// Raw DevTools connection to one tab of the harness Chrome. Callers wrap it at once: ReadOnlyCdp (recorder) or
// PageCall (Phase 2b); neither exposes it further.
import type { CdpConnection } from './cdpguard';

export type EditorTab = { id: string; url: string; webSocketDebuggerUrl: string };
export class NoDevToolsError extends Error {}

export const shortUrl = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '?'; } };

/** The single open /zcad tab (or the one named by id). Throws when there is none or more than one. */
export async function findEditorTab(cdpPort: number, targetId?: string): Promise<EditorTab> {
  let targets: Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>;
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  } catch (e) {
    throw new NoDevToolsError(`No harness Chrome on DevTools port ${cdpPort} (${(e as Error).message}). Start it with login.bat and keep that window open.`);
  }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const candidates = targetId ? pages.filter((t) => t.id === targetId) : pages.filter((t) => /\/zcad/.test(t.url));
  if (candidates.length !== 1) {
    const list = pages.map((t) => `  ${t.id}  ${shortUrl(t.url)}`).join('\n');
    throw new Error(`${candidates.length ? 'Several editor tabs are open; pick one with --target:' : 'No single editor tab found. Open tabs:'}\n${list}`);
  }
  return candidates[0] as EditorTab;
}

export function connect(url: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
    const listeners: Array<(m: string, p: unknown) => void> = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const w = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) w?.fail(new Error(msg.error.message)); else w?.ok(msg.result);
      } else if (msg.method) for (const l of listeners) l(msg.method, msg.params);
    };
    ws.onerror = () => reject(new Error('DevTools connection failed'));
    ws.onopen = () => resolve({
      send: (method, params) => new Promise((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      }),
      onEvent: (l) => { listeners.push(l); },
      close: () => ws.close(),
    });
  });
}
