import { describe, it, expect } from 'vitest';
import { evaluateFeature, evaluateAcceptance, reopenMatches, type Evidence } from '../src/checks';
import type { ModelSnapshot, SnapObject } from '../src/snapshot';

const allSupported = { feature_exists: true, depends_on: true, status_ok: true, body_count: true, dimension: true,
  no_unexpected_modification: true, existing_features_intact: true, no_new_console_errors: true, reopen_matches: true };
const ev = (over: Partial<typeof allSupported> = {}): Evidence => ({
  excludeClasses: [], featureClass: { sketch_rectangle: 'Sketch', extrude: 'Extrude' }, bodyClass: 'Body',
  volatileClasses: [], supported: { ...allSupported, ...over },
});
const snap = (...o: SnapObject[]): ModelSnapshot => ({ objects: new Map(o.map((x) => [x.key, x])) });
const extrude: SnapObject = { key: 'u7', handle: 7, cls: 'Extrude', hash: 'h', deps: ['u5'], statusOk: true, dims: { depth: 8 } };
const feature = { id: 'f2', type: 'extrude' as const, dependsOn: ['f1'], params: { depth: 8 },
  checks: [{ kind: 'depends_on' as const }, { kind: 'status_ok' as const }, { kind: 'dimension' as const, expect: { name: 'depth', value: 8 } }] };
const ctx = (o: Partial<Parameters<typeof evaluateFeature>[0]> = {}) => ({
  feature, diff: { added: [extrude], removed: [], modified: [] }, cur: snap(extrude), ev: ev(),
  freshConsole: [], createdIds: { f1: 'u5' }, ...o,
});

describe('evaluateFeature', () => {
  it('passes when all evidence matches', () => {
    const r = evaluateFeature(ctx());
    expect(r.passed).toBe(true); expect(r.createdId).toBe('u7');
  });
  it('agent claims done but nothing was created -> fail', () => {
    const r = evaluateFeature(ctx({ diff: { added: [], removed: [], modified: [] } }));
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.kind === 'feature_exists')!.status).toBe('fail');
  });
  it('old object of same class does not satisfy check (only diff.added counts)', () => {
    const r = evaluateFeature(ctx({ diff: { added: [], removed: [], modified: [] }, cur: snap(extrude) }));
    expect(r.passed).toBe(false);
  });
  it('modified pre-existing object -> fail', () => {
    const r = evaluateFeature(ctx({ diff: { added: [extrude], removed: [], modified: [{ key: 'u5', handle: 5, cls: 'Sketch', hash: 'x' }] } }));
    expect(r.passed).toBe(false);
  });
  it('fresh console error -> fail', () => {
    expect(evaluateFeature(ctx({ freshConsole: ['TypeError: boom'] })).passed).toBe(false);
  });
  it('unsupported fields are reported unsupported, never pass', () => {
    const r = evaluateFeature(ctx({ ev: ev({ status_ok: false, dimension: false, depends_on: false }) }));
    const st = Object.fromEntries(r.results.map((x) => [x.kind, x.status]));
    expect(st).toMatchObject({ status_ok: 'unsupported', dimension: 'unsupported', depends_on: 'unsupported' });
    expect(r.passed).toBe(true);   // creation still proven by feature_exists
  });
  it('feature_exists unsupported -> cannot pass', () => {
    expect(evaluateFeature(ctx({ ev: ev({ feature_exists: false }) })).passed).toBe(false);
  });
  it('wrong dimension -> fail', () => {
    const bad = { ...extrude, dims: { depth: 5 } };
    expect(evaluateFeature(ctx({ diff: { added: [bad], removed: [], modified: [] }, cur: snap(bad) })).passed).toBe(false);
  });
});

describe('evaluateAcceptance', () => {
  it('body_count pass/fail/unsupported', () => {
    const cur = snap({ key: 'u1', handle: 1, cls: 'Body', hash: 'b' });
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 1 }], cur, ev())[0].status).toBe('pass');
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 2 }], cur, ev())[0].status).toBe('fail');
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 1 }], cur, ev({ body_count: false }))[0].status).toBe('unsupported');
  });
});

describe('reopenMatches', () => {
  const a = snap({ key: 'u1', handle: 1, cls: 'Sketch', hash: 's' }, { key: 'u2', handle: 2, cls: 'Extrude', hash: 'e' });
  it('passes when the same keys and fingerprints come back under new handles', () => {
    const b = snap({ key: 'u1', handle: 901, cls: 'Sketch', hash: 's' }, { key: 'u2', handle: 902, cls: 'Extrude', hash: 'e' });
    expect(reopenMatches(a, b, ev()).status).toBe('pass');
  });
  it('fails when a feature is missing after reopen', () => {
    expect(reopenMatches(a, snap({ key: 'u1', handle: 1, cls: 'Sketch', hash: 's' }), ev()).status).toBe('fail');
  });
  it('unsupported when evidence says so', () => {
    expect(reopenMatches(a, a, ev({ reopen_matches: false })).status).toBe('unsupported');
  });
});
