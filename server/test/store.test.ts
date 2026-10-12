import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { RunStore, runVerdict, listRuns } from '../src/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')); });

describe('RunStore', () => {
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
