# LLD 37: Room-center / mid-line snap to room centroid

Parent issue: #23 · Order 3 of 3 · Effort: small · Depends on: LLD 34 (object-to-object
alignment snapping with transient drag guides)

## Scope

The last piece of the #23 snapping cluster. Adds a fourth per-axis snap target — the
**room centroid and its horizontal/vertical mid-lines** — to the existing symbol placement
resolver built in LLD 26 (wall-flush) and LLD 34 (object alignment + transient guides).
Two files carry the logic, exactly mirroring LLD 34:

1. **Room-center snap** — while dragging/placing a symbol, its center (the AABB center
   `cx`/`cy`) snaps, **per axis**, to a room's centroid X and/or centroid Y. Snapping X to a
   room's centroid X is the *vertical mid-line* alignment; snapping Y is the *horizontal
   mid-line* alignment; both together lands the symbol on the centroid.
2. **Guide reuse** — reuse the LLD-34 transient guide `<g>` renderer (`<line>` + filled
   chip + `<text>`) and its per-frame clear/re-append plumbing entirely. Add a small
   centroid **ring marker** (Direction B) at the target centroid. Guides appear only during
   an active drag and are cleared on drop.
3. **Toggle + precedence** — obey the existing persistent `prefs.gridSnap()` toggle (same
   control as grid + object alignment) and honor the Alt free-snap bypass. Slot in at the
   **same precedence tier as object alignment (tier 4)**: alignment/center targets beat the
   nearest grid line, lose to wall-flush; on a contested axis the nearer target wins.

### Explicitly NOT in scope

- New geometry dependencies. Centroid is derived from existing `walls.js` room vertices.
- A separate room-center on/off control. Reuse the single `prefs.gridSnap()` toggle.
- Snapping the symbol's *edges* to room mid-lines — this feature is **center-only**
  (centroid / mid-line). Edge alignment stays object-to-object (LLD 34).
- Snapping to *open* rooms/chains, or to a room's bounding-box center. Centroid is the true
  polygon centroid of **closed** rooms only.
