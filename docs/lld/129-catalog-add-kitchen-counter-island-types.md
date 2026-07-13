# LLD 129: Catalog — add kitchen counter/countertop + island types

## Scope

Follow-up from **LLD 72a** ("Catalog gaps", GitHub issue #129). The
`floorplan-interior-design` skill's kitchen reference
(`.claude/skills/floorplan-interior-design/references/kitchen.md`) can reason about the NKBA
work triangle — `sink`/`fridge`/`stove` all exist as catalog types — but it **cannot model a
landing zone or a continuous prep counter** because `CATALOG` (`src/js/symbols.js`) has no
`counter`/`countertop` or `island` type. Today the skill handles this in **prose only**
("Landing zones `[SOFT]` / prose", kitchen.md L24-31): it reserves the empty floor span beside
an appliance and is explicitly told **not to fabricate a counter by mis-using another type**.

**This LLD covers** adding two new furniture types to the catalog:

- **`counter`** — a linear countertop run. Fixed-ish standard depth (~0.61 m) with a **wide
  width band** so one entry models both a small **landing zone** (fridge handle side ≥0.38 m;
  stove/sink 0.30–0.61 m each side) and a **continuous prep run** (~0.91 m and up to a full
  wall run). Named presets encode those exact NKBA landing/prep spans.
- **`island`** — a freestanding kitchen block, a normal (non-anchored) clearance subject, with
  presets from a compact island up to a seating island.

Both are added under the existing **`kitchen`** category (Frontend decision: proceed with
recommendations — see below), with per-axis bounds and named presets, following the **exact**
established post-#98 catalog shape (identical to the `monitor`/`gaming-chair` additions in
LLD 104 / #125). The work is **purely additive catalog data** plus the matching dock entries,
the `SymbolType` typedef, and the two required test-fixture edits.

**This LLD explicitly does NOT cover:**

- The `check_layout` / landing-zone **evaluator**. Adding the types makes landing zones
  *expressible* and *checkable in principle*; building an evaluator that actually verifies
  "fridge ≥0.38 m handle side" etc. is **separate deferred work** and is out of scope here.
- Any edit to the interior-design skill logic or `references/kitchen.md` prose. Rewriting the
  "prose only / do not invent a counter" guidance to *use* the new types is a separate,
  optional follow-up (noted under Dependencies).
- Any change to rendering (`symbolRender.js`), resize/clamp/snap logic, export (PNG/SVG/JSON),
  share-hash, palette, or MCP tool code. The new types flow through all of those unchanged
  because they are data-driven (see Approach).
- Any new dock **category/tab** (they go in the existing `kitchen` tab).
- A bespoke interior glyph for either type. They fall back to the base box render — which is
  in fact an accurate depiction of a counter/island (a rectangular slab). A dedicated glyph is
  optional polish, not in scope.

## Frontend Design

**Decision: proceed with recommendations — add both types to the existing `kitchen`
category; do NOT add a new category/tab, render branch, or palette group.**

Rationale:

- The dock is organized by room *area* (`openings`, `living`, `kitchen`, `bedroom`, `bath`,
  `outdoor`). A counter and an island are kitchen fixtures alongside `fridge`/`stove`/`sink`/
  `washer` (all already `kitchen`), so they belong in the `kitchen` tab. No new
  `SymCategory` value, `swatchGroupsForCategory` mapping, or `dock-row` panel is needed.
- Placing them in `kitchen` means the existing swatch strip works with **no code change**:
  `swatchGroupsForCategory("kitchen")` returns `["appliance","wood","neutral"]`
  (`_CATEGORY_GROUPS.kitchen` = `["appliance","wood"]`, `src/js/palette.js:67`, with `"neutral"`
  appended, `palette.js:83-88`). That is exactly right — **wood** for butcher-block, **neutral**
  for stone/quartz, **appliance** for a stainless island.

**Dock entries.** Add two `<button class="dock-item" data-type="…">` entries inside the
existing `#row-kitchen` panel (`src/index.html`, after the `washer` item ~L2635), each with an
inline SVG glyph and a `<span>` label, matching the surrounding markup exactly:

- `data-type="counter"`, `aria-label="Add counter"`, label "Counter" — glyph: a wide, shallow
  rounded `rect` (a slab, wider than tall) with a thin top edge line suggesting the countertop.
- `data-type="island"`, `aria-label="Add island"`, label "Island" — glyph: a chunkier
  centered `rect` block (visually distinct from the wide thin counter), optionally two small
  stool circles on one long side to read as a seating island.

No JS wiring is needed: `symbolTool._onDockPointerDown` reads `data-type` generically and
validates against `CATALOG[type]`, so a new `data-type` that exists in `CATALOG` is placeable,
selectable, resizable, and shows its preset chips automatically. The category tab already
exists.

**Rendering.** No new glyph code. `_renderSymbolBody` draws every symbol's base box and
`_renderInterior` has no branch for the new types, so they draw as a plain labeled box — the
same graceful fallback other detail-light types (`chair`, `desk`, `nightstand`) rely on. For a
counter/island the plain slab box is an *accurate* depiction, so no glyph is warranted.

**Preset chips + inspector.** Both types get `presets`, so the inspector's preset-chip row
(`symbolTool._renderPresetChips`) renders their named sizes automatically with a trailing
"Custom" chip — no code change. The frontend surface is therefore: **catalog data + typedef +
two dock buttons**, nothing else.

## Approach

**Data-only addition to the shared catalog.** `CATALOG` in `src/js/symbols.js` is the single
source of truth; the MCP re-exports it verbatim (`mcp/src/core.js` → `floorplan://catalog`
resource). Every downstream behavior — `createSymbol` (defaults), `clampDim` (per-axis
bounds), `snapToPreset`/`resizeSymbol` (presets), the inspector preset chips, `place_symbol`'s
clamp + `preset:` resolution, and `set_brief` furniture validation — reads the catalog
generically. Adding two well-formed entries makes both types fully functional across the
editor and the MCP with **no logic change**.

**Neither type is `discrete`, `circular`, `openings`, or `floorLayer`.** They resize
continuously within their bounds (like `sink`, `sofa`, `desk`). Presets are named convenience
sizes pickable via chips / `preset:`, but free resize is allowed between them (snap-to-preset
in `resizeSymbol` only fires for `discrete` types). This is the correct behavior: a counter
run is any length that fits a given wall, and the user can nudge to an exact span while the
skill can still cite a named landing/prep preset.

**Chosen dimensions (metres), grounded in the LLD 72a kitchen needs (kitchen.md L24-31) and
standard cabinetry:**

- **`counter`** — default **0.91 × 0.61 m**; bounds **w 0.30–3.66, h 0.55–0.68**.
  Depth `h` is the standard countertop depth (24"–26" base cabinet + overhang ≈ 0.61 m); the
  narrow `h` band keeps it a realistic counter. Width `w` is deliberately wide so **one type**
  models the full NKBA span set from the smallest landing zone to a long wall run:
  - `min_w` **0.30 m** = the stove-side landing minimum (kitchen.md: stove 0.30–0.38 m each
    side).
  - default **0.91 m** = the continuous prep run.
  - `max_w` **3.66 m** (~12 ft) = a long uninterrupted wall run.
  Presets encode the exact landing/prep numbers the skill (and a future evaluator) checks:
  `Fridge landing 15"` (0.38 × 0.61 — fridge handle side ≥0.38 m), `Sink/stove side 24"`
  (0.61 × 0.61 — top of the 0.30–0.61 m each-side band), `Prep run 36"` (0.91 × 0.61 —
  continuous prep ~0.91 m), `Run 48"` (1.22 × 0.61), `Run 72"` (1.83 × 0.61). Every preset
  lies within bounds.
- **`island`** — default **1.20 × 0.90 m**; bounds **w 0.90–3.00, h 0.60–1.22**. A freestanding
  block: min ~0.90 × 0.60 m (a small island still needs its aisle), up to a large
  seating island. Presets: `Compact` (1.00 × 0.60), `Standard` (1.20 × 0.90),
  `Large` (1.83 × 1.00), `Seating` (2.44 × 1.07). Every preset lies within bounds.

**Invariant to preserve (enforced by existing tests):** for each new type,
`min_w ≤ w ≤ max_w`, `min_h ≤ h ≤ max_h`, all six numbers finite, non-empty `label`, valid
`category` (`kitchen`), and every preset `{w,h}` within the per-axis bounds.

## Interfaces / Types

**1. `SymbolType` typedef** (`src/js/symbols.js`, ~L13-19) — add the two literals to the union.
Append to the kitchen-adjacent group:

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"armchair"|"coffee-table"|"dining-table-round"
 *   |"monitor"|"gaming-chair"
 *   |"counter"|"island"
 *   |"nightstand"|"dresser"|"cabinet"
 *   |"patio-table"|"patio-chair"|"parasol"|"planter"
 *   |"rug"} SymbolType */
