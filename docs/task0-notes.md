# Task 0: Capture Notes

## Environment
- Frontend URL: `https://local.zixel.cn:8084`
- Backend: Local `zcad_service` at `ws://127.0.0.1:8081`
- Project ID: `37649139`
- Saving behavior: Ivy auto-saves. No separate manual-save action is available.

## Capture validation

All eight captures were inspected. They belong to the same project, objects were found in every capture, and no capture errors were reported.

| Capture | Label | Validation |
|---|---|---|
| 1 | `00-empty-part` | Passed reported checks |
| 2 | `01-after-sketch` | Passed reported checks |
| 3 | `02-after-extrude` | Passed reported checks |
| 4 | `03-after-edit-sketch` | Passed reported checks |
| 5 | `04-after-delete-extrude` | Passed reported checks |
| 6 | `05-after-failed-op` | Passed reported checks |
| 7 | `06-after-undo` | Passed reported checks |
| 8 | `07-after-reopen` | Passed reported checks |

## Saving behavior
Ivy auto-saves, and there is no separate manual-save action to capture. The final capture is `07-after-reopen`, taken after reopening the document.

## Limitations
The capture checks establish that the inspector returned objects and no capture errors were reported. They do not, by themselves, prove that every geometry operation succeeded, that Undo reverted the intended operation, or that all geometry and parameters persisted correctly. Those behaviors must be recorded only to the extent verified from the actual UI and captured data.

## Browser console errors
No capture errors were reported. Browser console errors were not independently confirmed here.
