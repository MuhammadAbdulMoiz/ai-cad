// OFFLINE sequencer for the plate write workflow. It talks to a WriteTransport interface only; no live transport
// exists in ai-cad and none is wired to PageCall or the replay allow-list. Each step is sent at most once; the first
// error, timeout, unexpected message or ambiguous reply stops the run. There is no retry and no cleanup: a stopped run
// reports what it created and flags possible hidden residue (a failed commit left an undo mark the graph did not
// show, session-protocol-capture.md §2 Failure).
import type { Decoded } from './wsframes';
import {
  AmbiguousProtocolError, buildExtrudeCommit, buildExtrudeCreate, buildExtrudeModify, buildSketchCreate, buildSketchStep,
  previewFeature, RefusedWriteError, SKETCH_GEOMETRY_STEPS, WRITE_STEPS, type Lines, type WriteStep,
} from './writeport';
import type { Schema } from './wsframes';

type Msg = Extract<Decoded, { kind: 'message' }>;
/**
 * What the transport saw after sending one step, already classified by classifyStepTraffic. `uncertain`: the request
 * may have run (or still run) and its effect is not verified; `timedOut` additionally means no reply came in time.
 */
export type StepTraffic = { reply?: any; ntfs: any[]; unexpected: string[]; timedOut?: boolean; uncertain?: boolean; notSent?: boolean };
export interface WriteTransport {
  exchange(step: WriteStep, body: Uint8Array): Promise<StepTraffic>;
  /** Told when the sequencer stops for any reason, so the transport refuses everything afterwards. */
  abort?(reason: string): void;
}

// Requests the editor page itself sent around every captured step (plate1 records 117, 135, 201, 205, 238, 242…):
// these query kinds and tessellation fetches only. Anything else the page sends is unexpected.
// Multicast (IVY_USER_MULTICAST_REQ/RSP/NTF) is refused everywhere, between steps and inside step windows: the capture
// shows it only around manual UI interaction (page requests 200 and 207, answered by 202/203 and 209/210), its content
// is not decoded, and a multicast from another user means a collaborator is present. A scripted run has no UI input.
const PAGE_QUERY_KINDS = new Set(['IVY_QUERY_PARAM_REQ', 'IVY_QUERY_META_REQ', 'IVY_QUERY_PKG_REQ']);
// Accepted without a content check (captured inside step windows: 122, 147, 232, 332). It may also signal another
// editor's change; the drift and per-step state checks are the backstop for the bound document.
const ALLOWED_NOTIFICATIONS = new Set(['IVY_PROJECT_VCS_CHANGE_NTF']);

function isPageRequest(m: Msg, docId?: number): boolean {
  const p: any = m.pkg;
  if (m.cmd === 'IVY_GET_TESSELLATION_REQ') return true;
  if (m.cmd !== 'IVY_QUERY_REQ' || !PAGE_QUERY_KINDS.has(p?.queryReq?.queryHead?.cmd)) return false;
  if (docId === undefined) return true;
  const q = p.queryReq;
  const target = q.paramQuery?.docId ?? q.metaQuery?.docId ?? q.queryHead?.workshopHead?.currentDocId;
  return target === undefined || Number(target) === docId;
}

/** The page's keep-alive, the only text frame seen on the model socket during the capture (sent every 30 s). */
function isPing(text: string): boolean {
  try {
    const j = JSON.parse(text);
    return Object.keys(j).sort().join() === 'body,command,requestId' && j.command === 'ping' && /^\d+$/.test(j.requestId)
      && Object.keys(j.body ?? {}).join() === 'timestamp' && typeof j.body.timestamp === 'string';
  } catch { return false; }
}
/** A model notification naming only the bound document (workshop head and every model description). */
function ntfForDoc(pkg: any, docId: number): boolean {
  const ws = pkg?.appModelNtf?.workshopHead, descs: any[] = pkg?.appModelNtf?.modelDescs ?? [];
  return (ws?.currentDocId === undefined || Number(ws.currentDocId) === docId) && descs.every((d) => Number(d.docId) === docId);
}

