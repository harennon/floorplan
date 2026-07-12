# LLD 91: Measure tool — place, snap, render, select & delete a distance annotation (fixed endpoints)

## Scope

Phase 2 (of 3) of the point-to-point measure tool (parent #87). This is the first
user-visible increment: a **Measure tool** on the tool rail that lets a user pick point A
then point B to drop a labeled dimension line, which is persisted, selectable, and
deletable. It builds directly on the LLD 81 foundation (`src/js/measurements.js` model +
all serialization/export round-trips, already shipped).

**In scope:**
- A **Measure rail button** (a third tool alongside Select/Wall), wired in `main.js`
  matching the existing rail-button pattern. New tool mode `"measure"`.
- **Placement interaction:** click/tap A, then B, to create one `Measurement`. A
  rubber-band preview draws from A to the snapped cursor. **Escape cancels** an in-progress
  measurement (before B is committed) without creating anything.
- **Snapping** for both endpoints, reusing existing infra: grid (`gridSnap`/`snapStep`),
  room wall **vertices** and **edges** (`allVertices` / `pointNearRoomWall`-style segment
  projection), and symbol **corners/center** (`corners()` / `aabb`). **Alt = free** (no
  snap), consistent with LLD 26/34. Respects the persistent snap toggle (`prefs.gridSnap()`).
- **Rendering:** a new `src/js/measureRender.js`, registered via the `onRender` hook chain
  in `main.js`. Draws each measurement as a line + end ticks + a midpoint distance label,
  formatted via `fmtLen` and reactive to the unit toggle. Also draws the in-progress
  rubber-band + live label during placement, and the selected-state highlight.
- **Selection & deletion:** integrate with the LLD 63 select dispatcher in `main.js` so a
  measurement can be hit-tested and selected in Select mode, shows a selected state, and is
  removed on Delete — **without disturbing room/symbol selection semantics**.
- **History:** each measurement add and each delete is its own undoable/redoable commit
  (extend `history.js` to snapshot the measurements model, mirroring rooms/symbols).
- **Persistence:** created/deleted measurements dirty the plan and autosave via the
  existing `store.js` onRender hook — no new persistence code (LLD 81 already wired
  `buildPlan`/`serializePlan`/`validatePlan`/compact codec/export).
- **Help overlay:** add a Measure entry to the shortcuts overlay (trivial data-row add).

**Explicitly NOT in scope:**
- Object-anchored / live-follow endpoints that move when the object moves (#93). Endpoints
  created here are **plain fixed world coordinates** (`{x,y}`) even when snapped to an
  object — no `anchor` field is written.
- Editing an existing measurement's endpoints (drag a handle to re-place). Only create +
  delete in this phase.
- Any change to the LLD 81 serialization/export/MCP wiring (already complete and tested).
- Any change to wall/room/symbol drawing, snapping, or clearance logic beyond the shared
  helpers this tool reuses read-only.

## Approach

### 1. Tool mode: extend the existing 2-tool controller, don't fork a new one

`wallTool.js` owns the current tool state (`_tool: "wall"|"select"`), the rail buttons, and
the `isDrawMode()` predicate that `interactions.js` branches on. Introducing a third mode
touches this controller. **Decision: add `"measure"` as a third value of `wallTool._tool`**
and keep `wallTool` as the single source of truth for "which tool is active", rather than
inventing a parallel mode flag. Rationale: `interactions.js` already asks `isDrawMode()` to
decide whether a pointer down is a draw-tap vs a select-down; a second parallel flag would
create ambiguous states (both "true" at once). One enum keeps the invariant "exactly one
tool active."

- Add `isMeasureMode()` to `wallTool.js` (`_tool === "measure"`).
- `setTool("measure")` finishes any open wall chain first (same guard as switching to
  select), clears the snap tag, and sets the cursor class.
- **Tool-switch cancel of a pending measurement (fixes Edge Cases 4/15).** `wallTool.setTool`
  is the single funnel for *every* tool change — the rail buttons, the `M`/`V`/`W` key
  handlers in `_onKeyDown`, and any programmatic switch all call it. So the pending-A cancel
  must hook there, not in `main.js` (the V-key and rail-button paths never surface to
  `main.js`). Because `wallTool` must not import `measureTool` (no-circular-import rule), we
  **inject a measure-cancel callback into `wallTool`**, mirroring the existing
  `setHistoryCommit(fn)` injection: add `setMeasureCancel(fn)` to `wallTool.js`, and in
  `setTool`, when leaving measure mode (`_tool === "measure" && t !== "measure"`) call the
  injected `_measureCancel?.()` **before** reassigning `_tool`. `main.js` wires
  `wallTool.setMeasureCancel(measureTool.cancel)`. This discards `_pendingA` on any switch
  away from measure mode (V, W, or rail click), symmetric with how `setTool` already commits
  the wall chain when leaving wall mode. **Belt-and-suspenders:** `measureRender` additionally
  gates all draft/rubber-band rendering on `isMeasureMode()` (see Approach §4), so even if a
  pending point somehow survived, no phantom rubber-band could paint in select/wall mode.
- The Measure tool's own pointer handling lives in a **new `measureTool.js`** module
  (mirroring how `symbolTool`/`roomTool` own their interaction logic but delegate mode
  ownership to `wallTool`). `measureTool` exposes hover/click/leave/cancel hooks and the
  in-progress state getter that `measureRender` reads.

**Why a new `measureTool.js` and not put it in `measure.js`?** `measure.js` is the live
area/perimeter *inspector panel* (unrelated). `measurements.js` is the pure model (no DOM).
The interaction controller is a third concern; name it `measureTool.js` to mirror
`wallTool.js` / `symbolTool.js` / `roomTool.js`.

### 2. Placement: reuse the draw-hook pointer path

`interactions.js` routes pointer events to injected `_drawHooks` (`isDrawMode`, `onHover`,
`onClick`, `onLeave`) when the active tool "is a draw mode." To avoid rewriting the pointer
plumbing, **generalise the draw-hook gate**: `interactions.js` currently calls
`_drawHooks.isDrawMode()`. We make that predicate return true for **both** wall and measure
modes (it becomes "is a click-to-place tool"), and the injected hook object dispatches
internally to wallTool or measureTool based on `wallTool` state. Concretely, `main.js`
composes the draw hooks:

```
setDrawHooks({
  isDrawMode: () => isDrawMode() || isMeasureMode(),   // click-to-place gate
  onHover: (sx, sy, pt) => isMeasureMode() ? measureHover(sx,sy,pt) : wallHover(sx,sy,pt),
  onClick: (sx, sy)     => isMeasureMode() ? measureClick(sx,sy)   : wallClick(sx,sy),
  onLeave: ()           => isMeasureMode() ? measureLeave()        : wallLeave(),
});
```

This reuses the entire tap/drag-threshold/loupe/touch path in `interactions.js` unchanged.
Pan (drag beyond threshold) still works in measure mode because the same threshold logic
gates it. Two-finger pinch cancel already calls `onLeave()`, which measureTool treats as
"abort the in-progress point-A if any" — see Edge Cases.

**Two-click state machine** (in `measureTool.js`):
- State `idle`: no pending point. `onClick(A)` resolves the snap, stores `_pendingA = {x,y}`,
  transitions to `awaitingB`.
- State `awaitingB`: `onHover` updates `_cursorSnap` (drives the rubber-band). `onClick(B)`
  resolves the snap for B; if B is degenerate (equal to A within `MIN_SEG_M`, reusing the
  wall zero-length guard) it is ignored (stay in `awaitingB`); otherwise it creates the
  Measurement, commits history, and returns to `idle`.
- **Escape** (and pinch-cancel / tool switch): clears `_pendingA`, back to `idle`, no commit.

### 3. Snapping: a measure-specific resolver composing existing helpers

`walls.resolveSnap` only considers grid + room/chain vertices + close + free — it does **not**
consider wall *edges* or *symbol* geometry, and its "close" branch is wall-chain-specific.
Rather than overload it, `measureTool` gets a small `_resolveMeasureSnap(sx, sy)` that
composites, in precedence order (highest first), each candidate measured in **screen-px**
against a single tolerance `SNAP_PX` (reuse the same value family as `SNAP_PT_PX`):

1. **Alt held → free**: return raw `screenToWorld(sx,sy)`, type `"free"`. (Short-circuits all
   snapping, per LLD 26/34.)
2. **Symbol corner** — nearest of every `corners(sym)` for all symbols within `SNAP_PX`.
3. **Symbol center** — nearest `aabb(sym).cx/cy` within `SNAP_PX`.
4. **Room vertex** — nearest of `allVertices()` (rooms + active chain, though chain is
   normally empty in measure mode) within `SNAP_PX`. Reuse `closestEndpoint`.
5. **Wall edge** — nearest point *on* any room wall segment within `SNAP_PX`: project the
   cursor world point onto each segment (the same clamped-projection math as
   `pointNearRoomWall`, but returning the projected point + screen distance rather than a
   bool). Factored as a small local helper; no change to `walls.js`.
6. **Grid** — if the persistent snap toggle is on (`prefs.gridSnap()` true) and
   `snapStep()` is non-null, `gridSnap(raw, step)`, type `"grid"`.
7. **Free** — otherwise raw world point, type `"free"` (snap toggle off / step null).

Both endpoints A and B use the identical resolver. The resolved `{x,y}` is stored as a plain
fixed world coordinate — **the snap target is not remembered** (no anchor; #93 owns that).

Corner/center/vertex/edge snaps reuse the existing screen-projection distance style
(`worldToScreen` then pixel distance) so snap tolerance is zoom-stable, matching wall
snapping. The snap **type** is surfaced to `measureRender` (and optionally the snap tag) only
as a visual cue; it is not persisted.

### 4. Rendering: `measureRender.js` on the onRender chain

New module `src/js/measureRender.js`, matching `wallRender.js`/`symbolRender.js` structure:
`init(gGroup, dimLabelsEl, getState)` binds a mount group + the HTML label overlay + an
injected getter for measureTool's transient state (pending A, cursor snap) and the selected
id. Its `render()` is registered via `onRender` in `main.js`.

- **Draw target:** a dedicated SVG group. Add a new `<g id="measure">` to `index.html`.
  The actual group order in `index.html` is `#grid, #world, #draft, #snap, #symbols,
  #clearance, #symbol-overlay`. **Place `#measure` immediately after `#clearance` and before
  `#symbol-overlay`** — i.e. above both furniture *and* clearance leaders, under the active
  selection handles. Rationale: a dimension line and its label should be readable over
  furniture and over clearance chips/leaders (which are advisory annotations, not primary
  content), while the symbol-overlay selection handles must stay on top so a user editing a
  symbol is never occluded by a measurement line. Paint order is therefore intentional, not
  incidental.
- **Committed measurements** (`measurementsModel.measurements`): for each, draw a `<line>`
  A→B, two short perpendicular **end ticks** at A and B (screen-constant length, matching the
  wall dimension tick idiom), and a midpoint distance **label** in the `.dim-labels` HTML
  overlay (reuse the existing chip styling family; not interactive in this phase) showing
  `` `${fmtLen(dist)} ${unitLabel()}` ``. `dist = edgeLength(a,b)`. Reactive to units because
  `onUnitChange(scheduleRender)` is already wired and the label is rebuilt each frame.
- **Selected state:** if the measure selection id matches, stroke the line with the
  selection/accent color and a slightly heavier width (mirror the room/symbol selected
  treatment; use `palette().accentRgb` / selection color).
- **In-progress rubber-band:** when `_pendingA` is set **and `isMeasureMode()` is true**, draw
  a dashed line from A to the current cursor snap point plus a live distance label, and a small
  marker glyph at A and at the snapped cursor (reuse the snap-glyph vocabulary lightly — a dot
  is sufficient). **The draft branch is explicitly gated on `isMeasureMode()`** (import
  `isMeasureMode` from `wallTool.js`): committed measurements always render, but the
  rubber-band + live label never paint outside measure mode. This is the second guard against
  a stale pending point leaking a phantom line into select/wall mode (the first being the
  tool-switch cancel in Approach §1).
- **Overlay clearing — scope-remove only our own nodes; never full-clear the shared overlay.**
  The `.dim-labels` HTML overlay is **shared** across modules and the render modules are **not**
  alike in how they clear it: `wallRender` runs first (as `surface._wallRender`, before the
  `onRender` chain) and **full-clears** `.dim-labels` (`while(_dimLabelsEl.firstChild) …`,
  `wallRender.js` ~L411/L416); `clearanceRender` runs later on the `onRender` chain and
  deliberately **scope-removes only its own** nodes (`querySelectorAll(".clr-chip, .fit-pill")`,
  `clearanceRender.js` L67). `measureRender` **must follow the clearanceRender pattern, not the
  wallRender pattern**: it tags every label chip it creates with a dedicated `.measure-label`
  class and, each frame, removes only `_dimLabelsEl.querySelectorAll(".measure-label")` before
  redrawing — it must **never** full-clear `.dim-labels`, or it would erase the wall dim chips
  and clearance chips already painted that frame. Its dedicated `<g id="measure">` SVG group
  *may* be full-cleared safely (`while(g.firstChild) g.removeChild(g.firstChild)`), since that
  group is exclusively owned by measureRender.
- **Registration order:** `measureRender.render()` is appended to the `onRender` chain in
  `main.js` **after** `wallRender` (which runs first, off-chain) and after `clearanceRender`,
  so its scoped label removal can never race a full-clear by wallRender within the same frame.
- Idempotent full redraw each frame. Colors from `palette()`; dark/light handled for free
  since palette swaps on theme change and `onThemeChange(scheduleRender)` is wired.

`measureRender.js` matches the `src/js/*Render.js` auto-merge `renderPaths` glob, so the new
module is covered by the render-diff gate (per project.json).

### 5. Selection & deletion via the LLD 63 dispatcher

The Select tool is one tool; `main.js` composes symbol + room selection over it via
`setSelectHooks({onDown, onMove, onUp, onTapEmpty})`, with a `_activeSelectOwner` mutex
("symbol" wins ties, else "room"). **Extend this dispatcher to add a third owner,
"measure", at the end of the precedence chain** so it never steals a symbol/room hit:

```
onDown(sx, sy) {
  if (onSelectDown(sx, sy))      { roomClearSelection(); measureClearSelection(); owner="symbol"; return true; }
  if (roomOnSelectDown(sx, sy))  { measureClearSelection();                       owner="room";   return true; }
  if (measureSelectDown(sx, sy)) { /* clears sym+room via injected clears */       owner="measure"; return true; }
  owner=null; return false;
}
```

- `measureSelectDown(sx, sy)` hit-tests the cursor against each committed measurement's
  **line segment** in screen space (point-to-segment distance ≤ `HIT_PX`); last match wins
  (topmost), mirroring room/symbol last-wins. On hit it sets `_selectedMeasureId`, clears the
  symbol + room selections (via injected clears, mirroring the room↔symbol mutex), and
  returns true. Selection is **session-only** (not persisted), like room/symbol selection.
- `measureTool` registers **no** onMove/onUp drag behavior in this phase (endpoints are
  fixed; no handle-drag). The dispatcher's `onMove`/`onUp` simply no-op when
  `owner === "measure"`. `onTapEmpty` also clears the measure selection alongside sym+room.
- **Close the dock drag-drop mutex hole.** Dropping a symbol from the dock places it via
  `selectSymbol` (symbolTool), which **bypasses the select dispatcher** — that is why `main.js`
  L253 already injects `symSetClearRoomSelection(roomClearSelection)` so a dock-placed symbol
  drops any live *room* selection. That reverse path clears only the room selection, not a
  measure selection, so placing a symbol while a measurement is selected would leave both
  selected — violating the single-selection invariant this LLD relies on. **Fix:** the injected
  clear that `symbolTool` calls on placement must also clear the measure selection. Concretely,
  wire `symSetClearRoomSelection` to a small composed clear in `main.js` that calls **both**
  `roomClearSelection()` **and** `measureTool.clearSelection()` (e.g.
  `symSetClearRoomSelection(() => { roomClearSelection(); measureClearSelection(); })`), rather
  than passing `roomClearSelection` alone. This keeps the mutex complete across the
  dispatcher-bypassing placement path.
- **Delete:** extend the `main.js` global Delete/Backspace handler. Today it delegates to
  `symbolTool.deleteSelected()` when `hasSelection()`. Add: if a measurement is selected
  (`measureHasSelection()`), consume the event and call `measureDeleteSelected()` — which
  removes the entry from `measurementsModel.measurements`, clears the selection, commits
  history, and shows a "Deleted" toast with a scoped one-tap Undo (mirror
  `symbolTool.deleteSelected`, Edge Case 14). **Order:** check symbol/room selection first
  (existing behavior unchanged), then measure — so no existing delete semantics change.
- **Esc** in select mode also clears a measure selection (extend the existing Esc branch
  alongside symbol/room deselect).

Because measure selection is only *added* after the existing symbol/room checks and only on
a segment hit (which cannot coincide with a symbol body or room interior hit that already
returned true), existing selection tests are unaffected — verify they still pass.

### 6. History: snapshot measurements alongside rooms/symbols

`history.js` currently captures only `{rooms, symbols}`. To make measurement add/delete
undoable **with the same one-commit-per-gesture model**, extend the snapshot:

- Import `measurementsModel` + `hydrate as hydrateMeasurements` from `measurements.js`.
- `_capture()` adds `measurements: JSON.parse(JSON.stringify(measurementsModel.measurements))`.
- `_apply(snap)` calls `hydrateMeasurements({ measurements: cloned.measurements })`.
- `GeomSnapshot` typedef gains `measurements: Measurement[]`.

The dirty-check (`JSON.stringify` compare) then naturally treats a measurement add/delete as
a committable change. This is the minimal, mechanical extension and preserves the existing
"never disturb the in-progress wall chain" behavior (chain is still excluded).

`measureTool` calls the injected `history.commit` (same injection pattern as
wallTool/roomTool/symbolTool — `setHistoryCommit`/`setHistoryAndToast`) after a create and
after a delete. Boot-restore/reset already reseed the baseline via `historyReset()`.

### 7. Persistence & autosave — no new code

Any mutation of `measurementsModel.measurements` followed by `scheduleRender()` trips the
`store.js` onRender autosave hook (debounced) and is captured by `buildPlan`/`serializePlan`
(LLD 81). Create and delete both call `scheduleRender()`. No `store.js`/`plan.js`/`share.js`/
`exportImg.js` change is needed — the LLD 81 wiring already round-trips measurements through
localStorage, share hash, JSON, and PNG/SVG export.

**Pitfall guard (explicit):** the resolver must never emit non-finite coordinates. All snap
branches derive from `screenToWorld` / `gridSnap` / existing finite vertex/corner coords, so
NaN/Infinity cannot arise under normal input; the create path additionally drops a degenerate
A≈B point (MIN_SEG_M guard). This keeps the LLD 81 plan/share/export round-trip suites green
(they already assert no NaN/Infinity reaches the model).

## Frontend Design

Per the CEO pre-authorization, this is **routine execution on existing conventions**, not a
brand-defining identity choice — no frontend-decision gate. Follow the shipped dimension
visual language (`dimEntry.js` / wall-label chips, `exportImg.js` measurement render):

- **Line + ticks:** solid stroke in `palette().dim` (the same color LLD 81 uses for the
  export measurement line), `stroke-width` ~1.5 screen px, `stroke-linecap:round`. End ticks
  are short perpendicular segments (~6–8 px) at A and B, matching the wall dimension tick
  idiom in `wallRender.js`.
- **Label:** midpoint chip using the existing `.dim-labels` chip typography/background
  (`FONT_FAMILY`, ~10px), text `` `${fmtLen(dist)} ${unitLabel()}` ``. Non-interactive in
  this phase (no click-to-edit; that is a later phase).
- **Rubber-band (in progress):** dashed variant of the line (`stroke-dasharray`) in a muted
  tone, with a live label following the cursor; small dot marker at A and at the snapped
  cursor. Mirror the wall draft rubber-band feel from `wallRender.js`.
- **Selected state:** stroke switches to the selection/accent color (`palette().accentRgb`)
  with slightly heavier width, mirroring the room/symbol selected outline treatment. No new
  handles are drawn (no editing this phase).
- **Rail button:** a third rail button matching the Select/Wall button markup — a 16×16
  inline SVG glyph (a dimension-line-with-ticks icon), `aria-label="Measure tool (M)"`,
  `aria-pressed` toggled with tool state, and a `.tool-key-hint` "M". Placed immediately
  after the Wall button, before the `.tool-rail-sep`.
- **Dark/light:** all colors sourced from `palette()`, which swaps on theme; no hardcoded
  hex. Nothing else required.
- **Cursor:** a crosshair cursor class on `.stage` while in measure mode (add a
  `.measure-mode` CSS rule mirroring `.draw-mode`).

No mockup is needed; the visuals are fully determined by the existing dimension look.

## Interfaces / Types

### `src/js/measureTool.js` (new — interaction controller)

```js
/** @typedef {"idle"|"awaitingB"} MeasureState */
/** @typedef {{ x:number, y:number, type:"free"|"grid"|"vertex"|"edge"|"corner"|"center" }} MSnap */

export function init(refs)                 // { stage }  — binds Alt key tracking
export function setHistoryAndToast(history, showToast) // { commit } + toast, injected by main.js

// Placement hooks (dispatched from the composed draw-hooks in main.js)
export function onHover(sx, sy, pointerType)  // update cursor snap; scheduleRender
export function onClick(sx, sy)               // A→awaitingB, or B→create+commit+idle
export function onLeave()                      // clear cursor snap (does NOT drop pending A)
export function cancel()                       // Esc/pinch/tool-switch: drop pending A → idle

// Selection hooks (composed into the main.js select dispatcher, lowest precedence)
export function selectDown(sx, sy)            // hit-test segments; returns boolean (consumed)
export function clearSelection()              // session-only; no render
export function hasSelection()                // -> boolean
export function deleteSelected()              // remove entry + commit + toast + render
export function getSelectedId()               // -> string|null (for measureRender)

// Transient state getter for measureRender
export function getDraftState()               // -> { pendingA:{x,y}|null, cursorSnap:MSnap|null }

// Mutex injection (mirrors roomTool.setClearSymbolSelection)
export function setClearOtherSelections(fn)   // clears symbol + room selection on a measure hit
```

Constants: `SNAP_PX` (screen-px snap tolerance, align with `walls.SNAP_PT_PX`), `HIT_PX`
(segment select tolerance), reuse `walls.MIN_SEG_M` for the degenerate-A≈B guard.

### `src/js/measureRender.js` (new — render module)

```js
export function init(gMeasure, dimLabelsEl, getDraftState, getSelectedId)
export function render()   // idempotent full redraw; registered via onRender in main.js
```

Imports: `worldToScreen` (view), `fmtLen`, `unitLabel` (units), `model as measurementsModel`
+ `edgeLength` (measurements/walls), `palette` (theme), `isMeasureMode` (wallTool — gates the
draft/rubber-band branch). Each label chip carries a dedicated `.measure-label` class; `render()`
scope-removes only `dimLabelsEl.querySelectorAll(".measure-label")` (never full-clears the shared
`.dim-labels` overlay) and full-clears its own `<g id="measure">`. Registered on the `onRender`
chain **after** `clearanceRender` (and after the off-chain `wallRender`).

### `src/js/wallTool.js` (extended)

```js
export function isMeasureMode()   // _tool === "measure"
export function setMeasureCancel(fn) // inject measureTool.cancel; called by setTool when leaving measure mode (mirrors setHistoryCommit)
// setTool() accepts "measure"; finishes open chain when leaving "wall"; calls injected
//   _measureCancel() when leaving "measure" (before reassigning _tool); sets .measure-mode cursor
// keyboard: "m"/"M" → setTool("measure")  (added to _onKeyDown switch)
```

### `src/js/history.js` (extended — internal only, signatures unchanged)

```js
// GeomSnapshot gains: measurements: Measurement[]
// _capture(): + measurements: deep clone of measurementsModel.measurements
// _apply():   + hydrateMeasurements({ measurements: cloned.measurements })
```

### `src/js/main.js` (wiring only)

- Grab `btnMeasure = document.getElementById("tool-measure")`; pass into `wallTool.init` refs
  (or add a click listener → `setTool("measure")`, matching the select/wall pattern) and into
  `_updateRail` aria-pressed handling.
- `initMeasureTool({ stage })`; `initMeasureRender(gMeasure, dimLabelsEl, getDraftState,
  getMeasureSelectedId)`; `onRender(measureRenderFn)` (append to the hook chain).
- Compose draw hooks to dispatch wall vs measure (Approach §2).
- Extend the select dispatcher with the measure owner (Approach §5); inject
  `setClearOtherSelections` and wire measure clears into the symbol/room clear paths.
- **Close the dock drag-drop mutex hole:** change the existing `symSetClearRoomSelection(...)`
  wiring (main.js L253) from `roomClearSelection` to a composed clear that also clears the
  measure selection — `symSetClearRoomSelection(() => { roomClearSelection();
  measureClearSelection(); })` (Approach §5).
- **Wire tool-switch cancel:** `wallTool.setMeasureCancel(measureTool.cancel)` so switching
  away from measure mode discards a pending A (Approach §1 / Edge Case 4).
- Extend the global Delete/Backspace + Esc handlers to cover measure selection (after
  symbol/room).
- `measureSetHistoryAndToast({ commit: historyCommit }, showToast)`.

### `src/index.html` (markup)

- New `<g id="measure">` placed **immediately after `#clearance` and before
  `#symbol-overlay`** (current order: `#grid, #world, #draft, #snap, #symbols, #clearance,
  #symbol-overlay`) — over furniture and clearance leaders, under selection handles (Approach §4).
- New `<button id="tool-measure" aria-label="Measure tool (M)" aria-pressed="false">` with a
  dimension-line SVG glyph + `<span class="tool-key-hint">M</span>`, placed after
  `#tool-wall`, before the first `.tool-rail-sep`.
- `.stage.measure-mode { cursor: crosshair; }` CSS rule.

### `src/js/help.js` (data-row add)

- Add to `SHORTCUTS`: `{ group:"Drawing"|"Tools", action:"Measure tool", mac:"M", other:"M" }`
  (and optionally a "Cancel measurement" Esc note — Esc row already exists as
  "Deselect / cancel").

## State Model

- **Source of truth:** `measurements.js` `model.measurements` (LLD 81) — the persisted array
  of `{ id, a:{x,y}, b:{x,y} }`. This tool pushes on create and splices on delete.
- **Transient (in-memory, not persisted):**
  - `measureTool._pendingA` (`{x,y}|null`) + `_state` — the in-progress first point.
  - `measureTool._cursorSnap` — last resolved snap for the rubber-band/preview.
  - `measureTool._selectedMeasureId` (`string|null`) — session-only selection, like
    room/symbol selection. Cleared on tool switch, Esc, tap-empty, and delete.
  - `wallTool._tool === "measure"` — active tool.
- **Persisted:** created measurements ride the existing LLD 81 paths — localStorage
  (`store.js` autosave), share hash (compact `m` tuples), JSON export/import, PNG/SVG export.
  No new persistence surface, no schema change.
- **History (in-memory undo/redo):** `history.js` snapshots now include `measurements`;
  create/delete each push one snapshot. Undo/redo re-hydrates the model in place.
- **Reset boundaries:** boot-restore and Reset-plan reseed the history baseline
  (`historyReset()`), so undo cannot cross them — unchanged, now covers measurements too.

## Edge Cases

1. **Escape with a pending A.** `cancel()` drops `_pendingA`, returns to `idle`, no
   measurement created, no history commit. The global Esc handler must route to measure
   `cancel()` when in measure mode with a pending point (add a branch before the
   symbol-deselect branch, mirroring the wall-chain Esc guard).
2. **Escape with no pending A (measure mode idle).** No-op for placement; if a measurement
   is selected in *select* mode, Esc clears that selection instead. Distinct handlers.
3. **B equals A (degenerate / double-click same spot).** Reuse `MIN_SEG_M`: if
   `edgeLength(A,B) < MIN_SEG_M`, ignore the B click (stay in `awaitingB`); no zero-length
   measurement is created. (LLD 81 tolerates zero-length in the model, but the tool guards it
   at placement, matching the wall vertex guard.)
4. **Tool switch mid-placement.** `wallTool.setTool` (to select/wall — via rail button, or
   the `V`/`W` key handlers in `wallTool._onKeyDown`, or programmatic) invokes the injected
   `_measureCancel` callback when leaving measure mode, **before** reassigning `_tool`, so a
   dangling pending A is discarded, not silently committed. No commit. The injection point is
   specified in Approach §1 (`wallTool.setMeasureCancel(fn)`, mirroring `setHistoryCommit`);
   it lives in `wallTool` — not `main.js` — precisely because the V-key and rail-button paths
   never surface to `main.js`. `measureRender`'s `isMeasureMode()` draft gate (Approach §4) is
   the backstop.
5. **Two-finger pinch / pointer-cancel mid-placement.** `interactions.js` calls
   `_drawHooks.onLeave()` on the second finger; measure `onLeave()` clears only the cursor
   snap, **not** pending A (so a one-finger pan-zoom detour doesn't lose point A). A true
   cancel is Escape or tool switch. (Documented divergence from wall draw, which has no
   two-click state.) If product prefers pinch to abort A, route pinch-cancel to `cancel()` —
   pick the non-destructive default: **keep A**.
6. **Alt held during A or B.** Free placement for that endpoint (no snap), per LLD 26/34.
   Alt is tracked per keydown/keyup + window blur reset, mirroring wallTool/roomTool.
7. **Snap toggle off (`prefs.gridSnap()` false / snapStep null).** Grid branch skipped;
   point/edge/corner/center object snaps still apply (they are not grid-gated — they help
   "does my couch fit" alignment); falls through to free when no object target is near.
   (Matches the intent that object snapping is always useful; only *grid* obeys the toggle.
   If reviewers prefer the toggle to also gate object snaps, that is a one-line change — the
   recommended behavior is grid-only gating, consistent with `resolveSnap` where point snap
   is not grid-gated.) **Open decision for CEO/CX confirmation:** whether object/corner/center
   snapping remaining active while the snap toggle is *off* could surprise users in the "does
   my couch fit" flow (a user who toggled snapping off may expect fully free placement). The
   recommended default is grid-only gating; if CX signals users expect the toggle to disable
   *all* snapping, flip object snaps to also honor `prefs.gridSnap()`. Flagging rather than
   deciding unilaterally, per the escalation rule.
8. **Delete with a measurement selected.** Removes it, commits, toast with scoped Undo. Must
   run **after** the symbol/room delete checks so existing behavior is unchanged; a
   measurement and a symbol cannot both be "selected" at once (mutex).
9. **Delete/Esc while in draw or measure placement mode.** Delete does nothing to
   measurements during placement (no selection exists in placement); the existing wall-chain
   Delete/Esc guards take precedence and are checked first.
10. **Undo immediately after create.** History snapshot before create is restored →
    measurement removed. Redo re-adds it. Selection state is not part of the snapshot
    (session-only), so an undone-then-selected measurement simply has no selection after
    undo — acceptable.
11. **Hit-test miss margin.** A measurement whose line passes near a symbol/room: the select
    dispatcher checks symbol then room then measure, so a click on a symbol body selects the
    symbol even if a measurement line crosses it. Measure only wins when the click is within
    `HIT_PX` of the segment AND missed symbol+room. This preserves existing semantics.
12. **Measurement with an endpoint far off-canvas.** Rendering projects via `worldToScreen`;
    the line may extend past the viewport (SVG clips to viewBox) — harmless. Export framing
    already accounts for endpoints (LLD 81 `contentBounds`).
13. **Units toggle after placement.** Labels rebuild every frame from `fmtLen`/`unitLabel`;
    `onUnitChange(scheduleRender)` is wired, so toggling ft/m updates all labels live.
14. **Reload / share-link / export round-trip.** Handled entirely by LLD 81; this LLD adds no
    new serialization. A created measurement survives reload, share, and export unchanged.
15. **Rapid A-click then immediate tool switch (no B).** Covered by Edge Case 4: pending A
    discarded on tool switch.

## Dependencies

**Must exist (all shipped):**
- `measurements.js` — `model`, `newId`, `hydrate` (LLD 81). **Reused as-is.**
- `plan.js` / `store.js` / `share.js` / `exportImg.js` — measurement serialization + export
  round-trips (LLD 81). **No change.**
- `walls.js` — `resolveSnap`, `gridSnap`, `allVertices`, `closestEndpoint`,
  `pointNearRoomWall` (segment-projection math to mirror), `edgeLength`, `MIN_SEG_M`,
  `SNAP_PT_PX`.
- `symbols.js` — `corners(sym)`, `aabb(sym)`, `model.symbols`.
- `grid.js` / `prefs.js` — `snapStep()`, `gridSnap()` (persistent snap toggle).
- `view.js` — `screenToWorld`, `worldToScreen`.
- `units.js` — `fmtLen`, `unitLabel`, `onChange`.
- `theme.js` — `palette()`, `onThemeChange`.
- `interactions.js` — draw-hook + select-hook injection points (generalise the draw gate;
  add measure owner to the select dispatcher — done in `main.js`).
- `history.js` — commit/undo/redo + the injected `commit` pattern (**extend snapshot**).
- `surface.js` — `onRender`, `scheduleRender`.
- LLD 63 select dispatcher in `main.js` — the composition point to extend.

**New additions:**
- `src/js/measureTool.js` — interaction controller (placement + selection + delete).
- `src/js/measureRender.js` — render module (matches `*Render.js` renderPaths glob).
- `wallTool.js` — `"measure"` tool mode + `isMeasureMode()` + `M` key.
- `history.js` — measurements in the snapshot.
- `main.js` — wiring (rail button, hooks, dispatcher, delete/esc, render hook).
- `index.html` — `<g id="measure">`, `#tool-measure` button, `.measure-mode` cursor CSS.
- `help.js` — Measure shortcut row.

**No new libraries, no build step, no backend** — client-side only, consistent with v1.

**Downstream (not this LLD):** #93 (object-anchored / live-follow endpoints) extends the
endpoint shape additively and adds handle-drag editing.

## Test Requirements

Frontend tests extend `test/tests.html` (in-page `describe`/`it`/`expect`, headless via
`.github/run-tests.mjs`). Reset `walls.model`, `symbols.model`, `measurements.model`, plus
`units.unit`/`view`/`history` between suites (existing pattern). Full command:
`node .github/run-tests.mjs && (cd mcp && node --test)`. **All existing tests must still
pass** — especially the LLD 63 selection suite and the LLD 81 round-trip suite.

**Unit — snap resolver (`measureTool`):**
- Alt held → returns raw world point (type `free`), regardless of nearby targets.
- Grid snap applies only when `prefs.gridSnap()` on and `snapStep()` non-null; type `grid`.
- Snaps to a room vertex when the cursor is within `SNAP_PX` of one.
- Snaps to a point on a wall edge (segment projection) when near an edge but not a vertex.
- Snaps to a symbol corner and to a symbol center within tolerance; corner beats center when
  both in range (precedence).
- Precedence order holds (corner > center > vertex > edge > grid > free).
- Never returns non-finite coordinates for any branch.

**Unit — placement state machine (`measureTool`):**
- `onClick(A)` sets pending A (state `awaitingB`); no measurement created yet.
- `onClick(B)` with a non-degenerate B creates exactly one measurement with the resolved
  A/B world coords and a fresh `m<n>` id; state returns to `idle`.
- Degenerate B (within `MIN_SEG_M` of A) is ignored; no measurement; state stays `awaitingB`.
- `cancel()` (Esc / tool switch) with pending A creates nothing and returns to `idle`.
- **Tool switch away from measure mode invokes the injected cancel:** with a pending A,
  calling `wallTool.setTool("select")` (or `"wall"`) discards `_pendingA` (no measurement, no
  commit) — asserts the `setMeasureCancel` wiring fires from every switch path.
- `onLeave()` does not drop pending A (Edge Case 5).

**Unit — selection & delete (`measureTool`):**
- `selectDown` within `HIT_PX` of a measurement segment selects it (returns true); a miss
  returns false.
- Last-match-wins when two segments overlap under the cursor.
- `deleteSelected` removes the entry, clears selection, and (with history injected) is
  undoable.
- Selecting a measurement clears any symbol/room selection (mutex) via the injected clear.
- **Dock drag-drop mutex:** with a measurement selected, placing a symbol via `selectSymbol`
  (the dispatcher-bypassing path) clears the measure selection — asserts the composed
  `symSetClearRoomSelection` clears both room and measure selection (no double-selection).

**Unit — history:**
- Create pushes one undoable snapshot; undo removes the measurement, redo re-adds it.
- Delete pushes one undoable snapshot; undo restores the measurement, redo removes it.
- Undo/redo of measurements does not disturb rooms, symbols, or the in-progress wall chain.
- `commit()` dirty-check no-ops when measurements (and rooms/symbols) are unchanged.

**Integration — dispatcher (LLD 63 regression):**
- In Select mode, clicking a symbol body still selects the symbol (measure does not steal it)
  even when a measurement line crosses that symbol.
- Clicking a room interior still selects the room.
- Clicking only a measurement segment (no symbol/room under cursor) selects the measurement.
- Existing symbol/room selection + delete tests pass unchanged.

**Integration — persistence (leveraging LLD 81, assert no regression):**
- A created measurement survives `buildPlan → serializePlan → validatePlan` round-trip.
- Survives the compact share-hash round-trip (geometry preserved; id regenerated).
- Appears in `buildExportSvg()` output (line + label) — already covered by LLD 81, re-assert
  after tool-created data.
- No NaN/Infinity endpoint reaches the model from any tool-created measurement (reuse LLD 81
  finite-check fixtures).

**Render (`measureRender`, structural — mirror LLD 61 render coverage):**
- Renders one `<line>` + a distance-label chip (`.measure-label`) per committed measurement.
- Selected measurement renders with the selection stroke treatment.
- With a pending A **and measure mode active**, renders a dashed rubber-band + live label;
  none when idle.
- **Draft gate:** with a pending A but the tool switched to select/wall (`isMeasureMode()`
  false), the rubber-band + live label are NOT rendered (committed measurements still render).
- **Overlay scoping:** `render()` removes only `.measure-label` nodes and leaves any
  pre-existing `.clr-chip`/`.fit-pill`/wall dim chips in `.dim-labels` intact (assert a
  sentinel foreign node survives a measure render; assert measure never full-clears the overlay).
- Label text reflects the current unit and updates after a unit toggle.

**Interaction (where practical, headless):**
- Activating the Measure rail button enters measure mode (`isMeasureMode()` true,
  aria-pressed set) and shows the rubber-band after the first click.
- Two clicks create a persistent, labeled measurement.
- Escape mid-placement creates nothing.
