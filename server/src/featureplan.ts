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

const Value = z.union([z.number(), z.string().min(1)]); // literal or expression over parameters/derived
const Profile = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('circle'), cx: Value.optional(), cy: Value.optional(), d: Value.optional(), r: Value.optional() }),
  z.object({ shape: z.literal('polygon'), sides: z.number().int(), size: Value, fit: z.enum(['acrossFlats', 'acrossCorners']).optional(),
    cx: Value.optional(), cy: Value.optional(), rotation: Value.optional() }),
  z.object({ shape: z.literal('rectangle'), width: Value, height: Value, cx: Value.optional(), cy: Value.optional(), rotation: Value.optional() }),
  z.object({ shape: z.literal('polyline'), points: z.array(z.tuple([Value, Value])), rotation: Value.optional() }),
]);
const Op = z.enum(['add', 'cut']);
const Feature = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sketch'), id: z.string().min(1), plane: z.enum(PLANES).default('XY'), profile: z.array(Profile).min(1) }),
  z.object({ type: z.literal('extrude'), id: z.string().min(1), profile: z.string().min(1), depth: Value.optional(),
    endType: z.enum(['blind', 'throughAll']).default('blind'), operation: Op.default('add'),
    reversed: z.boolean().optional(), symmetric: z.boolean().optional(), solid: z.string().optional() }),
  z.object({ type: z.literal('revolve'), id: z.string().min(1), profile: z.string().min(1), axis: z.enum(AXES).default('Z'),
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
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  deg: (v) => (v * 180) / Math.PI, rad: (v) => (v * Math.PI) / 180,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluates `expr` over `dims`. Precedence as the backend: unary (tightest, right) > ^ (right) > * / > + -. */
export function evaluate(expr: string, dims: Record<string, number>): number {
  const tokens = expr.match(/\d*\.?\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/^(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fail = (msg: string): never => { throw new Error(`${msg} in "${expr}"`); };
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
        const fn = FUNCS[t] ?? fail(`unknown function "${t}"`);
        next();
        const v = sum();
        if (next() !== ')') fail('missing )');
        return fn(v);
      }
      if (t in dims) return dims[t];
      if (t in CONSTS) return CONSTS[t];
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
    }
  }
  if (!base.success) return { ok: false, unsupported, errors: [...errors, ...base.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`)] };
  if (unsupported) return { ok: false, unsupported, errors };

  const features: z.infer<typeof Feature>[] = [];
  rawFeatures.forEach((f, idx) => {
    const r = Feature.safeParse(f);
    if (r.success) features.push(r.data);
    else errors.push(...r.error.issues.map((x) => `features.${idx}.${x.path.join('.')}: ${x.message}`));
  });
  if (errors.length) return { ok: false, unsupported: false, errors };
  const plan = { ...base.data, features } as FeaturePlan;

  if (Object.keys(plan.parameters).length === 0) errors.push('at least one parameter is required (the backend asset reader rejects assets without parameters)');
  const dims: Record<string, number> = { ...plan.parameters };
  for (const n of Object.keys(plan.derived)) if (n in dims) errors.push(`derived "${n}" duplicates a parameter`);
  let pending = Object.entries(plan.derived);
  while (pending.length) {
    const still = pending.filter(([n, e]) => { try { dims[n] = evaluate(e, dims); return false; } catch { return true; } });
    if (still.length === pending.length) {
      for (const [n, e] of still) { try { evaluate(e, dims); } catch (err) { errors.push(`derived "${n}": ${(err as Error).message}`); } }
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
  let bodyExists = false;
  for (const f of plan.features) {
    if (ids.has(f.id)) errors.push(`duplicate feature id "${f.id}"`);
    ids.add(f.id);
    if (f.type === 'sketch') {
      f.profile.forEach((p, k) => {
        const at = `${f.id}.profile[${k}]`;
        num(`${at}.cx`, p.shape !== 'polyline' ? p.cx : undefined); num(`${at}.cy`, p.shape !== 'polyline' ? p.cy : undefined);
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
          p.points.forEach(([x, y], j) => { num(`${at}.points[${j}].x`, x); num(`${at}.points[${j}].y`, y); });
        }
      });
      sketches.add(f.id);
    } else {
      if (!sketches.has(f.profile)) errors.push(`${f.id} references "${f.profile}", which is not an earlier sketch`);
      if (f.type === 'extrude') {
        if (f.endType === 'blind') { if (f.depth === undefined) errors.push(`${f.id}: blind extrude needs depth`); else num(`${f.id}.depth`, f.depth, true); }
      }
      if (f.operation === 'cut' && !bodyExists) errors.push(`${f.id}: cut before any body exists`);
      if (f.operation === 'add') bodyExists = true;
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
