# Sketch and geometry verification: where the truth lives

Date: 2026-10-12 · Read-only investigation, no production code changed · Follows `docs/inspector-fields.md`.

**Short answer.** Sketch geometry, dimensions, solve status and solid geometry **are** held by `zcad_service`. The frontend already reads them through **existing read-only queries**. The MCP inspector just doesn't expose those queries: its `zcad_get_object_json` serializes reflected attributes only.

The trustworthy fix is a **thin MCP wrapper over the existing queries**. It needs no new model serialization, no WASM/sketch-runtime access, and no UI scraping.

## 1. Where sketch geometry and dimension values live

| Data | Owner | Evidence |
|---|---|---|
| Solving while editing | Sketch solver from `ivyproject/zplugin/sketch`, compiled to WASM and run **in the browser**. Debug mode can use a native `wasm_sketch_ws` over WebSocket instead. | `mda/packages/IvySketchPlugin/src/runtime/sketch-runtime/SketchRuntime.ts`, `wsSketchAdapter.ts` ("is wasm_sketch_ws running?"), `ivyproject/zplugin/sketch/wasm/CMakeLists.txt` |
| Committed sketch (geometry, constraints, dimensions, solve diagnostics) | `zcad_service`: the frontend commits the solved sketch with `ivypart.SketchUpdateReq` | `ivyproto/proto/ivypart.proto:1477`; `ivysketch.proto:480` `SketchFeatureData { geoms, constraints, dimension_data, sketch_solve_data, version }` |
| 2D geometry values | `ivysketch.Geom2DData`: `line {start,end}`, `circle {center,radius}`, `arc`, … | `ivysketch.proto` (`Geom2DLine`, `Geom2DCircle`) |
| Sketch solve status | `SketchFeatureSolveData.solve_status` ∈ `SUCCESS / FAIL / PARTIALLY_SOLVED / INCONSISTENT`, plus DOF and conflicting/invalid constraints | `ivysketch.proto:517`, enum `SolveStatus` |
| Dimension and feature parameter **values** (sketch `length` ×2, extrude `Depth`, …) | `zcad_service` parameter table (`ivy::ParmSet` "参数集") | `IVY_QUERY_PARAM_REQ` with `{docId, parmSetId, paramIds:[-1]}` returns `featureParams[]` + `params[]` (`ParmData`, with `value`), used by `IvyPartPlugin/src/runtime/IvyParmSet.ts:318` |
| Solid geometry | `zcad_service` B-rep | `IVY_QUERY_MEASURE_REQ` returns `MeasureResult { volume, aabb_min, aabb_max, center_of_shape }` (`ivyproto.proto` `MeasureResult`) |

Why the inspector missed the 100 → 120 edit: the value lives in the parameter table and in the committed `SketchFeatureData`. Neither is a reflected attribute of the `ivy::ParmLength` / `ivy::FeatSketch` objects that `zcad_get_object_json` serializes (`inspector-fields.md` Q6). **The sketch did change. The inspector simply isn't looking where the value lives.**

## 2. Can the values be queried reliably before and after an edit?

Yes, from `zcad_service` (the authority), with existing read-only requests:

| Need | Existing request | Read-only? | Evidence of use |
|---|---|---|---|
| Sketch geometry (actual line endpoints → 100 × 60) | `ivypart IVY_PART_SKETCH_REFERENCE_READ_REQ` (header `featureId` = sketch) → `ivysketch.SketchSnapshotResponse { result, sketch }` | Commented "Read the committed model snapshot" (`ivysketch.proto:585`); the frontend calls it with `save:false, beCommand:false` | `IvySketchPlugin/src/runtime/sketchEditSession.ts:520-545` |
| Sketch solve status | `ivypart SketchConstraintStatusQueryReq { sketch_id }` → `{ result, solve_data, version }` | yes (query) | `ivypart.proto:434` |
| Dimension and Depth values | `IVY_QUERY_PARAM_REQ` | yes (query) | `IvyParmSet.ts:318` |
| Extrude produced the right solid | `IVY_QUERY_MEASURE_REQ { doc_id, measure_elements[{instance_id, brep_object}] }` → `volume`, `aabb_min/max` | yes (query) | `ivyproto.proto` `MeasureQuery` / `MeasureResult` |

For the Task 0 plate, the before/after values these would show are: rectangle edges 100/60 → 120/60, `Depth` 8, volume 48000 → 57600 mm³, AABB extent (100, 60, 8) → (120, 60, 8). A full "verify the 100 → 120 edit" needs one live capture through the new tools.

