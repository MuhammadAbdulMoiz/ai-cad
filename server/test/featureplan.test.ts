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
  it('round is half away from zero (std::round)', () => { expect(evaluate('round(-2.5)', {})).toBe(-3); expect(evaluate('round(2.5)', {})).toBe(3); });
  it('constructor(1) is an unknown function; __proto__ is an unknown name', () => {
    expect(() => evaluate('constructor(1)', {})).toThrow(/unknown function "constructor"/);
    expect(() => evaluate('__proto__', {})).toThrow(/unknown name "__proto__"/);
    expect(() => evaluate('toString', {})).toThrow(/unknown name "toString"/);
  });
  it('only space and tab are whitespace', () => {
    expect(evaluate(' 1\t+ 2 ', {})).toBe(3);
    expect(() => evaluate('1 +\n2', {})).toThrow(/unexpected character/);
    expect(() => evaluate('1\r+2', {})).toThrow(/unexpected character/);
    expect(() => evaluate('1\u00a0+2', {})).toThrow(/unexpected character/);
  });
  it('dimensions shadow constants', () => { expect(evaluate('e', { e: 3 })).toBe(3); });
  it('rejects unknown names, functions and junk', () => {
    expect(() => evaluate('x + 1', {})).toThrow(/unknown name "x"/);
    expect(() => evaluate('min(1)', {})).toThrow(/unknown function "min"/);
    expect(() => evaluate('1 % 2', {})).toThrow(/unexpected/);
    expect(() => evaluate('1 / 0', {})).toThrow(/finite/);
  });
});

