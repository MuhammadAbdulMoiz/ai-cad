// Simulated Ivy for executor tests. Lives under test/ so it cannot be wired into a real run.
// Every reply is stamped simulated: it exercises control flow only, never CAD correctness.
import type { BuildRequest, IvyPort, Target } from '../src/executor';
import type { ModelSnapshot, SnapObject } from '../src/snapshot';

const CLS = { sketch: 'ivy::FeatSketch', extrude: 'ivy::SolidExtrude', revolve: 'ivy::SolidRevolve' } as const;

export class MockIvy implements IvyPort {
  readonly provenance = 'simulated' as const;
  readonly docs = new Map<number, SnapObject[]>();
  readonly calls: BuildRequest[] = [];
  private nextId = 100;
  /** Present only when a simulated measurement was given, like a backend without the query tools. */
  measure?: IvyPort['measure'];
  /** `script` may return a reply to override the default for call n (1-based); undefined = normal build. */
  constructor(private script: (req: BuildRequest, n: number, mock: MockIvy) => unknown = () => undefined, measurement?: unknown) {
    if (measurement !== undefined) this.measure = async () => structuredClone(measurement);
  }

  doc(t: Target) {
    if (!this.docs.has(t.documentId)) this.docs.set(t.documentId, []);
    return this.docs.get(t.documentId)!;
  }
  add(t: Target, cls: string, id = this.nextId++, deps: string[] = []) {
    this.doc(t).push({ key: `sim-${t.documentId}-${id}-${this.doc(t).length}`, handle: id, cls, featId: id, hash: `h${id}`, deps });
    return id;
  }
  async build(req: BuildRequest) {
    this.calls.push(req);
    const custom = this.script(req, this.calls.length, this);
    if (custom !== undefined) return custom;
    const f = req.feature;
    const deps = f.type !== 'sketch' ? this.doc(req.target).filter((o) => o.featId === req.refs[f.profile]).map((o) => o.key) : [];
    return { result: 'OK', featureIds: [this.add(req.target, CLS[f.type], undefined, deps)], simulated: true };
  }
  async snapshot(t: Target): Promise<ModelSnapshot> {
    return { objects: new Map(this.doc(t).map((o) => [o.key, { ...o }])) };
  }
}
