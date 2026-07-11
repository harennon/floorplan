# LLD 63: Room editing — move a whole room + rectangle-preserving resize

Builds on / must not silently contradict: LLD 04 (wall drawing / `resolveSnap` / `model.rooms`),
LLD 09 (dimension chips + inline `rescaleEdge` edit via `dimEntry.js`), LLD 21 (undo/redo
snapshot model, delete/duplicate, select tool), LLD 32 (MCP core boundary; `set_edge_length`
footgun note), LLD 34/60 (symbol select+drag interaction the room path mirrors), LLD 37
(`roomCentroids`), LLD 24 (`pointInRoom` in `clearance.js`). Effort: medium.

**Why two capabilities in one LLD:** both are the "edit a room I already drew" user story, and
both are blocked by the same missing primitive — there is no room-selection concept and no
shape-preserving room geometry. Capability A (move) needs room selection; Capability B (resize)
needs rectangle geometry; they share the pure-geometry additions in `walls.js` and the same
render/undo plumbing, so splitting them would duplicate the wiring.

## Scope

Two capabilities on the existing `model.rooms` polygons, both reachable from the existing
**Select** tool (`_tool === "select"` in `wallTool.js`):

**Capability A — Move a whole room.** Click/tap a room's interior to select it, then drag to
translate every vertex rigidly (shape preserved). **Furniture whose center is inside the room
polygon moves with it** (decision + rationale below). One undo entry per drag, mirroring symbol
move-drag.

**Capability B — Rectangle-preserving resize.** When the room being dimension-edited is a
rectangle, setting a wall's length via the existing dim-chip inline editor (`dimEntry.js`) grows or
shrinks the room **along that wall's direction** — anchoring one end of the edited wall and sliding
the far perpendicular wall — so the edited wall becomes the typed length and **all four angles stay
90°**, instead of the current single-corner shear into a parallelogram. Non-rectangular rooms keep
the existing `rescaleEdge` behaviour unchanged.

**In scope**

- Room selection model: a `_selectedRoomId` in a new interaction owner, hit-tested against
  closed-room interiors, coexisting with symbol selection under the one Select tool.
- Pure geometry in `walls.js` (Node-clean, DOM-free): `moveRoom(room, dx, dy)`,
  `isRectangle(room)`, `rescaleRectEdge(room, edgeIndex, targetLenM)`.
- Room move-drag: grid snap (obeys the persistent snap toggle) + one history commit per gesture,
  including carried-furniture translation.
- Rectangle detection routing inside `dimEntry.commit()`: rectangle → `rescaleRectEdge`,
  otherwise → existing `rescaleEdge` (contract preserved).
- Min-size guard reusing `MIN_SEG_M`.
- Render: a room-selection outline, and (unchanged) inspector-free interaction — no new inspector.
- New unit + integration tests.

**Explicitly NOT in scope**

- **A `resize_room`/`move_room` MCP tool.** The new pure functions are designed to be surfaced by
  the MCP server later (`mcp/src/tools.js`), but adding MCP tools, brief-oracle changes, or
  `set_edge_length` behaviour changes is a **follow-up** (see Dependencies). This LLD does not
  touch `mcp/`.
- **A separate "set room to W×H" dialog/box.** Considered and rejected as primary (see Approach);
  the dim-chip edit is the gesture users already reach for. A W×H affordance can be a later LLD.
- **Rotating a room, per-vertex/corner dragging, or edge (single-wall) dragging.** Room edit here
  is whole-room translate + rectangle dimension resize only.
- **Making a non-rectangular (L-shaped/freehand) room resize "keep its shape."** There is no
  general shape-preserving resize; non-rectangles retain today's single-corner `rescaleEdge`.
- **Snapping a moved room to other rooms / walls** (only grid snap). Object/room-center alignment
  is a symbol-placement feature (LLD 34/37); extending it to room drag is deferred.
- **Multi-room selection / marquee.** Single room at a time.
- **Open polylines** (`room.closed === false`): not selectable for move; resize path unchanged.

## Approach

### Module boundary (respect the MCP Node-clean rule)

`walls.js` and `clearance.js` are imported by the MCP server via `mcp/src/core.js` and MUST stay
DOM-free / Node-clean. So the split is:

- **Pure geometry → `walls.js`** (new, DOM-free, testable, importable by MCP later):
  `moveRoom`, `isRectangle`, `rescaleRectEdge`. `pointInRoom` already lives in `clearance.js`
  (also Node-clean) and is reused for both room hit-test and furniture-carry.
- **Interaction / DOM → a new `roomTool.js`** (mirrors `symbolTool.js`): owns `_selectedRoomId`,
  the move-drag gesture, grid snapping, history commit, and the selection outline plumbing.
  Imported only by `main.js`, never by `mcp/`.
- **Dimension-edit routing → `dimEntry.js`** (already a DOM/interaction module, already on the
  auto-merge `renderPaths` list): the rectangle-vs-general decision happens in `commit()`, calling
  the appropriate pure function.

This keeps the geometry primitives pure and MCP-surfaceable while all pointer/DOM code stays in the
tool layer, exactly as LLD 34/60 did for symbols.

### Where the move gesture lands (reuse the select-hook plumbing)

`interactions.js` already routes single-pointer gestures in select mode through injected
`_selectHooks` (`onDown → onMove → onUp`, or `onTapEmpty`). `onDown` returns a boolean: `true`
consumes the gesture (suppresses pan). Today `main.js` wires those hooks **directly** to
`symbolTool` (`setSelectHooks({ onDown: onSelectDown, … })`).

We insert a thin **dispatcher** in `main.js` so both symbol and room selection share the one Select
tool, with **symbols winning ties** (they sit on top of rooms and are the finer target):

```
onDown(sx,sy):  symbolTool.onSelectDown(sx,sy)  // symbol/handle hit?
                  → roomTool.clearSelection()     // MUTEX: drop any room selection
                    consume as "symbol"
                  : roomTool.onSelectDown(sx,sy) // else room interior hit?
                    (roomTool clears the symbol selection on its own success — see below)
                    consume as "room" / else not consumed
onMove(sx,sy):  route to whichever consumed (symbolTool xor roomTool)
onUp(sx,sy):    route to whichever consumed
onTapEmpty():   symbolTool.onTapEmpty(); roomTool.onTapEmpty()  // clear both selections
```

