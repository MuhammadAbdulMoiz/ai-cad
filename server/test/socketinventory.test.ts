import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { socketInventory } from '../src/socketinventory';

const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');
const ready = fs.existsSync(captureFile);
const records: any[] = ready ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const page = { id: 'P', type: 'page', url: 'https://local.zixel.cn:8080/a/mda/zcad?id=1' };
// The pre-reload sockets (no socket record, no closed record): .2790 carried the model socket's ping, i.e. the old model socket.
const PRE = ['40700.2851', '40700.647', '40700.2790'];
const preWhy = (ids: Array<[string, number]>) => ids.map(([id, i]) => `socket ${id} was open before the recorder attached (frame at ${i}) and was never seen to close`);
const plate1Pre = [['40700.2851', 1], ['40700.647', 4], ['40700.2790', 15]] as Array<[string, number]>;
/** plate1 as if the recorder had attached before the page opened any socket. */
const clean = () => records.filter((r) => !PRE.includes(r.requestId));

describe.skipIf(!ready)('socketInventory over the plate1 capture (page reloaded after the recorder attached: socket record 31)', () => {
  it('is incomplete: the pre-reload sockets fell silent but were never seen to close (silence is not proof)', () => {
    expect(records.some((r) => r.requestId === '40700.2790' && /"command":"ping"/.test(r.payload))).toBe(true);
    expect(records.filter((r) => PRE.includes(r.requestId)).every((r) => r.i < 31 && r.type === 'frame')).toBe(true);
    expect(socketInventory(records, [page], 'P')).toEqual({ complete: false, modelSockets: ['40700.5030'], why: preWhy(plate1Pre) });
  });
  it('is complete with exactly the created model socket when no socket predates the recorder and only the editor page (and browser UI) exist', () => {
    expect(socketInventory(clean(), [page, { id: 'U', type: 'browser_ui', url: 'chrome://omnibox' }], 'P')).toEqual({ complete: true, modelSockets: ['40700.5030'], why: [] });
  });
  it('a pre-existing socket seen to close does not count', () => {
    const closed = PRE.map((id, k) => ({ i: 9000 + k, t: 0, type: 'closed', requestId: id, ts: 0 }));
    expect(socketInventory([...records, ...closed], [page], 'P').complete).toBe(true);
  });
  it.each([
    ['a service worker', { id: 'W', type: 'service_worker', url: 'https://local.zixel.cn:8080/a/mda/obs-cache.js' }],
    ['a second page', { id: 'Q', type: 'page', url: 'https://local.zixel.cn:8080/a/mda/zcad?id=2' }],
    ['an iframe', { id: 'F', type: 'iframe', url: 'https://x/y' }],
  ])('is incomplete when %s exists', (_n, other) => {
    const inv = socketInventory(clean(), [page, other], 'P');
    expect(inv.complete).toBe(false);
    expect(inv.why).toEqual([`another DevTools target could hold sockets the editor page session cannot see: ${other.type} ${other.url.split('?')[0]}`]);
  });
  it('is incomplete when the model socket was not created while recorded (pre-existing sockets are invisible)', () => {
    const inv = socketInventory(clean().filter((r) => r.type !== 'socket'), [page], 'P');
    expect(inv).toMatchObject({ complete: false, modelSockets: [] });
  });
  it('drops a model socket that closed, and lists a reconnect as a second socket', () => {
    const closedOnce = [...clean(), { i: 9000, t: 0, type: 'closed', requestId: '40700.5030', ts: 0 }];
    expect(socketInventory(closedOnce, [page], 'P').modelSockets).toEqual([]);
    const two = [...clean(), { i: 9001, t: 0, type: 'socket', requestId: '40700.6000', url: 'ws://127.0.0.1:8081/zcad/client?projectId=1' }];
    expect(socketInventory(two, [page], 'P').modelSockets).toEqual(['40700.5030', '40700.6000']);
  });
});

const probeFile = path.join(config.runsDir, 'write-probe-doc37660560', 'frames.jsonl');
describe.skipIf(!fs.existsSync(probeFile))('socketInventory over the doc37660560 read-only probe (reloaded at record 58)', () => {
  const recs: any[] = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  it('is incomplete: the old model socket 34692.27933 stopped 3 records before the new one, never seen to close', () => {
    expect(recs.some((r) => r.requestId === '34692.27933' && /"command":"ping"/.test(r.payload))).toBe(true);
    expect(socketInventory(recs, [page], 'P')).toEqual({
      complete: false, modelSockets: ['34692.30183'], why: preWhy([['34692.27997', 0], ['34692.25822', 7], ['34692.27933', 11]]),
    });
  });
  it('before the reload: no model socket created while recorded', () => {
    expect(socketInventory(recs.filter((r) => r.i < 56), [page], 'P').why[0]).toBe('no model socket was created while recorded (reload the editor tab after the recorder attached)');
  });
});

describe.skipIf(!ready)('the allowlisted service worker (obs-cache.js): judged by its monitor (workermonitor.test.ts)', () => {
  const URL_ = 'https://local.zixel.cn:8080/a/mda/obs-cache.js';
  const worker = { id: 'W', type: 'service_worker', url: URL_ };
  it('is accepted when its monitor found nothing', () => {
    expect(socketInventory(clean(), [page, worker], 'P', { serviceWorker: { url: URL_, problems: [] } })).toEqual({ complete: true, modelSockets: ['40700.5030'], why: [] });
  });
  it('is refused without a monitor (unchanged rule)', () => {
    expect(socketInventory(clean(), [page, worker], 'P').why).toEqual([`another DevTools target could hold sockets the editor page session cannot see: service_worker ${URL_}`]);
  });
  it('carries every problem its monitor found', () => {
    const problems = ['the allowlisted service worker x showed WebSocket activity (socket at 0)', 'the allowlisted service worker x was replaced'];
    expect(socketInventory(clean(), [page, worker], 'P', { serviceWorker: { url: URL_, problems } }).why).toEqual(problems);
  });
  it('allows only that exact script: another worker is still refused', () => {
    const other = { id: 'X', type: 'service_worker', url: 'https://local.zixel.cn:8080/a/mda/other.js' };
    expect(socketInventory(clean(), [page, worker, other], 'P', { serviceWorker: { url: URL_, problems: [] } }).why).toEqual(['another DevTools target could hold sockets the editor page session cannot see: service_worker https://local.zixel.cn:8080/a/mda/other.js']);
  });
  it('keeps every other refusal: pre-existing sockets, other targets, no model socket', () => {
    const iframe = { id: 'F', type: 'iframe', url: 'https://x/y' };
    const inv = socketInventory(records, [page, worker, iframe], 'P', { serviceWorker: { url: URL_, problems: [] } });
    expect(inv.why).toEqual(['another DevTools target could hold sockets the editor page session cannot see: iframe https://x/y', ...preWhy(plate1Pre)]);
    expect(socketInventory(clean().filter((r) => r.type !== 'socket'), [page, worker], 'P', { serviceWorker: { url: URL_, problems: [] } }).why[0]).toBe('no model socket was created while recorded (reload the editor tab after the recorder attached)');
  });
});
