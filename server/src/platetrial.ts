// The first controlled plate (100 × 60 mm sketch, 8 mm extrusion) as checkable logic: preconditions and a plan derived
// from the live document's own ids, the run with evidence preserved at every stage, and postconditions. Nothing here
// sends: runPlateTrial needs GuardPorts with a sender, and no sender exists in ai-cad (scripts/plate-trial.ts stops
// after the preflight). There is no undo, delete or cleanup anywhere: a failure stops and keeps the evidence.
import { LiveWriteGuard, snapshotProblems, tipOf, type FinalCheck, type GuardPorts, type GuardReport, type Identity, type Plan } from './livewriteguard';
import type { StateSnap } from './replaycheck';
import { checkPlan, rectLines, WRITE_STEPS } from './writeport';
import { runPlateSequence, type PlateInput, type SeqOutcome } from './writeseq';
import type { Schema } from './wsframes';

/**
 * `existingSketches`: names of sketches the document may already hold, each once and EMPTY (the document has no length
 * dimension at all), e.g. the Sketch1 left by plate-trial-write1. Anything else already in the document is refused.
 */
export type PlateSpec = { width: number; height: number; depth: number; x0: number; y0: number; sketchName: string; extrudeName: string; existingSketches?: string[] };
/** Centred on the origin (no vertex on an axis), names of a part with no sketch or extrude yet. */
export const FIRST_PLATE: PlateSpec = { width: 100, height: 60, depth: 8, x0: -50, y0: -30, sketchName: 'Sketch1', extrudeName: 'Extrude1' };

const named = (s: StateSnap, cls: string) => Object.keys(s.classes).filter((h) => s.classes[h] === cls)
  .map((h) => { const a = JSON.parse(s.objects[h] ?? '{}').attr_first_ ?? {}; return { handle: h, id: Number(a._id), name: String(a._name ?? '') }; });

/**
 * Every content-bearing list of ivysketch.SketchFeatureData (ivysketch.proto): a sketch is empty only when all are
 * empty. sketch_vertices is not content: the empty Sketch1 of write1 (notification 99) carries vertices.
 */
export const SKETCH_CONTENT_FIELDS = ['geoms', 'constraints', 'externalGeoms', 'dimensionData', 'patterns', 'sketchOffsets', 'geomFeatureData', 'blocks'] as const;
/** Per sketch feature id: its content counts in the latest data notification that carried it, or why it cannot count. */
export type SketchContents = Map<number, { counts: Record<string, number>; at: number; problem?: string }>;
// Model traffic that cannot change the document; anything else after the evidence makes it stale.
const READ_ONLY = new Set(['IVY_QUERY_REQ', 'IVY_QUERY_RSP', 'IVY_GET_TESSELLATION_REQ', 'IVY_GET_TESSELLATION_RSP']);
const isPing = (t: unknown) => { try { return JSON.parse(String(t))?.command === 'ping'; } catch { return false; } };
/** Decoded read-only queries, well-formed tessellation data and the page's ping; everything else may change the document. */
const harmless = (d: any) => (d?.kind === 'message' ? d.status === 'decoded' && READ_ONLY.has(d.cmd) : d?.kind === 'mesh' ? d.ok === true : d?.kind === 'text' && isPing(d.text));

/**
 * Sketch contents of document `docId`, from the decoded model messages (decodeCapture) of THIS session's bound model
 * socket: received, fully decoded IVY_APP_MODEL_NTF data notifications whose model description names `docId`. Each
 * sketch counts its content lists; all are proto3 `repeated` fields and the decoder omits empty ones (protobufjs
 * toObject, defaults: false), so a missing field is empty, while a present non-array is malformed (refused). The latest
 * notification per sketch is the evidence, and it is stale (refused) when any later message on the socket is not
 * read-only traffic or could not be decoded: the sketch could have changed since.
 */
