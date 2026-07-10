# LLD 50: Richer curated furniture/symbol set (RE-SHIP — Option A category tabs)

## Scope

**This is a RE-SHIP.** The catalog extension (LLD 45) already shipped: the 8 new types
(**toilet, bathtub, sink, stove, wardrobe, bookshelf, tv, washer**) are already present in
`CATALOG` (`src/js/symbols.js`), each with a glyph in `symbolRender.js` and a dock button in
`index.html`. That part of the acceptance criteria is **done and stays**.

What was shipped **incorrectly** is the dock presentation: the prior attempt shipped
**Option B** — one long grouped strip using `.dock-group-label` + `.dock-sep` — but the
approved decision is **Option A — category tabs**. This re-ship corrects only that, plus the
enabling data change:

1. **Data (root cause):** replace the binary `category: "openings" | "furniture"` field on
   every `CATALOG` entry with a **5-value taxonomy**: `"openings" | "living" | "kitchen" |
   "bedroom" | "bath"`. The binary field is why the 5-category grouping was never encoded.
2. **Dock UI:** replace the grouped single strip with a **tab strip** (`role="tablist"` of
   `role="tab"` buttons) above a **single item row** (`role="tabpanel"`) that shows only the
   active category's items; others hidden until selected.
3. **Dock controller:** a minimal session-only JS controller — clicking a tab sets the active
   category and shows/hides item rows; defaults to the first category.

**Explicitly NOT in scope:**
- No new symbol types, no changes to default dimensions, clamp bounds, or glyphs (all shipped
  under LLD 45 and correct).
- **`category` is NOT part of the plan schema.** It is dock-only presentation metadata. No
  change to `plan.js` `serializePlan` / `validatePlan`, `PLAN_SCHEMA`, `clearance.js`,
  `exportImg.js`, `symbolDimEntry.js`. Old plans continue to load unchanged (validation gates
  only on `sym.type in CATALOG`, never on category).
- No change to the per-item `data-type` contract, drag-to-place model, snapping, alignment,
  flush, history, or clearance algorithms.
- No persistence of the active tab (session-only UI state).
- No open-ended / user-editable catalog (curation constraint per CLAUDE.md).

## Approach

**Three edits, in order. The first (data) is the root cause; the tabs render from it.**

### 1. `symbols.js` — replace binary category with the 5-value taxonomy

The `category` field on every `CATALOG` entry changes from `"openings" | "furniture"` to one
of `"openings" | "living" | "kitchen" | "bedroom" | "bath"`. Confirmed mapping against the
shipped 16-type list:

| category  | types |
|-----------|-------|
| openings  | door, window |
| living    | sofa, table, chair, desk, tv, bookshelf |
| kitchen   | fridge, stove, sink, washer |
| bedroom   | bed, wardrobe |
| bath      | toilet, bathtub |

Notes reconciling suggested vs shipped list: **rug**, **dining-table variant**, **nightstand**,
and a separate **basin** never shipped (LLD 45 shipped `sink` covering vanity/basin; `bookshelf`
is the shipped "shelf"). So the taxonomy maps only the 16 shipped types. `sink` and `washer` are
placed in **kitchen** (a kitchen sink / laundry appliance are the higher-frequency uses; the same
symbols serve a bathroom sink without a duplicate type — matches curation constraint).

**Critical:** any code that branched on `category === "openings"` still works — `openings` is
preserved as a category value. But nothing branches on `category === "furniture"` today: the
opening-vs-furniture distinction everywhere in the code is driven by the separate boolean
`openings: true` flag (see `resizeSymbol`, `_renderInterior`, `_renderDimChips`,
`clearance.computeClearances`), **not** the `category` string. Grep confirms `category` is read
only by the dock. Therefore replacing the `category` values is safe — `openings:true` remains the
single source of truth for opening behavior.

### 2. `index.html` — replace grouped strip with tab strip + tabpanel

Remove the `.dock-group-label` spans and `.dock-sep` divider. Structure the dock as:
- a `.dock-tabs` element (`role="tablist"`) containing one `.dock-tab` button
  (`role="tab"`) per category, in taxonomy order (Openings, Living, Kitchen, Bedroom, Bath);
