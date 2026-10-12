import { describe, it, expect } from 'vitest';
import { validatePlan } from '../src/plan';

const good = {
  product: 'mounting plate', units: 'mm', parameters: { w: 100, h: 60, t: 8 },
  features: [
    { id: 'f1', type: 'sketch_rectangle', dependsOn: [], params: { plane: 'XY', width: 100, height: 60 }, checks: [] },
    { id: 'f2', type: 'extrude', dependsOn: ['f1'], params: { depth: 8 }, checks: [{ kind: 'dimension', expect: { name: 'depth', value: 8 } }] },
  ],
  acceptance: [{ kind: 'body_count', expect: 1 }],
};
const clone = () => structuredClone(good) as any;

describe('validatePlan', () => {
  it('accepts a valid plate plan', () => { expect(validatePlan(good).ok).toBe(true); });
  it('rejects unsupported operation with unsupported flag', () => {
    const p = clone(); p.features.push({ id: 'f3', type: 'hole', dependsOn: ['f2'], params: {}, checks: [] });
    const r = validatePlan(p);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.unsupported).toBe(true); expect(r.errors.join()).toContain('operation "hole" not supported'); }
  });
  it('rejects forward dependency', () => {
    const p = clone(); p.features[0].dependsOn = ['f2'];
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects duplicate ids', () => {
    const p = clone(); p.features[1].id = 'f1';
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects extrude without sketch dependency', () => {
    const p = clone(); p.features[1].dependsOn = [];
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects non-positive dimensions', () => {
    const p = clone(); p.features[1].params.depth = 0;
    expect(validatePlan(p).ok).toBe(false);
  });
});
