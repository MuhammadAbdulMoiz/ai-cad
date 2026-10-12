# Ivy CAD AI Harness Implementation Plan

> **Status (2026-10-12):** Tasks 1–11 done. Tasks 12–18 (UI executor, playbook, UI-driven orchestration) are **superseded** by `docs/specs/2026-10-12-ai-native-cad-engineering.md`; a new plan for native-MCP milestones follows once the zcad_service build/query interface is reviewed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementer model: `claude-haiku-5-5`. Tasks marked **[GATE]** are stops for the human, not for an agent.

**Goal:** Local harness that turns a product prompt into a validated CAD plan and builds it in Ivy's web UI, feature by feature, with independent, evidence-based verification.

**Architecture:** Thin Node/TS server. The harness owns one Chromium (persistent profile + CDP). Per feature, a Claude Agent SDK `query()` drives the UI through `@playwright/mcp` attached over CDP. The harness, never the agent, verifies the result with Ivy's read-only inspector MCP: a baseline snapshot diff plus checks derived from Task 0 evidence. A single-slot orchestrator persists events to disk. A static web console uses REST + SSE.

**Tech Stack:** Node 25, TypeScript, tsx 4.23.15, vitest 5.0.3, zod 4.6.6, @anthropic-ai/claude-agent-sdk 0.3.296, @playwright/mcp 0.0.83, playwright 1.64.0. Windows `.bat` launchers.

**Spec:** `docs/specs/2026-10-12-ivy-cad-harness-design.md` (read it before any task).

## Global Constraints

- Project root: `C:\zixel\ai-cad`. Server package in `server/`, console in `web/`, runs in `runs/`, browser profile in `.profile/`.
- Frontend: `C:\zixel\mda` (`pnpm dev:pc`, default `https://localhost:8080`, mkcert HTTPS). Backend: `C:\zixel\ivyproject\build\built\bin\zcad_service.exe`.
- Inspector MCP: `http://127.0.0.1:8083/mcp`, JSON-RPC 2.0, read-only. The harness never writes to Ivy except through the UI.
- Runtime model: `HARNESS_MODEL`, default `claude-sonnet-5-5`. API key from `ANTHROPIC_API_KEY`. Never hard-code keys.
- Exactly one active run. A second start returns HTTP 409.
- The agent gets **no** built-in tools (`tools: []`) and no shell or filesystem access. Tool gate is `canUseTool` with a prefix allowlist.
- Verdict `passed` only when every feature passed, the save succeeded, and no acceptance check is `fail`. `cancelled`, `failed` and `interrupted` never become `passed`.
- `unsupported` (field not exposed by the inspector per Task 0 evidence) is never treated as `pass`.
- Writes of `state.json`, `plan.json`, `report.html`, `bugs.json` and `evidence.json` are atomic (tmp + rename). Events are appended per line to `events.jsonl`.
- Imports are extensionless (tsconfig `moduleResolution: "Bundler"`, run with tsx). No `console.*` in `server/src` except `index.ts` startup lines. Scripts may use `console`.
- Commit after each task. Message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Inspector down or slow mid-run** (zcad_service crashed): the snapshot throws, so the feature is `failed` with reason "inspector unavailable", never `passed`. Test in Task 13.
2. **Agent says done but nothing changed** (no new objects): the `feature_exists` check fails, then recovery runs. Test in Task 9 (checks) and Task 13.
3. **Same console error before and during a feature** (noisy app): classified `recurring` and doesn't fail the feature. A brand-new error does fail it. Test in Task 8.
4. **Prompt for an unsupported operation** ("add M8 holes"): the plan fails at design with "operation not supported", and no browser actions happen. Test in Task 10.
5. **Harness process killed mid-run**: on restart, the run shows as `interrupted` and the report is regenerated from `events.jsonl`. Test in Task 7.

## File Map

```
ai-cad/
  .env.example                    Task 1
  start-ivy.bat                   Task 2   (backend + frontend only; for Task 0)
  setup.bat start-all.bat start-harness.bat login.bat stop-all.bat accept.bat   Task 17
  docs/task0-capture.md           Task 2
  docs/task0-notes.md             Task 3   (human)
  docs/inspector-fields.md        Task 4
  docs/promotion.md               Task 18
  server/
    package.json tsconfig.json vitest.config.ts   Task 1
    src/config.ts                 Task 1   env + paths
    src/inspector.ts              Task 1   MCP-over-HTTP client
    scripts/probe.ts              Task 2   evidence capture
    test/fixtures/inspector/**    Task 3   raw captures (user-produced)
    src/evidence.json             Task 5   evidence-derived class names / supported flags
    src/adapter.ts                Task 5   raw inspector output → ModelSnapshot
    src/snapshot.ts               Task 6   ModelSnapshot types + diff
    src/store.ts                  Task 7   run dir, events, atomic writes
    src/consolelog.ts             Task 8   console error baseline/classification
    src/plan.ts                   Task 9   plan schema + semantic validation
    src/checks.ts                 Task 9   Evidence type + check evaluation (pass/fail/unsupported)
    src/llm.ts                    Task 10  no-tools Agent SDK text call
    src/planner.ts                Task 10  prompt → Plan
    src/browser.ts                Task 11  Chromium launch (CDP), console capture, screenshots
    scripts/login.ts              Task 11  one-time login into .profile
    src/executor.ts               Task 12  per-feature query() + tool gate
    playbook/*.md                 Task 12  Ivy UI knowledge (Opus writes from Task 3 notes)
    src/orchestrator.ts           Task 13  state machine
    src/report.ts                 Task 14  report.html + bugs.json + env info
    src/server.ts                 Task 15  HTTP app: REST + SSE + static
    src/index.ts                  Task 15  real wiring + listen
    scripts/accept.ts             Task 17  live acceptance check
  web/index.html                  Task 16
```

---

# Milestone 1: Evidence gate (Tasks 1–5)

Nothing after Task 5 may start until the human approves `docs/inspector-fields.md` (Task 4 gate).

### Task 1: Server scaffold + inspector MCP client

