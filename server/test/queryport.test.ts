import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { encodeOp, RefusedOpError, validateOp } from '../src/queryport';
import { loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';

describe('validateOp', () => {
  const ok = { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 };
  it('accepts the two approved operations', () => {
    expect(validateOp(ok)).toEqual(ok);
    expect(validateOp({ kind: 'measure_face', docId: 569, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 4 }).kind).toBe('measure_face');
  });
  it.each([
    ['unknown kind', { kind: 'commit', docId: 1 }],
    ['extra field', { ...ok, isPreview: false }],
    ['extra field on measure', { kind: 'measure_face', docId: 1, workshopId: 1, tipFeatureId: 1, featureId: 1, faceId: 0, action: 'Modify' }],
    ['non-integer id', { ...ok, docId: 1.5 }],
    ['zero id', { ...ok, docId: 0 }],
    ['string id', { ...ok, docId: '540' }],
    ['negative face', { kind: 'measure_face', docId: 1, workshopId: 1, tipFeatureId: 1, featureId: 1, faceId: -1 }],
    ['missing field', { kind: 'param', docId: 540, workshopId: 1 }],
    ['not an object', 'param'],
  ])('refuses %s', (_name, op) => expect(() => validateOp(op)).toThrow(RefusedOpError));
});

// The encoded body must equal, byte for byte, what the UI itself sent in the captures.
const capture = (label: string) => path.join(config.runsDir, `capture-${label}`, 'frames.jsonl');
const haveCaptures = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(capture('plate1')) && fs.existsSync(capture('measure2'));

describe.skipIf(!haveCaptures)('encodeOp reproduces the captured UI requests', () => {
  const schema = haveCaptures ? loadSchema(ivyRepo) : (undefined as never);
  const frameField = (label: string, i: number, fieldNo: number) => {
    const line = fs.readFileSync(capture(label), 'utf8').split('\n').filter(Boolean).find((l) => JSON.parse(l).i === i)!;
    const r = protobuf.Reader.create(Buffer.from(JSON.parse(line).payload, 'base64'));
    while (r.pos < r.len) { const t = r.uint32(); if (t >>> 3 === fieldNo && (t & 7) === 2) return Buffer.from(r.bytes()); r.skipType(t & 7); }
    throw new Error(`field ${fieldNo} not in record ${i}`);
  };

  it('param query = plate1 record 295', () => {
    const e = encodeOp(schema, { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 });
    expect(e.cmd).toBe(142);
    expect(e.bodyFieldNo).toBe(58);
    expect(Buffer.from(e.body).equals(frameField('plate1', 295, 58))).toBe(true);
  });

  it('face measurement preview = measure2 record 63', () => {
    const e = encodeOp(schema, { kind: 'measure_face', docId: 569, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 4 });
    expect(e.cmd).toBe(120);
    expect(e.bodyFieldNo).toBe(100);
    expect(Buffer.from(e.body).toString('hex')).toBe(frameField('measure2', 63, 100).toString('hex'));
  });
});
