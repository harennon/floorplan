# LLD 70: Expand curated catalog — bedroom & storage pieces (nightstand, dresser, cabinet)

## Scope

Part of #3 (Phase 2 — richer furniture/symbol set). Adds **exactly three** curated
bedroom/storage furniture types by reusing the existing symbol pattern verbatim:

- **nightstand** — small bedside table.
- **dresser** — wide low chest of drawers.
- **cabinet** — general closed storage unit.

The change is **strictly additive**: three new `CATALOG` entries in `src/js/symbols.js`,
three new glyph branches in `_renderInterior()` in `src/js/symbolRender.js`, three new
`.dock-item` buttons in the existing Bedroom row (`#row-bedroom`) in `src/index.html`, and
test-array updates. No existing symbol handling, schema, or algorithm changes.

**Explicitly NOT in scope:**

- No new symbol-definition or rendering system. Glyphs compose only the SVG primitives
  already used in `_renderInterior` (`rect`/`line`/`circle`/`ellipse`/`polygon`); no new
  render helper. Any piece needing a new primitive is out of scope by construction — all
  three chosen pieces render from lines + a rect only.
- No new category tab. All three go in the existing **Bedroom** tab.
- No change to `SymCategory` values, the dock-tabs controller (`dockTabs.js`), snapping,
  alignment, flush, clearance, history, export, plan schema, or the MCP server code.
- No change to `data-type` / drag-to-place contract, `clampDim`, `resizeSymbol`, or
  `symbolDimEntry.js` — the new types flow through all of these unmodified.
- No open-ended / user-editable catalog (curation constraint per CLAUDE.md).

**Rebase note (ships 2nd of 3):** this issue is Order 1-of-3 of the batch but ships after
#74 lands on `symbols.js` / `symbolRender.js` / `index.html` / `tests.html`. On rebase,
reconcile the dock-item **count** assertion (see Test Requirements) and the shared
type-enumeration arrays against #74's additions — do not assume the catalog is still 16
types.

## Approach

Frontend decision: **Option A** — add the three pieces using only existing SVG primitives,
no new render helpers, change strictly additive. Four edits, in order:

### 1. `symbols.js` — add three `CATALOG` entries

Copy the `bed`/`wardrobe` schema shape exactly (`label`, `category:"bedroom"`, `w`, `h`,
`min`, `max`; no `openings` flag). Real-world to-scale defaults:

| type       | label      | w (m) | h (m) | min  | max  |
|------------|------------|-------|-------|------|------|
| nightstand | Nightstand | 0.45  | 0.40  | 0.30 | 1.00 |
| dresser    | Dresser    | 1.00  | 0.50  | 0.30 | 2.50 |
| cabinet    | Cabinet    | 0.90  | 0.40  | 0.30 | 2.50 |

Bounds satisfy the catalog-integrity invariant `min <= w,h <= max` for every entry (checked:
nightstand 0.30≤0.40,0.45≤1.00; dresser 0.30≤0.50,1.00≤2.50; cabinet 0.30≤0.40,0.90≤2.50).
Extend the `SymbolType` typedef union to include `"nightstand"|"dresser"|"cabinet"`. No
function bodies change — `createSymbol`, `clampDim`, `resizeSymbol`, `hitTest`, `corners`,
etc. are all type-agnostic and pick up the new entries automatically.

### 2. `symbolRender.js` — add three glyph branches in `_renderInterior()`

Add three `if (sym.type === …)` branches alongside the existing furniture branches, using
the established local-frame helper `lp(lx, ly)` (rotates a center-relative offset into
screen space) and `_makeLine`. Each uses `p.symStroke` for hairlines (width ~0.7–0.8,
reduced opacity), matching the `wardrobe`/`bookshelf`/`fridge` idiom. Proposed glyphs
(all primitives already present — lines + one rect):

