# LLD 139: Catalog — add fireplace type (focal element)

## Scope

Follow-up from **LLD 72a** "Catalog gaps" row #5 (GitHub issue #139). The
`floorplan-interior-design` skill treats a **fireplace** as the *top* living-room focal
priority (C1: fireplace > TV > picture window > longest blank wall,
`references/living-room.md:9`), but there is **no `fireplace` type** in `CATALOG`
(`src/js/symbols.js`). `tv` is the only modelled focal object; a window/opening or a blank
wall can only be *designated* focal by the agent's intent. Today the skill's workaround is
explicit: "There is no `fireplace` catalog type, so if the brief implies one, designate a
wall (or a window/`tv`) as the focal instead."

**This LLD covers** adding **one** new furniture type to the catalog:

- **`fireplace`** — a wall-anchored, shallow-depth focal element (default **1.30 × 0.40 m**),
  in the existing **`living`** category, with per-axis bounds and named presets like the rest
  of the catalog. Its footprint band sits alongside `tv` (both shallow, wall-hugging focal
  pieces) so the skill can place and orient seating toward a *real* fireplace object rather
  than only inferring a focal from a wall or window.

The work is **purely additive catalog data** plus the matching dock entry, the `SymbolType`
typedef, and the two test fixtures that enumerate catalog/dock types.

**This LLD explicitly does NOT cover:**

- Any change to `plan.js`, rendering (`symbolRender.js`, `isoRender.js`, `render3d.js`),
  resize/clamp/snap logic (`resizeSymbol`, `clampDim`, `snapToPreset`), export (PNG/SVG/JSON),
  share-hash, or MCP tool code. The new type flows through all of those unchanged because they
  are data-driven (see Approach).
- Any new dock **category/tab**. `fireplace` goes in the existing `living` tab.
- **Wiring the interior-design skill** to reference the new type. The C1 focal-priority logic
  *can* then point at a real `fireplace`, but editing the skill prose is a separate follow-up
  (noted under Dependencies) and out of scope here — this LLD only makes the type exist.
- A bespoke interior glyph in the renderers. `fireplace` falls back to the base labelled box
  (acceptable; a dedicated glyph is optional polish, not in scope).

## Frontend Design

**Decision: Option A — add a single `fireplace` type to `CATALOG` in the existing `living`
category, following the exact shape of existing catalog entries. Purely additive.**

Rationale:

- The dock is organized by room *area* (`openings`, `living`, `kitchen`, `bedroom`, `bath`,
  `outdoor`). A fireplace is a living-room focal piece and belongs naturally under `living`,
  next to `tv`. No new `SymCategory`, tab, palette group, or `dock-row` panel is warranted for
  one additive type.
- Placing it in `living` means the swatch strip works with no code change:
  `swatchGroupsForCategory("living")` returns `["wood","upholstery","neutral"]`, appropriate
  for a fireplace surround (wood mantel / neutral stone or matte black insert).
- **Model it after the adjacent focal/wall pieces `tv` and `window`:** wall-anchored, shallow
  depth, continuous resize between named presets. It is **not** `openings` (it is a solid
  object with a real depth footprint and two editable axes, unlike a door/window whose depth is
  pinned to the wall marker), **not** `circular`, and **not** `discrete`.

**Dock entry.** Add one `<button class="dock-item" data-type="fireplace">` inside the existing
`#row-living` panel (`src/index.html`, alongside `tv` ~L2619 / after the living items), with an
inline SVG glyph and a `<span>` label, matching the surrounding markup exactly. No JS wiring is
needed: `symbolTool._onDockPointerDown` reads `data-type` generically and validates against
`CATALOG[type]`, so a new `data-type` that exists in `CATALOG` is placeable, selectable,
resizable, and shows its preset chips automatically. The category tab already exists.

**Rendering.** No new glyph code in `symbolRender.js` / `isoRender.js` / `render3d.js`.
`_renderInterior` has no branch for `fireplace`, so it draws as a plain labelled box (the same
graceful fallback other detail-light types use). The 2.5D/3D renderers resolve extrusion height
generically from `cat.z ?? 0.75` (`isoRender.js:305`, reused by `render3d.js`), so the new type
extrudes correctly once its catalog entry carries a `z`. A dedicated interior glyph is deferred.