**Not verified yet (needs a live call):** whether the query handlers need a workshop header or session `user_id` when they're dispatched outside a browser session, and what `brep_object` reference `MeasureQuery` needs for "the part body". Neither is a design blocker.

## 3. Integration into the harness without UI-text or screenshot checks

| Option | Verdict |
|---|---|
| **A. Extend the MCP inspector with read-only tools wrapping the existing queries** (`zcad_query_params`, `zcad_read_sketch`, `zcad_sketch_status`, `zcad_measure`) | **Recommended.** `ProjectManager::ExecutePipelineRequest` is a general project-thread dispatcher. It already runs inspector, `IVY_MODEL_EXPORT_REQ` and `IVY_GET_PRODUCT_NODES_REQ` requests for the HTTP adapter (`zcad_service/http_request.cpp:561,724`, `app_framework/project_mgr.cpp:313`). Each tool is about 30-60 lines in `mcp_server.cpp`: build the `IvyPkg`, dispatch, return the protobuf as JSON. The harness keeps one independent, read-only channel, and the agent keeps no access to it. |
| B. Harness calls frontend internals through `page.evaluate` (`workshop.queryReq`) | Rejected. Modules aren't on `window`, `AGENTS.md` forbids adding window bridges, and it would make verification depend on frontend internals and the same session the agent drives. |
| C. Harness speaks the frontend WebSocket protocol to `:8081` directly | Rejected. It means re-implementing session handshake, auth, protobuf framing and zstd: fragile, with high upkeep. |
| D. Query the WASM sketch runtime or `wasm_sketch_ws` | Rejected. That's the *editing* solver state, not the committed model. A sketch can be edited in the runtime and never committed. The authority is the committed `SketchFeatureData` in `zcad_service`. |
| E. Read values from UI dialogs or screenshots | Rejected (spec): not independent of the agent's own UI session. |

## 4. Is a backend inspector extension still necessary?

**Yes, but a small one.** It wraps queries that already exist and doesn't add new model introspection:
- **Extrusion success:** there is no feature status field in the protocol (`inspector-fields.md` Q5: runtime state is `opaque`). The measured solid is stronger evidence anyway: a correct `volume` and AABB after the extrude proves the solid was computed with the right shape.
- **Sketch validity:** `solve_status == SUCCESS` from `SketchConstraintStatusQueryReq`.
- **Dimensions:** `IVY_QUERY_PARAM_REQ` values plus `SketchSnapshotResponse` geometry.
- `body_count` stays unsupported unless the measure call can enumerate solids. Volume and AABB of the part body cover the plate case.

## Proposed follow-up (separate reviewed task, in `C:\zixel\ivyproject`)

Add read-only MCP tools to `zcad_service/mcp_server.cpp`, following the existing `RunInspector` pattern. Each tool returns protobuf→JSON and fails closed (`isError: true`) on any non-OK result:
1. `zcad_query_params {projectId, docId, parmSetId}` → `IVY_QUERY_PARAM_REQ`.
2. `zcad_read_sketch {projectId, docId, sketchFeatureId}` → `IVY_PART_SKETCH_REFERENCE_READ_REQ`.
3. `zcad_sketch_status {projectId, docId, sketchId}` → `SketchConstraintStatusQueryReq`.
4. `zcad_measure_part {projectId, docId}` → `IVY_QUERY_MEASURE_REQ` on the part body.

Acceptance:
- Re-run the Task 0 capture with these tools.
- The 100 → 120 edit must show up in both the params and the sketch geometry.
- Volume and AABB must match 100×60×8 → 120×60×8.
- A failed op must leave the values unchanged.
- The tools must change no model state: `zcad_get_undo_history` stays the same before and after a call.

Only after that capture is reviewed do `dimension`, `status_ok` (as sketch solve status + measured solid), and a volume/AABB acceptance check become supported in `evidence.json`.

## Meanwhile (unchanged)

- Task 5 implements only the evidence-backed checks: `feature_exists` (uuid + class), `depends_on` (DOT `DependsOn`), `reopen_matches` (feature keys), and `existing_features_intact` (structural only).
- `dimension`, `status_ok`, `body_count` and `no_unexpected_modification` stay **unsupported**. Recovery stays **disabled**.
- Task 5 doesn't start until you've reviewed this and `inspector-fields.md`.
