// Offline: the sequencer driven by a fake transport that replays the captured plate1 reply windows. Nothing is
// sent anywhere. The fake also asserts every body ai-cad would send equals the captured UI body for that step.
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import template from '../src/templates/plate1-write.json';
import { decodeCapture, loadSchema } from '../src/wsframes';
import { WRITE_STEPS, type Lines, type WriteStep } from '../src/writeport';
import { checkWriteRequest } from '../src/livewriteguard';
import { classifyGapTraffic, classifyStepTraffic, prepareSequence, runPlateSequence, type PlateInput, type StepTraffic, type WriteTransport } from '../src/writeseq';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const captureFile = path.join(config.runsDir, 'capture-plate1', 'frames.jsonl');
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(captureFile);
const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
const records: any[] = ready ? fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const MODEL_SOCKET = '40700.5030';

// [sent request record, end of its reply window) as captured (session-protocol-capture.md §2). 133's window ends
// where the user started the dimension edit (record 195); 236 follows 223 in our sequence.
export const WINDOWS: Record<WriteStep, [number, number]> = {
  sketchCreate: [113, 121], sketchDraw: [121, 133], sketchClose: [133, 195], widthAdd: [214, 219], heightAdd: [223, 228],
  sketchFinish: [236, 245], extrudeCreate: [297, 303], extrudeModify: [303, 311], extrudeCommit: [311, 336],
};
const FAIL_PREVIEW: [number, number] = [454, 458]; // depth 0 preview → result 32000
const FAIL_COMMIT: [number, number] = [458, 470]; // depth 0 commit → result 32000

function body(i: number): string {
  const r = protobuf.Reader.create(Buffer.from(records.find((x) => x.i === i).payload, 'base64'));
  while (r.pos < r.len) { const t = r.uint32(); if (t >>> 3 === 100 && (t & 7) === 2) return Buffer.from(r.bytes()).toString('hex'); r.skipType(t & 7); }
  throw new Error(`no body in ${i}`);
}
function windowTraffic([from, to]: [number, number], pageIds = new Map<string, string>()): StepTraffic {
  const decoded = decodeCapture(records.filter((r) => r.type === 'frame' && r.requestId === MODEL_SOCKET && r.i >= from && r.i < to), schema);
  const sent = decoded.find((d) => d.frames[0] === from) as any;
  return classifyStepTraffic(decoded.filter((d) => d.frames[0] !== from), sent.asyncId, pageIds, 540);
}

// The plan's 100 x 60 rectangle is drawn at final size from 121 on, so these four carry other geometry and
// dimension values than the UI's freehand capture; only the allowed paths may differ from their templates.
const VALUES_DIFFER_FROM_CAPTURE: WriteStep[] = ['sketchDraw', 'sketchClose', 'widthAdd', 'heightAdd'];

/** Replays captured windows; `override` swaps one step's window or traffic. Records every call. */
function fakeTransport(override: Partial<Record<WriteStep, [number, number] | StepTraffic>> = {}, checkBytes = true) {
  const calls: WriteStep[] = [];
  const t: WriteTransport = {
    async exchange(step, b) {
      calls.push(step);
      if (checkBytes && VALUES_DIFFER_FROM_CAPTURE.includes(step)) expect(checkWriteRequest(schema, step, b).problems, `${step} shape`).toEqual([]);
      else if (checkBytes) expect(Buffer.from(b).toString('hex'), `${step} bytes`).toBe(body(WINDOWS[step][0]));
      const o = override[step];
      return o && !Array.isArray(o) ? o : windowTraffic(o ?? WINDOWS[step]);
    },
  };
  return { t, calls };
}

const capturedLines = (template.bodies.sketchFinish as any).modelPkg.sketchUpdateReq.geoms
  .map((g: any) => [g.line.start.x ?? 0, g.line.start.y ?? 0, g.line.end.x ?? 0, g.line.end.y ?? 0]) as Lines;
const input: PlateInput = { workshopId: 1, docId: 540, tipFeatureId: 12, planeFeatureId: 3, sketchName: 'Sketch2', extrudeName: 'Extrude1', lines: capturedLines, width: 100, height: 60, depth: 8 };
const ALL = [...WRITE_STEPS] as WriteStep[];

