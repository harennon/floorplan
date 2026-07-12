# LLD 96: Room editing — keyboard room selection + arrow-key nudge (LLD 63 follow-up)

Follow-up to **LLD 63** (room move + rectangle-preserving resize), which shipped room
selection + drag as **pointer-only** and explicitly deferred keyboard access
(LLD 63 "Follow-up (explicitly OUT of scope)"). This mirrors how **LLD 54** added
arrow-key nudge for *symbols* after the pointer-only symbol select of LLD 21.

Builds on: LLD 63 (`roomTool.js`, `moveRoom`, carried-furniture rules, dashed-gold
selection outline, the room↔symbol selection mutex), LLD 54 (symbol
`nudgeSelected`/`flushNudge`, the 400 ms debounce, the main.js global arrow-key
handler, the data-driven `?` overlay). Effort: small.

## Scope

Add **arrow-key nudge for a selected room**, reusing the LLD 54 symbol-nudge mechanics
verbatim. When a room is the current selection (and no symbol is selected), the arrow
keys translate the whole room rigidly — walls **and** carried furniture — via the same
`moveRoom` path used by the pointer drag, with the same step, same Shift-coarse rule, and
the same one-undo-per-burst debounce as symbols.

**In scope**
- `roomTool.nudgeSelected(dx, dy)` — mirrors `symbolTool.nudgeSelected`: rigidly translate
  the selected room + its carried furniture by `(dx, dy)` world metres, debounced-commit.
- `roomTool.flushNudge()` — mirrors `symbolTool.flushNudge`: commit a pending nudge burst
  immediately before any other committing action.
- A branch in the **existing** `main.js` arrow-key handler: when `hasSelection()` (symbol)
  is false but `roomTool.hasSelection()` is true, route the nudge to `roomTool`.
- Wire `roomTool.flushNudge()` into the same places `symbolTool.flushNudge()` is already
  called from `main.js` (undo, redo ×2) so a pending room nudge commits before those.
- Extend the `?` shortcuts overlay label so the arrow-nudge entry reads for rooms too
  (discoverability), per Direction A.

**Explicitly NOT in scope (per the approved Direction A / owner "Restart" decision)**
- **Tab / arrow key room *cycling* / any new keyboard selection entry point.** Rejected by
  the owner: room selection stays via **pointer click**, exactly like symbols today
  (LLD 63). This LLD adds keyboard *movement* only, not keyboard *selection*. (The issue
  title mentions "keyboard room selection"; the owner's Restart comment supersedes it.)
- **A focus ring, selection badge, or any new chrome.** The LLD 63 dashed-gold selection
  outline is the only feedback (Frontend Design).
- **Rotate / delete / duplicate of a room by keyboard.** LLD 63 already declines to add
  room delete/nudge shortcuts; this LLD adds *only* arrow-nudge. Room rotate is not a
  concept (rooms have no rotation), and room keyboard delete/duplicate are separate work.
- **Any change to `moveRoom`, the carried-furniture rules, the selection mutex, or the
  pointer drag** — all reused unchanged from LLD 63.
- **Any change to symbol nudge, `symbolTool.nudgeSelected`, or the debounce constant.**

## Approach

**Direction A — silent parity with symbol nudge.** Selection is pointer-click (unchanged
from LLD 63); movement is arrow keys, dispatched through the *existing* main.js handler.
No new listener, no new mode, no new visual. The change is ~10–15 lines in `roomTool.js`
plus one branch in `main.js`.

### 1. `roomTool.nudgeSelected(dx, dy)` mirrors `symbolTool.nudgeSelected`

LLD 63's pointer drag already contains the exact primitive we need: `moveRoom(room, dx,
dy)` + a loop translating each carried symbol by the same delta (`roomTool.js`
`onSelectMove`, lines 176–186). `nudgeSelected` factors that translate into a
keyboard-driven call:

```
nudgeSelected(dx, dy):
  if !_selectedRoomId: return
  room = wallsModel.rooms.find(r => r.id === _selectedRoomId)
  if !room || room.verts.length === 0: return
  moveRoom(room, dx, dy)
  for each carried symbol id: moveSymbol(sym, sym.x + dx, sym.y + dy)
  scheduleRender()
  debounce a history.commit() (NUDGE_COMMIT_MS = 400), resetting the timer per call
