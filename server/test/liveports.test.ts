// Read-only live ports, offline: fake inspector / page probe / DevTools targets, real recorder and RecordStream over
// the plate1 capture. Nothing here reaches a browser, the inspector or Ivy.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadOnlyCdp, type CdpConnection } from '../src/cdpguard';
import { config } from '../src/config';
import { checkDrift, snapshotProblems } from '../src/livewriteguard';
import { documentSubtree, inspectorState, liveReadPorts, parseGraph, recordedTarget, rootedGraphProblems } from '../src/liveports';
import { sentBody } from '../src/replaycheck';
import type { PageResult } from '../src/pagecall';
import { attachRecorder, RecordStream } from '../src/recorder';
import template from '../src/templates/plate1-write.json';
import { loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(captureFile);
const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
const records: any[] = ready ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const FIX = path.join(import.meta.dirname, 'fixtures', 'inspector', 'plate1-extrude');
const PROJECT = { projectId: 37649921, projectTag: 'main' };

/** A fake inspector serving the plate1-extrude fixture; `undo` may vary per read. Logs every call. */
function fakeInspector(opts: { undo?: (n: number) => string; doc?: string; projects?: unknown } = {}) {
  const calls: string[] = [];
  const dot = fs.readFileSync(path.join(FIX, 'graph-full.dot'), 'utf8');
  const undo = fs.readFileSync(path.join(FIX, 'undo.json'), 'utf8');
  let undoReads = 0;
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    calls.push(tool === 'zcad_get_object_json' ? `object ${args.objectId}` : tool);
    if (tool === 'zcad_list_projects') return JSON.stringify(opts.projects ?? [PROJECT]);
    if (tool === 'zcad_get_object_graph') return dot;
    if (tool === 'zcad_get_undo_history') return opts.undo ? opts.undo(undoReads++) : undo;
    if (tool === 'zcad_get_object_json') {
      if (args.objectId === 540 && opts.doc) return opts.doc;
      const f = path.join(FIX, 'objects', `${args.objectId}.json`);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '{}';
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { call, calls };
}

describe('inspectorState', () => {
  it('unbracketed (replay): graph, then each object, then undo, exactly as replay.ts read it before', async () => {
    const ins = fakeInspector();
    const s = await inspectorState(ins, PROJECT.projectId, PROJECT.projectTag);
    expect(ins.calls[0]).toBe('zcad_get_object_graph');
    expect(ins.calls.at(-1)).toBe('zcad_get_undo_history');
    expect(ins.calls.filter((c) => c === 'zcad_get_undo_history')).toHaveLength(1);
    const objs = Object.keys(s.classes).filter((h) => !['ivy::PipelineContext', 'ivy::Project'].includes(s.classes[h]));
    expect(ins.calls.slice(1, -1)).toEqual(objs.map((h) => `object ${h}`));
    expect(Object.keys(s.objects)).toEqual(objs);
    expect(s.edges.length).toBeGreaterThan(0);
  });
  it('bracketed: reads undo first and last and returns the same snapshot when both agree', async () => {
    const plain = await inspectorState(fakeInspector(), PROJECT.projectId, PROJECT.projectTag);
    const ins = fakeInspector();
    expect(await inspectorState(ins, PROJECT.projectId, PROJECT.projectTag, { bracketUndo: true })).toEqual(plain);
    expect([ins.calls[0], ins.calls[1], ins.calls.at(-1)]).toEqual(['zcad_get_undo_history', 'zcad_get_object_graph', 'zcad_get_undo_history']);
  });
  it('bracketed: refuses a snapshot during which the undo history changed', async () => {
    const undo = fs.readFileSync(path.join(FIX, 'undo.json'), 'utf8');
    const ins = fakeInspector({ undo: (n) => (n === 0 ? undo : undo.replace('"can_undo_step":10', '"can_undo_step":11')) });
    await expect(inspectorState(ins, PROJECT.projectId, PROJECT.projectTag, { bracketUndo: true }))
      .rejects.toThrow('the undo history changed while the snapshot was collected; the snapshot is inconsistent');
  });
  it('bracketed: does NOT detect a change that leaves undo alone (not atomic)', async () => {
    const ins = fakeInspector();
    const call = ins.call;
    let n = 0;
    const tearing = { call: async (t: string, a: Record<string, unknown> = {}) => (t === 'zcad_get_object_json' && n++ === 0 ? '{"torn":true}' : call(t, a)) };
    const s = await inspectorState(tearing, PROJECT.projectId, PROJECT.projectTag, { bracketUndo: true });
    expect(Object.values(s.objects)).toContain('{"torn":true}');
  });
});

/**
 * A SIMULATION of Ivy's DumpOMGraph(root) as read in source (zplugin/inspector/inspector.cpp:189-229): the root, its
 * Contain descendants, and every edge whose source is one of them. It is not the live API; these tests show what
 * the port does with such a reply, not that Ivy returns it.
 */
function rootedDot(fullDot: string, root: number): string {
  const vtx = new Map<string, string>();
  for (const m of fullDot.matchAll(/^\s*"?(\d+)"?\s*\[label="[^"]*"[^;]*\];/gm)) vtx.set(m[1], m[0]);
  const edges = fullDot.split('\n').filter((l) => / -> /.test(l)).map((l) => l.trim());
  if (!vtx.has(String(root))) return 'Root object not found.';
  const keep = new Set<string>();
  const visit = (h: string) => {
    if (keep.has(h)) return;
    keep.add(h);
    for (const e of edges) { const m = /^"(\d+)" -> "(\d+)" \[label="Contain"/.exec(e); if (m?.[1] === h) visit(m[2]); }
  };
  visit(String(root));
  return ['digraph G {', ...[...keep].map((h) => vtx.get(h)!), ...edges.filter((e) => keep.has(/^"(\d+)"/.exec(e)![1])), '}'].join('\n');
}

/** A fake inspector over one full-project dump that answers `rootEntityId` with rootedDot. Logs graph roots. */
function documentInspector(full: { dot: string; undo: string; object: (h: string) => string | undefined }, o: { graph?: (root: number) => string; throwOnGraph?: string } = {}) {
  const roots: number[] = [];
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    if (tool === 'zcad_get_undo_history') return full.undo;
    if (tool === 'zcad_get_object_graph') {
      const root = Number(args.rootEntityId); roots.push(root);
      if (o.throwOnGraph) throw new Error(o.throwOnGraph);
      return o.graph ? o.graph(root) : root === 0 ? full.dot : rootedDot(full.dot, root);
    }
    if (tool === 'zcad_get_object_json') return full.object(String(args.objectId)) ?? '{}';
    throw new Error(`unexpected tool ${tool}`);
  };
  return { call, roots };
}

const plate1Full = () => ({
  dot: fs.readFileSync(path.join(FIX, 'graph-full.dot'), 'utf8'), undo: fs.readFileSync(path.join(FIX, 'undo.json'), 'utf8'),
  object: (h: string) => { const f = path.join(FIX, 'objects', `${h}.json`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; },
});
/** The two-document project the doc37660560 probe read (test/fixtures/inspector/probe-two-docs), as a full dump. */
const twoDocs = () => {
  const s = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'inspector', 'probe-two-docs', 'state.json'), 'utf8'));
  const dot = ['digraph G {', ...Object.entries(s.classes).map(([h, c]) => (h === '0' ? `0 [label="${c}"];` : `  "${h}" [label="${c} ${h}", style=filled];`)), ...s.edges, '}'].join('\n');
  return { dot, undo: s.undo as string, object: (h: string) => s.objects[h] as string | undefined, state: s };
};
const count = (classes: Record<string, string>, cls: string) => Object.values(classes).filter((c) => c === cls).length;

describe('document-rooted snapshot (simulated rootEntityId replies; the live API is not proven by these)', () => {
  it('plate1: document 540 holds its 48 objects and one FeatPart; the workshop, project and pipeline context are excluded', async () => {
    const ins = documentInspector(plate1Full());
    const s = await inspectorState(ins, PROJECT.projectId, PROJECT.projectTag, { bracketUndo: true, root: 540 });
    expect(ins.roots).toEqual([540]);
    expect(Object.keys(s.classes)).toHaveLength(48);
    expect(count(s.classes, 'ivy::FeatPart')).toBe(1);
    for (const h of ['0', '541']) expect(s.classes[h]).toBeUndefined();
    expect(Object.values(s.classes)).not.toContain('ivy::PipelineContext');
    expect(snapshotProblems(s)).toEqual([]);
    expect(s.undo).toBe(plate1Full().undo); // undo is the project's, never narrowed
  });
  it('two documents: the project-wide snapshot is refused by the guard (two FeatParts); each document alone is well-formed', async () => {
    const full = await inspectorState(documentInspector(twoDocs()), PROJECT.projectId, PROJECT.projectTag);
    expect(snapshotProblems(full)).toEqual(['expected one ivy::FeatPart with its object, found 2']);
    const a = await inspectorState(documentInspector(twoDocs()), PROJECT.projectId, PROJECT.projectTag, { root: 579 });
    expect(Object.keys(a.classes)).toHaveLength(17);
    expect(Object.keys(a.classes).filter((h) => a.classes[h] === 'ivy::FeatPart')).toEqual(['585']);
    expect(Object.keys(a.classes).filter((h) => Number(h) >= 530 && Number(h) <= 575)).toEqual([]); // nothing of document 575
    expect(snapshotProblems(a)).toEqual([]);
    const b = await inspectorState(documentInspector(twoDocs()), PROJECT.projectId, PROJECT.projectTag, { root: 575 });
    expect(Object.keys(b.classes)).toHaveLength(48);
    expect(Object.keys(b.classes).filter((h) => b.classes[h] === 'ivy::FeatPart')).toEqual(['535']);
    expect(Object.keys(a.classes).filter((h) => h in b.classes)).toEqual([]);
    expect(a.undo).toBe(b.undo);
  });
  it('another document\'s change is detected by drift through the shared undo history, and NOT when it leaves undo alone', async () => {
    const td = twoDocs();
    const before = await inspectorState(documentInspector(td), PROJECT.projectId, PROJECT.projectTag, { root: 579 });
    const u = JSON.parse(td.undo);
    u.marks.push({ mark_id: 5, source_cmd: '6|0|', is_current: true, queue_index: 4, mark: [{ change_type: 1, class_name: 'ivy::StableHub', obj_id: 574 }] });
    u.can_undo_step = 4; u.markNum = 5;
    const marked = await inspectorState(documentInspector({ ...td, undo: JSON.stringify(u) }), PROJECT.projectId, PROJECT.projectTag, { root: 579 });
    expect(checkDrift(before, marked)).toEqual(['undo history changed (undo 3→4, redo 0→0, marks 1,2,3,4→1,2,3,4,5)']);
    const unmarked = await inspectorState(documentInspector({ ...td, object: (h) => (h === '574' ? '{"changed":true}' : td.object(h)) }), PROJECT.projectId, PROJECT.projectTag, { root: 579 });
    expect(checkDrift(before, unmarked)).toEqual([]); // limitation: object state outside the document is not read
  });
  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses root %s without touching the inspector', async (root) => {
    const ins = documentInspector(plate1Full());
    await expect(inspectorState(ins, PROJECT.projectId, PROJECT.projectTag, { root })).rejects.toThrow(`document root ${root} is not a positive object handle`);
    expect(ins.roots).toEqual([]);
  });
  it.each([
    ['a missing root (Ivy: "Root object not found.")', 999, undefined, 'document graph: the document root 999 is not in the graph (not found or not materialized)'],
    ['an empty graph', 579, () => 'digraph G {\n}\n', 'document graph: the document root 579 is not in the graph (not found or not materialized)'],
    ['a root that is not a document', 585, undefined, 'document graph: the root 585 is ivy::FeatPart, not ivy::PartReference'],
  ])('fails closed on %s', async (_n, root, graph, msg) => {
    await expect(inspectorState(documentInspector(twoDocs(), { graph }), PROJECT.projectId, PROJECT.projectTag, { root })).rejects.toThrow(msg);
  });
  it('fails closed when the reply carries an object the document does not contain', async () => {
    const graph = (root: number) => rootedDot(twoDocs().dot, root).replace('}', '  "535" [label="ivy::FeatPart 535", style=filled];\n}');
    await expect(inspectorState(documentInspector(twoDocs(), { graph }), PROJECT.projectId, PROJECT.projectTag, { root: 579 }))
      .rejects.toThrow('document graph: 1 object(s) in the graph are not contained by document 579: 535');
  });
  it('fails closed when the inspector refuses the root (unmaterialized: result -1)', async () => {
    const ins = documentInspector(twoDocs(), { throwOnGraph: 'Inspector request failed with result -1.' });
    await expect(inspectorState(ins, PROJECT.projectId, PROJECT.projectTag, { root: 579 })).rejects.toThrow('Inspector request failed with result -1.');
  });
  it('liveReadPorts with a documentRoot reads the state of that document only (bracketed undo)', async () => {
    const ins = documentInspector(twoDocs());
    const ports = liveReadPorts({
      schema: undefined as never, stream: new RecordStream(), probe: async () => ({ ok: false }), inspector: ins, targets: async () => [],
      editorTargetId: 'P', project: PROJECT, documentRoot: 579, settleMs: 0,
    });
    const s = await ports.state.snapshot();
    expect(ins.roots).toEqual([579]);
    expect(Object.keys(s.classes)).toHaveLength(17);
  });
  it('the subtree helpers agree with the fixture: 579 owns 17 objects, and rootedGraphProblems accepts its own subtree', () => {
    const { classes, edges } = parseGraph(twoDocs().dot);
    const sub = documentSubtree(edges, '579');
    expect(sub.size).toBe(17);
    const only = Object.fromEntries(Object.entries(classes).filter(([h]) => sub.has(h)));
    expect(rootedGraphProblems(only, edges.filter((e) => sub.has(/^"(\d+)"/.exec(e)![1])), 579)).toEqual([]);
    expect(rootedGraphProblems(classes, edges, 579)).toEqual([`${Object.keys(classes).length - 17} object(s) in the graph are not contained by document 579: ${Object.keys(classes).filter((h) => !sub.has(h)).slice(0, 5).join(', ')}`]);
  });
});