- one `.dock-row` element (`role="tabpanel"`) **per category**, each containing that category's
  existing `.dock-item` buttons (unchanged markup). Only the active category's row is visible.

The 16 existing `.dock-item` buttons keep their exact markup (`data-type`, `aria-label`, inline
SVG icon, `<span>` label) — they are just regrouped under per-category rows. **Tab buttons carry
NO `data-type` attribute** so `_onDockPointerDown`'s `e.target.closest("[data-type]")` never
treats a tab as a draggable item.

### 3. New dock controller (small JS)

A minimal session-only controller wires tab clicks to show/hide the item rows. It can live in a
new `src/js/dockTabs.js` (preferred, mirrors the one-module-per-concern layout) or as a small
init block in `main.js`. It does not touch `symbolTool`, the model, or persistence.

**Why this is a natural boundary / low risk:** the data change is a value-set swap on an existing
field; the markup change regroups existing buttons; the controller is pure show/hide. No
downstream consumer of the plan or the drag pipeline changes.

## Interfaces / Types

### `src/js/symbols.js`

Extend the category typedef and swap each entry's `category` value. No function signatures
change. `openings: true` on `door`/`window` is unchanged.

```js
/** @typedef {"openings"|"living"|"kitchen"|"bedroom"|"bath"} SymCategory */

/** @type {Record<SymbolType, {label:string, category:SymCategory,
 *   openings?:boolean, w:number, h:number, min:number, max:number}>} */
export const CATALOG = {
  door:      { label: "Door",      category: "openings", openings: true, w: 0.90, h: 0.12, min: 0.60, max: 2.00 },
  window:    { label: "Window",    category: "openings", openings: true, w: 1.00, h: 0.12, min: 0.30, max: 3.00 },
  bed:       { label: "Bed",       category: "bedroom",  w: 1.50, h: 2.00, min: 0.30, max: 2.50 },
  sofa:      { label: "Sofa",      category: "living",   w: 2.00, h: 0.90, min: 0.30, max: 3.50 },
  table:     { label: "Table",     category: "living",   w: 1.20, h: 0.80, min: 0.30, max: 3.00 },
  chair:     { label: "Chair",     category: "living",   w: 0.50, h: 0.50, min: 0.30, max: 1.00 },
  desk:      { label: "Desk",      category: "living",   w: 1.40, h: 0.70, min: 0.30, max: 2.50 },
  fridge:    { label: "Fridge",    category: "kitchen",  w: 0.70, h: 0.70, min: 0.30, max: 1.20 },
  toilet:    { label: "Toilet",    category: "bath",     w: 0.40, h: 0.70, min: 0.30, max: 1.00 },
  bathtub:   { label: "Bathtub",   category: "bath",     w: 1.70, h: 0.75, min: 0.30, max: 2.20 },
  sink:      { label: "Sink",      category: "kitchen",  w: 0.60, h: 0.45, min: 0.30, max: 1.50 },
  stove:     { label: "Stove",     category: "kitchen",  w: 0.60, h: 0.60, min: 0.30, max: 1.20 },
  wardrobe:  { label: "Wardrobe",  category: "bedroom",  w: 1.00, h: 0.60, min: 0.30, max: 3.00 },
  bookshelf: { label: "Bookshelf", category: "living",   w: 0.80, h: 0.30, min: 0.30, max: 3.00 },
  tv:        { label: "TV",        category: "living",   w: 1.20, h: 0.40, min: 0.30, max: 2.50 },
  washer:    { label: "Washer",    category: "kitchen",  w: 0.60, h: 0.60, min: 0.30, max: 1.00 },
};
```

(All `w/h/min/max` values are unchanged from the shipped catalog; only `category` values change.)

### Dock controller (`src/js/dockTabs.js`)

