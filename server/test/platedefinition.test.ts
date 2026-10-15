// The definition-level centring check on the first fully verified live plate (runs/plate-trial-write3, kept intact;
// its notification 96 is stored decoded and without its header in fixtures/write3). Definition is not measurement:
// these tests also pin that the overall verdict stays "incomplete" while the solid's position is unmeasured.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlateDefinition, EXTRUDE_ROLE } from '../src/platedefinition';
import { platePostconditions } from '../src/platetrial';

const FIX = path.join(import.meta.dirname, 'fixtures', 'write3');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const plan = () => read('plan.json');
const ntf = () => read('ntf96-decoded.json');
const IDS = { docId: 527, sketchId: 18, extrudeId: 46 };
const check = (msgs: any[] = [ntf()], p = plan()) => checkPlateDefinition(msgs, { ...IDS, plan: p });
const feature = (m: any, id: number) => m.pkg.appModelNtf.modelDescs[0].modelPkgDecoded.dataNtf.features.find((f: any) => Number(f.featureId) === id);
const sketch = (m: any) => feature(m, 18).sketchFeature;
const extrudeAttr = (m: any, role: number) => feature(m, 46).featUpdateFeature.feat.attributes.find((a: any) => Number(a.role) === role);
const edited = (f: (m: any) => void) => { const m = ntf(); f(m); return [m]; };

describe('the recorded write3 definition (notification 96)', () => {
  it('passes: centred 100 × 60 rectangle on the XY plane with identity placement; blind 8 mm extrude with offsets, reverse and symmetry off', () => {
    const c = check();
    expect(c).toMatchObject({ definition_centered: 'pass', extrusion_definition: 'pass', solid_position_measured: false, problems: [] });
    expect(c.facts.bounds).toEqual({ x: [-50, 50], y: [-30, 30] });
    expect(c.facts.supportTransform).toEqual({ basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin: [0, 0, 0] });
    expect(c.facts.sketchNotification).toBe(96);
    expect(c.extrusion_direction).toMatch(/^inferred: .*not measured$/);
  });
  it('reads the values from the notification, not from the plan (a different plan fails against the same record)', () => {
    expect(check([ntf()], { ...plan(), width: 120 }).definition_centered).toBe('fail');
    expect(check([ntf()], { ...plan(), depth: 10 }).extrusion_definition).toBe('fail');
  });
});

describe('sketch placement', () => {
  it('a shifted placement origin fails', () => {
    const c = check(edited((m) => { sketch(m).support.supportTransform.origin = { x: 10 }; }));
    expect(c.definition_centered).toBe('fail');
    expect(c.problems).toEqual(['sketch definition: the sketch placement origin is [10,0,0], not (0, 0, 0)']);
  });
  it('a rotated basis fails', () => {
    const c = check(edited((m) => { sketch(m).support.supportTransform.basis = [{ y: 1 }, { x: -1 }, { z: 1 }]; }));
    expect(c.definition_centered).toBe('fail');
    expect(c.problems[0]).toBe('sketch definition: the sketch placement basis is [[0,1,0],[-1,0,0],[0,0,1]], not identity');
  });
  it('another support plane fails', () => {
    const c = check(edited((m) => { sketch(m).support.supportBrep.featureId = 5; }));
    expect(c.problems).toEqual(['sketch definition: the sketch is on feature 5, not the planned plane 3']);
  });
});

describe('rectangle coordinates', () => {
  const shift = (dx: number, dy: number) => (m: any) => { for (const g of sketch(m).geoms) for (const q of [g.line.start, g.line.end]) { q.x = (q.x ?? 0) + dx; q.y = (q.y ?? 0) + dy; } };
  it('a rectangle off the origin fails', () => {
    const c = check(edited(shift(5, 0)));
    expect(c.definition_centered).toBe('fail');
    expect(c.problems).toEqual(['sketch definition: the rectangle spans x -45..55, y -30..30: not centred on the sketch origin']);
  });
  it('a wrong size fails', () => {
    const c = check(edited((m) => { for (const g of sketch(m).geoms) for (const q of [g.line.start, g.line.end]) if (q.x === 50) q.x = 60; }));
    expect(c.problems).toContain('sketch definition: the rectangle is 110 × 60, not 100 × 60');
  });
  it('a slanted line fails', () => {
    const c = check(edited((m) => { sketch(m).geoms[0].line.end.y = 20; }));
    expect(c.definition_centered).toBe('fail');
    expect(c.problems).toContain('sketch definition: a line is not axis-aligned');
  });
  it('anything but four lines fails', () => {
    expect(check(edited((m) => { sketch(m).geoms.pop(); })).problems).toEqual(['sketch definition: the sketch holds 3 geometries, not four lines']);
    expect(check(edited((m) => { sketch(m).geoms[0] = { arc: {} }; })).definition_centered).toBe('fail');
  });
});

