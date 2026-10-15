// Read-only live ports for the write guard (livewriteguard.ts GuardPorts): identity, state, traffic and settle. There
// is NO sender here and none may be added without separate approval; nothing in this file can send a model request.
// Sources: the page socket's project (PageCall probe mode), the recorder's RecordStream, the inspector, the DevTools
// target list. See docs/write-path.md §8.
import type { Inspector } from './inspector';
import type { GuardPorts } from './livewriteguard';
import type { PageResult } from './pagecall';
import type { CaptureRecord, RecordStream } from './recorder';
import { observedTarget, sentBody, VOLATILE, type StateSnap } from './replaycheck';
import { socketInventory, type DevToolsTarget } from './socketinventory';
import { decodeCapture, type Schema } from './wsframes';

const MODEL_SOCKET_URL = /:8081\/zcad\/client/;
type Reader = Pick<Inspector, 'call'>;

/** Vertices (handle → class) and edge lines of an inspector Graphviz dump. */
export function parseGraph(dot: string): { classes: Record<string, string>; edges: string[] } {
  const classes: Record<string, string> = {};
  for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"\s]+)/gm)) classes[m[1]] = m[2];
  return { classes, edges: [...dot.matchAll(/^\s*"\d+" -> "\d+".*$/gm)].map((m) => m[0].trim()) };
}

/** The handles reachable from `root` over `Contain` edges, root included: the objects a document owns. */
export function documentSubtree(edges: string[], root: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const m = /^"(\d+)" -> "(\d+)" \[label="Contain"/.exec(e);
    if (m) children.set(m[1], [...(children.get(m[1]) ?? []), m[2]]);
  }
  const seen = new Set<string>(), todo = [root];
  while (todo.length) { const h = todo.pop()!; if (!seen.has(h)) { seen.add(h); todo.push(...(children.get(h) ?? [])); } }
  return seen;
}

/** Why a graph dumped with `rootEntityId = root` is not exactly one part document's subtree. */
export function rootedGraphProblems(classes: Record<string, string>, edges: string[], root: number): string[] {
  const r = String(root);
  if (!(r in classes)) return [`the document root ${root} is not in the graph (not found or not materialized)`];
  if (classes[r] !== 'ivy::PartReference') return [`the root ${root} is ${classes[r]}, not ivy::PartReference`];
  const sub = documentSubtree(edges, r);
  const stray = Object.keys(classes).filter((h) => !sub.has(h));
  return stray.length ? [`${stray.length} object(s) in the graph are not contained by document ${root}: ${stray.slice(0, 5).join(', ')}`] : [];
}

/**
 * Inspector state: the object graph, every object's JSON (except volatile objects and the project), the undo history,
 * read in that order. These are separate reads and NOT atomic: the document can change between them. With
 * `bracketUndo` the undo history is also read first and the snapshot throws unless both reads are identical; that
 * detects undo-visible changes during collection only (a preview changes no undo), it does not make the snapshot atomic.
 *
 * With `root` (a PartReference handle) the graph, and so the objects, are that document's subtree only
 * (`rootEntityId`), and anything else is refused. The undo history is ALWAYS the whole project's (Ivy keeps one per
 * project, shared by all its documents): changes to another document show only through undo, never through objects.
 */
export async function inspectorState(ins: Reader, projectId: number, projectTag: string, opts: { bracketUndo?: boolean; root?: number } = {}): Promise<StateSnap> {
  if (opts.root !== undefined && !(Number.isSafeInteger(opts.root) && opts.root > 0)) throw new Error(`document root ${opts.root} is not a positive object handle`);
  const p = { projectId, projectTag };
  const first = opts.bracketUndo ? await ins.call('zcad_get_undo_history', p) : undefined;
  const dot = await ins.call('zcad_get_object_graph', { ...p, rootEntityId: opts.root ?? 0 });
  const { classes, edges } = parseGraph(dot);
  if (opts.root !== undefined) {
    const bad = rootedGraphProblems(classes, edges, opts.root);
    if (bad.length) throw new Error(`document graph: ${bad.join('; ')}`);
  }
  const objects: Record<string, string> = {};
  for (const [h, cls] of Object.entries(classes)) {
    if (VOLATILE.has(cls) || cls === 'ivy::Project') continue;
    objects[h] = await ins.call('zcad_get_object_json', { ...p, objectId: Number(h) });
  }
  const undo = await ins.call('zcad_get_undo_history', p);
  if (first !== undefined && first !== undo) throw new Error('the undo history changed while the snapshot was collected; the snapshot is inconsistent');
  return { undo, classes, objects, edges };
}

/**
 * The latest model socket the recorder saw created (its redacted URL), the server session its `ready` event named,
 * and the workshop and document of the latest request the page sent on it with a workshop head. Throws when any is
 * missing or the socket saw more than one `ready`.
 */
