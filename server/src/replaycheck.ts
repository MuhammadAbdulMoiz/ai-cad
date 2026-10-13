// Pure checks for a Phase 2b replay: target identity from observed page traffic, expected traffic around the one
// request, and before/after inspector state. Expectations come from the captures (session-protocol-capture.md §3, §6).
import protobuf from 'protobufjs';
import type { CaptureRecord } from './recorder';
import type { Decoded } from './wsframes';

type Msg = Extract<Decoded, { kind: 'message' }>;
const isMsg = (d: Decoded): d is Msg => d.kind === 'message';

/** The latest workshop head, document and parameter set the page itself sent; undefined when it sent none. */
export function observedTarget(items: Decoded[]): { workshopId: number; docId: number; parmSetId?: number } | undefined {
  let found: { workshopId: number; docId: number; parmSetId?: number } | undefined;
  let parmSetId: number | undefined;
  for (const m of items.filter(isMsg)) {
    if (m.dir !== 'sent' || m.status !== 'decoded') continue;
    const p: any = m.pkg;
    const head = p.appModelReq?.workshopHead ?? p.queryReq?.queryHead?.workshopHead;
    if (p.queryReq?.queryHead?.cmd === 'IVY_QUERY_PARAM_REQ' && p.queryReq.paramQuery?.parmSetId) parmSetId = Number(p.queryReq.paramQuery.parmSetId);
    if (head?.workshopId && head?.currentDocId) found = { workshopId: Number(head.workshopId), docId: Number(head.currentDocId) };
  }
  return found && { ...found, ...(parmSetId ? { parmSetId } : {}) };
}

/** Body bytes of field `fieldNo` in a raw sent frame; sent frames carry no compression (wsframes.ts). */
export function sentBody(record: Extract<CaptureRecord, { type: 'frame' }>, fieldNo: number): Buffer | undefined {
  let raw = Buffer.from(record.payload, 'base64');
  if (raw.length >= 35 && raw[0] === 0x5a && raw[1] === 1) raw = raw.subarray(35);
  const r = protobuf.Reader.create(raw);
  while (r.pos < r.len) { const t = r.uint32(); if (t >>> 3 === fieldNo && (t & 7) === 2) return Buffer.from(r.bytes()); r.skipType(t & 7); }
  return undefined;
}

export type Kind = 'param' | 'measure_face';
export type TrafficResult = { problems: string[]; reply?: Msg; ntf?: Msg };

/**
 * Exactly the traffic the captures showed for one request: one sent binary message carrying our bytes, then
 * param → one IVY_QUERY_RSP; measure_face → one IVY_APP_MODEL_RSP and one workbench-14 IVY_APP_MODEL_NTF.
 * Anything else in the window (other requests, version-control or model notifications, mesh frames) is a problem.
 */
export function checkTraffic(items: Decoded[], records: CaptureRecord[], kind: Kind, body: Uint8Array, bodyFieldNo: number): TrafficResult {
  const problems: string[] = [];
  const msgs = items.filter(isMsg);
  for (const d of items) if (d.kind === 'mesh') problems.push(`unexpected mesh frame at ${d.frames[0]}`);
  for (const m of msgs) if (m.status !== 'decoded') problems.push(`undecoded ${m.dir} message at ${m.frames[0]}: ${m.error}`);
  const sent = msgs.filter((m) => m.dir === 'sent');
  if (sent.length !== 1) return { problems: [...problems, `expected 1 sent message, saw ${sent.length}`] };
  const rec = records.find((r) => r.type === 'frame' && r.i === sent[0].frames[0]) as Extract<CaptureRecord, { type: 'frame' }> | undefined;
  const wire = rec && sent[0].frames.length === 1 ? sentBody(rec, bodyFieldNo) : undefined;
  if (!wire || !wire.equals(Buffer.from(body))) problems.push('the sent bytes differ from the encoded operation');
  const asyncId = sent[0].asyncId;
  const received = msgs.filter((m) => m.dir === 'received');
  const replies = received.filter((m) => m.asyncId === asyncId);
  const others = received.filter((m) => m.asyncId !== asyncId);
  if (replies.length !== 1) problems.push(`expected 1 reply for asyncId ${asyncId}, saw ${replies.length}`);
  const reply = replies[0];
  const p: any = reply?.pkg;
  if (kind === 'param') {
    if (reply && reply.cmd !== 'IVY_QUERY_RSP') problems.push(`reply is ${reply.cmd}, expected IVY_QUERY_RSP`);
    if (p?.queryRsp?.result) problems.push(`query result ${p.queryRsp.result}`);
    for (const o of others) problems.push(`unexpected ${o.cmd} at ${o.frames[0]}`);
    return { problems, reply };
  }
  if (reply && reply.cmd !== 'IVY_APP_MODEL_RSP') problems.push(`reply is ${reply.cmd}, expected IVY_APP_MODEL_RSP`);
  if (p?.appModelRsp?.result) problems.push(`app model result ${p.appModelRsp.result}`);
  if (p && p.appModelRsp?.modelPkgDecoded?.header?.cmd !== 'IVY_MEASUREMENT_UPDATE_RSP') problems.push('reply is not a measurement update response');
  const ntfs = others.filter((o) => o.cmd === 'IVY_APP_MODEL_NTF');
  for (const o of others.filter((x) => x.cmd !== 'IVY_APP_MODEL_NTF')) problems.push(`unexpected ${o.cmd} at ${o.frames[0]}`);
  if (ntfs.length !== 1) problems.push(`expected 1 model notification, saw ${ntfs.length}`);
  const descs: any[] = (ntfs[0]?.pkg as any)?.appModelNtf?.modelDescs ?? [];
  if (ntfs.length === 1 && (!descs.length || descs.some((d) => d.workbenchType !== 14))) problems.push('model notification is not measurement-only');
  return { problems, reply, ntf: ntfs[0] };
}

export type StateSnap = { undo: string; classes: Record<string, string>; objects: Record<string, string>; edges: string[] };
export const VOLATILE = new Set(['ivy::PipelineContext']); // the only difference a no-op showed (§6)

/** Differences between two inspector snapshots, ignoring only VOLATILE objects and edges touching them. */
export function compareState(a: StateSnap, b: StateSnap): string[] {
  const out: string[] = [];
  if (a.undo !== b.undo) out.push('undo history changed');
  const keep = (s: StateSnap) => Object.keys(s.classes).filter((h) => !VOLATILE.has(s.classes[h])).sort();
  const ka = keep(a), kb = keep(b);
  for (const h of ka.filter((x) => !kb.includes(x))) out.push(`object ${h} (${a.classes[h]}) removed`);
  for (const h of kb.filter((x) => !ka.includes(x))) out.push(`object ${h} (${b.classes[h]}) added`);
  for (const h of ka.filter((x) => kb.includes(x))) if (a.objects[h] !== b.objects[h]) out.push(`object ${h} (${a.classes[h]}) changed`);
  const vol = (s: StateSnap) => new Set(Object.keys(s.classes).filter((h) => VOLATILE.has(s.classes[h])));
  const edges = (s: StateSnap) => { const v = vol(s); return s.edges.filter((e) => !e.match(/"(\d+)"/g)?.some((q) => v.has(q.slice(1, -1)))).sort(); };
  if (JSON.stringify(edges(a)) !== JSON.stringify(edges(b))) out.push('graph edges changed');
  return out;
}
