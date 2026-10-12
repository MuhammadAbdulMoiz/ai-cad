# Task 0 capture: what the human does

## 1. Prepare Ivy

1. Copy `.env.example` to `.env` if `.env` doesn't already exist.
2. Run `start-ivy.bat` and wait until the frontend window prints its local URL.
3. Set `FRONTEND_URL` in `.env` to the actual frontend URL.
4. Open that URL in your normal browser and log in.
5. Enable the local backend if needed by running this in the browser's DevTools Console (F12):

   ```js
   localStorage.setItem('use_local_server', 'true');
   ```

   Reload the page and confirm the frontend connects to the local `zcad_service` at `ws://127.0.0.1:8081`.

6. Create a **new empty part** in a **disposable test project**. These steps delete features and use Undo, so never use real work.

## 2. Capture the eight states

In `server/`, run the probe command after completing each action in Ivy.

| # | Do this in Ivy first | Then run |
|---|---|---|
| 1 | Open the empty part. Make no changes. | `pnpm probe 00-empty-part` |
| 2 | Create one rectangular sketch on the XY plane, 100 × 60 mm. Exit the sketch. | `pnpm probe 01-after-sketch` |
| 3 | Extrude the sketch by 8 mm. | `pnpm probe 02-after-extrude` |
| 4 | Edit the sketch and change 100 mm to 120 mm. Exit the sketch and wait for the extrude to update. | `pnpm probe 03-after-edit-sketch` |
| 5 | Delete the extrude feature from the feature tree. | `pnpm probe 04-after-delete-extrude` |
| 6 | Attempt an extrude that fails, such as using a depth of 0 or selecting nothing. Record exactly what the UI shows. | `pnpm probe 05-after-failed-op` |
| 7 | Press Ctrl+Z once. Record exactly what Undo reverts. | `pnpm probe 06-after-undo` |
| 8 | Allow Ivy to auto-save, close the document, then reopen the same document. Confirm that it is the saved document and record what persisted. | `pnpm probe 07-after-reopen` |

There is **no separate manual-save capture** because Ivy auto-saves and does not provide the manual-save action assumed by the original guide. The reopen capture is used to check persistence.

## 3. Rules for every capture

- Wait until Ivy has finished recomputing. Do not probe while a spinner or progress indicator is active.
- Check the printed project ID. It must remain the same throughout, including after reopening. If several projects are open, specify the intended project:

  ```powershell
  pnpm probe <label> --project <id>
  ```

- If the probe prints errors, a warning, or zero objects, investigate and retake that label. Retaking a label replaces its existing capture.
- A successful exit does not guarantee valid evidence. Open each capture's `errors.json`. It should contain `{}`, except for an error that is the expected result of the failed-operation step. Document that exception in the notes.
- If a step cannot be reproduced in the UI, record **"not reproducible"** and explain why. Do not invent an outcome.

## 4. Write the notes

Create `docs/task0-notes.md` and record:

- The frontend URL used.
- The actual UI clicks for each step, including toolbar names and dialog field labels.
- The failed operation attempted and the exact UI response.
- What Ctrl+Z reverted.
- Confirmation that Ivy auto-saved, and what persisted after closing and reopening.
- Any browser console errors observed through DevTools (F12).
- Any steps that were not reproducible.

Record only what you actually observed. If a detail wasn't recorded, say so.

## 5. Commit the evidence

From the repository root, run:

```powershell
git add server/test/fixtures docs/task0-notes.md docs/task0-capture.md
git commit -m "test: Task 0 inspector captures"
```

Before committing, confirm that all eight expected capture directories are present and that the notes accurately describe the observed behavior.

## 6. Finish the evidence gate

Tell the agent **"captures done"** after the captures and notes are committed.

The next step is to review `docs/inspector-fields.md` against the raw captures before implementing verifier code. Any inspector field or behavior that the evidence cannot establish must remain explicitly unsupported.