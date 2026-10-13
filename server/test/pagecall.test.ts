import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CdpConnection } from '../src/cdpguard';
import { PAGE_FN, PageCall } from '../src/pagecall';
import { encodeOp, RefusedOpError } from '../src/queryport';
import { loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';

function fake(value: unknown) {
  const calls: Array<{ method: string; params?: any }> = [];
  let closed = 0;
  const conn: CdpConnection = {
    send: async (method, params) => { calls.push({ method, params }); return { result: { value } }; },
    onEvent: () => {}, close: () => { closed++; },
  };
  return { conn, calls, closed: () => closed };
}
const target = { projectId: 37649921, projectTag: 'main' };

describe('PageCall', () => {
  it('probe evaluates only the fixed page function', async () => {
    const f = fake({ ok: true, project: { projectId: '37649921', projectTag: 'main', valid: true } });
    await new PageCall(f.conn).probe();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe('Runtime.evaluate');
    expect(f.calls[0].params.expression).toBe(`(${PAGE_FN})({"mode":"probe"})`);
  });

  it('exposes only probe, send and close, and no handle to the connection', () => {
    const f = fake({ ok: true });
    const p = new PageCall(f.conn) as unknown as Record<string, unknown>;
    expect(Object.keys(p)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(p)).sort()).toEqual(['close', 'constructor', 'probe', 'send']);
  });

  it('rejects a malformed page result', async () => {
    await expect(new PageCall(fake({ ok: true, extra: 1 }).conn).probe()).rejects.toThrow(/malformed/);
    await expect(new PageCall(fake('nope').conn).probe()).rejects.toThrow(/malformed/);
  });

  it('closes once and refuses afterwards', async () => {
    const f = fake({ ok: true });
    const p = new PageCall(f.conn);
    p.close(); p.close();
    expect(f.closed()).toBe(1);
    await expect(p.probe()).rejects.toThrow(/closed/);
    expect(f.calls).toEqual([]);
  });
});

describe.skipIf(!fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')))('PageCall.send', () => {
  const schema = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) ? loadSchema(ivyRepo) : (undefined as never);

  it.each([
    { kind: 'commit', docId: 1 },
    { kind: 'measure_face', docId: 569, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 4, isPreview: false },
    { kind: 'param', docId: 540, workshopId: 1 },
  ])('refuses %o before the page is touched', async (op) => {
    const f = fake({ ok: true });
    await expect(new PageCall(f.conn).send(schema, op, target, 10000)).rejects.toThrow(RefusedOpError);
    expect(f.calls).toEqual([]);
  });

  it('refuses an out-of-range timeout before the page is touched', async () => {
    const f = fake({ ok: true });
    await expect(new PageCall(f.conn).send(schema, { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 }, target, 0)).rejects.toThrow(/timeoutMs/);
    expect(f.calls).toEqual([]);
  });

  it('sends exactly the encoded bytes of a valid operation, once', async () => {
    const f = fake({ ok: true, project: { projectId: '37649921', projectTag: 'main', valid: true }, asyncId: '42' });
    const op = { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 };
    const r = await new PageCall(f.conn).send(schema, op, target, 10000);
    expect(f.calls).toHaveLength(1);
    const arg = JSON.parse(f.calls[0].params.expression.slice(`(${PAGE_FN})(`.length, -1));
    const e = encodeOp(schema, op);
    expect(arg).toEqual({ mode: 'send', projectId: '37649921', projectTag: 'main', cmd: e.cmd, bodyFieldNo: e.bodyFieldNo, body: Array.from(e.body), timeoutMs: 10000 });
    expect(r.result.asyncId).toBe('42');
  });
});
