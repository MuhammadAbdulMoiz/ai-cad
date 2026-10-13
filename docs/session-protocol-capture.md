# Session protocol capture: plate1 (Phase 1, watch-only)

Date: 2026-10-13 · Re-plan §7.1 · **Observation only.** `ai-cad` sent no WebSocket message, ran no page script and performed no UI action. The human did all the modelling. No Ivy or mda file was changed.

**Setup:**
- Project `37649921`, tag `main`; editor URL `id=37649922`. The disposable part was opened in the `login.bat` Chrome.
- The recorder (`pnpm capture plate1`) was attached through `ReadOnlyCdp`, which allows `Network.enable` only.
- Inspector probes `plate1-<step>` were taken at each step end (`server/test/fixtures/inspector/plate1-*`, all `errors.json` = `{}`).

**Evidence:**
- `runs/capture-plate1/frames.jsonl`: **513 records** (493 WebSocket frames + 17 marks + 3 socket-opened events), raw and **gitignored**, because received headers carry the user's openId.
- **Index space:** every "frame N" in this report is the record index `i` (0–512) shared by all record types, *not* a count of frames. For example, "frames 484–512" spans frames and marks.
- `decoded.jsonl` and `summary.json` beside it (`pnpm decode-capture plate1`).
- Decoder tests run on these bytes (`server/test/wsframes.test.ts`) and skip where the capture is absent.

## 1. Framing: what the bytes confirmed

| Rule (from mda source) | Exercised by this capture? | Result |
|---|---|---|
| Ivy model socket `ws://127.0.0.1:8081/zcad/client?…projectId=37649921&projectTag=main` | yes | One socket for all model traffic. Its URL also carries `openId`, `platformId`, `token`, `tenantId`; all redacted in the capture. |
| Sent binary frame = encoded `IvyPkg` | yes, 42 messages | All decode |
| Received: zstd after reassembly | yes, 81 messages | All decode |
| Every request answered by `header.asyncId` | yes | 38/38 answered, none unsolicited |
| `IVTR` raw mesh frames | yes, 2 frames | Both valid against their 64-byte header (codec 1, sketch feature 15) |
| Trace header `'Z',1` (35 bytes) | **no** (0 messages; the local server omits it) | Unverified on real bytes |
| 512 KB chunking / empty terminator frame | **no** (largest message 68,102 bytes) | Unverified on real bytes |
| `IVYDOC01` envelope | **no** | Unverified on real bytes |
| Text frames | yes, 368 | Pings and connection events (`{"event":"ready"}`); no model data |

**Decoder bug found and fixed while testing on these bytes.** Node's `zstdDecompressSync` silently returns *partial* output for a truncated frame: cutting 8 bytes from reply 114 gave 64 of 68 bytes, which protobuf still decoded. `checkZstdFrame` (`server/src/wsframes.ts`) now walks the zstd frame structure and checks the declared content size. Cut and trailing-byte variants of the real frame are tested.

## 2. Per-step results

All model requests are `IVY_APP_MODEL_REQ` whose `modelPkg` is an `ivypart.PartPkg`, decoded in place. They all carry `workshopHead {workshopId: 1, currentDocId: 540, workbenchType}`.

**`currentDocId 540` is the part's runtime document handle.** The URL `id` (37649922) never appears in model traffic, which confirms re-plan §4.

### Idle (frames 65–85)
- Editor open sequence: user enter, version-control query, task-panel list, workshop open, get document, `IVY_QUERY_PARAM_REQ`/`META_REQ`, tessellation.
- The "empty" part **already contained `Sketch1`** (handle 537, feature 12). That's why the new sketch is "Sketch2".

### Sketch (frames 105–156): three `IVY_PART_SKETCH_UPDATE_REQ`
1. **Create** (113): `supportBrep {featureId: 3}` (the XY plane), `solverEnum: DCM`, no geometry. Part header `{tipFeatureId: 12, featureName: "Sketch2"}`. Reply (114): `featureId 15`, `ivy::FeatSketch`.
2. **Geometry** (121): `workshopHead.featureId 15`; 4 `line` geoms in mm, tags 4–7; 8 constraints (4 coincident, 2 horizontal, 2 vertical); 5 `sketchVertices`; `solve: true`, `syncDimension: true`, `version`.
3. **Exit** (133): the same payload again.

Notes:
- The freehand rectangle was 174.9 × 92.3 mm. The inspector added only `FeatSketch` + `FeatSupportPositioned`, with no dimension objects.
- Undo steps went 1 → 4.
- Persisted as version-control commits (`IVY_PROJECT_VCS_CHANGE_NTF`, frames 122, 147).

