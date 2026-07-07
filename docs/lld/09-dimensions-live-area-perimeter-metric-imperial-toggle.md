# LLD 9: MVP-3 — Dimensions, Live Area/Perimeter, Metric/Imperial Toggle

Phase 3 of 6 of the MVP epic (#1). Builds directly on wall drawing (LLD 4 / #6). This is
the "read off your area" payoff: persistent dimension labels on committed walls, exact
numeric length entry, a live area + perimeter readout for closed rooms, and a
metric/imperial toggle applied consistently to every readout and to entry. Client-side
only; nothing is persisted (that is #MVP-6) and nothing is sent to a server.

## Scope

**Covers:**
- **Auto dimension labels** — a persistent length chip on the centerline of every committed
  wall edge (both closed rooms and open polylines), formatted through the unit toggle.
- **Numeric dimension entry** — click a dimension chip to turn it into an inline input,
  type an exact length (e.g. `3.2m` / `10.5`), press Enter to rescale that edge to the exact
  measurement. Esc cancels.
- **Live area + perimeter** for closed rooms via a docked, collapsible **Measure inspector**
  (Total Floor Area + per-room area/perimeter rows + hover-to-highlight), updating live as
  geometry changes.
- **Metric/imperial toggle** applied consistently to every readout (chips, inspector, HUD)
  *and* to numeric entry parsing. Toggle is display-only — it never mutates stored geometry.

**Does NOT cover (explicitly out):**
- **Clearance / "does my couch fit" checking** — roadmap Phase 1 / #2, separate phase.
- **Doors/windows/furniture symbols** — #MVP-4 / #8.
- **Selection, move, delete, drag-to-resize a wall** — #MVP-5 / #9. This phase edits an edge
  length *only* through the numeric chip, not by dragging vertices.
- **Persistence / share / export** — #MVP-6. Geometry stays in memory; the model is unchanged
  plain-serializable objects.
- **Curved/angled dimension strings, witness lines, angle dimensions** — out of v1 (per the
  frontend decision below, on-canvas pill chips only, no drafting-tool chrome).

## Approach

**Reuse the MVP-2 geometry core and model verbatim.** No new geometry model. Dimensions,
area, and perimeter are all derived from the existing `Room { id, closed, verts }` model in
`walls.js`. `verts` are world metres; a closed room's ring is `verts[0..n-1]` with an
implicit closing edge back to `verts[0]`.

**Metric-as-storage (hard constraint).** World geometry is always stored in metres. The
`units.js` module (shipped) is the single display formatter and is *extended, not forked*:
new `parseLen`, `fmtArea`, `areaUnitLabel` join the existing `fmtLen`/`unitLabel`. Numeric
entry parses a display string → metres before it touches geometry; the unit toggle only
changes formatting and fires `onChange` → `scheduleRender`. Toggling units performs **zero
coordinate mutation**.

**Geometry core = shoelace + perimeter + exact-length edge rescale**, added as pure
functions to `walls.js` (the testable, DOM-free core):
- `polygonArea(verts)` — shoelace, absolute value, m².
- `perimeter(verts, closed)` — sum of edge lengths (+ closing edge when `closed`).
- `rescaleEdge(room, edgeIndex, targetLenM)` — move the edge's *second* endpoint along the
  current edge direction so the edge length equals `targetLenM`, keeping the first endpoint
  fixed. Adjacent edges follow their shared moved vertex (a polygon is a chain; this is the
  expected "type a dimension" behavior). Returns `false` (no-op) on a degenerate/zero-length
  edge or a target `< MIN_SEG_M`.

**On-canvas chips for labels + inline edit; docked inspector for totals** (frontend decision,
see Frontend Design). The chip is the label *and* the edit affordance; the inspector is the
home of the running total. They share the identical geometry core, so the split costs
nothing.

**Ride the existing render loop.** Every geometry mutation already calls
`scheduleRender()` (RAF-coalesced). New consumers (dimension chips in `wallRender`, the
Measure inspector, and repositioning an open inline input) update inside the same render
pass. `surface.js` gains a tiny generic `onRender(cb)` registration so `measure` and
`dimEntry` can hook the post-render step without `wallRender` having to know about them.
View/unit `onChange` already trigger `scheduleRender` via `main.js`, so pan/zoom/unit-toggle
refresh chips + inspector for free.

**Recompute-on-render is acceptable for v1.** Area/perimeter are O(vertices) and rooms are
few; recomputing each frame is cheap and avoids a dirty-flag/cache to get wrong. (Flag for
reviewer: if profiling ever shows this hot, add a per-room memo keyed on `verts` identity.)

## Interfaces / Types

New ES modules under `src/js/`, loaded by the existing `<script type="module">`. No bundler.

### Types (JSDoc)

```js
/** @typedef {{ area:number, perimeter:number }} RoomMetrics */   // metres² and metres; area 0 for open
/** @typedef {{ roomId:string, edgeIndex:number }} EdgeRef */
```

Reuses `Vertex` and `Room` from `walls.js` unchanged.

### `walls.js` — new pure geometry (append; existing exports unchanged)

```js
// Length of a single edge, metres.
export function edgeLength(a: Vertex, b: Vertex): number;

// Shoelace absolute area of the ring verts[0..n-1] (implicit close), metres².
// < 3 verts → 0.
export function polygonArea(verts: Vertex[]): number;

// Sum of edge lengths; when closed, adds the verts[n-1]→verts[0] edge. metres.
export function perimeter(verts: Vertex[], closed: boolean): number;

// Convenience: { area, perimeter } for a room. area = 0 when !closed.
export function roomMetrics(room: Room): RoomMetrics;

// Rescale room edge `edgeIndex` (edge from verts[i] to verts[(i+1)%n] for closed,
// verts[i]→verts[i+1] for open) to exactly `targetLenM`, keeping verts[i] fixed and
// moving the far endpoint along the current edge direction. Mutates room.verts in place.
// No-op → false when: targetLenM < MIN_SEG_M, edge length ~0 (no direction), or edgeIndex
// out of range. Success → true.
export function rescaleEdge(room: Room, edgeIndex: number, targetLenM: number): boolean;
```

### `units.js` — extend (do NOT fork; existing exports unchanged)

```js
export const M2_PER_FT2 = M_PER_FT * M_PER_FT;

// Parse a display string → metres, or null if invalid.
// Accepts an optional unit suffix that overrides the current display unit:
//   "3.2m" → 3.2 ;  "10ft" / "10'" → 3.048 ;  "10.5" → interpreted in current `unit`.
// Rejects: NaN, ≤ 0, non-finite, empty. Decimal point only (no locale comma in v1).
export function parseLen(str: string): number | null;

// Format an area in metres² for display.
//   ft²: m2 / M2_PER_FT2, 1 decimal ;  m²: m2, 2 decimals.
export function fmtArea(m2: number): string;

// Area unit label: "ft²" | "m²".
export function areaUnitLabel(): string;
```

### `wallRender.js` — extend

```js
// init signature gains the interactive dim-label layer + two injected getters
// (kept as injection to preserve this module's "no imports of controllers" style).
export function init(
  gWorld, gDraft, gSnap, labelsEl,
  dimLabelsEl: HTMLElement,          // interactive committed-dimension chip layer
  getSnap: () => Snap | null,
  getHighlight: () => string | null, // measure.getHighlightRoomId
  getEditingEdge: () => EdgeRef|null // dimEntry.getEditingEdge — skip that chip while editing
): void;
```

Rendering additions:
- New pass after committed rooms: for each committed room, one **interactive dimension chip**
  per edge, positioned at the screen-space edge midpoint, in `dimLabelsEl`. Each chip is a
  `<button class="dim-chip">` with `data-room-id` and `data-edge` attributes; text is
  `fmtLen(edgeLenM) + " " + unitLabel()`. The chip for the edge in `getEditingEdge()` is
  skipped (the floating input covers it).
- Highlighted room (`getHighlight()`): its fill/centerline render with an emphasized token
  (`--room-fill-hi` / brighter stroke).

`wallRender` still fires no events. Click/hover wiring lives in `dimEntry`/`measure`.

### `dimEntry.js` — inline numeric-entry controller (new)

```js
export function init(refs: { stage:Element, dimLabels:Element }): void;
export function isEditing(): boolean;
export function getEditingEdge(): EdgeRef | null;
export function beginEdit(roomId: string, edgeIndex: number): void; // open input over the edge
export function commit(): void;   // parseLen → rescaleEdge → close → scheduleRender
export function cancel(): void;   // discard, close input
export function reposition(): void; // registered via surface.onRender: keep input on edge midpoint
```

Owns a single floating `<input class="dim-input" inputmode="decimal">` appended to `.stage`
(so a redraw does not destroy it). Uses **event delegation** on `dimLabels`: a click on a
`.dim-chip` reads `data-room-id`/`data-edge` and calls `beginEdit`. On `beginEdit` the input
is prefilled with the current length via `fmtLen` (no unit suffix), selected, focused. Enter
→ `commit`; Esc/blur → `cancel`.

**Pointer isolation from the draw handler (required — see Edge Case 12).** The default (and
only usable) tool this phase is wall/draw mode, so a closed room's chips are visible *while
`isDrawMode()` is true*. `interactions.js` binds `pointerdown`/`pointerup` on `.stage`
(interactions.js:79-82); because `.dim-labels` and the `.dim-input` are descendants of
`.stage`, pointer events on a chip/input **bubble up to `.stage`** and would arm
`_drawPending` on pointerdown → call `_drawHooks.onClick()` on pointerup, dropping a stray
wall vertex, *even though* `pointer-events:auto` correctly makes the chip the event target.
`click` delegation cannot undo this — the pointerup already fired.

`dimEntry.init` therefore binds capture-agnostic **bubble listeners for `pointerdown`,
`pointerup`, and `pointercancel` on the `dimLabels` element and on the lazily-created
`.dim-input`**, each calling `e.stopPropagation()` when `e.target.closest('.dim-chip,
.dim-input')` matches. Because both are strict descendants of `.stage`, stopping propagation
at the descendant guarantees the event never reaches `.stage`'s own listeners (order-
independent — no reliance on listener registration order or `stopImmediatePropagation`), so
`_drawPending` is never armed and no vertex is placed. The existing `click` delegation on
`dimLabels` then runs `beginEdit` normally.

*Alternative considered:* have `interactions._onPointerDown` bail when
`e.target.closest('.dim-chip, .dim-input')`. Rejected as primary because it couples the
generic pointer layer to `dimEntry`'s DOM classes; the descendant-`stopPropagation` approach
keeps `interactions.js` unaware of dimensions. (Flag for reviewer if the coupling is
preferred instead.)

**Cancel-on-unit-change wiring.** `dimEntry.init` registers its own
`units.onChange(() => { if (isEditing()) cancel(); })` so an open edit is discarded when the
unit toggles (Edge Case 6). This is separate from `main.js`'s existing
`onUnitChange(scheduleRender)`, which only reformats committed chips/inspector and does not
cancel edits.

### `measure.js` — Measure inspector (new)

```js
export function init(refs: { panel:Element, list:Element, total:Element, toggle:Element }): void;
export function update(): void;                 // registered via surface.onRender
export function getHighlightRoomId(): string | null;
```

`update()` recomputes from `model.rooms`: Total Floor Area = Σ `roomMetrics(r).area` over
closed rooms; one row per closed room (`id`, area via `fmtArea`, perimeter via `fmtLen`).
Total uses `fmtArea`/`areaUnitLabel`. Event delegation on `list`: row `mouseenter`/`focus`
sets `_highlightRoomId` + `scheduleRender`; `mouseleave`/`blur` clears it. The toggle button
collapses/expands the panel (`.measure--collapsed`).

### `surface.js` — extend

```js
export function onRender(cb: () => void): void; // push a post-render hook, run at end of _doRender
```

`_doRender` runs `drawGrid` → `_wallRender()` → registered `onRender` hooks → `hudUpdate()`.
`measure.update` and `dimEntry.reposition` register here.

### `main.js` — wiring only

Grab new DOM refs (`.dim-labels`, `.measure` panel/list/total/toggle); `initWallRender` with
the extended signature (`measure.getHighlightRoomId`, `dimEntry.getEditingEdge`);
`measure.init`, `dimEntry.init` (which internally does its own pointer-isolation binding and
`units.onChange(cancel)` registration — see `dimEntry.js`); register `measure.update` and
`dimEntry.reposition` via `surface.onRender`. `onUnitChange(scheduleRender)` (verified
main.js:83) stays as-is and covers unit-driven *reformat*; the *cancel-open-edit-on-toggle*
behavior is owned by `dimEntry`'s own `units.onChange` registration, not added here.

## State Model

All state is **in-memory only** this phase (persistence is #MVP-6).

- **Geometry** (`walls.model`): unchanged `{ rooms: Room[], chain: Vertex[] }`, metres.
  `rescaleEdge` mutates `room.verts` in place; the room `id` and `closed` flag are untouched.
- **Display unit** (`units.unit`): `"ft" | "m"`, default `"ft"`, not persisted (MVP-2 behavior).
  Display-only; never affects `walls.model`.
- **Edit state** (`dimEntry`): `EdgeRef | null` + the input value. Ephemeral. An open edit is
  cancelled on unit toggle (see edge cases) so parsing is never ambiguous about which unit
  the typed number is in.
- **Highlight** (`measure`): `_highlightRoomId: string | null`, derived from hover/focus,
  read by `wallRender`. Ephemeral.
- **Dimension chips, inspector rows, totals** are all **derived** each render from
  `model.rooms` + the current unit. Nothing new is persisted; the model stays plain
  JSON-serializable for #MVP-6.

**DOM additions** (`index.html`):
```
<div class="labels"></div>       <!-- existing: drawing-time chips, pointer-events:none -->
<div class="dim-labels"></div>   <!-- NEW: committed dimension chips; chips pointer-events:auto; pointerdown/up stopPropagation'd in dimEntry so draw handler on .stage never fires -->
<aside class="measure"> …total, list of rows, collapse toggle… </aside>  <!-- NEW inspector -->
```
The `.dim-input` element is created lazily by `dimEntry` and attached to `.stage`.

## Edge Cases

1. **Invalid entry.** `parseLen` returns null (non-numeric, empty, ≤ 0, non-finite) →
   `commit` does **not** rescale; the input flags an error (red border, `aria-invalid`) and
   stays open. Esc cancels.
2. **Too-small target.** Target `< MIN_SEG_M` → `rescaleEdge` returns false → treated as
   invalid (no zero-length walls, consistent with MVP-2 edge 4).
3. **No-op commit / rounding drift.** If the parsed target equals the current edge length
   within an epsilon (e.g. `< MIN_SEG_M`), skip the rescale entirely. Prevents display
   rounding (ft chips show 1 decimal ≈ 3 cm) from silently nudging exact stored metres when
   the user presses Enter without changing the value. **This is what makes the unit toggle
   lossless in practice.**
4. **Degenerate edge (no direction).** Edge length ~0 → no unit vector → `rescaleEdge` returns
   false safely (should not occur given the MVP-2 draw-time guard, but defended).
5. **Closing-edge rescale (closed room).** Editing edge `n-1` (verts[n-1] → verts[0]) keeps
   verts[n-1] fixed and moves verts[0]; because verts[0] is also edge 0's start, edge 0
   changes too. This ripple is inherent to editing one length of a closed chain and is
   documented. *Alternative considered:* proportional two-sided scaling that preserves both
   neighbors — rejected as surprising and harder to reason about for a 2-minute sketch tool.
   (Flag for reviewer.)
6. **Unit toggle while editing.** The open edit is cancelled on unit change (the typed,
   uncommitted number would otherwise be ambiguous about its unit). Committed geometry and
   all chips/inspector values simply reformat. **Wiring:** `dimEntry.init` registers its own
   `units.onChange(() => { if (isEditing()) cancel(); })`; `main.js`'s existing
   `onUnitChange(scheduleRender)` only reformats and does *not* cancel, so the cancel must be
   registered by `dimEntry` itself (see Interfaces → `dimEntry.js`).
7. **Pan/zoom while editing.** `dimEntry.reposition` (post-render hook) re-anchors the input
   to the edge's current screen midpoint every frame, so it tracks the view. If the edge
   scrolls far off-screen the input follows and may clip — acceptable for v1.
8. **Open polylines.** Get dimension chips (editable) and contribute to per-edge labels, but
   have `area = 0` and are **excluded** from Total Floor Area and from the inspector's room
   rows (which list closed rooms only). Their length is still readable on the chips.
9. **Self-intersecting / non-simple polygon.** `polygonArea` returns the shoelace absolute
   value; a figure-eight under-reports — the user's call, matching MVP-2 edge 11. Not
   validated.
10. **Overlapping rooms.** Total Floor Area is a plain sum of closed-room areas; overlapping
    rooms double-count (no boolean union in v1). Documented limitation.
11. **Empty state.** No closed rooms → inspector shows Total `0` (formatted) and an empty/hint
    row; no chips render. No errors.
12. **Chip vs canvas interaction (draw mode).** Chip editing is intended to work in
    wall/draw mode — that is the default and only usable tool this phase (index.html:
    `tool-wall aria-pressed="true"`; selection/move is out of scope, #MVP-5), so a closed
    room's chips are normally shown while `isDrawMode()` is true. `pointer-events:auto` alone
    is **insufficient**: it only decides the event *target*, but pointerdown/pointerup on a
    chip still **bubble to `.stage`**, whose `interactions.js` listeners (interactions.js:79-
    82) would arm `_drawPending` and fire `_drawHooks.onClick()` (interactions.js:116-124,
    195-199), dropping a stray wall vertex; `click`-based `beginEdit` delegation cannot undo
    that pointerup. **Fix:** `dimEntry` attaches `pointerdown`/`pointerup`/`pointercancel`
    listeners on `.dim-labels` and on the `.dim-input` that call `e.stopPropagation()` for
    events originating on `.dim-chip`/`.dim-input`. Since both elements are descendants of
    `.stage`, stopping propagation at the descendant guarantees `.stage` never sees the event,
    so no vertex is placed regardless of listener order. See `dimEntry.js` → "Pointer
    isolation from the draw handler." Drawing-time chips in `.labels` remain
    `pointer-events:none`.
13. **Mobile inspector.** The inspector is collapsible and defaults **collapsed** on narrow
    screens to a compact pill showing only Total Floor Area; tap to expand. It never
    permanently occupies the small-screen canvas (frontend constraint).
14. **`prefers-reduced-motion`.** Hover-highlight and collapse transitions become instant (no
    animation); highlight still conveyed by fill/stroke emphasis.
15. **Keyboard scope while editing.** The input is a real `<input>`, so `wallTool`'s keyboard
    handler already bails when `document.activeElement` is an INPUT (existing guard). Enter/Esc
    are handled locally by `dimEntry`; Backspace edits text, not geometry.
16. **Locale decimals.** Only `.` decimal separator is supported in v1 (comma rejected by
    `parseLen`). Documented.

## Dependencies

- **Must exist first:** LLD 4 / #MVP-2 shipped modules — `walls.js` (model + `Room`/`Vertex`,
  `MIN_SEG_M`), `wallRender.js`, `wallTool.js`, `surface.js` (render loop), `interactions.js`,
  and the `.labels` overlay + tool rail in `index.html`. All present.
- **Reused contracts (do not change):** `view.js` `worldToScreen`/`pxPerM`;
  `walls.js` `model`/`Room`/`Vertex`/`MIN_SEG_M`; `units.js` `fmtLen`/`unitLabel`/`unit`/
  `setUnit`/`onChange`/`M_PER_FT`; `surface.js` `scheduleRender`/render loop.
- **Extended (surgical):** `walls.js` (append pure geometry: `edgeLength`, `polygonArea`,
  `perimeter`, `roomMetrics`, `rescaleEdge`); `units.js` (append `parseLen`, `fmtArea`,
  `areaUnitLabel`, `M2_PER_FT2`); `wallRender.js` (interactive dimension-chip pass + highlight
  + skip-editing-edge; extended `init`); `surface.js` (`onRender` hook); `index.html`
  (`.dim-labels` layer, `.measure` inspector markup, CSS tokens `--room-fill-hi`, chip/input/
  inspector styles); `main.js` (wiring).
- **New:** `dimEntry.js`, `measure.js`.
- **Downstream:** #MVP-6 serializes `model` (unchanged); #MVP-4/#MVP-5 build on the same
  chips/vertex model.
- **Platform:** static `src/`, no build step, no npm, no framework, no backend. Only network
  call remains the Google Fonts `<link>`.

## Frontend Design

**Hybrid: Direction A on-canvas dimension chips + Direction B docked Measure inspector**
(CEO-decided to unblock MVP-3). Carries the MVP warm-blueprint palette forward. Rationale
against CLAUDE.md + roadmap:

- **Dimension labels & inline edit → Direction A (on-canvas pill chips).** The product ethos
  is "sketch my studio in two minutes and text the link to a roommate… minimal chrome," not
  surveyor-grade CAD. B's architectural dimension strings (witness lines, 45° ticks, rotated
  numerals) read as drafting-tool chrome and get dense on mobile — wrong altitude for v1. Use
  A's chip-on-centerline + click-to-type inline entry. **Explicitly NOT** B's dimension
  strings.
- **Totals → Direction B's docked Measure inspector.** The "read off your area" payoff and
  the "does my couch fit?" wedge both want a clear, always-visible running total. A's
  centroid-stamped tags collide on small/overlapping rooms (A's own noted weakness) and don't
  scale to multi-room. B's inspector (big Total Floor Area + per-room rows + hover-to-
  highlight) is the total's obvious home and degrades gracefully. **Explicitly NOT** A's
  centroid-stamped totals.

**Dimension chip (`.dim-chip`).** A small monospace pill on each committed edge's screen
midpoint, `--panel` background with `--hairline` border, muted ink text `fmtLen + unitLabel`.
Hover/focus: gold border to signal "editable." Click → becomes the inline input in place.
Screen-constant size (does not scale with zoom). Distinct from the MVP-2 drawing-time chips:
those stay non-interactive in `.labels`; these are interactive in `.dim-labels`.

**Inline input (`.dim-input`).** Replaces the chip on click: a narrow monospace field
(`inputmode="decimal"`) prefilled with the current length in the active unit (number only,
no suffix), text pre-selected. Gold focus ring; red border + `aria-invalid="true"` on invalid
parse. Enter commits, Esc/blur cancels. Anchored to the edge midpoint and repositioned each
render so pan/zoom keeps it on the wall.

**Measure inspector (`.measure`).** Docked panel (desktop: top-right under the unit toggle, or
right edge, clear of the HUD bottom-right and zoom bottom-left). Contents:
- **Total Floor Area** — large `fmtArea + areaUnitLabel`, the hero number.
- **Per-room rows** — one per closed room: label (`Room A`/id), area, perimeter. Hovering or
  focusing a row highlights that room's polygon on canvas (`--room-fill-hi` + brighter
  centerline via `getHighlightRoomId`).
