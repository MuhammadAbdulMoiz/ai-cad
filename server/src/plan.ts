import { z } from 'zod';

export const FEATURE_TYPES = ['sketch_rectangle', 'extrude'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];
export const CHECK_KINDS = ['feature_exists', 'depends_on', 'status_ok', 'body_count', 'dimension',
  'no_unexpected_modification', 'existing_features_intact', 'no_new_console_errors', 'reopen_matches'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type Check = { kind: CheckKind; expect?: any };
export type PlanFeature = { id: string; type: FeatureType; dependsOn: string[]; params: Record<string, number | string>; checks: Check[] };
export type Plan = { product: string; units: 'mm'; parameters: Record<string, number>; features: PlanFeature[]; acceptance: Check[] };
export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[]; unsupported: boolean };

const CheckZ = z.object({ kind: z.enum(CHECK_KINDS), expect: z.any().optional() });
const PlanZ = z.object({
  product: z.string().min(1),
  units: z.literal('mm'),
  parameters: z.record(z.string(), z.number()),
  features: z.array(z.object({
    id: z.string().regex(/^f\d+$/),
    type: z.string(),
    dependsOn: z.array(z.string()),
    params: z.record(z.string(), z.union([z.number(), z.string()])),
    checks: z.array(CheckZ),
  })).min(1),
  acceptance: z.array(CheckZ),
});
const pos = z.number().positive();
const ParamsZ: Record<FeatureType, z.ZodTypeAny> = {
  sketch_rectangle: z.object({ plane: z.enum(['XY', 'XZ', 'YZ']), width: pos, height: pos }),
  extrude: z.object({ depth: pos }),
};

export function validatePlan(raw: unknown): PlanResult {
  const parsed = PlanZ.safeParse(raw);
  if (!parsed.success) return { ok: false, unsupported: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const p = parsed.data;
  const errors: string[] = [];
  let unsupported = false;
  const seen = new Map<string, string>();
  for (const f of p.features) {
    if (seen.has(f.id)) errors.push(`duplicate feature id ${f.id}`);
    if (!(FEATURE_TYPES as readonly string[]).includes(f.type)) {
      unsupported = true;
      errors.push(`operation "${f.type}" not supported in this version (supported: ${FEATURE_TYPES.join(', ')})`);
    } else {
      const pr = ParamsZ[f.type as FeatureType].safeParse(f.params);
      if (!pr.success) errors.push(`${f.id} params: ${pr.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    for (const d of f.dependsOn) if (!seen.has(d)) errors.push(`${f.id} depends on ${d}, which is not an earlier feature`);
    if (f.type === 'extrude' && !f.dependsOn.some((d) => seen.get(d) === 'sketch_rectangle'))
      errors.push(`${f.id} extrude must depend on a sketch_rectangle`);
    seen.set(f.id, f.type);
  }
  return errors.length ? { ok: false, errors, unsupported } : { ok: true, plan: p as Plan };
}
