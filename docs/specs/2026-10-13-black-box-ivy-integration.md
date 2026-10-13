# Black-box Ivy integration: re-plan

Date: 2026-10-13 · Status: **Phase 1 captured. Results and corrections in [session-protocol-capture.md](../session-protocol-capture.md), notably: no Confirm action (the commit is a non-preview Modify); cancel sends nothing; a failed commit leaves an undo mark. Phase 2 awaits review.** · Read-only investigation: no request was sent to a live `zcad_service`, and no file in `ivyproject` or `mda` was modified.

**Supersedes:**
- protocol-spike.md §4 path A and §5 (native MCP write tools in `zcad_service`);
- ai-native spec §2 ("Tools" row), §3B, §5.1 (documentId assumption) and §10 milestone 2;
- the unbuilt `zcad_service` MCP plan.

**Boundary (project vision §2):** Ivy (the `ivyproject` backend and the `mda` frontend) is a black box. We may read its source to learn behaviour, but we never change it, never add hooks or APIs, and never rely on a modified build. Everything new lives in `ai-cad`.

## 1. What changes, and why

| Earlier assumption | Under the boundary | Replacement |
|---|---|---|
| New MCP write and query tools in `zcad_service/mcp_server.cpp` | Forbidden: it changes Ivy | Send the same requests through Ivy's **existing session protocol**, from `ai-cad` (§3) |
| Inline Toolbox asset (new proto field + reader refactor) | Forbidden. The unmodified Toolbox builds **library assets by id only** (`zplugin_v1/toolbox/workbench/toolbox_task.cpp:246-251`, `toolbox_resolve.cpp:78`). | The plate uses the generic **sketch + extrude** requests the UI sends. The Toolbox is kept for real standard parts later. |
| Writing asset JSON files into Ivy's `resources/toolbox` | Forbidden: it edits Ivy's deployment. The library is also read once and cached (`toolbox_library.cpp:709-725`), so it would need a restart. | Rejected |
| Adding `volume` to the V1 part measure query | Forbidden. Today `BuildMeasureQueryResult` **never sets volume** (`zplugin_v1/part_design/workbench/part_design_runtime_serializer.cpp:956-990`). | Volume is not a measured value. §5 lists the options. |
| `documentId` = editor URL `id=37649982` | **Wrong.** The URL `id` is the cloud *appfile* id (`mda/apps/pc/src/views/zcad/index.vue:207,250`), which `zcad_service` never sees. The server's `doc_id` is the runtime ObjectManager handle (`app_framework/app_document_dto_util.cpp:79`). | Resolve the target as in §4 |
| `executor.ts` reply `{result:'OK', featureIds}`; `MeasureZ` requires `volume_mm3` | That reply shape came from the planned MCP tool | Map from the real responses (Phase 1). Volume becomes optional/unsupported. Units: Ivy measures in **metres**. |
| `featureplan.ts` mirrors the Toolbox asset reader | That mirror was tied to the inline-Toolbox backend | The validator mirrors what the **captured generic requests** support. Expressions are evaluated in `ai-cad` before sending. |

## 2. What unmodified Ivy exposes at runtime