describe.skipIf(!ready)('classifyStepTraffic on captured windows', () => {
  it.each(Object.entries(WINDOWS))('%s window has one reply and nothing unexpected', (_s, w) => {
    const t = windowTraffic(w as [number, number]);
    expect(t.unexpected).toEqual([]);
    expect(t.reply).toBeDefined();
  });
  it('flags a second app-model request inside a window as unexpected', () => {
    expect(windowTraffic([297, 311]).unexpected.join()).toMatch(/unexpected sent IVY_APP_MODEL_REQ at 303/);
  });
  it('recognises a page reply that arrives in the next step’s window (242 sent, 244 answered later)', () => {
    const ids = new Map<string, string>();
    expect(windowTraffic([236, 243], ids).unexpected).toEqual([]); // page tessellation request 242 seen here
    const late = decodeCapture(records.filter((r) => r.requestId === MODEL_SOCKET && (r.i === 244 || (r.i >= 297 && r.i < 303))), schema);
    const sent = late.find((d) => d.frames[0] === 297) as any;
    expect(classifyStepTraffic(late.filter((d) => d !== sent), sent.asyncId, ids, 540).unexpected).toEqual([]);
    expect(classifyStepTraffic(late.filter((d) => d !== sent), sent.asyncId, new Map(), 540).unexpected.join()).toMatch(/unexpected received IVY_GET_TESSELLATION_RSP at 244/);
  });
  it('answers each page request once: a second reply with its id is unexpected', () => {
    const ids = new Map<string, string>();
    expect(windowTraffic([236, 245], ids).unexpected).toEqual([]);
    const again = decodeCapture(records.filter((r) => r.requestId === MODEL_SOCKET && r.i === 244), schema);
    expect(classifyStepTraffic(again, 'x', ids, 540).unexpected.join()).toMatch(/unexpected received IVY_GET_TESSELLATION_RSP at 244/);
  });
  it('between steps allows page requests and their replies only', () => {
    const at = (...is: number[]) => decodeCapture(records.filter((r) => r.requestId === MODEL_SOCKET && is.includes(r.i)), schema);
    expect(classifyGapTraffic(at(242, 244), new Map(), 540)).toEqual([]);
    expect(classifyGapTraffic(at(239), new Map(), 540).join()).toMatch(/model notification between steps at 239/);
    expect(classifyGapTraffic(at(237), new Map(), 540, new Set([String((at(237)[0] as any).asyncId)])).join()).toMatch(/late or duplicate reply to an earlier request at 237/);
    expect(classifyGapTraffic(at(303), new Map(), 540).join()).toMatch(/unexpected sent IVY_APP_MODEL_REQ at 303/);
  });
  it('does not accept a page query for another document, or a reply nobody asked for', () => {
    const d = decodeCapture(records.filter((r) => r.requestId === MODEL_SOCKET && r.i >= 113 && r.i < 121), schema);
    const sent = d.find((x) => x.frames[0] === 113) as any;
    expect(classifyStepTraffic(d.filter((x) => x !== sent), sent.asyncId, new Map(), 541).unexpected.join()).toMatch(/unexpected sent IVY_QUERY_REQ at 117.*unexpected received IVY_QUERY_RSP at 118/);
  });
});