export function sketchContentsFrom(decoded: any[], docId: number): SketchContents {
  const out: SketchContents = new Map();
  for (const d of decoded) {
    if (d?.kind !== 'message' || d.dir !== 'received' || d.cmd !== 'IVY_APP_MODEL_NTF' || d.status !== 'decoded') continue;
    for (const m of d.pkg?.appModelNtf?.modelDescs ?? []) {
      if (Number(m?.docId) !== docId) continue;
      for (const f of m.modelPkgDecoded?.dataNtf?.features ?? []) {
        if (f?.feature !== 'sketchFeature' || !f.sketchFeature || !Number.isSafeInteger(Number(f.featureId))) continue;
        const counts: Record<string, number> = {}, bad: string[] = [];
        for (const k of SKETCH_CONTENT_FIELDS) {
          const v = f.sketchFeature[k];
          if (v === undefined) counts[k] = 0; else if (Array.isArray(v)) counts[k] = v.length; else bad.push(k);
        }
        out.set(Number(f.featureId), { counts, at: d.frames?.[0], ...(bad.length ? { problem: `malformed ${bad.join(', ')} in the data notification at ${d.frames?.[0]}` } : {}) });
      }
    }
  }
  for (const [id, c] of out) {
    if (c.problem) continue;
    const later = decoded.find((d) => d?.frames?.[0] > c.at && !harmless(d));
    if (later) out.set(id, { ...c, problem: `stale: ${later.kind === 'message' ? later.cmd ?? 'an undecodable message' : later.kind} at ${later.frames?.[0]} came after the data notification at ${c.at}` });
  }
  return out;
}

/**
 * Preconditions on the document-rooted state (`doc`) and the full project graph's classes, and the plan built from
 * the ids found there. Refuses unless: the snapshot is well-formed, the project has exactly one document, no redo,
 * a readable tip, exactly one origin plane named "XY Plane", no sketch or extrude yet (except named existing sketches
 * proved empty), and the names are unused.
 */
export function preparePlate(doc: StateSnap, projectClasses: Record<string, string>, spec: PlateSpec = FIRST_PLATE, evidence: { sketchContents?: SketchContents } = {}): { plan?: Plan; problems: string[] } {
  const problems = snapshotProblems(doc);
  if (problems.length) return { problems: problems.map((x) => `document state: ${x}`) };
  const docs = Object.values(projectClasses).filter((c) => c === 'ivy::PartReference').length;
  if (docs !== 1) problems.push(`the project has ${docs} documents, the first trial needs exactly one`);
  const undo = JSON.parse(doc.undo);
  if (undo.can_redo_step !== 0) problems.push(`the project has ${undo.can_redo_step} redo entries`);
  const tip = tipOf(doc);
  if (!tip) problems.push('the feature tip is unreadable');
  const xy = named(doc, 'ivy::FeatOriginPlane').filter((p) => p.name === 'XY Plane');
  if (xy.length !== 1 || !Number.isSafeInteger(xy[0].id)) problems.push(`expected one origin plane named "XY Plane", found ${xy.length}`);
  const allowed = spec.existingSketches ?? [];
  const sketches = named(doc, 'ivy::FeatSketch');
  const unexpected = sketches.filter((s) => !allowed.includes(s.name));
  if (unexpected.length) problems.push(`the document already has ${unexpected.length} ivy::FeatSketch`);
  for (const n of allowed) if (sketches.filter((s) => s.name === n).length > 1) problems.push(`the existing sketch ${n} is there more than once`);
  // Emptiness needs positive evidence. The inspector shows a sketch's geometry and constraints only as opaque runtime
  // state, so the one accepted source is a data notification recorded in this session naming the sketch with no
  // geometry and no constraint (sketchContentsFrom). Length dimensions only add a reason to refuse; their absence proves
  // nothing (plate-trial-write2's Sketch2 had 4 lines and 8 constraints and no dimension).
  for (const s of sketches.filter((x) => allowed.includes(x.name))) {
    const c = evidence.sketchContents?.get(s.id);
    const full = c && Object.entries(c.counts).filter(([, n]) => n > 0);
    if (!c) problems.push(`the existing sketch ${s.name} (feature ${s.id}) cannot be shown to be empty: the inspector reports sketch geometry only as opaque runtime state, and no document data for it was recorded in this session`);
    else if (c.problem) problems.push(`the existing sketch ${s.name} (feature ${s.id}) cannot be shown to be empty: ${c.problem}`);
    else if (full!.length) problems.push(`the existing sketch ${s.name} (feature ${s.id}) is not empty: ${full!.map(([k, n]) => `${n} ${k}`).join(', ')} (data notification at ${c.at})`);
    else if (SKETCH_CONTENT_FIELDS.some((k) => c.counts[k] !== 0)) problems.push(`the existing sketch ${s.name} (feature ${s.id}) cannot be shown to be empty: incomplete evidence`);
  }
  const dims = named(doc, 'ivy::SketchLengthDimension').length;
  if (sketches.length && dims) problems.push(`the document has ${dims} sketch length dimensions, so an existing sketch is not empty`);
  const extrudes = named(doc, 'ivy::SolidExtrude').length;
  if (extrudes) problems.push(`the document already has ${extrudes} ivy::SolidExtrude`);
  const taken = Object.keys(doc.objects).map((h) => String(JSON.parse(doc.objects[h]).attr_first_?._name ?? ''));
  for (const n of [spec.sketchName, spec.extrudeName]) if (taken.includes(n)) problems.push(`the name ${n} is already used`);
  if (problems.length) return { problems };
  try {
    const plan = checkPlan({
      tipFeatureId: tip!.id, planeFeatureId: xy[0].id, sketchName: spec.sketchName, extrudeName: spec.extrudeName,
      lines: rectLines(spec.x0, spec.y0, spec.width, spec.height), width: spec.width, height: spec.height, depth: spec.depth,
    }) as Plan;
    return { plan, problems: [] };
  } catch (e) { return { problems: [`plan: ${(e as Error).message}`] }; }
}