describe.skipIf(!ready)('recordedTarget over the plate1 capture', () => {
  it('finds the reloaded model socket and the workshop/document the page sent, as in the captured write requests', () => {
    const t = recordedTarget(records, schema);
    expect(t).toMatchObject({ modelSocket: '40700.5030', sessionId: '268435459', workshopId: 1, docId: 540 });
    expect(new URL(t.url).host).toBe('127.0.0.1:8081');
    const head = template.bodies.sketchCreate.workshopHead;
    expect([Number(head.workshopId), Number(head.currentDocId)]).toEqual([t.workshopId, t.docId]);
  });
  it('throws without a model socket created while recorded', () => {
    expect(() => recordedTarget(records.filter((r) => r.type !== 'socket'), schema)).toThrow('no model socket was created while recorded');
  });
  it('throws when the page sent no workshop head on the model socket yet', () => {
    expect(() => recordedTarget(records.filter((r) => r.i <= 32), schema)).toThrow('the page has sent no request with a workshop head on model socket 40700.5030');
  });
});

/** Replays the plate1 capture through the real recorder (fake CDP) into a real RecordStream. */
async function recordPlate1(stream: RecordStream, recs: any[] = records) {
  let listener: ((m: string, p: unknown) => void) | undefined;
  const conn: CdpConnection = { send: async () => ({}), onEvent: (l) => { listener = l; }, close: () => {} };
  const mark = await attachRecorder(new ReadOnlyCdp(conn), stream.write);
  for (const r of recs) {
    if (r.type === 'mark') mark(r.text);
    else if (r.type === 'socket') listener!('Network.webSocketCreated', { requestId: r.requestId, url: r.url });
    else if (r.type === 'frame') listener!(r.dir === 'sent' ? 'Network.webSocketFrameSent' : 'Network.webSocketFrameReceived', { requestId: r.requestId, timestamp: r.ts, response: { opcode: r.opcode, mask: r.mask, payloadData: r.payload } });
    else if (r.type === 'closed') listener!('Network.webSocketClosed', { requestId: r.requestId, timestamp: r.ts });
    else listener!('Network.webSocketFrameError', { requestId: r.requestId, timestamp: r.ts, errorMessage: r.message });
  }
  return listener!;
}

