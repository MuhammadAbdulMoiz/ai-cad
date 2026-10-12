import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, validateFeaturePlan, toToolboxAsset } from '../src/featureplan';

const plate = () => ({
  part: 'mounting-plate', units: 'mm',
  parameters: { width: 100, height: 60, thickness: 8 },
  features: [
    { type: 'sketch', id: 's_plate', plane: 'XY', profile: [{ shape: 'rectangle', width: 'width', height: 'height' }] },
    { type: 'extrude', id: 'e_plate', profile: 's_plate', depth: 'thickness' },
  ],
});

describe('evaluate (mirrors toolbox_expression.cpp)', () => {
  it('arithmetic, functions, constants, names', () => {
    expect(evaluate('s / cos(pi / 6)', { s: 13 })).toBeCloseTo(13 / Math.cos(Math.PI / 6));
    expect(evaluate('2 + 3 * 4', {})).toBe(14);
    expect(evaluate('2 ^ 3 ^ 2', {})).toBe(512); // right-associative
    expect(evaluate('-2 ^ 2', {})).toBe(4); // unary binds tighter than ^, as in the backend
    expect(evaluate('deg(pi)', {})).toBeCloseTo(180);
  });
  it('dimensions shadow constants', () => { expect(evaluate('e', { e: 3 })).toBe(3); });
  it('rejects unknown names, functions and junk', () => {
    expect(() => evaluate('x + 1', {})).toThrow(/unknown name "x"/);
    expect(() => evaluate('min(1)', {})).toThrow(/unknown function "min"/);
    expect(() => evaluate('1 % 2', {})).toThrow(/unexpected/);
    expect(() => evaluate('1 / 0', {})).toThrow(/finite/);
  });
});

describe('validateFeaturePlan', () => {
  it('accepts the plate and resolves dimensions', () => {
    const r = validateFeaturePlan(plate());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.dims.thickness).toBe(8); expect(r.plan.maturity).toBe('concept'); }
  });
  it('rejects unverified generic operations as unsupported (never drops them)', () => {
    const p: any = plate(); p.features.push({ type: 'fillet', id: 'f1', radius: 2 });
    const r = validateFeaturePlan(p);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.unsupported).toBe(true); expect(r.errors.join()).toMatch(/fillet.*unverified/); }
  });
  it('rejects references to unknown or later sketches', () => {
    const p: any = plate(); p.features[1].profile = 'nope';
    expect(validateFeaturePlan(p).ok).toBe(false);
  });
  it('rejects non-positive evaluated dimensions and unknown parameter names', () => {
    const a: any = plate(); a.parameters.thickness = 0;
    const b: any = plate(); b.features[0].profile[0].width = 'widht';
    expect(validateFeaturePlan(a).ok).toBe(false);
    const rb = validateFeaturePlan(b);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.errors.join()).toMatch(/unknown name "widht"/);
  });
  it('rejects a cut before any body, and duplicate ids', () => {
    const a: any = plate(); a.features[1].operation = 'cut';
    const b: any = plate(); b.features[1].id = 's_plate';
    expect(validateFeaturePlan(a).ok).toBe(false);
    expect(validateFeaturePlan(b).ok).toBe(false);
  });
  it('evaluates derived values in dependency order and reports cycles', () => {
    const a: any = { ...plate(), derived: { half: 'quarter * 2', quarter: 'width / 4' } };
    const r = validateFeaturePlan(a);
    expect(r.ok && r.dims.half).toBe(50);
    const c: any = { ...plate(), derived: { a1: 'b1 + 1', b1: 'a1 + 1' } };
    expect(validateFeaturePlan(c).ok).toBe(false);
  });
  it('polyline needs 3 points; circle needs d or r', () => {
    const a: any = plate(); a.features[0].profile = [{ shape: 'polyline', points: [[0, 0], [10, 0]] }];
    const b: any = plate(); b.features[0].profile = [{ shape: 'circle' }];
    expect(validateFeaturePlan(a).ok).toBe(false);
    expect(validateFeaturePlan(b).ok).toBe(false);
  });
});

describe('toToolboxAsset', () => {
  it('produces the backend asset fields (parameters, size table, features)', () => {
    const r = validateFeaturePlan(plate());
    if (!r.ok) throw new Error('plate invalid');
    const a = toToolboxAsset(r.plan);
    expect(a.sizes).toEqual({ columns: ['width', 'height', 'thickness'], defaultSize: 'default', rows: { default: [100, 60, 8] } });
    expect(a.features[1]).toMatchObject({ type: 'extrude', profile: 's_plate', depth: 'thickness', operation: 'add', endType: 'blind' });
  });
  it('every skill plan in skills/ validates', () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'skills');
    const plans = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('plan.json')) : [];
    expect(plans.length).toBeGreaterThan(0);
    for (const f of plans) {
      const r = validateFeaturePlan(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
    }
  });
});
