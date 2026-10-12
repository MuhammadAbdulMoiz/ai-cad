import { FEATURE_TYPES, CHECK_KINDS, validatePlan, type PlanResult } from './plan';
import type { AskText } from './llm';

export const PLANNER_SYSTEM = `You are a CAD design planner for the Ivy CAD system. Turn the user's product request
into a JSON build plan. Reply with ONLY one JSON object, no prose.

Schema:
{ "product": string, "units": "mm", "parameters": {name: number},
  "features": [{ "id": "f1", "type": string, "dependsOn": ["f<earlier>"], "params": {...}, "checks": [{"kind": string, "expect": any}] }],
  "acceptance": [{"kind": string, "expect": any}] }

Supported feature types and params:
- sketch_rectangle: { "plane": "XY"|"XZ"|"YZ", "width": mm>0, "height": mm>0 }
- extrude: { "depth": mm>0 }   (must depend on a sketch_rectangle)

Check kinds: ${CHECK_KINDS.join(', ')}.
Prefer checks the harness can currently prove: feature_exists, depends_on (and acceptance reopen_matches). dimension, status_ok and body_count are accepted but currently report "unsupported" and cannot pass.

If the request needs ANY operation other than ${FEATURE_TYPES.join(', ')} (holes, fillets, revolves, patterns,
assemblies...), still include it as a feature with its real name as "type" (e.g. "hole"). Never drop or
approximate a requested operation; the harness reports it as unsupported.`;

function extractJson(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in reply');
  return JSON.parse(text.slice(a, b + 1));
}
function check(text: string): PlanResult {
  try { return validatePlan(extractJson(text)); }
  catch (e) { return { ok: false, unsupported: false, errors: [`invalid JSON: ${(e as Error).message}`] }; }
}

export async function makePlan(userPrompt: string, ask: AskText, signal?: AbortSignal) {
  const first = check(await ask(PLANNER_SYSTEM, userPrompt, signal));
  if (first.ok || first.unsupported) return { ...first, attempts: 1 };
  const retry = `${userPrompt}\n\nYour previous plan had these errors:\n- ${first.errors.join('\n- ')}\nReturn a corrected JSON plan.`;
  return { ...check(await ask(PLANNER_SYSTEM, retry, signal)), attempts: 2 };
}
