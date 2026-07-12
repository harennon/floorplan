# LLD 93: Measure tool — place, snap, render, select & delete a distance annotation (fixed endpoints)

## Scope

Phase 2 of epic #87. Delivers a usable **Measure tool**: pick point A, pick point B, and a
labeled dimension line appears on the canvas, is saved with the plan, and can be selected and
deleted. Builds directly on the **already-merged** measurements schema + persistence foundation
(LLD 81, commit `0c19aff`).

Covers:
- A new **Measure** tool/mode on the tool rail, alongside Select and Wall.
- Two-click placement (A, then B) with a rubber-band preview from A to the cursor.
- Endpoint snapping reusing existing infra (grid, wall vertices/edges, object corners/centers);
  **Alt = free**; the persistent snap toggle is respected.
- A new render module `src/js/measureRender.js` (dimension line + end ticks + distance label)
  registered on the `onRender` hook chain in `main.js`.
- Distance label formatted via `fmtLen`, live-reactive to the unit toggle.
- Selection + deletion integrated through the LLD 63 Select dispatcher (hit-test the line),
  without disturbing room/symbol selection.
- One undoable `history.commit` per add and per delete.
- Persistence: create/delete dirties the plan and autosaves; round-trips through reload,
  share hash, and export (LLD 81 already handles serialization).

