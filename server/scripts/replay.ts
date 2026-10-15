// Phase 2b replay (approved 2026-10-13): sends ONE approved read operation to Ivy through the editor page and proves
// what happened. One operation per run; the human reloads the tab ("ready") and confirms the document ("confirm")
// before anything is sent. Recorder, identity checks, before/after inspector state and the traffic check all run.
//
// usage: pnpm replay <label> param
//        pnpm replay <label> measure --feature <featId> --face <faceIndex>
// stdin: "ready" after F5 and idle, then "confirm" to send, or "quit".
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connect, findEditorTab, shortUrl } from '../src/cdpconnect';
import { ReadOnlyCdp } from '../src/cdpguard';
import { config } from '../src/config';
import { Inspector } from '../src/inspector';
import { PageCall, type PageResult } from '../src/pagecall';
import type { Op } from '../src/queryport';
import { attachRecorder, type CaptureRecord } from '../src/recorder';
import { inspectorState } from '../src/liveports';
import { planFaceMeasure, type MeasurePlan } from '../src/measureplan';
import { checkTraffic, compareState, observedTarget, type StateSnap } from '../src/replaycheck';
import { decodeCapture, loadSchema } from '../src/wsframes';

const SETTLE_MS = 3000;
const PAGE_TIMEOUT_MS = 10000;
const [label, kindArg, ...rest] = process.argv.slice(2);
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? Number(rest[i + 1]) : undefined; };
if (!label || !/^[\w-]+$/.test(label) || !['param', 'measure'].includes(kindArg ?? '')) {
  console.error('usage: pnpm replay <label> param | pnpm replay <label> measure --feature <id> --face <index>');
  process.exit(2);
}
const featureArg = arg('feature'), faceArg = arg('face');
if (kindArg === 'measure' && !(Number.isInteger(featureArg) && Number.isInteger(faceArg))) { console.error('measure needs --feature and --face'); process.exit(2); }

const out = path.join(config.runsDir, `replay-${label}`);
if (fs.existsSync(out)) { console.error(`${out} already exists; pick a new label.`); process.exit(2); }
const schema = loadSchema(process.env.IVY_REPO || 'C:\\zixel\\ivyproject');
const ins = new Inspector(config.inspectorUrl, 30000);
const tab = await findEditorTab(config.cdpPort);
fs.mkdirSync(out, { recursive: true });
const file = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
const records: CaptureRecord[] = [];
const recorder = new ReadOnlyCdp(await connect(tab.webSocketDebuggerUrl));
const mark = await attachRecorder(recorder, (r) => { records.push(r); fs.writeSync(file, JSON.stringify(r) + '\n'); });
const page = new PageCall(await connect(tab.webSocketDebuggerUrl));
const log = (s: string) => console.log(s);

function finish(verdict: 'passed' | 'failed' | 'unknown', detail: Record<string, unknown>): never {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ label, kind: kindArg, verdict, ...detail }, null, 2));
  log(`\nVERDICT: ${verdict.toUpperCase()}  -> ${path.join(out, 'result.json')}`);
  mark('replay end'); recorder.detach(); page.close(); fs.closeSync(file);
  process.exit(verdict === 'passed' ? 0 : 1);
}

const captureState = (projectId: number, projectTag: string): Promise<StateSnap> => inspectorState(ins, projectId, projectTag); // unbracketed, as before

/** Identity from the page's own traffic, cross-checked against the page socket and the inspector. Throws on mismatch. */
async function resolveIdentity() {
  const probe = await page.probe();
  if (!probe.ok || !probe.project) throw new Error(`page probe failed: ${probe.error}`);
  const projectId = Number(probe.project.projectId), projectTag = probe.project.projectTag;
  const sock = modelSocketId();
  const obs = sock ? observedTarget(decodeCapture(records.filter((r) => r.type === 'frame' && r.requestId === sock), schema)) : undefined;
  if (!obs) throw new Error('the page has sent no request with a workshop head since the recorder attached; press F5 and wait');
  const projects = JSON.parse(await ins.call('zcad_list_projects'));
  if (!projects.some((p: any) => p.projectId === projectId && p.projectTag === projectTag)) throw new Error(`project ${projectId}/${projectTag} is not active in zcad_service`);
  const doc = JSON.parse(await ins.call('zcad_get_object_json', { projectId, projectTag, objectId: obs.docId }));
  if (doc.class_name !== 'ivy::PartReference') throw new Error(`object ${obs.docId} is ${doc.class_name}, not ivy::PartReference`);
  return { projectId, projectTag, ...obs, docUuid: doc.uuid as string, socketValid: probe.project.valid };
}

/** The measurement, from the page-reported document's own subtree (rootEntityId = its handle). Throws to refuse. */
async function measurePlan(id: NonNullable<typeof identity>): Promise<MeasurePlan> {
  const doc = await inspectorState(ins, id.projectId, id.projectTag, { root: id.docId, bracketUndo: true });
  return planFaceMeasure(doc, id, featureArg!, faceArg!);
}

