// Live write guard for the plate workflow: a WriteTransport that would carry the reviewed nine steps to the editor
// page. It is DISABLED by default. Only read-only ports exist (liveports.ts); there is no sender, nothing constructs
// the guard outside tests, and the replay allow-list (queryport.ts) is unchanged. See docs/write-path.md §8.
//
// Constructing it validates the bound identity and the plan. Before a send: one call at a time, order (claimed
// synchronously), request shape (captured template + allowed paths), plan values, identity (field by field), a complete
// model-socket inventory naming only the bound socket, the server's session list naming only the bound session
// (re-checked after every step and by finish(), which also drains and classifies traffic after the last step), state drift since the last verified step, redo history, target features, and every traffic record since the last
// inspection (contiguous record indices). After a send: the request is located on the wire by its exact bytes in a
// frame carrying nothing else, its reply by the wire's exact async id and checked for command, target and feature;
// the notifications against the captured per-step pattern; traffic, socket lifecycle, the state change (per object,
// against the captured per-request undo marks and edge rules), the created feature's identity (the exact object its
// undo mark added, carrying the reply's id, and the new tip) and the depth Ivy reports are verified. Snapshots are
// copied on intake and structure-checked before any parser sees them. Traffic recorded after the pre-send traffic
// read and before the send is only inspected after the send, in the step's window. Any failure, timeout, exception or uncertain outcome latches the
// guard: every later exchange is refused without touching a port. Nothing is retried, cancelled, undone or deleted.
// Checking identity and drift just before a send narrows but cannot close the race with other editors.
import protobuf from 'protobufjs';
import { z } from 'zod';
import type { CaptureRecord } from './recorder';
import type { StateSnap } from './replaycheck';
import template from './templates/plate1-write.json';
import { decodeCapture, type Schema } from './wsframes';
import { checkPlan, previewFeature, RefusedWriteError, SKETCH_DIMENSIONS, SKETCH_GEOMETRY_STEPS, WRITE_STEPS, type Lines, type SketchGeometryStep, type WriteStep } from './writeport';
import { classifyGapTraffic, classifyStepTraffic, type StepTraffic, type WriteTransport } from './writeseq';

/** `sessionId`: the server session of the bound model socket, as its `ready` event named it (local server mode). */
export type Identity = { projectId: number; projectTag: string; workshopId: number; docId: number; modelSocket: string; sessionId: string };
/** The approved design; every value a request may carry is checked against it. */
export type Plan = { tipFeatureId: number; planeFeatureId: number; sketchName: string; extrudeName: string; lines: Lines; width: number; height: number; depth: number };
export type SocketInventory = { complete: boolean; modelSockets: string[] };
export type SendResult ={ ok: boolean; asyncId?: string | null; unknownOutcome?: boolean; error?: string };
export interface GuardPorts {
  /** Sends one already-checked app-model body; the only operation the guard can perform on Ivy. */
  sender: { sendRaw(cmd: number, bodyFieldNo: number, body: Uint8Array, timeoutMs: number): Promise<SendResult> };
  identity: {
    current(): Promise<Identity>;
    /**
     * Every Ivy model socket (`:8081/zcad/client`) open in the browser the recorder watches, including sockets opened
     * before the recorder attached (CDP reports only creations after Network.enable). `complete: true` only when the
     * enumeration is known to be exhaustive. Anything but a complete list of exactly the bound socket is refused.
     */
    modelSockets(): Promise<SocketInventory>;
    /**
     * The server's own list of WebSocket client sessions bound to the bound project (proposed Ivy tool
     * `zcad_list_sessions`, not in Ivy yet). Checked before every send and after every step: anything but exactly the
     * bound session is refused. It covers WebSocket clients only, not HTTP routes or pipeline requests.
     */
    sessions(): Promise<{ sessions: string[]; source?: 'server' | 'attested' }>;
  };
  state: { snapshot(): Promise<StateSnap> };
  /**
   * The recorder's one append-only record stream. `position()` is the index `i` the next record will get; `since(p)`
   * returns every record from index p on, in order, so their `i` are p, p+1, … (checked: a hole is refused).
   */
  traffic: { position(): number; since(position: number): CaptureRecord[] };
  settle(): Promise<void>;
}
type UndoSummary = { canUndo: number; canRedo: number; markNum: number; markIds: number[] };
export type ObjDiff = { added: Array<{ h: string; cls: string }>; removed: Array<{ h: string; cls: string }>; modified: Array<{ h: string; cls: string; paths: string[] }> };
/**
 * refused: not sent. verified: every check passed. failed: Ivy answered with an error result to exactly our request,
 * and the undo history, objects and edges show no change. unknown: anything else after the send boundary (the
 * request may have run, partly run or still run).
 */
export type StepRecord = {
  step: WriteStep; sent: boolean; outcome: 'refused' | 'verified' | 'failed' | 'unknown'; problems: string[];
  wireAsyncId?: string; pageAsyncId?: string | null; undoBefore?: UndoSummary; undoAfter?: UndoSummary; changes?: ObjDiff; error?: string;
};
export type GuardReport = {
  completed: WriteStep[]; steps: StepRecord[]; aborted?: string;
  /** The last well-formed state observed, before (`observedBefore`) or after (`observedAfter`) a step's send. */
  lastState?: { undo: UndoSummary; objects: number; observedBefore?: WriteStep; observedAfter?: WriteStep; verified: boolean };
  possibleHiddenResidue: boolean;
  final?: FinalCheck;
  /** Where every session check's evidence came from: 'server' (Ivy's list) or 'attested' (a user statement, not evidence). */
  exclusivity: string[];
};
/**
 * After the last exchange: every record since the last inspection classified (nothing after the commit's settle goes
 * unseen), the session list, and the state against the last verified after-state. `verified` only when all nine
 * steps were verified and this found nothing. On a stopped run it is evidence only.
 */
export type FinalCheck = { verified: boolean; problems: string[]; records: number };

const APP_MODEL_REQ = 120, APP_MODEL_FIELD = 100;
const MODEL_SOCKET_URL = /:8081\/zcad\/client/;
const COMMIT_STEPS: WriteStep[] = ['sketchCreate', ...SKETCH_GEOMETRY_STEPS, 'extrudeCommit'];

// ---------------------------------------------------------------- request shape (template + allowed paths)

const opts = { enums: String, longs: String, bytes: String, defaults: false };
export function flat(o: unknown, p = '', out: Record<string, unknown> = {}) {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
  else out[p] = o;
  return out;
}
const items = (s: WriteStep): any[] => (template.bodies as any)[s].modelPkg.featUpdateReq?.updateItems ?? [];
const idx = (s: WriteStep, role: number) => items(s).findIndex((i) => Number(i.attrRole) === role);
const PARMS = [20003, 31004, 31010, 31013, 31018, 31021, 31027];
const DEPTH_ROLE = 31004;
const ids = 'workshopHead\\.(workshopId|currentDocId)';
const parmPath = (s: WriteStep) => `modelPkg\\.featUpdateReq\\.updateItems\\.(${PARMS.map((r) => idx(s, r)).join('|')})\\.parmObjects\\.items\\.\\d+\\.(featId|fullName|value|formula|unit)`;
const extrudeUpdate = (s: WriteStep) => [ids, 'workshopHead\\.featureId', 'modelPkg\\.header\\.(tipFeatureId|featureName)', 'modelPkg\\.featUpdateReq\\.header\\.featureId',
  `modelPkg\\.featUpdateReq\\.updateItems\\.${idx(s, 10009)}\\.first\\.name`, `modelPkg\\.featUpdateReq\\.updateItems\\.${idx(s, 30003)}\\.selection\\.items\\.0\\.featureId`, parmPath(s)];
const sketchGeom = (dims: string) => [ids, 'workshopHead\\.featureId', 'modelPkg\\.header\\.tipFeatureId', 'modelPkg\\.sketchUpdateReq\\.supportBrep\\.featureId',
  'modelPkg\\.sketchUpdateReq\\.geoms\\.[0-3]\\.line\\.(start|end|lastNonZeroDir)\\.(x|y)', ...(dims ? [`modelPkg\\.sketchUpdateReq\\.constraints\\.(${dims})\\.constraint\\.value`] : [])];
/** Paths that may differ from the captured template (writeport SUBSTITUTED); their VALUES are then checked by checkPlanValues. */
export const ALLOWED_PATHS: Record<WriteStep, RegExp[]> = Object.fromEntries(Object.entries({
  sketchCreate: [ids, 'modelPkg\\.header\\.(tipFeatureId|featureName)', 'modelPkg\\.sketchUpdateReq\\.supportBrep\\.featureId'],
  sketchDraw: sketchGeom(''), sketchClose: sketchGeom(''), widthAdd: sketchGeom('8'), heightAdd: sketchGeom('8|9'), sketchFinish: sketchGeom('8|9'),
  extrudeCreate: [ids, 'modelPkg\\.header\\.(tipFeatureId|featureName)', `modelPkg\\.featUpdateReq\\.updateItems\\.${idx('extrudeCreate', 30003)}\\.selection\\.items\\.0\\.featureId`],
  extrudeModify: extrudeUpdate('extrudeModify'), extrudeCommit: extrudeUpdate('extrudeCommit'),
}).map(([s, ps]) => [s, ps.map((p) => new RegExp(`^${p}$`))])) as Record<WriteStep, RegExp[]>;