- **Collapse toggle** — collapses to a compact pill showing just Total Floor Area.

**Mobile (canvas is the hero).** The inspector is collapsible and **defaults collapsed** on
narrow widths to the Total-only pill; the canvas stays the primary surface. It is positioned
to clear the tool rail (left), zoom cluster (bottom-left) and HUD (bottom-right). Chips shrink
slightly ≤640px; the inline input stays thumb-usable.

**New palette token:** `--room-fill-hi: rgba(201,168,76,0.15)` (highlight fill). Reuse
existing `--panel`, `--hairline`, `--gold`, `--gold-soft`, `--muted`, `--ink`, `--room-fill`,
`--wall-line`, `--font-mono`.

**Consistency with the toggle.** Every readout — chips, inline-input prefill, inspector area
+ perimeter, and the existing HUD cells — routes through `units.js` (`fmtLen`/`fmtArea`/
`unitLabel`/`areaUnitLabel`), so one `setUnit` call reformats the entire UI with no geometry
change.

## Test Requirements

Extend `src/tests.html` (same in-page harness: `describe`/`it`/`expect`,
`toBe`/`toBeCloseTo`). Import the new pure functions from `walls.js`/`units.js`; reset
`walls.model` and `units.unit` between suites; set `view.zoom`/`panX`/`panY` before any
projection-dependent assert (existing pattern).

