# Protocol spike: building CAD geometry without the UI

> **2026-10-13:** Ivy is now a black box (no Ivy changes). The native-MCP-in-zcad_service plan here is superseded by [the black-box re-plan](specs/2026-10-13-black-box-ivy-integration.md).

Date: 2026-10-12 · **Read-only.** No project was created or mutated during this spike. · Sources: `C:\zixel\mda`, `C:\zixel\ivyproject`.

**Recommendation:** add a small set of **local MCP write tools to `zcad_service`**. Start with one that builds a part from an inline **Toolbox-style feature description** (sketch / extrude / revolve). It runs on the project thread through the same dispatcher the inspector already uses: no auth tokens, no browser automation, server-side failure codes. Verify with the existing inspector, plus the proposed read-only query tools. A direct WebSocket client is the fallback. A frontend bridge is rejected.

## 1. Request chains (what the UI actually sends)

All model traffic goes over the frontend's WebSocket to `zcad_service:8081` as `ivyproto.IvyPkg`. Part edits are `ivypart.PartPkg` bytes inside the app-model request, sent through `IvyPart.modelUpdateReq(pkg, featureId, opts)` with a workshop header `{workbenchType, workshopId, currentDocId}` (e.g. `FeatureScriptPlugin/src/runtime/IvyScript.ts`, `IvySketchPlugin/src/methods.ts:450-483`).

| Step | Message | Key fields | Evidence |
|---|---|---|---|
| Sketch create/update | `PartPkg{header.cmd = IVY_PART_SKETCH_UPDATE_REQ (6), sketch_update_req}` | `SketchUpdateReq{support_brep, geoms[Geom2DData], constraints[], sketch_vertices[], solver_enum, sync_dimension, version, attr_first}`. `Geom2DLine{start,end}` etc., in **mm**. | `ivypart.proto:1477`, `ivysketch.proto:447-600`, `IvySketchPlugin/src/runtime/sketchEditSession.ts:268-295` |
| Sketch response | `SketchUpdateRsp{result}` | `result` = error code | `ivypart.proto:1496` |
| Generic feature (extrude, fillet, hole…) | `PartPkg{feat_update_req: ivytaskpanel.UpdateMessageReq}` | `UpdateHeader{action, feature_id, feature_class_id \| source, data_version}` + `update_items[UpdateItem{attrRole, reals \| ints \| bools \| selection \| sketch \| …}]` | `ivypart.proto` PartPkg body field 107; `ivytaskpanel.proto:422-470` |
| Feature lifecycle | `action`: `Create(1)` → `Modify(2)`… → `Confirm(3)` / `Cancel(4)` | `feature_id` is the tip when creating | `ivytaskpanel.proto:422` |
| Feature response | `UpdateMessageRsp{result}` | failure codes, e.g. `TM_EXTRUDE_FAILED = 10011`, `OPER_EXTRUDE_* = 14050–14068` | `ivypart.proto:532, 723-740` |
| Delete | `IVY_PART_DELETE_REQ (2)` / `DeleteReq` | | `ivypart.proto` PartCommand |
| Read-only queries (verification) | `IVY_QUERY_PARAM_REQ`, `IVY_QUERY_MEASURE_REQ` (volume, AABB), sketch snapshot, constraint status | | `docs/sketch-verification-investigation.md` |

Two things matter here:
- **Extrude parameters are `attrRole` numbers.** They're defined by the backend feature (e.g. `zplugin/part/model/ivysolidExtrude.cpp`). The task panel the UI renders is this same descriptor, so an agent can learn each feature's roles from the server instead of from screen labels.
- **Success is reported explicitly**, via the `result` codes. The inspector couldn't give us that.

## 2. A ready-made parametric builder already exists in the backend

`zplugin/toolbox` builds standard parts **from data**. `ToolboxPartBuilder::BuildFromDescription` (`toolbox_part_builder.h:68`) reads an asset JSON:

```json
{ "features": [
  { "type": "sketch",  "id": "s1", "plane": "XY", "profile": [ { "shape": "rectangle", "width": 100, "height": 60 } ] },
  { "type": "extrude", "id": "e1", "profile": "s1", "depth": 8 }
] }
```

- **Profiles:** `circle`, `polygon`, `rectangle` (`width`, `height`, `cx`, `cy`, `rotation`), and closed `polyline`.
- **Planes:** `XY`, `YZ`, `ZX`.
- **Extrude options:** `depth` (a number or an expression), `operation: add|cut`, `reversed`, `symmetric`, `solid` grouping.
- **Revolve** about the X, Y or Z axis.
- **Expressions** over a size table (`toolbox_library.h:91-190`, e.g. `assets/iso4014-hex-bolt.json`).
- The builder names features `SketchN` / `ExtrudeN` / `CutN` and stops at the first failed step without rollback (`toolbox_part_builder.h:31`).
- It's triggered through a Toolbox plugin command, `ToolboxBuildPartReq{config{assetId, sizeKey, overrides}, documentId, placementIndex}`. The response is `{result, featureIds, solidSetIds, message}` with codes `ERR_SKETCH`, `ERR_EXTRUDE`, `ERR_SOLID` and `ERR_OUT_OF_RANGE` (`ToolboxPlugin/src/adapters/HostCadApiAdapter.ts:84-110`).
- **Limitation:** the request references a *library* asset by id. Assets are read from `resources/toolbox/assets/<id>.json` beside the module (`toolbox_library.cpp:24-34, 673`). There's no inline-asset request today.
- **Capability gaps for full products:** no fillet, chamfer, hole, pattern, shell or offset sketch planes. Sketch planes pass through the origin, and there's a slot placement offset (`placementIndex × 110 mm`, `toolbox_library.h:284`). Those features exist only through the generic `UpdateMessageReq` path.