```

**2. `CATALOG` entries** (`src/js/symbols.js`, in the `// Kitchen` block, after `washer`) —
two new keys following the exact shape of existing entries
(`{label, category, w, h, min_w, max_w, min_h, max_h, presets?}`):

```js
  counter: {
    label: "Counter", category: "kitchen", w: 0.91, h: 0.61,
    min_w: 0.30, max_w: 3.66, min_h: 0.55, max_h: 0.68,
    presets: [
      { name: "Fridge landing 15\"", w: 0.38, h: 0.61 },
      { name: "Sink/stove side 24\"", w: 0.61, h: 0.61 },
      { name: "Prep run 36\"",        w: 0.91, h: 0.61 },
      { name: "Run 48\"",             w: 1.22, h: 0.61 },
      { name: "Run 72\"",             w: 1.83, h: 0.61 },
    ],
  },
  island: {
    label: "Island", category: "kitchen", w: 1.20, h: 0.90,
    min_w: 0.90, max_w: 3.00, min_h: 0.60, max_h: 1.22,
    presets: [
      { name: "Compact",  w: 1.00, h: 0.60 },
      { name: "Standard", w: 1.20, h: 0.90 },
      { name: "Large",    w: 1.83, h: 1.00 },
      { name: "Seating",  w: 2.44, h: 1.07 },
    ],
  },
```