/**
 * Splits the model-socket traffic after one sent step (our own request already removed) into its reply, model
 * notifications and anything unexpected, in frame order. `pageIds` maps the page's own requests still awaiting a
 * reply to their command, for the whole run, so a page reply arriving in a later window is still recognised. Each
 * page request is answered once: its id is removed by its reply, so a second reply with that id is unexpected.
 * Text frames must be the page's ping; mesh frames must be well-formed and belong to a pending tessellation request
 * (their transferId is its async id, captured 139→140, 242→243).
 */
export function classifyStepTraffic(items: Decoded[], sentAsyncId: string, pageIds: Map<string, string> = new Map(), docId?: number): StepTraffic {
  const unexpected: string[] = [], ntfs: any[] = [], replies: any[] = [];
  for (const d of items) {
    const at = d.frames[0];
    if (d.kind === 'text') { if (!(d.dir === 'sent' && isPing(d.text))) unexpected.push(`unexpected ${d.dir} text frame at ${at}`); continue; }
    if (d.kind === 'mesh') {
      if (!(d.dir === 'received' && d.ok && pageIds.get(String(d.header?.transferId)) === 'IVY_GET_TESSELLATION_REQ')) unexpected.push(`unexpected or malformed mesh frame at ${at}`);
      continue;
    }
    if (d.status !== 'decoded') { unexpected.push(`undecoded ${d.dir} message at ${at}`); continue; }
    if (d.dir === 'sent') {
      if (isPageRequest(d, docId) && d.asyncId) pageIds.set(d.asyncId, d.cmd!); else unexpected.push(`unexpected sent ${d.cmd} at ${at}`);
      continue;
    }
    if (d.asyncId !== undefined && d.asyncId === sentAsyncId) { replies.push(d.pkg); continue; }
    if (d.cmd === 'IVY_APP_MODEL_NTF') {
      if (docId !== undefined && !ntfForDoc(d.pkg, docId)) unexpected.push(`model notification for another document at ${at}`); else ntfs.push(d.pkg);
      continue;
    }
    if (ALLOWED_NOTIFICATIONS.has(d.cmd ?? '') && !Number(d.asyncId)) continue;
    if (d.asyncId && pageIds.delete(d.asyncId)) continue;
    unexpected.push(`unexpected received ${d.cmd} at ${at}`);
  }
  if (replies.length > 1) unexpected.push(`${replies.length} replies for one request`);
  return { reply: replies[0], ntfs, unexpected };
}

/**
 * Model-socket traffic recorded between two steps, while none of our requests is in flight. Only page requests,
 * their (single) replies and the allowed notifications may appear. A model notification means a late effect or
 * another editor; a message carrying one of `ourIds` is a late or duplicate reply to one of our earlier requests.
 */
export function classifyGapTraffic(items: Decoded[], pageIds: Map<string, string>, docId?: number, ourIds: Set<string> = new Set()): string[] {
  const msgs = items.filter((d): d is Msg => d.kind === 'message');
  const ours = msgs.filter((m) => m.dir === 'received' && m.asyncId && ourIds.has(m.asyncId));
  const out = ours.map((m) => `late or duplicate reply to an earlier request at ${m.frames[0]}`);
  out.push(...msgs.filter((m) => m.dir === 'received' && m.cmd === 'IVY_APP_MODEL_NTF').map((m) => `model notification between steps at ${m.frames[0]}`));
  out.push(...classifyStepTraffic(items.filter((d) => !ours.includes(d as Msg)), '\u0000', pageIds, docId).unexpected);
  return out;
}