export function recordedTarget(recs: CaptureRecord[], schema: Schema, ownBodies: Uint8Array[] = []): { modelSocket: string; url: string; sessionId: string; workshopId: number; docId: number; parmSetId?: number } {
  const created = recs.filter((r): r is Extract<CaptureRecord, { type: 'socket' }> => r.type === 'socket' && MODEL_SOCKET_URL.test(r.url)).at(-1);
  if (!created) throw new Error('no model socket was created while recorded (reload the editor tab after the recorder attached)');
  const modelSocket = created.requestId;
  const ready = recs.flatMap((r) => {
    if (r.type !== 'frame' || r.requestId !== modelSocket || r.dir !== 'received' || r.opcode !== 1) return [];
    try { const j = JSON.parse(r.payload); return j?.event === 'ready' ? [j.identifier] : []; } catch { return []; }
  });
  if (ready.length !== 1 || typeof ready[0] !== 'string' || !/^[1-9]\d*$/.test(ready[0])) throw new Error(`model socket ${modelSocket}: expected one ready event naming a session, saw ${JSON.stringify(ready)}`);
  // Only the page's own requests count: a sent frame carrying one of our bodies (field 100) would make identity
  // confirm itself after the first write.
  const ours = ownBodies.map((b) => Buffer.from(b));
  const isOurs = (r: Extract<CaptureRecord, { type: 'frame' }>) => {
    if (r.dir !== 'sent' || r.opcode !== 2 || !ours.length) return false;
    let body: Buffer | undefined;
    try { body = sentBody(r, 100); } catch { return false; }
    return !!body && ours.some((o) => o.equals(body!));
  };
  const t = observedTarget(decodeCapture(recs.filter((r) => r.type === 'frame' && r.requestId === modelSocket && !isOurs(r)), schema));
  if (!t) throw new Error(`the page has sent no request with a workshop head on model socket ${modelSocket}`);
  return { modelSocket, url: created.url, sessionId: ready[0], workshopId: t.workshopId, docId: t.docId, ...(t.parmSetId ? { parmSetId: t.parmSetId } : {}) };
}

export type LiveDeps = {
  schema: Schema;
  stream: RecordStream;
  /** PageCall.probe: reads the page socket's project, sends nothing to Ivy. */
  probe: () => Promise<PageResult>;
  inspector: Reader;
  /** The DevTools target list (`/json/list`), read fresh on every inventory. */
  targets: () => Promise<DevToolsTarget[]>;
  editorTargetId: string;
  /** The project whose state is read. */
  project: { projectId: number; projectTag: string };
  /** The bound document (PartReference handle): object state is read for its subtree only. Undo stays project-wide. */
  documentRoot?: number;
  settleMs: number;
  /** Bodies our sender handed to the page (its sentBodies()): never counted as the page's own requests. */
  ownBodies?: () => Uint8Array[];
  /**
   * Where the guard's session exclusivity comes from. 'server': the proposed Ivy tool zcad_list_sessions (not in Ivy
   * yet: throws, so the guard refuses). 'attested': the user's statement that no other client has the project open,
   * reported as an attestation, never as server evidence: the list returned is the bound session by construction.
   */
  exclusivity?: { kind: 'server' } | { kind: 'attested'; statement: string };
  /** The allowlisted service worker and its monitor's verdict (workermonitor.ts WorkerMonitor.check). */
  serviceWorker?: { url: string; check: (targets: DevToolsTarget[]) => Promise<string[]> };
};

/** Every guard port except the sender. Each read is fresh; nothing is cached. */
export function liveReadPorts(d: LiveDeps) {
  return {
    identity: {
      async current() {
        const probe = await d.probe();
        if (!probe.ok || !probe.project) throw new Error(`page probe failed: ${probe.error ?? 'no project'}`);
        const projectId = Number(probe.project.projectId), projectTag = probe.project.projectTag;
        const t = recordedTarget(d.stream.since(0), d.schema, d.ownBodies?.() ?? []);
        // Session ids are the server's own only in local server mode (zcad_service server_service: ready.identifier).
        const u = new URL(t.url);
        if (u.protocol !== 'ws:' || u.host !== '127.0.0.1:8081') throw new Error(`the model socket is ${u.protocol}//${u.host}, not the local zcad_service (ws://127.0.0.1:8081): its session id is not comparable`);
        const projects = JSON.parse(await d.inspector.call('zcad_list_projects'));
        if (!Array.isArray(projects) || !projects.some((p: any) => p.projectId === projectId && p.projectTag === projectTag)) throw new Error(`project ${projectId}/${projectTag} is not active in zcad_service`);
        const doc = JSON.parse(await d.inspector.call('zcad_get_object_json', { projectId, projectTag, objectId: t.docId }));
        if (doc?.class_name !== 'ivy::PartReference') throw new Error(`object ${t.docId} is ${doc?.class_name}, not ivy::PartReference`);
        return { projectId, projectTag, workshopId: t.workshopId, docId: t.docId, modelSocket: t.modelSocket, sessionId: t.sessionId };
      },
      /** The PROPOSED Ivy tool zcad_list_sessions (not in Ivy yet: until it exists this throws, and the guard refuses). */
      async sessions(): Promise<{ sessions: string[]; source: 'server' | 'attested' }> {
        const ex = d.exclusivity ?? { kind: 'server' };
        if (ex.kind === 'attested') {
          if (!ex.statement.trim()) throw new Error("an attested exclusivity needs the user's statement");
          return { sessions: [recordedTarget(d.stream.since(0), d.schema, d.ownBodies?.() ?? []).sessionId], source: 'attested' };
        }
        const r = JSON.parse(await d.inspector.call('zcad_list_sessions', d.project));
        if (r?.projectId !== d.project.projectId || r?.projectTag !== d.project.projectTag) throw new Error(`the session list is for ${r?.projectId}/${r?.projectTag}, not ${d.project.projectId}/${d.project.projectTag}`);
        return { sessions: r.sessions, source: 'server' };
      },
      async modelSockets() {
        const sw = d.serviceWorker;
        const targets = await d.targets();
        return socketInventory(d.stream.since(0), targets, d.editorTargetId, sw ? { serviceWorker: { url: sw.url, problems: await sw.check(targets) } } : {});
      },
    },
    state: { snapshot: () => inspectorState(d.inspector, d.project.projectId, d.project.projectTag, { bracketUndo: true, root: d.documentRoot }) },
    traffic: { position: () => d.stream.position(), since: (p: number) => d.stream.since(p) },
    settle: () => new Promise<void>((r) => setTimeout(r, d.settleMs)),
  } satisfies Omit<GuardPorts, 'sender'>;
}