**3. Dock buttons** (`src/index.html`, inside `#row-kitchen` after the `washer` button) — two
`.dock-item` buttons with inline SVG glyphs, matching the existing pattern:

```html
<button class="dock-item" data-type="counter" aria-label="Add counter">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2" y="7" width="14" height="6" rx="1" stroke="currentColor" stroke-width="1.3"/>
    <line x1="2" y1="7" x2="16" y2="7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>
  <span>Counter</span>
</button>
<button class="dock-item" data-type="island" aria-label="Add island">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/>
    <circle cx="6" cy="15" r="0.9" fill="currentColor"/>
    <circle cx="12" cy="15" r="0.9" fill="currentColor"/>
  </svg>
  <span>Island</span>
</button>
```

(The exact glyph paths are the implementer's to refine visually — the load-bearing attributes
are `data-type` and the `#row-kitchen` placement.)

**No signature changes.** No function in `symbols.js`, `symbolTool.js`, `symbolRender.js`, or
the MCP is modified. `createSymbol("counter", x, y)` and `createSymbol("island", x, y)` work by
virtue of the catalog lookup.

## State Model

**No new state, no persistence change, no schema change.** A placed `counter` or `island` is
an ordinary `Sym` (`{id, type, x, y, w, h, rot, color?}`) in `symbols.model.symbols`, exactly
like every other symbol. It:

- **Serializes** into the plan JSON, PNG/SVG export, and the share-hash with zero new fields —
  the serializer walks `model.symbols` generically.
- **Hydrates** back losslessly (`hydrate` is type-agnostic; `_counter` reconciliation is by
  `s<n>` id, unaffected).
- **Round-trips through the MCP** as a normal symbol; `place_symbol {type:"counter"}` and
  `{type:"island"}` succeed because the type is now `in CATALOG`.