describe.skipIf(!ready)('liveReadPorts over a real recorder and RecordStream', () => {
  const okProbe = async (): Promise<PageResult> => ({ ok: true, project: { projectId: '37649921', projectTag: 'main', valid: true } });
  const page = { id: 'P', type: 'page', url: 'https://local.zixel.cn:8080/a/mda/zcad?id=1' };
  const make = (stream: RecordStream, o: { probe?: () => Promise<PageResult>; ins?: ReturnType<typeof fakeInspector>; targets?: any[] } = {}) => liveReadPorts({
    schema, stream, probe: o.probe ?? okProbe, inspector: o.ins ?? fakeInspector(), targets: async () => o.targets ?? [page],
    editorTargetId: 'P', project: PROJECT, settleMs: 0,
  });

  it('serves the capture with its own indices and derives identity and the (incomplete) inventory from it', async () => {
    const stream = new RecordStream();
    await recordPlate1(stream);
    const ports = make(stream);
    expect(ports.traffic.position()).toBe(records.length);
    expect(ports.traffic.since(0).map((r) => r.i)).toEqual(records.map((r) => r.i));
    expect(await ports.identity.current()).toEqual({ ...PROJECT, workshopId: 1, docId: 540, modelSocket: '40700.5030', sessionId: '268435459' });
    // Incomplete: the pre-reload sockets were never seen to close (socketinventory.test.ts has the clean case).
    expect(await ports.identity.modelSockets()).toMatchObject({ complete: false, modelSockets: ['40700.5030'] });
    expect((await ports.identity.modelSockets()).why).toHaveLength(3);
    const s = await ports.state.snapshot();
    expect(Object.keys(s.classes).length).toBeGreaterThan(0);
  });
  it.each([
    ['the page probe fails', { probe: async () => ({ ok: false, error: 'page socket service missing or changed' }) }, 'page probe failed: page socket service missing or changed'],
    ['the project is not active', { ins: fakeInspector({ projects: [] }) }, 'project 37649921/main is not active in zcad_service'],
    ['the document is not a PartReference', { ins: fakeInspector({ doc: '{"class_name":"ivy::FeatPart"}' }) }, 'object 540 is ivy::FeatPart, not ivy::PartReference'],
  ])('identity throws when %s', async (_n, o, msg) => {
    const stream = new RecordStream();
    await recordPlate1(stream);
    await expect(make(stream, o as any).identity.current()).rejects.toThrow(msg);
  });
  it('the inventory is incomplete when another target exists', async () => {
    const stream = new RecordStream();
    await recordPlate1(stream);
    expect((await make(stream, { targets: [page, { id: 'W', type: 'service_worker', url: 'https://x/sw.js' }] }).identity.modelSockets()).complete).toBe(false);
  });
  it('a recorder reattached onto the same stream breaks every port that reads traffic', async () => {
    const stream = new RecordStream();
    await recordPlate1(stream);
    const ports = make(stream);
    const again = await recordPlate1(stream); // indices restart at 0
    again('Network.webSocketClosed', { requestId: 'x', timestamp: 0 });
    expect(() => ports.traffic.position()).toThrow(/traffic stream broken/);
    await expect(ports.identity.current()).rejects.toThrow(/traffic stream broken/);
    await expect(ports.identity.modelSockets()).rejects.toThrow(/traffic stream broken/);
  });
});

