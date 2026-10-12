import type { Check, CheckKind, FeatureType, PlanFeature } from './plan';
import { diffSnapshots, type ModelSnapshot, type SnapDiff, type SnapObject } from './snapshot';

export type Evidence = {
  excludeClasses: string[]; featureClass: Record<FeatureType, string>; bodyClass: string | null;
  volatileClasses: string[]; supported: Record<CheckKind, boolean>;
};
export type CheckStatus = 'pass' | 'fail' | 'unsupported' | 'skipped';
export type CheckResult = { kind: CheckKind; status: CheckStatus; detail: string };
export type FeatureCtx = {
  feature: PlanFeature; diff: SnapDiff; cur: ModelSnapshot; ev: Evidence;
  freshConsole: string[]; createdIds: Record<string, string>;
};
export const MANDATORY: CheckKind[] = ['feature_exists', 'existing_features_intact', 'no_new_console_errors'];

const r = (kind: CheckKind, status: CheckStatus, detail: string): CheckResult => ({ kind, status, detail });

function dimension(c: Check, obj: SnapObject | undefined): CheckResult {
  const { name, value, tol = 0.01 } = c.expect ?? {};
  if (typeof name !== 'string' || typeof value !== 'number' || !Number.isFinite(value))
    return r('dimension', 'fail', 'malformed dimension expectation');
  const v = obj?.dims?.[name];
  if (v === undefined) return r('dimension', 'unsupported', `dimension "${name}" not exposed`);
  return Math.abs(v - value) <= tol ? r('dimension', 'pass', `${name}=${v}`) : r('dimension', 'fail', `${name}=${v}, expected ${value}`);
}

export function evaluateFeature(ctx: FeatureCtx): { results: CheckResult[]; passed: boolean; createdId?: string } {
  const { feature, diff, ev } = ctx;
  const cls = ev.featureClass[feature.type];
  const created = diff.added.find((o) => o.cls === cls);
  // Every check in feature.checks is evaluated in order; a MANDATORY kind is added only when the feature does not declare it.
  const kinds: Check[] = [
    ...MANDATORY.filter((k) => !feature.checks.some((c) => c.kind === k)).map((k) => ({ kind: k })),
    ...feature.checks,
  ];

  const results = kinds.map((c): CheckResult => {
    if (!ev.supported[c.kind]) return r(c.kind, 'unsupported', 'not exposed by inspector (Task 0 evidence)');
    switch (c.kind) {
      case 'feature_exists':
        return created ? r(c.kind, 'pass', `new ${cls} #${created.handle}`) : r(c.kind, 'fail', `no new ${cls} object appeared`);
      case 'existing_features_intact': {
        const bad = [...diff.modified, ...diff.removed];
        return bad.length ? r(c.kind, 'fail', `existing objects changed: ${bad.map((o) => `${o.cls} #${o.handle}`).join(', ')}`) : r(c.kind, 'pass', 'none');
      }
      case 'no_new_console_errors':
        return ctx.freshConsole.length ? r(c.kind, 'fail', ctx.freshConsole.join(' | ')) : r(c.kind, 'pass', 'none');
      case 'depends_on': {
        if (!created?.deps) return r(c.kind, 'unsupported', 'dependencies not exposed');
        const want = feature.dependsOn.map((d) => ctx.createdIds[d]);
        return want.every((id) => created.deps!.includes(id)) ? r(c.kind, 'pass', `deps ${want}`) : r(c.kind, 'fail', `deps ${created.deps}, expected ${want}`);
      }
      case 'status_ok':
        if (created?.statusOk === undefined) return r(c.kind, 'unsupported', 'status not exposed');
        return created.statusOk ? r(c.kind, 'pass', 'ok') : r(c.kind, 'fail', 'feature reports error');
      case 'dimension':
        return dimension(c, created);
      default:
        return r(c.kind, 'skipped', 'evaluated at model level');
    }
  });
  const exists = results.find((x) => x.kind === 'feature_exists')!;
  return { results, passed: exists.status === 'pass' && !results.some((x) => x.status === 'fail'), createdId: created?.key };
}

export function evaluateAcceptance(checks: Check[], cur: ModelSnapshot, ev: Evidence): CheckResult[] {
  return checks.map((c) => {
    if (!ev.supported[c.kind]) return r(c.kind, 'unsupported', 'not exposed by inspector (Task 0 evidence)');
    if (c.kind === 'body_count') {
      if (!ev.bodyClass) return r(c.kind, 'unsupported', 'no body class');
      const n = [...cur.objects.values()].filter((o) => o.cls === ev.bodyClass).length;
      return n === c.expect ? r(c.kind, 'pass', `${n} bodies`) : r(c.kind, 'fail', `${n} bodies, expected ${c.expect}`);
    }
    return r(c.kind, 'skipped', 'not a model-level check');
  });
}

export function reopenMatches(before: ModelSnapshot, after: ModelSnapshot, ev: Evidence): CheckResult {
  if (!ev.supported.reopen_matches) return r('reopen_matches', 'unsupported', 'not exposed by inspector (Task 0 evidence)');
  const d = diffSnapshots(before, after, ev.volatileClasses);
  return d.added.length || d.removed.length || d.modified.length
    ? r('reopen_matches', 'fail', `after reopen: +${d.added.length} -${d.removed.length} ~${d.modified.length} features`)
    : r('reopen_matches', 'pass', `${after.objects.size} features persisted`);
}