- Any change to wall-flush (LLD 26), object alignment (LLD 34), grid step, zoom, or the
  precision chip (#22/#27).
- Rotation/angle snapping. Room-center is translation-only, world-axis-aligned.

## Approach

### Where the change lands

Same two files as LLD 34, plus a one-line CSS token addition:

- **`walls.js`** — add a pure helper `roomCentroids()` that returns the true polygon
  centroid `{cx, cy}` of every **closed** room. Uses the standard signed-area centroid
  formula, consistent with the existing `polygonArea` shoelace sum. No global reads beyond
  `model.rooms` (mirrors `wallSegments()` / `allVertices()`).
- **`symbols.js`** — add a pure helper `nearestRoomCenter(dragAABB, roomCenters, thresholdM)`
  paralleling `nearestObjectAlignment`. Returns the **same `AlignResult` shape** (`{x, y}` of
  `AlignAxisMatch|null`) so the existing guide plumbing in `symbolTool.js` consumes it with
  no structural change; the only new thing is a `kind:"room-center"` value. Reuse the
  `AlignPX`-style screen-px threshold constant `ROOM_CENTER_PX`.
- **`symbolTool.js`** — extend `_resolvePlacement` to compute room-center matches in the
  **same tier 4 as object alignment** and, per axis, pick the nearer of the two. Feed a
  `kind:"room-center"` guide into the existing `_updateGuides` list and add a small centroid
  ring marker. Build the per-gesture room-center candidate list once at gesture start, like
  `_candidateAABBs`.

The mandate is strict reuse: **do not build a new guide system.** Room-center rides the
LLD-34 `#symbol-overlay` `<g>` renderer, per-frame clear/re-append (`repositionGuides`),
`.snap-tag`, Alt handling, and toggle gate.

### Centroid geometry — `walls.js` `roomCentroids()`

The true polygon centroid (not the bounding-box center, not the vertex average) so a symbol
lands where a person reads "the middle of the room":

```
A  = ½ · Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)                    (signed area, i+1 mod n)
Cx = 1/(6A) · Σ (xᵢ + xᵢ₊₁)(xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)
Cy = 1/(6A) · Σ (yᵢ + yᵢ₊₁)(xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)
```

- Only **closed** rooms with `verts.length ≥ 3` contribute. Open rooms/active chain are
  skipped (Edge Case 3).
- **Degenerate polygon** (`|A| < 1e-9`, i.e. collinear verts): skip that room — no centroid
  (Edge Case 4). Never divide by zero.
- Winding-order-independent (the signed `A` cancels sign correctly), so it works regardless
  of whether the room was drawn CW or CCW.

### Match geometry — `symbols.js` `nearestRoomCenter()`

The dragged symbol's reference points are its AABB center only — `cx` on X, `cy` on Y
(room-center is a *center* snap; edges never participate). For each room center and each
axis:

- X: `gap = room.cx − dragAABB.cx`; if `|gap| ≤ thresholdM` it is a candidate translation.
- Y: `gap = room.cy − dragAABB.cy`; symmetric.

Keep the smallest `|gap|` per axis across all rooms. Every match is `kind:"room-center"`.

- **X match → vertical guide** at `x = room.cx`, spanning `y ∈ [min(dragAABB.minY, room.cy),
  max(dragAABB.maxY, room.cy)]` — bracketing symbol-to-centroid (Direction B), matching the
  LLD-34 span rule with the centroid treated as a zero-size point.
- **Y match → horizontal guide** at `y = room.cy`, spanning `x ∈ [min(dragAABB.minX,
  room.cx), max(dragAABB.maxX, room.cx)]`.
- The matched room's centroid `{cx, cy}` is carried on the match (new optional `center`
  field) so the resolver can place the ring marker. On X/Y ties between rooms, first-seen
  wins (documented, not load-bearing).

### Resolver — tier 4 shared with object alignment (in `symbolTool.js`)

`_resolvePlacement` keeps its per-axis precedence **Alt > wall-flush > tier 4 > grid > raw**.
Tier 4 now contains **both** object alignment and room-center; they are peers. For each axis
**not already claimed by wall-flush**, when `prefs.gridSnap()` is on:

1. Compute `objectMatch = nearestObjectAlignment(...)` (LLD 34, unchanged) and
   `roomMatch = nearestRoomCenter(dragAABB, _roomCenters, roomThreshM)`.
2. Per axis, among the available matches (either/both/neither), pick the one with the
   **smaller `|delta|`** ("nearer target wins the axis"). Apply its delta, mark the axis
   `snapType = "align"`, and record the chosen match (with its `kind`) for the guide.
3. Ties (`|delta|` within `1e-9`): prefer object alignment (it is the finer, edge-aware snap
   and shipped first) — documented, not load-bearing.

Grid then fills any still-unclaimed axis, exactly as today. The dominant `.snap-tag`
`snapType` priority is unchanged (`flush > align > grid > free`); room-center reports as
`align` with a rose tag color (see Frontend Design).

Threshold: reuse the LLD pattern — a screen-px constant converted to metres at resolve time.
`ROOM_CENTER_PX = 8`, matching `ALIGN_PX` so the two tier-4 snaps have equal reach and the
per-axis nearer-wins comparison is fair; both stay `< WALL_FLUSH_PX (12)` so a nearby wall
reliably wins a contested axis.

### Toggle semantics (inherited, unchanged)

- **Grid, object alignment, and room-center** all obey `prefs.gridSnap()` — toggle OFF
  disables all three.
- **Wall-flush** stays active regardless (LLD 26 decision, inherited, not changed here).
- **Alt** always yields raw on all axes and clears all guides, independent of the toggle.

## Frontend Design

