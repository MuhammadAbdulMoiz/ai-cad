// Watch-only WebSocket recorder: turns DevTools network events into capture records. It never sends
// anything except Network.enable, through ReadOnlyCdp.
import type { ReadOnlyCdp } from './cdpguard';

export type CaptureRecord =
  | { i: number; t: number; type: 'socket'; requestId: string; url: string }
  | { i: number; t: number; type: 'frame'; requestId: string; dir: 'sent' | 'received'; ts: number; opcode: number; mask: boolean; payload: string }
  | { i: number; t: number; type: 'frame_error'; requestId: string; ts: number; message: string }
  | { i: number; t: number; type: 'closed'; requestId: string; ts: number }
  | { i: number; t: number; type: 'mark'; text: string };

// The socket URL carries the user's token, openId and tenantId; only these query keys are kept.
const KEEP_QUERY = new Set(['projectId', 'projectTag', 'appId']);

export function redactUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return '<unparseable url>'; }
  for (const k of [...u.searchParams.keys()]) if (!KEEP_QUERY.has(k)) u.searchParams.set(k, 'REDACTED');
  u.username = u.password = '';
  return u.toString();
}

/**
 * The record stream the live write guard's traffic port reads (`position`/`since`). Contract: ONE stream per recorder
 * attachment, written by that attachment only, indices 0, 1, 2, … with no hole. attachRecorder numbers from 0 each
 * time, so reattaching onto a used stream (or a record lost to a throwing handler, which still consumed its index)
 * shows as an index that is not the next one. The stream then breaks for good: every later read throws, so a guard
 * refuses or reports unknown. A reattached recorder needs a new stream and a new guard; nothing is resumed or renumbered.
 */
export class RecordStream {
  readonly #recs: CaptureRecord[] = [];
  #broken?: string;
  readonly write = (r: CaptureRecord): void => {
    if (this.#broken) return;
    if (r?.i !== this.#recs.length) { this.#broken = `record index ${r?.i} written where ${this.#recs.length} was expected (recorder reattached, or a record lost)`; return; }
    this.#recs.push(Object.freeze({ ...r }) as CaptureRecord);
  };
  #check() { if (this.#broken) throw new Error(`traffic stream broken: ${this.#broken}`); }
  position(): number { this.#check(); return this.#recs.length; }
  since(p: number): CaptureRecord[] {
    this.#check();
    if (!Number.isSafeInteger(p) || p < 0 || p > this.#recs.length) throw new Error(`traffic position ${p} is not in the stream (0–${this.#recs.length})`);
    return this.#recs.slice(p);
  }
}

/** Subscribes to WebSocket events, then enables the Network domain. Returns a function that adds a mark. */
export async function attachRecorder(cdp: ReadOnlyCdp, write: (r: CaptureRecord) => void): Promise<(text: string) => void> {
  let i = 0;
  const p = (x: unknown) => x as Record<string, any>;
  cdp.on('Network.webSocketCreated', (x) => write({ i: i++, t: Date.now(), type: 'socket', requestId: p(x).requestId, url: redactUrl(p(x).url) }));
  for (const [event, dir] of [['Network.webSocketFrameSent', 'sent'], ['Network.webSocketFrameReceived', 'received']] as const) {
    cdp.on(event, (x) => {
      const { requestId, timestamp, response } = p(x);
      write({ i: i++, t: Date.now(), type: 'frame', requestId, dir, ts: timestamp, opcode: response.opcode, mask: response.mask, payload: response.payloadData });
    });
  }
  cdp.on('Network.webSocketFrameError', (x) => write({ i: i++, t: Date.now(), type: 'frame_error', requestId: p(x).requestId, ts: p(x).timestamp, message: p(x).errorMessage }));
  cdp.on('Network.webSocketClosed', (x) => write({ i: i++, t: Date.now(), type: 'closed', requestId: p(x).requestId, ts: p(x).timestamp }));
  await cdp.send('Network.enable');
  return (text) => write({ i: i++, t: Date.now(), type: 'mark', text });
}