**Selections are mutually exclusive (fixes the Delete/nudge/duplicate footgun).** `symbolTool` and
`roomTool` each hold their own selection id, and `interactions.js` `onDown` returning `false` on a
symbol *miss* does NOT clear `symbolTool._selectedId` (it just `return false` at `symbolTool.js:244`).
So without a mutex, "select a chair, then click bare floor to select the room" would leave BOTH
selected — and `main.js`'s global editing shortcuts (`Delete`, arrows, `Ctrl+D`) check
`symbolTool.hasSelection()` first, so they would act on the invisible chair, not the visible room
(silent data loss). The dispatcher enforces the invariant **"at most one of {symbol, room} is
selected"**:

- On a symbol hit: dispatcher calls `roomTool.clearSelection()` before/at consume, so picking a
  symbol drops any room selection.
- On a room hit: `roomTool.onSelectDown` **itself** calls the injected `clearSymbolSelection()`
  (wired from `main.js`, same injection pattern as history/toast) on its success path, so picking a
  room drops any symbol selection.

Because only one id is ever non-null, the two selection VISUALS are automatically mutually exclusive:
the symbol inspector/handles render off `symbolTool.getSelectedId()` and the room dashed outline
renders off `roomTool.getSelectedRoomId()`; clearing one to `null` removes its visual on the next
render. The `main.js` shortcut handlers are unchanged (still symbol-first) but are now safe because
the invisible-selection state can no longer occur.

The dispatcher tracks which owner consumed the current gesture (`_activeSelectOwner`) so moves/up
go to the right one. This is the minimal change that lets rooms and symbols coexist without
`interactions.js` learning about either module (it stays import-free of both).

**Why the Select tool, not a new tool/mode or long-press.** A new rail tool adds chrome and a mode
users must discover; long-press collides with the touch-draw loupe timing (LLD 46/57). The Select
tool already means "manipulate what's on the canvas," already clears on `W`/draw-mode entry, and
already has the pan-suppression plumbing. Clicking a room interior in Select mode is the natural
gesture and mirrors clicking a symbol.

### Decision A1 — does furniture inside the room move with it? **YES (option b): carry symbols
whose center is inside the room polygon.**

Options weighed:
- **(a) walls only** — cheapest, but moving "the bedroom" and leaving the bed behind is
  surprising and defeats the point (the plan visibly breaks; user must re-drag every piece).
- **(b) walls + symbols whose center ∈ room polygon** — matches intent ("move the room"),
  cheap (one `pointInRoom` test per symbol at drag start), and reuses an existing pure function.
- **(c) user choice (modifier / prompt)** — most flexible but adds UI/among-modes complexity the
  project's minimal-chrome principle resists; no evidence users want walls-only.

**Chosen: (b).** Rationale: highest intent-match for the "sketch my studio, move the bedroom over"
story; symbols are positioned by absolute center (`sym.x/sym.y`), so carrying them is a pure
translate by the same `(dx, dy)` — no new parent-link field, nothing new persisted. Membership is
computed **once at drag start** (snapshot the set of carried symbol ids using
`pointInRoom(room, sym.x, sym.y)`), not per-frame, so a symbol that starts inside stays attached
for the whole drag even if the room briefly slides off it, and a symbol that starts outside is
never grabbed mid-drag.

**Known limitation this decision inherits (surfaced to QA, not buried):** doors/windows are
`model.symbols` whose centers sit essentially **on** the wall (≈ 0.06 m off the centerline), and
`pointInRoom` is not reliable for on-boundary points — so a room's own door may or may not be judged
inside and carried. Well-inside furniture (beds/sofas/tables) carries reliably; boundary-hugging
openings are the coin-flip case. This is promoted to an explicit **"Known limitation for QA"**
callout in Frontend Design (with the observable symptom + v1 workaround) and Edge Case 6. Boundary-
aware door attachment is out of scope for v1.

**Migration note (if ever deferred to walls-only):** because carry is computed from geometry at
drag start and never persisted, switching to walls-only (or to option (c)) is a localized change in
`roomTool` with zero data-model or persistence impact. No `roomId` back-link is introduced, so no
migration of saved plans is required either way.

### Decision A2 — snapping + commit for room move

- **Grid snap, obeying the persistent snap toggle** (`prefs.gridSnap()` + `grid.snapStep()`), same
  authorities symbol drag uses. We snap the **dragged reference vertex** (`room.verts[0]`) to the
  grid and translate all vertices by the resulting delta, so a grid-aligned room stays grid-aligned
  after a move. When the toggle is off or `snapStep()` is `null`, the room follows the pointer
  freely (Alt also forces free, matching the symbol path). **No** object/room-center alignment for
  rooms (out of scope) — only grid.
- **One history commit per drag**, on `onSelectUp`, exactly like `symbolTool.onSelectUp`. The
  `history.commit()` dirty-check already no-ops a zero-distance drag. Because the history snapshot
  deep-clones **both** `rooms` and `symbols` (confirmed in `history.js` `_snapshot`), a single undo
  reverts the room translation **and** the carried-furniture translation together — no special
  handling needed.

### Decision B1 — resize model: **keep the dim-chip inline edit as the primary gesture; branch on
shape inside `commit()`.**

The user's exact complaint is that typing a new length on a rectangle edge shears it. That gesture
(click chip → type length → Enter, in `dimEntry.js`) is the one to fix, not replace. A separate
"set room to W×H" box is *more explicit* but is a second affordance to build/teach and does not fix
the gesture users already try. So:

- **Primary:** `dimEntry.commit()` decides, per the edited room's shape, which geometry to apply.
  No new UI, no new chip, no new control. The dim chip, its positioning, unit parsing, no-op
  round-trip check, and error handling are all unchanged.
- A W×H box is explicitly deferred (see NOT in scope) as a possible later explicit affordance.

### Decision B2 — rectangle detection + non-rectangular routing (the hard question)

`rescaleEdge` is general and correct for arbitrary polygons (including L-shapes and open
polylines); it must NOT change for shapes where it is the right tool (its MCP `set_edge_length`
contract depends on it). So we **add** a rectangle-only path and route to it only when the room
provably is an axis-agnostic rectangle:

**`isRectangle(room)` — true iff ALL of:**
1. `room.closed === true`.
2. Exactly 4 vertices (`verts.length === 4`).
3. All four interior corner turns are right angles within tolerance: for each corner, the dot
   product of the two adjacent edge unit vectors is ≈ 0 (`|cosθ| ≤ RIGHT_ANGLE_COS_TOL`, with
   `RIGHT_ANGLE_COS_TOL = cos(85°) ≈ 0.087`, i.e. within 5° of square — consistent with the ~5°
   axis tolerances already used in `symbolTool`). This is rotation-agnostic (a rectangle drawn at
   an angle still qualifies) and, together with the 4-vertex + closed checks, is sufficient: four
   right angles force opposite sides parallel and equal.
4. Non-degenerate: no edge shorter than `MIN_SEG_M` (guards a "rectangle" collapsed to a line).

**Routing in `commit()`:**

| Room shape (edited) | Function applied | Result |
| --- | --- | --- |
| `isRectangle(room)` true | `rescaleRectEdge(room, edgeIndex, targetLenM)` | Edited edge grows/shrinks to L; the far side slides along the edge direction; stays a rectangle (no shear). |
| Not a rectangle (L-shape, triangle, 5+ verts, open polyline, non-right angles) | `rescaleEdge(room, edgeIndex, targetLenM)` (unchanged) | Existing single-corner behaviour. |

**What happens for a NON-rectangular room:** we deliberately keep the old single-corner
`rescaleEdge` — it is the correct primitive there (the whole point is it does not assume
rectangularity), and silently "moving the whole edge" on an L-shape would still deform the shape in
a different, equally-surprising way. Because a non-rectangular edit behaves **exactly as today (no
regression)**, no new user signal is added (the once-per-session toast considered in an earlier
draft is dropped — see Frontend Design / non-blocking notes). The routing is purely geometric.

**`rescaleRectEdge(room, edgeIndex, targetLenM)` geometry (corrected).** Mental model: **anchor the
near corner, slide the far wall along the edited edge's own direction.** An edge's length is a
function of *its own two endpoints*, so to change `|eK|` we MUST move one of `eK`'s endpoints — the
earlier "keep both endpoints of `eK` fixed and move the opposite edge" model was arithmetically
impossible (it left `|eK|` unchanged and sheared the shape into the very parallelogram this fixes).

For a 4-vertex closed rectangle with vertices `v0..v3` in order and edges `ei = vi → v(i+1 mod 4)`,
to set the clicked edge `eK` to length `L`:

1. Anchor `vK` (the first vertex of `eK`) — it does not move.
2. `u = unit( v(K+1) − vK )` — the current direction of `eK` (preserved; we only change length).
3. `shift = u * ( L − |eK| )` where `|eK| = dist(vK, v(K+1))`.
4. Move **`v(K+1)` and `v(K+2)`** each by `shift`. (`vK` and `v(K+3)` stay fixed.)

Why this is correct and stays a rectangle:
- `v(K+1)` — the far endpoint of the edited edge — moves along `u`, so the new `|eK| = L` exactly,
  and `eK`'s direction is unchanged.
- `v(K+1)` and `v(K+2)` move by the *same* vector, so edge `e(K+1)` (the far perpendicular wall,
  connecting the two moved vertices) is translated rigidly — same length, same direction.
- `v(K)` and `v(K+3)` are fixed, so the near perpendicular wall `e(K+3)` is untouched.
- The parallel opposite edge `e(K+2)` = `v(K+2)→v(K+3)` therefore also becomes length `L` and stays
  parallel to `eK`. All four right angles are preserved.