**Frontend decision: Direction B (centroid marker + bracketed guides), new rose
`--room-center` (`#e08fbf`).** Settled by the CEO to keep the backlog moving; not re-opened
here. Rationale: bracketed guides that bridge only symbol-to-centroid match the LLD-34
object-guide span rule and add the least chrome during a drag (vs. full crosshair mid-lines
across the room, Direction A). A distinct rose token — alongside object-center teal
(`#7fd0c8`) and edge violet (`#b98bd9`) — gives one color per snap-target class so
room-center cues aren't confused with object-center cues.

### Colors

| snap / guide       | color               | token                | status                 |
| ------------------ | ------------------- | -------------------- | ---------------------- |
| room-center (this) | rose `#e08fbf`      | `--room-center`      | **new**                |
| object edge (#34)  | violet `#b98bd9`    | `--align-edge`       | unchanged              |
| object center (#34)| teal `#7fd0c8`      | `--align-center`     | unchanged              |
| wall-flush (#26)   | green `#9cd67a`     | (inline)             | unchanged              |
| grid / free        | teal / muted        | (inline)             | unchanged              |

Add `--room-center: #e08fbf;` to the existing `:root` block next to `--align-edge` /
`--align-center` (index.html ~line 340).

### Centroid ring marker + bracketed guides (Direction B)

Per active room-center match:

- **Guide line(s):** reuse the LLD-34 `.align-guide` `<g>` (solid `<line>`, `stroke-width
  1.4`, no dash) with `stroke = var(--room-center)`. X match → vertical guide; Y match →
  horizontal; both → an L of two rose guides bracketing symbol-to-centroid. Same filled chip
  as LLD 34: rounded `rect` filled rose, text ink `#14140f`, label `"room"` (short; refine
  later without a design change).
- **Centroid ring marker (new, the only new visual):** a small hollow `<circle>` (r ≈ 4px,
  `stroke = var(--room-center)`, `stroke-width 1.4`, `fill none`) centered at the matched
  room's `{cx, cy}`, rendered into `#symbol-overlay`. It reads as a distinct "you are on the
  room center" cue and disambiguates centroid snap from object-center snap. Drawn once when
  either axis matches (use the axis match that carries `center`); reuse the same per-frame
  clear/re-append path as the guides. It is `aria-hidden` decoration with `pointer-events:
  none`.

Implement the ring by extending the guide `<g>` (append a `<circle class="room-center-ring">`)
or as a sibling element in the same overlay group — implementer's choice; it must ride the
existing `repositionGuides()` recompute so it tracks pan/zoom mid-drag.

### Transience (minimal-chrome ethos)

- Ring + guides appear the instant a room-center match is found during a drag, recomputed
  each pointer move, and cleared on every gesture-end path (`onSelectUp`, dock `_onUp`) by
  the existing `_clearGuides()`. Nothing persists on the canvas, in export JSON, or the share
  hash.
- Reuse the LLD-34 `.align-guide { transition: opacity 120ms }` fade, disabled under
  `@media (prefers-reduced-motion: reduce)`.

### Cursor snap-tag

Extend the LLD-34 `_updateSnapTag` align-color logic: when the dominant align match is
`kind:"room-center"`, color the tag rose (`--room-center`); mixed room-center + object still
resolves per the existing "all center → teal, any edge → violet" rule, with room-center
treated as its own rose class. Label stays `"align"`. Grid, flush, free unchanged.

### Toggle control

No new control. The existing `#hud-grid-toggle` already gates grid + object alignment; it
now also gates room-center (all read `prefs.gridSnap()`). Label/glyph unchanged.

## Interfaces / Types

### New in `src/js/walls.js`

```js
/**
 * True polygon centroids of every CLOSED room (>=3 verts, non-degenerate).
 * Pure: reads only model.rooms. Skips open rooms and degenerate (|area|<eps) polygons.
 * @returns {{ id:string, cx:number, cy:number }[]}   // world metres
 */
export function roomCentroids();
```

Signed-area centroid formula (see Approach). Uses the same shoelace term as `polygonArea`;
`id` is carried for debugging/tests but not used by the resolver.

### New in `src/js/symbols.js`

```js
/** Screen-px room-center threshold; converted to metres by the caller. */
export const ROOM_CENTER_PX = 8;

/**
 * AlignAxisMatch is reused from LLD 34, with:
 *   - kind extended to include "room-center"
 *   - an optional `center:{x,y}` field carrying the matched room centroid
 *     (present only for kind==="room-center"; drives the ring marker).
 * @typedef {{
 *   delta:number, line:number,
 *   kind:"edge"|"center"|"room-center",
 *   guide:{ a:{x,y}, b:{x,y} },
 *   center?:{ x:number, y:number }
 * }} AlignAxisMatch
 *
 * Nearest per-axis snap of the dragged AABB CENTER to any room centroid / mid-line.
 * Pure: no global reads. Only cx/cy of the drag AABB participate (center-only snap).
 * @param {{minX,maxX,cx,minY,maxY,cy}} dragAABB
 * @param {{ cx:number, cy:number }[]} roomCenters
 * @param {number} thresholdM
 * @returns {import("./symbols.js").AlignResult}   // { x:AlignAxisMatch|null, y:... }
 */
export function nearestRoomCenter(dragAABB, roomCenters, thresholdM);
```

Keep `nearestRoomCenter` pure and exported so it is unit-tested directly, exactly like
`nearestObjectAlignment`.

### Changed in `src/js/symbolTool.js`

- Import `roomCentroids` from `walls.js` and `ROOM_CENTER_PX`, `nearestRoomCenter` from
  `symbols.js`.
- New per-gesture state `_roomCenters: {cx,cy}[]`, populated alongside `_candidateAABBs` at
  every gesture start (`onSelectDown` move-drag branch, dock `_onDockPointerDown`, dock
  `_onUp` drop resolve) and cleared on gesture end. Rooms don't move during a symbol drag, so
  it is built once per gesture like the AABB list.
- `_resolvePlacement(...)` — tier-4 block extended to compute `nearestRoomCenter` and, per
  unclaimed axis, choose the nearer of object-align vs room-center by `|delta|` (see
  Approach). Return shape unchanged (`{ x, y, snapType, _flushActive, _alignX, _alignY }`);
  `_alignX` / `_alignY` may now carry a `kind:"room-center"` match.
- `_updateGuides(resolved)` — the existing loop over `_alignX` / `_alignY` picks the guide
  color from `kind`: extend the `center ? teal : violet` choice to `kind==="room-center" ?
  rose : (kind==="center" ? teal : violet)` and set label `"room"`. Add the ring marker when
  any active align match has `kind:"room-center"` (using its `center`).
- `repositionGuides()` / `_clearGuides()` — extended to reposition/remove the ring marker
  alongside the existing align `<g>` elements.
- `resolvePlacementForTest(sx, sy, altHeld, boxLike, candidateAABBs, roomCenters?)` — add an
  optional `roomCenters` param that temporarily swaps `_roomCenters` (same pattern as the
  existing `_candidateAABBs` swap) so the resolver is testable in isolation.
- Add `_COLOR_ROOM = "#e08fbf"` next to `_COLOR_EDGE` / `_COLOR_CENTER`; extend
  `_SNAP_TAG_COLORS` handling for the rose case.

### Unchanged / reused

- `symbols.corners`, `symbols.aabb`, `symbols.nearestObjectAlignment`, `ALIGN_PX`,
  `symbols.model`; `walls.model`, `walls.wallSegments`, `walls.polygonArea`.
- `grid.snapStep`, `prefs.gridSnap`, `view.screenToWorld/worldToScreen/pxPerM`.
- `#symbol-overlay`, `.snap-tag`, `.align-guide` renderer, `main.js` `onRender` hook.

## State Model

- **Room centers / matches / guides / ring** — fully transient, recomputed per pointer move,
  never persisted. `_roomCenters` is built once per gesture start (rooms are static during a
  symbol drag) and cleared on gesture end. Matches and their guide/ring DOM live only for the
  drag. Nothing is added to the plan document, export JSON, or share hash.
- **Guide + ring DOM** — SVG nodes in `#symbol-overlay`. `symbolRender` clears the overlay
  each frame; `repositionGuides()` (post-render hook) re-appends and recomputes screen coords
  so they survive pan/zoom mid-drag — the exact mechanism LLD 26/34 use.
- **`prefs.gridSnap`** — unchanged persisted boolean; now also gates room-center.
- **`_altHeld`** — unchanged transient flag.
- No new persisted state of any kind. `roomCentroids()` is derived on demand from
  `walls.model.rooms`; it stores nothing.

## Edge Cases

1. **Alt held** → raw on both axes; guides + ring cleared; toggle state irrelevant.
2. **Toggle OFF** → room-center (with grid + object alignment) disabled; only wall-flush may
   act. No room-center guide or ring shown.
3. **No closed rooms** (only open chains / <3 verts) → `roomCentroids()` returns `[]`;
   `nearestRoomCenter` returns `{x:null, y:null}`; behaves as object-align/grid/flush/raw.
4. **Degenerate polygon** (collinear verts, `|area| < 1e-9`) → that room contributes no
   centroid; no divide-by-zero. Other rooms still contribute.
5. **Room-center vs object-alignment on the same axis** → tier-4 nearer-`|delta|` wins;
   ties prefer object alignment. The losing snap is not applied on that axis.
6. **Room-center on one axis, object-align on the other** → both apply independently; two
   guides render, colored per their own `kind` (rose room-center + violet/teal object).
7. **Wall-flush claims an axis** → room-center (and object-align) skip that axis entirely;
   room-center may still claim the orthogonal axis.
8. **Both axes match centroid** → symbol lands on the centroid; two rose guides (vertical +
   horizontal L-bracket) + one ring marker at `{cx,cy}`.
9. **Multiple rooms in range on an axis** → smallest `|gap|` wins; inter-room ties first-seen.
10. **Dragged symbol is itself inside/over a room** → still snaps to that room's centroid;
    intended (centering a table in its own room is the headline use case).
11. **Rotated furniture** → uses the AABB center (`cx`/`cy`), which equals the symbol center
    regardless of rotation, so a rotated table still centers correctly.
12. **Nested / overlapping rooms** → each closed room yields its own centroid; nearest per
    axis wins. Acceptable; the user is actively dragging.
13. **Non-convex (L-shaped) room** → true polygon centroid may lie outside the floor area;
    that is the mathematically correct centroid and matches "balance point" intuition. Noted;
    not special-cased.
14. **Zoom** → threshold is `ROOM_CENTER_PX (8)` converted via `pxPerM()` at resolve time,
    ~8px on screen at any zoom, `< WALL_FLUSH_PX (12)`.
15. **Guide/ring left on canvas** → forbidden; `_clearGuides()` on every gesture-end path
    guarantees a clean canvas (asserted by an integration test).
16. **`.snap-tag` contention with wall tool** → unchanged guard: symbol path writes the tag
    only in select/placement mode.

## Dependencies

- **Blocks on:** LLD 34 merged (it is — `symbolTool.js` has the per-axis `_resolvePlacement`,
  the `.align-guide` transient guide renderer, `AlignAxisMatch`/`AlignResult`,
  `nearestObjectAlignment`, `aabb`, `resolvePlacementForTest`, and the `.snap-tag` +
  `#symbol-overlay` infra). Also transitively LLD 26.
- **Builds on (do not change semantics):**
  - `walls.js` — `model.rooms`, `polygonArea`, `wallSegments`; add `roomCentroids`.
  - `symbols.js` — `aabb`, `corners`, `AlignAxisMatch`/`AlignResult`; add `nearestRoomCenter`,
    `ROOM_CENTER_PX`, extend `AlignAxisMatch.kind`.
  - `symbolTool.js` — `_resolvePlacement`, `_updateGuides`, `repositionGuides`,
    `_clearGuides`, `_updateSnapTag`, `resolvePlacementForTest`, `_candidateAABBs` pattern.
  - `grid.js` `snapStep`, `prefs.js` `gridSnap`, `view.js`, `main.js` `onRender` hook.
- **CSS:** add `--room-center: #e08fbf;` token and (optional) `.room-center-ring` style to
  the existing inline `<style>` in `index.html` (values from Frontend Design).
- **No new third-party dependencies. No build step.** Pure client-side vanilla JS/CSS.

## Test Requirements

Tests live in the existing `src/tests.html` harness (`describe`/`it`), run headless via
`.github/run-tests.mjs`, matching LLD 26/34.

### Unit — geometry (`walls.roomCentroids`)
- Axis-aligned rectangle room → centroid at its geometric center.
- Triangle room → centroid at the average-of-vertices point (matches signed-area formula).
- Winding order CW vs CCW → same centroid (sign-independent).
- Open room / chain / <3 verts → contributes nothing (`[]` when no closed rooms).
- Degenerate (collinear) closed room → skipped, no NaN/Infinity, other rooms still returned.

### Unit — geometry (`symbols.nearestRoomCenter`)
- Drag AABB center just inside threshold of a room centroid X → X match, `delta` makes
  `cx` coincide, `kind:"room-center"`, `center` carries `{cx,cy}`; `y` null.
- Center within threshold on both axes → both `x` and `y` matches, both `room-center`.
- Beyond threshold on both axes → `{x:null, y:null}`.
- Two rooms in range on one axis → smaller `|gap|` wins.
- Guide span brackets symbol-center to centroid on the orthogonal axis (spot-check `a`/`b`).
- Only the AABB center participates (edges near a centroid do NOT match) — verify a symbol
  whose edge (not center) is near the centroid produces no match.

### Unit — resolver precedence (`_resolvePlacement` via `resolvePlacementForTest`)
- Alt held → `"free"`, raw both axes, no guides/ring (toggle ON and OFF).
- Toggle OFF, room center in range → NOT snapped (gated off); wall-flush still applies if a
  wall is near.
- Toggle ON, room center in range, no wall, no object → `"align"`, axis snapped to centroid.
- **Tier-4 contention:** object-align and room-center both in range on X with different
  `|delta|` → nearer wins; equal `|delta|` → object alignment wins (documented tie rule).
- **Cross-tier:** wall-flush on Y (axis-aligned wall) + room-center on X → Y flush-seated, X
  centered, `snapType` reports `flush`, both cues present.
- Same axis contested by wall-flush + room-center → wall-flush wins (`ROOM_CENTER_PX <
  WALL_FLUSH_PX`).

### Integration (Playwright, `.github/run-tests.mjs`)
- Draw a closed room, drag a table near its center → symbol center coincides with centroid on
  drop; a rose guide + ring appears during the drag.
- Mid-line: drag so only X (or only Y) is near the centroid → symbol snaps that axis, single
  rose guide shown.
- On drop, assert `#symbol-overlay` has no residual guide `<g>` / ring and `.snap-tag` is
  hidden (nothing left on canvas).
- Toggle OFF → no room-center guide/ring and no snap; toggle ON → resumes.
- Hold Alt during a centering drag → no snap, no guide/ring.

### Regression
- LLD-26 wall-flush and LLD-34 object alignment behavior, `.snap-tag`, grid toggle
  persistence unchanged.
- `chooseGridStep` / zoom / precision chip unchanged (#22/#27 tests pass).
- Wall-drawing snapping (`resolveSnap`) unaffected.
- No new key in plan JSON / export / share hash.