- **nightstand** — a single inset drawer line: one horizontal `_makeLine` across the width
  at ~40% depth, plus a small center handle dot (`circle`, like `wardrobe`). (Distinguishes
  from `table`'s cross and `chair`'s circle.)
- **dresser** — two horizontal drawer lines (evenly spaced, like a 2-row `bookshelf`) plus
  a short vertical center split line across the drawer band, echoing a chest of drawers.
- **cabinet** — a vertical center divider `_makeLine` (two doors) with two handle dots, but
  **without** wardrobe's full-height read — draw the divider inset and add a single
  horizontal shelf line at mid-depth to read as closed storage distinct from `wardrobe`.

(Exact offsets are the implementer's to tune for legibility; the constraint is *primitives
already in use*. If two glyphs read too alike at small size, nudge line count/handle
placement — do not add a new primitive.)

### 3. `index.html` — add three `.dock-item` buttons to `#row-bedroom`

Append three buttons inside the existing `<div class="dock-row" … id="row-bedroom">`, after
`wardrobe`, matching the exact markup of `bed`/`wardrobe`: `class="dock-item"`,
`data-type="…"`, `aria-label="Add …"`, an inline `18x18` `viewBox="0 0 18 18"` SVG icon
(`aria-hidden="true"`, `stroke="currentColor"`), and a `<span>` label. Icons reuse the same
primitives (a bounding `rect` + drawer/divider `line`s + handle `circle`s). No tab, CSS, or
controller change — the Bedroom tab already exists and `dockTabs.js` discovers rows/items
generically.

### 4. `tests.html` — extend enumerations and dock assertion

Add the three types to the shared new-type coverage arrays and reconcile the dock-item count
(see Test Requirements). No new test infrastructure.

**Why low-risk:** every consumer (drag-to-place `symbolTool`, `clampDim`/`resizeSymbol`,
clearance, export, plan `validatePlan` which gates on `type in CATALOG`, and MCP
`place_symbol` which validates against `CATALOG`) already keys off the catalog generically.
Adding entries lights all of them up with zero per-type special-casing.

## Interfaces / Types

### `src/js/symbols.js`

Extend the union typedef and add three entries. No signature changes.

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"nightstand"|"dresser"|"cabinet"} SymbolType */

// Added to CATALOG (in the bedroom grouping, alongside bed/wardrobe):
nightstand: { label: "Nightstand", category: "bedroom", w: 0.45, h: 0.40, min: 0.30, max: 1.00 },
dresser:    { label: "Dresser",    category: "bedroom", w: 1.00, h: 0.50, min: 0.30, max: 2.50 },
cabinet:    { label: "Cabinet",    category: "bedroom", w: 0.90, h: 0.40, min: 0.30, max: 2.50 },
```

### `src/js/symbolRender.js`

Three new branches inside `_renderInterior(parent, sym, cs, p)`, using existing locals
(`lp`, `sw`, `sh`, `_makeLine`, `p.symStroke`, `rgb`). Signature unchanged. Shape mirrors
the existing `wardrobe`/`bookshelf` branches — append `line`/`circle` (and at most one
`polygon`/`rect`-equivalent) children to `parent`, then `return`.

### `src/index.html`

Three `<button class="dock-item" data-type="{nightstand|dresser|cabinet}" aria-label="Add …">`
elements inside `#row-bedroom`, each with an inline `18x18` SVG icon + `<span>` label.
No new attributes or contracts.

### Files that DO NOT change

`src/js/dockTabs.js`, `src/js/symbolTool.js`, `src/js/symbolDimEntry.js`, `src/js/plan.js`,
`src/js/clearance.js`, `src/js/exportImg.js`, `src/js/view.js`, and the MCP server
(`mcp/**`). Each reads the catalog / `[data-type]` generically.

## State Model

- **Persisted state (unchanged):** a placed piece is an ordinary `Sym` record
  `{id,type,x,y,w,h,rot}` in `symbols.model.symbols`, where `type` is now one of the three
  new strings. `category` is dock-only catalog metadata and is **not** serialized. No
  `PLAN_SCHEMA` bump.