Worked check (the reviewer's counterexample, now passing): `v0=(0,0) v1=(4,0) v2=(4,3) v3=(0,3)`,
edit `e0` (`|e0|=4`) to `L=6`. `u=(1,0)`, `shift=(2,0)`. Move `v1,v2` → `v1=(6,0) v2=(6,3)`. Result
`|e0|=6`, `|e2|=6` (opposite, parallel), `|e1|=|e3|=3` (perpendicular, unchanged), all corners 90°.

- The dim chip on `eK` displays `|eK|`; the user's intent "this wall is now `L` long" applies to the
  clicked edge, and step 3 sets exactly that edge. The two perpendicular side walls keep their own
  lengths; the room grows/shrinks only along `u`.
- Returns `false` (no-op) on `targetLenM < MIN_SEG_M`, `!isRectangle(room)` (caller already checks,
  but the function self-guards for MCP-later safety), or `edgeIndex` outside `[0,3]`.

### Where the changes land

| File | Change | On auto-merge `renderPaths`? |
| --- | --- | --- |
| `src/js/walls.js` | +`moveRoom`, +`isRectangle`, +`rescaleRectEdge` (pure) | No (must stay Node-clean) |
| `src/js/roomTool.js` | **new** interaction owner (select/drag rooms, carry furniture, grid snap, commit) | No (new file, not a `*Render.js`) |
| `src/js/roomRender.js` OR extend `wallRender.js` | selection outline for `_selectedRoomId` | `wallRender.js` is not on the list, but it is render code — see note |
| `src/js/dimEntry.js` | branch `commit()` on `isRectangle` | **Yes** (`dimEntry.js` explicitly listed) |
| `src/js/main.js` | select-hook dispatcher, init `roomTool`, wire history/toast, render hook | No (but touches editor wiring) |

Selection outline: extend `wallRender.js` with a **distinct** selection treatment, kept separate
from the measure-hover `highlighted` boolean so "selected" and "hovered" read differently (see
non-blocking note in Frontend Design). Add a second injected getter `getSelectedRoomId` and, when it
matches the room, draw a dashed selection outline (spec in Frontend Design) *in addition to* the
existing render — do NOT reuse/OR the solid `highlighted` fill, which is reserved for measure hover.
This keeps room rendering in the one place. See Frontend Design for the exact visual and the
auto-merge implication.

## Interfaces / Types

### `src/js/walls.js` — new pure functions (DOM-free, MCP-surfaceable)

```js
/**
 * Translate every vertex of a room by (dx, dy) world metres. Rigid — shape,
 * angles, and edge lengths are all preserved. Mutates room.verts in place.
 * No-op-safe on dx===0 && dy===0. Works for closed and open rooms.
 * @param {Room} room
 * @param {number} dx  world metres
 * @param {number} dy  world metres
 */
export function moveRoom(room, dx, dy) { /* verts.forEach(v => { v.x+=dx; v.y+=dy }) */ }

/** Right-angle tolerance: |cos(theta)| below this counts as square (~5° of 90°). */
export const RIGHT_ANGLE_COS_TOL = 0.087; // cos(85°)

/**
 * True iff room is an axis-agnostic rectangle: closed, exactly 4 verts, all four
 * corner turns within RIGHT_ANGLE_COS_TOL of 90°, no edge < MIN_SEG_M.
 * Rotation-agnostic (a tilted rectangle qualifies). Pure.
 * @param {Room} room
 * @returns {boolean}
 */
export function isRectangle(room) { /* ... */ }

/**
 * Rectangle-preserving edge resize. Sets edge K=`edgeIndex` (vK→v(K+1)) to length
 * `targetLenM`, keeping all four angles at 90°. Mutates room.verts in place.
 *
 * Algorithm: anchor vK; u = unit(v(K+1) − vK); shift = u * (targetLenM − |eK|);
 * move v(K+1) AND v(K+2) by shift (vK and v(K+3) stay fixed). This changes the
 * edited edge's own length (its far endpoint moves), rigidly translates the far
 * perpendicular wall, and keeps the shape a rectangle. Verts are (mod 4).
 *
 * Self-guards for MCP-later safety: returns false (no-op) if !isRectangle(room),
 * targetLenM < MIN_SEG_M, or edgeIndex out of [0,3]. Returns true on success.
 * @param {Room} room
 * @param {number} edgeIndex  0..3
 * @param {number} targetLenM
 * @returns {boolean}
 */
export function rescaleRectEdge(room, edgeIndex, targetLenM) { /* ... */ }
```

`rescaleEdge` is **unchanged** (its single-corner contract is depended on by `set_edge_length`).

### `src/js/roomTool.js` — new interaction owner (mirrors `symbolTool.js`)

```js
/** init(refs): binds stage + injected getters; registers no global keydown of its own
 *  (main.js owns editing shortcuts, per LLD 21). */
export function init(refs /* { stage } */) { /* ... */ }

/** history.commit + showToast injected from main.js (avoids circular import), same
 *  pattern as symbolTool.setHistoryAndToast. */
export function setHistoryAndToast(history /* {commit} */, showToast) { /* ... */ }

/** Injected from main.js: clears the SYMBOL selection. Called on roomTool's own
 *  onSelectDown success path to enforce the room↔symbol selection mutex without
 *  roomTool importing symbolTool (avoids a cycle; mirrors the history/toast injection). */
export function setClearSymbolSelection(fn) { /* ... */ }

/** Select-hook: returns true if a CLOSED room interior was hit (consume the gesture),
 *  else false (let pan / symbol path proceed). Called by the main.js dispatcher AFTER
 *  symbolTool.onSelectDown returns false. ON SUCCESS: sets _selectedRoomId, calls the
 *  injected clearSymbolSelection() (mutex), and snapshots carried-symbol ids at down-time. */
export function onSelectDown(sx, sy) { /* returns boolean */ }

/** Drag: translate selected room (+ carried symbols) to follow pointer, grid-snapped. */
export function onSelectMove(sx, sy) { /* ... */ }

/** Finalize drag; history.commit() (dirty-check no-ops a zero-distance drag). */
export function onSelectUp(sx, sy) { /* ... */ }

/** Clear room selection WITHOUT touching symbol selection. Called by the dispatcher on a
 *  symbol hit (mutex: picking a symbol drops the room), and internally by onTapEmpty /
 *  onDrawModeEnter. Idempotent; no-op when nothing selected. */
export function clearSelection() { /* ... */ }

/** Tap on empty canvas: clears room selection (delegates to clearSelection). */
export function onTapEmpty() { /* ... */ }

/** For roomRender / wallRender selection outline: currently selected room id or null. */
export function getSelectedRoomId() { /* returns string|null */ }

/** True when a room is selected (parallels symbolTool.hasSelection). */
export function hasSelection() { /* ... */ }

/** Clear selection when switching to draw mode (parallels symbolTool.onDrawModeEnter). */
export function onDrawModeEnter() { /* ... */ }
```

`symbolTool` needs a matching **`clearSelection()`** export (a rename/alias of its existing private
`_clearSelection()`, which already nulls `_selectedId`, cancels dim edit, and hides the inspector).
The dispatcher calls it on a room hit / and `roomTool` receives it via `setClearSymbolSelection`.
No other `symbolTool` change is required.

### `src/js/dimEntry.js` — `commit()` routing change

```js
// BEFORE (dimEntry.js:198)
import { model, edgeLength, rescaleEdge } from "./walls.js";
...
const ok = rescaleEdge(room, _editing.edgeIndex, targetM);

// AFTER
import { model, edgeLength, rescaleEdge, isRectangle, rescaleRectEdge } from "./walls.js";
...
const ok = isRectangle(room)
  ? rescaleRectEdge(room, _editing.edgeIndex, targetM)
  : rescaleEdge(room, _editing.edgeIndex, targetM);
```

Everything else in `dimEntry.js` (chip binding, positioning, `parseLen`, the no-op
`fmtLen`-equality round-trip check at :191, error flagging, blur/Escape, `_historyCommit()`)
is unchanged. No toast and no `setToast`/`showToast` injection is added to `dimEntry.js` — the
non-rectangular path is behaviourally identical to today, so there is nothing to explain, and adding
an injection into this render-path-gated module is avoided (see non-blocking decisions).

### `src/js/main.js` — select-hook dispatcher (replaces the direct symbol wiring)

```js
// BEFORE (main.js:203)
setSelectHooks({ onDown: onSelectDown, onMove: onSelectMove, onUp: onSelectUp, onTapEmpty });

// AFTER — dispatcher: symbols win ties, else rooms; selections are mutually exclusive
let _activeSelectOwner = null; // "symbol" | "room" | null
setSelectHooks({
  onDown(sx, sy) {
    if (symOnSelectDown(sx, sy)) {
      roomClearSelection();               // MUTEX: picking a symbol drops the room
      _activeSelectOwner = "symbol"; return true;
    }
    if (roomOnSelectDown(sx, sy)) {       // roomTool clears the symbol selection itself,
      _activeSelectOwner = "room"; return true; // via injected clearSymbolSelection()
    }
    _activeSelectOwner = null; return false;   // miss: neither selection changes
  },
  onMove(sx, sy) {
    if (_activeSelectOwner === "symbol") symOnSelectMove(sx, sy);
    else if (_activeSelectOwner === "room") roomOnSelectMove(sx, sy);
  },
  onUp(sx, sy) {
    if (_activeSelectOwner === "symbol") symOnSelectUp(sx, sy);
    else if (_activeSelectOwner === "room") roomOnSelectUp(sx, sy);
    _activeSelectOwner = null;
  },
  onTapEmpty() { symOnTapEmpty(); roomOnTapEmpty(); }, // clear both
});
// Wire the mutex injection so roomTool can drop the symbol selection without importing symbolTool:
roomSetClearSymbolSelection(symClearSelection); // symClearSelection = symbolTool.clearSelection
```

Note: a symbol *miss* that then hits a room does NOT go through `roomClearSelection()`; instead the
`roomOnSelectDown` success path calls the injected `clearSymbolSelection()`. A pure miss (empty
canvas) leaves both selections untouched at `onDown` and is only cleared by `onTapEmpty` if the
gesture ends as a tap. The invariant "≤1 of {symbol, room} selected" holds after every `onDown`.

Also in `main.js`: `initRoomTool({ stage })`; `setHistoryAndToast({ commit: historyCommit }, showToast)`
for `roomTool`; `roomSetClearSymbolSelection(symbolTool.clearSelection)`; call
`roomTool.onDrawModeEnter()` wherever `symbolTool.onDrawModeEnter` is called
(the `#tool-wall` click + `w`/`W` keydown at :206–212); pass `roomTool.getSelectedRoomId` into
`initWallRender` (new arg) for the selection outline.

### Unchanged / reused

- `clearance.pointInRoom(room, x, y)` — room interior hit-test AND carried-furniture membership.
- `view.screenToWorld` / `worldToScreen`, `pxPerM` — screen↔world for hit-test + drag.
- `prefs.gridSnap()`, `grid.snapStep()` — snap toggle + step, identical to symbol drag.
- `history.commit()` — deep-clones rooms + symbols; one call reverts room + carried furniture.
- `symbols.moveSymbol(sym, x, y)` — used to translate each carried symbol by the drag delta.

## State Model

**Persisted (localStorage / URL hash / export):** unchanged shape. Both capabilities mutate
`walls.model.rooms[*].verts` (and, for carried furniture, `symbols.model.symbols[*].x/y`) in
place — the exact arrays `plan.buildPlan()` already serializes. **No new persisted keys.** A moved
or resized room round-trips through `validatePlan` (verts are `{x,y}` finite numbers — already
validated at `plan.js:63-71`) and carried-symbol positions are ordinary `sym.x/sym.y` (validated
at `plan.js:82-91`). The autosave `onRender` hook and share-hash encoder pick the change up with no
change to `plan.js`.

**Session-only, in-memory (never persisted), owned by `roomTool.js`:**

| State | Meaning | Lifetime |
| --- | --- | --- |
| `_selectedRoomId` | id of the currently selected room, or `null` | cleared on tap-empty, draw-mode enter, delete-of-room (N/A here), reload |
| `_dragging` | whether a move-drag is in progress | per gesture |
| `_dragStartRefX/Y` | reference vertex world pos at down + pointer offset | per gesture |
| `_carriedSymbolIds` | ids of symbols whose center was inside the room at drag start | snapshotted at `onSelectDown`, cleared at `onSelectUp` |
| `_dispatcherOwner` (`main.js`) | which select owner consumed the active gesture | per gesture |

Selection is **not** persisted (matches symbol selection, which `symbolTool` also keeps
session-only). A reloaded plan starts with nothing selected.

**History commit lifecycle (extends the LLD 21 table):**

| Gesture | Call site | Notes |
| --- | --- | --- |
| Room move-drag end | `roomTool.onSelectUp` | 1 step; dirty-check no-ops a zero-distance drag. Snapshot includes rooms **and** symbols, so undo reverts the room + all carried furniture in one step. |
| Rectangle resize committed | `dimEntry.commit()` (existing `_historyCommit()` at :208) | 1 step; unchanged call site, now may apply `rescaleRectEdge`. |

**Not commit points (transient):** live drag frames (`onSelectMove`), room selection/deselection,
hover highlight. These match the symbol-drag transience rules.

**Interaction with the persistent grid-snap toggle:** room move uses `prefs.gridSnap()` +
`grid.snapStep()` exactly as symbol drag does — snapping on ⇒ reference vertex snaps to grid;
off / `snapStep()===null` / Alt held ⇒ free follow. Rectangle **resize** does not snap the typed
length to grid (the user typed an exact number; snapping it would fight the input) — this matches
the current `rescaleEdge` behaviour, which applies the parsed value verbatim.

## Edge Cases

**Capability A — move**

1. **Click lands on both a symbol and a room interior.** Symbol wins (dispatcher tries
   `symbolTool.onSelectDown` first). Rationale: symbols sit on top and are the finer target; the
   room is still reachable by clicking interior floor not covered by a symbol.
2. **Click inside an OPEN polyline / a room with < 3 verts.** Not selectable — `onSelectDown`
   returns `false` (only `room.closed` rooms are hit-tested via `pointInRoom`). Pan proceeds.
3. **Overlapping / nested rooms, click in the shared interior.** Hit-test iterates
   `model.rooms` and selects the **last** matching closed room (topmost draw order), mirroring
   `pickSymbol`'s last-wins rule. Deterministic; user can move the outer room away to reach the inner.
4. **Zero-distance drag (tap on a room).** Selects the room (shows outline) and commits nothing —
   the drag delta is 0, `moveRoom` is a no-op, and `history.commit()` dirty-check discards it.
   A pure tap that stays under the drag threshold routes to `onTapEmpty` via `interactions.js`
   (which will re-run `onSelectDown` first, so a tap still selects). Selection is set in
   `onSelectDown`; `onTapEmpty` only clears when nothing was hit.
5. **Second finger during a room drag (touch pinch).** `interactions.js` already finalizes an
   in-flight consumed select gesture at the pre-pinch position (`_selectHooks.onUp` on 2nd pointer)
   and sets `_gestureCancelled`. `roomTool.onSelectUp` therefore commits the room at wherever it
   was — consistent with how symbol drags handle pinch interruption. No half-applied state.
6. **A door/window on the moved room's boundary (carry is unreliable) — KNOWN LIMITATION.** Carry
   membership is `pointInRoom(room, sym.x, sym.y)` on the symbol center. A wall-flush door's center
   sits ≈ 0.06 m off the wall centerline — effectively **on** the polygon boundary — and
   `pointInRoom` (even-odd ray cast) is not guaranteed for on-boundary points (`clearance.js:161`).
   So whether a room's own door travels with it is effectively a per-door coin-flip. **Observable
   symptom:** after moving a room, a door/window may be left behind on the old wall line. **v1
   workaround:** re-select and nudge/drag the stray opening. This is called out as an explicit
   **Known limitation for QA** in Frontend Design (so it is not filed as a bug). Boundary-aware door
   attachment is out of scope for v1. Non-boundary furniture (centers well inside) carries reliably.
7. **Move makes the room overlap another room or push furniture through a wall.** Allowed — the
   editor is a freeform sketcher, not a constraint solver. Clearance annotations (if a symbol is
   selected) recompute on the next render and will flag tight/bad gaps, which is the intended
   feedback, not a block.
8. **Grid-snap on, non-grid-aligned room.** We snap the reference vertex (`verts[0]`) to grid and
   translate all verts by that delta; the room keeps its internal shape but its `verts[0]` lands on
   grid. A room drawn off-grid stays its shape, just shifted — no distortion (rigid translate).
9. **Selected room then user presses `W` / clicks Draw.** `roomTool.onDrawModeEnter()` clears
   `_selectedRoomId` (parallels symbol behaviour), so the selection outline disappears when leaving
   Select mode. Prevents a stale outline in draw mode.
10. **Mutually exclusive selection (symbol ↔ room).** Select a symbol, then click bare room floor:
    the room becomes selected and the symbol selection is cleared (via the dispatcher/injected
    `clearSymbolSelection`), so `Delete` / arrow-nudge / `Ctrl+D` act on the **room-nothing-else**
    — never on an invisible still-selected symbol. And vice-versa: clicking a symbol clears the room
    selection. The invariant "≤1 of {symbol, room} selected" holds after every `onDown`. This is the
    fix for the delete/nudge/duplicate footgun. (Note: room delete/nudge shortcuts are NOT added in
    this LLD — see Frontend Design; the point here is that a *symbol* shortcut can no longer fire
    against a hidden selection while a room is the visibly-selected thing.)

**Capability B — rectangle-preserving resize**

11. **Edited room is a rectangle rotated off-axis.** `isRectangle` is rotation-agnostic (checks
    corner angles, not axis alignment), so `rescaleRectEdge` anchors `vK` and slides `v(K+1)`,
    `v(K+2)` along the edge's own direction `u` — the tilted rectangle grows along its local axis and
    stays a rectangle. Correct.
12. **Edited room is NOT a rectangle (L-shape, 5+ verts, triangle, non-right angles, open
    polyline).** Falls through to unchanged `rescaleEdge` (single-corner). No regression, no new
    signal. This is the explicit contract from Approach B2.
13. **Rectangle within angle tolerance but not exact 90° (e.g. drawn freehand at 88°).** It passes
    `isRectangle` (within `RIGHT_ANGLE_COS_TOL` = 5°), so `rescaleRectEdge` runs. The translate-based
    algorithm moves `v(K+1)`/`v(K+2)` along the *current* edge direction `u` and leaves the
    perpendicular edge vectors unchanged, so **the 88° corners stay 88° — the near-rectangle is NOT
    squared up.** The edited edge still becomes exactly `L` and the shape does not shear further; it
    simply is not regularized. This is intentional (we chose the simpler translate over a
    reconstruct-and-orthogonalize approach — see B2 non-blocking note): we do not silently rewrite a
    room the user drew slightly off-square. No regularization is promised.
14. **Target length below `MIN_SEG_M`.** `rescaleRectEdge` returns `false`; `dimEntry.commit()`
    flags the input invalid and stays open (same code path as today's `rescaleEdge` false return at
    :199-204). Min-size guard satisfied.
15. **No-op resize (Enter with unchanged value).** The existing `fmtLen(targetM) === fmtLen(currentLen)`
    check at `dimEntry.js:191` short-circuits BEFORE either resize function is called, so a
    no-change Enter still just closes the editor and never commits history — unchanged.
16. **Editing a rectangle edge to a very large value.** No upper clamp (rooms have no catalog max,
    unlike symbols). The far side translates; the room can extend past the viewport — acceptable
    (matches drawing arbitrarily large rooms). Autosave + share still round-trip.
17. **Rectangle that shares a vertex/edge with the active drawing chain.** Resize only touches the
    committed room's `verts`; the chain is a separate array. No cross-contamination. (Shared vertex
    *values* are copies, not references — rooms are built with `[...chain]` at close time.)

