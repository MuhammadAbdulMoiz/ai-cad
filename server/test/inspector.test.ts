import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inspector, InspectorError } from '../src/inspector';

type Reply = { status?: number; type?: string; text: string };
let server: http.Server;

// Respond with a raw body. Returning null means never respond (hang).
function serve(respond: (body: any) => Reply | null): Promise<string> {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const reply = respond(JSON.parse(data));
      if (!reply) return;
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', reply.type ?? 'application/json');
      res.end(reply.text);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
}
const json = (reply: (b: any) => unknown) => (b: any): Reply => ({ text: JSON.stringify(reply(b)) });

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Inspector', () => {
  it('returns tool text', async () => {
    const url = await serve(json((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: `called ${b.params.name}` }], isError: false } })));
    expect(await new Inspector(url).call('zcad_list_projects')).toBe('called zcad_list_projects');
  });
  it('throws on isError', async () => {
    const url = await serve(json((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: 'Project 1(main) is not active.' }], isError: true } })));
    await expect(new Inspector(url).call('zcad_get_object_graph', { projectId: 1 }))
      .rejects.toThrow('Project 1(main) is not active.');
  });
  it('throws on JSON-RPC error', async () => {
    const url = await serve(json((b) => ({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'bad' } })));
    await expect(new Inspector(url).call('x')).rejects.toBeInstanceOf(InspectorError);
  });
  it('throws InspectorError when server is down', async () => {
    await expect(new Inspector('http://127.0.0.1:1/mcp').call('x')).rejects.toBeInstanceOf(InspectorError);
  });

  it('uses the SSE event matching the request id, skipping notifications', async () => {
    const result = { jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'ok result' }], isError: false } };
    const url = await serve(() => ({ type: 'text/event-stream', text:
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
      `event: message\ndata: ${JSON.stringify(result)}\n\n` }));
    expect(await new Inspector(url).call('x')).toBe('ok result');
  });
  it('throws InspectorError when SSE has no event matching the request id', async () => {
    const url = await serve(() => ({ type: 'text/event-stream', text:
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 99, result: { content: [], isError: false } })}\n\n` }));
    await expect(new Inspector(url).call('x')).rejects.toBeInstanceOf(InspectorError);
  });
  it('throws InspectorError on HTTP 500 with an HTML body', async () => {
    const url = await serve(() => ({ status: 500, type: 'text/html', text: '<html>boom</html>' }));
    const err = await new Inspector(url).call('x').catch((e) => e);
    expect(err).toBeInstanceOf(InspectorError);
    expect(err.message).toContain('HTTP 500');
  });
  it('throws InspectorError when the reply has neither result nor error', async () => {
    const url = await serve(json((b) => ({ jsonrpc: '2.0', id: b.id })));
    await expect(new Inspector(url).call('x')).rejects.toThrow('missing result');
  });
  it('throws InspectorError on timeout when the server never responds', async () => {
    const url = await serve(() => null);
    const started = Date.now();
    await expect(new Inspector(url, 100).call('x')).rejects.toBeInstanceOf(InspectorError);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
