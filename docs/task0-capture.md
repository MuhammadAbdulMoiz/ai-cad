# Task 0 capture: what the human does

1. Copy `.env.example` to `.env`. Run `start-ivy.bat` and wait until the frontend window prints its local URL. Put the real URL in `.env` as `FRONTEND_URL`.
2. Open that URL in your normal browser, log in, and create a **new empty part** document in a **disposable test project**. The sequence deletes, undoes, saves and reopens, so never use real work.
3. In `server/`, run each capture at the moment described.

Rules for every capture:
- Wait until Ivy has finished recomputing (no spinner/progress) before running the probe.
- Check the printed project id. It must be the same document every time (and must be the reopened one in step 9). If several projects are open, use `pnpm probe <label> --project <id>`.
- If the probe prints errors, a WARNING, or 0 objects, fix the situation and re-run the same label (re-running replaces that capture).
- A probe that exits normally is not proof of good evidence: open that label's `errors.json`. It must be `{}`, unless the error is the expected outcome of step 6, in which case say so in the notes.

| # | Do this in Ivy first | Then run |
|---|---|---|
| 1 | Nothing (empty part open) | `pnpm probe 00-empty-part` |
| 2 | Sketch on XY plane: one rectangle 100 × 60 mm, exit sketch | `pnpm probe 01-after-sketch` |
| 3 | Extrude that sketch 8 mm | `pnpm probe 02-after-extrude` |
| 4 | Edit the sketch: change 100 → 120 mm, exit (extrude updates) | `pnpm probe 03-after-edit-sketch` |
| 5 | Delete the extrude feature from the feature tree | `pnpm probe 04-after-delete-extrude` |
| 6 | Try an extrude that fails (depth 0, or nothing selected), and note what the UI shows | `pnpm probe 05-after-failed-op` |
| 7 | Undo once (Ctrl+Z) | `pnpm probe 06-after-undo` |
| 8 | Save the document (note the exact clicks and file name) | `pnpm probe 07-after-save` |
| 9 | Close and reopen the saved document | `pnpm probe 08-after-reopen` |

4. In `docs/task0-notes.md`, write down: the frontend URL, the clicks for each step (toolbar names, dialog field labels), what the failed op showed, for step 7 what the undo reverted, and any browser console errors (F12).
5. Commit: `git add server/test/fixtures docs/task0-notes.md` and then `git commit -m "test: Task 0 inspector captures"`.
6. Tell the agent "captures done". If a step is impossible in the UI, write "not reproducible" for it in the notes and continue.