```

**Carried-furniture set for nudge is recomputed at each nudge, from the current room
polygon**, not snapshotted like the drag. Rationale: a nudge is a discrete event with no
"down" to snapshot at, and unlike a drag the room never transiently slides off a symbol
mid-gesture (each nudge is a small committed step whose membership matches what the user
sees). So `nudgeSelected` computes the carried set inline using the same split rule LLD 63
uses (furniture → `pointInRoom`; openings → `pointNearRoomWall(room, x, y, WALL_M)`),
factored into a shared private helper `_carriedSymbolsFor(room)` that `onSelectDown`
reuses. This keeps the two carry paths from drifting.

> Consistency note: because membership is recomputed per nudge from the room's *current*
> position, a symbol the room is nudged **onto** becomes carried on subsequent nudges, and
> one nudged **off** stops being carried — which reads correctly for a step-wise move
> (contrast the drag, which locks membership at down-time to avoid mid-drag flicker). This
> is an intentional, minor divergence and is called out in Edge Cases.

### 2. `roomTool.flushNudge()` mirrors `symbolTool.flushNudge`

Identical body: if a debounce timer is pending, clear it and commit now. Called before any
other committing action so undo-stack ordering is correct. The debounce timer and constant
are **module-private to `roomTool`** — independent of symbolTool's timer (the two can never
both be pending because selection is mutually exclusive, but keeping them separate avoids
cross-module coupling and matches the "surgical" constraint).

### 3. Dispatch in the existing `main.js` arrow handler (branch on room selection)

The main.js global keydown listener already has the symbol arrow-nudge branch (lines
600–612). Today it early-returns when `hasSelection()` (symbol) is false, letting arrows
scroll the page. We extend that branch so a *room* selection is handled before the
early-return:

```
if (!meta && arrow key) {
  const step = e.shiftKey ? base*4 : base   // base = snapStep() ?? 0.1  (unchanged)
  const [dx, dy] = dirFor(e.key, step)      // unchanged mapping
  if (hasSelection()) { e.preventDefault(); nudgeSelected(dx, dy); return; }        // symbol (existing)
  if (roomHasSelection()) { e.preventDefault(); roomNudgeSelected(dx, dy); return; } // room (NEW)
  return;   // nothing selected → native scroll (unchanged)
}
```

Symbol wins if both were somehow selected — but the LLD 63 mutex guarantees at most one of
{symbol, room} is selected, so this is just defensive ordering that matches the pointer
dispatcher ("symbols win ties"). The `step`/`dirFor` computation is shared (lifted above
the two `if`s) so symbol and room nudge use an identical step — satisfying "same keys, same
step" exactly.

### 4. Flush a pending room nudge before other committing actions

`symbolTool.flushNudge()` is already called in main.js at undo (line 514), redo (523), and
redo-via-Ctrl+Y (530), and internally by symbolTool's own delete/duplicate/rotate/
draw-mode paths. We add `roomTool.flushNudge()` **alongside** each of those three main.js
call sites (undo, redo, redo-Y). No room delete/duplicate/rotate shortcuts exist, so there
are no roomTool-internal flush sites to add. `roomTool.onDrawModeEnter()` and
`clearSelection()` should also flush (a pending room nudge must commit before the room is
deselected or draw mode is entered) — see Edge Cases.

### Why reuse, not generalize

An alternative was a single shared nudge dispatcher parameterized over "the active
selection." Rejected: symbol and room translate differently (one `moveSymbol` vs
`moveRoom` + carried loop) and already have separate tool modules and separate mutation
paths; a shared abstraction would be a single-use indirection the project's simplicity
principle resists. Mirroring `symbolTool`'s three small exports in `roomTool` is the
smaller, more consistent change.

## Interfaces / Types

### `src/js/roomTool.js` — new exports (mirror `symbolTool`)

```js
/** Debounce window for coalescing a burst of nudges into one undo step.
 *  Same value as symbolTool.NUDGE_COMMIT_MS (LLD 54). Module-private. */
const NUDGE_COMMIT_MS = 400;
let _nudgeTimer = null; // setTimeout handle for the deferred commit

/**
 * Move the selected room by (dx, dy) world metres, carrying its furniture.
 * No-op if no room selected or the room has no verts. Applies the delta literally
 * (no grid snap resolve — repeated presses accumulate predictably, exactly like
 * symbolTool.nudgeSelected). Rigidly translates walls via moveRoom and every
 * currently-carried symbol via moveSymbol, then scheduleRender(). Schedules a
 * debounced history.commit() (NUDGE_COMMIT_MS) so a burst collapses to one undo step.
 * @param {number} dx  world metres
 * @param {number} dy  world metres
 */