Explicitly does **NOT** cover:
- **Object-anchored / live-follow endpoints** (sub-issue 3 / #93 follow-up). Endpoints created
  here are **fixed world coordinates** even when snapped to an object; they do not move when the
  object later moves. The `Endpoint` schema's reserved optional `anchor` field is left unused.
- Editing an existing measurement's endpoints after commit (no drag-to-adjust). Only add + delete.
- Measurement labels in the docked Measure inspector panel (that panel stays room-only).
- Angle/area annotations; only point-to-point distance.

## Approach

### Module split (mirrors the wall / symbol / room pattern)

| File | Role | Imported by |
| --- | --- | --- |
| `src/js/measurements.js` (exists, LLD 81) | pure model; **add**: `addMeasurement`, `removeMeasurement`, `pickMeasurement`, `createMeasurement` | plan, history, measureTool, measureRender |
| `src/js/measureTool.js` (new) | interaction controller: mode, two-click placement, snapping, selection/delete hooks; DOM/event layer | main.js only |
| `src/js/measureRender.js` (new) | `onRender` hook: draws committed measurements + rubber-band preview + selection state | main.js only |

`measureTool.js` is the interaction controller (no `*Render.js` suffix, so it is **not** on the
auto-merge `renderPaths` gate). `measureRender.js` matches the `src/js/*Render.js` pattern already
listed in `.claude/project.json` → `autoMerge.renderPaths`, so the new render module is covered by
the gate as required. History is injected (never statically imported) to match the existing
no-cycle convention (`setHistoryCommit`).

### Why a new tool mode rather than extending Select

The rail already models mutually-exclusive tools via `wallTool.setTool(t)` with `_tool ∈
{"wall","select"}`. Measure is a third placement mode with its own two-click gesture. Two options
were considered:

- **(A) Extend `wallTool._tool` to include `"measure"`** and route placement clicks through the
  existing draw-hooks path (`interactions.setDrawHooks`). Pro: reuses the draw-pending/tap plumbing
  in `interactions.js` verbatim; Con: `interactions.js` gates that path behind
  `_drawHooks.isDrawMode()`, which is wall-specific, and the wall hooks own the loupe/snap-tag.
- **(B) Add a parallel mode owned by `measureTool.js`** with its own pointer hooks injected into
  `interactions.js`.

**Recommendation: (A)** — extend `wallTool`'s tool enum to `"wall" | "select" | "measure"` and have
`isDrawMode()` stay wall-only, but add a sibling predicate `isMeasureMode()`. `measureTool` registers
its own lightweight pointer hooks (`setMeasureHooks`) in `interactions.js`, parallel to
`setDrawHooks`/`setSelectHooks`. This keeps wall and measure gestures independent (different snap
semantics, no loupe reuse needed) while letting `setTool` remain the single source of truth for
mode + selection-clearing. This is the smallest change that keeps mode arbitration centralized.

### Snapping: reuse, don't reinvent

Endpoint placement resolves through a single helper `resolveEndpointSnap(sx, sy, altHeld)` in
`measureTool.js` that composes existing pure functions, in this precedence (highest first):

1. **Alt held** → raw world point (`screenToWorld`), `type:"free"`. (Consistent with LLD 26/34.)
2. **Object corner / center** — from `symbols.model` via `corners(sym)` and `aabb(sym).{cx,cy}`,
   nearest within `SNAP_PT_PX` screen px. Gated by the persistent snap toggle (`prefs.gridSnap()`).
3. **Wall vertex** — nearest room/chain vertex within `SNAP_PT_PX` (reuse
   `walls.closestEndpoint(sx, sy, walls.allVertices(), null, SNAP_PT_PX)`).
4. **Wall edge** — nearest point ON a wall segment within `SNAP_PT_PX`, using `wallSegments()` +
   a project-to-segment helper (`pointNearRoomWall` is a boolean; we need the projected point, so
   `measureTool` adds a small `_projectToSegment(px,py,a,b)` local, or reuses the projection math
   already in `pointNearRoomWall`). Gated by snap toggle.
5. **Grid** — `gridSnap(raw, snapStep())` when `prefs.gridSnap()` and `snapStep() != null`,
   `type:"grid"`.
6. **Free** — raw world point, `type:"free"` (snap off, or nothing in range).

Vertex/corner/edge snaps are **ungated by grid** in the sense that they win over grid when in
range, but the whole snap stack (except Alt) is short-circuited to raw when the persistent snap
toggle is OFF — matching how `symbolTool._resolvePlacement` treats `prefsGridSnap()`. Alt always
forces free regardless of toggle.

The resolved snap returns `{ x, y, type }` where `type ∈ "corner"|"center"|"vertex"|"edge"|"grid"|
"free"` — used only to color the cursor snap-tag; **the stored endpoint is always the plain
`{x,y}`** (fixed world coords), never an anchor reference.

### History: measurements must join the snapshot

`history.js` currently snapshots only `{ rooms, symbols }`. Add/delete of a measurement will not be
undoable unless the snapshot includes measurements. **Required change**: extend `GeomSnapshot` to
`{ rooms, symbols, measurements }`, and have `_capture()` / `_apply()` include
`measurementsModel.measurements` via `hydrateMeasurements`. This is additive and preserves the
existing dirty-check (JSON stringify) behavior. Each measurement add and each delete calls the
injected `history.commit()` exactly once; the dirty-check no-ops a cancelled/no-op gesture.

### Rendering

`measureRender.render()` is a full idempotent redraw registered via `onRender`. It draws into a
dedicated SVG group and appends distance chips to the shared `.dim-labels` layer (append-only,
same contract as `symbolRender`). Because it reads `unit` at draw time via `fmtLen`, the existing
`onUnitChange(scheduleRender)` wiring in `main.js` makes labels react live to the unit toggle with
no extra code. A new SVG group `#measures` is added to `index.html` between `#symbols` and
`#symbol-overlay` (below the symbol selection overlay, above walls). The in-progress rubber-band
preview is drawn by the same module from `measureTool`'s injected draft-state getter.

## Interfaces / Types

### `measurements.js` — new mutators (additive; pure, Node-loadable)

```js
/** @typedef {{ x:number, y:number }} Endpoint */          // existing (anchor reserved for #93)
/** @typedef {{ id:string, a:Endpoint, b:Endpoint }} Measurement */  // existing

/** Build a Measurement with a fresh id from two fixed world points. Does NOT add it. */
export function createMeasurement(a, b);        // → Measurement  (uses newId())

/** Append a measurement to model.measurements (mirrors addSymbol). */
export function addMeasurement(m);              // → void

/** Remove by id; returns true if removed (mirrors removeSymbol). */
export function removeMeasurement(id);          // → boolean

/**
 * Hit-test: nearest measurement whose segment passes within tolWorld of (wx,wy).
 * Last match wins on ties (topmost draw order), mirroring pickSymbol.
 * Pure geometry; screen-tolerance conversion is the caller's job.
 */
export function pickMeasurement(wx, wy, tolWorld);  // → Measurement | null
```

`pickMeasurement` uses point-to-segment distance (same math as `pointNearRoomWall`), operating in
world metres; the caller passes `tolWorld = (MIN_HIT_PX/2) / pxPerM()`.

### `measureTool.js` (new)

```js
export function init(refs);                 // { stage, btnMeasure, snapTag }
export function setHistoryCommit(fn);       // inject history.commit (no cycle)
export function setToolBridge(fns);         // { setTool, isMeasureMode } from wallTool

// Mode-aware pointer hooks injected into interactions.js (parallel to draw/select hooks)
export function onMeasureDown(sx, sy);      // place A or commit B; returns void
export function onMeasureMove(sx, sy);      // update rubber-band preview + snap-tag
export function onMeasureLeave();           // clear hover preview

// Selection integration (called by the main.js Select dispatcher)
export function onSelectDown(sx, sy);       // → boolean (true if a measurement was hit)
export function clearSelection();           // drop measurement selection (mutex)
export function hasSelection();             // → boolean
export function deleteSelected();           // remove + commit + "Deleted" toast w/ Undo
export function onDrawModeEnter();          // clear selection on mode switch

// Getters for measureRender
export function getSelectedId();            // → string | null
export function getDraft();                 // → { a:{x,y}, cursor:{x,y}, snapType } | null
```

### `wallTool.js` — extend tool enum (surgical)

```js
/** @type {"wall"|"select"|"measure"} */ let _tool = "wall";
export function isMeasureMode() { return _tool === "measure"; }
// setTool: when leaving "wall", still auto-finish chain; "measure" clears wall snap + selections.
```

### `interactions.js` — new hook set (parallel to setDrawHooks/setSelectHooks)

```js
/** @type {{ isMeasureMode:()=>boolean, onDown, onMove, onLeave } | null} */
let _measureHooks = null;
export function setMeasureHooks(h);
```

In `_onPointerDown`/`_onPointerMove`/`_onPointerEnd`, gate on `_measureHooks.isMeasureMode()` before
the draw-mode branch. A measure-mode single-pointer down that does not exceed the drag threshold is
a **tap** → `onMeasureDown`; exceeding the threshold starts a pan (does not place a point). Plain
hover (buttons===0) → `onMeasureMove` to drive the rubber-band. Mirrors the wall draw-pending logic.

### `measureRender.js` (new)

```js
export function init(gMeasures, dimLabels, getSelectedId, getDraft);
export function render();   // onRender hook; MUST run after wallRender (dim-labels append contract)
```

### `history.js` — extend snapshot (required)

```js
// _capture(): add  measurements: JSON.parse(JSON.stringify(measurementsModel.measurements))
// _apply():   add  hydrateMeasurements({ measurements: cloned.measurements })
```

## State Model

**Persisted (in the plan; already wired by LLD 81):**
- `measurements.model.measurements: Measurement[]` — fixed world-coordinate endpoint pairs.
  Serialized by `plan.buildPlan`/`buildCompact`, validated by `validatePlan`/`parseCompact`,
  rendered in export by `exportImg`, autosaved by `store.js`. No changes needed to those paths.

**Session-only (in `measureTool.js`, never persisted):**
- `_tool` state lives in `wallTool` (`"measure"`); mode is not persisted.
- `_draft: { a:{x,y}, cursor:{x,y}, snapType } | null` — in-progress measurement after the first
  click; `null` before A and after B commits or Escape.
- `_selectedId: string | null` — currently selected measurement (Select mode).
- `_altHeld: boolean` — Alt modifier for free snap (tracked like symbolTool/roomTool).

**Undo/redo:** `history.js` snapshot now includes measurements. Add commits after
`addMeasurement`; delete commits after `removeMeasurement`. Boot-restore / template-apply reseed
the baseline via `historyReset()` (unchanged).

### Lifecycle of a placement gesture

1. Enter Measure mode (rail button / shortcut) → `_draft = null`, wall + symbol + room selections
   cleared.
2. First tap → `resolveEndpointSnap` → `_draft = { a: snapped, cursor: snapped, snapType }`.
3. Hover/move → update `_draft.cursor` + snapType; `measureRender` draws rubber-band A→cursor.
4. Second tap → `b = resolveEndpointSnap`. If `dist(a,b) < MIN_LEN_M` → discard (no commit),
   keep `_draft = null` (Edge Case 4). Else `addMeasurement(createMeasurement(a,b))`,
   `history.commit()`, `_draft = null`, `scheduleRender()`.
5. Escape at step 3 → `_draft = null`, no commit, `scheduleRender()`.

## Edge Cases

1. **Escape before B** — cancel in-progress measurement; no annotation created. Handled in
   `measureTool` keydown; must run before `main.js` global Escape (which handles symbol deselect).
   Guard order: if `isMeasureMode() && _draft` → cancel + `stopPropagation` so main.js does not also
   act. If measure mode but no draft, Escape is a no-op (does not exit the tool).
2. **Zero-/tiny-length measurement** — second point within `MIN_LEN_M` (reuse `MIN_SEG_M` = wall
   min-seg, or a dedicated small constant) of A → discard, no commit, draft stays cleared. Prevents
   degenerate labels and accidental double-tap zero-length lines.
3. **Snap toggle OFF** — only grid is suppressed; Alt still forces raw; when snap is off, vertex/
   corner/edge snaps are also suppressed (raw placement) to match `symbolTool` behavior where the
   whole align/grid stack is gated by `prefsGridSnap()`. Wall-vertex snapping being gated is a
   deliberate simplification for consistency; revisit only if QA finds it surprising.
4. **Second finger / gesture cancel mid-placement** — `interactions.js` `_gestureCancelled` path
   must call `onMeasureLeave()` (clears hover) but must NOT discard `_draft` (A is already
   committed to the draft; the user can still place B). A pinch does not lose point A.
5. **Delete in Select mode** — `main.js` global Delete handler consults measure selection. Priority
   with symbol/room: measurement delete only fires when `measureTool.hasSelection()` and neither a
   symbol nor room is selected (selections are already mutually exclusive; see Dependencies). Add
   `measureTool` to the mutex set so selecting a measurement clears symbol+room and vice-versa.
6. **Selecting a measurement whose line overlaps a symbol/room** — dispatcher order: symbol → room
   → measurement (measurements are thin annotations; giving them lowest priority avoids stealing
   taps from furniture). Documented; revisit if users report they cannot grab an overlapping line.
7. **Switching tools mid-draft** — leaving Measure mode via rail/shortcut with an open `_draft`
   discards the draft (no commit), mirroring wallTool auto-finish-but-discard-if-incomplete.
8. **Unit toggle with a measurement selected / mid-draft** — labels re-render via
   `onUnitChange(scheduleRender)`; draft preview label also updates. No stored data changes (world
   metres are canonical).
9. **Undo of an add while a new draft is in progress** — draft is session-only and not in the
   snapshot, so undo/redo never disturbs it (parallel to history excluding `model.chain`).
10. **Empty-plan export / share with only measurements** — `isEmptyPlan()` currently checks rooms/
    chain/symbols only, so a plan with only measurements reports "empty" (empty-CTA shows). This is
    pre-existing LLD 81 behavior; **out of scope** to change here. Note for follow-up.
11. **Coarse pointer (touch) hit target** — use `MIN_HIT_PX = isCoarsePointer ? 44 : 12` for line
    hit-testing and snap radius, matching `symbolTool`.

## Dependencies

Must exist before implementation (all present on `main`):
- **LLD 81** measurements model + persistence (`measurements.js`, `plan.js`, `exportImg.js`, MCP).
  `plan.js`/`exportImg.js` already serialize/render measurements — **no change** there.
- **LLD 63** Select dispatcher in `main.js` (`setSelectHooks`, symbol/room mutex,
  `_activeSelectOwner`). This LLD extends the dispatcher to a third owner `"measure"` and wires the
  mutex so `symClearSelection` / `roomClearSelection` / `measureClearSelection` stay exclusive.
- **`walls.js`**: `resolveSnap`, `gridSnap`, `closestEndpoint`, `allVertices`, `wallSegments`,
  `pointNearRoomWall`, `WALL_M`, `MIN_SEG_M`.
- **`symbols.js`**: `model`, `corners`, `aabb`.
- **`grid.js`** `snapStep`, `onSnapModeChange`; **`prefs.js`** `gridSnap` (persistent toggle).
- **`units.js`** `fmtLen`, `unitLabel`, `onChange`.
- **`surface.js`** `onRender`, `scheduleRender`; **`interactions.js`** hook injection.
- **`history.js`** — **modified by this LLD** to snapshot measurements.
- **`index.html`** — add `#measures` SVG group + a `#tool-measure` rail button.

Required edits to shared files (surgical):
- `history.js`: snapshot + apply measurements (see Interfaces).
- `main.js`: import + init `measureTool`/`measureRender`; register `measureRender.render` on
  `onRender`; wire `setMeasureHooks`; extend Select dispatcher + Delete/Escape handlers + mutex; add
  rail button + `M` shortcut.
- `wallTool.js`: `_tool` enum + `isMeasureMode` + `setTool` handling of `"measure"`.
- `interactions.js`: `setMeasureHooks` + measure-mode pointer branch.
- `index.html`: `#measures` group, `#tool-measure` button (SVG icon + `M` key hint).

## Frontend Design

Decision: proceed with recommendations.

- **Rail button.** Insert `#tool-measure` after `#tool-wall`, before the `tool-rail-sep`. Reuse the
  existing rail button structure (16×16 SVG icon + `.tool-key-hint` = `M`, `aria-label="Measure
  tool (M)"`, `aria-pressed`). Icon: a dimension line with end ticks and a small caliper feel
  (e.g. `<line>` with two short perpendicular end serifs). `setTool` toggles `aria-pressed` across
  select/wall/measure so exactly one is active; `_updateToggleIcon` mirrors the active icon into the
  collapsed-rail toggle (extend its `activeBtn` selection to include measure).
- **Dimension line rendering.** Solid stroke in `palette().dim` (same token used by `exportImg`
  measurement lines and wall dim chips, for visual consistency), `stroke-width` ~1.5, round caps.
  End ticks: short perpendicular serifs (~6 screen px) at A and B. Distance label: a `.dim-labels`
  HTML chip centered at the segment midpoint, offset perpendicular to the line so it does not sit
  on top of the stroke; text = `fmtLen(dist) + " " + unitLabel()`. Chip reuses the `.dim-chip`
  class for typographic consistency (but is non-editable in this phase — no click-to-edit).
- **Rubber-band preview.** Dashed line (`stroke-dasharray "5 3"`, `palette().dim` at ~0.7 opacity)
  from A to the current snapped cursor, with a live distance chip. Endpoint snap indicator: a small
  filled dot at the snapped point colored by snap type (reuse palette tokens: `snapPoint` for
  vertex, `alignCenter`/`snapTeal` for center, `snapGrid` for grid, `muted` for free), mirroring
  the wall snap-tag and symbol snap dot conventions.
- **Snap-tag.** Reuse the shared `.snap-tag` cursor label (as wall/symbol do) showing the snap type
  word while in Measure mode. `measureTool` owns the tag during its gesture; hide on leave.
- **Selected state.** Selected measurement: thicken stroke to ~2.5 and recolor to `palette().gold`
  (the selection accent used for symbols), and draw small square handles at A and B (non-interactive
  this phase — purely a visual affordance). No inspector popover in this phase; deletion is via
  Delete key or (optional) a small floating delete affordance — recommend Delete-key-only to keep
  scope tight and match "each delete is one commit".
- **Help / shortcuts overlay.** Adding `M` = Measure is trivial (one row in the shortcuts list and
  the `M` key hint on the rail button). Include it. Escape-to-cancel is documented in the same row.
- **Empty/degenerate feedback.** A discarded tiny second point (Edge Case 2) gives no toast (silent,
  like the wall zero-length guard). Cancelling via Escape gives no toast.

## Test Requirements

**Unit — `measurements.js` mutators (Node, mirrors `symbols` tests):**
- `createMeasurement` mints unique ids via `newId`; does not mutate model.
- `addMeasurement` / `removeMeasurement` add/remove by id; `removeMeasurement` returns
  true/false correctly; id counter never collides after `hydrate`.
- `pickMeasurement` returns the nearest segment within tolerance; null when out of tolerance;
  last-match-wins on overlapping candidates; point-to-segment distance correct for endpoints and
  interior projection.

**Unit — snap resolution (`measureTool.resolveEndpointSnap`, via a test wrapper like
`resolvePlacementForTest`):**
- Alt → raw/free regardless of toggle.
- Grid snap when toggle on and nothing else in range; raw when toggle off.
- Wall vertex, wall edge, object corner, object center each win over grid when within radius;
  documented precedence honored.
- Snap toggle OFF suppresses vertex/corner/edge/grid (Alt still free).

**Unit — history integration:**
- Snapshot now includes measurements; add then undo restores prior measurement set; redo re-adds;
  delete then undo restores; dirty-check no-ops an unchanged commit.

**Integration — placement + selection + delete (headless DOM / existing harness):**
- Two taps create one measurement with the expected endpoints (snapped); rubber-band draft exists
  after first tap and clears after second.
- Escape after first tap creates nothing.
- Tiny second tap (< MIN_LEN_M) creates nothing.
- Select mode: tap on a measurement line selects it (shows selected state); Delete removes it and
  is undoable/redoable; symbol/room selection unaffected by measure selection and vice-versa
  (mutex).
- Unit toggle updates the label text of both committed and draft measurements.

**Persistence round-trip (extend existing LLD 81 tests where practical):**
- Create measurements → autosave → reload restores them (localStorage).
- Share hash encode/decode round-trips created measurements (compact codec already covers `m`).
- SVG/PNG export includes the measurement line + label (exportImg path already covers it; assert a
  created measurement appears).

**Regression:**
- Existing wall/symbol/room selection, draw, undo/redo, and `node .github/run-tests.mjs` +
  `mcp` `node --test` suites still pass. No build step introduced (pure HTML/CSS/JS).
</content>
</invoke>
