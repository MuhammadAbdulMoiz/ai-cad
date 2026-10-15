// Offline: byte equality with the UI requests captured in runs/capture-plate1 (gitignored; skipped where absent).
// These tests prove the encoders reproduce what the UI sent. They do NOT prove Ivy accepts ai-cad's requests.
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import template from '../src/templates/plate1-write.json';
import { decodeCapture, loadSchema } from '../src/wsframes';
import {
  AmbiguousProtocolError, buildExtrudeCommit, buildExtrudeCreate, buildExtrudeModify, buildSketchCreate, buildSketchStep,
  encodeTemplate, rectLines, RefusedWriteError, SKETCH_GEOMETRY_STEPS, WRITE_STEPS, type Lines, type SketchGeometryStep,
} from '../src/writeport';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const haveIvy = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto'));
const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');
const ready = haveIvy && fs.existsSync(captureFile);
const schema = haveIvy ? loadSchema(ivyRepo) : (undefined as never);
const records = ready ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** The captured app-model body (IvyPkg field 100) of a record. */
function capturedBody(i: number): Buffer {
  const r = protobuf.Reader.create(Buffer.from(records.find((x: any) => x.i === i).payload, 'base64'));
  while (r.pos < r.len) { const t = r.uint32(); if (t >>> 3 === 100 && (t & 7) === 2) return Buffer.from(r.bytes()); r.skipType(t & 7); }
  throw new Error(`record ${i} has no app-model body`);
}
const decodedAt = (i: number) => decodeCapture(records.filter((r: any) => r.i === i), schema)[0] as any;
const sketchOf = (step: SketchGeometryStep) => (template.bodies as any)[step].modelPkg.sketchUpdateReq;
const capturedLines = (step: SketchGeometryStep): Lines => sketchOf(step).geoms.map((g: any) => [g.line.start.x ?? 0, g.line.start.y ?? 0, g.line.end.x ?? 0, g.line.end.y ?? 0]);
/** The dimension values the capture carried, or the drawn size where the request has no dimension yet. */
const capturedSize = (step: SketchGeometryStep) => {
  const l = capturedLines(step), c = sketchOf(step).constraints;
  return { width: c[8]?.constraint?.value ?? l[0][2] - l[0][0], height: c[9]?.constraint?.value ?? l[3][3] - l[3][1] };
};
const doc = { workshopId: 1, docId: 540 };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe.skipIf(!ready)('write encoders reproduce the captured UI requests byte for byte', () => {
  it.each(WRITE_STEPS.map((s) => [s, (template.records as any)[s]]))('template %s = record %i', (step, i) => {
    expect(hex(encodeTemplate(schema, step as any))).toBe(hex(capturedBody(i as number)));
  });

  it('sketchCreate = 113', () => {
    const { body } = buildSketchCreate(schema, { ...doc, tipFeatureId: 12, sketchName: 'Sketch2', planeFeatureId: 3 });
    expect(hex(body)).toBe(hex(capturedBody(113)));
  });

  it.each(SKETCH_GEOMETRY_STEPS.map((s) => [s, (template.records as any)[s]]))('%s = record %i', (step, i) => {
    const s = step as SketchGeometryStep;
    const { body } = buildSketchStep(schema, s, { ...doc, sketchFeatureId: 15, planeFeatureId: 3, lines: capturedLines(s), ...capturedSize(s) });
    expect(hex(body)).toBe(hex(capturedBody(i as number)));
  });

  it('extrudeCreate = 297', () => {
    expect(hex(buildExtrudeCreate(schema, { ...doc, sketchFeatureId: 15, extrudeName: 'Extrude1' }).body)).toBe(hex(capturedBody(297)));
  });

  it('extrudeModify (from preview notification 299, depth 8) = 303, and extrudeCommit (from 305) = 311', () => {
    const x = { ...doc, sketchFeatureId: 15, extrudeName: 'Extrude1', previewFeatureId: -2, depth: 8 };
    const m = buildExtrudeModify(schema, x, decodedAt(299).pkg);
    expect(hex(m.body)).toBe(hex(capturedBody(303)));
    expect(m.depthItem).toMatchObject({ featId: '21', value: '8', formula: '' });
    expect(hex(buildExtrudeCommit(schema, x, decodedAt(305).pkg, m.depthItem).body)).toBe(hex(capturedBody(311)));
  });

  it('commit built from the wrong notification differs from the UI bytes', () => {
    const x = { ...doc, sketchFeatureId: 15, extrudeName: 'Extrude1', previewFeatureId: -2, depth: 8 };
    const m = buildExtrudeModify(schema, x, decodedAt(299).pkg);
    expect(hex(buildExtrudeCommit(schema, x, decodedAt(299).pkg, m.depthItem).body)).not.toBe(hex(capturedBody(311)));
  });

  it('fails closed on a missing, mismatched or ambiguous preview notification', () => {
    const x = { ...doc, sketchFeatureId: 15, extrudeName: 'Extrude1', previewFeatureId: -2, depth: 8 };
    const ntf = decodedAt(299).pkg;
    expect(() => buildExtrudeModify(schema, x, {})).toThrow(AmbiguousProtocolError);
    expect(() => buildExtrudeModify(schema, { ...x, previewFeatureId: -3 }, ntf)).toThrow(AmbiguousProtocolError);
    expect(() => buildExtrudeModify(schema, { ...x, sketchFeatureId: 16 }, ntf)).toThrow(AmbiguousProtocolError);
    const dup = structuredClone(ntf); const f = dup.appModelNtf.modelDescs[0].modelPkgDecoded.dataNtf.features; f.push(f[0]);
    expect(() => buildExtrudeModify(schema, x, dup)).toThrow(AmbiguousProtocolError);
    const short = structuredClone(ntf);
    const attrs = short.appModelNtf.modelDescs[0].modelPkgDecoded.dataNtf.features[0].featUpdateFeature.feat.attributes;
    attrs.find((a: any) => Number(a.role) === 31027).parm.pop();
    expect(() => buildExtrudeModify(schema, x, short)).toThrow(AmbiguousProtocolError);
    expect(() => buildExtrudeCommit(schema, x, decodedAt(305).pkg, undefined)).toThrow(AmbiguousProtocolError);
  });
});