## Frontend Design

Minimal chrome — reuse the existing blueprint visual language; no new panels, no room inspector.

**Room selection outline (pinned down — distinct from measure hover, not an OR of it).** When
`_selectedRoomId` matches a room, `wallRender._renderRoom` draws an **additional** selection outline
on top of the normal room render, driven by the new `getSelectedRoomId` getter as a **separate**
code path from the measure-hover `highlighted` boolean. The two must read differently:

| State | Treatment |
| --- | --- |
| Measure-hover (`getHighlightRoomId`) — unchanged | solid `roomFillHi` fill + `wallLineHi` 2px centerline (existing) |
| **Selected (`getSelectedRoomId`) — new** | a **1.5px dashed** outline, `stroke-dasharray "6 4"` (matching the draft rubber-band idiom for "active/in-hand"), `fill: none`, in `palette().snapPoint` (the gold selection/point accent), drawn as an extra polygon just inside the wall centerline |

Using the **dashed gold** treatment (not the solid `wallLineHi` hover fill) makes "selected" read
as "picked up / actionable" and keeps it visually distinct from "hovered in the measure list." If a
room is both hovered and selected, both layers draw and compose acceptably (dashed gold over the
solid hover). Drawn in the same `#world` group as the room, so it pans/zooms correctly and is
cleared on each idempotent redraw. No vertex/resize handles are drawn (per scope — no corner
dragging); the selection is a whole-room affordance.

