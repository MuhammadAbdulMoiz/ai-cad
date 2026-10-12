export class InspectorError extends Error {}

export class Inspector {
  private id = 0;
  constructor(private url: string, private timeoutMs = 15000) {}

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const id = ++this.id;
    let res: Response;
    let raw: string;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      raw = await res.text();
    } catch (e) {
      throw new InspectorError(`inspector unavailable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new InspectorError(`inspector HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const body = pickReply(raw, id);
    if (body.error) throw new InspectorError(`inspector error ${body.error.code}: ${body.error.message}`);
    if (body.result == null) throw new InspectorError('inspector reply missing result');
    const text = (body.result.content ?? []).map((c: any) => c.text ?? '').join('');
    if (body.result.isError) throw new InspectorError(text);
    return text;
  }
}

// Returns the JSON-RPC message whose id matches the request. Accepts plain JSON
// or an SSE stream; in SSE, events are blank-line separated and may include
// notifications (no id) before the response.
function pickReply(raw: string, id: number): any {
  const messages: string[] = [];
  if (raw.trimStart().startsWith('{')) {
    messages.push(raw);
  } else {
    let data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line === '') {
        if (data.length) messages.push(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length) messages.push(data.join('\n'));
  }
  for (const text of messages) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new InspectorError('inspector reply was not valid JSON');
    }
    if (msg?.id === id) return msg;
  }
  throw new InspectorError(`inspector reply had no response for request ${id}`);
}
