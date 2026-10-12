// Task 4 evidence analysis. Usage: node analyze.mjs <fixturesDir>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const labels = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();

function load(label) {
  const dir = path.join(root, label);
  const dot = fs.readFileSync(path.join(dir, 'graph-full.dot'), 'utf8');
  const nodes = new Map(); // id -> {cls, label}
  for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"]*)"/gm)) {
    const [cls] = m[2].split(/\s+/);
    nodes.set(m[1], { cls, label: m[2].replace(/\n/g, ' | ') });
  }
  const edges = [...dot.matchAll(/"(\d+)" -> "(\d+)" \[label="(\w+)"/g)].map((m) => ({ from: m[1], to: m[2], kind: m[3] }));
  const objs = new Map();
  for (const f of fs.readdirSync(path.join(dir, 'objects'))) {
    const raw = fs.readFileSync(path.join(dir, 'objects', f), 'utf8');
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = '__unparsable__'; }
    objs.set(f.replace('.json', ''), { raw, json });
  }
  return { label, nodes, edges, objs };
}

const caps = labels.map(load);
const flat = (o, p = '', out = {}) => {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
  else out[p] = o;
  return out;
};

for (const c of caps) {
  const classes = {};
  for (const n of c.nodes.values()) classes[n.cls] = (classes[n.cls] || 0) + 1;
  const empty = [...c.objs].filter(([, o]) => !o.raw).map(([id]) => id);
  const missing = [...c.nodes.keys()].filter((id) => !c.objs.has(id));
  console.log(`\n### ${c.label}: ${c.nodes.size} nodes, ${c.edges.length} edges (${c.edges.filter((e) => e.kind === 'DependsOn').length} DependsOn), emptyJson=[${empty}], noJsonFile=[${missing}]`);
  console.log('edge kinds:', [...new Set(c.edges.map((e) => e.kind))].join(','));
}

function diff(a, b) {
  const added = [...b.nodes.keys()].filter((k) => !a.nodes.has(k));
  const removed = [...a.nodes.keys()].filter((k) => !b.nodes.has(k));
  const changed = [];
  for (const k of a.nodes.keys()) {
    if (!b.nodes.has(k)) continue;
    const x = a.objs.get(k)?.raw, y = b.objs.get(k)?.raw;
    if (x !== y) {
      const fx = flat(a.objs.get(k)?.json), fy = flat(b.objs.get(k)?.json);
      const keys = [...new Set([...Object.keys(fx), ...Object.keys(fy)])].filter((p) => JSON.stringify(fx[p]) !== JSON.stringify(fy[p]));
      changed.push({ id: k, cls: a.nodes.get(k).cls, keys: keys.slice(0, 12).map((p) => `${p}: ${JSON.stringify(fx[p])?.slice(0, 60)} -> ${JSON.stringify(fy[p])?.slice(0, 60)}`), nkeys: keys.length });
    }
  }
  console.log(`\n================ ${a.label} -> ${b.label}`);
  console.log('ADDED:', added.map((k) => `${k} ${b.nodes.get(k).label}`).join('\n       '));
  console.log('REMOVED:', removed.map((k) => `${k} ${a.nodes.get(k).label}`).join('\n         '));
  for (const c of changed) console.log(`CHANGED ${c.id} ${c.cls} (${c.nkeys} paths)\n    ` + c.keys.join('\n    '));
}

const by = Object.fromEntries(caps.map((c) => [c.label, c]));
const pairs = process.argv.slice(3).map((p) => p.split(':'));
for (const [x, y] of pairs) diff(by[x], by[y]);
