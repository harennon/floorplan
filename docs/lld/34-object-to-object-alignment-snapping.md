# LLD 34: Object-to-object alignment snapping with transient drag guides

Parent issue: #23 · Order 2 of 3 · Effort: medium · Depends on: LLD 26 (persistent snap
toggle + wall-flush snapping)

## Scope

Builds directly on the LLD-26 symbol snap path (`_resolvePlacement` in `symbolTool.js` +
`nearestWallFlush` in `symbols.js`). Four deliverables:

1. **Edge-to-edge (place beside) snapping** — while dragging/placing a symbol, its edges snap
   to align with another symbol's edges. This covers both *contact* ("place the sofa beside the
   table" → dragged edge meets the facing edge, 0-gap) and *edge alignment* (left edge lines up
   with left edge), because every edge of every other symbol is a candidate line.
2. **Center-to-center snapping** — the dragged symbol's center snaps to another symbol's center
   on the X axis and/or the Y axis, independently.
3. **Transient guide lines + labels** — the instant an edge or center lines up, draw a thin
   solid guide line (style B) with a small filled label chip, rendered ONLY during an active
   drag and cleared immediately on drop. Nothing persists on the canvas.
4. **Toggle integration** — alignment snapping and its guides obey the existing persistent
   `prefs.gridSnap` toggle from LLD 26 (same control). Turning snap off disables grid **and**
   alignment together.
5. **Precedence** — a single, per-axis resolution order in the snap path:
   **Alt bypass > wall-flush > object alignment > grid > raw.** Per-axis resolution lets
   wall-flush own one axis while alignment owns the orthogonal axis in the same drag, so they
   never fight.

### Explicitly NOT in scope

- Equal-spacing / distribution guides (the amber `--align-spacing` swatch in the mockup is a
  future idea, not built here).
