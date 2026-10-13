import { describe, expect, it } from 'vitest';
import { ForbiddenCdpCommandError, ReadOnlyCdp, type CdpConnection } from '../src/cdpguard';

function fakeConnection() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  let listener: ((m: string, p: unknown) => void) | undefined;
  let closed = 0;
  const conn: CdpConnection = {
    send: async (method, params) => { calls.push({ method, params }); return {}; },
    onEvent: (l) => { listener = l; },
    close: () => { closed++; },
  };
  return { conn, calls, emit: (m: string, p: unknown) => listener?.(m, p), closedCount: () => closed };
}

// Commands a recorder must never be able to issue: page scripts, input, navigation, network tampering, raw target sends.
const FORBIDDEN = [
  'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.enable', 'Page.navigate', 'Page.reload', 'Page.enable',
  'Page.addScriptToEvaluateOnNewDocument', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'DOM.setAttributeValue', 'Network.setExtraHTTPHeaders', 'Network.disable', 'Fetch.enable', 'Fetch.fulfillRequest',
  'Target.sendMessageToTarget', 'Target.attachToTarget', 'Debugger.enable', 'Emulation.setDeviceMetricsOverride', '',
];

describe('ReadOnlyCdp', () => {
  it('forwards Network.enable', async () => {
    const f = fakeConnection();
    await new ReadOnlyCdp(f.conn).send('Network.enable');
    expect(f.calls).toEqual([{ method: 'Network.enable', params: undefined }]);
  });

  it.each(FORBIDDEN)('refuses %s before it reaches the connection', async (method) => {
    const f = fakeConnection();
    await expect(new ReadOnlyCdp(f.conn).send(method)).rejects.toBeInstanceOf(ForbiddenCdpCommandError);
    expect(f.calls).toEqual([]);
  });

  it('refuses parameters even on the allowed command', async () => {
    const f = fakeConnection();
    await expect(new ReadOnlyCdp(f.conn).send('Network.enable', { maxTotalBufferSize: 1 })).rejects.toBeInstanceOf(ForbiddenCdpCommandError);
    expect(f.calls).toEqual([]);
  });

  it('closes once on detach and refuses every command afterwards', async () => {
    const f = fakeConnection();
    const cdp = new ReadOnlyCdp(f.conn);
    cdp.detach(); cdp.detach();
    expect(f.closedCount()).toBe(1);
    await expect(cdp.send('Network.enable')).rejects.toBeInstanceOf(ForbiddenCdpCommandError);
    expect(f.calls).toEqual([]);
  });

  it('exposes no handle to the raw connection', () => {
    const f = fakeConnection();
    const cdp = new ReadOnlyCdp(f.conn) as unknown as Record<string, unknown>;
    expect(Object.keys(cdp)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(cdp)).sort()).toEqual(['constructor', 'detach', 'on', 'send']);
    expect(Object.values(cdp)).not.toContain(f.conn);
  });

  it('delivers events to subscribers', () => {
    const f = fakeConnection();
    const cdp = new ReadOnlyCdp(f.conn);
    const seen: unknown[] = [];
    cdp.on('Network.webSocketCreated', (p) => seen.push(p));
    f.emit('Network.webSocketCreated', { requestId: 'r1' });
    f.emit('Network.other', {});
    expect(seen).toEqual([{ requestId: 'r1' }]);
  });
});