**Files:**
- Create: `.env.example`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/config.ts`, `server/src/inspector.ts`
- Test: `server/test/inspector.test.ts`

**Interfaces:**
- Produces: `config` object (below). `class Inspector { constructor(url: string); call(tool: string, args?: Record<string, unknown>): Promise<string> }`. It throws `InspectorError` (has `.message`) on a transport failure, a JSON-RPC error, or `isError: true`.

- [ ] **Step 1: Create package files**

`server/package.json`:
```json
{
  "name": "ivy-cad-harness",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "probe": "tsx scripts/probe.ts",
    "test": "vitest --run",
    "typecheck": "tsc --noEmit"
  }
}
```
Then run in `server/`:
```bash
pnpm add @anthropic-ai/claude-agent-sdk@0.3.296 @playwright/mcp@0.0.83 playwright@1.64.0 zod@4.6.6
pnpm add -D tsx@4.23.15 vitest@5.0.3 typescript @types/node
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "resolveJsonModule": true, "types": ["node"]
  },
  "include": ["src", "scripts", "test"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`.env.example` (repo root):
```
ANTHROPIC_API_KEY=
HARNESS_MODEL=claude-sonnet-5-5
FRONTEND_URL=https://localhost:8080
INSPECTOR_URL=http://127.0.0.1:8083/mcp
HARNESS_PORT=4377
CDP_PORT=9222
MAX_TURNS_PER_FEATURE=25
MDA_DIR=C:\zixel\mda
IVY_BIN=C:\zixel\ivyproject\build\built\bin
```

- [ ] **Step 2: Write `server/src/config.ts`**

```ts
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* .env optional */ }
const env = (k: string, d: string) => process.env[k] || d;

export const config = {
  root,
  runsDir: path.join(root, 'runs'),
  profileDir: path.join(root, '.profile'),
  webDir: path.join(root, 'web'),
  playbookDir: path.join(root, 'server', 'playbook'),
  frontendUrl: env('FRONTEND_URL', 'https://localhost:8080'),
  inspectorUrl: env('INSPECTOR_URL', 'http://127.0.0.1:8083/mcp'),
  port: Number(env('HARNESS_PORT', '4377')),
  cdpPort: Number(env('CDP_PORT', '9222')),
  model: env('HARNESS_MODEL', 'claude-sonnet-5-5'),
  maxTurnsPerFeature: Number(env('MAX_TURNS_PER_FEATURE', '25')),
  maxRecoveries: 2,
};
```

- [ ] **Step 3: Write the failing test `server/test/inspector.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inspector, InspectorError } from '../src/inspector';

let server: http.Server;
function stub(reply: (body: any) => unknown): Promise<string> {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply(JSON.parse(data))));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
}
afterEach(() => server?.close());

describe('Inspector', () => {
  it('returns tool text', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: `called ${b.params.name}` }], isError: false } }));
    expect(await new Inspector(url).call('zcad_list_projects')).toBe('called zcad_list_projects');
  });
  it('throws on isError', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id,
      result: { content: [{ type: 'text', text: 'Project 1(main) is not active.' }], isError: true } }));
    await expect(new Inspector(url).call('zcad_get_object_graph', { projectId: 1 }))
      .rejects.toThrow('Project 1(main) is not active.');
  });
  it('throws on JSON-RPC error', async () => {
    const url = await stub((b) => ({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'bad' } }));
    await expect(new Inspector(url).call('x')).rejects.toBeInstanceOf(InspectorError);
  });
  it('throws InspectorError when server is down', async () => {
    await expect(new Inspector('http://127.0.0.1:1/mcp').call('x')).rejects.toBeInstanceOf(InspectorError);
  });
});
```

- [ ] **Step 4: Run it, expect FAIL** (`cd server && pnpm test`): module `../src/inspector` not found.

- [ ] **Step 5: Write `server/src/inspector.ts`**

```ts
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
```

- [ ] **Step 6: Run tests, expect PASS (4 tests).** Also run `pnpm typecheck`, expect no errors.

- [ ] **Step 7: Commit**
```bash
git add .env.example server && git commit -m "feat: server scaffold and inspector MCP client"
```

**Acceptance:** 4 inspector tests pass. `pnpm typecheck` is clean. `server/node_modules` is gitignored (root `.gitignore` has `node_modules/`).

### Task 2: Probe script, Ivy launcher, capture instructions

**Files:**
- Create: `server/scripts/probe.ts`, `start-ivy.bat`, `docs/task0-capture.md`
- Test: manual (needs a live Ivy). Step 3 does a dry check against the stopped inspector.

**Interfaces:**
- Consumes: `Inspector`, `config` (Task 1).
- Produces: `pnpm probe <label> [--project <id>]` writes `server/test/fixtures/inspector/<label>/`: `projects.json`, `graph-full.dot`, `graph-compact.dot`, `undo.json`, `pipeline.json`, `objects/<id>.json` (one per numeric node id found in the full DOT), `errors.json` (each failed call), `meta.json` (`{label, projectId, projectTag, capturedAt, nodeIdCount}`).

- [ ] **Step 1: Write `server/scripts/probe.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { Inspector } from '../src/inspector';
import { config } from '../src/config';

const [label, ...rest] = process.argv.slice(2);
if (!label || !/^[\w-]+$/.test(label)) {
  console.error('usage: pnpm probe <label> [--project <id>]   (label: letters, digits, - _)');
  process.exit(2);
}
const projArg = rest.indexOf('--project');
const out = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'inspector', label);
fs.mkdirSync(path.join(out, 'objects'), { recursive: true });
const ins = new Inspector(config.inspectorUrl);
const errors: Record<string, string> = {};
const save = (f: string, s: string) => fs.writeFileSync(path.join(out, f), s);

async function tryCall(file: string, tool: string, args: Record<string, unknown>) {
  try { const t = await ins.call(tool, args); save(file, t); return t; }
  catch (e) { errors[file] = (e as Error).message; return undefined; }
}

const projects = JSON.parse((await tryCall('projects.json', 'zcad_list_projects', {})) ?? '[]');
if (!projects.length) { console.error('No active Ivy project. Open a part in the browser first.', errors); process.exit(1); }
const chosen = projArg >= 0 ? projects.find((p: any) => p.projectId === Number(rest[projArg + 1])) : projects.at(-1);
if (!chosen) { console.error('Project not found. Active:', projects); process.exit(1); }
const pa = { projectId: chosen.projectId, projectTag: chosen.projectTag };

const dot = (await tryCall('graph-full.dot', 'zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: false })) ?? '';
await tryCall('graph-compact.dot', 'zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: true });
await tryCall('undo.json', 'zcad_get_undo_history', pa);
await tryCall('pipeline.json', 'zcad_get_pipeline_history', pa);

// ponytail: node-id regex is a guess at the DOT shape; Task 4 confirms or corrects it.
const ids = [...new Set([...dot.matchAll(/^\s*"?(\d+)"?\s*\[/gm)].map((m) => Number(m[1])))];
for (const id of ids) await tryCall(`objects/${id}.json`, 'zcad_get_object_json', { ...pa, objectId: id });

save('errors.json', JSON.stringify(errors, null, 2));
save('meta.json', JSON.stringify({ label, ...pa, capturedAt: new Date().toISOString(), nodeIdCount: ids.length }, null, 2));
console.log(`captured ${label}: project ${pa.projectId}, ${ids.length} objects, ${Object.keys(errors).length} errors -> ${out}`);
```

- [ ] **Step 2: Write `start-ivy.bat`** (repo root)

```bat
@echo off
setlocal
cd /d "%~dp0"
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if not defined IVY_BIN set "IVY_BIN=C:\zixel\ivyproject\build\built\bin"
if not defined MDA_DIR set "MDA_DIR=C:\zixel\mda"
if not exist "%IVY_BIN%\zcad_service.exe" (echo ERROR: %IVY_BIN%\zcad_service.exe not found & exit /b 1)
set "CONANRUN=%IVY_BIN%\..\..\conanrun.bat"
echo Starting zcad_service...
start "ivy-backend" cmd /k "(if exist "%CONANRUN%" call "%CONANRUN%") & cd /d "%IVY_BIN%" & zcad_service.exe"
echo Starting frontend (pnpm dev:pc)...
start "ivy-frontend" cmd /k "cd /d "%MDA_DIR%" & pnpm dev:pc"
echo Both started in separate windows. Frontend: %FRONTEND_URL%
endlocal
```

- [ ] **Step 3: Dry check.** With Ivy **not** running, run `cd server && pnpm probe dry`. Expected: it exits 1 with "No active Ivy project" and an `inspector unavailable` error. Then delete `server/test/fixtures/inspector/dry`.

- [ ] **Step 4: Write `docs/task0-capture.md`** with this content (the table is the procedure):

> # Task 0 capture: what the human does
>
> 1. Copy `.env.example` to `.env`. Run `start-ivy.bat` and wait until the frontend window prints its local URL. Put the real URL in `.env` as `FRONTEND_URL`.
> 2. Open that URL in your normal browser, log in, and create a **new empty part** document.
> 3. In `server/`, run each capture at the moment described:
>
> | # | Do this in Ivy first | Then run |
> |---|---|---|
> | 1 | Nothing (empty part open) | `pnpm probe 00-empty-part` |
> | 2 | Sketch on XY plane: one rectangle 100 × 60 mm, exit sketch | `pnpm probe 01-after-sketch` |
> | 3 | Extrude that sketch 8 mm | `pnpm probe 02-after-extrude` |
> | 4 | Edit the sketch: change 100 → 120 mm, exit (extrude updates) | `pnpm probe 03-after-edit-sketch` |
> | 5 | Delete the extrude feature from the feature tree | `pnpm probe 04-after-delete-extrude` |
> | 6 | Try an extrude that fails (depth 0, or nothing selected), and note what the UI shows | `pnpm probe 05-after-failed-op` |
> | 7 | Undo once (Ctrl+Z) | `pnpm probe 06-after-undo` |
> | 8 | Save the document (note the exact clicks and file name) | `pnpm probe 07-after-save` |
> | 9 | Close and reopen the saved document | `pnpm probe 08-after-reopen` |
>
> 4. In `docs/task0-notes.md`, write down: the frontend URL, the clicks for each step (toolbar names, dialog field labels), what the failed op showed, and any browser console errors (F12).
> 5. Commit: `git add server/test/fixtures docs/task0-notes.md` and then `git commit -m "test: Task 0 inspector captures"`.
> 6. Tell the agent "captures done". If a step is impossible in the UI, write "not reproducible" for it in the notes and continue.

- [ ] **Step 5: Commit**: `git add server/scripts start-ivy.bat docs/task0-capture.md`, then `git commit -m "feat: Task 0 probe script and capture instructions"`.

**Acceptance:** the dry check behaves as in Step 3.

### Task 3: [GATE] Human captures evidence

The human follows `docs/task0-capture.md`. The agent waits. **Done when** `server/test/fixtures/inspector/` has the label folders and `docs/task0-notes.md` is committed.

### Task 4: Record inspector fields (Opus analysis) + [GATE] review

**Files:** Create `docs/inspector-fields.md`.

This is done by the planning model (Opus), not Haiku. Every answer quotes evidence (fixture file plus line, or a JSON path). With no evidence, the answer is `UNSUPPORTED`.

- [ ] **Step 1:** Answer these, one section each:
  - **Q1 Enumeration:** does the DOT node id equal `zcad_get_object_json`'s `objectId`? Give the exact id regex. Does it miss objects (compare `objects/` and `errors.json`)?
  - **Q2 Class:** which JSON path names the class? List the values for the document, sketch, rectangle entities, extrude and body.
  - **Q3 Feature identity:** how to recognize a new sketch and a new extrude (`00` → `01` → `02`).
  - **Q4 Dependencies:** is extrude → sketch visible (DOT edge or JSON field)? Give the exact form.
  - **Q5 Compute status:** is there a success/error field? Compare `02` vs `05`.
  - **Q6 Dimensions:** are the extrude depth (8) and the sketch width (100 → 120) visible? Give the paths.
  - **Q7 Volatile objects:** between `01` → `02`, which **pre-existing** objects changed? Is each change legitimate (container/timestamp/counter)? List the field paths to strip before hashing.
  - **Q8 Restoration:** after stripping, does `04-after-delete-extrude` equal `01-after-sketch`? Does `06-after-undo` equal the state before the undone action? This decides whether delete is a safe recovery and whether undo is scoped. **Default: recovery stays disabled.** Hash equality is only enough if Q1 shows enumeration is complete (every object reachable, none missing from `objects/`) and Q7 shows hashes are stable for untouched objects. If either is unproven, `evidence.json` sets `supported.no_unexpected_modification = false`. The orchestrator then refuses recovery, and any failed feature means "restart required".
  - **Q9 Reopen:** do ids survive `07` → `08`? If not, which stable key should be compared instead?
  - **Q10 Bodies:** how to count solids.
- [ ] **Step 2:** End with a **Supported checks** table. Each row is a `CheckKind` (`feature_exists`, `depends_on`, `status_ok`, `body_count`, `dimension`, `no_unexpected_modification`, `reopen_matches`), then supported yes/no, and the evidence reference.
- [ ] **Step 3:** Commit.
- [ ] **Step 4 [GATE]:** The human reviews the doc. Nothing proceeds until they approve. Opus then writes Task 5's code into this plan.

### Task 5: Evidence file + inspector adapter (evidence-approved 2026-10-12)

**Files:** Create `server/src/evidence.json`, `server/src/adapter.ts`. Test: `server/test/adapter.test.ts`, which runs on the **real** Task 0 fixtures in `server/test/fixtures/inspector/`. Implement **after Tasks 6 and 9**.

Every rule here comes from `docs/inspector-fields.md`. The Q-numbers in the comments refer to it.

**Interfaces:**
- Consumes: `Inspector`, `InspectorError` (Task 1); `fingerprint`, `ModelSnapshot`, `SnapObject` (Task 6); `Evidence` (Task 9, `checks.ts`).
- Produces:
```ts
export type ProjectRef = { projectId: number; projectTag: string };
export type Graph = { nodes: Map<number, string /* class */>; dependsOn: Map<number, number[]> };
export function loadEvidence(): Evidence;
export function parseGraph(dot: string): Graph;
export function parseSnapshot(graph: Graph, objects: Map<number, string>, ev: Evidence): ModelSnapshot;  // pure
export function takeSnapshot(ins: Inspector, proj: ProjectRef, ev: Evidence): Promise<ModelSnapshot>; // all-or-nothing
export function findProject(ins: Inspector): Promise<ProjectRef>;
```
Rules:
- Nodes whose class is in `ev.excludeClasses` are never fetched (Q1: `ivy::Project` returns "", `ivy::PipelineContext` returns `Object not found.` without an error; `ivy::VisuGeomObject` is replaced on every recompute, Q7).
- Every other node must return JSON with string `uuid` and `class_name`. Anything else **throws `InspectorError`**, which fails closed.
- The snapshot contains only feature objects (JSON has `attr_first_`, Q2). Key = `uuid` (handles are reassigned on reopen, Q3/Q9). `hash = fingerprint([class_name, attr_first_._id, attr_first_._name])`, a structural fingerprint (Q7: whole-JSON hashes aren't stable).
- `deps` = keys of feature objects reachable from the node over DOT `DependsOn` edges, transitively, through any node (Q4: extrude → FeatGeomBRep → sketch).
- `statusOk` and `dims` are never set (Q5/Q6 unsupported).

- [ ] **Step 1: Write `server/src/evidence.json`**
```json
{
  "excludeClasses": ["ivy::Project", "ivy::PipelineContext", "ivy::VisuGeomObject"],
  "featureClass": { "sketch_rectangle": "ivy::FeatSketch", "extrude": "ivy::SolidExtrude" },
  "bodyClass": null,
  "volatileClasses": [],
  "supported": {
    "feature_exists": true,
    "depends_on": true,
    "existing_features_intact": true,
    "reopen_matches": true,
    "no_new_console_errors": true,
    "status_ok": false,
    "dimension": false,
    "body_count": false,
    "no_unexpected_modification": false
  }
}
```
- [ ] **Step 2: Failing test `server/test/adapter.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGraph, parseSnapshot, loadEvidence } from '../src/adapter';
import { diffSnapshots, sameAsBaseline } from '../src/snapshot';
import { InspectorError } from '../src/inspector';

const FIX = path.join(import.meta.dirname, 'fixtures', 'inspector');
const ev = loadEvidence();
function snap(label: string) {
  const dir = path.join(FIX, label);
  const graph = parseGraph(fs.readFileSync(path.join(dir, 'graph-full.dot'), 'utf8'));
  const objects = new Map<number, string>();
  for (const f of fs.readdirSync(path.join(dir, 'objects')))
    objects.set(Number(f.replace('.json', '')), fs.readFileSync(path.join(dir, 'objects', f), 'utf8'));
  return parseSnapshot(graph, objects, ev);
}
const ofClass = (s: ReturnType<typeof snap>, cls: string) => [...s.objects.values()].filter((o) => o.cls === cls);

describe('adapter on real Task 0 captures', () => {
  it('02-after-extrude has exactly one sketch and one extrude (Q3)', () => {
    const s = snap('02-after-extrude');
    expect(ofClass(s, 'ivy::FeatSketch')).toHaveLength(1);
    expect(ofClass(s, 'ivy::SolidExtrude')).toHaveLength(1);
  });
  it('extrude transitively depends on the sketch (Q4)', () => {
    const s = snap('02-after-extrude');
    const [sk] = ofClass(s, 'ivy::FeatSketch');
    const [ex] = ofClass(s, 'ivy::SolidExtrude');
    expect(ex.deps).toContain(sk.key);
  });
  it('01 -> 02: extrude added, no pre-existing feature removed or changed (Q7 fingerprint ignores _featOptions)', () => {
    const d = diffSnapshots(snap('01-after-sketch'), snap('02-after-extrude'), ev.volatileClasses);
    expect(d.added.map((o) => o.cls)).toContain('ivy::SolidExtrude');
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });
  it('reopen keeps every feature by uuid and fingerprint (Q9)', () => {
    expect(sameAsBaseline(snap('06-after-undo'), snap('07-after-reopen'), ev.volatileClasses)).toBe(true);
  });
  it('delete extrude restores the sketch-only structure (Q8; structure only, recovery stays disabled)', () => {
    expect(sameAsBaseline(snap('01-after-sketch'), snap('04-after-delete-extrude'), ev.volatileClasses)).toBe(true);
  });
  it('documents the Q6 blind spot: a 100->120 sketch edit is structurally invisible', () => {
    expect(sameAsBaseline(snap('02-after-extrude'), snap('03-after-edit-sketch'), ev.volatileClasses)).toBe(true);
  });
  it('unsupported fields stay undefined (Q5, Q6)', () => {
    for (const o of snap('02-after-extrude').objects.values()) {
      expect(o.statusOk).toBeUndefined();
      expect(o.dims).toBeUndefined();
    }
  });
  it('fails closed on a non-JSON reply for a model object (Q1)', () => {
    const graph = parseGraph('digraph G {\n  "7" [label="ivy::FeatSketch 7"];\n}');
    expect(() => parseSnapshot(graph, new Map([[7, 'Object not found.']]), ev)).toThrow(InspectorError);
    expect(() => parseSnapshot(graph, new Map(), ev)).toThrow(InspectorError);
  });
  it('skips excluded classes even when they reply "Object not found." (Q1)', () => {
    const graph = parseGraph('digraph G {\n0 [label="ivy::Project", shape=box];\n  "99" [label="ivy::PipelineContext 99"];\n}');
    expect(parseSnapshot(graph, new Map([[0, ''], [99, 'Object not found.']]), ev).objects.size).toBe(0);
  });
});
```
If the reopen test (Q9) or the delete test (Q8) fails, **stop and report it**. Don't adjust the test: it means the evidence analysis was wrong, and that is a human decision.
- [ ] **Step 3:** Run `pnpm test test/adapter.test.ts`. Expect FAIL (module missing).
- [ ] **Step 4: Implement `server/src/adapter.ts`**
```ts
import evidenceJson from './evidence.json';
import type { Evidence } from './checks';
import { Inspector, InspectorError } from './inspector';
import { fingerprint, type ModelSnapshot, type SnapObject } from './snapshot';

export type ProjectRef = { projectId: number; projectTag: string };
export type Graph = { nodes: Map<number, string>; dependsOn: Map<number, number[]> };

export function loadEvidence(): Evidence {
  return evidenceJson as Evidence;
}

/** Q1: node lines look like `  "539" [label="ivy::FeatSketch 539\n12 草图1", ...]` (root `0` is unquoted). */
export function parseGraph(dot: string): Graph {
  const nodes = new Map<number, string>();
  for (const m of dot.matchAll(/^\s*"?(\d+)"?\s*\[label="([^"\s]+)/gm)) nodes.set(Number(m[1]), m[2]);
  const dependsOn = new Map<number, number[]>();
  for (const m of dot.matchAll(/"(\d+)" -> "(\d+)" \[label="DependsOn"/g)) {
    const from = Number(m[1]);
    dependsOn.set(from, [...(dependsOn.get(from) ?? []), Number(m[2])]);
  }
  return { nodes, dependsOn };
}

export function parseSnapshot(graph: Graph, objects: Map<number, string>, ev: Evidence): ModelSnapshot {
  const features = new Map<number, SnapObject>();
  for (const [handle, cls] of graph.nodes) {
    if (ev.excludeClasses.includes(cls)) continue;
    const raw = objects.get(handle);
    if (raw === undefined) throw new InspectorError(`no object JSON for ${cls} #${handle}`);
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new InspectorError(`${cls} #${handle}: non-JSON reply: ${raw.slice(0, 80)}`); }
    if (typeof j?.uuid !== 'string' || typeof j?.class_name !== 'string')
      throw new InspectorError(`${cls} #${handle}: reply lacks uuid/class_name`);
    if (!j.attr_first_) continue; // containers and runtime plumbing are not model features (Q2)
    const a = j.attr_first_;
    features.set(handle, {
      key: j.uuid, handle, cls: j.class_name, featId: a._id, name: a._name,
      hash: fingerprint([j.class_name, a._id, a._name]),
    });
  }
  for (const [handle, obj] of features) {
    const seen = new Set<number>();
    const stack = [...(graph.dependsOn.get(handle) ?? [])];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      stack.push(...(graph.dependsOn.get(h) ?? []));
    }
    obj.deps = [...seen].filter((h) => features.has(h)).map((h) => features.get(h)!.key);
  }
  return { objects: new Map([...features.values()].map((o) => [o.key, o])) };
}

export async function takeSnapshot(ins: Inspector, proj: ProjectRef, ev: Evidence): Promise<ModelSnapshot> {
  const pa = { projectId: proj.projectId, projectTag: proj.projectTag };
  const graph = parseGraph(await ins.call('zcad_get_object_graph', { ...pa, rootEntityId: 0, compactMode: false }));
  const objects = new Map<number, string>();
  for (const [handle, cls] of graph.nodes) {
    if (!ev.excludeClasses.includes(cls)) objects.set(handle, await ins.call('zcad_get_object_json', { ...pa, objectId: handle }));
  }
  return parseSnapshot(graph, objects, ev);
}

export async function findProject(ins: Inspector): Promise<ProjectRef> {
  const text = await ins.call('zcad_list_projects');
  let list: unknown;
  try { list = JSON.parse(text); } catch { throw new InspectorError(`unexpected zcad_list_projects reply: ${text.slice(0, 200)}`); }
  if (!Array.isArray(list)) throw new InspectorError(`unexpected zcad_list_projects reply: ${text.slice(0, 200)}`);
  const p = list.at(-1);
  if (!p) throw new InspectorError('no active Ivy project');
  return { projectId: Number(p.projectId), projectTag: String(p.projectTag) };
}
```
- [ ] **Step 5:** Run the tests, expect 9 PASS. Run `pnpm typecheck`; `resolveJsonModule` is already on.
- [ ] **Step 6:** Commit: `feat: evidence-based inspector adapter (uuid keys, structural fingerprints)`.

**Acceptance:** all 9 tests pass on the real fixtures, without changing any expectation. Non-JSON or incomplete replies throw. Unsupported fields stay undefined.

---

# Milestone 2: Core logic (Tasks 6–10: pure, no live Ivy)

Tasks 6–10 don't depend on Task 0 values. Order: 6 → 9 → 5 → 7 → 8 → 10.

### Task 6: Snapshot types + diff (structural, uuid-keyed)

**Files:** Create `server/src/snapshot.ts`. Test: `server/test/snapshot.test.ts`.

**Interfaces — Produces:**
```ts
export type SnapObject = {
  key: string;                      // persistent uuid (handles change on reopen)
  handle: number;                   // inspector objectId, valid in this session only
  cls: string;
  featId?: number;                  // attr_first_._id
  name?: string;                    // attr_first_._name
  hash: string;                     // structural fingerprint
  deps?: string[];                  // keys this object depends on; undefined = unsupported
  statusOk?: boolean;               // undefined = unsupported
  dims?: Record<string, number>;    // undefined = unsupported
};
export type ModelSnapshot = { objects: Map<string, SnapObject> };
export type SnapDiff = { added: SnapObject[]; removed: SnapObject[]; modified: SnapObject[] };
export function fingerprint(parts: unknown[]): string;   // sha1 hex of JSON.stringify(parts)
export function diffSnapshots(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): SnapDiff;
export function sameAsBaseline(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): boolean;
```
Rules: `added` = keys only in `cur` (never filtered). `removed` = keys only in `base` whose class isn't volatile. `modified` = shared keys with a different `hash` whose class isn't volatile.

- [ ] **Step 1: Failing test `server/test/snapshot.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { diffSnapshots, sameAsBaseline, fingerprint, type ModelSnapshot, type SnapObject } from '../src/snapshot';

const snap = (...o: SnapObject[]): ModelSnapshot => ({ objects: new Map(o.map((x) => [x.key, x])) });
const o = (key: string, cls: string, hash: string): SnapObject => ({ key, handle: 0, cls, hash });

describe('fingerprint', () => {
  it('is stable for equal parts and differs otherwise', () => {
    expect(fingerprint(['ivy::FeatSketch', 12, '草图1'])).toBe(fingerprint(['ivy::FeatSketch', 12, '草图1']));
    expect(fingerprint(['ivy::FeatSketch', 12, '草图1'])).not.toBe(fingerprint(['ivy::FeatSketch', 12, '草图2']));
  });
});

describe('diffSnapshots', () => {
  const base = snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'));
  it('reports added objects', () => {
    const d = diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'), o('u-ex', 'Extrude', 'h3')), []);
    expect(d.added.map((x) => x.key)).toEqual(['u-ex']);
    expect(d.modified).toEqual([]); expect(d.removed).toEqual([]);
  });
  it('same key with a new handle is the same object (reopen)', () => {
    const moved = snap({ ...o('u-doc', 'Doc', 'h1'), handle: 900 }, { ...o('u-sk', 'Sketch', 'h2'), handle: 901 });
    expect(sameAsBaseline(base, moved, [])).toBe(true);
  });
  it('reports a structurally changed pre-existing object', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'CHANGED')), []).modified.map((x) => x.key)).toEqual(['u-sk']);
  });
  it('reports a removed pre-existing object', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'h1')), []).removed.map((x) => x.key)).toEqual(['u-sk']);
  });
  it('ignores volatile classes for modified/removed', () => {
    expect(diffSnapshots(base, snap(o('u-doc', 'Doc', 'CHANGED'), o('u-sk', 'Sketch', 'h2')), ['Doc']).modified).toEqual([]);
  });
  it('sameAsBaseline false when anything was added', () => {
    expect(sameAsBaseline(base, snap(o('u-doc', 'Doc', 'h1'), o('u-sk', 'Sketch', 'h2'), o('u-x', 'X', 'h')), [])).toBe(false);
  });
});
```
- [ ] **Step 2:** Run `pnpm test test/snapshot.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement `server/src/snapshot.ts`**
```ts
import { createHash } from 'node:crypto';

export type SnapObject = {
  key: string; handle: number; cls: string; featId?: number; name?: string; hash: string;
  deps?: string[]; statusOk?: boolean; dims?: Record<string, number>;
};
export type ModelSnapshot = { objects: Map<string, SnapObject> };
export type SnapDiff = { added: SnapObject[]; removed: SnapObject[]; modified: SnapObject[] };

export function fingerprint(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

export function diffSnapshots(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): SnapDiff {
  const vol = new Set(volatileClasses);
  const added = [...cur.objects.values()].filter((o) => !base.objects.has(o.key));
  const removed = [...base.objects.values()].filter((o) => !cur.objects.has(o.key) && !vol.has(o.cls));
  const modified = [...base.objects.values()].filter((o) => {
    const c = cur.objects.get(o.key);
    return c && c.hash !== o.hash && !vol.has(o.cls);
  });
  return { added, removed, modified };
}

export function sameAsBaseline(base: ModelSnapshot, cur: ModelSnapshot, volatileClasses: string[]): boolean {
  const d = diffSnapshots(base, cur, volatileClasses);
  return !d.added.length && !d.removed.length && !d.modified.length;
}
```
- [ ] **Step 4:** Run, expect 7 PASS.
- [ ] **Step 5:** Commit: `feat: uuid-keyed snapshot diff`.

