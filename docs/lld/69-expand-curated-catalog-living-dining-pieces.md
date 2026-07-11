# LLD 69: Expand curated catalog — living/dining pieces (armchair, coffee table, round dining table)

## Scope

Add exactly **three** curated furniture types to the existing `living` category, reusing the
established symbol pattern verbatim (LLD 45/50):

- **armchair** — single upholstered chair, distinct from the plain `chair`.
- **coffee-table** — low rectangular table.
- **dining-table-round** — circular dining table; drawn as a circle but hit-tested/measured as
  its `w×h` box like every other symbol.

The change is **strictly additive**: three new `CATALOG` entries in `src/js/symbols.js`, three
new glyph branches in `src/js/symbolRender.js`, three new `.dock-item` buttons inside the existing
`#row-living` tab panel in `src/index.html`, and test-count/coverage-array updates in
`test/tests.html`.

**Explicitly NOT in scope:**
- No new category tab (the three pieces go in the existing **Living** row).
- No new SVG rendering machinery — glyphs compose only existing primitives (`rect`/`line`/
  `circle`/`ellipse`/`polygon`).
- No changes to any symbol-handling logic: `createSymbol`, `hitTest`, `resizeSymbol`, `clampDim`,
  snapping/flush/alignment, clearance, dim chips, export, plan schema, MCP allowlist. All are
  type-agnostic and pick the new types up for free.
- No plan-schema bump (`category` and `type` remain as-is; new `type` strings are additive).
- No new dependency, no build step; client-side only.

## Approach

Three edits, each mirroring the shipped precedent (compare bed/wardrobe/toilet):

### 1. `symbols.js` — three `CATALOG` entries + typedef extension

Append the three entries under the existing `living` block; extend the `SymbolType` typedef union
with the three new literals. No function signature changes. Defaults (to-scale, metres):

| type                 | label               | w    | h    | min  | max  | notes |
|----------------------|---------------------|------|------|------|------|-------|
| `armchair`           | Armchair            | 0.80 | 0.80 | 0.40 | 1.20 | square-ish single seat |
| `coffee-table`       | Coffee Table        | 1.10 | 0.55 | 0.30 | 2.00 | low rectangular |
| `dining-table-round` | Round Dining Table  | 1.20 | 1.20 | 0.60 | 2.50 | square footprint = diameter; circular glyph |

All satisfy the catalog regression guard `min ≤ w ≤ max` **and** `min ≤ h ≤ max` (none are
openings). `min`/`max` share the single-range contract used by every furniture type.

**Type-key naming (decision):** use hyphenated keys `coffee-table` and `dining-table-round` (and
plain `armchair`). Rationale: they are the public `type` strings agents pass to MCP `place_symbol`
and the `data-type` values in the dock; hyphenated slugs are unambiguous, JSON/URL-hash safe, and
read cleanly. They are object keys and string-union literals only — no code parses or splits them,
so hyphens are inert. (Alternative: camelCase `coffeeTable`. Rejected only for consistency with
external-facing slug style; either works — recommend hyphenated.)

### 2. `symbolRender.js` — three glyph branches in `_renderInterior()`

Add three `if (sym.type === …) { … return; }` branches alongside the existing ones, using the
`lp(lx,ly)` local-to-screen helper already in scope. All coordinates derive from `sw`/`sh` (screen
w/h) so glyphs scale and rotate with the box.

- **armchair** — reuse the `sofa` composition at single-seat proportions: a back strip across the
  top (~22% depth) + two thin armrests down the sides, all as `polygon`s with `rgba(${rgb},…)`
  fills and `p.symStroke`. Reads as a chunkier `chair` with a back, visually distinct from the
  plain-circle `chair` glyph.
- **coffee-table** — an inset inner `polygon` rectangle (tabletop, ~10–12% inset on each side)
  with a faint `rgba(${rgb},0.06)` fill + `p.symStroke`. Simple, low, tasteful; distinct from the
  `table` cross-lines glyph.
- **dining-table-round** — a `circle` centered on `sc` with
  `r = Math.min(sw, sh) / 2 * ~0.94` (fills the box, reads round), `fill:none`,
  `stroke:p.symStroke` + a concentric inner ring `circle` at ~0.6·r, faint opacity, for a tabletop
  read. Rotation-invariant by construction (concentric circles), so no `transform` needed. The
  square `w×h` footprint (min=max ratio 1:1 default) makes the box a tight bounding square. Do NOT
  draw a rect glyph — only the circle(s).