**Unit — area & perimeter (`polygonArea`, `perimeter`, `roomMetrics`, `edgeLength`):**
- Axis-aligned 2 m × 3 m rectangle → area `6`, perimeter `10`.
- Unit-square, right triangle (legs 3,4) → area `6`, perimeter `12`.
- Winding independent: clockwise vs counter-clockwise verts give the same absolute area.
- `< 3` verts → area `0`.
- `perimeter(verts, true)` includes the closing edge; `perimeter(verts, false)` does not.
- `roomMetrics` on an open room → `area === 0`, `perimeter` = polyline length.

**Unit — exact-length rescale (`rescaleEdge`):**
- Rescaling an edge to `targetLenM` yields exactly that edge length (`toBeCloseTo`), with the
  first endpoint unchanged and the far endpoint moved along the original direction.
- Direction preserved: the rescaled edge is collinear with the original (unit vector equal).
- Closing edge of a closed room (`edgeIndex === n-1`) moves `verts[0]`; assert the new closing
  length and that `verts[n-1]` is unchanged.
- No-op guards: `targetLenM < MIN_SEG_M` → returns false, geometry unchanged; zero-length edge
  → returns false; out-of-range `edgeIndex` → false.

**Unit — units (`parseLen`, `fmtArea`, `areaUnitLabel`, round-trip):**
- `parseLen` in metric unit: `"3.2"` → `3.2`, `"3.2m"` → `3.2`, `"10ft"`/`"10'"` → `3.048`.
- `parseLen` in imperial unit: `"10"` → `3.048`; suffix override still respected.
- `parseLen` rejects: `""`, `"abc"`, `"0"`, `"-2"`, `"1,5"` → `null`.
- `fmtArea` metric: `6` m² → `"6.00"`; imperial: `6` m² → `(6 / M2_PER_FT2).toFixed(1)`.
- `areaUnitLabel` returns `"m²"`/`"ft²"` per unit.
- **Lossless round-trip:** for a length L metres, `parseLen(fmtLen(L) [+unit])` re-parses to L
  within display precision; and toggling unit then back leaves `walls.model` bit-identical
  (no mutation).

