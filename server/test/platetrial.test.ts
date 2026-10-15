import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/liveports';
import { faceSides, FIRST_PLATE, preparePlate, SKETCH_CONTENT_FIELDS, sketchContentsFrom, writeGate, type SketchContents } from '../src/platetrial';
import { decodeCapture, loadSchema } from '../src/wsframes';
import { rectLines } from '../src/writeport';

const FIX = path.join(import.meta.dirname, 'fixtures', 'inspector');
const read = (...p: string[]) => fs.readFileSync(path.join(FIX, ...p), 'utf8');
// The live, empty, single-document part read by the isolation probe (project 37660626, document 530).
const empty = () => JSON.parse(read('empty-part-single-doc', 'state-document.json'));
const emptyClasses = () => parseGraph(read('empty-part-single-doc', 'graph-full.dot')).classes;

describe('preparePlate: preconditions and a plan from the document\'s own ids', () => {
  it('derives the plan from the live empty part: its tip and its "XY Plane", the centred 100 × 60 rectangle, depth 8', () => {
    expect(preparePlate(empty(), emptyClasses())).toEqual({
      problems: [],
      plan: { tipFeatureId: 9, planeFeatureId: 3, sketchName: 'Sketch1', extrudeName: 'Extrude1', lines: rectLines(-50, -30, 100, 60), width: 100, height: 60, depth: 8 },
    });
    expect(FIRST_PLATE).toMatchObject({ width: 100, height: 60, depth: 8 });
  });
  it('refuses a project with a second document', () => {
    const two = JSON.parse(read('probe-two-docs', 'state.json'));
    expect(preparePlate(empty(), two.classes).problems).toEqual(['the project has 2 documents, the first trial needs exactly one']);
  });
  it('refuses redo history', () => {
    const s = empty(); const u = JSON.parse(s.undo); u.can_redo_step = 1; s.undo = JSON.stringify(u);
    expect(preparePlate(s, emptyClasses()).problems).toEqual(['the project has 1 redo entries']);
  });
  it('refuses a document that already has sketches or an extrude, or uses the names', () => {
    const s = empty();
    s.classes['9001'] = 'ivy::FeatSketch'; s.objects['9001'] = JSON.stringify({ class_name: 'ivy::FeatSketch', attr_first_: { _id: 99, _name: 'Sketch1' } });
    expect(preparePlate(s, emptyClasses()).problems).toEqual(['the document already has 1 ivy::FeatSketch', 'the name Sketch1 is already used']);
  });
  it('refuses without exactly one "XY Plane"', () => {
    const s = empty();
    for (const h of Object.keys(s.objects)) s.objects[h] = s.objects[h].replace('"XY Plane"', '"Plane"');
    expect(preparePlate(s, emptyClasses()).problems).toEqual(['expected one origin plane named "XY Plane", found 0']);
  });
  it('refuses a malformed document state', () => {
    const s = empty(); delete s.edges;
    expect(preparePlate(s, emptyClasses()).problems).toEqual(['document state: edges are missing or not text']);
  });
});

describe('faceSides: a rectangle from a measured perimeter and area (SI in, mm out)', () => {
  const round = (x?: [number, number]) => x?.map((v) => Math.round(v * 1e6) / 1e6);
  it.each([
    ['the captured top face of plate1 (face 4)', 0.32, 0.006, [100, 60]],
    ['a 100 × 8 side', 0.216, 0.0008, [100, 8]],
    ['a 100 × 10 side', 0.22, 0.001, [100, 10]],
    ['a 60 × 8 side', 0.136, 0.00048, [60, 8]],
  ])('%s', (_n, p, a, want) => expect(round(faceSides(p, a))).toEqual(want));
  it('no rectangle fits impossible values', () => {
    expect(faceSides(0.1, 0.01)).toBeUndefined();
    expect(faceSides(0, 0.001)).toBeUndefined();
  });
});