/** The latest Ivy model socket the page opened; the page also keeps platform sockets that are not Ivy traffic. */
function modelSocketId(): string | undefined {
  return records.filter((r): r is Extract<CaptureRecord, { type: 'socket' }> => r.type === 'socket' && /:8081\/zcad\/client/.test(r.url)).at(-1)?.requestId;
}

let identity: Awaited<ReturnType<typeof resolveIdentity>> | undefined;
let shown: MeasurePlan | undefined;
log(`Attached to ${shortUrl(tab.url)}; recording to ${out}`);
const probe = await page.probe();
log(`Page socket: ${JSON.stringify(probe.project ?? probe.error)}`);
log('Press F5 in the editor tab yourself, wait until idle, then type "ready".');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const cmd = line.trim();
  try {
    if (cmd === 'quit') finish('failed', { reason: 'quit before sending' });
    if (cmd === 'ready') {
      identity = await resolveIdentity();
      log(`Target: project ${identity.projectId}/${identity.projectTag}, workshop ${identity.workshopId}, document handle ${identity.docId} (PartReference ${identity.docUuid}), parmSet ${identity.parmSetId ?? '-'}`);
      if (kindArg === 'measure') {
        try { shown = await measurePlan(identity); }
        catch (e) { return finish('failed', { reason: (e as Error).message, identity }); }
        log(`Measurement: rootEntityId ${shown.docId}, tip ${shown.tipFeatureId} (#${shown.tipHandle}), feature ${shown.featureId} (#${shown.featureHandle}), face ${shown.faceId}`);
        log(`Operation that would be sent: ${JSON.stringify(shown.op)}`);
      }
      log('If this is the intended disposable document, type "confirm"; otherwise "quit".');
      return;
    }
    if (cmd !== 'confirm' || !identity) return;
    rl.close();
    const again = await resolveIdentity(); // immediately before the request
    if (JSON.stringify(again) !== JSON.stringify(identity)) finish('failed', { reason: 'identity changed after it was shown', identity, again });
    const before = await captureState(identity.projectId, identity.projectTag);
    let op: Op;
    if (kindArg === 'param') {
      if (!identity.parmSetId) finish('failed', { reason: 'no parameter set observed in the page traffic', identity });
      op = { kind: 'param', docId: identity.docId, workshopId: identity.workshopId, parmSetId: identity.parmSetId! };
    } else {
      // Re-derived immediately before the request; anything but the operation shown at "ready" is refused.
      let now: MeasurePlan;
      try { now = await measurePlan(identity); }
      catch (e) { return finish('failed', { reason: (e as Error).message, identity, shown: shown?.op }); }
      if (!shown || JSON.stringify(now) !== JSON.stringify(shown)) return finish('failed', { reason: 'the measurement changed after it was shown', shown: shown?.op, now: now.op });
      op = now.op;
    }
    mark('op start');
    const startIdx = records.length - 1;
    let sent: { result: PageResult; body: Uint8Array; cmd: number };
    try { sent = await page.send(schema, op, identity, PAGE_TIMEOUT_MS); }
    catch (e) { mark('op end'); return finish('failed', { reason: `refused or failed before reaching Ivy: ${(e as Error).message}`, identity, op }); }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    mark('op end');
    const win = records.slice(startIdx + 1, records.length - 1);
    // Only the Ivy model socket counts; the page's platform sockets (session gate, messenger) are not Ivy traffic.
    const modelSocket = modelSocketId();
    const reconnected = win.some((r) => (r.type === 'socket' && /:8081\/zcad\/client/.test(r.url)) || (r.type === 'closed' && r.requestId === modelSocket));
    const modelFrames = win.filter((r) => r.type === 'frame' && r.requestId === modelSocket);
    const after = await captureState(identity.projectId, identity.projectTag);
    const decoded = decodeCapture(modelFrames, schema);
    const bodyFieldNo = op.kind === 'param' ? schema.IvyPkg.fields.queryReq.id : schema.IvyPkg.fields.appModelReq.id;
    const traffic = checkTraffic(decoded, modelFrames, op.kind, sent.body, bodyFieldNo);
    const stateDiff = compareState(before, after);
    if (!modelSocket) traffic.problems.push('no Ivy model socket observed');
    if (reconnected) traffic.problems.push('a socket opened or closed during the operation');
    const p: any = traffic.reply?.pkg;
    const values = op.kind === 'param'
      ? { featureParams: p?.queryRsp?.featureParams ?? [], params: p?.queryRsp?.params ?? [], note: 'values as returned; unit labels are not trusted' }
      : { notification: (traffic.ntf?.pkg as any)?.appModelNtf ?? null, note: 'raw server notification; field mapping of the measured values is not decoded' };
    const detail = { identity, op, bodyHex: Buffer.from(sent.body).toString('hex'), page: sent.result, traffic: traffic.problems, state: stateDiff, values, frames: modelFrames.map((r) => r.i), otherSocketFrames: win.filter((r) => r.type === 'frame' && r.requestId !== modelSocket).length };
    if (sent.result.unknownOutcome) finish('unknown', { reason: 'no reply within the timeout; the request may still have run', ...detail });
    finish(sent.result.ok && !traffic.problems.length && !stateDiff.length ? 'passed' : 'failed', detail);
  } catch (e) {
    finish('failed', { reason: (e as Error).message });
  }
});