### Dimension (frames 195–270): five more `IVY_PART_SKETCH_UPDATE_REQ`
- **Dimensions are constraints inside the same sketch update; there's no separate message.** Each is sent with the full sketch.
  - `{type: CONSTRAINT_TYPE_DISTANCE_X, value: 100, isDriving: true, first/second: "6" (END/START), third: "-2000", labelDistance, labelTransform}`
  - `{type: CONSTRAINT_TYPE_DISTANCE_Y, value: 60, …}` on edge 5.
  - `third: "-2000"` is unexplained.
- The geometry was solved to exactly 100 × 60, but **not centred**: x −89.79…10.21, y −41.52…18.48.
- **Inspector:** + 2 `SketchLengthDimension`, + 2 `ParmLength`. **Undo:** 4 → 9.
- The UI also sent `IVY_USER_MULTICAST_REQ` (editor state to other sessions) and an `IVY_QUERY_PKG_REQ`.

### Extrude (frames 289–328): `IVY_PART_FEAT_UPDATE_UPDATE_REQ` with `featureType ivy::SolidExtrude`

| Frame | `featUpdateReq.header` | workshopHead flags | Reply |
|---|---|---|---|
| 297 | `{action: Create}` | `isPreview, ignoreMark, doNotSave` = true | `featureId -2` (temporary) |
| 303 | `{action: Modify, featureId: -2}` | preview, as above; depth now 8 | `-2` |
| 311 | `{action: Modify, featureId: -2}` | **all false** | **`featureId 43`** (`Extrude1`) |

- **There's no `Confirm` action.** The commit is a non-preview `Modify` of the preview id. This corrects re-plan §3, which assumed Create → Modify → Confirm.
- The commit carries 32 `attrRole` items. Known so far:
  - `10009` name/options;
  - `30003` profile = `{featureId 15, face id 0}`;
  - **`31004` depth `{value: "8", type: tLength, unit: "m"}`**;
  - `31010`, `31013` second-direction and offset lengths (10);
  - `31018`, `31021` angles;
  - `31027` thicken lengths;
  - the rest are bools, ints and empty selections.
  - Several `parmObjects` carry server `featId`s from the preview (21, 29–32) or negative placeholders (−13…−15).
