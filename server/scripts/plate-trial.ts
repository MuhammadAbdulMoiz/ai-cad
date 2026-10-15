// First plate trial (100 × 60 mm sketch, 8 mm extrusion). By default PREFLIGHT ONLY: nothing is sent. Sending needs
// all of writeGate (src/platetrial.ts): --write, a preflight in which every check passed, --attest "<statement>"
// (no server session list exists, so exclusivity is the user's attestation, recorded as such), and the user typing
// "write" after seeing the plan. Then PageSender is armed and runPlateTrial runs the nine guarded steps, the guard's
// final check, a final snapshot and read-only evidence (parameter query, face measurements). Every stage is saved;
// nothing is retried, undone or deleted. Every id comes from the live page and inspector.
//
// usage: pnpm -C server exec tsx scripts/plate-trial.ts <label> --id <editor url id> --project <projectId>
//          [--target auto|<devtools tab id>] [--origin <https origin>] [--wait <s>] [--attest "<statement>"]
//          [--sketch-name <name>] [--existing-sketch <name>] [--write]
// --target auto: the single open page, only if it is an empty tab (chrome://newtab/ or about:blank); the script prints
// the exact editor URL to load there by hand, waits (--wait, default 300 s) until the editor has loaded and been quiet
// for 3 s (at most 20 s, else it refuses), runs the preflight and ends with one summary (also summary.txt) naming the
// next required action. Without --target: press F5 in the editor tab after "recorder attached". The script never
// navigates, clicks or reloads, and a passing preflight never sends anything by itself.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connect, findEditorTab, shortUrl } from '../src/cdpconnect';
import { ReadOnlyCdp } from '../src/cdpguard';
import { config } from '../src/config';
import { Inspector } from '../src/inspector';
import { checkDrift, sessionProblems, snapshotProblems } from '../src/livewriteguard';
import { liveReadPorts, parseGraph, recordedTarget } from '../src/liveports';
import { PageCall } from '../src/pagecall';
import { FIRST_PLATE, preparePlate, runPlateTrial, sketchContentsFrom, writeGate } from '../src/platetrial';
import { attachRecorder, RecordStream } from '../src/recorder';
import { checkPlateDefinition, type DefinitionCheck } from '../src/platedefinition';
import { readTrialEvidence } from '../src/trialevidence';
import { buildSummary, editorUrl, matchesEditorUrl, selectEmptyTab, waitForQuiet, type SummaryInput } from '../src/trialworkflow';
import { WorkerMonitor } from '../src/workermonitor';
import { PageSender } from '../src/writesender';
import { decodeCapture, loadSchema } from '../src/wsframes';

/** The one allowlisted service worker (approved 2026-10-13), by exact script URL; it is monitored, never ignored. */
const ALLOWED_SERVICE_WORKER = 'https://local.zixel.cn:8080/a/mda/obs-cache.js';
const SETTLE_MS = 3000;
const FACES = [0, 4]; // plate1: face 0 was a side (100 × 8), face 4 the top (100 × 60); others are measured by hand

const [label, ...rest] = process.argv.slice(2);
const arg = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const wantId = arg('id'), wantProject = Number(arg('project')), targetArg = arg('target'), attestation = arg('attest');
const wantWrite = rest.includes('--write');
// A document that already holds an empty sketch (e.g. Sketch1 from plate-trial-write1): name it with --existing-sketch
// and give the new one another name with --sketch-name; the preflight still refuses anything else already there.
const existingSketch = arg('existing-sketch');
const spec = { ...FIRST_PLATE, ...(arg('sketch-name') ? { sketchName: arg('sketch-name')! } : {}), ...(existingSketch ? { existingSketches: [existingSketch] } : {}) };
const waitS = Number(arg('wait') ?? 300);
if (!label || !/^[\w-]+$/.test(label) || !wantId || !Number.isSafeInteger(wantProject) || !(Number.isInteger(waitS) && waitS >= 10 && waitS <= 3600)) {
  console.error('usage: plate-trial <label> --id <url id> --project <projectId> [--target auto|<tab id>] [--origin <https origin>] [--wait <s, 10–3600>] [--attest "<statement>"] [--sketch-name <name>] [--existing-sketch <name>] [--write]'); process.exit(2);
}
let url: string;
try { url = editorUrl(arg('origin') ?? 'https://local.zixel.cn:8080', wantId, wantProject); } catch (e) { console.error((e as Error).message); process.exit(2); }
const out = path.join(config.runsDir, `plate-trial-${label}`);
if (fs.existsSync(out)) { console.error(`${out} exists; pick a new label`); process.exit(2); }

