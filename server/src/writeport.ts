// OFFLINE write-path encoders for the plate workflow (sketch + dimensions + extrude). NOT wired to any live
// transport and NOT in the replay allow-list (queryport.ts). Every request starts from the UI request captured in
// runs/capture-plate1 (templates/plate1-write.json, records 113/228/236/297/303/311) and changes only the fields
// listed in SUBSTITUTED; everything else is sent exactly as the UI sent it (see docs/write-path.md for what is
// understood and what is copied unexplained).
import { z } from 'zod';
import template from './templates/plate1-write.json';
import type { Schema } from './wsframes';

export class AmbiguousProtocolError extends Error {}
export class RefusedWriteError extends Error {}

// The UI's own request order (capture-plate1 records 113, 121, 133, 214, 223, 236, 297, 303, 311). The UI's
// value edits 219 (174.92→100) and 228 (52.75→60) are omitted: our rectangle is drawn at its final size, so each
// dimension is added at its current value as 214/223 did. The edits also advanced the sketch version (4→5, 7→8)
// and renumbered vertex tags; whether Ivy accepts the resulting discontinuity is unverified (docs/write-path.md §5).
export const WRITE_STEPS = ['sketchCreate', 'sketchDraw', 'sketchClose', 'widthAdd', 'heightAdd', 'sketchFinish', 'extrudeCreate', 'extrudeModify', 'extrudeCommit'] as const;
export type WriteStep = (typeof WRITE_STEPS)[number];
export const SKETCH_GEOMETRY_STEPS = ['sketchDraw', 'sketchClose', 'widthAdd', 'heightAdd', 'sketchFinish'] as const;
export type SketchGeometryStep = (typeof SKETCH_GEOMETRY_STEPS)[number];

const GEOM = ['workshopHead.workshopId', 'workshopHead.currentDocId', 'workshopHead.featureId', 'header.tipFeatureId', 'sketchUpdateReq.supportBrep.featureId', 'sketchUpdateReq.geoms[0..3].line.{start,end,lastNonZeroDir}'];
/** The only fields a builder changes; everything else in each template is the captured UI value. */
export const SUBSTITUTED: Record<WriteStep, string[]> = {
  sketchCreate: ['workshopHead.workshopId', 'workshopHead.currentDocId', 'header.tipFeatureId', 'header.featureName', 'sketchUpdateReq.supportBrep.featureId'],
  sketchDraw: GEOM, sketchClose: GEOM,
  widthAdd: [...GEOM, 'sketchUpdateReq.constraints[8].constraint.value (DISTANCE_X = width)'],
  heightAdd: [...GEOM, 'sketchUpdateReq.constraints[8].constraint.value (width)', 'sketchUpdateReq.constraints[9].constraint.value (DISTANCE_Y = height)'],
  sketchFinish: [...GEOM, 'sketchUpdateReq.constraints[8|9].constraint.value'],
  extrudeCreate: ['workshopHead.workshopId', 'workshopHead.currentDocId', 'header.tipFeatureId', 'header.featureName', 'updateItems[30003].selection.items[0].featureId'],
  extrudeModify: ['workshopHead.{workshopId,currentDocId,featureId}', 'header.{tipFeatureId,featureName}', 'featUpdateReq.header.featureId', 'updateItems[10009].first.name', 'updateItems[30003] featureId', 'parmObjects of every parameter role, from the preceding preview notification', 'updateItems[31004] value (depth)'],
  extrudeCommit: ['(same as extrudeModify)', 'updateItems[31004] = the item sent by extrudeModify, verbatim'],
};

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const finite = z.number().finite();
const Line = z.tuple([finite, finite, finite, finite]); // start x, start y, end x, end y (sketch units, mm as captured)
const Lines = z.tuple([Line, Line, Line, Line]);
const length = z.number().finite().positive().max(10000);
const DocZ = z.object({ workshopId: id, docId: id }).strict();
const SketchCreateZ = DocZ.extend({ tipFeatureId: id, sketchName: name, planeFeatureId: id }).strict();
const SketchGeomZ = DocZ.extend({ sketchFeatureId: id, planeFeatureId: id, lines: Lines, width: length, height: length }).strict();
const ExtrudeCreateZ = DocZ.extend({ sketchFeatureId: id, extrudeName: name }).strict();
const tempId = z.number().int().negative().min(-Number.MAX_SAFE_INTEGER);
const ExtrudeModifyZ = ExtrudeCreateZ.extend({ previewFeatureId: tempId, depth: length }).strict();
const PlanZ = z.object({ tipFeatureId: id, planeFeatureId: id, sketchName: name, extrudeName: name, lines: Lines, width: length, height: length, depth: length }).strict();

