# LLD 85: Measure tool — place, snap, render, select & delete a distance annotation (fixed endpoints)

## Scope

Phase 2 (of 3) of the point-to-point measure tool (parent #87). This is the first
**user-visible** increment. It builds directly on LLD 81's persisted `measurements`
model (PR #99, merged) — schema, `plan.js` serialization, compact codec, and export are
already done and MUST NOT be re-invented here.

**In scope:**
- A new Measure tool mode on the tool rail (button + `M` shortcut), wired in `main.js`
  matching the existing Select/Wall rail patterns.
- Two-tap placement: tap point A, then point B, creating one `Measurement`. A rubber-band
  preview follows the cursor after A. `Escape` cancels an in-progress measurement before B
  commits.
- Endpoint snapping by **reusing existing snap infra** (grid via `gridSnap`/`snapStep`,
  wall vertices via `allVertices`/`closestEndpoint`, wall edges via `wallSegments`, object
  corners/centers via `corners()`/`aabb`). **Alt = free** (no snap) per LLD 26/34; the
  persistent snap toggle is respected.
- A new **`src/js/measureRender.js`** registered on the `onRender` hook chain: draws each
  dimension line with end ticks and a distance chip (`fmtLen`, reactive to the unit
  toggle), plus the rubber-band preview and the selected-state highlight.
- Selection & deletion integrated through the LLD 63 select dispatcher: in Select mode a
  measurement can be picked (line hit-test), shows selected state, and is removed on
  `Delete`/`Backspace` — without disturbing room/symbol selection.
- Each add and each delete is its own undoable `history.commit`. This requires extending
  `history.js` snapshots to include `measurements` (see Approach §6).
- Created/deleted measurements dirty the plan and autosave (LLD 81 wiring), surviving
  reload, share-link, and export round-trip.
- Add a Measure/tool row to the help/shortcuts overlay.

**Explicitly NOT in scope:**
- Object-anchored / live-follow endpoints that move with an object (#93). Endpoints created
  here are **fixed world coordinates** even when snapped to an object at placement time.
- Editing/moving an existing measurement's endpoints, multi-select, or a measurements
  inspector panel.
- Any change to the LLD 81 schema/serialization/compact/export code paths.

## Approach

### 1. Tool ownership: extend `wallTool` mode; new `measureTool.js` owns behavior

`wallTool.js` is the single owner of tool state (`_tool`), the rail buttons, and the
`V`/`W` keyboard switches. Extend its `_tool` union from `"wall"|"select"` to
`"wall"|"select"|"measure"` and add:
- A `tool-measure` rail button + `M`/`m` key → `setTool("measure")`.
- `export function isMeasureMode()` → `_tool === "measure"`.
- A one-arg tool-change notifier: add an injected `_onToolChange` callback fired at the end
  of `setTool(t)` with the new tool. main.js wires it to `measureTool.setActive(t === "measure")`
  so leaving measure mode cancels any pending point. Keep it optional/injected (same
  pattern as `setHistoryCommit`) to avoid a `wallTool → measureTool` import cycle.
- `_updateRail()` sets `aria-pressed` on the measure button; `_updateCursor()` toggles a
  `measure-mode` class on the stage (crosshair cursor, mirrors `draw-mode`).

**New module `src/js/measureTool.js`** (mirrors `symbolTool`/`roomTool` as the DOM/interaction
layer; imports pure geometry, no cycles). It owns:
- `_pendingA: {x,y}|null` — first point placed, awaiting B (module state, spans two taps).
- `_snap: Snap|null` — current preview snap (drives rubber-band + snap tag).
- `_altHeld` — Alt modifier for free snap.
- `_selectedId: string|null` — the selected measurement in Select mode.
- Injected `history.commit` (via `setHistoryCommit`), `showToast`, and mutex-clear hooks.

### 2. Placement interaction (tap-place mode, reuses interactions.js machinery)

Measure mode is a "tap-to-place" mode exactly like draw mode (hover preview + deferred tap,
with drag-threshold → pan). Rather than duplicate the pending-tap/threshold/touch logic in
`interactions.js`, generalize the existing draw-mode branch:

- Add `setMeasureHooks({ isMeasureMode, onHover, onClick, onLeave })` alongside `setDrawHooks`.
- Introduce a private `_activeTapHook()` in interactions.js returning the draw hook object
  when `isDrawMode()`, else the measure hook object when `isMeasureMode()`, else `null`.
- Replace the `_drawHooks && _drawHooks.isDrawMode()` guards in `_onPointerDown`,
  `_onPointerMove`, `_onPointerEnd`, `_onPointerLeave` with the generalized hook. The
  select-hooks branch condition becomes "no active tap hook" so select routing is disabled
  in measure mode too. Loupe behavior stays draw-only (it lives inside `wallTool.onHover`;
  `measureTool.onHover` simply does not call it).

`measureTool` hook semantics:
- `onHover(sx, sy, pointerType)` → `_snap = resolveMeasureSnap(sx, sy)`, update snap tag,
  `scheduleRender()` (preview redraws).
- `onClick(sx, sy)`:
  - Resolve snap. If `_pendingA === null`: set `_pendingA = {x: snap.x, y: snap.y}`.
  - Else: `b = {x: snap.x, y: snap.y}`. If `dist(_pendingA, b) < MIN_SEG_M` (reuse
    `walls.MIN_SEG_M`), ignore (degenerate, keep pending — Edge Case 3). Otherwise create
    `{ id: measurements.newId(), a: {..._pendingA}, b }`, push to `measurements.model`,
    clear `_pendingA` and `_snap`, `history.commit()`, `scheduleRender()`.
- `onLeave()` → clear `_snap`, hide snap tag, `scheduleRender()` (pending A persists).
- `cancel()` → clear `_pendingA` + `_snap` (used by Escape and `setActive(false)`).

### 3. Snap resolution — compose existing helpers, do not build new snapping

`resolveMeasureSnap(sx, sy)` in `measureTool.js` composes existing infra; precedence:

1. **Alt held** → raw `screenToWorld`, `type:"free"`.
2. **Point snap** (screen-px tolerance `SNAP_PT_PX` from walls.js) — nearest of:
   - all wall vertices: `allVertices()` (walls.js), and
   - object corners + centers: for each `symbols.model` symbol, `corners(sym)` (4 pts) plus
     the AABB center `aabb(sym).{cx,cy}`.
   Reuse `closestEndpoint(sx, sy, candidates, null, SNAP_PT_PX)`. Match → `type:"point"`.
3. **Wall-edge snap** — closest projection onto any `wallSegments()` segment within
   `SNAP_PT_PX` (screen space). Use a small pure helper `_closestPointOnSegment(p, a, b)`
   (the same segment-projection math already in `pointNearRoomWall`, returning the point).
   Match → `type:"point"`.
4. **Grid** — if `snapStep()` returns non-null (snap toggle ON, Alt not held):
   `gridSnap(raw, step)`, `type:"grid"`.
5. **Free** — otherwise (toggle OFF), raw point, `type:"free"`.

Point/edge/object snapping are always active (they are intentional targets, mirroring how
wall point-snap is never gated by the grid toggle); only the grid step obeys the persistent
toggle, and Alt bypasses everything. `Snap` reuses the walls.js `{x,y,type}` shape.

### 4. Rendering (`src/js/measureRender.js`, new; on the `onRender` chain)

A new SVG group `<g id="measure">` is added to `index.html` between `#clearance` and
`#symbol-overlay` (annotations above furniture bodies, below symbol selection handles). The
module mirrors `symbolRender.js`: idempotent full redraw, clears only its own group.

Per committed measurement:
- One `<line>` A→B in `--measure-line` (cool cyan-blue `#6fb3d9`); slightly thicker + a
  soft halo when `id === _getSelectedId()` (selected state).
- Two short perpendicular **end ticks** at A and B (fixed screen length, e.g. 6px).
- A distance **chip** appended to `.dim-labels` at the segment midpoint: text
  `` `${fmtLen(edgeLength(a,b))} ${unitLabel()}` ``, styled `.measure-chip` (cool outline
  per the frontend decision). Reactive to the unit toggle because `onUnitChange →
  scheduleRender → onRender → measureRender`.

Preview (when `getPendingA()` is set): dashed rubber-band `<line>` from A to the current
preview snap point (`getPreviewSnap()`), same accent color, plus a snap dot at the live
endpoint. Nothing is committed until the second tap.

Registration order in `main.js`: register `measureRender` as an `onRender` hook **after
`symbolRenderFn`** so `.dim-labels` (cleared by wallRender at the top of the surface render,
appended-to by symbolRender) already exists; measureRender only appends its chips (never
clears `.dim-labels`).

### 5. Selection & delete via the LLD 63 dispatcher

`measureTool` exposes: `onSelectDown(sx, sy) -> boolean`, `getSelectedId()`,
`clearSelection()`, `hasSelection()`, `deleteSelected()`.

- **Hit-test** (`onSelectDown`): find the measurement whose segment is within a screen-px
  tolerance (`MEASURE_HIT_PX`, coarse-pointer-aware ~44px touch / ~8px mouse, mirroring
  symbol `MIN_HIT_PX`) of (sx,sy), last-drawn wins. On hit: set `_selectedId`, return true.
  No drag this phase (fixed endpoints) — `onSelectMove`/`onSelectUp` are no-ops.
- **Dispatcher edits** (`main.js setSelectHooks`): insert measurement between symbol and
  room so it never steals symbol ties and only beats room-interior when the click lands on
  the thin line:
  ```
  onDown: symbol? → clear room+measure, owner="symbol"
          else measure? → clear symbol+room, owner="measure"
          else room?   → clear measure (room clears symbol itself), owner="room"
          else null
  onMove/onUp: route by owner ("measure" → no-op)
  onTapEmpty: clear symbol + room + measure
  ```
- **Mutex completeness:** `symbolTool.selectSymbol` also clears measurement selection
  (inject `setClearMeasureSelection`, mirroring `setClearRoomSelection`) so dock drag-drop
  placement — which bypasses the dispatcher — upholds the "≤1 selected" invariant.
- **Delete:** extend the `main.js` global `Delete`/`Backspace` handler with a
  `measureTool.hasSelection()` branch calling `measureTool.deleteSelected()` (removes from
  `measurements.model`, clears selection, `history.commit()`, "Deleted" toast with scoped
  one-tap Undo, `scheduleRender()`), mirroring `symbolTool.deleteSelected`. Because of the
  mutex, only one of symbol/measure is selected, so branch order is safe.
- **Escape (in-progress cancel):** `measureTool` registers its own bubble-phase keydown
  (mirrors wallTool): when `isMeasureMode()` and `_pendingA !== null`, `Escape` calls
  `cancel()` + `scheduleRender()` (guarded by `isHelpOpen()` and editable-focus, like
  wallTool). It does not `stopPropagation`; the main.js Escape branch no-ops because
  `isDrawMode()` is false and symbol `hasSelection()` is false.

### 6. History: include measurements in snapshots (required for undo/redo)

LLD 81 wired measurements into `plan.js` serialization but **not** into `history.js`, whose
`_capture`/`_apply` snapshot only rooms + symbols. To make add/delete undoable:
- Import `model as measurementsModel, hydrate as hydrateMeasurements` from `measurements.js`.
- `_capture()` returns `{ rooms, symbols, measurements: deep-clone(measurementsModel.measurements) }`.
- `_apply(snap)` calls `hydrateMeasurements({ measurements: cloned.measurements })` alongside
  the walls/symbols hydrate.
This keeps the stringify dirty-check honest (a pure add/delete changes the snapshot) and
makes undo/redo restore measurements consistently. `GeomSnapshot` typedef gains
`measurements`.

### 7. Persistence & autosave (LLD 81, no new code)

Add/delete mutate `measurements.model` then `scheduleRender()`. The surface render fires the
`store` autosave `onRender` hook, which calls `buildPlan()` → `serializePlan()` (both
already include `measurements` per LLD 81) → localStorage. Share-hash and export likewise
already carry measurements. No `store.js`/`plan.js`/`exportImg.js` changes.

## Frontend Design

Approved frontend decision: **proceed with recommendations**.

- **Dedicated accent — `--measure-line: #6fb3d9`** (cool cyan-blue), deliberately distinct
  from the gold walls/dimension chips (`--gold #c9a84c`) and the green wall-flush /
  teal/violet snap guides. Measurements read as a separate annotation layer at a glance.
  Add `measureLine` to both the dark and light `theme.js` palettes and map `--measure-line`
  in the CSS-var table; light mode may use a slightly darker shade for contrast on the pale
  paper (implementer's call — note it in the PR).
- **Distance chip — cool-outlined `.measure-chip`.** Same base HTML chip affordance as
  `.dim-chip`/`.sym-dim-chip` (monospace, small, appended to `.dim-labels`) but outlined in
  `--measure-line` rather than gold, so the measurement's label is visually tied to its
  line. Non-interactive this phase (no click-to-edit); `pointer-events:none`.
- **End ticks** at A and B (short perpendicular caps, ~6px screen) in `--measure-line`, so a
  measurement reads as a dimension segment, not a wall.
- **Rubber-band preview** after point A: a dashed line in `--measure-line` from A to the live
  snap point, plus a snap dot at the cursor endpoint, echoing the wall draft/snap language.
- **Rail button + `M` key.** New `#tool-measure` button placed after `#tool-wall`, matching
  the existing rail button markup (16×16 SVG icon — a dimension line with end ticks — plus a
  `.tool-key-hint` reading `M`). `aria-pressed` reflects the active mode; the stage shows a
  crosshair (`measure-mode` class) in measure mode.
- **Cursor-side snap tag** reuses the shared `.snap-tag` (grid/point/free labels), owned by
  `measureTool` while in measure mode — the same pattern wallTool/symbolTool use.
- **Help overlay:** add a `Tools → Measure (M)` row (and note free-snap Alt already covers
  the measure endpoints) to `SHORTCUTS` in `help.js`.

## Interfaces / Types

### `src/js/measureTool.js` (new)

```js
/** @typedef {import("./walls.js").Snap} Snap */

export function init(refs)                     // { stage } — binds keydown(Esc/Alt), cursor
export function setHistoryCommit(fn)           // inject history.commit
export function setToastAndHistory(showToast, { undo, depth }) // for scoped-undo delete toast

// Tool-mode participation (injected/queried by main.js + interactions.js)
export function setActive(active)              // called on tool change; false → cancel()
export function cancel()                       // clear pending A + preview snap

// Tap-place hooks (injected into interactions.js via setMeasureHooks)
export function isMeasureMode()                // reads wallTool.isMeasureMode (injected)
export function onHover(sx, sy, pointerType)
export function onClick(sx, sy)                // tap A, then tap B → create + commit
export function onLeave()

// Render getters (injected into measureRender.js)
export function getPendingA()                  // {x,y}|null
export function getPreviewSnap()               // Snap|null
export function getSelectedId()                // string|null

// Select-dispatcher API (LLD 63)
export function onSelectDown(sx, sy)           // -> boolean (line hit-test)
export function clearSelection()               // clear _selectedId (no render)
export function hasSelection()                 // -> boolean
export function deleteSelected()               // remove + commit + toast + render

// Pure helper (exported for tests)
export function resolveMeasureSnap(sx, sy)     // -> Snap
```

### `src/js/measureRender.js` (new)

```js
export function init(gMeasure, dimLabels, getMeasurements, getSelectedId, getPendingA, getPreviewSnap)
export function render()                       // onRender hook: lines + ticks + chips + preview
```

### `src/js/wallTool.js` (extended)

```js
// _tool: "wall" | "select" | "measure"
export function isMeasureMode()                // -> _tool === "measure"
export function setToolChangeHook(fn)          // fn(newTool) fired at end of setTool
// init(refs): refs gains { btnMeasure }
// _onKeyDown: add case "m"/"M" → setTool("measure")
```

### `src/js/interactions.js` (extended)

```js
export function setMeasureHooks(h)             // { isMeasureMode, onHover, onClick, onLeave }
// private _activeTapHook(): draw hook | measure hook | null (replaces isDrawMode() guards)
```

### `src/js/measurements.js` (used, unchanged)

`newId()`, `model.measurements`, `hydrate` already exist (LLD 81). This LLD is the first
consumer of `newId()`.

### `src/js/history.js` (extended — §6)

```js
// GeomSnapshot gains: measurements: Measurement[]
// _capture(): + measurements deep clone ; _apply(): + hydrateMeasurements(...)
```

### Signatures unchanged
`plan.js`, `store.js`, `exportImg.js`, `symbols.js`, `walls.js` public functions are
unchanged (measureTool only *reads* their pure helpers).

## State Model

- **Source of truth (persisted):** `measurements.model.measurements` (LLD 81). Add/delete
  push/splice this array, then `scheduleRender()` → autosave via the store onRender hook.
  `buildPlan`/`serializePlan`/compact/export already include it.
- **Undo/redo:** history snapshots now include a deep clone of `measurements` (§6). One
  commit per add and per delete.
- **Session-only (in-memory, not persisted, not in history):**
  - `measureTool._pendingA` / `_snap` — in-progress placement; cleared on commit, `cancel()`,
    tool switch, or blur. Never serialized.
  - `measureTool._selectedId` — current selection; cleared on tap-empty, tool switch, delete,
    or mutex from a symbol/room selection.
  - `wallTool._tool === "measure"` — active mode.
- **Ids:** `newId()` mints `m<n>`; `measurements.hydrate` (on load/undo) re-syncs the counter
  past the max loaded id so a later add cannot collide (LLD 81).
- **Rendering is read-only:** `measureRender` reads the model + measureTool getters; never
  mutates.

## Edge Cases

1. **Escape before B.** `_pendingA` set, no B yet → `Esc` (or tool switch / `setActive(false)`)
   calls `cancel()`; no measurement created, no history commit, no autosave dirtying.
2. **Tool switch mid-placement.** Switching to Wall/Select (rail, `V`/`W`, or programmatic
   dock-drag `setTool("select")`) fires the tool-change hook → `setActive(false)` → `cancel()`.
   Pending A discarded.
3. **Degenerate (zero-length) measurement.** Second tap within `MIN_SEG_M` of A → ignored;
   `_pendingA` retained so the user can tap a different B. No commit. (LLD 81 tolerates a
   zero-length entry, but we guard at placement.)
4. **Second finger / pinch during placement.** interactions cancels in-flight tap gestures
   via the generalized tap-hook path (`onLeave`), same as draw mode; `_pendingA` is module
   state and is unaffected by a single cancelled tap — a stray B is not committed
   (`_gestureCancelled` blocks the trailing `onClick`).
5. **Alt held at either tap.** That endpoint is placed free (raw world), `type:"free"`; the
   snap tag shows "free". Consistent with LLD 26/34.
6. **Snap toggle OFF.** `snapStep()` is null → grid step skipped; point/edge/object snapping
   still applies (intentional targets). Alt still forces fully-free.
7. **Unit toggle after placement.** Chip label recomputes via `fmtLen`/`unitLabel` on the
   next render (unit change schedules a render). Stored geometry is metres, unchanged.
8. **Delete with nothing selected.** `deleteSelected()` no-ops when `_selectedId` is null;
   the main.js Delete branch only calls it under `hasSelection()`.
9. **Selecting a measurement over a room.** Line hit-test (thin, tolerant) runs before room
   interior in the dispatcher, so a click on the line selects the measurement; clicks
   elsewhere in the room still select the room. Symbol still wins ties (checked first).
10. **Mutex.** Selecting a measurement clears symbol + room selection and vice-versa
    (dispatcher + `selectSymbol` injection). Never two selections at once.
11. **Undo of an add / redo of a delete.** History snapshots include measurements (§6), so
    undo removes the just-added line and redo restores it; autosave follows the render.
12. **Reload / share-link / export round-trip.** Created measurements persist via LLD 81;
    no new persistence code. Verified by reusing LLD 81's round-trip guarantees.
13. **Measurement snapped to an object, then object moved.** Endpoint stays at its fixed
    world coord (does NOT follow the object) — correct for this phase; live-follow is #93.
14. **Empty / no rooms or symbols.** Snapping falls back to grid (or free) via `screenToWorld`;
    placement still works on a blank canvas.

## Dependencies

**Must exist (all shipped):**
- `measurements.js` — `model`, `newId`, `hydrate` (LLD 81, PR #99).
- `plan.js` / `store.js` / `exportImg.js` — measurements already serialized/persisted/
  exported (LLD 81) — **no change**.
- `walls.js` — `allVertices`, `closestEndpoint`, `gridSnap`, `wallSegments`, `edgeLength`,
  `SNAP_PT_PX`, `MIN_SEG_M`, `Snap` typedef (reused, unchanged).
- `symbols.js` — `model`, `corners`, `aabb` (reused, unchanged).
- `grid.js` — `snapStep` (persistent snap toggle).
- `view.js` — `screenToWorld`, `worldToScreen`, `pxPerM`.
- `units.js` — `fmtLen`, `unitLabel`, `onChange`.
- `interactions.js` — draw-hook gesture machinery to generalize.
- `wallTool.js` — tool/rail/keyboard owner to extend.
- `history.js` — snapshot capture/apply to extend (§6).
- `theme.js` — palette to extend with `measureLine`.
- `help.js` — `SHORTCUTS` array to extend.

**New files:**
- `src/js/measureTool.js` — interaction + selection controller.
- `src/js/measureRender.js` — SVG lines/ticks + `.dim-labels` chips + preview.

**HTML/CSS additions (`index.html`):**
- `#tool-measure` rail button (SVG icon + `M` key hint) after `#tool-wall`.
- `<g id="measure">` between `#clearance` and `#symbol-overlay`.
- `--measure-line` CSS var + `.measure-chip` style (cool cyan-blue outline, `#6fb3d9`).
- `theme.js`: add `measureLine` to dark **and** light palettes and the `--measure-line`
  var mapping (light may darken for contrast; implementer's call, note it).

**Auto-merge:** `measureRender.js` matches the `src/js/*Render.js` renderPaths gate (already
listed in `.claude/project.json`), so it is covered by the render-validation path.

**No new libraries, no build step, no backend** — client-side only, consistent with v1.

**Downstream (not this LLD):** #93 (object-anchored / live-follow endpoints) extends the
endpoint shape additively (`a.anchor`) per LLD 81 §2.

## Test Requirements

Frontend tests extend `test/tests.html` (in-page `describe`/`it`/`expect`, run headless via
`.github/run-tests.mjs`). Reset `walls.model`, `symbols.model`, `measurements.model`,
`units.unit`, and `view` between suites. **All existing tests must still pass.**

**Unit — `measureTool.resolveMeasureSnap` (pure-ish, needs view + models):**
- Grid snap: with snap toggle ON and no nearby targets, a raw point resolves to the nearest
  grid multiple, `type:"grid"`.
- Point snap: a cursor within `SNAP_PT_PX` of a wall vertex resolves to that vertex,
  `type:"point"`; likewise for a symbol corner and a symbol AABB center.
- Edge snap: a cursor near a wall segment (not near a vertex) resolves to the projected point
  on the segment, `type:"point"`.
- Alt free: with Alt held, resolves to the raw world point, `type:"free"`, ignoring nearby
  targets.
- Toggle OFF: with `snapStep()` null and no targets, resolves free (no grid rounding).

**Unit — placement / commit (`measureTool` onClick):**
- First `onClick` sets pending A, creates no measurement.
- Second `onClick` at a distinct point pushes exactly one `Measurement` with fixed `a`/`b`
  and a fresh `m<n>` id, clears pending, and calls the injected `history.commit` once.
- Degenerate second tap (< `MIN_SEG_M` from A) creates nothing and keeps pending A.
- `cancel()` (and `setActive(false)`) with pending A clears it and creates nothing.

**Unit — selection & delete:**
- `onSelectDown` on a point within tolerance of a measurement line returns true and sets the
  selected id; a far click returns false and leaves selection unchanged.
- `deleteSelected` removes the selected measurement from the model, clears selection, and
  commits once; no-op when nothing selected.
- Mutex: selecting a measurement clears symbol + room selection; selecting a symbol/room
  clears the measurement selection.

**Unit — history (§6):**
- After an add, `historyUndo()` removes the measurement and `historyRedo()` restores it
  (deep-equal geometry); a pure add/delete is NOT dirty-check-collapsed to a no-op.

**Render — `measureRender` (structural, mirrors LLD 61 render coverage):**
- With N committed measurements, the `#measure` group contains N line elements and 2N end
  ticks, and `.dim-labels` gains N `.measure-chip` elements whose text matches
  `fmtLen(len)+" "+unitLabel()`.
- Selected measurement's line carries the selected-state attribute/class.
- With pending A set and a preview snap, a dashed preview line is rendered; none is rendered
  when pending A is null.
- Unit toggle re-renders chip text (ft ↔ m) without changing stored geometry.

**Integration — persistence (leverages LLD 81, HARD acceptance):**
- Create a measurement, `serializePlan(buildPlan())` → `validatePlan(JSON.parse(...))`
  round-trips it losslessly (reuses LLD 81 guarantees; assert non-regression from the tool
  path).
- A created measurement survives a share-hash encode/decode round-trip (reuse the existing
  share suite) and appears in `buildExportSvg()`.

**Regression / safety:**
- Existing draw-mode, select (symbol/room), history, store, share, and export suites still
  pass unchanged (measure mode is additive; the generalized tap-hook path must not alter
  draw-mode behavior — add an assertion that draw-mode tap still commits a vertex).
</content>
</invoke>