**Acceptance:** a key with a new handle compares equal (reopen). A structural change and a removal are both reported.


### Task 7: Run store (events, atomic writes, interrupted detection)

**Files:** Create `server/src/store.ts`. Test: `server/test/store.test.ts`.

**Interfaces — Produces:**
```ts
export type Verdict = 'passed' | 'failed' | 'cancelled' | 'interrupted';
export type RunEvent = { t: string; type: string; [k: string]: unknown };
export class RunStore {
  readonly id: string; readonly dir: string;
  static create(runsDir: string, prompt: string): RunStore;   // id = YYYYMMDD-HHMMSS-mmm
  static open(runsDir: string, id: string): RunStore;
  append(type: string, data?: Record<string, unknown>): RunEvent;  // appendFileSync to events.jsonl
  writeAtomic(name: string, content: string): void;               // name.tmp then rename
  writeJson(name: string, value: unknown): void;
  readEvents(): RunEvent[];                                       // skips unparsable lines
  shotPath(name: string): string;                                 // <dir>/shots/<name>.png, creates dir
}
export function runVerdict(events: RunEvent[]): Verdict;   // last 'run_end'.verdict, else 'interrupted'
export function listRuns(runsDir: string): { id: string; prompt: string; verdict: Verdict }[];  // newest first
```
`create` writes the first event `run_start {prompt}`. Ids must match `/^[\w-]+$/`, and `open` throws on anything else (this guards against path traversal).

- [ ] **Step 1: Failing test `server/test/store.test.ts`**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { RunStore, runVerdict, listRuns } from '../src/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')); });

describe('RunStore', () => {
  it('appends events and reads them back', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('phase', { phase: 'designing' });
    expect(s.readEvents().map((e) => e.type)).toEqual(['run_start', 'phase']);
  });
  it('run with no run_end is interrupted (process killed)', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('phase', { phase: 'executing' });
    fs.appendFileSync(path.join(s.dir, 'events.jsonl'), '{"t":"x","type":"half');  // torn last line
    expect(runVerdict(s.readEvents())).toBe('interrupted');
  });
  it('verdict comes from run_end', () => {
    const s = RunStore.create(dir, 'plate');
    s.append('run_end', { verdict: 'cancelled' });
    expect(runVerdict(s.readEvents())).toBe('cancelled');
  });
  it('writeAtomic leaves no tmp file', () => {
    const s = RunStore.create(dir, 'p');
    s.writeAtomic('report.html', '<p>x</p>');
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(s.dir, 'report.html'), 'utf8')).toBe('<p>x</p>');
  });
  it('open rejects path traversal', () => {
    expect(() => RunStore.open(dir, '../etc')).toThrow();
  });
  it('listRuns newest first with verdicts', async () => {
    const a = RunStore.create(dir, 'first'); a.append('run_end', { verdict: 'failed' });
    await new Promise((r) => setTimeout(r, 5));
    RunStore.create(dir, 'second');
    expect(listRuns(dir).map((r) => [r.prompt, r.verdict])).toEqual([['second', 'interrupted'], ['first', 'failed']]);
  });
});
```
- [ ] **Step 2:** Run the tests, expect FAIL.
- [ ] **Step 3: Implement `server/src/store.ts`**
```ts
import fs from 'node:fs';
import path from 'node:path';

export type Verdict = 'passed' | 'failed' | 'cancelled' | 'interrupted';
export type RunEvent = { t: string; type: string; [k: string]: unknown };
const ID = /^[\w-]+$/;

export class RunStore {
  private constructor(readonly id: string, readonly dir: string) {}