/**
 * The sides of a rectangular face from its measured perimeter and area (the measurement's values, taken as SI and
 * returned in mm: the unit is inferred, not sent). The sides are the roots of t² − (P/2)·t + A = 0; undefined when
 * no real rectangle fits.
 */
export function faceSides(perimeterM: number, areaM2: number): [number, number] | undefined {
  const s = (perimeterM * 1000) / 2, a = areaM2 * 1e6, d = s * s - 4 * a;
  if (!(perimeterM > 0 && areaM2 > 0) || d < -1e-6) return undefined;
  const r = Math.sqrt(Math.max(0, d));
  return [(s + r) / 2, (s - r) / 2];
}

export type MeasuredFace = { perimeter: number; area: number };
export type Postconditions = { verdict: 'verified' | 'failed' | 'incomplete'; problems: string[]; notChecked: string[]; facts: Record<string, unknown> };

/**
 * After a run: the guard verified all nine steps and its final check; the document holds exactly the planned sketch
 * (two length dimensions) and extrude, and the extrude is the tip. Values the inspector does not show come from
 * optional read-only evidence: `params` (the approved parameter query) for the two dimensions, and `faces` (approved
 * face measurements) for the thickness. Without them the verdict is at best "incomplete", never "verified".
 */
export function platePostconditions(x: { report: GuardReport; after: StateSnap; plan: Plan; params?: Array<{ fullName: string; value: string; type: string }>; faces?: MeasuredFace[]; existingSketches?: string[] }): Postconditions {
  const problems: string[] = [], notChecked: string[] = [], facts: Record<string, unknown> = {};
  const { report, after, plan } = x;
  if (JSON.stringify(report.completed) !== JSON.stringify(WRITE_STEPS)) problems.push(`verified steps ${JSON.stringify(report.completed)}, not all nine`);
  if (report.aborted) problems.push(`the guard stopped: ${report.aborted}`);
  if (!report.final) problems.push('the final check did not run');
  else if (!report.final.verified) problems.push(`the final check failed: ${report.final.problems.join('; ') || 'run not completed'}`);
  const bad = snapshotProblems(after);
  if (bad.length) return { verdict: 'failed', problems: [...problems, ...bad.map((b) => `final state: ${b}`)], notChecked, facts };
  const sketches = named(after, 'ivy::FeatSketch'), extrudes = named(after, 'ivy::SolidExtrude');
  facts.sketches = sketches; facts.extrudes = extrudes; facts.tip = tipOf(after);
  // Exactly the planned sketch, plus exactly the pre-existing (empty) ones the preflight allowed, nothing else.
  const wantSketches = [plan.sketchName, ...(x.existingSketches ?? [])].sort();
  if (JSON.stringify(sketches.map((s) => s.name).sort()) !== JSON.stringify(wantSketches)) problems.push(`expected sketches ${JSON.stringify(wantSketches)}, found ${JSON.stringify(sketches.map((s) => s.name))}`);
  if (extrudes.length !== 1 || extrudes[0].name !== plan.extrudeName) problems.push(`expected one extrude ${plan.extrudeName}, found ${JSON.stringify(extrudes.map((s) => s.name))}`);
  const dims = named(after, 'ivy::SketchLengthDimension').length;
  if (dims !== 2) problems.push(`expected two sketch length dimensions, found ${dims}`);
  if (extrudes.length === 1 && (tipOf(after)?.id !== extrudes[0].id || tipOf(after)?.handle !== extrudes[0].handle)) problems.push(`the tip is not the new extrude ${extrudes[0].id}`);
  if (!x.params) notChecked.push('dimension values (needs the read-only parameter query)');
  else {
    const lens = x.params.filter((p) => p.type === 'tLength' && p.fullName.startsWith(`\\Part Body\\${plan.sketchName}\\`) && /SketchLengthDimension/.test(p.fullName)).map((p) => Number(p.value)).sort((a, b) => a - b);
    facts.dimensionValues = lens;
    const want = [plan.width, plan.height].sort((a, b) => a - b);
    if (lens.length !== 2 || lens.some((v, i) => Math.abs(v - want[i]) > 1e-6)) problems.push(`sketch dimensions ${JSON.stringify(lens)}, planned ${JSON.stringify(want)}`);
  }
  // Geometry needs measured faces (fail closed without them): one face exactly width × height (the top or bottom) and
  // one side face width-or-height × depth, each within ±0.01 mm. The depth parameter alone is not taken as proof.
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  const [big, small] = [Math.max(plan.width, plan.height), Math.min(plan.width, plan.height)];
  if (!x.faces?.length) problems.push(`no face was measured: neither the ${plan.width} × ${plan.height} mm face nor the ${plan.depth} mm thickness is established`);
  else {
    const sides = x.faces.map((f) => faceSides(f.perimeter, f.area));
    facts.faceSides = sides;
    if (!sides.some((s) => s && near(s[0], big) && near(s[1], small))) problems.push(`no measured face is ${plan.width} × ${plan.height} mm: ${JSON.stringify(sides)}`);
    if (!sides.some((s) => s && near(s[1], plan.depth) && (near(s[0], plan.width) || near(s[0], plan.height)))) problems.push(`no measured face is ${plan.width} or ${plan.height} by ${plan.depth} mm: ${JSON.stringify(sides)}`);
  }
  // Always unmeasured: no approved read operation shows where the solid lies (only the requests' centred lines are
  // checked, by the guard). So a run can be at best "incomplete", never "verified".
  notChecked.push('position (centring): not measurable with the approved read operations; only the requested centred lines were checked');
  return { verdict: problems.length ? 'failed' : notChecked.length ? 'incomplete' : 'verified', problems, notChecked, facts };
}

