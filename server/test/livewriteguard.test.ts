// Live write guard, tested with fake ports only. The fake document is rebuilt per request from REAL data (the plate1
// probe fixtures plus the per-request undo marks the capture recorded), not from the guard's rules. The fake page
// puts our exact bytes on the wire under the captured header and reports the async id through Number(), as the real
// page does. No live Ivy connection is used.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { StateSnap } from '../src/replaycheck';
import template from '../src/templates/plate1-write.json';
import { bindCreated, checkDrift, checkReportedDepth, checkStateChange, checkWriteRequest, EXPECTED_MARKS, LiveWriteGuard, snapshotProblems, type GuardPorts, type Identity, type Plan, type SendResult, type SocketInventory } from '../src/livewriteguard';
import { RecordStream } from '../src/recorder';
import { buildExtrudeModify, buildSketchCreate, buildSketchStep, rectLines, WRITE_STEPS, type Lines, type WriteStep } from '../src/writeport';
import { runPlateSequence, type PlateInput, type WriteTransport } from '../src/writeseq';
import { platePostconditions, runPlateTrial } from '../src/platetrial';
import { PAGE_FN } from '../src/pagecall';
import { PageSender } from '../src/writesender';
import type { CdpConnection } from '../src/cdpguard';
import { decodeCapture, loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const FIX = path.join(import.meta.dirname, 'fixtures', 'inspector');
const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(captureFile);
const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
const records: any[] = ready ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const SOCKET = '40700.5030';
const SESSION = '268435459'; // the plate1 model socket's ready identifier
const bound: Identity = { projectId: 37649921, projectTag: 'main', workshopId: 1, docId: 540, modelSocket: SOCKET, sessionId: SESSION };
const ALL = [...WRITE_STEPS] as WriteStep[];

// ------------------------------------------------------------------ real fixtures

type Fixture = { classes: Record<string, string>; objects: Record<string, string>; edges: string[]; undo: any };
function fixture(label: string): Fixture {
  const dir = path.join(FIX, label);
  const dot = fs.readFileSync(path.join(dir, 'graph-full.dot'), 'utf8');
  const classes: Record<string, string> = {};
  for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"\s]+)/gm)) classes[m[1]] = m[2];
  const objects: Record<string, string> = {};
  for (const h of Object.keys(classes)) { const f = path.join(dir, 'objects', `${h}.json`); if (fs.existsSync(f) && classes[h] !== 'ivy::PipelineContext' && classes[h] !== 'ivy::Project') objects[h] = fs.readFileSync(f, 'utf8'); }
  return { classes, objects, edges: [...dot.matchAll(/^\s*"\d+" -> "\d+".*$/gm)].map((m) => m[0].trim()), undo: JSON.parse(fs.readFileSync(path.join(dir, 'undo.json'), 'utf8')) };
}
const F = ready ? { idle: fixture('plate1-idle'), sketch: fixture('plate1-sketch'), dimension: fixture('plate1-dimension'), extrude: fixture('plate1-extrude'), failure: fixture('plate1-failure') } : ({} as any);
// Every captured mark: the run's (1–13) and the failed commit's residue mark 22.
const allMarks = (): any[] => [...F.extrude.undo.marks, ...F.failure.undo.marks.filter((m: any) => !F.extrude.undo.marks.some((x: any) => x.mark_id === m.mark_id))];
// Which captured mark each step created, and which probe shows the objects it produced.
const STEP_MARK: Partial<Record<WriteStep, number>> = { sketchCreate: 3, sketchDraw: 4, sketchClose: 5, widthAdd: 6, heightAdd: 8, sketchFinish: 10, extrudeCommit: 13 };
const STEP_SOURCE: Record<WriteStep, keyof typeof F> = { sketchCreate: 'sketch', sketchDraw: 'sketch', sketchClose: 'sketch', widthAdd: 'dimension', heightAdd: 'dimension', sketchFinish: 'dimension', extrudeCreate: 'extrude', extrudeModify: 'extrude', extrudeCommit: 'extrude' };

/** A document state rebuilt from real fixtures, advanced one request at a time by the request's captured undo mark. */
class RealDoc {
  classes: Record<string, string>; objects: Record<string, string>; edges: string[]; markIds: number[]; redo = 0;
  constructor() { const i = F.idle; this.classes = { ...i.classes }; this.objects = { ...i.objects }; this.edges = [...i.edges]; this.markIds = i.undo.marks.map((m: any) => m.mark_id); }
  undoText() {
    const marks = this.markIds.map((id, k) => ({ ...allMarks().find((m) => m.mark_id === id), is_current: k === this.markIds.length - 1, queue_index: k }));
    return JSON.stringify({ can_redo_step: this.redo, can_undo_step: marks.length - 1, currentIndex: marks.length - 1, currentMarkId: this.markIds.at(-1), markNum: marks.length, marks });
  }
  snap(): StateSnap { return structuredClone({ undo: this.undoText(), classes: this.classes, objects: this.objects, edges: this.edges }); }
  apply(step: WriteStep) {
    const src = F[STEP_SOURCE[step]] as Fixture;
    const markId = STEP_MARK[step];
    if (markId === undefined) { this.bumpCounter(3); return; } // previews: the counter moves, nothing else (extrude→cancel probes)
    const mark = allMarks().find((m) => m.mark_id === markId);
    for (const e of mark.mark) {
      const h = String(e.obj_id);
      if (/VisuGeomObject/.test(e.class_name)) continue;
      if (e.change_type === 3 || e.change_type === 1) { if (src.objects[h] !== undefined) { this.classes[h] = src.classes[h]; this.objects[h] = src.objects[h]; } }
    }
    this.edges = src.edges.filter((e) => [...e.matchAll(/"(\d+)"/g)].slice(0, 2).every((m) => m[1] in this.classes || m[1] === '0'));
    // The sketch's needs-update bit (128), as Ivy sets it on solve-only requests and clears it on closing ones (seen
    // live in plate-trial-write2; the plate1 probes were all taken after closing steps, so they never show it set).
    const flag = ({ sketchDraw: true, widthAdd: true, heightAdd: true, sketchClose: false, sketchFinish: false } as Partial<Record<WriteStep, boolean>>)[step];
    if (flag !== undefined) for (const e of mark.mark) if (e.class_name === 'ivy::FeatSketch' && e.change_type === 1) {
      this.edit(String(e.obj_id), (j) => { const v = parseInt(j.attr_first_._featOptions, 2); j.attr_first_._featOptions = ((flag ? v | 128 : v & ~128) >>> 0).toString(2).padStart(16, '0'); });
    }
    this.markIds.push(markId);
  }
  bumpCounter(n: number) { const h = Object.keys(this.classes).find((k) => this.classes[k] === 'ivy::FeatContainer')!; const j = JSON.parse(this.objects[h]); j._lastId = String(Number(j._lastId) + n); this.objects[h] = JSON.stringify(j); }
  add(cls: string, h: string, json: Record<string, unknown> = {}) { this.classes[h] = cls; this.objects[h] = JSON.stringify({ class_name: cls, uuid: `x${h}`, ...json }); }
  edit(h: string, f: (j: any) => void) { const j = JSON.parse(this.objects[h]); f(j); this.objects[h] = JSON.stringify(j); }
}

// ------------------------------------------------------------------ captured traffic with our bytes on the wire

const WINDOWS: Record<WriteStep, [number, number]> = {
  sketchCreate: [113, 121], sketchDraw: [121, 133], sketchClose: [133, 195], widthAdd: [214, 219], heightAdd: [223, 228],
  sketchFinish: [236, 245], extrudeCreate: [297, 303], extrudeModify: [303, 311], extrudeCommit: [311, 336],
};
const IvyPkg = () => schema.IvyPkg.root.lookupType('ivyproto.IvyPkg');
/** The captured request frame re-sent with our body: same header (async id, project), field 100 = our bytes. */
function withBody(frame: any, body: Uint8Array, header?: (h: any) => void) {
  const pkg: any = IvyPkg().decode(Buffer.from(frame.payload, 'base64'));
  pkg.appModelReq = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq').decode(body);
  header?.(pkg.header);
  return { ...frame, payload: Buffer.from(IvyPkg().encode(pkg).finish()).toString('base64') };
}
/** Edits a received frame's decoded IvyPkg (zstd-decompressed and recompressed). */
function withPkg(frame: any, f: (pkg: any) => void) {
  const pkg: any = IvyPkg().decode(zlib.zstdDecompressSync(Buffer.from(frame.payload, 'base64'))); f(pkg);
  return { ...frame, payload: zlib.zstdCompressSync(Buffer.from(IvyPkg().encode(pkg).finish())).toString('base64') };
}
/** Edits a frame's header; received frames are zstd-compressed, so they are decompressed and recompressed. */
function withHeader(frame: any, f: (h: any) => void) {
  const raw = Buffer.from(frame.payload, 'base64');
  const plain = frame.dir === 'received' ? zlib.zstdDecompressSync(raw) : raw;
  const pkg: any = IvyPkg().decode(plain); f(pkg.header);
  const out = Buffer.from(IvyPkg().encode(pkg).finish());
  return { ...frame, payload: (frame.dir === 'received' ? zlib.zstdCompressSync(out) : out).toString('base64') };
}
const wireAsyncId = (frame: any) => String((IvyPkg().toObject(IvyPkg().decode(Buffer.from(frame.payload, 'base64')), { longs: String }) as any).header.asyncId);
const windowRecs = ([from, to]: [number, number]) => records.filter((r) => r.type === 'frame' && r.requestId === SOCKET && r.i >= from && r.i < to);

/** Edits the decoded model packages (PartPkg) of a received reply or notification frame. */
function withModel(frame: any, f: (model: any) => void) {
  const pkg: any = IvyPkg().decode(zlib.zstdDecompressSync(Buffer.from(frame.payload, 'base64')));
  const P = schema.PartPkg!;
  const holders = pkg.appModelRsp ? [pkg.appModelRsp] : (pkg.appModelNtf?.modelDescs ?? []).filter((d: any) => [1, 2].includes(Number(d.workbenchType)));
  for (const h of holders) if (h.modelPkg?.length) { const m: any = P.decode(h.modelPkg); f(m); h.modelPkg = P.encode(m).finish(); }
  return { ...frame, payload: zlib.zstdCompressSync(Buffer.from(IvyPkg().encode(pkg).finish())).toString('base64') };
}
/** Sets the depth parameter (role 31004) of feature `id` in a notification frame. */
const withDepth = (frame: any, id: number, value: string, formula: string) => withModel(frame, (m) => {
  for (const f of m.dataNtf?.features ?? []) if (Number(String(f.featureId)) === id) for (const a of f.featUpdateFeature.feat.attributes) if (Number(a.role) === 31004) { a.parm[0].value = value; a.parm[0].formula = formula; }
});
/** Appends raw protobuf bytes to a sent frame (extra top-level fields after header and body). */
const appendBytes = (frame: any, extra: Uint8Array) => ({ ...frame, payload: Buffer.concat([Buffer.from(frame.payload, 'base64'), extra]).toString('base64') });

type Tweak = {
  window?: (recs: any[], body: Uint8Array) => any[]; replyWindow?: [number, number]; send?: (wireId: string) => SendResult; sendThrows?: string;
  effect?: (d: RealDoc) => void; identity?: Partial<Identity>; identityThrows?: boolean; snapshotThrows?: 'before' | 'after'; settleThrows?: boolean; sinceThrows?: boolean;
  late?: (recs: any[]) => [any[], any[]]; tamper?: (body: Uint8Array) => Uint8Array; gapSinceThrows?: boolean;
  /** Happens BETWEEN the previous step's post-send inspection and this step's pre-send checks (at its first port call). */
  gap?: { recs?: () => any[]; doc?: (d: RealDoc) => void; /** recorded with their own indices (a reattached recorder) */ raw?: () => any[] };
  /** What the identity port's model-socket inventory returns before this step (default: complete, the bound socket). */
  sockets?: SocketInventory | 'throw' | null;
  /** What the server session list returns before this step's send / after it (default: exactly the bound session). */
  sessions?: unknown; sessionsAfter?: unknown;
  /** The recorder loses one record index while this step's window is recorded. */
  loseIndex?: boolean;
  /** Replaces the snapshot the state port returns before / after this step's send. */
  snapBefore?: (s: any) => any; snapAfter?: (s: any) => any;
};
type HarnessOpts = { /** traffic port = the real RecordStream */ stream?: boolean; /** the state port returns ONE object, mutated in place */ sharedSnap?: boolean; /** session list at finish() */ finalSessions?: unknown };
function harness(tweaks: Partial<Record<WriteStep, Tweak>> = {}, startDoc?: (d: RealDoc) => void, ho: HarnessOpts = {}) {
  const doc = new RealDoc(); startDoc?.(doc);
  // The recorder's append-only stream: each record gets the next index `i`; `cap` keeps the capture's own index.
  const live: any[] = []; let pending: any[] = []; let nextI = 0;
  const stream = new RecordStream();
  const push = (r: any) => { live.push(r); stream.write(r); };
  const record = (rs: any[], lose = false) => rs.forEach((r, k) => { if (lose && k === 1) nextI++; push({ ...r, cap: r.i, i: nextI++ }); });
  const shared: any = {};
  const sends: Array<{ cmd: number; field: number; body: Buffer }> = [];
  const calls = { identity: 0, state: 0, traffic: 0, since: 0, settle: 0 };
  const gapsDone = new Set<WriteStep>();
  const sessionLog: string[] = [];
  const nextStep = () => ALL[sends.length] as WriteStep;
  const curStep = () => ALL[sends.length - 1] as WriteStep;
  let afterPhase = false, postSend = false;
  const ports: GuardPorts = {
    sender: {
      async sendRaw(cmd, field, body) {
        sends.push({ cmd, field, body: Buffer.from(body) });
        const step = curStep(), tw = tweaks[step] ?? {};
        if (tw.sendThrows) throw new Error(tw.sendThrows);
        const recs = windowRecs(tw.replyWindow ?? WINDOWS[step]);
        const first = recs[0];
        const mine = withBody(first, body);
        let win = [mine, ...recs.slice(1)];
        if (tw.window) win = tw.window(win, body);
        const [now, later] = tw.late ? tw.late(win) : [win, []];
        record(pending); record(now, tw.loseIndex); pending = later;
        (tw.effect ?? ((d) => d.apply(step)))(doc);
        afterPhase = true; postSend = true;
        const wid = wireAsyncId(first);
        return tw.send ? tw.send(wid) : { ok: true, asyncId: String(Number(wid)) }; // the page reports Number(asyncId)
      },
    },
    identity: {
      async current() {
        calls.identity++;
        const step = nextStep(), tw = tweaks[step] ?? {};
        if (tw.gap && !gapsDone.has(step)) { gapsDone.add(step); record(tw.gap.recs?.() ?? []); (tw.gap.raw?.() ?? []).forEach(push); tw.gap.doc?.(doc); }
        if (tw.identityThrows) throw new Error('page unreachable');
        return { ...bound, ...(tw.identity ?? {}) };
      },
      async modelSockets() {
        calls.identity++;
        const tw = tweaks[nextStep()] ?? {};
        if (tw.sockets === 'throw') throw new Error('socket list unavailable');
        return tw.sockets === undefined ? { complete: true, modelSockets: [SOCKET] } : (tw.sockets as SocketInventory);
      },
      async sessions() {
        calls.identity++;
        const after = postSend; postSend = false;
        const step = after ? curStep() : nextStep();
        sessionLog.push(`${after ? 'after' : 'before'} ${step ?? 'finish'}`);
        const v = step === undefined ? ho.finalSessions : after ? tweaks[step]?.sessionsAfter : tweaks[step]?.sessions;
        if (v === 'throw') throw new Error('session list unavailable');
        return (v === undefined ? { sessions: [SESSION] } : v) as any;
      },
    },
    state: {
      async snapshot() {
        calls.state++;
        const step = afterPhase ? curStep() : nextStep(), phase = afterPhase ? 'after' : 'before';
        afterPhase = false;
        if (tweaks[step]?.snapshotThrows === phase) throw new Error(`inspector timed out (${phase} ${step})`);
        const f = phase === 'after' ? tweaks[step]?.snapAfter : tweaks[step]?.snapBefore;
        const s = f ? f(doc.snap()) : doc.snap();
        if (!ho.sharedSnap) return s;
        for (const k of Object.keys(shared)) delete shared[k];
        return Object.assign(shared, s);
      },
    },
    traffic: { position: () => { calls.traffic++; return ho.stream ? stream.position() : nextI; }, since: (p) => {
      calls.since++;
      if (afterPhase && tweaks[curStep()]?.sinceThrows) throw new Error('recorder gone');
      if (!afterPhase && tweaks[nextStep()]?.gapSinceThrows) throw new Error('recorder gone between steps');
      return ho.stream ? stream.since(p) : live.filter((r) => r.i >= p);
    } },
    settle: async () => { calls.settle++; if (tweaks[curStep()]?.settleThrows) throw new Error('settle failed'); },
  };
  /** The stream index of the last record copied from capture record (or synthetic record) `cap`. */
  const at = (cap: number) => [...live].reverse().find((r) => r.cap === cap)?.i;
  /** Records the frames a step's `late` tweak held back (they arrive after its settle). */
  const flushLate = () => { record(pending); pending = []; };
  return { ports, sends, calls, doc, live, at, shared, sessionLog, flushLate };
}

const lines = (template.bodies.sketchFinish as any).modelPkg.sketchUpdateReq.geoms.map((g: any) => [g.line.start.x ?? 0, g.line.start.y ?? 0, g.line.end.x ?? 0, g.line.end.y ?? 0]) as Lines;
const input: PlateInput = { workshopId: 1, docId: 540, tipFeatureId: 12, planeFeatureId: 3, sketchName: 'Sketch2', extrudeName: 'Extrude1', lines, width: 100, height: 60, depth: 8 };
const plan: Plan = { tipFeatureId: 12, planeFeatureId: 3, sketchName: 'Sketch2', extrudeName: 'Extrude1', lines, width: 100, height: 60, depth: 8 };

/** Runs the sequencer through the guard; tweaks may tamper with what the guard receives (a faulty builder). */
async function run(tweaks: Partial<Record<WriteStep, Tweak>> = {}, opts: { enabled?: boolean; startDoc?: (d: RealDoc) => void; plan?: Plan; input?: PlateInput } & HarnessOpts = {}) {
  const h = harness(tweaks, opts.startDoc, opts);
  const guard = new LiveWriteGuard(schema, h.ports, bound, opts.plan ?? plan, { enabled: opts.enabled ?? true });
  const transport: WriteTransport = { exchange: (s, b) => guard.exchange(s, tweaks[s]?.tamper ? tweaks[s]!.tamper!(b) : b), abort: (why) => guard.abort(why) };
  const out = await runPlateSequence(schema, transport, opts.input ?? input);
  return { ...h, guard, out, report: guard.report() };
}

/** Decode, edit and re-encode an app-model body (to simulate a faulty builder). */
function edit(body: Uint8Array, f: (req: any, part: any) => void): Uint8Array {
  const A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq'), P = schema.PartPkg!;
  const req: any = A.toObject(A.decode(body), { enums: String, longs: String });
  const part: any = P.toObject(P.decode(Buffer.from(req.modelPkg)), { enums: String, longs: String });
  f(req, part);
  req.modelPkg = P.encode(P.fromObject(part)).finish();
  return A.encode(A.fromObject(req)).finish();
}
const itemOf = (part: any, role: number) => part.featUpdateReq.updateItems.find((i: any) => Number(i.attrRole) === role);

// ------------------------------------------------------------------ evidence

describe.skipIf(!ready)('evidence the rules are taken from', () => {
  it('EXPECTED_MARKS equal the non-visual entries of the captured per-request undo marks', () => {
    for (const [step, id] of Object.entries(STEP_MARK)) {
      const sig: Record<string, number> = {};
      for (const e of allMarks().find((m) => m.mark_id === id).mark) if (!/VisuGeomObject|PipelineContext/.test(e.class_name)) sig[`${e.class_name}/${e.change_type}`] = (sig[`${e.class_name}/${e.change_type}`] ?? 0) + 1;
      expect(sig, `${step} = mark ${id}`).toEqual(EXPECTED_MARKS[step as WriteStep]);
    }
  });
  it('the real failed commit is rejected as a commit and as a no-change step', () => {
    const snap = (l: string): StateSnap => { const f = fixture(l); return { undo: JSON.stringify(f.undo), classes: f.classes, objects: f.objects, edges: f.edges }; };
    expect(checkStateChange('extrudeCommit', snap('plate1-cancel'), snap('plate1-failure')).join()).toMatch(/expected one new undo step.*redo 1/);
    expect(checkStateChange('noChange', snap('plate1-cancel'), snap('plate1-failure')).join()).toMatch(/undo history changed/);
    expect(checkStateChange('noChange', snap('plate1-extrude'), snap('plate1-cancel'))).toEqual([]);
  });
});

// ------------------------------------------------------------------ guard behaviour

describe.skipIf(!ready)('LiveWriteGuard', () => {
  it('is disabled by default: refused, nothing sent, no port touched', async () => {
    const r = await run({}, { enabled: false });
    expect(r.out).toMatchObject({ status: 'refused', sent: [], possibleHiddenResidue: false });
    expect(r.sends).toEqual([]);
    expect(r.calls).toEqual({ identity: 0, state: 0, traffic: 0, since: 0, settle: 0 });
  });

  it('carries the nine steps once each, verified against the real per-request evidence', async () => {
    const r = await run();
    expect(r.out).toEqual({ status: 'completed', sent: ALL, created: { sketchFeatureId: 15, previewFeatureId: -2, extrudeFeatureId: 43 }, possibleHiddenResidue: false });
    expect(r.report).toMatchObject({ completed: ALL, possibleHiddenResidue: false });
    expect(r.report.aborted).toBeUndefined();
    expect(r.sends.map((s) => [s.cmd, s.field])).toEqual(ALL.map(() => [120, 100]));
    // one run-wide cursor: position() starts it once; every later read continues from where the last one ended
    expect(r.calls).toMatchObject({ traffic: 1, since: 2 * ALL.length - 1 });
  });

  // B1 -------------------------------------------------------------
  const geomBodyFor = (step: 'sketchClose') => buildSketchStep(schema, step, { workshopId: 1, docId: 540, sketchFeatureId: 15, planeFeatureId: 3, lines, width: 100, height: 60 }).body;
  it('correlates by wire bytes when the page’s Number-rounded id differs from the wire id (real replay-measure1 values)', async () => {
    const wire = '193457812480010144', page = '193457812480010140'; // replay-measure1: page result vs frame header
    expect(page).not.toBe(wire);
    expect(Number(page)).toBe(Number(wire));
    const restamp = (recs: any[]) => recs.map((x) => (x.i === 113 || x.i === 114 ? withHeader(x, (h) => { h.asyncId = wire; }) : x));
    const r = await run({ sketchCreate: { window: restamp, send: () => ({ ok: true, asyncId: page }) } });
    expect(r.out.status).toBe('completed');
    expect(r.report.steps[0]).toMatchObject({ wireAsyncId: wire, pageAsyncId: page, outcome: 'verified' });
  });
  it('rejects a page id that does not even match the wire id numerically', async () => {
    const r = await run({ sketchCreate: { send: () => ({ ok: true, asyncId: '42' }) } });
    expect(r.out.reason).toMatch(/page async id 42 does not match/);
  });
  it.each([
    ['missing from the wire', (w: any[]) => w.slice(1), /not on the wire with the checked bytes/],
    ['sent twice', (w: any[]) => [w[0], { ...w[0], i: 9001 }, ...w.slice(1)], /2 copies of the request on the wire/],
    ['different bytes under the same id', (w: any[]) => [withBody(w[0], geomBodyFor('sketchClose')), ...w.slice(1)], /not on the wire with the checked bytes/],
    ['for another project', (w: any[]) => [withHeader(w[0], (h) => { h.projectId = 99; }), ...w.slice(1)], /wire request is for project 99/],
    ['under another command', (w: any[]) => [withHeader(w[0], (h) => { h.cmd = 'IVY_QUERY_REQ'; }), ...w.slice(1)], /not on the wire/],
  ])('fails when the request is %s', async (_n, window, re) => {
    const r = await run({ sketchDraw: { window: window as any } });
    expect(r.out.status).toBe('unknown');
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(2);
    expect(r.report.possibleHiddenResidue).toBe(true);
  });

  // B2 + latch ------------------------------------------------------
  it.each([
    ['the send throws', { sendThrows: 'socket gone' }, /send failed: socket gone/],
    ['settle throws', { settleThrows: true }, /post-send traffic check failed: settle failed/],
    ['the traffic source throws', { sinceThrows: true }, /post-send traffic check failed: recorder gone/],
    ['the state snapshot throws after the commit', { snapshotThrows: 'after' }, /state not verified: inspector timed out \(after extrudeCommit\)/],
  ] as const)('an exception after sending (%s) is an unknown outcome, never “completed”', async (_n, tw, re) => {
    const r = await run({ extrudeCommit: tw as Tweak });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.out.reason).toMatch(re);
    expect(r.report.completed).not.toContain('extrudeCommit');
    expect(r.report.steps.at(-1)).toMatchObject({ step: 'extrudeCommit', sent: true, outcome: 'unknown' });
    expect(r.report.steps.at(-1)!.error).toBeTruthy();
    expect(r.report.possibleHiddenResidue).toBe(true);
    expect(r.report.aborted).toMatch(/extrudeCommit unknown/);
    expect(r.report.lastState?.observedAfter).not.toBe('extrudeCommit');
  });
  it.each([['identity', { identityThrows: true }], ['state', { snapshotThrows: 'before' }], ['traffic (between steps)', { gapSinceThrows: true }]] as const)('a %s failure before sending refuses without sending', async (_n, tw) => {
    const r = await run({ widthAdd: tw as Tweak });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(/widthAdd: not sent: pre-send check failed/);
    expect(r.sends).toHaveLength(3);
  });
  it('latches: after any failure every further exchange is refused without touching a port', async () => {
    const h = harness({ sketchDraw: { window: (w) => w.slice(1) } });
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    const out = await runPlateSequence(schema, g, input);
    expect(out.status).toBe('unknown');
    const before = { ...h.calls }, sent = h.sends.length;
    const again = await g.exchange('sketchClose', buildSketchStep(schema, 'sketchClose', { workshopId: 1, docId: 540, sketchFeatureId: 15, planeFeatureId: 3, lines, width: 100, height: 60 }).body);
    expect(again.notSent).toBe(true);
    expect(again.unexpected.join()).toMatch(/run aborted earlier/);
    expect(h.calls).toEqual(before);
    expect(h.sends).toHaveLength(sent);
  });

  // error replies --------------------------------------------------
  it('an error reply (real 32000) still gets a state inspection, and anomalies are reported', async () => {
    const failRedo = (d: RealDoc) => { d.markIds.push(22); d.redo = 1; }; // what the real failed commit did (cancel→failure)
    const r = await run({ extrudeCommit: { replyWindow: [458, 470], effect: failRedo } });
    expect(r.out.status).toBe('unknown'); // the error reply left an undo change: it partly ran
    expect(r.out.reason).toMatch(/extrudeCommit: outcome unknown \(error result 32000/);
    const last = r.report.steps.at(-1)!;
    expect(last.outcome).toBe('unknown');
    expect(last.problems).toEqual(['error result 32000', 'after error: undo history changed although this step must not record one']);
    expect(last.undoAfter?.canRedo).toBe(1);
    expect(r.report).toMatchObject({ possibleHiddenResidue: true });
  });
  it('an error reply with no inspectable state reports that verification could not be completed', async () => {
    const r = await run({ extrudeModify: { replyWindow: [454, 458], effect: () => {}, snapshotThrows: 'after' } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)!.problems.join()).toMatch(/error result 32000.*state not verified/);
  });

  // plan values (a faulty builder upstream of the guard) ----------------
  const geomBody = (step: 'sketchDraw' | 'widthAdd' | 'heightAdd', l: Lines, w: number, hgt: number) =>
    buildSketchStep(schema, step, { workshopId: 1, docId: 540, sketchFeatureId: 15, planeFeatureId: 3, lines: l, width: w, height: hgt }).body;
  it.each([
    ['wrong height', 'heightAdd', () => geomBody('heightAdd', rectLines(lines[3][0], lines[3][1], 100, 70), 100, 70), /constraint 9 is not DISTANCE_Y = 60/],
    ['shifted coordinates', 'sketchDraw', () => geomBody('sketchDraw', rectLines(lines[3][0] + 1, lines[3][1], 100, 60), 100, 60), /line 0 is not the planned line/],
  ] as const)('refuses %s before sending', async (_n, step, make, re) => {
    const r = await run({ [step]: { tamper: () => make() } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(ALL.indexOf(step));
  });
  it('refuses a width dimension of 120 on the planned 100-wide lines (the lines alone are right)', async () => {
    const r = await run({ widthAdd: { tamper: (b) => edit(b, (_q, p) => { p.sketchUpdateReq.constraints[8].constraint.value = 120; }) } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(/constraint 8 is not DISTANCE_X = 100/);
    expect(r.out.reason).not.toMatch(/line \d|direction/);
    expect(r.sends).toHaveLength(ALL.indexOf('widthAdd'));
  });
  it.each([
    ['wrong depth', (b: Uint8Array) => edit(b, (_q, p) => { const it = itemOf(p, 31004).parmObjects.items[0]; it.value = '9'; }), /depth item is not 8/],
    ['an extra parameter entry', (b: Uint8Array) => edit(b, (_q, p) => { const it = itemOf(p, 31010).parmObjects; it.items.push({ ...it.items[0] }); }), /^extrudeModify: not sent: extrudeModify: parameter field modelPkg\.featUpdateReq\.updateItems\.14\.parmObjects\.items\.1\.featId is not in the captured request; /],
    ['a changed parameter type', (b: Uint8Array) => edit(b, (_q, p) => { itemOf(p, 31010).parmObjects.items[0].type = 'tAngle'; }), /field modelPkg\.featUpdateReq\.updateItems\.14\.parmObjects\.items\.0\.type differs from the captured request \("tLength" → "tAngle"\)/], // item 14 = role 31010
    ['an unsupported unit', (b: Uint8Array) => edit(b, (_q, p) => { itemOf(p, 31010).parmObjects.items[0].unit = 'mm'; }), /unsupported type\/unit/],
    ['a parameter id not from the preview', (b: Uint8Array) => edit(b, (_q, p) => { itemOf(p, 31010).parmObjects.items[0].featId = '999'; }), /role 31010 parameter 0 is not the preview's/],
    ['another feature name', (b: Uint8Array) => edit(b, (_q, p) => { p.header.featureName = 'Extrude2'; }), /not the planned Extrude1/],
    ['another preview id', (b: Uint8Array) => edit(b, (q, p) => { q.workshopHead.featureId = -3; p.featUpdateReq.header.featureId = -3; }), /not aimed at preview -2/],
    ['a wrong tip', (b: Uint8Array) => edit(b, (_q, p) => { p.header.tipFeatureId = '12'; }), /tip 12 is not the sketch 15/],
    ['a wrong part command', (b: Uint8Array) => edit(b, (_q, p) => { p.header.cmd = 'IVY_PART_DELETE_REQ'; }), /^extrudeModify: not sent: extrudeModify: field modelPkg\.header\.cmd differs from the captured request \("IVY_PART_FEAT_UPDATE_UPDATE_REQ" → "IVY_PART_DELETE_REQ"\)$/],
  ] as const)('refuses an extrude Modify with %s before sending', async (_n, tamper, re) => {
    const r = await run({ extrudeModify: { tamper } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(7);
  });
  it('refuses a commit whose depth item is not the one the Modify sent', async () => {
    const r = await run({ extrudeCommit: { tamper: (b) => edit(b, (_q, p) => { itemOf(p, 31004).parmObjects.items[0].featId = '28'; }) } });
    expect(r.out.reason).toMatch(/depth item is not the one the Modify sent/);
    expect(r.sends).toHaveLength(8);
  });
  it.each([
    ['another plane', (b: Uint8Array) => edit(b, (_q, p) => { p.sketchUpdateReq.supportBrep.featureId = 5; }), /sketchCreate: not on the planned plane/],
    ['another start tip', (b: Uint8Array) => edit(b, (_q, p) => { p.header.tipFeatureId = '13'; }), /sketchCreate: tip 13 is not the planned 12/],
    ['another document', (b: Uint8Array) => edit(b, (q) => { q.workshopHead.currentDocId = 541; }), /sketchCreate: targets workshop 1 \/ document 541, not 1 \/ 540/],
  ])('refuses a sketch on %s, before any port is touched', async (_n, tamper, re) => {
    const r = await run({ sketchCreate: { tamper } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(0);
    expect(r.calls).toEqual({ identity: 0, state: 0, traffic: 0, since: 0, settle: 0 });
  });

  // state ---------------------------------------------------------
  it.each([
    ['an extra object of an allowed class', 'widthAdd', (d: RealDoc) => { d.apply('widthAdd'); d.add('ivy::ParmLength', '9101'); }, /unexpected new ivy::ParmLength #9101/],
    ['an unexpected dependency edge', 'extrudeCommit', (d: RealDoc) => { d.apply('extrudeCommit'); d.edges.push('"635" -> "537" [label="DependsOn", color="#000"]'); }, /unexpected edge: "635" -> "537"/],
    ['a removed edge', 'sketchClose', (d: RealDoc) => { d.apply('sketchClose'); d.edges = d.edges.filter((e) => !e.startsWith('"535" -> "543"')); }, /edge removed/],
    ['the wrong undo mark (the UI value-edit mark 7 for the width step)', 'widthAdd', (d: RealDoc) => { d.apply('widthAdd'); d.markIds[d.markIds.length - 1] = 7; }, /undo mark: ivy::SketchLengthDimension\/3 ×0, captured ×1/],
    ['a change to another sketch (hidden by class aggregation before)', 'extrudeCommit', (d: RealDoc) => { d.apply('extrudeCommit'); d.edit('537', (j) => { j.attr_first_._featOptions = '1111111111111111'; }); }, /unexpected change to ivy::FeatSketch #537/],
    ['a visible change to the part body set', 'sketchClose', (d: RealDoc) => { d.apply('sketchClose'); d.edit('535', (j) => { j.attr_first_._name = 'Renamed'; }); }, /unexpected change to ivy::FeatSolidSet #535/],
    ['a preview that records an undo mark', 'extrudeModify', (d: RealDoc) => { d.markIds.push(13); }, /undo history changed/],
    ['an id counter that goes backwards', 'extrudeCreate', (d: RealDoc) => { d.bumpCounter(-5); }, /id counter went backwards/],
  ] as const)('stops on %s', async (_n, step, effect, re) => {
    const r = await run({ [step]: { effect } });
    expect(r.out.status).toBe('unknown');
    expect(r.out.reason).toMatch(re);
    expect(r.report.possibleHiddenResidue).toBe(true);
    expect(r.sends).toHaveLength(ALL.indexOf(step) + 1);
  });
  it('refuses to start when the document has redo history', async () => {
    const r = await run({}, { startDoc: (d) => { d.redo = 1; } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(/redo entr/);
    expect(r.sends).toHaveLength(0);
  });

  // traffic / lifecycle --------------------------------------------
  it('keeps the page’s requests across steps: a tessellation reply arriving one step late is page traffic', async () => {
    const r = await run({ sketchFinish: { late: (w) => [w.filter((x) => x.i !== 244), w.filter((x) => x.i === 244)] } });
    expect(r.out.status).toBe('completed');
  });
  it.each([
    ['the model socket closes', { i: 9001, t: 0, type: 'closed', requestId: SOCKET, ts: 0 }],
    ['a new model socket opens (reconnect)', { i: 9002, t: 0, type: 'socket', requestId: '40700.7777', url: 'ws://127.0.0.1:8081/zcad/client?projectId=37649921' }],
    ['the model socket reports a frame error', { i: 9003, t: 0, type: 'frame_error', requestId: SOCKET, ts: 0, message: 'x' }],
  ])('stops when %s during a step', async (_n, extra) => {
    const r = await run({ sketchDraw: { window: (w) => [...w, extra] } });
    expect(r.out.reason).toMatch(/model socket closed, failed or reconnected/);
    expect(r.sends).toHaveLength(2);
  });
  it.each([
    ['an unrelated model request', (w: any[]) => [...w, records.find((x) => x.i === 303)], /unexpected sent IVY_APP_MODEL_REQ/],
    ['a duplicated reply', (w: any[]) => [...w, w.find((x) => x.i === 123)], /2 replies for one request/],
    ['a reply nobody asked for', (w: any[]) => [...w, records.find((x) => x.i === 312)], /unexpected received IVY_APP_MODEL_RSP/],
    ['a missing reply', (w: any[]) => w.filter((x) => x.i !== 123), /no reply/],
  ])('stops on %s', async (_n, window, re) => {
    const r = await run({ sketchDraw: { window: window as any } });
    expect(r.out.status).toBe('unknown');
    expect(r.out.reason).toMatch(re);
  });
  it('a reply that arrives only after the settle window is treated as missing (fail closed), deterministically', async () => {
    const r = await run({ sketchDraw: { late: (w) => [w.filter((x) => x.i !== 123), w.filter((x) => x.i === 123)] } });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.out.reason).toMatch(/sketchDraw: outcome unknown \(no reply to the request/);
    expect(r.sends).toHaveLength(2);
    expect(r.report.aborted).toBeTruthy();
  });
  it('a preview notification that arrives after the settle window stops the run', async () => {
    const r = await run({ extrudeCreate: { late: (w) => [w.filter((x) => x.i !== 299), w.filter((x) => x.i === 299)] } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)!.problems).toEqual(['extrudeCreate: 0 notifications, captured exactly one preview notification']);
    expect(r.sends).toHaveLength(7);
  });
  it('refuses when the identity changes between steps, compared field by field', async () => {
    for (const id of [{ docId: 541 }, { modelSocket: '40700.9999' }, { projectTag: 'branch' }]) {
      const r = await run({ heightAdd: { identity: id } });
      expect(r.out.reason).toMatch(/heightAdd: not sent: identity changed/);
      expect(r.sends).toHaveLength(4);
    }
  });
  it('accepts the bound identity whatever its key order', async () => {
    const r = await run({ sketchCreate: { identity: { modelSocket: SOCKET, docId: 540, workshopId: 1, projectTag: 'main', projectId: 37649921 } } });
    expect(r.out.status).toBe('completed');
  });

  // no other operation ------------------------------------------------
  it('never sends anything but the nine app-model write requests; there is no undo, cancel or delete', async () => {
    const r = await run({ extrudeCommit: { sendThrows: 'x' } });
    const P = schema.PartPkg!, A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq');
    for (const s of r.sends) expect(['IVY_PART_SKETCH_UPDATE_REQ', 'IVY_PART_FEAT_UPDATE_UPDATE_REQ']).toContain((P.toObject(P.decode((A.decode(s.body) as any).modelPkg), { enums: String }) as any).header.cmd);
    expect(r.sends).toHaveLength(9);
    expect(Object.getOwnPropertyNames(LiveWriteGuard.prototype).sort()).toEqual(['abort', 'constructor', 'exchange', 'finish', 'report']); // abort only latches; finish only reads
  });
  it('refuses a step out of order or sent twice', async () => {
    const h = harness();
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    expect((await g.exchange('sketchDraw', new Uint8Array())).notSent).toBe(true);
    expect(h.sends).toHaveLength(0);
    const h2 = harness();
    const g2 = new LiveWriteGuard(schema, h2.ports, bound, plan, { enabled: true });
    const out = await runPlateSequence(schema, g2, input);
    expect(out.status).toBe('completed');
    expect((await g2.exchange('extrudeCommit', new Uint8Array())).notSent).toBe(true);
    expect(h2.sends).toHaveLength(9);
  });
  it('a Modify built for a different depth is refused (plan binding, not the builder)', async () => {
    const r = await run({}, { input: { ...input, depth: 9 } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(/depth item is not 8/);
    expect(r.sends).toHaveLength(7);
    void buildExtrudeModify;
  });
});

// ------------------------------------------------------------------ review hardening (each case targets one new branch)

describe.skipIf(!ready)('LiveWriteGuard: traffic and state between steps, overlap, depth, reply identity, plan, frame', () => {
  const frame = (i: number) => records.find((x) => x.i === i);
  const NO_PORT = { identity: 0, state: 0, traffic: 0, since: 0, settle: 0 };
  const createBody = () => buildSketchCreate(schema, { workshopId: 1, docId: 540, tipFeatureId: 12, sketchName: 'Sketch2', planeFeatureId: 3 }).body;
  const closeBody = () => buildSketchStep(schema, 'sketchClose', { workshopId: 1, docId: 540, sketchFeatureId: 15, planeFeatureId: 3, lines, width: 100, height: 60 }).body;

  // 1. one run-wide traffic cursor: records between steps are classified before the next send
  // Each case states the guard's complete problem list; `at(n)` is the stream index of captured/synthetic record n.
  const other = '40700.5091'; // the page's session-gate socket (captured record 33)
  it.each([
    ['an unrelated reply', () => [frame(312)], (at: (n: number) => number) => [`unexpected received IVY_APP_MODEL_RSP at ${at(312)}`]],
    ['a duplicate of the previous step’s reply', () => [frame(123)], (at: (n: number) => number) => [`late or duplicate reply to an earlier request at ${at(123)}`]],
    ['an outgoing model write', () => [frame(303)], (at: (n: number) => number) => [`unexpected sent IVY_APP_MODEL_REQ at ${at(303)}`]],
    ['a model notification', () => [frame(124)], (at: (n: number) => number) => [`model notification between steps at ${at(124)}`]],
    ['a page reply nobody asked for', () => [frame(244)], (at: (n: number) => number) => [`unexpected received IVY_GET_TESSELLATION_RSP at ${at(244)}`]],
    ['the model socket closing', () => [{ i: 9001, t: 0, type: 'closed', requestId: SOCKET, ts: 0 }], (at: (n: number) => number) => [`the model socket closed, failed or reconnected (closed at ${at(9001)})`]],
    ['a model socket frame error', () => [{ i: 9002, t: 0, type: 'frame_error', requestId: SOCKET, ts: 0, message: 'x' }], (at: (n: number) => number) => [`the model socket closed, failed or reconnected (frame_error at ${at(9002)})`]],
    ['a reconnect', () => [{ i: 9003, t: 0, type: 'socket', requestId: '40700.7777', url: 'ws://127.0.0.1:8081/zcad/client?projectId=37649921' }], (at: (n: number) => number) => [`the model socket closed, failed or reconnected (new model socket at ${at(9003)})`]],
    ['an unrecognized record', () => [{ i: 9004, t: 0, type: 'weird' }], (at: (n: number) => number) => [`unrecognized record type weird at ${at(9004)}`]],
    ['another socket opening', () => [{ i: 9005, t: 0, type: 'socket', requestId: '40700.8888', url: 'wss://example.invalid/ws' }], (at: (n: number) => number) => [`a new socket opened during the run at ${at(9005)}`]],
    ['another socket closing', () => [{ i: 9006, t: 0, type: 'closed', requestId: other, ts: 0 }], (at: (n: number) => number) => [`socket ${other}: closed during the run at ${at(9006)}`]],
    ['a control frame on the model socket', () => [{ ...frame(126), i: 9007, opcode: 9, payload: '' }], (at: (n: number) => number) => [`unsupported opcode 9 on the model socket at ${at(9007)}`]],
    ['an empty binary frame on the model socket', () => [{ ...frame(123), i: 9008, payload: '' }], (at: (n: number) => number) => [`empty binary frame on the model socket at ${at(9008)}`]],
    ['a received text frame', () => [{ ...frame(126), i: 9009, dir: 'received' }], (at: (n: number) => number) => [`unexpected received text frame at ${at(9009)}`]],
    ['a sent text frame that is not the ping', () => [{ ...frame(126), i: 9010, payload: '{"requestId":"1","command":"save","body":{"timestamp":"x"}}' }], (at: (n: number) => number) => [`unexpected sent text frame at ${at(9010)}`]],
    ['a mesh frame no tessellation request asked for', () => [frame(140)], (at: (n: number) => number) => [`unexpected or malformed mesh frame at ${at(140)}`]],
    ['a malformed mesh frame', () => [{ ...frame(140), i: 9011, payload: Buffer.from(frame(140).payload, 'base64').subarray(0, 80).toString('base64') }], (at: (n: number) => number) => [`unexpected or malformed mesh frame at ${at(9011)}`]],
  ])('refuses the next step when %s arrives between steps', async (_n, recs, problems) => {
    const r = await run({ sketchClose: { gap: { recs } } });
    expect(r.out.status).toBe('refused');
    expect(r.report.steps.at(-1)).toMatchObject({ step: 'sketchClose', sent: false, outcome: 'refused' });
    expect(r.report.steps.at(-1)!.problems).toEqual(problems((n) => r.at(n)!).map((p) => `traffic since sketchDraw: ${p}`));
    expect(r.sends).toHaveLength(2); // sketchClose never reached the sender
    expect(r.report).toMatchObject({ completed: ['sketchCreate', 'sketchDraw'], possibleHiddenResidue: true });
  });
  it('accepts frames of the page’s other sockets between steps (not Ivy model traffic; not inspected)', async () => {
    const r = await run({ sketchClose: { gap: { recs: () => [{ ...frame(126), i: 9012, requestId: other, payload: 'anything' }] } } });
    expect(r.out.status).toBe('completed');
  });
  it('refuses the next step when a record index is missing from the stream (a lost record)', async () => {
    const r = await run({ sketchDraw: { loseIndex: true } });
    expect(r.out.status).toBe('unknown');
    const first = r.live.find((x) => x.cap === 121)!.i;
    expect(r.report.steps.at(-1)!.problems).toEqual([`traffic record ${first + 2} where ${first + 1} was expected: records were lost, reordered or renumbered`]);
    expect(r.sends).toHaveLength(2);
  });
  it('accepts page traffic between steps: a page request’s reply arriving in the gap', async () => {
    const r = await run({ sketchFinish: { window: (w) => w.filter((x) => x.i !== 244) }, extrudeCreate: { gap: { recs: () => [frame(244)] } } });
    expect(r.out.status).toBe('completed');
  });
  it.each([
    ['answered twice in the gap', { sketchFinish: { window: (w: any[]) => w.filter((x) => x.i !== 244) }, extrudeCreate: { gap: { recs: () => [frame(244), frame(244)] } } }],
    ['already answered in its own window', { extrudeCreate: { gap: { recs: () => [frame(244)] } } }],
  ])('an old page reply is not accepted again: %s', async (_n, tweaks) => {
    const r = await run(tweaks as any);
    expect(r.out.status).toBe('refused');
    expect(r.report.steps.at(-1)!.problems).toEqual([`traffic since sketchFinish: unexpected received IVY_GET_TESSELLATION_RSP at ${r.at(244)}`]);
    expect(r.sends).toHaveLength(6);
  });

  // 2. drift between verified steps
  it.each([
    ['one object changed', (d: RealDoc) => d.edit('535', (j) => { j.attr_first_._name = 'Renamed'; }), /object ivy::FeatSolidSet #535 changed/],
    ['one object added', (d: RealDoc) => d.add('ivy::ParmLength', '9200'), /new object ivy::ParmLength #9200/],
    ['a visualisation object added (not exempt between steps)', (d: RealDoc) => d.add('ivy::VisuGeomObject', '9300'), /new object ivy::VisuGeomObject #9300/],
    ['one edge removed', (d: RealDoc) => { d.edges = d.edges.slice(1); }, /edge removed: /],
    ['one edge added', (d: RealDoc) => { d.edges.push('"535" -> "9999" [label="DependsOn", color="#000"]'); }, /edge added: "535" -> "9999"/],
    ['an unparsable edge', (d: RealDoc) => { d.edges.push('garbage'); }, /unparsable edge in the current state: garbage/],
    ['the undo signature', (d: RealDoc) => { d.markIds.push(7); }, /undo history changed \(undo \d+→\d+, redo 0→0, marks [\d,]+→[\d,]+,7\)/],
    ['the redo count', (d: RealDoc) => { d.redo = 1; }, /undo history changed \(undo \d+→\d+, redo 0→1/],
  ])('refuses the next step after drift between steps: %s', async (_n, change, re) => {
    const r = await run({ extrudeCreate: { gap: { doc: change } } });
    expect(r.out.status).toBe('refused');
    expect(r.out.reason).toMatch(/extrudeCreate: not sent: state drift since sketchFinish: /);
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(6);
  });
  it('ignores only the documented exemption between steps (a PipelineContext object)', async () => {
    const r = await run({ extrudeCreate: { gap: { doc: (d) => d.add('ivy::PipelineContext', '9400') } } });
    expect(r.out.status).toBe('completed');
  });
  it('an unparsable edge is a problem in the per-step check too, never silently dropped', () => {
    const f = fixture('plate1-idle');
    const s: StateSnap = { undo: JSON.stringify(f.undo), classes: f.classes, objects: f.objects, edges: f.edges };
    const t = { ...s, edges: [...s.edges, 'garbage'] };
    expect(checkStateChange('noChange', s, t).join()).toMatch(/unparsable edge in the after state: garbage/);
    expect(checkDrift(s, s)).toEqual([]);
  });

  // 3. overlapping calls, repeated steps, caller buffers
  it('refuses overlapping calls: neither the second nor the suspended first reaches the sender', async () => {
    const h = harness();
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    const first = g.exchange('sketchCreate', createBody());
    const second = g.exchange('sketchCreate', createBody());
    const third = g.exchange('sketchDraw', createBody());
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(b).toMatchObject({ notSent: true });
    expect(b.unexpected.join()).toMatch(/sketchCreate is still in flight/);
    expect(c.notSent).toBe(true);
    expect(a.notSent).toBe(true);
    expect(a.unexpected.join()).toMatch(/run aborted while sketchCreate was being checked/);
    expect(h.sends).toHaveLength(0);
    expect(g.report().completed).toEqual([]);
  });
  it('a step refused before sending cannot be retried', async () => {
    const h = harness({ sketchCreate: { identityThrows: true } });
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    expect((await g.exchange('sketchCreate', createBody())).unexpected.join()).toMatch(/pre-send check failed/);
    const before = { ...h.calls };
    const again = await g.exchange('sketchCreate', createBody());
    expect(again.unexpected.join()).toMatch(/run aborted earlier/);
    expect(h.calls).toEqual(before);
    expect(h.sends).toHaveLength(0);
  });
  it('sends and matches the bytes it checked, even when the caller changes its buffer while the call is suspended', async () => {
    const h = harness();
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    const buf = createBody(), original = Buffer.from(buf);
    const pending = g.exchange('sketchCreate', buf);
    buf.fill(0); // the call is suspended at its first port call
    const t = await pending;
    expect(t.notSent).toBeUndefined();
    expect(h.sends[0].body.equals(original)).toBe(true);
    expect(g.report().steps[0]).toMatchObject({ step: 'sketchCreate', outcome: 'verified' });
  });

  // 4. depth as Ivy reports it
  it('stops when the preview after the Modify still reports depth 10 (plan 8); the commit is never sent', async () => {
    const r = await run({ extrudeModify: { window: (w) => w.map((x) => (x.i === 305 ? withDepth(x, -2, '10.000000', '10') : x)) } });
    expect(r.out.status).toBe('unknown');
    expect(r.out.reason).toMatch(/preview depth: feature -2 reports depth 10\.000000 \(formula 10\), the plan is 8/);
    expect(r.sends).toHaveLength(8);
    expect(r.report.completed).toEqual(ALL.slice(0, 7));
  });
  it('the committed feature reporting another depth is an unknown outcome, not completion', async () => {
    const r = await run({ extrudeCommit: { window: (w) => w.map((x) => (x.i === 313 ? withDepth(x, 43, '9.000000', '9') : x)) } });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.out.reason).toMatch(/committed feature depth: feature 43 reports depth 9\.000000/);
    expect(r.report.completed).not.toContain('extrudeCommit');
  });
  describe('checkReportedDepth on the captured notifications', () => {
    const ntfAt = (i: number) => (decodeCapture(records.filter((r) => r.i === i), schema)[0] as any).pkg;
    const depthAttrs = (n: any) => n.appModelNtf.modelDescs.flatMap((d: any) => d.modelPkgDecoded?.dataNtf?.features ?? []).find((f: any) => Number(f.featureId) === -2).featUpdateFeature.feat.attributes;
    const with305 = (f: (attrs: any[]) => void) => { const n = structuredClone(ntfAt(305)); f(depthAttrs(n)); return [n]; };
    const d = (attrs: any[]) => attrs.find((a) => Number(a.role) === 31004);
    it('accepts 305 (preview -2) and 313 (feature 43) at depth 8', () => {
      expect(checkReportedDepth([ntfAt(305)], -2, 8, 'preview')).toEqual([]);
      expect(checkReportedDepth([ntfAt(313)], 43, 8, 'committed feature')).toEqual([]);
      expect(checkReportedDepth([ntfAt(299)], -2, 8, 'preview').join()).toMatch(/reports depth 10\.000000/); // the pre-Modify preview
    });
    it.each([
      ['no notification', () => [], -2, /found 0/],
      ['another feature', () => [ntfAt(305)], -3, /found 0/],
      ['the feature twice', () => [ntfAt(305), ntfAt(305)], -2, /found 2/],
      ['no depth role', () => with305((a) => { d(a).role = 31005; }), -2, /has 0 depth attributes/],
      ['two depth attributes', () => with305((a) => { a.push(structuredClone(d(a))); }), -2, /has 2 depth attributes/],
      ['two depth parameters', () => with305((a) => { d(a).parm.push(structuredClone(d(a).parm[0])); }), -2, /has 2 depth parameters/],
      ['a non-numeric value', () => with305((a) => { d(a).parm[0].value = 'abc'; }), -2, /malformed depth parameter/],
      ['an empty formula', () => with305((a) => { d(a).parm[0].formula = ''; }), -2, /malformed depth parameter/],
      ['another parameter type', () => with305((a) => { d(a).parm[0].type = 'tAngle'; }), -2, /malformed depth parameter/],
      ['a formula disagreeing with the value', () => with305((a) => { d(a).parm[0].formula = '10'; }), -2, /reports depth 8\.000000 \(formula 10\)/],
    ] as const)('rejects %s', (_n, ntfs, id, re) => {
      expect(checkReportedDepth(ntfs() as any[], id, 8, 'preview').join()).toMatch(re);
    });
  });

  // 5. reply identity, and the guard agreeing with the sequencer
  it.each([
    ['names another feature (16)', (x: any) => withModel(x, (m) => { m.header.featureId = 16; }), /reply names feature 16, expected sketch 15/],
    ['is of another feature type', (x: any) => withModel(x, (m) => { m.header.featureType = 'ivy::SolidExtrude'; }), /reply is IVY_PART_SKETCH_UPDATE_RSP \/ ivy::SolidExtrude, expected IVY_PART_SKETCH_UPDATE_RSP \/ ivy::FeatSketch/],
    ['is for another document', (x: any) => withPkg(x, (p) => { p.appModelRsp.workshopHead.currentDocId = 541; }), /reply is for workshop 1 \/ document 541/],
    ['is for another project', (x: any) => withPkg(x, (p) => { p.header.projectId = 99; }), /reply is for project 99/],
  ])('a reply that %s: unknown in the guard and the sequencer, never completed', async (_n, f, re) => {
    const r = await run({ sketchDraw: { window: (w) => w.map((x) => (x.i === 123 ? f(x) : x)) } });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.out.reason).toMatch(re);
    expect(r.report.completed).toEqual(['sketchCreate']);
    expect(r.report.steps[1]).toMatchObject({ step: 'sketchDraw', sent: true, outcome: 'unknown' });
    expect(r.report).toMatchObject({ possibleHiddenResidue: true, aborted: expect.stringMatching(/sketchDraw unknown/) });
  });
  it('when the sequencer stops for its own reason after a verified step, the guard latches and reports residue', async () => {
    // the preview's profile is not our sketch: the guard verified extrudeCreate, the Modify builder refuses
    const profile = (x: any) => withModel(x, (m) => { for (const f of m.dataNtf?.features ?? []) for (const a of f.featUpdateFeature?.feat?.attributes ?? []) if (Number(a.role) === 30003) a.select[0].featureId = 99; });
    const r = await run({ extrudeCreate: { window: (w) => w.map((x) => (x.i === 299 ? profile(x) : x)) } });
    expect(r.out.status).toBe('stopped');
    expect(r.out.reason).toMatch(/preview feature does not use the sketch as its profile/);
    expect(r.sends).toHaveLength(7);
    expect(r.report.completed).toEqual(ALL.slice(0, 7));
    expect(r.report).toMatchObject({ possibleHiddenResidue: true, aborted: expect.stringMatching(/stopped by the sequencer/) });
    expect((await r.guard.exchange('extrudeModify', new Uint8Array())).unexpected.join()).toMatch(/run aborted earlier/);
  });

  // 6. the plan and identity are validated at construction
  it.each([
    ['a width not matching the lines', { ...plan, width: 120 }, /lines do not match the width\/height/],
    ['an open outline', { ...plan, lines: [plan.lines[0], plan.lines[1], plan.lines[2], [0, 0, 1, 1]] }, /line 2 does not end where line 3 starts/],
    ['zero depth', { ...plan, depth: 0 }, /plan: depth/],
    ['a NaN depth', { ...plan, depth: NaN }, /plan: depth/],
    ['a fractional tip id', { ...plan, tipFeatureId: 1.5 }, /plan: tipFeatureId/],
    ['an odd name', { ...plan, extrudeName: 'x"; drop' }, /plan: extrudeName/],
    ['an extra field', { ...plan, onlySolve: true }, /^plan: \(input\) Unrecognized key: "onlySolve"$/],
  ])('refuses a plan with %s at construction, before any port', (_n, bad, re) => {
    const h = harness();
    expect(() => new LiveWriteGuard(schema, h.ports, bound, bad as Plan, { enabled: true })).toThrow(re);
    expect(h.calls).toEqual(NO_PORT);
  });
  it('refuses an invalid bound identity at construction', () => {
    for (const bad of [{ ...bound, docId: 0 }, { ...bound, modelSocket: '' }, { ...bound, projectId: 1.5 }]) {
      expect(() => new LiveWriteGuard(schema, harness().ports, bad, plan, { enabled: true })).toThrow(/bound identity/);
    }
  });

  // 7. definite failure vs unknown
  it('an error reply with no visible or undo change is a definite failure', async () => {
    const r = await run({ extrudeModify: { replyWindow: [454, 458], effect: () => {} } });
    expect(r.out.status).toBe('stopped');
    expect(r.out.reason).toMatch(/extrudeModify: error result 32000/);
    expect(r.report.steps.at(-1)).toMatchObject({ step: 'extrudeModify', sent: true, outcome: 'failed', problems: ['error result 32000'] });
    expect(r.report.aborted).toMatch(/extrudeModify failed: error result 32000/);
    expect(r.sends).toHaveLength(8);
  });

  // 8. the request frame must be exactly one header and our one body
  it.each([
    ['a second body after ours', (w: any[]) => [appendBytes(w[0], protobuf.Writer.create().uint32((100 << 3) | 2).bytes(closeBody()).finish()), ...w.slice(1)], /the request frame carries fields 1,100,100/],
    ['another body field', (w: any[]) => [appendBytes(w[0], Uint8Array.from([0x12, 0x00])), ...w.slice(1)], /the request frame carries fields 1,100,2/],
  ])('our request frame carrying %s is an unknown outcome', async (_n, window, re) => {
    const r = await run({ sketchDraw: { window: window as any } });
    expect(r.out.status).toBe('unknown');
    expect(r.out.reason).toMatch(re);
    expect(r.sends).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ final review fixes (F1 malformed state, F2 notifications, F4 identity, F5 report)

describe.skipIf(!ready)('LiveWriteGuard: malformed state, created-feature identity, notifications, report state', () => {
  const frame = (i: number) => records.find((x) => x.i === i);
  const PART = '526'; // the plate document's ivy::FeatPart (fixtures)
  const malformed: Array<[string, (s: any) => any, string]> = [
    ['missing classes', (s) => ({ ...s, classes: undefined }), 'classes are missing or not class names'],
    ['invalid undo JSON', (s) => ({ ...s, undo: '{"marks": [' }), 'undo history is not a JSON object'],
    ['undo marks that are not a list', (s) => ({ ...s, undo: JSON.stringify({ ...JSON.parse(s.undo), marks: {} }) }), 'undo marks are missing or malformed'],
    ['no FeatPart', (s) => { const c = { ...s.classes }, o = { ...s.objects }; delete c[PART]; delete o[PART]; return { ...s, classes: c, objects: o }; }, 'expected one ivy::FeatPart with its object, found 0'],
    ['a FeatPart object that is not JSON', (s) => ({ ...s, objects: { ...s.objects, [PART]: '{"attr_tip_feat_":' } }), `object #${PART} is not JSON`],
    ['no snapshot at all', () => null, 'snapshot is not an object'],
  ];

  // F1 ----------------------------------------------------------------
  it('the fixtures themselves are well-formed snapshots', () => {
    const d = new RealDoc();
    expect(snapshotProblems(d.snap())).toEqual([]);
    for (const m of malformed) expect(snapshotProblems(m[1](d.snap()))).toEqual([m[2]]);
  });
  it.each(malformed.flatMap(([n, f, why]) => (['sketchCreate', 'extrudeCommit'] as const).map((step) => [step, n, f, why] as const)))(
    'a resolved but malformed snapshot after %s (%s) is an unknown outcome that latches the guard', async (step, _n, f, why) => {
      const r = await run({ [step]: { snapAfter: f } });
      expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
      expect(r.report.steps.at(-1)).toMatchObject({ step, sent: true, outcome: 'unknown', error: `malformed snapshot: ${why}` });
      expect(r.report.steps.at(-1)!.problems).toEqual([`state not verified: malformed snapshot: ${why}`]);
      expect(r.report.aborted).toBe(`${step} unknown: state not verified: malformed snapshot: ${why}`);
      expect(r.report.completed).toEqual(ALL.slice(0, ALL.indexOf(step)));
      expect(r.report.lastState).toMatchObject({ observedBefore: step, verified: false });
      expect(r.report.lastState?.observedAfter).toBeUndefined();
      const calls = { ...r.calls };
      const again = await r.guard.exchange(ALL[ALL.indexOf(step) + 1] ?? step, new Uint8Array());
      expect(again.unexpected.join()).toMatch(/^run aborted earlier/);
      expect(r.calls).toEqual(calls);
      expect(r.sends).toHaveLength(ALL.indexOf(step) + 1);
    });
  it.each(malformed)('a malformed snapshot before sending (%s) refuses without sending', async (_n, f, why) => {
    const r = await run({ widthAdd: { snapBefore: f } });
    expect(r.out.status).toBe('refused');
    expect(r.report.steps.at(-1)).toMatchObject({ step: 'widthAdd', sent: false, outcome: 'refused', problems: [`malformed state before widthAdd: ${why}`] });
    expect(r.sends).toHaveLength(3);
  });
  it('an exception anywhere after the send boundary is an unknown outcome and latches', async () => {
    const r = await run({ sketchDraw: { send: () => ({ ok: true, get asyncId(): string { throw new Error('page result unreadable'); } }) } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)).toMatchObject({ step: 'sketchDraw', sent: true, outcome: 'unknown', problems: ['verification failed: page result unreadable'] });
    expect(r.report.aborted).toBe('sketchDraw unknown: verification failed: page result unreadable');
    expect(r.sends).toHaveLength(2);
  });
  it('a send result that is not an object is an unknown outcome', async () => {
    const r = await run({ sketchDraw: { send: () => null as any } });
    expect(r.report.steps.at(-1)).toMatchObject({ outcome: 'unknown', problems: ['the sender returned null, not a send result'] });
  });
  it('request bytes that are not a byte array are refused, latched, before any port', async () => {
    const h = harness();
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    const t = await g.exchange('sketchCreate', undefined as any);
    expect(t.notSent).toBe(true);
    expect(t.unexpected.join()).toMatch(/^request bytes are not a byte array/);
    expect(g.report().aborted).toMatch(/^sketchCreate refused: request bytes/);
    expect(h.calls).toEqual({ identity: 0, state: 0, traffic: 0, since: 0, settle: 0 });
  });

  // F4 ----------------------------------------------------------------
  /** Renames feature 43 to `id` in the commit's reply (312) and notification (313): both then name `id` at depth 8. */
  const nameCommit = (id: number) => (w: any[]) => w.map((x) => (x.i === 312 ? withModel(x, (m) => { m.header.featureId = id; })
    : x.i === 313 ? withModel(x, (m) => { m.header.tipFeatureId = String(id); for (const f of m.dataNtf?.features ?? []) if (Number(String(f.featureId)) === 43) { f.featureId = id; f.featUpdateFeature.feat.id = id; } }) : x));
  it('an existing extrude with the planned depth named by reply and notification, while another extrude is added: unknown', async () => {
    // 900: an id no fixture object carries (feature and parameter ids share one counter, e.g. ParmLength #577 is 20)
    const r = await run({ extrudeCommit: { window: nameCommit(900) } }, { startDoc: (d) => d.add('ivy::SolidExtrude', '9500', { attr_first_: { _id: '900' } }) });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.report.steps.at(-1)!.problems).toEqual([
      'extrudeCommit: the added ivy::SolidExtrude #626 is feature 43, the reply names 900',
      'extrudeCommit: feature id 900 already belonged to ivy::SolidExtrude #9500 before the step',
      'extrudeCommit: the tip is 43_626, not the new ivy::SolidExtrude 900_626',
      'unexpected change to ivy::FeatPart #526: attr_tip_feat_',
    ]);
    expect(r.report.completed).toEqual(ALL.slice(0, 8));
  });
  it('the added extrude carrying another id than the reply and notification: unknown', async () => {
    const r = await run({ extrudeCommit: { effect: (d) => { d.apply('extrudeCommit'); d.edit('626', (j) => { j.attr_first_._id = '44'; }); } } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)!.problems).toEqual(['extrudeCommit: the added ivy::SolidExtrude #626 is feature 44, the reply names 43']);
  });
  it('the tip not moving to the committed extrude: unknown', async () => {
    const r = await run({ extrudeCommit: { effect: (d) => { const tip = JSON.parse(d.objects[PART]).attr_tip_feat_; d.apply('extrudeCommit'); d.edit(PART, (j) => { j.attr_tip_feat_ = tip; }); } } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)!.problems).toContain('extrudeCommit: the tip is 15_543, not the new ivy::SolidExtrude 43_626');
  });
  it('binds the created sketch to the object its undo mark added (captured: 15 / #543), and nothing else', () => {
    const d = new RealDoc(), before = d.snap();
    d.apply('sketchCreate');
    const after = d.snap();
    expect(bindCreated('ivy::FeatSketch', 15, before, after)).toEqual({ handle: '543', problems: [] });
    expect(bindCreated('ivy::FeatSketch', 12, before, after).problems).toEqual([
      'the added ivy::FeatSketch #543 is feature 15, the reply names 12',
      'feature id 12 already belonged to ivy::FeatSketch #537 before the step',
      'the tip is 15_543, not the new ivy::FeatSketch 12_543',
    ]);
    expect(bindCreated('ivy::FeatSketch', 15, before, before).problems).toEqual(['the undo mark adds 0 ivy::FeatSketch objects, expected 1']);
  });
  it('a sketchCreate reply naming the existing Sketch1 (12) is refused by the notification and never bound', async () => {
    const r = await run({ sketchCreate: { window: (w) => w.map((x) => (x.i === 114 ? withModel(x, (m) => { m.header.featureId = 12; }) : x)) } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps[0].problems).toEqual(['sketchCreate: the notification\'s tip 15 is not the sketch 12', 'sketchCreate: the new sketch does not follow the planned tip 12']);
  });

  // F2 ----------------------------------------------------------------
  const ntfCases: Array<[string, WriteStep, (w: any[]) => any[], (at: (n: number) => number) => string[]]> = [
    ['a notification for another document during a sketch step', 'sketchDraw',
      (w) => [...w, { ...withPkg(frame(125), (p) => { p.appModelNtf.workshopHead.currentDocId = 541; for (const x of p.appModelNtf.modelDescs) x.docId = 541; }), i: 9100 }],
      (at) => [`model notification for another document at ${at(9100)}`]],
    ['an extra notification during a sketch step', 'sketchDraw', (w) => [...w, { ...frame(125), i: 9101 }],
      () => ['sketchDraw: 3 notifications (2 data, 1 bare), captured exactly one of each']],
    ['a notification from another session', 'sketchDraw', (w) => w.map((x) => (x.i === 125 ? withHeader(x, (h) => { h.userSessionId = 999; }) : x)),
      () => ['sketchDraw: notification 1 is from session 999, the reply from 268435459']],
    ['a sketch notification not naming the sketch', 'sketchDraw',
      (w) => w.map((x) => (x.i === 125 ? withModel(x, (m) => { m.dataNtf.features = m.dataNtf.features.filter((f: any) => Number(String(f.featureId)) !== 15); }) : x)),
      () => ['sketchDraw: the data notification does not carry the sketch 15 exactly once']],
    ['a second preview notification', 'extrudeCreate', (w) => [...w, { ...frame(299), i: 9102 }],
      () => ['extrudeCreate: 2 notifications, captured exactly one preview notification']],
    ['a preview notification not flagged as a preview', 'extrudeCreate', (w) => w.map((x) => (x.i === 299 ? withPkg(x, (p) => { p.appModelNtf.workshopHead.isPreview = false; }) : x)),
      () => ['extrudeCreate: the notification is not flagged as a preview']],
    ['a commit notification whose tip is not the new feature', 'extrudeCommit', (w) => w.map((x) => (x.i === 313 ? withModel(x, (m) => { m.header.tipFeatureId = '15'; }) : x)),
      () => ['extrudeCommit: the notification\'s tip 15 is not the new feature 43']],
    ['a committed extrude not following the sketch', 'extrudeCommit',
      (w) => w.map((x) => (x.i === 313 ? withModel(x, (m) => { for (const f of m.dataNtf?.features ?? []) if (Number(String(f.featureId)) === 43) f.previousFeatureId = 12; }) : x)),
      () => ['extrudeCommit: the notification does not carry exactly one SolidExtrude 43 following the sketch 15']],
  ];
  it.each(ntfCases)('%s stops the run as an unknown outcome', async (_n, step, window, problems) => {
    const r = await run({ [step]: { window } });
    expect(r.out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(r.report.steps.at(-1)).toMatchObject({ step, sent: true, outcome: 'unknown' });
    expect(r.report.steps.at(-1)!.problems).toEqual(problems((n) => r.at(n)!));
    expect(r.sends).toHaveLength(ALL.indexOf(step) + 1);
  });

  // F5 ----------------------------------------------------------------
  it('lastState is verified only for the after-state of a verified step', async () => {
    const ok = await run();
    expect(ok.report.lastState).toMatchObject({ observedAfter: 'extrudeCommit', verified: true });
    const drift = await run({ extrudeCreate: { gap: { doc: (d) => d.add('ivy::ParmLength', '9200') } } });
    expect(drift.out.status).toBe('refused');
    expect(drift.report.lastState).toMatchObject({ observedBefore: 'extrudeCreate', verified: false });
    expect(drift.report.lastState?.observedAfter).toBeUndefined();
    const first = await run({}, { startDoc: (d) => { d.redo = 1; } });
    expect(first.report.lastState).toMatchObject({ observedBefore: 'sketchCreate', verified: false });
    const bad = await run({ widthAdd: { effect: (d) => { d.apply('widthAdd'); d.add('ivy::ParmLength', '9101'); } } });
    expect(bad.report.lastState).toMatchObject({ observedAfter: 'widthAdd', verified: false });
  });
});

// ------------------------------------------------------------------ follow-up review (binary payloads, recorder stream, socket inventory, sketch tip, snapshot copies)

describe.skipIf(!ready)('LiveWriteGuard: binary payloads, recorder stream, socket inventory, sketch tip, snapshot copies', () => {
  const frame = (i: number) => records.find((x) => x.i === i);
  const headerOnly = Buffer.concat([Buffer.from([0x5a, 0x01]), Buffer.alloc(33)]).toString('base64'); // 35 bytes: a trace header, no body

  // binary payloads that decodeCapture would drop as zero bytes -----------------
  it.each([
    ['invalid base64', '!!!!', 'binary frame that is not valid base64'],
    ['base64 of the wrong length (decodes to nothing)', 'A', 'binary frame that is not valid base64'],
    ['a trace header and no body', headerOnly, 'binary frame carrying only a trace header'],
  ])('refuses the next step when a model-socket binary frame with %s arrives between steps', async (_n, payload, why) => {
    const r = await run({ sketchClose: { gap: { recs: () => [{ ...frame(123), i: 9013, payload }] } } });
    expect(r.out.status).toBe('refused');
    expect(r.report.steps.at(-1)!.problems).toEqual([`traffic since sketchDraw: ${why} on the model socket at ${r.at(9013)}`]);
    expect(r.sends).toHaveLength(2);
  });
  it('a header-only binary frame inside a step window is an unknown outcome', async () => {
    const r = await run({ sketchDraw: { window: (w) => [...w, { ...frame(123), i: 9014, payload: headerOnly }] } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps.at(-1)!.problems).toEqual([`binary frame carrying only a trace header on the model socket at ${r.at(9014)}`]);
  });

  // the real RecordStream as the traffic port --------------------------------
  it('runs the nine steps over the real RecordStream (one attachment, contiguous indices)', async () => {
    const r = await run({}, { stream: true });
    expect(r.out.status).toBe('completed');
  });
  it('a recorder reattached between steps (indices restart at 0) breaks the stream: the next step is refused', async () => {
    const r = await run({ sketchClose: { gap: { raw: () => [{ i: 0, t: 0, type: 'mark', text: 'recorder attached' }] } } }, { stream: true });
    expect(r.out.status).toBe('refused');
    const n = r.live.length - 1; // the stream had n records when the reattached recorder wrote index 0
    expect(r.report.steps.at(-1)!.problems).toEqual([`pre-send check failed: traffic stream broken: record index 0 written where ${n} was expected (recorder reattached, or a record lost)`]);
    expect(r.sends).toHaveLength(2);
  });

  // model-socket inventory ----------------------------------------------------
  it.each([
    ['incomplete', { complete: false, modelSockets: [SOCKET] }, 'the model sockets could not be enumerated completely; exclusive use of the bound socket is not proven'],
    ['missing', null, 'the model sockets could not be enumerated completely; exclusive use of the bound socket is not proven'],
    ['not a list', { complete: true, modelSockets: SOCKET }, 'the model sockets could not be enumerated completely; exclusive use of the bound socket is not proven'],
    ['a second model socket', { complete: true, modelSockets: [SOCKET, '40700.9999'] }, `model sockets ["${SOCKET}","40700.9999"] are not exactly the bound ${SOCKET}`],
    ['only another socket', { complete: true, modelSockets: ['40700.9999'] }, `model sockets ["40700.9999"] are not exactly the bound ${SOCKET}`],
    ['empty', { complete: true, modelSockets: [] }, `model sockets [] are not exactly the bound ${SOCKET}`],
    ['unavailable (throws)', 'throw', 'pre-send check failed: socket list unavailable'],
  ] as const)('refuses before any send when the model-socket inventory is %s', async (_n, sockets, why) => {
    const r = await run({ sketchCreate: { sockets: sockets as any } });
    expect(r.out.status).toBe('refused');
    expect(r.report.steps).toEqual([{ step: 'sketchCreate', sent: false, outcome: 'refused', problems: [why] }]);
    expect(r.sends).toHaveLength(0);
  });
  it('a second model socket appearing in the inventory mid-run refuses the next step', async () => {
    const r = await run({ heightAdd: { sockets: { complete: true, modelSockets: [SOCKET, '40700.9999'] } } });
    expect(r.out.reason).toMatch(/heightAdd: not sent: model sockets .* are not exactly the bound/);
    expect(r.sends).toHaveLength(4);
  });

  // the sketch-create notification must carry the tip ------------------------
  it('a sketch-create notification without the tip (captured 116 has 15) is an unknown outcome', async () => {
    const r = await run({ sketchCreate: { window: (w) => w.map((x) => (x.i === 116 ? withModel(x, (m) => { delete m.header.tipFeatureId; }) : x)) } });
    expect(r.out.status).toBe('unknown');
    expect(r.report.steps[0].problems).toEqual(['sketchCreate: the notification\'s tip undefined is not the sketch 15']);
    expect(r.sends).toHaveLength(1);
  });

  // snapshots are copied on intake --------------------------------------------
  it('a state port that mutates one snapshot object in place still gets per-step and drift checks (copies, not references)', async () => {
    expect((await run({}, { sharedSnap: true })).out.status).toBe('completed');
    const drift = await run({ extrudeCreate: { gap: { doc: (d) => d.add('ivy::ParmLength', '9200') } } }, { sharedSnap: true });
    expect(drift.out.status).toBe('refused');
    expect(drift.report.steps.at(-1)!.problems).toEqual(['state drift since sketchFinish: new object ivy::ParmLength #9200']);
  });
  it('report() is unaffected by later mutation of the port\'s snapshot object or of an earlier report', async () => {
    const r = await run({}, { sharedSnap: true });
    const first = r.guard.report();
    Object.assign(r.shared, { undo: 'garbage', classes: null, objects: null, edges: null });
    first.lastState!.undo.markIds.push(999);
    first.steps[0].problems.push('x');
    const again = r.guard.report();
    expect(again).toEqual(r.report);
    expect(again.lastState).toMatchObject({ observedAfter: 'extrudeCommit', verified: true });
  });
});

// ------------------------------------------------------------------ server sessions (mocked port) and the final check

describe.skipIf(!ready)('server session exclusivity (a MOCKED session-list port: Ivy has no such tool yet)', () => {
  const NONE = { identity: 0, state: 0, traffic: 0, since: 0, settle: 0 };
  it('checks the session list before every send and after every step', async () => {
    const r = await run();
    expect(r.out.status).toBe('completed');
    expect(r.sessionLog).toEqual(ALL.flatMap((s) => [`before ${s}`, `after ${s}`]));
  });
  it.each([
    ['a second session', { sessions: [SESSION, '268435460'] }, `server sessions ["${SESSION}","268435460"] are not exactly the bound session ${SESSION}`],
    ['another session only', { sessions: ['268435460'] }, `server sessions ["268435460"] are not exactly the bound session ${SESSION}`],
    ['no session', { sessions: [] }, `server sessions [] are not exactly the bound session ${SESSION}`],
    ['numbers instead of strings', { sessions: [Number(SESSION)] }, 'the server session list is missing or malformed'],
    ['no list', {}, 'the server session list is missing or malformed'],
    ['null', null, 'the server session list is missing or malformed'],
  ])('refuses the first step, sending nothing, on %s', async (_n, sessions, why) => {
    const r = await run({ sketchCreate: { sessions } });
    expect(r.sends).toHaveLength(0);
    expect(r.report.steps).toEqual([{ step: 'sketchCreate', sent: false, outcome: 'refused', problems: [why] }]);
    expect(r.report.aborted).toBe(`sketchCreate refused: ${why}`);
  });
  it('refuses when the session list cannot be read', async () => {
    const r = await run({ sketchCreate: { sessions: 'throw' } });
    expect(r.sends).toHaveLength(0);
    expect(r.report.steps[0].problems).toEqual(['pre-send check failed: session list unavailable']);
  });
  it('a session that joins while a step runs makes that step unknown and stops the run', async () => {
    const r = await run({ sketchClose: { sessionsAfter: { sessions: [SESSION, '268435461'] } } });
    expect(r.sends).toHaveLength(3);
    expect(r.out.status).toBe('unknown');
    const rec = r.report.steps.find((s) => s.step === 'sketchClose')!;
    expect(rec.outcome).toBe('unknown');
    expect(rec.problems).toEqual([`after sketchClose: server sessions ["${SESSION}","268435461"] are not exactly the bound session ${SESSION}`]);
    expect(r.report.possibleHiddenResidue).toBe(true);
  });
  it('a session list that fails after a step is unknown too', async () => {
    const r = await run({ widthAdd: { sessionsAfter: 'throw' } });
    expect(r.report.steps.find((s) => s.step === 'widthAdd')).toMatchObject({ outcome: 'unknown', problems: ['after widthAdd: the server session list is unavailable: session list unavailable'] });
  });
  it('a bound identity needs a server session id', () => {
    for (const sessionId of [undefined, '', '0', '12a', 268435459]) {
      expect(() => new LiveWriteGuard(schema, harness().ports, { ...bound, sessionId } as any, plan)).toThrow(/bound identity: sessionId/);
    }
  });
  it('an identity whose session changed is refused', async () => {
    const r = await run({ heightAdd: { identity: { sessionId: '268435462' } } });
    expect(r.sends).toHaveLength(4);
    expect(r.report.steps.at(-1)!.problems[0]).toMatch(/^identity changed: /);
  });
  it('a disabled guard touches no port, the session list included', async () => {
    const r = await run({}, { enabled: false });
    expect(r.calls).toEqual(NONE);
    expect(r.sessionLog).toEqual([]);
  });
});

describe.skipIf(!ready)('LiveWriteGuard.finish: nothing after the commit goes unclassified', () => {
  it('a clean completed run is verified, and no exchange is accepted afterwards', async () => {
    const r = await run();
    const f = await r.guard.finish();
    expect(f).toEqual({ verified: true, problems: [], records: 0 });
    expect(r.sessionLog.at(-1)).toBe('before finish');
    expect(r.guard.report()).toMatchObject({ final: f, aborted: undefined });
    expect(await r.guard.finish()).toEqual(f); // once
    const again = await r.guard.exchange('sketchCreate', new Uint8Array([1]));
    expect(again.notSent).toBe(true);
    expect(r.sends).toHaveLength(9);
  });
  it('a notification arriving after the commit\'s settle is classified and fails the run', async () => {
    const late = (win: any[]) => [win, [win.find((x) => x.i === 313)]] as [any[], any[]];
    const r = await run({ extrudeCommit: { late } });
    expect(r.out.status).toBe('completed');
    r.flushLate();
    const f = await r.guard.finish();
    expect(f.verified).toBe(false);
    expect(f.records).toBe(1);
    expect(f.problems).toEqual([`traffic after the last step: model notification between steps at ${r.at(313)}`]);
    expect(r.guard.report().aborted).toBe(`final check: ${f.problems[0]}`);
  });
  it('state that changed after the commit fails the run', async () => {
    const r = await run();
    r.doc.add('ivy::ParmLength', '9300');
    const f = await r.guard.finish();
    expect(f).toEqual({ verified: false, problems: ['state changed after extrudeCommit: new object ivy::ParmLength #9300'], records: 0 });
  });
  it('a session that joined after the commit fails the run', async () => {
    const r = await run({}, { finalSessions: { sessions: [SESSION, '268435463'] } });
    expect((await r.guard.finish()).problems).toEqual([`at the end: server sessions ["${SESSION}","268435463"] are not exactly the bound session ${SESSION}`]);
  });
  it('on a stopped run it is evidence only, never verified', async () => {
    const r = await run({ widthAdd: { sendThrows: 'socket closed' } });
    expect(r.out.status).toBe('unknown');
    const f = await r.guard.finish();
    expect(f.verified).toBe(false);
    expect(r.guard.report().final).toEqual(f);
  });
  it('before any step it reports that nothing was inspected', async () => {
    const h = harness();
    const g = new LiveWriteGuard(schema, h.ports, bound, plan, { enabled: true });
    expect((await g.finish()).problems[0]).toBe('nothing was inspected: no step reached its traffic checks');
  });
});

// ------------------------------------------------------------------ the plate trial over fake ports (nothing reaches Ivy)

const CENTRE = 'position (centring): not measurable with the approved read operations; only the requested centred lines were checked';
describe.skipIf(!ready)('runPlateTrial and platePostconditions (fake ports; the fake document starts as plate1, which already has Sketch1)', () => {
  const trial = async (tweaks: Partial<Record<WriteStep, Tweak>> = {}) => {
    const h = harness(tweaks);
    const saved: Array<[string, unknown]> = [];
    const r = await runPlateTrial({ schema, ports: h.ports, bound, plan, save: (n, d) => saved.push([n, structuredClone(d)]) });
    return { ...h, r, saved };
  };
  it('runs all nine steps, the final check and a final snapshot, saving each stage', async () => {
    const t = await trial();
    expect(t.r.outcome?.status).toBe('completed');
    expect(t.r.final).toEqual({ verified: true, problems: [], records: 0 });
    expect(t.saved.map(([n]) => n)).toEqual(['outcome', 'final', 'state-after', 'report', 'postconditions']);
    // The only postcondition that fails is the fake document's pre-existing Sketch1 (a real first trial requires none).
    expect(t.r.post).toEqual(expect.objectContaining({
      verdict: 'failed',
      problems: ['expected sketches ["Sketch2"], found ["Sketch1","Sketch2"]', 'no face was measured: neither the 100 × 60 mm face nor the 8 mm thickness is established'],
      notChecked: ['dimension values (needs the read-only parameter query)', CENTRE],
    }));
  });
  it('a failing step stops, still saves every stage, and never cleans up', async () => {
    const t = await trial({ widthAdd: { sendThrows: 'socket closed' } });
    expect(t.r.outcome?.status).toBe('unknown');
    expect(t.sends).toHaveLength(4);
    expect(t.saved.map(([n]) => n)).toEqual(['outcome', 'final', 'state-after', 'report', 'postconditions']);
    expect(t.r.final?.verified).toBe(false);
    expect(t.r.report.possibleHiddenResidue).toBe(true);
    expect(t.r.post?.verdict).toBe('failed');
    expect(t.r.post?.problems[0]).toBe('verified steps ["sketchCreate","sketchDraw","sketchClose"], not all nine');
  });
  it('an exception while taking the final snapshot is saved, and the report still comes back', async () => {
    const h = harness();
    const saved: string[] = [];
    let n = 0;
    const ports = { ...h.ports, state: { snapshot: async () => { if (++n > 2 * ALL.length + 1) throw new Error('inspector gone'); return h.ports.state.snapshot(); } } };
    const r = await runPlateTrial({ schema, ports, bound, plan, save: (k) => saved.push(k) });
    expect(r.error).toBe('inspector gone');
    expect(saved).toEqual(['outcome', 'final', 'error', 'report']);
    expect(r.post).toBeUndefined();
  });
  it('dimension values and thickness come only from read-only evidence, and are checked when given', async () => {
    const t = await trial();
    const after = t.saved.find(([n]) => n === 'state-after')![1] as any;
    const base = { report: t.r.report, after, plan };
    const params = [
      { fullName: String.raw`\Part Body\Sketch2\ivy::SketchLengthDimension.EN_US1\length`, value: '100.000000', type: 'tLength' },
      { fullName: String.raw`\Part Body\Sketch2\ivy::SketchLengthDimension.EN_US2\length`, value: '60.000000', type: 'tLength' },
    ];
    const top = { perimeter: 0.32, area: 0.006 }, side = { perimeter: 0.216, area: 0.0008 };
    const ok = platePostconditions({ ...base, params, faces: [side, top] });
    expect(ok.problems).toEqual(['expected sketches ["Sketch2"], found ["Sketch1","Sketch2"]']);
    // The pre-existing Sketch1, once allowed by name, is accepted; everything else still passes, so only centring is open.
    const allowed = platePostconditions({ ...base, params, faces: [side, top], existingSketches: ['Sketch1'] });
    expect(allowed).toEqual(expect.objectContaining({ verdict: 'incomplete', problems: [], notChecked: [CENTRE] }));
    expect(platePostconditions({ ...base, params, faces: [side, top], existingSketches: ['Sketch1', 'Sketch9'] }).problems).toEqual(['expected sketches ["Sketch1","Sketch2","Sketch9"], found ["Sketch1","Sketch2"]']);
    expect(ok.notChecked).toEqual([CENTRE]);
    const thick = platePostconditions({ ...base, params, faces: [{ perimeter: 0.22, area: 0.001 }, top] });
    expect(thick.problems.at(-1)).toBe('no measured face is 100 or 60 by 8 mm: [[100,10],[100,60]]');
    const noTop = platePostconditions({ ...base, params, faces: [side] });
    expect(noTop.problems.at(-1)).toBe('no measured face is 100 × 60 mm: [[100,8]]');
    const offTop = platePostconditions({ ...base, params, faces: [side, { perimeter: 0.3202, area: 0.0060 }] }); // 100.1 × 60: off by 0.1 mm
    expect(offTop.problems.at(-1)).toMatch(/^no measured face is 100 × 60 mm: /);
    const impossible = platePostconditions({ ...base, params, faces: [side, { perimeter: 0.1, area: 0.01 }] }); // no rectangle fits
    expect(impossible.problems.at(-1)).toBe('no measured face is 100 × 60 mm: [[100,8],null]');
    const dims = platePostconditions({ ...base, params: [{ ...params[0], value: '174.92' }, params[1]], faces: [side, top] });
    expect(dims.problems.at(-1)).toBe('sketch dimensions [60,174.92], planned [60,100]');
  });
  it('even with every other check passing, a run is at best "incomplete": centring is never measured', async () => {
    const t = await trial();
    const after = structuredClone(t.saved.find(([n]) => n === 'state-after')![1] as any);
    // Drop the fake document's pre-existing Sketch1 so only the run's own objects remain.
    const sketch1 = Object.keys(after.classes).find((h) => after.classes[h] === 'ivy::FeatSketch' && JSON.parse(after.objects[h]).attr_first_?._name === 'Sketch1')!;
    delete after.classes[sketch1]; delete after.objects[sketch1];
    const params = [
      { fullName: String.raw`\Part Body\Sketch2\ivy::SketchLengthDimension.EN_US1\length`, value: '100.000000', type: 'tLength' },
      { fullName: String.raw`\Part Body\Sketch2\ivy::SketchLengthDimension.EN_US2\length`, value: '60.000000', type: 'tLength' },
    ];
    const p = platePostconditions({ report: t.r.report, after, plan, params, faces: [{ perimeter: 0.216, area: 0.0008 }, { perimeter: 0.32, area: 0.006 }] });
    expect(p).toEqual(expect.objectContaining({ verdict: 'incomplete', problems: [], notChecked: [CENTRE] }));
  });
});

describe.skipIf(!ready)('PageSender through the guard and the trial (the page is faked; nothing reaches Ivy)', () => {
  /** A DevTools connection whose PAGE_FN send mode hands the body to the harness's fake page and document. */
  const pageOver = (h: ReturnType<typeof harness>, log: any[]): CdpConnection => ({
    send: async (_m, params: any) => {
      const arg = JSON.parse(params.expression.slice(`(${PAGE_FN})(`.length, -1));
      log.push(arg);
      const r = await h.ports.sender.sendRaw(arg.cmd, arg.bodyFieldNo, Uint8Array.from(arg.body), arg.timeoutMs);
      return { result: { value: { ok: r.ok, project: { projectId: arg.projectId, projectTag: arg.projectTag, valid: true }, asyncId: r.asyncId ?? null } } };
    },
    onEvent: () => {}, close: () => {},
  });
  it('sends exactly the nine guarded bodies, in order, for the bound project, and verifies the run', async () => {
    const h = harness(), log: any[] = [];
    const sender = new PageSender(pageOver(h, log), { projectId: bound.projectId, projectTag: bound.projectTag }, { armed: true });
    const evidence: any[] = [];
    const r = await runPlateTrial({ schema, ports: { ...h.ports, sender }, bound, plan, save: () => {}, readEvidence: async (c) => { evidence.push(c); return {}; } });
    expect(r.outcome?.status).toBe('completed');
    expect(r.final?.verified).toBe(true);
    expect(log.map((a) => [a.mode, a.projectId, a.cmd, a.bodyFieldNo])).toEqual(ALL.map(() => ['send', String(bound.projectId), 120, 100]));
    const P = schema.PartPkg!, A = schema.IvyPkg.root.lookupType('ivyproto.AppModelReq');
    const kinds = sender.sentBodies().map((b) => (P.toObject(P.decode((A.decode(b) as any).modelPkg), { enums: String }) as any).header.cmd);
    expect(kinds).toEqual([...Array(6).fill('IVY_PART_SKETCH_UPDATE_REQ'), ...Array(3).fill('IVY_PART_FEAT_UPDATE_UPDATE_REQ')]);
    expect(sender.sentBodies().map((b) => Buffer.from(b))).toEqual(h.sends.map((s) => s.body));
    expect(evidence).toEqual([r.outcome!.created]); // read-only evidence only after a verified run
    expect(r.report.exclusivity).toEqual(['server']);
  });
  it('a disarmed sender sends nothing: the first step is an unknown outcome and the run stops', async () => {
    const h = harness(), log: any[] = [];
    const r = await runPlateTrial({ schema, ports: { ...h.ports, sender: new PageSender(pageOver(h, log), bound) }, bound, plan, save: () => {} });
    expect(log).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(r.outcome?.status).toBe('unknown');
    expect(r.report.steps[0].problems[0]).toBe('send failed: the sender is disarmed');
  });
  it('no read-only evidence is taken after a stopped run', async () => {
    const h = harness({ widthAdd: { sendThrows: 'socket closed' } });
    let called = false;
    await runPlateTrial({ schema, ports: h.ports, bound, plan, save: () => {}, readEvidence: async () => { called = true; return {}; } });
    expect(called).toBe(false);
  });
  it('an attested session list is reported as attested, never as server evidence', async () => {
    const h = harness();
    const ports = { ...h.ports, identity: { ...h.ports.identity, sessions: async () => ({ sessions: [SESSION], source: 'attested' as const }) } };
    const r = await runPlateTrial({ schema, ports, bound, plan, save: () => {} });
    expect(r.outcome?.status).toBe('completed');
    expect(r.report.exclusivity).toEqual(['attested']);
  });
});

describe.skipIf(!ready)('finish() after a step judged unknown: its window is not re-read as between-steps traffic', () => {
  const joined = { sessions: [SESSION, '268435499'] };
  it('starts after the classified window, so our own request and its answers are not reported again', async () => {
    const r = await run({ sketchDraw: { sessionsAfter: joined } });
    expect(r.report.steps.find((s) => s.step === 'sketchDraw')?.outcome).toBe('unknown');
    const f = await r.guard.finish();
    expect(f.records).toBe(0);
    expect(f.problems.filter((p) => p.startsWith('traffic after the last step'))).toEqual([]);
  });
  it('still classifies anything that arrives after that window', async () => {
    const late = (win: any[]) => [win, [win.find((x) => x.i === 125)]] as [any[], any[]]; // a second copy of sketchDraw's data notification
    const r = await run({ sketchDraw: { sessionsAfter: joined, late } });
    r.flushLate();
    const f = await r.guard.finish();
    expect(f.records).toBe(1);
    expect(f.problems.filter((p) => p.startsWith('traffic after the last step'))).toEqual([`traffic after the last step: model notification between steps at ${r.at(125)}`]);
  });
  it('re-reads a window whose classification never ran (no reply in time: the guard stopped before classifying)', async () => {
    const r = await run({ sketchDraw: { send: () => ({ ok: false, unknownOutcome: true }) } });
    expect(r.report.steps.find((s) => s.step === 'sketchDraw')?.problems[0]).toBe('no reply in time');
    const f = await r.guard.finish();
    expect(f.records).toBeGreaterThan(0); // the unclassified sketchDraw window is inspected now
    expect(f.problems.some((p) => p.startsWith('traffic after the last step'))).toBe(true);
  });
});
