// Definition-level checks of the plate: what Ivy's own recorded data notification says the model IS, kept apart from
// anything measured. "definition_centered" judges the sketch (its four lines, its support plane, its placement
// transform); "extrusion_definition" judges the extrude's recorded options. Neither measures the resulting solid:
// `solid_position_measured` is always false here, and the extrusion's +Z sense is inferred from the options, never
// shown. See docs/write-path.md §9 (evidence: runs/plate-trial-write3, notification 96).
import type { Plan } from './livewriteguard';

export type Verdict3 = 'pass' | 'fail' | 'unknown';
export type DefinitionCheck = {
  definition_centered: Verdict3;
  extrusion_definition: Verdict3;
  extrusion_direction: string;
  solid_position_measured: false;
  problems: string[];
  facts: Record<string, unknown>;
};

/**
 * SolidExtrude attribute roles (Ivy zplugin/part/model/inc/ivypartmodelrole.h, SolidExtrudeAttri, numbered from
 * 31001 in declaration order; kSolidExtrudeDepth = 31004 matches the depth item of every captured request).
 */
export const EXTRUDE_ROLE = {
  extrudeType: 31001, depth: 31004, useDirection: 31005, offsetFromStart: 31008, offsetFromStartDistance: 31010,
  symmetry: 31011, direction2: 31012, reverse: 31015, offsetReverse: 31016, draft: 31017, draft2: 31020,
} as const;
/** ExtrudeType::kExtrudeTypeBlind (zplugin/part/model/inc/ivysolidExtrude.h). */
export const EXTRUDE_TYPE_BLIND = 0;
/** Options that must be off for a plain blind extrude from the sketch plane. */
const MUST_BE_OFF = ['useDirection', 'offsetFromStart', 'symmetry', 'direction2', 'reverse', 'offsetReverse', 'draft', 'draft2'] as const;
const DIRECTION = 'inferred: along the support plane normal (+Z for the XY plane), from reverse/symmetric/second-direction off — not measured';

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** A proto3 double that the decoder omits when 0 (defaults: false): missing → 0, present non-number → malformed. */
const coord = (o: any, k: 'x' | 'y' | 'z'): number | undefined => (o?.[k] === undefined ? 0 : isNum(o[k]) ? o[k] : undefined);

/** The latest received, decoded data notification for `docId` that carries feature `id` (and that feature). */
function latestFeature(decoded: any[], docId: number, id: number): { feature: any; at: number } | undefined {
  let found: { feature: any; at: number } | undefined;
  for (const d of decoded) {
    if (d?.kind !== 'message' || d.dir !== 'received' || d.cmd !== 'IVY_APP_MODEL_NTF' || d.status !== 'decoded') continue;
    for (const m of d.pkg?.appModelNtf?.modelDescs ?? []) {
      if (Number(m?.docId) !== docId) continue;
      for (const f of m.modelPkgDecoded?.dataNtf?.features ?? []) if (Number(f?.featureId) === id) found = { feature: f, at: d.frames?.[0] };
    }
  }
  return found;
}

