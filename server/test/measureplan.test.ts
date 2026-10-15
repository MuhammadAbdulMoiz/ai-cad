// Regression: in a project with two documents the replay took the first FeatPart of the whole project, which can be
// the other document's (live, 2026-10-13: Part(1) #536 tip 9 before plate1's #553 tip 43). planFaceMeasure reads the
// tip and the feature from the target document's own subtree only.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentSubtree } from '../src/liveports';
import { planFaceMeasure } from '../src/measureplan';
import type { StateSnap } from '../src/replaycheck';

// Project 37649921 read by the doc37660560 probe: plate1 = PartReference 575 (tip 43_558, Extrude1 = 43),
// Part(1) = PartReference 579 (tip 9_593, no extrude).
const full = (): StateSnap => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'inspector', 'probe-two-docs', 'state.json'), 'utf8'));
/** The document's state as a rootEntityId read returns it (its Contain subtree; undo stays the project's). */
function rooted(root: number): StateSnap {
  const s = full(), sub = documentSubtree(s.edges, String(root));
  const keep = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([h]) => sub.has(h)));
  return { undo: s.undo, classes: keep(s.classes), objects: keep(s.objects), edges: s.edges.filter((e) => sub.has(/^"(\d+)"/.exec(e)![1])) };
}
const PLATE1 = { docId: 575, workshopId: 1 }, OTHER = { docId: 579, workshopId: 2 };

describe('planFaceMeasure: tip and feature from the target document only', () => {
  it('selects plate1\'s own tip 43 and its Extrude1, not the other document\'s tip 9', () => {
    const p = planFaceMeasure(rooted(575), PLATE1, 43, 0);
    expect(p).toEqual({
      docId: 575, tipFeatureId: 43, tipHandle: '558', featureId: 43, featureHandle: '558', faceId: 0,
      op: { kind: 'measure_face', docId: 575, workshopId: 1, tipFeatureId: 43, featureId: 43, faceId: 0 },
    });
    expect(rooted(579).classes['593']).toBeDefined(); // the other document's tip object exists, with id 9
  });
  it('refuses feature 43 in the other document (whose tip is 9)', () => {
    expect(() => planFaceMeasure(rooted(579), OTHER, 43, 0)).toThrow('measurement refused: document 579 has 0 ivy::SolidExtrude with id 43');
  });
  it('refuses a target that is not the root of the state read (mismatched document)', () => {
    expect(() => planFaceMeasure(rooted(575), OTHER, 43, 0)).toThrow('measurement refused: document 579 is not the root of the state read (absent)');
    expect(() => planFaceMeasure(rooted(579), PLATE1, 43, 0)).toThrow('measurement refused: document 575 is not the root of the state read (absent)');
  });
  it('refuses the whole project (two FeatParts: ambiguous), which is where the old rule took the first one', () => {
    expect(() => planFaceMeasure(full(), PLATE1, 43, 0)).toThrow('measurement refused: document 575: expected one ivy::FeatPart with its object, found 2');
  });
  it('refuses a tip that does not resolve to an object of the document', () => {
    const s = rooted(575);
    const part = Object.keys(s.classes).find((h) => s.classes[h] === 'ivy::FeatPart')!;
    s.objects[part] = s.objects[part].replace('"_vValue:[43_558]"', '"_vValue:[9_593]"'); // the other document's tip
    expect(() => planFaceMeasure(s, PLATE1, 43, 0)).toThrow('measurement refused: the tip 9_593 is not an object of document 575 carrying feature 9');
  });
  it('refuses a document with no readable tip, and two extrudes carrying the id', () => {
    const s = rooted(575);
    const part = Object.keys(s.classes).find((h) => s.classes[h] === 'ivy::FeatPart')!;
    const noTip = structuredClone(s); noTip.objects[part] = noTip.objects[part].replace('"_vValue:[43_558]"', '""');
    expect(() => planFaceMeasure(noTip, PLATE1, 43, 0)).toThrow('measurement refused: document 575 has no readable tip');
    const twice = structuredClone(s); twice.classes['9100'] = 'ivy::SolidExtrude'; twice.objects['9100'] = twice.objects['558'];
    expect(() => planFaceMeasure(twice, PLATE1, 43, 0)).toThrow('measurement refused: document 575 has 2 ivy::SolidExtrude with id 43');
  });
});
