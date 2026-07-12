# LLD 92: Measure tool — place, snap, render, select & delete a distance annotation (fixed endpoints)

## Scope

Phase 2 of epic #87 (sub-issue 2 of 3). Delivers the first user-visible measurement
feature: a **Measure** tool that places a labeled, to-scale distance annotation from
point A to point B, renders it on the canvas, and lets the user select and delete it in
Select mode. Endpoints are **fixed world coordinates**, snapped at placement time.

### In scope
- A **Measure** rail button + `M` shortcut; a dedicated measure mode.
- Two-click placement: click A → dashed teal rubber-band with live distance readout →
  click B commits. Escape cancels an in-progress measurement.
- Snapping of both endpoints to grid / wall vertices / wall edges / object corners &
  centers by **reusing existing snap infra**; **Alt = free**; persistent snap toggle
  respected.
- New `src/js/measureRender.js` (mirrors `clearanceRender.js`): teal SVG line +
  perpendicular end-ticks + endpoint nodes, plus an HTML distance chip in `.dim-labels`.
  Distance via `fmtLen`, reactive to the unit toggle.
- Selection + deletion through the LLD 63 select dispatcher (hit-test the line);
  `Delete`/`Backspace` removes; room and symbol selection semantics unchanged.
- Add and delete are each their own undoable `history.commit`.
- Created measurements dirty the plan → autosave; survive reload + share-hash + export
  (LLD 81 foundation already serializes them — this LLD verifies the round-trip).