- **Inspector:** + `SolidExtrude` (626, #43), `FeatGeomBRep`, `TopoGroup`, `StableHub`. The tip moved 15 → 43, and the sketch's `_featOptions` flipped as in Task 0. **Undo:** 9 → 10, from the commit only.
- **Version control:** commit `Part|add|108|ivy::SolidExtrude|Extrude1` (frame 332).

### Cancel (frames 363–419)
- The UI sent `Create` (preview, temp id −21) and five preview `Modify`s. **Pressing Cancel sent no model message**, only `IVY_USER_MULTICAST_REQ`.
- **Graph:** unchanged except `FeatContainer._lastId` (51 → 93). **Undo:** unchanged (10 steps, 11 marks, current mark 13). No version-control commit.
- ⇒ **Preview requests leave no model, undo or version-control trace, and "cancel" = don't send the committing `Modify`.** This is observed for a preview-only sequence. A cancelled *commit* isn't possible in this protocol.

### Failure (frames 446–470): depth 0
| Frame | Request | Reply |
|---|---|---|
| 450 | `Create` (preview), depth 10 | temp id −76, OK |
| 454 | `Modify` (preview), depth "0" | **`result 32000`** in `appModelRsp` and `featUpdateRsp` |
| 458 | `Modify`, **non-preview** (commit attempt), depth "0" | **`result 32000`** |

- **32000 = `kInvalidInput`, "Invalid Part Design input"** (`ivyproject/zplugin_v1/part_design/model/inc/part_design_error_code.h:14`).
- **Graph:** unchanged except `_lastId` (93 → 107). No version-control commit.
- ⚠ **Undo stack not untouched:** `markNum` went 11 → 12 while `can_undo_step` (10) and the current mark (13) stayed the same.
  - The new **mark #22** sits after the current mark and holds 22 recorded changes, including a *modify* entry on the existing extrude's `TopoGroup` (643) and several `ParmLength`s.
  - What Ivy does with it on the next undo or edit is unknown.
  - ⇒ A failed commit leaves state that the object graph doesn't show.

### Close (frames 484–512)
- Idle, then the tab was closed. Pings and session-gate text only.
- There's no explicit leave message. The single `IVY_USER_LEAVE_REQ` belongs to the pre-F5 socket (`40700.2790`).

## 3. What this changes in the plan

1. **Write sequence for one feature:**
   - `Create` (preview) → optional preview `Modify`s → **committing `Modify` with `isPreview`, `ignoreMark` and `doNotSave` all false**.
   - Success = reply `featureId > 0` and `result` absent/0.
   - Sketches use `IVY_PART_SKETCH_UPDATE_REQ`: create (no geoms) → geometry and constraints, with dimensions as `DISTANCE_X/Y` constraints → exit.
2. **Cancel:** for an *uncommitted* preview, simply not committing is enough: no residue was observed. There's no Cancel message to send. A failed **commit** is different. It leaves an extra mark (§2 Failure), so the executor must treat any non-zero `result` on a committing request as **"failed with possible hidden residue"**: stop and report it, even when the graph looks clean (D4 unchanged).
3. **Identity:** the runtime doc handle (540) is what the page sends as `currentDocId`. Inspector object 540 is the `ivy::PartReference` (`plate1-extrude/graph-full.dot`). It can be read passively from the page's own traffic before any write, then matched against the inspector's `PartReference` handle.
4. **Verification reads already in use by the UI:**
   - `IVY_QUERY_PARAM_REQ {docId: 540, parmSetId: 10, paramIds: [-1]}`, sent with a `workshopHead`. The reply carries the sketch dimensions as `"100.000000"` and `"60.000000"`.
   - **Units:** depth "8" and lengths "100"/"60" are labelled `unit: "m"`, but the values are millimetre-scale. The unit label can't be trusted for scaling, so Phase 2 has to establish it against a measurement.
5. **Placement:** the drawn rectangle isn't centred, so the expected AABB comes from the captured geometry (x −89.79…10.21, y −41.52…18.48, z 0…8 mm), not from an assumed origin.
6. **Mesh for D3:**
   - The two `IVTR` frames carry only the *sketch's* tessellation (feature 15, 138 bytes decoded).
   - **No mesh for the extruded solid was seen on the model socket** during or after the extrude. The model notification (313) holds feature data, not geometry.
   - So how the viewport gets solid meshes is still unknown, and mesh-derived volume is **not yet available**.

## 4. Open questions (for review, before Phase 2)

- How the solid's mesh reaches the page. It's needed for D3; volume stays unsupported until then.
- What happens to failure mark #22 on the next undo or edit. Until known, a failed commit means "stop, report, rebuild elsewhere".
- The meaning of constraint `third: "-2000"`, and which of the 32 extrude roles are required and which are UI defaults. Answering this requires a write experiment (Phase 3+, approval needed).
- Framing branches not exercised: trace header, multi-chunk, `IVYDOC01`. The decoder implements them from the mda source, but they're unverified on bytes.
- Whether `ParmLength` values are in display units or a fixed unit. Phase 2 should compare a parameter query against a measured AABB.

## 5. Phase 2a: watch-only measurement capture (`measure1`)

Date: 2026-10-13 · Approved as 2a only · `runs/capture-measure1` (gitignored) · probes `measure1-before`/`measure1-after`. `ai-cad` sent no request; the human used Ivy's measure tool once on `Extrude1`.

**After reopening plate1, every runtime handle changed:**
- The part is now **557** (`ivy::PartReference`); it was 540.
- **540 is now the `SolidExtrude` object.**
- The undo history was reset by the reload (1 step, 2 marks), and the failed commit's mark #22 is gone.
- The model socket opened three times during the load (records 102, 110, 231).

This confirms re-plan §4: identity must be re-resolved after every reopen, and a number seen earlier may now name a different object.

**What the measure tool sent with record-as-feature on: not `IVY_QUERY_MEASURE_REQ`.**
- The tool is a **measurement feature** in the measurement workbench (`workbenchType 14`, `ivymeasurement.MeasurementPkg`). It uses the same preview → commit pattern as the extrude:

| Record | Request | workshopHead | Reply |
|---|---|---|---|
| 276 | `IVY_MEASUREMENT_UPDATE_REQ`, `{action: Create}` | preview / ignoreMark / doNotSave | feature 1 (preview) |
| 280 | `Modify` (−1) | preview | — |
| 283 | `Modify` (−3), **non-preview** | all false | **`featureId 52`, `ivy::Measurement` "Measure1"** |

- The innermost payload is an `ivytaskpanel.UpdateMessageReq`:
  - `30003` = the target: feature 43, `TopoFace` id 4.
  - `30005` = values: **`[0.32, 0.006]` in the preview, `[320, 6]` in the commit**.
  - `30007` = `[6, 3]`, `30009` = `[1, 2]`, both unexplained.
  - 0.32 first appears in the **server's** preview notification (record 278), so the values are server-computed.
- **Interpretation (a hypothesis):** 0.32 m is the perimeter and 0.006 m² the area of a 100 × 60 mm face. In the commit, 320 matches mm, but "6" doesn't match mm² (6000). The display-unit encoding is unknown.
- **This run persisted the measurement, because "record as feature" was enabled** (the human's setting). Role `30008` (`kMeasureInsertToSet`, `zplugin_v1/measurement/model/inc/measurement_role.h:23`) was `true` here, **but it was also `true` with recording off (§6), so it is not the record switch**; the UI decides whether to send the commit. The probe diff added `ivy::Measurement` "Measure1", an `ivy::MeasurementSet` and a `FeatGeomBRep`. Undo went 1 → 2 steps, and Ivy sent 3 version-control change notifications. **This shows the record workflow writes; it does not show that measuring itself writes.** The other roles: `30004` result active, `30005` result values, `30007` result refs, `30009` result-set ids (same header).

**Decoder fix:**
- Nested `model_pkg` bytes are now decoded by their declared `workbenchType`: 1, 2, 13 → `PartPkg`; 14 → `MeasurementPkg`. Any other workbench is reported in `summary.nestedUndecoded` instead of being guessed.
- Before this fix, the measurement messages decoded "successfully" as `PartPkg` and read as `IVY_PART_DELETE_RSP`. That was a silent mis-decode, now covered by tests on the measure1 bytes.

**Consequence for Phase 2b (corrected 2026-10-13):**
- **Read-only native measurement is _unverified_, not unsupported.** Only the record-as-feature workflow was captured. Whether measuring with recording off sends only preview requests (like the cancelled extrude, which left no undo or version-control trace) or something else is not known.
- Next experiment (needs its own approval, watch-only like 2a): repeat the measurement with **record as feature disabled**, capture the outgoing requests, and compare the tree, undo history and version-control notifications before and after.
- Until then, no measure request of any kind is in 2b, and nothing guessed is replayed. Even a preview-only measurement path would consist of model requests (`IVY_APP_MODEL_REQ`, workbench 14), so adding it to the allow-list would be a separate decision after the capture.
- 2b can still run the **parameter query** exactly as the UI sends it (§3 item 4), with the undo and graph checks. It cannot establish geometry by itself.

## 6. Measurement with record-as-feature off (`measure2`)

Date: 2026-10-13 · Approved: "measure capture with record-as-feature off" · `runs/capture-measure2` (gitignored) · probes `measure2-before`/`measure2-after`. `ai-cad` sent no request; the human measured the top face of `Extrude1` once with recording disabled.

**Handles after this reload:** the part is now 569, `SolidExtrude` 549, and `Measure1` (from §5) 566.

**What the UI sent (records 53–71):**

| Record | Message | Notes |
|---|---|---|
| 63 | `IVY_APP_MODEL_REQ`, workbench 14, `IVY_MEASUREMENT_UPDATE_REQ` `{action: Create}` | `isPreview`, `ignoreMark`, `doNotSave` all **true**. Items: `30002`=[1], `30003`= feature 43 `TopoFace` 4, `30004`={}, `30008`=[true] |
| 64 | `IVY_APP_MODEL_RSP` | preview feature id 1 |
| 65 | `IVY_APP_MODEL_NTF` (323 bytes) | **contains the doubles 0.32 and 0.006**, server-computed |

- **That's the whole exchange.** There was no `Modify`, no commit, and closing the measure tool sent nothing.

**State before and after (inspector):**
- Undo history is identical: 1 step, 0 redo, 2 marks, current mark 2, same mark ids and sizes.
- The graph is identical apart from the volatile `PipelineContext`. Even `FeatContainer._lastId` is unchanged.
- Ivy sent no version-control change notification.

**Conclusions:**
1. **The UI's measurement with recording off is a single preview request that leaves no observed trace** in the graph, the undo history or version control. Recording is the separate commit step captured in §5.
2. It is **still a model request** (`IVY_APP_MODEL_REQ` on the measurement workbench), not an `IVY_QUERY_REQ`. "No trace observed" covers this one run and these three state views; it doesn't prove that every preview is side-effect-free.
3. **What it measured:** the server's reply carries 0.32 and 0.006 for face 4. That's consistent with a 100 × 60 mm face (perimeter 0.32 m, area 0.006 m²) if the values are SI, but it's **face data**: neither a bounding box nor a volume. The message layout carrying these values isn't decoded field by field yet.
4. **For 2b and later:**
   - Allowing this preview request would be a deliberate exception to the "query requests only" allow-list. It's a separate decision.
   - If you take it, it should be the exact captured shape (input type 1, a single face), with the before/after state checks.
   - Other input types might give a thickness or body result: what the `30002` values mean is unknown and would need its own capture.
