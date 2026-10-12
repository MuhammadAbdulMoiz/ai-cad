import { describe, it, expect, vi } from 'vitest';
import { makePlan } from '../src/planner';

const valid = JSON.stringify({ product: 'plate', units: 'mm', parameters: {},
  features: [{ id: 'f1', type: 'sketch_rectangle', dependsOn: [], params: { plane: 'XY', width: 100, height: 60 }, checks: [] },
             { id: 'f2', type: 'extrude', dependsOn: ['f1'], params: { depth: 8 }, checks: [] }],
  acceptance: [] });

describe('makePlan', () => {
  it('returns plan on first valid answer (JSON inside prose/fences is fine)', async () => {
    const ask = vi.fn().mockResolvedValue('Here:\n```json\n' + valid + '\n```');
    const r = await makePlan('plate', ask);
    expect(r.ok).toBe(true); expect(r.attempts).toBe(1);
  });
  it('re-asks once with errors, then succeeds', async () => {
    const ask = vi.fn().mockResolvedValueOnce('not json').mockResolvedValueOnce(valid);
    const r = await makePlan('plate', ask);
    expect(r.ok).toBe(true); expect(r.attempts).toBe(2);
    expect(ask.mock.calls[1][1]).toContain('errors');
  });
  it('fails after two invalid answers', async () => {
    const r = await makePlan('plate', vi.fn().mockResolvedValue('{}'));
    expect(r.ok).toBe(false); expect(r.attempts).toBe(2);
  });
  it('unsupported operation fails immediately without re-ask', async () => {
    const bad = JSON.parse(valid); bad.features.push({ id: 'f3', type: 'hole', dependsOn: ['f2'], params: {}, checks: [] });
    const ask = vi.fn().mockResolvedValue(JSON.stringify(bad));
    const r = await makePlan('plate with M8 holes', ask);
    expect(r.ok).toBe(false); expect(r.attempts).toBe(1);
    if (!r.ok) expect(r.errors.join()).toContain('not supported');
  });
});