export type PlateInput = {
  workshopId: number; docId: number; tipFeatureId: number; planeFeatureId: number;
  sketchName: string; extrudeName: string; lines: Lines; width: number; height: number; depth: number;
};
export type SeqOutcome = {
  status: 'completed' | 'stopped' | 'unknown' | 'refused';
  reason?: string;
  sent: WriteStep[];
  created: { sketchFeatureId?: number; previewFeatureId?: number; extrudeFeatureId?: number };
  possibleHiddenResidue: boolean;
};

/** Validates the whole intended sequence and dry-encodes every step whose inputs are known before anything is sent. */
export function prepareSequence(schema: Schema, x: PlateInput) {
  const doc = { workshopId: x.workshopId, docId: x.docId };
  const placeholderSketch = 1; // dry run only: the real id comes from the sketchCreate reply
  buildSketchCreate(schema, { ...doc, tipFeatureId: x.tipFeatureId, sketchName: x.sketchName, planeFeatureId: x.planeFeatureId });
  const geom = { ...doc, sketchFeatureId: placeholderSketch, planeFeatureId: x.planeFeatureId, lines: x.lines, width: x.width, height: x.height };
  for (const s of SKETCH_GEOMETRY_STEPS) buildSketchStep(schema, s, geom);
  buildExtrudeCreate(schema, { ...doc, sketchFeatureId: placeholderSketch, extrudeName: x.extrudeName });
  if (!(Number.isFinite(x.depth) && x.depth > 0 && x.depth <= 10000)) throw new RefusedWriteError('depth must be in (0, 10000]');
  return { ready: true as const, steps: [...WRITE_STEPS] as WriteStep[] };
}

const rspOf = (reply: any) => reply?.appModelRsp?.modelPkgDecoded;
const failed = (reply: any) => {
  const inner = rspOf(reply);
  return reply?.appModelRsp?.result || inner?.featUpdateRsp?.result || inner?.sketchUpdateRsp?.result || 0;
};