| # | Surface | R/W | Auth | Verdict |
|---|---|---|---|---|
| 1 | MCP inspector `127.0.0.1:8083/mcp`: list projects, object graph/JSON, undo marks, pipeline history (`zcad_service/mcp_server.cpp:105-148`) | Read | none (localhost) | **Keep** for structure, identity and undo evidence. `ai-cad` never sends raw `InspectorReq`: that message also has `remove_object_id` / `remove_relation_*` mutators (`zplugin_v1/inspector/inspector_request.cpp:88-120`), which the MCP tools don't expose. |
| 2 | Session protocol: WebSocket `:8081`, `ivyproto.IvyPkg` | Read + write | `projectId, openId, appId, token, tenantId` required at open (`zcad_service/server_session.cpp:68-112`); the token travels with project events (`:127`) | **The only write surface for custom geometry.** Carries `PartPkg.sketch_update_req`, `feat_update_req` (`UpdateMessageReq`), `QueryReq` and Toolbox `plugin_req`. |
| 2a | …reached through the editor page's existing `window.__mda_ivySocketService__` (`mda/packages/IvyCorePlugin/src/socket/ProtoSocketService.ts:166-169`). It's a cross-iframe contract mda itself uses (`Drawing/src/manager/DrawingIvyManagerV3.ts:3859`). `getAsyncMessage(cmd, pkg, {timeout})` encodes with the page's protobuf bundle and resolves with the reply (`ProtoSocketService.ts:487-530`). | Read + write | The user's existing browser session. `ai-cad` holds no credentials. | **Recommended** (decision D1/D2) |
| 2b | …reached through an `ai-cad` WebSocket client | Read + write | The user's token, openId and tenantId stored in `ai-cad` config | Fallback. It means re-implementing framing (the server streams zstd chunks, `app_framework/network_system.cpp` around line 340) and the join/workshop handshake. |
| 3 | HTTP `:8082` platform callbacks: createfile, updatefile, deletefiles, copyfiles, imported, model-export, get-product-nodes (`zcad_service/http_request.cpp:1116-1121`) | Platform ops | Platform user and tunnel context | Not a build surface. `model-export` returns a job id and uploads to the platform (`http_request.cpp` around 545-575); it could be an independent geometry source later, but that's unproven. |
| 4 | ZCF editable-model import (`ivyproject/docs/zcf/README.md`) | Write | session | Rejected: `ai-cad` would have to produce Ivy's private EntityGraph serialization. |
| 5 | Browser UI automation | Read + write | session | Fragile (Task 0 experience). Kept for presenting results, screenshots and console checks, and as a last resort. |

## 3. Recommended integration

**Transport: 2a.** The harness-owned Chrome (`config.cdpPort`) runs `page.evaluate` against the page's existing socket service.

Why 2a:
- No credentials leave the browser.
- The requests are the same ones the UI sends, so undo, save, notifications and version control follow Ivy's normal path.
- The user's viewport shows the result live.

Costs:
- `__mda_ivySocketService__` and `getAsyncMessage` are internal mda contracts, not a published API, so they're tied to the mda version.
- Mitigation: a startup probe checks that the global exists, that `getAsyncMessage` is a function, and that its `projectId` and tag match the target. If any check fails, `ai-cad` fails closed and doesn't fall back.

**Operations for the plate:** the generic part path.
- Sketch: `IVY_PART_SKETCH_UPDATE_REQ` with geoms, constraints and dimensions (`ivyproto/proto/ivypart.proto:1477`).
- Extrude: `feat_update_req` with `UpdateAction` Create(1) → Modify(2) → Confirm(3), or Cancel(4) (`ivyproto/proto/ivytaskpanel.proto:424-430`).
- Exact payloads aren't known yet; Phase 1 captures them.
- The executor's one-feature-per-call `IvyPort` seam fits this path.
- The Toolbox doesn't: it builds a whole asset per call into a **new `FeatSolidSet`** per solid (`toolbox_part_builder.cpp:193-221`; slot 0 means no offset, `:498`). It returns later only for library standard parts (bolts, pins, keys).

**Port allow-list (keeps reads and writes separate):**
- **Reads:** `QueryReq` with PARAM, MEASURE, DOC or META, plus the inspector MCP tools.
- **Writes:** sketch update and `feat_update_req` only, and only through the write path, after the identity check.
- The port rejects any other command.
- A request type joins the allow-list only after Phase 1 has captured it and its arguments have a typed validator.
- **The planner never builds protocol messages.** It emits a validated `FeaturePlan`, and the port alone turns approved plan steps into requests.
- Accepting the browser hook doesn't make every internal Ivy request safe.

**Approval gate:** Claude proposes, `ai-cad` validates, and the human authorizes each write. This stays until the safeguards are proven.

## 4. Target identity (vision §5)