function checkSketch(decoded: any[], docId: number, sketchId: number, plan: Plan, facts: Record<string, unknown>): { v: Verdict3; problems: string[] } {
  const hit = latestFeature(decoded, docId, sketchId);
  const sk = hit?.feature?.sketchFeature;
  if (!sk) return { v: 'unknown', problems: [`no recorded data notification for sketch ${sketchId} of document ${docId}`] };
  facts.sketchNotification = hit!.at;
  const p: string[] = [];
  // Support plane and placement transform.
  const sup = sk.support;
  if (!sup?.supportTransform) return { v: 'unknown', problems: ['the sketch notification carries no support transform'] };
  if (Number(sup.supportBrep?.featureId) !== plan.planeFeatureId) p.push(`the sketch is on feature ${sup.supportBrep?.featureId}, not the planned plane ${plan.planeFeatureId}`);
  const t = sup.supportTransform;
  const basis = t.basis, origin = t.origin ?? {};
  if (!Array.isArray(basis) || basis.length !== 3) return { v: 'fail', problems: [...p, 'the support transform basis is not three vectors'] };
  const vec = (o: any) => [coord(o, 'x'), coord(o, 'y'), coord(o, 'z')];
  const rows = basis.map(vec), org = vec(origin);
  if ([...rows.flat(), ...org].some((x) => x === undefined)) return { v: 'fail', problems: [...p, 'the support transform holds a non-numeric component'] };
  const ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  facts.supportTransform = { basis: rows, origin: org };
  if (rows.some((r, i) => r.some((x, j) => x !== ident[i][j]))) p.push(`the sketch placement basis is ${JSON.stringify(rows)}, not identity`);
  if (org.some((x) => x !== 0)) p.push(`the sketch placement origin is ${JSON.stringify(org)}, not (0, 0, 0)`);
  // The four lines: an axis-aligned rectangle whose bounds are centred on the sketch origin with the planned size.
  const geoms = sk.geoms;
  if (!Array.isArray(geoms)) return { v: 'unknown', problems: [...p, 'the sketch notification carries no geometry'] };
  if (geoms.length !== 4 || !geoms.every((g: any) => g?.line?.start && g?.line?.end)) return { v: 'fail', problems: [...p, `the sketch holds ${geoms.length} geometries, not four lines`] };
  const raw = geoms.flatMap((g: any) => [g.line.start, g.line.end]).map((q: any) => [coord(q, 'x'), coord(q, 'y')]);
  if (raw.flat().some((x: number | undefined) => x === undefined)) return { v: 'fail', problems: [...p, 'a line end holds a non-numeric coordinate'] };
  const pts = raw as number[][];
  const xs = pts.map((q: number[]) => q[0]), ys = pts.map((q: number[]) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  facts.bounds = { x: [x0, x1], y: [y0, y1] };
  const tol = 1e-9 * Math.max(1, plan.width, plan.height);
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  if (!pts.every(([x, y]: number[]) => (near(x, x0) || near(x, x1)) && (near(y, y0) || near(y, y1)))) p.push('a line end is not a corner of the bounding rectangle');
  if (!geoms.every((g: any) => near(coord(g.line.start, 'x')!, coord(g.line.end, 'x')!) || near(coord(g.line.start, 'y')!, coord(g.line.end, 'y')!))) p.push('a line is not axis-aligned');
  if (!near(x1 - x0, plan.width) || !near(y1 - y0, plan.height)) p.push(`the rectangle is ${x1 - x0} × ${y1 - y0}, not ${plan.width} × ${plan.height}`);
  if (!near(x0 + x1, 0) || !near(y0 + y1, 0)) p.push(`the rectangle spans x ${x0}..${x1}, y ${y0}..${y1}: not centred on the sketch origin`);
  return { v: p.length ? 'fail' : 'pass', problems: p };
}

function checkExtrude(decoded: any[], docId: number, extrudeId: number, plan: Plan, facts: Record<string, unknown>): { v: Verdict3; problems: string[] } {
  const hit = latestFeature(decoded, docId, extrudeId);
  const feat = hit?.feature?.featUpdateFeature?.feat;
  if (!feat) return { v: 'unknown', problems: [`no recorded data notification for extrude ${extrudeId} of document ${docId}`] };
  facts.extrudeNotification = hit!.at;
  if (feat.type !== 'SolidExtrude') return { v: 'fail', problems: [`feature ${extrudeId} is ${feat.type}, not SolidExtrude`] };
  const attrs: any[] = Array.isArray(feat.attributes) ? feat.attributes : [];
  const role = (r: number) => attrs.filter((a) => Number(a?.role) === r);
  const p: string[] = [], missing: string[] = [];
  const one = (r: number) => { const a = role(r); return a.length === 1 ? a[0] : undefined; };
  const type = one(EXTRUDE_ROLE.extrudeType);
  if (!type || !Array.isArray(type.enum)) missing.push('extrude type');
  else if (type.enum.length !== 1 || Number(type.enum[0]) !== EXTRUDE_TYPE_BLIND) p.push(`the extrude type is ${JSON.stringify(type.enum)}, not blind (${EXTRUDE_TYPE_BLIND})`);
  const depth = one(EXTRUDE_ROLE.depth);
  if (!depth || !Array.isArray(depth.parm)) missing.push('depth');
  else if (depth.parm.length !== 1 || depth.parm[0].type !== 'tLength' || Number(depth.parm[0].value) !== plan.depth) p.push(`the depth is ${JSON.stringify(depth.parm.map((x: any) => x.value))}, not ${plan.depth}`);
  const flags: Record<string, unknown> = {};
  for (const k of MUST_BE_OFF) {
    const a = one(EXTRUDE_ROLE[k]);
    if (!a || !Array.isArray(a.check)) { missing.push(k); continue; }
    flags[k] = a.check;
    if (a.check.length !== 1 || a.check[0] !== false) p.push(`the extrude option ${k} (role ${EXTRUDE_ROLE[k]}) is ${JSON.stringify(a.check)}, not off`);
  }
  facts.extrudeOptions = flags;
  if (p.length) return { v: 'fail', problems: [...p, ...missing.map((m) => `the extrude option ${m} is missing`)] };
  if (missing.length) return { v: 'unknown', problems: missing.map((m) => `the extrude option ${m} is missing`) };
  return { v: 'pass', problems: [] };
}

/**
 * Both definition checks from decoded model messages of the run (decodeCapture over the bound model socket), for the
 * bound document and the created sketch and extrude ids. Nothing here is a measurement of the solid.
 */
export function checkPlateDefinition(decoded: any[], o: { docId: number; sketchId: number; extrudeId: number; plan: Plan }): DefinitionCheck {
  const facts: Record<string, unknown> = {};
  const s = checkSketch(decoded, o.docId, o.sketchId, o.plan, facts);
  const e = checkExtrude(decoded, o.docId, o.extrudeId, o.plan, facts);
  return {
    definition_centered: s.v, extrusion_definition: e.v, extrusion_direction: DIRECTION, solid_position_measured: false,
    problems: [...s.problems.map((x) => `sketch definition: ${x}`), ...e.problems.map((x) => `extrusion definition: ${x}`)], facts,
  };
}