  static create(runsDir: string, prompt: string): RunStore {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
    const s = new RunStore(id, path.join(runsDir, id));
    fs.mkdirSync(s.dir, { recursive: true });
    s.append('run_start', { prompt });
    return s;
  }
  static open(runsDir: string, id: string): RunStore {
    if (!ID.test(id)) throw new Error(`bad run id: ${id}`);
    const dir = path.join(runsDir, id);
    if (!fs.existsSync(dir)) throw new Error(`no such run: ${id}`);
    return new RunStore(id, dir);
  }
  append(type: string, data: Record<string, unknown> = {}): RunEvent {
    const ev = { t: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    return ev;
  }
  writeAtomic(name: string, content: string): void {
    const f = path.join(this.dir, name);
    fs.writeFileSync(f + '.tmp', content);
    fs.renameSync(f + '.tmp', f);
  }
  writeJson(name: string, value: unknown): void { this.writeAtomic(name, JSON.stringify(value, null, 2)); }
  readEvents(): RunEvent[] {
    const f = path.join(this.dir, 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  }
  shotPath(name: string): string {
    const d = path.join(this.dir, 'shots');
    fs.mkdirSync(d, { recursive: true });
    return path.join(d, `${name}.png`);
  }
}

export function runVerdict(events: RunEvent[]): Verdict {
  const end = events.findLast((e) => e.type === 'run_end');
  return (end?.verdict as Verdict) ?? 'interrupted';
}

export function listRuns(runsDir: string) {
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).filter((id) => ID.test(id)).sort().reverse().map((id) => {
    const ev = RunStore.open(runsDir, id).readEvents();
    return { id, prompt: String(ev[0]?.prompt ?? ''), verdict: runVerdict(ev) };
  });
}
```
- [ ] **Step 4:** Run the tests, expect 6 PASS.
- [ ] **Step 5:** Commit: `feat: run store with atomic writes and interrupted detection`.

**Acceptance:** a torn last line is tolerated. A missing `run_end` gives `interrupted`.

### Task 8: Console error baseline (requirement 2)

**Files:** Create `server/src/consolelog.ts`. Test: `server/test/consolelog.test.ts`.

**Interfaces — Produces:**
```ts
export type ConsoleEntry = { seq: number; t: string; text: string; sig: string };
export type ConsoleMark = { seq: number; seen: Set<string> };
export function signature(text: string): string;
export class ConsoleLog {
  add(text: string): ConsoleEntry;
  mark(): ConsoleMark;                          // call at feature start
  since(m: ConsoleMark): { fresh: ConsoleEntry[]; recurring: ConsoleEntry[] };
}
```
`signature`: lowercase. Drop the query string of URLs (`?…` up to whitespace). Replace `0x[0-9a-f]+`, uuids and digit runs with `#`. Collapse whitespace. An entry after the mark is `fresh` if its signature wasn't in `mark.seen`, and `recurring` otherwise.

- [ ] **Step 1: Failing test `server/test/consolelog.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { ConsoleLog, signature } from '../src/consolelog';

describe('signature', () => {
  it('normalizes ids, numbers, hex and query strings', () => {
    expect(signature('Failed id=123 at 0xABC https://x/a.js?v=99 '))
      .toBe(signature('failed id=456 at 0x1f https://x/a.js?v=1'));
  });
});

describe('ConsoleLog', () => {
  it('pre-existing error recurring during feature is "recurring", new one is "fresh"', () => {
    const log = new ConsoleLog();
    log.add('WebSocket reconnect attempt 1');
    const m = log.mark();
    log.add('WebSocket reconnect attempt 2');      // same signature as before the mark
    log.add('TypeError: cannot read extrude of undefined');
    const r = log.since(m);
    expect(r.recurring.map((e) => e.text)).toEqual(['WebSocket reconnect attempt 2']);
    expect(r.fresh.map((e) => e.text)).toEqual(['TypeError: cannot read extrude of undefined']);
  });
  it('nothing after mark → empty', () => {
    const log = new ConsoleLog(); log.add('x');
    expect(log.since(log.mark())).toEqual({ fresh: [], recurring: [] });
  });
});
```
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3: Implement `server/src/consolelog.ts`**
```ts
export type ConsoleEntry = { seq: number; t: string; text: string; sig: string };
export type ConsoleMark = { seq: number; seen: Set<string> };

export function signature(text: string): string {
  return text.toLowerCase()
    .replace(/\?\S*/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim();
}

export class ConsoleLog {
  private entries: ConsoleEntry[] = [];

  add(text: string): ConsoleEntry {
    const e = { seq: this.entries.length, t: new Date().toISOString(), text, sig: signature(text) };
    this.entries.push(e);
    return e;
  }
  mark(): ConsoleMark {
    return { seq: this.entries.length, seen: new Set(this.entries.map((e) => e.sig)) };
  }
  since(m: ConsoleMark) {
    const after = this.entries.slice(m.seq);
    return { fresh: after.filter((e) => !m.seen.has(e.sig)), recurring: after.filter((e) => m.seen.has(e.sig)) };
  }
}
```
- [ ] **Step 4:** Run, expect 3 PASS.
- [ ] **Step 5:** Commit: `feat: console error baseline classification`.

**Acceptance:** the recurring/fresh test passes. Only `fresh` errors will fail a feature (wired in Task 13).

### Task 9: Plan schema + check evaluation (requirement 3: unsupported never passes)

**Files:** Create `server/src/plan.ts`, `server/src/checks.ts`. Test: `server/test/plan.test.ts`, `server/test/checks.test.ts`.

**Interfaces — Produces:**
```ts
// plan.ts
export const FEATURE_TYPES = ['sketch_rectangle', 'extrude'] as const;   // grows only via promotion gate
export type FeatureType = (typeof FEATURE_TYPES)[number];
export const CHECK_KINDS = ['feature_exists', 'depends_on', 'status_ok', 'body_count', 'dimension',
  'no_unexpected_modification', 'existing_features_intact', 'no_new_console_errors', 'reopen_matches'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type Check = { kind: CheckKind; expect?: any };
export type PlanFeature = { id: string; type: FeatureType; dependsOn: string[]; params: Record<string, number | string>; checks: Check[] };
export type Plan = { product: string; units: 'mm'; parameters: Record<string, number>; features: PlanFeature[]; acceptance: Check[] };
export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[]; unsupported: boolean };
export function validatePlan(raw: unknown): PlanResult;

// checks.ts
export type Evidence = {
  excludeClasses: string[]; featureClass: Record<FeatureType, string>; bodyClass: string | null;
  volatileClasses: string[]; supported: Record<CheckKind, boolean>;
};
export type CheckStatus = 'pass' | 'fail' | 'unsupported' | 'skipped';
export type CheckResult = { kind: CheckKind; status: CheckStatus; detail: string };
export type FeatureCtx = {
  feature: PlanFeature; diff: SnapDiff; cur: ModelSnapshot; ev: Evidence;
  freshConsole: string[];                 // texts of fresh console errors in this feature window
  createdIds: Record<string, string>;     // earlier plan feature id -> its object key (uuid)
};
export const MANDATORY: CheckKind[] = ['feature_exists', 'existing_features_intact', 'no_new_console_errors'];
export function evaluateFeature(ctx: FeatureCtx): { results: CheckResult[]; passed: boolean; createdId?: string };
export function evaluateAcceptance(checks: Check[], cur: ModelSnapshot, ev: Evidence): CheckResult[];
export function reopenMatches(before: ModelSnapshot, after: ModelSnapshot, ev: Evidence): CheckResult;
```
(Task 5's `Evidence` comes from `checks.ts`, so `adapter.ts` imports it from there.)

Rules:
- `validatePlan` checks: schema; unique ids; `dependsOn` refers only to earlier ids; every `extrude` depends on a `sketch_rectangle`; `sketch_rectangle.params` = `{plane: 'XY'|'XZ'|'YZ', width>0, height>0}`; `extrude.params` = `{depth>0}`. An unknown `type` gives the error `operation "<type>" not supported in this version` and `unsupported: true`.
- `evaluateFeature` runs `MANDATORY` plus `feature.checks` (deduped by kind). If `ev.supported[kind]` is false, the result is `unsupported`. `reopen_matches` is always `skipped` here: the orchestrator evaluates it with `reopenMatches(before, after, ev)` (same keys and fingerprints after reopen, Q9). `existing_features_intact` = no baseline feature removed or structurally changed. It never implies parameters are unchanged (Q6), so it never enables recovery.
- **`passed` is true only if no result is `fail` AND `feature_exists` is `pass`.** If creation can't be proven, the feature can't pass.

- [ ] **Step 1: Failing test `server/test/plan.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { validatePlan } from '../src/plan';

const good = {
  product: 'mounting plate', units: 'mm', parameters: { w: 100, h: 60, t: 8 },
  features: [
    { id: 'f1', type: 'sketch_rectangle', dependsOn: [], params: { plane: 'XY', width: 100, height: 60 }, checks: [] },
    { id: 'f2', type: 'extrude', dependsOn: ['f1'], params: { depth: 8 }, checks: [{ kind: 'dimension', expect: { name: 'depth', value: 8 } }] },
  ],
  acceptance: [{ kind: 'body_count', expect: 1 }],
};
const clone = () => structuredClone(good) as any;

describe('validatePlan', () => {
  it('accepts a valid plate plan', () => { expect(validatePlan(good).ok).toBe(true); });
  it('rejects unsupported operation with unsupported flag', () => {
    const p = clone(); p.features.push({ id: 'f3', type: 'hole', dependsOn: ['f2'], params: {}, checks: [] });
    const r = validatePlan(p);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.unsupported).toBe(true); expect(r.errors.join()).toContain('operation "hole" not supported'); }
  });
  it('rejects forward dependency', () => {
    const p = clone(); p.features[0].dependsOn = ['f2'];
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects duplicate ids', () => {
    const p = clone(); p.features[1].id = 'f1';
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects extrude without sketch dependency', () => {
    const p = clone(); p.features[1].dependsOn = [];
    expect(validatePlan(p).ok).toBe(false);
  });
  it('rejects non-positive dimensions', () => {
    const p = clone(); p.features[1].params.depth = 0;
    expect(validatePlan(p).ok).toBe(false);
  });
});
```
- [ ] **Step 2: Failing test `server/test/checks.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { evaluateFeature, evaluateAcceptance, reopenMatches, type Evidence } from '../src/checks';
import type { ModelSnapshot, SnapObject } from '../src/snapshot';

const allSupported = { feature_exists: true, depends_on: true, status_ok: true, body_count: true, dimension: true,
  no_unexpected_modification: true, existing_features_intact: true, no_new_console_errors: true, reopen_matches: true };
const ev = (over: Partial<typeof allSupported> = {}): Evidence => ({
  excludeClasses: [], featureClass: { sketch_rectangle: 'Sketch', extrude: 'Extrude' }, bodyClass: 'Body',
  volatileClasses: [], supported: { ...allSupported, ...over },
});
const snap = (...o: SnapObject[]): ModelSnapshot => ({ objects: new Map(o.map((x) => [x.key, x])) });
const extrude: SnapObject = { key: 'u7', handle: 7, cls: 'Extrude', hash: 'h', deps: ['u5'], statusOk: true, dims: { depth: 8 } };
const feature = { id: 'f2', type: 'extrude' as const, dependsOn: ['f1'], params: { depth: 8 },
  checks: [{ kind: 'depends_on' as const }, { kind: 'status_ok' as const }, { kind: 'dimension' as const, expect: { name: 'depth', value: 8 } }] };
const ctx = (o: Partial<Parameters<typeof evaluateFeature>[0]> = {}) => ({
  feature, diff: { added: [extrude], removed: [], modified: [] }, cur: snap(extrude), ev: ev(),
  freshConsole: [], createdIds: { f1: 'u5' }, ...o,
});

describe('evaluateFeature', () => {
  it('passes when all evidence matches', () => {
    const r = evaluateFeature(ctx());
    expect(r.passed).toBe(true); expect(r.createdId).toBe('u7');
  });
  it('agent claims done but nothing was created -> fail', () => {
    const r = evaluateFeature(ctx({ diff: { added: [], removed: [], modified: [] } }));
    expect(r.passed).toBe(false);
    expect(r.results.find((x) => x.kind === 'feature_exists')!.status).toBe('fail');
  });
  it('old object of same class does not satisfy check (only diff.added counts)', () => {
    const r = evaluateFeature(ctx({ diff: { added: [], removed: [], modified: [] }, cur: snap(extrude) }));
    expect(r.passed).toBe(false);
  });
  it('modified pre-existing object -> fail', () => {
    const r = evaluateFeature(ctx({ diff: { added: [extrude], removed: [], modified: [{ key: 'u5', handle: 5, cls: 'Sketch', hash: 'x' }] } }));
    expect(r.passed).toBe(false);
  });
  it('fresh console error -> fail', () => {
    expect(evaluateFeature(ctx({ freshConsole: ['TypeError: boom'] })).passed).toBe(false);
  });
  it('unsupported fields are reported unsupported, never pass', () => {
    const r = evaluateFeature(ctx({ ev: ev({ status_ok: false, dimension: false, depends_on: false }) }));
    const st = Object.fromEntries(r.results.map((x) => [x.kind, x.status]));
    expect(st).toMatchObject({ status_ok: 'unsupported', dimension: 'unsupported', depends_on: 'unsupported' });
    expect(r.passed).toBe(true);   // creation still proven by feature_exists
  });
  it('feature_exists unsupported -> cannot pass', () => {
    expect(evaluateFeature(ctx({ ev: ev({ feature_exists: false }) })).passed).toBe(false);
  });
  it('wrong dimension -> fail', () => {
    const bad = { ...extrude, dims: { depth: 5 } };
    expect(evaluateFeature(ctx({ diff: { added: [bad], removed: [], modified: [] }, cur: snap(bad) })).passed).toBe(false);
  });
});

describe('evaluateAcceptance', () => {
  it('body_count pass/fail/unsupported', () => {
    const cur = snap({ key: 'u1', handle: 1, cls: 'Body', hash: 'b' });
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 1 }], cur, ev())[0].status).toBe('pass');
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 2 }], cur, ev())[0].status).toBe('fail');
    expect(evaluateAcceptance([{ kind: 'body_count', expect: 1 }], cur, ev({ body_count: false }))[0].status).toBe('unsupported');
  });
});

describe('reopenMatches', () => {
  const a = snap({ key: 'u1', handle: 1, cls: 'Sketch', hash: 's' }, { key: 'u2', handle: 2, cls: 'Extrude', hash: 'e' });
  it('passes when the same keys and fingerprints come back under new handles', () => {
    const b = snap({ key: 'u1', handle: 901, cls: 'Sketch', hash: 's' }, { key: 'u2', handle: 902, cls: 'Extrude', hash: 'e' });
    expect(reopenMatches(a, b, ev()).status).toBe('pass');
  });
  it('fails when a feature is missing after reopen', () => {
    expect(reopenMatches(a, snap({ key: 'u1', handle: 1, cls: 'Sketch', hash: 's' }), ev()).status).toBe('fail');
  });
  it('unsupported when evidence says so', () => {
    expect(reopenMatches(a, a, ev({ reopen_matches: false })).status).toBe('unsupported');
  });
});
```
- [ ] **Step 3:** Run both, expect FAIL.
- [ ] **Step 4: Implement `server/src/plan.ts`**
```ts
import { z } from 'zod';

export const FEATURE_TYPES = ['sketch_rectangle', 'extrude'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];
export const CHECK_KINDS = ['feature_exists', 'depends_on', 'status_ok', 'body_count', 'dimension',
  'no_unexpected_modification', 'existing_features_intact', 'no_new_console_errors', 'reopen_matches'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type Check = { kind: CheckKind; expect?: any };
export type PlanFeature = { id: string; type: FeatureType; dependsOn: string[]; params: Record<string, number | string>; checks: Check[] };
export type Plan = { product: string; units: 'mm'; parameters: Record<string, number>; features: PlanFeature[]; acceptance: Check[] };
export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[]; unsupported: boolean };

const CheckZ = z.object({ kind: z.enum(CHECK_KINDS), expect: z.any().optional() });
const PlanZ = z.object({
  product: z.string().min(1),
  units: z.literal('mm'),
  parameters: z.record(z.string(), z.number()),
  features: z.array(z.object({
    id: z.string().regex(/^f\d+$/),
    type: z.string(),
    dependsOn: z.array(z.string()),
    params: z.record(z.string(), z.union([z.number(), z.string()])),
    checks: z.array(CheckZ),
  })).min(1),
  acceptance: z.array(CheckZ),
});
const pos = z.number().positive();
const ParamsZ: Record<FeatureType, z.ZodTypeAny> = {
  sketch_rectangle: z.object({ plane: z.enum(['XY', 'XZ', 'YZ']), width: pos, height: pos }),
  extrude: z.object({ depth: pos }),
};

export function validatePlan(raw: unknown): PlanResult {
  const parsed = PlanZ.safeParse(raw);
  if (!parsed.success) return { ok: false, unsupported: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const p = parsed.data;
  const errors: string[] = [];
  let unsupported = false;
  const seen = new Map<string, string>();
  for (const f of p.features) {
    if (seen.has(f.id)) errors.push(`duplicate feature id ${f.id}`);
    if (!(FEATURE_TYPES as readonly string[]).includes(f.type)) {
      unsupported = true;
      errors.push(`operation "${f.type}" not supported in this version (supported: ${FEATURE_TYPES.join(', ')})`);
    } else {
      const pr = ParamsZ[f.type as FeatureType].safeParse(f.params);
      if (!pr.success) errors.push(`${f.id} params: ${pr.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    for (const d of f.dependsOn) if (!seen.has(d)) errors.push(`${f.id} depends on ${d}, which is not an earlier feature`);
    if (f.type === 'extrude' && !f.dependsOn.some((d) => seen.get(d) === 'sketch_rectangle'))
      errors.push(`${f.id} extrude must depend on a sketch_rectangle`);
    seen.set(f.id, f.type);
  }
  return errors.length ? { ok: false, errors, unsupported } : { ok: true, plan: p as Plan };
}
```
- [ ] **Step 5: Implement `server/src/checks.ts`**
```ts
import type { Check, CheckKind, FeatureType, PlanFeature } from './plan';
import { diffSnapshots, type ModelSnapshot, type SnapDiff, type SnapObject } from './snapshot';

export type Evidence = {
  excludeClasses: string[]; featureClass: Record<FeatureType, string>; bodyClass: string | null;
  volatileClasses: string[]; supported: Record<CheckKind, boolean>;
};
export type CheckStatus = 'pass' | 'fail' | 'unsupported' | 'skipped';
export type CheckResult = { kind: CheckKind; status: CheckStatus; detail: string };
export type FeatureCtx = {
  feature: PlanFeature; diff: SnapDiff; cur: ModelSnapshot; ev: Evidence;
  freshConsole: string[]; createdIds: Record<string, string>;
};
export const MANDATORY: CheckKind[] = ['feature_exists', 'existing_features_intact', 'no_new_console_errors'];

const r = (kind: CheckKind, status: CheckStatus, detail: string): CheckResult => ({ kind, status, detail });

function dimension(c: Check, obj: SnapObject | undefined): CheckResult {
  const { name, value, tol = 0.01 } = c.expect ?? {};
  const v = obj?.dims?.[name];
  if (v === undefined) return r('dimension', 'unsupported', `dimension "${name}" not exposed`);
  return Math.abs(v - value) <= tol ? r('dimension', 'pass', `${name}=${v}`) : r('dimension', 'fail', `${name}=${v}, expected ${value}`);
}

export function evaluateFeature(ctx: FeatureCtx): { results: CheckResult[]; passed: boolean; createdId?: number } {
  const { feature, diff, ev } = ctx;
  const cls = ev.featureClass[feature.type];
  const created = diff.added.find((o) => o.cls === cls);
  const kinds = [...new Map([...MANDATORY.map((k) => [k, { kind: k }] as const), ...feature.checks.map((c) => [c.kind, c] as const)]).values()];

  const results = kinds.map((c): CheckResult => {
    if (!ev.supported[c.kind]) return r(c.kind, 'unsupported', 'not exposed by inspector (Task 0 evidence)');
    switch (c.kind) {
      case 'feature_exists':
        return created ? r(c.kind, 'pass', `new ${cls} #${created.handle}`) : r(c.kind, 'fail', `no new ${cls} object appeared`);
      case 'existing_features_intact': {
        const bad = [...diff.modified, ...diff.removed];
        return bad.length ? r(c.kind, 'fail', `existing objects changed: ${bad.map((o) => `${o.cls} #${o.handle}`).join(', ')}`) : r(c.kind, 'pass', 'none');
      }
      case 'no_new_console_errors':
        return ctx.freshConsole.length ? r(c.kind, 'fail', ctx.freshConsole.join(' | ')) : r(c.kind, 'pass', 'none');
      case 'depends_on': {
        if (!created?.deps) return r(c.kind, 'unsupported', 'dependencies not exposed');
        const want = feature.dependsOn.map((d) => ctx.createdIds[d]);
        return want.every((id) => created.deps!.includes(id)) ? r(c.kind, 'pass', `deps ${want}`) : r(c.kind, 'fail', `deps ${created.deps}, expected ${want}`);
      }
      case 'status_ok':
        if (created?.statusOk === undefined) return r(c.kind, 'unsupported', 'status not exposed');
        return created.statusOk ? r(c.kind, 'pass', 'ok') : r(c.kind, 'fail', 'feature reports error');
      case 'dimension':
        return dimension(c, created);
      default:
        return r(c.kind, 'skipped', 'evaluated at model level');
    }
  });
  const exists = results.find((x) => x.kind === 'feature_exists')!;
  return { results, passed: exists.status === 'pass' && !results.some((x) => x.status === 'fail'), createdId: created?.key };
}

export function evaluateAcceptance(checks: Check[], cur: ModelSnapshot, ev: Evidence): CheckResult[] {
  return checks.map((c) => {
    if (!ev.supported[c.kind]) return r(c.kind, 'unsupported', 'not exposed by inspector (Task 0 evidence)');
    if (c.kind === 'body_count') {
      if (!ev.bodyClass) return r(c.kind, 'unsupported', 'no body class');
      const n = [...cur.objects.values()].filter((o) => o.cls === ev.bodyClass).length;
      return n === c.expect ? r(c.kind, 'pass', `${n} bodies`) : r(c.kind, 'fail', `${n} bodies, expected ${c.expect}`);
    }
    return r(c.kind, 'skipped', 'not a model-level check');
  });
}

export function reopenMatches(before: ModelSnapshot, after: ModelSnapshot, ev: Evidence): CheckResult {
  if (!ev.supported.reopen_matches) return r('reopen_matches', 'unsupported', 'not exposed by inspector (Task 0 evidence)');
  const d = diffSnapshots(before, after, ev.volatileClasses);
  return d.added.length || d.removed.length || d.modified.length
    ? r('reopen_matches', 'fail', `after reopen: +${d.added.length} -${d.removed.length} ~${d.modified.length} features`)
    : r('reopen_matches', 'pass', `${after.objects.size} features persisted`);
}
```
- [ ] **Step 6:** Run, expect PASS (6 plan + 12 checks).
- [ ] **Step 7:** Commit: `feat: plan validation and evidence-based checks`.

**Acceptance:** a test proves that `unsupported` never makes a feature pass on its own, and that a feature can't pass without `feature_exists` = `pass`.

### Task 10: Planner (prompt → validated Plan)

**Files:** Create `server/src/planner.ts`, `server/src/llm.ts`. Test: `server/test/planner.test.ts`.

**Interfaces:**
- Consumes: `validatePlan`, `PlanResult`, `FEATURE_TYPES` (Task 9). `config` (Task 1).
- Produces:
  - `llm.ts`: `export type AskText = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;` and `export const askText: AskText`, a no-tools Agent SDK call.
  - `planner.ts`: `export async function makePlan(userPrompt: string, ask: AskText, signal?: AbortSignal): Promise<PlanResult & { attempts: number }>` and `export const PLANNER_SYSTEM: string`.
- Rules: at most 2 calls. If attempt 1 fails with `unsupported: true`, there's **no** re-ask (the re-ask would just drop the feature). For any other failure, re-ask once with the error list appended. Invalid JSON counts as a validation error.

- [ ] **Step 1: Failing test `server/test/planner.test.ts`**
```ts
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
```
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3: Implement `server/src/llm.ts`**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';

export type AskText = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export const askText: AskText = async (system, prompt, signal) => {
  const abortController = new AbortController();
  signal?.addEventListener('abort', () => abortController.abort());
  let text = '';
  for await (const m of query({
    prompt,
    options: { model: config.model, systemPrompt: system, tools: [], maxTurns: 1, settingSources: [], abortController },
  })) {
    if (m.type === 'result') {
      if ('result' in m && typeof m.result === 'string') text = m.result;
      else throw new Error(`planner query failed: ${JSON.stringify(m).slice(0, 300)}`);
    }
  }
  return text;
};
```
- [ ] **Step 4: Implement `server/src/planner.ts`**
```ts
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

Check kinds: ${CHECK_KINDS.join(', ')}. Useful: {"kind":"dimension","expect":{"name":"depth","value":8}},
acceptance {"kind":"body_count","expect":1}.

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
```
- [ ] **Step 5:** Run, expect 4 PASS. Run `pnpm typecheck`. If `m.result` doesn't typecheck, read the `SDKResultMessage` type in `node_modules/@anthropic-ai/claude-agent-sdk` and narrow on its success subtype. Keep the same behavior.
- [ ] **Step 6:** Commit: `feat: planner with validated plan and single re-ask`.

**Acceptance:** an unsupported operation fails at design with no re-ask and no browser use. The tests never call the real API.

---

# Milestone 3: Browser + agent (Tasks 11–12)

### Task 11: Harness-owned browser + login script

**Files:** Create `server/src/browser.ts`, `server/scripts/login.ts`. Test: manual smoke (Step 3). The console logic is already tested in Task 8.

**Interfaces:**
- Consumes: `config` (Task 1), `ConsoleLog` (Task 8).
- Produces:
```ts
export class ProfileLockedError extends Error {}
export class HarnessBrowser {
  readonly console: ConsoleLog;
  readonly cdpEndpoint: string;                       // http://127.0.0.1:<cdpPort>
  static launch(): Promise<HarnessBrowser>;           // throws ProfileLockedError if .profile in use
  open(url: string): Promise<void>;
  screenshot(file: string): Promise<void>;            // active (last) page
  close(): Promise<void>;
  waitForClose(): Promise<void>;
}
```

- [ ] **Step 1: Implement `server/src/browser.ts`**
```ts
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from './config';
import { ConsoleLog } from './consolelog';

export class ProfileLockedError extends Error {}

export class HarnessBrowser {
  readonly console = new ConsoleLog();
  readonly cdpEndpoint = `http://127.0.0.1:${config.cdpPort}`;
  private constructor(private ctx: BrowserContext) {}

  static async launch(): Promise<HarnessBrowser> {
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(config.profileDir, {
        headless: false, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 },
        args: [`--remote-debugging-port=${config.cdpPort}`],
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/ProcessSingleton|lock|already in use/i.test(msg)) throw new ProfileLockedError('Browser profile is in use: close the login browser first.');
      throw e;
    }
    const b = new HarnessBrowser(ctx);
    for (const p of ctx.pages()) b.hook(p);
    ctx.on('page', (p) => b.hook(p));
    return b;
  }
  async open(url: string) {
    const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  async screenshot(file: string) {
    await this.ctx.pages().at(-1)?.screenshot({ path: file });
  }
  async close() { await this.ctx.close(); }
  waitForClose(): Promise<void> { return new Promise((r) => this.ctx.on('close', () => r())); }

  private hook(p: Page) {
    p.on('console', (m) => { if (m.type() === 'error') this.console.add(m.text()); });
    p.on('pageerror', (e) => this.console.add(`pageerror: ${e.message}`));
  }
}
```
- [ ] **Step 2: Implement `server/scripts/login.ts`**
```ts
import { HarnessBrowser } from '../src/browser';
import { config } from '../src/config';

const b = await HarnessBrowser.launch();
await b.open(config.frontendUrl);
console.log('Log in to Zixel in the opened browser, then close the browser window to save the session.');
await b.waitForClose();
```
Install the browser once: `cd server && pnpm exec playwright install chromium`.
- [ ] **Step 3: Manual smoke.** With Ivy running, run `cd server && pnpm exec tsx scripts/login.ts`, log in, and close the window. Run it again: you should still be logged in. While it's open, run it a second time in another terminal: you should get `ProfileLockedError`.
- [ ] **Step 4:** Commit: `feat: harness-owned persistent browser and login script`.

**Acceptance:** the login persists across launches. A second concurrent launch fails with the "close the login browser first" message.

### Task 12: Executor (per-feature agent) + tool gate + playbook

> **REVISION REQUIRED before execution (Task 0 evidence, 2026-10-12):** Ivy autosaves and has no manual save. Replace the `save` mode/step with a `reopen` step (close + reopen the document, then `reopenMatches(before, after, ev)` from Task 9). Object keys are uuid strings (`SnapObject.key`/`handle`, `createdIds: Record<string,string>`). With `supported.no_unexpected_modification = false` recovery always stops with `restart required`; add a test for that path. Opus revises this task after Tasks 5–10 land.


**Files:** Create `server/src/executor.ts`, `server/playbook/{common,new_document,sketch_rectangle,extrude,save,recovery}.md`. Test: `server/test/executor.test.ts`.

The agent does **not** get the inspector MCP. The harness does all verification. This is a deliberate narrowing of spec §8.

**Interfaces:**
- Consumes: `Plan`, `PlanFeature`, `FeatureType` (Task 9); `config` (Task 1).
- Produces:
```ts
export type GateDecision = { allow: true } | { allow: false; reason: string };
export function toolGate(frontendUrl: string): (name: string, input: Record<string, unknown>) => GateDecision;
export type TaskMode = 'new_document' | 'build' | 'recover' | 'save';
export type FeatureTask = { plan: Plan; feature: PlanFeature; attempt: number; diagnostics?: string; mode: TaskMode };
export function loadPlaybook(task: FeatureTask): string;   // common.md + one of new_document|<feature.type>|recovery|save
export function buildPrompt(task: FeatureTask, playbook: string): string;
export type ExecResult = { reportedDone: boolean; summary: string };
export type AgentEvent = { kind: 'tool'; name: string } | { kind: 'text'; text: string } | { kind: 'denied'; name: string; reason: string };
export type RunAgent = (task: FeatureTask, cdpEndpoint: string, signal: AbortSignal, onEvent: (e: AgentEvent) => void) => Promise<ExecResult>;
export const runAgent: RunAgent;
```
Gate rules: allow only names starting with `mcp__playwright__` or exactly `mcp__harness__report_feature_done`. Deny the playwright tools `browser_evaluate`, `browser_run_code`, `browser_close`, `browser_install`, `browser_file_upload`, `browser_tabs`. Deny `browser_navigate` when the URL origin differs from `frontendUrl`'s origin. Deny everything else (`Bash`, `Read`, …).

- [ ] **Step 1: Failing test `server/test/executor.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { toolGate, buildPrompt, loadPlaybook, type FeatureTask } from '../src/executor';

const gate = toolGate('https://localhost:8080');
const plan = { product: 'plate', units: 'mm' as const, parameters: {}, acceptance: [],
  features: [{ id: 'f1', type: 'sketch_rectangle' as const, dependsOn: [], params: { plane: 'XY', width: 100, height: 60 }, checks: [] }] };
const task: FeatureTask = { plan, feature: plan.features[0], attempt: 1, mode: 'build' };

describe('toolGate', () => {
  it('allows browser tools and report_feature_done', () => {
    expect(gate('mcp__playwright__browser_click', {}).allow).toBe(true);
    expect(gate('mcp__harness__report_feature_done', {}).allow).toBe(true);
  });
  it('denies built-ins and dangerous browser tools', () => {
    for (const n of ['Bash', 'Write', 'Read', 'WebFetch', 'mcp__playwright__browser_evaluate',
      'mcp__playwright__browser_run_code', 'mcp__playwright__browser_close', 'mcp__playwright__browser_tabs', 'mcp__other__x'])
      expect(gate(n, {}).allow, n).toBe(false);
  });
  it('restricts navigation to the frontend origin', () => {
    expect(gate('mcp__playwright__browser_navigate', { url: 'https://localhost:8080/p/123' }).allow).toBe(true);
    expect(gate('mcp__playwright__browser_navigate', { url: 'https://evil.example/' }).allow).toBe(false);
    expect(gate('mcp__playwright__browser_navigate', { url: 'not a url' }).allow).toBe(false);
  });
});

describe('prompt building', () => {
  it('includes feature params and playbook; no diagnostics on first attempt', () => {
    const p = buildPrompt(task, loadPlaybook(task));
    expect(p).toContain('sketch_rectangle'); expect(p).toContain('"width":100');
    expect(p).not.toContain('Previous attempt');
  });
  it('recover mode includes diagnostics and recovery playbook', () => {
    const t: FeatureTask = { ...task, attempt: 2, mode: 'recover', diagnostics: 'no new Sketch object appeared; delete Extrude#9' };
    const pb = loadPlaybook(t);
    expect(pb).toContain('# Recovery');
    expect(buildPrompt(t, pb)).toContain('delete Extrude#9');
  });
});
```
- [ ] **Step 2: Write the playbook files.** This is done by **Opus** from `docs/task0-notes.md`, since it needs the real UI labels. Each file uses exactly this structure: an `# <Title>` heading, then `## Goal`, `## Steps` (numbered, exact toolbar/menu/dialog labels as written in the notes, and numeric values typed into fields rather than drawn), `## Done when` (what the UI visibly shows), and `## Pitfalls`. The files:
  - `common.md`: the editor layout, how to find the feature tree, how to cancel a dialog (Esc / Cancel), "never save unless told", "never close the tab".
  - `sketch_rectangle.md`, `extrude.md`, `save.md`: from capture steps 2, 3 and 8.
  - `new_document.md`: from capture step 1 (how to create a new empty part).
  - `recovery.md` must start with `# Recovery`. It covers: delete **only** the objects listed in the diagnostics, through the feature tree's right-click delete; never use Ctrl+Z unless `docs/inspector-fields.md` Q8 says undo is scoped; **do not rebuild** (the harness verifies the cleanup, then starts a fresh build attempt).
- [ ] **Step 3: Implement `server/src/executor.ts`**
```ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';
import type { Plan, PlanFeature } from './plan';

export type GateDecision = { allow: true } | { allow: false; reason: string };
const DENY = new Set(['browser_evaluate', 'browser_run_code', 'browser_close', 'browser_install', 'browser_file_upload', 'browser_tabs']);

export function toolGate(frontendUrl: string) {
  const origin = new URL(frontendUrl).origin;
  return (name: string, input: Record<string, unknown>): GateDecision => {
    if (name === 'mcp__harness__report_feature_done') return { allow: true };
    if (!name.startsWith('mcp__playwright__')) return { allow: false, reason: `tool ${name} is not available` };
    const t = name.slice('mcp__playwright__'.length);
    if (DENY.has(t)) return { allow: false, reason: `${t} is disabled in this harness` };
    if (t === 'browser_navigate') {
      try { if (new URL(String(input.url)).origin !== origin) return { allow: false, reason: `navigation outside ${origin}` }; }
      catch { return { allow: false, reason: 'invalid url' }; }
    }
    return { allow: true };
  };
}

export type TaskMode = 'new_document' | 'build' | 'recover' | 'save';
export type FeatureTask = { plan: Plan; feature: PlanFeature; attempt: number; diagnostics?: string; mode: TaskMode };

export function loadPlaybook(task: FeatureTask): string {
  const read = (n: string) => fs.readFileSync(path.join(config.playbookDir, `${n}.md`), 'utf8');
  const specific = { new_document: 'new_document', build: task.feature.type, recover: 'recovery', save: 'save' }[task.mode];
  return [read('common'), read(specific)].join('\n\n');
}

export function buildPrompt(task: FeatureTask, playbook: string): string {
  const feat = JSON.stringify({ id: task.feature.id, type: task.feature.type, params: task.feature.params });
  const what = {
    new_document: 'Create a new, empty part document and leave it open in the editor. Do not add any features.',
    build: `Build exactly this one feature and nothing else:\n${feat}`,
    recover: `Clean up after a failed attempt at ${feat}. Delete exactly the objects listed below and nothing else. Do NOT rebuild the feature.`,
    save: 'Save the current document. Do not change the model.',
  }[task.mode];
  return [
    `Product: ${task.plan.product} (units: mm). Attempt ${task.attempt}.`,
    what,
    task.diagnostics ? `Previous attempt failed verification:\n${task.diagnostics}` : '',
    `Ivy UI playbook:\n${playbook}`,
    'When you have finished trying (success or not), call report_feature_done once with a short factual summary of what the UI shows.',
  ].filter(Boolean).join('\n\n');
}

const EXECUTOR_SYSTEM = `You operate the Ivy web CAD application in an already-open, logged-in browser tab using browser tools.
Do only the single task given. Read the UI with browser_snapshot and act by element refs; use coordinate mouse tools only for the 3D/sketch canvas.
Prefer typing exact numeric values into dialog fields over drawing by mouse.
Never save unless the task says so, never close or switch tabs, never navigate away, never modify or delete existing features unless the task is a recovery that lists them.
Report honestly: describe what the UI shows, do not claim success you did not observe.`;

export type ExecResult = { reportedDone: boolean; summary: string };
export type AgentEvent = { kind: 'tool'; name: string } | { kind: 'text'; text: string } | { kind: 'denied'; name: string; reason: string };
export type RunAgent = (task: FeatureTask, cdpEndpoint: string, signal: AbortSignal, onEvent: (e: AgentEvent) => void) => Promise<ExecResult>;

const PLAYWRIGHT_CLI = path.join(config.root, 'server', 'node_modules', '@playwright', 'mcp', 'cli.js');

export const runAgent: RunAgent = async (task, cdpEndpoint, signal, onEvent) => {
  const done = { called: false, summary: '' };
  const harness = createSdkMcpServer({
    name: 'harness',
    tools: [tool('report_feature_done', 'Call exactly once when you have finished attempting the task, whether or not it worked.',
      { summary: z.string() },
      async ({ summary }) => { done.called = true; done.summary = summary; return { content: [{ type: 'text', text: 'recorded' }] }; })],
  });
  const gate = toolGate(config.frontendUrl);
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort());

  for await (const m of query({
    prompt: buildPrompt(task, loadPlaybook(task)),
    options: {
      model: config.model,
      systemPrompt: EXECUTOR_SYSTEM,
      tools: [],
      settingSources: [],
      maxTurns: config.maxTurnsPerFeature,
      abortController,
      mcpServers: {
        playwright: { command: process.execPath, args: [PLAYWRIGHT_CLI, '--cdp-endpoint', cdpEndpoint, '--caps=vision'] },
        harness,
      },
      canUseTool: async (name: string, input: Record<string, unknown>) => {
        const d = gate(name, input);
        if (d.allow) return { behavior: 'allow' as const, updatedInput: input };
        onEvent({ kind: 'denied', name, reason: d.reason });
        return { behavior: 'deny' as const, message: d.reason };
      },
    },
  })) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') onEvent({ kind: 'tool', name: b.name });
        else if (b.type === 'text' && b.text.trim()) onEvent({ kind: 'text', text: b.text.slice(0, 500) });
      }
    }
  }
  return { reportedDone: done.called, summary: done.summary };
};
```
- [ ] **Step 4:** Run the tests, expect 5 PASS. Run `pnpm typecheck`. If `canUseTool`'s signature differs in the installed SDK (for example a third `options` argument), adapt the parameter list and keep the behavior. Check that `PLAYWRIGHT_CLI` exists: `node server/node_modules/@playwright/mcp/cli.js --help` must print usage. If the file name differs, use the `bin` entry from that package's `package.json`.
- [ ] **Step 5: Live smoke (human present, Ivy running, logged-in profile):** run a scratch script `server/scripts/smoke-agent.ts` (not committed) that launches `HarnessBrowser`, opens `config.frontendUrl`, creates a new part by hand, then calls `runAgent` for the `sketch_rectangle` task above and prints the events. Expected: browser tool calls appear, the sketch appears in the UI, and `reportedDone` is true. Delete the scratch script afterwards.
- [ ] **Step 6:** Commit: `feat: per-feature executor with tool gate and Ivy playbook`.

**Acceptance:** gate tests pass, typecheck is clean, and the live smoke draws a rectangle sketch.

---

# Milestone 4: Orchestration, reporting, UI, launchers (Tasks 13–18)

### Task 13: Orchestrator (state machine, safe recovery, pause/cancel/retry)

> **REVISION REQUIRED before execution (Task 0 evidence, 2026-10-12):** Ivy autosaves and has no manual save. Replace the `save` mode/step with a `reopen` step (close + reopen the document, then `reopenMatches(before, after, ev)` from Task 9). Object keys are uuid strings (`SnapObject.key`/`handle`, `createdIds: Record<string,string>`). With `supported.no_unexpected_modification = false` recovery always stops with `restart required`; add a test for that path. Opus revises this task after Tasks 5–10 land.


**Files:** Create `server/src/orchestrator.ts`. Test: `server/test/orchestrator.test.ts`.

**Interfaces:**
- Consumes: `RunStore`, `RunEvent`, `Verdict` (Task 7); `diffSnapshots`, `sameAsBaseline`, `ModelSnapshot` (Task 6); `evaluateFeature`, `evaluateAcceptance`, `Evidence` (Task 9); `makePlan`, `AskText` (Task 10); `RunAgent`, `FeatureTask` (Task 12); `ConsoleLog` (Task 8); `InspectorError` (Task 1); `ProjectRef` (Task 5, `adapter.ts`).
- Produces:
```ts
export type BrowserLike = { console: ConsoleLog; cdpEndpoint: string; open(url: string): Promise<void>; screenshot(file: string): Promise<void> };
export type Deps = {
  ask: AskText; runAgent: RunAgent; launchBrowser: () => Promise<BrowserLike>;
  findProject: () => Promise<ProjectRef>; snapshot: (p: ProjectRef) => Promise<ModelSnapshot>;
  evidence: Evidence; frontendUrl: string; maxRecoveries: number;
  writeReport: (store: RunStore) => void;
};
export class BusyError extends Error { runId: string }
export class Orchestrator {
  constructor(runsDir: string, deps: Deps, emit?: (runId: string, ev: RunEvent) => void);
  status(): { runId: string; phase: string; featureId?: string; paused: boolean } | null;
  start(prompt: string): string;           // throws BusyError; runs async; returns runId
  pause(runId: string): void; resume(runId: string): void; cancel(runId: string): void;
  canRetry(runId: string): boolean;
  retry(runId: string): void;              // throws BusyError or Error('retry not available — restart the run')
  done(): Promise<void>;                   // resolves when the current run finishes (for tests and accept)
}
```
Behavior (from the spec, §7):
- `designing` → plan. An invalid plan fails with `design failed: …`. The browser is never launched.
- `preparing`: launch the browser lazily (one per process, reused), open `frontendUrl`, run an agent in `new_document` mode, then `findProject`.
- Per feature: checkpoint (pause/cancel) → baseline snapshot plus console mark → `build` attempt → snapshot, diff, console classification, screenshot `<fid>-a<n>`, `evaluateFeature` → pass ends the loop. On fail → **cleanup**:
  - stop (non-retryable) if modification detection is unsupported, or if `diff.modified`/`diff.removed` is non-empty;
  - otherwise a `recover` agent deletes exactly `diff.added`, then the model must be `sameAsBaseline`, or else stop with "restoration not verified — restart required".
  - Then reset the console mark and make the next attempt. At most `1 + maxRecoveries` build attempts. After the last failed attempt the cleanup still runs. If it succeeds, the run is **retryable**.
- `saving`: a `save` agent. Ok = `reportedDone` and no fresh console errors and the model is unchanged (`sameAsBaseline`).
- `verifying_model`: `evaluateAcceptance`. `reopen_matches` is recorded as `skipped` ("reopen not automated in v1"). Any `fail` fails the run.
- `run_end {verdict, reason}` is always appended (in `finally` style), then `writeReport` runs. `passed` is set only after everything succeeded and the run wasn't aborted.
- `retry` works only for an in-memory retryable failure. It first checks that the model still equals that feature's baseline, then resumes from that feature on the **same** run id.

- [ ] **Step 1: Failing test `server/test/orchestrator.test.ts`**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Orchestrator, BusyError, type Deps } from '../src/orchestrator';
import { ConsoleLog } from '../src/consolelog';
import { RunStore, runVerdict } from '../src/store';
import { InspectorError } from '../src/inspector';
import type { SnapObject } from '../src/snapshot';
import type { FeatureTask } from '../src/executor';

