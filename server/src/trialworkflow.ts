// Small pure helpers that let scripts/plate-trial.ts run with less supervision: pick the one empty tab to record,
// build the exact editor URL the human must load, wait until the page is quiet before reading state, and print one
// summary with the next required action. None of them navigates, clicks, sends or authorizes anything.
import type { CaptureRecord } from './recorder';
import type { WorkerReport } from './workermonitor';

export type TabTarget = { id: string; type: string; url: string };
const EMPTY_TABS = new Set(['chrome://newtab/', 'about:blank']);

/** The single page target, accepted only when it is an empty tab; otherwise why not, naming every page. */
export function selectEmptyTab(targets: TabTarget[]): { id?: string; problem?: string } {
  const pages = targets.filter((t) => t.type === 'page');
  const list = pages.map((p) => `${p.id} ${p.url.split('?')[0]}`).join('; ') || 'none';
  if (pages.length !== 1) return { problem: `--target auto needs exactly one page, found ${pages.length}: ${list}` };
  if (!EMPTY_TABS.has(pages[0].url)) return { problem: `--target auto: the only page is ${pages[0].url.split('?')[0]} (${pages[0].id}), not an empty tab (chrome://newtab/ or about:blank)` };
  return { id: pages[0].id };
}

/** The editor URL for one document, from an http(s) origin; throws on anything else. */
export function editorUrl(origin: string, id: string, projectId: number): string {
  let o: URL;
  try { o = new URL(origin); } catch { throw new Error(`--origin ${origin} is not a URL`); }
  if ((o.protocol !== 'https:' && o.protocol !== 'http:') || (o.pathname !== '/' && o.pathname !== '') || o.search || o.hash || o.username || o.password) throw new Error(`--origin must be a bare http(s) origin, not ${origin}`);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('editor id and project id must be positive integers');
  const u = new URL('/a/mda/zcad', o.origin);
  u.searchParams.set('id', id);
  u.searchParams.set('projectId', String(projectId));
  return u.toString();
}

/** Whether a tab's URL is the expected editor URL: same origin, same path, same `id` and `projectId`. */
export function matchesEditorUrl(url: string, expected: string): boolean {
  try {
    const u = new URL(url), e = new URL(expected);
    return u.origin === e.origin && u.pathname === e.pathname && u.searchParams.get('id') === e.searchParams.get('id') && u.searchParams.get('projectId') === e.searchParams.get('projectId');
  } catch { return false; }
}

/** Whether the page has sent no binary request on the model socket for `quietMs` (its text pings do not count). */
export function pageQuiet(recs: CaptureRecord[], modelSocket: string, now: number, quietMs: number): boolean {
  const last = recs.filter((r) => r.type === 'frame' && r.requestId === modelSocket && r.dir === 'sent' && r.opcode === 2).at(-1);
  return !last || now - last.t >= quietMs;
}