describe.skipIf(!ready)('runPlateSequence (offline, captured replies)', () => {
  it('sends the nine steps in order, byte-identical to the UI, and reports the created features', async () => {
    const f = fakeTransport();
    const out = await runPlateSequence(schema, f.t, input);
    expect(out).toEqual({ status: 'completed', sent: ALL, created: { sketchFeatureId: 15, previewFeatureId: -2, extrudeFeatureId: 43 }, possibleHiddenResidue: false });
    expect(f.calls).toEqual(ALL);
  });

  it('stops after an error reply to the preview Modify: no commit, no retry, residue flagged', async () => {
    const f = fakeTransport({ extrudeModify: FAIL_PREVIEW });
    const out = await runPlateSequence(schema, f.t, input);
    expect(out.status).toBe('stopped');
    expect(out.reason).toMatch(/extrudeModify: error result 32000/);
    expect(f.calls).toEqual(ALL.slice(0, 8));
    expect(out.possibleHiddenResidue).toBe(true);
    expect(out.created.sketchFeatureId).toBe(15);
  });

  it('stops after an error reply to the commit: no retry, no cleanup, residue flagged', async () => {
    const f = fakeTransport({ extrudeCommit: FAIL_COMMIT });
    const out = await runPlateSequence(schema, f.t, input);
    expect(out).toMatchObject({ status: 'stopped', possibleHiddenResidue: true });
    expect(out.reason).toMatch(/extrudeCommit: error result 32000/);
    expect(f.calls).toEqual(ALL);
    expect(out.created.extrudeFeatureId).toBeUndefined();
  });

  it('treats a timeout as an unknown outcome and sends nothing further', async () => {
    const f = fakeTransport({ widthAdd: { ntfs: [], unexpected: [], timedOut: true } });
    const out = await runPlateSequence(schema, f.t, input);
    expect(out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(f.calls).toEqual(ALL.slice(0, 4));
  });

  it('treats an uncertain outcome (the transport could not verify it) as unknown, and tells the transport on every stop', async () => {
    const f = fakeTransport({ sketchClose: { ...windowTraffic(WINDOWS.sketchClose), unexpected: ['unexpected change'], uncertain: true } });
    const aborts: string[] = [];
    const out = await runPlateSequence(schema, { ...f.t, abort: (r) => aborts.push(r) }, input);
    expect(out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true });
    expect(f.calls).toEqual(ALL.slice(0, 3));
    expect(aborts).toEqual([out.reason]);
  });

  it('a transport that throws: unknown (the request may have run), the transport is aborted, nothing further is sent', async () => {
    const aborts: string[] = [], calls: WriteStep[] = [];
    const t: WriteTransport = {
      async exchange(s) { calls.push(s); if (s === 'widthAdd') throw new TypeError('boom'); return windowTraffic(WINDOWS[s]); },
      abort: (r) => aborts.push(r),
    };
    const out = await runPlateSequence(schema, t, input);
    expect(out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true, reason: 'widthAdd: transport error (boom); the request may have run' });
    expect(out.sent).toEqual(ALL.slice(0, 4));
    expect(calls).toEqual(ALL.slice(0, 4));
    expect(aborts).toEqual([out.reason]);
  });

  it('an unexpected (non-protocol) error while building the next step stops the run and aborts the transport', async () => {
    const t0 = windowTraffic(WINDOWS.extrudeCreate);
    let reads = 0; // the notification is readable once (the sequencer's check), then throws (the Modify builder)
    const ntf = new Proxy(t0.ntfs[0], { get: (o, k) => { if (k === 'appModelNtf' && ++reads > 1) throw new TypeError('notification became unreadable'); return o[k]; } });
    const f = fakeTransport({ extrudeCreate: { ...t0, ntfs: [ntf] } });
    const aborts: string[] = [];
    const out = await runPlateSequence(schema, { ...f.t, abort: (r) => aborts.push(r) }, input);
    expect(out).toMatchObject({ status: 'stopped', possibleHiddenResidue: true, reason: 'unexpected error: notification became unreadable' });
    expect(f.calls).toEqual(ALL.slice(0, 7));
    expect(aborts).toEqual([out.reason]);
  });

  it('stops on an unexpected message', async () => {
    const t = windowTraffic(WINDOWS.sketchFinish);
    const f = fakeTransport({ sketchFinish: { ...t, unexpected: ['unexpected received IVY_PART_DELETE_RSP at 999'] } });
    const out = await runPlateSequence(schema, f.t, input);
    expect(out.status).toBe('stopped');
    expect(f.calls).toEqual(ALL.slice(0, 6));
  });

  it('stops when a reply is missing or names the wrong feature', async () => {
    const missing = fakeTransport({ sketchCreate: { ntfs: [], unexpected: [] } });
    expect((await runPlateSequence(schema, missing.t, input)).reason).toMatch(/sketchCreate: no reply/);
    const wrong = structuredClone(windowTraffic(WINDOWS.sketchDraw));
    wrong.reply.appModelRsp.modelPkgDecoded.header.featureId = '16';
    const f = fakeTransport({ sketchDraw: wrong });
    expect((await runPlateSequence(schema, f.t, input)).reason).toMatch(/sketchDraw: unexpected reply/);
    expect(f.calls).toEqual(['sketchCreate', 'sketchDraw']);
  });

  it('fails closed when the preview notification is missing or ambiguous', async () => {
    const t = windowTraffic(WINDOWS.extrudeCreate);
    for (const ntfs of [[], [t.ntfs[0], t.ntfs[0]]]) {
      const f = fakeTransport({ extrudeCreate: { ...t, ntfs } });
      const out = await runPlateSequence(schema, f.t, input);
      expect(out.status).toBe('stopped');
      expect(out.reason).toMatch(/ambiguous/);
      expect(f.calls).toEqual(ALL.slice(0, 7));
    }
  });

  it('refuses an invalid plan before sending anything', async () => {
    const f = fakeTransport({}, false);
    for (const bad of [{ ...input, depth: 0 }, { ...input, width: 120 }, { ...input, docId: -1 }, { ...input, sketchName: '' }]) {
      const out = await runPlateSequence(schema, f.t, bad);
      expect(out.status).toBe('refused');
      expect(out.sent).toEqual([]);
    }
    expect(f.calls).toEqual([]);
    expect(prepareSequence(schema, input).ready).toBe(true);
  });
});