/**
 * Runs the nine steps through an ENABLED guard over the given ports (which must include a sender), then the guard's
 * final check and a final snapshot. `save` is called after every stage, so evidence survives any failure or
 * exception; nothing is retried, undone or deleted. Not called by any script: there is no sender.
 */
export type TrialEvidence = { params?: Array<{ fullName: string; value: string; type: string }>; faces?: MeasuredFace[] };
export async function runPlateTrial(d: {
  schema: Schema; ports: GuardPorts; bound: Identity; plan: Plan; save: (name: string, data: unknown) => void;
  /** Read-only evidence for the postconditions (parameter query, face measurements); called only after a verified run. */
  readEvidence?: (created: SeqOutcome['created']) => Promise<TrialEvidence>;
  /** The pre-existing empty sketches the preflight allowed (PlateSpec.existingSketches). */
  existingSketches?: string[];
}) {
  const guard = new LiveWriteGuard(d.schema, d.ports, d.bound, d.plan, { enabled: true });
  const input: PlateInput = { workshopId: d.bound.workshopId, docId: d.bound.docId, ...d.plan };
  let outcome: SeqOutcome | undefined, final: FinalCheck | undefined, after: StateSnap | undefined, error: string | undefined, evidence: TrialEvidence = {};
  try {
    outcome = await runPlateSequence(d.schema, { exchange: (s, b) => guard.exchange(s, b), abort: (why) => guard.abort(why) }, input);
    d.save('outcome', outcome);
    final = await guard.finish();
    d.save('final', final);
    after = structuredClone(await d.ports.state.snapshot());
    d.save('state-after', after);
    if (d.readEvidence && outcome.status === 'completed' && final.verified) { evidence = await d.readEvidence(outcome.created); d.save('evidence', evidence); }
  } catch (e) { error = (e as Error)?.message ?? String(e); d.save('error', error); }
  const report = guard.report();
  d.save('report', report);
  const post = after ? platePostconditions({ report, after, plan: d.plan, ...evidence, existingSketches: d.existingSketches }) : undefined;
  if (post) d.save('postconditions', post);
  return { outcome, final, report, post, error, evidence };
}


/**
 * Whether the trial script may arm its sender: only with the --write flag, a preflight in which every check passed, a
 * non-empty attestation of exclusivity (no server session list exists), and the user typing exactly "write" after
 * seeing the plan. Returns the reasons it may not; empty means it may.
 */
export function writeGate(g: { flag: boolean; preflightPassed: boolean; attestation?: string; typed?: string }): string[] {
  const no: string[] = [];
  if (!g.flag) no.push('sending is disabled: run with --write to ask for it');
  if (!g.preflightPassed) no.push('the preflight did not pass');
  if (!g.attestation?.trim()) no.push('no exclusivity attestation (--attest "<statement>")');
  if (g.typed !== 'write') no.push('the user did not type "write"');
  return no;
}
