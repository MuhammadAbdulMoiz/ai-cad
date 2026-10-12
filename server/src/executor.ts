// Executor: runs a validated FeaturePlan one feature at a time through an IvyPort and records every step.
// A tool reply is never success on its own: each feature must be identified in the snapshot diff and pass
// its evidence-backed checks. On the first failure or ambiguous reply the run stops; nothing is retried
// or repaired in place. Repair = a revised plan rebuilt into a different, approved document (spec §5).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { evaluateFeature, type CheckResult, type Evidence } from './checks';
import { validateFeaturePlan, type FeaturePlan } from './featureplan';
import type { FeatureType } from './plan';
import { diffSnapshots, type ModelSnapshot, type SnapDiff } from './snapshot';
import { RunStore, runVerdict, type RunEvent, type Verdict } from './store';

export type Provenance = 'simulated' | 'live';
export type Target = { projectId: number; projectTag: string; documentId: number };
export type PlanFeatureStep = FeaturePlan['features'][number];
/** One feature per call. `refs` maps earlier plan ids to the Ivy feature ids they were created as. */
export type BuildRequest = { target: Target; feature: PlanFeatureStep; dims: Record<string, number>; refs: Record<string, number> };

/** The seam to Ivy, implemented by the test mock now and the live MCP client later. Replies are untrusted. */
export interface IvyPort {
  readonly provenance: Provenance;
  build(req: BuildRequest): Promise<unknown>;
  snapshot(target: Target): Promise<ModelSnapshot>;
  measure?(target: Target): Promise<unknown>;
}

// featureIds are assumed to be the features' attr `_id` (SnapObject.featId); unverified until a live build.
const ReplyZ = z.object({ result: z.string(), featureIds: z.array(z.number().int().positive()), message: z.string().optional() });
const mm = z.number().positive().finite();
const MeasureZ = z.object({ volume_mm3: mm, bbox_mm: z.tuple([mm, mm, mm]) });
// Class evidence was captured for UI-built sketches and extrudes (docs/inspector-fields.md); revolve has none yet.
const EVIDENCE_TYPE: Partial<Record<PlanFeatureStep['type'], FeatureType>> = { sketch: 'sketch_rectangle', extrude: 'extrude' };

export type ExecuteOptions = { runsDir: string; target: Target; ev: Evidence; signal?: AbortSignal; repairOf?: string };
export type ExecuteResult = { runId: string; verdict: Verdict; reason?: string; createdIds: Record<string, string> };

function checkTarget(t: Target) {
  const ok = t && Number.isInteger(t.projectId) && t.projectId > 0 && Number.isInteger(t.documentId) && t.documentId > 0
    && typeof t.projectTag === 'string' && t.projectTag.length > 0;
  if (!ok) throw new Error(`explicit target {projectId, projectTag, documentId} required, got ${JSON.stringify(t)}`);
}
const classes = (d: SnapDiff) => ({ added: d.added.map((o) => o.cls), removed: d.removed.map((o) => o.cls), modified: d.modified.map((o) => o.cls) });