**Facts:**
- The server keys projects by `(projectId, projectTag)`.
- The tag is the active branch. The page may send an empty tag, which the server treats as `main` (`index.vue:265-266`, `server_session.cpp:80-84`).
- The URL `id` is provenance only.
- The document id is a runtime handle. It **changes on reopen**, and even the `PartReference` uuid changed across reopen (`docs/inspector-fields.md` Q3, Q9).

**Procedure (all reads):**
1. Read `projectId` and the tag from the page's socket service (`ProtoSocketService.ts:165,252`). Both must equal the human-supplied target.
2. `zcad_list_projects` must list that `(projectId, tag)`.
3. Take the candidate documents from the `ivy::PartReference` nodes in the inspector graph. Cross-check against the active workshop's `current_doc_id`, which is visible in captured traffic (Phase 1 shows which read reports it reliably). The human confirms the document by name.
4. **Bind** `{projectId, tag, handle, uuid, name, tip feature}` and record it in `run_config`.
5. **Immediately before every write**, re-read handle → uuid and class with `zcad_get_object_json`. Any mismatch, or an editor that isn't idle (an open task panel or sketch session), aborts the write.

**Gap:** unmodified Ivy has no compare-and-set on document identity, so a short race remains between the check and the write. Mitigations:
- Operations are serialized: one request in flight, and the next is sent only after the previous reply and snapshot.
- The active document is re-verified immediately before each dispatch.
- The run stops if the document or the tip feature changed.
- The human doesn't edit during a run, and every write is approved.

These **reduce the race but cannot eliminate it**, and reports say so.

## 5. Verification without Ivy changes

| Property | Interface | Status |
|---|---|---|
| New feature exists; its class, `DependsOn`, persistence across reopen | inspector | **Supported** (Task 0) |
| Sketch dimensions and extrude `Depth` values | `QueryReq IVY_QUERY_PARAM_REQ {docId, parmSetId, paramIds:[-1]}`. Needs only `doc_id`, no workshop (`app_framework/query_system.cpp:42-58,100-112`). | Prove live (Phase 2) |
| Bounding box | `QueryReq IVY_QUERY_MEASURE_REQ`. Needs **exactly one face element** `{feature_id, face index}` and returns the body's AABB in **metres** (`part_design_runtime_serializer.cpp:956-990`). | Prove live (Phase 2) |
| Volume | **Not returned** by the V1 part measure. The proto3 default is 0, so a 0 or missing volume means *unsupported*, never a value. | D3: measured from the mesh only if the mesh passes topology checks (§9). A dimension-based volume is always labelled *derived*. |
| Sketch solve status, committed sketch geometry | V1 Sketch-workbench commands through `app_model_req` with a workshop header (`zplugin_v1/sketch/workbench/sketch_workbench.cpp:42-60`). That path can request saves and history (`zplugin_v1/modeling_systems/src/model_update_system.cpp:425-510`). | **Unsupported** until a live run shows the undo history unchanged |

## 6. Failure, timeouts, partial changes

- **Unconfirmed feature fails:** Cancel(4) is the UI's own action, but **it isn't assumed to roll back**.
  - Its effect is first observed in Phase 1 on a disposable document, by comparing the feature graph before and after a human cancel.
  - Until that proves cleanup, any failure stops the run and reports the partial state from snapshot evidence. The executor never sends Cancel as a recovery step.
- **Run fails after committed steps** (for example, the sketch exists but the extrude failed): report the partial state with snapshot evidence. Repair stays "revised plan rebuilt into a different, approved document" (`server/src/executor.ts` `rebuild`). Deleting our own features is decision D4.
- **Timeout:** the request may still run on the project thread. The outcome is UNKNOWN: stop, take a snapshot, report. Never retry.
- **Every reply is untrusted.** A build counts as successful only on snapshot plus query evidence (existing executor rule).

## 7. Phases (all code in `ai-cad`)

