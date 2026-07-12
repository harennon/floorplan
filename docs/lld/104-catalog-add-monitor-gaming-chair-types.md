# LLD 104: Catalog — add desktop monitor + gaming chair types

## Scope

Follow-up from **LLD 72a** ("Catalog gaps" #2/#3, GitHub issue #104). The
`floorplan-interior-design` skill's gaming-room reference
(`.claude/skills/floorplan-interior-design/references/gaming-room.md`) is prose-first and
`[GEO]`-light because the catalog has no desk-scale **monitor** and no **gaming chair**. The
closest existing type, `tv` (`min_w` 0.90 m ≈ 35"), is too large for a desk monitor, so the
battlestation sub-mode approximates a screen via desk depth + a caveat rather than placing a
real object and checking seat-to-screen viewing distance.

**This LLD covers** adding two new furniture types to the catalog:

- **`monitor`** — a desk-scale screen footprint (default 0.60 × 0.22 m), far smaller than
  `tv`, so the gaming-room skill can place a real monitor and check the ~0.5–0.75 m
  seat-to-screen viewing distance as a genuine `[GEO]` rule.
- **`gaming-chair`** — a task/racing chair footprint (default 0.66 × 0.66 m), distinct from
  the plain `chair` (0.50 × 0.50 m, no presets) and `armchair`.

Both are added under the existing **`living`** category (Frontend decision: Option A — see
below), with per-axis bounds and named presets like the rest of the catalog. The work is
**purely additive catalog data** plus the matching dock entries and the `SymbolType` typedef.

**This LLD explicitly does NOT cover:**

- Any change to rendering (`symbolRender.js`), resize/clamp/snap logic (`resizeSymbol`,
  `clampDim`, `snapToPreset`), export (PNG/SVG/JSON), share-hash, or MCP tool code. The new
  types flow through all of those unchanged because they are data-driven (see Approach).
- Any new dock **category/tab** (no "gaming" tab). Option A places both types in `living`.
- Rewriting the gaming-room skill reference to *use* the new types. That is a separate,
  optional follow-up (noted under Dependencies); this LLD only makes the types available.
- A bespoke glyph for either type. They fall back to the base box render (acceptable; a
  dedicated glyph is an optional polish follow-up, not in scope).

## Frontend Design

**Decision: Option A — add both types to the existing `living` category; do NOT add a
"gaming" category/tab.**

Rationale (per the approved selection):

- The dock is organized by room *area* (`openings`, `living`, `kitchen`, `bedroom`, `bath`,
  `outdoor`) — the tab list in `src/index.html` (`.dock-tabs`, ~L2438) and the `SymCategory`
  union in `symbols.js`. A gaming room is furnished from living-room-adjacent pieces
  (`desk`, `chair`, `armchair`, `sofa`, `tv`, `bookshelf` — all already `living`), so
  `monitor` and `gaming-chair` belong naturally under `living`. Adding a whole new category
  would mean a new tab, a new `SymCategory` value, a new `swatchGroupsForCategory` mapping,
  and a new `dock-row` panel — scope well beyond two additive types.
- Placing them in `living` means the existing swatch strip works with no code change:
  `swatchGroupsForCategory("living")` returns `["wood", "upholstery", "neutral"]` — the
  `_CATEGORY_GROUPS.living` entry is `["wood","upholstery"]` (`src/js/palette.js:66`) and the
  function appends `"neutral"` for all non-empty, non-openings categories (`palette.js:73-80`).
  That is appropriate for a monitor (dark/neutral) and a gaming chair (upholstery).

**Dock entries.** Add two `<button class="dock-item" data-type="…">` entries inside the
existing `#row-living` panel (`src/index.html`, after the `dining-table-round` item ~L2538),
each with an inline SVG glyph and a `<span>` label, matching the surrounding markup exactly:

- `data-type="monitor"`, `aria-label="Add monitor"`, label "Monitor" — glyph: a wide
  rounded `rect` (screen) with a short center stem to a base line.
- `data-type="gaming-chair"`, `aria-label="Add gaming chair"`, label "Chair" or "Gamer" —
  glyph: a seat square with a tall winged/high back strip (visually distinct from the plain
  `chair` circle and the `armchair`).

No JS wiring is needed for the dock: `symbolTool._onDockPointerDown` reads `data-type`
generically and validates against `CATALOG[type]` (`symbolTool.js:380-384`), so a new
`data-type` that exists in `CATALOG` is placeable, selectable, resizable, and shows its
preset chips automatically. The category tab already exists.

**Rendering.** No new glyph code. `_renderSymbolBody` draws every symbol's base box
(`symbolRender.js:105-118`); `_renderInterior` has no branch for the new types, so they draw
as a plain labeled box — the same graceful fallback other detail-light types rely on. A
dedicated interior glyph is deferred (optional polish).

**Preset chips + inspector.** Both types get `presets`, so the inspector's preset-chip row
(`symbolTool._renderPresetChips`) renders their named sizes automatically with a trailing
"Custom" chip — no code change. The frontend surface is therefore: **catalog data + typedef
+ two dock buttons**, nothing else.

## Approach

**Data-only addition to the shared catalog.** `CATALOG` in `src/js/symbols.js` is the single
source of truth; the MCP re-exports it verbatim (`mcp/src/core.js:48` →
`floorplan://catalog` resource, `server.js:224-226`). Every downstream behavior —
`createSymbol` (defaults), `clampDim` (per-axis bounds), `snapToPreset`/`resizeSymbol`
(presets), the inspector preset chips, `place_symbol`'s clamp + `preset:` resolution
(`tools.js`), and `set_brief` furniture validation (`brief.js:84`) — reads the catalog
generically. Adding two well-formed entries makes both types fully functional across the
editor and the MCP with **no logic change**.

**Neither type is `openings`, `circular`, or `discrete`.** They resize continuously within
their bounds (like `sofa`, `desk`, `armchair`), and their presets are named convenience
sizes (snap-to-preset only applies to `discrete` types in `resizeSymbol`; these behave like
`sofa`/`tv` — presets are pickable via chips / `preset:` but free resize is allowed between
them). This matches the "task/racing chair footprint" and "desk monitor" intent: the user
can nudge to an exact size, and the skill can also cite a named preset.

**Chosen dimensions (metres), grounded in real products:**

- **`monitor`** — default **0.60 × 0.22 m**; bounds **w 0.45–0.85, h 0.18–0.28**. `w` spans a
  24"–34" 16:9/ultrawide screen width; `h` is the stand footprint depth on the desk (a
  monitor foot is shallow, ~0.18–0.28 m). Far below `tv`'s `min_w` 0.90 m — that gap is the
  whole point: it lets the gaming skill place a screen at a desk-scale footprint and check
  seat-to-screen ~0.5–0.75 m as a real `[GEO]` distance.
  Presets: `24"` (0.54 × 0.20), `27"` (0.62 × 0.22), `32"` (0.71 × 0.24),
  `Ultrawide 34"` (0.81 × 0.24). Every preset lies within bounds.
- **`gaming-chair`** — default **0.66 × 0.66 m**; bounds **w 0.55–0.80, h 0.55–0.82**. A
  gaming/racing chair has a larger footprint than the plain `chair` (0.50 × 0.50) because of
  its wide base and reclined back projection.
  Presets: `Task` (0.60 × 0.60), `Racing` (0.66 × 0.66), `Big & Tall` (0.75 × 0.78). Every
  preset lies within bounds.

**Invariant to preserve (enforced by existing tests):** for each new type,
`min_w ≤ w ≤ max_w`, `min_h ≤ h ≤ max_h`, all six numbers finite, non-empty `label`, valid
`category` (`living`), and every preset `{w,h}` within the per-axis bounds.

## Interfaces / Types

**1. `SymbolType` typedef** (`src/js/symbols.js`, ~L13-17) — add the two literals to the
union. Append to the existing `living`-adjacent group:

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"armchair"|"coffee-table"|"dining-table-round"
 *   |"monitor"|"gaming-chair"
 *   |"nightstand"|"dresser"|"cabinet"
 *   |"patio-table"|"patio-chair"|"parasol"|"planter"} SymbolType */
```

**2. `CATALOG` entries** (`src/js/symbols.js`, in the `// Living` block, after
`dining-table-round`) — two new keys following the exact shape of existing entries
(`{label, category, w, h, min_w, max_w, min_h, max_h, presets?}`):

