// Feature plan: the engineering agent's output and the construction engine's input.
// Toolbox-compatible operations (sketch/extrude/revolve) mirror the backend asset reader
// (ivyproject zplugin/toolbox/workbench/toolbox_library.cpp ReadAsset) and its expression
// evaluator (toolbox_expression.cpp). Generic features (fillet, hole, …) are rejected as
// unsupported until their protocol path is verified (docs/protocol-spike.md §2, §6).
import { z } from 'zod';

export const PLANES = ['XY', 'YZ', 'ZX'] as const;
export const AXES = ['X', 'Y', 'Z'] as const;
/** Known CAD operations whose generic-feature request path is not verified yet. */
export const UNVERIFIED_OPERATIONS = ['fillet', 'chamfer', 'hole', 'pattern', 'mirror', 'shell', 'draft', 'sweep', 'loft'];

const SHAPES = ['circle', 'polygon', 'rectangle', 'polyline'];
const END_TYPES = ['blind', 'throughAll'];
const Value = z.union([z.number(), z.string().min(1)]); // literal or expression over parameters/derived
const Profile = z.discriminatedUnion('shape', [
  z.strictObject({ shape: z.literal('circle'), cx: Value.optional(), cy: Value.optional(), d: Value.optional(), r: Value.optional() }),
  z.strictObject({ shape: z.literal('polygon'), sides: z.number().int(), size: Value, fit: z.enum(['acrossFlats', 'acrossCorners']).optional(),
    cx: Value.optional(), cy: Value.optional(), rotation: Value.optional() }),
  z.strictObject({ shape: z.literal('rectangle'), width: Value, height: Value, cx: Value.optional(), cy: Value.optional(), rotation: Value.optional() }),
  z.strictObject({ shape: z.literal('polyline'), points: z.array(z.tuple([Value, Value])), cx: Value.optional(), cy: Value.optional(), rotation: Value.optional() }),
]);
const Op = z.enum(['add', 'cut']);
const Feature = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sketch'), id: z.string().min(1), plane: z.enum(PLANES).default('XY'), profile: z.array(Profile).min(1) }),
  z.strictObject({ type: z.literal('extrude'), id: z.string().min(1), profile: z.string().min(1), depth: Value,
    endType: z.enum(['blind', 'throughAll']).default('blind'), operation: Op.default('add'),
    reversed: z.boolean().optional(), symmetric: z.boolean().optional(), solid: z.string().optional() }),
  z.strictObject({ type: z.literal('revolve'), id: z.string().min(1), profile: z.string().min(1), axis: z.enum(AXES).default('Z'),
    operation: Op.default('add'), solid: z.string().optional() }),
]);
const Name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const FeaturePlanZ = z.object({
  part: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().optional(),
  units: z.literal('mm'),
  /** Always concept geometry: CAD generation alone does not validate a component (spec §7). */
  maturity: z.literal('concept').default('concept'),
  parameters: z.record(Name, z.number()),
  derived: z.record(Name, z.string().min(1)).default({}),
  assumptions: z.array(z.string()).default([]),
  features: z.array(z.object({ type: z.string() }).passthrough()).min(1),
});
export type FeaturePlan = Omit<z.infer<typeof FeaturePlanZ>, 'features'> & { features: z.infer<typeof Feature>[] };
export type FeaturePlanResult =
  | { ok: true; plan: FeaturePlan; dims: Record<string, number> }
  | { ok: false; errors: string[]; unsupported: boolean };

// ---------------------------------------------------------------- expressions (mirror of toolbox_expression.cpp)
const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sqrt: Math.sqrt,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: (v) => Math.sign(v) * Math.round(Math.abs(v)), // std::round: half away from zero
  deg: (v) => (v * 180) / Math.PI, rad: (v) => (v * Math.PI) / 180,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluates `expr` over `dims`. Precedence as the backend: unary (tightest, right) > ^ (right) > * / > + -. */