describe.skipIf(!ready)('follow-up review: multicast policy, throwing abort, malformed transport results', () => {
  const at = (...is: number[]) => decodeCapture(records.filter((r) => r.requestId === MODEL_SOCKET && is.includes(r.i)), schema);

  it('refuses every multicast message, between steps and inside a step window (captured 200–210, around UI interaction)', () => {
    expect(classifyGapTraffic(at(200, 202, 203, 207, 209, 210), new Map(), 540)).toEqual([
      'unexpected sent IVY_USER_MULTICAST_REQ at 200', 'unexpected received IVY_USER_MULTICAST_RSP at 202', 'unexpected received IVY_USER_MULTICAST_NTF at 203',
      'unexpected sent IVY_USER_MULTICAST_REQ at 207', 'unexpected received IVY_USER_MULTICAST_RSP at 209', 'unexpected received IVY_USER_MULTICAST_NTF at 210',
    ]);
    expect(classifyStepTraffic(at(203), 'x', new Map(), 540).unexpected).toEqual(['unexpected received IVY_USER_MULTICAST_NTF at 203']);
    // the version-control notification stays accepted (captured inside step windows, e.g. 122)
    expect(classifyGapTraffic(at(122), new Map(), 540)).toEqual([]);
  });

  it.each([
    ['an uncertain outcome', (s: WriteStep) => (s === 'widthAdd' ? { ...windowTraffic(WINDOWS[s]), uncertain: true } : windowTraffic(WINDOWS[s])), 'unknown', 'widthAdd: outcome unknown (no reply in time); the request may still have run'],
    ['a throwing transport', (s: WriteStep) => { if (s === 'widthAdd') throw new Error('boom'); return windowTraffic(WINDOWS[s]); }, 'unknown', 'widthAdd: transport error (boom); the request may have run'],
  ] as const)('an abort that throws after %s is reported, never thrown', async (_n, exchange, status, reason) => {
    const aborts: string[] = [], calls: WriteStep[] = [];
    const t: WriteTransport = { async exchange(s) { calls.push(s); return exchange(s); }, abort: (r) => { aborts.push(r); throw new Error('latch broke'); } };
    const out = await runPlateSequence(schema, t, input);
    expect(out).toMatchObject({ status, possibleHiddenResidue: true, sent: ALL.slice(0, 4) });
    expect(out.reason).toBe(`${reason}; the transport's abort failed (latch broke), so it may not be latched`);
    expect(aborts).toEqual([reason]);
    expect(calls).toEqual(ALL.slice(0, 4));
  });

  it.each([
    ['undefined', undefined], ['null', null], ['a string', 'ok'], ['an empty object', {}],
    ['unexpected that is not a list', { ntfs: [], unexpected: 'x' }], ['ntfs that are not a list', { ntfs: {}, unexpected: [] }],
    ['a non-boolean notSent', { notSent: 'yes', ntfs: [], unexpected: [] }], ['notSent without lists', { notSent: true }],
  ])('a malformed transport result (%s) is an unknown outcome: the request may have been sent', async (_n, result) => {
    const aborts: string[] = [], calls: WriteStep[] = [];
    const t: WriteTransport = { async exchange(s) { calls.push(s); return s === 'widthAdd' ? (result as any) : windowTraffic(WINDOWS[s]); }, abort: (r) => aborts.push(r) };
    const out = await runPlateSequence(schema, t, input);
    expect(out).toMatchObject({ status: 'unknown', possibleHiddenResidue: true, sent: ALL.slice(0, 4), reason: 'widthAdd: malformed transport result; the request may have run' });
    expect(calls).toEqual(ALL.slice(0, 4));
    expect(aborts).toEqual([out.reason]);
  });
});
