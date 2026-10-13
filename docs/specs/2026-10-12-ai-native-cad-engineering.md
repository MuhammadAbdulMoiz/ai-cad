# AI-native parametric CAD engineering: design spec

> **2026-10-13:** Ivy is now a black box (no Ivy changes). The native-MCP-in-zcad_service plan here is superseded by [the black-box re-plan](2026-10-13-black-box-ivy-integration.md).

Date: 2026-10-12 · Status: draft for review · **Supersedes** the UI-automation direction of `2026-10-12-ivy-cad-harness-design.md`. Its evidence, verification and run-control rules carry over (§8).

## 1. Product goal

The user states a part or product ("design a smartwatch case", "a 300 mm ventilated brake rotor"). The system produces an **editable Ivy CAD model with a meaningful feature history**, together with evidence of what was verified.

The agent reasons about engineering intent, chooses a modelling strategy, constructs geometry through **deterministic native CAD operations**, independently verifies the result, and reports proven versus unproven properties.

The agent is **not** primarily a UI-automation system. Browser automation is reserved for viewing, screenshots, operations with no native interface, and user interaction.

Success is measured by:
- the correctness and usefulness of the final parametric model;
- the quality of its feature history;
- the reliability of verification;
- how little manual intervention it needed.

How closely the agent imitates a human clicking is not a measure.

## 2. Roles (kept separate)

| Role | Component | Responsibility |
|---|---|---|
| Engineer | LLM agent (engineering planner → feature planner) | Intent, dimensions, assumptions, feature graph, questions for decisions that matter |
| Tools | Ivy CAD MCP (in `zcad_service`) | Exact, typed construction and read-only measurement |
| Execution manager | ai-cad harness | Run control, one-feature-at-a-time execution, evidence, reports |
| Judge | Verifier | Feature history, parameters, geometry. Unsupported is never pass. |

## 3. Layers

**A. Engineering planner.** Converts the request into components, dimensions and units, assumptions (labelled as such), acceptance criteria, and only the questions that materially change the result. Critical engineering requirements are never silently invented.

**B. Construction engine.** Executes a validated **feature plan** (`server/src/featureplan.ts`) as real Ivy features, through two native backends:
1. **Toolbox builder** (verified to exist; inline use not yet verified): sketch on `XY`/`YZ`/`ZX` with circle, polygon, rectangle or polyline profiles, extrude (blind or through-all, add or cut, reversed, symmetric), revolve about X/Y/Z, and expressions. Source: `ivyproject/zplugin/toolbox`; see `docs/protocol-spike.md` §2.
2. **Generic feature path** (`PartPkg.feat_update_req` = `UpdateMessageReq`, a Create → Modify → Confirm lifecycle with `attrRole` items). It's needed for fillet, chamfer, hole, pattern, mirror, shell, offset planes and arcs in profiles. **Not yet supported.** Each feature type is enabled only when its request path and verification are proven.

**C. Verifier.** It grades five levels, and reports prove only what they have evidence for:

| Level | Status today |
|---|---|
| Feature history | **Supported** (inspector: uuid, class, `DependsOn`, reopen persistence) |
| Parameters | Pending the read-only query tools (`IVY_QUERY_PARAM_REQ`) |
| Geometry | Pending the query tools (`IVY_QUERY_MEASURE_REQ`: volume, AABB) |
| Design intent | Future (relationship checks) |
| Engineering validation | **Out of scope.** Every output is labelled `maturity: concept`. |

A successful tool response is never treated as a successful solid.

## 4. Feature plan contract

`FeaturePlan = {part, label?, units: 'mm', maturity: 'concept', parameters{name: number}, derived{name: expression}, assumptions[], features[]}`.

Feature types today are `sketch`, `extrude` and `revolve`, as a stricter subset of what the backend asset reader accepts. Expressions use the backend evaluator's grammar:
- operators `+ - * / ^`, with unary minus binding tighter than `^`;
- one-argument functions `sin cos tan asin acos atan sqrt abs floor ceil round deg rad`;
- constants `pi` and `e`;
- names that resolve to parameters and derived values first.

Before anything executes, validation rejects:
- unknown or unverified operations (`unsupported`; never dropped or approximated);
- duplicate ids, and references to sketches that are unknown or come later;
- non-positive evaluated sizes;
- unknown names, and cycles in derived values;
- a cut before any body exists;
- malformed profiles.

## 5. Execution

1. **Target:** an explicitly supplied `projectId` and `documentId`. The system never auto-creates projects and never picks "last listed". Creating a document for a clean rebuild is allowed **only with per-build approval** of the build and its destination (decided 2026-10-12).
   **First live target (supplied 2026-10-12):** `projectId = 37649980`, editor URL `id = 37649982` (assumed documentId; to be confirmed by the zcad_service task, protocol-spike §6 item 2).
2. **Per feature (or per Toolbox build):** baseline snapshot → execute through MCP → read the result code → verify, comparing the snapshot diff and measurements with the plan.
3. **Failure:** diagnose, and *propose* a plan revision. **Repair = revised plan + clean rebuild** into an approved destination. The system never edits a possibly corrupted model in place. Recovery by in-place mutation **stays disabled** until restoration can be proven.

## 6. Named parameters (capability gate)

Editable, expression-driven models require Ivy's parameter table to be written, and features bound to it. The Toolbox builder evaluates expressions at build time, so its features may hold plain numbers. **Until a live build shows parameters persisted and linked, reports must say "dimensions applied as values", not "parametric".**

## 7. Engineering claims

All outputs are **concept geometry**. Structural and geometric checks are reported separately from manufacturing, stress, thermal and safety validation, which this system does not perform.

## 8. Carried over from the harness spec

- The evidence gate: checks exist only where Task 0 evidence supports them.
- uuid-keyed snapshots and fail-closed inspector use.
- One active run.
- Events persisted as they happen, atomic artifacts, and `interrupted`, `cancelled` and `failed` never becoming `passed`.
- Recovery disabled.
- Console-error baselining (used when the browser viewport is attached).

## 9. Skills

Skills live in `skills/<name>/` as `SKILL.md` (approach, valid sequence, failure modes, verification), `plan.json` (validated by tests) and `expected.json`. `expected.json` holds **measured** values from a recorded run. Until a value is measured, it is marked `unmeasured`, and analytic numbers are labelled as hypotheses. Templates speed the agent up; they don't restrict it.

## 10. Milestones

1. ✅ Native protocol spike, read-only (`docs/protocol-spike.md`).
2. Native build and query tools in `zcad_service` (separate reviewed `ivyproject` task), then a live plate build on a supplied target.
3. Plate from a natural-language request: feature history, parameters and geometry verified; report and screenshots.
4. Planning and diagnosis loop (feature-by-feature execution, revise-and-rebuild repair).
5. Wider coverage: brackets, flanges, enclosures, shafts, then assemblies. Generic features are added one at a time as their paths are proven.