const fails = (p: unknown): string => { const r = validateFeaturePlan(p); if (r.ok) throw new Error('expected failure'); return r.errors.join('\n'); };

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
    const ra = validateFeaturePlan(a);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.errors.join()).toMatch(/must be > 0/);
    const rb = validateFeaturePlan(b);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.errors.join()).toMatch(/unknown name "widht"/);
  });
  it('rejects a cut before any body, and duplicate ids', () => {
    const a: any = plate(); a.features[1].operation = 'cut';
    const b: any = plate(); b.features[1].id = 's_plate';
    expect(fails(a)).toMatch(/cut before/);
    expect(fails(b)).toMatch(/duplicate/);
  });
  it('evaluates derived values in dependency order and reports cycles', () => {
    const a: any = { ...plate(), derived: { half: 'quarter * 2', quarter: 'width / 4' } };
    const r = validateFeaturePlan(a);
    expect(r.ok && r.dims.half).toBe(50);
    const c: any = { ...plate(), derived: { a1: 'b1 + 1', b1: 'a1 + 1' } };
    expect(fails(c)).toMatch(/derived "a1"/);
  });
  it('polyline needs 3 points; circle needs d or r', () => {
    const a: any = plate(); a.features[0].profile = [{ shape: 'polyline', points: [[0, 0], [10, 0]] }];
    const b: any = plate(); b.features[0].profile = [{ shape: 'circle' }];
    expect(fails(a)).toMatch(/3 points/);
    expect(fails(b)).toMatch(/d or r/);
  });
  it('rejects unknown keys as unsupported (never strips them)', () => {
    const a: any = { ...plate(), features: [{ type: 'sketch', id: 's', profile: [{ shape: 'circle', d: 5 }] }, { type: 'revolve', id: 'r', profile: 's', angle: 90 }] };
    const b: any = plate(); b.features[1].draft = 3;
    for (const [p, key] of [[a, 'angle'], [b, 'draft']] as const) {
      const r = validateFeaturePlan(p);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.unsupported).toBe(true); expect(r.errors.join()).toContain(key); }
    }
    const c: any = plate(); c.features[0].profile[0].fillet = 2;
    expect(fails(c)).toMatch(/fillet/);
  });
  it('unknown shape or endType is unsupported', () => {
    const a: any = plate(); a.features[0].profile = [{ shape: 'arc' }];
    const b: any = plate(); b.features[1].endType = 'upToFace';
    for (const p of [a, b]) { const r = validateFeaturePlan(p); expect(r.ok).toBe(false); if (!r.ok) expect(r.unsupported).toBe(true); }
    expect(fails(a)).toMatch(/shape "arc"/);
    expect(fails(b)).toMatch(/endType "upToFace"/);
  });
  it('extrude depth is required and evaluated even for throughAll; > 0 only for blind', () => {
    const a: any = plate(); a.features[1].endType = 'throughAll'; delete a.features[1].depth;
    expect(fails(a)).toMatch(/depth/);
    const b: any = plate(); b.features[1].endType = 'throughAll'; b.features[1].depth = 'nope';
    expect(fails(b)).toMatch(/unknown name "nope"/);
    const c: any = plate(); c.features[1].endType = 'throughAll'; c.features[1].depth = 0;
    expect(validateFeaturePlan(c).ok).toBe(true);
  });
  it('evaluates rotation on polygon, rectangle and polyline', () => {
    const shapes: any[] = [
      { shape: 'polygon', sides: 6, size: 10, rotation: 'nope' },
      { shape: 'rectangle', width: 5, height: 5, rotation: 'nope' },
      { shape: 'polyline', points: [[0, 0], [5, 0], [5, 5]], rotation: 'nope' },
    ];
    for (const sh of shapes) { const a: any = plate(); a.features[0].profile = [sh]; expect(fails(a)).toMatch(/rotation.*unknown name "nope"/); }
  });
  it('polyline accepts cx/cy; closed or coincident loops fail', () => {
    const a: any = plate(); a.features[0].profile = [{ shape: 'polyline', cx: 'width', cy: 1, points: [[0, 0], [5, 0], [5, 5]] }];
    expect(validateFeaturePlan(a).ok).toBe(true);
    const b: any = plate(); b.features[0].profile = [{ shape: 'polyline', points: [[0, 0], [5, 0], [5, 5], [0, 0]] }];
    expect(fails(b)).toMatch(/do not repeat the first point/);
    const c: any = plate(); c.features[0].profile = [{ shape: 'polyline', points: [[0, 0], [5, 0], [5, 5], [5, 5]] }];
    expect(fails(c)).toMatch(/corners 3 and 4 coincide/);
  });
  it('cut needs an earlier add in its own solid (extrude and revolve)', () => {
    const a: any = plate(); a.features.push({ type: 'extrude', id: 'e2', profile: 's_plate', depth: 1, operation: 'cut', solid: 'other' });
    expect(fails(a)).toMatch(/cut before any add in solid "other"/);
    const b: any = plate(); b.features.push({ type: 'revolve', id: 'r2', profile: 's_plate', operation: 'cut', solid: 'other' });
    expect(fails(b)).toMatch(/cut before any add in solid "other"/);
    const ok: any = plate(); ok.features.push({ type: 'extrude', id: 'e2', profile: 's_plate', depth: 1, operation: 'cut' });
    expect(validateFeaturePlan(ok).ok).toBe(true);
  });
  it('a parameter or derived named __proto__ is rejected; pi/e/sin may be shadowed', () => {
    const a = JSON.parse('{"part":"p","units":"mm","parameters":{"__proto__":3,"w":5},"features":[{"type":"sketch","id":"s","profile":[{"shape":"circle","d":"w"}]}]}');
    expect(fails(a)).toMatch(/"__proto__" is a reserved name/);
    const b = JSON.parse('{"part":"p","units":"mm","parameters":{"w":5},"derived":{"__proto__":"w"},"features":[{"type":"sketch","id":"s","profile":[{"shape":"circle","d":"w"}]}]}');
    expect(fails(b)).toMatch(/"__proto__" is a reserved name/);
    const c: any = plate(); c.parameters.pi = 3;
    expect(validateFeaturePlan(c).ok).toBe(true);
  });
  it('the ISO 4014 hex bolt asset re-expressed as a plan validates', () => {
    const bolt = {
      part: 'iso4014-hex-bolt', units: 'mm',
      parameters: { d: 8, s: 13, k: 5.3, L: 40 }, derived: { e: 's / cos(pi / 6)' },
      features: [
        { type: 'sketch', id: 's_head', plane: 'XY', profile: [{ shape: 'polygon', sides: 6, fit: 'acrossFlats', size: 's' }] },
        { type: 'extrude', id: 'e_head', profile: 's_head', depth: 'k' },
        { type: 'sketch', id: 's_shank', plane: 'XY', profile: [{ shape: 'circle', d: 'd' }] },
        { type: 'extrude', id: 'e_shank', profile: 's_shank', depth: 'L', reversed: true, operation: 'add' },
      ],
    };
    const r = validateFeaturePlan(bolt);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dims.e).toBeCloseTo(13 / Math.cos(Math.PI / 6));
  });
  it('strict-key error path has no trailing dot', () => {
    const a: any = plate(); a.features[1].foo = 1;
    expect(fails(a)).toMatch(/features.1: Unrecognized key/);
  });
  it('derived values follow the backend order: alphabetical sweeps, in-sweep visibility', () => {
    // sweep 1: a_x ok(width); b_y needs c_z (pending); c_z ok -> sweep 2 resolves b_y
    const a: any = { ...plate(), derived: { b_y: 'c_z + 1', a_x: 'width', c_z: 'a_x * 2' } };
    const r = validateFeaturePlan(a);
    expect(r.ok && [r.dims.a_x, r.dims.c_z, r.dims.b_y]).toEqual([100, 200, 201]);
    // only the first (alphabetical) unresolved derived is reported, as the backend does
    const c: any = { ...plate(), derived: { z: 'y + 1', y: 'z + 1' } };
    const rc = validateFeaturePlan(c);
    expect(rc.ok).toBe(false);
    if (!rc.ok) { expect(rc.errors.join()).toMatch(/derived "y"/); expect(rc.errors.join()).not.toMatch(/derived "z"/); }
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