describe('missing or malformed data: unknown, or fail closed', () => {
  it('no support transform → unknown', () => {
    const c = check(edited((m) => { delete sketch(m).support.supportTransform; }));
    expect(c.definition_centered).toBe('unknown');
    expect(c.problems).toEqual(['sketch definition: the sketch notification carries no support transform']);
  });
  it('a basis that is not three vectors, or a non-numeric component → fail', () => {
    expect(check(edited((m) => { sketch(m).support.supportTransform.basis.pop(); })).problems).toEqual(['sketch definition: the support transform basis is not three vectors']);
    expect(check(edited((m) => { sketch(m).support.supportTransform.basis[0] = { x: '1' }; })).problems).toEqual(['sketch definition: the support transform holds a non-numeric component']);
    expect(check(edited((m) => { sketch(m).geoms[1].line.start.x = 'NaN'; })).problems).toEqual(['sketch definition: a line end holds a non-numeric coordinate']);
  });
  it('no geometry, no notification, another document, an undecoded or sent message → unknown', () => {
    expect(check(edited((m) => { delete sketch(m).geoms; })).definition_centered).toBe('unknown');
    expect(check([]).definition_centered).toBe('unknown');
    expect(check([]).extrusion_definition).toBe('unknown');
    expect(checkPlateDefinition([ntf()], { ...IDS, docId: 999, plan: plan() })).toMatchObject({ definition_centered: 'unknown', extrusion_definition: 'unknown' });
    expect(check([{ ...ntf(), status: 'undecoded' }]).definition_centered).toBe('unknown');
    expect(check([{ ...ntf(), dir: 'sent' }]).definition_centered).toBe('unknown');
  });
  it('a missing extrude option → unknown, never pass', () => {
    const c = check(edited((m) => { const f = feature(m, 46).featUpdateFeature.feat; f.attributes = f.attributes.filter((a: any) => Number(a.role) !== EXTRUDE_ROLE.symmetry); }));
    expect(c.extrusion_definition).toBe('unknown');
    expect(c.problems).toEqual(['extrusion definition: the extrude option symmetry is missing']);
  });
});

describe('extrusion definition', () => {
  it.each([
    ['depth 10', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.depth).parm[0].value = '10.000000'; }, 'extrusion definition: the depth is ["10.000000"], not 8'],
    ['through-all', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.extrudeType).enum = [5]; }, 'extrusion definition: the extrude type is [5], not blind (0)'],
    ['reversed', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.reverse).check = [true]; }, 'extrusion definition: the extrude option reverse (role 31015) is [true], not off'],
    ['symmetric', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.symmetry).check = [true]; }, 'extrusion definition: the extrude option symmetry (role 31011) is [true], not off'],
    ['offset from start on', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.offsetFromStart).check = [true]; }, 'extrusion definition: the extrude option offsetFromStart (role 31008) is [true], not off'],
    ['a second direction', (m: any) => { extrudeAttr(m, EXTRUDE_ROLE.direction2).check = [true]; }, 'extrusion definition: the extrude option direction2 (role 31012) is [true], not off'],
  ])('%s fails', (_n, f, why) => {
    const c = check(edited(f));
    expect(c.extrusion_definition).toBe('fail');
    expect(c.problems).toEqual([why]);
    expect(c.definition_centered).toBe('pass'); // kept separate
  });
  it('another feature type fails', () => {
    expect(check(edited((m) => { feature(m, 46).featUpdateFeature.feat.type = 'SolidRevolution'; })).problems).toEqual(['extrusion definition: feature 46 is SolidRevolution, not SolidExtrude']);
  });
});

describe('definition is not measurement: the write3 verdict stays incomplete', () => {
  it('the real postconditions are "incomplete" with centring unmeasured, while the definition check passes', () => {
    const ev = read('evidence.json');
    const post = platePostconditions({ report: read('report.json'), after: read('state-after.json'), plan: plan(), params: ev.params, faces: ev.faces });
    expect(post.verdict).toBe('incomplete');
    expect(post.problems).toEqual([]);
    expect(post.notChecked).toEqual(['position (centring): not measurable with the approved read operations; only the requested centred lines were checked']);
    const d = check();
    expect(d.definition_centered).toBe('pass');
    expect(d.solid_position_measured).toBe(false);
  });
});