```js
  monitor: {
    label: "Monitor", category: "living", w: 0.60, h: 0.22,
    min_w: 0.45, max_w: 0.85, min_h: 0.18, max_h: 0.28,
    presets: [
      { name: "24\"",           w: 0.54, h: 0.20 },
      { name: "27\"",           w: 0.62, h: 0.22 },
      { name: "32\"",           w: 0.71, h: 0.24 },
      { name: "Ultrawide 34\"", w: 0.81, h: 0.24 },
    ],
  },
  "gaming-chair": {
    label: "Gaming Chair", category: "living", w: 0.66, h: 0.66,
    min_w: 0.55, max_w: 0.80, min_h: 0.55, max_h: 0.82,
    presets: [
      { name: "Task",       w: 0.60, h: 0.60 },
      { name: "Racing",     w: 0.66, h: 0.66 },
      { name: "Big & Tall", w: 0.75, h: 0.78 },
    ],
  },
```

**3. Dock buttons** (`src/index.html`, inside `#row-living` after the `dining-table-round`
button) — two `.dock-item` buttons with inline SVG glyphs, matching the existing pattern:

```html
<button class="dock-item" data-type="monitor" aria-label="Add monitor">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2" y="3" width="14" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/>
    <line x1="9" y1="12" x2="9" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="6" y1="15" x2="12" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>
  <span>Monitor</span>
</button>
<button class="dock-item" data-type="gaming-chair" aria-label="Add gaming chair">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="5" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
    <rect x="4" y="10" width="10" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/>
  </svg>
  <span>Gamer</span>
</button>
```

