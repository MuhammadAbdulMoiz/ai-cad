# Inspector fields: what Task 0 evidence proves

Source: `server/test/fixtures/inspector/{00..07}` (project 37649139, tag `main`, captured 2026-10-12, all `errors.json` = `{}`).
Captures: 00 empty part · 01 sketch (rectangle 100×60) · 02 extrude 8 · 03 edit sketch 100→120 · 04 delete extrude · 05 failed op · 06 undo · 07 reopen.
The save capture was skipped because the application autosaves. Reopen (`07`) is the persistence evidence.
Reproduce: `node server/scripts/evidence/diff-captures.mjs server/test/fixtures/inspector 01-after-sketch:02-after-extrude` and `node server/scripts/evidence/stable-keys.mjs server/test/fixtures/inspector 06-after-undo 07-after-reopen`. Every claim below cites a file.

**Verdict in one line:** the inspector can prove *structure* (which features exist, their type, their dependency chain, and that they persist across reopen). It **cannot** prove *values* (dimensions), *compute success*, or *that an existing feature was not modified*. So recovery stays **disabled**.

## Q1 Enumeration

- The DOT node id **is** the `objectId` accepted by `zcad_get_object_json`. Every node in every capture has an `objects/<id>.json` (no `noJsonFile`).
- Id regex: `^\s*"?(\d+)"?\s*\[` matches all nodes. Example: `02/graph-full.dot` → 47 nodes, `meta.json nodeIdCount: 47`.
- Two node kinds don't return an object, and the inspector reports **neither as an error**:
  - Node `0` (`ivy::Project`) returns an empty string (`*/objects/0.json`, 0 bytes).
  - The `ivy::PipelineContext <id>` node returns the plain text `Object not found.` with `isError: false` (for example `02/objects/184683594279.json`). Its id changes on every capture.
- ⇒ **The adapter must treat any non-JSON object reply as an error**, except for these two known non-model nodes, which are excluded from enumeration by class (`ivy::Project`, `ivy::PipelineContext`). Saving `Object not found.` as data would be fail-open.
- Completeness: within one session, every feature-bearing object appears. Feature keys match 17/17 (01 vs 04) and 34/34 (02 vs 03, 02 vs 06, 06 vs 07). See Q9.

## Q2 Class

- Class name: JSON path `class_name` (for example `02/objects/600.json`: `"class_name":"ivy::SolidExtrude"`). It also appears as the first token of the DOT label.
- Values seen:
  - Document/tree: `ivy::PartReference`, `ivy::PartRepresentation`, `ivy::FeatContainer`, `ivy::FeatPart` (`1 零件`), `ivy::FeatOriginSet`, `ivy::FeatOriginPlane` (XY/YZ/ZX), `ivy::FeatSolidSet` (`9 零件几何体`, part body set), `ivy::ParmSet`.
  - Sketch: `ivy::FeatSketch` (`12 草图1`) with children `ivy::FeatSupportPositioned`, `ivy::SketchLengthDimension` ×2, `ivy::ParmLength` ×2 (`length`), `ivy::ParmBool` (`Deactivated`).
  - Rectangle entities (lines/points) are **not objects**. The sketch JSON is 638 bytes with no geometry (`02/objects/539.json`).
  - Extrude: `ivy::SolidExtrude` (`40 拉伸1`) with children `ivy::FeatGeomBRep` (`32`), `ivy::ParmLength` (`Depth`, `ThickenLength_0/1`, `OffsetFromStartDistance`, `Direction2Depth`, …), `ivy::ParmAngle`, `ivy::ParmBool`, `ivy::TopoGroup`, `ivy::StableHub`.
  - Non-model: `ivy::VisuContainer`, `ivy::VisuGeomObject`, `ivy::ShapeContainer`, `ivy::TopoContainer`, `BRepContainer`, `ivy::PipelineContext`, `ivy::PartDesignWorkshop` (only after reopen).

## Q3 Feature identity