/** Polls until the page is quiet for `quietMs`, at most `capMs`. `quiet: false` means readiness was not established. */
export async function waitForQuiet(o: { recs: () => CaptureRecord[]; modelSocket: string; quietMs?: number; capMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<{ quiet: boolean; waitedMs: number }> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const quietMs = o.quietMs ?? 3000, capMs = o.capMs ?? 20000, start = now();
  for (;;) {
    if (pageQuiet(o.recs(), o.modelSocket, now(), quietMs)) return { quiet: true, waitedMs: now() - start };
    if (now() - start >= capMs) return { quiet: false, waitedMs: now() - start };
    await sleep(250);
  }
}

/**
 * Live gaps still open (kept here so every summary repeats them until they are closed); keep in step with the guard.
 */
export const OPEN_LIVE_GAPS = [
  'the needs-update option-bit rule (allowed after write2 stopped on it at step 2) has not yet run live; for widthAdd/heightAdd it rests on Ivy source only',
  'steps 3–9 have never run live; settle timing is untested live',
  'an existing sketch can be accepted only with a data notification from this session showing it empty; at page load there is none, so a document holding sketches is refused',
];

type Check = { check: string; pass: boolean; detail?: unknown };
type Plan = { tipFeatureId: number; planeFeatureId: number; sketchName: string; extrudeName: string; lines: number[][]; width: number; height: number; depth: number };
export type SummaryInput = {
  label: string; verdict: string; out: string; url: string;
  identity?: { projectId: number; projectTag: string; workshopId: number; docId: number; modelSocket: string; sessionId: string };
  docUuid?: string; plan?: Plan; checks: Check[]; worker?: WorkerReport; attested: boolean;
  sending?: unknown; sent?: string[];
  /** The separate definition-level check (platedefinition.ts), when a run created a sketch and an extrude. */
  definition?: { definition_centered: string; extrusion_definition: string; extrusion_direction: string; solid_position_measured: boolean; problems: string[] };
};

/** The one next action for a verdict. A passing preflight never authorizes a write. */
export function nextAction(i: Pick<SummaryInput, 'verdict' | 'url' | 'sending' | 'sent'>): string {
  switch (i.verdict) {
    case 'incomplete': return `Nothing was sent. The editor was not seen loading under the recorder: start a new run (new label), then load ${i.url} in the attached tab within the --wait time.`;
    case 'preflight-refused':
    case 'error': return 'Nothing was sent. Resolve the failed checks above, then rerun the preflight with a new label.';
    case 'preflight-passed': return 'Preflight passed; nothing was sent. A passing preflight authorizes nothing: a live write needs your explicit go for that specific run, then a new run with --write and --attest, and typing "write" at its prompt.';
    case 'write-refused': return `Nothing was sent: ${Array.isArray(i.sending) ? i.sending.join('; ') : String(i.sending ?? 'the write gate refused')}.`;
    case 'plate-incomplete': return 'All nine steps and the final check were verified; centring cannot be measured. Review the evidence; nothing was undone.';
    case 'plate-failed': return `Stopped after ${i.sent?.length ? i.sent.join(', ') : 'no step'}; nothing was retried, undone or deleted. The document may hold partial residue: review report.json and postconditions.json before deciding anything further.`;
    default: return 'See result.json.';
  }
}

/** The concise end-of-run summary (printed and saved as summary.txt). */
export function buildSummary(i: SummaryInput): string {
  const t = i.identity;
  const target = t ? `project ${t.projectId}/${t.projectTag}, workshop ${t.workshopId}, document ${t.docId}${i.docUuid ? ` (uuid ${i.docUuid})` : ''}, session ${t.sessionId}, model socket ${t.modelSocket}` : 'not established';
  let plan = 'none';
  if (i.plan) {
    const xs = i.plan.lines.flatMap((l) => [l[0], l[2]]), ys = i.plan.lines.flatMap((l) => [l[1], l[3]]);
    plan = `${i.plan.sketchName} on plane ${i.plan.planeFeatureId} after tip ${i.plan.tipFeatureId}; rectangle (${Math.min(...xs)}, ${Math.min(...ys)})–(${Math.max(...xs)}, ${Math.max(...ys)}) = ${i.plan.width} × ${i.plan.height}; ${i.plan.extrudeName} depth ${i.plan.depth}`;
  }
  const failed = i.checks.filter((c) => !c.pass);
  const risks: string[] = [];
  if (i.attested) risks.push('exclusivity is the user\'s attestation, not server-verified; HTTP routes and pipeline requests are not covered');
  const w = i.worker;
  if (w?.attachedAt) risks.push(`service worker monitored only from ${w.attachedAt} (${w.gapMs ?? '?'} ms after first sight): activity before that cannot be ruled out`);
  risks.push('centring is not measurable with the approved read operations (best possible verdict: incomplete)');
  risks.push(...OPEN_LIVE_GAPS);
  return [
    `== SUMMARY ${i.label}: ${i.verdict} ==`,
    `Target: ${target}`,
    `Plan:   ${plan}`,
    ...(i.definition ? [
      `Definition (Ivy's recorded model data, not a measurement): definition_centered=${i.definition.definition_centered}, extrusion_definition=${i.definition.extrusion_definition}, solid_position_measured=${i.definition.solid_position_measured}; direction ${i.definition.extrusion_direction}`,
      ...i.definition.problems.map((p) => `  - ${p}`),
    ] : []),
    `Failed checks: ${failed.length ? '' : 'none'}`,
    ...failed.map((c) => `  - ${c.check}${c.detail === undefined ? '' : `: ${JSON.stringify(c.detail)}`}`),
    'Outstanding risks:',
    ...risks.map((r) => `  - ${r}`),
    `Next: ${nextAction(i)}`,
    `Evidence: ${i.out}`,
  ].join('\n');
}