### Explicitly NOT in scope
- Object-anchored endpoints that move when the object moves (sub-issue #93). Endpoints
  created here are fixed even if snapped to an object.
- Editing an existing measurement's endpoints after commit (drag a handle). Not in this
  phase; only create + delete.
- Live-follow / re-snap of committed measurements.

## Approach

### Module layout

Three touch points, mirroring how `wallTool.js` + `wallRender.js` + `walls.js` are split:

| File | Role | Notes |
| --- | --- | --- |
| `src/js/measurements.js` | Pure model + CRUD + geometry | EXISTS (LLD 81). Extend with `add` / `remove` / `getById` / `nearestMeasurement` hit-test. No DOM, Node-loadable. |
| `src/js/measureTool.js` | NEW. Interaction controller | Owns measure mode, two-click placement, in-progress endpoint, Alt state, snapping, select/delete hooks. Mirrors `wallTool.js` + `roomTool.js`. Imported only by `main.js`. |
| `src/js/measureRender.js` | NEW. `onRender` hook renderer | Draws committed + in-progress annotations. Mirrors `clearanceRender.js`. Matches the `src/js/*Render.js` auto-merge renderPaths glob. |

> The existing `src/js/measure.js` is the **area/perimeter inspector** — unrelated.
> Do NOT reuse or overload it. The new controller is `measureTool.js`.

### Tool mode: a third tool, not a wallTool sub-mode

`wallTool._tool` is `"wall" | "select"`. Rather than thread a third value through
wallTool's rail/HUD/keyboard logic, `measureTool` owns its own boolean mode
(`_active`) and coordinates with the existing tools through `main.js`:

- Activating Measure (rail button or `M`) calls `wallTool.setTool("select")` to leave
  draw mode (auto-finishing any open chain), then sets `measureTool` active. This keeps
  wallTool's invariant that leaving wall mode finishes the chain, and means pan/zoom and
  the select-dispatcher hooks continue to work while measuring is layered on top.
- Activating Wall or Select (rail/`W`/`V`) deactivates measure mode first
  (`measureTool.deactivate()` — cancels any in-progress measurement without committing).
- Rationale: measure mode is a *placement overlay* over the select tool. During
  placement, `measureTool` consumes pointer taps; when idle, taps fall through to the
  select dispatcher so a user in Measure mode can still pan. This avoids invasive edits
  to wallTool and matches the "layered controller" pattern already used by symbolTool.

### Placement pipeline (reusing snap infra)

Both endpoints resolve their world position through a single helper,
`measureTool._resolvePoint(sx, sy)`, which composes the existing snap primitives in
precedence order (closest wins by screen-pixel distance, tolerance `SNAP_PT_PX = 15`):

1. **Object corner / center** — for every symbol, test `corners(sym)` (4) and the AABB
   center (`sym.x, sym.y`); reuse `symbols.corners` + `aabb`.
2. **Wall vertex** — `walls.closestEndpoint(sx, sy, allVertices(), null, SNAP_PT_PX)`.
3. **Wall edge** — nearest point on any `walls.wallSegments()` segment within tolerance
   (perpendicular projection; reuse the segment-distance math already in
   `pointNearRoomWall`, applied per segment to also get the foot point).
4. **Grid** — `resolveSnap(sx, sy, {chain:[], rooms:[], altHeld, step})` collapses to
   grid/free; equivalently `gridSnap(raw, step)` when snapping on.
5. **Free** — raw `screenToWorld`, when Alt held OR `snapStep()` is null OR
   `prefs.gridSnap()` is false.

`altHeld` and the persistent toggle gate steps 1–4: if `_altHeld || !prefsGridSnap()`,
skip straight to free (raw world point). This matches wallTool/roomTool exactly (Alt =
free, snap toggle respected). Snapped endpoints store the resolved **world coordinate
only** — no anchor reference (that is #93).

### Rendering

`measureRender.render()` is registered as an `onRender` hook in `main.js`, ordered
**after `clearanceRenderFn` and before the selection overlays** so measurement lines sit
below `#symbol-overlay` (per the frontend decision). It:
- Clears its own SVG group and its own `.dim-labels` nodes (class-scoped, like
  clearanceRender clears only `.clr-chip`/`.fit-pill`).
- Draws each committed measurement: teal line (`palette().snapTeal` / `--snap-teal`),
  two perpendicular end-ticks (reuse the tick math from clearanceRender), small endpoint
  node dots, and one HTML distance chip at the line midpoint (`fmtLen(len)+unitLabel()`).
- Draws the in-progress measurement (A→cursor) as a **dashed** teal line with a live
  chip, plus a snap glyph at the pending endpoint.
- Selected measurement gets a thicker/highlighted stroke (selection state read via an
  injected `getSelectedMeasurementId` getter, mirroring how clearanceRender reads
  `getSelectedId`).

New SVG group `#measure` is added to `index.html` between `#clearance` and
`#symbol-overlay`.

### Selection & deletion (LLD 63 dispatcher)

The `main.js` select dispatcher composes symbol + room hooks with symbols winning ties.
Measurements are added as a **third, lowest-priority** owner so room/symbol semantics are
untouched:

```
onDown: symbol? → "symbol"
        else room? → "room"
        else measurement? → "measurement"   // NEW, last
        else null (miss)
```

- `measureTool.onSelectDown(sx,sy)` hit-tests the nearest measurement line within
  tolerance; on hit sets `_selectedMeasurementId`, clears symbol+room selection (mutex,
  via injected clearers), returns true. No drag — measurements are not movable this
  phase, so `onSelectMove`/`onSelectUp` are no-ops (up still fires nothing to commit).
- Deletion is owned by `main.js`'s existing global `Delete`/`Backspace` handler. Extend
  the guard: if `measureTool.hasSelection()` (and no symbol selection), consume the event
  and call `measureTool.deleteSelected()`, which removes from the model + commits +
  schedules render. Room selection has no delete today, so ordering is: symbol delete →
  measurement delete.
- `Escape` in Select mode with a measurement selected clears it (added to the existing
  Escape branch). In Measure mode Escape cancels the in-progress placement (owned by
  measureTool's own keydown).

### History: extend the snapshot to include measurements

**Required change.** `history.js._capture()` / `_apply()` currently snapshot only
`walls` + `symbols`. Measurement add/delete would therefore NOT be captured and
undo/redo would silently drop them (and worse, an unrelated undo would not restore a
deleted measurement). Extend both:

- `_capture()` adds `measurements: JSON.parse(JSON.stringify(measurementsModel.measurements))`.
- `_apply()` calls `hydrateMeasurements({ measurements: cloned.measurements })`.

This is the single-source-of-truth commit path; `measureTool` calls the injected
`history.commit` after each add and each delete (dirty-check makes a no-op cancel free).
This mirrors how symbol/room commits already flow.

### Persistence (verify, don't rebuild)

`plan.js` already serializes measurements in `buildPlan`, `validatePlan`,
`buildCompact`/`parseCompact`, and `applyPlan`→`hydrateMeasurements` (LLD 81). Autosave
(`store.js`) is driven by the `onRender` hook and calls `buildPlan`. Because every
add/delete calls `scheduleRender()`, autosave fires automatically — no store.js change.
This LLD's obligation is to **verify** the reload / share-hash / export round-trips carry
measurements, via tests.

## Frontend Design

Approved decision (from @neiljurling): **free-form placement with grid snap, teal
accent** (reuse `--snap-teal`, distinct from wall gold). Recommendations accepted as-is.

### Tool rail
- New `#tool-measure` button placed in the rail after `#tool-wall`, before the first
  `.tool-rail-sep`. Same markup pattern as `#tool-select`/`#tool-wall`: a 16×16 SVG icon,
  a `.tool-key-hint` span showing `M`, `aria-label="Measure tool (M)"`,
  `aria-pressed="false"`.
- Icon: a dimension-line glyph — a horizontal line with short perpendicular end-ticks
  (e.g. `<path d="M2 8 H14 M2 5 V11 M14 5 V11" .../>`), reading as a ruler/dimension.
- Pressed state uses the existing `button[aria-pressed="true"]` rail rule. When measure
  mode activates, set `#tool-measure` pressed and clear `#tool-select`/`#tool-wall`;
  when Wall/Select activate, clear `#tool-measure`. `measureTool` owns this via injected
  button refs (same as wallTool `_updateRail`).

### Colors (teal, both themes)
- Line, ticks, endpoint nodes, in-progress rubber-band, and snap glyph all use
  `palette().snapTeal` (`--snap-teal`: `#7fd0c8` dark, `#2f8f86` light). This is visually
  distinct from wall-draw gold (`snapPoint`/`snapGrid`) and from clearance red/green.
- Selected measurement: same teal at higher stroke width (2.5 vs 1.75) plus a subtle
  halo, matching the "selected" affordance weight used elsewhere. No new color var.

### Distance chip
- One `.dim-labels` HTML chip per measurement at the line midpoint, class
  `.measure-chip` (new). Text `fmtLen(len) + " " + unitLabel()`. `aria-hidden="true"`
  (decorative; the canvas is `aria-hidden`). Reuse the visual style of `.clr-chip`
  (small pill) but tinted teal; add a `.measure-chip` rule in `index.html`'s inline CSS
  next to `.clr-chip`.
- In-progress chip is the same class with a `.measure-chip--draft` modifier (slightly
  translucent) tracking the cursor endpoint.
- `pointer-events` follows `.dim-labels` default — the chip is NOT the hit target;
  selection hit-tests the SVG line in world space (see State Model), so chips don't
  interfere with pan.

### Two-click interaction feel
- After the first click, the cursor drags a dashed rubber-band from A with a live
  readout, exactly like the wall rubber-band but teal + dashed. Snap glyph shows at the
  live endpoint so the user sees what B will lock to.
- On touch, the same two-tap flow applies; the placement uses the committed
  `effectiveDrawPoint` offset already applied by interactions.js for draw-mode taps —
  measure mode reuses that path (see State Model / interactions wiring).

### Help / shortcuts overlay
- Add a single `M — Measure tool` line to the shortcuts list in the help overlay
  (`help.js` / the overlay markup) alongside `V`/`W`. This is trivial (one row); include
  it. If the overlay is generated from a static list, add the entry there.

## Interfaces / Types

### `measurements.js` (extend existing — pure, Node-loadable)

Existing: `model`, `newId()`, `hydrate(next)`, typedefs `Endpoint`/`Measurement`. Add:

```js
/** Create + append a fixed-endpoint measurement. Mints id via newId(). Returns it.
 *  a, b are world-metre points. Does NOT dirty history/plan (caller commits). */
export function add(a, b) // → Measurement

/** Remove by id. No-op if absent. Returns boolean. */
export function remove(id) // → boolean

/** Find by id, or null. */
export function getById(id) // → Measurement|null

/** Euclidean length in metres of a measurement (or of an {a,b} pair). Pure. */
export function length(m) // → number

/** Nearest measurement whose segment passes within tolPx (screen px) of (sx,sy),
 *  or null. Uses worldToScreen on both endpoints + point-to-segment distance in
 *  SCREEN space (so tolerance is zoom-independent, like closestEndpoint). Last
 *  match wins on ties (topmost draw order), mirroring pickSymbol/room hit rules. */
export function nearestMeasurement(sx, sy, tolPx) // → Measurement|null
```

> `nearestMeasurement` imports `worldToScreen` from `view.js` (same dependency
> `walls.closestEndpoint` already has), keeping the model pure of DOM but view-aware.

### `measureTool.js` (NEW — interaction controller, imported only by main.js)

```js
export function init(refs)   // refs: { stage, btnMeasure, btnSelect, btnWall, snapTag }
export function setHistoryCommit(fn) // inject history.commit (avoids cycle)
export function setClearOtherSelections(fn) // inject () => { symClear(); roomClear(); }

// Mode
export function isActive()            // → boolean  (measure mode on)
export function activate()            // enter measure mode (main.js also setTool("select"))
export function deactivate()          // leave measure mode; cancels in-progress placement

// Placement (called from interactions via injected hooks — see wiring)
export function onMeasureDown(sx, sy) // → boolean: consumed? (places A, or commits B)
export function onMeasureMove(sx, sy) // update rubber-band endpoint + snap glyph
export function onMeasureLeave()      // clear rubber-band snap glyph

// Preview state readers (for measureRender)
export function getDraft()            // → { a:{x,y}, b:{x,y}, snapType } | null
export function getSelectedMeasurementId() // → string|null

// Selection (LLD 63 dispatcher, lowest priority)
export function onSelectDown(sx, sy)  // → boolean: hit a measurement line?
export function onSelectMove(sx, sy)  // no-op this phase
export function onSelectUp(sx, sy)    // no-op this phase
export function clearSelection()      // clear _selectedMeasurementId (no render)
export function hasSelection()        // → boolean
export function deleteSelected()      // remove + history.commit + scheduleRender
export function onTapEmpty()          // clear measurement selection + render
```

### `measureRender.js` (NEW — onRender hook; mirrors clearanceRender.js)

```js
/** @param gMeasure  #measure SVG group
 *  @param overlayEl .dim-labels HTML container
 *  @param getMeasurements  () => Measurement[]      (measurementsModel.measurements)
 *  @param getDraft         () => draft|null         (measureTool.getDraft)
 *  @param getSelectedId    () => string|null        (measureTool.getSelectedMeasurementId) */
export function init(gMeasure, overlayEl, getMeasurements, getDraft, getSelectedId)

/** Idempotent full redraw: clears #measure + own .measure-chip nodes, then draws
 *  committed measurements + the in-progress draft. Registered as an onRender hook. */
export function render()
```

### `main.js` wiring (additions)

- Grab `#tool-measure` and `#measure` SVG group refs.
- `initMeasureTool({ stage, btnMeasure, btnSelect, btnWall, snapTag })`;
  `measureSetHistoryCommit(historyCommit)`;
  `measureSetClearOtherSelections(() => { symClearSelection(); roomClearSelection(); })`.
- `initMeasureRender(gMeasure, dimLabelsEl, () => measurementsModel.measurements, getDraft, getSelectedMeasurementId)`.
- Register `onRender(measureRenderFn)` AFTER `clearanceRenderFn`, before selection-overlay
  repositioners.
- Rail/keyboard: `#tool-measure` click → `measureActivate()`; `M` key → `measureActivate()`;
  `W`/`V`/Wall/Select clicks → `measureDeactivate()` before their existing handlers.
- Extend the select dispatcher (`setSelectHooks`) with the measurement branch (lowest
  priority) and route move/up when `_activeSelectOwner === "measurement"`.
- Extend interactions: measure mode needs its own down/move routing. Add a small
  `setMeasureHooks({ isActive, onDown, onMove, onLeave })` injection to interactions.js
  analogous to `setDrawHooks` — when `isActive()` and single-pointer, tap → `onDown`,
  hover/threshold → `onMove`, matching the draw-pending tap-vs-drag logic so a drag still
  pans. (Reuse `_drawPending` semantics; do not duplicate pan logic.)
- Extend the global `Delete`/`Escape` handlers with the measurement branches described in
  Approach.

### `history.js` (extend)

Add `measurements` to `_capture()` and `hydrateMeasurements(...)` to `_apply()` (import
`{ model as measurementsModel, hydrate as hydrateMeasurements }` from `measurements.js`).

## State Model

### Persisted (in the plan document)
- `measurementsModel.measurements: Measurement[]` — the only persisted state this LLD
  adds to, and it already exists (LLD 81). Each `{ id, a:{x,y}, b:{x,y} }` in world
  metres. Flows to localStorage / share-hash / export via `plan.js` unchanged.

### Session-only, in `measureTool.js` (NOT persisted)
- `_active: boolean` — measure mode on/off. Resets to off on reload (default tool is
  wall, per wallTool).
- `_pendingA: {x,y}|null` — first placed endpoint during a two-click placement; null when
  idle or after commit.
- `_cursorPt: {x,y}|null` + `_snapType` — live rubber-band endpoint + resolved snap kind,
  updated on move; used only for preview render and the snap glyph.
- `_selectedMeasurementId: string|null` — current selection (session-only, like
  `roomTool._selectedRoomId` / `symbolTool` selection).
- `_altHeld: boolean` — Alt modifier for free snap (own keydown/keyup/blur listeners,
  identical to roomTool).

### Derived / not stored
- Distance labels: computed each render from endpoints (`length` → `fmtLen`); never
  stored, so the unit toggle re-labels reactively (unit change → `onUnitChange` →
  `scheduleRender` → `measureRender.render`).

### State flow — create
1. Measure mode active; `onMeasureDown(A)` → `_pendingA = _resolvePoint(sx,sy)`; render
   shows node at A.
2. `onMeasureMove` → `_cursorPt = _resolvePoint(...)`; render shows dashed A→cursor +
   live chip + snap glyph.
3. `onMeasureDown(B)` → `b = _resolvePoint(...)`; if `length({a:_pendingA,b}) < MIN_LEN`
   (see Edge Cases) discard; else `measurements.add(_pendingA, b)` →
   `history.commit()` → `scheduleRender()` (which triggers autosave). `_pendingA = null`
   (ready for the next measurement — tool stays active).

### State flow — select + delete
1. In Select mode (or Measure mode when idle), dispatcher tries symbol → room →
   measurement. Measurement hit → `_selectedMeasurementId` set, other selections cleared.
2. `Delete`/`Backspace` (main.js) → `deleteSelected()` → `measurements.remove(id)` →
   `_selectedMeasurementId = null` → `history.commit()` → `scheduleRender()` (autosave).

### State flow — undo/redo
- `history` snapshots include `measurements` (see Approach). Undo after an add removes it;
  undo after a delete restores it; redo reverses. `_selectedMeasurementId` is NOT part of
  the snapshot — after an undo/redo that removes the selected measurement, `measureTool`
  must null a now-dangling selection: `measureRender`/`deleteSelected` treat a missing id
  as no selection; additionally main.js's history undo/redo path should call
  `measureTool.clearSelection()`-safe reconciliation (drop id if `getById` returns null)
  before render. Simplest: `getSelectedMeasurementId()` returns null when the id no longer
  exists in the model (validate on read).

## Edge Cases

1. **Zero / near-zero-length measurement** — A and B resolve to the same (or ~same)
   point. Reject B when `length < MIN_LEN` (reuse `walls.MIN_SEG_M = 1e-4` m). Keep
   `_pendingA` so the user can click a real B; do not commit, do not history.commit.
2. **Escape mid-placement** — `_pendingA` set, no B yet. Escape cancels: clear
   `_pendingA`/`_cursorPt`, no model change, no commit, re-render. Owned by measureTool's
   keydown; guard against help-overlay-open (let help.js handle) like wallTool.
3. **Switching tool mid-placement** — user hits `W`/`V` or a rail button with `_pendingA`
   set. `deactivate()` cancels the in-progress placement (same as Escape) — no partial
   measurement is committed.
4. **Second finger / gesture cancel during placement** — interactions.js already cancels
   in-flight single-pointer gestures on the 2nd pointer (`_gestureCancelled`). The measure
   hooks must be included in that cancel path (call `onMeasureLeave()` and drop the
   pending tap) so a pinch never commits a stray endpoint. Do NOT clear `_pendingA` on a
   pinch that starts *after* A is placed but before B — cancel only the pending tap, not
   the whole placement (mirror how draw cancels the pending click but keeps the chain).
   Decision: pinch cancels the *current tap only*; `_pendingA` survives so the user can
   still place B after zooming. Document this explicitly to avoid ambiguity.
5. **Delete precedence** — a symbol AND (conceptually) a measurement can't both be
   selected (mutex clears others on select). But the main.js `Delete` handler checks
   `hasSelection()` (symbol) first, then measurement. Since selection is mutually
   exclusive, only one branch fires. Also: in Wall draw mode with an active chain, Delete
   still routes to wallTool vertex removal (existing guard unchanged) — measurement delete
   only applies outside that.
6. **Snap target removed then undo** — measurement endpoints are fixed world coords; they
   do not reference the wall/object they snapped to. Deleting that wall/object leaves the
   measurement in place (correct — this is the fixed-endpoint contract; live-follow is #93).
7. **Unit toggle** — chip text recomputes from metres each render; toggling ft↔m relabels
   without touching stored coords. Covered by `onUnitChange → scheduleRender`.
8. **Snapping off / snap toggle** — when `prefs.gridSnap()` is false, `_resolvePoint`
   still tries object/vertex/edge snaps? Decision: **the persistent grid-snap toggle gates
   grid snapping only**; object/vertex/edge snapping is a placement affordance that stays
   on (consistent with wall/symbol snapping which are unaffected by the grid toggle).
   Alt is the universal "free, no snap at all" override. This matches LLD 26/34 semantics.
9. **Empty model / no snap targets** — no rooms, no symbols: `_resolvePoint` falls through
   to grid (or free). Placement still works on the bare grid.
10. **Selection hit tolerance vs overlapping geometry** — a measurement line drawn over a
    room interior or a symbol: symbol and room hit-tests run first (higher priority), so a
    measurement over furniture is only selectable where it does not overlap a symbol/room
    hit. Acceptable this phase; endpoint-node hit-testing (finer) is deferred.
11. **Reload / share / export round-trip** — LLD 81 handles serialization. Verify a plan
    with measurements survives: localStorage restore, share-hash open, JSON export/import,
    and SVG/PNG export. VERIFIED against `exportImg.js`: `contentBounds`,
    `buildExportSvg`, and the PNG path already include `measurementsModel.measurements`
    (line + midpoint label — LLD 81 built this forward). No export change needed; confirm
    with a test.
12. **Very long measurement / off-screen endpoint** — chip midpoint may fall off-screen;
    acceptable (same behavior as clearance chips). No clamping required this phase.
13. **Touch placement offset** — reuse `effectiveDrawPoint` (interactions.js) so the
    committed point matches the loupe-offset finger position, consistent with wall drawing.

## Dependencies

### Must already exist (all present)
- **LLD 81 — measurements schema/persistence** (`measurements.js` model/newId/hydrate;
  `plan.js` build/validate/compact/apply round-trip; `exportImg.js` render). SHIPPED.
- `walls.js`: `resolveSnap`, `gridSnap`, `closestEndpoint`, `allVertices`,
  `wallSegments`, `pointNearRoomWall` (segment-distance math), `MIN_SEG_M`, `SNAP_PT_PX`.
- `symbols.js`: `corners`, `aabb`, `model.symbols`.
- `view.js`: `worldToScreen`, `screenToWorld`.
- `units.js`: `fmtLen`, `unitLabel`, `onChange`.
- `grid.js`: `snapStep`; `prefs.js`: `gridSnap()`.
- `interactions.js`: `setDrawHooks`/`setSelectHooks` injection pattern +
  `effectiveDrawPoint`, tap-vs-drag/gesture-cancel machinery.
- `history.js`: `commit`/`undo`/`redo` (inject `commit`).
- `theme.js`: `palette().snapTeal`; CSS `--snap-teal` (both themes) already defined.
- LLD 63 select dispatcher in `main.js` (`_activeSelectOwner`, mutex clearers).

### Changes this LLD makes to existing files
- `measurements.js`: add `add`/`remove`/`getById`/`length`/`nearestMeasurement`.
- `history.js`: extend `_capture()`/`_apply()` with `measurements` (REQUIRED — otherwise
  add/delete are not undoable and unrelated undos corrupt measurements).
- `main.js`: init + wire the new modules; extend select dispatcher, Delete/Escape
  handlers, rail/keyboard; register the render hook.
- `interactions.js`: add `setMeasureHooks` + route single-pointer taps/moves when measure
  mode active (mirrors draw hooks; include in the gesture-cancel path).
- `index.html`: add `#tool-measure` rail button, `#measure` SVG group (between
  `#clearance` and `#symbol-overlay`), `.measure-chip` CSS.
- `help.js` / help overlay: add the `M — Measure tool` shortcut row.

### New files
- `src/js/measureTool.js`, `src/js/measureRender.js`.

### Blocks / blocked by
- Blocked by: #87 sub-issue 1 (done).
- Blocks: #93 (object-anchored / live-follow) — will extend the `Endpoint` typedef with
  an optional `anchor` and add follow logic; this LLD must not add anchor fields.

## Test Requirements

Tests run headless via `test/tests.html` (browser harness, Playwright) for DOM-touching
code and `node --test` in `mcp/` for pure model code. Keep existing tests green.

### Unit — `measurements.js` (pure; add to the harness measurements suite)
- `add(a,b)` appends a `{id,a,b}`, mints a monotonic `m<n>` id, returns it.
- `remove(id)` removes existing (true) / no-op on missing (false).
- `getById` returns the entry or null.
- `length` computes Euclidean distance in metres; 0 for coincident points.
- `nearestMeasurement`: hits within `tolPx` of the segment (incl. near an endpoint and at
  the midpoint); misses beyond tolerance; returns null on empty model; last-match-wins on
  overlapping lines; tolerance is measured in screen space (zoom-independent).
- `hydrate` still re-syncs the id counter past loaded `m<n>` (regression).

### Unit — snapping (`measureTool._resolvePoint`, exercised via exported helper or hook)
- Snaps to a wall vertex when the cursor is within `SNAP_PT_PX`.
- Snaps to a wall edge foot-point when near a segment but not a vertex.
- Snaps to a symbol corner and to a symbol center.
- Falls to grid when snapping on and no proximate target; `gridSnap` applied.
- `Alt` held → raw world point (free), no snap, regardless of nearby targets.
- Persistent snap toggle off → grid snapping skipped, but object/vertex/edge still apply
  (Edge Case 8); Alt still forces fully free.

### Unit — `history.js` extension
- A snapshot captures `measurements`; `_apply` restores them.
- Add-then-undo removes the measurement; redo restores it.
- Delete-then-undo restores; redo removes.
- An undo of an UNRELATED op (e.g. a symbol move) does not drop existing measurements
  (regression guarding the pre-fix bug).

### Integration / interaction (browser harness)
- Two clicks in measure mode create one measurement with the expected endpoints; a third
  click starts a new one (tool stays active).
- Rubber-band draft is present after the first click (`getDraft()` non-null) and cleared
  after commit / after Escape.
- Escape mid-placement commits nothing and clears the draft.
- Zero-length (A==B) second click does not commit.
- Chip text equals `fmtLen(len)+unitLabel()`; toggling units changes the chip text
  without changing stored coords.
- Select dispatcher: clicking a measurement line selects it; a symbol/room under a
  competing hit still wins (priority order preserved); selecting a measurement clears any
  symbol/room selection and vice-versa (mutex).
- `Delete` with a measurement selected removes it and commits; room/symbol Delete paths
  unaffected; Wall-mode chain-vertex Delete unaffected.
- Selecting then undoing a delete restores the measurement; selection of a deleted-then-
  undone id does not crash render (dangling-id guard).

### Render (`measureRender`)
- Renders one SVG line + two ticks + endpoint nodes + one `.measure-chip` per committed
  measurement; draft renders a dashed line + draft chip; clears its own nodes on redraw
  and does not remove `.clr-chip` / wall / symbol chips.
- Selected measurement renders the highlighted stroke.

### Persistence round-trip (verify LLD 81, don't rebuild)
- `buildPlan → serializePlan → validatePlan → applyPlan` preserves measurements.
- Compact codec `buildCompact → parseCompact` preserves measurement endpoints
  (mm-rounded) — existing LLD 81 tests likely cover this; extend if a gap.
- `exportImg.buildExportSvg` output contains a `<line>` + label for each measurement.
- localStorage save/load and share-hash encode/decode carry measurements (harness or
  existing plan round-trip tests extended).
