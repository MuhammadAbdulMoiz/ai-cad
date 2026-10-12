# Skill: rectangular plate

**Use for:** base plates, mounting plates, spacers, and the main body of simple brackets and enclosure lids, i.e. any prismatic body with a rectangular outline and uniform thickness.

**Status:** pattern defined, **not yet verified on a live build**. See `expected.json`, where `status` is `unmeasured`.

## Modelling approach
1. Name the driving dimensions as parameters (`width`, `height`, `thickness`), so later features and edits reference names, not numbers.
2. One sketch on `XY` holding a single `rectangle` profile (`width` × `height`), centred at the origin unless the design needs an offset (`cx`, `cy`).
3. One blind `extrude` of that sketch by `thickness`, with operation `add`.

## Valid sequence (feature plan)
`sketch(XY, rectangle)` → `extrude(add, depth)`. See `plan.json`.

## Known failure modes
- **Zero or negative dimension:** the validator rejects it before execution, and the backend rejects it too ("rectangle is W by H").
- **Cut before any body:** the validator rejects it.
- **Holes, fillets and chamfers** on the plate are not available yet: they're generic features whose request path is unverified. Plan them as separate, later features and mark them unsupported. Never approximate them silently.
- **Placement:** the Toolbox builder offsets each build by (d, -d, 0) with d = placementIndex × slotPitch (toolbox_part_builder.cpp). 110 mm is only the default pitch (library.json may change it) and index 0 has no offset. This is from code, not yet verified live, so don't rely on absolute coordinates.

## Verification
- **Feature history:** exactly one new `ivy::FeatSketch` and one `ivy::SolidExtrude`, and the extrude depends on the sketch.
- **Geometry** (once the query tools exist): volume ≈ `width × height × thickness`, and AABB extents equal to (`width`, `height`, `thickness`).
- Expected values become regression evidence only after they've been **measured** on a live build (`expected.json`).

## Maturity
Concept geometry only. No manufacturing, tolerance or load validation is implied.
