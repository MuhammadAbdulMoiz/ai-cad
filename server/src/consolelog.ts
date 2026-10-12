export type ConsoleEntry = { seq: number; t: string; text: string; sig: string };
export type ConsoleMark = { seq: number; seen: Set<string> };

export function signature(text: string): string {
  return text.toLowerCase()
    .replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, '$1')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ').trim();
}

export class ConsoleLog {
  private entries: ConsoleEntry[] = [];

  add(text: string): ConsoleEntry {
    const e = { seq: this.entries.length, t: new Date().toISOString(), text, sig: signature(text) };
    this.entries.push(e);
    return e;
  }
  mark(): ConsoleMark {
    return { seq: this.entries.length, seen: new Set(this.entries.map((e) => e.sig)) };
  }
  since(m: ConsoleMark) {
    const after = this.entries.slice(m.seq);
    return { fresh: after.filter((e) => !m.seen.has(e.sig)), recurring: after.filter((e) => m.seen.has(e.sig)) };
  }
}