## 3. Session and authentication (direct client)

`ServerSession::OnOpen` (`zcad_service/server_session.cpp:68-128`) rejects a WebSocket unless the query has all of:
- `projectId`
- `openId`, which must start with `oi_`; its digits become the user id
- `appId`, `1002` for the web client
- `token`
- `tenantId`

`projectTag` defaults to `main`. The token travels with every message event (`_mToken`), which suggests it's used for the cloud VCS storage the project is loaded from and saved to. After joining, the client must also replicate the frontend's workshop and document handshake before model requests are accepted (not traced in full).

⇒ **Direct MCP → `:8081` is technically possible, but it needs the user's live session token** in the harness's config, plus a re-implementation of the frontend's IvyPkg framing, compression and workshop lifecycle. That's a credential-handling and maintenance burden.

## 4. Integration paths compared

| Path | Auth | Effort | Fragility | Verdict |
|---|---|---|---|---|
| **A. Local MCP write tools in `zcad_service`** (localhost `:8083`, project-thread dispatch like the inspector) | None. Runs inside the server that already has the project loaded by the user's session. | Small–medium C++: wrap `ToolboxPartBuilder` with an inline asset (the JSON reader exists, so it's a refactor), then later a generic `UpdateMessageReq` passthrough. | Low. It uses the server's own types. | **Recommended** |
| B. Direct WebSocket client (Node) to `:8081` | Needs user token, openId and tenantId | High: framing, zstd, workshop handshake | High: tracks a private client protocol | Fallback |
| C. Frontend bridge (call `IvyManager` inside the page) | Uses the browser session | Low to try | High, and `mda/AGENTS.md` forbids window bridges | Rejected |
| D. `ivycli` | n/a | n/a | n/a | Not viable: it only does import, export and thickness analysis (`ivycli/cmd*`) |

Path A changes one boundary we set earlier: **the MCP becomes read-write.** The safeguards I propose:
- write tools bind to `127.0.0.1` only (the MCP already does);
- every write requires an explicit `projectId` + `documentId` that you supply;
- writes go through the same undo/notify pipeline the UI uses (to be confirmed, see unknowns);
- the agent never gets an unbounded delete tool.

## 5. Smallest safe proof of concept (not executed)

1. **ivyproject (separate reviewed task):** add `zcad_build_features {projectId, projectTag, documentId, asset}` to `mcp_server.cpp`.
   - It parses the inline asset with the existing `ReadAsset` logic and runs `ToolboxPartBuilder::BuildFromDescription` on the project thread.
   - It returns `{result, message, featureIds, solidSetIds}` and fails closed (`isError`) on any non-OK result.
   - Bundle it with the four read-only query tools from `docs/sketch-verification-investigation.md`.
2. **Live test on a project you supply** (never auto-created, never "last listed"):
   - Submit the 100 × 60 rectangle + 8 mm extrude asset above.
   - Expect `result = OK` and two feature ids.
   - Inspector diff: exactly one new `ivy::FeatSketch` and one `ivy::SolidExtrude`, the extrude depending on the sketch, existing features intact.
   - Query tools: volume 48000 mm³, AABB 100 × 60 × 8.
   - The browser (harness Chrome) shows the result as the viewport.
3. **ai-cad:**
   - The orchestrator's executor becomes "call MCP tool" instead of "drive the UI".
   - The planner emits the asset JSON. Its schema is already close to our `plan.ts`.
   - The verifier, run store and reports stay as built.

## 6. Unknowns and blockers

1. Whether a model change made through `ExecutePipelineRequest` (outside a client session) **broadcasts to the open browser session** and records **undo marks**. `project.cpp` has `BroadCastToSession`, but the path is unconfirmed. If it doesn't, the UI won't refresh until reload.
2. `documentId` for a part. The editor URL's `id=` parameter is likely the document id (e.g. `id=37649889&projectId=37649888`). This needs confirming against the inspector's document stable id.
3. Toolbox slot placement for `placementIndex = 0`: does it place at the origin?
4. `attrRole` ids and `feature_class_id` per feature (extrude, fillet, hole…) for the later generic path. These need tracing in `zplugin/part/model/*`, or capturing from the server's task-panel descriptor.
5. Concurrency: an agent build while the user edits the same project. Serialised on the project thread, but semantically unguarded.

**Checks that stay unsupported until verified live:** `dimension`, `status_ok`, `body_count` (they need the query tools), and recovery (still disabled).
