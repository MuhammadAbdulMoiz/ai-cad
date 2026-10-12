import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';

export type AskText = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export const askText: AskText = async (system, prompt, signal) => {
  if (signal?.aborted) throw new Error('aborted');
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let text = '';
  try {
    for await (const m of query({
      prompt,
      options: { model: config.model, systemPrompt: system, tools: [], maxTurns: 1, settingSources: [], abortController },
    })) {
      if (m.type === 'result') {
        if ('result' in m && typeof m.result === 'string') text = m.result;
        else throw new Error(`planner query failed: ${JSON.stringify(m).slice(0, 300)}`);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return text;
};
