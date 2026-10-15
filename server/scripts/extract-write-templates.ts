// Extracts the nine captured UI requests of the plate workflow (session-protocol-capture.md §2) into
// src/templates/plate1-write.json. Offline: reads runs/capture-plate1 only. The bodies carry no user identifiers
// (checked: no "oi_" in any body); headers (asyncId, projectId) are not kept.
//
// usage: pnpm exec tsx scripts/extract-write-templates.ts
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { config } from '../src/config';
import { loadSchema } from '../src/wsframes';

export const SOURCES = { sketchCreate: 113, sketchDraw: 121, sketchClose: 133, widthAdd: 214, heightAdd: 223, sketchFinish: 236, extrudeCreate: 297, extrudeModify: 303, extrudeCommit: 311 } as const;
const schema = loadSchema(process.env.IVY_REPO || 'C:\\zixel\\ivyproject');
const records = fs.readFileSync(path.join(config.runsDir, 'capture-plate1', 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const opts = { enums: String, longs: String, bytes: String, defaults: false };
const A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq');

const bodies: Record<string, unknown> = {};
for (const [name, i] of Object.entries(SOURCES)) {
  const r = protobuf.Reader.create(Buffer.from(records.find((x) => x.i === i).payload, 'base64'));
  let body: Uint8Array | undefined;
  while (r.pos < r.len) { const t = r.uint32(); if (t >>> 3 === 100 && (t & 7) === 2) body = r.bytes(); else r.skipType(t & 7); }
  if (!body || Buffer.from(body).includes('oi_')) throw new Error(`record ${i}: no app-model body, or it carries a user id`);
  const req: any = A.decode(body);
  const obj: any = A.toObject(req, opts);
  obj.modelPkg = schema.PartPkg!.toObject(schema.PartPkg!.decode(req.modelPkg), opts);
  bodies[name] = obj;
}
const out = path.join(import.meta.dirname, '..', 'src', 'templates', 'plate1-write.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: 'runs/capture-plate1 (2026-10-13)', records: SOURCES, bodies }, null, 1) + '\n');
console.log(`wrote ${out}`);
