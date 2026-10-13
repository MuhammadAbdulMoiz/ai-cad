// Labelled results from a measurement-workbench notification (offline decode, 2026-10-13).
// Evidence: MeasurementPkg.data_ntf decodes as ivypart.PartDataNtf and re-encodes byte-identically (capture §8);
// the result lists are appended together per result, so index i aligns across roles
// (ivyproject zplugin_v1/measurement/model/inc/measurement.h:88-96; roles: measurement_role.h:15-23).
import type { Schema } from './wsframes';

// ivyproject zplugin_v1/measurement/model/inc/measurement_types.h:18-50 (MeasureType)
export const MEASURE_TYPE: Record<number, string> = {
  2: 'length', 3: 'area', 4: 'volume', 5: 'radius', 6: 'perimeter', 7: 'angle', 8: 'semiAngle', 10: 'position',
  11: 'center', 12: 'parallelDist', 13: 'prepDist', 14: 'minDist', 15: 'maxDist', 16: 'aabbMass', 17: 'centerOfMass',
  100: 'vectorX', 101: 'vectorY', 102: 'vectorZ', 103: 'vector2X', 104: 'vector2Y', 105: 'vector2Z', 106: 'distance',
  107: 'aabbLength', 108: 'aabbWidth', 109: 'aabbHeight', 110: 'centerDist',
};
const ROLE = { active: '30004', values: '30005', refs: '30007', setIds: '30009', inputs: '30003' } as const;

export type MeasureResult = { type: number; name: string; value: number; active: boolean; setId: number };
export type MeasureNtf = { featureName: string; inputs: unknown; results: MeasureResult[] };

/** Throws unless the bytes decode losslessly and every result list has the same length. Values are raw (no unit is sent). */
export function decodeMeasurementNtf(schema: Schema, modelPkg: Uint8Array): MeasureNtf {
  const M = schema.MeasurementPkg;
  if (!M) throw new Error('no MeasurementPkg schema');
  const pkg: any = M.decode(modelPkg);
  if (pkg.body !== 'dataNtf' || !pkg.dataNtf?.length) throw new Error(`measurement package body is ${pkg.body}, not dataNtf`);
  const T = schema.IvyPkg.root.lookupType('ivypart.PartDataNtf');
  const data: any = T.decode(pkg.dataNtf);
  if (!Buffer.from(T.encode(data).finish()).equals(Buffer.from(pkg.dataNtf))) throw new Error('data_ntf does not re-encode identically as PartDataNtf');
  const feats = (T.toObject(data, { enums: String, longs: Number, defaults: false }) as any).features ?? [];
  const measured = feats.map((f: any) => f.featUpdateFeature?.feat).filter((f: any) => f?.type === 'Measurement');
  if (measured.length !== 1) throw new Error(`expected 1 Measurement feature, found ${measured.length}`);
  const attr = (role: string) => measured[0].attributes?.find((a: any) => a.role === role || String(a.role) === role);
  const values: number[] = attr(ROLE.values)?.real ?? [];
  const refs: number[] = attr(ROLE.refs)?.enum ?? [];
  const setIds: number[] = attr(ROLE.setIds)?.enum ?? [];
  const active: boolean[] = attr(ROLE.active)?.check ?? [];
  if (!values.length || ![refs, setIds, active].every((l) => l.length === values.length))
    throw new Error(`result lists differ in length: values ${values.length}, refs ${refs.length}, setIds ${setIds.length}, active ${active.length}`);
  return {
    featureName: measured[0].name,
    inputs: attr(ROLE.inputs)?.select ?? null,
    results: values.map((value, i) => ({ type: refs[i], name: MEASURE_TYPE[refs[i]] ?? `unknown(${refs[i]})`, value, active: active[i], setId: setIds[i] })),
  };
}
