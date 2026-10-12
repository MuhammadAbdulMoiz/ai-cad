# Ivy CAD AI Harness — Design Spec

Date: 2026-10-12
Status: Draft for review

## 1. Goal

A local harness that takes a natural-language product prompt (e.g. "100×60×8 mm mounting plate"),
designs a structured CAD plan, then drives the real Ivy web CAD (mda frontend + ivyproject backend)
in a browser to build the model feature by feature, independently verifying each feature before
continuing. Each run yields a saved model, a reproducible report, and a UI bug log.

Primary value: automated, verified CAD construction through Ivy's real UI (product demo and
end-to-end regression of the CAD itself).

## 2. Decisions (agreed)

| Topic | Decision |
|---|---|
| Stack | Node + TypeScript (Python not available on target machine). |
| Agent loop | `@anthropic-ai/claude-agent-sdk` `query()`; no hand-rolled loop. |
| Geometry creation | Through Ivy's UI only, via Playwright MCP (`@playwright/mcp`). |
| Verification | Ivy backend MCP `zcad-runtime-inspector` (HTTP, `127.0.0.1:8083/mcp`), read-only. |
| Runtime model | `HARNESS_MODEL` env var, default `claude-sonnet-5-5`. Key from `ANTHROPIC_API_KEY`. |
| Interface | Local web console (single static page) + REST + SSE. |
| Launch | `.bat` files. |
| Concurrency | Exactly one active run and one CAD session. |
| Outputs | Run report (HTML), saved CAD model, UI bug log (`bugs.json`). |

Investigated and rejected for v1:
- **FeatureScriptPlugin**: Python script workbench that authors new *dynamic feature types*
  (`SCRIPT_CMD_SAVE` / `SCRIPT_CMD_EXPORT` → task panel). Not a model-building API.
- **RecordManager replay**: opaque protobuf payloads. Revisit after UI flow is repeatable.
- No frontend JS command API is exposed on `window`; none will be added in v1.

## 3. Environment (as found)

- Frontend: `C:\zixel\mda`, started with `pnpm dev:pc` (Vite, `@zixel/mda-pc`). Requires Zixel login.
- Backend: `C:\zixel\ivyproject\build\built\bin\zcad_service.exe` (HTTP/WS + MCP on port from
  `mcp.port`, default 8083). Optional `build\conanrun.bat` sources runtime DLL env.
- Inspector MCP tools: `zcad_list_projects`, `zcad_get_object_graph` (DOT),
  `zcad_get_object_json`, `zcad_get_undo_history`, `zcad_get_constraint_graph`,
  `zcad_get_constraint_node`, `zcad_get_pipeline_history`.

Paths (`MDA_DIR`, `IVY_BIN`, `FRONTEND_URL`, ports) live in `ai-cad\.env`, with defaults matching the above.

## 4. Task 0 — Inspector evidence probe (blocks verifier work)

Before writing any verifier:
1. Start Ivy, manually create: new part → rectangle sketch → extrude.
2. Capture `zcad_list_projects`, `zcad_get_object_graph` (full and compact), `zcad_get_object_json`
   for the sketch, the extrude feature and the body, and `zcad_get_undo_history`. Capture once
   *before* the extrude and once *after*.
3. Save raw outputs as fixtures: `server/test/fixtures/inspector/<name>.{dot,json}`.
4. Write `docs/inspector-fields.md` recording, with evidence, for each concept: feature identity
   and type, dependency edges, body/solid presence, compute status (success/error), dimension
   values, and how to tell new objects from pre-existing ones (IDs, undo marks).
5. Any concept not exposed is marked **unsupported**. The verifier reports unsupported checks as
   `unsupported`, never as `pass`.

Small helper `server/scripts/probe.ts` (calls the MCP and dumps outputs) makes this repeatable.

## 5. Architecture

```
ai-cad/
  .env.example
  start-all.bat       starts zcad_service.exe, pnpm dev:pc, harness server; opens console
  start-harness.bat   harness server only (Ivy already running)
  login.bat           opens Playwright persistent profile at FRONTEND_URL for one-time Zixel login
  stop-all.bat        kills the processes started by start-all
  accept.bat          live acceptance run (plate prompt)
  server/
    src/
      index.ts         HTTP server: static console, REST, SSE
      orchestrator.ts  run state machine (one slot), pause/cancel, recovery
      planner.ts       prompt → plan.json (zod-validated)
      executor.ts      per-feature Agent SDK query() with restricted tools
      verifier.ts      inspector-based checks for one feature / whole model
      inspector.ts     minimal MCP-over-HTTP client for zcad-runtime-inspector
      store.ts         run dir, events.jsonl append, atomic writes
      report.ts        report.html + bugs.json from run dir
      plan.ts          zod schema + types
    playbook/          Ivy UI knowledge per operation (markdown, fed to the executor prompt)
      common.md  sketch-rectangle.md  extrude.md  save.md
    test/              vitest unit tests + fixtures
    scripts/probe.ts
  web/index.html       console (vanilla JS, no framework)
  runs/<runId>/        plan.json, events.jsonl, state.json, shots/*.png, report.html, bugs.json
  .profile/            Playwright persistent browser profile (gitignored)
```