// Guardrail only (a text scan proves nothing about behaviour): the live read ports and every script stay without a
// sender and never construct a write guard.
// Guardrails only (a text scan proves nothing about behaviour). The one sender is src/writesender.ts (approved
// 2026-10-13, disarmed by default); the one script that may arm it is plate-trial.ts, behind writeGate.
describe('one sender, one gated write path (guardrail)', () => {
  const dir = path.join(import.meta.dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((f) => f.endsWith('.ts')).map((f) => `scripts/${f}`);
  it.each(['src/liveports.ts', ...scripts.filter((f) => f !== 'scripts/plate-trial.ts')])('%s has no write path', (f) => {
    expect(read(f)).not.toMatch(/new LiveWriteGuard|sendRaw|PageSender|getRawAsyncMessage|enabled:\s*true|armed:\s*true|runPlateTrial\(|from '\.\.?\/src\/(writeport|writeseq|writesender)'|from '\.\/(writeport|writeseq|writesender)'/);
  });
  const all = ['src', 'scripts'].flatMap((d) => fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.ts')).map((f) => `${d}/${f}`));
  it.each(all.filter((f) => f !== 'src/writesender.ts'))('%s implements no sender', (f) => {
    expect(read(f)).not.toMatch(/async\s+sendRaw\s*\(|sendRaw\s*:\s*(async|\(|function)|sendRaw\s*\([^)]*\)\s*\{/);
  });
  it('plate-trial.ts arms the sender and runs the trial only after writeGate passed, once', () => {
    const s = read('scripts/plate-trial.ts');
    const gate = s.indexOf('const gate = writeGate('), stop = s.indexOf('if (gate.length)', gate);
    expect(gate).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(gate);
    for (const use of ['armed: true', 'runPlateTrial({']) {
      expect(s.split(use)).toHaveLength(2); // exactly once
      expect(s.indexOf(use)).toBeGreaterThan(stop);
    }
    expect(s).not.toMatch(/new LiveWriteGuard|enabled:\s*true/);
  });
});

describe.skipIf(!ready)('the bound server session (ready identifier) and the proposed session-list port', () => {
  const okProbe = async (): Promise<PageResult> => ({ ok: true, project: { projectId: '37649921', projectTag: 'main', valid: true } });
  const READY = 32; // plate1: {"event":"ready","identifier":"268435459"} on 40700.5030
  it('the ready frame is the captured one', () => {
    expect(JSON.parse(records.find((r) => r.i === READY).payload)).toEqual({ event: 'ready', identifier: '268435459' });
  });
  it.each([
    ['no ready event', () => records.filter((r) => r.i !== READY), 'model socket 40700.5030: expected one ready event naming a session, saw []'],
    ['two ready events', () => [...records, { ...records.find((r) => r.i === READY), i: 9000 }], 'model socket 40700.5030: expected one ready event naming a session, saw ["268435459","268435459"]'],
    ['a ready without a session', () => records.map((r) => (r.i === READY ? { ...r, payload: '{"event":"ready"}' } : r)), 'model socket 40700.5030: expected one ready event naming a session, saw [null]'],
  ])('recordedTarget throws on %s', (_n, recs, msg) => {
    expect(() => recordedTarget(recs(), schema)).toThrow(msg);
  });
  it('identity refuses a model socket that is not the local zcad_service (its session id would not be the server key)', async () => {
    const stream = new RecordStream();
    await recordPlate1(stream, records.map((r) => (r.type === 'socket' && r.requestId === '40700.5030' ? { ...r, url: 'ws://10.0.0.5:8081/zcad/client?projectId=37649921&projectTag=main&appId=1002' } : r)));
    const ports = liveReadPorts({ schema, stream, probe: okProbe, inspector: fakeInspector(), targets: async () => [], editorTargetId: 'P', project: PROJECT, settleMs: 0 });
    await expect(ports.identity.current()).rejects.toThrow('the model socket is ws://10.0.0.5:8081, not the local zcad_service (ws://127.0.0.1:8081): its session id is not comparable');
  });
  const withSessions = (reply: string | Error) => {
    const base = fakeInspector();
    return { call: async (tool: string, args: Record<string, unknown> = {}) => {
      if (tool !== 'zcad_list_sessions') return base.call(tool, args);
      if (reply instanceof Error) throw reply;
      return reply;
    } };
  };
  const portsWith = (ins: { call: (t: string, a?: Record<string, unknown>) => Promise<string> }) =>
    liveReadPorts({ schema, stream: new RecordStream(), probe: okProbe, inspector: ins, targets: async () => [], editorTargetId: 'P', project: PROJECT, settleMs: 0 });
  it('sessions() returns the server list for the bound project', async () => {
    expect(await portsWith(withSessions('{"projectId":37649921,"projectTag":"main","sessions":["268435459"]}')).identity.sessions()).toEqual({ sessions: ['268435459'], source: 'server' });
  });
  it('sessions() refuses a list for another project', async () => {
    await expect(portsWith(withSessions('{"projectId":1,"projectTag":"main","sessions":["268435459"]}')).identity.sessions()).rejects.toThrow('the session list is for 1/main, not 37649921/main');
  });
  it('sessions() fails while Ivy has no such tool (the guard then refuses)', async () => {
    await expect(portsWith(withSessions(new Error('inspector error -32602: Unknown tool: zcad_list_sessions'))).identity.sessions()).rejects.toThrow('Unknown tool: zcad_list_sessions');
  });
});

describe.skipIf(!ready)('identity ignores our own requests; attested exclusivity', () => {
  const okProbe = async (): Promise<PageResult> => ({ ok: true, project: { projectId: '37649921', projectTag: 'main', valid: true } });
  /** A copy of the captured sketchCreate frame (113) aimed at another document: what a write of ours could carry. */
  const ourFrame = () => {
    const rec = records.find((r) => r.i === 113);
    let raw = Buffer.from(rec.payload, 'base64');
    if (raw[0] === 0x5a && raw[1] === 1) raw = raw.subarray(35);
    const P = schema.IvyPkg; const pkg: any = P.decode(raw);
    pkg.appModelReq.workshopHead.workshopId = 9; pkg.appModelReq.workshopHead.currentDocId = 999;
    return { ...rec, i: 9000, payload: Buffer.from(P.encode(pkg).finish()).toString('base64') };
  };
  it('a sent frame carrying one of our bodies is not taken as the page\'s target', () => {
    const f = ourFrame();
    expect(recordedTarget([...records, f], schema)).toMatchObject({ workshopId: 9, docId: 999 }); // counted when not known as ours
    const body = sentBody(f, 100)!;
    expect(recordedTarget([...records, f], schema, [body])).toMatchObject({ workshopId: 1, docId: 540 });
  });
  it('attested exclusivity names the bound session, labelled as attested; an empty statement is refused', async () => {
    const stream = new RecordStream();
    await recordPlate1(stream);
    const mk = (statement: string) => liveReadPorts({ schema, stream, probe: okProbe, inspector: fakeInspector(), targets: async () => [], editorTargetId: 'P', project: PROJECT, settleMs: 0, exclusivity: { kind: 'attested', statement } });
    expect(await mk('only I have project 37660626 open').identity.sessions()).toEqual({ sessions: ['268435459'], source: 'attested' });
    await expect(mk('  ').identity.sessions()).rejects.toThrow("an attested exclusivity needs the user's statement");
  });
});
