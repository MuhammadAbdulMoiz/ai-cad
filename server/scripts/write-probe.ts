// READ-ONLY probe of a write-path target: document isolation and the guard's pre-send prerequisites. Sends nothing to
// Ivy's model: the page is only evaluated in PageCall's probe mode, the recorder is ReadOnlyCdp, and the inspector is
// asked only for zcad_list_projects, zcad_get_object_graph, zcad_get_object_json and zcad_get_undo_history. It
// constructs no guard and has no sender. Every id it uses is discovered at runtime; --id/--project only confirm that
// the open editor tab is the target the user named.
//
// usage: pnpm exec tsx scripts/write-probe.ts <label> --id <editor url id> --project <projectId>
// Press F5 in the editor tab after "recorder attached" so the model socket is created while recorded.
import fs from 'node:fs';
import path from 'node:path';
import { connect, findEditorTab, shortUrl } from '../src/cdpconnect';
import { ReadOnlyCdp } from '../src/cdpguard';
import { config } from '../src/config';
import { Inspector } from '../src/inspector';
import { checkDrift, snapshotProblems, tipOf } from '../src/livewriteguard';
import { documentSubtree, liveReadPorts, parseGraph, recordedTarget, rootedGraphProblems } from '../src/liveports';
import { PageCall } from '../src/pagecall';
import { attachRecorder, RecordStream } from '../src/recorder';
import type { StateSnap } from '../src/replaycheck';
import { loadSchema } from '../src/wsframes';

const [label, ...rest] = process.argv.slice(2);
const arg = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const wantId = arg('id'), wantProject = Number(arg('project'));
if (!label || !/^[\w-]+$/.test(label) || !wantId || !Number.isSafeInteger(wantProject)) { console.error('usage: write-probe <label> --id <url id> --project <projectId>'); process.exit(2); }
const out = path.join(config.runsDir, `write-probe-${label}`);
if (fs.existsSync(out)) { console.error(`${out} exists; pick a new label`); process.exit(2); }