- New sketch: an object with `class_name == "ivy::FeatSketch"` whose `uuid` was not in the baseline (00→01 adds `539 ivy::FeatSketch 12 草图1`).
- New extrude: `class_name == "ivy::SolidExtrude"`, uuid not in the baseline (01→02 adds `600 … 40 拉伸1`).
- **Identity key = `uuid`**, with fallback `class_name + attr_first_._id + attr_first_._name`. **Handles are not stable across reopen**: in 06→07, handle `539` changes from `ivy::FeatSketch` to `ivy::ParmSet`, and the extrude moves from `600` to `550`. Baseline comparison must key on uuid, never on handle.
- `ivy::FeatPart.attr_tip_feat_` points at the latest feature (`_vValue:[40_600]` = feature #40, handle 600). It is a useful confirmation.

## Q4 Dependencies

- Visible as DOT edges `"<from>" -> "<to>" [label="DependsOn"]`. Not present in the object JSON.
- Extrude → sketch is a **2-hop path**: `600 -DependsOn-> 609` (its `FeatGeomBRep`) and `609 -DependsOn-> 539` (the sketch) (`02/graph-full.dot`). Also `527 FeatSolidSet -DependsOn-> 539, 600`.
- ⇒ `depends_on` is **supported** as reachability over `DependsOn` edges.

## Q5 Compute status

- **UNSUPPORTED.** The only runtime field is `components.GeometryRuntimeComponent.state` = `{"cpp_type":"class std::shared_ptr<…RuntimeState>","inspection":"opaque"}` (`02/objects/600.json`).
- The failed operation (`05`) left **no objects**. Only the id counters moved (`FeatContainer._lastId 48→62`, `TopoContainer._lastId 3→5`). A failed feature is therefore observable only as "no new feature appeared", never as a feature with an error status.

## Q6 Dimensions

- **UNSUPPORTED.** `ivy::ParmLength` objects carry only a name, with no value. For example `02/objects/604.json` (`Depth`) and `02/objects/554.json` (`length`) contain `attr_first_` metadata, `class_name`, `handle` and `uuid` only.
- The sketch edit 100 → 120 (02→03) changed **no model object**. Only `PipelineContext` and `VisuGeomObject` changed. Neither the sketch, its dimension parameters, nor the extrude reflect the edit.

## Q7 Volatile objects and fields

- Volatile classes (new id or replaced on every capture): `ivy::PipelineContext`, `ivy::VisuGeomObject` (563→620→622, plus a stale `674` in 06).
- Legitimately changing fields on pre-existing objects for a normal create (01→02):
  - `ivy::FeatContainer`: `_lastId`, `class_name_id_map_`.
  - `ivy::TopoContainer`: `_lastId`.
  - `ivy::FeatPart`: `attr_tip_feat_`.
  - **`ivy::FeatSketch`: `attr_first_._featOptions` (`…100011` → `…000011`) when the extrude consumes it.** A pre-existing feature's own field changes on a normal operation.
- Serialization isn't stable for equal states. After undo (03 vs 06), the restored extrude and its 15 children gain `component_info.AttributeDefinition.*` and `component_info.FeatureImplementation.*` (15 paths each) that the originally created objects did not serialize. Whole-object JSON hashes therefore differ for the same model.

## Q8 Restoration (decides recovery)

- Delete extrude (04 vs 01): the structure is restored (17/17 feature keys and uuids match). But the sketch keeps `_featOptions …000011`, the consumed state, and the counters keep the higher values. A full-JSON comparison says "not restored".
- Undo (05→06): it reverted the **delete from step 5**, not the failed op of step 6, which created no history entry (06 vs 03: same feature keys, uuids and handles). Undo scope depends on the history stack, which the harness can't see ⇒ **never use Ctrl+Z**.
- **Recovery decision: DISABLED.**
  - Hash comparison is blind to parameter edits (Q6), so "unchanged" can't be proven.
  - It is also noisy for equal states (Q7): stripping enough fields to make delete/undo compare equal (`_featOptions`, `component_info.*`) also strips real state.
  - The fail-closed rule from the spec therefore applies: any failed feature means **restart required**.

## Q9 Reopen

- Handles are reassigned (Q3).
- **`uuid` survives**: 43 of 45 shared, and the 2 that change are `PartReference`/`PartRepresentation` plumbing.
- **Feature keys survive 34/34** (06 vs 07). `attr_tip_feat_` keeps feature `#40` (`[40_600]` → `[40_550]`).
- ⇒ `reopen_matches` is supported as "same set of feature keys (class + `_id` + `_name`) and the same tip feature id".

## Q10 Bodies

- **UNSUPPORTED** as a solid count.
- `ivy::FeatGeomBRep` appears exactly when an extrude exists (0,0,1,1,0,0,1,1 across 00–07). But it is *contained in* the extrude and `DependsOn` the sketch (`02/graph-full.dot`), so it is most likely the extrude's profile/input reference, not the resulting solid.
- No object represents the solid itself. `ivy::FeatSolidSet` (`零件几何体`) depends on the features but carries no count. Counting `FeatGeomBRep` as bodies would be an inference, not evidence.

## Supported checks

| CheckKind | Supported | Evidence | Notes |
|---|---|---|---|
| `feature_exists` | **yes** | Q3 (00→01, 01→02) | new uuid with `class_name` = `ivy::FeatSketch` / `ivy::SolidExtrude` |
| `depends_on` | **yes** | Q4 | reachability over DOT `DependsOn` edges (extrude→BRep→sketch) |
| `status_ok` | no | Q5 | runtime state is `opaque`; a failed op leaves no object |
| `body_count` | no | Q10 | no solid object; `FeatGeomBRep` is an input reference |
| `dimension` | no | Q6 | `ParmLength` has no value; the 100→120 edit is invisible |
| `no_unexpected_modification` | **no** | Q6, Q7, Q8 | blind to parameter edits, unstable serialization ⇒ recovery disabled |
| `reopen_matches` | **yes** | Q9 | feature-key set + tip feature id survive reopen |
| `no_new_console_errors` | yes (browser, not inspector) | — | not an inspector field |

**Weaker structural check worth adding:** `existing_features_intact`. Every baseline feature key (`uuid`, `class_name`, `_id`, `_name`) is still present and unchanged. It is reliable (Q8, Q9) and catches deletions or replacements of earlier features. It does **not** prove parameters are unchanged, so it must never enable recovery.

## What this means for the harness (decisions needed)

1. **Verification ceiling.** v1 can prove "a sketch then an extrude depending on it were created and persist after reopen". It cannot prove "the plate is 100 × 60 × 8" or "the extrude computed successfully".
2. **Recovery.** Off. A failed feature ⇒ run `failed`, restart required.
3. **Closing the gap.** The inspector lives in our own repo (`C:\zixel\ivyproject\zcad_service\mcp_server.cpp`, read-only tools). Exposing `ParmLength`/`ParmAngle` values and the feature `RuntimeState` (ok/error) in `zcad_get_object_json`, plus solid count and volume or bounding box, would make `dimension`, `status_ok` and `body_count` provable. That's a backend change, so it needs its own decision.
