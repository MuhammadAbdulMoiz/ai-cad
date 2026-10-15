// The model-socket inventory the live write guard requires (livewriteguard.ts identity.modelSockets). The recorder
// sees only the editor page's own WebSocket events, and only from when it attached. The inventory is complete only
// when (a) the page created its model socket while recorded (the human reloaded it after attaching), (b) no other
// DevTools target could hold a socket the page session cannot see: another page, an iframe or any worker, and (c) every
// socket the recorder saw active without seeing it created (opened before it attached) was also seen to close.
// (c) never accepts silence: in capture-plate1 and the doc37660560 probe the pre-reload sockets, the old model socket
// among them, simply stopped, with no `closed` record, and the model socket pings only every 30 s.
// Not covered: a pre-existing socket that is never active while recorded is invisible here (docs/write-path.md §5).
// One service worker may be allowlisted (approved 2026-10-13: obs-cache.js, which mda registers on every load): its
// exact script URL is judged by its monitor (workermonitor.ts), whose problems, if any, refuse here. The monitor sees
// only what happened after it attached.
import type { CaptureRecord } from './recorder';
import type { SocketInventory } from './livewriteguard';

export type DevToolsTarget = { id: string; type: string; url: string };
const MODEL_SOCKET_URL = /:8081\/zcad\/client/;
const HARMLESS = new Set(['browser_ui', 'tab', 'browser']); // the browser's own UI; it hosts no page script

/** The allowlisted worker's URL and what its monitor (workermonitor.ts WorkerMonitor.check) found; empty = accepted. */
export type MonitoredWorker = { url: string; problems: string[] };
export function socketInventory(recs: CaptureRecord[], targets: DevToolsTarget[], editorTargetId: string, opts: { serviceWorker?: MonitoredWorker } = {}): SocketInventory & { why: string[] } {
  const why: string[] = [];
  const created = recs.filter((r): r is Extract<CaptureRecord, { type: 'socket' }> => r.type === 'socket' && MODEL_SOCKET_URL.test(r.url)).map((r) => r.requestId);
  const closed = new Set(recs.filter((r) => r.type === 'closed' || r.type === 'frame_error').map((r) => (r as any).requestId));
  const modelSockets = created.filter((id) => !closed.has(id));
  if (!created.length) why.push('no model socket was created while recorded (reload the editor tab after the recorder attached)');
  for (const t of targets) {
    if (t.id === editorTargetId || HARMLESS.has(t.type)) continue;
    const sw = opts.serviceWorker;
    if (sw && t.type === 'service_worker' && t.url.split('?')[0] === sw.url) continue; // judged once, below
    why.push(`another DevTools target could hold sockets the editor page session cannot see: ${t.type} ${t.url.split('?')[0]}`);
  }
  for (const p of opts.serviceWorker?.problems ?? []) why.push(p);
  const seen = new Set(recs.filter((r) => r.type === 'socket').map((r) => (r as any).requestId));
  const unproven = new Map<string, number>();
  for (const r of recs) if (r.type === 'frame' && !seen.has(r.requestId) && !closed.has(r.requestId) && !unproven.has(r.requestId)) unproven.set(r.requestId, r.i);
  for (const [id, i] of unproven) why.push(`socket ${id} was open before the recorder attached (frame at ${i}) and was never seen to close`);
  return { complete: why.length === 0, modelSockets, why };
}
