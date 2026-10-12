import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGraph, parseSnapshot, loadEvidence } from '../src/adapter';
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
    const graph = parseGraph('digraph G {\n  "7" [label="ivy::FeatSketch 7"];\n}');
    expect(() => parseSnapshot(graph, new Map([[7, 'Object not found.']]), ev)).toThrow(InspectorError);
    expect(() => parseSnapshot(graph, new Map(), ev)).toThrow(InspectorError);
  });
  it('skips excluded classes even when they reply "Object not found." (Q1)', () => {
    const graph = parseGraph('digraph G {\n0 [label="ivy::Project", shape=box];\n  "99" [label="ivy::PipelineContext 99"];\n}');
    expect(parseSnapshot(graph, new Map([[0, ''], [99, 'Object not found.']]), ev).objects.size).toBe(0);
  });
});