| Phase | Work | Live interaction | Gate |
|---|---|---|---|
| 0 | This document; mark the superseded sections | none | done here |
| 1 | **Protocol discovery, watch-only.** Procedure in §7.1. Output: `docs/session-protocol-capture.md`. | Observe only; `ai-cad` sends nothing | Your go-ahead, then you do the UI work |
| 2 | **Read-only port.** Capability probe; PARAM and MEASURE queries on the Task 0 part; `zcad_get_undo_history` must be identical before and after. Record measured values. | Read requests | Approval to send reads |
| 3 | **Write port with a mock.** Sketch/extrude replaying the captured shapes, allow-list, identity re-check, Cancel on failure, UNKNOWN on timeout. Unit tests against a mock socket in `server/test`. | none | — |
| 4 | **Review:** execution path, failure behaviour, identity checks, verification | none | Explicit approval |
| 5 | **First live plate build** on the approved target (§8) | Writes | Per-build approval |
| 6 | Natural-language request → `designer.ts` plan → build → verify → present. Then image references, edits to existing designs, brackets, Toolbox standard parts, assemblies. | Writes | Per-build approval until safeguards are proven |

**The first milestone is narrow:** `ai-cad` safely reproduces one sketch-and-extrude workflow it has watched in unmodified Ivy, and verifies the result. Autonomous design (phase 6) starts only after that.

**Acceptance strength, in order:** feature graph + bounding box first. Mesh volume is added only once D3's checks pass. A missing measurement is reported as missing.

### 7.1 Phase 1 procedure (watch-only)

**Recorder** (`server/scripts/capture.ts`, new):
- Attaches a CDP session to the harness Chrome page that's already open.
- **Records only.** No `page.evaluate`, no request, no click.
- For every WebSocket frame it appends `{t, direction, opcode, base64}` to `runs/capture-<label>/frames.jsonl`.
- It takes inspector snapshots (the existing probe) when the human marks the start and end of each step.

**Decoder** (`server/scripts/decode-capture.ts`, offline, on saved files):
- **Both directions:**
  - Strip the optional 35-byte `'Z',1` trace header. The page omits it for `use_local_server` unless `enable_ws_header` is set (`ProtoSocketService.ts:1212-1217, 1588-1594`).
  - Reassemble chunks; a chunk under 512 KB ends a message. An exact multiple of 512 KB is followed by an empty frame (`:66, 700-713, 2051-2074`).
  - `sendMessage` sends one unchunked frame (`:485`).
- **Received messages only:** zstd-decompressed after reassembly (`:745`). The result may be an `IVYDOC01` envelope around the `IvyPkg` (`DocumentTessellationProtocol.ts:231-265`).
- **Raw `IVTR` mesh frames:** these bypass reassembly. Each one is checked against its 64-byte header (`DocumentTessellationProtocol.ts:617-660`) and kept for D3.

Implemented in `server/src/wsframes.ts`. Any message that fails reassembly, decompression or decoding is listed as undecoded in `summary.json`.

**Run (you start Ivy, the harness Chrome and the project; the scripts only observe):**
1. `login.bat`: keep that Chrome window open, log in, and open the disposable part.
2. `pnpm capture <label>`: attaches to the single `/zcad` tab. Then press **F5 yourself**, because sockets opened before the recorder attached aren't seen. Type marks such as `start sketch` / `end sketch`, and `quit` to stop.
3. Run `pnpm probe <label>-<step> --project <id>` yourself at each step boundary, as in Task 0.
4. `pnpm decode-capture <label>` (offline) writes `decoded.jsonl` and `summary.json` beside the untouched `frames.jsonl`.

The socket URL's `token`, `openId` and `tenantId` are redacted before anything is written.
- Decoding uses `protobufjs` (the one new dependency) with Ivy's `.proto` files, which are read in place and never copied or edited.