**Backward compatibility:** older saved plans and share links contain none of these types, so
nothing changes for them. A plan authored with the new types will not render the *specific*
symbol on an older deployment that lacks the catalog entry — the same forward-compat property
every prior additive catalog LLD (45/50/76/104/107) already accepts; no migration is needed.

## Edge Cases

1. **No interior glyph.** `_renderInterior` has no branch for `counter`/`island`, so they
   render as a plain box with the base fill/stroke. This is the intended graceful fallback and
   is *accurate* for a rectangular slab. The box is still selectable, resizable, and labeled.
   Not a defect.
2. **Counter is a wide, shallow band.** `w` spans 0.30–3.66 m while `h` is pinned to a narrow
   0.55–0.68 m depth. A user cannot resize a counter into a square blob because the depth band
   is tight — matching real cabinetry. Preset widths (0.38 → 1.83 m) all share `h = 0.61 m`.
3. **`counter` vs `island` distinctness.** A counter is shallow (`max_h` 0.68 m) and can be
   very wide; an island is deeper (`min_h` 0.60 m up to 1.22 m) and freestanding. Their depth
   bands overlap only at the 0.60–0.68 m sliver, but the label and default footprint keep them
   distinct; the skill picks `counter` for a wall run / landing zone and `island` for a
   freestanding block.
4. **Preset within bounds.** Every authored preset `{w,h}` must satisfy the per-axis bounds or
   the LLD-45-style integrity test fails. Verified above; the implementer must not widen a
   preset past a bound without also widening the bound.
5. **Swatch category.** Both are `kitchen`, so `swatchGroupsForCategory("kitchen")` →
   `["appliance","wood","neutral"]` supplies color swatches (butcher-block wood, stone/quartz
   neutral, stainless appliance); no new palette group needed.
6. **Wall-flush / alignment / clearance** all operate on the AABB from `w`/`h` and are
   type-agnostic; the new types get flush-to-wall (a counter seats against a wall run) and
   neighbor alignment for free, with no special casing. Unlike `rug`, they are **not**
   `floorLayer`, so they participate normally in clearance/pick — which is correct (a counter
   IS an obstacle in the work aisle).
7. **`aria-label` uniqueness in the dock.** Use "Add counter" / "Add island" — distinct from
   the existing kitchen items so screen-reader users can tell them apart.

## Dependencies

**All present in `main`; nothing blocks this LLD.**