/** Decodes a body and checks its SHAPE: lossless decode, and differences from the template only on allowed paths. */
export function checkWriteRequest(schema: Schema, step: WriteStep, body: Uint8Array): { problems: string[]; request?: any } {
  if (!WRITE_STEPS.includes(step)) return { problems: [`step ${String(step)} is not allowed`] };
  const A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq');
  let req: any;
  try {
    const raw: any = A.decode(body);
    if (!Buffer.from(A.encode(raw).finish()).equals(Buffer.from(body))) return { problems: ['body does not re-encode identically'] };
    req = A.toObject(raw, opts);
    const P = schema.PartPkg!;
    const part: any = P.decode(raw.modelPkg);
    if (!Buffer.from(P.encode(part).finish()).equals(Buffer.from(raw.modelPkg))) return { problems: ['model package does not re-encode identically'] };
    req.modelPkg = P.toObject(part, opts);
  } catch (e) { return { problems: [`body does not decode: ${(e as Error).message}`] }; }
  const a = flat((template.bodies as any)[step]), b = flat(req);
  const problems: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    const allowed = ALLOWED_PATHS[step].some((r) => r.test(k));
    // Parameter entries may only carry values in places the template has them: no added entries or fields.
    if (allowed && /parmObjects\.items/.test(k) && !(k in a)) problems.push(`${step}: parameter field ${k} is not in the captured request`);
    else if (!allowed) problems.push(`${step}: field ${k} differs from the captured request (${JSON.stringify(a[k])} → ${JSON.stringify(b[k])})`);
  }
  return { problems, request: req };
}

// ---------------------------------------------------------------- plan values (separate from shape)

export type Known = { sketchFeatureId?: number; previewFeatureId?: number; previewFeature?: any; modifyDepthItem?: any };
const UNITS: Record<string, string | undefined> = { tLength: 'm', tAngle: undefined, tBool: undefined }; // as captured in 299/303/305/311

/** Checks every value the request carries against the plan, the bound target and what earlier steps established. */
export function checkPlanValues(step: WriteStep, req: any, plan: Plan, bound: Identity, known: Known): string[] {
  const p: string[] = [];
  const ws = req.workshopHead ?? {}, h = req.modelPkg?.header ?? {};
  const want = (cond: boolean, msg: string) => { if (!cond) p.push(`${step}: ${msg}`); };
  want(Number(ws.workshopId) === bound.workshopId && Number(ws.currentDocId) === bound.docId, `targets workshop ${ws.workshopId} / document ${ws.currentDocId}, not ${bound.workshopId} / ${bound.docId}`);
  if (step === 'sketchCreate') {
    want(Number(h.tipFeatureId) === plan.tipFeatureId, `tip ${h.tipFeatureId} is not the planned ${plan.tipFeatureId}`);
    want(h.featureName === plan.sketchName, `name ${h.featureName} is not ${plan.sketchName}`);
    want(Number(req.modelPkg.sketchUpdateReq?.supportBrep?.featureId) === plan.planeFeatureId, 'not on the planned plane');
    return p;
  }
  if ((SKETCH_GEOMETRY_STEPS as readonly string[]).includes(step)) {
    const s = req.modelPkg.sketchUpdateReq ?? {};
    want(known.sketchFeatureId !== undefined && Number(ws.featureId) === known.sketchFeatureId && Number(h.tipFeatureId) === known.sketchFeatureId, `not aimed at the created sketch ${known.sketchFeatureId}`);
    want(Number(s.supportBrep?.featureId) === plan.planeFeatureId, 'not on the planned plane');
    const g = s.geoms ?? [];
    want(g.length === 4, `has ${g.length} lines`);
    g.forEach((x: any, i: number) => {
      const l = x.line ?? {}, [sx, sy, ex, ey] = plan.lines[i] ?? [];
      const at = (v: any, c: 'x' | 'y') => Number(v?.[c] ?? 0);
      want(at(l.start, 'x') === sx && at(l.start, 'y') === sy && at(l.end, 'x') === ex && at(l.end, 'y') === ey, `line ${i} is not the planned line`);
      want(at(l.lastNonZeroDir, 'x') === ex - sx && at(l.lastNonZeroDir, 'y') === ey - sy, `line ${i} direction is not end − start`);
    });
    const dims = SKETCH_DIMENSIONS[step as SketchGeometryStep], c = s.constraints ?? [];
    want(c.length === dims.constraints, `has ${c.length} constraints, captured ${dims.constraints}`);
    const dist = c.filter((x: any) => /DISTANCE/.test(x.constraint?.type ?? ''));
    want(dist.length === Number(dims.width) + Number(dims.height), 'carries unexpected dimensions');
    if (dims.width) want(c[8]?.constraint?.type === 'CONSTRAINT_TYPE_DISTANCE_X' && Number(c[8].constraint.value) === plan.width, `constraint 8 is not DISTANCE_X = ${plan.width}`);
    if (dims.height) want(c[9]?.constraint?.type === 'CONSTRAINT_TYPE_DISTANCE_Y' && Number(c[9].constraint.value) === plan.height, `constraint 9 is not DISTANCE_Y = ${plan.height}`);
    return p;
  }
  const u = req.modelPkg.featUpdateReq ?? {};
  const role = (r: number) => (u.updateItems ?? []).find((i: any) => Number(i.attrRole) === r);
  want(known.sketchFeatureId !== undefined && Number(h.tipFeatureId) === known.sketchFeatureId, `tip ${h.tipFeatureId} is not the sketch ${known.sketchFeatureId}`);
  want(h.featureName === plan.extrudeName && h.featureType === 'ivy::SolidExtrude', `not the planned ${plan.extrudeName}`);
  want(Number(role(30003)?.selection?.items?.[0]?.featureId) === known.sketchFeatureId, 'profile is not the created sketch');
  if (step === 'extrudeCreate') return p;
  want(known.previewFeatureId !== undefined && Number(ws.featureId) === known.previewFeatureId && Number(u.header?.featureId) === known.previewFeatureId, `not aimed at preview ${known.previewFeatureId}`);
  want(role(10009)?.first?.name === plan.extrudeName, 'feature name item is not the planned name');
  const feat = known.previewFeature;
  if (!feat) { p.push(`${step}: no preview notification was observed to check parameters against`); return p; }
  for (const r of PARMS) {
    const sent = role(r)?.parmObjects?.items ?? [], seen = feat.attributes?.find((a: any) => Number(a.role) === r)?.parm ?? [];
    if (sent.length !== seen.length) { p.push(`${step}: role ${r} has ${sent.length} parameters, the preview ${seen.length}`); continue; }
    sent.forEach((x: any, i: number) => {
      const n = seen[i];
      if (!(n.type in UNITS) || x.type !== n.type || x.unit !== UNITS[n.type] || n.unit !== UNITS[n.type]) { p.push(`${step}: role ${r} parameter ${i} has unsupported type/unit ${x.type}/${x.unit}`); return; }
      if (r === DEPTH_ROLE && step === 'extrudeModify') {
        want(x.featId === String(n.featId) && x.fullName === n.fullName && x.value === String(plan.depth) && x.formula === '', `depth item is not ${plan.depth} on preview parameter ${n.featId}`);
      } else if (r === DEPTH_ROLE) {
        want(JSON.stringify(x) === JSON.stringify(known.modifyDepthItem) && x.value === String(plan.depth), 'depth item is not the one the Modify sent');
      } else {
        want(x.featId === String(n.featId) && x.fullName === n.fullName && x.value === String(Number(n.value)) && x.formula === n.formula, `role ${r} parameter ${i} is not the preview's ${n.featId}`);
      }
    });
  }
  return p;
}

// ---------------------------------------------------------------- state change (per object, captured evidence)

function undoOf(s: StateSnap) {
  const u = JSON.parse(s.undo);
  const marks = new Map<number, any>();
  for (const m of u.marks ?? []) marks.set(m.mark_id, m);
  const summary: UndoSummary = { canUndo: u.can_undo_step, canRedo: u.can_redo_step, markNum: u.markNum, markIds: [...marks.keys()] };
  return { summary, marks, strip: (m: any) => JSON.stringify({ ...m, is_current: undefined, queue_index: undefined }) };
}

const VOLATILE = new Set(['ivy::PipelineContext', 'ivy::VisuGeomObject']);
export function diffObjects(a: StateSnap, b: StateSnap): ObjDiff {
  const d: ObjDiff = { added: [], removed: [], modified: [] };
  for (const h of Object.keys(b.classes)) if (!(h in a.classes) && !VOLATILE.has(b.classes[h])) d.added.push({ h, cls: b.classes[h] });
  for (const h of Object.keys(a.classes)) if (!(h in b.classes) && !VOLATILE.has(a.classes[h])) d.removed.push({ h, cls: a.classes[h] });
  for (const h of Object.keys(a.classes)) {
    if (!(h in b.classes) || VOLATILE.has(a.classes[h]) || a.objects[h] === b.objects[h]) continue;
    let paths: string[];
    try { const x = flat(JSON.parse(a.objects[h])), y = flat(JSON.parse(b.objects[h])); paths = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])); }
    catch { paths = ['(non-JSON object)']; }
    d.modified.push({ h, cls: a.classes[h], paths });
  }
  return d;
}

/**
 * The non-visualisation entries of the undo mark each step created in the capture
 * (runs/capture-plate1 → test/fixtures/inspector/plate1-extrude/undo.json marks 3, 4, 5, 6, 8, 10, 13), as
 * `class/change` → count, change 3 = added, 1 = modified. Asserted against the fixture by the tests.
 */
