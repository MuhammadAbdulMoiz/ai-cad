// The only sender in ai-cad (approved 2026-10-13, disarmed by default): hands the live write guard's already-checked
// app-model bodies to the editor page through PAGE_FN's existing send mode, which is unchanged. It sends nothing
// unless constructed with `armed: true`, accepts only IVY_APP_MODEL_REQ with the body in field 100, and keeps a copy
// of every body it hands over (identity must not count our own requests as the page's). It checks nothing else:
// the guard decides what may be sent; this only carries it.
import type { CdpConnection } from './cdpguard';
import type { SendResult } from './livewriteguard';
import { PAGE_FN, PageResultZ, type Target } from './pagecall';
import { RefusedWriteError } from './writeport';

export const APP_MODEL_REQ = 120, APP_MODEL_FIELD = 100; // ivyproto.IvyCommand.IVY_APP_MODEL_REQ, IvyPkg.app_model_req

export class PageSender {
  readonly #conn: CdpConnection; readonly #target: Target; readonly #armed: boolean;
  readonly #sent: Uint8Array[] = [];
  #closed = false;
  constructor(conn: CdpConnection, target: Target, opts: { armed?: boolean } = {}) {
    this.#conn = conn; this.#target = { projectId: target.projectId, projectTag: target.projectTag };
    this.#armed = opts.armed === true; // disarmed unless explicitly armed
  }
  get armed(): boolean { return this.#armed; }
  /** Copies of every body handed to the page, in order. */
  sentBodies(): Uint8Array[] { return this.#sent.map((b) => Uint8Array.from(b)); }

  async sendRaw(cmd: number, bodyFieldNo: number, body: Uint8Array, timeoutMs: number): Promise<SendResult> {
    if (!this.#armed) throw new RefusedWriteError('the sender is disarmed');
    if (this.#closed) throw new RefusedWriteError('the sender is closed');
    if (cmd !== APP_MODEL_REQ || bodyFieldNo !== APP_MODEL_FIELD) throw new RefusedWriteError(`only IVY_APP_MODEL_REQ bodies in field ${APP_MODEL_FIELD} are sent, not ${cmd}/${bodyFieldNo}`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new RefusedWriteError('timeoutMs must be 1000..60000');
    const copy = Uint8Array.from(body);
    this.#sent.push(copy);
    const arg = { mode: 'send', projectId: String(this.#target.projectId), projectTag: this.#target.projectTag, cmd, bodyFieldNo, body: Array.from(copy), timeoutMs };
    const res: any = await this.#conn.send('Runtime.evaluate', { expression: `(${PAGE_FN})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true });
    if (res?.exceptionDetails) throw new Error(`page function threw: ${res.exceptionDetails.text ?? 'exception'}`);
    const p = PageResultZ.safeParse(res?.result?.value);
    if (!p.success) throw new Error(`malformed page result: ${JSON.stringify(res?.result?.value)?.slice(0, 200)}`);
    return { ok: p.data.ok, asyncId: p.data.asyncId ?? null, ...(p.data.unknownOutcome ? { unknownOutcome: true } : {}), ...(p.data.error ? { error: p.data.error } : {}) };
  }

  close() { if (!this.#closed) { this.#closed = true; this.#conn.close(); } }
}