const schema = loadSchema(process.env.IVY_REPO || 'C:\\zixel\\ivyproject');
const ins = new Inspector(config.inspectorUrl, 30000);
const tab = await findEditorTab(config.cdpPort); // refuses unless exactly one /zcad tab is open
const u = new URL(tab.url);
if (u.searchParams.get('id') !== wantId || Number(u.searchParams.get('projectId')) !== wantProject) {
  console.error(`the editor tab is ${shortUrl(tab.url)}?id=${u.searchParams.get('id')}&projectId=${u.searchParams.get('projectId')}, not the named target`); process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const file = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
const stream = new RecordStream();
const recorder = new ReadOnlyCdp(await connect(tab.webSocketDebuggerUrl));
await attachRecorder(recorder, (r) => { stream.write(r); fs.writeSync(file, JSON.stringify(r) + '\n'); });
const page = new PageCall(await connect(tab.webSocketDebuggerUrl));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const save = (name: string, text: string) => fs.writeFileSync(path.join(out, name), text);
console.log(`recorder attached to ${shortUrl(tab.url)} — press F5 in the editor tab now (waiting up to 180 s)`);

type Check = { check: string; pass: boolean; detail?: unknown };
const result: Record<string, unknown> = { label, tab: shortUrl(tab.url), urlId: wantId, sentToIvy: 'nothing to the model (page probe mode and inspector reads only)', guardConstructed: false };
const summary: string[] = [];
const done = (verdict: string): never => {
  result.verdict = verdict;
  save('result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n== SUMMARY (${verdict}) ==\n${summary.join('\n')}\nfull result: ${path.join(out, 'result.json')}`);
  recorder.detach(); page.close(); fs.closeSync(file); process.exit(0);
};

try {
  let target: ReturnType<typeof recordedTarget> | undefined;
  for (let k = 0; k < 180 && !target; k++) {
    await sleep(1000);
    try { target = recordedTarget(stream.since(0), schema); } catch { /* not yet */ }
  }
  if (!target) { result.problem = 'no model socket created and no workshop head sent while recorded (was the tab reloaded?)'; summary.push('No reload observed: nothing was inspected.'); done('incomplete'); }
  await sleep(5000); // let the page finish loading before reading state

  const probe = await page.probe();
  const project = { projectId: Number(probe.project?.projectId), projectTag: probe.project?.projectTag ?? '' };
  const portsFor = (documentRoot?: number) => liveReadPorts({
    schema, stream, probe: () => page.probe(), inspector: ins, editorTargetId: tab.id, project, documentRoot, settleMs: 0,
    targets: async () => (await fetch(`http://127.0.0.1:${config.cdpPort}/json/list`)).json(),
  });
  const id1 = await portsFor().identity.current().catch((e) => {
    result.problem = `identity: ${errorOf(e)}`; summary.push(`Identity could not be established: ${errorOf(e)}`); return done('incomplete');
  });
  const p = { projectId: id1.projectId, projectTag: id1.projectTag }, docId = id1.docId;
  result.identity = { ...id1, pageProject: probe.project, projectMatchesUrl: id1.projectId === wantProject };
  const ports = portsFor(docId);

  // ---- document isolation: the rooted graph must be exactly the document's subtree in the full project graph
  const undoBefore = await ins.call('zcad_get_undo_history', p);
  const fullDot = await ins.call('zcad_get_object_graph', { ...p, rootEntityId: 0 });
  const docDot = await ins.call('zcad_get_object_graph', { ...p, rootEntityId: docId });
  save('graph-full.dot', fullDot); save('graph-document.dot', docDot);
  const full = parseGraph(fullDot), doc = parseGraph(docDot);
  const sub = documentSubtree(full.edges, String(docId));
  const expectedEdges = full.edges.filter((e) => sub.has(/^"(\d+)"/.exec(e)![1]));
  const diff = (a: Iterable<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
  const docHandles = new Set(Object.keys(doc.classes)), docEdges = new Set(doc.edges);
  const isolation = {
    rootedProblems: rootedGraphProblems(doc.classes, doc.edges, docId),
    objects: { document: docHandles.size, expectedFromProjectGraph: sub.size, project: Object.keys(full.classes).length },
    missingFromDocumentGraph: diff(sub, docHandles), extraInDocumentGraph: diff(docHandles, sub),
    classMismatches: [...sub].filter((h) => h in doc.classes && doc.classes[h] !== full.classes[h]),
    edges: { document: doc.edges.length, expected: expectedEdges.length, missing: diff(expectedEdges, docEdges).length, extra: diff(doc.edges, new Set(expectedEdges)).length },
    featParts: Object.keys(doc.classes).filter((h) => doc.classes[h] === 'ivy::FeatPart'),
    otherDocuments: Object.keys(full.classes).filter((h) => full.classes[h] === 'ivy::PartReference' && h !== String(docId)),
  };
  const isolated = !isolation.rootedProblems.length && !isolation.missingFromDocumentGraph.length && !isolation.extraInDocumentGraph.length
    && !isolation.classMismatches.length && !isolation.edges.missing && !isolation.edges.extra && isolation.featParts.length === 1;
  result.isolation = { ...isolation, isolated };

  // ---- state through the port (document objects, project-wide undo), twice, 3 s apart
  const snap = async (n: string) => { try { return await ports.state.snapshot(); } catch (e) { result[`${n}Error`] = errorOf(e); return undefined; } };
  const s1 = await snap('snapshot1');
  await sleep(3000);
  const s2: StateSnap | undefined = await snap('snapshot2');
  const undoAfter = await ins.call('zcad_get_undo_history', p);
  const undoSummary = (t: string) => { try { const x = JSON.parse(t); return { canUndo: x.can_undo_step, canRedo: x.can_redo_step, marks: x.markNum, currentMarkId: x.currentMarkId }; } catch { return 'unparsable'; } };
  result.undo = { scope: 'project (shared by every document of the project; NOT document-scoped)', before: undoSummary(undoBefore), after: undoSummary(undoAfter), unchangedDuringProbe: undoBefore === undoAfter };
  if (s2) save('state-document.json', JSON.stringify(s2, null, 2));

  // ---- the guard's pre-send target checks for a first step (tip/plane need a plan and are reported as facts)
  const checks: Check[] = [];
  const inv = await ports.identity.modelSockets().catch((e) => ({ complete: false, modelSockets: [] as string[], why: [`inventory failed: ${errorOf(e)}`] }));
  checks.push({ check: 'model-socket inventory complete', pass: inv.complete === true, detail: inv.why });
  checks.push({ check: 'inventory is exactly the bound socket', pass: inv.modelSockets.length === 1 && inv.modelSockets[0] === id1.modelSocket, detail: { inventory: inv.modelSockets, bound: id1.modelSocket } });
  const id2 = await ports.identity.current().catch((e) => errorOf(e));
  checks.push({ check: 'identity stable during the probe', pass: JSON.stringify(id2) === JSON.stringify(id1), detail: typeof id2 === 'string' ? id2 : undefined });
  checks.push({ check: 'document graph is exactly the document subtree', pass: isolated });
  const bad = s2 ? snapshotProblems(s2) : [`snapshot failed: ${result.snapshot2Error}`];
  checks.push({ check: 'document snapshot well-formed (one FeatPart)', pass: !bad.length, detail: bad });
  const drift = s1 && s2 && !bad.length && !snapshotProblems(s1).length ? checkDrift(s1, s2) : ['not comparable'];
  checks.push({ check: 'no drift over 3 s (document objects + project undo)', pass: !drift.length, detail: drift });
  checks.push({ check: 'project undo unchanged during the probe', pass: undoBefore === undoAfter });
  const u2 = s2 && !bad.length ? JSON.parse(s2.undo) : undefined;
  checks.push({ check: 'no redo history (project)', pass: u2?.can_redo_step === 0, detail: u2?.can_redo_step });
  const pos = stream.position();
  checks.push({ check: 'traffic position is a record index', pass: Number.isSafeInteger(pos) && pos >= 0, detail: pos });
  if (s2 && !bad.length) {
    const feats = (cls: string) => Object.keys(s2.classes).filter((h) => s2.classes[h] === cls).map((h) => { const a = JSON.parse(s2.objects[h]).attr_first_ ?? {}; return { handle: h, id: a._id, name: a._name }; });
    result.document = { tip: tipOf(s2), originPlanes: feats('ivy::FeatOriginPlane'), sketches: feats('ivy::FeatSketch'), extrudes: feats('ivy::SolidExtrude') };
  }
  const failed = checks.filter((c) => !c.pass);
  result.guardPrerequisites = {
    checks, allPass: failed.length === 0, notCheckedWithoutAPlan: ['tip = plan.tipFeatureId', 'one origin plane with plan.planeFeatureId'],
    writeAuthorized: false, note: 'No write is authorized by this probe. Passing prerequisites would only mean the guard\'s target checks would not refuse a first step; there is no sender.',
  };

  summary.push(`Target: project ${id1.projectId}/${id1.projectTag}, workshop ${id1.workshopId}, document ${docId}, model socket ${id1.modelSocket}.`);
  summary.push(`Isolation: ${isolated ? 'CONFIRMED' : 'NOT confirmed'}. Document graph ${isolation.objects.document} objects (expected ${isolation.objects.expectedFromProjectGraph} of ${isolation.objects.project} in the project), FeatPart ${isolation.featParts.join(',') || 'none'}, edges ${isolation.edges.document}/${isolation.edges.expected}, other documents: ${isolation.otherDocuments.join(',') || 'none'}.`);
  summary.push(`Undo (project-wide): ${undoBefore === undoAfter ? 'unchanged' : 'CHANGED'} during the probe.`);
  for (const c of checks) summary.push(`  [${c.pass ? 'pass' : 'FAIL'}] ${c.check}${c.pass || c.detail === undefined ? '' : `: ${JSON.stringify(c.detail)}`}`);
  summary.push(failed.length ? `The guard would refuse a first step (${failed.length} prerequisite(s) fail). No write is authorized.` : 'All target prerequisites pass. This does not authorize a write; there is no sender.');
  done(isolated ? 'isolation-confirmed' : 'isolation-mismatch');
} catch (e) {
  result.error = errorOf(e);
  summary.push(`Stopped by an error: ${errorOf(e)}`);
  done('error');
}
