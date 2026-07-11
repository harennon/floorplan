# LLD 76: Add Outdoor/patio category with a curated starter set (patio table, patio chair, parasol, planter)

## Scope

Adds a sixth symbol category, **`outdoor`**, and four curated to-scale pieces:
patio table, patio chair, parasol, planter. This is a pure data + markup + glyph
increment following the exact add-a-symbol pattern established by the merged
#77/#78 work (LLD 45/50) — no new mechanism is introduced except the one new
category value and its matching tab/panel pair in the dock.

In scope:
- One new `SymCategory` value (`"outdoor"`) and four `SymbolType` values.
- Four `CATALOG` entries (`category: "outdoor"`).
- Four glyph branches in `_renderInterior()`, composed **only** from existing SVG
  primitives (`line`, `polygon`, `circle`, `ellipse`).
- One new tab button + one new tabpanel row in `src/index.html`, mirroring existing
  markup exactly (ids, `aria-controls`/`aria-labelledby`, `hidden`).
- Updates to the category/type-enumeration tests.

Explicitly NOT in scope:
- No changes to `dockTabs.js` (it is generic — reads tabs/rows from the DOM).
- No changes to placement, resize, rotate, clearance/fit-test, export
  (PNG/SVG/JSON), or URL-hash share code — all are type-agnostic and inherit the
  new types for free.
- No manual allowlist edit in the MCP: `place_symbol` gates on `type in CATALOG`
  (`mcp/src/tools.js:265`), so the new types are accepted automatically.
- No new SVG primitive. Any piece requiring one (e.g. a `path` arc) is out of scope;
  glyphs must be expressible with the primitives already used in `_renderInterior()`.
- No persistence/config changes; category tab state remains session-only DOM state.

## Approach

Follow the established seam precisely. The system is already generic across symbol
types and categories; the only genuinely new surface is the `outdoor` category and
its dock tab/panel. Concretely:

1. **`src/js/symbols.js`** — Add `"outdoor"` to the `SymCategory` typedef and the four
   new type strings to the `SymbolType` typedef, then add four `CATALOG` rows with
   `category: "outdoor"`. All CRUD/geometry/clamp functions read the catalog
   generically, so no function-body change is needed.

2. **`src/js/symbolRender.js`** — Add four `if (sym.type === ...) { ... return; }`
   branches in `_renderInterior()`, styled like the existing branches (using
   `p.symStroke`, `rgba(${rgb},…)` fills, `lp()` for rotation-aware local offsets,
   `_makeLine()` for lines). Glyphs use only `line`/`polygon`/`circle`/`ellipse`.

3. **`src/index.html`** — Add one `<button role="tab" data-category="outdoor">` to
   `.dock-tabs` and one `<div class="dock-row" role="tabpanel" data-category="outdoor">`
   with four `.dock-item` buttons, each carrying an inline preview `<svg>` and a
   `<span>` label, mirroring the existing rows.

4. **`test/tests.html`** — Extend the enumeration tests so the new category and types
   are covered (details in Test Requirements). The dock-structure tests assert
   `union(dock-item[data-type]) === Object.keys(CATALOG)` and count tabs/rows, so the
   test DOM builder and category list must be updated to 6.

**Naming decision.** Use hyphenated multi-word type ids consistent with existing
entries (`coffee-table`, `dining-table-round`): `"patio-table"`, `"patio-chair"`,
`"parasol"`, `"planter"`. Recommended labels: "Patio Table", "Patio Chair",
"Parasol", "Planter".

**Dimensions (to-scale defaults; recommended, implementer may fine-tune).**

| type          | label        | w    | h    | min  | max  | rationale |
|---------------|--------------|------|------|------|------|-----------|
| `patio-table` | Patio Table  | 0.90 | 0.90 | 0.40 | 2.00 | square outdoor table |
| `patio-chair` | Patio Chair  | 0.65 | 0.70 | 0.40 | 1.10 | outdoor seat/lounge |
| `parasol`     | Parasol      | 2.00 | 2.00 | 0.90 | 3.50 | round shade footprint |
| `planter`     | Planter      | 0.50 | 0.50 | 0.20 | 1.50 | potted plant / box |

All satisfy `min ≤ w,h ≤ max` (the catalog regression guard). None set
`openings:true`.
## Frontend Design

Frontend decision: **proceed** — no visual-design risk. The dock, tabs, glyphs, and
chrome already exist; this adds one tab and four items that reuse the established
visual language.

**Dock tab.** Append the new tab to `.dock-tabs` after `tab-bath`, matching the
existing pattern exactly:
```html
<button class="dock-tab" role="tab" data-category="outdoor"
        id="tab-outdoor" aria-controls="row-outdoor" aria-selected="false" tabindex="-1">Outdoor</button>
```
The `.dock-tabs` strip is horizontally scrollable (`overflow-x`, hidden scrollbar,
`src/index.html:1129`), so a sixth tab needs no layout change; it scrolls into view
on narrow viewports.

