import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execute, rebuild, plateAcceptance, type Target } from '../src/executor';
import { loadEvidence } from '../src/adapter';
import { RunStore, runVerdict, type RunEvent } from '../src/store';
import { MockIvy } from './mockivy';

const platePlan = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'plate', 'plan.json'), 'utf8'));
const plateExpected = { volume_mm3: 48000, bbox_mm: [100, 60, 8] as [number, number, number] };
// plate + a cut pocket: four features, two dependency chains
const pocketPlan = structuredClone(platePlan);
pocketPlan.parameters.pocket = 20;
pocketPlan.features.push(
  { type: 'sketch', id: 's_pocket', plane: 'XY', profile: [{ shape: 'circle', d: 'pocket' }] },
  { type: 'extrude', id: 'e_pocket', profile: 's_pocket', depth: 'thickness', operation: 'cut' },
);
const target: Target = { projectId: 37649980, projectTag: 'main', documentId: 1 };
const ev = loadEvidence();
let runsDir: string;
beforeEach(() => { runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-')); });
const opts = <T extends object>(o: T = {} as T) => ({ runsDir, target, ev, ...o });
const events = (id: string) => RunStore.open(runsDir, id).readEvents();
const ofType = (evs: RunEvent[], t: string) => evs.filter((e) => e.type === t);

describe('execute', () => {
  it('builds features one at a time in dependency order and proves each from the snapshot', async () => {
    const ivy = new MockIvy();
    const r = await execute(pocketPlan, ivy, opts());
    expect(r.verdict).toBe('passed');
    expect(ivy.calls.map((c) => c.feature.id)).toEqual(['s_plate', 'e_plate', 's_pocket', 'e_pocket']);
    expect(ivy.calls[1].refs).toEqual({ s_plate: 100 });             // extrude gets its sketch's Ivy id
    expect(ivy.calls[3].refs).toMatchObject({ s_pocket: 102 });
    const evs = events(r.runId);
    const verifies = ofType(evs, 'step_verify');
    expect(verifies.map((e) => e.passed)).toEqual([true, true, true, true]);
    const st = (i: number) => Object.fromEntries((verifies[i].results as any[]).map((x) => [x.kind, x.status]));
    expect(st(1)).toMatchObject({ feature_exists: 'pass', depends_on: 'pass', existing_features_intact: 'pass', no_new_console_errors: 'unsupported' });
    expect(ofType(evs, 'measurement')[0]).toMatchObject({ status: 'unsupported' });
    expect(ofType(evs, 'run_config')[0]).toMatchObject({ provenance: 'simulated', target });
    expect(runVerdict(evs)).toBe('passed');
  });

  it('a failed build stops the run, records the failure and the partial state, builds nothing more', async () => {
    const ivy = new MockIvy((req, n, m) => n === 2 ? (m.add(req.target, 'ivy::FeatSolidSet'), { result: 'ERR_EXTRUDE', featureIds: [], message: 'depth' }) : undefined);
    const r = await execute(pocketPlan, ivy, opts());
    expect(r.verdict).toBe('failed');
    expect(ivy.calls).toHaveLength(2);
    const evs = events(r.runId);
    expect(ofType(evs, 'step_fail')[0]).toMatchObject({ feature: 'e_plate', reason: 'build failed: ERR_EXTRUDE (depth)' });
    expect(ofType(evs, 'post_failure_state')[0]).toMatchObject({ added: ['ivy::FeatSolidSet'] });
    expect(runVerdict(evs)).toBe('failed');
  });

  it.each([
    ['no reply', undefined],
    ['missing featureIds', { result: 'OK' }],
    ['wrong types', { result: 0, featureIds: ['100'] }],
    ['two ids for one feature', { result: 'OK', featureIds: [100, 101] }],
  ])('ambiguous reply (%s) stops the run', async (_, reply) => {
    const ivy = new MockIvy((req, n) => (n === 1 ? reply ?? null : undefined));
    const r = await execute(platePlan, ivy, opts());
    expect(r.verdict).toBe('failed');
    expect(r.reason).toMatch(/^s_plate: ambiguous build reply/);
    expect(ivy.calls).toHaveLength(1);
  });

  it('an OK reply with nothing created never passes (missing identity)', async () => {
    const r = await execute(platePlan, new MockIvy((_, n) => (n === 1 ? { result: 'OK', featureIds: [555] } : undefined)), opts());
    expect(r.verdict).toBe('failed');
    expect(r.reason).toBe('s_plate: missing feature identity 555: no new object carries it');
  });

  it('a reply reusing an earlier feature id is a duplicate identity', async () => {
    const r = await execute(platePlan, new MockIvy((_, n) => (n === 2 ? { result: 'OK', featureIds: [100] } : undefined)), opts());
    expect(r.reason).toBe('e_plate: duplicate feature identity 100: already created for s_plate');
  });

  it('two new objects carrying the same id are ambiguous', async () => {
    const ivy = new MockIvy((req, n, m) => {
      if (n !== 1) return undefined;
      m.add(req.target, 'ivy::FeatSketch', 300); m.add(req.target, 'ivy::FeatSketch', 300);
      return { result: 'OK', featureIds: [300] };
    });
    expect((await execute(platePlan, ivy, opts())).reason).toBe('s_plate: duplicate feature identity 300: 2 new objects carry it');
  });

  it('an id pointing at the wrong class fails', async () => {
    const ivy = new MockIvy((req, n, m) => (n === 1 ? { result: 'OK', featureIds: [m.add(req.target, 'ivy::SolidExtrude')] } : undefined));
    expect((await execute(platePlan, ivy, opts())).reason).toMatch(/is ivy::SolidExtrude, expected ivy::FeatSketch/);
  });

  it('a change to an existing feature fails verification', async () => {
    const ivy = new MockIvy((req, n, m) => { if (n === 2) m.doc(req.target)[0].hash = 'changed'; return undefined; });
    const r = await execute(platePlan, ivy, opts());
    expect(r.verdict).toBe('failed');
    expect(r.reason).toMatch(/existing_features_intact existing objects changed: ivy::FeatSketch/);
  });

  it('unsupported checks stay unsupported: no class evidence for revolve means the run cannot pass', async () => {
    const plan = structuredClone(platePlan);
    plan.features.push({ type: 'revolve', id: 'r1', profile: 's_plate', axis: 'Y' });
    const r = await execute(plan, new MockIvy(), opts());
    expect(r.verdict).toBe('failed');
    const v = ofType(events(r.runId), 'step_verify').at(-1)!;
    expect(v).toMatchObject({ feature: 'r1', passed: false, results: [{ kind: 'feature_exists', status: 'unsupported' }] });
  });

  it('dependency evidence switched off is reported unsupported, not passed', async () => {
    const r = await execute(platePlan, new MockIvy(), opts({ ev: { ...ev, supported: { ...ev.supported, depends_on: false } } }));
    const v = ofType(events(r.runId), 'step_verify')[1].results as any[];
    expect(v.find((x) => x.kind === 'depends_on').status).toBe('unsupported');
  });

  it('a port error is persisted as a failure', async () => {
    const ivy = new MockIvy((_, n) => { if (n === 2) throw new Error('socket closed'); return undefined; });
    const r = await execute(platePlan, ivy, opts());
    expect(runVerdict(events(r.runId))).toBe('failed');
    expect(r.reason).toBe('error: socket closed');
  });

  it('a run that dies mid-build is left interrupted with every event so far on disk', async () => {
    const ivy = new MockIvy((_, n) => (n === 2 ? new Promise(() => {}) : undefined));
    void execute(platePlan, ivy, opts());
    await new Promise((r) => setTimeout(r, 50));
    const [id] = fs.readdirSync(runsDir);
    const evs = events(id);
    expect(ofType(evs, 'step_verify')).toHaveLength(1);
    expect(ofType(evs, 'step_start').at(-1)).toMatchObject({ feature: 'e_plate' });
    expect(runVerdict(evs)).toBe('interrupted');
  });

  it('cancellation stops before the next feature', async () => {
    const ac = new AbortController();
    const ivy = new MockIvy((_, n) => { if (n === 1) ac.abort(); return undefined; });
    const r = await execute(platePlan, ivy, opts({ signal: ac.signal }));
    expect(r.verdict).toBe('cancelled');
    expect(ivy.calls).toHaveLength(1);
  });

  it('rejects an invalid plan or a missing target before creating a run', async () => {
    await expect(execute({ ...platePlan, features: [{ type: 'fillet', id: 'f' }] }, new MockIvy(), opts())).rejects.toThrow(/plan rejected/);
    await expect(execute(platePlan, new MockIvy(), opts({ target: { projectId: 1, projectTag: 'main' } }))).rejects.toThrow(/explicit target/);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it('a malformed measurement fails the run', async () => {
    const r = await execute(platePlan, new MockIvy(undefined, { volume_mm3: -1, bbox_mm: [1, 2] }), opts());
    expect(r.reason).toBe('malformed measurement reply');
  });
});

describe('rebuild', () => {
  const failFirst = () => new MockIvy((req, n) => (n === 2 && req.target.documentId === 1 ? { result: 'ERR_EXTRUDE', featureIds: [] } : undefined));
  const revised = () => ({ ...structuredClone(platePlan), parameters: { ...platePlan.parameters, thickness: 10 } });

  it('builds the revised plan into a clean document and leaves the failed model untouched', async () => {
    const ivy = failFirst();
    const failed = await execute(platePlan, ivy, opts());
    const before = structuredClone(ivy.doc(target));
    const clean = { ...target, documentId: 2 };
    const r = await rebuild(failed.runId, revised(), ivy, opts({ target: clean, approved: true }));
    expect(r.verdict).toBe('passed');
    expect(ivy.doc(target)).toEqual(before);
    expect(ivy.calls.slice(2).every((c) => c.target.documentId === 2)).toBe(true);
    expect(ofType(events(r.runId), 'run_config')[0]).toMatchObject({ repairOf: failed.runId, target: clean });
  });

  it('refuses the failed document, an unapproved destination, an unchanged plan, or a passed run', async () => {
    const ivy = failFirst();
    const failed = await execute(platePlan, ivy, opts());
    const clean = { ...target, documentId: 2 };
    await expect(rebuild(failed.runId, revised(), ivy, opts({ approved: true }))).rejects.toThrow(/clean document/);
    await expect(rebuild(failed.runId, revised(), ivy, opts({ target: clean, approved: false }))).rejects.toThrow(/approval/);
    await expect(rebuild(failed.runId, platePlan, ivy, opts({ target: clean, approved: true }))).rejects.toThrow(/identical/);
    const passed = await rebuild(failed.runId, revised(), ivy, opts({ target: clean, approved: true }));
    await expect(rebuild(passed.runId, revised(), ivy, opts({ target: { ...target, documentId: 3 }, approved: true }))).rejects.toThrow(/nothing to repair/);
    expect(ivy.calls.filter((c) => c.target.documentId === 1)).toHaveLength(2); // only the original run touched it
  });
});

describe('plateAcceptance', () => {
  it('a perfect simulated run can never pass the live gate', async () => {
    const r = await execute(platePlan, new MockIvy(undefined, plateExpected), opts());
    expect(r.verdict).toBe('passed');
    const g = plateAcceptance(events(r.runId), plateExpected);
    expect(g.pass).toBe(false);
    expect(g.reasons).toEqual(expect.arrayContaining(['build evidence is simulated, not live', 'no live measurement']));
  });

  const live = (m: object, verdict = 'passed'): RunEvent[] => [
    { t: '', type: 'run_config', provenance: 'live' },
    { t: '', type: 'step_build', provenance: 'live' },
    { t: '', type: 'measurement', provenance: 'live', status: 'measured', ...m },
    { t: '', type: 'run_end', verdict },
  ];
  it('live evidence with matching measurements passes; any mismatch or simulated event fails', () => {
    expect(plateAcceptance(live(plateExpected), plateExpected)).toEqual({ pass: true, reasons: [] });
    expect(plateAcceptance(live({ ...plateExpected, volume_mm3: 40000 }), plateExpected).reasons).toEqual(['volume 40000 mm³, expected 48000']);
    expect(plateAcceptance(live({ ...plateExpected, bbox_mm: [100, 60, 10] }), plateExpected).pass).toBe(false);
    expect(plateAcceptance(live(plateExpected, 'failed'), plateExpected).pass).toBe(false);
    const mixed = live(plateExpected); mixed[1].provenance = 'simulated';
    expect(plateAcceptance(mixed, plateExpected).reasons).toEqual(['1 evidence events are not live']);
    expect(plateAcceptance(live({ status: 'unsupported' }), plateExpected).reasons).toEqual(['no live measurement']);
  });
});