```js
/**
 * Wire the dock category tabs to show/hide item rows. Session-only; persists nothing.
 * @param {HTMLElement} dock  the #symbol-dock element
 */
export function initDockTabs(dock) { /* ... */ }

/**
 * Activate a category tab: mark its tab selected, show its row, hide the others.
 * Exported for tests. No-op if the category has no tab/row.
 * @param {HTMLElement} dock
 * @param {SymCategory} category
 */
export function setActiveCategory(dock, category) { /* ... */ }
```

Behavior:
- On init, read all `.dock-tab[data-category]` and `.dock-row[data-category]` under `dock`.
- Attach one `click` listener to the tablist (event delegation) that calls
  `setActiveCategory(dock, clickedTab.dataset.category)`.
- `setActiveCategory` toggles `aria-selected="true"` / `tabIndex` on the matching tab (others
  `aria-selected="false"`), and toggles the `hidden` attribute on `.dock-row` elements so only
  the matching row is visible.
- Default active category on load = first tab in DOM order (`openings`).
- Keyboard: Left/Right arrows on a focused tab move selection to the adjacent tab (standard
  ARIA tabs pattern); Enter/Space activates. (Minimal; roving tabindex.)

### `src/index.html` markup shape (illustrative)

```html
<nav class="symbol-dock" id="symbol-dock" aria-label="Symbol palette">
  <div class="dock-tabs" role="tablist" aria-label="Symbol categories">
    <button class="dock-tab" role="tab" data-category="openings"
            id="tab-openings" aria-controls="row-openings" aria-selected="true">Openings</button>
    <button class="dock-tab" role="tab" data-category="living"
            id="tab-living" aria-controls="row-living" aria-selected="false" tabindex="-1">Living</button>
    <!-- Kitchen, Bedroom, Bath … -->
  </div>

  <div class="dock-row" role="tabpanel" data-category="openings" id="row-openings"
       aria-labelledby="tab-openings">
    <!-- existing door, window .dock-item buttons unchanged -->
  </div>
  <div class="dock-row" role="tabpanel" data-category="living" id="row-living"
       aria-labelledby="tab-living" hidden>
    <!-- sofa, table, chair, desk, tv, bookshelf .dock-item buttons -->
  </div>
  <!-- kitchen, bedroom, bath rows … -->
</nav>
```

### Files that DO NOT change

`src/js/plan.js`, `src/js/clearance.js`, `src/js/exportImg.js`, `src/js/symbolDimEntry.js`,
`src/js/symbolRender.js` (glyphs already shipped), and `src/js/symbolTool.js` (its
`_onDockPointerDown` already keys off `[data-type]`, which only item buttons carry). `main.js`
gains one line to call `initDockTabs(dockEl)`.

## State Model

- **Plan / persisted state (unchanged):** symbols remain ordinary `Sym` records
  `{id,type,x,y,w,h,rot}` in `symbols.model.symbols`. `category` is catalog metadata, **not** a
  `Sym` field and **not** serialized. `serializePlan` → localStorage / JSON export / URL hash
  and `validatePlan` are untouched; `PLAN_SCHEMA` stays `1`.
- **Backwards compatibility:** `validatePlan` gates on `sym.type in CATALOG` only. Because the
  16 `type` keys are unchanged (only their `category` value changed), every previously valid
  plan — including ones authored before any new types existed — still validates and applies. A
  plan authored with the new types opened in an older build fails validation the same way it did
  before (existing forward-compat behavior; acceptable, no schema bump).
- **Active-tab state (new, in-memory / session only):** which category tab is active lives in
  the DOM (`aria-selected` + `hidden`) and is derived on load (defaults to `openings`). It is
  never persisted — reloading resets to the first tab. This matches "persist nothing" from the
  re-ship spec.
- No change to selection, ghost, guides, or history state.

## Frontend Design

**Decision: Option A — Category tabs.** A tab strip sits on top of the dock, one tab per
category (5-value taxonomy: Openings, Living, Kitchen, Bedroom, Bath). Selecting a tab shows only
that category's items in a single row; the other rows are hidden until selected. The active tab
is always highlighted/labeled. On mobile, the tab strip and the item row each scroll horizontally
and independently within the bottom sheet.

