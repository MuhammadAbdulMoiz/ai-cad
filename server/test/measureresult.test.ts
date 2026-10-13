// Real measurement notifications only: the UI's (measure2 record 65) and ai-cad's own replay (replay-measure1).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { decodeMeasurementNtf } from '../src/measureresult';
import { decodeCapture, loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';
const m2 = path.join(config.runsDir, 'capture-measure2', 'frames.jsonl');
const r1 = path.join(config.runsDir, 'replay-measure1', 'frames.jsonl');
const ready = fs.existsSync(path.join(ivyRepo, 'ivyproto', 'proto', 'ivyproto.proto')) && fs.existsSync(m2) && fs.existsSync(r1);

describe.skipIf(!ready)('decodeMeasurementNtf', () => {
  const schema = ready ? loadSchema(ivyRepo) : (undefined as never);
  const ntfBytes = (file: string) => {
    const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const n = decodeCapture(recs, schema).filter((d: any) => d.kind === 'message' && d.cmd === 'IVY_APP_MODEL_NTF' && d.pkg.appModelNtf?.modelDescs?.[0]?.workbenchType === 14);
    expect(n).toHaveLength(1);
    return Buffer.from((n[0] as any).pkg.appModelNtf.modelDescs[0].modelPkg, 'base64');
  };
  const expected = [
    { type: 6, name: 'perimeter', value: 0.32, active: false, setId: 1 },
    { type: 3, name: 'area', value: 0.006, active: false, setId: 2 },
  ];

  it('labels the UI measurement of face 4 (measure2)', () => {
    const r = decodeMeasurementNtf(schema, ntfBytes(m2));
    expect(r.results).toEqual(expected);
    expect(r.inputs).toEqual([{ featureId: 43, item: [{ id: 4, topoType: 'TopoFace' }] }]);
  });

  it('labels ai-cad’s replayed measurement identically (replay-measure1)', () => {
    expect(decodeMeasurementNtf(schema, ntfBytes(r1)).results).toEqual(expected);
  });

  it('rejects a truncated notification', () => {
    const b = ntfBytes(r1);
    expect(() => decodeMeasurementNtf(schema, b.subarray(0, b.length - 20))).toThrow();
  });
});