const schema = loadSchema(process.env.IVY_REPO || 'C:\\zixel\\ivyproject');
const ins = new Inspector(config.inspectorUrl, 30000);
type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };
const listTargets = async (): Promise<Target[]> => (await fetch(`http://127.0.0.1:${config.cdpPort}/json/list`)).json();
// --target auto: the one open page, and only if it is an empty tab. Nothing is navigated or changed either way.
let targetId = targetArg;
if (targetArg === 'auto') {
  const pick = selectEmptyTab(await listTargets());
  if (!pick.id) { console.error(`${pick.problem}\nOpen exactly one empty tab (chrome://newtab or about:blank) yourself, then rerun.`); process.exit(1); }
  targetId = pick.id;
}
const tab = await findEditorTab(config.cdpPort, targetId);
// The recorded tab must show exactly the printed editor URL: origin, path, id and project (not only the query).
const tabMatches = (u: string) => matchesEditorUrl(u, url);
if (!targetArg && !tabMatches(tab.url)) { console.error(`the editor tab is ${shortUrl(tab.url)}, not the named target`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const file = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
const stream = new RecordStream();
const recorder = new ReadOnlyCdp(await connect(tab.webSocketDebuggerUrl));
await attachRecorder(recorder, (r) => { stream.write(r); fs.writeSync(file, JSON.stringify(r) + '\n'); });
// The allowlisted service worker starts with the editor, after this recorder attached: the target list is polled and
// a separate read-only recorder attaches the moment the worker appears (workermonitor.ts). Unmonitored, it is refused.
const swFile = fs.openSync(path.join(out, 'service-worker-frames.jsonl'), 'a');
const worker = new WorkerMonitor(ALLOWED_SERVICE_WORKER, {
  list: listTargets, stream: new RecordStream(),
  attach: async (t, write) => {
    const cdp = new ReadOnlyCdp(await connect(t.webSocketDebuggerUrl!));
    await attachRecorder(cdp, (r) => { write(r); fs.writeSync(swFile, JSON.stringify(r) + '\n'); });
    return { ping: async () => { await cdp.send('Network.enable'); }, detach: () => cdp.detach() };
  },
});
const workerPoll = setInterval(() => { worker.poll().catch(() => { /* list unavailable this round; check() decides */ }); }, 250);
const page = new PageCall(await connect(tab.webSocketDebuggerUrl));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const save = (name: string, data: unknown) => fs.writeFileSync(path.join(out, name.includes('.') ? name : `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
console.log(`recorder attached to ${targetId ? `tab ${tab.id}` : shortUrl(tab.url)} (evidence: ${out})`);
console.log(targetId
  ? `ACTION REQUIRED (manual): load ${url} in tab ${tab.id} now. Waiting up to ${waitS} s; the preflight starts on its own once the editor is loaded and quiet.`
  : `ACTION REQUIRED (manual): press F5 in the editor tab now. Waiting up to ${waitS} s; the preflight starts on its own once the editor is loaded and quiet.`);

type Check = { check: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
const result: Record<string, unknown> = { label, tab: tab.id, exclusivity: attestation ? { kind: 'attested', statement: attestation } : { kind: 'server' }, checks };
let sender: PageSender | undefined;
const done = (verdict: string): never => {
  clearInterval(workerPoll);
  const w = worker.report();
  result.verdict = verdict; result.serviceWorker = w;
  save('result', result);
  console.log(`\n== ${verdict} ==`);
  for (const c of checks) console.log(`  [${c.pass ? 'pass' : 'FAIL'}] ${c.check}${c.pass || c.detail === undefined ? '' : `: ${JSON.stringify(c.detail)}`}`);
  console.log(`service worker ${w.url}: first seen ${w.firstSeenAt ?? 'never'} (target ${w.firstSeenTargetId ?? '-'}), recorder attached ${w.attachedAt ?? 'never'} (target ${w.targetId ?? '-'}), gap ${w.gapMs ?? '-'} ms, activity records ${w.activity}${w.failed ? `, attach failed: ${w.failed}` : ''}${w.replacedBy ? `, replaced by ${w.replacedBy.join(',')}` : ''}, accepted: ${w.accepted ?? 'not judged'}`);
  console.log(`  ${w.note}`);
  const trial = result.trial as { outcome?: { sent?: string[] } } | undefined;
  const summary = buildSummary({
    label, verdict, out, url, identity: result.identity as SummaryInput['identity'], docUuid: result.docUuid as string | undefined,
    plan: result.plan as SummaryInput['plan'], checks, worker: w, attested: !!attestation, sending: result.sending, sent: trial?.outcome?.sent, definition: result.definition as DefinitionCheck | undefined,
  });
  save('summary.txt', summary + '\n');
  console.log(`\n${summary}`);
  recorder.detach(); worker.detach(); page.close(); sender?.close(); fs.closeSync(file); process.exit(0);
};
const ask = (q: string) => new Promise<string>((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a.trim()); }); });

try {
  let ok = false;
  let ready: ReturnType<typeof recordedTarget> | undefined;
  for (let k = 0; k < waitS && !ready; k++) { await sleep(1000); try { ready = recordedTarget(stream.since(0), schema); } catch { /* not yet */ } }
  if (!ready) { checks.push({ check: `model socket created and a workshop head sent while recorded (within ${waitS} s)`, pass: false }); done('incomplete'); }
  const now = (await listTargets()).find((t) => t.id === tab.id);
  checks.push({ check: 'the recorded tab is the named editor target', pass: !!now && tabMatches(now.url), detail: now ? shortUrl(now.url) : 'tab gone' });
  if (!now || !tabMatches(now.url)) done('preflight-refused');
  // Readiness: the page has sent no request on the model socket for 3 s (at most 20 s); otherwise refuse, never guess.
  const quiet = await waitForQuiet({ recs: () => stream.since(0), modelSocket: ready!.modelSocket, quietMs: 3000, capMs: 20000 });
  checks.push({ check: 'editor quiet for 3 s before reading state (cap 20 s)', pass: quiet.quiet, detail: quiet.quiet ? undefined : `still sending requests after ${quiet.waitedMs} ms` });
  if (!quiet.quiet) done('preflight-refused');
  console.log(`editor loaded and quiet after ${quiet.waitedMs} ms; running the preflight (read-only)`);
  const probe = await page.probe();
  const project = { projectId: Number(probe.project?.projectId), projectTag: probe.project?.projectTag ?? '' };
  const base = {
    schema, stream, probe: () => page.probe(), inspector: ins, editorTargetId: tab.id, project, settleMs: SETTLE_MS,
    targets: listTargets, ownBodies: () => sender?.sentBodies() ?? [],
    exclusivity: attestation ? { kind: 'attested' as const, statement: attestation } : { kind: 'server' as const },
    serviceWorker: { url: ALLOWED_SERVICE_WORKER, check: (ts: Array<{ id: string; type: string; url: string }>) => worker.check(ts) },
  };
  const id = await liveReadPorts(base).identity.current().catch((e) => { checks.push({ check: 'identity', pass: false, detail: errorOf(e) }); return done('preflight-refused'); });
  result.identity = id;
  result.docUuid = JSON.parse(await ins.call('zcad_get_object_json', { ...project, objectId: id.docId })).uuid;
  const ports = liveReadPorts({ ...base, documentRoot: id.docId });

  const fullDot = await ins.call('zcad_get_object_graph', { ...project, rootEntityId: 0 });
  save('graph-full.dot', fullDot);
  const s1 = await ports.state.snapshot().catch((e) => { checks.push({ check: 'document snapshot', pass: false, detail: errorOf(e) }); return done('preflight-refused'); });
  save('state-document-1', s1);
  await sleep(3000);
  const s2 = await ports.state.snapshot().catch((e) => { checks.push({ check: 'document snapshot (again)', pass: false, detail: errorOf(e) }); return done('preflight-refused'); });
  save('state-document-2', s2);

  // The only accepted evidence that an existing sketch is empty: data notifications recorded on the bound model socket
  // in this session (the inspector shows sketch contents only as opaque state). Usually none at load: then refused.
  const sketchContents = sketchContentsFrom(decodeCapture(stream.since(0).filter((r) => r.type === 'frame' && r.requestId === id.modelSocket), schema), id.docId);
  const prep = preparePlate(s2, parseGraph(fullDot).classes, spec, { sketchContents });
  checks.push({ check: 'trial preconditions (single document, empty part, XY plane, no redo, names free)', pass: !prep.problems.length, detail: prep.problems });
  if (prep.plan) { result.plan = prep.plan; save('plan', prep.plan); }
  checks.push({ check: 'document snapshot well-formed', pass: !snapshotProblems(s2).length, detail: snapshotProblems(s2) });
  const drift = snapshotProblems(s1).length ? ['not comparable'] : checkDrift(s1, s2);
  checks.push({ check: 'no drift over 3 s', pass: !drift.length, detail: drift });
  const inv = await ports.identity.modelSockets().catch((e) => ({ complete: false, modelSockets: [] as string[], why: [errorOf(e)] }));
  checks.push({ check: 'browser model-socket inventory complete (service worker allowlisted only while monitored)', pass: inv.complete, detail: inv.why });
  checks.push({ check: 'inventory is exactly the bound socket', pass: inv.modelSockets.length === 1 && inv.modelSockets[0] === id.modelSocket, detail: inv.modelSockets });
  const sess = await ports.identity.sessions().then((r) => sessionProblems(r, id.sessionId)).catch((e) => [`session list unavailable: ${errorOf(e)}`]);
  checks.push({
    check: attestation
      ? `exclusivity ATTESTED by the user, not verified by the server ("${attestation}"); WebSocket sessions only, HTTP and pipeline requests not covered`
      : `server WebSocket sessions are exactly the bound session ${id.sessionId} (HTTP routes and pipeline requests not covered)`,
    pass: !sess.length, detail: sess,
  });
  const again = await ports.identity.current().catch((e) => errorOf(e));
  checks.push({ check: 'identity stable', pass: JSON.stringify(again) === JSON.stringify(id), detail: typeof again === 'string' ? again : undefined });
  const passed = checks.every((c) => c.pass);
  if (!wantWrite) { result.sending = 'disabled (no --write)'; done(passed ? 'preflight-passed' : 'preflight-refused'); }

  // ---- the write path: only through writeGate
  console.log(`\nPlan: ${JSON.stringify(prep.plan)}\nTarget: ${JSON.stringify(id)}`);
  const pre = writeGate({ flag: wantWrite, preflightPassed: passed, attestation, typed: 'write' }); // everything but the typed word
  if (pre.length) { result.sending = pre; done('write-refused'); }
  const typed = await ask('Type "write" to send the nine steps to this document (anything else stops): ');
  const gate = writeGate({ flag: wantWrite, preflightPassed: passed, attestation, typed });
  if (gate.length) { result.sending = gate; done('write-refused'); }

  sender = new PageSender(await connect(tab.webSocketDebuggerUrl), project, { armed: true });
  result.sending = 'armed';
  const trial = await runPlateTrial({
    schema, ports: { ...ports, sender }, bound: id, plan: prep.plan!, save, existingSketches: spec.existingSketches,
    readEvidence: async (created) => {
      if (!created.extrudeFeatureId) return {};
      const t = recordedTarget(stream.since(0), schema, sender!.sentBodies());
      const ev = await readTrialEvidence({ page, schema, stream, modelSocket: id.modelSocket, target: { ...project, workshopId: id.workshopId, docId: id.docId }, parmSetId: t.parmSetId, waitMs: 2000 }, created.extrudeFeatureId, FACES);
      return ev;
    },
  });
  result.trial = { outcome: trial.outcome, final: trial.final, post: trial.post, error: trial.error, exclusivity: trial.report.exclusivity };
  // Definition-level check (docs/write-path.md §9): from Ivy's recorded notifications, separate from the measured
  // postconditions; it changes no verdict and measures no position.
  const created = trial.outcome?.created;
  if (created?.sketchFeatureId && created.extrudeFeatureId) {
    result.definition = checkPlateDefinition(decodeCapture(stream.since(0).filter((r) => r.type === 'frame' && r.requestId === id.modelSocket), schema), { docId: id.docId, sketchId: created.sketchFeatureId, extrudeId: created.extrudeFeatureId, plan: prep.plan! });
    save('definition', result.definition);
  }
  done(trial.post?.verdict === 'verified' ? 'plate-verified' : trial.post?.verdict === 'incomplete' ? 'plate-incomplete' : 'plate-failed');
} catch (e) {
  checks.push({ check: 'ran without an exception', pass: false, detail: errorOf(e) });
  done('error');
}