The circle uses the same absolute-screen-center approach as the existing `chair`/`stove`/`washer`
circle glyphs; the `ellipse`-with-`rotate()` precedent (toilet) is available if a future non-square
default is wanted, but concentric circles need no rotation handling.

### 3. `index.html` — three `.dock-item` buttons in `#row-living`

Insert three buttons into the existing `<div class="dock-row" … id="row-living">` (currently ends
after `bookshelf` at line ~2164), matching sibling markup exactly: `class="dock-item"`,
`data-type="…"`, `aria-label="Add …"`, an inline 18×18 `aria-hidden` SVG mini-icon using
`currentColor`, and a `<span>` label. Suggested mini-icons (blueprint style, thin strokes):

- **armchair** — rounded-rect seat with a top back-bar and two side arm bars (a compact sofa).
- **coffee-table** — rounded rect with a faint inner inset rect.
- **dining-table-round** — a `circle` (`cx=9 cy=9 r=6`) with a faint inner `circle` (`r=3.2`).

No tab, no CSS, and no controller changes — the buttons inherit `.dock-item` styling and the
existing `symbolTool._onDockPointerDown` `[data-type]` drag pipeline.

**Why low-risk / natural boundary:** every consumer keys off `CATALOG`, `sym.type`, or
`[data-type]`. Adding entries/branches/buttons is purely additive; nothing branches on a closed
type set except the render/dock, both of which we extend.

## Interfaces / Types

### `src/js/symbols.js`

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"armchair"|"coffee-table"|"dining-table-round"} SymbolType */

// appended inside CATALOG, living block:
armchair:            { label: "Armchair",           category: "living", w: 0.80, h: 0.80, min: 0.40, max: 1.20 },
"coffee-table":      { label: "Coffee Table",       category: "living", w: 1.10, h: 0.55, min: 0.30, max: 2.00 },
"dining-table-round":{ label: "Round Dining Table", category: "living", w: 1.20, h: 1.20, min: 0.60, max: 2.50 },
```

No new exported functions. `createSymbol`, `clampDim`, `resizeSymbol`, `hitTest`, `corners`,
`aabb` operate on the new entries unchanged.

### `src/js/symbolRender.js`

Three private glyph branches added to `_renderInterior(parent, sym, cs, p)` — no new exports, no
signature change. Uses existing `lp()`, `_makeLine()`, `sw`/`sh`, `p.symStroke`, `p.symInkRgb`.

### `src/index.html`

Three `.dock-item` `<button>` elements appended to `#row-living`. No new IDs, no JS.

### Files that do NOT change

`plan.js` (serialize/validate/schema), `clearance.js`, `exportImg.js`, `symbolDimEntry.js`,
`symbolTool.js`, `dockTabs.js`, `main.js`, and `mcp/src/tools.js` (`tool_place_symbol` gates on
`type in CATALOG` — the new keys are accepted with no allowlist edit).

## State Model

- **Persisted / plan state:** new symbols are ordinary `Sym` records `{id,type,x,y,w,h,rot}` with
  `type` ∈ the three new slugs. `serializePlan` → localStorage / JSON / URL-hash and `validatePlan`
  are untouched; `PLAN_SCHEMA` unchanged. A plan containing the new types round-trips through JSON
  and the URL hash because validation gates only on `sym.type in CATALOG`.
- **`category`** is dock-only presentation metadata (not a `Sym` field, not serialized); all three
  are `"living"`.
- **Backwards compat:** old plans (without these types) load unchanged. A plan authored with the
  new types opened in an older build fails validation exactly as any unknown type would today —
  existing forward-compat behavior, no schema change.
- No change to selection, ghost, guides, history, or in-memory dock tab state.

## Edge Cases

1. **Round table selection/rotation/fit-test** — footprint is the `w×h` box (default square).
   `hitTest`, selection overlay, rotate handle, and clearance all use the box; only the drawn glyph
   is circular. A rotated round table shows an unchanged circle (rotation-invariant) but its
   selection box and dim chips rotate normally. Assert box-based hit-test in tests.
