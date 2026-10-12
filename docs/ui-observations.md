# Ivy UI observations (playbook evidence)

Only what has actually been observed. Source: screenshots supplied by the human (Brave, `https://local.zixel.cn:8080/a/mda/zcad?id=…&projectId=…`, UI language English). Claude's own browser tools couldn't load the editor: the built-in pane blocks `local.zixel.cn` sub-resources, and the Chrome extension isn't connected.

## Empty part editor (screenshot 1, 2026-10-12)

- **Header (top left):** app menu icon ▾ · document name `Unnamed Proj…` · `Part` ▾ dropdown · panel toggle icon.
- **Header (top right):** user avatar · `Share/Export` button.
- **Feature tree** (left panel titled `Feature`, with a search icon):
  - `Part`
    - `Default Geometry`
      - `XY Plane` (eye toggle)
      - `YZ Plane` (eye toggle)
      - `ZX Plane` (eye toggle)
    - `Part Body`
- **Viewport:** XYZ triad at the centre. View cube top right, with a fit-view and a display icon.
- **Right rail:** icons, including `fx` (formulas/parameters) and a checklist icon. Their labels haven't been observed yet.
- **Workbench tabs** (bottom): `Part` (active) · `Sheet Metal` · `Surface` · `Weldment` · `Piping` · `Smart Design` · `Analysis` · `MBD`.
- **Part toolbar** (bottom): the first button is the text button **`New Sketch`** with a dropdown corner. Every other button is icon-only, and their tooltips haven't been observed yet.
- **Naming:** feature names are stored in the creation locale (the inspector showed `草图1`, `拉伸1`), so the UI language doesn't determine them. The playbook must not rely on feature names matching the UI language.

## Still needed (for `server/playbook/*.md`)

1. `New Sketch`: how the plane is chosen (click `XY Plane` in the tree, or a dialog?) and how the sketch mode looks.
2. The rectangle tool in sketch mode: its label/tooltip, and how exact width and height are entered (dimension input fields and their labels).
3. Exiting the sketch: button label.
4. Extrude: which toolbar icon (tooltip), the dialog title, the depth field label, and the confirm button label.
5. Deleting a feature: the right-click menu item label on a feature-tree node, and whether a confirm dialog appears.
6. Creating a new part document from the workspace (`Back to Workspace` → new part flow).
