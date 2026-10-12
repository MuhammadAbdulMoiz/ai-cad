import fs from 'node:fs';
import path from 'node:path';

export type Verdict = 'passed' | 'failed' | 'cancelled' | 'interrupted';
export type RunEvent = { t: string; type: string; [k: string]: unknown };
const ID = /^[\w-]+$/;

export class RunStore {
  private constructor(readonly id: string, readonly dir: string) {}

  static create(runsDir: string, prompt: string): RunStore {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
    const s = new RunStore(id, path.join(runsDir, id));
    fs.mkdirSync(s.dir, { recursive: true });
    s.append('run_start', { prompt });
    return s;
  }
  static open(runsDir: string, id: string): RunStore {
    if (!ID.test(id)) throw new Error(`bad run id: ${id}`);
    const dir = path.join(runsDir, id);
    if (!fs.existsSync(dir)) throw new Error(`no such run: ${id}`);
    return new RunStore(id, dir);
  }
  append(type: string, data: Record<string, unknown> = {}): RunEvent {
    const ev = { t: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    return ev;
  }
  writeAtomic(name: string, content: string): void {
    const f = path.join(this.dir, name);
    fs.writeFileSync(f + '.tmp', content);
    fs.renameSync(f + '.tmp', f);
  }
  writeJson(name: string, value: unknown): void { this.writeAtomic(name, JSON.stringify(value, null, 2)); }
  readEvents(): RunEvent[] {
    const f = path.join(this.dir, 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  }
  shotPath(name: string): string {
    const d = path.join(this.dir, 'shots');
    fs.mkdirSync(d, { recursive: true });
    return path.join(d, `${name}.png`);
  }
}

export function runVerdict(events: RunEvent[]): Verdict {
  const end = events.filter((e) => e.type === 'run_end').at(-1);  // findLast needs lib es2023
  return (end?.verdict as Verdict) ?? 'interrupted';
}

export function listRuns(runsDir: string) {
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((id) => ID.test(id)).sort().reverse().map((id) => {
    const ev = RunStore.open(runsDir, id).readEvents();
    return { id, prompt: String(ev[0]?.prompt ?? ''), verdict: runVerdict(ev) };
  });
}