**Dock row.** Append a matching panel after `row-bath`:
```html
<div class="dock-row" role="tabpanel" data-category="outdoor" id="row-outdoor"
     aria-labelledby="tab-outdoor" hidden>
  <!-- four .dock-item buttons, each: preview <svg viewBox="0 0 18 18"> + <span>label</span> -->
</div>
```
Each `.dock-item` mirrors existing ones: `data-type="<type>"`, `aria-label="Add <label>"`,
an 18×18 `viewBox` inline `<svg>` preview using `stroke="currentColor"`, and a `<span>`
caption. Preview icon sketches (existing primitives only):
- **Patio Table** — square `rect` + short center `circle` (parasol hole), echoing the
  square table read.
- **Patio Chair** — rounded `rect` with a top back-strip `rect` (like `armchair`).
- **Parasol** — `circle` outer + several radial `line`s from center (ribs), reusing the
  circle/line composition the issue calls out.
- **Planter** — `rect` pot + a small `circle` cluster or two short `line`s (foliage).

**Behavior (verify only; no code).** `initDockTabs()` and `setActiveCategory()`
enumerate tabs/rows from the DOM (`dock.querySelectorAll("[role='tab'][data-category]")`),
so the new tab automatically: activates on click, hides the other five rows, and joins
the roving-tabindex Arrow-Left/Right cycle (`dockTabs.js:35-44` uses modulo over the live
tab list). No JS change; confirm by manual check + the DOM tests.

**Glyph rendering.** The four `_renderInterior()` branches follow the in-file
conventions: rotation-aware local offsets via `lp(lx, ly)`, `_makeLine()` for strokes,
`p.symStroke` strokes at ~0.7–0.9 width with `opacity` ~0.5–0.7, and translucent
`rgba(${rgb},0.08–0.15)` fills. Suggested body glyphs:
- **patio-table** — inscribed `circle` at ~0.45·min(sw,sh) for a small tabletop + center
  `circle` dot (umbrella hole), reading distinct from the indoor square `table` crosshair.
- **patio-chair** — top back-strip `polygon` (like `armchair`) without side armrests.
- **parasol** — outer `circle` (inscribed, like `dining-table-round`) + 6–8 radial
  `line`s from center to the rim (canopy ribs) + a small center `circle` (pole).
- **planter** — inset `polygon` rim + a center `circle` (plant) — or two crossed short
  `line`s reading as foliage.

All glyphs must remain legible at small sizes and when rotated; they inherit theme
colors via `palette()` so light/dark both work with no extra work.

## Interfaces / Types

No function signatures change. Only typedefs and the `CATALOG` literal grow.

**`src/js/symbols.js` — typedef edits:**
```js
/** @typedef {"door"|"window"|...|"nightstand"|"dresser"|"cabinet"
 *   |"patio-table"|"patio-chair"|"parasol"|"planter"} SymbolType */
/** @typedef {"openings"|"living"|"kitchen"|"bedroom"|"bath"|"outdoor"} SymCategory */
```

**`src/js/symbols.js` — `CATALOG` additions** (append after the `bath` block; grouping
is cosmetic since consumers iterate `Object.entries`):
```js
"patio-table": { label: "Patio Table", category: "outdoor", w: 0.90, h: 0.90, min: 0.40, max: 2.00 },
"patio-chair": { label: "Patio Chair", category: "outdoor", w: 0.65, h: 0.70, min: 0.40, max: 1.10 },
parasol:       { label: "Parasol",     category: "outdoor", w: 2.00, h: 2.00, min: 0.90, max: 3.50 },
planter:       { label: "Planter",     category: "outdoor", w: 0.50, h: 0.50, min: 0.20, max: 1.50 },
```

**`src/js/symbolRender.js` — new branches** in `_renderInterior(parent, sym, cs, p)`,
each terminating with `return;`, using the local helpers already in scope (`lp`,
`_makeLine`, `sc`, `sw`, `sh`, `rgb`, `p`). Signature unchanged.

**Consumers that need no change (inherit types automatically):**
- `createSymbol` / `clampDim` / `resizeSymbol` / `hitTest` — read `CATALOG[type]` generically.
- `mcp/src/tools.js` `tool_place_symbol` — accepts any `type in CATALOG` (`:265`),
  routes dims through `clampDim`, runs the shared clearance path. No allowlist.
- `src/js/plan.js` validation — accepts any `sym.type in CATALOG` (`:85`); export/import
  and URL-hash share round-trip the generic `Sym` shape.

## State Model

No new state. A `Sym` is `{ id, type, x, y, w, h, rot }` (world metres, deg CW) exactly
as today; the new pieces are ordinary furniture Syms living in `symbols.model.symbols`,
persisted/serialized identically (localStorage autosave, JSON export, URL-hash share).

Category-tab state remains **session-only DOM state** owned by `dockTabs.js`
(`aria-selected` + `hidden`); nothing about the active category is persisted, and reload
resets to the first tab (Openings). Adding the sixth tab does not change this contract.
## Edge Cases

