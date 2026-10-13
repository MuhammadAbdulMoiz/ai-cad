// Offline decoder for watch-only captures (black-box re-plan §7.1). Framing mirrors mda's
// ProtoSocketService as read on 2026-10-13 and is checked against captured bytes, never assumed:
// anything that does not reassemble, decompress or decode is reported as undecoded with its frames.
//   - optional 35-byte trace header: bytes[0]=='Z' && bytes[1]==1 (ProtoSocketService.ts:72,1588-1594,1212)
//   - messages split into 512 KB chunks; a shorter chunk ends a message (ProtoSocketService.ts:66,700-713,2051-2074)
//   - received messages are zstd-compressed after reassembly (ProtoSocketService.ts:745); sent ones are not
//   - received 'IVTR' raw mesh frames bypass reassembly (ProtoSocketService.ts:681-693, DocumentTessellationProtocol.ts:617-660)
//   - a reassembled reply may be an 'IVYDOC01' envelope around the IvyPkg (DocumentTessellationProtocol.ts:231-265,603)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import protobuf from 'protobufjs';
import type { CaptureRecord } from './recorder';

export const FULL_PACKAGE_SIZE = 512 * 1024;
const TRACE_HEADER_SIZE = 35;
const MESH_HEADER_SIZE = 64;
const ascii = (s: string) => Buffer.from(s, 'ascii');
const MESH_MAGIC = ascii('IVTR');
const ENVELOPE_MAGIC = ascii('IVYDOC01');
const startsWith = (b: Uint8Array, m: Uint8Array) => b.length >= m.length && m.every((v, i) => b[i] === v);

export type Dir = 'sent' | 'received';
export type Decoded =
  | { kind: 'text'; dir: Dir; requestId: string; frames: number[]; t: number; text: string }
  | { kind: 'mesh'; dir: Dir; requestId: string; frames: number[]; t: number; bytes: number; ok: boolean; error?: string; header?: Record<string, number | string> }
  | { kind: 'message'; dir: Dir; requestId: string; frames: number[]; t: number; traceHeader: boolean; wireBytes: number; bytes?: number; envelope?: boolean;
      status: 'decoded' | 'undecoded'; error?: string; cmd?: string; asyncId?: string; pkg?: unknown };

// ------------------------------------------------------------------ protobuf schema (Ivy's .proto files, read in place)

const INCLUDE_DIRS = ['ivyproto/proto', 'ivyproto/commonProto', 'sdk/commonproto/proto'];

export type Schema = { IvyPkg: protobuf.Type; PartPkg?: protobuf.Type };

export function loadSchema(ivyRepo: string): Schema {
  const dirs = INCLUDE_DIRS.map((d) => path.join(ivyRepo, d));
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => {
    if (path.isAbsolute(target) && fs.existsSync(target)) return target;
    for (const d of dirs) { const p = path.join(d, path.basename(target)); if (fs.existsSync(p)) return p; }
    return target;
  };
  root.loadSync(['ivyproto.proto', 'ivypart.proto'], { keepCase: false });
  root.resolveAll();
  return { IvyPkg: root.lookupType('ivyproto.IvyPkg'), PartPkg: root.lookupType('ivypart.PartPkg') };
}

const TO_OBJECT: protobuf.IConversionOptions = { longs: String, enums: String, bytes: String, defaults: false, oneofs: true };

/** Decodes nested PartPkg payloads where the outer message carries them as bytes; failures are recorded, not hidden. */
function decodeNested(schema: Schema, msg: any, obj: any) {
  if (!schema.PartPkg) return;
  const tryPart = (bytes: unknown, into: any) => {
    if (!(bytes instanceof Uint8Array) || !bytes.length || !into) return;
    try { into.modelPkgDecoded = schema.PartPkg!.toObject(schema.PartPkg!.decode(bytes), TO_OBJECT); }
    catch (e) { into.modelPkgDecodeError = (e as Error).message; }
  };
  tryPart(msg.appModelReq?.modelPkg, obj.appModelReq);
  tryPart(msg.appModelRsp?.modelPkg, obj.appModelRsp);
  (msg.appModelNtf?.modelDescs ?? []).forEach((d: any, i: number) => tryPart(d?.modelPkg, obj.appModelNtf?.modelDescs?.[i]));
}

function decodePkg(schema: Schema, bytes: Uint8Array): { cmd?: string; asyncId?: string; pkg: unknown } {
  const msg: any = schema.IvyPkg.decode(bytes);
  const obj: any = schema.IvyPkg.toObject(msg, TO_OBJECT);
  decodeNested(schema, msg, obj);
  return { cmd: obj.header?.cmd, asyncId: obj.header?.asyncId, pkg: obj };
}