**Safeguards (agreed 2026-10-13):**
- **Recorder.** The recorder reaches the browser only through a fail-closed DevTools wrapper that allows only `Network.enable` and detach. Any other command throws.
- **Wrapper tests.** The wrapper is tested on its own against a fake connection: allowed commands pass, and every other command (`Runtime.*`, `Input.*`, `Page.*`, raw sends) is refused before reaching the connection.
- **Source scan.** A scan of the recorder's source for page actions is an extra guardrail only. It proves nothing about the recorder's inability to send.
- **Decoder order.** Received responses are reassembled from their chunks first, following framing rules checked against the captured bytes. Only the reassembled message is decompressed and decoded. Individual chunks are never expected to decompress on their own.
- **Raw frames.** Original frames are kept untouched beside every decode result. Messages that fail reconstruction or decoding are listed as *undecoded*, with their frame indexes and byte counts, so they can be diagnosed.
- **Test data.** Decoder tests use only captured bytes.

**Your steps** (in a disposable project and part; each step is bracketed by start/end marks):
1. Open the empty part and stay idle (baseline: heartbeats and background traffic).
2. Draw a rectangle sketch on XY, 100 × 60, and exit the sketch.
3. Extrude 8 mm and confirm.
4. Start a second extrude, change its depth once, then **Cancel**. This is the cancel-rollback evidence.
5. Attempt a failing operation (depth 0 or no selection). This shows the failure reply.
6. Do nothing for 30 s, then close the editor tab.

**Output (`docs/session-protocol-capture.md`) for each step:**
- The exact request/response/notification sequence.
- Required fields and how they relate across messages: `workshop_head`, `feature_id`, `feature_class_id`/source, `attrRole` items and units.
- Result codes and failure replies.
- Where the active document id and tip feature appear.
- Undo-history and graph differences, including **what Cancel left behind**.
- What the tessellation frames contain (mesh, topology, units).

**Exit:** you review the capture and this plan before authorizing Phase 2.

### 7.2 Phase 2 proposed scope: read-only queries (awaiting approval)

**Target:** the plate1 document. Project `37649921`/`main`, part handle `540` (`ivy::PartReference`), `Sketch2` = feature 15, `Extrude1` = feature 43.

**2a. Watch-only measurement capture (no `ai-cad` requests).**
- The measure request (`IVY_QUERY_MEASURE_REQ`) hasn't been observed yet. Its shape is known only from source (`part_design_runtime_serializer.cpp:956-990`: exactly one face element `{featureId, face id}`, returning the body's AABB).
- With the recorder attached, you use Ivy's own measure tool once on a face of `Extrude1`. The real request and reply are then captured. **If the UI never sends `IVY_QUERY_MEASURE_REQ`, the measure query stays out of 2b**, and Phase 2 reports AABB as unsupported. We don't fall back to a guessed payload.

