# Offline write path: rectangle sketch + extrude, and its live write guard

Date: 2026-10-13 · **Status: offline only. Final read-only review (F1–F8) and its adversarial follow-up (A1–A8) fixed offline; awaiting review. Not cleared for a live trial (§8).**
- No request was sent to Ivy. No service, Ivy or Chrome was launched, reloaded or touched. No `ivyproject` or `mda` file was changed (Ivy source was only read, §5).
- The live write path stays **disabled**:
  - the guard refuses everything unless constructed with `enabled: true`;
  - **one sender, disarmed by default** (`writesender.ts` `PageSender`, approved 2026-10-13): it sends nothing unless constructed with `armed: true`, and only `scripts/plate-trial.ts` arms it, behind `writeGate` (`--write`, a fully passed preflight, an exclusivity attestation, and the user typing `write`). No live write has been sent;
  - the live allow-list (`queryport.ts`) and `pagecall.ts` are unchanged; `replay.ts` only reads its snapshot through the shared `inspectorState` (same reads, same order);
  - imports: `writeport.ts` and `writeseq.ts` are imported only by `livewriteguard.ts`, each other and the tests. `livewriteguard.ts` (which imports both) is also imported by `scripts/write-probe.ts` for pure checks (`checkDrift`, `snapshotProblems`, `tipOf`) and, as types only, by `liveports.ts` and `socketinventory.ts`. No script constructs a guard or holds a sender (guardrail scan in `liveports.test.ts`).
- Byte equality with captured requests proves the encoders reproduce what the UI sent. It does **not** prove Ivy will accept requests that `ai-cad` sends.

Evidence labels used below: **captured** (bytes, undo marks or probe snapshots from `runs/capture-plate1` and `test/fixtures/inspector`), **source** (read from Ivy source, not exercised), **test-only** (shown with fake ports over captured data, never against Ivy), **inferred** (not demonstrated), **unresolved** (the capture cannot answer it).

## 1. Request sequence (source: `runs/capture-plate1`, `session-protocol-capture.md` §2)

| # | Step | Captured request → reply window | Undo mark it produced | What it carries |
|---|---|---|---|---|
| 1 | `sketchCreate` | 113 → 114–120 | 3 | empty sketch on the XY plane (feature 3) |
| 2 | `sketchDraw` | 121 → 122–132 | 4 | 4 lines + 8 constraints, `onlySolve: true`, version 1 |
| 3 | `sketchClose` | 133 → 134–194 | 5 | same, `onlySolve: false`, version 1 |
| 4 | `widthAdd` | 214 → 215–218 | 6 | + `DISTANCE_X` (constraint 8) at the current width, version 4 |
| 5 | `heightAdd` | 223 → 224–227 | 8 | + `DISTANCE_Y` (constraint 9) at the current height, version 7 |
| 6 | `sketchFinish` | 236 → 237–244 | 10 | both dimensions, `onlySolve: false`, version 8 |
| 7 | `extrudeCreate` | 297 → 298–302 | none (preview) | `{action: Create}`, preview, default depth 10 |
| 8 | `extrudeModify` | 303 → 304–310 | none (preview) | `{action: Modify}` on the preview id, depth 8 |
| 9 | `extrudeCommit` | 311 → 312–335 | 13 | `{action: Modify}`, preview flags false |

**Omitted: the UI's value edits 219 (174.92 → 100) and 228 (52.75 → 60).** Our rectangle is drawn at its final size, so each dimension is added at its current value, as 214 and 223 did. The edits do **not** change nothing, though (captured):
- **Versions.** The UI sent 1, 1, 4, **5**, 7, **8**, 8; ours sends 1, 1, 4, 7, 8. The UI's closing requests reused the preceding request's version (133 = 121 = 1; 236 = 228 = 8). Ours sends 8 after 7, which the capture never shows.
- **Vertex tags.** Each edit renumbered the five `sketchVertices` tags (219: 26–30; 228: 41–45). Ours goes from 214's 21–25 straight to 223's 36–40.
- **Undo marks.** Marks 7 and 9 show that a value edit modifies a `ParmLength`. That would not happen here, because each `ParmLength` is created at its final value.

Source: `Sketcher::Load` skips data whose version is lower than its own (`zplugin/sketch/sketcher/src/sketcher.cpp:914`). Our versions are never lower than the UI's at the same point. Whether this is the code path for these requests was not traced. A skipped load would add no undo mark, which the guard's mark check refuses (fail closed). **Unresolved:** whether Ivy accepts the version/tag discontinuity. It needs a live trial or a capture of this exact sequence.

## 2. What each builder changes (`server/src/writeport.ts`)

Templates (`server/src/templates/plate1-write.json`) are extracted by `server/scripts/extract-write-templates.ts` from the nine records. No body contains a user identifier, and headers aren't kept.

