// Checks run against the real captures: the UI's own requests must pass, and altered variants must fail.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { encodeOp } from '../src/queryport';
import type { CaptureRecord } from '../src/recorder';
import { checkTraffic, compareState, observedTarget, type StateSnap } from '../src/replaycheck';
import { decodeCapture, loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const file = (l: string) => path.join(config.runsDir, `capture-${l}`, 'frames.jsonl');
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(file('plate1')) && fs.existsSync(file('measure2'));

describe.skipIf(!ready)('replay checks on captured traffic', () => {
  const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
  const load = (l: string): CaptureRecord[] => fs.readFileSync(file(l), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  const plate1 = ready ? load('plate1') : [];
  const measure2 = ready ? load('measure2') : [];
  const between = (recs: CaptureRecord[], from: number, to: number) => recs.filter((r) => r.i > from && r.i < to);

  it('observes the workshop, document and parameter set the page sent', () => {
    expect(observedTarget(decodeCapture(between(plate1, 0, 105), schema))).toEqual({ workshopId: 1, docId: 540, parmSetId: 10 });
    expect(observedTarget(decodeCapture(between(measure2, 0, 53), schema))).toMatchObject({ workshopId: 1, docId: 569 });
  });

  it('accepts the UI face measurement (measure2 records 53-71) as the expected traffic', () => {
    const recs = between(measure2, 53, 71);
    const e = encodeOp(schema, { kind: 'measure_face', docId: 569, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 4 });
    const r = checkTraffic(decodeCapture(recs, schema), recs, 'measure_face', e.body, e.bodyFieldNo);
    expect(r.problems).toEqual([]);
    expect(r.ntf?.cmd).toBe('IVY_APP_MODEL_NTF');
  });

  it('rejects that window when our bytes differ from what was sent', () => {
    const recs = between(measure2, 53, 71);
    const e = encodeOp(schema, { kind: 'measure_face', docId: 569, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 5 });
    expect(checkTraffic(decodeCapture(recs, schema), recs, 'measure_face', e.body, e.bodyFieldNo).problems).toContain('the sent bytes differ from the encoded operation');
  });

  it('accepts the UI parameter query (plate1 records 295-296)', () => {
    const recs = plate1.filter((r) => r.i === 295 || r.i === 296);
    const e = encodeOp(schema, { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 });
    const r = checkTraffic(decodeCapture(recs, schema), recs, 'param', e.body, e.bodyFieldNo);
    expect(r.problems).toEqual([]);
    expect((r.reply?.pkg as any).queryRsp.featureParams.map((p: any) => p.value)).toContain('100.000000');
  });

  it('rejects a parameter window that also contains a model request (plate1 records 295-299)', () => {
    const recs = plate1.filter((r) => r.i >= 295 && r.i <= 299);
    const e = encodeOp(schema, { kind: 'param', docId: 540, workshopId: 1, parmSetId: 10 });
    expect(checkTraffic(decodeCapture(recs, schema), recs, 'param', e.body, e.bodyFieldNo).problems).toContain('expected 1 sent message, saw 2');
  });
});

describe('compareState', () => {
  const base: StateSnap = {
    undo: '{"markNum":2}', classes: { '1': 'ivy::FeatPart', '9': 'ivy::PipelineContext' },
    objects: { '1': '{"a":1}', '9': 'x' }, edges: ['"1" -> "9" [label="Contain"]', '"0" -> "1" [label="Contain"]'],
  };
  it('ignores only PipelineContext churn', () => {
    const b: StateSnap = { ...base, classes: { '1': 'ivy::FeatPart', '7': 'ivy::PipelineContext' }, objects: { '1': '{"a":1}', '7': 'y' }, edges: ['"1" -> "7" [label="Contain"]', '"0" -> "1" [label="Contain"]'] };
    expect(compareState(base, b)).toEqual([]);
  });
  it.each([
    ['undo', { undo: '{"markNum":3}' }, 'undo history changed'],
    ['object json', { objects: { '1': '{"a":2}', '9': 'x' } }, 'object 1 (ivy::FeatPart) changed'],
    ['added object', { classes: { ...base.classes, '5': 'ivy::Measurement' }, objects: { ...base.objects, '5': '{}' } }, 'object 5 (ivy::Measurement) added'],
    ['edges', { edges: ['"1" -> "9" [label="Contain"]'] }, 'graph edges changed'],
  ])('reports a %s change', (_n, patch, msg) => expect(compareState(base, { ...base, ...patch } as StateSnap)).toContain(msg));
});
