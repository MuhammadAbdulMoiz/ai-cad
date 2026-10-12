// UI exploration through the harness-owned browser (.profile). Repeatable; writes runs/explore-<ts>/.
// Safety: works only in a project it creates itself (its id must be absent from the pre-run project
// list), and only deletes a feature whose uuid the inspector proved was created by this run.
// Usage: pnpm exec tsx scripts/explore.ts   (Ivy running locally, profile logged in via login.bat)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { config } from '../src/config';
import { Inspector } from '../src/inspector';
import { takeSnapshot, loadEvidence, type ProjectRef } from '../src/adapter';
import { diffSnapshots, type ModelSnapshot } from '../src/snapshot';

const out = path.join(config.runsDir, `explore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(out, { recursive: true });
const log: Record<string, unknown>[] = [];
const note = (step: string, data: Record<string, unknown>) => {
  log.push({ step, t: new Date().toISOString(), ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 300));
};
const save = () => fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(log, null, 2));
let shotN = 0;
const shot = async (page: Page, name: string) => page.screenshot({ path: path.join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`) });

const ins = new Inspector(config.inspectorUrl);
const ev = loadEvidence();
const origin = new URL(config.frontendUrl).origin;

async function projectIds(): Promise<number[]> {
  return (JSON.parse(await ins.call('zcad_list_projects')) as { projectId: number }[]).map((p) => Number(p.projectId));
}

/** Visible interactive elements near the bottom toolbar, with any tooltip shown on hover. */
async function scanToolbar(page: Page) {
  const vh = page.viewportSize()!.height;
  const items = await page.evaluate((minY) => {
    const seen = new Set<Element>();
    return [...document.querySelectorAll('button, [role="button"], [class*="tool"] > *')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.top > minY && r.width > 8 && r.width < 200 && r.height > 8; })
      .filter((el) => !seen.has(el) && seen.add(el))
      .map((el) => { const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el as HTMLElement).innerText.trim(),
          title: el.getAttribute('title') ?? '', aria: el.getAttribute('aria-label') ?? '', cls: String(el.className).slice(0, 80) }; });
  }, vh - 140);
  const result = [];
  for (const it of items) {
    await page.mouse.move(it.x, it.y);
    await page.waitForTimeout(350);
    const tip = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"], .el-popper, [class*="tooltip"]')]
      .filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(' | '));
    result.push({ ...it, tooltip: tip });
  }
  return result;
}

/** Labels, inputs and buttons of floating panels/dialogs currently on screen. */
async function dumpPanels(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('[role="dialog"], .el-dialog, [class*="panel"], [class*="Panel"], [class*="popover"], .el-dropdown-menu, [role="menu"]')]
    .filter((e) => (e as HTMLElement).offsetParent !== null && (e as HTMLElement).innerText.trim())
    .map((e) => ({
      cls: String(e.className).slice(0, 80),
      text: (e as HTMLElement).innerText.trim().slice(0, 600),
      inputs: [...e.querySelectorAll('input, textarea')].map((i) => ({
        type: (i as HTMLInputElement).type, value: (i as HTMLInputElement).value, placeholder: (i as HTMLInputElement).placeholder,
        label: (i.closest('[class*="item"], label, [class*="row"]') as HTMLElement | null)?.innerText.trim().slice(0, 80) ?? '' })),
      buttons: [...e.querySelectorAll('button, [role="button"]')].map((b) => (b as HTMLElement).innerText.trim()).filter(Boolean),
    })));
}

async function clickText(page: Page, text: string | RegExp, timeout = 10000) {
  await page.getByText(text, { exact: typeof text === 'string' }).first().click({ timeout });
}