| Field | Steps | Source | Evidence |
|---|---|---|---|
| `workshopHead.workshopId`, `currentDocId` | all | the bound target | identical in all captured requests |
| `workshopHead.featureId` | 2–6 / 8–9 | sketch id / preview id | 15 / −2 |
| `header.tipFeatureId` | all | 1: planned tip; 2–9: sketch id | 12; 15 |
| `header.featureName` | 1, 7–9 | plan | "Sketch2" / "Extrude1" (2–6 carry none) |
| `supportBrep.featureId` | 1–6 | planned plane | 3 (= `FeatOriginPlane` #527 "XY Plane") |
| 4 × `line.start/end`, `lastNonZeroDir` | 2–6 | plan lines; direction = `end − start` | exact on all five captured sketch requests |
| constraint 8 / 9 `.value` | 4 / 5–6 | width / height | 214, 223, 236 |
| profile `featureId` (30003) | 7–9 | sketch id | 15 |
| parameter items | 8–9 | the preceding preview notification: `featId`, `fullName`, `formula`, `type`, `unit`; `value = String(Number(value))` | 303 from 299; 311 from 305 (byte-identical) |
| depth item (31004) | 8 / 9 | notification item with `value = depth`, `formula = ""` / **the item step 8 sent, verbatim** | 303 / 311 (stale featId 21) |

Every feature-id-like constant left in the nine templates is on a substituted path (checked by scanning the templates).

**Copied from the capture without understanding** (valid only for this exact topology; anything else is refused):
- `sketchVertices` tags/keys and `version` (see §1);
- the constraint tags, `third: "-2000"` and label transforms;
- the solver flags;
- the 32 extrude items' order and subset, every option, and the default depth 10.

**Test fixtures vs plan values:** steps 2–5 carry the plan's 100 × 60 geometry rather than the UI's freehand values. They are byte-tested against their own templates with the captured values, and shape-checked (template differences only on allowed paths) with the plan's values.

## 3. Review findings and fixes

### Adversarial follow-up (all offline)

None of these fixes touches the unresolved items in §5: the shortened sketch sequence, the stale depth id, and settle timing.

| # | Finding | Fix | Negative tests |
|---|---|---|---|
| A1 | A model-socket binary record with invalid base64, or carrying only the 35-byte trace header, passed `recordProblems` because only `payload === ''` was refused. `decodeCapture` then dropped it as zero bytes, unclassified. | `binaryProblem` (`livewriteguard.ts`): the payload must be a non-empty string of padded base64, and must not be exactly a trace header. Between steps this is refused before the send; inside a step window it is `unknown`. | Invalid base64 (`!!!!`), wrong length (`A`), and header-only, all between steps; header-only inside a window. Each asserts the exact problem list. |
| A2 | The recorder numbers from 0 on every attach, and nothing defined what a traffic port does when a recorder is reattached. | `RecordStream` (`recorder.ts`) is the contract: one stream per recorder attachment. A write whose index is not the next one breaks the stream **for good**, and every later `position`/`since` throws. That covers a reattach (indices restart at 0) and a record lost to a throwing handler. A reattached recorder needs a new stream and a new guard. Nothing is resumed or renumbered. | Real `attachRecorder` with fake CDP: contiguous reads, a second attach onto the same stream, a lost record, frozen records. Guard over the real `RecordStream`: nine steps complete; a reattach between steps → the next step is refused before sending. |
| A3 | Frames of other sockets are not inspected, and the guard assumed (the code comment said) that they "carry no Ivy model traffic". The capture shows sockets opened before the recorder attached (40700.2851/.647/.2790, no `socket` record), and .2790 carries binary frames. (Later reading, inferred: .2790's text frames are the model socket's `{requestId, command: "ping"}`, so it was most likely the pre-reload model socket. It fell silent before the reload's model socket was created, with no `closed` record.) | New identity-port requirement, `identity.modelSockets()`: a **complete** inventory of every `:8081/zcad/client` socket in the watched browser, including sockets opened before the recorder. It is checked before every send. Anything other than `complete: true` with exactly `[boundSocket]` is refused: incomplete, missing, malformed, empty, a second socket, another socket, or a throwing port. If a live port cannot enumerate existing sockets reliably, it must answer `complete: false`, and live writes are refused. The incorrect comment was removed. | Seven inventory cases at the first step (exact problem, nothing sent), plus a second socket appearing mid-run. |
| A4 | The sketch-create notification's tip could be absent, although the capture (116) names it (15). | On `sketchCreate`, the tip must be present and equal to the new sketch. Later sketch steps may still omit it (captured 125, 137, 240). | 116 without its tip → `unknown`, with one exact problem. |
| A5 | Snapshots were retained by reference as the drift baseline and `lastState`, and `report()` re-parsed retained data outside any `try`. | Every snapshot is `structuredClone`d on intake, before the structure check. All checks and baselines use the copy. `lastState` is summarised when it is observed, so `report()` parses nothing. The report returns copies, and the page's async id is stored as a string. | A state port that mutates **one** object in place: the run still completes, and drift is still detected. Mutating the port's object or an earlier report leaves the next report unchanged. |
| A6 | A throwing `transport.abort()` escaped `runPlateSequence`. A malformed `exchange` result threw on `t.notSent` and was reported as `stopped`. | `stop()` catches an abort failure and appends it to the reason ("may not be latched"). It never throws. A non-object result, non-list `unexpected`/`ntfs`, or a non-boolean `notSent` is `unknown` ("the request may have run"). Its `notSent` flag is not trusted. | A throwing abort after an uncertain outcome and after a throwing transport. Eight malformed results. |
| A7 | Multicast policy was inconsistent: `IVY_USER_MULTICAST_NTF` was accepted, but its REQ/RSP were refused. | **Policy: every multicast message is refused, between steps and inside step windows.** The capture shows multicast only around manual UI interaction (page requests 200/207, answered by 202/203 and 209/210). Its content is not decoded, and a multicast from another user means a collaborator is present. A scripted run has no UI input. `IVY_PROJECT_VCS_CHANGE_NTF` stays accepted without a content check (it was captured inside step windows: 122, 147, 232, 332). It may also signal another editor; the state checks are the backstop. | The captured 200–210 are refused in the gap, and 203 inside a window; 122 is still accepted. |
| A8 | Documentation claims exceeded the implementation: "every record classified exactly once", "other sockets carry no model traffic", and no mention of the window between the traffic read and the send. | Corrected in §4, §5, §8 and the guard's header comment. | — |

**Mutation check (this round):** each fix was reverted in place, the targeted test file was run, and the source was restored and compared byte for byte.
- A1 → 4 failures; A2 → 3; A3 → 7 of its 8 cases (the throwing-port case refuses regardless); A4 → 1; A5 → 2; A6 abort → 2 and malformed → 8; A7 → 1.

### Final review (all offline)

| # | Severity | Finding | Fix | Negative tests (exact problem lists) |
|---|---|---|---|---|
| F1 | High | A post-send snapshot that resolved but was malformed made a parser throw outside every `try`: the guard was not latched and the report had no abort reason. The sequencer rethrew without calling `abort`. | `snapshotProblems` checks a snapshot's structure (undo JSON and counts, marks, classes, objects as JSON objects with a class, edges, exactly one `FeatPart` with its object) **before** any parser sees it, before and after the send. A malformed after-state is "state not verified" (unknown). `exchange` is split into pre-send, send and verify; everything after the send boundary runs inside one catch, so any exception there is unknown and latches. Non-byte input is refused and latched. The sequencer catches every exception: a throwing transport is `unknown`, any other error `stopped`, and both call `abort` (`writeseq.ts`). | Six malformations (missing classes, invalid undo JSON, non-list marks, no `FeatPart`, non-JSON `FeatPart`, `null`) after `sketchCreate` and after `extrudeCommit`: unknown, latched (a later exchange touches no port), exact problem and abort reason. The same six before `widthAdd`: refused, not sent. A throwing getter in the send result → "verification failed", latched. A non-object send result. Non-byte input. Sequencer: a throwing transport (unknown, `abort` called with the reason); an unexpected error while building the next step (stopped, `abort` called). |
| F2 | Medium | Every model notification in a step window was accepted. | `classifyStepTraffic` refuses notifications naming another document (workshop head or any model description). `notificationProblems` checks each step's notifications against the captured pattern (§4), the reply's session, and the bound project, workshop and document. | Another document, an extra sketch notification, another session, a sketch notification without the sketch, a second preview notification, a preview not flagged as a preview, a commit notification whose tip isn't the new feature, a committed extrude not following the sketch. |
| F3 | Medium | Text, mesh and control frames on the model socket were dropped unclassified, and nothing detected lost records. | `recordProblems` requires contiguous record indices from the cursor (the traffic port's contract, §8). It refuses: any socket opened, closed or failing during the run; model-socket opcodes other than 1 and 2; empty binary frames; unknown record types. The classifier accepts only the page's `ping` as text, and mesh frames only when well-formed and belonging to a pending tessellation request (`transferId` = its async id, captured 139→140, 242→243). Frames of the page's **other** sockets are not inspected (§5). | A lost record index. Another socket opening or closing. Opcode 9. An empty binary frame. Received text. Non-ping text. A mesh frame nobody asked for. A malformed mesh frame. Other-socket frames are accepted. |
| F4 | Medium | The committed feature (and the sketch) were not bound to the object actually added. | `bindCreated`: the single new undo mark must add exactly one `FeatSketch` (create) or `SolidExtrude` (commit). That object must be new and visible, and carry the reply's feature id. No object may have carried that id before. The tip must be exactly `<id>_<handle>` (captured: `15_543`, `43_626`). The notification must agree: new-sketch placement after the planned tip (captured 116), commit tip = new id, extrude after the sketch (313). | An existing extrude with the planned depth, named by reply and notification, while extrude 43 is added. The added extrude carrying another id. The tip not moving. A reply naming the existing Sketch1. Unit cases on the real fixtures. |
| F5 | Low | `lastState` labelled the pre-send (possibly drifted) snapshot as verified. | `lastState` holds only well-formed snapshots and says whether each was observed before or after a step. `verified` is true only for the after-state of a verified step. | Happy path, drift refusal, first-step refusal, a failed state check. |
| F6 | Low | The sequencer did not call `abort` on unexpected exceptions. | See F1. | See F1. |
| F7 | Low | A class change from a volatile class went unnoticed per step. | **Not fixed.** It depends on handle reuse, which has never been observed (§5). | — |
| F8 | Low | Some assertions accepted alternative reasons. | The error-reply, extra-parameter, part-command and plan-key cases now assert one exact reason. The gap and traffic cases assert the full problem list. | — |

Also corrected: record numbers in the guard's messages are the traffic stream's indices. The test harness gives each record the next index, as the recorder does, and looks up captured records by their capture number.

### Second review (all offline)

| # | Severity | Finding | Fix (`livewriteguard.ts` unless noted) | Negative tests (`livewriteguard.test.ts` unless noted) |
|---|---|---|---|---|
| 1 | High | Records arriving between one step's inspection and the next step's `position()` were never classified. | **One run-wide cursor.** `position()` is read once, to start the run. Before each later send, `since(cursor)` is classified (`classifyGapTraffic`, `writeseq.ts`). Allowed: page requests of the captured kinds for the bound document, their replies, and the allowed notifications. Refused: any reply or model notification, a reply carrying one of our earlier wire ids, an outgoing write, a model-socket close/error/reconnect, or an unknown record type. The cursor advances only after a verified step. Each page request is answered once. | Nine "arrives between steps" cases, injected at the next step's first pre-send port call (not inside `sendRaw`). Page traffic in the gap is accepted. An old page reply (twice, or already answered) is refused. The happy path asserts `position()` once and `since()` 17 times. |
| 2 | High | State between steps was not compared with the last verified state. | `checkDrift(lastVerifiedAfter, before)` before every send after the first: identical undo text (marks, counts, redo), the same objects with identical JSON, the same edges. Only `ivy::PipelineContext` is exempt, because it is the only object a no-op changed (`replaycheck.ts` §6). `VisuGeomObject` is **not** exempt between steps. The first step has no baseline and uses its own pre-checks (tip, plane, redo). | Changed object, added object, added visualisation object, removed edge, added edge, unparsable edge, undo signature, redo count. A `PipelineContext` addition passes. |
| 3 | Medium | The order check and the step claim were separated by `await`s, and the caller's buffer was not copied. | The step is claimed synchronously, with an in-flight marker, before the first `await`. An overlapping call is refused and latches the run. The suspended call re-checks the latch before its send boundary. The body is copied on entry and that copy is checked, sent and matched on the wire. | Overlapping calls: none reaches the sender. A step refused before sending cannot be retried. The caller zeroes its buffer mid-call and the checked bytes are still sent. |
| 4 | Medium | Ivy's reported depth was never checked. | `checkReportedDepth`. After Modify: the preview's single role-31004 parameter must equal the plan depth in value (and formula, when present). After commit: the same for the committed feature named by the validated new id. The stale depth item id (21) is still sent, as the UI did. Only the resulting depth is verified. | Preview still at 10. Committed feature at 9. Unit cases: no notification, another feature, the feature twice, no depth role, two depth attributes, two parameters, a non-numeric value, an empty formula, another type, a formula disagreeing with the value. The captured 305/313 are accepted, and 299 (pre-Modify) is rejected. |
| 5 | Medium | The guard did not check the reply's command, feature or target. Its report could say "completed, no residue" for a run the sequencer stopped. | `replyProblems`: the reply must be `IVY_APP_MODEL_RSP` with the wire's exact async id, the bound project, workshop and document, and the step's command and feature type. Without an error it must name the expected feature (new sketch > 0 / our sketch / new preview < 0 / our preview / new feature > 0). The sequencer now calls `transport.abort(reason)` on every stop (`writeseq.ts`). `abort` only latches. The report flags residue whenever a stopped run sent anything. | Another feature id (16), another feature type, another document, another project: `unknown`, never completed. A sequencer-only stop (preview profile not our sketch) latches the guard and reports residue. `writeseq.test.ts`: `abort` is called with the stop reason. |
| 6 | Low | The plan was not validated. | `checkPlan` (`writeport.ts`): the builders' zod rules plus the rectangle check. The bound identity is validated too. The constructor throws `RefusedWriteError`; no port is touched. | A width that doesn't match the lines, an open outline, zero/NaN depth, a fractional id, an odd name, an extra field. Invalid identities. |
| 7 | Low | Uncertain outcomes were labelled `failed`. | `failed` only for an error reply to exactly our request with no undo or visible change. Everything else after the send boundary is `unknown`, with `uncertain: true` (plus `timedOut` for timeouts). The sequencer maps it to `unknown`. | A clean error reply → `failed`. The real 32000 commit with its redo mark → `unknown`. Missing reply, request missing from the wire, wrong header, state anomaly → `unknown`. |
| 8 | Low | The wire check read only the first field-100 occurrence. | `frameRequestBodies`: the frame must be exactly one header (field 1) and one body (field 100), and that body must be our checked bytes. | A second body appended. Another body field appended. |
| 9 | Low | Unparsable edges were silently dropped. | `edgeSet` reports them, both per step and for drift. | Unit test, plus a drift case. |
| 10 | Low | The doc said the omitted edits "change nothing". | §1 corrected. The discontinuity is listed under unresolved items. | — |
| 11 | Low | Some negative tests passed for incidental reasons. | The width case is isolated (only constraint 8 changed; no line or direction reason allowed). The type mutation asserts the exact path. Plane, tip and document cases assert their reasons and no port call. Late-traffic cases assert their reasons and send counts. | — |

### First review (kept)

| Finding | Fix | Evidence / test |
|---|---|---|
| **B1** The request and reply were matched by the page's async id, which JavaScript rounds. | Our request is found on the wire by its exact bytes and command, and the reply by the wire's exact id. The page id is only a numeric consistency check. | Real `replay-measure1` values. Seven of the nine captured step ids change under `String(Number())`, so the happy path exercises rounding too. |
| **B2** Exceptions after the send escaped. | Everything after `sendRaw` is wrapped; any throw is `unknown`, latched, with residue flagged. | Send, settle, traffic and after-snapshot throws. |
| Error replies skipped the state check. | The after-state is inspected on error replies too. | Real 32000 windows. |
| **H1/H2/M1–M5/L1–L5** | Page-traffic kinds, plan values, edge rules, header, per-request marks, parameter strictness, redo, identity, `lastState`. | As in the test file. |

## 4. State rules (`server/src/livewriteguard.ts`)

### Committing steps (1–6, 9)
- **Undo:** exactly one new undo step, no redo entry, earlier marks unchanged. The new mark's source must be `6|0|` (sketch) or `108|0|ivy::SolidExtrude` (commit). Its non-visual entries must equal `EXPECTED_MARKS[step]` (captured marks 3–13).
- **Objects:**
  - Every visible new object needs a mark entry "added" for its handle, and every mark "added" must be visible.
  - No non-volatile removals.
  - Visible modifications are allowed only for:
    - the id counters (`FeatContainer._lastId/class_name_id_map_`, `TopoContainer._lastId`; `FeatContainer._lastId` must not go backwards);
    - `FeatPart.attr_tip_feat_` on create and commit, with a mark entry and the tip equal to the new feature;
    - on commit, `attr_first_._featOptions` of our sketch handle, with a mark entry.
- **Edges:**
  - Removed edges are refused.
  - New edges must touch a new object:
    - from an existing object, only the captured parents may point to a new one;
    - from a new object, only `DependsOn` to the planned plane (create) or our sketch (commit).
  - Unparsable edges are refused.
- **Depth (commit):** the committed feature reports the plan depth (§3 #4).

### Previews (7–8)
- The undo history must be byte-identical. No non-volatile additions or removals. Only the counter paths may change (captured: `FeatContainer._lastId` 51 → 93 across the extrude/cancel probes, without marks).
- **Depth (Modify):** the preview reports the plan depth.

### Between steps (drift)
- Exact equality with the last verified after-state, except `ivy::PipelineContext` (§3 #2).

### Volatile within a step
- `ivy::PipelineContext` and `ivy::VisuGeomObject` (and their edges) are ignored inside a step's diff. In the capture, both churn on every committing step.

### Snapshot structure (every snapshot, copied on intake, then checked before any parser)
- `undo`: JSON with integer `can_undo_step`, `can_redo_step` and `markNum`, plus a list of marks with unique integer ids.
- `classes`: names. `objects`: JSON objects, each with a class. `edges`: text.
- Exactly one `ivy::FeatPart`, with its object.
- Before the send, a malformed snapshot is refused. After the send, it means "state not verified" (unknown). It is never compared, so it can never count as equal.

### Created features (sketch on create, extrude on commit)
- The new undo mark adds exactly one object of the class.
- That object is new and visible, and carries the reply's id.
- No object carried that id before. Feature and parameter ids share one counter (e.g. `ParmLength` #577 is 20).
- The `FeatPart` tip is exactly `<id>_<handle>`.

### Notifications (captured pattern)
- **Every notification:**
  - the bound project;
  - the reply's `userSessionId`;
  - the bound workshop and document in the workshop head;
  - exactly one model description, for the bound document.
- **Sketch steps:** exactly two. One is a bare workbench-2 description. The other is an `IVY_PART_DATA_NTF` carrying the sketch exactly once. On the create, the tip must be present and equal the new sketch (116). Later steps may omit the tip (125, 137, 240); when it is present, it must equal the sketch. The new sketch follows the planned tip (113→115/116 … 236→239/240).
- **Previews:** exactly one, flagged `isPreview`, carrying only the preview `SolidExtrude` (299, 305).
- **Commit:** exactly one, not a preview, with tip = the new feature. It carries that `SolidExtrude` once, following the sketch (313).
- **Error replies:** at most one, with no feature (455→456; 459 had none).

### Traffic records
- Contiguous indices from the cursor (a reattached recorder breaks its `RecordStream`, §3 A2). Annotations are allowed.
- **Model socket:**
  - text must be the page's `ping` (`{requestId, command: "ping", body: {timestamp}}`; the only text seen during the capture, besides one `ready` event at connect);
  - binary must be padded base64, must carry more than a trace header, and must decode;
  - multicast (request, reply or notification) is refused; `IVY_PROJECT_VCS_CHANGE_NTF` is accepted unchecked (§3 A7);
  - mesh must be well-formed and belong to a pending tessellation request;
  - any other opcode is refused.
- **Any socket** opened, closed or failing during the run is refused.
- **Frames of other sockets** are not inspected. Whether they can carry model traffic is **not established**. Instead, the identity port must prove that the bound socket is the only model socket (§3 A3).
- **Timing:** traffic recorded after the pre-send traffic read and before the send is inspected only after the send, in the step's window.

## 5. Verified guarantees and remaining limitations

### Verified by the implementation (offline: source, plus tests over captured data)
These hold **given ports that keep their contracts** (§8). None of them has run against Ivy.

**Sending**
- **Disabled by default.** Nothing is sent and no port is touched unless the guard is constructed with `enabled: true`.
- **Each step is sent at most once, in order.** The claim is synchronous, before the first await. Overlapping calls are refused. Every refusal after the claim latches the run.
- **The checked bytes are the sent bytes.** The guard copies the body on entry; that copy is validated, sent, and found on the wire byte for byte, in a frame carrying exactly one header and that body.

**After the send**
- **The reply is correlated by the wire's exact async id.** The guard checks its command, project, workshop, document, feature type and feature id rule.
- **Notifications match the captured per-step pattern** for the bound project, workshop, document and the reply's session (§4).
- **The created sketch and extrude are the exact objects their undo marks added.** Each carries the reply's id, which no object had before, and is the new tip.
- **Depth.** The preview after Modify and the committed feature each report exactly one role-31004 `tLength` parameter equal to the plan depth.

**State**
- **Every snapshot is structure-checked before parsing.** A malformed one is never compared or treated as equal.
- **Drift.** Between steps, the state must equal the last verified after-state exactly, except `ivy::PipelineContext`.

**Outcomes and the report**
- **Any exception or uncertainty after the send boundary is `unknown`.** It is latched and residue is flagged. The sequencer calls `abort` on every stop and every exception.
- **`completed` lists only verified steps.** `lastState.verified` is true only for a verified after-state.

**Traffic**
- **Every record the traffic port returns is checked exactly once**, by the gap check or the step window. Record indices must be contiguous. Records of other sockets are checked only for type and lifecycle (open, close, error), never for content. On the model socket, every opcode, text frame, mesh frame and message is accounted for, and binary payloads that would decode to nothing are refused.
- **Exclusive model socket:** before every send, the identity port must list exactly the bound socket, with the inventory marked complete. This is only as strong as the port's enumeration; no live port exists (§8).

### Captured evidence the rules come from
- **Requests and their effects:**
  - all nine request templates and the substitution rules (`lastNonZeroDir` on five requests, parameter mapping on 303/311);
  - per-request mark signatures (marks 3–13);
  - edge patterns and object paths per probe group.
- **Traffic:**
  - reply windows and the page's reaction traffic, with each page request answered exactly once;
  - the notification pattern per step (§4), carrying the page session `268435459`;
  - mesh `transferId` = its tessellation request's async id;
  - the model socket's text frames: `ping`, plus one `ready` at connect;
  - contiguous recorder indices **within one attachment** (513 records, no hole). A reattach was never captured; its handling is a contract (§3 A2), not an observation;
  - sockets open before the recorder attached (no `socket` record: 40700.2851, .647, .2790), so the recorder alone cannot enumerate sockets.
- **Feature identity:** the tip encoding `<feature id>_<handle>` (`43_626`); new features placed after the planned tip / the sketch (116, 313).
- **Errors and residue:** error replies carry no feature id (455/459); the failed-commit residue (redo + mark 22).
- **Depth:**
  - the preview depth before and after Modify (299: 10; 305: 8);
  - the committed depth (313: feature 43, 8);
  - the rounded page id.
- **Our sequence:** the version/tag discontinuity it introduces (§1).

**Source** (read, not exercised):
- `Sketcher::Load` skips a lower non-zero version, and data whose hash equals the current data (`sketcher.cpp:911–943`).
- `featSketch::UpdateConstraintFromDimension` raises the version only when a dimension value changes the constraint (`feat_sketch.cpp:2081–2093`).

### Inferred (not demonstrated)
1. **Stale depth id.** The edited depth item keeps its stale id (21, not 28) in the commit. Seen once; whether Ivy needs it is unknown. The resulting depth is verified instead.
2. **Omitted edits.** The value edits (219/228) are unnecessary when geometry starts at final size.
3. **Copied constants.** The copied sketch constants are acceptable with our geometry.
4. **Per-request split.** Visible JSON was observed per probe *group*. The split per request comes from the marks. So counter paths are allowed without a mark entry, and the harness attributes a group's edges to its first step.
5. **Units.** Lengths go as the captured numbers (mm-scale); the `unit: "m"` labels aren't trusted.
6. **Session id.** `userSessionId` on a notification is the session the reply came from in every capture. Whether it names the originating editor or the recipient is unknown (only one session was captured). The check rejects a mismatch; a match does not prove the notification was caused by our request.

### Limitations (not closed by this implementation)
1. **Traffic observation.** The recorder sees only this page's CDP WebSocket events.
   - **Other clients:** another editor's traffic is invisible. It shows up only through notifications pushed to this page and through the state diff.
   - **Other sockets:** frames of other sockets (mda, session gate, and sockets of unknown protocol opened before the recorder) are not inspected; their protocols aren't decoded. The guard relies on the identity port's complete inventory instead (§3 A3). The recorder cannot enumerate sockets that already exist. `socketinventory.ts` claims completeness only if three things hold: the model socket was created while recorded, there is no other DevTools target, and every socket seen active without a creation record was also seen to close. Silence never counts. In both live recordings (capture-plate1, write-probe-doc37660560) the pre-reload sockets, the old model socket among them, stopped without a `closed` record, so **neither recording yields a complete inventory**. Still not covered: a pre-existing socket that is never active while recorded is invisible, and a dedicated worker is not listed by `/json/list` (assumed absent: no `new Worker(` in mda `.ts`).
   - **Completeness:** that the recorder delivers every frame is the port's contract. Index holes and reattachment are detected (`RecordStream`); frames CDP never reports are not.
   - **Version-control notifications** are accepted without a content check, and may come from another editor (§3 A7).
2. **Snapshot/traffic race.**
   - **Atomicity:** no interface makes a state snapshot and a traffic position atomic, and requests carry no server-side precondition.
   - **Unattributed changes:** another editor's change applied after the pre-send snapshot and before our request runs is attributed to our step. It is detected only if it falls outside the step's allowed changes: counters, volatile classes, or (now) the notification pattern.
   - **Stale snapshots:** a stale or cached snapshot cannot be told from a fresh one. A preview step would pass on it.
   - **Traffic after the pre-send read:** records arriving between the gap read and `sendRaw` are only seen in the step's window, after the request has gone.
3. **F7.** A handle changing class from a volatile class within a step is not detected. Handle reuse has never been observed.

### Unresolved (blocks a live trial)
1. **The shortened sketch sequence (219 and 228 omitted).**
   - **What we send:** versions 1, 1, 4, 7, 8, with vertex tags jumping from 21–25 to 36–40.
   - **What the source suggests:** adding a dimension at its current value doesn't raise the version, so ours would not be "lower" (see Source above).
   - **What is not established:**
     - that these requests reach `Sketcher::Load`;
     - whether other version bumps apply (`feat_sketch.cpp:2589`, `sketch_edit_cmd.cpp:4283`);
     - whether the vertex-tag numbering matters;
     - whether solver noise makes `ApplyValue` report a change;
     - whether the hash-equal skip triggers.
   - **Why it matters:** a skipped step adds no undo mark, which the guard reports as `unknown` *after* the send, leaving a partial sketch. It needs a capture of exactly this sequence or a live trial on a disposable document.
2. **Ivy's acceptance of the stale depth id.**
3. **Live settle timing.** A late reply or notification fails closed, in the next window or between steps. A too-short settle refuses runs after a send; a too-long one only slows them.
4. **Strict drift and strict traffic may refuse live runs.** Examples: late `VisuGeomObject` or counter changes between steps, a socket opening mid-run, a mesh arriving after its tessellation reply. Each fails closed and is not relaxed without evidence.
5. **Thickness, bounding box and volume of the result.** The depth parameter is verified; the geometry is not. Only the top face's perimeter and area are known to be measurable.

## 6. Failure handling summary

- **Before sending** (refused, nothing sent, run latched). The disabled guard is refused but not latched. Everything else latches:
  - **Run state:** aborted run, overlapping call, out of order.
  - **Request:** non-byte input, shape, plan values.
  - **Target:** identity, a model-socket inventory that is not complete and exactly the bound socket, a malformed snapshot, drift since the last verified step, redo history, target features.
  - **Traffic since the last inspection:** messages, records, indices.
  - **Ports:** a pre-send port exception, or an invalid traffic position.
  - An invalid plan or identity is refused at construction.
- **After sending** (never retried):
  - **failed:** an error reply to exactly our request, with matching notifications and no undo or visible change.
  - **unknown:** everything else:
    - a timeout, or any exception, wherever it is thrown;
    - a missing, duplicate or mis-addressed reply;
    - our request missing, duplicated, or in a frame carrying anything else;
    - unexpected traffic or notifications, a lost record, or a socket close, reconnect or error;
    - a malformed or failing after-snapshot, or a state anomaly;
    - a created feature not bound to its added object;
    - an error reply with a state change;
    - a wrong reported depth.
- **Every stop and every exception after the plan check:** the sequencer calls `abort`, and the guard latches. If `abort` itself throws, the run still returns and its reason says that the transport may not be latched. A malformed transport result is `unknown`.
  - `report()` flags residue whenever a stopped run sent anything.
  - It shows the completed (verified) steps, every step's outcome and problems, undo before/after, per-object changes, and the last well-formed state (with whether it was observed before or after a step, and whether it was verified). It also gives the abort reason.
- **There is no retry, cancel, undo, delete or cleanup operation.** The guard exposes `exchange`, `report` and `abort` (latch only).

## 7. Tests and results

| File | Tests (actual run) | Covers |
|---|---|---|
| `server/test/writeport.test.ts` | 35 | Nine templates and nine builders byte-identical to their records. Notification-driven Modify/commit. Fail-closed notification handling. Refusals. |
| `server/test/writeseq.test.ts` | 36 | **Traffic classifier:** all nine windows (including their text pings and mesh frames), a cross-step page reply, one answer per page request, the gap classifier, another document's query, an unrequested reply. **The sequence over captured replies:** error replies, timeout, uncertain outcome + `abort`, unexpected/missing/wrong reply, preview notification, refused plan, a throwing transport, an unexpected build error (`abort` called). |
| `server/test/livewriteguard.test.ts` | 178 | Evidence checks, plus everything in §3 (all reviews) over a real-data fake document. The traffic port numbers records contiguously; one variant reads through the real `RecordStream`. |
| `server/test/recorder.test.ts` | 10 | Recorder records and redaction; `RecordStream` contiguity, reattachment, lost record, frozen records. |

**Run for this round** (2026-10-13, after the adversarial follow-up):
- `vitest run` over all 23 files: **466 passed, 0 failed, 0 skipped**. Write-path and recorder files: 35 + 36 + 178 + 10.
- `tsc --noEmit`: clean.
- **Limits of these results:** passing tests over fake ports and captured data show the guard's logic, not live behaviour. The happy path is partly circular: the fake document applies the captured undo marks, and the guard expects those marks.

**How the tests were run:**
- Vitest ran with a config in the session scratchpad that puts its cache there.
- The repo's `node_modules/.vite` cache was fingerprinted before and after the run.
- No reporter output was written into the repo.

**Mutation checks:** first review only (M1 wire correlation → 6 failures; M2 latch → 1; M3 plan values → 6; M4a/M4c → 1 each). **Not re-run** since. Each new safeguard instead has a negative test asserting the exact problem list only that branch produces (§3).

## 8. Before any live trial (each needs separate approval)

- **Live port implementations.** Read ports: `server/src/liveports.ts` `liveReadPorts` (the document-rooted read was validated live by the isolation probe). Sender: `server/src/writesender.ts`, disarmed by default, never run live.
  - **sender:** `PageSender` hands the guard-checked body to PAGE_FN's existing send mode (`getRawAsyncMessage`, PAGE_FN unchanged); only `IVY_APP_MODEL_REQ` in field 100; it keeps copies of what it sent so identity never counts our own requests;
  - **exclusivity:** Ivy exposes no per-project session list. For the first trial the user's attestation stands in for it and every report labels it `attested`, never server evidence; it covers nothing the guard cannot see (HTTP routes, pipeline requests, other clients). The proposed Ivy tool `zcad_list_sessions` would replace it;
  - **service worker:** `obs-cache.js` is allowlisted by exact URL and target id only while a read-only recorder on it has seen no WebSocket; sockets it opened before that recorder attached are not visible. Pre-existing page sockets are avoided by attaching to an empty tab first (`--target`) and loading the editor in it;
  - **thickness:** measured on plate1 (face 0 = 100 × 8 mm, perimeter 0.216, area 0.0008): the role-31004 depth is the geometric one; `\Extrude1\Depth` (10) is not;
  - **identity:** the page probe (project, tag) + the latest model socket the recorder saw created + the latest workshop head the page sent on it (`recordedTarget`) + the inspector (project active, document is a `PartReference`). **Once a sender exists, it must exclude its own request bodies, or identity confirms itself.** Inventory: `socketInventory` over the stream and a fresh `/json/list` (see §5 Limitations 1);
  - **state:** `inspectorState` with `bracketUndo`. Undo is read before and after, and the snapshot throws if the two differ. Each inspector read is queued on the project thread (source: `mcp_server.cpp` `RunInspector` → `ProjectManager::ExecutePipelineRequest`), but the snapshot is N+2 separate reads and **not atomic**. Changes that leave undo alone (previews, torn object reads) are not detected. With `documentRoot` the objects are the bound document's subtree only (`rootEntityId`; refused unless the reply is exactly a `PartReference`'s `Contain` subtree), while the undo history stays **project-wide**, shared by every document of the project. Another document's changes show only through undo. Rooted replies are tested against a simulation of Ivy's `DumpOMGraph` traversal, not against Ivy; `scripts/write-probe.ts` compares the live rooted reply with the full project graph;
  - **traffic:** the recorder writing into one `RecordStream`; `settle` is a fixed sleep.
- **Port contracts the guard relies on:**
  - **traffic:** one append-only stream per recorder attachment, where `position()` = the next record's `i` and `since(p)` = every record from `i = p` on, in order. A reattach breaks the stream; it needs a new stream and a new guard;
  - **identity:** `modelSockets()` is exhaustive, including pre-existing sockets, or says it is not;
  - **state:** fresh snapshots, never cached.
- **Not resolved by any offline fix:** the shortened sketch sequence, the stale depth id, settle timing.
- **Settle timing** on a live run.
- **Ivy's acceptance** of the shortened sketch sequence (§5, unresolved 1) and of the stale depth id.
- **A disposable target document** with no redo history.
- **Result verification** beyond the depth parameter (thickness, bounding box, volume) is still unsupported.

## 9. Plate position: what the recorded evidence establishes (baseline `runs/plate-trial-write3/`)

Date: 2026-10-14. Offline analysis of the first fully verified live plate (`write3`: all nine steps and the final check verified, verdict `plate-incomplete`). The run directory is the baseline and must stay intact. No new operation was sent for this analysis; the write path is unchanged.

**Established at the level of the model definition: Ivy's own data, already recorded, read-only.**
- **Profile in sketch coordinates.** Every sketch data notification for `Sketch1` (feature 18), including the one after the commit (record 96, version 8), reports the four lines at exactly (±50, ±30). The profile is centred on the sketch origin.
- **Sketch frame equals world frame.** In the same notification, the sketch's support is plane 3 ("XY Plane") with `supportTransform` basis identity and origin (0, 0, 0).
- **Extrusion parameters (record 96).** Roles are mapped by Ivy's `SolidExtrudeAttri` (`zplugin/part/model/inc/ivypartmodelrole.h`, starting at 31001); type 0 is `kExtrudeTypeBlind` (`ivysolidExtrude.h`):
  - type 0 = blind, depth (31004) = 8;
  - no custom direction (31005 false);
  - no start offset (31008 false, so the 10 in 31010 is inactive);
  - not symmetric (31011), no second direction (31012), not reversed (31015, 31016), no drafts (31017, 31020).
- **Sizes, measured.** Face 0 measures 100 × 8 and face 4 measures 100 × 60; the sketch dimensions are 100 and 60.

Together these specify a solid spanning x ∈ [−50, 50] and y ∈ [−30, 30] around the world origin, extruded 8 from the XY plane along its normal.

**Not established: a known verification limitation.**
- **Nothing measures the body's position.** The values above are the model's definition as Ivy reports it, not a measurement of the resulting body. None of the approved read-only operations returns position:
  - face measurement returns perimeter and area only;
  - the inspector shows B-rep and sketch content as opaque runtime state;
  - tessellation vertex data is not decoded, and none was recorded after the commit in `write3`.
- **Extrusion sense.** The direction (+Z vs −Z) follows Ivy's convention for the default direction of a blind extrude on the XY plane. With `reverse` false it is inferred to be the plane normal (+Z), but it is not shown.
- **Postconditions are unchanged.** They still report centring as not checked, so the best verdict remains `incomplete`. A check that the model *definition* is centred (the profile coordinates, frame and extrude options above) could be added as a separate, explicitly labelled postcondition. It would not be a geometric measurement and must not be presented as one.
