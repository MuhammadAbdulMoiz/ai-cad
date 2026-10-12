import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { design, DESIGNER_SYSTEM } from '../src/designer';

const platePlan = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'skills', 'plate', 'plan.json'), 'utf8'));
const reply = (plan: unknown, questions: string[] = []) => '```json\n' + JSON.stringify({ plan, questions }) + '\n```';

describe('design', () => {
  it('returns a validated plan and passes questions through', async () => {
    const ask = vi.fn().mockResolvedValue(reply(platePlan, ['Hole pattern needed?']));
    const r = await design('a 100x60x8 mounting plate', ask);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.dims.thickness).toBe(8); expect(r.questions).toEqual(['Hole pattern needed?']); expect(r.attempts).toBe(1); }
  });
  it('re-asks once with the validator errors, then succeeds', async () => {
    const bad = structuredClone(platePlan); bad.features[1].profile = 'missing';
    const ask = vi.fn().mockResolvedValueOnce(reply(bad)).mockResolvedValueOnce(reply(platePlan));
    const r = await design('plate', ask);
    expect(r.ok && r.attempts).toBe(2);
    expect(ask.mock.calls[1][1]).toMatch(/rejected:[\s\S]*missing/);
  });
  it('unsupported operation fails at once without a re-ask and keeps the questions', async () => {
    const withFillet = structuredClone(platePlan); withFillet.features.push({ type: 'fillet', id: 'f1', radius: 2 });
    const ask = vi.fn().mockResolvedValue(reply(withFillet, ['Edge radius?']));
    const r = await design('plate with rounded edges', ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.unsupported).toBe(true); expect(r.errors.join()).toMatch(/fillet/); expect(r.questions).toEqual(['Edge radius?']); }
  });
  it('fails after two unusable replies (no JSON, then no plan field)', async () => {
    const ask = vi.fn().mockResolvedValueOnce('sorry').mockResolvedValueOnce('{"questions":[]}');
    const r = await design('plate', ask);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.attempts).toBe(2); expect(r.errors.join()).toMatch(/no "plan" field/); }
  });
  it('system prompt lists every unverified operation and the never-drop rule', () => {
    for (const op of ['fillet', 'hole', 'pattern', 'shell']) expect(DESIGNER_SYSTEM).toContain(op);
    expect(DESIGNER_SYSTEM).toMatch(/Never approximate or silently drop/);
  });
});
