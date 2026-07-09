# LLD 45: Richer curated furniture/symbol set

## Scope

Extend the symbol catalog beyond today's 8 types with a **curated, fixed** handful of
high-frequency household items so a typical apartment can be represented without
improvising. New types (all category `furniture`):

- **toilet**, **bathtub**, **sink**, **stove**, **wardrobe**, **bookshelf**, **tv**,
  **washer** (washing machine).

Each new type gets, in `CATALOG` (`src/js/symbols.js`): a `label`, `category:"furniture"`,
default `w`/`h` in metres, and `min`/`max` clamp bounds — following the existing convention
exactly. Each gets a recognizable to-scale interior glyph in `symbolRender.js` and a dock
button (with inline SVG icon) in `index.html`.

**Explicitly NOT in scope:**
- No new subsystem, no per-type special-casing anywhere. New types flow through the
  generic paths for placement, resize/clamp, rotate, duplicate, delete, clearance, dim
  entry, export, and serialization.
- No per-axis clamp bounds (the existing model has a single `[min,max]` applied to both
  `w` and `h` — LLD 45 keeps that model; it does not introduce separate width/depth
  ranges).
- No open-ended / user-defined catalog, no import of external symbol libraries, no
  category beyond the existing `openings`/`furniture`. (Curation constraint per CLAUDE.md
  + Phase 2 umbrella.)
- No change to the snapping, alignment, flush, history, or clearance algorithms.

## Approach

**Key insight — the catalog is the single source of truth.** Every downstream consumer
already reads `CATALOG[type]` generically:

- `createSymbol` / `duplicateSymbol` copy `cat.w`/`cat.h`.
- `clampDim` / `resizeSymbol` read `cat.min`/`cat.max`.
- `plan.validatePlan` gates on `sym.type in CATALOG` — **new types validate automatically,
  and older plans lacking these types are unaffected** (it only checks membership, never
  requires a type to be present). Backwards compatibility is therefore free.
- `exportImg` draws a generic rotated polygon + centered `CATALOG[type].label` — no
  per-type export code exists, so export/PNG/SVG need **zero** changes.
- `clearance.computeClearances` skips only `openings`; all `furniture` participate
  identically. New furniture types need no clearance changes.
- `symbolDimEntry` reads `openings` and clamps via `resizeSymbol` — generic.

Therefore the implementation is **three edits**:
1. `symbols.js` — add 8 `CATALOG` entries and extend the `SymbolType` typedef.
2. `symbolRender.js` — add 8 glyph branches in `_renderInterior` (recognizability only;
   a missing branch still renders a valid plain box, but each new type gets a glyph per
   acceptance criteria).
3. `index.html` — add 8 dock buttons under the existing "Furniture" group, plus a CSS
   tweak so the wider dock stays uncluttered on mobile (see Frontend Design).

**Rationale for this being a natural boundary:** the add-a-symbol pattern is already
established and well-factored; risk is confined to data + one render function + markup.

### Chosen dimensions and clamp bounds

Defaults are realistic residential sizes (metres). `min` stays `0.30` for all (matches
every existing furniture entry); `max` is chosen to cover the largest realistic variant of
that item so `resizeSymbol` never blocks a plausible edit. Because the single `[min,max]`
applies to **both** `w` and `h`, `max` must be ≥ the larger default dimension.

| type      | label     | w    | h    | min  | max  | notes |
|-----------|-----------|------|------|------|------|-------|
| toilet    | Toilet    | 0.40 | 0.70 | 0.30 | 1.00 | tank+bowl footprint |
| bathtub   | Bathtub   | 1.70 | 0.75 | 0.30 | 2.20 | standard alcove tub |
| sink      | Sink      | 0.60 | 0.45 | 0.30 | 1.50 | covers vanity basin |
| stove     | Stove     | 0.60 | 0.60 | 0.30 | 1.20 | range up to 1.2 m |
| wardrobe  | Wardrobe  | 1.00 | 0.60 | 0.30 | 3.00 | closet run |
| bookshelf | Bookshelf | 0.80 | 0.30 | 0.30 | 3.00 | shallow, wide runs |
| tv        | TV        | 1.20 | 0.40 | 0.30 | 2.50 | media unit / stand |
| washer    | Washer    | 0.60 | 0.60 | 0.30 | 1.00 | front-load footprint |

## Interfaces / Types