export function evaluate(expr: string, dims: Record<string, number>): number {
  // only ' ' and '\t' are whitespace in the backend tokenizer; any other character is an error
  const tokens = (expr.match(/\d*\.?\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/^(),]|[^]/g) ?? []).filter((t) => t !== ' ' && t !== '\t');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fail = (msg: string): never => { throw new Error(`${msg} in "${expr}"`); };
  const bad = tokens.find((t) => !/^(\d*\.?\d|[A-Za-z_]|[-+*/^(),]$)/.test(t));
  if (bad !== undefined) fail(`unexpected character '${bad}'`);
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + product() : v - product();
    return v;
  };
  const product = (): number => {
    let v = power();
    while (peek() === '*' || peek() === '/') v = next() === '*' ? v * power() : v / power();
    return v;
  };
  const power = (): number => {
    const base = unary();
    return peek() === '^' ? (next(), base ** power()) : base;
  };
  const unary = (): number => (peek() === '-' ? (next(), -unary()) : peek() === '+' ? (next(), unary()) : primary());
  const primary = (): number => {
    const t = next();
    if (t === undefined) return fail('unexpected end');
    if (t === '(') { const v = sum(); if (next() !== ')') fail('missing )'); return v; }
    if (/^\d*\.?\d/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        const fn = (Object.hasOwn(FUNCS, t) ? FUNCS[t] : undefined) ?? fail(`unknown function "${t}"`);
        next();
        const v = sum();
        if (next() !== ')') fail('missing )');
        return fn(v);
      }
      if (Object.hasOwn(dims, t)) return dims[t];
      if (Object.hasOwn(CONSTS, t)) return CONSTS[t];
      return fail(`unknown name "${t}"`);
    }
    return fail(`unexpected character '${t}'`);
  };
  const v = sum();
  if (i < tokens.length) fail(`unexpected "${tokens[i]}"`);
  if (!Number.isFinite(v)) fail('result is not a finite number');
  return v;
}

