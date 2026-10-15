// Read-only evidence after a verified plate run, through the two operations approved for replay (queryport.ts): the
// parameter query (dimension values) and face measurements (perimeter/area, from which faceSides gives the face's
// two sides). Each goes through PageCall.send (encodeOp's allow-list) and its answer is read from the recorder.
// Missing or unexpected answers are reported, never guessed: the postconditions then stay incomplete or fail.
import { decodeMeasurementNtf } from './measureresult';
import type { PageCall, Target } from './pagecall';
import type { MeasuredFace, TrialEvidence } from './platetrial';
import type { RecordStream } from './recorder';
import { decodeCapture, type Schema } from './wsframes';

export type EvidenceDeps = {
  page: Pick<PageCall, 'send'>; schema: Schema; stream: RecordStream; modelSocket: string;
  target: Target & { workshopId: number; docId: number }; parmSetId?: number; waitMs: number;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One approved operation; returns the decoded model-socket messages recorded while it ran. */
async function exchange(d: EvidenceDeps, op: Parameters<PageCall['send']>[1]) {
  const pos = d.stream.position();
  const { result } = await d.page.send(d.schema, op, d.target, 10000);
  await sleep(d.waitMs);
  const frames = d.stream.since(pos).filter((r) => r.type === 'frame' && r.requestId === d.modelSocket);
  return { result, msgs: (decodeCapture(frames, d.schema) as any[]).filter((m) => m.kind === 'message' && m.dir === 'received') };
}

export async function readTrialEvidence(d: EvidenceDeps, extrudeId: number, faceIds: number[]): Promise<TrialEvidence & { problems: string[] }> {
  const problems: string[] = [];
  const out: TrialEvidence & { problems: string[] } = { problems };
  if (!d.parmSetId) problems.push('no parameter set id was observed in the page traffic: dimension values not read');
  else {
    const { result, msgs } = await exchange(d, { kind: 'param', docId: d.target.docId, workshopId: d.target.workshopId, parmSetId: d.parmSetId });
    const rsp = msgs.filter((m) => m.cmd === 'IVY_QUERY_RSP');
    if (!result.ok || rsp.length !== 1) problems.push(`parameter query: page ok=${result.ok}, ${rsp.length} replies`);
    else out.params = rsp[0].pkg?.queryRsp?.featureParams ?? [];
  }
  const faces: MeasuredFace[] = [];
  for (const faceId of faceIds) {
    const { result, msgs } = await exchange(d, { kind: 'measure_face', docId: d.target.docId, workshopId: d.target.workshopId, tipFeatureId: extrudeId, featureId: extrudeId, faceId });
    const ntf = msgs.filter((m) => m.cmd === 'IVY_APP_MODEL_NTF' && m.pkg?.appModelNtf?.modelDescs?.[0]?.workbenchType === 14);
    if (!result.ok || ntf.length !== 1) { problems.push(`face ${faceId}: page ok=${result.ok}, ${ntf.length} measurement notifications`); continue; }
    try {
      const m = decodeMeasurementNtf(d.schema, Buffer.from(ntf[0].pkg.appModelNtf.modelDescs[0].modelPkg, 'base64'));
      const v = (n: string) => m.results.find((r) => r.name === n)?.value;
      const perimeter = v('perimeter'), area = v('area');
      if (perimeter === undefined || area === undefined) problems.push(`face ${faceId}: no perimeter/area in ${JSON.stringify(m.results)}`);
      else faces.push({ perimeter, area });
    } catch (e) { problems.push(`face ${faceId}: ${(e as Error).message}`); }
  }
  if (faces.length) out.faces = faces;
  return out;
}
