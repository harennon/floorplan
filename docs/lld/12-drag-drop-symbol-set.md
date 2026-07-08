# LLD 12: MVP-4 — Drag-Drop Symbol Set (Doors, Windows, ~6 Furniture) with Editable Dimensions

Phase 4 of 6 of the MVP epic (#1). Builds on the drawing surface (#5 / LLD 2), wall
drawing + snapping (#6 / LLD 4), and the dimensions/units layer (#7 / LLD 9). This phase
adds a small **drag-drop symbol palette** — 2 openings (door, window) + 6 furniture pieces
— that place **to true scale** relative to the walls, can be **moved and rotated**, and
have **editable dimensions** via the same on-canvas dim-chip idiom used for walls.
Client-side only; nothing is persisted or sent to a server (that is #MVP-6).

## Scope

**Covers:**
- A **bottom-center dock palette** (Direction A), always live in **select mode**, with two
  groups: **Openings** (Door, Window) and **Furniture** (Bed, Sofa, Table, Chair, Desk,
  Fridge) — 8 symbols total.
- **Drag-to-place**: press a dock item, drag onto the canvas → a grid-snapped **ghost**
  follows the pointer → release drops the symbol, which **auto-selects** and opens its
  editor. No dedicated tool/mode; dragging from the dock *is* the placement gesture.
- **To-scale rendering** using the exact `view.js` scale contract (`BASE_PX_PER_M = 40`);
  no second scale is introduced.
- **Move** a selected symbol (drag its body; grid-snapped center) and **rotate** it
  (rotate handle + 90° button in a floating inspector).
- **Editable dimensions** per symbol — width and depth (metres, shown in the active unit)
  via **on-canvas dimension chips**, reusing the MVP-3 wall dim-chip pattern. Per-type
  min/max clamps; optional lock-aspect.
- A floating **inspector** hosting rotate / 90° / duplicate / delete / lock-aspect. Numeric
  width/depth editing lives on the canvas chips, **not** in the inspector.
- Serializable `model.symbols[]` mirroring `walls.model`, so #MVP-6 JSON export / URL-hash
  share pick it up for free.

**Does NOT cover (explicitly out):**
- **Large / branded furniture catalogs** — out of v1.
- **Clearance / "does my couch fit" checking** — #2, separate phase.
- **Undo/redo** — #9.
- **Persistence / export / share** — #MVP-6 / #10. We only add the serializable model shape;
  we do not build export/share here.
- **Wall-mounted opening behavior** (auto-embedding a door/window into a wall, cutting the
  wall line) — openings place as free to-scale glyphs in v1; wall-snapping is a later
  enhancement.

## Approach

**New geometry core `symbols.js`, mirroring `walls.js`.** Pure, DOM-free, testable. Holds the
serializable `model.symbols[]`, the symbol-type catalog (defaults + clamps), and pure
functions for hit-testing, clamping, and move/rotate/resize mutations. World units are
metres, exactly like walls.

**One scale, reused.** All world↔screen conversion goes through `view.js`
(`worldToScreen`/`screenToWorld`/`pxPerM`). A symbol of world size `w × h` renders at
`w*pxPerM() × h*pxPerM()` pixels — identical scale to walls at every zoom. No new constant.

**Reuse existing infra:**
- **Grid snap:** `gridSnap()` + `chooseGridStep()` from `walls.js`/`grid.js` snap the symbol
  center during placement/move. Alt = free (no snap), mirroring the wall tool.
- **Dim-chip idiom:** symbol width/depth chips reuse the MVP-3 chip → inline-input flow
  (`dimEntry.js` design), rendered into the shared `.dim-labels` overlay and styled by the
  shared chip/input CSS. A parallel controller `symbolDimEntry.js` edits `w`/`h` (vs wall
  edge length) to avoid entangling the tested wall path.
- **Units:** chips format via `fmtLen`/`unitLabel`; entry parses via `parseLen`. Storage is
  always metres; the unit toggle is display-only.
- **Render loop:** `symbolRender.render` registers as a `surface.onRender` hook. SVG paint
  order follows DOM group order, so symbols draw above walls without touching `surface.js`'s
  wall layer.

**Selection & interaction via injected hooks.** `interactions.js` already arbitrates
pan/draw. It gains a **select-hooks** slot (mirroring the existing draw-hooks) so that, in
select mode, a pointerdown first asks `symbolTool` whether it hit a symbol/handle before
falling through to pan. Dock drag-placement is self-contained in `symbolTool` (its own
pointer capture from the dock), so it does not go through `interactions.js`.

**Rendering separation of concerns** (mirrors `wallRender.js`): `symbolRender.js` reads
`symbols.model` + selection state and paints into two new SVG groups (`#symbols` bodies,
`#symbol-overlay` selection box/handles) and appends dim chips to `.dim-labels`. It fires no
events.

**Shared `.dim-labels` clear/ordering contract (critical — the two renderers co-own this one
overlay).** `wallRender.render()` unconditionally clears the *entire* `.dim-labels` container
each frame (`_clearDimLabels`, wallRender.js:404-407) and then re-appends wall chips. Because
SVG/DOM has no per-owner clearing, the layer is shared by convention with a strict discipline:
- `symbolRender` **owns and clears only its own two SVG groups** (`#symbols`, `#symbol-overlay`)
  each frame. It **MUST NOT** call any clear on `.dim-labels`.
- `symbolRender` **appends** its symbol dim chips to `.dim-labels` *without clearing it*, so it
  never wipes the wall chips that `wallRender` just added.
- Therefore `symbolRender.render` **MUST be registered as an `onRender` hook AFTER `wallRender`
  runs**. Per `surface._doRender` (surface.js:105-113) the fixed order is: `drawGrid` →
  `_wallRender()` → `_renderHooks` in registration order → `hudUpdate`. `wallRender` runs as
  `_wallRender` (before all hooks), so any `onRender` hook is already after it; among hooks,
  `main.js` registers `symbolRender.render` (and then `symbolDimEntry.reposition`) — do not
  register it before other `.dim-labels` writers. Net invariant each frame: `wallRender` clears
  `.dim-labels` and adds wall chips first; `symbolRender` then appends symbol chips; nobody else
  clears the container. Violating either rule (symbolRender clearing `.dim-labels`, or running
  before `wallRender`) either wipes all wall chips or duplicates symbol chips every frame.

Symbol chips carry a distinct CSS class/`data-*` selector from wall chips (see `dimEntry.js`
reuse note) so `symbolDimEntry` can locate/reposition only its own chip within the shared layer.

## Interfaces / Types

### `symbols.js` (new — pure model + geometry)

```js
/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"} SymbolType */
/** @typedef {{ id:string, type:SymbolType, x:number, y:number, w:number, h:number, rot:number }} Sym */
// x,y   = symbol CENTER in world metres
// w,h   = width (across) and depth, world metres (to scale)
// rot   = rotation in degrees, clockwise, about the center

/** Serializable model — MVP-6 can JSON.stringify(model) directly (mirrors walls.model). */
export const model = { symbols: /** @type {Sym[]} */ ([]) };

/**
 * Per-type catalog. `openings:true` → single editable dimension (width); depth is a fixed
 * thin marker and its chip is hidden. Furniture edits both w and h.
 * @type {Record<SymbolType, {label:string, category:"openings"|"furniture", openings?:boolean,
 *   w:number, h:number, min:number, max:number}>}
 */
export const CATALOG = {
  door:   { label:"Door",   category:"openings",  openings:true, w:0.90, h:0.12, min:0.60, max:2.00 },
  window: { label:"Window", category:"openings",  openings:true, w:1.00, h:0.12, min:0.30, max:3.00 },
  bed:    { label:"Bed",    category:"furniture", w:1.50, h:2.00, min:0.30, max:2.50 },
  sofa:   { label:"Sofa",   category:"furniture", w:2.00, h:0.90, min:0.30, max:3.50 },
  table:  { label:"Table",  category:"furniture", w:1.20, h:0.80, min:0.30, max:3.00 },
  chair:  { label:"Chair",  category:"furniture", w:0.50, h:0.50, min:0.30, max:1.00 },
  desk:   { label:"Desk",   category:"furniture", w:1.40, h:0.70, min:0.30, max:2.50 },
  fridge: { label:"Fridge", category:"furniture", w:0.70, h:0.70, min:0.30, max:1.20 },
};

/** Create a symbol from catalog defaults at world center (x,y). Assigns id `s<n>`. */
export function createSymbol(type, x, y): Sym

/** Add a fully-formed Sym to the model (returns it). */
export function addSymbol(sym): Sym

/** Remove by id. No-op if absent. Returns boolean. */
export function removeSymbol(id): boolean

/** Duplicate by id, offset by +0.3m x/y, new id, auto-select handled by caller. Returns new Sym|null. */
export function duplicateSymbol(id): Sym | null

/** Find by id. */
export function getSymbol(id): Sym | null

/**
 * Point-in-symbol hit test in WORLD metres, honoring rotation. Transforms the world point
 * into the symbol's local (un-rotated) frame and tests the w×h box inflated by `tolWorld`
 * metres on every side. `tolWorld` defaults to 0 (exact box). Callers that want a
 * screen-space minimum hit target pass a world tolerance = (minPx/2)/pxPerM() (see
 * onSelectDown below and Edge Case 14). Returns boolean.
 */
export function hitTest(sym, wx, wy, tolWorld = 0): boolean

/**
 * Topmost symbol at world point (last in array wins = drawn last = on top), or null.
 * `tolWorld` (metres) is forwarded to hitTest so a caller can enforce a minimum on-screen
 * hit target regardless of zoom. Defaults to 0.
 */
export function pickSymbol(wx, wy, tolWorld = 0): Sym | null

/** Clamp a dimension value to the type's [min,max]. */
export function clampDim(type, metres): number

/**
 * Set width/depth (metres), clamped to type range. `lockAspect` scales the other dim to
 * preserve the w:h ratio. Mutates sym. Openings ignore `dim:"h"`. Returns boolean (changed).
 */
export function resizeSymbol(sym, dim /* "w"|"h" */, metres, lockAspect): boolean

/** Move center to world (x,y). Mutates. */
export function moveSymbol(sym, x, y): void

/** Set rotation degrees (normalized to [0,360)). Mutates. */
export function rotateSymbol(sym, deg): void

/** Four world-space corners of the rotated box, order TL,TR,BR,BL (local frame). Used by render + chip placement. */
export function corners(sym): {x:number,y:number}[]
```

### `symbolTool.js` (new — palette, placement, selection controller, inspector)

```js
export function init(refs): void
// refs: { stage, dock, dockItems:NodeList, inspector, dimLabels }

// Select-mode pointer hooks injected into interactions.js (see below).
// onSelectDown converts (sx,sy)→world via screenToWorld, then computes a world tolerance
// so the effective hit target is never smaller than MIN_HIT_PX on screen:
//     const tolWorld = (MIN_HIT_PX / 2) / pxPerM();   // MIN_HIT_PX = 12
// It tests handles first (rotate knob, then chips — themselves screen-sized DOM), then calls
// pickSymbol(wx, wy, tolWorld). This is the ONLY place the screen→world minimum is applied;
// pure symbols.js stays zoom-agnostic (Edge Case 14).
export function onSelectDown(sx, sy): boolean   // true if a symbol/handle was hit (consume; suppress pan)
export function onSelectMove(sx, sy): void      // drag move/rotate of the active symbol
export function onSelectUp(sx, sy): void        // finalize drag
export function onTapEmpty(): void              // click on empty canvas → clear selection

export function getSelectedId(): string | null  // for symbolRender highlight
export function getPlacementGhost(): { type, x, y, w, h, rot } | null  // for symbolRender ghost
```

### `symbolRender.js` (new — SVG + chips, no events)

```js
export function init(gSymbols, gOverlay, dimLabels, getSelectedId, getPlacementGhost, getEditingDim): void
export function render(): void   // registered as a surface.onRender hook
```

### `symbolDimEntry.js` (new — inline w/h editing; mirrors dimEntry.js)

```js
export function init(refs): void            // { stage, dimLabels }
export function beginEdit(symbolId, dim /* "w"|"h" */): void
export function commit(): void
export function cancel(): void
export function isEditing(): boolean
export function getEditingDim(): { symbolId:string, dim:"w"|"h" } | null
export function reposition(): void          // surface.onRender hook — keeps input on the edge
```

### `interactions.js` (extend — new select-hooks slot, mirroring `setDrawHooks`)

```js
/** @type {{ onDown, onMove, onUp, onTapEmpty }|null} */
export function setSelectHooks(h): void
```
In select mode (`!isDrawMode()`, no Space): a single-pointer `pointerdown` calls
`selectHooks.onDown(sx,sy)`. If it returns `true`, subsequent moves route to
`selectHooks.onMove` and the release to `selectHooks.onUp` (pan is suppressed). If it
returns `false`, pan proceeds as today; a release under `DRAG_THRESHOLD` calls
`selectHooks.onTapEmpty()`.

## Frontend Design

Implements the posted **CEO "Frontend decision: Direction A"** — bottom-center dock +
floating inspector, with click-to-edit dimension chips on the selection edges.

**Bottom-center dock (`.symbol-dock`).** Fixed, horizontally centered, above the safe-area
inset — thumb-reachable on phones and keeps the canvas maximally open. Two labeled groups
separated by a hairline divider: **Openings** (Door, Window) and **Furniture** (Bed, Sofa,
Table, Chair, Desk, Fridge). Each item is a `<button>` with a small inline SVG glyph + tiny
mono label. Warm-blueprint language throughout: panel background `var(--panel)`, hairline
`var(--hairline)`, gold `#c9a84c` for active/hover, `DM Mono` labels. Horizontally
scrollable if it overflows a narrow viewport.

**Always live in select mode — no 'S' mode.** The dock is present and interactive whenever
the app is in select mode (the default non-draw tool). Dragging an item is the placement
gesture; there is no mode to enter. (An optional rail affordance that scrolls to / pulses
the dock is acceptable but must not gate placement behind a mode.)

**Placement gesture.** `pointerdown` on a dock item → `setPointerCapture` on the dock/document
→ a translucent gold **ghost** of the symbol (to-scale, grid-snapped center, teal `#7fd0c8`
snap dot) tracks the pointer over the canvas → `pointerup` over the canvas drops the symbol,
which **auto-selects** and opens its dim chips + inspector. Releasing off-canvas (e.g. back
on the dock) cancels with no placement. Works with mouse, pen, and touch (Pointer Events,
not HTML5 DnD, which is unreliable on mobile).

**Selection affordances.** A selected symbol shows a gold bounding box, a **rotate handle**
(small gold knob offset above the top edge), and **dimension chips** on two edges: a **width
chip** centered on the top edge, a **depth chip** centered on the left edge. Chips reuse the
MVP-3 look and the chip→inline-input flow. Openings show only the width chip. Tapping empty
canvas clears the selection.

**Floating inspector (`.symbol-inspector`).** A compact panel that appears near the selected
symbol (clamped to viewport, offset so it doesn't cover the symbol) hosting icon buttons:
**rotate 90°**, **duplicate**, **delete**, and a **lock-aspect** toggle. It does **not**
contain numeric width/depth fields — those live on the canvas chips. On mobile it docks just
above the symbol dock to stay thumb-reachable.

**Colors / type.** Selection + handles + active dock item: gold `#c9a84c`. Snap indicator:
teal `#7fd0c8`. Symbol bodies: thin gold stroke + very light gold fill, consistent with wall
rendering (`--wall-line` / `--room-fill`). Fonts: `DM Sans` (UI), `DM Mono` (chips/labels),
`Libre Baskerville` (display, unchanged). Static, no build step.

**Touch/mobile.** Dock is bottom-center and thumb-reachable by design; dim chips and inline
inputs use the larger mobile sizing already defined for `.dim-chip`/`.dim-input`. Drag
placement, move, rotate, and dimension edit all work by touch.

## State Model

**Persisted-shape (in memory only in v1):** `symbols.model.symbols[]` — an array of plain
`Sym` objects `{ id, type, x, y, w, h, rot }`. Fully JSON-serializable and independent of
view/units, exactly mirroring `walls.model.rooms`. #MVP-6 serializes `{ walls: ..., symbols:
model.symbols }` with no extra work here. Nothing is written to `localStorage` or the URL in
this phase.

**Transient / in-memory-only (never serialized):**
- `symbolTool`: `_selectedId` (string|null), placement ghost `{type,x,y,w,h,rot}|null`,
  active-drag state (`move`|`rotate`|null + pointer offsets), `_lockAspect` bool per session.
- `symbolDimEntry`: `_editing { symbolId, dim }|null` + the single floating `<input>`.
- View (`zoom/pan`) and display `unit` remain owned by `view.js` / `units.js`; symbols read
  them for projection/formatting only.

**Coordinate contract:** all `Sym` fields are world metres/degrees. Screen positions are
derived every frame via `worldToScreen`/`pxPerM`; nothing screen-space is stored on the
model. Grid snap and rotation snap operate in world space before mutation.

**Ownership / single source of truth:** only `symbols.js` mutates `model.symbols`.
`symbolTool` orchestrates and calls those mutators; `symbolRender`/`symbolDimEntry` read.
Every mutation ends with `scheduleRender()`.

## Edge Cases

1. **Drop off-canvas / released on the dock** → cancel placement; no symbol added.
2. **Placement while zoomed far out/in** → ghost + final symbol size come straight from
   `pxPerM()`, so scale is always correct; grid step follows `chooseGridStep()`.
3. **Alt held during placement/move** → free (un-snapped) center, mirroring the wall tool's
   free mode; release Alt returns to grid snap.
4. **Dimension entry below type min / above max** → `clampDim` clamps silently to the range;
   the chip re-reads the clamped value. Non-parseable input (`parseLen` → null) flags
   `aria-invalid` and stays open (identical to wall dim entry).
5. **Lock-aspect on** → editing `w` scales `h` by the same ratio (and vice-versa), each
   result independently clamped to `[min,max]`; if a clamp would break the ratio, the edited
   dim wins and the other is clamped.
6. **Openings (door/window)** → only the width chip renders and is editable; depth is a fixed
   thin marker; `resizeSymbol(sym,"h",…)` is a no-op for openings.
7. **Unit toggle mid-edit** → cancel the open symbol dim input (mirror dimEntry Edge Case 6);
   committed chips reformat; geometry unchanged.
8. **Tap a dim chip while a symbol is selected** → pointer isolation (`stopPropagation` on
   chip/input) prevents the stage select/pan handler from firing or from deselecting.
9. **Delete the selected symbol** (inspector delete or `Delete`/`Backspace` key when a symbol
   is selected and focus is not in an input) → remove from model, clear selection, close any
   open chip editor, hide inspector.
10. **Rotate** → free rotate via handle snaps to 15° increments (Alt = free); the 90° button
    adds exactly 90° (normalized to `[0,360)`). Dim chips and inspector re-anchor to the
    rotated box each frame via `reposition`.
11. **Selected symbol removed while its chip input is open** → `symbolDimEntry.commit`/
    `reposition` guard on `getSymbol(id)`; if gone, close silently.
12. **Switching to wall (draw) mode with a symbol selected** → clear symbol selection and
    close the inspector/chip editor so wall drawing is unobstructed. The dock remains visible
    but is greyed/disabled in draw mode (placement is a select-mode gesture); starting a
    placement drag from a dock item first switches back to select mode.
13. **Two symbols overlapping** → `pickSymbol` returns the topmost (last-drawn) symbol so the
    visually-front piece is selected.
14. **Very small symbol at low zoom** (e.g. a 0.5 m chair at min zoom, whose true box is only
    a few px) → stays selectable because `onSelectDown` inflates the world hit point by
    `tolWorld = (MIN_HIT_PX/2)/pxPerM()` (MIN_HIT_PX = 12) before calling
    `pickSymbol(wx,wy,tolWorld)`, giving a ≥12 px on-screen hit target at any zoom. The
    minimum is a *hit-test* concern applied in the tool layer (which has `pxPerM`), NOT in the
    pure `symbols.js` model and NOT a render-only stroke floor — this is distinct from the
    wall `Math.max(6, WALL_M*ppm)` case, which is purely `wallRender` stroke width (walls are
    not selectable, so that floor never touches hit-testing). `symbolRender` independently
    draws the selection box/handles at their normal screen sizes so the visible affordance and
    the hit target agree.
15. **Window/pan/zoom during an open edit or active drag** → chips, inspector, ghost, and the
    inline input reposition every frame from world coords (no drift).

## Dependencies

Must exist before implementation (all present on this branch):
- **`view.js`** — `worldToScreen`, `screenToWorld`, `pxPerM`, `BASE_PX_PER_M` (the single
  scale contract). No changes.
- **`walls.js`** — `gridSnap` (reused for center snap); `walls.model` unchanged; used to
  serialize alongside `symbols.model` in #MVP-6 (not here).
- **`grid.js`** — `chooseGridStep`.
- **`units.js`** — `fmtLen`, `unitLabel`, `parseLen`, `onChange` (cancel-on-toggle).
- **`surface.js`** — `onRender` (register `symbolRender.render`, `symbolDimEntry.reposition`),
  `scheduleRender`.
- **`interactions.js`** — extend with `setSelectHooks` (new slot) and select-mode arbitration.
- **`dimEntry.js`** — pattern reused (chip → inline input, pointer isolation, unit-cancel).
  No behavioral change required; symbol chips use a distinct class/selector so the two
  controllers do not collide in the shared `.dim-labels` layer.
- **`index.html`** — add `#symbols` + `#symbol-overlay` SVG groups (after `#world`), the
  `.symbol-dock`, the `.symbol-inspector`, and CSS for dock/inspector/ghost (reusing the
  existing chip/input CSS by grouping selectors).
- **`main.js`** — instantiate the new modules, wire `setSelectHooks`, register the new render
  hooks, grab the new DOM refs.

## Test Requirements

Extend `src/tests.html` (in-page `describe`/`it`/`expect`, `toBe`/`toBeCloseTo`). Reset
`symbols.model`, `walls.model`, and `units.unit` between suites; set `view` before any
projection-dependent assert (existing pattern).

**Unit — model & catalog (`createSymbol`, `addSymbol`, `removeSymbol`, `duplicateSymbol`,
`getSymbol`):**
- `createSymbol("bed", …)` returns a `Sym` with catalog default `w=1.5,h=2.0,rot=0` and a
  unique `s<n>` id; `addSymbol` appends it.
- `removeSymbol` removes by id and is a no-op / returns false for an unknown id.
- `duplicateSymbol` returns a new id, offset center, same type/dims/rot; original unchanged.
- Model objects are plain and JSON-round-trippable (`JSON.parse(JSON.stringify(model))`
  deep-equals model) — guarantees #MVP-6 serialization.

**Unit — geometry (`hitTest`, `pickSymbol`, `corners`, `clampDim`, `resizeSymbol`,
`moveSymbol`, `rotateSymbol`):**
- `hitTest` true for the center and inside the box; false just outside; correct under
  `rot=90` (a point inside the rotated footprint but outside the axis-aligned box hits).
- `pickSymbol` returns the topmost (last-added) of two overlapping symbols; null on empty
  space.
- `clampDim` clamps below `min` → `min`, above `max` → `max`, in-range unchanged.
- `resizeSymbol(sym,"w",v)` sets width to `clampDim`; with `lockAspect` the ratio `w:h` is
  preserved (both clamped); openings ignore `"h"`.
- `moveSymbol` sets center exactly; `rotateSymbol` normalizes to `[0,360)` (e.g. `450→90`,
  `-90→270`).
- `corners` returns 4 points; for `rot=0` they equal the axis-aligned box; for `rot=90` the
  box is rotated about the center (width/height swap in screen extent).

**Unit — units reuse:** width/depth chips format via `fmtLen`+`unitLabel`; entry parses via
`parseLen`; a metres value round-trips through `fmtLen`→`parseLen` within display precision;
toggling unit leaves `symbols.model` bit-identical (display-only).

**Integration / behavioral (in-browser):**
- Dragging a dock item onto the canvas drops a symbol at the grid-snapped pointer center; it
  renders to scale (a 2 m sofa spans `2*pxPerM()` px at the current zoom — assert width in
  px `toBeCloseTo`) and auto-selects.
- Releasing off-canvas (over the dock) adds no symbol.
- A dropped symbol shows width/depth chips (openings: width only) + inspector; clicking the
  width chip opens an inline input prefilled in the current unit; typing a value + Enter
  resizes the symbol (chip re-reads); values beyond min/max clamp; Esc cancels.
- **Pointer isolation:** with a symbol selected, tapping its dim chip opens the editor and
  neither pans nor deselects (assert selection id unchanged, no symbol added); tapping empty
  canvas clears selection.
- Moving a selected symbol by drag updates only its center (grid-snapped); Alt makes it free.
- Rotate 90° button rotates exactly 90°; free rotate snaps to 15°; chips/inspector re-anchor
  to the rotated footprint.
- Duplicate creates a second selectable symbol offset from the original; delete (button and
  `Delete` key) removes the selected symbol and hides its editor.
- Unit toggle reformats all symbol chips with no geometry change; toggling mid-edit cancels
  the open input.
- Symbols paint above walls; one render per animation frame under continuous drag/pan (RAF
  coalescing intact); no console errors.
- **Wall/symbol coexistence:** wall dim chips and symbol dim chips share `.dim-labels` without
  cross-triggering (clicking a wall chip does not open a symbol editor and vice-versa).

**Accessibility:**
- Dock items are `<button>`s with `aria-label` (e.g. "Add sofa"); inspector buttons have
  `aria-label`s; the lock-aspect toggle exposes `aria-pressed`.
- Symbol dim chips are `<button>`s with an `aria-label` including the current dimension; the
  inline input has an `aria-label` and sets `aria-invalid` on bad input.
- `prefers-reduced-motion` disables ghost/selection transitions.

**Security:**
- No new network calls; nothing leaves the client.
- Dock labels, chip text, and input prefill are built via DOM APIs / `textContent` with
  numeric values through `fmtLen` — no `innerHTML` from user- or event-derived strings.
- The one free-text surface (the dimension input) is consumed only by `parseLen` → `Number` →
  `clampDim`; the raw string never reaches the DOM as markup or the geometry model.
</content>
</invoke>
