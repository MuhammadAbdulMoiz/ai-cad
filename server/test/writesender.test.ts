import { describe, expect, it } from 'vitest';
import type { CdpConnection } from '../src/cdpguard';
import { PAGE_FN } from '../src/pagecall';
import { APP_MODEL_FIELD, APP_MODEL_REQ, PageSender } from '../src/writesender';

function fake(value: unknown) {
  const calls: Array<{ method: string; params: any }> = [];
  let closed = 0;
  const conn: CdpConnection = { send: async (method, params) => { calls.push({ method, params }); return { result: { value } }; }, onEvent: () => {}, close: () => { closed++; } };
  return { conn, calls, closed: () => closed };
}
const target = { projectId: 37660626, projectTag: 'main' };
const ok = { ok: true, project: { projectId: '37660626', projectTag: 'main', valid: true }, asyncId: '193457812480010530' };
const body = new Uint8Array([10, 2, 8, 1]);

describe('PageSender (the only sender; disarmed by default)', () => {
  it('is disarmed unless armed explicitly, and then touches nothing', async () => {
    for (const s of [new PageSender(fake(ok).conn, target), new PageSender(fake(ok).conn, target, { armed: false })]) {
      expect(s.armed).toBe(false);
      await expect(s.sendRaw(APP_MODEL_REQ, APP_MODEL_FIELD, body, 10000)).rejects.toThrow('the sender is disarmed');
      expect(s.sentBodies()).toEqual([]);
    }
    const f = fake(ok);
    await expect(new PageSender(f.conn, target).sendRaw(APP_MODEL_REQ, APP_MODEL_FIELD, body, 10000)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('armed, hands exactly the body to PAGE_FN\'s existing send mode for the bound project, and maps the result', async () => {
    const f = fake(ok);
    const s = new PageSender(f.conn, target, { armed: true });
    expect(await s.sendRaw(APP_MODEL_REQ, APP_MODEL_FIELD, body, 10000)).toEqual({ ok: true, asyncId: '193457812480010530' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe('Runtime.evaluate');
    expect(f.calls[0].params).toMatchObject({ awaitPromise: true, returnByValue: true });
    const expr: string = f.calls[0].params.expression;
    expect(expr.startsWith(`(${PAGE_FN})(`)).toBe(true);
    expect(JSON.parse(expr.slice(`(${PAGE_FN})(`.length, -1))).toEqual({ mode: 'send', projectId: '37660626', projectTag: 'main', cmd: 120, bodyFieldNo: 100, body: [10, 2, 8, 1], timeoutMs: 10000 });
    expect(s.sentBodies()).toEqual([body]);
  });
  it('keeps its own copy of each body (the caller may reuse its buffer)', async () => {
    const s = new PageSender(fake(ok).conn, target, { armed: true });
    const b = Uint8Array.from(body);
    await s.sendRaw(APP_MODEL_REQ, APP_MODEL_FIELD, b, 10000);
    b.fill(0);
    expect(s.sentBodies()).toEqual([body]);
  });
  it.each([
    ['another command', 117, 100, 'only IVY_APP_MODEL_REQ bodies in field 100 are sent, not 117/100'],
    ['another body field', 120, 101, 'only IVY_APP_MODEL_REQ bodies in field 100 are sent, not 120/101'],
  ])('refuses %s without touching the page', async (_n, cmd, field, msg) => {
    const f = fake(ok);
    await expect(new PageSender(f.conn, target, { armed: true }).sendRaw(cmd, field, body, 10000)).rejects.toThrow(msg);
    expect(f.calls).toEqual([]);
  });
  it('refuses a timeout outside 1–60 s', async () => {
    await expect(new PageSender(fake(ok).conn, target, { armed: true }).sendRaw(120, 100, body, 70000)).rejects.toThrow('timeoutMs must be 1000..60000');
  });
  it('passes the page\'s "no reply" through as an unknown outcome, and its refusals as not ok', async () => {
    const late = { ok: false, project: ok.project, unknownOutcome: true, error: 'no reply: timeout' };
    expect(await new PageSender(fake(late).conn, target, { armed: true }).sendRaw(120, 100, body, 10000)).toEqual({ ok: false, asyncId: null, unknownOutcome: true, error: 'no reply: timeout' });
    const mismatch = { ok: false, error: 'page project mismatch', project: { projectId: '1', projectTag: 'main', valid: true } };
    expect(await new PageSender(fake(mismatch).conn, target, { armed: true }).sendRaw(120, 100, body, 10000)).toEqual({ ok: false, asyncId: null, error: 'page project mismatch' });
  });
  it('throws on a malformed page result, and refuses after close', async () => {
    await expect(new PageSender(fake({ ok: true, extra: 1 }).conn, target, { armed: true }).sendRaw(120, 100, body, 10000)).rejects.toThrow(/malformed page result/);
    const f = fake(ok);
    const s = new PageSender(f.conn, target, { armed: true });
    s.close(); s.close();
    expect(f.closed()).toBe(1);
    await expect(s.sendRaw(120, 100, body, 10000)).rejects.toThrow('the sender is closed');
  });
});