- **Serialization / round-trip:** `serializePlan` → localStorage / JSON export / URL hash
  and `validatePlan` are untouched. `validatePlan` gates on `sym.type in CATALOG`; because
  the three keys now exist in `CATALOG`, plans containing them validate and round-trip.
  PNG/SVG export render via the same `_renderInterior` path, so a placed piece exports with
  its glyph.
- **Backwards / forward compatibility:** old plans (without the new types) are unaffected —
  no existing key changed. A plan authored with a new type, opened in an older build, fails
  `validatePlan` exactly as any unknown type does today (pre-existing forward-compat
  behavior; acceptable, no schema change).
- **Active-tab / selection / ghost / history state:** unchanged.

## Frontend Design

**Decision: Option A** — add exactly three curated pieces (nightstand, dresser, cabinet)
using only existing SVG primitives (`polygon`/`line`/`circle`/`ellipse`/`rect`), no new
render helpers. The change is strictly additive; existing symbol handling is not modified.

**Dock placement:** the three new `.dock-item` buttons live in the existing **Bedroom** tab
row (`#row-bedroom`), appended after `bed` and `wardrobe`. No new category tab; the
`dockTabs.js` controller already shows/hides this row and discovers items generically. The
Bedroom row goes from 2 to 5 items — still well within the horizontally-scrolling row and
the ≥44px coarse-pointer hit target sizing already defined for `.dock-item` (LLD 46). No CSS
change is required.

**Dock icons (18×18):** each button carries an inline SVG matching the `bed`/`wardrobe`
idiom — a bounding `rect` outline plus a couple of `line`s and small `circle` handle dots,
`stroke="currentColor"`, `aria-hidden="true"`:

- nightstand — square-ish `rect` + one horizontal drawer line + one center handle dot.
- dresser — wide `rect` + two horizontal drawer lines + a short vertical split.
- cabinet — `rect` + vertical center divider + two handle dots (reads as closed doors).

**Canvas glyphs:** as described in Approach §2 — legible, distinct at small scale, composed
only from primitives already in `_renderInterior`. Selection box, dim chips (both w and h,
since none are openings), rotate handle, and ghost all come from the shared symbol paths
unchanged.

**Accessibility:** each button keeps a descriptive `aria-label` ("Add nightstand", etc.);
icons are `aria-hidden`. Matches the existing dock pattern exactly.

## Edge Cases

1. **Resize past bounds:** dim-chip entry routes through `resizeSymbol`→`clampDim`, which
   clamps to each type's `[min,max]` on both w and h (none are openings, so both chips
   show). Values below min → min, above max → max. Covered by tests.
2. **Glyph legibility when shrunk to min:** all glyph offsets are fractions of `sw`/`sh`
   (plus small px insets like the existing branches), so they scale down without overflowing
   the box; at `min` (0.30 m) they collapse gracefully like the existing small types
   (chair, sink). No special handling.
3. **Two glyphs reading alike (dresser vs cabinet vs wardrobe):** mitigated by distinct line
   counts / divider orientation (Approach §2). Purely visual; if still ambiguous, tune
   offsets — never add a primitive.
4. **Rotation:** glyphs are built via `lp()` (local→rotated-screen), so they rotate with the
   body exactly like existing furniture. No per-type rotation logic.
5. **Unknown-type render:** `_renderInterior` falls through with no glyph for any type
   lacking a branch (only the base polygon draws). Adding the three branches prevents a
   blank body; not a crash either way.
6. **MCP `place_symbol` with a new type:** accepted automatically — the handler validates
   `type ∈ CATALOG` and routes dims through `clampDim`. No allowlist edit (per acceptance
   criteria). Adding the `CATALOG` entry is the whole change.
7. **Old plan / forward-compat:** see State Model — no existing key changed; old plans load
   unchanged, and a new-type plan in an older build fails validation like any unknown type.
