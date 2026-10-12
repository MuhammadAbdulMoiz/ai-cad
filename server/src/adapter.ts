import evidenceJson from './evidence.json';
import type { Evidence } from './checks';
import { CHECK_KINDS, FEATURE_TYPES } from './plan';
import { Inspector, InspectorError } from './inspector';
import { fingerprint, type ModelSnapshot, type SnapObject } from './snapshot';

export type ProjectRef = { projectId: number; projectTag: string };
export type Graph = { nodes: Map<number, string>; dependsOn: Map<number, number[]> };

/** Fails closed: a malformed evidence.json must never be silently trusted. */
export function validateEvidence(x: unknown): Evidence {
  const fail = (what: string): never => { throw new Error(`invalid evidence.json: ${what}`); };
  const o: any = x;
  if (!o || typeof o !== 'object') fail('not an object');
  const isStrArr = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!isStrArr(o.excludeClasses)) fail('excludeClasses must be string[]');
  if (!isStrArr(o.volatileClasses)) fail('volatileClasses must be string[]');
  if (!o.featureClass || typeof o.featureClass !== 'object') fail('featureClass missing');
  for (const t of FEATURE_TYPES) if (typeof o.featureClass[t] !== 'string') fail(`featureClass.${t} must be a string`);
  if (!(typeof o.bodyClass === 'string' || o.bodyClass === null)) fail('bodyClass must be string or null');
  if (!o.supported || typeof o.supported !== 'object') fail('supported missing');
  for (const k of CHECK_KINDS) if (typeof o.supported[k] !== 'boolean') fail(`supported.${k} must be a boolean`);
  return x as Evidence;
}

export function loadEvidence(): Evidence {
  return validateEvidence(evidenceJson);
}

/** Q1: node lines look like `  "539" [label="ivy::FeatSketch 539\n12 草图1", ...]` (root `0` is unquoted). */
export function parseGraph(dot: string): Graph {
  const nodes = new Map<number, string>();
  for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"\s]+)/gm)) nodes.set(Number(m[1]), m[2]);
  const dependsOn = new Map<number, number[]>();
  for (const m of dot.matchAll(/"(\d+)" -> "(\d+)" \[label="DependsOn"/g)) {
    const from = Number(m[1]);
    dependsOn.set(from, [...(dependsOn.get(from) ?? []), Number(m[2])]);
  }
  return { nodes, dependsOn };
}

export function parseSnapshot(graph: Graph, objects: Map<number, string>, ev: Evidence): ModelSnapshot {
  if (![...graph.nodes.values()].includes('ivy::Project')) throw new InspectorError('object graph has no ivy::Project root node');
  const features = new Map<number, SnapObject>();
  const byUuid = new Map<string, number>();
  for (const [handle, cls] of graph.nodes) {
    if (ev.excludeClasses.includes(cls)) continue;
    const raw = objects.get(handle);
    if (raw === undefined) throw new InspectorError(`no object JSON for ${cls} #${handle}`);
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new InspectorError(`${cls} #${handle}: non-JSON reply: ${raw.slice(0, 80)}`); }
    if (typeof j?.uuid !== 'string' || typeof j?.class_name !== 'string')
      throw new InspectorError(`${cls} #${handle}: reply lacks uuid/class_name`);
    if (!j.attr_first_) continue; // containers and runtime plumbing are not model features (Q2)
    if (byUuid.has(j.uuid)) throw new InspectorError(`duplicate uuid ${j.uuid} on handles ${byUuid.get(j.uuid)} and ${handle}`);
    byUuid.set(j.uuid, handle);
    const a = j.attr_first_;
    features.set(handle, {
      key: j.uuid, handle, cls: j.class_name, featId: a._id, name: a._name,
      hash: fingerprint([j.class_name, a._id, a._name]),
    });
  }
  if (features.size === 0) throw new InspectorError('object graph contains no feature objects');
  for (const [handle, obj] of features) {
    const seen = new Set<number>();
    const stack = [...(graph.dependsOn.get(handle) ?? [])];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      stack.push(...(graph.dependsOn.get(h) ?? []));
    }
    seen.delete(handle); // a cycle must not make a feature depend on itself
    obj.deps = [...seen].filter((h) => features.has(h)).map((h) => features.get(h)!.key);
  }
  return { objects: new Map([...features.values()].map((o) => [o.key, o])) };
}

export async function takeSnapshot(ins: Inspector, proj: ProjectRef, ev: Evidence): Promise<ModelSnapshot> {
  const pa = { projectId: proj.projectId, projectTag: proj.projectTag };
  const graph = parseGraph(await ins.call('zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: false }));
  const objects = new Map<number, string>();
  for (const [handle, cls] of graph.nodes) {
    if (!ev.excludeClasses.includes(cls)) objects.set(handle, await ins.call('zcad_get_object_json', { ...pa, objectId: handle }));
  }
  return parseSnapshot(graph, objects, ev);
}

// ponytail: assumes the last listed project is the harness's document; if several projects are loaded this is ambiguous — revisit with live multi-project evidence.
export async function findProject(ins: Inspector): Promise<ProjectRef> {
  const text = await ins.call('zcad_list_projects');
  let list: unknown;
  try { list = JSON.parse(text); } catch { throw new InspectorError(`unexpected zcad_list_projects reply: ${text.slice(0, 200)}`); }
  if (!Array.isArray(list)) throw new InspectorError(`unexpected zcad_list_projects reply: ${text.slice(0, 200)}`);
  const p = list.at(-1);
  if (!p) throw new InspectorError('no active Ivy project');
  return { projectId: Number(p.projectId), projectTag: String(p.projectTag) };
}
