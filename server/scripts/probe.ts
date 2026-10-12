import fs from 'node:fs';
import path from 'node:path';
import { Inspector } from '../src/inspector';
import { config } from '../src/config';

const [label, ...rest] = process.argv.slice(2);
if (!label || !/^[\w-]+$/.test(label)) {
  console.error('usage: pnpm probe <label> [--project <id>]   (label: letters, digits, - _)');
  process.exit(2);
}
const projArg = rest.indexOf('--project');
const out = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'inspector', label);
fs.rmSync(out, { recursive: true, force: true }); // re-running a label replaces the whole capture
fs.mkdirSync(path.join(out, 'objects'), { recursive: true });
const ins = new Inspector(config.inspectorUrl);
const errors: Record<string, string> = {};
const save = (f: string, s: string) => fs.writeFileSync(path.join(out, f), s);
const finish = (projectId: unknown, projectTag: unknown, nodeIdCount: number) => {
  save('errors.json', JSON.stringify(errors, null, 2));
  save('meta.json', JSON.stringify({ label, projectId, projectTag, capturedAt: new Date().toISOString(), nodeIdCount }, null, 2));
};

async function tryCall(file: string, tool: string, args: Record<string, unknown>) {
  try { const t = await ins.call(tool, args); save(file, t); return t; }
  catch (e) { errors[file] = (e as Error).message; return undefined; }
}

const projText = await tryCall('projects.json', 'zcad_list_projects', {});
let projects: any[] | undefined;
if (projText !== undefined) {
  try { const parsed: unknown = JSON.parse(projText); if (Array.isArray(parsed)) projects = parsed; } catch { /* not JSON */ }
  if (!projects) {
    errors['projects.json'] = `unexpected zcad_list_projects reply: ${projText.slice(0, 200)}`;
    finish(null, null, 0);
    console.error(errors['projects.json']);
    process.exit(1);
  }
}
if (!projects?.length) { finish(null, null, 0); console.error('No active Ivy project. Open a part in the browser first.', errors); process.exit(1); }
const chosen = projArg >= 0 ? projects.find((p: any) => p.projectId === Number(rest[projArg + 1])) : projects.at(-1);
if (!chosen) { console.error('Project not found. Active:', projects); process.exit(1); }
const pa = { projectId: chosen.projectId, projectTag: chosen.projectTag };

const dot = (await tryCall('graph-full.dot', 'zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: false })) ?? '';
await tryCall('graph-compact.dot', 'zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: true });
await tryCall('undo.json', 'zcad_get_undo_history', pa);
await tryCall('pipeline.json', 'zcad_get_pipeline_history', pa);

// ponytail: node-id regex is a guess at the DOT shape; Task 4 confirms or corrects it.
const ids = [...new Set([...dot.matchAll(/^\s*"?(\d+)"?\s*\[/gm)].map((m) => Number(m[1])))];
for (const id of ids) await tryCall(`objects/${id}.json`, 'zcad_get_object_json', { ...pa, objectId: id });

finish(pa.projectId, pa.projectTag, ids.length);
console.log(`captured ${label}: project ${pa.projectId}, ${ids.length} objects, ${Object.keys(errors).length} errors -> ${out}`);
if (ids.length === 0) {
  console.warn('WARNING: 0 objects found - capture is NOT usable; check graph-full.dot and tell the agent');
  process.exit(3);
}