export const EXPECTED_MARKS: Partial<Record<WriteStep, Record<string, number>>> = {
  sketchCreate: { 'ivy::FeatSketch/3': 1, 'ivy::ParmBool/3': 1, 'ivy::FeatSupportPositioned/3': 1, 'ivy::FeatContainer/1': 1, 'ivy::FeatPart/1': 1, 'ivy::FeatSolidSet/1': 1 },
  sketchDraw: { 'ivy::FeatSketch/1': 1 },
  sketchClose: { 'ivy::FeatSketch/1': 1, 'ivy::FeatSolidSet/1': 1 },
  widthAdd: { 'ivy::FeatSketch/1': 1, 'ivy::SketchLengthDimension/3': 1, 'ivy::FeatContainer/1': 1, 'ivy::FeatPart/1': 1, 'ivy::ParmLength/3': 1 },
  heightAdd: { 'ivy::FeatSketch/1': 1, 'ivy::SketchLengthDimension/3': 1, 'ivy::FeatContainer/1': 1, 'ivy::FeatPart/1': 1, 'ivy::ParmLength/3': 1 },
  sketchFinish: { 'ivy::FeatSketch/1': 1, 'ivy::FeatSolidSet/1': 1 },
  extrudeCommit: {
    'ivy::SolidExtrude/3': 1, 'ivy::ParmBool/3': 1, 'ivy::ParmLength/3': 10, 'ivy::ParmAngle/3': 4, 'ivy::FeatSketch/1': 1, 'ivy::FeatGeomBRep/3': 1,
    'ivy::FeatContainer/1': 1, 'ivy::FeatPart/1': 1, 'ivy::FeatSolidSet/1': 1, 'ivy::TopoContainer/1': 1, 'ivy::TopoGroup/3': 1, 'BRepContainer/1': 1, 'ivy::StableHub/3': 1,
  },
};
const MARK_SOURCE: Partial<Record<WriteStep, RegExp>> = { extrudeCommit: /^108\|0\|ivy::SolidExtrude$/ };
for (const s of ['sketchCreate', ...SKETCH_GEOMETRY_STEPS] as WriteStep[]) MARK_SOURCE[s] = /^6\|0\|$/;

// Visible JSON paths a step may change (probe evidence): the id counters on any step; the tip on create and commit;
// the sketch's options on commit. FeatSolidSet/FeatSketch appear modified in marks but their inspector JSON did not
// change in any probe, so any visible change to them (other than the commit's options) is unexpected.
const COUNTER_PATHS: Record<string, string[]> = { 'ivy::FeatContainer': ['_lastId', 'class_name_id_map_'], 'ivy::TopoContainer': ['_lastId'] };
const EDGE_PARENTS: Partial<Record<WriteStep, string[]>> = {
  sketchCreate: ['ivy::FeatSolidSet'], widthAdd: ['<sketch>'], heightAdd: ['<sketch>'],
  extrudeCommit: ['ivy::FeatSolidSet', 'ivy::TopoContainer', 'BRepContainer'],
};

export type StateCtx = { sketchHandle?: string; planeHandle?: string; newFeatureId?: number; tipIsEmptyBody?: boolean };

/**
 * The sketch's "needs update" option (attr_first_._featOptions, a 16-character bit string, most significant first):
 * bit value 128. Ivy's SketchFeatCmd::UpdateFeature sets it for a solve-only request (setNeedsUpdate(true)) and clears
 * it for a closing one (source). Seen live: plate-trial-write2 sketchDraw 0000000000100011 → 0000000010100011. Seen
 * cleared after the closing steps in the plate1 probes (plate1-sketch after sketchClose, plate1-dimension after
 * sketchFinish: 0000000000100011). widthAdd/heightAdd setting it rests on the source (their requests are solve-only).
 */
export const NEEDS_UPDATE_BIT = 128;
const NEEDS_UPDATE_AFTER: Partial<Record<WriteStep, boolean>> = { sketchDraw: true, widthAdd: true, heightAdd: true, sketchClose: false, sketchFinish: false };
const OPTIONS = /^[01]{16}$/;
const bitSet = (o: string, bit: number) => ((parseInt(o, 2) & bit) !== 0);
const optionsOf = (s: StateSnap, h: string): string | undefined => { try { return JSON.parse(s.objects[h]).attr_first_?._featOptions; } catch { return undefined; } };

/**
 * null when the sketch's options went from `before` to `after` by exactly the needs-update bit, in the step's
 * direction (set by the solve-only steps, cleared by the closing ones); otherwise why not. Any other bit, a malformed
 * value or the wrong direction is a problem.
 */
export function needsUpdateTransition(step: WriteStep, before: string | undefined, after: string | undefined): string | null {
  const want = NEEDS_UPDATE_AFTER[step];
  if (want === undefined) return `${step} may not change the sketch's options`;
  if (!OPTIONS.test(before ?? '') || !OPTIONS.test(after ?? '')) return `the sketch's options ${before} → ${after} are not 16-bit flag strings`;
  const diff = parseInt(before!, 2) ^ parseInt(after!, 2);
  if (diff !== NEEDS_UPDATE_BIT) return `the sketch's options changed ${before} → ${after}: only the needs-update bit (${NEEDS_UPDATE_BIT}) may change`;
  if (bitSet(after!, NEEDS_UPDATE_BIT) !== want) return `${step} ${want ? 'cleared' : 'set'} the sketch's needs-update bit (${before} → ${after}); it must ${want ? 'set' : 'clear'} it`;
  return null;
}

/**
 * Whether the state proves the planned tip is the document's EMPTY body: the FeatPart's tip is `tipId` itself, that
 * object is an ivy::FeatSolidSet, and it contains nothing. Then Ivy reports the first feature added to the body with
 * previousFeatureId -1 (plate-trial-write1, notification 99: tip 9 = the solid set, new sketch 12, previous -1).
 */
export function isEmptyBodyTip(s: StateSnap, tipId: number): boolean {
  const tip = tipOf(s);
  if (!tip || tip.id !== tipId || s.classes[tip.handle] !== 'ivy::FeatSolidSet') return false;
  return !s.edges.some((e) => { const p = parseEdge(e); return !p || (p.from === tip.handle && p.label === 'Contain'); });
}

/** Problems with the change one step made, per object; empty means it matches the captured pattern for the step. */
export function checkStateChange(step: WriteStep | 'noChange', before: StateSnap, after: StateSnap, ctx: StateCtx = {}): string[] {
  const out: string[] = [];
  const committing = step !== 'noChange' && COMMIT_STEPS.includes(step);
  const ub = undoOf(before), ua = undoOf(after);
  for (const [id, m] of ub.marks) if (!ua.marks.has(id) || ub.strip(m) !== ua.strip(ua.marks.get(id))) out.push(`undo mark ${id} changed or vanished`);
  const newMarks = [...ua.marks.keys()].filter((id) => !ub.marks.has(id));
  const d = diffObjects(before, after);
  let entries: any[] = [];
  if (!committing) {
    if (before.undo !== after.undo) out.push('undo history changed although this step must not record one');
  } else if (ua.summary.canUndo !== ub.summary.canUndo + 1 || ua.summary.canRedo !== 0 || newMarks.length !== 1) {
    out.push(`undo: expected one new undo step, saw undo ${ub.summary.canUndo}→${ua.summary.canUndo}, redo ${ua.summary.canRedo}, ${newMarks.length} new mark(s)`);
  } else {
    const mark = ua.marks.get(newMarks[0]);
    if (!MARK_SOURCE[step as WriteStep]!.test(mark.source_cmd ?? '')) out.push(`undo: new mark source "${mark.source_cmd}" is not the expected command`);
    entries = (mark.mark ?? []).filter((e: any) => !VOLATILE.has(e.class_name));
    const sig: Record<string, number> = {};
    for (const e of entries) sig[`${e.class_name}/${e.change_type}`] = (sig[`${e.class_name}/${e.change_type}`] ?? 0) + 1;
    const want = EXPECTED_MARKS[step as WriteStep]!;
    for (const k of new Set([...Object.keys(sig), ...Object.keys(want)])) if (sig[k] !== want[k]) out.push(`undo mark: ${k} ×${sig[k] ?? 0}, captured ×${want[k] ?? 0}`);
  }
  const entryFor = (h: string, change: number) => entries.some((e) => String(e.obj_id) === h && e.change_type === change);
  for (const a of d.added) if (!committing || !entryFor(a.h, 3)) out.push(`unexpected new ${a.cls} #${a.h}`);
  for (const e of entries.filter((x) => x.change_type === 3)) if (!(String(e.obj_id) in after.classes)) out.push(`undo mark adds ${e.class_name} #${e.obj_id} but the inspector does not show it`);
  for (const r of d.removed) out.push(`unexpected removal of ${r.cls} #${r.h}`);
  for (const m of d.modified) {
    const counters = COUNTER_PATHS[m.cls] ?? [];
    const rest = m.paths.filter((p) => !counters.some((c) => p === c || p.startsWith(`${c}.`)));
    if (m.cls === 'ivy::FeatContainer' && m.paths.includes('_lastId')) {
      const [x, y] = [JSON.parse(before.objects[m.h])._lastId, JSON.parse(after.objects[m.h])._lastId].map(Number);
      if (!(y >= x)) out.push(`id counter went backwards (${x} → ${y})`);
    }
    if (!rest.length) continue;
    const tipOk = committing && (step === 'sketchCreate' || step === 'extrudeCommit') && m.cls === 'ivy::FeatPart' && rest.every((p) => p === 'attr_tip_feat_') && entryFor(m.h, 1)
      && new RegExp(`^_vValue:\\[${ctx.newFeatureId}_\\d+\\]$`).test(JSON.parse(after.objects[m.h]).attr_tip_feat_ ?? '');
    const optionsOk = step === 'extrudeCommit' && m.h === ctx.sketchHandle && rest.every((p) => p === 'attr_first_._featOptions') && entryFor(m.h, 1);
    // Sketch steps: only the needs-update bit of our sketch, in the step's direction (needsUpdateTransition).
    const onlyOptions = m.h === ctx.sketchHandle && rest.length === 1 && rest[0] === 'attr_first_._featOptions' && entryFor(m.h, 1);
    const flagProblem = onlyOptions && NEEDS_UPDATE_AFTER[step as WriteStep] !== undefined ? needsUpdateTransition(step as WriteStep, optionsOf(before, m.h), optionsOf(after, m.h)) : undefined;
    if (flagProblem) out.push(flagProblem);
    else if (!tipOk && !optionsOk && !(onlyOptions && flagProblem === null)) out.push(`unexpected change to ${m.cls} #${m.h}: ${rest.slice(0, 5).join(', ')}`);
  }
  // The flag must also END in the step's state when it did not change (e.g. a closing step that left it set).
  const want = NEEDS_UPDATE_AFTER[step as WriteStep];
  if (committing && want !== undefined && ctx.sketchHandle && ctx.sketchHandle in after.objects) {
    const o = optionsOf(after, ctx.sketchHandle);
    if (!OPTIONS.test(o ?? '')) out.push(`the sketch's options ${o} are not a 16-bit flag string`);
    else if (bitSet(o!, NEEDS_UPDATE_BIT) !== want) out.push(`after ${step} the sketch's needs-update bit is ${want ? 'clear' : 'set'} (options ${o})`);
  }
  if (committing && ['sketchDraw', 'sketchClose', 'widthAdd', 'heightAdd', 'sketchFinish', 'extrudeCommit'].includes(step)
    && !entries.some((e) => e.class_name === 'ivy::FeatSketch' && e.change_type === 1 && String(e.obj_id) === ctx.sketchHandle)) out.push('undo mark does not modify the created sketch');
  out.push(...checkEdges(step, before, after, d, ctx));
  return out;
}