(The exact glyph paths are the implementer's to refine visually — the load-bearing
attributes are `data-type` and the `#row-living` placement.)

**No signature changes.** No function in `symbols.js`, `symbolTool.js`, `symbolRender.js`,
or the MCP is modified. `createSymbol("monitor", x, y)` and
`createSymbol("gaming-chair", x, y)` work by virtue of the catalog lookup.

## State Model

**No new state, no persistence change, no schema change.** A placed `monitor` or
`gaming-chair` is an ordinary `Sym` (`{id, type, x, y, w, h, rot, color?}`) in
`symbols.model.symbols`, exactly like every other symbol. It:

- **Serializes** into the plan JSON, PNG/SVG export, and the share-hash with zero new fields —
  the serializer walks `model.symbols` generically.
- **Hydrates** back losslessly (`hydrate` is type-agnostic; `_counter` reconciliation is by
  `s<n>` id, unaffected).
- **Round-trips through the MCP** as a normal symbol; `place_symbol {type:"monitor"}` and
  `{type:"gaming-chair"}` succeed because the type is now `in CATALOG`
  (`tools.js:359`, `brief.js:84`).

**Backward compatibility:** older saved plans and share links contain none of these types, so
nothing changes for them. A plan authored with the new types will fail to render the
*specific* symbol on an older deployment that lacks the catalog entry — but that is the same
forward-compat property every prior additive catalog LLD (45/50/76) already accepts; no
migration is needed.

## Edge Cases

1. **No interior glyph.** `_renderInterior` has no branch for `monitor`/`gaming-chair`, so
   they render as a plain box with the base fill/stroke. This is the intended graceful
   fallback (several detail-light types rely on it); the box is still selectable, resizable,
   and labeled. Not a defect.
2. **`monitor` vs `tv` confusion.** Both are screens under `living`. Distinguish by footprint:
   `monitor` `max_w` 0.85 m sits entirely below `tv` `min_w` 0.90 m, so the two size bands do
   not overlap — the gaming skill picks `monitor` for a battlestation and `tv` for a
   console/couch setup. Dock labels ("Monitor" vs "TV") keep them distinct visually.
3. **`gaming-chair` vs `chair`/`armchair`.** Footprints differ (0.66² default vs `chair`
   0.50², `armchair` 0.80²) and bounds do not fully coincide, so a size read disambiguates.
   Both remain valid `seating` in the skill's role map.
4. **Preset within bounds.** Every authored preset `{w,h}` must satisfy the per-axis bounds
   or the LLD-45-style integrity test fails. Verified above; the implementer must not widen a
   preset past a bound without also widening the bound.
5. **Swatch category.** `gaming-chair` and `monitor` are `living`, so
   `swatchGroupsForCategory("living")` → `["wood","upholstery","neutral"]` (the `"neutral"`
   group is appended by the function) supplies color swatches; no new palette group needed.
   (A monitor colored "wood" is odd but harmless — colors are optional and default to theme;
   the appended "neutral" group covers the dark/grey a monitor would realistically use.)
6. **Wall-flush / alignment / clearance** all operate on the AABB from `w`/`h` and are
   type-agnostic; the new types get flush-to-wall and neighbor alignment for free, with no
   special casing.
7. **`aria-label` uniqueness in the dock.** Use "Add monitor" / "Add gaming chair" — distinct
   from the existing "Add tv" / "Add chair" so screen-reader users can tell them apart.

## Dependencies

**All present in `main`; nothing blocks this LLD.**

- **The per-axis-bounds + presets catalog** (`src/js/symbols.js`, `CATALOG`) — the shape this
  LLD extends. Already carries `label/category/w/h/min_w/max_w/min_h/max_h/presets`.
- **The generic dock** (`src/index.html` `#row-living`; `symbolTool._onDockPointerDown`) —
  reads `data-type` and validates against `CATALOG`; no per-type wiring.
- **The MCP catalog re-export** (`mcp/src/core.js:48`, `server.js:224-226`) — surfaces the two
  new types to the interior-design skill via `floorplan://catalog` automatically.
- **LLD 72a** — the source of this gap; its gaming-room reference is the intended consumer.

