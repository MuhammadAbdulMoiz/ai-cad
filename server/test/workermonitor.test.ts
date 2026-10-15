import { describe, expect, it } from 'vitest';
import { RecordStream, type CaptureRecord } from '../src/recorder';
import { WorkerMonitor, type WorkerTarget } from '../src/workermonitor';

const URL_ = 'https://local.zixel.cn:8080/a/mda/obs-cache.js';
const TAG = `the allowlisted service worker ${URL_}`;
const page: WorkerTarget = { id: 'P', type: 'page', url: 'https://local.zixel.cn:8080/a/mda/zcad?id=1', webSocketDebuggerUrl: 'ws://p' };
const sw = (id: string): WorkerTarget => ({ id, type: 'service_worker', url: URL_, webSocketDebuggerUrl: `ws://${id}` });

/** A fake browser: `targets` is what /json/list returns; attach() records each attachment and may fail. */
function fake(o: { failAttach?: string; pingFails?: boolean; pingHangs?: boolean } = {}) {
  let t = 1000;
  const targets: WorkerTarget[] = [page];
  const stream = new RecordStream();
  const attached: string[] = [], detached: string[] = [];
  let write: ((r: CaptureRecord) => void) | undefined;
  let next = 0;
  const m = new WorkerMonitor(URL_, {
    list: async () => [...targets], stream, now: () => t, pingTimeoutMs: 50,
    attach: async (target, w) => {
      if (o.failAttach) throw new Error(o.failAttach);
      attached.push(target.id); write = w;
      return {
        ping: () => (o.pingHangs ? new Promise<void>(() => {}) : o.pingFails ? Promise.reject(new Error('connection closed')) : Promise.resolve()),
        detach: () => { detached.push(target.id); },
      };
    },
  });
  const emit = (r: Omit<CaptureRecord, 'i' | 't'>) => write!({ ...(r as any), i: next++, t: 0 });
  return { m, targets, attached, detached, emit, tick: (ms: number) => { t += ms; } };
}

