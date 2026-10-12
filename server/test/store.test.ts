import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { RunStore, runVerdict, listRuns } from '../src/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')); });
afterEach(() => { vi.useRealTimers(); });

describe('RunStore', () => {
  it('two creates in the same millisecond get distinct runs', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 12, 13, 14, 15, 123));
    const a = RunStore.create(dir, 'first');
    const b = RunStore.create(dir, 'second');
    expect(a.id).not.toBe(b.id);
    expect(a.dir).not.toBe(b.dir);
    for (const s of [a, b]) {
      const starts = s.readEvents().filter((e) => e.type === 'run_start');
      expect(starts).toHaveLength(1);
    }
    expect(a.readEvents()[0].prompt).toBe('first');
    expect(b.readEvents()[0].prompt).toBe('second');
  });
  it('tight loop of creates never merges runs', () => {
    const runs = Array.from({ length: 20 }, (_, i) => RunStore.create(dir, `p${i}`));
    expect(new Set(runs.map((r) => r.id)).size).toBe(20);
    runs.forEach((r, i) => {
      const starts = r.readEvents().filter((e) => e.type === 'run_start');
      expect(starts.map((e) => e.prompt)).toEqual([`p${i}`]);
    });
  });
  it('readEvents skips null, numbers and torn lines in the middle', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('phase', { phase: 'executing' });
    const f = path.join(s.dir, 'events.jsonl');
    fs.appendFileSync(f, 'null\n42\n{"t":"x","type":"half\n');
    s.append('run_end', { verdict: 'passed' });
    expect(s.readEvents().map((e) => e.type)).toEqual(['run_start', 'phase', 'run_end']);
    expect(runVerdict(s.readEvents())).toBe('passed');
  });

  it('appends events and reads them back', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('phase', { phase: 'designing' });
    expect(s.readEvents().map((e) => e.type)).toEqual(['run_start', 'phase']);
  });
  it('run with no run_end is interrupted (process killed)', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('phase', { phase: 'executing' });
    fs.appendFileSync(path.join(s.dir, 'events.jsonl'), '{"t":"x","type":"half');  // torn last line
    expect(runVerdict(s.readEvents())).toBe('interrupted');
  });
  it('verdict comes from run_end', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('run_end', { verdict: 'cancelled' });
    expect(runVerdict(s.readEvents())).toBe('cancelled');
  });
  it('writeAtomic leaves no tmp file', () => {
    const s = RunStore.create(dir, 'p');
    s.writeAtomic('report.html', '<p>x</p>');
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(s.dir, 'report.html'), 'utf8')).toBe('<p>x</p>');
  });
  it('open rejects path traversal', () => {
    expect(() => RunStore.open(dir, '../etc')).toThrow();
  });
  it('listRuns newest first with verdicts', async () => {
    const a = RunStore.create(dir, 'first'); a.append('run_end', { verdict: 'failed' });
    await new Promise((r) => setTimeout(r, 5));
    RunStore.create(dir, 'second');
    expect(listRuns(dir).map((r) => [r.prompt, r.verdict])).toEqual([['second', 'interrupted'], ['first', 'failed']]);
  });
});
