# Black-box Ivy integration: re-plan

Date: 2026-10-13 · Status: **decisions recorded (§9); Phase 1 (watch-only) awaiting go-ahead** · Read-only investigation: no request was sent to a live `zcad_service`, and no file in `ivyproject` or `mda` was modified.

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
- **Sent frames** are plain `IvyPkg` (`ProtoSocketService.ts:476-484`).
- **Received frames:**
  - Strip the trace-header prefix (`getBinaryFramePayload`).
  - Reassemble chunks; a chunk under 512 KB ends a message (`ProtoSocketService.ts:66, 700-735`).
  - Decompress with Node's built-in zstd.
  - Keep raw tessellation frames (`DocumentTessellationProtocol.ts:617`) aside for D3.
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