describe('WorkerMonitor: the allowlisted service worker, monitored from when it appears', () => {
  it('attaches the moment the worker appears after startup, and accepts it while nothing is seen', async () => {
    const f = fake();
    await f.m.poll(); await f.m.poll();
    expect(f.attached).toEqual([]); // not there yet: the editor has not started it
    f.tick(250); f.targets.push(sw('W1'));
    await f.m.poll();
    expect(f.attached).toEqual(['W1']);
    f.tick(250); await f.m.poll();
    expect(f.attached).toEqual(['W1']); // attached once
    expect(await f.m.check([...f.targets])).toEqual([]);
    expect(f.m.report()).toEqual({
      url: URL_, firstSeenAt: new Date(1250).toISOString(), firstSeenTargetId: 'W1', attachedAt: new Date(1250).toISOString(), targetId: 'W1', gapMs: 0,
      activity: 0, accepted: true, note: 'monitoring starts at attachedAt: worker activity between its start and the attachment cannot be ruled out',
    });
  });
  it('attaches at the inventory check itself if no poll saw the worker yet, before judging it', async () => {
    const f = fake();
    f.targets.push(sw('W1'));
    expect(await f.m.check([...f.targets])).toEqual([]);
    expect(f.attached).toEqual(['W1']);
  });
  it('accepts no worker at all (nothing to monitor), and reports that it was never seen', async () => {
    const f = fake();
    expect(await f.m.check([page])).toEqual([]);
    expect(f.m.report()).toMatchObject({ firstSeenAt: undefined, attachedAt: undefined, activity: 0 });
    expect(f.m.report().accepted).toBeUndefined();
  });
  it.each([
    ['opens a WebSocket', { type: 'socket', requestId: 'w.1', url: 'wss://elsewhere/x' }, `${TAG} showed WebSocket activity (socket at 0)`],
    ['sends a frame', { type: 'frame', requestId: 'w.1', dir: 'sent', ts: 0, opcode: 1, mask: true, payload: 'x' }, `${TAG} showed WebSocket activity (frame at 0)`],
    ['reports a frame error', { type: 'frame_error', requestId: 'w.1', ts: 0, message: 'x' }, `${TAG} showed WebSocket activity (frame_error at 0)`],
    ['closes a socket', { type: 'closed', requestId: 'w.1', ts: 0 }, `${TAG} showed WebSocket activity (closed at 0)`],
  ])('refuses when the worker %s', async (_n, rec, why) => {
    const f = fake();
    f.targets.push(sw('W1')); await f.m.poll();
    f.emit(rec as any);
    expect(await f.m.check([...f.targets])).toEqual([why]);
    expect(f.m.report()).toMatchObject({ activity: 1, accepted: false });
  });
  it('refuses a restarted or replaced worker, and keeps refusing even if the old target returns', async () => {
    const f = fake();
    f.targets.push(sw('W1')); await f.m.poll();
    f.targets.splice(1, 1, sw('W2')); await f.m.poll();
    expect(await f.m.check([...f.targets])).toEqual([`${TAG} was replaced or restarted after monitoring began (W1 → W2)`, `${TAG} is target W2, not the monitored W1`]);
    f.targets.splice(1, 1, sw('W1'));
    expect(await f.m.check([...f.targets])).toEqual([`${TAG} was replaced or restarted after monitoring began (W1 → W2)`]);
    expect(f.attached).toEqual(['W1']); // never re-attached to the newcomer
    expect(f.m.report().replacedBy).toEqual(['W2']);
  });
  it('refuses two workers with the URL', async () => {
    const f = fake();
    f.targets.push(sw('W1'), sw('W2'));
    expect(await f.m.check([...f.targets])).toEqual([`${TAG} is listed 2 times (W1, W2)`, `${TAG} is not monitored`]);
    expect(f.attached).toEqual([]);
  });
  it('refuses for good when the recorder cannot attach (never retried)', async () => {
    const f = fake({ failAttach: 'connect ECONNREFUSED' });
    f.targets.push(sw('W1')); await f.m.poll(); await f.m.poll();
    expect(await f.m.check([...f.targets])).toEqual([`${TAG} could not be monitored: connect ECONNREFUSED`]);
    expect(f.m.report()).toMatchObject({ failed: 'connect ECONNREFUSED', attachedAt: undefined, firstSeenTargetId: 'W1', accepted: false });
  });
  it('refuses a worker target without a DevTools endpoint', async () => {
    const f = fake();
    f.targets.push({ ...sw('W1'), webSocketDebuggerUrl: undefined });
    expect(await f.m.check([...f.targets])).toEqual([`${TAG} could not be monitored: the worker target has no DevTools endpoint`]);
  });
  it.each([
    ['fails', { pingFails: true }, `${TAG}: its recorder is not operational (connection closed)`],
    ['does not answer', { pingHangs: true }, `${TAG}: its recorder is not operational (no answer within 50 ms)`],
  ])('refuses when the recorder %s at check time', async (_n, o, why) => {
    const f = fake(o);
    f.targets.push(sw('W1')); await f.m.poll();
    expect(await f.m.check([...f.targets])).toEqual([why]);
  });
  it('reports the monitoring gap between first sight and attachment, and never claims full history', async () => {
    let t = 0;
    const stream = new RecordStream();
    const m = new WorkerMonitor(URL_, { list: async () => [sw('W1')], stream, now: () => (t += 40), attach: async () => ({ ping: async () => {}, detach: () => {} }) });
    await m.poll();
    const r = m.report();
    expect(r).toMatchObject({ firstSeenAt: new Date(40).toISOString(), attachedAt: new Date(80).toISOString(), gapMs: 40 });
    expect(r.note).toBe('monitoring starts at attachedAt: worker activity between its start and the attachment cannot be ruled out');
  });
  it('a check during an attachment in progress waits for it instead of judging "not monitored"', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = new WorkerMonitor(URL_, { list: async () => [sw('W1')], stream: new RecordStream(), attach: async () => { await gate; return { ping: async () => {}, detach: () => {} }; } });
    const polling = m.poll();
    const checking = m.check([sw('W1')]);
    release();
    await polling;
    expect(await checking).toEqual([]);
  });
  it('detaches its recorder', async () => {
    const f = fake();
    f.targets.push(sw('W1')); await f.m.poll();
    f.m.detach();
    expect(f.detached).toEqual(['W1']);
  });
});
