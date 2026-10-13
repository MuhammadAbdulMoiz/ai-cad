// The one way ai-cad reaches Ivy (Phase 2b): a fixed function evaluated in the editor page that hands encoded bytes
// to the page's existing socket service (ProtoSocketService.getRawAsyncMessage, mda ProtoSocketService.ts:1862).
// Only validated operations from queryport.ts can be sent; no other DevTools command or page code is expressible.
import { z } from 'zod';
import type { CdpConnection } from './cdpguard';
import { encodeOp } from './queryport';
import type { Schema } from './wsframes';

// Returns only what the page knows about the request; the reply content is read from the recorded frames instead.
export const PAGE_FN = `async (a) => {
  const s = window.__mda_ivySocketService__;
  if (!s || typeof s.getRawAsyncMessage !== 'function' || typeof s.getProjectID !== 'function' || typeof s.getProjectTag !== 'function')
    return { ok: false, error: 'page socket service missing or changed' };
  const project = { projectId: String(s.getProjectID()), projectTag: String(s.getProjectTag() || 'main'), valid: typeof s.isValid === 'function' ? !!s.isValid() : null };
  if (a.mode === 'probe') return { ok: true, project };
  if (project.projectId !== a.projectId || project.projectTag !== a.projectTag) return { ok: false, error: 'page project mismatch', project };
  try {
    const r = await s.getRawAsyncMessage(a.cmd, a.bodyFieldNo, new Uint8Array(a.body), { timeout: a.timeoutMs });
    return { ok: true, project, asyncId: r && r.header && r.header.asyncId != null ? String(r.header.asyncId) : null };
  } catch (e) {
    return { ok: false, project, unknownOutcome: true, error: 'no reply: ' + (e && e.message ? e.message : String(e)) };
  }
}`;

const ProjectZ = z.object({ projectId: z.string(), projectTag: z.string(), valid: z.boolean().nullable() });
const PageResultZ = z.object({
  ok: z.boolean(), error: z.string().optional(), project: ProjectZ.optional(),
  asyncId: z.string().nullable().optional(), unknownOutcome: z.boolean().optional(),
}).strict();
export type PageResult = z.infer<typeof PageResultZ>;
export type Target = { projectId: number; projectTag: string };

export class PageCall {
  readonly #conn: CdpConnection;
  #closed = false;
  constructor(conn: CdpConnection) { this.#conn = conn; }

  async #evaluate(arg: Record<string, unknown>): Promise<PageResult> {
    if (this.#closed) throw new Error('page call is closed');
    const res: any = await this.#conn.send('Runtime.evaluate', {
      expression: `(${PAGE_FN})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true,
    });
    if (res?.exceptionDetails) throw new Error(`page function threw: ${res.exceptionDetails.text ?? 'exception'}`);
    const parsed = PageResultZ.safeParse(res?.result?.value);
    if (!parsed.success) throw new Error(`malformed page result: ${JSON.stringify(res?.result?.value)?.slice(0, 200)}`);
    return parsed.data;
  }

  /** Reads the page socket's project and tag; sends nothing to Ivy. */
  probe(): Promise<PageResult> { return this.#evaluate({ mode: 'probe' }); }

  /** Sends one approved operation; refuses anything else before the page is touched. */
  async send(schema: Schema, op: unknown, target: Target, timeoutMs: number): Promise<{ result: PageResult; body: Uint8Array; cmd: number }> {
    const e = encodeOp(schema, op);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('timeoutMs must be 1000..60000');
    const result = await this.#evaluate({
      mode: 'send', projectId: String(target.projectId), projectTag: target.projectTag,
      cmd: e.cmd, bodyFieldNo: e.bodyFieldNo, body: Array.from(e.body), timeoutMs,
    });
    return { result, body: e.body, cmd: e.cmd };
  }

  close() { if (!this.#closed) { this.#closed = true; this.#conn.close(); } }
}
