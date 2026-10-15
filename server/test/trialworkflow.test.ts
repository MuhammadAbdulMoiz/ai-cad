import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaptureRecord } from '../src/recorder';
import { buildSummary, editorUrl, matchesEditorUrl, nextAction, OPEN_LIVE_GAPS, pageQuiet, selectEmptyTab, waitForQuiet, type SummaryInput } from '../src/trialworkflow';

const page = (id: string, url: string) => ({ id, type: 'page', url });
const ui = { id: 'U', type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' };
const sw = { id: 'W', type: 'service_worker', url: 'https://local.zixel.cn:8080/a/mda/obs-cache.js' };

describe('selectEmptyTab (--target auto)', () => {
  it.each(['chrome://newtab/', 'about:blank'])('accepts the single page when it is %s', (url) => {
    expect(selectEmptyTab([page('T1', url), ui, sw, { id: 'F', type: 'iframe', url: 'chrome-untrusted://new-tab-page/one-google-bar?x=1' }])).toEqual({ id: 'T1' });
  });
  it('refuses the editor (or any other page) and names it', () => {
    expect(selectEmptyTab([page('T1', 'https://local.zixel.cn:8080/a/mda/zcad?id=1&projectId=2'), ui])).toEqual({ problem: '--target auto: the only page is https://local.zixel.cn:8080/a/mda/zcad (T1), not an empty tab (chrome://newtab/ or about:blank)' });
    expect(selectEmptyTab([page('T1', 'https://local.zixel.cn:8080/p/home')]).problem).toMatch(/the only page is https:\/\/local\.zixel\.cn:8080\/p\/home \(T1\)/);
  });
  it('refuses two pages or none, listing them', () => {
    expect(selectEmptyTab([page('A', 'chrome://newtab/'), page('B', 'https://x/zcad?id=1')])).toEqual({ problem: '--target auto needs exactly one page, found 2: A chrome://newtab/; B https://x/zcad' });
    expect(selectEmptyTab([ui, sw])).toEqual({ problem: '--target auto needs exactly one page, found 0: none' });
  });
  it('does not accept look-alikes', () => {
    expect(selectEmptyTab([page('A', 'chrome://newtab/?x')]).problem).toBeDefined();
    expect(selectEmptyTab([page('A', 'about:blank#x')]).problem).toBeDefined();
  });
});

describe('editorUrl (--origin)', () => {
  it('builds the exact editor URL', () => {
    expect(editorUrl('https://local.zixel.cn:8080', '37660627', 37660626)).toBe('https://local.zixel.cn:8080/a/mda/zcad?id=37660627&projectId=37660626');
    expect(editorUrl('https://local.zixel.cn:8080/', '1', 2)).toBe('https://local.zixel.cn:8080/a/mda/zcad?id=1&projectId=2');
  });
  it.each([
    ['not a URL', 'local.zixel.cn', '--origin local.zixel.cn is not a URL'],
    ['another scheme', 'javascript:alert(1)', '--origin must be a bare http(s) origin, not javascript:alert(1)'],
    ['a path', 'https://x/evil', '--origin must be a bare http(s) origin, not https://x/evil'],
    ['a query', 'https://x/?a=1', '--origin must be a bare http(s) origin, not https://x/?a=1'],
    ['credentials', 'https://u:p@x', '--origin must be a bare http(s) origin, not https://u:p@x'],
  ])('refuses %s', (_n, origin, msg) => expect(() => editorUrl(origin, '1', 2)).toThrow(msg));
  it('refuses non-numeric ids', () => {
    expect(() => editorUrl('https://x', '1&projectId=9', 2)).toThrow('editor id and project id must be positive integers');
    expect(() => editorUrl('https://x', '1', 0)).toThrow('editor id and project id must be positive integers');
  });
});

describe('readiness: the editor quiet for 3 s before state is read (cap 20 s, fail closed)', () => {
  const sent = (t: number, opcode = 2): CaptureRecord => ({ i: 0, t, type: 'frame', requestId: 'S', dir: 'sent', ts: 0, opcode, mask: true, payload: 'AAAA' });
  it('counts only binary requests on the model socket', () => {
    expect(pageQuiet([sent(1000)], 'S', 3999, 3000)).toBe(false);
    expect(pageQuiet([sent(1000)], 'S', 4000, 3000)).toBe(true);
    expect(pageQuiet([sent(1000), sent(3900, 1)], 'S', 4000, 3000)).toBe(true); // a text ping does not count
    expect(pageQuiet([sent(1000), { ...sent(3900), requestId: 'other' } as CaptureRecord], 'S', 4000, 3000)).toBe(true);
  });
  it('waits until quiet', async () => {
    let t = 0; const recs = [sent(0), sent(1000)];
    const r = await waitForQuiet({ recs: () => recs, modelSocket: 'S', now: () => t, sleep: async (ms) => { t += ms; } });
    expect(r).toEqual({ quiet: true, waitedMs: 4000 });
  });
  it('refuses when the page keeps sending past the cap', async () => {
    let t = 0; const recs: CaptureRecord[] = [];
    const r = await waitForQuiet({ recs: () => { recs.push(sent(t)); return recs; }, modelSocket: 'S', now: () => t, sleep: async (ms) => { t += ms; } });
    expect(r).toEqual({ quiet: false, waitedMs: 20000 });
  });
});

describe('summary and next action', () => {
  const url = 'https://local.zixel.cn:8080/a/mda/zcad?id=37660627&projectId=37660626';
  const plan = { tipFeatureId: 12, planeFeatureId: 3, sketchName: 'Sketch2', extrudeName: 'Extrude1', lines: [[-50, 30, 50, 30], [50, 30, 50, -30], [50, -30, -50, -30], [-50, -30, -50, 30]], width: 100, height: 60, depth: 8 };
  const identity = { projectId: 37660626, projectTag: 'main', workshopId: 1, docId: 527, modelSocket: '51360.7008', sessionId: '268435458' };
  const worker = { url: 'https://local.zixel.cn:8080/a/mda/obs-cache.js', attachedAt: '2026-10-14T03:52:47.205Z', gapMs: 2, activity: 0, accepted: true, note: 'n' };
  const base: SummaryInput = { label: 'pre3', verdict: 'preflight-passed', out: 'runs/plate-trial-pre3', url, identity, docUuid: '01519N1Q4KK1QHVP08AJMJK097', plan, checks: [{ check: 'a', pass: true }], worker, attested: true };
  it('a passing preflight never reads as an authorization', () => {
    const n = nextAction(base);
    expect(n).toBe('Preflight passed; nothing was sent. A passing preflight authorizes nothing: a live write needs your explicit go for that specific run, then a new run with --write and --attest, and typing "write" at its prompt.');
    expect(n).not.toMatch(/^Write|you may write|ready to write/i);
  });
  it.each([
    ['incomplete', {}, `Nothing was sent. The editor was not seen loading under the recorder: start a new run (new label), then load ${url} in the attached tab within the --wait time.`],
    ['preflight-refused', {}, 'Nothing was sent. Resolve the failed checks above, then rerun the preflight with a new label.'],
    ['error', {}, 'Nothing was sent. Resolve the failed checks above, then rerun the preflight with a new label.'],
    ['write-refused', { sending: ['the user did not type "write"'] }, 'Nothing was sent: the user did not type "write".'],
    ['plate-failed', { sent: ['sketchCreate', 'sketchDraw'] }, 'Stopped after sketchCreate, sketchDraw; nothing was retried, undone or deleted. The document may hold partial residue: review report.json and postconditions.json before deciding anything further.'],
    ['plate-incomplete', {}, 'All nine steps and the final check were verified; centring cannot be measured. Review the evidence; nothing was undone.'],
  ])('next action for %s', (verdict, extra, want) => expect(nextAction({ ...base, verdict, ...extra })).toBe(want));
  it('prints target, plan, failed checks, risks and the next action', () => {
    const s = buildSummary({ ...base, verdict: 'preflight-refused', checks: [{ check: 'a', pass: true }, { check: 'inventory', pass: false, detail: ['socket x never closed'] }] });
    expect(s.split('\n')).toEqual([
      '== SUMMARY pre3: preflight-refused ==',
      'Target: project 37660626/main, workshop 1, document 527 (uuid 01519N1Q4KK1QHVP08AJMJK097), session 268435458, model socket 51360.7008',
      'Plan:   Sketch2 on plane 3 after tip 12; rectangle (-50, -30)–(50, 30) = 100 × 60; Extrude1 depth 8',
      'Failed checks: ',
      '  - inventory: ["socket x never closed"]',
      'Outstanding risks:',
      '  - exclusivity is the user\'s attestation, not server-verified; HTTP routes and pipeline requests are not covered',
      '  - service worker monitored only from 2026-10-14T03:52:47.205Z (2 ms after first sight): activity before that cannot be ruled out',
      '  - centring is not measurable with the approved read operations (best possible verdict: incomplete)',
      ...OPEN_LIVE_GAPS.map((g) => `  - ${g}`),
      'Next: Nothing was sent. Resolve the failed checks above, then rerun the preflight with a new label.',
      'Evidence: runs/plate-trial-pre3',
    ]);
  });
  it('says so when no target or plan was established', () => {
    const s = buildSummary({ label: 'x', verdict: 'incomplete', out: 'o', url, checks: [], attested: false });
    expect(s).toContain('Target: not established');
    expect(s).toContain('Plan:   none');
    expect(s).toContain('Failed checks: none');
    expect(s).not.toContain('attestation');
  });
});

// Guardrail only: the workflow helpers must stay free of anything that could act on the browser or Ivy.
describe('trialworkflow.ts is pure (guardrail)', () => {
  it('imports no connection, page call, sender or guard', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'trialworkflow.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/(cdpconnect|cdpguard|pagecall|writesender|livewriteguard|inspector)'|fetch\(|Runtime\.|Page\.|sendRaw/);
  });
});

describe('matchesEditorUrl: the recorded tab is exactly the printed editor URL', () => {
  const want = 'https://local.zixel.cn:8080/a/mda/zcad?id=37660627&projectId=37660626';
  it('accepts the same URL, also with extra query parameters the editor adds', () => {
    expect(matchesEditorUrl(want, want)).toBe(true);
    expect(matchesEditorUrl('https://local.zixel.cn:8080/a/mda/zcad?projectId=37660626&id=37660627&tab=1', want)).toBe(true);
  });
  it.each([
    ['another origin', 'https://evil.example:8080/a/mda/zcad?id=37660627&projectId=37660626'],
    ['another port', 'https://local.zixel.cn:9999/a/mda/zcad?id=37660627&projectId=37660626'],
    ['another path', 'https://local.zixel.cn:8080/p/home?id=37660627&projectId=37660626'],
    ['another document', 'https://local.zixel.cn:8080/a/mda/zcad?id=1&projectId=37660626'],
    ['another project', 'https://local.zixel.cn:8080/a/mda/zcad?id=37660627&projectId=1'],
    ['no URL', 'chrome://newtab/'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_n, url) => expect(matchesEditorUrl(url, want)).toBe(false));
});