**Why A over B:** density stays low regardless of catalog size — at most one category's items
(2–6) are visible at once, versus Option B's single strip of all 16 items that forced long
horizontal scrolling and read as cluttered. The prior implementation shipped Option B and was
reopened; this re-ship renders tabs from the new taxonomy. Reference mockup:
`design-mockups/richer-curated-furniture-symbol-set.html` (Option A). **Note:** that mockup file
is not present in this worktree/repo at design time — the implementer should treat the CSS/markup
specs below as authoritative and, if the mockup is restored, reconcile visual details (gold accent
on active tab, graph-paper panel) against it.

**Markup:** as in Interfaces — a `.dock-tabs` `role="tablist"` above per-category `.dock-row`
`role="tabpanel"` elements. Existing `.dock-item` buttons move verbatim into their category's row.

**CSS (extend the existing dock block in `index.html`):**
- Change `.symbol-dock` to `flex-direction: column; align-items: stretch;` so the tab strip
  stacks above the item row. Keep `position: fixed`, the gold/graph-paper `--panel` background,
  hairline border, blur, `z-index`, and bottom placement (desktop centered; coarse-pointer /
  ≤640px full-width bottom sheet with safe-area padding — all preserved from LLD 46).
- `.dock-tabs`: `display:flex; overflow-x:auto; scrollbar-width:none;` (hidden scrollbar as the
  dock already does); a subtle hairline bottom border separating tabs from the row.
- `.dock-tab`: mono font, uppercase small label matching the retired `.dock-group-label` styling
  (`font-size:0.52rem`, letter-spacing, `--muted` color); transparent background; padding giving
  a **≥44px** hit height under coarse pointer (reuse the LLD 46 coarse-pointer sizing pattern).
  Active state (`aria-selected="true"`): gold text + `border-bottom` gold underline +
  `rgba(201,168,76,0.13)` wash, mirroring `.dock-item--active`.
- `.dock-row`: `display:flex; gap:0; overflow-x:auto; scrollbar-width:none;` — same horizontal
  scroll behavior the single strip had. `.dock-row[hidden]` is not rendered (native `hidden`).
- `.dock-item`: unchanged, including the `@media (max-width:480px)` compaction and the coarse-
  pointer `3rem` (≥44px) sizing from LLD 46. Remove the now-unused `.dock-group-label` and
  `.dock-sep` rules (orphaned by this change — safe to delete per surgical-change rule).

**Interaction:** click/tap a tab → its row shows, others hide (controller above). Drag-to-place
from a visible `.dock-item` is unchanged (`symbolTool._onDockPointerDown`). Because tabs have no
`data-type`, tapping a tab never starts a placement drag.

**Accessibility:** proper `role="tablist"/"tab"/"tabpanel"` wiring with `aria-controls` /
`aria-labelledby`; roving `tabindex` (active tab `0`, others `-1`); Left/Right arrow navigation;
`aria-selected` reflects state. `.dock-item` buttons keep their descriptive `aria-label`
("Add toilet", etc.); icons stay `aria-hidden`.

## Edge Cases

1. **Old plan without new types / authored before category change:** validates and loads
   unchanged (`validatePlan` gates on `type in CATALOG`, never on `category`). Assert in tests.
2. **Tab with no items:** cannot occur — every one of the 5 categories has ≥1 shipped type, so
   every tab has a non-empty row. The controller nonetheless renders a tab only for categories
   that have a `.dock-row` (defensive), so an empty category would simply produce no tab.
3. **Every type must have exactly one of the 5 valid categories** — no leftover `"furniture"`.
   Enforced by a catalog-integrity test iterating all `CATALOG` entries.
4. **Tab button mistaken for a draggable item:** prevented — tabs carry no `data-type`;
   `_onDockPointerDown` bails when `e.target.closest("[data-type]")` is null.
5. **Drag started, then a tab tapped mid-gesture:** not reachable — a placement drag captures
   the pointer on the dock (`setPointerCapture`) until `pointerup`; the tab click happens between
   gestures. No special handling.