The orchestrator is independent of the console: closing the console never affects a run.
All state needed to rebuild the report lives on disk in `runs/<runId>/`.

## 6. Plan contract (`plan.json`)

```ts
Plan = {
  product: string,
  units: 'mm',
  parameters: Record<string, number>,
  features: Array<{
    id: string,                 // 'f1', 'f2', ...
    type: 'sketch_rectangle' | 'extrude',   // v1 supported set; grows with promotion gate
    dependsOn: string[],        // ids of earlier features
    params: Record<string, number | string>,
    checks: Array<{ kind: CheckKind, expect?: unknown }>
  }>,
  acceptance: Array<{ kind: CheckKind, expect?: unknown }>
}
```

- `CheckKind` values are fixed after Task 0, from the supported concepts (e.g. `feature_exists`,
  `depends_on`, `status_ok`, `body_count`, `dimension`).
- Validation: zod schema plus semantic rules: unique ids, `dependsOn` refers only to earlier ids,
  feature `type` in the supported set.
- If validation fails, the planner gets one re-ask with the error list. If it fails again, the run ends
  `failed` at `designing` with the errors in the report.
- Prompts asking for unsupported operations fail at design with the reason
  "operation X not supported in this version". The planner never silently drops a feature.

## 7. Run state machine

```
idle → designing → [ per feature in order:
                       baseline → executing → verifying → passed
                                                   ↘ recovering → executing (max 2) → failed ]
     → saving → verifying_model → reporting → passed | failed
any state --cancel--> cancelling → reporting → cancelled
```

- **Single slot**: `POST /runs` while a run is active → `409 {error:'busy', runId}`.
- **baseline**: before each feature, snapshot every inspector object as `{id, class, hash}` (hash of
  its normalized `zcad_get_object_json`), plus a console-log mark. Feature checks only match
  objects **not in the baseline**, so a pre-existing feature can never satisfy a new check.
  After the feature, any baseline object that was removed or whose hash changed is an
  **unexpected modification**, unless its class is in the evidence-derived `volatileClasses`
  list (objects Task 0 shows legitimately change on a normal operation, e.g. document root).
  An unexpected modification fails the feature.
- **console baseline**: console errors are keyed by a normalized signature (message without
  numbers, hex ids or URLs' query strings). Errors during a feature whose signature was never seen
  before that feature started are `new` and fail the feature (`no_new_console_errors`). Errors whose
  signature already occurred are `recurring`: they go to `bugs.json` but don't fail the feature.
- **executing**: one Agent SDK `query()` scoped to this feature. Prompt = feature spec, the
  playbook for its type plus `common.md`, and the last verifier diagnostics (on recovery).
  Max ~25 turns (`maxTurns`). The agent ends by calling `report_feature_done({summary})`.
  This only means the agent finished trying. It never implies success.
- **verifying**: the harness (not the agent) runs the feature checks against the inspector,
  scans the browser console errors captured during the step, and takes a screenshot.
  All checks `pass` → `passed`. Any `fail` → `recovering`. `unsupported` checks are recorded
  but don't block.
- **recovering**: undo safety first.
  1. Compare the current object set with the baseline. If the only new objects are the failed
     feature's partial objects, the agent is instructed to delete exactly those (by name/ID shown
     in the diagnostics) via the UI feature tree.
     If any baseline object was modified or removed (§ baseline), recovery is not attempted:
     run `failed`, reason "unsafe to recover: existing objects modified — restart required".
  2. Re-snapshot. If the state isn't exactly the baseline (same ids, same hashes, ignoring
     `volatileClasses`), or that can't be verified (inspector error), stop: run `failed`, reason
     "unsafe to recover: restoration not verified — restart required".
  3. Otherwise retry `executing` with diagnostics. Max 2 recovery attempts per feature.
  Ctrl+Z / undo is **not** used unless Task 0 shows undo history can be scoped to the
  failed feature's marks. That decision is recorded in `docs/inspector-fields.md`.
- A failed feature stops the run. Downstream features are never attempted.
- **saving / verifying_model**: save via UI (playbook `save.md`), then run the `acceptance` checks.
  Reopen-and-recheck is attempted. If it can't be automated reliably it is reported as `skipped`
  (never `pass`).
- **Verdict rules**: `passed` only if every feature passed, save succeeded, and no acceptance
  check is `fail`. `cancelled` and `failed` runs can never receive `passed`.