describe('writeGate: the only way the trial script may arm its sender', () => {
  const all = { flag: true, preflightPassed: true, attestation: 'only I have it open', typed: 'write' };
  it('passes only with every condition', () => expect(writeGate(all)).toEqual([]));
  it.each([
    ['no --write', { flag: false }, 'sending is disabled: run with --write to ask for it'],
    ['a failed preflight', { preflightPassed: false }, 'the preflight did not pass'],
    ['no attestation', { attestation: undefined }, 'no exclusivity attestation (--attest "<statement>")'],
    ['a blank attestation', { attestation: '  ' }, 'no exclusivity attestation (--attest "<statement>")'],
    ['anything but "write" typed', { typed: 'yes' }, 'the user did not type "write"'],
  ])('refuses %s', (_n, change, why) => expect(writeGate({ ...all, ...change })).toEqual([why]));
});

const ivyRepo = process.env.IVY_REPO || 'C:/zixel/ivyproject';
const proto = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto'));
const W = (run: string, f: string) => path.join(import.meta.dirname, 'fixtures', run, f);
const decodedFrom = (run: string, f: string, upTo = Infinity) => decodeCapture(fs.readFileSync(W(run, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.i <= upTo), loadSchema(ivyRepo));
const zero = () => Object.fromEntries(SKETCH_CONTENT_FIELDS.map((k) => [k, 0]));
const DOC1 = 521, DOC2 = 527; // write1's and write2's document handles

describe.skipIf(!proto)('sketchContentsFrom: only fresh, decoded evidence for the bound document', () => {
  it('write1 notification 99 (records 96–99): Sketch1 (12) has every content list empty', () => {
    expect(sketchContentsFrom(decodedFrom('write1', 'step1-window.jsonl', 99), DOC1).get(12)).toEqual({ counts: zero(), at: 99 });
  });
  it('the same evidence is stale once any later non-read-only message arrives (write1 record 102, a VCS change)', () => {
    expect(sketchContentsFrom(decodedFrom('write1', 'step1-window.jsonl'), DOC1).get(12)?.problem).toBe('stale: IVY_PROJECT_VCS_CHANGE_NTF at 102 came after the data notification at 99');
  });
  it('notifications for another document count for nothing', () => {
    expect(sketchContentsFrom(decodedFrom('write1', 'step1-window.jsonl', 99), 999).size).toBe(0);
  });
  it('write2 notification 292: Sketch2 (15) has 4 geoms and 8 constraints; a later page ping does not make it stale', () => {
    const c = sketchContentsFrom(decodedFrom('write2', 'data-ntf-window.jsonl'), DOC2);
    expect(c.get(15)).toEqual({ counts: { ...zero(), geoms: 4, constraints: 8 }, at: 292 });
    expect(c.get(12)).toEqual({ counts: zero(), at: 292 });
  });
  it('ignores sent messages and undecoded notifications', () => {
    const d = decodedFrom('write2', 'data-ntf-window.jsonl');
    expect(sketchContentsFrom(d.filter((x: any) => x.kind === 'message' && x.dir === 'sent'), DOC2).size).toBe(0);
    expect(sketchContentsFrom(d.map((x: any) => (x.kind === 'message' ? { ...x, status: 'undecoded' } : x)), DOC2).size).toBe(0);
  });
  const with99 = (f: (sk: any) => void) => {
    const d = structuredClone(decodedFrom('write1', 'step1-window.jsonl', 99));
    for (const x of d as any[]) for (const m of x.pkg?.appModelNtf?.modelDescs ?? []) for (const ft of m.modelPkgDecoded?.dataNtf?.features ?? []) if (Number(ft.featureId) === 12) f(ft.sketchFeature);
    return d;
  };
  it('a present but malformed content field is refused, never read as zero', () => {
    expect(sketchContentsFrom(with99((sk) => { sk.geoms = {}; }), DOC1).get(12)?.problem).toBe('malformed geoms in the data notification at 99');
    expect(sketchContentsFrom(with99((sk) => { sk.constraints = 'x'; sk.blocks = 3; }), DOC1).get(12)?.problem).toBe('malformed constraints, blocks in the data notification at 99');
  });
  it('counts every content list, not only geoms and constraints', () => {
    expect(sketchContentsFrom(with99((sk) => { sk.patterns = [{}]; sk.externalGeoms = [{}, {}]; }), DOC1).get(12)?.counts).toEqual({ ...zero(), patterns: 1, externalGeoms: 2 });
  });
  it.each([
    ['an undecodable message', { kind: 'message', dir: 'received', status: 'undecoded', frames: [200] }, 'stale: an undecodable message at 200 came after the data notification at 99'],
    ['a sent write request', { kind: 'message', dir: 'sent', status: 'decoded', cmd: 'IVY_APP_MODEL_REQ', frames: [200] }, 'stale: IVY_APP_MODEL_REQ at 200 came after the data notification at 99'],
    ['a text frame that is not the ping', { kind: 'text', dir: 'received', text: '{"event":"close"}', frames: [200] }, 'stale: text at 200 came after the data notification at 99'],
    ['a malformed mesh frame', { kind: 'mesh', dir: 'received', ok: false, frames: [200] }, 'stale: mesh at 200 came after the data notification at 99'],
  ])('is stale after %s', (_n, later, why) => {
    expect(sketchContentsFrom([...decodedFrom('write1', 'step1-window.jsonl', 99), later], DOC1).get(12)?.problem).toBe(why);
  });
  it('stays fresh after read-only traffic: a query, its reply, a well-formed mesh, the ping', () => {
    const later = [
      { kind: 'message', dir: 'sent', status: 'decoded', cmd: 'IVY_QUERY_REQ', frames: [200] }, { kind: 'message', dir: 'received', status: 'decoded', cmd: 'IVY_QUERY_RSP', frames: [201] },
      { kind: 'mesh', dir: 'received', ok: true, frames: [202] }, { kind: 'text', dir: 'sent', text: '{"requestId":"1","command":"ping","body":{}}', frames: [203] },
    ];
    expect(sketchContentsFrom([...decodedFrom('write1', 'step1-window.jsonl', 99), ...later], DOC1).get(12)).toEqual({ counts: zero(), at: 99 });
  });
});

describe.skipIf(!proto)('preparePlate with an existing sketch: emptiness needs fresh positive evidence', () => {
  const write1After = () => JSON.parse(fs.readFileSync(W('write1', 'state-after.json'), 'utf8')); // Sketch1 (12) is the tip
  const write2After = () => JSON.parse(fs.readFileSync(W('write2', 'state-after-sketchDraw.json'), 'utf8')); // Sketch1 (12), Sketch2 (15) drawn
  const spec2 = { ...FIRST_PLATE, sketchName: 'Sketch2', existingSketches: ['Sketch1'] };
  const fresh12 = () => sketchContentsFrom(decodedFrom('write1', 'step1-window.jsonl', 99), DOC1);
  const NO_EVIDENCE = 'the existing sketch Sketch1 (feature 12) cannot be shown to be empty: the inspector reports sketch geometry only as opaque runtime state, and no document data for it was recorded in this session';
  it('accepts an existing sketch with fresh evidence that every content list is empty, and plans after it', () => {
    const s = write1After();
    expect(preparePlate(s, s.classes, spec2, { sketchContents: fresh12() })).toEqual({
      problems: [],
      plan: { tipFeatureId: 12, planeFeatureId: 3, sketchName: 'Sketch2', extrudeName: 'Extrude1', lines: rectLines(-50, -30, 100, 60), width: 100, height: 60, depth: 8 },
    });
  });
  it('refuses without evidence (the live case at page load), or with evidence only for another feature', () => {
    const s = write1After();
    expect(preparePlate(s, s.classes, spec2).problems).toEqual([NO_EVIDENCE]);
    expect(preparePlate(s, s.classes, spec2, { sketchContents: new Map([[99, { counts: zero(), at: 1 }]]) }).problems).toEqual([NO_EVIDENCE]);
  });
  it('refuses stale evidence', () => {
    const s = write1After();
    expect(preparePlate(s, s.classes, spec2, { sketchContents: sketchContentsFrom(decodedFrom('write1', 'step1-window.jsonl'), DOC1) }).problems)
      .toEqual(['the existing sketch Sketch1 (feature 12) cannot be shown to be empty: stale: IVY_PROJECT_VCS_CHANGE_NTF at 102 came after the data notification at 99']);
  });
  it('refuses a sketch with geometry but no dimension (real write2 Sketch2 after sketchDraw)', () => {
    const s = write2After();
    expect(Object.values(s.classes).filter((x) => x === 'ivy::SketchLengthDimension')).toHaveLength(0); // the old proxy would have passed it
    expect(preparePlate(s, s.classes, { ...FIRST_PLATE, sketchName: 'Sketch3', existingSketches: ['Sketch1', 'Sketch2'] }, { sketchContents: sketchContentsFrom(decodedFrom('write2', 'data-ntf-window.jsonl'), DOC2) }).problems)
      .toEqual(['the existing sketch Sketch2 (feature 15) is not empty: 4 geoms, 8 constraints (data notification at 292)']);
  });
  it('refuses a sketch with constraints only, or any other content', () => {
    const s = write1After();
    const c = (counts: Record<string, number>): SketchContents => new Map([[12, { counts: { ...zero(), ...counts }, at: 7 }]]);
    expect(preparePlate(s, s.classes, spec2, { sketchContents: c({ constraints: 3 }) }).problems).toEqual(['the existing sketch Sketch1 (feature 12) is not empty: 3 constraints (data notification at 7)']);
    expect(preparePlate(s, s.classes, spec2, { sketchContents: c({ blocks: 1 }) }).problems).toEqual(['the existing sketch Sketch1 (feature 12) is not empty: 1 blocks (data notification at 7)']);
  });
  it('refuses incomplete or malformed evidence', () => {
    const s = write1After();
    const partial: SketchContents = new Map([[12, { counts: { geoms: 0, constraints: 0 }, at: 7 }]]);
    expect(preparePlate(s, s.classes, spec2, { sketchContents: partial }).problems).toEqual(['the existing sketch Sketch1 (feature 12) cannot be shown to be empty: incomplete evidence']);
    const bad: SketchContents = new Map([[12, { counts: zero(), at: 7, problem: 'malformed geoms in the data notification at 7' }]]);
    expect(preparePlate(s, s.classes, spec2, { sketchContents: bad }).problems).toEqual(['the existing sketch Sketch1 (feature 12) cannot be shown to be empty: malformed geoms in the data notification at 7']);
  });
  it('still refuses an unnamed existing sketch, a reused name, a length dimension, and an extrude', () => {
    const s = write1After();
    expect(preparePlate(s, s.classes, { ...FIRST_PLATE, sketchName: 'Sketch2' }, { sketchContents: fresh12() }).problems).toEqual(['the document already has 1 ivy::FeatSketch']);
    expect(preparePlate(s, s.classes, { ...spec2, sketchName: 'Sketch1' }, { sketchContents: fresh12() }).problems).toEqual(['the name Sketch1 is already used']);
    const dim = write1After();
    dim.classes['9100'] = 'ivy::SketchLengthDimension'; dim.objects['9100'] = JSON.stringify({ class_name: 'ivy::SketchLengthDimension', attr_first_: { _id: 99, _name: 'd' } });
    expect(preparePlate(dim, dim.classes, spec2, { sketchContents: fresh12() }).problems).toEqual(['the document has 1 sketch length dimensions, so an existing sketch is not empty']);
    const ext = write1After();
    ext.classes['9101'] = 'ivy::SolidExtrude'; ext.objects['9101'] = JSON.stringify({ class_name: 'ivy::SolidExtrude', attr_first_: { _id: 98, _name: 'E' } });
    expect(preparePlate(ext, ext.classes, spec2, { sketchContents: fresh12() }).problems).toEqual(['the document already has 1 ivy::SolidExtrude']);
  });
});