- **The per-axis-bounds + presets catalog** (`src/js/symbols.js`, `CATALOG`) — the shape this
  LLD extends, already carrying `label/category/w/h/min_w/max_w/min_h/max_h/presets`
  (see the `monitor`/`gaming-chair` post-#98 entries as the exact template).
- **The generic dock** (`src/index.html` `#row-kitchen`; `symbolTool._onDockPointerDown`) —
  reads `data-type` and validates against `CATALOG`; no per-type wiring.
- **The kitchen palette groups** (`src/js/palette.js:67`) — already
  `["appliance","wood"]` (+ `"neutral"`), appropriate for counters/islands with no change.
- **The MCP catalog re-export** (`mcp/src/core.js` → `floorplan://catalog`) — surfaces the two
  new types to the interior-design skill automatically.
- **LLD 72a** — the source of this gap; its kitchen reference is the intended consumer.

**Enables (not required by this LLD, listed for the follow-up):**

- A follow-up edit to `references/kitchen.md` can replace the "prose only / do not invent a
  counter" guidance (L24-31, L37-43) with placing real `counter` runs beside appliances and
  citing the landing presets, and add `counter`/`island` to "Types in play".
- A future `check_layout` / landing-zone evaluator can measure fridge ≥0.38 m handle side,
  stove/sink 0.30–0.61 m each side, and the ~0.91 m continuous prep run against placed
  `counter` symbols.

Both are intentionally out of scope here (this LLD only makes the types exist) so the catalog
change ships cleanly on its own.

## Test Requirements

Follows the existing LLD-45-style catalog-integrity pattern in `test/tests.html`.

**Required test-fixture edits (not optional — the suite fails or silently under-covers
without them):**

- **`LLD45_TYPES` array** (`test/tests.html:1978-1979`) — the hardcoded array the
  catalog-integrity and `createSymbol` suites iterate. Append `"counter"` and `"island"`.
  Omitting this does not *fail* the suite — the parameterized assertions simply never touch the
  new types, so they would ship untested. The implementer must edit this array.
- **`itemsByCategory` map in `_makeDockDOM()`** (`test/tests.html:9363-9370`) — a **hardcoded
  synthetic dock**, NOT parsed from `index.html`. Add `"counter"` and `"island"` to the
  `kitchen` entry (`test/tests.html:9366`). This edit **is required to keep the suite green**:
  the LLD-50 test "union of all dock-item[data-type] equals the catalog keys"
  (`test/tests.html:9432-9439`) asserts `dockTypes === Object.keys(CATALOG)` exactly and throws
  on mismatch, plus a derived count assertion. Adding the two types to `CATALOG` without adding
  them here makes that equality check fail.

**Unit (browser suite, `test/tests.html`):**

- **Catalog integrity** (extends the LLD-45 block): both types exist in `CATALOG`; category is
  `kitchen` (valid); `label` non-empty; `w/h/min_w/max_w/min_h/max_h` all finite;
  `min_w ≤ w ≤ max_w` and `min_h ≤ h ≤ max_h`; neither has `openings:true`, `circular:true`,
  `discrete:true`, or `floorLayer:true`.
- **Preset validity:** every preset of each type has `{name, w, h}` with `min_w ≤ p.w ≤ max_w`
  and `min_h ≤ p.h ≤ max_h`. (Guards the "preset within bounds" invariant.)
- **`createSymbol`:** `createSymbol("counter"|"island", x, y)` returns a `Sym` with the catalog
  default `w/h`, `rot:0`, and a unique `s<n>` id.
- **`clampDim`:** width/depth below `min` clamps to `min`, above `max` clamps to `max`, for
  both types and both axes (e.g. `counter` width clamps into 0.30–3.66; depth into 0.55–0.68).
- **Continuous (non-discrete) resize:** `resizeSymbol(sym,"w",v)` to an in-range value
  *between* presets keeps that value (both types are non-`discrete`, so no snap) — mirrors the
  existing `sink`/`sofa` continuity tests.
- **Landing-span assertion (optional, encodes the reason for existing):** a `counter` can hold
  the NKBA landing spans — `CATALOG.counter.min_w ≤ 0.38` (fridge handle side) and the
  `Prep run 36"` preset width `0.91` lies within `[min_w, max_w]` (continuous prep run).
- **JSON round-trip:** a placed `counter`/`island` serializes and hydrates losslessly (type,
  w, h, rot, id preserved).

**Integration / MCP (`mcp/test/*.test.js`):**

- **`place_symbol`:** `{type:"counter"}` and `{type:"island"}` succeed and return the clamped
  catalog-default footprint.
- **`preset:` resolution:** `place_symbol {type:"counter", preset:"Prep run 36\""}` and
  `{type:"island", preset:"Standard"}` resolve to the named preset `{w,h}`; an unknown preset
  name is rejected with the valid-names list (existing behavior — confirm the new types
  participate).
- **`set_brief` furniture validation:** a brief listing `counter` / `island` is accepted (type
  `in CATALOG`).

**DOM / dock (covered by the LLD-50 dock-integrity test once fixtures are edited):**

- Both dock buttons appear under the `kitchen` tab, carry the correct `data-type`, and
  drag-place a symbol of that type. A manual check that the placed box renders and is
  selectable is sufficient given no new render branch.

**Regression:** with the two required test-fixture edits above (`LLD45_TYPES` and the
`_makeDockDOM` `itemsByCategory.kitchen` map), the full suite
(`node .github/run-tests.mjs` + `cd mcp && node --test`) stays green. The change is **not**
purely additive on the test side: the LLD-50 dock-integrity test demands the synthetic dock's
`data-type` set equal the catalog keys exactly, so the `itemsByCategory` edit is mandatory. No
other existing assertion should break.