- Room-center snap (sibling sub-issue #3 of #23).
- Snapping to *walls as alignment targets* (walls are handled by wall-flush, LLD 26).
- Rotation/angle snapping between symbols. Alignment is translation-only, world-axis-aligned.
- A separate alignment on/off control. We reuse the single `prefs.gridSnap` toggle.
- Any change to `chooseGridStep` / zoom / snap-precision chip (owned by #22/#27).

## Approach

### Where the change lands

Two files carry the logic, mirroring LLD 26 exactly:

- **`symbols.js`** — add a pure geometry helper `nearestObjectAlignment(...)` paralleling the
  existing `nearestWallFlush(...)`. No global reads; all candidate geometry injected.
- **`symbolTool.js`** — extend `_resolvePlacement` to resolve **per axis** with the new
  precedence order and a new `"align"` snap type, and generalize the existing single-guide
  overlay plumbing (`_updateFlushGuide` / `repositionFlushGuide`) to render a small set of
  transient guides (wall-flush + up to two alignment guides) with label chips.

We reuse `corners()` for candidate geometry (per the reuse mandate) and the existing
`#symbol-overlay` + `.snap-tag` infrastructure from LLD 26 — no new render layer.

### Candidate geometry — axis-aligned bounding boxes

Object alignment operates on the **world-axis-aligned bounding box (AABB)** of each symbol,
derived from `corners(sym)` (min/max over the 4 rotated corners). Rationale: alignment is a
world-X / world-Y concept ("left edges line up", "centers line up"); AABBs make per-axis
resolution trivial and behave correctly for rotated furniture (you align its visual extent).

For each candidate symbol we precompute `{ minX, maxX, cx, minY, maxY, cy }`. The dragged
symbol's own AABB gives its reference points. On each axis there are three reference points and
three candidate lines:

- X reference points: `minX` (left edge), `maxX` (right edge), `cx` (center).
- X candidate lines (per other symbol): its `minX`, `maxX`, `cx`.
- Y is symmetric (`minY` / `maxY` / `cy`).

For every (referencePoint, candidateLine) pair on an axis, `gap = candidateLine − referencePoint`.
If `|gap| ≤ thresholdM`, it is a candidate translation on that axis. We keep the smallest
`|gap|` per axis. `kind = (reference is center AND candidate is center) ? "center" : "edge"` —
this drives the guide color (center = teal, otherwise edge = violet).

This single pairing rule yields all required behaviors: right-edge→left-edge = contact
("place beside", 0-gap); left→left = edge alignment; center→center = center alignment.

### `nearestObjectAlignment` (new, in `symbols.js`)

```js
/**
 * @typedef {{
 *   delta:number,                 // translation along the axis (world m) to align
 *   line:number,                  // the target world coordinate on this axis
 *   kind:"edge"|"center",
 *   guide:{ a:{x,y}, b:{x,y} }    // guide segment to draw (world m)
 * }} AlignAxisMatch
 *
 * @typedef {{ x: AlignAxisMatch|null, y: AlignAxisMatch|null }} AlignResult
 *
 * Nearest per-axis alignment of a dragged symbol's AABB to any candidate AABB.
 * Pure: no global reads.
 * @param {{minX,maxX,cx,minY,maxY,cy}} dragAABB     dragged symbol AABB at the raw point
 * @param {{minX,maxX,cx,minY,maxY,cy}[]} candidates other symbols' AABBs
 * @param {number} thresholdM                        world-metre snap threshold
 * @returns {AlignResult}
 */
export function nearestObjectAlignment(dragAABB, candidates, thresholdM);
```

- X axis produces a **vertical** guide at `x = line`, spanning `y ∈ [min(dragAABB.minY,
  cand.minY), max(dragAABB.maxY, cand.maxY)]` for the matched candidate, so the line visibly
  bridges the two symbols. Y axis produces a **horizontal** guide symmetrically.
- Guide y/x span uses the current (pre-move) AABB extents — a transient guide, exactness of the
  span is cosmetic.
- On ties in `|gap|`, prefer `center` over `edge` (centers feel more intentional), then first
  candidate encountered. Documented; not load-bearing.

### Resolver — per-axis precedence (in `symbolTool.js`)

`_resolvePlacement(sx, sy, altHeld, boxLike)` is rewritten to resolve X and Y **independently**,
each starting "unclaimed", applying the order **Alt > wall-flush > alignment > grid > raw**:

1. **Alt held** → return raw point on both axes, `snapType:"free"`, clear all guides. (Transient
   full bypass; independent of the toggle. Unchanged from LLD 26.)
2. **Wall-flush** (ungated — see toggle note): compute `nearestWallFlush(...)` as today. When the
   matched wall is **axis-aligned** (its normal is within a small epsilon of ±X or ±Y), it claims
   exactly that one world axis (edge coincident with the face); the orthogonal axis stays
   unclaimed for alignment/grid. When the wall is **angled** (rare in this tool), fall back to the
   existing `(t, n)` decomposition (flush on `n`, grid on `t`) and skip alignment for that
   gesture — documented limitation (Edge Case 8).
3. **Object alignment** (gated by `prefs.gridSnap()`): if the toggle is on, compute
   `nearestObjectAlignment(...)`. For each axis **not already claimed by wall-flush**, if there is
   a match, set that axis to the aligned value and mark it `"align"`.
4. **Grid** (gated by `prefs.gridSnap()` **and** `snapStep()` non-null): for each axis still
   unclaimed, snap that axis component to the grid step (`round(v/step)*step`).
5. **Raw**: any axis still unclaimed keeps the raw value (`"free"`).

The function returns `{ x, y, snapType }` plus the active guide set. `snapType` for the cursor
`.snap-tag` is the highest-priority type across the two axes:
`flush > align > grid > free`. Per-axis alignment guides carry their own color/label.

Threshold: reuse the LLD-26 pattern — a screen-px constant converted to metres at resolve time so
it feels consistent across zoom. `ALIGN_PX = 8` (tighter than `WALL_FLUSH_PX = 12`, so a nearby
wall wins the shared axis; alignment is the finer, secondary snap).

### Toggle semantics (deliberate asymmetry, matching both LLDs)

- **Grid** and **object alignment** obey `prefs.gridSnap()` — toggle OFF disables both.
- **Wall-flush** stays active regardless of the toggle (LLD 26's explicit decision: it is the
  hero "seat the couch against the wall" behavior, not "the grid"). Users defeat it per-gesture
  with Alt.
- **Alt** always yields raw on all axes, independent of the toggle.

This is intentional and consistent with LLD 26; the task requires alignment to obey the toggle,
which it does. Wall-flush's exemption is inherited, not changed here.

## Frontend Design

**Frontend decision: guide style B, colors as proposed.** Settled by the owner; not re-opened.
Reference mockup: `design-mockups/object-to-object-alignment-snapping.html`
(branch `lld-33-object-to-object-alignment-snapping`).

### Colors

| snap / guide      | color                | note                         |
| ----------------- | -------------------- | ---------------------------- |
| edge-to-edge      | violet `#b98bd9`     | `--align-edge`               |
| center-to-center  | teal `#7fd0c8`       | `--align-center`             |
| wall-flush (#1)   | green `#9cd67a`      | unchanged from LLD 26        |
| grid              | teal `#7fd0c8`       | unchanged (`.snap-tag` grid) |
| free              | muted `#8f8a78`      | unchanged                    |

### Guide line + label chip (style B)

For each active alignment guide:

- **Line:** a solid stroke, `stroke-width: 1.4`, no dash, `stroke` = the axis color (violet for
  edge, teal for center), rendered into `#symbol-overlay`. (Contrast: the wall-flush guide stays
  the existing faint dashed green — the two languages differ on purpose.)
- **Label chip (filled, style B):** a small rounded rect filled with the guide color plus text in
  ink `#14140f` (dark-on-color, per the mockup's `background: color; color: #14140f`), centered
  at the guide midpoint. Label text is a short descriptor of the match — `"edges"` /
  `"centers"` (kept short; may be refined to `"L edges"` etc. later without a design change).
- Implemented as an SVG `<g>` per guide (a `<line>` + a `<rect>` + a `<text>`) so it rides the
  existing per-frame clear/re-append path (see State Model). Up to **two** alignment guides at
  once (one X, one Y) plus at most one wall-flush guide.

### Transience (minimal-chrome ethos)

- Guides appear the instant a match is found during a drag and are recomputed each pointer move.
- On drop / gesture end (`onSelectUp`, dock `_onUp`) all guides and the `.snap-tag` are cleared;
  **nothing is left on the canvas.** This reuses the existing LLD-26 teardown calls.
- Optional: fade-in over ~120ms via CSS `transition: opacity`, disabled under
  `@media (prefers-reduced-motion: reduce)` — reuse the block LLD 26 added. Guides are
  `aria-hidden` decoration.

### Cursor snap-tag

Extend the existing `_SNAP_TAG_COLORS` map with `align` handling: when the dominant snap type is
`align`, color the tag violet (edge) or teal (center) to match the guide, label `"align"`. Grid,
flush, free unchanged.

### Toggle control

No new control. The existing `#hud-grid-toggle` (LLD 26) already gates grid; it now also gates
alignment (both read `prefs.gridSnap()`). Its label/glyph are unchanged.

## Interfaces / Types

### New in `src/js/symbols.js`

```js
/** Screen-px alignment threshold; converted to metres by the caller. */
export const ALIGN_PX = 8;

/** @typedef {{ delta:number, line:number, kind:"edge"|"center", guide:{a,b} }} AlignAxisMatch */
/** @typedef {{ x: AlignAxisMatch|null, y: AlignAxisMatch|null }} AlignResult */

/** AABB of a symbol from its rotated corners. */
export function aabb(sym): { minX,maxX,cx,minY,maxY,cy };   // or accept corners4

/** Nearest per-axis edge/center alignment; pure. (signature above) */
export function nearestObjectAlignment(dragAABB, candidates, thresholdM): AlignResult;
```

`aabb` may be a tiny local helper rather than an export if only the resolver needs it; expose it
if a test wants it directly. Keep `nearestObjectAlignment` pure and exported (tested directly).

### Changed in `src/js/symbolTool.js`

- `_resolvePlacement(sx, sy, altHeld, boxLike)` — rewritten for per-axis precedence; return type
  unchanged shape `{ x, y, snapType }` with `snapType ∈ {"flush","align","grid","free"}`.
- Build the candidate AABB list from `model.symbols` (from `symbols.js`) **excluding the symbol
  being dragged** (`_selectedId`) and, during dock placement, excluding nothing (the ghost isn't
  in the model yet). Compute via `corners()` per symbol → AABB.
- Guide state: replace the single `_flushGuide` / `_flushGuideLine` with a small transient guide
  model, e.g. `_activeGuides: { color, kind, guide:{a,b}, label? }[]`, rebuilt each resolve.
  `_updateFlushGuide` → `_updateGuides(resolved)`; `_clearFlushGuideLine` →
  `_clearGuides()`; `repositionFlushGuide` → `repositionGuides()` (broaden; keep re-append +
  world→screen recompute logic). **`main.js` import updated** from `repositionFlushGuide` to
  `repositionGuides` (one line) — or keep the old export name to avoid touching `main.js`
  (implementer's choice; prefer the rename for clarity).

### Unchanged / reused

- `symbols.corners`, `symbols.model`, `symbols.nearestWallFlush`, `WALL_FLUSH_PX`,
  `PARALLEL_TOL_DEG`.
- `walls.wallSegments`, `walls.gridSnap`, `walls.WALL_M`.
- `grid.snapStep`, `prefs.gridSnap`.
- `view.screenToWorld / worldToScreen / pxPerM`.
- `#symbol-overlay`, `.snap-tag`, the `onRender` post-hook wiring in `main.js`.

## State Model

- **Alignment candidates / matches / guides** — fully transient, recomputed per pointer move,
  never persisted. Live only for the duration of a placement/drag gesture; cleared on gesture
  end (`onSelectUp`, dock `_onUp`). Nothing added to the plan document, export JSON, or share
  hash.
- **Guide DOM** — SVG `<g>` nodes in `#symbol-overlay`. `symbolRender` clears the overlay each
  frame (`_clearGroup(_gOverlay)`); `repositionGuides()` (post-render `onRender` hook)
  re-appends the active guides and recomputes their screen coords, so they survive pan/zoom mid-
  drag — the exact mechanism LLD 26 uses for the flush guide.
- **`prefs.gridSnap`** — unchanged persisted boolean (LLD 26). Now read as the gate for both grid
  and alignment in the resolver.
- **`_altHeld`** — unchanged transient flag.
- No new persisted state of any kind.

## Edge Cases

1. **Alt held** → raw on both axes; all guides cleared; toggle state irrelevant.
2. **Toggle OFF** → alignment and grid both disabled; only wall-flush may still act. No alignment
   guides shown.
3. **Wall-flush + alignment on orthogonal axes** → sofa seats flush to a horizontal wall (Y
   claimed by flush) while its left edge aligns to a bookshelf (X claimed by alignment) in the
   same drag. Both guides show (green flush + violet edge). This is the headline co-existence
   case — covered by a test.
4. **Wall-flush and alignment both target the same axis** → wall-flush wins that axis (higher
   precedence); alignment is not applied there. Alignment may still claim the other axis.
5. **Edge contact vs edge alignment** → both fall out of the same pairing: right→left gives
   0-gap contact; left→left gives shared-edge alignment. Nearest `|gap|` wins.
6. **Center match on both axes** → two teal guides (vertical + horizontal) + two chips.
7. **Multiple candidate symbols in range on one axis** → smallest `|gap|` wins; ties prefer
   center then first-seen.
8. **Angled wall-flush active** → alignment skipped for that gesture (resolver uses the legacy
   `(t,n)` flush+grid path). Rare; documented limitation, not a crash.
9. **Dragged symbol excluded from candidates** → the selected/dragged symbol never aligns to
   itself; dock-placement ghost is not yet in the model so nothing to exclude.
10. **No other symbols** → `candidates` empty; `nearestObjectAlignment` returns `{x:null,
    y:null}`; behaves as grid/flush/raw.
11. **Rotated furniture** → alignment uses the AABB (visual extent); a rotated sofa aligns its
    bounding extents, which is the intuitive result. No rotation snapping.
12. **Overlapping symbols** → alignment still computes on edges/centers; may produce a small
    delta pulling them into edge/center coincidence. Acceptable; the user is dragging.
13. **Zoom** → threshold is `ALIGN_PX` converted via `pxPerM()` at resolve time, ~8px on screen
    at any zoom. `ALIGN_PX(8) < WALL_FLUSH_PX(12)` so a nearby wall reliably wins a contested
    axis.
14. **`.snap-tag` contention with wall tool** → unchanged LLD-26 guard: symbol path writes the
    tag only in select/placement mode; wall tool only in draw mode.
15. **Guide left on canvas** → forbidden; `_clearGuides()` on every gesture-end path guarantees a
    clean canvas (asserted by an integration test).
16. **Many symbols (perf)** → candidate list is O(n) per move; n is small for a floor plan.
    Rebuild the candidate AABB list once per gesture start (symbols don't move except the dragged
    one), refreshing only the dragged AABB per move, to avoid recomputing all corners each frame.

## Dependencies

- **Blocks on:** LLD 26 merged (it is — `symbolTool.js` already has `_resolvePlacement`,
  `nearestWallFlush`, `prefs.js`, the `.snap-tag` + `#symbol-overlay` guide infra).
- **Builds on (do not change semantics):**
  - `symbols.js` — `corners`, `model`, `nearestWallFlush`, `Sym`; add `nearestObjectAlignment`,
    `ALIGN_PX`, optional `aabb`.
  - `symbolTool.js` — `_resolvePlacement`, guide helpers, `.snap-tag` updater.
  - `walls.js` — `wallSegments`, `gridSnap`, `WALL_M`.
  - `grid.js` — `snapStep` (consumed, not modified).
  - `prefs.js` — `gridSnap` (the shared toggle gate).
  - `view.js`, `#symbol-overlay`, `.snap-tag`, `main.js` `onRender` hook.
- **CSS:** add `.align-guide` / `.guide-label` styles + `--align-edge` / `--align-center` custom
  properties to the existing stylesheet (values from the mockup).
- **No new third-party dependencies. No build step.** Pure client-side vanilla JS/CSS.

## Test Requirements

Tests live in the existing `src/tests.html` harness (`describe`/`it`), matching LLD 26.

### Unit — geometry (`symbols.nearestObjectAlignment`)
- Two axis-aligned symbols side by side, dragged right edge just inside threshold of the other's
  left edge → X match with `delta` making the edges coincident (0-gap contact); `y` null.
- Left-edge to left-edge alignment → X match, `kind:"edge"`.
- Center-to-center on X only → X match `kind:"center"`, `y` null.
- Center-to-center on both axes → both `x` and `y` matches, both `kind:"center"`.
- Beyond threshold on both axes → `{x:null, y:null}`.
- Two candidates in range on one axis → smaller `|gap|` wins; center-vs-edge tie prefers center.
- Guide span brackets both symbols' extents on the orthogonal axis.
- Rotated symbol → alignment uses its AABB extents (spot-check min/max).

### Unit — resolver precedence (`_resolvePlacement`)
- Alt held → `"free"`, raw both axes, no guides (toggle ON and OFF).
- Toggle OFF, alignment target in range → NOT aligned (grid+alignment gated off); wall-flush
  still applies if a wall is near.
- Toggle ON, alignment in range, no wall → `"align"`, aligned axis snapped, other axis
  grid-snapped or raw per `snapStep`.
- **Per-axis co-existence:** wall-flush in range on Y (axis-aligned wall) + alignment in range on
  X → Y flush-seated, X aligned, `snapType` reports the higher-priority (`flush`), both guides
  present. (Headline case from the issue.)
- Same axis contested (wall-flush + alignment both on X) → wall-flush wins X.
- `ALIGN_PX < WALL_FLUSH_PX`: a target that is within both thresholds on the shared axis resolves
  to flush.

### Integration (Playwright, `.github/run-tests.mjs`)
- Drag a symbol beside another → facing edges become visibly coincident (assert `sym.x/sym.y` or
  rendered geometry), and a violet guide + chip appears during the drag.
- Center-drag → teal guide(s) appear; centers coincide on drop.
- On drop, assert `#symbol-overlay` contains no residual guide `<g>` and `.snap-tag` is hidden
  (nothing left on canvas).
- Toggle OFF → alignment guides do not appear and edges do not snap; toggle ON → they resume.
- Hold Alt during an aligning drag → no alignment, no guides.

### Regression
- LLD-26 wall-flush behavior, `.snap-tag`, and grid toggle persistence unchanged.
- `chooseGridStep` / zoom / precision chip unchanged (#22/#27 tests pass).
- Wall-drawing snapping (`resolveSnap`) unaffected.
- No new key in plan JSON / export / share hash.