export async function runPlateSequence(schema: Schema, transport: WriteTransport, x: PlateInput): Promise<SeqOutcome> {
  const out: SeqOutcome = { status: 'completed', sent: [], created: {}, possibleHiddenResidue: false };
  try { prepareSequence(schema, x); }
  catch (e) { return { ...out, status: 'refused', reason: (e as Error).message }; }

  // Every stop latches the transport too, so it cannot report a run the sequencer abandoned as clean. An abort that
  // throws may have left the transport unlatched: that is added to the reason, never thrown.
  const stop = (status: SeqOutcome['status'], reason: string): SeqOutcome => {
    try { transport.abort?.(reason); }
    catch (e) { reason += `; the transport's abort failed (${(e as Error)?.message ?? String(e)}), so it may not be latched`; }
    return { ...out, status, reason, possibleHiddenResidue: out.sent.length > 0 };
  };
  // Sends one step once and checks its reply. Returns the traffic, or a stop outcome.
  const step = async (name: WriteStep, body: Uint8Array, expect: { cmd: string; type: string; id: (n: number) => boolean }) => {
    out.sent.push(name);
    let t: StepTraffic;
    // A transport that throws may already have sent the request: the outcome is unknown, never retried.
    try { t = await transport.exchange(name, body); }
    catch (e) { return stop('unknown', `${name}: transport error (${(e as Error)?.message ?? String(e)}); the request may have run`); }
    // A malformed result cannot show the request was not sent (not even its notSent flag is trusted): unknown.
    if (!t || typeof t !== 'object' || !Array.isArray(t.unexpected) || !Array.isArray(t.ntfs) || (t.notSent !== undefined && typeof t.notSent !== 'boolean'))
      return stop('unknown', `${name}: malformed transport result; the request may have run`);
    // The transport refused before sending (disabled guard, shape, plan, order, identity, state or target checks).
    if (t.notSent) { out.sent.pop(); return stop('refused', `${name}: not sent: ${t.unexpected.join('; ')}`); }
    if (t.timedOut || t.uncertain) return stop('unknown', `${name}: outcome unknown (${t.unexpected.join('; ') || 'no reply in time'}); the request may still have run`);
    if (!t.reply) return stop('stopped', `${name}: no reply${t.unexpected.length ? `; ${t.unexpected.join('; ')}` : ''}`);
    const code = failed(t.reply);
    if (code) return stop('stopped', `${name}: error result ${code}${t.unexpected.length ? `; ${t.unexpected.join('; ')}` : ''}`);
    if (t.unexpected.length) return stop('stopped', `${name}: ${t.unexpected.join('; ')}`);
    const h = rspOf(t.reply)?.header;
    if (h?.cmd !== expect.cmd || h?.featureType !== expect.type || !expect.id(Number(h?.featureId)))
      return stop('stopped', `${name}: unexpected reply ${JSON.stringify(h)}`);
    return t;
  };
  const isStop = (r: StepTraffic | SeqOutcome): r is SeqOutcome => 'status' in r;
  const doc = { workshopId: x.workshopId, docId: x.docId };
  const SKETCH = { cmd: 'IVY_PART_SKETCH_UPDATE_RSP', type: 'ivy::FeatSketch' };
  const EXTRUDE = { cmd: 'IVY_PART_FEAT_UPDATE_UPDATE_RSP', type: 'ivy::SolidExtrude' };

  try {
    let r = await step('sketchCreate', buildSketchCreate(schema, { ...doc, tipFeatureId: x.tipFeatureId, sketchName: x.sketchName, planeFeatureId: x.planeFeatureId }).body, { ...SKETCH, id: (n) => n > 0 });
    if (isStop(r)) return r;
    const sketch = Number(rspOf(r.reply).header.featureId); out.created.sketchFeatureId = sketch;
    const geom = { ...doc, sketchFeatureId: sketch, planeFeatureId: x.planeFeatureId, lines: x.lines, width: x.width, height: x.height };
    for (const s of SKETCH_GEOMETRY_STEPS) {
      r = await step(s, buildSketchStep(schema, s, geom).body, { ...SKETCH, id: (n) => n === sketch });
      if (isStop(r)) return r;
    }
    r = await step('extrudeCreate', buildExtrudeCreate(schema, { ...doc, sketchFeatureId: sketch, extrudeName: x.extrudeName }).body, { ...EXTRUDE, id: (n) => n < 0 });
    if (isStop(r)) return r;
    const preview = Number(rspOf(r.reply).header.featureId); out.created.previewFeatureId = preview;
    const ext = { ...doc, sketchFeatureId: sketch, extrudeName: x.extrudeName, previewFeatureId: preview, depth: x.depth };
    const modify = buildExtrudeModify(schema, ext, single(r.ntfs, preview));
    r = await step('extrudeModify', modify.body, { ...EXTRUDE, id: (n) => n === preview });
    if (isStop(r)) return r;
    r = await step('extrudeCommit', buildExtrudeCommit(schema, ext, single(r.ntfs, preview), modify.depthItem).body, { ...EXTRUDE, id: (n) => n > 0 });
    if (isStop(r)) return r;
    out.created.extrudeFeatureId = Number(rspOf(r.reply).header.featureId);
    return out;
  } catch (e) {
    // Building a later step failed; nothing of it was sent. Any other error stops (and latches) the run the same way.
    if (e instanceof AmbiguousProtocolError || e instanceof RefusedWriteError) return stop('stopped', `ambiguous or refused: ${e.message}`);
    return stop('stopped', `unexpected error: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Exactly one notification carrying the preview feature; anything else is ambiguous. */
function single(ntfs: any[], preview: number): any {
  const hits = ntfs.filter((n) => { try { previewFeature(n, preview); return true; } catch { return false; } });
  if (hits.length !== 1) throw new AmbiguousProtocolError(`expected 1 preview notification for ${preview}, found ${hits.length}`);
  return hits[0];
}
