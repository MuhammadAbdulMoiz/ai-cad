// Offline decoder for a watch-only capture: reads runs/capture-<label>/frames.jsonl (never modified) and
// writes decoded.jsonl (messages, text, mesh frames and marks in frame order) plus summary.json beside it.
// Sends nothing anywhere.
//
// usage: pnpm decode-capture <label>
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import type { CaptureRecord } from '../src/recorder';
import { decodeCapture, loadSchema, summarize } from '../src/wsframes';

const label = process.argv[2];
if (!label || !/^[\w-]+$/.test(label)) { console.error('usage: pnpm decode-capture <label>'); process.exit(2); }
const dir = path.join(config.runsDir, `capture-${label}`);
const records: CaptureRecord[] = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const decoded = decodeCapture(records, loadSchema(ivyRepo));

// Long bytes fields stay out of the readable output; the raw frames remain in frames.jsonl.
const shorten = (_k: string, v: unknown) => (typeof v === 'string' && v.length > 512 ? `<${v.length} chars elided; see frames.jsonl>` : v);
const marks = records.filter((r) => r.type === 'mark' || r.type === 'socket' || r.type === 'closed' || r.type === 'frame_error');
const ordered = [...marks.map((m) => ({ at: m.i, item: m })), ...decoded.map((d) => ({ at: d.frames[0], item: d }))].sort((a, b) => a.at - b.at);
fs.writeFileSync(path.join(dir, 'decoded.jsonl'), ordered.map((o) => JSON.stringify(o.item, shorten)).join('\n') + '\n');
const summary = { label, frames: records.filter((r) => r.type === 'frame').length, ...summarize(decoded) };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
