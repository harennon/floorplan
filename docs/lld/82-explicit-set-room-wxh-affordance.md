# LLD 82: Room editing — explicit "set room to W × H" affordance (LLD 63 follow-up)

Builds on / must not contradict: **LLD 63** (room move + rectangle-preserving resize —
`isRectangle`, `rescaleRectEdge`, `roomTool._selectedRoomId`, the select-hook dispatcher),
LLD 09 (dim-chip inline edit via `dimEntry.js`), LLD 21 (undo/redo snapshot model). Effort: low.

Priority note: this is a **minimal-chrome complement** to LLD 63's dim-chip edit, not a
replacement. The click-a-wall-dimension gesture stays exactly as it is. This LLD adds one small,
explicit two-field control for users who already know the exact target size and don't want to edit
two edges sequentially.

## Scope

Add one explicit, two-field **W × H** control that sets both side lengths of the *currently
selected rectangular room* at once, committed as a single undo step. It lives in the **measure
panel** (Frontend decision **Option A**), keyed off the room selection LLD 63 already ships
(`roomTool.getSelectedRoomId()`).

**In scope**

- A small, persistent W × H editor rendered in the measure-panel body. Visible **only** when a
  single **rectangular** room is selected; hidden/absent otherwise.
- Prefill both fields from the selected room's two side lengths, formatted in the active unit via
  `fmtLen`; parse input via existing `parseLen` (so `ft`/`m` suffixes and the imperial/metric
  toggle all work as they do in the dim chip).
- Apply = one call to LLD 63's `rescaleRectEdge` per axis (W then H), then **one** `history.commit()`
  so a single undo/redo reverts the whole W × H change.
- A tiny pure read helper `rectDims(room)` in `walls.js` that maps the rectangle's two side edges
  to a `{ w, h, wEdge, hEdge }` pair (which edge index is "width" vs "height"). Node-clean, testable.
- Min-size guard and invalid-input handling reusing `rescaleRectEdge`'s `false` return and
  `parseLen`'s `null` return.

**Explicitly NOT in scope**

- **Replacing or altering the dim-chip edit path.** LLD 63's click-a-wall-dimension gesture
  (`dimEntry.js`) is untouched. This is a *complement* for people who know the exact target size.
- **Any geometry rework.** We reuse `isRectangle` + `rescaleRectEdge` verbatim; no new resize math.
- **W × H for non-rectangular rooms** (L-shape, triangle, 5+ verts, open polyline). The affordance
  is hidden for them — there is no single unambiguous W × H, and forcing one would deform the shape.
