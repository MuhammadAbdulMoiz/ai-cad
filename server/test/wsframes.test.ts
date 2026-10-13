// Decoder tests use captured bytes only (re-plan §7.1). The capture lives in the gitignored runs/ folder because
// its frames carry the user's id; these tests skip where it is absent. Expected values come from the
// 2026-10-13 plate1 capture (docs/session-protocol-capture.md).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { CaptureRecord } from '../src/recorder';
import { decodeCapture, loadSchema, summarize, type Decoded } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');

describe.skipIf(!fs.existsSync(ivyRepo))('loadSchema', () => {
  it("loads IvyPkg and PartPkg from Ivy's .proto files", () => {
    const s = loadSchema(ivyRepo);
    expect(s.IvyPkg.fullName).toBe('.ivyproto.IvyPkg');
    expect(s.PartPkg?.fullName).toBe('.ivypart.PartPkg');
    for (const f of ['header', 'appModelReq', 'appModelRsp', 'appModelNtf', 'queryReq', 'queryRsp', 'pluginReq'])
      expect(s.IvyPkg.fields[f], f).toBeDefined();
  });
});

describe.skipIf(!fs.existsSync(ivyRepo) || !fs.existsSync(captureFile))('decodeCapture on the plate1 capture', () => {
  const records: CaptureRecord[] = fs.existsSync(captureFile)
    ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const schema = fs.existsSync(ivyRepo) ? loadSchema(ivyRepo) : (undefined as never);
  const decoded = records.length ? decodeCapture(records, schema) : [];
  const at = (frame: number) => decoded.find((d) => d.frames[0] === frame) as Extract<Decoded, { kind: 'message' }>;
  const part = (frame: number) => { const p: any = at(frame).pkg; return (p.appModelReq ?? p.appModelRsp).modelPkgDecoded; };

  it('decodes every binary message, answers every request and validates every mesh frame', () => {
    const s = summarize(decoded);
    expect(s.undecoded).toEqual([]);
    expect(s.asyncIds.unanswered).toEqual([]);
    expect(s.asyncIds.unsolicited).toEqual([]);
    expect(s.mesh).toEqual({ ok: 2 });
    expect(s.messages).toEqual({ 'sent:decoded': 42, 'received:decoded': 81 });
  });

  it('sketch create: app-model request wrapping a part sketch update, answered with the new feature id', () => {
    expect(at(113)).toMatchObject({ dir: 'sent', status: 'decoded', cmd: 'IVY_APP_MODEL_REQ' });
    expect((at(113).pkg as any).appModelReq.workshopHead).toMatchObject({ workshopId: '1', currentDocId: '540' });
    expect(part(113).header).toMatchObject({ cmd: 'IVY_PART_SKETCH_UPDATE_REQ', featureName: 'Sketch2' });
    expect(part(114).header).toMatchObject({ cmd: 'IVY_PART_SKETCH_UPDATE_RSP', featureId: '15', featureType: 'ivy::FeatSketch' });
  });

  it('extrude: preview Create/Modify on a temporary id, committed by a non-preview Modify', () => {
    expect(part(297).featUpdateReq.header).toEqual({ action: 'Create' });
    expect((at(297).pkg as any).appModelReq.workshopHead).toMatchObject({ isPreview: true, ignoreMark: true, doNotSave: true });
    expect(part(311).featUpdateReq.header).toEqual({ action: 'Modify', featureId: -2 });
    expect((at(311).pkg as any).appModelReq.workshopHead).toMatchObject({ isPreview: false, ignoreMark: false, doNotSave: false });
    expect(part(312).header).toMatchObject({ cmd: 'IVY_PART_FEAT_UPDATE_UPDATE_RSP', featureId: '43', featureType: 'ivy::SolidExtrude' });
  });

  it('failure: depth 0 is answered with result 32000 for the preview and for the commit attempt', () => {
    expect(part(455).featUpdateRsp).toEqual({ result: 32000 });
    expect(part(459).featUpdateRsp).toEqual({ result: 32000 });
    expect((at(459).pkg as any).appModelRsp.result).toBe(32000);
  });

  // Fail-closed checks on altered captured bytes: a damaged frame must be reported, never half-decoded.
  const frame = (i: number) => records.find((r) => r.type === 'frame' && r.i === i) as Extract<CaptureRecord, { type: 'frame' }>;
  const cut = (i: number, n: number) => ({ ...frame(i), payload: Buffer.from(frame(i).payload, 'base64').subarray(0, -n).toString('base64') });

  it('reports a truncated sent message as undecoded', () => {
    const [d] = decodeCapture([cut(121, 10)], schema);
    expect(d).toMatchObject({ kind: 'message', status: 'undecoded' });
  });
  // Node's zstd returns partial output for these instead of failing (seen on this capture); checkZstdFrame must catch them.
  it.each([1, 4, 8, 20])('reports a compressed reply cut by %i bytes as undecoded (zstd)', (n) => {
    const [d] = decodeCapture([cut(114, n)], schema);
    expect(d).toMatchObject({ kind: 'message', status: 'undecoded' });
    expect((d as any).error).toMatch(/^zstd/);
  });
  it('reports trailing bytes after a compressed reply as undecoded (zstd)', () => {
    const f = frame(114);
    const [d] = decodeCapture([{ ...f, payload: Buffer.concat([Buffer.from(f.payload, 'base64'), Buffer.from([0])]).toString('base64') }], schema);
    expect((d as any).error).toMatch(/^zstd: zstd frame: 1 trailing bytes/);
  });
  it('rejects a mesh frame whose length disagrees with its header', () => {
    const [d] = decodeCapture([cut(140, 1)], schema);
    expect(d).toMatchObject({ kind: 'mesh', ok: false });
  });
});
