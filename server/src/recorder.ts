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
