// Read-only DevTools access for the protocol recorder (black-box re-plan §7.1).
// The recorder may enable network events and detach; every other command (page scripts, input,
// navigation, raw sends) is refused here, before it can reach the browser.

/** The raw DevTools connection. Only ReadOnlyCdp may hold one. */
export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: unknown) => void): void;
  close(): void;
}

export class ForbiddenCdpCommandError extends Error {}

const ALLOWED = new Set(['Network.enable']);

export class ReadOnlyCdp {
  readonly #conn: CdpConnection;
  #listeners = new Map<string, Array<(params: unknown) => void>>();
  #closed = false;

  constructor(conn: CdpConnection) {
    this.#conn = conn;
    conn.onEvent((method, params) => {
      for (const fn of this.#listeners.get(method) ?? []) fn(params);
    });
  }

  /** The only way to send. Throws for anything outside the allow-list without touching the connection. */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new ForbiddenCdpCommandError(`connection is detached: ${method}`);
    if (!ALLOWED.has(method)) throw new ForbiddenCdpCommandError(`forbidden DevTools command: ${method}`);
    if (params && Object.keys(params).length) throw new ForbiddenCdpCommandError(`${method} takes no parameters here`);
    return this.#conn.send(method);
  }

  on(event: string, fn: (params: unknown) => void) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
  }

  detach() {
    if (this.#closed) return;
    this.#closed = true;
    this.#conn.close();
  }
}
