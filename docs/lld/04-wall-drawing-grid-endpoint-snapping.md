# LLD 4: MVP-2 — Wall Drawing with Grid + Endpoint Snapping

Phase 2 of 6 of the MVP epic (#1). Builds directly on the shipped drawing surface
(LLD 2 / #5). Adds the first real, editable geometry: straight walls drawn by
clicking/tapping snapped vertices, closing into computable room polygons. Client-side
only; nothing is persisted (that is #MVP-6) and nothing is sent to a server.

## Scope

**Covers:**
- A **Draw-wall tool** (mode): click/tap to place a snapped vertex, rubber-band preview to
  the next point, click the first vertex to close a room.
- **Snapping** of the point-under-cursor, resolved *before commit*, with priority:
  room-close → existing endpoint → free (Alt) → grid. Grid snap uses the currently visible
  fine grid step; endpoint/close use a screen-pixel tolerance.
- **Visible snap feedback**: color-coded *and* glyph-differentiated indicators (never
  color-only), a cursor-side snap-type tag, and a HUD snap readout.
- **Room-close detection**: a chain of ≥3 vertices closing onto its first vertex is marked
  as a closed polygon so #MVP-3 (#7) can compute area/perimeter.
- **Wall styling**: translucent to-scale gold body under a crisp centerline with vertex
  dots; committed rooms get a faint gold fill; a live length chip on the rubber-band and
  on active-chain segments.
- **Direction A "Draft Dock"**: a lean left tool rail (Select / Draw wall / Undo point /
  Finish) with V/W hints, collapsible/compact on mobile.
- New geometry unit tests in `src/tests.html`.

**Does NOT cover (explicitly out, later phases):**
- Curved/angled walls — **out of v1 entirely** (roadmap "Later / maybe").
- Persistent dimension labels on committed geometry, and any area/perimeter readout —
  **#MVP-3 (#7)**. MVP-2 renders length chips only as *drawing-time* feedback (the
  rubber-band segment and the in-progress chain's segments); they are not persisted onto
  committed rooms.
- Doors/windows/furniture symbols — **#MVP-4 (#8)**.
- Selection, move, delete, duplicate, and any undo/redo history stack **beyond per-point
  Backspace** — **#MVP-5 (#9)**. The Select tool exists in the rail but is inert this phase
  (it only changes cursor + lets drag pan).
- Persistence (localStorage), URL-hash share, export — **#MVP-6**. Geometry lives in memory
  and is discarded on reload; the data model is plain serializable objects so #MVP-6 is a
  drop-in.

## Approach

**Build on the MVP-1 engine; do not rewrite the surface.** Reuse `view.js`
(`worldToScreen`/`screenToWorld`/`pxPerM`/`onChange`), `surface.js`
(`scheduleRender`, the RAF-coalesced render loop, `W`/`H`, the `<g id="world">` mount),
`grid.js` (`chooseGridStep`), `units.js` (`fmtLen`/`unitLabel`/`onChange`), `interactions.js`
(pan/zoom/pinch), and `hud.js`. Wall geometry renders into new SVG groups appended after
`#world`, and into an HTML label overlay, added to the render loop.

**World coordinates in metres, exactly as MVP-1.** Every vertex is `{x, y}` in metres.
Rendering always projects through `worldToScreen`, so walls, the rubber band, and the snap
glyph stay locked to world space through pan/zoom automatically — no per-gesture bookkeeping.

**Snap tolerances are screen-pixel, snap grid is world-metre.** Endpoint/close proximity is
measured in *screen px* (`SNAP_PT_PX`, `CLOSE_PX`) so "how close is close enough" feels the
same at every zoom — matching MVP-1's screen-constant stroke/label principle. Grid snapping
rounds the raw world point to the **currently visible fine grid step** (`chooseGridStep()`),
so points snap to the grid the user can actually see.

**Welds return exact coordinates.** Endpoint- and close-snaps return the *stored* world
coordinates of the target vertex (not a re-rounded value), so shared corners are
bit-identical. This is what lets #7 close a polygon ring reliably and lets #5 treat a shared
corner as one point.

**One pointer owner.** `interactions.js` remains the sole pointer/gesture arbiter (avoids
two listener sets fighting). It gains *mode awareness* via an injected hook set from
`main.js`; it never statically imports the wall modules (no cycle). In draw mode it performs
click-vs-drag discrimination: a clean tap places a vertex; a drag beyond a threshold pans
(preserving MVP-1 panning while drawing). Wheel/pinch zoom and Space-drag pan are unchanged
in every mode.

**Snap resolved before commit, on hover *and* press.** On desktop, hover (pointermove with
no button) continuously resolves + previews the snap. Touch has no hover, so the preview
appears while the finger is down and commits on release (if the gesture was a tap, not a
drag) — snap is still visible before commit on mobile.

**Reference implementation.** The gh-pages mockup `wall-drawing-grid-endpoint-snapping.html`
(Direction A, "Draft Dock") is the visual + behavioral reference: it defines the snap
precedence, glyph set, palette tokens, and rail. It uses a *fixed* view (no pan/zoom) for
demo focus; this LLD reconciles it with MVP-1's live zoomable view (snap grid = adaptive
`chooseGridStep()`, tolerances in screen px, click-vs-drag discrimination). Where this doc
and the mockup disagree, this doc wins.

**Frontend decision is LOCKED to Direction A** (see Frontend Design). Rationale (CEO):
#MVP-4 and #MVP-5 both need a persistent home for tools/modes; giving them an obvious home
now (one lean rail) avoids a chrome redesign in two later phases. This is building for
*known imminent* features, consistent with the simplicity principle.

## Interfaces / Types

New ES modules under `src/js/`, loaded by the existing `<script type="module">`. No bundler.

### Data model (in-memory, serializable)

```js
// A vertex is world metres.
/** @typedef {{ x:number, y:number }} Vertex */

// A committed room/wall-chain. `closed` polygons are area-computable (#7).
/** @typedef {{ id:string, closed:boolean, verts:Vertex[] }} Room */

// The point-under-cursor resolution.
/** @typedef {{ x:number, y:number, type:"grid"|"point"|"close"|"free" }} Snap */
```

### `walls.js` — model + pure geometry (the testable core)

```js
export const WALL_M     = 0.12;  // wall body thickness, world metres (to-scale)
export const SNAP_PT_PX = 15;    // endpoint-snap tolerance, screen px
export const CLOSE_PX   = 16;    // room-close tolerance, screen px (>= SNAP_PT_PX)
export const MIN_SEG_M  = 1e-4;  // reject zero-length segments below this

// In-memory model. Plain objects → trivially serializable for #MVP-6.
export const model = { rooms: /** @type {Room[]} */ ([]), chain: /** @type {Vertex[]} */ ([]) };

// Every placed vertex (all committed rooms + the active chain), for endpoint snapping.
export function allVertices(): Vertex[];

// Round a world point to the grid step (metres).
export function gridSnap(wpt: Vertex, step: number): Vertex;

// Nearest vertex to screen (sx,sy) within tolPx, skipping `skip` (the chain's active
// last vertex). Returns the matched Vertex or null. Screen distance via worldToScreen.
export function closestEndpoint(sx, sy, verts: Vertex[], skip: Vertex|null, tolPx: number): Vertex|null;

// Resolve the snapped point + type for a raw screen position. Pure w.r.t. `opts`
// (reads view.js projection only). Precedence: close → point → free → grid.
export function resolveSnap(sx, sy, opts: { chain:Vertex[], rooms:Room[], altHeld:boolean, step:number }): Snap;

// Can the current chain be closed into a polygon? (>= 3 vertices.)
export function canClose(chain: Vertex[]): boolean;

// ── Mutations (thin; operate on `model`) ────────────────────────────
export function placeVertex(snap: Snap): void; // close if type==="close"; else push
                                               // (ignored if it would make a < MIN_SEG_M segment)
export function closeRoom(): boolean;          // chain(>=3) → closed Room; clears chain
export function finishChain(): void;           // chain(>=2) → open Room; else discard; clears chain
export function undoPoint(): void;             // pop last chain vertex
```

`resolveSnap` precedence (mirrors the mockup, reconciled to the live view):

1. **close** — `chain.length >= 3` and screen-distance(cursor, `chain[0]`) ≤ `CLOSE_PX`
   → returns `chain[0]` coords, type `"close"`.
2. **point** — `closestEndpoint(...)` over `allVertices`, skipping `chain[last]`, within
   `SNAP_PT_PX` → returns that vertex's exact coords, type `"point"`.
3. **free** — `altHeld` → raw `screenToWorld` point, type `"free"`.
4. **grid** — `gridSnap(raw, step)`, type `"grid"` (default).

### `wallRender.js` — SVG + label rendering

```js
export function init(gWorld, gDraft, gSnap, labelsEl): void; // bind mount points
export function render(): void; // redraw committed rooms + active chain + rubber band
                                // + snap glyph + drawing-time length chips; idempotent
```

Called from `surface.js`'s render loop (see State Model). Reads `walls.model`, the current
snap (via `wallTool.getSnap()`), and `units.js` for label formatting.

### `wallTool.js` — drawing controller + tool/mode + keyboard + rail

```js
export function init(refs): void;   // rail buttons, hud snap cell, snap-tag el, stage
export function isDrawMode(): boolean;
export function getSnap(): Snap | null;      // current resolved snap, or null when no cursor
export function setTool(t: "select" | "wall"): void;

// Pointer hooks called by interactions.js (injected via main.js):
export function onHover(sx, sy): void;  // resolve+store snap, position snap-tag, scheduleRender
export function onClick(sx, sy): void;  // resolve snap, placeVertex/closeRoom, scheduleRender
export function onLeave(): void;        // clear snap (hide rubber band + glyph)
```

Owns: current tool (`"wall"` default), `altHeld`, the current `Snap`, keyboard handling
(V/W/Esc/Enter/Backspace/Alt), and rail-button wiring. Updates the `#hud-snap` cell and the
cursor-side snap-tag directly (wall-specific chrome; `hud.js` is left untouched for
view/unit cells).

### `interactions.js` — mode-aware additions (surgical)

```js
// New: main.js injects the draw hooks; interactions.js has NO static wall import.
export function setDrawHooks(h: { isDrawMode:()=>boolean, onHover, onClick, onLeave }): void;
```

Behavior change, single-pointer, no Space, when `hooks.isDrawMode()`:
- `pointerdown`: record down position, mark a pending click; **do not** start panning yet.
- `pointermove`: `onHover(sx,sy)`; if moved > `DRAG_THRESHOLD` (≈6px) from down, cancel the
  pending click and pan by deltas from here on (existing pan path).
- `pointerup`: if still a pending click → `onClick(sx,sy)`; else finish pan.
- `pointerleave` / `pointercancel`: `onLeave()` and clear any pending click.
- Plain hover (`pointermove`, `buttons === 0`): `onHover(sx,sy)`.

All other modes/gestures (Select-mode drag = pan; wheel; two-finger pinch; Space-drag)
are **unchanged**.

## State Model

All state is **in-memory only** this phase (persistence is #MVP-6).

- **Geometry** (`walls.model`): `{ rooms: Room[], chain: Vertex[] }`. `rooms` are committed
  (closed polygons or open polylines); `chain` is the in-progress open chain. Vertices in
  metres. Room `id` from a module counter (`w0`, `w1`, …). Discarded on reload.
- **Tool/interaction** (`wallTool.js`): `tool ∈ {"select","wall"}` (default `"wall"`),
  `altHeld` bool, current `Snap|null`. All ephemeral.
- **Snap** is *derived*, recomputed every hover/press from `(cursor, model, altHeld, step)`;
  never persisted. `step = chooseGridStep()`.

**Render flow (extends MVP-1's loop).** `surface.js` gains refs to `#draft`/`#snap`/`#labels`
and calls `wallRender.render()` inside `_doRender`, after `drawGrid()`. The MVP-1 placeholder
rectangle is **removed** — real geometry now conveys scale and a fake dashed room is
misleading (justified deviation from LLD 2). Order per frame: grid → committed rooms →
active chain + rubber band → snap glyph → labels → HUD. Any model/tool/snap change calls
`scheduleRender()` (RAF-coalesced, one render per frame). View/unit `onChange` already
trigger `scheduleRender` via `main.js`; walls ride the same loop, so pan/zoom/unit-toggle
redraw walls for free.

**SVG structure** (added to `index.html`, inside `#drawing`, after `#world`):
```
<g id="world"></g>   <!-- committed rooms: fill + wall body + centerline + vertex dots -->
<g id="draft"></g>   <!-- active chain + rubber-band segment + close-preview fill -->
<g id="snap"></g>    <!-- snap indicator glyph -->
```
Length chips live in an HTML overlay `.labels` (`pointer-events:none`) positioned over the
SVG, updated in the same render pass.

**Persisted vs in-memory:** nothing persisted. Model objects are plain and serializable so
#MVP-6 can `JSON.stringify(model)` directly.

## Edge Cases

1. **Click vs drag in draw mode.** A press that moves > `DRAG_THRESHOLD` (~6px) pans and
   places nothing; a press under threshold places a vertex on release. Prevents accidental
   points while panning and accidental pans while tapping.
2. **Touch has no hover.** Preview (rubber band + snap glyph) appears while the finger is
   down and commits on release if the gesture was a tap. Snap stays visible before commit on
   mobile. `onLeave()` on `pointercancel`/lift-after-drag clears the preview.
3. **Pan/zoom mid-chain.** Chain, rubber band, and glyph are world coords re-projected each
   frame, so they track the view automatically. Screen-px tolerances keep snapping feel
   constant across zoom.
4. **Zero-length segment.** `placeVertex` ignores a snap within `MIN_SEG_M` of the current
   last vertex (double-tap, or clicking the just-placed point). No zero-length walls.
5. **Close requires ≥3 vertices.** With <3 points, the first vertex resolves as an ordinary
   endpoint snap, not a close; `closeRoom()` is a no-op below 3. `canClose()` gates the glyph.
6. **Weld precision.** Endpoint/close snaps return the target vertex's exact stored coords,
   guaranteeing bit-identical shared corners (critical for #7 ring closure and #5 editing).
7. **Alt free-draw scope.** Alt disables *grid* snapping only; endpoint/close welding still
   applies (matches the mockup) so you can weld to a corner or close a room while free-drawing,
   yet get truly free points anywhere away from existing vertices. *Alternative considered:*
   Alt disables all snapping — rejected because it makes welding/closing impossible mid-gesture
   and users rarely want a free point *on top of* an existing corner. (Flag for reviewer.)
7b. **Endpoint snap with an empty chain.** Endpoint snapping is active even before the first
   point, so a new chain can start welded to an existing room's corner (multi-room plans).
8. **Switching to Select mid-chain.** Selecting the Select tool (V, or rail) auto-finishes
   the open chain via `finishChain()` (commits ≥2 points as an open polyline; discards a
   1-point chain). Prevents an orphaned in-progress chain.
9. **Esc/Enter/Backspace no-ops.** Esc/Enter with an empty chain does nothing. Backspace
   with a non-empty chain pops the last point **and** `preventDefault()`s (so the browser
   doesn't navigate back); with an empty chain it is not consumed.
10. **Keyboard guards.** V/W/Esc/Enter/Backspace are ignored when `ctrlKey`/`metaKey`/`altKey`
    accompanies them (except Alt for free-draw) and when the event target is an editable
    element (none in v1, but future-proof). Space still pans in every mode (unchanged).
11. **Self-intersecting / non-simple polygons.** Allowed; not validated in MVP-2. #7's
    shoelace area handles orientation; a figure-eight is the user's call.
12. **`prefers-reduced-motion`.** The pulsing endpoint/close rings drop their animation
    (static ring) under `@media (prefers-reduced-motion: reduce)`; color + glyph still convey
    snap type.
13. **Snap-tag off-screen.** The cursor-side snap-tag is clamped to stay within the viewport
    near edges/corners so it never clips.
14. **Rail vs canvas on mobile.** The rail is compact/collapsible and positioned to avoid the
    zoom cluster (bottom-left) and HUD (bottom-right); it must never cover the canvas center.
    Canvas stays the hero (see Frontend Design).
15. **Extreme zoom.** Snap step follows `chooseGridStep()`, so at deep zoom-in it can be
    0.1 m and at zoom-out 100 m — always the visible fine grid. Wall body = `WALL_M * pxPerM()`
    with a **min 6px floor** so thin walls stay visible when zoomed out; centerline/vertex/glyph
    sizes are screen-constant.
16. **Empty state.** With no rooms and no chain, only the grid renders (plus the hint). No
    placeholder rectangle.

## Dependencies

- **Must exist first:** LLD 2 / #MVP-1 shipped modules (`view.js`, `surface.js`, `grid.js`,
  `units.js`, `interactions.js`, `hud.js`, `main.js`) and `index.html` app shell — all present
  in `src/`.
- **Reused contracts (do not change):** `view.js` `worldToScreen`/`screenToWorld`/`pxPerM`/
  `view`/`onChange`/`BASE_PX_PER_M`; `surface.js` `scheduleRender`/`W`/`H`/`init`/render loop
  and the `#world` mount; `grid.js` `chooseGridStep`; `units.js` `fmtLen`/`unitLabel`/`onChange`.
- **Modified (surgical):** `interactions.js` (mode-aware pointer arbitration + `setDrawHooks`),
  `surface.js` (bind `#draft`/`#snap`/`#labels`, call `wallRender.render()`, drop placeholder),
  `index.html` (draft/snap groups, `.labels` overlay, tool rail, `#hud-snap` cell, wall CSS,
  updated hint), `main.js` (init `wallRender` + `wallTool`, inject draw hooks into
  `interactions`), `tests.html` (geometry suites).
- **New:** `walls.js`, `wallRender.js`, `wallTool.js`.
- **Downstream:** #MVP-3 (#7) consumes `model.rooms` (closed rings → shoelace area/perimeter);
  #MVP-4 (#8) and #MVP-5 (#9) build on the tool rail and the vertex model; #MVP-6 serializes
  `model`.
- **Platform:** static `src/`, no build step, no npm, no framework, no backend. Only network
  call remains the Google Fonts `<link>`.

## Frontend Design

**Direction A — "Draft Dock" (LOCKED), with mobile adaptations.** Carries the MVP-1
warm-blueprint palette forward. Locked carryovers: warm-blueprint palette, imperial default
(metric one tap away), 40px = 1m base scale.

**New palette tokens** (add to `:root`, from the mockup):
- `--wall-body: rgba(201,168,76,0.30)`, `--wall-line: #d9be6e`, `--draft: #d9be6e`
- `--room-fill: rgba(201,168,76,0.07)`
- Snap colors, each also glyph-differentiated (never color-only):
  `--snap-grid: #7fd0c8` (teal), `--snap-point: #e0b64f` (gold), `--snap-close: #9cd67a` (green).

**Wall styling.** Committed room = faint `--room-fill` polygon under a translucent to-scale
`--wall-body` stroke (`WALL_M * pxPerM()`, min 6px), under a crisp 1.5px `--wall-line`
centerline, with small `--wall-line` vertex dots. The active chain renders the same in
`#draft`; the rubber-band segment is a dashed `--draft` line. `stroke-linejoin/linecap:
round`.

**Snap indicators (color + glyph):**
- **grid** — teal diamond + center dot on the intersection.
- **point** — gold pulsing ring + inner dot on the existing endpoint.
- **close** — green pulsing ring + inner dot + faint `--room-fill` polygon preview of the
  room that would close.
- **free** (Alt) — faint muted crosshair.
Pulse animation is disabled under `prefers-reduced-motion`.

**Cursor-side snap-type tag** (carried from the Direction B exploration): a small monospace
tag near the cursor showing `grid` / `point` / `close room` / `free`, color-keyed to the snap
type, clamped to the viewport. Reinforced by a **HUD snap readout** cell (`#hud-snap`) added
above the Zoom cell.

**Length chips.** Live gold chip (`--draft` background) on the rubber-band segment; muted
chips on the active chain's already-placed segments — both via `fmtLen`/`unitLabel` so they
honor the imperial/metric toggle. (Committed-room dimension labels + area/perimeter are #7.)

**The tool rail (`.tool-rail`).** Lean, icon-first, left-center, `--panel` background with
`--hairline` border and blur. Buttons (top→bottom), `aria-pressed`/`aria-label` on each:
1. **Select** (V) — inert this phase (cursor + drag-pan only).
2. **Draw wall** (W) — default active.
3. separator
4. **Undo point** (⌫) — disabled when chain empty.
5. **Finish** (Esc/Enter) — disabled when chain empty.
Tiny V/W key hints on Select/Draw. Cursor is `crosshair` in draw mode, default in select.

**Mobile adaptations (mobile-first, canvas is the hero).**
- ≤640px: compact rail (smaller buttons, tighter gaps, key hints hidden), positioned to
  clear the bottom-left zoom cluster and bottom-right HUD; never over canvas center; stays
  thumb-reachable.
- ≤480px: rail is **collapsible** — a small toggle collapses it to a single active-tool
  button; tapping expands it. Default expanded on first load, then remembers within the
  session.
- HUD cursor cell already hidden <560px (MVP-1); the snap readout cell stays (it is the
  mobile snap feedback alongside the on-canvas glyph).
- `touch-action: none` on the stage is retained; the rail and chrome keep their own
  pointer-events so taps on them never reach the canvas.

**Updated hint text:** "Click to place wall points · snaps to grid & existing corners ·
click the first point to close the room" (dismisses on first interaction, as MVP-1).

## Test Requirements

Extend `src/tests.html` (same in-page harness: `describe`/`it`/`expect`). Import pure
geometry from `walls.js`; set `view.zoom`/`panX`/`panY` before projection-dependent asserts
(the existing pattern). Reset `walls.model` between suites.

**Unit — snap resolution (`resolveSnap`, `gridSnap`):**
- `gridSnap` rounds to the given step (e.g. step 1: (2.4,3.6)→(2,4); step 0.5: (1.2,1.2)→(1.0,1.0)).
- Precedence: with `chain.length>=3` and cursor within `CLOSE_PX` of `chain[0]` → `"close"`
  returning `chain[0]` exactly, even when a grid point is also near.
- Endpoint beats grid: cursor within `SNAP_PT_PX` of an existing vertex → `"point"` with that
  vertex's exact coords; just outside tolerance → `"grid"`.
- `altHeld` → `"free"` (raw world point) when not near any vertex; but a vertex within
  `SNAP_PT_PX` still yields `"point"` (documented Alt scope).
- Close is gated by `canClose` (≥3): with a 2-point chain, cursor on `chain[0]` resolves as
  `"point"`/`"grid"`, never `"close"`.

**Unit — closest-endpoint detection (`closestEndpoint`):**
- Returns the nearest vertex within `tolPx`; `null` beyond it.
- Excludes the `skip` vertex (the chain's active last point).
- Distance is screen-space: the same world gap crosses/does not cross tolerance as
  `view.zoom` changes (assert at two zooms).

**Unit — room-close / polygon (`canClose`, `closeRoom`, `finishChain`, `placeVertex`):**
- `canClose` false for 0/1/2 verts, true for ≥3.
- `closeRoom` on a ≥3 chain pushes one `Room` with `closed:true`, `verts` equal to the chain,
  and clears the chain; no-op (returns false) below 3.
- `finishChain` commits ≥2 verts as `closed:false`; discards a 1-vert chain; clears chain.
- `placeVertex` ignores a snap within `MIN_SEG_M` of the last vertex (no zero-length segment);
  a `"close"` snap routes to `closeRoom`.
- `undoPoint` pops exactly one vertex; no-op on empty chain.

**Integration / behavioral (in-browser, manual or scripted):**
- Draw-mode tap places a snapped vertex; rubber band follows the cursor; snap glyph + tag +
  HUD readout update live and match the resolved type *before* commit.
- Clicking the first vertex (green ring) with ≥3 points closes the room: fill + closed wall
  loop render; chain resets.
- Esc/Enter finishes an open chain; Backspace removes the last point (and does not navigate
  back); Alt toggles free-draw glyph.
- Panning (Space-drag / Select-drag) and zooming (wheel/pinch/buttons) while a chain is in
  progress keep walls, rubber band, and glyph locked to world space; a drag in draw mode pans
  and places nothing, a tap places a point.
- Unit toggle reformats length chips without moving the view or altering geometry.
- Rail: V/W switch tools; Undo/Finish enable only while drawing; rail is compact/collapsible
  and thumb-reachable at 360–480px widths and never covers canvas center.
- One render per animation frame under fast continuous hover/drag (RAF coalescing intact);
  no console errors.

**Accessibility:**
- Every snap state is distinguishable by glyph shape (diamond / ring / ring+fill / crosshair),
  not color alone.
- `prefers-reduced-motion` disables the pulse; snap type still legible.
- Rail buttons have `aria-label` and correct `aria-pressed`; disabled state on Undo/Finish
  reflects chain state.

**Security:**
- No new network calls (Google Fonts `<link>` only); nothing leaves the client.
- Length chips and the snap tag are built via DOM APIs / `textContent` with numeric values
  through `fmtLen` — no `innerHTML` from event- or user-derived strings (no injection surface).