`src/js/symbols.js` — extend the union typedef and append to `CATALOG`. No signature
changes to any function.

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"} SymbolType */
```

```js
export const CATALOG = {
  // ...existing 8 entries unchanged...
  toilet:    { label: "Toilet",    category: "furniture", w: 0.40, h: 0.70, min: 0.30, max: 1.00 },
  bathtub:   { label: "Bathtub",   category: "furniture", w: 1.70, h: 0.75, min: 0.30, max: 2.20 },
  sink:      { label: "Sink",      category: "furniture", w: 0.60, h: 0.45, min: 0.30, max: 1.50 },
  stove:     { label: "Stove",     category: "furniture", w: 0.60, h: 0.60, min: 0.30, max: 1.20 },
  wardrobe:  { label: "Wardrobe",  category: "furniture", w: 1.00, h: 0.60, min: 0.30, max: 3.00 },
  bookshelf: { label: "Bookshelf", category: "furniture", w: 0.80, h: 0.30, min: 0.30, max: 3.00 },
  tv:        { label: "TV",        category: "furniture", w: 1.20, h: 0.40, min: 0.30, max: 2.50 },
  washer:    { label: "Washer",    category: "furniture", w: 0.60, h: 0.60, min: 0.30, max: 1.00 },
};
```

`src/js/symbolRender.js` — add branches inside `_renderInterior(parent, sym, cs)`, using
the existing local helpers already in scope: `lp(lx, ly)` (local→screen offset from
center, honours rotation), `_makeLine`, `sw`/`sh` (screen w/h px), `sc` (screen center),
and the `GOLD`/`GOLD_STROKE` palette constants. Each branch ends with `return;`, matching
the existing pattern. Glyph specs (schematic, recognizable, all stroked in `GOLD_STROKE`
at ~0.7–0.9 px, low opacity like siblings):

- **toilet**: an oval seat (ellipse, ~70% width, upper ~65% of depth) + a tank rectangle
  across the top edge (~20% depth).
- **bathtub**: inner rounded rectangle inset ~10% (the basin) + a small drain circle near
  one short end.
- **sink**: inner rounded rectangle (basin) centered + a small faucet dot on the back
  (top) edge.
- **stove**: 4 burner circles in a 2×2 grid.
- **wardrobe**: a vertical center divider line (two doors) + two small handle dots either
  side of it.
- **bookshelf**: 2–3 evenly spaced shelf lines parallel to the long (width) axis.
- **tv**: a thin screen rectangle across the top ~70% + a short center stand line to the
  bottom edge.
- **washer**: a large center circle (drum door) + a small detergent-tray rectangle on the
  top edge.

Glyphs must scale with `sw`/`sh` (never fixed sizes that break at small zoom) and derive
all coordinates via `lp(...)` so they rotate with the symbol, exactly like `bed`/`fridge`.

`src/js/plan.js`, `src/js/clearance.js`, `src/js/exportImg.js`, `src/js/symbolTool.js`,
`src/js/symbolDimEntry.js` — **no code changes.** They consume `CATALOG` generically.

## State Model

- No new state. New symbols are ordinary `Sym` records `{id,type,x,y,w,h,rot}` in
  `symbols.model.symbols`, identical in shape to existing symbols.
- **Persisted** (via `buildPlan`/`serializePlan` → localStorage, JSON export, URL hash):
  the `Sym` records. New `type` strings serialize as-is; `validatePlan` accepts them
  because `"toilet" in CATALOG` (etc.) is now true.
- **In-memory / session only:** catalog metadata, dock active state, selection, ghost,
  guides — unchanged.
- **Backwards compatibility:** `PLAN_SCHEMA` stays `1`. A plan authored before this change
  simply has no symbols of the new types; it validates and applies unchanged. A plan
  authored *with* new types, opened in an *older* build, would fail validation
  (`type in CATALOG` false → whole plan rejected) — this is the existing forward-compat
  behavior and is acceptable (no schema bump needed; new types are additive).

## Edge Cases

1. **Asymmetric defaults vs single clamp range.** `clampDim` applies one `[min,max]` to
   both axes. Chosen `max` per type is ≥ the larger default dimension, so no default is
   born clamped, and both axes remain independently editable within the shared range.
   Verify in tests.
2. **`resizeSymbol` clamp at bounds.** Entering a value below `min` or above `max` for any
   new type clamps to the bound (generic path — same as existing types). Covered by tests.
3. **Lock-aspect on asymmetric items** (e.g. bathtub 1.70×0.75): existing `resizeSymbol`
   lock-aspect logic already independently clamps each axis and lets the edited dim win if
   the ratio would break a bound. No new behavior; no new handling.
4. **Rotation / duplicate / delete**: fully generic; new types inherit behavior. No
   special handling. (Sanity-checked, not separately unit-tested beyond creation/clamp per
   acceptance criteria.)
5. **Clearance participation**: all new types are `furniture` (not `openings`), so they
   participate as both subject and neighbour with no special-casing. A `bathtub` placed
   against a wall reports wall + symbol gaps like any furniture.
6. **Missing glyph branch**: if a glyph branch is omitted, `_renderInterior` falls through
   and the plain gold box still renders — the symbol is fully functional (fail-safe). Each
   type nonetheless ships a glyph per acceptance criteria.
7. **Dock overflow on narrow screens**: the dock already has `overflow-x: auto` +
   hidden scrollbar and `max-width: calc(100vw - 2rem)`; 16 items scroll horizontally.
   See Frontend Design for the uncluttered-on-mobile decision.
8. **Unknown/legacy type in a loaded plan**: unchanged — `validatePlan` still rejects any
   `type` not in `CATALOG`, so a corrupted or future-only type invalidates the plan
   (existing guardrail).
9. **Export label length**: `exportImg` centers `CATALOG[type].label`; longer labels
   ("Bookshelf") render as-is at font-size 9 — acceptable, matches existing "Fridge".

## Dependencies

Nothing must be built first. This purely extends existing, shipped subsystems:

- `src/js/symbols.js` `CATALOG` / `clampDim` model (LLD 12).
- `src/js/symbolRender.js` `_renderInterior` glyph pattern (LLD 12).
- `src/js/plan.js` validate/serialize (LLD 16) — relied on for round-trip, unchanged.
- `src/index.html` symbol dock markup + CSS (LLD 12).

Independent of templates (future) and keyboard shortcuts — neither blocks this.

## Test Requirements

Add to `src/tests.html` in the existing `symbols.js` suites (mirror the current
`createSymbol`/`clampDim`/`resizeSymbol` cases).

**Unit — catalog integrity:**
- Every new type exists in `CATALOG` with `category:"furniture"`, a non-empty `label`,
  finite `w`,`h`,`min`,`max`, and `min <= w <= max` **and** `min <= h <= max` (guards the
  single-range/asymmetric-default edge case for all 8).
- No new type sets `openings:true`.

**Unit — creation:**
- `createSymbol(t, x, y)` for each new type returns a `Sym` with catalog `w`/`h`, `rot:0`,
  unique `id`, and correct `type`.
- New-type symbol is JSON-round-trippable (`JSON.parse(JSON.stringify(model))` preserves
  fields) — one representative type (e.g. `bathtub`).

**Unit — clamp/resize:**
- `clampDim(t, min-0.1)` → `min` and `clampDim(t, max+1)` → `max` for a representative
  asymmetric type (bathtub) and a symmetric one (washer).
- `resizeSymbol(sym, "w", huge)` and `("h", tiny)` clamp to bounds and return the changed
  flag correctly.

**Integration — round-trip (plan.js suite):**
- A plan containing at least one new-type symbol passes `validatePlan(buildPlan())` and
  survives `serializePlan` → `JSON.parse` → `validatePlan` unchanged (export/localStorage/
  URL-hash share path).
- **Backwards compat:** a hand-built plan object with only *old* types (or zero symbols)
  still validates — asserts the new entries did not tighten validation.

**Manual / QA (not automated):** each new dock item drags onto the canvas, renders a
recognizable to-scale glyph, and can be resized/rotated/duplicated/deleted; dock stays
scrollable and uncluttered on a mobile viewport.

## Frontend Design

**Frontend decision: Option A — extend the existing single bottom dock, grouped by
category, with horizontal scroll on overflow.** No new palette UI, no category tabs, no
collapsible panel. Rationale: the dock already groups by category (`Openings` |
`Furniture`) with `.dock-group-label` + `.dock-sep`, already scrolls horizontally
(`overflow-x:auto`, hidden scrollbar, `max-width: calc(100vw - 2rem)`), and this is the
lowest-risk, most consistent path. Curation keeps the total at 16 items — small enough
that a scroll dock stays uncluttered; a tabbed/expanding picker would be over-engineering
for the count and conflicts with the minimal-chrome philosophy.

**Markup:** append 8 `<button class="dock-item" data-type="…" aria-label="Add …">` entries
after the `fridge` button, inside the existing `Furniture` group (no new group needed — all
new items are furniture). Each carries an inline 18×18 `viewBox="0 0 18 18"` SVG icon using
`stroke="currentColor"` (so hover/active gold theming works) plus a `<span>` label —
matching every existing dock item. Icons should read as miniatures of the canvas glyph
(e.g. toilet = oval + tank bar; stove = 2×2 dots; tv = screen + stand).

**Mobile uncluttered guarantee:** with 16 items the dock exceeds phone width and relies on
the existing horizontal scroll. Add one CSS refinement to signal scrollability and keep it
tidy: a subtle inline scroll affordance is optional; at minimum verify the dock does not
force viewport horizontal scroll (it is `position:fixed; max-width: calc(100vw - 2rem)`,
so it clips correctly). No layout-engine change. Optionally reduce `.dock-item` width from
`2.6rem` to `2.4rem` under a `@media (max-width: 480px)` query if QA finds it cramped —
this is a routine MVP visual tweak authorized without further sign-off, provided it does
not conflict with the CX doc.

**Accessibility:** each button keeps a descriptive `aria-label` ("Add toilet", etc.); the
group label stays `aria-hidden` as today. Icons are `aria-hidden`.