describe.skipIf(!haveIvy)('write encoders refuse altered or invalid input', () => {
  const geom = { ...doc, sketchFeatureId: 15, planeFeatureId: 3, lines: rectLines(-50, -30, 100, 60), width: 100, height: 60 };
  it.each(SKETCH_GEOMETRY_STEPS)('builds a clean 100 x 60 rectangle for %s', (s) => expect(buildSketchStep(schema, s, geom).body.length).toBeGreaterThan(0));
  it.each([
    ['extra field', () => buildSketchCreate(schema, { ...doc, tipFeatureId: 12, sketchName: 'Sketch2', planeFeatureId: 3, onlySolve: false })],
    ['non-integer document', () => buildSketchCreate(schema, { workshopId: 1, docId: 1.5, tipFeatureId: 12, sketchName: 'S', planeFeatureId: 3 })],
    ['odd feature name', () => buildSketchCreate(schema, { ...doc, tipFeatureId: 12, sketchName: 'x"; drop', planeFeatureId: 3 })],
    ['zero width', () => buildSketchStep(schema, 'widthAdd', { ...geom, width: 0 })],
    ['dimension not matching lines', () => buildSketchStep(schema, 'heightAdd', { ...geom, width: 120 })],
    ['open outline', () => buildSketchStep(schema, 'sketchDraw', { ...geom, lines: [geom.lines[0], geom.lines[1], geom.lines[2], [-50, -30, -50, 40]] })],
    ['wrong line order', () => buildSketchStep(schema, 'sketchFinish', { ...geom, lines: [geom.lines[1], geom.lines[2], geom.lines[3], geom.lines[0]] })],
    ['not a geometry step', () => buildSketchStep(schema, 'extrudeCreate' as SketchGeometryStep, geom)],
    ['positive preview id', () => buildExtrudeModify(schema, { ...doc, sketchFeatureId: 15, extrudeName: 'E', previewFeatureId: 2, depth: 8 }, {})],
    ['negative depth', () => buildExtrudeModify(schema, { ...doc, sketchFeatureId: 15, extrudeName: 'E', previewFeatureId: -2, depth: -8 }, {})],
    ['unknown step', () => encodeTemplate(schema, 'extrudeDelete' as any)],
  ])('refuses %s', (_n, fn) => expect(fn).toThrow(RefusedWriteError));
});