**Preset chips + inspector.** `fireplace` gets `presets`, so the inspector's preset-chip row
(`symbolTool._renderPresetChips`) renders its named sizes automatically with a trailing "Custom"
chip — no code change. The frontend surface is therefore: **catalog data + typedef + one dock
button**, nothing else.

## Approach

**Data-only addition to the shared catalog.** `CATALOG` in `src/js/symbols.js` is the single
source of truth; the MCP re-exports it verbatim via the `floorplan://catalog` resource. Every
downstream behavior — `createSymbol` (defaults), `clampDim` (per-axis bounds),
`snapToPreset`/`resizeSymbol` (presets), the inspector preset chips, iso/3D extrusion height,
`place_symbol`'s clamp + `preset:` resolution, and `set_brief` furniture validation — reads the
catalog generically. Adding one well-formed entry makes the type fully functional across the
editor and the MCP with **no logic change**.

**Not `openings`, `circular`, or `discrete`.** `fireplace` resizes continuously within its
bounds (like `sofa`, `tv`, `desk`); its presets are named convenience sizes (snap-to-preset in
`resizeSymbol` only fires for `discrete` types). This matches "wall-anchored, shallow depth,
pickable real sizes" — the user can nudge to an exact size, and the skill can cite a named
preset.

**Chosen dimensions (metres), grounded in real products** (mainstream electric-fireplace inserts,
mantel consoles, and masonry surround footprints — Dimplex/Napoleon/ClassicFlame insert widths,
West Elm / mantel-surround depths):

- **`fireplace`** — default **1.30 × 0.40 m**; bounds **w 0.75–2.00, h 0.15–0.60**, **z 1.10**.
  - `w` (1.30 default) spans a compact wall insert up to a wide masonry surround; the band
    deliberately overlaps `tv`'s width band because both are wall-hugging focal pieces of
    similar visual scale.
  - `h` (depth) is **shallow** — a flush wall-mounted electric insert protrudes ~0.15 m, a
    mantel/media console ~0.35–0.45 m, a masonry hearth ~0.5 m. The wide `min_h` 0.15 lets a
    thin insert seat nearly flush to the wall (like `tv`), while `max_h` 0.60 covers a
    protruding hearth.
  - `z` 1.10 m is a typical mantel/insert top height for the extrusion preview (between `tv`
    0.70 and `bookshelf` 1.80).
  - Presets (every pair within the per-axis bounds):
    `Wall insert 30"` (0.76 × 0.18), `Electric 42"` (1.07 × 0.30),
    `Mantel 48"` (1.22 × 0.40), `Surround 60"` (1.52 × 0.45), `Hearth 72"` (1.83 × 0.50).

**Invariant to preserve (enforced by existing tests):** `min_w ≤ w ≤ max_w`,
`min_h ≤ h ≤ max_h`, all six numbers plus `z` finite, non-empty `label`, valid `category`
(`living`), and every preset `{w,h}` within the per-axis bounds.

## Interfaces / Types

**1. `SymbolType` typedef** (`src/js/symbols.js`, ~L13-19) — add the `"fireplace"` literal to
the union, in the `living`-adjacent group next to `tv`:

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"armchair"|"coffee-table"|"dining-table-round"
 *   |"monitor"|"gaming-chair"|"fireplace"
 *   |"nightstand"|"dresser"|"cabinet"
 *   |"patio-table"|"patio-chair"|"parasol"|"planter"
 *   |"rug"} SymbolType */
```

**2. `CATALOG` entry** (`src/js/symbols.js`, in the `// Living` block, near `tv`) — one new key
following the exact shape of existing entries
(`{label, category, w, h, min_w, max_w, min_h, max_h, z, presets?}`):

```js
  fireplace: {
    label: "Fireplace", category: "living", w: 1.30, h: 0.40,
    min_w: 0.75, max_w: 2.00, min_h: 0.15, max_h: 0.60, z: 1.10,
    presets: [
      { name: "Wall insert 30\"", w: 0.76, h: 0.18 },
      { name: "Electric 42\"",    w: 1.07, h: 0.30 },
      { name: "Mantel 48\"",      w: 1.22, h: 0.40 },
      { name: "Surround 60\"",    w: 1.52, h: 0.45 },
      { name: "Hearth 72\"",      w: 1.83, h: 0.50 },
    ],
  },
```

