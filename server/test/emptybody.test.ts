// The first live write (runs/plate-trial-write1, 2026-10-14) created Sketch1 = feature 12 on an EMPTY part whose tip
// was the solid set (9). Ivy reported the new sketch with previousFeatureId -1, which the step-1 rule (built from
// plate1, where the new sketch followed an existing one) rejected. These tests use that run's real records and states.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEmptyBodyTip, notificationProblems, tipOf, type Identity } from '../src/livewriteguard';
import type { StateSnap } from '../src/replaycheck';
import { classifyStepTraffic } from '../src/writeseq';
import { decodeCapture, loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto'));
const FIX = path.join(import.meta.dirname, 'fixtures', 'write1');
const state = (f: string): StateSnap => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const bound: Identity = { projectId: 37660626, projectTag: 'main', workshopId: 1, docId: 521, modelSocket: '51360.4750', sessionId: '268435457' };
const WIRE = '193457812480010528'; // our sketchCreate (record 96)

describe('isEmptyBodyTip: the planned tip is the document\'s body and it contains nothing', () => {
  it('holds for the write1 before-state: tip 9 is the solid set #536 with no children', () => {
    const s = state('state-before.json');
    expect(tipOf(s)).toEqual({ id: 9, handle: '536' });
    expect(isEmptyBodyTip(s, 9)).toBe(true);
  });
  it('does not hold for another planned tip', () => {
    expect(isEmptyBodyTip(state('state-before.json'), 5)).toBe(false);
    expect(isEmptyBodyTip(state('state-before.json'), 12)).toBe(false);
  });
  it('does not hold once the body contains a feature (the write1 after-state: Sketch1 #539 inside #536)', () => {
    const after = state('state-after.json');
    expect(isEmptyBodyTip(after, 12)).toBe(false); // the tip is the sketch, not the body
    expect(isEmptyBodyTip(after, 9)).toBe(false); // the body is no longer the tip
  });
  it('does not hold for a non-empty body that is still named as the tip', () => {
    const s = state('state-before.json');
    s.classes['9999'] = 'ivy::FeatSketch'; s.objects['9999'] = JSON.stringify({ class_name: 'ivy::FeatSketch', attr_first_: { _id: 99, _name: 'X' } });
    s.edges.push('"536" -> "9999" [label="Contain", color="#87CEEB"];');
    expect(isEmptyBodyTip(s, 9)).toBe(false);
  });
  it('does not hold when the tip object is not a solid set, or an edge cannot be read', () => {
    const notBody = state('state-before.json'); notBody.classes['536'] = 'ivy::FeatSketch';
    expect(isEmptyBodyTip(notBody, 9)).toBe(false);
    const garbled = state('state-before.json'); garbled.edges.push('garbage');
    expect(isEmptyBodyTip(garbled, 9)).toBe(false);
  });
  it('does not hold for plate1, whose body already held sketches', () => {
    const dir = path.join(import.meta.dirname, 'fixtures', 'inspector', 'plate1-sketch');
    const dot = fs.readFileSync(path.join(dir, 'graph-full.dot'), 'utf8');
    const classes: Record<string, string> = {};
    for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"\s]+)/gm)) classes[m[1]] = m[2];
    const objects: Record<string, string> = {};
    for (const h of Object.keys(classes)) { const f = path.join(dir, 'objects', `${h}.json`); if (fs.existsSync(f)) objects[h] = fs.readFileSync(f, 'utf8'); }
    const s: StateSnap = { undo: '{}', classes, objects, edges: [...dot.matchAll(/^\s*"\d+" -> "\d+".*$/gm)].map((m) => m[0].trim()) };
    const tip = tipOf(s)!;
    expect(isEmptyBodyTip(s, tip.id)).toBe(false);
  });
});

describe.skipIf(!ready)('step-1 notifications of the first live write (records 97–99, 102)', () => {
  const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
  const recs = fs.readFileSync(path.join(FIX, 'step1-window.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const traffic = () => {
    const decoded = decodeCapture(recs, schema).filter((d: any) => !(d.kind === 'message' && d.dir === 'sent' && d.asyncId === WIRE));
    return classifyStepTraffic(decoded, WIRE, new Map(), bound.docId);
  };
  it('the window is what the guard saw: one reply, two model notifications, nothing unexpected', () => {
    const t = traffic();
    expect(t.unexpected).toEqual([]);
    expect(t.reply?.appModelRsp?.modelPkgDecoded?.header).toMatchObject({ cmd: 'IVY_PART_SKETCH_UPDATE_RSP', featureId: '12', featureType: 'ivy::FeatSketch' });
    expect(t.ntfs).toHaveLength(2);
    const sketch = t.ntfs.flatMap((n: any) => n.appModelNtf.modelDescs.flatMap((m: any) => m.modelPkgDecoded?.dataNtf?.features ?? [])).find((f: any) => Number(f.featureId) === 12);
    expect(Number(sketch.previousFeatureId)).toBe(-1); // notification 99
  });
  it('is accepted when the before-state proved the planned tip is the empty body', () => {
    const t = traffic();
    const ids = { sketch: 12, created: 12, priorTip: 9, priorTipIsEmptyBody: isEmptyBodyTip(state('state-before.json'), 9) };
    expect(notificationProblems('sketchCreate', t.ntfs, t.reply, bound, ids, false)).toEqual([]);
  });
  it('is still rejected without that proof (exact-tip rule unchanged)', () => {
    const t = traffic();
    expect(notificationProblems('sketchCreate', t.ntfs, t.reply, bound, { sketch: 12, created: 12, priorTip: 9 }, false)).toEqual(['sketchCreate: the new sketch does not follow the planned tip 9']);
    expect(notificationProblems('sketchCreate', t.ntfs, t.reply, bound, { sketch: 12, created: 12, priorTip: 9, priorTipIsEmptyBody: false }, false)).toEqual(['sketchCreate: the new sketch does not follow the planned tip 9']);
  });
  it('the exception admits only -1: any other predecessor is still refused even for an empty body', () => {
    const t = traffic();
    const edited = structuredClone(t.ntfs);
    for (const n of edited) for (const m of n.appModelNtf.modelDescs) for (const f of m.modelPkgDecoded?.dataNtf?.features ?? []) if (Number(f.featureId) === 12) f.previousFeatureId = 7;
    expect(notificationProblems('sketchCreate', edited, t.reply, bound, { sketch: 12, created: 12, priorTip: 9, priorTipIsEmptyBody: true }, false)).toEqual(['sketchCreate: the new sketch does not follow the planned tip 9']);
  });
});
