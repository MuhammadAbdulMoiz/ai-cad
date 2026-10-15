// The face-measurement request for one document, from that document's own state (read with rootEntityId = the
// document the page reported). The tip and the measured feature are taken only from that subtree, never from the
// first FeatPart of the project: in a project with several documents that is another document's tip.
import { snapshotProblems, tipOf } from './livewriteguard';
import type { FaceMeasureOp } from './queryport';
import type { StateSnap } from './replaycheck';

export type MeasurePlan = { docId: number; tipFeatureId: number; tipHandle: string; featureId: number; featureHandle: string; faceId: number; op: FaceMeasureOp };

/**
 * `doc` must be the document-rooted state of `target.docId`. Throws (refuses) unless that document is its root, it
 * holds exactly one FeatPart whose tip resolves to an object of the document carrying the tip's feature id, and
 * exactly one ivy::SolidExtrude with `featureId`.
 */
export function planFaceMeasure(doc: StateSnap, target: { docId: number; workshopId: number }, featureId: number, faceId: number): MeasurePlan {
  const refuse = (why: string): never => { throw new Error(`measurement refused: ${why}`); };
  const root = String(target.docId);
  if (doc.classes[root] !== 'ivy::PartReference') refuse(`document ${target.docId} is not the root of the state read (${doc.classes[root] ?? 'absent'})`);
  const bad = snapshotProblems(doc);
  if (bad.length) refuse(`document ${target.docId}: ${bad.join('; ')}`);
  const idOf = (h: string) => Number(JSON.parse(doc.objects[h] ?? '{}').attr_first_?._id);
  const tip = tipOf(doc) ?? refuse(`document ${target.docId} has no readable tip`);
  if (!(tip.handle in doc.classes) || idOf(tip.handle) !== tip.id) refuse(`the tip ${tip.id}_${tip.handle} is not an object of document ${target.docId} carrying feature ${tip.id}`);
  const feats = Object.keys(doc.classes).filter((h) => doc.classes[h] === 'ivy::SolidExtrude' && idOf(h) === featureId);
  if (feats.length !== 1) refuse(`document ${target.docId} has ${feats.length} ivy::SolidExtrude with id ${featureId}`);
  const op: FaceMeasureOp = { kind: 'measure_face', docId: target.docId, workshopId: target.workshopId, tipFeatureId: tip.id, featureId, faceId };
  return { docId: target.docId, tipFeatureId: tip.id, tipHandle: tip.handle, featureId, featureHandle: feats[0], faceId, op };
}