- **`plan.js` serialization / persistence changes.** No new persisted keys; must stay disjoint from
  the share-codec work (#91) to avoid conflict. W × H edits mutate the same `rooms[*].verts` LLD 63
  already round-trips.
- **A floating on-canvas W × H box, a room inspector, or MCP tools.** Deferred.
- **Rotating, re-squaring a near-rectangle, or resizing from a corner handle.**

## Approach

### Decision — where the affordance lives: **measure panel (Option A).**

The measure panel already (a) lives adjacent to the canvas, (b) already lists each room's
area/perimeter, and (c) is the natural "read off the numbers" surface — so a "type the numbers"
control belongs beside it. It reuses existing panel chrome (no new panel, no floating box, no rail
tool). It keys off the selection LLD 63 already exposes. Alternatives rejected: a floating
on-canvas box (new positioning/pan-tracking code, more chrome), a room inspector (a whole new
surface, contradicts minimal-chrome), or overloading the dim chip (it already does single-edge — a
two-field control is a *different* intent).

The control is a small block at the top of `.measure-body`, above the room list:

```
Selected room:  [ 4.0 ] × [ 3.0 ] ft   [Apply]
```

It renders only when `roomTool.getSelectedRoomId()` resolves to a **rectangular** room
(`isRectangle`). For any other selection state (nothing selected, a symbol selected, a
non-rectangular room selected) the block is hidden and the panel looks exactly as it does today.

### Decision — reuse LLD 63 geometry; W and H each map to one `rescaleRectEdge` call.

A rectangle's four edges form two parallel pairs: `{e0,e2}` and `{e1,e3}`. Setting one side length
is exactly `rescaleRectEdge(room, edgeIndex, targetM)` — the far parallel wall slides and the shape
stays rectangular. So "set W × H" is just **two orthogonal `rescaleRectEdge` calls** — one on a
`{e0,e2}` edge (width), one on a `{e1,e3}` edge (height). Because the two edited edges are
perpendicular, the calls are order-independent: resizing along `e0`'s direction moves `v1,v2` but
leaves `|e1|`/`|e3|` unchanged, and vice-versa. **No new geometry is invented.**

**Which edge is "W" vs "H".** For intuitive labels on the common axis-aligned room, `rectDims`
picks the edge pair whose direction is more horizontal (`|dx| >= |dy|` for edge `e0`) as **width**
and the other as **height**. For a tilted rectangle the split is still well-defined (one of the two
perpendicular directions is nearer horizontal); the labels are approximate but harmless — the two
fields still map to the room's two real side lengths. `rectDims` returns the concrete
`wEdge`/`hEdge` indices so Apply calls `rescaleRectEdge` on exactly those edges.

### Decision — Apply commits once; parsing/validation reuse existing helpers.

- **Parse** each field with `parseLen` (returns metres or `null`). If **either** field is `null`
  (empty, ≤ 0, non-numeric) or below `MIN_SEG_M`, Apply flags the offending field invalid (same
  `aria-invalid` + red-border treatment `dimEntry.js` uses) and does **not** mutate geometry.
- **Apply** on valid input: capture `const dims0 = rectDims(room)` **once, before any mutation**,
  and use `dims0.w` / `dims0.h` as each axis's "current" side length for the no-op guard. Then call
  `rescaleRectEdge(room, dims0.wEdge, wM)` then `rescaleRectEdge(room, dims0.hEdge, hM)`. Guard: if a
  field's parsed value equals that pre-mutation side length within display precision
  (`fmtLen(target) === fmtLen(current)`, matching the dim-chip no-op check), skip that axis's call.
  Because the two edited edges are perpendicular, a W resize does not change the H side length — but
  the "current" values must still be read from the **pre-mutation** `dims0` snapshot (not re-derived
  from geometry after the W call) so the read order is unambiguous. If **both** axes are no-ops,
  Apply does nothing and does not commit history.
- **One history entry.** Call `history.commit()` **once** after both `rescaleRectEdge` calls, so a
  single Ctrl+Z reverts the whole W × H change in one step. (`dimEntry.js` commits per single-edge
  edit; here the two edits are one user action, so one commit.)
- After Apply, `scheduleRender()` refreshes the canvas, dim chips, area/perimeter, and the W × H
  fields (which re-prefill from the new side lengths).

### Decision — the W × H refresh runs on EVERY `update()`, above the dirty-check early return.

`measure.update()` (src/js/measure.js:75–164) has a **dirty-check early return**: when the room set
is structurally unchanged (`structureUnchanged && newRows.length > 0`, line 109) it patches row text
in place and `return`s at line 120 — it never reaches the tail of the function. Selecting /
deselecting a room, toggling units, hovering, and dragging all leave `model.rooms` structurally
unchanged (the id list is identical), so they all hit this early return.

Therefore the W × H visibility + prefill logic **must NOT be appended to the tail of `update()`** —
it would never run for exactly the events that must show/hide the block (selection change, unit
toggle), producing a non-functional feature. Instead, factor it into a dedicated helper
`_refreshWxh()` and call it **unconditionally near the top of `update()`, before the dirty-check
branch** (and thus before both the early return and the rebuild path). `_refreshWxh()` reads
`getSelectedRoomId()` → resolves the room → shows + prefills iff `isRectangle`, else hides. It does
not depend on `newRows`/`_lastRows` and must be reachable on every invocation regardless of which
row-update branch `update()` then takes.

### Where the changes land

| File | Change | On auto-merge `renderPaths`? |
| --- | --- | --- |
| `src/js/walls.js` | +`rectDims(room)` (pure, Node-clean read helper) | No (must stay Node-clean) |
| `src/js/measure.js` | render + wire the W × H block; read `getSelectedRoomId`; call `rescaleRectEdge` ×2 + one `history.commit` | **See note** |
| `src/index.html` | static markup + CSS for the W × H block inside `.measure-body` | No |
| `src/js/main.js` | inject `getSelectedRoomId` + `history.commit` into `measure` (measure currently has neither) | No (wiring) |

`measure.js` is a render-path module in spirit (it renders on every `onRender`); confirm against
`.claude/project.json` `autoMerge.renderPaths` at implementation time. Either way this touches the
live editor, so a human review hold is expected and desirable. **`plan.js` is not touched** (keeps
this disjoint from #91).

## Frontend Design

**Placement (Option A): a compact W × H block at the top of `.measure-body`, above the room list.**
Reuses the existing blueprint panel visual language; no new panel or inspector.

**Markup** (static in `index.html`, shown/hidden by `measure.js`, default `hidden`):

```html
<div class="measure-wxh" hidden>
  <span class="measure-wxh-label">Selected room</span>
  <input class="measure-wxh-w" inputmode="decimal" autocomplete="off"
         aria-label="Room width — type a value and press Enter" />
  <span class="measure-wxh-x" aria-hidden="true">×</span>
  <input class="measure-wxh-h" inputmode="decimal" autocomplete="off"
         aria-label="Room height — type a value and press Enter" />
  <span class="measure-wxh-unit" aria-hidden="true">ft</span>
  <button class="measure-wxh-apply" type="button">Set</button>
</div>
```

**Visibility rule** (evaluated by a dedicated `_refreshWxh()` helper called **unconditionally near
the top of `measure.update()`, above the dirty-check early return** — see Approach; `update()` runs
each `onRender`):
- Show iff `getSelectedRoomId()` resolves to a room in `model.rooms` with `isRectangle(room) === true`.
- Otherwise `hidden`.
- **Critical:** `_refreshWxh()` must be reached on every `update()` call. `update()`'s dirty-check
  `return` (measure.js:120) fires whenever the room set is structurally unchanged — which is the case
  for selection/deselection, unit toggle, hover, and drag. If the W × H logic were placed after that
  return it would never run for a selection change or unit toggle and the block would never appear.
  Placing `_refreshWxh()` before the dirty-check makes the block appear/disappear reactively as the
  selection or the room's shape changes (e.g. a dim-chip edit that keeps it rectangular keeps the
  block; a move that leaves it rectangular keeps it).

**Prefill + unit reactivity.** When shown, set the two inputs to `fmtLen(w)` / `fmtLen(h)` from
`rectDims(room)`, and the trailing unit label to `unitLabel()`. On unit toggle the panel re-renders
(measure already re-renders on unit change via its area/perimeter path), so the fields re-prefill in
the new unit — **but do not clobber a field the user is mid-edit in** (see Edge Cases): skip the
prefill for a field that currently has focus.

**Interaction.**
- **Set button** click, or **Enter** in either field → `applyWxH()`.
- **Escape** or **blur without Apply** → re-prefill fields from the room (discard the typed-but-not-
  applied value); no geometry change.
- Invalid field (parse `null` or `< MIN_SEG_M`, or `rescaleRectEdge` returns `false`): set
  `aria-invalid="true"` + red border (`var(--error, #e57373)`), matching `dimEntry.js`; keep the
  block open, do not commit.

**Pointer isolation.** The block sits in the docked measure panel (not over `.stage`), so it does
not need the `.dim-chip` pointerdown-stopPropagation dance; normal panel event handling applies.

**Styling.** Match `.dim-input` sizing/typography and `.measure-row` spacing so the block reads as
part of the panel. Small inputs (~4ch), a muted `×` glyph, a compact `Set` button using the
existing button treatment. Respect the `prefers-reduced-motion` transition-off block already present.

**No canvas change.** The room's selection outline (dashed gold, LLD 63) is the on-canvas cue that
"this is the room the W × H applies to"; this LLD adds no new canvas rendering.

**Accessibility.** Both inputs are labelled; the block is keyboard-reachable within the panel; Enter
applies. No new global keyboard shortcut is added.

## Interfaces / Types

### `src/js/walls.js` — new pure read helper (DOM-free)

```js
/**
 * For a rectangle, return its two side lengths and the edge indices they map to.
 * Width = the edge pair nearer horizontal (|dx| >= |dy| for e0); height = the other.
 * Pure; does not mutate. Returns null if !isRectangle(room).
 * @param {Room} room
 * @returns {{ w:number, h:number, wEdge:number, hEdge:number } | null}
 *          w/h in world metres; wEdge ∈ {0,2}, hEdge ∈ {1,3} (whichever member of
 *          each perpendicular pair; either works since parallel edges are equal length).
 */
export function rectDims(room) { /* ... */ }
```

`isRectangle`, `rescaleRectEdge`, `edgeLength`, `MIN_SEG_M` are reused unchanged.

### `src/js/measure.js` — additions

```js
/** init(refs): refs now also include the W×H block elements:
 *  { panel, list, total, toggle, wxhBox, wxhW, wxhH, wxhUnit, wxhApply } */
export function init(refs) { /* binds Set click, Enter/Escape/blur on inputs */ }

/** Injected from main.js (avoids circular import), mirroring the dimEntry pattern. */
export function setSelectedRoomAccessor(getSelectedRoomId) { /* ... */ }
export function setHistoryCommit(fn) { /* ... */ }

/** update() [existing, extended]: MUST call _refreshWxh() UNCONDITIONALLY near the
 *  top, BEFORE the dirty-check early return at measure.js:120 (which fires on
 *  structurally-unchanged room sets — i.e. selection change, unit toggle, hover,
 *  drag). Do NOT append the W×H refresh to the tail of update(); it would be
 *  unreachable for exactly those events. */
export function update() { /* ... _refreshWxh() first, then existing row logic ... */ }

/** _refreshWxh() [new, private]: resolve getSelectedRoomId() → room;
 *  show + prefill (fmtLen w/h from rectDims, unitLabel) iff isRectangle(room);
 *  else hide. Skip prefill of a field that currently has focus (document.activeElement).
 *  Self-contained: does not read newRows/_lastRows, so it is safe to call before
 *  either update() branch. */
function _refreshWxh() { /* ... */ }

/** applyWxH() [new, private → bound to Set/Enter]:
 *  const dims0 = rectDims(room);   // capture BEFORE any mutation
 *  parse both fields via parseLen; validate (null / <MIN_SEG_M → flag field, return);
 *  per axis, skip if fmtLen(target)===fmtLen(<dims0.w | dims0.h>)  // "current" from
 *  the pre-mutation snapshot, never re-derived after the W call;
 *  rescaleRectEdge(room, dims0.wEdge, wM); rescaleRectEdge(room, dims0.hEdge, hM);
 *  if anything changed → historyCommit() once; scheduleRender(). */
```

### `src/js/main.js` — wiring (measure currently gets neither injection)

```js
// after initMeasure(...) and after roomTool + history are available:
measureSetSelectedRoomAccessor(roomGetSelectedRoomId); // roomTool.getSelectedRoomId
measureSetHistoryCommit(historyCommit);
// pass the new W×H element refs into initMeasure({ ..., wxhBox, wxhW, wxhH, wxhUnit, wxhApply })
```

### Unchanged / reused

- `walls.isRectangle`, `walls.rescaleRectEdge`, `walls.edgeLength`, `walls.MIN_SEG_M` (LLD 63).
- `roomTool.getSelectedRoomId()` (LLD 63) — the single source of "which room".
- `units.fmtLen`, `units.parseLen`, `units.unitLabel`, `units.onChange` (metric/imperial handling).
- `history.commit()`, `surface.scheduleRender()`.
- `dimEntry.js` — **not touched.** Its single-edge path is the complementary gesture.

## State Model

**Persisted (localStorage / URL hash / export):** unchanged. Apply mutates
`walls.model.rooms[*].verts` in place — the exact array LLD 63 and `plan.buildPlan()` already
serialize. **No new persisted keys. `plan.js` is not touched** (disjoint from #91). The autosave
`onRender` hook and share-hash encoder pick up the change with no serialization change.

**No new selection state.** "Which room" is `roomTool._selectedRoomId` (LLD 63); this LLD only
*reads* it via `getSelectedRoomId()`. Unit preference stays in `units.js`.

**Session-only, in-memory (owned by `measure.js`):**

| State | Meaning | Lifetime |
| --- | --- | --- |
| W × H input field text | uncommitted typed values | until Apply / Escape / blur re-prefill / re-render prefill |

The W × H fields are a *view* of the selected room's side lengths — they are re-prefilled from
geometry on each `update()` (except a field the user is actively focused in). Nothing about the
block persists across reload.

**History commit lifecycle:**

| Gesture | Call site | Notes |
| --- | --- | --- |
| W × H Apply (≥1 axis changed) | `measure.applyWxH` → one `history.commit()` | 1 undo step reverts both edited sides together. |
| W × H Apply with both axes no-op | (none) | Skipped by the `fmtLen`-equality check; no commit. |

**Not commit points:** typing in a field, showing/hiding the block, prefill re-renders.

## Edge Cases

1. **Nothing selected / a symbol selected.** `getSelectedRoomId()` is `null` → block hidden. Panel
   looks exactly as today.
2. **Non-rectangular room selected** (L-shape, triangle, 5+ verts, open polyline, non-right angles).
   `isRectangle(room)` false → block hidden. We do not force a W × H onto a shape without one.
3. **Selected room becomes non-rectangular after a dim-chip edit** (e.g. an L-shape resize). Next
   `update()` re-evaluates `isRectangle` and hides the block. No stale W × H shown.
4. **Selected room stops existing** (deleted, or plan reset). `getSelectedRoomId()` still returns an
   id but `model.rooms.find` misses → treat as "no room", hide the block. (LLD 63 does not currently
   add room-delete, so this is defensive.)
5. **One field empty or non-numeric.** `parseLen` returns `null` → flag that field invalid, keep
   block open, no geometry change, no commit.
6. **A field ≤ 0 or below `MIN_SEG_M`.** `parseLen` rejects ≤ 0 (returns `null`); a tiny-but-positive
   value is caught by `rescaleRectEdge` returning `false` → flag that field invalid, no commit.
7. **Both fields unchanged (Apply with prefilled values).** Both axes hit the
   `fmtLen(target)===fmtLen(current)` no-op check → nothing mutated, no history commit. Block stays.
8. **Only one field changed.** The unchanged axis is skipped (no-op check); the changed axis calls
   `rescaleRectEdge`; **one** commit. Undo reverts the single changed side.
9. **Unit toggle while block is open.** A unit change alters only row/field *text*, not the room set,
   so `update()` hits the dirty-check early return (measure.js:120) — this is exactly why
   `_refreshWxh()` runs **before** that return (see Approach). On the unit-change re-render fields
   re-prefill in the new unit — **except** a field the user currently has focused (guard with
   `document.activeElement`), so mid-typing is not clobbered. `parseLen` still honours an explicit
   `ft`/`m`/`'` suffix regardless of the active unit. (If `_refreshWxh` were tail-placed, the toggle
   would never re-prefill because the early return would skip it.)
10. **Very large value.** No upper clamp (rooms have no catalog max); the far wall slides and the
    room may exceed the viewport — acceptable, matches drawing arbitrarily large rooms and the
    dim-chip path. Autosave + share round-trip.
11. **Tilted (off-axis) rectangle.** `rectDims` still returns two side lengths (labels approximate);
    each `rescaleRectEdge` grows the room along its own local axis and keeps it rectangular. Correct.
12. **Near-rectangle within `isRectangle` tolerance (e.g. 88° corners).** Block shows; each
    `rescaleRectEdge` sets the edited side to the typed length via translation and does **not**
    square up the corners (consistent with LLD 63 Edge Case 13). No regularization promised.
13. **Concurrent dim-chip edit open.** The two paths are independent; a W × H Apply reads current
    geometry at Apply time. If a dim-chip input is mid-open its own commit/cancel is unaffected.
    (They target the same room but distinct user actions; last-committed wins, each its own history
    step.)
14. **Rapid re-render during typing.** `update()` runs each frame and `_refreshWxh()` runs on every
    invocation (above the dirty-check return), so it fires even on hover-driven re-renders that leave
    the room set unchanged. It must therefore **not** reset a field the user is focused in (Edge Case
    9 guard via `document.activeElement`) — otherwise those frequent re-renders would wipe input
    mid-type.

## Dependencies

**Blocked on LLD 63 merged** (already merged — `isRectangle`, `rescaleRectEdge`, `roomTool`,
`getSelectedRoomId` are present in `walls.js` / `roomTool.js` on `main`).

**Must already exist (all present):**

- `walls.isRectangle`, `walls.rescaleRectEdge`, `walls.edgeLength`, `walls.MIN_SEG_M` — LLD 63.
- `roomTool.getSelectedRoomId()` — LLD 63 room selection.
- `units.fmtLen`, `units.parseLen`, `units.unitLabel`, `units.onChange` — display/parse + toggle.
- `history.commit()`, `surface.scheduleRender()`, `measure.js` `onRender` `update()` hook.
- `.measure-body` markup in `index.html`.

**New surface added by this LLD:**

- `walls.rectDims(room)` (pure).
- W × H markup + CSS in `index.html`; W × H render/apply logic in `measure.js`; two injections in
  `main.js` (`setSelectedRoomAccessor`, `setHistoryCommit`).

**No new third-party dependencies. No build step. `plan.js` / `mcp/` untouched.**

**Ordering:** `walls.rectDims` first (unit-testable in isolation), then `index.html` markup, then
`measure.js` render/apply, then `main.js` injections.

**Disjointness note (#91):** this LLD deliberately touches no serialization. If #91 (share codec)
lands first, there is no overlap — W × H writes only to `rooms[*].verts`, which both LLDs already
treat as the source of truth.

## Test Requirements

Unit tests in `test/tests.html` (the `describe`/`it`/`expect` harness); integration via Playwright
under `.github/run-tests.mjs`. `rectDims` is imported from `../src/js/walls.js`.

### Unit — `walls.rectDims`

- Axis-aligned rectangle `v0=(0,0) v1=(4,0) v2=(4,3) v3=(0,3)`: returns `w≈4, h≈3`, `wEdge` a member
  of `{0,2}` (the horizontal pair), `hEdge` a member of `{1,3}`.
- Rectangle taller than wide: width still maps to the more-horizontal pair.
- Rectangle rotated 30°: returns the two true side lengths; `wEdge`/`hEdge` are perpendicular.
- Returns `null` for a non-rectangle (triangle, L-shape, open polyline).
- The returned `wEdge`/`hEdge` fed back into `rescaleRectEdge` change the expected side (integration
  with LLD 63 geometry): setting via `wEdge` changes `w` and leaves `h` unchanged, and vice-versa.

### Unit — apply logic (extract `applyWxH` core or test via a light DOM rig)

- Valid W and H → both sides become the typed lengths (metres), room still `isRectangle`,
  exactly one `history.commit()` fires.
- Only W changed → H side length unchanged; still one commit.
- Both unchanged (prefilled) → no `rescaleRectEdge` mutation, **zero** commits.
- Invalid field (`parseLen` null, or `< MIN_SEG_M`) → no mutation, no commit, field flagged.
- Values respect the active unit: with unit `ft`, entering `10` sets the side to `10*M_PER_FT` m;
  an explicit `3m` suffix overrides the toggle (via `parseLen`).

### Unit / DOM — visibility rule

- Block hidden when `getSelectedRoomId()` is null.
- Block hidden when the selected room is not `isRectangle`.
- Block shown + prefilled (in active unit) when a rectangular room is selected.
- A focused field is NOT re-prefilled on a re-render (mid-edit not clobbered).
- **Early-return regression:** with the room set structurally unchanged (so `update()` takes the
  dirty-check in-place path and early-returns at measure.js:120), changing only the selection —
  select then deselect a rectangular room — still shows then hides the block. This proves
  `_refreshWxh()` runs before the early return, not after it.
- **Unit toggle re-prefill:** toggling units on a stable room set (also an early-return frame)
  re-prefills the (unfocused) fields in the new unit.

### Integration (Playwright)

- Draw a rectangle, select it (Select tool, click interior), enter W and H in the measure panel,
  click Set → the room resizes to the typed W × H, stays rectangular, and a single Ctrl+Z reverts
  the whole change; Ctrl+Y re-applies.
- Enter in a field applies (equivalent to Set).
- Select a non-rectangular (L-shaped) room → the W × H block is not shown; dim-chip edit still works.
- Toggle ft↔m with a rectangle selected → the fields re-prefill in the new unit; entered values are
  interpreted in the shown unit.
- Persistence: set W × H, reload (localStorage) — geometry restores; share-hash export/import
  round-trips identically (confirms `plan.js` untouched still serializes the verts).

### Regression (must stay green)

- **Dim-chip single-edge edit (LLD 63 / LLD 09) unchanged** — the W × H control is additive; the
  click-a-wall-dimension gesture must behave exactly as before.
- `walls.rescaleRectEdge` / `isRectangle` unit tests (LLD 63) — untouched.
- Measure panel area/perimeter rows + hover-highlight (LLD 37) — unaffected by the new block.
- MCP `set_edge_length` tests — untouched (`mcp/` not modified).