export type Lines = z.infer<typeof Lines>;
export type SketchCreateIn = z.infer<typeof SketchCreateZ>;
export type SketchGeomIn = z.infer<typeof SketchGeomZ>;
export type ExtrudeCreateIn = z.infer<typeof ExtrudeCreateZ>;
export type ExtrudeModifyIn = z.infer<typeof ExtrudeModifyZ>;

function parse<T>(schema: z.ZodType<T>, x: unknown, what: string): T {
  const r = schema.safeParse(x);
  if (!r.success) throw new RefusedWriteError(`${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(input)'} ${i.message}`).join('; ')}`);
  return r.data;
}

/** The captured rectangle's line order: top (left→right), right (down), bottom (right→left), left (up). */
export function rectLines(x0: number, y0: number, width: number, height: number): Lines {
  const x1 = x0 + width, y1 = y0 + height;
  return [[x0, y1, x1, y1], [x1, y1, x1, y0], [x1, y0, x0, y0], [x0, y0, x0, y1]];
}

/** Closed, axis-aligned, in the captured order, and matching the two dimensions (tolerance for solver noise). */
function checkRectangle(lines: Lines, width: number, height: number) {
  const tol = 1e-6;
  const near = (a: number, b: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  for (let i = 0; i < 4; i++) {
    const [, , ex, ey] = lines[i], [sx, sy] = lines[(i + 1) % 4];
    if (!near(ex, sx) || !near(ey, sy)) throw new RefusedWriteError(`line ${i} does not end where line ${(i + 1) % 4} starts`);
  }
  const [t, r, b, l] = lines;
  const ok = near(t[1], t[3]) && near(b[1], b[3]) && near(r[0], r[2]) && near(l[0], l[2]) && t[2] > t[0] && r[3] < r[1] && b[2] < b[0] && l[3] > l[1];
  if (!ok) throw new RefusedWriteError('lines are not the captured top/right/bottom/left rectangle');
  if (!near(t[2] - t[0], width) || !near(l[3] - l[1], height)) throw new RefusedWriteError('lines do not match the width/height dimensions');
}

export type PlanIn = z.infer<typeof PlanZ>;
/** The live guard's approved design, under the builders' own field rules and rectangle check. */
export function checkPlan(raw: unknown): PlanIn {
  const x = parse(PlanZ, raw, 'plan');
  checkRectangle(x.lines, x.width, x.height);
  return x;
}

const clone = <T>(x: T): T => structuredClone(x);
const bodies = template.bodies as Record<WriteStep, any>;

function encodeBody(schema: Schema, body: any): Uint8Array {
  const P = schema.PartPkg!, A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq');
  const part = P.fromObject(body.modelPkg);
  const errP = P.verify(part); if (errP) throw new RefusedWriteError(`PartPkg: ${errP}`);
  const req = A.fromObject({ ...body, modelPkg: P.encode(part).finish() });
  const errA = A.verify(req); if (errA) throw new RefusedWriteError(`AppModelReq: ${errA}`);
  return A.encode(req).finish();
}

/** Encodes a captured template unchanged; used by tests to prove the encoder reproduces the UI bytes. */
export function encodeTemplate(schema: Schema, step: WriteStep): Uint8Array {
  if (!WRITE_STEPS.includes(step)) throw new RefusedWriteError(`unknown write step ${String(step)}`);
  return encodeBody(schema, clone(bodies[step]));
}

export function buildSketchCreate(schema: Schema, raw: unknown): { body: Uint8Array; request: any } {
  const x = parse(SketchCreateZ, raw, 'sketchCreate');
  const b = clone(bodies.sketchCreate);
  b.workshopHead.workshopId = String(x.workshopId); b.workshopHead.currentDocId = String(x.docId);
  b.modelPkg.header.tipFeatureId = String(x.tipFeatureId); b.modelPkg.header.featureName = x.sketchName;
  b.modelPkg.sketchUpdateReq.supportBrep.featureId = x.planeFeatureId;
  return { body: encodeBody(schema, b), request: b };
}

/** Constraint count and dimensions each captured sketch request carries (verified on records 121/133/214/223/236). */
export const SKETCH_DIMENSIONS: Record<SketchGeometryStep, { constraints: number; width: boolean; height: boolean }> = {
  sketchDraw: { constraints: 8, width: false, height: false }, sketchClose: { constraints: 8, width: false, height: false },
  widthAdd: { constraints: 9, width: true, height: false }, heightAdd: { constraints: 10, width: true, height: true },
  sketchFinish: { constraints: 10, width: true, height: true },
};

export function buildSketchStep(schema: Schema, step: SketchGeometryStep, raw: unknown) {
  if (!SKETCH_GEOMETRY_STEPS.includes(step)) throw new RefusedWriteError(`${String(step)} is not a sketch geometry step`);
  const x = parse(SketchGeomZ, raw, step);
  checkRectangle(x.lines, x.width, x.height);
  const b = clone(bodies[step]);
  b.workshopHead.workshopId = String(x.workshopId); b.workshopHead.currentDocId = String(x.docId); b.workshopHead.featureId = x.sketchFeatureId;
  b.modelPkg.header.tipFeatureId = String(x.sketchFeatureId);
  const s = b.modelPkg.sketchUpdateReq;
  s.supportBrep.featureId = x.planeFeatureId;
  if (s.geoms?.length !== 4 || s.geoms.some((g: any, i: number) => g.tag !== String(4 + i) || !g.line)) throw new AmbiguousProtocolError(`${step} template is not the 4-line rectangle`);
  s.geoms.forEach((g: any, i: number) => {
    const [sx, sy, ex, ey] = x.lines[i];
    const dx = ex - sx, dy = ey - sy;
    g.line.start = { ...(sx ? { x: sx } : {}), ...(sy ? { y: sy } : {}) };
    g.line.end = { ...(ex ? { x: ex } : {}), ...(ey ? { y: ey } : {}) };
    g.line.lastNonZeroDir = { ...(dx ? { x: dx } : {}), ...(dy ? { y: dy } : {}) }; // = end - start (verified on 121/133/214/223/236)
  });
  const dims = SKETCH_DIMENSIONS[step];
  const cons = s.constraints ?? [];
  const isDim = (c: any) => /^CONSTRAINT_TYPE_DISTANCE_[XY]$/.test(c?.constraint?.type ?? '');
  if (cons.length !== dims.constraints || cons.filter(isDim).length !== Number(dims.width) + Number(dims.height))
    throw new AmbiguousProtocolError(`${step} template does not have the captured constraints`);
  if (dims.width) {
    if (cons[8].constraint.type !== 'CONSTRAINT_TYPE_DISTANCE_X') throw new AmbiguousProtocolError(`${step}: constraint 8 is not DISTANCE_X`);
    cons[8].constraint.value = x.width;
  }
  if (dims.height) {
    if (cons[9].constraint.type !== 'CONSTRAINT_TYPE_DISTANCE_Y') throw new AmbiguousProtocolError(`${step}: constraint 9 is not DISTANCE_Y`);
    cons[9].constraint.value = x.height;
  }
  return { body: encodeBody(schema, b), request: b };
}

export function buildExtrudeCreate(schema: Schema, raw: unknown): { body: Uint8Array; request: any } {
  const x = parse(ExtrudeCreateZ, raw, 'extrudeCreate');
  const b = clone(bodies.extrudeCreate);
  b.workshopHead.workshopId = String(x.workshopId); b.workshopHead.currentDocId = String(x.docId);
  b.modelPkg.header.tipFeatureId = String(x.sketchFeatureId); b.modelPkg.header.featureName = x.extrudeName;
  setProfile(b, x.sketchFeatureId, 'extrudeCreate');
  return { body: encodeBody(schema, b), request: b };
}

function setProfile(b: any, sketchFeatureId: number, step: string) {
  const sel = b.modelPkg.featUpdateReq.updateItems.find((i: any) => Number(i.attrRole) === 30003)?.selection?.items;
  if (sel?.length !== 1) throw new AmbiguousProtocolError(`${step} template has no single profile selection`);
  sel[0].featureId = sketchFeatureId;
}

/** The single SolidExtrude preview feature in a preview notification (decoded IvyPkg object); fails closed otherwise. */
export function previewFeature(ntf: any, previewFeatureId: number): any {
  const descs = ntf?.appModelNtf?.modelDescs ?? [];
  const feats = descs.flatMap((d: any) => d.workbenchType === 1 ? (d.modelPkgDecoded?.dataNtf?.features ?? []) : []);
  const hits = feats.filter((f: any) => Number(f.featureId) === previewFeatureId && f.featUpdateFeature?.feat?.type === 'SolidExtrude');
  if (hits.length !== 1) throw new AmbiguousProtocolError(`expected 1 SolidExtrude preview feature ${previewFeatureId} in the notification, found ${hits.length}`);
  return hits[0].featUpdateFeature.feat;
}

const PARM_ROLES = [20003, 31004, 31010, 31013, 31018, 31021, 31027];
const DEPTH_ROLE = 31004;

/** ntf parameter → request parameter, as the UI did in 303/311: value re-formatted as a JS number, fields copied. */
function toParmItem(p: any) {
  if (p?.featId === undefined || p.fullName === undefined || p.value === undefined || !Number.isFinite(Number(p.value))) throw new AmbiguousProtocolError(`incomplete parameter in notification: ${JSON.stringify(p)}`);
  return { featId: String(p.featId), fullName: p.fullName, value: String(Number(p.value)), ...(p.formula !== undefined ? { formula: p.formula } : {}), type: p.type, ...(p.unit !== undefined ? { unit: p.unit } : {}) };
}

function buildExtrudeUpdate(schema: Schema, step: 'extrudeModify' | 'extrudeCommit', raw: unknown, ntf: any, editedDepthItem?: any) {
  const x = parse(ExtrudeModifyZ, raw, step);
  const feat = previewFeature(ntf, x.previewFeatureId);
  const b = clone(bodies[step]);
  b.workshopHead.workshopId = String(x.workshopId); b.workshopHead.currentDocId = String(x.docId); b.workshopHead.featureId = x.previewFeatureId;
  const h = b.modelPkg.header; h.tipFeatureId = String(x.sketchFeatureId); h.featureName = x.extrudeName;
  b.modelPkg.featUpdateReq.header.featureId = x.previewFeatureId;
  setProfile(b, x.sketchFeatureId, step);
  const sel = feat.attributes?.find((a: any) => Number(a.role) === 30003)?.select;
  if (sel?.length !== 1 || Number(sel[0].featureId) !== x.sketchFeatureId) throw new AmbiguousProtocolError('preview feature does not use the sketch as its profile');
  for (const item of b.modelPkg.featUpdateReq.updateItems) {
    if (Number(item.attrRole) === 10009) item.first.name = x.extrudeName;
    const role = Number(item.attrRole);
    if (!PARM_ROLES.includes(role)) continue;
    const parms = feat.attributes?.find((a: any) => Number(a.role) === role)?.parm;
    if (!Array.isArray(parms) || parms.length !== item.parmObjects.items.length) throw new AmbiguousProtocolError(`role ${role}: notification has ${parms?.length ?? 0} parameters, template ${item.parmObjects.items.length}`);
    item.parmObjects.items = parms.map(toParmItem);
    if (role === DEPTH_ROLE) {
      if (step === 'extrudeCommit') {
        // The UI's commit re-sent the item from the Modify that edited it (stale featId 21, not 28): copied, not inferred.
        if (!editedDepthItem) throw new AmbiguousProtocolError('commit needs the depth item sent by the preceding Modify');
        item.parmObjects.items = [clone(editedDepthItem)];
      } else {
        const [p] = item.parmObjects.items;
        item.parmObjects.items = [{ ...p, value: String(x.depth), formula: '' }];
      }
      if (Number(item.parmObjects.items[0].value) !== x.depth) throw new AmbiguousProtocolError('depth item does not carry the requested depth');
    }
  }
  const depthItem = b.modelPkg.featUpdateReq.updateItems.find((i: any) => Number(i.attrRole) === DEPTH_ROLE).parmObjects.items[0];
  return { body: encodeBody(schema, b), request: b, depthItem };
}
export const buildExtrudeModify = (schema: Schema, raw: unknown, previewNtf: any) => buildExtrudeUpdate(schema, 'extrudeModify', raw, previewNtf);
export const buildExtrudeCommit = (schema: Schema, raw: unknown, previewNtf: any, modifyDepthItem: any) => buildExtrudeUpdate(schema, 'extrudeCommit', raw, previewNtf, modifyDepthItem);
