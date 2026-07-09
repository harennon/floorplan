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
(room-center is a *center* snap; edges never participate).

**Single-room selection (the key departure from `nearestObjectAlignment`).** Unlike object
alignment — where `bestX` and `bestY` are chosen independently across all candidates —
room-center commits to **one** target room per call and emits both axes from *that room
only*. This is deliberate: a centroid is a single point, so allowing X to snap to roomA's
centroid while Y snaps to roomB's centroid would land the symbol on **no** centroid at all
and leave the ring marker (drawn at a room's `{cx,cy}`) floating away from the symbol center
— a misleading "you are on the room center" cue. Committing to one room keeps the centroid
snap coherent and the ring truthful.

Selection algorithm:

1. For each closed room center, compute `dx = room.cx − dragAABB.cx`, `dy = room.cy −
   dragAABB.cy`.
2. A room is **eligible** if at least one axis is within threshold: `|dx| ≤ thresholdM`
   **or** `|dy| ≤ thresholdM`.
3. Among eligible rooms, pick the one minimizing squared distance `dx² + dy²` from the drag
   center to the centroid. Ties → first-seen (documented, not load-bearing). This naturally
   favors a room the symbol is near-centered in (both axes in range ⇒ small distance) over a
   room offering only a distant mid-line.
4. From the **chosen room only**, emit `x` match iff `|dx| ≤ thresholdM` and `y` match iff
   `|dy| ≤ thresholdM`. Both matches carry that room's centroid in `center`.

If no room is eligible, return `{x:null, y:null}`. Every emitted match is
`kind:"room-center"`.

Consequence: when both axes match, they come from the same room, so the symbol lands exactly
on that centroid and the ring coincides with the symbol center (resolves Edge Case 8). When
only one axis matches (mid-line snap), the symbol sits on that mid-line and the ring sits on
the guide line at the room's true center — a correct "this line is the room's mid-line" cue,
not a floating marker.

Guides (per emitted match, centroid treated as a zero-size point à la LLD-34 span rule):

- **X match → vertical guide** at `x = room.cx`, spanning `y ∈ [min(dragAABB.minY, room.cy),
  max(dragAABB.maxY, room.cy)]`.
- **Y match → horizontal guide** at `y = room.cy`, spanning `x ∈ [min(dragAABB.minX,
  room.cx), max(dragAABB.maxX, room.cx)]`.
- The chosen room's centroid `{cx, cy}` is carried on each match (new optional `center`
  field). Because both axes (when present) come from the same room, the resolver has a single
  unambiguous `{cx,cy}` for the ring marker regardless of which axis wins tier-4 contention.

### Resolver — tier 4 shared with object alignment (in `symbolTool.js`)

`_resolvePlacement` keeps its per-axis precedence **Alt > wall-flush > tier 4 > grid > raw**.
Tier 4 now contains **both** object alignment and room-center; they are peers. For each axis
**not already claimed by wall-flush**, when `prefs.gridSnap()` is on:

1. Compute `objectMatch = nearestObjectAlignment(...)` (LLD 34, unchanged) and
   `roomMatch = nearestRoomCenter(dragAABB, _roomCenters, roomThreshM)`. `roomMatch`'s X and
   Y (when both present) are guaranteed to reference the **same** room (single-room selection,
   see Match geometry), so the two axes never disagree about which centroid the ring marks.
2. Per axis, among the available matches (either/both/neither), pick the one with the
   **smaller `|delta|`** ("nearer target wins the axis"). Apply its delta, mark the axis
   `snapType = "align"`, and record the chosen match (with its `kind`) for the guide. Note the
   axes are resolved independently *here* only to arbitrate room-center vs. object-align on
   each axis; the room-center candidate itself is already axis-coherent from step 1, so a
   full centroid snap (both axes room-center) always lands the symbol on that one centroid.
3. Ties (`|delta|` within `1e-9`): prefer object alignment (it is the finer, edge-aware snap
   and shipped first) — documented, not load-bearing.