**3. Dock button** (`src/index.html`, inside `#row-living`, near the `tv` button) — one
`.dock-item` button with an inline SVG glyph, matching the existing pattern:

```html
<button class="dock-item" data-type="fireplace" aria-label="Add fireplace">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2" y="3" width="14" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
    <path d="M9 12c-1.2-.8-1.2-2 0-3 .6 1 1.6 1.2 1.6 2.2A1.6 1.6 0 0 1 9 12z"
          fill="currentColor"/>
  </svg>
  <span>Fireplace</span>
</button>
```

(The exact glyph paths are the implementer's to refine — the load-bearing attributes are
`data-type="fireplace"` and the `#row-living` placement. Use `aria-label="Add fireplace"`,
distinct from the existing dock labels.)

**No signature changes.** No function in `symbols.js`, `symbolTool.js`, the renderers, or the
MCP is modified. `createSymbol("fireplace", x, y)` works by virtue of the catalog lookup.

## State Model

**No new state, no persistence change, no schema change.** A placed `fireplace` is an ordinary
`Sym` (`{id, type, x, y, w, h, rot, color?}`) in `symbols.model.symbols`, exactly like every
other symbol. It:

- **Serializes** into the plan JSON, PNG/SVG export, and the share-hash with zero new fields —
  the serializer walks `model.symbols` generically.
- **Hydrates** back losslessly (`hydrate` is type-agnostic; `_counter` reconciliation is by
  `s<n>` id, unaffected).
- **Round-trips through the MCP** as a normal symbol; `place_symbol {type:"fireplace"}` succeeds
  because the type is now `in CATALOG`.

**Backward compatibility:** older saved plans and share links contain no `fireplace`, so nothing
changes for them. A plan authored with the new type will fail to render that *specific* symbol on
an older deployment lacking the catalog entry — the same forward-compat property every prior
additive catalog LLD (45/50/76/104) already accepts; no migration is needed.

## Edge Cases

1. **No interior glyph.** `_renderInterior` has no branch for `fireplace`, so it renders as a
   plain box with the base fill/stroke, and extrudes to `z` 1.10 in the 2.5D/3D previews via the
   generic `cat.z ?? 0.75` path. Selectable, resizable, labelled. Intended graceful fallback,
   not a defect.
2. **`fireplace` vs `tv` overlap.** Both are shallow wall-anchored `living` focal pieces and
   their width bands overlap by design (they are similar-scale focal objects). They are
   distinguished by `label` ("Fireplace" vs "TV"), by the dock glyph, and by the type itself —
   the skill picks whichever the brief implies (C1 puts fireplace above TV in focal priority).
3. **Shallow depth / wall-flush.** `min_h` 0.15 lets a thin insert seat nearly flush to the
   wall. Wall-flush snapping (`nearestWallFlush`) operates on the AABB from `w`/`h` and is
   type-agnostic, so `fireplace` seats against a wall for free, like `tv`.
4. **Preset within bounds.** Every authored preset `{w,h}` must satisfy the per-axis bounds or
   the LLD-45-style integrity test fails. Verified above; do not widen a preset past a bound
   without also widening the bound.
5. **Swatch category.** `fireplace` is `living`, so `swatchGroupsForCategory("living")` →
   `["wood","upholstery","neutral"]` supplies color swatches; no new palette group needed.
6. **Alignment / clearance** all operate on the AABB from `w`/`h` and are type-agnostic; the new
   type gets neighbor alignment and room-center snapping for free, with no special casing.

## Dependencies

**All present in `main`; nothing blocks this LLD.**

- **The per-axis-bounds + presets + `z` catalog** (`src/js/symbols.js`, `CATALOG`) — the shape
  this LLD extends.
- **The generic dock** (`src/index.html` `#row-living`; `symbolTool._onDockPointerDown`) — reads
  `data-type` and validates against `CATALOG`; no per-type wiring.
- **Generic extrusion height** (`isoRender.js:305` `cat.z ?? 0.75`, reused by `render3d.js`) —
  renders the new type at `z` 1.10 with no renderer change.
