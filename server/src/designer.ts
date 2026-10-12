// Engineering planner: natural-language request -> validated FeaturePlan (+ assumptions, open questions).
// Interface-agnostic: produces the plan only; construction and verification happen elsewhere.
import { validateFeaturePlan, UNVERIFIED_OPERATIONS, type FeaturePlan } from './featureplan';
import type { AskText } from './llm';

export const DESIGNER_SYSTEM = `You are a mechanical design engineer planning a parametric CAD model for the Ivy CAD system.
Reply with ONLY one JSON object: { "plan": <FeaturePlan>, "questions": [<string>] }.

FeaturePlan:
{ "part": "<kebab-case id>", "label": "<name>", "units": "mm", "maturity": "concept",
  "parameters": { "<name>": <number mm> },            // every driving dimension, named
  "derived": { "<name>": "<expression>" },             // optional
  "assumptions": [ "<each assumption you made>" ],
  "features": [ ...in build order... ] }

Feature types available NOW (no other keys allowed on any object):
- {"type":"sketch","id":..,"plane":"XY"|"YZ"|"ZX","profile":[ <shapes> ]}   planes pass through the origin
  shapes: {"shape":"rectangle","width":v,"height":v,"cx"?:v,"cy"?:v,"rotation"?:v}
          {"shape":"circle","d":v | "r":v,"cx"?:v,"cy"?:v}
          {"shape":"polygon","sides":n>=3,"size":v,"fit"?:"acrossFlats"|"acrossCorners","cx"?,"cy"?,"rotation"?}
          {"shape":"polyline","points":[[x,y],...>=3, do NOT repeat the first point],"cx"?,"cy"?,"rotation"?}
- {"type":"extrude","id":..,"profile":"<earlier sketch id>","depth":v,"endType"?:"blind"|"throughAll",
   "operation"?:"add"|"cut","reversed"?:bool,"symmetric"?:bool,"solid"?:"<body name>"}
- {"type":"revolve","id":..,"profile":"<earlier sketch id>","axis":"X"|"Y"|"Z","operation"?:"add"|"cut","solid"?:..}
A value v is a number or an expression over parameter/derived names: + - * / ^ ( ),
functions sin cos tan asin acos atan sqrt abs floor ceil round deg rad, constants pi e.
A cut needs an earlier add in the same solid.

NOT available yet: ${UNVERIFIED_OPERATIONS.join(', ')}, arcs in profiles, offset sketch planes.
If the design needs any of them, still include them as features with their real "type" so the
system reports them as unsupported. Never approximate or silently drop a requested feature.

Engineering rules: state every assumption in "assumptions"; put only decisions that materially change
the result in "questions" (empty if none); never invent safety-critical requirements; this is concept
geometry, not a validated component.`;

export type DesignResult =
  | { ok: true; plan: FeaturePlan; dims: Record<string, number>; questions: string[]; attempts: number }
  | { ok: false; errors: string[]; unsupported: boolean; questions: string[]; attempts: number };

function parseReply(text: string): { plan?: unknown; questions: string[]; error?: string } {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { questions: [], error: 'reply contains no JSON object' };
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    const questions = Array.isArray(j?.questions) ? j.questions.filter((q: unknown) => typeof q === 'string') : [];
    if (!j || typeof j !== 'object' || !('plan' in j)) return { questions, error: 'reply has no "plan" field' };
    return { plan: j.plan, questions };
  } catch (e) {
    return { questions: [], error: `invalid JSON: ${(e as Error).message}` };
  }
}

/** At most two model calls. Unsupported operations fail immediately (a re-ask would only drop them). */
export async function design(request: string, ask: AskText, signal?: AbortSignal): Promise<DesignResult> {
  let prompt = request;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = parseReply(await ask(DESIGNER_SYSTEM, prompt, signal));
    const v = reply.error ? { ok: false as const, errors: [reply.error], unsupported: false } : validateFeaturePlan(reply.plan);
    if (v.ok) return { ok: true, plan: v.plan, dims: v.dims, questions: reply.questions, attempts: attempt };
    if (v.unsupported || attempt === 2) return { ...v, questions: reply.questions, attempts: attempt };
    prompt = `${request}\n\nYour previous reply was rejected:\n- ${v.errors.join('\n- ')}\nReturn a corrected reply.`;
  }
  throw new Error('unreachable');
}