async function main() {
  const ctx = await chromium.launchPersistentContext(config.profileDir, {
    headless: false, ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1600, height: 900 },
    channel: config.browserChannel || undefined, // bundled Chromium fails here (Windows SxS); see Task 11 report
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  let proj: ProjectRef | undefined;
  const snaps: Record<string, ModelSnapshot> = {};
  const snap = async (label: string) => {
    snaps[label] = await takeSnapshot(ins, proj!, ev);
    note(`snapshot:${label}`, { features: snaps[label].objects.size });
    return snaps[label];
  };
  const diff = (a: string, b: string) => {
    const d = diffSnapshots(snaps[a], snaps[b], ev.volatileClasses);
    return { added: d.added.map((o) => `${o.cls} ${o.name}`), removed: d.removed.map((o) => o.cls), modified: d.modified.map((o) => o.cls) };
  };

  try {
    // 1. Home + login check
    await page.goto(`${origin}/p/home`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('use_local_server', 'true'); // dev flag: talk to local zcad_service
      localStorage.setItem('userLanguage', JSON.stringify('en-US')); // deterministic UI language = en-US i18n strings
      localStorage.setItem('open_language', 'true'); // required alongside userLanguage for English (per human)
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const home = await page.getByText('New 3D Design').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await shot(page, 'home');
    if (!home) { note('login', { ok: false, hint: 'Not logged in (no "New 3D Design"). Run login.bat first.', url: page.url() }); return; }

    // 2. Create a disposable part; identify its project explicitly
    const before = await projectIds();
    await clickText(page, 'New 3D Design');
    await page.waitForURL(/\/a\/mda\/zcad\?.*projectId=\d+/, { timeout: 30000 });
    const url = new URL(page.url());
    const projectId = Number(url.searchParams.get('projectId'));
    await page.getByText('New Sketch').first().waitFor({ timeout: 90000 });
    const after = await projectIds();
    note('project', { url: page.url(), projectId, before, after, isNew: !before.includes(projectId), listed: after.includes(projectId) });
    if (before.includes(projectId) || !after.includes(projectId)) throw new Error('could not prove the editor project is a new project served by the local backend');
    proj = { projectId, projectTag: 'main' };
    await shot(page, 'editor');
    await snap('s0-empty');

    // 3. Toolbar inventory (labels + tooltips)
    note('toolbar:part', { items: await scanToolbar(page) });

    // 4. New Sketch → task panel
    await clickText(page, 'New Sketch');
    await page.waitForTimeout(1500);
    note('panel:new-sketch', { panels: await dumpPanels(page) });
    await shot(page, 'sketch-panel');
    await page.getByRole('button', { name: /^Confirm$/ }).first().click({ timeout: 10000 });
    await page.getByText('Exit Sketch').first().waitFor({ timeout: 20000 });
    note('toolbar:sketch', { items: await scanToolbar(page) });
    await shot(page, 'sketch-mode');

    // 5. Rectangle via inline dimension inputs, typed slowly; record what the inputs look like
    const canvas = await page.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')].map((e) => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return c && { x: c.left + c.width / 2, y: c.top + c.height / 2 };
    });
    if (!canvas) throw new Error('no canvas found');
    const rectBtn = (await scanToolbar(page)).find((b) => /Corner Rectangle|Rectangle/i.test(b.tooltip));
    note('rect:button', { rectBtn });
    if (!rectBtn) throw new Error('rectangle tool not found by tooltip');
    await page.mouse.click(rectBtn.x, rectBtn.y); // exactly once: a second click toggles construction mode (observed)
    await page.mouse.click(canvas.x, canvas.y);   // sketch origin is at the canvas centre right after entering the sketch (observed)
    for (let i = 1; i <= 10; i++) { await page.mouse.move(canvas.x + i * 20, canvas.y - i * 12); await page.waitForTimeout(40); }
    await page.waitForTimeout(600);
    const dimInputs = await page.evaluate(() => [...document.querySelectorAll('input')].filter((i) => (i as HTMLElement).offsetParent !== null)
      .map((i) => ({ value: i.value, focused: i === document.activeElement, cls: String(i.className).slice(0, 60) })));
    note('rect:dimension-inputs', { dimInputs });
    await shot(page, 'rect-preview');
    await page.keyboard.type('100', { delay: 250 });
    await page.waitForTimeout(400);
    await shot(page, 'rect-width-typed');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    await page.keyboard.type('60', { delay: 250 });
    await page.waitForTimeout(400);
    await shot(page, 'rect-height-typed');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await shot(page, 'rect-done');
    await page.keyboard.press('Escape'); // leave the rectangle tool
    await clickText(page, 'Exit Sketch');
    await page.getByText('New Sketch').first().waitFor({ timeout: 20000 });
    await snap('s1-sketch');
    note('verify:sketch', { diff: diff('s0-empty', 's1-sketch') });
    await shot(page, 'after-sketch');

    // 6. Extrude: find by tooltip, dump its task panel, set depth if a single obvious field exists
    const tools = await scanToolbar(page);
    const ext = tools.find((b) => /^Extrude/i.test(b.tooltip) || /^Extrude/i.test(b.text));
    note('extrude:button', { ext });
    if (!ext) throw new Error('extrude tool not found by tooltip');
    await page.mouse.click(ext.x, ext.y);
    await page.waitForTimeout(2000);
    const extPanels = await dumpPanels(page);
    note('panel:extrude', { panels: extPanels });
    await shot(page, 'extrude-panel');
    const depthInput = page.locator('input').filter({ hasNot: page.locator('[type="checkbox"]') });
    note('extrude:inputs', { count: await depthInput.count() });
    const depth = page.getByRole('textbox').nth(0);
    const depthLabelled = page.getByLabel(/Depth|Distance|深度|距离/).first();
    const target = (await depthLabelled.count()) ? depthLabelled : depth;
    await target.click({ clickCount: 3, timeout: 5000 });
    await page.keyboard.type('8', { delay: 200 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await shot(page, 'extrude-depth');
    await page.getByRole('button', { name: /^Confirm$/ }).first().click({ timeout: 10000 });
    await page.waitForTimeout(3000);
    await snap('s2-extrude');
    const d12 = diffSnapshots(snaps['s1-sketch'], snaps['s2-extrude'], ev.volatileClasses);
    note('verify:extrude', { diff: diff('s1-sketch', 's2-extrude') });
    await shot(page, 'after-extrude');

    // 7. Delete ONLY the extrude this run created (proven by inspector diff)
    const created = d12.added.find((o) => o.cls === ev.featureClass.extrude);
    if (!created?.name) throw new Error('no extrude created by this run; delete step skipped');
    const node = page.getByText(created.name, { exact: true }).first();
    await node.click({ button: 'right', timeout: 10000 });
    await page.waitForTimeout(800);
    note('menu:feature-context', { panels: await dumpPanels(page) });
    await shot(page, 'context-menu');
    await clickText(page, 'Delete');
    await page.waitForTimeout(1000);
    const confirm = await dumpPanels(page);
    note('panel:delete-confirm', { panels: confirm });
    await shot(page, 'delete-confirm');
    const confirmBtn = page.getByRole('button', { name: /^(Confirm|OK|Delete)$/ }).first();
    if (await confirmBtn.count()) await confirmBtn.click();
    await page.waitForTimeout(2000);
    await snap('s3-deleted');
    note('verify:delete', { diff: diff('s2-extrude', 's3-deleted'), backToSketchOnly: diff('s1-sketch', 's3-deleted') });
    await shot(page, 'after-delete');
  } catch (e) {
    note('FAILED', { error: (e as Error).message });
    await shot(page, 'failure').catch(() => {});
  } finally {
    note('console-errors', { count: consoleErrors.length, sample: consoleErrors.slice(0, 20) });
    save();
    await ctx.close();
    console.log(`\nobservations: ${out}`);
  }
}

await main();
