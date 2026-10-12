import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGraph, parseSnapshot, loadEvidence, validateEvidence } from '../src/adapter';
import { diffSnapshots, sameAsBaseline } from '../src/snapshot';
import { InspectorError } from '../src/inspector';

const FIX = path.join(import.meta.dirname, 'fixtures', 'inspector');
const ev = loadEvidence();
function snap(label: string) {
  const dir = path.join(FIX, label);
  const graph = parseGraph(fs.readFileSync(path.join(dir, 'graph-full.dot'), 'utf8'));
  const objects = new Map<number, string>();
  for (const f of fs.readdirSync(path.join(dir, 'objects')))
    objects.set(Number(f.replace('.json', '')), fs.readFileSync(path.join(dir, 'objects', f), 'utf8'));
  return parseSnapshot(graph, objects, ev);
}
const ofClass = (s: ReturnType<typeof snap>, cls: string) => [...s.objects.values()].filter((o) => o.cls === cls);
const PROJ = '0 [label="ivy::Project", shape=box];';
const feat = (uuid: string, id = 1) => `{"uuid":"${uuid}","class_name":"ivy::FeatPart","attr_first_":{"_id":${id},"_name":"p"}}`;

describe('adapter on real Task 0 captures', () => {
  it('02-after-extrude has exactly one sketch and one extrude (Q3)', () => {
    const s = snap('02-after-extrude');
    expect(ofClass(s, 'ivy::FeatSketch')).toHaveLength(1);
    expect(ofClass(s, 'ivy::SolidExtrude')).toHaveLength(1);
  });
  it('extrude transitively depends on the sketch (Q4)', () => {
    const s = snap('02-after-extrude');
    const [sk] = ofClass(s, 'ivy::FeatSketch');
    const [ex] = ofClass(s, 'ivy::SolidExtrude');
    expect(ex.deps).toContain(sk.key);
  });
  it('01 -> 02: extrude added, no pre-existing feature removed or changed (Q7 fingerprint ignores _featOptions)', () => {
    const d = diffSnapshots(snap('01-after-sketch'), snap('02-after-extrude'), ev.volatileClasses);
    expect(d.added.map((o) => o.cls)).toContain('ivy::SolidExtrude');
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });
  it('reopen keeps every feature by uuid and fingerprint (Q9)', () => {
    expect(sameAsBaseline(snap('06-after-undo'), snap('07-after-reopen'), ev.volatileClasses)).toBe(true);
  });
  it('delete extrude restores the sketch-only structure (Q8; structure only, recovery stays disabled)', () => {
    expect(sameAsBaseline(snap('01-after-sketch'), snap('04-after-delete-extrude'), ev.volatileClasses)).toBe(true);
  });
  it('documents the Q6 blind spot: a 100->120 sketch edit is structurally invisible', () => {
    expect(sameAsBaseline(snap('02-after-extrude'), snap('03-after-edit-sketch'), ev.volatileClasses)).toBe(true);
  });
  it('unsupported fields stay undefined (Q5, Q6)', () => {
    for (const o of snap('02-after-extrude').objects.values()) {
      expect(o.statusOk).toBeUndefined();
      expect(o.dims).toBeUndefined();
    }
  });
  it('fails closed on a non-JSON reply for a model object (Q1)', () => {
    const graph = parseGraph(`digraph G {\n${PROJ}\n  "7" [label="ivy::FeatSketch 7"];\n}`);
    expect(() => parseSnapshot(graph, new Map([[7, 'Object not found.']]), ev)).toThrow(InspectorError);
    expect(() => parseSnapshot(graph, new Map(), ev)).toThrow(InspectorError);
  });
  it('skips excluded classes even when they reply "Object not found." (Q1)', () => {
    const graph = parseGraph(`digraph G {\n${PROJ}\n  "99" [label="ivy::PipelineContext 99"];\n  "5" [label="ivy::FeatPart 5"];\n}`);
    const objs = new Map<number, string>([[0, ''], [99, 'Object not found.'], [5, feat('u1')]]);
    expect(parseSnapshot(graph, objs, ev).objects.size).toBe(1);
  });
  it('throws on an empty graph (no Project root, no features)', () => {
    expect(() => parseSnapshot(parseGraph(''), new Map(), ev)).toThrow(InspectorError);
  });
  it('throws when the graph has only excluded nodes (no features)', () => {
    const graph = parseGraph(`digraph G {\n${PROJ}\n  "99" [label="ivy::PipelineContext 99"];\n}`);
    expect(() => parseSnapshot(graph, new Map([[0, ''], [99, 'Object not found.']]), ev)).toThrow(/no feature objects/);
  });
  it('throws when the graph has no ivy::Project root', () => {
    const graph = parseGraph('digraph G {\n  "5" [label="ivy::FeatPart 5"];\n}');
    expect(() => parseSnapshot(graph, new Map([[5, feat('u1')]]), ev)).toThrow(/no ivy::Project root node/);
  });
  it('throws on a duplicate uuid instead of silently dropping one', () => {
    const graph = parseGraph(`digraph G {\n${PROJ}\n  "5" [label="ivy::FeatPart 5"];\n  "6" [label="ivy::FeatPart 6"];\n}`);
    expect(() => parseSnapshot(graph, new Map([[0, ''], [5, feat('u1')], [6, feat('u1', 2)]]), ev)).toThrow(/duplicate uuid u1/);
  });
  it('a dependency cycle does not list a feature as its own dependency', () => {
    const graph = parseGraph(`digraph G {\n${PROJ}\n  "5" [label="ivy::FeatPart 5"];\n  "6" [label="ivy::FeatPart 6"];\n  "5" -> "6" [label="DependsOn"];\n  "6" -> "5" [label="DependsOn"];\n  "6" -> "6" [label="DependsOn"];\n}`);
    const objs = new Map<number, string>([[0, ''], [5, feat('u5', 1)], [6, feat('u6', 2)]]);
    const s = parseSnapshot(graph, objs, ev);
    expect(s.objects.get('u5')!.deps).toEqual(['u6']);
    expect(s.objects.get('u6')!.deps).toEqual(['u5']);
  });
  it('validateEvidence accepts the real evidence.json', () => {
    expect(() => validateEvidence(structuredClone(loadEvidence()))).not.toThrow();
  });
  it('validateEvidence rejects a missing supported key', () => {
    const bad = structuredClone(loadEvidence()) as any;
    delete bad.supported.dimension;
    expect(() => validateEvidence(bad)).toThrow(/invalid evidence\.json/);
  });
});
