export class InspectorError extends Error {}

export class Inspector {
  private id = 0;
  constructor(private url: string, private timeoutMs = 15000) {}

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    let body: any;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      // Accept plain JSON or a single SSE "data:" frame.
      const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? '';
      body = JSON.parse(json);
    } catch (e) {
      throw new InspectorError(`inspector unavailable: ${(e as Error).message}`);
    }
    if (body.error) throw new InspectorError(`inspector error ${body.error.code}: ${body.error.message}`);
    const text = (body.result?.content ?? []).map((c: any) => c.text ?? '').join('');
    if (body.result?.isError) throw new InspectorError(text);
    return text;
  }
}
