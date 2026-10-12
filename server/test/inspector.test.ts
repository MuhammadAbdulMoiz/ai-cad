import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inspector, InspectorError } from '../src/inspector';

let server: http.Server;
function stub(reply: (body: any) => unknown): Promise<string> {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply(JSON.parse(data))));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
}
afterEach(() => server?.close());

describe('Inspector', () => {
  it('returns tool text', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: `called ${b.params.name}` }], isError: false } }));
    expect(await new Inspector(url).call('zcad_list_projects')).toBe('called zcad_list_projects');
  });
  it('throws on isError', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: 'Project 1(main) is not active.' }], isError: true } }));
    await expect(new Inspector(url).call('zcad_get_object_graph', { projectId: 1 }))
      .rejects.toThrow('Project 1(main) is not active.');
  });
  it('throws on JSON-RPC error', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'bad' } }));
    await expect(new Inspector(url).call('x')).rejects.toBeInstanceOf(InspectorError);
  });
  it('throws InspectorError when server is down', async () => {
    await expect(new Inspector('http://127.0.0.1:1/mcp').call('x')).rejects.toBeInstanceOf(InspectorError);
  });
});
