// plate-trial-write2 (2026-10-14) stopped at step 2: after sketchDraw, Ivy had set the sketch's needs-update option
// bit (0000000000100011 → 0000000010100011), which the guard did not allow. The after-state below is the real one.
// The before-state (after sketchCreate, not saved by that run) is DERIVED from it using exactly the differences the
// guard's final check recorded (fixtures/write2/final.json): undo mark 4 added, Sketch2 #549 changed, visualisation
// objects #554/#555 replaced by #558/#559.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStateChange, NEEDS_UPDATE_BIT, needsUpdateTransition } from '../src/livewriteguard';
import type { StateSnap } from '../src/replaycheck';

const FIX = path.join(import.meta.dirname, 'fixtures', 'write2');
const after = (): StateSnap => JSON.parse(fs.readFileSync(path.join(FIX, 'state-after-sketchDraw.json'), 'utf8'));
const SKETCH = '549';
const setOptions = (s: StateSnap, h: string, o: string) => { const j = JSON.parse(s.objects[h]); j.attr_first_._featOptions = o; s.objects[h] = JSON.stringify(j); };

function before(): StateSnap {
  const s = after();
  const u = JSON.parse(s.undo);
  const marks = u.marks.filter((m: any) => m.mark_id !== 4).map((m: any, k: number, all: any[]) => ({ ...m, is_current: k === all.length - 1 }));
  s.undo = JSON.stringify({ ...u, marks, markNum: marks.length, can_undo_step: u.can_undo_step - 1, currentIndex: u.currentIndex - 1, currentMarkId: 3 });
  setOptions(s, SKETCH, '0000000000100011');
  const visu = s.objects['558'];
  for (const h of ['558', '559']) { delete s.classes[h]; delete s.objects[h]; }
  for (const h of ['554', '555']) { s.classes[h] = 'ivy::VisuGeomObject'; s.objects[h] = visu; }
  s.edges = s.edges.filter((e) => !/"530" -> "55[89]"/.test(e)).concat(['"530" -> "554" [label="Contain", color="#87CEEB"];', '"530" -> "555" [label="Contain", color="#87CEEB"];']);
  return s;
}
const ctx = { sketchHandle: SKETCH, newFeatureId: 15 };

describe('the needs-update bit after sketchDraw (real write2 state)', () => {
  it('the captured change is exactly bit 128, set', () => {
    const o = (s: StateSnap) => JSON.parse(s.objects[SKETCH]).attr_first_._featOptions;
    expect([o(before()), o(after())]).toEqual(['0000000000100011', '0000000010100011']);
    expect(parseInt(o(before()), 2) ^ parseInt(o(after()), 2)).toBe(NEEDS_UPDATE_BIT);
    expect(JSON.parse(after().undo).marks.at(-1)).toMatchObject({ mark_id: 4, source_cmd: '6|0|' });
  });
  it('is now accepted: no problem at all for the step write2 stopped on', () => {
    expect(checkStateChange('sketchDraw', before(), after(), ctx)).toEqual([]);
  });
  it('another bit changing as well is refused', () => {
    const a = after(); setOptions(a, SKETCH, '0000000010100111');
    expect(checkStateChange('sketchDraw', before(), a, ctx)).toEqual(['the sketch\'s options changed 0000000000100011 → 0000000010100111: only the needs-update bit (128) may change']);
  });
  it('a different single bit is refused', () => {
    const a = after(); setOptions(a, SKETCH, '0000000000110011');
    expect(checkStateChange('sketchDraw', before(), a, ctx)).toEqual(['the sketch\'s options changed 0000000000100011 → 0000000000110011: only the needs-update bit (128) may change', 'after sketchDraw the sketch\'s needs-update bit is clear (options 0000000000110011)']);
  });
  it('a solve-only step that leaves the bit clear is refused', () => {
    const a = after(); setOptions(a, SKETCH, '0000000000100011');
    expect(checkStateChange('sketchDraw', before(), a, ctx)).toEqual(['after sketchDraw the sketch\'s needs-update bit is clear (options 0000000000100011)']);
  });
  // The closing-step cases reuse sketchDraw's real undo mark, whose signature differs from a closing step's (the mark
  // check reports that separately), so only the option-flag problems are compared.
  const flags = (p: string[]) => p.filter((x) => /needs-update|options/.test(x));
  it('a closing step must clear it: setting it, or leaving it set, is refused', () => {
    expect(flags(checkStateChange('sketchClose', before(), after(), ctx))).toEqual(['sketchClose set the sketch\'s needs-update bit (0000000000100011 → 0000000010100011); it must clear it', 'after sketchClose the sketch\'s needs-update bit is set (options 0000000010100011)']);
    const set = after(); const b = before(); setOptions(b, SKETCH, '0000000010100011');
    expect(checkStateChange('sketchClose', b, set, ctx).filter((p) => /needs-update/.test(p))).toEqual(['after sketchClose the sketch\'s needs-update bit is set (options 0000000010100011)']);
  });
  it('a closing step that clears it is accepted (the transition plate1 shows after sketchClose and sketchFinish)', () => {
    const b = before(); setOptions(b, SKETCH, '0000000010100011');
    const a = after(); setOptions(a, SKETCH, '0000000000100011');
    expect(flags(checkStateChange('sketchClose', b, a, ctx))).toEqual([]);
    expect(flags(checkStateChange('sketchFinish', b, a, ctx))).toEqual([]);
  });
  it('the change is allowed only on our sketch', () => {
    expect(checkStateChange('sketchDraw', before(), after(), { ...ctx, sketchHandle: '544' }).some((p) => p.startsWith('unexpected change to ivy::FeatSketch #549'))).toBe(true);
  });
});

describe('needsUpdateTransition', () => {
  it.each([
    ['sketchDraw', '0000000000100011', '0000000010100011', null],
    ['widthAdd', '0000000000100011', '0000000010100011', null],
    ['heightAdd', '0000000000100011', '0000000010100011', null],
    ['sketchClose', '0000000010100011', '0000000000100011', null],
    ['sketchFinish', '0000000010100011', '0000000000100011', null],
    ['sketchDraw', '0000000010100011', '0000000000100011', 'sketchDraw cleared the sketch\'s needs-update bit (0000000010100011 → 0000000000100011); it must set it'],
    ['sketchFinish', '0000000000100011', '0000000010100011', 'sketchFinish set the sketch\'s needs-update bit (0000000000100011 → 0000000010100011); it must clear it'],
    ['sketchCreate', '0000000000100011', '0000000010100011', 'sketchCreate may not change the sketch\'s options'],
    ['extrudeCreate', '0000000000100011', '0000000010100011', 'extrudeCreate may not change the sketch\'s options'],
    ['sketchDraw', '0000000000100011', undefined, 'the sketch\'s options 0000000000100011 → undefined are not 16-bit flag strings'],
    ['sketchDraw', '100011', '10100011', 'the sketch\'s options 100011 → 10100011 are not 16-bit flag strings'],
    ['sketchDraw', '0000000000100011', '1000000010100011', 'the sketch\'s options changed 0000000000100011 → 1000000010100011: only the needs-update bit (128) may change'],
  ])('%s %s → %s', (step, b, a, want) => expect(needsUpdateTransition(step as any, b, a)).toBe(want));
});