export async function execute(rawPlan: unknown, port: IvyPort, o: ExecuteOptions): Promise<ExecuteResult> {
  const v = validateFeaturePlan(rawPlan);
  if (!v.ok) throw new Error(`plan rejected: ${v.errors.join('; ')}`);
  checkTarget(o.target);
  const run = RunStore.create(o.runsDir, `${v.plan.part}${v.plan.label ? `: ${v.plan.label}` : ''}`);
  run.writeJson('plan.json', v.plan);
  run.append('run_config', { target: o.target, provenance: port.provenance, repairOf: o.repairOf ?? null });

  const createdIds: Record<string, string> = {}; // plan id -> snapshot uuid
  const ivyIds: Record<string, number> = {};     // plan id -> Ivy feature id
  const end = (verdict: Verdict, reason?: string): ExecuteResult => {
    run.append('run_end', { verdict, ...(reason ? { reason } : {}) });
    return { runId: run.id, verdict, reason, createdIds };
  };
  let base: ModelSnapshot | undefined;
  // Stops the run. Records what the failed step left behind (a build may stop without rollback) for diagnosis only.
  const stop = async (feature: string, reason: string): Promise<ExecuteResult> => {
    run.append('step_fail', { feature, reason });
    try {
      if (base) run.append('post_failure_state', { provenance: port.provenance, ...classes(diffSnapshots(base, await port.snapshot(o.target), o.ev.volatileClasses)) });
    } catch (e) { run.append('post_failure_state', { error: (e as Error).message }); }
    return end('failed', `${feature}: ${reason}`);
  };

  try {
    base = await port.snapshot(o.target);
    run.append('baseline', { provenance: port.provenance, objects: base.objects.size });
    for (const f of v.plan.features) {
      if (o.signal?.aborted) return end('cancelled', `cancelled before ${f.id}`);
      run.append('step_start', { feature: f.id, featureType: f.type });
      const raw = await port.build({ target: o.target, feature: f, dims: v.dims, refs: { ...ivyIds } });
      run.append('step_build', { feature: f.id, provenance: port.provenance, reply: raw ?? null });
      const reply = ReplyZ.safeParse(raw);
      if (!reply.success) return stop(f.id, `ambiguous build reply: ${reply.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      if (reply.data.result !== 'OK') return stop(f.id, `build failed: ${reply.data.result}${reply.data.message ? ` (${reply.data.message})` : ''}`);
      if (reply.data.featureIds.length !== 1) return stop(f.id, `ambiguous build reply: expected 1 feature id, got ${reply.data.featureIds.length}`);
      const id = reply.data.featureIds[0];
      const owner = Object.keys(ivyIds).find((k) => ivyIds[k] === id);
      if (owner) return stop(f.id, `duplicate feature identity ${id}: already created for ${owner}`);

      const cur = await port.snapshot(o.target);
      run.append('snapshot', { feature: f.id, provenance: port.provenance, objects: cur.objects.size });
      const diff = diffSnapshots(base, cur, o.ev.volatileClasses);
      const matches = diff.added.filter((x) => x.featId === id);
      if (matches.length !== 1)
        return stop(f.id, matches.length ? `duplicate feature identity ${id}: ${matches.length} new objects carry it` : `missing feature identity ${id}: no new object carries it`);
      const obj = matches[0];
      const type = EVIDENCE_TYPE[f.type];
      if (!type) {
        const results: CheckResult[] = [{ kind: 'feature_exists', status: 'unsupported', detail: `no class evidence for ${f.type}` }];
        run.append('step_verify', { feature: f.id, ivyFeatureId: id, key: obj.key, ...classes(diff), results, passed: false });
        return stop(f.id, `unverifiable: no class evidence for ${f.type}`);
      }
      const cls = o.ev.featureClass[type];
      if (obj.cls !== cls) return stop(f.id, `feature ${id} is ${obj.cls}, expected ${cls}`);
      if (diff.added.filter((x) => x.cls === cls).length > 1) return stop(f.id, `ambiguous: several new ${cls} objects appeared`);

      const res = evaluateFeature({
        feature: { id: f.id, type, dependsOn: f.type === 'sketch' ? [] : [f.profile], params: {}, checks: f.type === 'sketch' ? [] : [{ kind: 'depends_on' }] },
        diff: { ...diff, added: [obj] }, cur,
        // no browser is attached to an MCP build, so console evidence does not exist: unsupported, never a pass
        ev: { ...o.ev, supported: { ...o.ev.supported, no_new_console_errors: false } },
        freshConsole: [], createdIds,
      });
      run.append('step_verify', { feature: f.id, ivyFeatureId: id, key: obj.key, ...classes(diff), results: res.results, passed: res.passed });
      if (!res.passed) return stop(f.id, `verification failed: ${res.results.filter((r) => r.status === 'fail').map((r) => `${r.kind} ${r.detail}`).join('; ')}`);
      createdIds[f.id] = obj.key;
      ivyIds[f.id] = id;
      base = cur;
    }

    if (!port.measure) run.append('measurement', { status: 'unsupported', detail: 'no measurement tool' });
    else {
      const m = MeasureZ.safeParse(await port.measure(o.target));
      if (!m.success) { run.append('measurement', { provenance: port.provenance, status: 'malformed' }); return end('failed', 'malformed measurement reply'); }
      run.append('measurement', { provenance: port.provenance, status: 'measured', ...m.data });
    }
    return end('passed');
  } catch (e) {
    return end('failed', `error: ${(e as Error).message}`);
  }
}

/** Repair: rebuild a revised plan into a different, approved document. The failed run's document is never written. */
export async function rebuild(prevRunId: string, revisedPlan: unknown, port: IvyPort, o: ExecuteOptions & { approved: boolean }): Promise<ExecuteResult> {
  if (o.approved !== true) throw new Error('a clean rebuild needs explicit approval of its destination document');
  const prev = RunStore.open(o.runsDir, prevRunId);
  const events = prev.readEvents();
  if (runVerdict(events) === 'passed') throw new Error(`run ${prevRunId} passed; nothing to repair`);
  const old = events.find((e) => e.type === 'run_config')?.target as Target | undefined;
  if (!old) throw new Error(`run ${prevRunId} has no recorded target`);
  if (old.projectId === o.target.projectId && old.documentId === o.target.documentId)
    throw new Error('a rebuild must go into a clean document, never the failed one');
  const v = validateFeaturePlan(revisedPlan);
  if (!v.ok) throw new Error(`revised plan rejected: ${v.errors.join('; ')}`);
  if (JSON.stringify(v.plan) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(prev.dir, 'plan.json'), 'utf8'))))
    throw new Error('the revised plan is identical to the failed one');
  return execute(revisedPlan, port, { ...o, repairOf: prevRunId });
}

export type PlateExpectation = { volume_mm3: number; bbox_mm: [number, number, number] };

/** Live plate acceptance: only live evidence, a passed run, and a live measurement matching the expectation (relative tol). */
export function plateAcceptance(events: RunEvent[], expected: PlateExpectation, tol = 1e-3): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cfg = events.find((e) => e.type === 'run_config');
  if (cfg?.provenance !== 'live') reasons.push(`build evidence is ${String(cfg?.provenance ?? 'missing')}, not live`);
  const notLive = events.filter((e) => 'provenance' in e && e.provenance !== 'live');
  if (notLive.length) reasons.push(`${notLive.length} evidence events are not live`);
  const verdict = runVerdict(events);
  if (verdict !== 'passed') reasons.push(`run verdict is ${verdict}`);
  const m = events.filter((e) => e.type === 'measurement').at(-1);
  const near = (a: number, b: number) => Math.abs(a - b) <= tol * Math.abs(b);
  if (m?.status !== 'measured' || m.provenance !== 'live') reasons.push('no live measurement');
  else {
    const got = m as unknown as PlateExpectation;
    if (!near(got.volume_mm3, expected.volume_mm3)) reasons.push(`volume ${got.volume_mm3} mm³, expected ${expected.volume_mm3}`);
    if (!got.bbox_mm.every((x, i) => near(x, expected.bbox_mm[i]))) reasons.push(`bbox ${got.bbox_mm.join('×')} mm, expected ${expected.bbox_mm.join('×')}`);
  }
  return { pass: reasons.length === 0, reasons };
}