### Pause / cancel / retry
- **Pause** takes effect at the next safe checkpoint (before the next feature's `baseline`). It
  never interrupts an in-progress CAD operation. Resume continues from that checkpoint.
- **Cancel** aborts the current `query()` via `AbortController`, then best-effort cleanup: final
  screenshot, partial report. Verdict is `cancelled`.
- **Retry feature** is only available on a `failed` run whose failed feature is the last
  attempted one (no downstream state exists) and whose current object set equals that feature's
  baseline. It reruns only that feature, then continues. In every other case the console offers
  "Restart run" (same prompt, new runId) instead.

## 8. Agent tool boundary

The executor's `query()` is configured with:
- `mcpServers`: `playwright` (stdio, `@playwright/mcp --cdp-endpoint <harness browser>`), plus an
  in-process SDK MCP server exposing only `report_feature_done`. The agent does **not** get the
  inspector: the harness alone verifies, which keeps the agent from grading its own work.
- `tools: []` (no built-ins), `settingSources: []`, and a `canUseTool` gate allowing only
  `mcp__playwright__*` (minus the denied tools below) and `report_feature_done`. The model never
  gets shell or filesystem access.
- The planner's `query()` has no tools: plain JSON output.
- Process start/stop, file writes and screenshots for reports are done by harness code, not the model.

Browser process: the harness launches one Chromium (`launchPersistentContext(.profile)` with a
CDP port) and keeps it for the whole run. The harness records console errors and takes screenshots
from it. Each `query()` starts `@playwright/mcp --cdp-endpoint` attached to that same browser, so CAD
state persists across features. `canUseTool` denies `browser_evaluate`, `browser_run_code`,
`browser_close`, `browser_install`, `browser_file_upload`, `browser_tabs`, and navigation outside
`FRONTEND_URL`'s origin.

Browser ownership: the harness owns `.profile`. `login.bat` is the only manual use. If the
profile is locked (Chrome already open on it) when a run starts, the run fails fast with
"close the login browser first".

## 9. Persistence and reporting

- Every state transition, tool call summary, verifier result and console error is appended to
  `runs/<id>/events.jsonl` as it happens, and flushed per line.
- `state.json`, `plan.json`, `report.html` and `bugs.json` are written atomically (write `*.tmp`,
  then rename).
- Report writing runs in `finally`. After a hard crash, `GET /runs/:id/report` regenerates the
  report from `events.jsonl`. A run with no terminal event is shown as `interrupted` (not passed).
- Report contents: prompt, plan, environment (model, git SHAs of mda and ivyproject if
  available, harness version), per-feature steps with screenshots, check results
  (pass/fail/unsupported/skipped), verdict and reason.
- `bugs.json`: browser console errors, failed UI actions, inspector errors and timeouts, each
  with feature id, timestamp and screenshot ref.

## 10. Console (`web/index.html`)

- Prompt box and preset buttons (plate, flange, shaft-with-keyway, enclosure). Presets for
  operations not yet promoted are shown disabled with "not yet supported".
- Live phase and a per-feature checklist with status icons and step thumbnails.
- Controls: Pause / Resume / Cancel / Retry feature (only when allowed per §7) / Restart run.
- Verdict banner with reason, run history list, and artifact links.

REST: `POST /runs {prompt}`, `GET /runs`, `GET /runs/:id`, `POST /runs/:id/{pause,resume,cancel,retry}`,
`GET /runs/:id/events` (SSE; replays `events.jsonl` then streams live), static `/runs/<id>/*` files.

## 11. Scope and promotion gate

**Milestone 1 (this spec):** Task 0, then automate rectangle sketch → extrude plate, save, and
verify, repeatably.

**Promotion gate** for each new operation type (holes, fillet, revolve, pattern, assembly):
3 consecutive passing runs of a fixed prompt, where pass = complete end-to-end run with verified
geometry, successful save, and all required artifacts. A failed run resets the streak. Each
gate run records prompt, plan, model and environment SHAs in `runs/`. Results are tracked in
`docs/promotion.md`.

## 12. Testing

Unit tests (vitest, no live Ivy):
- plan schema and semantic validation (bad deps, unsupported type, duplicate ids).
- verifier against Task 0 fixtures: pass, fail, unsupported, and baseline exclusion (an old
  feature doesn't satisfy a new check).
- orchestrator with a fake executor/verifier: busy slot (409), feature fail → recovery
  exhausted → `failed` with downstream not attempted, divergent state → unsafe-recover
  stop, cancel mid-feature → `cancelled` (never `passed`), pause at checkpoint only.
- store: atomic write, and report regeneration from `events.jsonl` after a simulated crash.

Live acceptance (`accept.bat`): runs the plate prompt end to end and asserts: verdict `passed`,
`report.html` exists, model saved, one screenshot per feature step.

## 13. Acceptance criteria

1. A prompt produces a validated structured plan (or a clear design-phase failure).
2. The harness executes a small feature sequence in Ivy through the UI.
3. Each feature is independently verified (baseline-scoped) before the next begins.
4. Failed operations produce actionable diagnostics, and the report is never corrupted or lost.
5. A successful run saves the model and produces a reproducible report with screenshots and
   verification results.
6. Runs can be cancelled safely, cannot run concurrently, and cancelled/failed runs never pass.

## 14. Out of scope (v1)

Parallel runs, RecordManager replay, FeatureScript generation, assemblies, multi-user,
remote deployment, and automatic login.