export function nudgeSelected(dx, dy) { /* ... */ }

/**
 * If a nudge commit is pending, cancel the timer and commit now. No-op when none
 * pending. Called before any other committing action (undo/redo, deselect,
 * draw-mode enter) so undo-stack ordering stays correct. Mirrors symbolTool.flushNudge.
 */
export function flushNudge() { /* ... */ }
```

Internal helper (factored from the existing `onSelectDown` carry loop so drag and nudge
share one definition):

```js
/**
 * Ids of symbols carried by `room`: furniture whose center is strictly inside
 * (pointInRoom), plus openings within WALL_M of one of the room's own wall segments
 * (pointNearRoomWall). Pure over the current model state. Used by onSelectDown
 * (snapshot at drag start) and nudgeSelected (recomputed per nudge).
 * @param {Room} room
 * @returns {string[]}
 */
function _carriedSymbolsFor(room) { /* ... */ }
```

`nudgeSelected` body (concrete):
```js
if (!_selectedRoomId) return;
const room = wallsModel.rooms.find(r => r.id === _selectedRoomId);
if (!room || room.verts.length === 0) return;
moveRoom(room, dx, dy);
for (const id of _carriedSymbolsFor(room)) {
  const sym = getSymbol(id);
  if (sym) moveSymbol(sym, sym.x + dx, sym.y + dy);
}
scheduleRender();
clearTimeout(_nudgeTimer);
_nudgeTimer = setTimeout(() => { _nudgeTimer = null; if (_historyCommit) _historyCommit(); }, NUDGE_COMMIT_MS);
```
`flushNudge` body: `if (_nudgeTimer !== null) { clearTimeout(_nudgeTimer); _nudgeTimer = null; if (_historyCommit) _historyCommit(); }`.

**Changed internal calls (surgical):** `onSelectDown` replaces its inline carry loop
(lines 134–141) with `_carriedSymbolIds = _carriedSymbolsFor(hitRoom);`. `clearSelection()`
and `onDrawModeEnter()` call `flushNudge()` first so a pending nudge commits before the
room is dropped.

### `src/js/main.js` — extend the existing arrow-nudge branch (no new listener)

Import the two new roomTool exports (add to the existing `roomTool.js` import block, lines
21–32):
```js
nudgeSelected as roomNudgeSelected,
flushNudge as roomFlushNudge,
hasSelection as roomHasSelection,
```
Modify the arrow branch (currently lines 600–612) to compute the step once, then dispatch
symbol-first, room-second (see Approach §3). Add `roomFlushNudge()` next to the three
existing `flushNudge()` calls (undo line 514, redo 523, redo-Y 530).

`roomTool` already exposes `getSelectedRoomId` (imported as `roomGetSelectedRoomId`); the
new `roomHasSelection` is a trivial existing-style predicate (`_selectedRoomId !== null`) —
**`hasSelection()` already exists in `roomTool.js` (line 228)**, so only the import alias is
added, no new roomTool predicate is written.

### `src/js/help.js` — overlay label (discoverability)

The `SHORTCUTS` array (line 24) already has `{ group:"Object", action:"Nudge selected", … }`
and `"Coarse nudge"`. Update the `action` text of those two rows to make clear they apply
to rooms too, e.g. **"Nudge selection (symbol/room)"** and **"Coarse nudge"** (keys
unchanged: `↑ ↓ ← →` and `Shift+↑↓←→`). No new rows, no key changes — the same physical
keys now act on whichever of {symbol, room} is selected. Exact wording is a copy detail for
the implementer; keep it short to fit the existing table.

### Unchanged / reused
- `walls.moveRoom`, `walls.pointNearRoomWall`, `walls.WALL_M`, `clearance.pointInRoom`,
  `symbols.moveSymbol`, `symbols.getSymbol`, `symbols.CATALOG` — all already imported by
  `roomTool.js` (lines 23–28).
- `grid.snapStep()` and the `dirFor`/step logic in main.js — reused verbatim from LLD 54.
- The LLD 63 selection mutex, pointer drag, and `getSelectedRoomId` render getter.

## State Model

**No new persisted state.** Nudge mutates the same arrays LLD 63's drag mutates:
`walls.model.rooms[*].verts` (rigid translate) and, for carried furniture,
`symbols.model.symbols[*].x/y`. These are the exact arrays `plan.buildPlan()` serializes;
autosave (`store.js` `onRender`) and the share-hash encoder pick the change up with no
change to `plan.js`. A nudged room round-trips through `validatePlan` unchanged.

**Session-only, in-memory (owned by `roomTool.js`):**

| State | Meaning | Lifetime |
| --- | --- | --- |
| `_selectedRoomId` | selected room id, or `null` (existing, LLD 63) | cleared on tap-empty / draw-mode enter / reload |
| `_nudgeTimer` (**new**) | debounce handle for the deferred commit | transient; flushed before any other committing action; discarded on reload |

`_nudgeTimer` never persists. It is flushed (committed) before undo/redo, deselect, and
draw-mode entry so ordering is deterministic.

**History commit lifecycle (extends LLD 63's table):**

| Gesture | Call site | Granularity |
| --- | --- | --- |
| Room move-drag end | `roomTool.onSelectUp` (existing, LLD 63) | 1 step per gesture |
| **Room arrow-nudge (new)** | debounced `_nudgeTimer` in `roomTool` | 1 step per burst (≤400 ms gap); flushed early by undo/redo/deselect/draw-mode |

Because `history.js` snapshots deep-clone **both** rooms and symbols, a single undo reverts
the room translation **and** the carried-furniture translation for the whole burst together
— identical to the drag's one-undo guarantee (LLD 63 State Model). Nudge is **not** a commit
point per keypress; only the debounced timer (or an early `flushNudge`) commits.

## Edge Cases

1. **Arrow with no selection at all.** Symbol branch returns without `preventDefault`
   (existing), then the new room branch: `roomHasSelection()` false → also no
   `preventDefault` → native page scroll is preserved. We only consume arrows when we
   actually nudge something. (Matches LLD 54 Edge Case 2.)
2. **Arrow while a symbol is selected (room not).** Existing symbol branch handles it and
   returns before the room branch is reached — symbol nudge is completely unchanged.
3. **Arrow while a room is selected (symbol not).** New branch nudges the room; the LLD 63
   mutex guarantees no symbol is also selected, so there is no ambiguity.
4. **Nudge burst = one undo step.** Rapid/held arrows each move the room immediately
   (responsive) but commit once after a 400 ms pause. A single Ctrl/Cmd+Z reverts the whole
   burst — room + all carried furniture — to the pre-nudge position (deep-clone snapshot).
5. **Interleaving nudge with undo/redo.** `roomFlushNudge()` runs at the top of the undo,
   redo, and redo-Y branches (alongside the existing `flushNudge()`), so a pending room
   nudge commits *before* the undo/redo executes — no "undo then nudge" inversion.
6. **Nudge then deselect / draw-mode.** `clearSelection()` and `onDrawModeEnter()` call
   `flushNudge()` first, so a pending nudge is committed before the room is dropped or the
   tool switches. Prevents a lost or mis-ordered commit.
7. **Selected room deleted/absent underneath a pending timer.** `nudgeSelected` re-reads
   the room from `wallsModel.rooms` each call and returns if not found; a stale timer that
   fires after the room vanished just calls `history.commit()` (a dirty-check no-op if
   nothing changed). No room delete shortcut exists in this LLD, so this is only reachable
   via undo/MCP mutation between nudges — harmless.
8. **Carried-furniture set differs from the drag's snapshot semantics.** Nudge recomputes
   membership per keypress from the room's *current* polygon (Approach §1), so a symbol the
   room is stepped onto starts being carried, and one stepped off stops. This is correct
   for a discrete step-move and is the intended behavior; it differs from the drag, which
   locks membership at down-time to avoid mid-drag flicker. No data-model impact (carry is
   pure geometry, never persisted — LLD 63 migration note).
9. **Focus in a text field (dimension entry).** The room branch sits below the shared
   `INPUT/TEXTAREA/SELECT` editable-focus guard at the top of the main.js handler (same
   guard LLD 54 relies on), so typing a dimension is never hijacked.
10. **Ctrl/Cmd+arrow chords.** The whole arrow branch is guarded by `!meta` (existing), so
    OS/browser arrow chords pass through untouched.
11. **Nudge step when snapping is off.** `snapStep()` returns `null` → `base = 0.1 m` fine /
    `0.4 m` coarse (`Shift`), identical to the symbol fallback. Nudge applies the delta
    literally (no snap resolve), so repeated presses accumulate predictably even off-grid,
    and the room does not re-snap `verts[0]` (unlike the pointer drag, which snaps the
    reference vertex — this literal-delta choice matches symbol nudge exactly, per the
    "reuse LLD 54 mechanics" constraint).
12. **Nudge pushes the room over another room / off-viewport.** Allowed — freeform sketcher,
    no constraint solver (LLD 63 Edge Case 7/16). Clearance annotations recompute on render.
13. **Overlay open + arrow nudge.** `help.js` capture-phase listener consumes only `?`/`Esc`;
    arrows still bubble to the main.js handler, so nudging with the cheat sheet open works
    and is harmless (matches LLD 54 Edge Case 11).

## Frontend Design

**Direction A — silent parity with symbol nudge.** The approved direction (owner "Restart"
comment) is: selection via pointer **click** exactly like symbols (LLD 63, unchanged), and
movement via arrow keys with the *same keys, same step, same history-commit-per-burst
behavior* as the symbol nudge in LLD 54. Tab-cycling and any other keyboard selection
entry point were explicitly **rejected**.

**No new chrome.** The only on-canvas feedback is the **existing LLD 63 dashed-gold
selection outline** (`palette().snapPoint`, 1.5px dashed `"6 4"`), drawn by
`wallRender` off `getSelectedRoomId`. It already updates every frame during pan/zoom and
after each render, so a nudged room's outline tracks the new position for free — **no
render change is required**. Explicitly not added: focus ring, selection badge, snap-tag,
toast. Rooms move visibly on the canvas, so nudge is self-evident (same reasoning LLD 54
gives for omitting a rotate/nudge toast).

**Discoverability via the `?` overlay only.** The existing `SHORTCUTS` "Nudge selected" /
"Coarse nudge" rows are relabeled so a user reading the cheat sheet learns the arrow keys
move a selected *room* too (see Interfaces / help.js). This is the single discoverability
touch, consistent with LLD 54's Direction B (data-driven overlay is the source of truth for
keyboard affordances) — no new visible control.

**Accessibility framing.** This is the accessibility follow-up LLD 63 flagged: LLD 63's
measure panel already lists rooms with area/perimeter for non-visual context, but there was
no keyboard way to *move* a room once selected. Nudge closes that gap for the movement half.
Note the honest limitation carried over from the owner's decision: room *selection* remains
pointer-only, so this does not make room editing fully keyboard-operable end-to-end — it
brings rooms to exact parity with where symbols stand after LLD 54 (pointer-select +
keyboard-nudge), which is the stated goal. A fully keyboard-navigable selection model
(rooms and symbols alike) remains possible future work, out of scope here.

## Dependencies

**Blocked on LLD 63 merged** — confirmed present in this worktree: `roomTool.js` exists
with `_selectedRoomId`, `hasSelection()` (line 228), the carry loop in `onSelectDown`
(134–141), `clearSelection()`, `onDrawModeEnter()`, and the injected `_historyCommit`; the
main.js select dispatcher and mutex are wired.

**Must already exist (all present):**
- `roomTool.js` — `_selectedRoomId`, `hasSelection`, `clearSelection`, `onDrawModeEnter`,
  injected `_historyCommit` (via `setHistoryAndToast`), and the imports it already holds:
  `moveRoom`, `pointNearRoomWall`, `WALL_M` (walls.js), `pointInRoom` (clearance.js),
  `getSymbol`, `moveSymbol`, `CATALOG` (symbols.js). **[present, to be extended]**
- `symbolTool.js` — `nudgeSelected`/`flushNudge`/`NUDGE_COMMIT_MS` as the pattern to mirror
  (LLD 54). **[present, reference only — not modified]**
- `main.js` — the global keydown handler with the existing arrow-nudge branch (600–612),
  the `snapStep`/`dirFor` step logic, and the three `flushNudge()` call sites (514/523/530);
  the `roomTool.js` import block (21–32). **[present, to be extended]**
- `help.js` — the `SHORTCUTS` array + `_renderTable` (LLD 54). **[present, to be edited]**
- `history.js` snapshot (deep-clones rooms + symbols) — one undo reverts a nudge burst +
  carried furniture. **[present]**

**No new third-party dependencies. No build step.** Vanilla ES modules only, client-side.

**Ordering:** add `roomTool.nudgeSelected`/`flushNudge` + `_carriedSymbolsFor` first
(unit-testable), then the main.js branch + flush wiring, then the help.js label.

**Render-path / auto-merge note:** this LLD does not touch any file on
`autoMerge.renderPaths` in a render-affecting way — `roomTool.js` is not on the list,
`main.js`/`help.js` changes are dispatch/label only, and no render code changes (the
selection outline is reused as-is). Confirm against `.claude/project.json` at
implementation time; if `help.js`/`main.js` are gated, the PR simply holds for a human
glance, which is acceptable.

## Test Requirements

Unit tests live in the in-browser harness (`describe`/`it`/`expect`, run headless via
`.github/run-tests.mjs`); integration tests are Playwright specs on the same runner. Where
practical, favor pure dispatch-logic tests over synthetic key events (mirrors LLD 54).

### Unit — `roomTool.nudgeSelected` / `flushNudge`
- With a room selected, `nudgeSelected(dx, dy)` translates every vertex of that room by
  exactly `(dx, dy)` (rigid — edge lengths / area / perimeter invariant), no snap resolve
  applied.
- Carried furniture: a symbol whose center is inside the selected room moves by exactly
  `(dx, dy)`; a symbol outside does not move.
- An **opening** cut into one of the room's own walls (center within `WALL_M` of a room
  segment) is carried; a symbol outside is not — confirms `_carriedSymbolsFor` uses the
  same split rule as the drag.
- No-op when no room selected, when the room id is missing, or when the room has 0 verts.
- Debounce: N rapid `nudgeSelected` calls schedule exactly **one** commit after the quiet
  window (spy commit count == 1, injected via `setHistoryAndToast`).
- `flushNudge()` with a pending timer calls `_historyCommit` once and clears the timer;
  no-op when nothing pending.
- `clearSelection()` and `onDrawModeEnter()` flush a pending nudge (spy commit fires before
  the selection is dropped).

### Unit — step selection (shared with symbol nudge)
- Room nudge uses `snapStep()` when non-null, falls back to `0.1 m` when snap is off, and
  `Shift` yields 4× the base — identical to the symbol path (assert the same `step` value
  drives both, since the main.js branch computes it once).

### Unit — help overlay parity
- The `SHORTCUTS` nudge/coarse-nudge rows still exist with unchanged keys (`↑ ↓ ← →`,
  `Shift+↑↓←→`) after the label edit; `mac`/`other` chords remain non-empty (guards the
  LLD 54 parity checkpoint).

### Integration (Playwright)
- **Room nudge:** draw a closed room with a symbol inside; Select tool; click the room
  interior to select (dashed-gold outline appears); press `ArrowRight` several times →
  assert the room polygon **and** the symbol translated by the accumulated step; a single
  Ctrl/Cmd+Z reverts the whole burst (room + symbol) in one step.
- **Coarse nudge:** `Shift+Arrow` moves 4× the fine step.
- **Symbol-first dispatch / mutex:** with a symbol selected, arrows nudge the symbol and
  the room is untouched; after clicking a room (symbol deselected via mutex), arrows nudge
  the room and the symbol is untouched.
- **No selection:** arrows with nothing selected do not `preventDefault` (native scroll
  allowed) and move neither rooms nor symbols.
- **Editable-focus guard:** focus a dimension input, press arrows → the input receives the
  keystroke; no room moves.
- **Flush-before-undo ordering:** nudge a room once, immediately Ctrl/Cmd+Z → the nudge is
  committed then undone (room returns to start), not lost.
- **Draw-mode / deselect flush:** nudge a room, press `W` (or click empty canvas) →
  the pending nudge is committed (a subsequent undo restores the pre-nudge position) and
  the selection outline disappears.

### Regression (must stay green)
- Symbol nudge/rotate/delete/duplicate (LLD 54) — symbolTool is not modified; its branch
  runs first and is unchanged.
- Room pointer drag + carried furniture + one-undo (LLD 63) — `onSelectDown`'s carry now
  routes through `_carriedSymbolsFor`; assert the extracted helper produces the identical
  set the inline loop produced (drag behavior unchanged).
- The LLD 63 room↔symbol selection mutex and the dashed-gold outline render.