**2b. Replaying observed read requests.**
- **Transport:** a new `QueryPort` that is separate from the recorder (the recorder's DevTools wrapper stays untouched). It runs **one fixed page function** that calls `window.__mda_ivySocketService__.getAsyncMessage(IVY_QUERY_REQ, pkg, {timeout})`.
- **Allow-list:** the port accepts only a typed request: `param {docId, parmSetId, paramIds:[-1]}` or `measure {docId, featureId, faceId}` (only if 2a captured it). The port builds the package from the shape observed in the capture, and nothing else reaches the page. The port's tests check that every other command, query kind or field is refused before anything runs in the page.
- **Startup probe:** the global exists; `getAsyncMessage` is a function; its project id and tag equal the target. Otherwise fail closed.
- **Recorder:** it runs alongside, so the exact bytes `ai-cad` sends and receives are evidenced.

**Procedure (each step fails closed):**
1. **Identity.** The `currentDocId` in the page's own captured traffic must equal 540, and the inspector object 540 must be `ivy::PartReference` in project `37649921`/`main`. You confirm the document.
2. **Pre-state.** `zcad_get_undo_history` (all marks: ids, counts, current mark, can-undo/redo), plus an inspector graph snapshot.
3. **Queries.** One PARAM query, then, if 2a captured it, one MEASURE query on feature 43, face 0. Serialized and sent once, with no retry. A timeout is reported as unknown.
4. **Post-state.** The same snapshots as step 2. **Pass only if the undo history is identical, and the graph is identical apart from the volatile classes** (`PipelineContext`, `VisuGeomObject`). Any other difference, including `FeatContainer._lastId`, fails and is reported.
5. **Consistency, with no trust in unit labels.**
   - Take the parameter values (sketch 100, 60 and, if present, extrude depth 8) and the measured AABB extents.
   - Accept only if one scale factor maps all three onto the extents within tolerance, and that factor is 1 (mm) or 0.001 (m). That factor becomes the established unit.
   - Expected extents: 100 × 60 × 8 mm. Expected AABB: x −89.79…10.21, y −41.52…18.48, z 0…8 mm, or in m if the factor says so.
6. **Report.** Values observed, the unit established (or not), state unchanged (or the difference), and the raw evidence paths.

**Fail closed on:**
- an identity mismatch;
- a missing or changed page global;
- a malformed or non-OK reply (`result ≠ 0`, missing fields);
- a measurement that isn't supported;
- inconsistent scale factors;
- any state change.

**Explicitly excluded:** preview, `Create`/`Modify`, commits, sketch updates, cleanup, undo/redo, retries.

**Volume** stays **unsupported**. Phase 2 makes no claim that the solid is verified; AABB plus parameters is the most it can prove.

**Known caveat:** the failed commit's leftover mark #22 is already in this document's undo stack. Phase 2 only checks that the queries don't change it, and doesn't interpret it.

**Impact on existing code:**
- Keep `inspector.ts`, `snapshot.ts`, `checks.ts`, `store.ts` and `designer.ts`.
- `executor.ts`: the reply mapping, `MeasureZ` and `plateAcceptance` need changes (optional volume, metres, no pass without evidence).
- `featureplan.ts`: drop the Toolbox-mirror rules that don't apply to the generic path; `toToolboxAsset` is retired for the plate.
- `browser.ts`: also hosts the transport.

## 8. Acceptance for the first live plate (Phase 5; do not run before Phase 4)

On the approved target, build a 100 × 60 mm rectangle sketch on XY and an 8 mm blind extrude.
- The inspector diff shows exactly one new `ivy::FeatSketch` (with its `ivy::FeatSupportPositioned`) and one new `ivy::SolidExtrude` that `DependsOn` it. Every baseline feature key is unchanged.
- PARAM: the sketch lengths and `Depth` are read back.
- MEASURE: the AABB extent is recorded as observed. The expected 0.1 × 0.06 × 0.008 m is a hypothesis until measured. Placement depends on where the plan puts the rectangle.
- Volume: as decided in D3. The expected 4.8e-5 m³ (48000 mm³) stays a hypothesis.
- Undo history gains the expected entries only. The browser shows the part without a reload.

## 9. Decisions (recorded 2026-10-13)

| | Decision | Consequence |
|---|---|---|
| D1 | **Transport via the open editor page (2a).** | No credentials in `ai-cad`. |
| D2 | **The `__mda_ivySocketService__` hook is accepted conditionally.** It's an existing runtime interface but not a stable API. | Startup probe; fail closed if its behaviour changes. Only allow-listed, validated request types (§3). |
| D3 | **Volume from the mesh, only if reliable.** | The mesh must be closed and manifold with consistent orientation before volume is computed. Otherwise report the bounding box only, and label any computed volume *derived*. Never substitute 0, and never present a derived value as measured. |
| D4 | **Report first. Clean up only with explicit approval.** | No automatic deletes or Cancel-as-rollback while ownership or rollback safety is uncertain. |
| D5 | **The human creates rebuild documents** for now. | Document lifecycle stays outside the first implementation. Never a new project. |

## 10. Gaps the boundary leaves open

- No custom or inline geometry through the Toolbox.
- No volume from the V1 part measure.
- No atomic identity check for writes.
- No public, versioned API: the session protocol and the page global are internal. Mitigations: version pinning and the startup probe.
- Sketch status and snapshot reads aren't proven free of side effects.