**Integration / behavioral (in-browser):**
- Every committed edge shows a dimension chip; drawing a new room adds chips live.
- Clicking a chip opens the inline input prefilled in the current unit; typing `3.2m` + Enter
  rescales that wall to exactly 3.2 m (chip re-reads 3.2 m / 10.5 ft); Esc cancels with no
  change; invalid input flags error and does not mutate.
- **Draw-mode pointer isolation (regression guard for Edge Case 12):** with the wall tool
  active (`isDrawMode()` true) and a closed room on screen, tapping a `.dim-chip` opens the
  editor and adds **no** new vertex to `walls.model` (assert model vertex count unchanged);
  tapping the empty canvas still places a vertex normally. Same for tapping inside the open
  `.dim-input`.
- **Cancel-on-unit-toggle (Edge Case 6):** with an edit open, toggling the unit closes the
  input (`isEditing()` false) and leaves geometry unchanged; committed chips reformat.
- Area + perimeter in the inspector update live as vertices/edges change; Total Floor Area is
  the sum of closed rooms.
- Unit toggle reformats every chip, the inspector, and HUD with no geometry change and no view
  change (assert a stored vertex is unchanged before/after toggle).
- Hovering/focusing an inspector row highlights the corresponding room polygon; leaving clears
  it.
- Inspector collapses/expands; defaults collapsed on ≤640px, never covers canvas center; the
  input repositions on pan/zoom to stay on the edge.
- One render per animation frame under continuous hover/pan (RAF coalescing intact); no
  console errors.

**Accessibility:**
- `.dim-chip` is a `<button>` with an `aria-label` including the current length; the inline
  input has an `aria-label` and sets `aria-invalid` on bad input.
- Inspector rows are focusable and highlight on focus (keyboard parity with hover).
- `prefers-reduced-motion` disables highlight/collapse transitions.

**Security:**
- No new network calls; nothing leaves the client.
- Chips, inspector text, and input prefill are built via DOM APIs / `textContent` with numeric
  values through `fmtLen`/`fmtArea` — no `innerHTML` from user- or event-derived strings.
- The one user free-text surface (the dimension input) is consumed only by `parseLen` →
  `Number`; the raw string never reaches the DOM as markup or the geometry model.