/**
 * Node's zstd returns partial output for a truncated frame instead of failing, so the frame structure is walked
 * here (RFC 8878 §3.1.1): exactly one frame, blocks up to the last one, the checksum if declared, then the end of
 * the buffer. Returns the declared content size, if any. The checksum value itself is not verified (no XXH64).
 */
export function checkZstdFrame(b: Uint8Array): number | undefined {
  const fail = (why: string): never => { throw new Error(`zstd frame: ${why}`); };
  if (b.length < 6 || b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) fail('missing magic');
  const fhd = b[4];
  const single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, fcsFlag = fhd >> 6;
  if ((fhd >> 3) & 1) fail('reserved bit set');
  let o = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3];
  const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  if (o + fcsSize > b.length) fail('truncated header');
  let size: number | undefined;
  if (fcsSize) {
    size = 0;
    for (let i = fcsSize - 1; i >= 0; i--) size = size * 256 + b[o + i];
    if (fcsSize === 2) size += 256;
  }
  o += fcsSize;
  for (let last = 0; !last;) {
    if (o + 3 > b.length) fail('truncated block header');
    const h = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    last = h & 1;
    const type = (h >> 1) & 3, blockSize = h >>> 3;
    if (type === 3) fail('reserved block type');
    o += 3 + (type === 1 ? 1 : blockSize);
  }
  o += checksum ? 4 : 0;
  if (o !== b.length) fail(o > b.length ? `truncated by ${o - b.length} bytes` : `${b.length - o} trailing bytes`);
  return size;
}

function readEnvelope(b: Uint8Array): { proto: Uint8Array; payloads: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = ENVELOPE_MAGIC.length;
  const version = v.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`envelope version ${version}`);
  const protoSize = Number(v.getBigUint64(o, true)); o += 8;
  const count = v.getUint32(o, true); o += 4;
  const proto = b.subarray(o, o + protoSize); o += protoSize;
  if (proto.length !== protoSize) throw new Error('truncated envelope proto');
  for (let i = 0; i < count; i++) { o += 8; const size = Number(v.getBigUint64(o, true)); o += 8 + size; }
  if (o !== b.length) throw new Error(`envelope trailing/missing bytes: ${b.length - o}`);
  return { proto, payloads: count };
}

export function readMeshHeader(b: Uint8Array): Record<string, number | string> {
  if (b.length < MESH_HEADER_SIZE) throw new Error(`mesh frame shorter than its ${MESH_HEADER_SIZE}-byte header`);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const h = {
    version: v.getUint16(4, true), headerSize: v.getUint16(6, true), transferId: v.getBigUint64(8, true).toString(),
    queryId: v.getUint32(16, true), tessellationIndex: v.getUint32(20, true), tessellationCount: v.getUint32(24, true),
    codec: v.getUint16(28, true), flags: v.getUint16(30, true), totalSize: Number(v.getBigUint64(32, true)),
    decodedSize: Number(v.getBigUint64(40, true)), offset: Number(v.getBigUint64(48, true)), chunkSize: v.getUint32(56, true),
    featureId: v.getInt32(60, true),
  };
  if (h.version !== 3 || h.headerSize !== MESH_HEADER_SIZE) throw new Error(`mesh header version ${h.version}, size ${h.headerSize}`);
  if (b.length !== MESH_HEADER_SIZE + h.chunkSize) throw new Error(`mesh frame is ${b.length} bytes, header says ${MESH_HEADER_SIZE + h.chunkSize}`);
  if (h.offset + h.chunkSize > h.totalSize) throw new Error('mesh chunk exceeds declared total size');
  return h;
}

// ------------------------------------------------------------------ reassembly

type Pending = { frames: number[]; chunks: Uint8Array[]; trace: boolean; wire: number; t: number };

