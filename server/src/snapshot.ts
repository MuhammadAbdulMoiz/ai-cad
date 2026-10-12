import { createHash } from 'node:crypto';

export type SnapObject = {
  key: string; handle: number; cls: string; featId?: number; name?: string; hash: string;
  deps?: string[]; statusOk?: boolean; dims?: Record<string, number>;
};
export type ModelSnapshot = { objects: Map<string, SnapObject> };
export type SnapDiff = { added: SnapObject[]; removed: SnapObject[]; modified: SnapObject[] };

export function fingerprint(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

export function diffSnapshots(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): SnapDiff {
  const vol = new Set(volatileClasses);
  const added = [...cur.objects.values()].filter((o) => !base.objects.has(o.key));
  const removed = [...base.objects.values()].filter((o) => !cur.objects.has(o.key) && !vol.has(o.cls));
  const modified = [...base.objects.values()].filter((o) => {
    const c = cur.objects.get(o.key);
    return c && c.hash !== o.hash && !vol.has(o.cls);
  });
  return { added, removed, modified };
}

export function sameAsBaseline(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): boolean {
  const d = diffSnapshots(base, cur, volatileClasses);
  return !d.added.length && !d.removed.length && !d.modified.length;
}