1. **Parasol footprint (2.0 m) is large.** Default 2.0×2.0 m may overlap other symbols
   or exceed a small room. This is fine — clearance/fit-test is advisory (never blocks
   placement) and applies uniformly; no special-casing. Confirm the piece still places
   and the shared clearance path reports overlap without errors.
2. **Parasol/patio-table are square (w == h).** `resizeSymbol` with `lockAspect` uses
   `h/w` ratio = 1, so aspect-locked resize keeps them square — matches existing square
   types (`dining-table-round`, `stove`). No special handling.
3. **Rotation of near-symmetric glyphs.** A radial-rib parasol looks identical at many
   rotations; acceptable (round objects have no meaningful orientation). Glyphs must
   still render correctly via `lp()` at arbitrary `rot` — verified by the existing
   rotation-aware render path.
4. **Glyph legibility at min size.** At `min` (e.g. planter 0.20 m) the glyph shrinks;
   use `Math.max(…)` floors on radii/insets as the existing branches do (e.g. `bathtub`
   drain uses `Math.max(2, sw*0.04)`) so features don't collapse to zero.
5. **Sixth tab overflow on narrow screens.** `.dock-tabs` already scrolls horizontally;
   the new tab must remain reachable. No new code — verify it scrolls into view and is
   Arrow-key reachable.
6. **Backwards compatibility.** Older saved plans have no outdoor symbols; new plans with
   outdoor symbols must round-trip. Since validation gates on `type in CATALOG`, a plan
   written by this version and reopened validates; a plan from an older version still
   validates here (superset of types). No migration needed.
7. **MCP unknown-type rejection unaffected.** A bogus type still returns
   `{ ok:false, reason:"unknown symbol type" }`; only the four new valid types are now
   accepted. No allowlist to keep in sync.

## Dependencies

- **Depends on (merged):** LLD 45/50 (#77/#78) — established the multi-category dock,
  the 5-value `SymCategory`, the per-type `CATALOG`/glyph pattern, and the
  enumeration-test structure this LLD extends. This is the last of the three catalog
  increments and the only one adding a category surface.
- **Existing generic infrastructure (no change):** `dockTabs.js` (tab controller),
  `plan.js` (validation/serialize), `mcp/src/tools.js` (`place_symbol`), export
  (PNG/SVG/JSON) and URL-hash share — all type/category-agnostic.
- No new runtime dependency, no build step, client-side only.

## Test Requirements

Extend `test/tests.html` (no new file). Organize as below.

**Catalog / type enumeration (unit):**
- Add an `LLD76_TYPES = ["patio-table","patio-chair","parasol","planter"]` block mirroring
  the `LLD45_TYPES` suite: each exists in `CATALOG`; each has a non-empty label; finite
  `w,h,min,max`; `min ≤ w,h ≤ max`; none has `openings:true`; `createSymbol` returns the
  right type/defaults/`rot:0`/string id.
- Update the `VALID_CATS` sets (currently `{"openings","living","kitchen","bedroom","bath"}`
  at `tests.html:1830`, `:8833`, `:8843` region) to include `"outdoor"`.
- Add a spot-check: `CATALOG["patio-table"].category === "outdoor"` (and the other three).

**Dock structure (unit, DOM):**
- Update the test DOM builder `_makeDockDOM()` (`tests.html:8960`): add `"outdoor"` to
  `categories`, a `tabLabels.outdoor = "Outdoor"`, and
  `itemsByCategory.outdoor = ["patio-table","patio-chair","parasol","planter"]`.
- The "6 tabs / 6 rows" assertions replace the current "exactly 5" counts.
- The `union(dock-item[data-type]) === Object.keys(CATALOG)` test is catalog-derived and
  will now require the four new items to be present in the builder (it already asserts
  equality with `Object.keys(CATALOG)`).
- `setActiveCategory("outdoor")` shows only the outdoor row, hides the other five, and
  sets `aria-selected="true"` only on the outdoor tab; extend the "cycles through all
  categories" test to include `"outdoor"`.

**Plan round-trip / MCP (integration):**
- Extend the plan round-trip suite: a plan containing one of each outdoor type serializes
  and re-validates unchanged (mirror the existing "all new types" test at `tests.html:9159`).
- MCP: `tool_place_symbol({ type:"parasol", x, y })` returns `ok:true` with clamped dims;
  an out-of-range `w`/`h` clamps; a bogus type still returns `ok:false`. (Add to the
  existing place_symbol suite if present; otherwise a small new case.)

**Manual verification (QA, no automated test needed):**
- Each piece places, resizes within min/max, rotates, and fit-tests through the existing
  clearance path with no special-casing.
- Each exports to PNG, SVG, JSON and round-trips through the URL-hash share link.
- The Outdoor tab appears, activates on click, hides the others, and is reachable via
  Arrow-key navigation; glyphs render legibly in light and dark themes.
## Test Requirements