- **The MCP catalog re-export** (`floorplan://catalog`) — surfaces `fireplace` to the
  interior-design skill automatically.
- **LLD 72a** ("Catalog gaps" row #5) — the source of this gap; its living-room reference is the
  intended consumer.

**Enables (not required by this LLD, listed for the follow-up):** a follow-up edit to
`.claude/skills/floorplan-interior-design/references/living-room.md` (C1) and `SKILL.md` can
replace the "there is no `fireplace` catalog type, so designate a wall instead" workaround with
placing a real `fireplace` and orienting the primary seating's front at it (B4, ≤ ~25°). That
prose update is intentionally out of scope here and should be filed/handled separately so the
catalog change ships cleanly on its own.

## Test Requirements

Follows the existing LLD-45-style catalog-integrity pattern in `test/tests.html`.

**Required test-fixture edits (not optional — the suite fails or silently under-covers without
them):**

- **`LLD45_TYPES` array** (`test/tests.html:1978-1979`) — the hardcoded array the
  catalog-integrity and `createSymbol` suites iterate. Append `"fireplace"`. If omitted, the
  parameterized assertions never touch the new type and it ships untested; the implementer must
  edit this array.
- **`itemsByCategory` map in `_makeDockDOM()`** (`test/tests.html:9363-9365`) — a **hardcoded
  synthetic dock**, NOT parsed from `index.html`. Add `"fireplace"` to the `living` entry. This
  edit **is required to keep the suite green**: the LLD-50 test asserts the union of all
  `dock-item[data-type]` equals `Object.keys(CATALOG)` *exactly* and throws on mismatch. Adding
  `fireplace` to `CATALOG` without adding it here makes that equality check fail.

**Unit (browser suite, `test/tests.html`):**

- **Catalog integrity** (extends the LLD-45 block): `fireplace` exists in `CATALOG`; category is
  `living` (valid); `label` non-empty; `w/h/min_w/max_w/min_h/max_h/z` all finite;
  `min_w ≤ w ≤ max_w` and `min_h ≤ h ≤ max_h`; not `openings`, not `circular`, not `discrete`.
- **Preset validity:** every preset has `{name, w, h}` with `min_w ≤ p.w ≤ max_w` and
  `min_h ≤ p.h ≤ max_h`.
- **`createSymbol`:** `createSymbol("fireplace", x, y)` returns a `Sym` with the catalog default
  `w/h` (1.30 × 0.40), `rot:0`, and a unique `s<n>` id.
- **`clampDim`:** width/depth below `min` clamps to `min`, above `max` clamps to `max`, for both
  axes.
- **Continuous (not discrete) resize:** `resizeSymbol(sym,"w",v)` / `("h",v)` to an in-range
  value *between* presets keeps that value (no snap) — mirrors the `sofa`/`tv` continuity tests.
- **JSON round-trip:** a placed `fireplace` serializes and hydrates losslessly (type, w, h, rot,
  id preserved).

**Integration / MCP (`mcp/test/*.test.js`):**

- **`place_symbol`:** `{type:"fireplace"}` succeeds and returns the clamped catalog-default
  footprint.
- **`preset:` resolution:** `place_symbol {type:"fireplace", preset:"Mantel 48\""}` resolves to
  the named preset `{w,h}`; an unknown preset name is rejected with the valid-names list
  (existing behavior — just confirm the new type participates).
- **`set_brief` furniture validation:** a brief listing `fireplace` is accepted (type
  `in CATALOG`).

**DOM / dock (manual or existing dock test):**

- The dock button appears under the `living` tab, carries `data-type="fireplace"`, and
  drag-places a `fireplace`. A manual check that the placed box renders and is selectable is
  sufficient given no new render branch.

**Regression:** with the two required fixture edits (`LLD45_TYPES` and the `_makeDockDOM`
`itemsByCategory.living` map), the full suite (`node .github/run-tests.mjs` + `cd mcp &&
node --test`) stays green. The LLD-50 dock-integrity test derives its expected count from
`Object.keys(CATALOG).length` (no manual count to bump) but demands the synthetic dock's
`data-type` set equal the catalog keys exactly, so the `itemsByCategory` edit is mandatory. No
other existing assertion should break.