/** Decodes a capture in frame order. Sockets and directions are reassembled independently. */
export function decodeCapture(records: CaptureRecord[], schema: Schema): Decoded[] {
  const out: Decoded[] = [];
  const pending = new Map<string, Pending>();

  const finish = (key: string, dir: Dir, requestId: string, p: Pending) => {
    pending.delete(key);
    const merged = Buffer.concat(p.chunks);
    const base = { kind: 'message' as const, dir, requestId, frames: p.frames, t: p.t, traceHeader: p.trace, wireBytes: p.wire };
    let bytes: Uint8Array = merged;
    if (dir === 'received') {
      try {
        const declared = checkZstdFrame(merged);
        bytes = zlib.zstdDecompressSync(merged);
        if (declared !== undefined && bytes.length !== declared) throw new Error(`decompressed ${bytes.length} bytes, frame declares ${declared}`);
      }
      catch (e) { out.push({ ...base, status: 'undecoded', error: `zstd: ${(e as Error).message}` }); return; }
    }
    let envelope = false;
    try {
      let proto = bytes;
      if (startsWith(bytes, ENVELOPE_MAGIC)) { envelope = true; proto = readEnvelope(bytes).proto; }
      out.push({ ...base, bytes: bytes.length, envelope, status: 'decoded', ...decodePkg(schema, proto) });
    } catch (e) {
      out.push({ ...base, bytes: bytes.length, envelope, status: 'undecoded', error: `decode: ${(e as Error).message}` });
    }
  };

  for (const r of records) {
    if (r.type !== 'frame') continue;
    if (r.opcode === 1) { out.push({ kind: 'text', dir: r.dir, requestId: r.requestId, frames: [r.i], t: r.t, text: r.payload }); continue; }
    if (r.opcode !== 2) continue; // control frames carry no protocol data
    const raw = Buffer.from(r.payload, 'base64');
    const trace = raw.length >= TRACE_HEADER_SIZE && raw[0] === 0x5a && raw[1] === 1;
    const body = trace ? raw.subarray(TRACE_HEADER_SIZE) : raw;
    const key = `${r.requestId}/${r.dir}`;

    if (r.dir === 'received' && startsWith(body, MESH_MAGIC)) {
      try { out.push({ kind: 'mesh', dir: r.dir, requestId: r.requestId, frames: [r.i], t: r.t, bytes: body.length, ok: true, header: readMeshHeader(body) }); }
      catch (e) { out.push({ kind: 'mesh', dir: r.dir, requestId: r.requestId, frames: [r.i], t: r.t, bytes: body.length, ok: false, error: (e as Error).message }); }
      continue;
    }
    const p = pending.get(key);
    if (body.length === 0 && !p) continue; // mda ignores an empty frame that starts nothing (ProtoSocketService.ts:702-704)
    const cur = p ?? { frames: [], chunks: [], trace: false, wire: 0, t: r.t };
    cur.frames.push(r.i); cur.chunks.push(body); cur.trace ||= trace; cur.wire += raw.length;
    pending.set(key, cur);
    if (body.length < FULL_PACKAGE_SIZE) finish(key, r.dir, r.requestId, cur);
  }
  for (const [key, p] of pending) {
    const [requestId, dir] = key.split('/') as [string, Dir];
    out.push({ kind: 'message', dir, requestId, frames: p.frames, t: p.t, traceHeader: p.trace, wireBytes: p.wire, status: 'undecoded', error: 'capture ended mid-message (no final chunk)' });
  }
  return out.sort((a, b) => a.frames[0] - b.frames[0]);
}

/** Request/response pairing by header asyncId, and counts, for the report. */
export function summarize(items: Decoded[]) {
  const msgs = items.filter((x): x is Extract<Decoded, { kind: 'message' }> => x.kind === 'message');
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const sentIds = new Set(msgs.filter((m) => m.dir === 'sent' && m.asyncId && m.asyncId !== '0').map((m) => m.asyncId!));
  const recvIds = new Set(msgs.filter((m) => m.dir === 'received' && m.asyncId && m.asyncId !== '0').map((m) => m.asyncId!));
  return {
    messages: count(msgs.map((m) => `${m.dir}:${m.status}`)),
    commands: { sent: count(msgs.filter((m) => m.dir === 'sent' && m.cmd).map((m) => m.cmd!)), received: count(msgs.filter((m) => m.dir === 'received' && m.cmd).map((m) => m.cmd!)) },
    text: items.filter((x) => x.kind === 'text').length,
    mesh: count(items.filter((x): x is Extract<Decoded, { kind: 'mesh' }> => x.kind === 'mesh').map((m) => (m.ok ? 'ok' : 'invalid'))),
    asyncIds: { requests: sentIds.size, answered: [...sentIds].filter((id) => recvIds.has(id)).length, unanswered: [...sentIds].filter((id) => !recvIds.has(id)), unsolicited: [...recvIds].filter((id) => !sentIds.has(id)) },
    undecoded: msgs.filter((m) => m.status === 'undecoded').map((m) => ({ dir: m.dir, frames: m.frames, wireBytes: m.wireBytes, error: m.error })),
  };
}