**Enables (not required by this LLD, listed for the follow-up):** a follow-up edit to
`.claude/skills/floorplan-interior-design/references/gaming-room.md` can replace the
"approximate the monitor via desk depth" caveat with placing a real `monitor` and checking
seat-to-screen distance ~0.5–0.75 m as a `[GEO]` rule, and swap the `chair`/`armchair`
battlestation seat for `gaming-chair`. That prose update is intentionally out of scope here
(this LLD only makes the types exist) and should be filed/handled separately so the catalog
change ships cleanly on its own.

## Test Requirements

Follows the existing LLD-45-style catalog-integrity pattern in `test/tests.html`.

**Required test-fixture edits (not optional — the suite fails or silently under-covers
without them):**

- **`LLD45_TYPES` array** (`test/tests.html:1978-1979`) — a hardcoded array of the 11 LLD-45
  types that the catalog-integrity and `createSymbol` suites iterate. Append `"monitor"` and
  `"gaming-chair"`. This does **not** fail if omitted — the parameterized assertions simply
  never touch the new types, so they would ship untested. The implementer must edit this
  array (or add an equivalent iterated list); do not assume automatic coverage.
- **`itemsByCategory` map in `_makeDockDOM()`** (`test/tests.html:9363-9370`) — this map is a
  **hardcoded synthetic dock**, NOT parsed from `index.html`. Add `"monitor"` and
  `"gaming-chair"` to the `living` entry (`test/tests.html:9365`). This edit **is required to
  keep the suite green**: the LLD-50 test "union of all dock-item[data-type] equals the
  catalog keys" (`test/tests.html:9428-9440`) asserts `dockTypes === Object.keys(CATALOG)`
  *exactly* and throws on mismatch (line 9434), plus a derived count assertion (line 9439).
  Adding the two types to `CATALOG` without adding them to `itemsByCategory` makes that
  equality check fail.

**Unit (browser suite, `test/tests.html`):**

- **Catalog integrity** (extends the LLD-45 block): both types exist in `CATALOG`; category
  is `living` (valid); `label` non-empty; `w/h/min_w/max_w/min_h/max_h` all finite;
  `min_w ≤ w ≤ max_w` and `min_h ≤ h ≤ max_h`; neither has `openings:true`.
- **Preset validity:** every preset of each type has `{name, w, h}` with
  `min_w ≤ p.w ≤ max_w` and `min_h ≤ p.h ≤ max_h`. (Guards the "preset within bounds"
  invariant.)
- **`createSymbol`:** `createSymbol("monitor"|"gaming-chair", x, y)` returns a `Sym` with the
  catalog default `w/h`, `rot:0`, and a unique `s<n>` id.
- **`clampDim`:** width/depth below `min` clamps to `min`, above `max` clamps to `max`, for
  both types and both axes.
- **`snapToPreset` behaves as continuous (not discrete):** confirm `resizeSymbol(sym,"w",v)`
  to an in-range value *between* presets keeps that value (both types are non-`discrete`, so
  no snap) — mirrors the existing `sofa`/`dining-table-round` continuity tests.
- **Distinctness assertion:** `CATALOG.monitor.max_w < CATALOG.tv.min_w` (the non-overlap
  that makes `monitor` a real desk-scale screen). Optional but directly encodes the LLD's
  reason for existing.
- **JSON round-trip:** a placed `monitor`/`gaming-chair` serializes and hydrates losslessly
  (type, w, h, rot, id preserved).

**Integration / MCP (`mcp/test/*.test.js`):**

- **`place_symbol`:** `{type:"monitor"}` and `{type:"gaming-chair"}` succeed and return the
  clamped catalog-default footprint.
- **`preset:` resolution:** `place_symbol {type:"monitor", preset:"27\""}` and
  `{type:"gaming-chair", preset:"Racing"}` resolve to the named preset `{w,h}`; an unknown
  preset name is rejected with the valid-names list (existing behavior — just confirm the new
  types participate).
- **`set_brief` furniture validation:** a brief listing `monitor` / `gaming-chair` is
  accepted (type `in CATALOG`).

**DOM / dock (may be covered manually or by an existing dock test):**

- Both dock buttons appear under the `living` tab, carry the correct `data-type`, and
  drag-place a symbol of that type. A manual check that the placed box renders and is
  selectable is sufficient given no new render branch.

**Regression:** with the two required test-fixture edits above (`LLD45_TYPES` and the
`_makeDockDOM` `itemsByCategory.living` map), the full suite
(`node .github/run-tests.mjs` + `cd mcp && node --test`) stays green. Note the change is
**not** purely additive on the test side: the LLD-50 dock-integrity test derives its expected
count from `Object.keys(CATALOG).length` (no manual count to bump) but demands the synthetic
dock's `data-type` set equal the catalog keys exactly, so the `itemsByCategory` edit is
mandatory. No other existing assertion should break.