// ---------------------------------------------------------------- validation
export function validateFeaturePlan(raw: unknown): FeaturePlanResult {
  const base = FeaturePlanZ.safeParse(raw);
  const errors: string[] = [];
  let unsupported = false;
  const rawFeatures: any[] = Array.isArray((raw as any)?.features) ? (raw as any).features : [];
  for (const f of rawFeatures) {
    if (typeof f?.type === 'string' && UNVERIFIED_OPERATIONS.includes(f.type)) {
      unsupported = true;
      errors.push(`operation "${f.type}" is not supported yet: its native request path is unverified (docs/protocol-spike.md)`);
    } else if (typeof f?.type === 'string' && !['sketch', 'extrude', 'revolve'].includes(f.type)) {
      unsupported = true;
      errors.push(`operation "${f.type}" is unknown`);
    } else if (f?.type === 'sketch' && Array.isArray(f.profile)) {
      for (const p of f.profile) if (p?.shape !== undefined && !SHAPES.includes(p.shape)) { unsupported = true; errors.push(`profile shape "${String(p.shape)}" is not supported (supported: ${SHAPES.join(', ')})`); }
    } else if (f?.type === 'extrude' && f.endType !== undefined && !END_TYPES.includes(f.endType)) {
      unsupported = true; errors.push(`extrude endType "${String(f.endType)}" is not supported (supported: ${END_TYPES.join(', ')})`);
    }
  }
  if (!base.success) return { ok: false, unsupported, errors: [...errors, ...base.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`)] };
  if (unsupported) return { ok: false, unsupported, errors };

  const features: z.infer<typeof Feature>[] = [];
  rawFeatures.forEach((f, idx) => {
    const r = Feature.safeParse(f);
    if (r.success) features.push(r.data);
    else for (const x of r.error.issues) {
      if (x.code === 'unrecognized_keys') unsupported = true; // a field the validator does not model must never be dropped
      errors.push(`features.${idx}.${x.path.join('.')}: ${x.message}`);
    }
  });
  if (errors.length) return { ok: false, unsupported, errors };
  const plan = { ...base.data, features } as FeaturePlan;

  if (Object.keys(plan.parameters).length === 0) errors.push('at least one parameter is required (the backend asset reader rejects assets without parameters)');
  const dims: Record<string, number> = { ...plan.parameters };
  const reserved = (n: string) => Object.hasOwn(CONSTS, n) || Object.hasOwn(FUNCS, n) || n === '__proto__';
  for (const n of Object.keys(plan.parameters)) if (reserved(n)) errors.push(`parameter "${n}" is a reserved name (constant or function)`);
  for (const n of Object.keys(plan.derived)) {
    if (Object.hasOwn(dims, n)) errors.push(`derived "${n}" duplicates a parameter`);
    if (reserved(n)) errors.push(`derived "${n}" is a reserved name (constant or function)`);
  }
  // Mirror toolbox_library.cpp: std::map (alphabetical) swept repeatedly; values resolved earlier in a sweep are visible to later entries.
  let pending = Object.entries(plan.derived).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  while (pending.length) {
    const still = pending.filter(([n, e]) => { try { dims[n] = evaluate(e, dims); return false; } catch { return true; } });
    if (still.length === pending.length) {
      const [n, e] = still[0]; // the backend reports only the first unresolved entry
      try { evaluate(e, dims); } catch (err) { errors.push(`derived "${n}": ${(err as Error).message}`); }
      break;
    }
    pending = still;
  }

  const num = (where: string, v: unknown, positive = false): number | undefined => {
    if (v === undefined) return undefined;
    try {
      const x = typeof v === 'number' ? v : evaluate(String(v), dims);
      if (positive && !(x > 0)) errors.push(`${where} must be > 0 (is ${x})`);
      return x;
    } catch (err) { errors.push(`${where}: ${(err as Error).message}`); return undefined; }
  };
  const sketches = new Set<string>();
  const ids = new Set<string>();
  const solids = new Set<string>(); // solids that have an add so far
  for (const f of plan.features) {
    if (ids.has(f.id)) errors.push(`duplicate feature id "${f.id}"`);
    ids.add(f.id);
    if (f.type === 'sketch') {
      f.profile.forEach((p, k) => {
        const at = `${f.id}.profile[${k}]`;
        num(`${at}.cx`, p.cx); num(`${at}.cy`, p.cy);
        if (p.shape !== 'circle') num(`${at}.rotation`, p.rotation);
        if (p.shape === 'circle') {
          if (p.d === undefined && p.r === undefined) errors.push(`${at}: circle needs d or r`);
          num(`${at}.d`, p.d, true); num(`${at}.r`, p.r, true);
        } else if (p.shape === 'polygon') {
          if (p.sides < 3) errors.push(`${at}: polygon needs at least 3 sides`);
          num(`${at}.size`, p.size, true);
        } else if (p.shape === 'rectangle') {
          num(`${at}.width`, p.width, true); num(`${at}.height`, p.height, true);
        } else {
          if (p.points.length < 3) errors.push(`${at}: polyline needs at least 3 points`);
          const xy = p.points.map(([x, y], j) => [num(`${at}.points[${j}].x`, x), num(`${at}.points[${j}].y`, y)]);
          // rotation and translation preserve distance, so the raw evaluated values decide (backend: < 1e-6, incl. last -> first)
          if (xy.every(([x, y]) => x !== undefined && y !== undefined)) {
            for (let j = 0; j < xy.length; j++) {
              const [a, b] = [xy[j], xy[(j + 1) % xy.length]];
              if (Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) < 1e-6)
                errors.push(`${at}: polyline corners ${j + 1} and ${((j + 1) % xy.length) + 1} coincide (closer than 1e-6); do not repeat the first point to close the loop, it closes automatically`);
            }
          }
        }
      });
      sketches.add(f.id);
    } else {
      if (!sketches.has(f.profile)) errors.push(`${f.id} references "${f.profile}", which is not an earlier sketch`);
      if (f.type === 'extrude') {
        num(`${f.id}.depth`, f.depth, f.endType === 'blind'); // backend always evaluates depth; > 0 only when blind
      }
      const solid = f.solid ?? '';
      if (f.operation === 'cut' && !solids.has(solid)) errors.push(`${f.id}: cut before any add in solid "${solid}"`);
      if (f.operation === 'add') solids.add(solid);
    }
  }
  return errors.length ? { ok: false, unsupported: false, errors } : { ok: true, plan, dims };
}

/**
 * Converts a validated plan to the backend Toolbox asset JSON format (fields as read by toolbox_library.cpp).
 * The *file* format is verified; whether the backend accepts it inline is not (docs/protocol-spike.md §5-6).
 */
export function toToolboxAsset(plan: FeaturePlan) {
  const names = Object.keys(plan.parameters);
  return {
    id: plan.part,
    standardId: 'agent',
    label: plan.label ?? plan.part,
    parameters: names.map((name) => ({ name, label: name, unit: 'mm' })),
    derived: plan.derived,
    sizes: { columns: names, defaultSize: 'default', rows: { default: names.map((n) => plan.parameters[n]) } },
    features: plan.features,
  };
}
