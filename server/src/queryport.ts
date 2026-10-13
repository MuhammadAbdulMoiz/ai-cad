// Phase 2b (approved 2026-10-13): the only two requests ai-cad may send to Ivy, each in the exact shape the UI was
// captured sending (docs/session-protocol-capture.md §3 item 4, §6). Bodies are encoded here with Ivy's own .proto
// files and handed to the page's existing socket service; nothing else can be expressed.
//   - param:        IVY_QUERY_REQ / IVY_QUERY_PARAM_REQ  (plate1 record 295)
//   - measure_face: IVY_APP_MODEL_REQ, measurement workbench, preview Create, input type 1, one face (measure2 record 63)
import { z } from 'zod';
import type { Schema } from './wsframes';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ParamOpZ = z.object({ kind: z.literal('param'), docId: id, workshopId: id, parmSetId: id }).strict();
const FaceMeasureOpZ = z.object({
  kind: z.literal('measure_face'), docId: id, workshopId: id, tipFeatureId: id, featureId: id,
  faceId: z.number().int().min(0).max(0x7fffffff),
}).strict();
const OpZ = z.discriminatedUnion('kind', [ParamOpZ, FaceMeasureOpZ]);

export type ParamOp = z.infer<typeof ParamOpZ>;
export type FaceMeasureOp = z.infer<typeof FaceMeasureOpZ>;
export type Op = z.infer<typeof OpZ>;
export type EncodedOp = { cmd: number; bodyFieldNo: number; body: Uint8Array };

export class RefusedOpError extends Error {}

/** Throws RefusedOpError for anything that is not exactly one of the two approved operations. */
export function validateOp(x: unknown): Op {
  const r = OpZ.safeParse(x);
  if (!r.success) throw new RefusedOpError(`refused operation: ${r.error.issues.map((i) => `${i.path.join('.') || '(op)'} ${i.message}`).join('; ')}`);
  return r.data;
}

const WORKBENCH_PART = 1;
const WORKBENCH_MEASUREMENT = 14;
const MEASUREMENT_INPUT_FACE = 1; // role 30002 as captured; other input types were never observed

function encode(schema: Schema, typeName: string, obj: Record<string, unknown>): Uint8Array {
  const t = schema.IvyPkg.root.lookupType(typeName);
  const err = t.verify(t.fromObject(obj));
  if (err) throw new RefusedOpError(`${typeName}: ${err}`);
  return t.encode(t.fromObject(obj)).finish();
}

export function encodeOp(schema: Schema, raw: unknown): EncodedOp {
  const op = validateOp(raw);
  const cmds = schema.IvyPkg.root.lookupEnum('ivyproto.IvyCommand').values;
  if (op.kind === 'param') {
    return {
      cmd: cmds.IVY_QUERY_REQ, bodyFieldNo: schema.IvyPkg.fields.queryReq.id,
      body: encode(schema, 'ivyproto.QueryReq', {
        queryHead: { cmd: 'IVY_QUERY_PARAM_REQ', workshopHead: { workshopId: op.workshopId, currentDocId: op.docId, workbenchType: WORKBENCH_PART } },
        paramQuery: { docId: op.docId, parmSetId: op.parmSetId, paramIds: [-1] },
      }),
    };
  }
  const update = encode(schema, 'ivytaskpanel.UpdateMessageReq', {
    updateItems: [
      { attrRole: 30002, ints: { items: [MEASUREMENT_INPUT_FACE] } },
      { attrRole: 30003, selection: { items: [{ featureId: op.featureId, item: [{ id: op.faceId, topoType: 'TopoFace' }] }] } },
      { attrRole: 30004, bools: {} },
      { attrRole: 30008, bools: { items: [true] } },
    ],
    header: { action: 'Create' },
  });
  const modelPkg = encode(schema, 'ivymeasurement.MeasurementPkg', {
    header: { cmd: 'IVY_MEASUREMENT_UPDATE_REQ', isPreview: true, tipFeatureId: op.tipFeatureId, featureName: 'Measure1', featureType: 'ivy::Measurement' },
    measurementUpdateReq: update,
  });
  return {
    cmd: cmds.IVY_APP_MODEL_REQ, bodyFieldNo: schema.IvyPkg.fields.appModelReq.id,
    body: encode(schema, 'ivyproto.AppModelReq', {
      // preview + ignoreMark + doNotSave: the captured non-recording measurement; a commit cannot be expressed here
      workshopHead: { workshopId: op.workshopId, currentDocId: op.docId, workbenchType: WORKBENCH_MEASUREMENT, doNotSave: true, isPreview: true, ignoreMark: true, updateExternalLink: false },
      modelPkg,
    }),
  };
}