**Cursor / feedback during move.** Reuse the existing `.stage.panning` grab cursor semantics; while
a room drag is active the stage already shows the grabbing state via `interactions.js`. No new
snap-tag is required for room move (grid snap is silent, matching how a room is drawn); if desired,
the existing `.snap-tag` could show "grid" during the drag, but this is optional and NOT required
for MVP — recommend omitting to keep it quiet.

**Rectangle resize.** No visible change to the affordance — the same dim chip, the same inline
input. The only observable difference is the *result*: setting a wall's length grows/shrinks the
room along that wall's direction and slides the far wall, so the room stays rectangular instead of
shearing. No toast is added (the non-rectangular path is unchanged from today).

**Accessibility.** Room selection is pointer-driven (like symbol selection today); no new keyboard
entry point is added in this LLD (keyboard room-selection/nudge is a possible follow-up, consistent
with LLD 54 having added symbol nudge). The selection outline is a visual cue; the measure panel
already lists rooms with area/perimeter for non-visual context.

**⚠️ Known limitation for QA — a room's own door/window may or may not travel with it.**
Furniture-carry membership is `pointInRoom(room, sym.x, sym.y)` on the symbol *center*.
`pointInRoom` (even-odd ray cast) does **not** give a guaranteed result for points exactly on the
polygon boundary (documented at `clearance.js:161`). A wall-flush door/window sits with its center
~`h/2` (≈ 0.06 m) off the wall centerline — i.e. effectively **on** the room boundary — so whether a
given door is judged "inside" and carried with the room is effectively a per-door coin-flip.
**Observable symptom for QA:** after moving a room, one of its doors/windows may stay behind on the
old wall line while the room (and its furniture) moves. **v1 workaround:** the user re-selects and
nudges/drags the stray door into place. Boundary-aware door attachment (treating a door as belonging
to the wall it's flush against) is deliberately **out of scope for v1** (see Scope); this callout
exists so QA treats a left-behind door as a *known limitation*, not a bug to file. Furniture with
centers well inside the room (beds, sofas, tables) carries reliably — the limitation is specific to
boundary-hugging openings.

**Auto-merge render-path note.** `wallRender.js` is **not** currently on the `autoMerge.renderPaths`
list in `.claude/project.json`, but this feature changes the live editor's render output (selection
outline) and `dimEntry.js` **is** on the list. The PR will therefore trip the render-path gate and
be held for a human glance regardless. That is expected and desirable here — a reviewer should
eyeball the selection outline and the resize behaviour. Do **not** add `wallRender.js`/`roomTool.js`
to `renderPaths` in this LLD (config change is orthogonal); the `dimEntry.js` entry already forces
the hold. See Dependencies / rollout.