const parseEdge = (e: string) => { const m = /^"(\d+)" -> "(\d+)" \[label="(\w+)"/.exec(e); return m ? { from: m[1], to: m[2], label: m[3] } : undefined; };
/** The edges not touching an object of the `skip` classes; an edge that cannot be parsed is a problem, never dropped. */
function edgeSet(s: StateSnap, skip: Set<string>, problems: string[], label: string) {
  const out = new Set<string>();
  for (const e of s.edges) {
    const p = parseEdge(e);
    if (!p) { problems.push(`unparsable edge in the ${label} state: ${e}`); continue; }
    if (!skip.has(s.classes[p.from] ?? '') && !skip.has(s.classes[p.to] ?? '')) out.add(e);
  }
  return out;
}

function checkEdges(step: WriteStep | 'noChange', before: StateSnap, after: StateSnap, d: ObjDiff, ctx: StateCtx): string[] {
  const out: string[] = [];
  const parse = parseEdge;
  const isNew = new Set(d.added.map((a) => a.h));
  const eb = edgeSet(before, VOLATILE, out, 'before'), ea = edgeSet(after, VOLATILE, out, 'after');
  for (const e of eb) if (!ea.has(e)) out.push(`edge removed: ${e}`);
  const parents = EDGE_PARENTS[step as WriteStep] ?? [];
  for (const e of ea) {
    if (eb.has(e)) continue;
    const p = parse(e)!;
    if (isNew.has(p.from) && isNew.has(p.to)) continue;
    if (!isNew.has(p.from) && isNew.has(p.to) && (parents.includes(after.classes[p.from]) || (parents.includes('<sketch>') && p.from === ctx.sketchHandle))) continue;
    if (isNew.has(p.from) && !isNew.has(p.to) && p.label === 'DependsOn'
      && ((step === 'sketchCreate' && p.to === ctx.planeHandle) || (step === 'extrudeCommit' && p.to === ctx.sketchHandle))) continue;
    out.push(`unexpected edge: ${e}`);
  }
  return out;
}

// ---------------------------------------------------------------- snapshot structure, feature identity

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

/**
 * Problems with a snapshot's structure. Every parser in this file (undoOf, diffObjects, featureFacts, tipOf, the
 * edge rules) assumes a snapshot that passed this, so a malformed one is never compared or treated as equal.
 */
export function snapshotProblems(s: unknown): string[] {
  if (!isObj(s)) return ['snapshot is not an object'];
  const { undo, classes, objects, edges } = s;
  const out: string[] = [];
  if (!isObj(classes) || !Object.values(classes).every((c) => typeof c === 'string' && c !== '')) out.push('classes are missing or not class names');
  if (!isObj(objects) || !Object.values(objects).every((o) => typeof o === 'string')) out.push('objects are missing or not JSON text');
  if (!Array.isArray(edges) || !edges.every((e) => typeof e === 'string')) out.push('edges are missing or not text');
  let u: any;
  try { u = typeof undo === 'string' ? JSON.parse(undo) : undefined; } catch { /* reported below */ }
  if (!isObj(u)) out.push('undo history is not a JSON object');
  else {
    if (!count(u.can_undo_step) || !count(u.can_redo_step) || !count(u.markNum)) out.push('undo counts are missing or not counts');
    if (!Array.isArray(u.marks) || !u.marks.every((m: any) => isObj(m) && count(m.mark_id) && (m.mark === undefined || (Array.isArray(m.mark) && m.mark.every(isObj)))))
      out.push('undo marks are missing or malformed');
    else if (new Set(u.marks.map((m: any) => m.mark_id)).size !== u.marks.length) out.push('undo mark ids repeat');
  }
  if (out.length) return out;
  for (const h of Object.keys(objects)) {
    if (!(h in classes)) { out.push(`object #${h} has no class`); continue; }
    try { if (!isObj(JSON.parse(objects[h]))) out.push(`object #${h} is not a JSON object`); } catch { out.push(`object #${h} is not JSON`); }
  }
  const parts = Object.keys(classes).filter((h) => classes[h] === 'ivy::FeatPart');
  if (parts.length !== 1 || objects[parts[0]] === undefined) out.push(`expected one ivy::FeatPart with its object, found ${parts.length}`);
  return out;
}

const featIdOf = (s: StateSnap, h: string) => Number(JSON.parse(s.objects[h] ?? '{}').attr_first_?._id);
/** The feature-tree tip as the FeatPart shows it: `_vValue:[<feature id>_<object handle>]` (captured: 43_626). */
export function tipOf(s: StateSnap): { id: number; handle: string } | undefined {
  const part = Object.keys(s.classes).find((h) => s.classes[h] === 'ivy::FeatPart');
  const m = part ? /^_vValue:\[(\d+)_(\d+)\]$/.exec(JSON.parse(s.objects[part] ?? '{}').attr_tip_feat_ ?? '') : null;
  return m ? { id: Number(m[1]), handle: m[2] } : undefined;
}

function featureFacts(s: StateSnap, planeFeatureId: number) {
  const byId = (cls: string, id: number) => Object.keys(s.classes).filter((h) => s.classes[h] === cls && featIdOf(s, h) === id);
  return { tip: tipOf(s)?.id ?? NaN, byId, planes: byId('ivy::FeatOriginPlane', planeFeatureId) };
}

/**
 * Binds a created feature to the one object the step's undo mark added: the single new mark must add exactly one
 * `cls` object; it must be new, visible, carry the reply's feature id, no object may have carried that id before,
 * and the tip must name exactly that id and object (captured: sketch 15 / #543 after 113, extrude 43 / #626 after 311).
 */
export function bindCreated(cls: string, id: number, before: StateSnap, after: StateSnap): { handle?: string; problems: string[] } {
  const ub = undoOf(before), ua = undoOf(after);
  const fresh = [...ua.marks.keys()].filter((m) => !ub.marks.has(m));
  const entries: any[] = fresh.length === 1 ? (ua.marks.get(fresh[0]).mark ?? []) : [];
  const hs = [...new Set(entries.filter((e) => e.class_name === cls && e.change_type === 3).map((e) => String(e.obj_id)))];
  if (hs.length !== 1) return { problems: [`the undo mark adds ${hs.length} ${cls} objects, expected 1`] };
  const [h] = hs, p: string[] = [];
  if (h in before.classes) p.push(`${cls} #${h} existed before the step`);
  if (after.classes[h] !== cls) p.push(`the added ${cls} #${h} is not visible after the step`);
  else if (featIdOf(after, h) !== id) p.push(`the added ${cls} #${h} is feature ${featIdOf(after, h)}, the reply names ${id}`);
  const clash = Object.keys(before.classes).find((x) => featIdOf(before, x) === id);
  if (clash) p.push(`feature id ${id} already belonged to ${before.classes[clash]} #${clash} before the step`);
  const tip = tipOf(after);
  if (tip?.id !== id || tip.handle !== h) p.push(`the tip is ${tip ? `${tip.id}_${tip.handle}` : 'unreadable'}, not the new ${cls} ${id}_${h}`);
  return { handle: p.length ? undefined : h, problems: p };
}

// ---------------------------------------------------------------- drift between verified steps

// Between steps no request of ours is in flight, so the state must equal the last verified after-state exactly.
// Exempt: ivy::PipelineContext only, the one object a no-op request changed (replaycheck.ts VOLATILE, §6). Unlike
// the per-step check, VisuGeomObject is NOT exempt: its churn was observed only inside committing steps.
const DRIFT_EXEMPT = new Set(['ivy::PipelineContext']);

/** Differences between the last verified state and the state just before the next send; empty means no drift. */
export function checkDrift(verified: StateSnap, now: StateSnap): string[] {
  const out: string[] = [];
  if (verified.undo !== now.undo) {
    const a = undoOf(verified).summary, b = undoOf(now).summary;
    out.push(`undo history changed (undo ${a.canUndo}→${b.canUndo}, redo ${a.canRedo}→${b.canRedo}, marks ${a.markIds.join(',')}→${b.markIds.join(',')})`);
  }
  for (const h of new Set([...Object.keys(verified.classes), ...Object.keys(now.classes)])) {
    const [ca, cb] = [verified.classes[h], now.classes[h]];
    const exempt = (c?: string) => c === undefined || DRIFT_EXEMPT.has(c);
    if (exempt(ca) && exempt(cb)) continue;
    if (ca === undefined) out.push(`new object ${cb} #${h}`);
    else if (cb === undefined) out.push(`object ${ca} #${h} removed`);
    else if (ca !== cb) out.push(`object #${h} changed class ${ca} → ${cb}`);
    else if (verified.objects[h] !== now.objects[h]) out.push(`object ${ca} #${h} changed`);
  }
  const ea = edgeSet(verified, DRIFT_EXEMPT, out, 'verified'), eb = edgeSet(now, DRIFT_EXEMPT, out, 'current');
  for (const e of ea) if (!eb.has(e)) out.push(`edge removed: ${e}`);
  for (const e of eb) if (!ea.has(e)) out.push(`edge added: ${e}`);
  return out;
}

// ---------------------------------------------------------------- depth as Ivy reports it

const mergedNtf = (ntfs: any[]) => (ntfs.length === 1 ? ntfs[0] : { appModelNtf: { modelDescs: ntfs.flatMap((n) => n.appModelNtf?.modelDescs ?? []) } });

/**
 * The depth Ivy reports for one SolidExtrude feature in the step's notifications: exactly one feature with that id,
 * exactly one role-31004 attribute with exactly one tLength parameter whose value (and formula, when present) is
 * the plan's depth. Captured: preview -2 after Modify 303 → notification 305 ("8.000000", formula "8"); committed 43
 * after 311 → notification 313 (same). A reply code or the feature tree alone is not taken as proof of the depth.
 */
export function checkReportedDepth(ntfs: any[], featureId: number, depth: number, what: string): string[] {
  let feat: any;
  try { feat = previewFeature(mergedNtf(ntfs), featureId); } catch (e) { return [`${what} depth: ${(e as Error).message}`]; }
  const attrs = (feat.attributes ?? []).filter((a: any) => Number(a.role) === DEPTH_ROLE);
  if (attrs.length !== 1) return [`${what} depth: feature ${featureId} has ${attrs.length} depth attributes (role ${DEPTH_ROLE})`];
  const parms = attrs[0].parm ?? [];
  if (parms.length !== 1) return [`${what} depth: feature ${featureId} has ${parms.length} depth parameters`];
  const [x] = parms;
  const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (x.type !== 'tLength' || !Number.isFinite(num(x.value)) || (x.formula !== undefined && !Number.isFinite(num(x.formula))))
    return [`${what} depth: malformed depth parameter ${JSON.stringify(x)}`];
  if (num(x.value) !== depth || (x.formula !== undefined && num(x.formula) !== depth))
    return [`${what} depth: feature ${featureId} reports depth ${x.value} (formula ${x.formula}), the plan is ${depth}`];
  return [];
}

// ---------------------------------------------------------------- the frame, the reply and the record stream

/** The app-model bodies (field 100) of one sent frame, and a problem unless it is exactly one header and one body. */
export function frameRequestBodies(payload: string): { bodies: Buffer[]; problem?: string } {
  let raw = Buffer.from(payload, 'base64');
  if (raw.length >= 35 && raw[0] === 0x5a && raw[1] === 1) raw = raw.subarray(35); // trace header, as sentBody
  const bodies: Buffer[] = [], fields: number[] = [];
  try {
    const r = protobuf.Reader.create(raw);
    while (r.pos < r.len) {
      const t = r.uint32();
      fields.push(t >>> 3);
      if (t >>> 3 === APP_MODEL_FIELD && (t & 7) === 2) bodies.push(Buffer.from(r.bytes())); else r.skipType(t & 7);
    }
  } catch (e) { return { bodies, problem: `the request frame does not parse: ${(e as Error).message}` }; }
  const ok = fields.length === 2 && fields.filter((f) => f === 1).length === 1 && bodies.length === 1;
  return { bodies, problem: ok ? undefined : `the request frame carries fields ${fields.join(',')}, not exactly one header and one body` };
}

const errorOf = (reply: any) => {
  const rsp = reply?.appModelRsp, inner = rsp?.modelPkgDecoded;
  return rsp?.result || inner?.featUpdateRsp?.result || inner?.sketchUpdateRsp?.result || 0;
};
const REPLY_KIND = (s: WriteStep) => (s.startsWith('extrude')
  ? { cmd: 'IVY_PART_FEAT_UPDATE_UPDATE_RSP', type: 'ivy::SolidExtrude' } : { cmd: 'IVY_PART_SKETCH_UPDATE_RSP', type: 'ivy::FeatSketch' });

/**
 * The reply must be an app-model response with the wire request's exact async id, for the bound project and
 * document, of the step's command and feature type. Without an error it must name the expected feature: a new
 * sketch (> 0), our sketch, a new preview (< 0), our preview, a new feature (> 0). Error replies carry no feature
 * id (captured 455/459), so only their command, type and target are checked.
 */
function replyProblems(step: WriteStep, reply: any, wireId: string | undefined, bound: Identity, known: Known): string[] {
  if (!reply) return ['no reply to the request'];
  const p: string[] = [];
  const h = reply.header ?? {}, rsp = reply.appModelRsp, ws = rsp?.workshopHead ?? {}, inner = rsp?.modelPkgDecoded?.header;
  if (h.cmd !== 'IVY_APP_MODEL_RSP') p.push(`reply command ${h.cmd} is not IVY_APP_MODEL_RSP`);
  if (wireId === undefined || String(h.asyncId) !== wireId) p.push(`reply async id ${h.asyncId} is not the wire request's ${wireId}`);
  if (String(h.projectId) !== String(bound.projectId)) p.push(`reply is for project ${h.projectId}`);
  if (Number(ws.workshopId) !== bound.workshopId || Number(ws.currentDocId) !== bound.docId) p.push(`reply is for workshop ${ws.workshopId} / document ${ws.currentDocId}`);
  if (!inner) return [...p, 'reply has no decodable model header'];
  const want = REPLY_KIND(step);
  if (inner.cmd !== want.cmd || inner.featureType !== want.type) p.push(`reply is ${inner.cmd} / ${inner.featureType}, expected ${want.cmd} / ${want.type}`);
  if (!errorOf(reply)) {
    const id = Number(inner.featureId), sketch = known.sketchFeatureId;
    const [ok, what] = step === 'sketchCreate' ? [id > 0, 'a new sketch id']
      : step === 'extrudeCreate' ? [id < 0, 'a preview id']
      : step === 'extrudeModify' ? [id === known.previewFeatureId, `preview ${known.previewFeatureId}`]
      : step === 'extrudeCommit' ? [id > 0 && id !== sketch, 'a new feature id']
      : [id === sketch, `sketch ${sketch}`];
    if (!ok || !Number.isSafeInteger(id)) p.push(`reply names feature ${inner.featureId}, expected ${what}`);
  }
  return p;
}

/**
 * The model notifications of one step, against the captured pattern (plate1 windows, see docs/write-path.md §4):
 * every one is for the bound project, workshop and document (one model description), from the reply's session;
 * sketch steps: exactly one bare workbench-2 notification and one IVY_PART_DATA_NTF naming the sketch (113→115/116 …
 * 236→239/240), whose tip, on the create, must be present and be the new sketch (116); previews: exactly one, flagged preview, carrying only the preview SolidExtrude (299, 305); commit:
 * exactly one, tip = the new feature, which follows the sketch (313); error replies: at most one, carrying no
 * feature (455→456; 459 had none).
 */
export function notificationProblems(step: WriteStep, ntfs: any[], reply: any, bound: Identity, ids: { sketch?: number; preview?: number; created?: number; priorTip: number; priorTipIsEmptyBody?: boolean }, error: boolean): string[] {
  const p: string[] = [];
  const session = reply?.header?.userSessionId;
  const descs = (n: any): any[] => n?.appModelNtf?.modelDescs ?? [];
  ntfs.forEach((n, k) => {
    const h = n?.header ?? {}, ws = n?.appModelNtf?.workshopHead ?? {};
    if (String(h.projectId) !== String(bound.projectId)) p.push(`notification ${k} is for project ${h.projectId}`);
    if (session === undefined || String(h.userSessionId) !== String(session)) p.push(`notification ${k} is from session ${h.userSessionId}, the reply from ${session}`);
    if (Number(ws.workshopId) !== bound.workshopId || Number(ws.currentDocId) !== bound.docId) p.push(`notification ${k} is for workshop ${ws.workshopId} / document ${ws.currentDocId}`);
    if (descs(n).length !== 1 || Number(descs(n)[0].docId) !== bound.docId) p.push(`notification ${k} has ${descs(n).length} model descriptions, not one for document ${bound.docId}`);
  });
  if (p.length) return p.map((x) => `${step}: ${x}`);
  const data = ntfs.filter((n) => Number(descs(n)[0].workbenchType) === 1);
  const bare = ntfs.filter((n) => Number(descs(n)[0].workbenchType) === 2 && descs(n)[0].modelPkg === undefined);
  const feats = (n: any): any[] => descs(n)[0].modelPkgDecoded?.dataNtf?.features ?? [];
  const head = (n: any) => descs(n)[0].modelPkgDecoded?.header ?? {};
  const want = (cond: boolean, msg: string) => { if (!cond) p.push(`${step}: ${msg}`); };
  if (error) {
    want(ntfs.length <= 1 && data.length === ntfs.length && data.every((n) => feats(n).length === 0), `an error reply came with ${ntfs.length} notification(s), expected at most one carrying no feature`);
    return p;
  }
  const one = (n: any, id: number | undefined) => feats(n).filter((f) => Number(f.featureId) === id);
  if (step === 'extrudeCreate' || step === 'extrudeModify') {
    want(ntfs.length === 1 && data.length === 1, `${ntfs.length} notifications, captured exactly one preview notification`);
    if (data.length !== 1) return p;
    const f = feats(data[0]);
    want(data[0].appModelNtf.workshopHead.isPreview === true, 'the notification is not flagged as a preview');
    want(f.length === 1 && Number(f[0].featureId) === ids.preview && f[0].featUpdateFeature?.feat?.type === 'SolidExtrude', `the preview notification does not carry only the preview SolidExtrude ${ids.preview}`);
    return p;
  }
  if (step === 'extrudeCommit') {
    want(ntfs.length === 1 && data.length === 1, `${ntfs.length} notifications, captured exactly one`);
    if (data.length !== 1) return p;
    const f = one(data[0], ids.created);
    want(!data[0].appModelNtf.workshopHead.isPreview, 'the commit notification is flagged as a preview');
    want(Number(head(data[0]).tipFeatureId) === ids.created, `the notification's tip ${head(data[0]).tipFeatureId} is not the new feature ${ids.created}`);
    want(f.length === 1 && f[0].featUpdateFeature?.feat?.type === 'SolidExtrude' && Number(f[0].previousFeatureId) === ids.sketch,
      `the notification does not carry exactly one SolidExtrude ${ids.created} following the sketch ${ids.sketch}`);
    return p;
  }
  // sketch steps
  want(ntfs.length === 2 && data.length === 1 && bare.length === 1, `${ntfs.length} notifications (${data.length} data, ${bare.length} bare), captured exactly one of each`);
  if (data.length !== 1) return p;
  const f = one(data[0], ids.sketch), tip = head(data[0]).tipFeatureId;
  want(head(data[0]).cmd === 'IVY_PART_DATA_NTF', `the data notification is ${head(data[0]).cmd}`);
  want(f.length === 1 && f[0].feature === 'sketchFeature', `the data notification does not carry the sketch ${ids.sketch} exactly once`);
  // Captured: the create's notification names the new tip (116: 15); later sketch steps may omit it (125, 137, 240).
  want(step === 'sketchCreate' ? tip !== undefined && Number(tip) === ids.sketch : tip === undefined || Number(tip) === ids.sketch, `the notification's tip ${tip} is not the sketch ${ids.sketch}`);
  // Exactly the planned tip (captured 116), or -1 only when the before-state proved that tip is the empty body
  // (isEmptyBodyTip; captured plate-trial-write1 notification 99).
  const prev = Number(f[0]?.previousFeatureId);
  if (step === 'sketchCreate') want(prev === ids.priorTip || (ids.priorTipIsEmptyBody === true && prev === -1), `the new sketch does not follow the planned tip ${ids.priorTip}`);
  return p;
}

const TRACE_HEADER = 35; // wsframes TRACE_HEADER_SIZE
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Why a binary payload would carry nothing decodeCapture can classify (it silently drops zero-byte bodies). */
function binaryProblem(payload: unknown): string | undefined {
  if (typeof payload !== 'string' || payload === '') return 'empty binary frame';
  if (!BASE64.test(payload)) return 'binary frame that is not valid base64';
  const raw = Buffer.from(payload, 'base64');
  if (raw.length === TRACE_HEADER && raw[0] === 0x5a && raw[1] === 1) return 'binary frame carrying only a trace header';
  return undefined;
}

/**
 * Every record of a window, which must start at `from` with contiguous indices (the traffic port's contract: one
 * append-only index, as the recorder writes it). Allowed: annotations; model-socket frames of opcode 1 (text, checked
 * as the page's ping by the classifier) and opcode 2 with a valid base64 payload carrying more than a trace header
 * (decoded and classified); frames of other sockets, which are NOT inspected: whether they can carry Ivy model traffic
 * is not established, so the identity port must prove the bound socket is the only model socket (docs/write-path.md
 * §5, §8). Refused: any socket opened, closed or failing during the run, other opcodes, binary payloads that would
 * decode to nothing, unknown types.
 */
function recordProblems(recs: CaptureRecord[], from: number, modelSocket: string): string[] {
  const out: string[] = [];
  const hole = recs.findIndex((r, k) => r.i !== from + k);
  if (hole >= 0) out.push(`traffic record ${recs[hole].i} where ${from + hole} was expected: records were lost, reordered or renumbered`);
  for (const r of recs as any[]) {
    if (r.type === 'mark') continue;
    if (r.type === 'frame') {
      if (r.requestId !== modelSocket) continue;
      if (r.opcode !== 1 && r.opcode !== 2) out.push(`unsupported opcode ${r.opcode} on the model socket at ${r.i}`);
      else if (r.opcode === 2) { const why = binaryProblem(r.payload); if (why) out.push(`${why} on the model socket at ${r.i}`); }
    } else if (r.type === 'socket') {
      out.push(MODEL_SOCKET_URL.test(r.url ?? '') ? `the model socket closed, failed or reconnected (new model socket at ${r.i})` : `a new socket opened during the run at ${r.i}`);
    } else if (r.type === 'closed' || r.type === 'frame_error') {
      out.push(r.requestId === modelSocket ? `the model socket closed, failed or reconnected (${r.type} at ${r.i})` : `socket ${r.requestId}: ${r.type} during the run at ${r.i}`);
    } else out.push(`unrecognized record type ${String(r.type)} at ${r.i}`);
  }
  return out;
}

// ---------------------------------------------------------------- the guard

const sameIdentity = (a: Identity, b: Identity) =>
  a?.projectId === b.projectId && a?.projectTag === b.projectTag && a?.workshopId === b.workshopId && a?.docId === b.docId && a?.modelSocket === b.modelSocket && a?.sessionId === b.sessionId;
const posInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdentityZ = z.object({ projectId: posInt, projectTag: z.string().min(1), workshopId: posInt, docId: posInt, modelSocket: z.string().min(1), sessionId: z.string().regex(/^[1-9]\d*$/) }).strict();

/** Problems unless the server lists exactly the bound session for the project. */
export function sessionProblems(res: unknown, sessionId: string): string[] {
  const s = isObj(res) ? res.sessions : undefined;
  if (!Array.isArray(s) || !s.every((x) => typeof x === 'string')) return ['the server session list is missing or malformed'];
  return s.length === 1 && s[0] === sessionId ? [] : [`server sessions ${JSON.stringify(s)} are not exactly the bound session ${sessionId}`];
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The report's view of a well-formed (snapshotProblems-checked) state, computed once when it is observed. */
const stateSummary = (s: StateSnap, at: { observedBefore?: WriteStep; observedAfter?: WriteStep; verified: boolean }): NonNullable<GuardReport['lastState']> =>
  ({ undo: undoOf(s).summary, objects: Object.keys(s.classes).length, ...at });

/** What the pre-send checks established: the checked state, where this step's traffic window starts, the request. */
type Pre = { before: StateSnap; pos: number; request: any };

export class LiveWriteGuard implements WriteTransport {
  readonly #schema: Schema; readonly #ports: GuardPorts; readonly #bound: Identity; readonly #plan: Plan;
  readonly #enabled: boolean; readonly #timeoutMs: number;
  #next = 0; #aborted?: string; #inFlight?: WriteStep; #known: Known = {}; #ctx: StateCtx = {};
  /** Page requests still awaiting their reply (async id → command), and our own wire async ids, for the whole run. */
  #pageIds = new Map<string, string>(); #ourIds = new Set<string>();
  /** Run-wide traffic cursor (a record index): every record before it has been through recordProblems and a classifier. */
  #cursor?: number;
  /** End of the last step window whose records were all classified, verified or not (finish() starts there). */
  #inspectedTo?: number;
  /** The after-state of the last verified step: the baseline the next step's state must still equal. */
  #verified?: { snap: StateSnap; step: WriteStep };
  #final?: FinalCheck;
  readonly #exclusivity = new Set<string>();
  /** The session check, recording where its answer came from. */
  async #sessionCheck(): Promise<string[]> {
    const res = await this.#ports.identity.sessions();
    this.#exclusivity.add(isObj(res) && res.source === 'attested' ? 'attested' : 'server');
    return sessionProblems(res, this.#bound.sessionId);
  }
  /**
   * The last well-formed state observed, summarised when it was taken (report() parses nothing). `verified` only when
   * it is the after-state of a step that passed every check.
   */
  #lastState?: NonNullable<GuardReport['lastState']>;
  readonly #steps: StepRecord[] = [];

  /** Throws RefusedWriteError on an invalid identity or plan; no port is touched here. */
  constructor(schema: Schema, ports: GuardPorts, bound: Identity, plan: Plan, opts: { enabled?: boolean; timeoutMs?: number } = {}) {
    const id = IdentityZ.safeParse(bound);
    if (!id.success) throw new RefusedWriteError(`bound identity: ${id.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    this.#schema = schema; this.#ports = ports; this.#bound = { ...id.data }; this.#plan = structuredClone(checkPlan(plan));
    this.#enabled = opts.enabled === true; // disabled unless explicitly enabled
    this.#timeoutMs = opts.timeoutMs ?? 10000;
  }

  /** Refuses without sending; anything but the disabled state also aborts the run for good. */
  #refuse(step: WriteStep, problems: string[], latch = true): StepTraffic {
    this.#steps.push({ step, sent: false, outcome: 'refused', problems });
    if (latch) this.#aborted ??= `${step} refused: ${problems[0]}`;
    return { notSent: true, ntfs: [], unexpected: problems };
  }

  /** Records a sent step whose outcome is not verified, latches the guard and tells the sequencer it is uncertain. */
  #unknown(rec: StepRecord, problems: string[], traffic?: StepTraffic, timedOut = false): StepTraffic {
    rec.outcome = 'unknown'; rec.problems.push(...problems);
    this.#aborted ??= `${rec.step} unknown: ${problems[0] ?? 'see report'}`;
    return { ...(traffic ?? { ntfs: [] }), unexpected: problems.length ? problems : ['verification failed'], uncertain: true, ...(timedOut ? { timedOut: true } : {}) };
  }

  /** The sequencer stopped (for its own reason or ours): refuse everything from now on. Touches no port. */
  abort(reason: string): void {
    this.#aborted ??= `stopped by the sequencer: ${reason}`;
  }

  async exchange(step: WriteStep, input: Uint8Array): Promise<StepTraffic> {
    if (!this.#enabled) return this.#refuse(step, ['live write guard is disabled'], false);
    let body: Uint8Array;
    try { body = Uint8Array.from(input); } // owned copy: the caller's buffer may change while this call is suspended
    catch (e) { return this.#refuse(step, [`request bytes are not a byte array: ${msg(e)}`]); }
    if (this.#aborted) return this.#refuse(step, [`run aborted earlier (${this.#aborted}); a new run needs a new guard`]);
    if (this.#final) return this.#refuse(step, ['the run was finished; a new run needs a new guard']);
    if (this.#inFlight) return this.#refuse(step, [`${this.#inFlight} is still in flight; exchanges must not overlap`]);
    if (WRITE_STEPS[this.#next] !== step) return this.#refuse(step, [`step ${step} out of order or already sent (next is ${WRITE_STEPS[this.#next] ?? 'none'})`]);
    // Claimed before the first await. Every refusal from here on latches the run, so the step is never sent twice.
    this.#next++; this.#inFlight = step;
    try { return await this.#run(step, body); } finally { this.#inFlight = undefined; }
  }

  async #run(step: WriteStep, body: Uint8Array): Promise<StepTraffic> {
    let pre: Pre | StepTraffic;
    try { pre = await this.#preSend(step, body); }
    catch (e) { return this.#refuse(step, [`pre-send check failed: ${msg(e)}`]); }
    if (!('before' in pre)) return pre; // refused
    // A concurrent call latched the run while this one was suspended.
    if (this.#aborted) return this.#refuse(step, [`run aborted while ${step} was being checked (${this.#aborted})`]);

    // ---- send boundary: from here the request may have reached Ivy; it is never re-sent. Whatever throws from here
    // on (a port, a parser, a bug) is an unknown outcome and latches the run.
    const rec: StepRecord = { step, sent: true, outcome: 'unknown', problems: [], undoBefore: undoOf(pre.before).summary };
    this.#steps.push(rec);
    try { return await this.#sendAndVerify(step, body, pre, rec); }
    catch (e) { rec.error ??= msg(e); return this.#unknown(rec, [`verification failed: ${msg(e)}`]); }
  }

  /** Every check before the send. Returns a refusal (latched) or what the send and verification need. */
  async #preSend(step: WriteStep, body: Uint8Array): Promise<Pre | StepTraffic> {
    const shape = checkWriteRequest(this.#schema, step, body);
    if (shape.problems.length) return this.#refuse(step, shape.problems);
    const values = checkPlanValues(step, shape.request, this.#plan, this.#bound, this.#known);
    if (values.length) return this.#refuse(step, values);

    const id = await this.#ports.identity.current();
    if (!sameIdentity(id, this.#bound)) return this.#refuse(step, [`identity changed: ${JSON.stringify(id)} is not the bound ${JSON.stringify(this.#bound)}`]);
    const inv = await this.#ports.identity.modelSockets();
    const socks = inv?.modelSockets;
    if (inv?.complete !== true || !Array.isArray(socks)) return this.#refuse(step, ['the model sockets could not be enumerated completely; exclusive use of the bound socket is not proven']);
    if (socks.length !== 1 || socks[0] !== this.#bound.modelSocket) return this.#refuse(step, [`model sockets ${JSON.stringify(socks)} are not exactly the bound ${this.#bound.modelSocket}`]);
    const sess = (await this.#sessionCheck());
    if (sess.length) return this.#refuse(step, sess);
    // Copied on intake: the port may reuse or mutate its object; every check and baseline uses this copy.
    const before = structuredClone(await this.#ports.state.snapshot());
    const bad = snapshotProblems(before);
    if (bad.length) return this.#refuse(step, bad.map((x) => `malformed state before ${step}: ${x}`));
    this.#lastState = stateSummary(before, { observedBefore: step, verified: false });
    if (this.#verified) {
      const drift = checkDrift(this.#verified.snap, before);
      if (drift.length) return this.#refuse(step, drift.map((x) => `state drift since ${this.#verified!.step}: ${x}`));
    }
    const u = undoOf(before).summary;
    if (u.canRedo !== 0) return this.#refuse(step, [`the document has ${u.canRedo} redo entr${u.canRedo === 1 ? 'y' : 'ies'}; a commit would discard them`]);
    const f = featureFacts(before, this.#plan.planeFeatureId);
    if (step === 'sketchCreate') {
      if (f.tip !== this.#plan.tipFeatureId) return this.#refuse(step, [`tip feature is ${f.tip}, the plan expects ${this.#plan.tipFeatureId}`]);
      if (f.planes.length !== 1) return this.#refuse(step, [`expected one origin plane with id ${this.#plan.planeFeatureId}, found ${f.planes.length}`]);
      this.#ctx.planeHandle = f.planes[0];
      this.#ctx.tipIsEmptyBody = isEmptyBodyTip(before, this.#plan.tipFeatureId);
    } else {
      const sk = f.byId('ivy::FeatSketch', this.#known.sketchFeatureId!);
      if (sk.length !== 1 || sk[0] !== this.#ctx.sketchHandle) return this.#refuse(step, [`sketch ${this.#known.sketchFeatureId} is not the one created (#${this.#ctx.sketchHandle})`]);
      if (f.tip !== this.#known.sketchFeatureId) return this.#refuse(step, [`tip feature is ${f.tip}, not the sketch ${this.#known.sketchFeatureId}`]);
    }
    // Traffic since the last inspection (the previous step's window) up to now. The first step starts the cursor:
    // earlier traffic is not this run's.
    let pos: number;
    if (this.#cursor === undefined) pos = this.#ports.traffic.position();
    else {
      const gap = this.#ports.traffic.since(this.#cursor);
      const frames = gap.filter((r) => r.type === 'frame' && r.requestId === this.#bound.modelSocket);
      const gp = [...recordProblems(gap, this.#cursor, this.#bound.modelSocket), ...classifyGapTraffic(decodeCapture(frames, this.#schema), this.#pageIds, this.#bound.docId, this.#ourIds)];
      if (gp.length) return this.#refuse(step, gp.map((x) => `traffic since ${this.#verified?.step}: ${x}`));
      pos = this.#cursor + gap.length;
    }
    if (!Number.isSafeInteger(pos) || pos < 0) return this.#refuse(step, [`traffic position ${pos} is not a record index`]);
    this.#cursor = pos;
    return { before, pos, request: shape.request };
  }

  async #sendAndVerify(step: WriteStep, body: Uint8Array, { before, pos, request }: Pre, rec: StepRecord): Promise<StepTraffic> {
    let res: SendResult;
    try { res = await this.#ports.sender.sendRaw(APP_MODEL_REQ, APP_MODEL_FIELD, body, this.#timeoutMs); }
    catch (e) { rec.error = msg(e); return this.#unknown(rec, [`send failed: ${rec.error}`]); }
    if (!isObj(res)) return this.#unknown(rec, [`the sender returned ${JSON.stringify(res)}, not a send result`]);
    rec.pageAsyncId = res.asyncId == null ? null : String(res.asyncId); // a plain value in the report, whatever the port gave

    let recs: CaptureRecord[];
    try {
      await this.#ports.settle();
      recs = this.#ports.traffic.since(pos);
      if (!Array.isArray(recs)) throw new Error('the traffic source returned no record list');
    } catch (e) { rec.error = msg(e); return this.#unknown(rec, [`post-send traffic check failed: ${rec.error}`]); }
    // A snapshot that throws or is malformed leaves the state unverified; it is never parsed or compared.
    let after: StateSnap | undefined, afterError: string | undefined;
    try {
      const s = structuredClone(await this.#ports.state.snapshot());
      const bad = snapshotProblems(s);
      if (bad.length) afterError = `malformed snapshot: ${bad.join('; ')}`;
      else { after = s; this.#lastState = stateSummary(after, { observedAfter: step, verified: false }); rec.undoAfter = undoOf(after).summary; rec.changes = diffObjects(before, after); }
    } catch (e) { afterError = msg(e); }
    if (afterError) rec.error = afterError;

    const problems = recordProblems(recs, pos, this.#bound.modelSocket);
    // Exclusivity again after the step: a session that joined while it ran makes its outcome unattributable.
    try { problems.push(...(await this.#sessionCheck()).map((x) => `after ${step}: ${x}`)); }
    catch (e) { problems.push(`after ${step}: the server session list is unavailable: ${msg(e)}`); }
    if (res.unknownOutcome) return this.#unknown(rec, ['no reply in time', ...problems, ...(afterError ? [`state not verified: ${afterError}`] : [])], undefined, true);
    if (!res.ok) problems.push(`page reported the request was not sent: ${res.error ?? 'unknown'}`);

    let traffic: StepTraffic = { ntfs: [], unexpected: [] }, wire: any;
    try {
      const frames = recs.filter((r) => r.type === 'frame' && r.requestId === this.#bound.modelSocket);
      const decoded = decodeCapture(frames, this.#schema);
      // Our request is found by its exact bytes and command, never by the page's (Number-rounded) async id; its
      // frame must carry exactly one header and that one body, so Ivy decodes exactly the checked request.
      const appReqs = decoded.filter((d: any) => d.kind === 'message' && d.dir === 'sent' && d.cmd === 'IVY_APP_MODEL_REQ') as any[];
      const mine = appReqs.flatMap((d) => {
        const f: any = d.frames.length === 1 ? frames.find((x) => x.i === d.frames[0]) : undefined;
        const fb = f ? frameRequestBodies(f.payload) : undefined;
        return fb?.bodies.some((b) => b.equals(Buffer.from(body))) ? [{ d, problem: fb.problem }] : [];
      });
      if (mine.length !== 1) problems.push(mine.length ? `${mine.length} copies of the request on the wire` : 'the request is not on the wire with the checked bytes');
      wire = mine.length === 1 ? mine[0].d : undefined;
      if (wire) {
        if (mine[0].problem) problems.push(mine[0].problem);
        rec.wireAsyncId = wire.asyncId;
        this.#ourIds.add(wire.asyncId);
        if (String(wire.pkg?.header?.projectId) !== String(this.#bound.projectId)) problems.push(`the wire request is for project ${wire.pkg?.header?.projectId}`);
        if (res.asyncId != null && Number(res.asyncId) !== Number(wire.asyncId)) problems.push(`page async id ${res.asyncId} does not match the wire's ${wire.asyncId}`);
      }
      traffic = classifyStepTraffic(decoded.filter((d) => !mine.some((m) => m.d === d)), wire?.asyncId ?? '\u0000', this.#pageIds, this.#bound.docId);
      problems.push(...traffic.unexpected);
      // Every record of this window has now been through recordProblems and the step classifier, whatever the step's
      // outcome: finish() starts after it instead of classifying the window a second time as between-steps traffic.
      this.#inspectedTo = pos + recs.length;
    } catch (e) { rec.error = msg(e); return this.#unknown(rec, [`post-send traffic check failed: ${rec.error}`, ...problems]); }

    problems.push(...replyProblems(step, traffic.reply, wire?.asyncId, this.#bound, this.#known));
    const errorCode = errorOf(traffic.reply);
    const newId = Number(traffic.reply?.appModelRsp?.modelPkgDecoded?.header?.featureId);
    const ids = {
      sketch: step === 'sketchCreate' ? newId : this.#known.sketchFeatureId, preview: step === 'extrudeCreate' ? newId : this.#known.previewFeatureId,
      created: newId, priorTip: this.#plan.tipFeatureId, priorTipIsEmptyBody: this.#ctx.tipIsEmptyBody === true,
    };
    if (traffic.reply) problems.push(...notificationProblems(step, traffic.ntfs, traffic.reply, this.#bound, ids, !!errorCode));

    // State is inspected after every reply, error replies included. Without it the outcome is unknown.
    if (!after) return this.#unknown(rec, [...(errorCode ? [`error result ${errorCode}`] : []), `state not verified: ${afterError}`, ...problems]);
    if (errorCode) {
      problems.push(...checkStateChange('noChange', before, after).map((x) => `after error: ${x}`));
      if (problems.length) return this.#unknown(rec, [`error result ${errorCode}`, ...problems], traffic);
      // Proven rejected: an error answer to exactly our request, and no visible or undo change.
      rec.outcome = 'failed'; rec.problems.push(`error result ${errorCode}`);
      this.#aborted ??= `${step} failed: error result ${errorCode}`;
      return traffic;
    }
    if (problems.length) return this.#unknown(rec, problems, traffic);
    // The created feature is the exact object the undo mark added, carrying the reply's id, and the new tip.
    if (step === 'sketchCreate' || step === 'extrudeCommit') {
      const b = bindCreated(step === 'sketchCreate' ? 'ivy::FeatSketch' : 'ivy::SolidExtrude', newId, before, after);
      problems.push(...b.problems.map((x) => `${step}: ${x}`));
      if (step === 'sketchCreate') this.#ctx.sketchHandle = b.handle;
    }
    this.#ctx.newFeatureId = step === 'sketchCreate' || step === 'extrudeCommit' ? newId : this.#known.sketchFeatureId;
    problems.push(...checkStateChange(step, before, after, this.#ctx));
    if (problems.length) return this.#unknown(rec, problems, traffic);
    if (step === 'sketchCreate') this.#known.sketchFeatureId = newId;
    if (step === 'extrudeCreate') this.#known.previewFeatureId = newId;

    if (step === 'extrudeCreate' || step === 'extrudeModify') {
      try { this.#known.previewFeature = previewFeature(mergedNtf(traffic.ntfs), this.#known.previewFeatureId!); }
      catch (e) { return this.#unknown(rec, [`preview notification: ${msg(e)}`], traffic); }
    }
    const depth = step === 'extrudeModify' ? checkReportedDepth(traffic.ntfs, this.#known.previewFeatureId!, this.#plan.depth, 'preview')
      : step === 'extrudeCommit' ? checkReportedDepth(traffic.ntfs, newId, this.#plan.depth, 'committed feature') : [];
    if (depth.length) return this.#unknown(rec, depth, traffic);
    if (step === 'extrudeModify') this.#known.modifyDepthItem = (request.modelPkg.featUpdateReq.updateItems as any[]).find((i) => Number(i.attrRole) === DEPTH_ROLE)?.parmObjects?.items?.[0];
    rec.outcome = 'verified';
    this.#verified = { snap: after, step };
    this.#lastState = { ...this.#lastState!, verified: true }; // the summary of this same `after`, taken above
    this.#cursor = pos + recs.length; // every record of this window is classified
    return traffic;
  }

  /**
   * Ends the run (no exchange is accepted afterwards): waits one settle, then classifies every record since the last
   * inspection exactly as between steps, checks the server sessions, and compares the state with the last verified
   * after-state. Any problem latches the guard. Runs once; later calls return the same result. Touches no port when
   * a step is still in flight.
   */
  async finish(): Promise<FinalCheck> {
    if (this.#final) return structuredClone(this.#final);
    if (this.#inFlight) return { verified: false, problems: [`${this.#inFlight} is still in flight`], records: 0 };
    const problems: string[] = [];
    let records = 0;
    const completed = !this.#aborted && WRITE_STEPS.every((s) => this.#steps.some((r) => r.step === s && r.outcome === 'verified'));
    this.#final = { verified: false, problems, records }; // claimed before the first await: no exchange from now on
    try {
      await this.#ports.settle();
      // From the end of the last window that was fully classified (verified or not), else the run cursor.
      const from = Math.max(this.#cursor ?? -1, this.#inspectedTo ?? -1);
      if (from < 0) problems.push('nothing was inspected: no step reached its traffic checks');
      else {
        const recs = this.#ports.traffic.since(from);
        if (!Array.isArray(recs)) throw new Error('the traffic source returned no record list');
        records = recs.length;
        const frames = recs.filter((r) => r.type === 'frame' && r.requestId === this.#bound.modelSocket);
        problems.push(...[...recordProblems(recs, from, this.#bound.modelSocket), ...classifyGapTraffic(decodeCapture(frames, this.#schema), this.#pageIds, this.#bound.docId, this.#ourIds)]
          .map((x) => `traffic after the last step: ${x}`));
      }
      problems.push(...(await this.#sessionCheck()).map((x) => `at the end: ${x}`));
      const now = structuredClone(await this.#ports.state.snapshot());
      const bad = snapshotProblems(now);
      if (bad.length) problems.push(...bad.map((x) => `malformed final state: ${x}`));
      else {
        this.#lastState = stateSummary(now, { verified: false });
        if (this.#verified) problems.push(...checkDrift(this.#verified.snap, now).map((x) => `state changed after ${this.#verified!.step}: ${x}`));
      }
    } catch (e) { problems.push(`final check failed: ${msg(e)}`); }
    this.#final = { verified: completed && problems.length === 0, problems, records };
    if (problems.length) this.#aborted ??= `final check: ${problems[0]}`;
    return structuredClone(this.#final);
  }

  report(): GuardReport {
    const sent = this.#steps.filter((s) => s.sent);
    return {
      completed: sent.filter((s) => s.outcome === 'verified').map((s) => s.step),
      steps: structuredClone(this.#steps), // plain data only (strings, numbers, the summaries and diffs built here)
      aborted: this.#aborted,
      lastState: structuredClone(this.#lastState),
      final: structuredClone(this.#final),
      exclusivity: [...this.#exclusivity],
      // A stopped run that sent anything may have left residue the inspector cannot show (an open preview, a mark).
      possibleHiddenResidue: sent.some((s) => s.outcome !== 'verified') || (this.#aborted !== undefined && sent.length > 0),
    };
  }
}