2. **Round table resize** — dim chips edit `w` and `h` independently; a non-square result draws an
   ellipse-looking circle only if `r=min(sw,sh)/2·k` — chosen `min()` keeps the circle inscribed in
   the box (never overflows). Acceptable and consistent; the default is square. (No aspect lock.)
3. **`armchair` vs `chair` distinctness** — different default size (0.80 vs 0.50) and glyph (back +
   arms vs bare circle); both remain in the Living row. Verify both dock buttons place distinct
   types.
4. **Hyphenated type keys** — `data-type="coffee-table"` reads via `dataset.type` as
   `"coffee-table"` (dataset does not camel-convert hyphenated values without further segments here;
   `data-type` is a single-segment attr so `dataset.type` === the literal). `type in CATALOG` and
   `CATALOG[type]` resolve correctly. Confirm in a placement test.
5. **Clamp bounds** — `dining-table-round` min 0.60 prevents a degenerate tiny circle; max 2.50
   caps a banquet table. `coffee-table` min 0.30 matches the family default.
6. **MCP `place_symbol`** — passing `type:"armchair"` (etc.) succeeds with no manual allowlist;
   dims route through `clampDim`. Passing an unknown type still returns `{ok:false}`.
7. **Export (PNG/SVG/JSON)** — glyphs use only standard SVG elements already emitted by the render
   path; export is type-agnostic and includes them with no special-casing.

## Dependencies

Nothing must be built first. Extends already-shipped subsystems:
- `src/js/symbols.js` `CATALOG` (LLD 12/45).
- `src/js/symbolRender.js` `_renderInterior` glyph dispatch (LLD 45).
- `src/index.html` `#row-living` dock panel + `.dock-item` markup/CSS (LLD 46/50).
- `src/js/symbolTool.js` `[data-type]` drag contract (unchanged).
- `mcp/src/tools.js` `tool_place_symbol` `type in CATALOG` gate (unchanged).

## Test Requirements

Update and extend `test/tests.html`:

**Update existing counts/arrays (must stay green):**
- The dock-integrity test asserting the union of `.dock-item[data-type]` equals the catalog keys
  and `types.length` — bump from **16 → 19** and add the three types to the `living` array in
  `_makeDockDOM`'s `itemsByCategory`.
- Any coverage array enumerating symbol types (e.g. `LLD45_TYPES`-style spot lists) — add the three
  new types where "all new types" coverage is asserted, or add a parallel `LLD69_TYPES` list.

**Unit — catalog integrity (extend existing suites):**
- Each new type exists in `CATALOG` with `category === "living"`, a non-empty `label`, finite
  `w/h/min/max`, and `min ≤ w ≤ max` **and** `min ≤ h ≤ max`.
- `createSymbol(type, x, y)` for each new type returns catalog `w/h`, `rot:0`, unique `s<n>` id.
- `clampDim`: `dining-table-round` clamps below 0.60 → 0.60 and above 2.50 → 2.50; `coffee-table`
  in-range value unchanged; `resizeSymbol` returns the correct changed flag.

**Unit — round table footprint (box semantics):**
- `hitTest(diningRound, cx, cy)` true at center; a point just outside the `w×h` box but inside the
  circumscribed circle is **outside** (footprint is the box, not the circle) — and a point inside
  the box corner (outside the inscribed circle) is **inside** (confirms box, not circle, governs
  picking).
- `corners()` / `aabb()` for a rotated round table match the box (unchanged geometry).

**DOM — dock:**
- `#row-living` (or the test dock's living row) contains the three new `.dock-item[data-type]`
  buttons; none is a `[role='tab']`; all carry `aria-label`.

**Integration — round-trip (plan.js suite):**
- A plan containing one of each new type passes `validatePlan(buildPlan())` and survives
  `serializePlan` → `JSON.parse` → `validatePlan` unchanged (covers JSON + URL-hash round-trip).

**MCP (if the MCP suite is exercised):**
- `tool_place_symbol({type:"dining-table-round", x, y})` returns `{ok:true}` with the placed type;
  no allowlist edit needed.

**Manual / QA (not automated):** each piece appears in the Living tab, drags onto the grid,
resizes via dim chips within min/max, and exports to PNG/SVG. The round table reads visibly
circular at multiple zooms yet selects/rotates/fit-tests as its box.