**Non-blocking review decisions (resolved):**
1. **Once-per-session non-rectangle toast — DROPPED for v1.** The non-rectangular path is
   behaviourally identical to today, so there is nothing to explain, and it avoids adding a
   `setToast` injection into the render-path-gated `dimEntry.js`. If a future need arises, keep the
   "shown" flag in module state (session-only), never a persisted pref.
2. **Selection outline — DISTINCT dashed treatment (not an OR of the hover boolean).** Pinned to a
   1.5px dashed gold (`palette().snapPoint`) outline via a separate `getSelectedRoomId` render path,
   so "selected" reads differently from measure-hover (solid `roomFillHi`). Decided here, not left
   to implementation.

## Dependencies

**Must already exist (all present):**

- `walls.js` `model.rooms`, `edgeLength`, `MIN_SEG_M`, `Room`/`Vertex` typedefs — the geometry base.
- `clearance.js` `pointInRoom` — room interior hit-test + carried-furniture membership (already
  Node-clean, already exported through `mcp/src/core.js`).
- `interactions.js` select-hook plumbing (`setSelectHooks`, `onDown` boolean-consume contract,
  pan suppression, pinch cancellation) — LLD 21/34.
- `symbolTool.js` select API (`onSelectDown/Move/Up/onTapEmpty`, `onDrawModeEnter`) — the dispatcher
  composes with it. **One small addition:** expose `clearSelection()` (a public alias of the
  existing private `_clearSelection()`, which already nulls `_selectedId` + hides the inspector +
  cancels dim edit) so the dispatcher/`roomTool` can enforce the selection mutex. No behavioural
  change to `symbolTool`'s own gestures (it still `return false` on a miss).
- `history.js` snapshot (deep-clones rooms **and** symbols) — one undo reverts move + carry.
- `prefs.gridSnap()`, `grid.snapStep()`, `view` transforms, `symbols.moveSymbol` — all present.
- `wallRender.js` `_renderRoom(room, p, ppm, highlighted)` + injected getters pattern — extend with
  a `getSelectedRoomId` getter.

**No new third-party dependencies.** No build step. Pure vanilla JS/CSS/SVG, client-side only.

**Ordering:** `walls.js` pure functions first (unit-testable in isolation), then `roomTool.js` +
`dimEntry.js` routing, then `main.js` dispatcher + render-getter wiring, then the render outline.

### Follow-up (explicitly OUT of scope for this LLD)

