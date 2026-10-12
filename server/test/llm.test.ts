import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { askText } from '../src/llm';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

describe('askText', () => {
  beforeEach(() => { vi.mocked(query).mockReset(); });

  it('rejects an already-aborted signal without calling query', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(askText('sys', 'prompt', ac.signal)).rejects.toThrow('aborted');
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves the success result text', async () => {
    vi.mocked(query).mockReturnValue((async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })() as any);
    await expect(askText('sys', 'prompt')).resolves.toBe('ok');
  });
});
