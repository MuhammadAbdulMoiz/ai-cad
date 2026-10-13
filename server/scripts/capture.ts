// Watch-only protocol capture (black-box re-plan §7.1). Attaches to the already-open harness Chrome editor
// tab over DevTools and records every WebSocket frame. It sends no WebSocket message, runs no page script,
// and clicks, types or navigates nothing: the only DevTools command it can send is Network.enable.
//
// usage: pnpm capture <label> [--target <devtoolsTargetId>]
// Type a line + Enter to add a mark (e.g. "start sketch"); type "quit" to stop.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connect, findEditorTab, NoDevToolsError, shortUrl, type EditorTab } from '../src/cdpconnect';
import { ReadOnlyCdp } from '../src/cdpguard';
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

let target: EditorTab;
try { target = await findEditorTab(config.cdpPort, targetArg); }
catch (e) { console.error((e as Error).message); process.exit(e instanceof NoDevToolsError ? 1 : 2); }

fs.mkdirSync(out, { recursive: true });
const file = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
let count = 0;
const cdp = new ReadOnlyCdp(await connect(target.webSocketDebuggerUrl));
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