- **MCP tools `move_room` / `resize_room`.** `moveRoom` and `rescaleRectEdge` are designed to be
  Node-clean specifically so `mcp/src/tools.js` can later expose them as agent tools, and
  `rescaleRectEdge` finally gives the MCP server a **non-destructive room resizer** — the exact gap
  LLD 32 documented (M2: "there is deliberately no `resize_room` tool… `set_edge_length` deforms a
  rectangle"). When surfaced later: re-export from `mcp/src/core.js`, add `tool_move_room` /
  `tool_resize_room` in `tools.js`, and update the `check_brief` oracle's `unmet` guidance
  (currently "rebuild the room via new_plan + add_room") to prefer `resize_room`. That is its own
  LLD (tool schema, agent-loop guidance, convergence-harness updates) and must not be bundled here.
- **A separate "set room to W×H" explicit affordance.** Deferred.
- **Keyboard room selection + arrow-key room nudge.** Deferred (parallels how LLD 54 followed the
  pointer-only symbol select of LLD 21).

### Rollout / testing considerations

- **Render-path gate.** `dimEntry.js` is on `autoMerge.renderPaths`, and the feature alters live
  editor rendering, so auto-merge will hold the PR for human review even on green CI. Intended.
- **Regression risk on `rescaleEdge` / `set_edge_length`.** The MCP `set_edge_length` tool and its
  tests call `rescaleEdge` directly (not through `dimEntry`), and this LLD does **not** change
  `rescaleEdge`. The rectangle branch lives only in `dimEntry.commit()`. MCP behaviour is therefore
  untouched — call this out in the PR so the reviewer confirms the MCP tests stay green unchanged.
- **Render-only structural tests** (LLD 61/62) may assert on `#world` children counts; adding a
  selection outline element changes counts when a room is selected — update those fixtures if they
  render with an active room selection (they currently do not select rooms, so likely unaffected).

## Test Requirements

Unit tests live in `test/tests.html` (the `describe`/`it`/`expect` harness, run by
`.github/run-tests.mjs`); integration tests are Playwright specs driven by the same runner. New
pure functions are imported from `../src/js/walls.js` alongside the existing
`rescaleEdge` import block.

### Unit — `walls.moveRoom`

- Translates all vertices of a closed 4-vert room by (dx, dy); edge lengths, `polygonArea`, and
  `perimeter` are invariant before/after (rigid translate).
- `dx===0 && dy===0` leaves verts numerically identical (no-op-safe).
- Works on an open polyline room (all verts shifted).
- Negative deltas shift correctly.

### Unit — `walls.isRectangle`

- True for an axis-aligned 4-vert closed rectangle.
- True for a rectangle rotated 30° (rotation-agnostic).
- True for a near-rectangle within 5° tolerance (e.g. 87° corners).
- False for: open polyline; 3 verts (triangle); 5+ verts; an L-shape (has a non-right corner);
  a parallelogram (60°/120° corners); a rectangle with one edge < `MIN_SEG_M` (degenerate).
- Boundary: corners at exactly `RIGHT_ANGLE_COS_TOL` classify consistently (document which side of
  the boundary is inclusive).

### Unit — `walls.rescaleRectEdge`

- **Worked case (reviewer's counterexample, must pass):** `v0=(0,0) v1=(4,0) v2=(4,3) v3=(0,3)`,
  edit edge 0 (`|e0|=4`) to `L=6`. Assert afterwards: `v0=(0,0)` and `v3=(0,3)` **unchanged**;
  `v1=(6,0)` and `v2=(6,3)` (each moved by `u·(L−|e0|)=(2,0)`); `|e0|===6`; opposite edge `|e2|===6`
  and parallel to e0; perpendicular sides `|e1|===|e3|===3` (unchanged); all four corners 90°;
  `isRectangle` still true.
- **The two moved vertices are `v(K+1)` and `v(K+2)`** (the far endpoint of the edited edge and its
  neighbour); `vK` and `v(K+3)` stay fixed. (This is the CORRECTED behaviour — the edited edge's far
  endpoint MUST move for its length to change.)
- **Does not shear:** the result satisfies `isRectangle` (all angles remain 90°) — this is the
  anti-parallelogram assertion, the headline bug the LLD fixes.
- Works for each `edgeIndex` 0..3 (anchor rotates accordingly) and for a rectangle rotated 30°
  (grows along its local axis `u`; still a rectangle).
- Shrinking (`L < |eK|`, e.g. 4→2) works symmetrically; result stays a rectangle.
- Returns `false` (no-op, verts unchanged) for: `targetLenM < MIN_SEG_M`; `edgeIndex` outside
  [0,3]; a non-rectangle input (self-guard).
- **Near-rectangle NOT regularized:** for a room with 88° corners (passes `isRectangle` within
  tolerance), after `rescaleRectEdge` the edited edge equals `L` but the corners are **still 88°**
  (the translate leaves perpendicular edge directions unchanged) — assert the corner angles are
  unchanged. (Confirms we chose the simple translate and do not silently square up the room; Edge
  Case 13.)

### Unit — `dimEntry.commit()` routing (may need a light DOM rig or an extracted routing helper)

- Committing a length on a rectangle room applies `rescaleRectEdge` (result stays rectangular).
- Committing a length on an L-shaped room applies `rescaleEdge` (single-corner, unchanged).
- No-op round-trip (unchanged value) still commits nothing (existing `fmtLen`-equality check).
- Invalid `rescaleRectEdge` (target < MIN_SEG_M) flags the input and keeps the editor open.

### Unit — carried-furniture membership (`roomTool` helper, or test the pure predicate)

- Given a room and symbols, the carried set = symbols with `pointInRoom(room, sym.x, sym.y)` true;
  symbols outside are excluded. Verify membership is computed from center, not AABB.
- After a `moveRoom(dx,dy)` + translating each carried symbol by the same `(dx,dy)`, carried symbol
  centers moved by exactly the delta and non-carried symbols are unchanged.

### Integration (Playwright, `.github/run-tests.mjs`)

- **Move:** draw a closed rectangle with a symbol inside; switch to Select; drag the room interior;
  assert the room polygon and the symbol both translated by the drag delta, and a single Ctrl+Z
  reverts BOTH together (one history step).
- **Symbol-wins-tie:** click where a symbol overlaps a room interior selects the symbol, not the
  room.
- **Selection mutex — the delete footgun (both directions):**
  (a) select a chair, then click bare room floor → the room is selected, the chair is NOT; press
  `Delete` → the **room's** deletion path runs (or, since room-delete isn't a shortcut in this LLD,
  assert `symbolTool.hasSelection()` is `false` so `Delete`/`Ctrl+D`/arrows do **nothing to the
  chair**). The chair must still exist.
  (b) select a room, then click a symbol → the symbol is selected, the room outline is gone; the
  symbol inspector shows. Confirms clicking a symbol clears the room selection.
- **Resize fixes shear:** draw a rectangle, click a wall's dim chip, type a larger length, Enter;
  assert the room is still a rectangle (far wall moved, edited edge = typed length, angles ~90°),
  not a parallelogram.
- **Non-rectangle unchanged:** draw an L-shaped room, dimension-edit an edge; assert single-corner
  `rescaleEdge` behaviour (matches pre-change snapshot).
- **Grid snap:** with snapping on, a room drag lands `verts[0]` on a grid multiple; with snapping
  off (or Alt), it follows the pointer freely.
- **Draw-mode clears selection:** select a room, press `W`; selection outline disappears.
- **Persistence round-trip:** move + resize a room, reload (localStorage) — geometry and carried
  symbol positions restore identically; share-hash export/import round-trips the same.

### Regression (must stay green, unchanged behaviour to protect)

- Existing `walls.js — rescaleEdge` unit tests (`tests.html`) — `rescaleEdge` is untouched.
- MCP `set_edge_length` tests (`mcp/`, `node --test`) — unchanged, still single-corner.
- Symbol select/drag/rotate/duplicate/delete (LLD 21/34/60) — the dispatcher must not regress the
  symbol path; symbol-only gestures behave exactly as before (symbols consume first).
- Draw-mode wall drawing, snap resolution, dimension chips for open rooms.