**On the two tie rules.** Inter-room ties inside `nearestRoomCenter` resolve first-seen
(step 3 of Match geometry); tier-4 object-vs-room ties inside `_resolvePlacement` prefer
object alignment (item 3 above). These are different scopes — one picks *which room*, the
other picks *which snap class on an axis* — and both are deliberately arbitrary tie-breaks on
exact-`|delta|` coincidences that are vanishingly rare with float world coordinates. Their
interaction on a doubly-contested axis is intentional and not load-bearing: no correctness
property depends on either choice.

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
  `stroke = var(--room-center)`, `stroke-width 1.4`, `fill none`) centered at the **chosen
  room's centroid `{cx, cy}`**, rendered into `#symbol-overlay`. Because `nearestRoomCenter`
  commits to a single room, both emitted axis matches carry the *same* `{cx,cy}`, so the ring
  position is unambiguous no matter which axis (or both) survives tier-4 contention. Drawn
  once whenever any active align match has `kind:"room-center"` (read `center` from whichever
  such match is present). Reuse the same per-frame clear/re-append path as the guides. It is
  `aria-hidden` decoration with `pointer-events: none`.

  **Semantics — the ring is a landmark, not a "symbol is here" dot.** It always sits at the
  room's true centroid, which lies on the active room-center guide line(s). When both axes
  snap to that room, the ring coincides with the symbol center (full centroid snap). When
  only one axis is a room-center snap (mid-line snap, or the orthogonal axis went to
  wall-flush / object-align), the ring still marks the room centroid on the active mid-line
  guide — reinforcing "this line is the room's mid-line" rather than implying the symbol is
  centered. This is intentional and consistent: the ring never floats off its own guide.

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
 * Snap of the dragged AABB CENTER to a SINGLE room's centroid / mid-lines.
 * Selects one target room (min dx^2+dy^2 among rooms with at least one axis in
 * threshold; ties first-seen), then emits x and/or y matches from THAT room only,
 * so both returned axes share one centroid (ring marker is unambiguous, full snap
 * lands exactly on the centroid). Pure: no global reads. Only cx/cy of the drag
 * AABB participate (center-only snap).
 * @param {{minX,maxX,cx,minY,maxY,cy}} dragAABB
 * @param {{ cx:number, cy:number }[]} roomCenters
 * @param {number} thresholdM
 * @returns {import("./symbols.js").AlignResult}   // { x:AlignAxisMatch|null, y:... }; both from same room
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
8. **Both axes match centroid** → because `nearestRoomCenter` commits to a single room, both
   axes reference the *same* centroid, so the symbol lands exactly on that centroid; two rose
   guides (vertical + horizontal L-bracket) + one ring marker at that room's `{cx,cy}`, which
   now coincides with the symbol center. (No X-from-roomA / Y-from-roomB hybrid is possible.)
9. **Multiple rooms in range** → one room is chosen (min `dx²+dy²` from drag center to
   centroid; ties first-seen), and both axes come from that room. A room in range on X and a
   different room in range on Y can never split the two axes (single-room selection); the
   nearer centroid overall wins the whole snap.
10. **Dragged symbol is itself inside/over a room** → still snaps to that room's centroid;
    intended (centering a table in its own room is the headline use case).
11. **Rotated furniture** → uses the AABB center (`cx`/`cy`), which equals the symbol center
    regardless of rotation, so a rotated table still centers correctly.
12. **Nested / overlapping rooms** → each closed room yields its own centroid, but a single
    room is chosen per frame (min `dx²+dy²`, Edge Case 9), so the symbol always snaps to one
    coherent centroid and the ring marks that one room. No hybrid X-from-one / Y-from-another
    landing. Acceptable; the user is actively dragging.
13. **Non-convex (L-shaped) room** → the true polygon centroid can fall outside the floor
    area (in the notch, or in a wall). We snap to it anyway — it is the mathematically correct
    centroid / balance point. **Known UX wrinkle:** for the headline "center a table in its
    own room" flow (Edge Case 10), this can place the table into a wall or notch, which reads
    as wrong for a "does my couch fit" tool even though it is geometrically correct. We accept
    this for v1 because (a) L-shaped rooms are a minority of the lowest-frequency snap case,
    (b) the snap is only a suggestion during an active drag the user can override (Alt, or
    just drag past threshold), and (c) computing a guaranteed-interior "visual center" (e.g.
    pole-of-inaccessibility) is materially more code than this small, deferrable feature
    warrants. If real usage shows this biting users, revisit with a visual-center algorithm.
    **Flagged for CEO/CX:** confirm shipping the mathematical centroid for non-convex rooms is
    acceptable, or whether the parent #23 flow needs the interior-point variant instead.
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
- Two rooms in range → the room with smaller `dx²+dy²` is chosen; both emitted axes carry
  that room's `center` (never a mix of two rooms' centroids).
- **Single-room coherence:** roomA in range on X only, roomB in range on Y only → the chosen
  room emits only its in-range axis; the other axis is `null` (no X-from-A / Y-from-B split).
  When both axes match, both `center` values are identical.
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
