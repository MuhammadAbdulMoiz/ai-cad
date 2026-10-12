import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from './config';
import { ConsoleLog } from './consolelog';

export class ProfileLockedError extends Error {}

export function isProfileLockError(message: string): boolean {
  // \block\b, not bare "lock": Playwright's call log lists flags such as BlockOriginHeaderModificationOnRedirect.
  return /ProcessSingleton|\block(ed|s)?\b|already in use/i.test(message);
}

export class HarnessBrowser {
  readonly console = new ConsoleLog();
  readonly cdpEndpoint = `http://127.0.0.1:${config.cdpPort}`;
  private constructor(private ctx: BrowserContext) {}

  static async launch(): Promise<HarnessBrowser> {
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(config.profileDir, {
        headless: false, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 },
        args: [`--remote-debugging-port=${config.cdpPort}`],
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (isProfileLockError(msg)) throw new ProfileLockedError('Browser profile is in use: close the login browser first.');
      throw e;
    }
    const b = new HarnessBrowser(ctx);
    for (const p of ctx.pages()) b.hook(p);
    ctx.on('page', (p) => b.hook(p));
    return b;
  }
  async open(url: string) {
    const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  async screenshot(file: string) {
    await this.ctx.pages().at(-1)?.screenshot({ path: file });
  }
  async close() { await this.ctx.close(); }
  waitForClose(): Promise<void> { return new Promise((r) => this.ctx.on('close', () => r())); }

  private hook(p: Page) {
    p.on('console', (m) => { if (m.type() === 'error') this.console.add(m.text()); });
    p.on('pageerror', (e) => this.console.add(`pageerror: ${e.message}`));
  }
}
