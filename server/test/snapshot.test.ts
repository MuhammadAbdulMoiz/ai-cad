import { describe, it, expect } from 'vitest';
import { diffSnapshots, sameAsBaseline, fingerprint, type ModelSnapshot, type SnapObject } from '../src/snapshot';

const snap = (...o: SnapObject[]): ModelSnapshot => ({ objects: new Map(o.map((x) => [x.key, x])) });
const o = (key: string, cls: string, hash: string): SnapObject => ({ key, handle: 0, cls, hash });

describe('fingerprint', () => {
  it('is stable for equal parts and differs otherwise', () => {
    expect(fingerprint(['ivy::FeatSketch', 12, '草图1'])).toBe(fingerprint(['ivy::FeatSketch', 12, '草图1']));
    expect(fingerprint(['ivy::FeatSketch', 12, '草图1'])).not.toBe(fingerprint(['ivy::FeatSketch', 12, '草图2']));
  });
});

describe('diffSnapshots', () => {
  const base = snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'));
  it('reports added objects', () => {
    const d = diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'), o('u-ex', 'Extrude', 'h3')), []);
    expect(d.added.map((x) => x.key)).toEqual(['u-ex']);
    expect(d.modified).toEqual([]); expect(d.removed).toEqual([]);
  });
  it('same key with a new handle is the same object (reopen)', () => {
    const moved = snap({ ...o('u-doc', 'Doc', 'h1'), handle: 900 }, { ...o('u-sk', 'Sketch', 'h2'), handle: 901 });
    expect(sameAsBaseline(base, moved, [])).toBe(true);
  });
  it('reports a structurally changed pre-existing object', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'CHANGED')), []).modified.map((x) => x.key)).toEqual(['u-sk']);
  });
  it('reports a removed pre-existing object', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1')), []).removed.map((x) => x.key)).toEqual(['u-sk']);
  });
  it('ignores volatile classes for modified/removed', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'CHANGED'), o('u-sk', 'Sketch', 'h2')), ['Doc']).modified).toEqual([]);
  });
  it('sameAsBaseline false when anything was added', () => {
    expect(sameAsBaseline(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'), o('u-x', 'X', 'h')), [])).toBe(false);
  });
});
