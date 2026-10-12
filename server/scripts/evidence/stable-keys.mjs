// Compare stable keys (uuid, feature _id+class) between captures.
import fs from 'node:fs';
import path from 'node:path';
const [root, a, b] = process.argv.slice(2);
const read = (l) => {
  const dir = path.join(root, l, 'objects');
  return fs.readdirSync(dir).map((f) => { const r = fs.readFileSync(path.join(dir, f), 'utf8'); return r.trimStart().startsWith('{') ? JSON.parse(r) : null; }).filter(Boolean);
};
const A = read(a), B = read(b);
const uu = (xs) => new Set(xs.map((o) => o.uuid).filter(Boolean));
const ua = uu(A), ub = uu(B);
console.log(`uuids: ${a}=${ua.size} ${b}=${ub.size} shared=${[...ua].filter((u) => ub.has(u)).length}`);
const fk = (xs) => new Set(xs.filter((o) => o.attr_first_).map((o) => `${o.class_name}#${o.attr_first_._id}:${o.attr_first_._name}`));
const fa = fk(A), fb = fk(B);
console.log(`feature keys (class#_id:name): ${a}=${fa.size} ${b}=${fb.size} shared=${[...fa].filter((k) => fb.has(k)).length}`);
console.log('only in', a, [...fa].filter((k) => !fb.has(k)));
console.log('only in', b, [...fb].filter((k) => !fa.has(k)));
const tip = (xs) => xs.find((o) => o.class_name === 'ivy::FeatPart')?.attr_tip_feat_;
console.log('FeatPart tip:', tip(A), '->', tip(B));

