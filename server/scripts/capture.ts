// Watch-only protocol capture (black-box re-plan §7.1). Attaches to the already-open harness Chrome editor
// tab over DevTools and records every WebSocket frame. It sends no WebSocket message, runs no page script,
// and clicks, types or navigates nothing: the only DevTools command it can send is Network.enable.
//
// usage: pnpm capture <label> [--target <devtoolsTargetId>]
// Type a line + Enter to add a mark (e.g. "start sketch"); type "quit" to stop.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ReadOnlyCdp, type CdpConnection } from '../src/cdpguard';
import { config } from '../src/config';
import { attachRecorder } from '../src/recorder';

const [label, ...rest] = process.argv.slice(2);
if (!label || !/^[\w-]+$/.test(label)) {
  console.error('usage: pnpm capture <label> [--target <devtoolsTargetId>]   (label: letters, digits, - _)');
  process.exit(2);
}
const targetArg = rest.indexOf('--target') >= 0 ? rest[rest.indexOf('--target') + 1] : undefined;

const out = path.join(config.runsDir, `capture-${label}`);
if (fs.existsSync(out)) { console.error(`${out} already exists; pick a new label.`); process.exit(2); }

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };
let targets: Target[];
try {
  targets = await (await fetch(`http://127.0.0.1:${config.cdpPort}/json/list`)).json() as Target[];
} catch (e) {
  console.error(`No harness Chrome on DevTools port ${config.cdpPort} (${(e as Error).message}). Start it with login.bat and keep that window open.`);
  process.exit(1);
}
const shortUrl = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '?'; } };
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const candidates = targetArg ? pages.filter((t) => t.id === targetArg) : pages.filter((t) => /\/zcad/.test(t.url));
if (candidates.length !== 1) {
  console.error(candidates.length ? 'Several editor tabs are open; pick one with --target:' : 'No single editor tab found. Open tabs:');
  for (const t of pages) console.error(`  ${t.id}  ${shortUrl(t.url)}`);
  process.exit(2);
}
const target = candidates[0];

function connect(url: string): Promise<CdpConnection> {
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

fs.mkdirSync(out, { recursive: true });
const file = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
let count = 0;
const cdp = new ReadOnlyCdp(await connect(target.webSocketDebuggerUrl!));
const mark = await attachRecorder(cdp, (r) => { fs.writeSync(file, JSON.stringify(r) + '\n'); if (r.type === 'frame') count++; });
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ label, page: shortUrl(target.url), startedAt: new Date().toISOString() }, null, 2));
mark('recorder attached');

console.log(`Recording ${shortUrl(target.url)} -> ${out}`);
console.log('Only sockets opened or frames sent from now on are seen: reload the editor tab yourself (F5) if it was already open.');
console.log('Type a mark + Enter (e.g. "start sketch", "end sketch"); "quit" stops.');

const stop = () => { mark('recorder detached'); cdp.detach(); fs.closeSync(file); console.log(`Stopped. ${count} frames in ${out}`); process.exit(0); };
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === 'quit') return stop();
  mark(text);
  console.log(`  mark: ${text}  (${count} frames so far)`);
});
process.on('SIGINT', stop);