6. **Default tab on load:** first tab in DOM order (`openings`) is active; its row visible, all
   others `hidden`. Reload resets to this (no persistence).
7. **Coarse-pointer bottom sheet overflow:** both the tab strip and the active item row scroll
   horizontally and independently; item targets stay ≥44px (LLD 46). The dock is
   `max-width:100%` full-width on coarse pointers, so it never forces viewport horizontal scroll.
8. **`category` value read anywhere other than the dock:** none today — `openings` behavior is
   driven by the `openings:true` boolean, not the category string. Re-verify with a grep for
   `\.category` during implementation before deleting the old values.
9. **Reduced motion:** tab activation is an instant show/hide (no transition needed); existing
   `prefers-reduced-motion` block already covers `.dock-item`.

## Dependencies

Nothing must be built first. This extends already-shipped subsystems:
- `src/js/symbols.js` `CATALOG` (LLD 12; extended by LLD 45 — the 8 new types are present).
- `src/js/symbolRender.js` glyphs (already shipped for all 16 types — no change).
- `src/index.html` dock markup + CSS, and the LLD 46 coarse-pointer bottom-sheet / ≥44px sizing.
- `src/js/symbolTool.js` `_onDockPointerDown` `[data-type]` contract (unchanged).
- `src/js/plan.js` validate/serialize (LLD 16) — relied on for round-trip, unchanged.

Independent of templates and keyboard shortcuts (parent issue #3 siblings).

## Test Requirements

Add to `src/tests.html` alongside the existing `symbols.js` suites and a small DOM-based dock
suite (tests.html already runs in a browser context, so DOM assertions are available).

**Unit — catalog taxonomy integrity:**
- Every `CATALOG` entry's `category` is one of the exact set
  `{"openings","living","kitchen","bedroom","bath"}` — **no entry retains `"furniture"`**.
- `door` and `window` have `category === "openings"` **and** `openings === true`; no other type
  sets `openings`.
- Spot-check the mapping: e.g. `CATALOG.bed.category === "bedroom"`,
  `CATALOG.stove.category === "kitchen"`, `CATALOG.tv.category === "living"`,
  `CATALOG.toilet.category === "bath"`.
- Regression guard (kept from LLD 45): for every type, `min <= w <= max` **and** `min <= h <= max`
  (single-range/asymmetric-default guard), finite `w/h/min/max`, non-empty `label`.

**Unit — creation / clamp (kept from LLD 45, still required by acceptance criteria):**
- `createSymbol(t,x,y)` for each new type returns a `Sym` with catalog `w/h`, `rot:0`, unique id.
- `clampDim(t, min-0.1) → min` and `clampDim(t, max+1) → max` for an asymmetric type (bathtub)
  and a symmetric one (washer); `resizeSymbol` clamps and returns the changed flag correctly.

**DOM — dock tabs:**
- Dock renders exactly one `.dock-tab` per non-empty category (5 tabs) and one `.dock-row` per
  category; the union of `.dock-item[data-type]` across all rows equals the 16 catalog keys.
- On load, exactly one tab has `aria-selected="true"` (the first, `openings`) and exactly one
  `.dock-row` is visible (not `hidden`).
- `setActiveCategory(dock, "kitchen")` shows only the kitchen row, hides the other four, and sets
  `aria-selected="true"` on the kitchen tab only.
- Tab buttons have no `data-type` attribute (so they are never draggable items).

**Integration — round-trip / backwards-compat (plan.js suite, kept from LLD 45):**
- A plan containing at least one new-type symbol passes `validatePlan(buildPlan())` and survives
  `serializePlan` → `JSON.parse` → `validatePlan` unchanged.
- A hand-built plan object with only old types (or zero symbols) still validates — asserts the
  category change did not affect the plan schema.

**Manual / QA (not automated):** on a mobile viewport, tap each tab and confirm only that
category's items show; both the tab strip and item row scroll horizontally; item targets are
≥44px; drag-to-place still works for a symbol in each category; gold/graph-paper aesthetic and
bottom-sheet behavior are preserved.

