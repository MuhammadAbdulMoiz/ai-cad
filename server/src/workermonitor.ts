// Read-only monitoring of the one allowlisted service worker (approved 2026-10-13: obs-cache.js, exact URL only). mda
// starts the worker only when the editor loads, after the recorder attached to an empty tab, so the worker is found
// by polling the DevTools target list and a separate read-only recorder (Network.enable only) is attached the moment
// it appears. Anything the worker did between starting and that attachment is NOT visible: the monitoring covers
// only the time after `attachedAt`, and every report says so.
//
// check() is what the inventory consults. It refuses (returns problems) unless: at most one worker with the URL is
// listed; it is the very target the recorder attached to (no restart or replacement since); the attachment never
// failed; the recorder still answers (a repeated Network.enable within the timeout); and its stream holds no record
// but annotations (no WebSocket created, no frame, no error or close).
import type { CaptureRecord, RecordStream } from './recorder';
import type { DevToolsTarget } from './socketinventory';

export type WorkerTarget = DevToolsTarget & { webSocketDebuggerUrl?: string };
/** A live recorder on the worker: `ping` repeats Network.enable (the only command ReadOnlyCdp allows). */
export type WorkerRecorder = { ping(): Promise<void>; detach(): void };
export type WorkerMonitorDeps = {
  list: () => Promise<WorkerTarget[]>;
  /** Attaches a read-only recorder writing into `write`; resolves once Network.enable was acknowledged. */
  attach: (t: WorkerTarget, write: (r: CaptureRecord) => void) => Promise<WorkerRecorder>;
  stream: RecordStream;
  now?: () => number;
  pingTimeoutMs?: number;
};
export type WorkerReport = {
  url: string; firstSeenAt?: string; firstSeenTargetId?: string; attachedAt?: string; targetId?: string;
  gapMs?: number; activity: number; failed?: string; replacedBy?: string[]; accepted?: boolean; note: string;
};

const NOTE = 'monitoring starts at attachedAt: worker activity between its start and the attachment cannot be ruled out';

export class WorkerMonitor {
  readonly #url: string; readonly #d: WorkerMonitorDeps; readonly #now: () => number;
  #firstSeen?: { at: number; id: string }; #attached?: { at: number; id: string; rec: WorkerRecorder };
  #attaching?: Promise<void>; #failed?: string; #replaced: string[] = []; #accepted?: boolean;

  constructor(url: string, d: WorkerMonitorDeps) { this.#url = url; this.#d = d; this.#now = d.now ?? Date.now; }

  #matches(ts: WorkerTarget[]) { return ts.filter((t) => t.type === 'service_worker' && t.url.split('?')[0] === this.#url); }

  /** Looks at the target list; attaches the moment the worker first appears. Never retries a failed attachment. */
  async poll(targets?: WorkerTarget[]): Promise<void> {
    const ts = this.#matches(targets ?? await this.#d.list());
    for (const t of ts) {
      this.#firstSeen ??= { at: this.#now(), id: t.id };
      if (this.#attached && t.id !== this.#attached.id && !this.#replaced.includes(t.id)) this.#replaced.push(t.id);
    }
    if (this.#attaching) { await this.#attaching; return; } // a concurrent poll is attaching: wait for its outcome
    if (this.#attached || this.#failed || ts.length !== 1) return;
    const t = ts[0];
    this.#attaching = (async () => {
      try {
        if (!t.webSocketDebuggerUrl) throw new Error('the worker target has no DevTools endpoint');
        const rec = await this.#d.attach(t, this.#d.stream.write);
        this.#attached = { at: this.#now(), id: t.id, rec };
      } catch (e) { this.#failed = (e as Error)?.message ?? String(e); }
    })();
    await this.#attaching;
    this.#attaching = undefined;
  }

  /** Problems that make the inventory refuse; empty means the worker is accepted under this policy. */
  async check(targets: WorkerTarget[]): Promise<string[]> {
    await this.poll(targets);
    const ts = this.#matches(targets);
    const p: string[] = [];
    const tag = `the allowlisted service worker ${this.#url}`;
    if (ts.length > 1) p.push(`${tag} is listed ${ts.length} times (${ts.map((t) => t.id).join(', ')})`);
    if (this.#failed) p.push(`${tag} could not be monitored: ${this.#failed}`);
    if (this.#replaced.length) p.push(`${tag} was replaced or restarted after monitoring began (${this.#attached?.id} → ${this.#replaced.join(', ')})`);
    if (ts.length && !this.#attached && !this.#failed) p.push(`${tag} is not monitored`);
    if (this.#attached) {
      if (ts.length === 1 && ts[0].id !== this.#attached.id) p.push(`${tag} is target ${ts[0].id}, not the monitored ${this.#attached.id}`);
      try {
        const timeout = this.#d.pingTimeoutMs ?? 2000;
        await Promise.race([this.#attached.rec.ping(), new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${timeout} ms`)), timeout))]);
      } catch (e) { p.push(`${tag}: its recorder is not operational (${(e as Error)?.message ?? e})`); }
      try {
        const seen = this.#d.stream.since(0).filter((r) => r.type !== 'mark');
        if (seen.length) p.push(`${tag} showed WebSocket activity (${seen[0].type} at ${seen[0].i})`);
      } catch (e) { p.push(`${tag}: its record stream failed (${(e as Error).message})`); }
    }
    if (ts.length) this.#accepted = p.length === 0;
    return p;
  }

  report(): WorkerReport {
    const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
    let activity = 0;
    try { activity = this.#d.stream.since(0).filter((r) => r.type !== 'mark').length; } catch { activity = -1; }
    return {
      url: this.#url, firstSeenAt: iso(this.#firstSeen?.at), firstSeenTargetId: this.#firstSeen?.id, attachedAt: iso(this.#attached?.at),
      targetId: this.#attached?.id, gapMs: this.#attached && this.#firstSeen ? this.#attached.at - this.#firstSeen.at : undefined,
      activity, ...(this.#failed ? { failed: this.#failed } : {}), ...(this.#replaced.length ? { replacedBy: [...this.#replaced] } : {}),
      ...(this.#accepted === undefined ? {} : { accepted: this.#accepted }), note: NOTE,
    };
  }

  detach() { this.#attached?.rec.detach(); }
}