const PLAN = JSON.stringify({ product: 'plate', units: 'mm', parameters: {},
  features: [{ id: 'f1', type: 'sketch_rectangle', dependsOn: [], params: { plane: 'XY', width: 100, height: 60 }, checks: [] },
             { id: 'f2', type: 'extrude', dependsOn: ['f1'], params: { depth: 8 }, checks: [] }],
  acceptance: [{ kind: 'body_count', expect: 1 }] });
const supported = { feature_exists: true, depends_on: false, status_ok: false, body_count: true, dimension: false,
  no_unexpected_modification: true, no_new_console_errors: true, reopen_matches: false };

/** Simulated Ivy: a model the fake agent mutates. Knobs change the agent's behaviour. */
function sim(knobs: { noop?: boolean; touchExisting?: boolean; cleanupFails?: boolean; consoleError?: boolean;
                      inspectorDown?: boolean; hang?: boolean; plan?: string } = {}) {
  const model = new Map<number, SnapObject>([[1, { id: 1, cls: 'Doc', hash: 'd' }]]);
  let next = 10;
  const calls: FeatureTask[] = [];
  const log = new ConsoleLog();
  const cls = { sketch_rectangle: 'Sketch', extrude: 'Extrude' } as const;
  let browserLaunched = false;
  const deps: Deps = {
    ask: async () => knobs.plan ?? PLAN,
    launchBrowser: async () => { browserLaunched = true; return { console: log, cdpEndpoint: 'x', open: async () => {}, screenshot: async () => {} }; },
    findProject: async () => ({ projectId: 1, projectTag: 'main' }),
    snapshot: async () => {
      if (knobs.inspectorDown) throw new InspectorError('inspector unavailable: ECONNREFUSED');
      return { objects: new Map([...model].map(([k, v]) => [k, { ...v }])) };
    },
    runAgent: async (task, _cdp, signal) => {
      calls.push(task);
      if (knobs.hang) await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      if (task.mode === 'build' && !knobs.noop) {
        const id = next++;
        model.set(id, { id, cls: cls[task.feature.type], hash: 'h' + id });
        if (task.feature.type === 'extrude') model.set(next++, { id: next - 1, cls: 'Body', hash: 'b' });
        if (knobs.touchExisting) model.get(1)!.hash = 'changed';
        if (knobs.consoleError) log.add('TypeError: boom ' + id);
      }
      if (task.mode === 'recover' && !knobs.cleanupFails) {
        for (const m of task.diagnostics!.matchAll(/#(\d+)/g)) model.delete(Number(m[1]));
      }
      return { reportedDone: true, summary: 'done' };
    },
    evidence: { idRegex: '', classPath: '', featureClass: cls, bodyClass: 'Body', volatileClasses: ['Doc'], stripPaths: [], supported },
    frontendUrl: 'https://localhost:8080', maxRecoveries: 2,
    writeReport: (s) => s.writeAtomic('report.html', 'r'),
  };
  return { deps, calls, model, log, launched: () => browserLaunched };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-')); });
const run = async (s: ReturnType<typeof sim>, prompt = 'plate') => {
  const o = new Orchestrator(dir, s.deps);
  const id = o.start(prompt);
  await o.done();
  const ev = RunStore.open(dir, id).readEvents();
  return { o, id, ev, verdict: runVerdict(ev), reason: String(ev.findLast((e) => e.type === 'run_end')?.reason) };
};

describe('Orchestrator', () => {
  it('happy path passes, saves, writes report', async () => {
    const s = sim();
    const r = await run(s);
    expect(r.verdict).toBe('passed');
    expect(s.calls.map((c) => c.mode)).toEqual(['new_document', 'build', 'build', 'save']);
    expect(fs.existsSync(path.join(dir, r.id, 'report.html'))).toBe(true);
  });
  it('second start while running -> BusyError', async () => {
    const s = sim({ hang: true });
    const o = new Orchestrator(dir, s.deps);
    const id = o.start('a');
    expect(() => o.start('b')).toThrow(BusyError);
    o.cancel(id); await o.done();
  });
  it('agent claims done but nothing changes -> 3 attempts, fail, downstream never attempted, retryable', async () => {
    const s = sim({ noop: true });
    const r = await run(s);
    expect(r.verdict).toBe('failed');
    expect(s.calls.filter((c) => c.mode === 'build').map((c) => c.feature.id)).toEqual(['f1', 'f1', 'f1']);
    expect(r.o.canRetry(r.id)).toBe(true);
  });
  it('modified existing object -> stop without recovery, restart required', async () => {
    const s = sim({ touchExisting: true });
    s.deps.evidence.volatileClasses = [];
    const r = await run(s);
    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('existing objects modified');
    expect(s.calls.filter((c) => c.mode === 'recover')).toEqual([]);
    expect(r.o.canRetry(r.id)).toBe(false);
  });
  it('cleanup that does not restore baseline -> restoration not verified', async () => {
    const s = sim({ consoleError: true, cleanupFails: true });
    const r = await run(s);
    expect(r.reason).toContain('restoration not verified');
    expect(r.o.canRetry(r.id)).toBe(false);
  });
  it('fresh console error fails the feature and triggers verified cleanup', async () => {
    const s = sim({ consoleError: true });
    const r = await run(s);
    expect(r.verdict).toBe('failed');
    expect(s.calls.filter((c) => c.mode === 'recover').length).toBe(3);
  });
  it('inspector down -> failed with inspector unavailable, never passed', async () => {
    const r = await run(sim({ inspectorDown: true }));
    expect(r.verdict).toBe('failed');
    expect(r.reason).toContain('inspector unavailable');
  });
  it('cancel mid-feature -> cancelled, report still written', async () => {
    const s = sim({ hang: true });
    const o = new Orchestrator(dir, s.deps);
    const id = o.start('p');
    await new Promise((r) => setTimeout(r, 20));
    o.cancel(id); await o.done();
    expect(runVerdict(RunStore.open(dir, id).readEvents())).toBe('cancelled');
    expect(fs.existsSync(path.join(dir, id, 'report.html'))).toBe(true);
  });
  it('pause takes effect at the next checkpoint only', async () => {
    const s = sim();
    const o = new Orchestrator(dir, s.deps);
    const id = o.start('p');
    o.pause(id);
    await new Promise((r) => setTimeout(r, 30));
    expect(o.status()?.paused).toBe(true);
    expect(s.calls.filter((c) => c.mode === 'build')).toEqual([]);
    o.resume(id); await o.done();
    expect(runVerdict(RunStore.open(dir, id).readEvents())).toBe('passed');
  });
  it('unsupported operation fails at design, browser never launched', async () => {
    const bad = JSON.parse(PLAN); bad.features.push({ id: 'f3', type: 'hole', dependsOn: ['f2'], params: {}, checks: [] });
    const s = sim({ plan: JSON.stringify(bad) });
    const r = await run(s);
    expect(r.reason).toContain('not supported'); expect(s.launched()).toBe(false);
  });
  it('fresh error repeated on every retry keeps failing (not downgraded to recurring)', async () => {
    const r = await run(sim({ consoleError: true }));
    const fresh = r.ev.filter((e) => e.type === 'console' && e.kind === 'fresh');
    expect(fresh.length).toBe(3);
  });
  it('retry resumes the failed feature on the same run id', async () => {
    const knobs = { noop: true };              // sim reads knobs live
    const s = sim(knobs);
    const r = await run(s);
    knobs.noop = false;                        // "UI fixed"
    r.o.retry(r.id); await r.o.done();
    expect(runVerdict(RunStore.open(dir, r.id).readEvents())).toBe('passed');
  });
});
```
- [ ] **Step 2:** Run, expect FAIL (module missing).
- [ ] **Step 3: Implement `server/src/orchestrator.ts`**
```ts
import { RunStore, type RunEvent, type Verdict } from './store';
import { diffSnapshots, sameAsBaseline, type ModelSnapshot, type SnapDiff } from './snapshot';
import { evaluateFeature, evaluateAcceptance, type Evidence } from './checks';
import { makePlan } from './planner';
import type { AskText } from './llm';
import type { RunAgent, FeatureTask, AgentEvent } from './executor';
import type { ConsoleLog } from './consolelog';
import type { Plan, PlanFeature } from './plan';
import type { ProjectRef } from './adapter';
import { InspectorError } from './inspector';

export type BrowserLike = { console: ConsoleLog; cdpEndpoint: string; open(url: string): Promise<void>; screenshot(file: string): Promise<void> };
export type Deps = {
  ask: AskText; runAgent: RunAgent; launchBrowser: () => Promise<BrowserLike>;
  findProject: () => Promise<ProjectRef>; snapshot: (p: ProjectRef) => Promise<ModelSnapshot>;
  evidence: Evidence; frontendUrl: string; maxRecoveries: number;
  writeReport: (store: RunStore) => void;
};
export class BusyError extends Error { constructor(public runId: string) { super(`busy: run ${runId} is active`); } }

type Resume = { plan: Plan; proj: ProjectRef; featureIndex: number; createdIds: Record<string, number>; base: ModelSnapshot };
class RunFailure extends Error { constructor(msg: string, public resume?: Resume) { super(msg); } }
class Cancelled extends Error {}
type Active = { store: RunStore; abort: AbortController; paused: boolean; wake?: () => void; phase: string; featureId?: string; finished: Promise<void> };

export class Orchestrator {
  private active: Active | null = null;
  private browser?: BrowserLike;
  // ponytail: retry state is in-memory only; after a harness restart the console offers "Restart run".
  private retryable = new Map<string, Resume>();

  constructor(private runsDir: string, private deps: Deps, private emit: (runId: string, ev: RunEvent) => void = () => {}) {}

  status() {
    const a = this.active;
    return a && { runId: a.store.id, phase: a.phase, featureId: a.featureId, paused: a.paused };
  }
  canRetry(runId: string) { return !this.active && this.retryable.has(runId); }
  done(): Promise<void> { return this.active?.finished ?? Promise.resolve(); }

  start(prompt: string): string {
    if (this.active) throw new BusyError(this.active.store.id);
    const store = RunStore.create(this.runsDir, prompt);
    this.launch(store, (a) => this.fromPrompt(a, prompt));
    return store.id;
  }
  retry(runId: string): void {
    if (this.active) throw new BusyError(this.active.store.id);
    const r = this.retryable.get(runId);
    if (!r) throw new Error('retry not available — restart the run');
    this.retryable.delete(runId);
    this.launch(RunStore.open(this.runsDir, runId), async (a) => {
      this.log(a, 'retry', { feature: r.plan.features[r.featureIndex].id });
      if (!sameAsBaseline(r.base, await this.deps.snapshot(r.proj), this.deps.evidence.volatileClasses))
        throw new RunFailure('model changed since the failure — restart required');
      await this.buildFrom(a, r.plan, r.proj, r.featureIndex, r.createdIds);
    });
  }
  pause(runId: string) { const a = this.get(runId); a.paused = true; this.log(a, 'pause_requested'); }
  resume(runId: string) { const a = this.get(runId); a.paused = false; a.wake?.(); this.log(a, 'resumed'); }
  cancel(runId: string) { const a = this.get(runId); this.log(a, 'cancel_requested'); a.abort.abort(); a.wake?.(); }

  private get(runId: string): Active {
    if (!this.active || this.active.store.id !== runId) throw new Error(`run ${runId} is not active`);
    return this.active;
  }
  private launch(store: RunStore, body: (a: Active) => Promise<void>) {
    const a = { store, abort: new AbortController(), paused: false, phase: 'starting' } as Active;
    this.active = a;
    a.finished = this.execute(a, body);
  }

  private async execute(a: Active, body: (a: Active) => Promise<void>) {
    let verdict: Verdict = 'failed';
    let reason = '';
    try {
      await body(a);
      verdict = 'passed';
      reason = 'all features verified, model saved, acceptance checks passed';
    } catch (e) {
      if (a.abort.signal.aborted || e instanceof Cancelled) { verdict = 'cancelled'; reason = 'cancelled by user'; }
      else {
        reason = e instanceof InspectorError ? `inspector unavailable: ${e.message}` : (e as Error).message;
        if (e instanceof RunFailure && e.resume) this.retryable.set(a.store.id, e.resume);
      }
    }
    if (a.abort.signal.aborted) verdict = 'cancelled';
    try { await this.browser?.screenshot(a.store.shotPath('final')); } catch { /* best effort */ }
    this.log(a, 'run_end', { verdict, reason, retryable: this.retryable.has(a.store.id) });
    try { this.deps.writeReport(a.store); } catch (e) { this.log(a, 'report_error', { message: String(e) }); }
    this.active = null;
  }

  private async fromPrompt(a: Active, prompt: string) {
    this.phase(a, 'designing');
    const pr = await makePlan(prompt, this.deps.ask, a.abort.signal);
    this.check(a);
    if (!pr.ok) {
      this.log(a, 'plan_invalid', { errors: pr.errors, unsupported: pr.unsupported });
      throw new RunFailure(`design failed: ${pr.errors.join('; ')}`);
    }
    a.store.writeJson('plan.json', pr.plan);
    this.log(a, 'plan', { plan: pr.plan, attempts: pr.attempts });

    this.phase(a, 'preparing');
    this.browser ??= await this.deps.launchBrowser();
    await this.browser.open(this.deps.frontendUrl);
    await this.agent(a, { plan: pr.plan, feature: pr.plan.features[0], attempt: 1, mode: 'new_document' });
    const proj = await this.deps.findProject();
    this.log(a, 'project', proj);
    await this.buildFrom(a, pr.plan, proj, 0, {});
  }

  private async buildFrom(a: Active, plan: Plan, proj: ProjectRef, start: number, createdIds: Record<string, number>) {
    const ev = this.deps.evidence;
    const b = this.browser!;
    const attempts = 1 + this.deps.maxRecoveries;
    for (let i = start; i < plan.features.length; i++) {
      const f = plan.features[i];
      await this.checkpoint(a);
      a.featureId = f.id;
      const base = await this.deps.snapshot(proj);
      // Errors are "fresh" relative to the feature start, so an error repeated on a retry stays fresh.
      const featureMark = b.console.mark();
      let diagnostics: string | undefined;
      let passed = false;
      for (let attempt = 1; attempt <= attempts && !passed; attempt++) {
        const attemptSeq = b.console.mark().seq;
        this.phase(a, 'executing', { attempt });
        const ex = await this.agent(a, { plan, feature: f, attempt, mode: 'build', diagnostics });
        this.phase(a, 'verifying', { attempt });
        const cur = await this.deps.snapshot(proj);
        const diff = diffSnapshots(base, cur, ev.volatileClasses);
        const all = b.console.since(featureMark);
        const con = { fresh: all.fresh.filter((e) => e.seq >= attemptSeq), recurring: all.recurring.filter((e) => e.seq >= attemptSeq) };
        for (const e of con.recurring) this.log(a, 'console', { feature: f.id, kind: 'recurring', text: e.text });
        for (const e of con.fresh) this.log(a, 'console', { feature: f.id, kind: 'fresh', text: e.text });
        const shot = `${f.id}-a${attempt}`;
        try { await b.screenshot(a.store.shotPath(shot)); } catch { /* best effort */ }
        const res = evaluateFeature({ feature: f, diff, cur, ev, freshConsole: con.fresh.map((e) => e.text), createdIds });
        this.log(a, 'feature_result', { feature: f.id, attempt, passed: res.passed, results: res.results, shot, reportedDone: ex.reportedDone, summary: ex.summary });
        if (res.passed) { createdIds[f.id] = res.createdId!; passed = true; break; }
        diagnostics = res.results.filter((r) => r.status === 'fail').map((r) => `${r.kind}: ${r.detail}`).join('\n');
        await this.cleanup(a, plan, f, proj, base, diff, diagnostics);
      }
      if (!passed) throw new RunFailure(`feature ${f.id} (${f.type}) failed verification after ${attempts} attempts`,
        { plan, proj, featureIndex: i, createdIds: { ...createdIds }, base });
    }

    await this.checkpoint(a);
    a.featureId = undefined;
    this.phase(a, 'saving');
    const before = await this.deps.snapshot(proj);
    const sm = b.console.mark();
    const sv = await this.agent(a, { plan, feature: plan.features.at(-1)!, attempt: 1, mode: 'save' });
    const after = await this.deps.snapshot(proj);
    const fresh = b.console.since(sm).fresh.map((e) => e.text);
    const saveOk = sv.reportedDone && !fresh.length && sameAsBaseline(before, after, ev.volatileClasses);
    this.log(a, 'save_result', { ok: saveOk, summary: sv.summary, fresh });
    if (!saveOk) throw new RunFailure('save failed or changed the model');

    this.phase(a, 'verifying_model');
    const acc = evaluateAcceptance(plan.acceptance.filter((c) => c.kind !== 'reopen_matches'), after, ev);
    acc.push({ kind: 'reopen_matches', status: 'skipped', detail: 'reopen not automated in v1' });
    this.log(a, 'acceptance', { results: acc });
    const bad = acc.filter((r) => r.status === 'fail');
    if (bad.length) throw new RunFailure(`acceptance failed: ${bad.map((r) => r.detail).join('; ')}`);
  }

  /** Restore the pre-feature baseline or stop. Never guesses. */
  private async cleanup(a: Active, plan: Plan, f: PlanFeature, proj: ProjectRef, base: ModelSnapshot, diff: SnapDiff, diagnostics: string) {
    const ev = this.deps.evidence;
    if (!ev.supported.no_unexpected_modification) throw new RunFailure('unsafe to recover: modification detection unsupported — restart required');
    if (diff.modified.length || diff.removed.length) throw new RunFailure('unsafe to recover: existing objects modified — restart required');
    if (diff.added.length) {
      this.phase(a, 'recovering');
      const list = diff.added.map((o) => `${o.cls}#${o.id}${o.name ? ` "${o.name}"` : ''}`).join(', ');
      await this.agent(a, { plan, feature: f, attempt: 0, mode: 'recover', diagnostics: `${diagnostics}\nDelete exactly these objects: ${list}` });
    }
    let restored = false;
    try { restored = sameAsBaseline(base, await this.deps.snapshot(proj), ev.volatileClasses); } catch { /* not verified */ }
    if (!restored) throw new RunFailure('unsafe to recover: restoration not verified — restart required');
    this.log(a, 'recovered', { feature: f.id });
  }

  private async agent(a: Active, task: FeatureTask) {
    const res = await this.deps.runAgent(task, this.browser!.cdpEndpoint, a.abort.signal,
      (e: AgentEvent) => this.log(a, 'agent', { feature: task.feature.id, mode: task.mode, ...e }));
    this.check(a);
    return res;
  }
  private async checkpoint(a: Active) {
    this.check(a);
    if (a.paused) {
      this.phase(a, 'paused');
      await new Promise<void>((r) => (a.wake = r));
      a.wake = undefined;
      this.check(a);
    }
  }
  private check(a: Active) { if (a.abort.signal.aborted) throw new Cancelled(); }
  private phase(a: Active, phase: string, extra: Record<string, unknown> = {}) {
    a.phase = phase;
    this.log(a, 'phase', { phase, feature: a.featureId, ...extra });
  }
  private log(a: Active, type: string, data: Record<string, unknown> = {}) {
    this.emit(a.store.id, a.store.append(type, data));
  }
}
```
- [ ] **Step 4:** Run, expect 12 PASS. If the `retry` test is awkward, simplify the fixture but keep its assertion: retry resumes on the same run id and the final verdict is `passed`.
- [ ] **Step 5:** Commit: `feat: orchestrator with verified recovery, pause, cancel, retry`.

**Acceptance (Task 13):** all 12 tests pass. A cancelled run is never `passed`. Recovery never runs when existing objects changed. A failure to verify restoration stops the run with "restart required".

### Task 14: Report + bug log (rebuildable from events)

> **REVISION REQUIRED before execution (Task 0 evidence, 2026-10-12):** Ivy autosaves and has no manual save. Replace the `save` mode/step with a `reopen` step (close + reopen the document, then `reopenMatches(before, after, ev)` from Task 9). Object keys are uuid strings (`SnapObject.key`/`handle`, `createdIds: Record<string,string>`). With `supported.no_unexpected_modification = false` recovery always stops with `restart required`; add a test for that path. Opus revises this task after Tasks 5–10 land.


**Files:** Create `server/src/report.ts`. Test: `server/test/report.test.ts`.

**Interfaces:**
- Consumes: `RunStore`, `RunEvent`, `runVerdict` (Task 7).
- Produces:
```ts
export type Bug = { t: string; kind: 'console_fresh' | 'console_recurring' | 'tool_denied' | 'feature_failed' | 'save_failed'; feature?: string; text: string; shot?: string };
export function collectBugs(events: RunEvent[]): Bug[];
export function renderReport(events: RunEvent[]): string;   // self-contained HTML, all event text escaped
export function writeReport(store: RunStore): void;          // report.html + bugs.json, atomic
export function envInfo(): Record<string, string>;           // model, node, git short SHAs of ai-cad, mda, ivyproject ('unknown' on error)
```
Report sections: title plus a verdict badge (`interrupted` when there's no `run_end`) and the reason; the prompt; environment (`env` event); the plan (`plan` event, pretty JSON); one card per `feature_result` (feature, attempt, pass/fail, a check table with status per kind, the agent summary, and a thumbnail linking `shots/<shot>.png`); save; acceptance; bugs. Inline CSS with light/dark via `prefers-color-scheme`.

- [ ] **Step 1: Failing test `server/test/report.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { renderReport, collectBugs, writeReport } from '../src/report';
import { RunStore } from '../src/store';

const ev = (type: string, d: Record<string, unknown> = {}) => ({ t: '2026-10-12T00:00:00Z', type, ...d });
const base = [
  ev('run_start', { prompt: '<script>alert(1)</script> plate' }),
  ev('feature_result', { feature: 'f1', attempt: 1, passed: false, shot: 'f1-a1', summary: 'drew it',
    results: [{ kind: 'feature_exists', status: 'fail', detail: 'no new Sketch object appeared' }, { kind: 'status_ok', status: 'unsupported', detail: 'n/a' }] }),
  ev('console', { feature: 'f1', kind: 'fresh', text: 'TypeError: x' }),
  ev('console', { feature: 'f1', kind: 'recurring', text: 'ws reconnect' }),
  ev('agent', { feature: 'f1', kind: 'denied', name: 'Bash', reason: 'tool Bash is not available' }),
];

describe('report', () => {
  it('shows interrupted when run_end is missing and escapes HTML', () => {
    const html = renderReport(base);
    expect(html).toContain('interrupted');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('shots/f1-a1.png');
    expect(html).toContain('unsupported');
  });
  it('shows final verdict and reason', () => {
    const html = renderReport([...base, ev('run_end', { verdict: 'failed', reason: 'unsafe to recover: restoration not verified — restart required' })]);
    expect(html).toContain('failed'); expect(html).toContain('restart required');
  });
  it('collects bugs by kind', () => {
    expect(collectBugs(base).map((b) => b.kind).sort()).toEqual(['console_fresh', 'console_recurring', 'feature_failed', 'tool_denied']);
  });
  it('writeReport writes report.html and bugs.json', () => {
    const s = RunStore.create(fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')), 'p');
    writeReport(s);
    expect(fs.existsSync(path.join(s.dir, 'report.html'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, 'bugs.json'), 'utf8'))).toEqual([]);
  });
});
```
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3: Implement `server/src/report.ts`**
```ts
import { execFileSync } from 'node:child_process';
import { runVerdict, type RunEvent, type RunStore } from './store';
import { config } from './config';

export type Bug = { t: string; kind: 'console_fresh' | 'console_recurring' | 'tool_denied' | 'feature_failed' | 'save_failed'; feature?: string; text: string; shot?: string };

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function collectBugs(events: RunEvent[]): Bug[] {
  return events.flatMap((e): Bug[] => {
    const f = e.feature as string | undefined;
    if (e.type === 'console') return [{ t: e.t, kind: e.kind === 'fresh' ? 'console_fresh' : 'console_recurring', feature: f, text: String(e.text) }];
    if (e.type === 'agent' && e.kind === 'denied') return [{ t: e.t, kind: 'tool_denied', feature: f, text: `${e.name}: ${e.reason}` }];
    if (e.type === 'feature_result' && !e.passed) {
      const fails = (e.results as any[]).filter((r) => r.status === 'fail').map((r) => `${r.kind}: ${r.detail}`);
      return [{ t: e.t, kind: 'feature_failed', feature: f, text: `attempt ${e.attempt}: ${fails.join('; ')}`, shot: String(e.shot) }];
    }
    if (e.type === 'save_result' && !e.ok) return [{ t: e.t, kind: 'save_failed', text: String(e.summary) }];
    return [];
  });
}

function checks(rows: any[]) {
  return `<table><tr><th>check</th><th>status</th><th>detail</th></tr>${rows.map((r) =>
    `<tr><td>${esc(r.kind)}</td><td class="s-${esc(r.status)}">${esc(r.status)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`;
}

export function renderReport(events: RunEvent[]): string {
  const find = (t: string) => events.findLast((e) => e.type === t);
  const verdict = runVerdict(events);
  const end = find('run_end');
  const plan = find('plan')?.plan;
  const save = find('save_result');
  const acc = find('acceptance');
  const env = find('env');
  const features = events.filter((e) => e.type === 'feature_result').map((e) => `
    <section class="card"><h3>${esc(e.feature)} · attempt ${esc(e.attempt)} · <span class="s-${e.passed ? 'pass' : 'fail'}">${e.passed ? 'pass' : 'fail'}</span></h3>
    <a href="shots/${esc(e.shot)}.png"><img src="shots/${esc(e.shot)}.png" alt="screenshot ${esc(e.shot)}"></a>
    ${checks(e.results as any[])}<p><b>Agent:</b> ${esc(e.summary)}</p></section>`).join('');
  const bugs = collectBugs(events);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run report</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--card:#f5f5f5;--pass:#1a7f37;--fail:#c62828;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#999;--card:#1f1f1f;--pass:#4ac26b;--fail:#ff6b6b;--warn:#d4a72c}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:16px}
.card{background:var(--card);border-radius:8px;padding:12px;margin:12px 0}img{max-width:100%;border-radius:4px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--mut)}
.s-pass,.s-passed{color:var(--pass)}.s-fail,.s-failed,.s-interrupted{color:var(--fail)}.s-unsupported,.s-skipped,.s-cancelled{color:var(--warn)}
pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<h1>Run report · <span class="s-${verdict}">${verdict}</span></h1>
<p>${esc(end?.reason ?? 'run did not finish (no run_end event)')}</p>
<p><b>Prompt:</b> ${esc(events[0]?.prompt)}</p>
${env ? `<p class="card"><b>Environment:</b> ${esc(JSON.stringify({ ...env, t: undefined, type: undefined }))}</p>` : ''}
<h2>Plan</h2><pre class="card">${esc(plan ? JSON.stringify(plan, null, 2) : 'no plan')}</pre>
<h2>Features</h2>${features || '<p>none attempted</p>'}
<h2>Save</h2><p>${save ? (save.ok ? '<span class="s-pass">saved</span>' : `<span class="s-fail">failed</span> ${esc(save.summary)}`) : 'not reached'}</p>
<h2>Acceptance</h2>${acc ? checks(acc.results as any[]) : '<p>not reached</p>'}
<h2>Bugs (${bugs.length})</h2>${bugs.length ? `<table>${bugs.map((b) => `<tr><td>${esc(b.kind)}</td><td>${esc(b.feature)}</td><td>${esc(b.text)}</td></tr>`).join('')}</table>` : '<p>none</p>'}
</body></html>`;
}

export function writeReport(store: RunStore): void {
  const events = store.readEvents();
  store.writeJson('bugs.json', collectBugs(events));
  store.writeAtomic('report.html', renderReport(events));
}

export function envInfo(): Record<string, string> {
  const sha = (dir: string) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  return { model: config.model, node: process.version, harness: sha(config.root),
    mda: sha(process.env.MDA_DIR || 'C:\\zixel\\mda'), ivyproject: sha(process.env.IVY_ROOT || 'C:\\zixel\\ivyproject') };
}
```
- [ ] **Step 4:** Run, expect 4 PASS.
- [ ] **Step 5:** Commit: `feat: HTML report and bug log rebuilt from events`.

**Acceptance:** the report renders for interrupted runs, and all event text is HTML-escaped.

### Task 15: HTTP server (REST + SSE + static), real wiring

**Files:** Create `server/src/server.ts` (testable app), `server/src/index.ts` (wiring + listen). Test: `server/test/server.test.ts`.

**Interfaces:**
- Consumes: `Orchestrator`, `BusyError` (Task 13); `listRuns`, `RunStore`, `runVerdict` (Task 7); `writeReport`, `envInfo` (Task 14); `HarnessBrowser` (Task 11); `askText` (Task 10); `runAgent` (Task 12); `Inspector` (Task 1); `findProject`, `takeSnapshot`, `loadEvidence` (Task 5).
- Produces:
```ts
export type OrchestratorLike = Pick<Orchestrator, 'status' | 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'canRetry'>;
export function createApp(orch: OrchestratorLike, opts: { runsDir: string; webDir: string; onStart?: (runId: string) => void }):
  { server: http.Server; broadcast: (runId: string, ev: RunEvent) => void };
```
Routes (bound to `127.0.0.1` only):

| Method | Path | Result |
|---|---|---|
| GET | `/` | `web/index.html` |
| GET | `/api/status` | `orch.status()` or `null` |
| GET | `/api/runs` | `listRuns()`, each with `canRetry` |
| POST | `/api/runs` `{prompt}` | 400 if the prompt is empty or over 2000 chars; 409 `{error:'busy', runId}`; else 201 `{runId}` |
| GET | `/api/runs/:id` | `{id, verdict, canRetry, events}` |
| POST | `/api/runs/:id/pause\|resume\|cancel\|retry` | 204; 409 on BusyError; 400 with message on other errors |
| GET | `/api/runs/:id/events` | SSE: replays the file's events, then streams live ones |
| GET | `/runs/:id/<file>` | static artifact; `:id` must match `^[\w-]+$`, and the file must match `^[\w.-]+(/[\w.-]+)?$` with no `..`; else 404 |

- [ ] **Step 1: Failing test `server/test/server.test.ts`**
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server';
import { BusyError } from '../src/orchestrator';
import { RunStore } from '../src/store';

let runsDir: string, base: string, app: ReturnType<typeof createApp>, busy = false;
const orch: any = {
  status: () => null, canRetry: () => false,
  start: (p: string) => { if (busy) throw new BusyError('r0'); return RunStore.create(runsDir, p).id; },
  pause() {}, resume() {}, cancel() {}, retry() { throw new Error('retry not available — restart the run'); },
};
beforeEach(async () => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<h1>console</h1>');
  app = createApp(orch, { runsDir, webDir });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(() => { busy = false; app.server.close(); });
const post = (p: string, body?: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('server', () => {
  it('serves console', async () => { expect(await (await fetch(base + '/')).text()).toContain('console'); });
  it('starts a run', async () => {
    const r = await post('/api/runs', { prompt: 'plate 100x60x8' });
    expect(r.status).toBe(201); expect((await r.json()).runId).toMatch(/^[\w-]+$/);
  });
  it('rejects empty and oversized prompts', async () => {
    expect((await post('/api/runs', { prompt: ' ' })).status).toBe(400);
    expect((await post('/api/runs', { prompt: 'x'.repeat(2001) })).status).toBe(400);
  });
  it('409 when busy', async () => { busy = true; expect((await post('/api/runs', { prompt: 'p' })).status).toBe(409); });
  it('retry not available -> 400 with message', async () => {
    const id = RunStore.create(runsDir, 'p').id;
    const r = await post(`/api/runs/${id}/retry`);
    expect(r.status).toBe(400); expect((await r.json()).error).toContain('restart');
  });
  it('blocks path traversal on artifacts', async () => {
    expect((await fetch(base + '/runs/..%2F..%2Fetc/passwd')).status).toBe(404);
    const id = RunStore.create(runsDir, 'p').id;
    expect((await fetch(`${base}/runs/${id}/..%2F..%2Fsecret`)).status).toBe(404);
  });
  it('SSE replays existing events', async () => {
    const s = RunStore.create(runsDir, 'p'); s.append('phase', { phase: 'designing' });
    const res = await fetch(`${base}/api/runs/${s.id}/events`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('run_start');
    await reader.cancel();
  });
});
```
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3: Implement `server/src/server.ts`**
```ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BusyError, type Orchestrator } from './orchestrator';
import { listRuns, RunStore, runVerdict, type RunEvent } from './store';

export type OrchestratorLike = Pick<Orchestrator, 'status' | 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'canRetry'>;
const ID = /^[\w-]+$/;
const FILE = /^[\w.-]+(\/[\w.-]+)?$/;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jsonl': 'text/plain; charset=utf-8' };

export function createApp(orch: OrchestratorLike, opts: { runsDir: string; webDir: string; onStart?: (runId: string) => void }) {
  const subs = new Map<string, Set<http.ServerResponse>>();
  const json = (res: http.ServerResponse, code: number, body?: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const file = (res: http.ServerResponse, f: string) => {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = decodeURIComponent(url.pathname);
    const m = p.match(/^\/api\/runs\/([^/]+)(?:\/(\w+))?$/);
    try {
      if (req.method === 'GET' && p === '/') return file(res, path.join(opts.webDir, 'index.html'));
      if (req.method === 'GET' && p === '/api/status') return json(res, 200, orch.status());
      if (req.method === 'GET' && p === '/api/runs') return json(res, 200, listRuns(opts.runsDir).map((r) => ({ ...r, canRetry: orch.canRetry(r.id) })));
      if (req.method === 'POST' && p === '/api/runs') {
        const prompt = String((await readBody(req)).prompt ?? '').trim();
        if (!prompt || prompt.length > 2000) return json(res, 400, { error: 'prompt must be 1-2000 characters' });
        const runId = orch.start(prompt);
        opts.onStart?.(runId);
        return json(res, 201, { runId });
      }
      if (m && ID.test(m[1])) {
        const [, id, action] = m;
        if (req.method === 'GET' && !action) {
          const events = RunStore.open(opts.runsDir, id).readEvents();
          return json(res, 200, { id, verdict: runVerdict(events), canRetry: orch.canRetry(id), events });
        }
        if (req.method === 'GET' && action === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          for (const e of RunStore.open(opts.runsDir, id).readEvents()) res.write(`data: ${JSON.stringify(e)}\n\n`);
          const set = subs.get(id) ?? new Set(); set.add(res); subs.set(id, set);
          req.on('close', () => set.delete(res));
          return;
        }
        if (req.method === 'POST' && action && ['pause', 'resume', 'cancel', 'retry'].includes(action)) {
          (orch as any)[action](id);
          return json(res, 204);
        }
      }
      const a = p.match(/^\/runs\/([^/]+)\/(.+)$/);
      if (req.method === 'GET' && a && ID.test(a[1]) && FILE.test(a[2]) && !a[2].includes('..'))
        return file(res, path.join(opts.runsDir, a[1], a[2]));
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BusyError) return json(res, 409, { error: 'busy', runId: e.runId });
      return json(res, 400, { error: (e as Error).message });
    }
  });

  const broadcast = (runId: string, ev: RunEvent) => {
    for (const r of subs.get(runId) ?? []) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  return { server, broadcast };
}
```
- [ ] **Step 4: Implement `server/src/index.ts`**
```ts
import { config } from './config';
import { createApp } from './server';
import { Orchestrator } from './orchestrator';
import { Inspector } from './inspector';
import { findProject, takeSnapshot, loadEvidence } from './adapter';
import { HarnessBrowser } from './browser';
import { askText } from './llm';
import { runAgent } from './executor';
import { writeReport, envInfo } from './report';
import { listRuns, RunStore } from './store';

const ins = new Inspector(config.inspectorUrl);
const evidence = loadEvidence();
let broadcast: (id: string, e: any) => void = () => {};
const orch = new Orchestrator(config.runsDir, {
  ask: askText, runAgent, launchBrowser: () => HarnessBrowser.launch(),
  findProject: () => findProject(ins), snapshot: (p) => takeSnapshot(ins, p, evidence),
  evidence, frontendUrl: config.frontendUrl, maxRecoveries: config.maxRecoveries, writeReport,
}, (id, e) => broadcast(id, e));

// Crash recovery: give every interrupted run a report rebuilt from its events.
for (const r of listRuns(config.runsDir)) if (r.verdict === 'interrupted') writeReport(RunStore.open(config.runsDir, r.id));

const app = createApp(orch, { runsDir: config.runsDir, webDir: config.webDir,
  onStart: (id) => RunStore.open(config.runsDir, id).append('env', envInfo()) });
broadcast = app.broadcast;
app.server.listen(config.port, '127.0.0.1', () => console.log(`Ivy CAD harness console: http://127.0.0.1:${config.port}`));
```
- [ ] **Step 5:** Run the tests, expect 7 PASS. Run `pnpm typecheck`.
- [ ] **Step 6:** Commit: `feat: HTTP API, SSE stream and real wiring`.

**Acceptance:** busy gives 409, bad prompts give 400, path traversal gives 404, SSE replays history, and the server binds to localhost only.

### Task 16: Web console

**Files:** Create `web/index.html` (single file: vanilla JS, no build, no external scripts).

**Interfaces:** Consumes the Task 15 REST/SSE API only.

Required behavior (spec §10):
- Prompt textarea and a **Start** button. Presets: "Mounting plate" (enabled; fills `Rectangular mounting plate 100 x 60 mm, 8 mm thick`). "Pipe flange", "Shaft with keyway" and "Enclosure box" are disabled, with the title "not yet supported".
- A live panel for the selected run: the phase line, then a per-feature checklist built from the `plan` event, updated by `feature_result` (✓ / ✗ / ⏳ plus attempt count). Each attempt shows a thumbnail (`/runs/<id>/shots/<shot>.png`, which opens full size).
- Buttons: **Pause / Resume / Cancel** (only while the run is active), **Retry feature** (only when `canRetry`), and **Restart run** (finished runs: POST `/api/runs` with the same prompt).
- A verdict banner with the `run_end` reason. Artifact links: `report.html`, `plan.json`, `bugs.json`, `events.jsonl`.
- A history list (`GET /api/runs`), newest first, with a verdict chip. Clicking a run selects it.
- An HTTP 409 on start shows "A run is already active" and selects it.
- Theming: color tokens on `:root`, redefined under `@media (prefers-color-scheme: dark)`, and `body` has an explicit background. Works at 375px width (16px gutter, no horizontal scroll).

- [ ] **Step 1: Write `web/index.html`**
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ivy CAD Harness</title>
<style>
:root{--bg:#fafafa;--fg:#1a1a1a;--mut:#6b6b6b;--card:#fff;--line:#e3e3e3;--acc:#2f6feb;--pass:#1a7f37;--fail:#c62828;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#e8e8e8;--mut:#9a9a9a;--card:#1c1c1c;--line:#2e2e2e;--acc:#6ea8fe;--pass:#4ac26b;--fail:#ff6b6b;--warn:#d4a72c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px;display:grid;gap:16px;grid-template-columns:1fr}
@media (min-width:900px){main{grid-template-columns:2fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
textarea{width:100%;min-height:70px;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--acc);color:#fff;border-color:var(--acc)}button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.mut{color:var(--mut)}
.pass{color:var(--pass)}.fail,.failed,.interrupted{color:var(--fail)}.cancelled,.unsupported{color:var(--warn)}.passed{color:var(--pass)}
ul{list-style:none;padding:0;margin:0}li{padding:6px 0;border-bottom:1px solid var(--line)}
.shots{display:flex;flex-wrap:wrap;gap:6px}.shots img{width:120px;border-radius:4px;border:1px solid var(--line)}
#banner{padding:8px;border-radius:6px;display:none}.hist li{cursor:pointer}.hist li.sel{font-weight:600}
</style></head><body><main>
<section>
  <div class="card">
    <h1 style="margin-top:0;font-size:20px">Ivy CAD Harness</h1>
    <div class="row" id="presets">
      <button data-p="Rectangular mounting plate 100 x 60 mm, 8 mm thick">Mounting plate</button>
      <button disabled title="not yet supported">Pipe flange</button>
      <button disabled title="not yet supported">Shaft with keyway</button>
      <button disabled title="not yet supported">Enclosure box</button>
    </div>
    <textarea id="prompt" placeholder="Describe the part to build…"></textarea>
    <div class="row"><button class="primary" id="start">Start</button><span id="msg" class="mut"></span></div>
  </div>
  <div class="card" id="run" hidden>
    <div id="banner"></div>
    <p><b id="rid"></b> · <span id="phase" class="mut"></span></p>
    <p class="mut" id="rprompt"></p>
    <div class="row">
      <button data-a="pause">Pause</button><button data-a="resume">Resume</button><button data-a="cancel">Cancel</button>
      <button data-a="retry">Retry feature</button><button id="restart">Restart run</button>
    </div>
    <ul id="features"></ul>
    <p class="row" id="links"></p>
  </div>
</section>
<aside class="card"><h2 style="margin-top:0;font-size:16px">History</h2><ul class="hist" id="history"></ul></aside>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let sel = null, es = null, state = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, body: j };
}
async function loadHistory() {
  const { body } = await api('GET', '/api/runs');
  $('#history').innerHTML = (body || []).map((r) =>
    `<li data-id="${esc(r.id)}" class="${r.id === sel ? 'sel' : ''}"><span class="${esc(r.verdict)}">●</span> ${esc(r.prompt.slice(0, 60))}<br><span class="mut">${esc(r.id)} · ${esc(r.verdict)}</span></li>`).join('');
}
function render() {
  const s = state; if (!s) return;
  $('#run').hidden = false;
  $('#rid').textContent = s.id; $('#rprompt').textContent = s.prompt; $('#phase').textContent = s.ended ? 'finished' : s.phase + (s.paused ? ' (paused)' : '');
  $('#features').innerHTML = s.features.map((f) => {
    const at = s.attempts[f.id] || [];
    const last = at.at(-1);
    const icon = !last ? (s.current === f.id && !s.ended ? '⏳' : '·') : last.passed ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>';
    return `<li>${icon} <b>${esc(f.id)}</b> ${esc(f.type)} <span class="mut">${esc(JSON.stringify(f.params))}</span>
      ${at.length ? `<span class="mut"> · ${at.length} attempt(s)</span>` : ''}
      <div class="shots">${at.map((a) => `<a href="/runs/${esc(s.id)}/shots/${esc(a.shot)}.png" target="_blank"><img src="/runs/${esc(s.id)}/shots/${esc(a.shot)}.png" alt="${esc(a.shot)}" loading="lazy"></a>`).join('')}</div></li>`;
  }).join('');
  const b = $('#banner');
  if (s.ended) { b.style.display = 'block'; b.className = s.verdict; b.innerHTML = `<b>${esc(s.verdict)}</b>: ${esc(s.reason)}`; } else b.style.display = 'none';
  const active = !s.ended;
  for (const btn of document.querySelectorAll('[data-a]')) {
    const a = btn.dataset.a;
    btn.disabled = a === 'retry' ? !s.canRetry : !active || (a === 'pause' && s.paused) || (a === 'resume' && !s.paused);
  }
  $('#restart').disabled = active;
  $('#links').innerHTML = ['report.html', 'plan.json', 'bugs.json', 'events.jsonl'].map((f) => `<a href="/runs/${esc(s.id)}/${f}" target="_blank">${f}</a>`).join(' · ');
}
function apply(e) {
  const s = state;
  if (e.type === 'run_start') s.prompt = e.prompt;
  if (e.type === 'plan') s.features = e.plan.features;
  if (e.type === 'phase') { s.phase = e.phase; s.current = e.feature; s.paused = e.phase === 'paused'; }
  if (e.type === 'resumed') s.paused = false;
  if (e.type === 'feature_result') (s.attempts[e.feature] ||= []).push(e);
  if (e.type === 'retry') { s.ended = false; s.canRetry = false; }
  if (e.type === 'run_end') { s.ended = true; s.verdict = e.verdict; s.reason = e.reason; s.canRetry = !!e.retryable; loadHistory(); }
}
function select(id) {
  sel = id; es?.close();
  state = { id, prompt: '', features: [], attempts: {}, phase: '', ended: false, paused: false, canRetry: false };
  es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  es.onmessage = (m) => { apply(JSON.parse(m.data)); render(); };
  api('GET', `/api/runs/${encodeURIComponent(id)}`).then(({ body }) => { if (body) { state.canRetry = body.canRetry; render(); } });
  loadHistory();
}
async function start(prompt) {
  const r = await api('POST', '/api/runs', { prompt });
  if (r.status === 201) { $('#msg').textContent = ''; select(r.body.runId); }
  else if (r.status === 409) { $('#msg').textContent = 'A run is already active.'; select(r.body.runId); }
  else $('#msg').textContent = r.body?.error || 'failed to start';
}
$('#presets').onclick = (e) => { if (e.target.dataset.p) $('#prompt').value = e.target.dataset.p; };
$('#start').onclick = () => start($('#prompt').value);
$('#restart').onclick = () => state && start(state.prompt);
$('#history').onclick = (e) => { const li = e.target.closest('li'); if (li) select(li.dataset.id); };
for (const btn of document.querySelectorAll('[data-a]')) btn.onclick = async () => {
  const r = await api('POST', `/api/runs/${encodeURIComponent(sel)}/${btn.dataset.a}`);
  if (r.status >= 400) $('#msg').textContent = r.body?.error || 'action failed';
};
api('GET', '/api/status').then(({ body }) => body ? select(body.runId) : loadHistory());
</script></body></html>
```
- [ ] **Step 2: Manual check:** run `cd server && pnpm start` (no Ivy needed) and open `http://127.0.0.1:4377`. Without an API key the run must end `failed` with a design-phase reason, and the history must update. Check 375px width in browser devtools (no horizontal scroll) and dark mode.
- [ ] **Step 3:** Commit: `feat: web console`.

**Acceptance:** start / 409 / history / verdict banner / artifact links work; buttons are enabled exactly per the rules above.

### Task 17: Windows launchers

> **REVISION REQUIRED before execution (Task 0 evidence, 2026-10-12):** Ivy autosaves and has no manual save. Replace the `save` mode/step with a `reopen` step (close + reopen the document, then `reopenMatches(before, after, ev)` from Task 9). Object keys are uuid strings (`SnapObject.key`/`handle`, `createdIds: Record<string,string>`). With `supported.no_unexpected_modification = false` recovery always stops with `restart required`; add a test for that path. Opus revises this task after Tasks 5–10 land.


**Files:** Create `setup.bat`, `start-all.bat`, `start-harness.bat`, `login.bat`, `stop-all.bat`, `accept.bat` (root), `server/scripts/accept.ts`.

**Interfaces:** Consumes `start-ivy.bat` (Task 2) and the Task 15 API.

- [ ] **Step 1: `setup.bat`** (first-time install)
```bat
@echo off
cd /d "%~dp0"
if not exist .env (copy .env.example .env >nul & echo Created .env - set ANTHROPIC_API_KEY and FRONTEND_URL in it.)
cd server
call pnpm install || exit /b 1
call pnpm exec playwright install chromium || exit /b 1
echo Setup done. Next: start-ivy.bat, then login.bat once, then start-all.bat
```
- [ ] **Step 2: `start-harness.bat`**
```bat
@echo off
cd /d "%~dp0"
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if not defined HARNESS_PORT set "HARNESS_PORT=4377"
start "ivy-harness" cmd /k "cd /d "%~dp0server" & pnpm start"
timeout /t 3 >nul
start "" "http://127.0.0.1:%HARNESS_PORT%"
```
- [ ] **Step 3: `start-all.bat`**
```bat
@echo off
cd /d "%~dp0"
call "%~dp0start-ivy.bat" || exit /b 1
echo Waiting 20s for backend and frontend to come up...
timeout /t 20 >nul
call "%~dp0start-harness.bat"
```
- [ ] **Step 4: `login.bat`**
```bat
@echo off
cd /d "%~dp0server"
echo A browser opens. Log in to Zixel, then CLOSE the browser window to save the session.
call pnpm exec tsx scripts/login.ts
```
- [ ] **Step 5: `stop-all.bat`**
```bat
@echo off
for %%T in (ivy-harness ivy-frontend ivy-backend) do taskkill /FI "WINDOWTITLE eq %%T*" /T /F >nul 2>&1
echo Stopped harness, frontend and backend windows.
```
- [ ] **Step 6: `server/scripts/accept.ts`** (live acceptance; needs everything running)
```ts
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';

const base = `http://127.0.0.1:${config.port}`;
const prompt = process.argv[2] ?? 'Rectangular mounting plate 100 x 60 mm, 8 mm thick';
const start = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
if (start.status !== 201) { console.error('start failed', start.status, await start.text()); process.exit(1); }
const { runId } = await start.json();
console.log('run', runId);
let run: any;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  run = await (await fetch(`${base}/api/runs/${runId}`)).json();
  if (run.events.some((e: any) => e.type === 'run_end')) break;
  process.stdout.write('.');
}
const dir = path.join(config.runsDir, runId);
const results = run.events.filter((e: any) => e.type === 'feature_result');
const failures = [
  run.verdict !== 'passed' && `verdict ${run.verdict}: ${run.events.findLast((e: any) => e.type === 'run_end').reason}`,
  !fs.existsSync(path.join(dir, 'report.html')) && 'report.html missing',
  !run.events.some((e: any) => e.type === 'save_result' && e.ok) && 'model not saved',
  ...results.filter((e: any) => !fs.existsSync(path.join(dir, 'shots', `${e.shot}.png`))).map((e: any) => `screenshot missing for ${e.shot}`),
].filter(Boolean);
console.log(failures.length ? `\nACCEPTANCE FAILED:\n- ${failures.join('\n- ')}` : `\nACCEPTANCE PASSED (${dir})`);
process.exit(failures.length ? 1 : 0);
```
- [ ] **Step 7: `accept.bat`**
```bat
@echo off
cd /d "%~dp0server"
call pnpm exec tsx scripts/accept.ts %*
exit /b %ERRORLEVEL%
```
- [ ] **Step 8:** Smoke-test each `.bat` by hand (`setup`, `start-all`, `stop-all`). Commit: `feat: Windows launchers and acceptance script`.

**Acceptance:** `setup.bat` → `start-all.bat` opens 3 windows plus the console. `stop-all.bat` closes them.

### Task 18: [GATE] Live acceptance + promotion log

**Files:** Create `docs/promotion.md`.

- [ ] **Step 1:** Write `docs/promotion.md`:
```markdown
# Promotion gate log

Rule: an operation type is supported only after 3 consecutive passing `accept.bat` runs of its fixed prompt.
Pass = verdict passed, every feature verified, model saved, all artifacts present. Any failure resets the streak.

| Date | Operation set | Prompt | Run id | Model | harness/mda/ivy SHAs | Verdict | Streak |
|---|---|---|---|---|---|---|---|
```
- [ ] **Step 2 (human):** With Ivy running and the profile logged in, run `accept.bat` three times. After each run, add a row (the SHAs come from the report's Environment line). Any failure means: inspect `report.html` and `bugs.json`, fix the playbook or code through a new task, and restart the streak at 0.
- [ ] **Step 3:** When the streak reaches 3 for `sketch_rectangle + extrude`, Milestone 1 of the product scope (spec §11) is done. Commit `docs/promotion.md`.

**Acceptance:** spec §13 criteria 1–6 are demonstrated by the 3 passing runs plus Tasks 7/13/15 tests (cancel, concurrency, failure diagnostics).

---

## Execution order and dependencies

```
1 → 2 → [3 GATE] → 4 → [4 GATE]
1 → 6 → 9 → 10           (can run while gates are pending)
1 → 7 → 14
8
6 + 9 + [4 GATE] → 5
8 + 1 → 11 → 12 (playbook needs Task 3 notes)
5 + 7 + 9 + 10 + 11 + 12 + 14 → 13 → 15 → 16 → 17 → [18 GATE]
```
Haiku agents implement Tasks 1, 2, 6–17. Opus does Task 4, writes Task 5's code after the gate, and writes the Task 12 playbook files. Humans do Tasks 3 and 18 plus the gate reviews.
