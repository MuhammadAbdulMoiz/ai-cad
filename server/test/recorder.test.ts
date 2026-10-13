import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadOnlyCdp, type CdpConnection } from '../src/cdpguard';
import { attachRecorder, redactUrl, type CaptureRecord } from '../src/recorder';

function fake() {
  const calls: string[] = [];
  let listener: ((m: string, p: unknown) => void) | undefined;
  const conn: CdpConnection = { send: async (m) => { calls.push(m); return {}; }, onEvent: (l) => { listener = l; }, close: () => {} };
  return { conn, calls, emit: (m: string, p: unknown) => listener!(m, p) };
}

describe('attachRecorder', () => {
  it('sends only Network.enable and records socket events verbatim', async () => {
    const f = fake();
    const recs: CaptureRecord[] = [];
    const mark = await attachRecorder(new ReadOnlyCdp(f.conn), (r) => recs.push(r));
    f.emit('Network.webSocketCreated', { requestId: 'w1', url: 'wss://h/ws?projectId=5&projectTag=main&appId=1002&openId=oi_9&token=SECRET&tenantId=7' });
    f.emit('Network.webSocketFrameSent', { requestId: 'w1', timestamp: 1, response: { opcode: 2, mask: true, payloadData: 'AAEC' } });
    f.emit('Network.webSocketFrameReceived', { requestId: 'w1', timestamp: 2, response: { opcode: 1, mask: false, payloadData: '{"event":"ready"}' } });
    f.emit('Network.webSocketClosed', { requestId: 'w1', timestamp: 3 });
    mark('start sketch');
    expect(f.calls).toEqual(['Network.enable']);
    expect(recs.map((r) => r.type)).toEqual(['socket', 'frame', 'frame', 'closed', 'mark']);
    expect(recs.map((r) => r.i)).toEqual([0, 1, 2, 3, 4]);
    expect(recs[1]).toMatchObject({ dir: 'sent', opcode: 2, payload: 'AAEC' });
    expect(recs[2]).toMatchObject({ dir: 'received', opcode: 1, payload: '{"event":"ready"}' });
    expect(JSON.stringify(recs)).not.toMatch(/SECRET|oi_9/);
  });
});

describe('redactUrl', () => {
  it('keeps only projectId, projectTag and appId', () => {
    const u = new URL(redactUrl('wss://u:p@h:8081/ws?projectId=5&projectTag=dev&appId=1002&openId=oi_9&token=SECRET&tenantId=7'));
    expect(Object.fromEntries(u.searchParams)).toEqual({ projectId: '5', projectTag: 'dev', appId: '1002', openId: 'REDACTED', token: 'REDACTED', tenantId: 'REDACTED' });
    expect(u.username + u.password).toBe('');
  });
  it('never echoes an unparseable url', () => expect(redactUrl('not a url token=SECRET')).toBe('<unparseable url>'));
});

// Guardrail only: a text scan cannot prove the recorder is unable to send. ReadOnlyCdp's tests above are that proof.
describe('recorder source scan (guardrail)', () => {
  const files = ['scripts/capture.ts', 'src/recorder.ts', 'src/cdpguard.ts'].map((f) => path.join(import.meta.dirname, '..', f));
  it.each(files)('%s uses no page actions or browser automation', (file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toMatch(/\.(evaluate|click|goto|fill|type|press|reload|dispatchEvent)\(|playwright|['"](Runtime|Input|Page|DOM|Fetch|Target|Emulation)\.\w+['"]/);
  });
});