8. **Dock-count / enumeration drift after #74 rebase:** the hardcoded catalog-size numbers
   in tests (currently 16) must be reconciled to the post-#74 total plus 3. See Test
   Requirements.

## Dependencies

Nothing must be built first; this extends already-shipped subsystems:

- `src/js/symbols.js` `CATALOG` + `SymbolType` (LLD 12/45/50).
- `src/js/symbolRender.js` `_renderInterior` glyph dispatch (LLD 45/50).
- `src/index.html` Bedroom `.dock-row#row-bedroom` + `dockTabs.js` controller (LLD 50).
- `src/js/symbolTool.js` `[data-type]` drag-to-place, `symbolDimEntry.js` clamp path,
  `clearance.js`, `exportImg.js`, `plan.js` validate/serialize — all consumed unchanged.
- MCP `place_symbol` catalog validation (LLD 32).

**Ordering:** ships **after #74** in the batch. Rebase onto #74's changes to
`symbols.js` / `symbolRender.js` / `index.html` / `tests.html` and reconcile shared
type-enumeration arrays and the dock count (below) before implementing.

## Test Requirements

Extend `test/tests.html` in place — no new harness. Reuse the existing LLD-45/50 patterns.

**Unit — catalog integrity (extend existing suites):**
- Add `"nightstand"`, `"dresser"`, `"cabinet"` to the shared new-type coverage array (the
  `LLD45_TYPES` / `newTypes` arrays and any equivalent post-#74 array). The existing
  loops then assert, for each: present in `CATALOG`; `category === "bedroom"` and is one of
  the 5 valid categories; `min <= w <= max` **and** `min <= h <= max`; finite `w/h/min/max`;
  non-empty `label`; and `openings` is falsy.
- Spot-check mapping: `CATALOG.nightstand.category === "bedroom"`, same for `dresser`,
  `cabinet`.

**Unit — creation / clamp:**
- `createSymbol(t, x, y)` for each new type returns a `Sym` with catalog `w/h`, `rot:0`,
  unique `s<n>` id.
- `clampDim`/`resizeSymbol`: for each new type, below-min → min and above-max → max on both
  w and h; in-range unchanged; `resizeSymbol` returns the correct changed flag. (Nightstand
  and cabinet are the asymmetric-default cases; dresser too.)

**DOM — dock (extend the LLD-50 dock suite):**
- Reconcile the "union of dock-item `[data-type]` equals catalog keys" test: the
  `_makeDockDOM` fixture's `itemsByCategory.bedroom` must add the three types, and the
  hardcoded count (`16`) must become **the post-#74 catalog size + 3** (per selection note,
  **19** if #74 shipped its expected additions — verify against the actual rebased
  `Object.keys(CATALOG).length`, do not assume). The union-equals-`Object.keys(CATALOG)`
  assertion is self-checking; only the literal count needs updating.
- Bedroom row contains 5 `.dock-item` buttons including the three new `data-type`s; each has
  a descriptive `aria-label` and no tab carries `data-type`.

**Render (extend SVG structural suite):**
- Placing each new type and rendering produces the base `polygon` plus its glyph children
  (at least one `line`/`circle`) in `#symbols`, mirroring existing per-type render assertions.

**Integration — round-trip / MCP:**
- A plan containing a nightstand/dresser/cabinet passes `validatePlan(buildPlan())` and
  survives `serializePlan` → `JSON.parse` → `validatePlan` unchanged (JSON + URL-hash path).
- If MCP tool tests exist: `place_symbol {type:"dresser", …}` returns `ok` (validates
  against `CATALOG`, dims clamped) with no allowlist edit.

**Manual / QA (not automated):** each piece appears in the Bedroom dock tab, drags onto the
grid, resizes via both dim chips within bounds, fit-tests through the clearance/measure path
with no special-casing, and exports correctly to PNG/SVG/JSON with its glyph.
