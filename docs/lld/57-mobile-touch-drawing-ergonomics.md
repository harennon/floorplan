# LLD 57: Mobile-touch drawing ergonomics (draw & snap with a finger)

## Scope

This LLD closes the one remaining defect in the LLD-46 touch stack: the **commit-coordinate
loupe offset**. Today `effectiveDrawPoint("touch", x, y)` returns `{x, y: y - 56}` and that same
offset point feeds **both** the hover preview and the actual `onClick` commit
(`interactions.js` ~line 311). The consequence is that a vertex placed with a finger lands
~56px *above* the fingertip — the offset was meant to keep the snap crosshair visible above the
occluding finger, but it silently moved the real geometry. This is the exact bug being fixed.

**In scope:**
1. Remove the commit-coordinate offset so the vertex lands directly under the fingertip
   (`effectiveDrawPoint` returns `{x, y}` unchanged for all pointer types).
2. Solve finger-occlusion the **Option A way**: an in-place **magnifier loupe** — a round bubble
   floating *above* the fingertip that shows a zoomed live view of the hidden snap point with the
   snap crosshair centered. This is a purely visual affordance; it never shifts the commit point.
3. Flip the LLD-46 unit tests in `src/tests.html` that assert the `-56px` offset to assert
   raw (unchanged) coordinates.

**Explicitly NOT in scope (already shipped in LLD 46, must be preserved unchanged):**
- 44px coarse-pointer touch hit targets / handle sizes (`handleSizes` in `pointerEnv.js`).
- Swipeable bottom-sheet dock.
- Two-finger pinch-zoom and two-finger pan disambiguation (`_seedPinch`/`_handlePinch`).
- Two-finger cancel of an in-flight one-finger gesture (`_gestureCancelled`).
- `touch-action: none` page-gesture suppression.
- Per-gesture drag thresholds (touch=10, mouse/pen=6).

**Out of scope entirely (tracked separately):** a broader mobile UI/layout or responsive
visual-identity redesign; any change to the mouse/pen path (already commits at raw coordinates).

## Approach

### 1. Remove the commit offset (the fix)
`effectiveDrawPoint` becomes the identity map on coordinates for every pointer type:

```js
export function effectiveDrawPoint(pointerType, x, y) {
  return { x, y };
}
```

Because `interactions.js` passes the *result* of `effectiveDrawPoint` to both `onHover` and
`onClick`, this single change makes the touch draw path commit exactly under the fingertip. No
call-site changes are required in `interactions.js`; the function is retained (rather than
inlined) so the existing call sites and the unit-test surface stay stable, and so the pen/mouse
path is provably unchanged. `LOUPE_OFFSET_PX` is removed from `pointerEnv.js` — the magnifier
computes its own geometry (see below) and no longer needs a shared commit offset.

**Rationale for keeping `effectiveDrawPoint` rather than deleting it:** call sites in
`interactions.js` (`_onPointerDown`, `_onPointerMove`, `_onPointerEnd`) already funnel through it;
keeping the seam localized to one pure function keeps the diff surgical and preserves the
unit-test entry point.

### 2. Magnifier loupe (Option A occlusion fix)
While a **touch** draw gesture is active (finger down in wall mode, before the drag threshold is
crossed) **and** a snap is resolved, render a circular magnifier bubble anchored a fixed offset
**above** the fingertip. The bubble shows a zoomed, live rendering of the world region centered on
the current snap point, with a fixed crosshair drawn at the bubble's center. This lets the user
see precisely where the vertex will land even though the finger covers it.

Key properties:
- **Visual only.** The bubble reads from the same snap the commit will use; it never feeds back
  into the commit coordinate. There is no path by which the bubble can move a placed vertex.
- **Touch only.** Mouse and pen never show it (`pointerType === "touch"` gate). Coarse-pointer
  boot flag (`isCoarsePointer`) is *not* the gate — the gate is the live pointer type of the
  active gesture, so a stylus on a touchscreen stays precise.
- **One extra cheap redraw.** The bubble content is produced by re-projecting the existing SVG
  world/draft/snap layers at a higher effective scale into a small clipped SVG (a `<use>` of the
  live `#drawing` groups under a magnifying transform), so it always matches what is on the canvas.
  No second render pipeline is introduced.
- **Lifecycle.** Shown on touch finger-down in draw mode (mirrors the existing early
  `onHover` call) and updated on each touch move below the drag threshold; hidden when: the drag
  threshold is crossed (gesture became a pan), a second finger lands (pinch/cancel), the vertex is
  committed on lift, `onLeave` fires, or the tool leaves wall mode.

### 3. Ownership / module boundaries
- `pointerEnv.js` owns the (now trivial) `effectiveDrawPoint` and drops `LOUPE_OFFSET_PX`.
- A new small module `loupe.js` owns the magnifier DOM element and its show/update/hide API. It is
  driven by `wallTool.js`, which already knows the current snap and screen position (it positions
  the snap-tag in `_positionSnapTag`). `wallTool.onHover`/`onClick`/`onLeave` call the loupe;
  `interactions.js` needs no new knowledge of the loupe beyond the pointer type it already tracks.
- The loupe is told the current fingertip screen position and pointer type; it decides visibility.

This keeps `interactions.js` (gesture disambiguation) and the rendering concern (`loupe.js`)
cleanly separated, matching the existing hook-injection pattern.

## Frontend Design

Frontend decision: **Option A (in-place magnifier loupe).**

### Element and layering
- A single `<div class="loupe">` appended to `.stage`, sibling to `.labels`/`.snap-tag`,
  `position: fixed`, `pointer-events: none`, `z-index` above the canvas and snap-tag.
- Inside it, a clipped circular `<svg>` viewport (≈112px diameter) with:
  - a `<use href="#drawing">`-style zoomed clone (or a re-projected group) of the world/draft/snap
    content centered on the snap point, and
  - a fixed center crosshair + snap-colored ring matching the on-canvas snap glyph palette
    (`#7fd0c8` grid / `#e0b64f` point / `#9cd67a` close / muted for free), so the loupe reinforces
    the same snap language the user already learned on desktop.
- A small tail/notch pointing down toward the fingertip, and a soft blueprint-panel border
  (`var(--panel)` / `var(--hairline)`) consistent with `.snap-tag` styling.

### Placement math
- Anchor: bubble center sits `LOUPE_LIFT` (≈72px) above the fingertip in screen space so the
  finger never occludes it. Clamp horizontally and vertically to the viewport (mirroring
  `_positionSnapTag`'s clamp): if the fingertip is near the top edge, flip the bubble *below* the
  finger; if near a side, shift inward. The tail hides when flipped/clamped hard.
- Magnification factor `LOUPE_MAG` ≈ 2.5×. The bubble shows a world radius of
  `(bubbleRadiusPx / LOUPE_MAG) / pxPerM()` metres around the snap point, so zoom-independent: at
  high canvas zoom the loupe still shows a proportionally tighter region.

### Interaction feel
- The snap crosshair is *pinned to the bubble center*; as the finger moves, the world scrolls
  under the crosshair, and the crosshair color/label updates with the snap type. This gives the
  "the point I will place is exactly here" read that the offset hack was trying to fake, without
  moving geometry.
- The existing `.snap-tag` (textual snap-type label) is retained; it may be tucked onto the loupe
  rim on touch to avoid double chrome, but that is optional polish and not required by acceptance.

### Motion / cost
- Updated inside the existing `scheduleRender()` RAF coalescing — `wallTool.onHover` already calls
  `scheduleRender()`. The loupe redraw is one transform update on a cloned group, no per-frame DOM
  rebuild of the world.
- Respect `prefers-reduced-motion`: drop the snap-glyph pulse animation inside the loupe (reuse
  the existing `.snap-pulse` reduced-motion handling).
## Interfaces / Types

### `pointerEnv.js` (modified)
```js
// REMOVED: export const LOUPE_OFFSET_PX = 56;

/**
 * Effective draw-hook coordinate. Now the identity map for ALL pointer types:
 * the snap point (and therefore the committed vertex) lands directly under the
 * pointer. Occlusion is handled visually by the magnifier loupe, never by
 * shifting the commit coordinate.
 * @returns {{ x:number, y:number }}
 */
export function effectiveDrawPoint(pointerType, x, y) {
  return { x, y };
}
```
`dragThreshold` and `handleSizes` are unchanged.

### `loupe.js` (new module)
```js
/**
 * loupe.js — in-place magnifier bubble for touch drawing (LLD 57).
 * Visual-only affordance; never affects commit coordinates.
 */

/** Bind DOM refs. Called once from main.js.
 *  @param {HTMLElement} stage     .stage container
 *  @param {SVGSVGElement} drawing #drawing svg (source for the zoomed clone) */
export function init(stage, drawing) {}

/**
 * Show/update the loupe.
 * @param {number} fingerSx  fingertip screen x (raw clientX)
 * @param {number} fingerSy  fingertip screen y (raw clientY)
 * @param {import("./walls.js").Snap} snap  resolved snap (has world x,y,type)
 */
export function show(fingerSx, fingerSy, snap) {}

/** Hide the loupe (gesture end / cancel / leave / non-touch). */
export function hide() {}

/** Reposition the zoomed content after a view change (called from render hook). */
export function reposition() {}
```

Module constants (in `loupe.js`):
```js
const LOUPE_DIAM_PX = 112;   // bubble diameter
const LOUPE_LIFT_PX = 72;    // center offset above fingertip
const LOUPE_MAG     = 2.5;   // magnification factor
```

### `wallTool.js` (modified — drives the loupe)
`onHover(sx, sy)` gains a call to render the loupe *when the active pointer is touch*. Because
`wallTool` does not currently know the pointer type, `interactions.js` passes it through. Two
viable wirings — **recommended: (a)**:

- **(a) Extend the draw-hook signature** so `onHover`/`onClick` receive the pointer type:
  `onHover(sx, sy, pointerType)`. `interactions.js` already holds `_downPointerType` and the live
  `e.pointerType`; it forwards it. `wallTool.onHover` calls `loupe.show(sx, sy, _snap)` when
  `pointerType === "touch"` and a snap exists, else `loupe.hide()`.
- (b) Have `interactions.js` call the loupe directly. Rejected: it would couple the gesture module
  to snap state it does not own.

### `interactions.js` (modified — minimal)
- Forward `pointerType` into the draw hooks (`onHover`, and optionally `onClick` for the hide).
- On the commit path (`_onPointerEnd`, ~line 311) and on all the existing hide triggers
  (threshold-crossed pan start, second-finger cancel, `onLeave`), ensure `loupe.hide()` runs.
  Simplest: route hide through `wallTool` (`onLeave` already hides snap; extend it to hide the
  loupe) and add a `loupe.hide()` after commit in `wallTool.onClick`.

## State Model

- **No new persisted state.** Nothing here touches `localStorage`, the URL hash, or export. The
  loupe is transient view chrome; the plan model (`walls.model`) is untouched by this change.
- **Transient (in-memory) state:**
  - `interactions.js` already tracks `_downPointerType`, `_drawPending`, `_gestureCancelled`,
    `_pointers`. The only addition is forwarding `pointerType` into the draw hooks.
  - `loupe.js` holds only DOM refs and a `_visible` boolean; it derives everything else per call
    from the passed `snap` + fingertip position + live `view`/`pxPerM()`.
  - The committed vertex flows: touch pointerdown → (early `onHover` shows loupe) → touch move
    below threshold updates `_snap` + loupe → lift → `onClick(sx, sy)` where `sx,sy` are now the
    **raw** fingertip coordinates → `resolveSnap` → `placeVertex`. The loupe never participates in
    this data flow.
- **Interaction with the render loop:** the loupe re-reads the live view on `reposition()`,
  registered as a `surface.onRender` hook so it stays aligned during pinch-zoom/pan that happen
  around it (though during an active single-finger draw there is no concurrent pinch).

## Edge Cases

1. **Vertex under finger at all four corners/edges.** Because the commit uses raw fingertip
   coordinates, a tap in any corner lands exactly under the finger. The loupe bubble must *not*
   push the commit — verified by placing near each edge; the loupe flips/clamps but geometry is
   unaffected. (This is the acceptance-critical regression the offset introduced.)
2. **Fingertip near top edge of viewport.** `LOUPE_LIFT_PX` above the finger would clip off-screen
   → flip the bubble below the finger; hide the tail.
3. **Fingertip near left/right edge.** Clamp bubble center horizontally into the viewport (same
   clamp logic as `_positionSnapTag`).
4. **Second finger lands mid-draw (pinch / cancel).** `interactions.js` already sets
   `_gestureCancelled` and calls `_drawHooks.onLeave()`; `onLeave` must hide the loupe. No vertex,
   no loupe.
5. **Drag threshold crossed (draw → pan).** `_drawPending` flips to `_dragging`; hide the loupe so
   it does not linger during a pan.
6. **Pointer leaves the stage / pointercancel.** `onLeave` fires → loupe hidden.
7. **Tool switched away from wall mid-gesture.** `wallTool.setTool` clears `_snap`; ensure it also
   hides the loupe.
8. **Mouse or pen in draw mode.** `pointerType !== "touch"` → loupe never shown; commit is raw
   (already true). No behavioral change on desktop.
9. **Snap is `free` (no grid/point/close).** Loupe still shows (helps aim); crosshair uses the
   muted "free" styling, matching the on-canvas glyph.
10. **Very high canvas zoom (near MAX_ZOOM).** Loupe world-radius shrinks proportionally; content
    stays crisp because it re-uses the vector layers, not a raster snapshot.
11. **Rapid taps (tap-tap-tap chain drawing).** Each finger-down shows the loupe, each lift hides
    it and commits; no state leaks between taps (loupe `_visible` reset on hide).
12. **`prefers-reduced-motion`.** Suppress the pulse animation inside the loupe (reuse existing
    reduced-motion CSS on `.snap-pulse`).

## Dependencies

Everything already exists in the repo; no new libraries (client-side-only, no-build principle
holds). Depends on:
- `pointerEnv.js` — `effectiveDrawPoint` (modified), `dragThreshold`/`handleSizes` (unchanged).
- `interactions.js` — gesture state machine; must forward `pointerType` into draw hooks and
  trigger loupe hide on the existing cancel/leave/commit paths.
- `wallTool.js` — owns `_snap` and screen position; drives the loupe.
- `view.js` — `pxPerM()`, `worldToScreen`, `screenToWorld` for loupe geometry.
- `surface.js` — `scheduleRender`/`onRender` for coalesced updates; `#drawing` SVG groups
  (`#world`/`#draft`/`#snap`) as the source for the zoomed clone.
- `index.html` — add the `.loupe` element and its CSS; `main.js` — `loupe.init(...)` wiring.
- LLD 46 is the predecessor whose commit-offset behavior this supersedes; its other ergonomics
  (handles, dock, pinch, cancel, `touch-action:none`) are dependencies to preserve, not modify.

No blocking dependency on other Phase 2 sub-issues.

## Test Requirements

### Unit (`src/tests.html`)
- **Flip the existing offset assertions.** Update the `pointerEnv — effectiveDrawPoint` block:
  - `effectiveDrawPoint("touch", 100, 300)` now returns `{x:100, y:300}` (was `y:244`).
  - Remove/replace the `LOUPE_OFFSET_PX is 56` constant test and the `-LOUPE_OFFSET_PX` cases;
    assert the constant is no longer exported (or delete those cases).
  - Mouse/pen/unknown cases stay (they already assert raw coordinates).
- **Flip the `interactions` integration tests.** The `interactions — loupe commit
  (touch pointerdown→up commits at y-56)` block must assert `onClick` fires at the **raw** y
  (300), and touch-down `onHover` fires at raw y (300), not `300 - 56`. Rename the describe block
  accordingly (e.g. "commits at raw fingertip coordinates").
- The `mouse draw commits at raw coordinates` and `symbol move … no loupe offset` tests already
  assert raw behavior and should continue to pass unchanged.
- **loupe.js pure/positioning tests:** given a fingertip and snap, `show` computes a bubble-center
  above the finger; near the top edge it flips below; near a side it clamps into the viewport.
  (Test the placement math via a small exported pure helper, e.g. `computeLoupeRect(...)`, so it
  can run headless without a live SVG.)

### Integration / behavioral
- Simulated touch pointerdown→move→up in wall mode places a vertex at the raw fingertip snap
  point (verify `placeVertex` receives the snap resolved at raw coordinates).
- Second-finger-down during a pending draw cancels cleanly and hides the loupe (no vertex, no
  lingering bubble).
- Drag-threshold crossover hides the loupe and starts a pan.

### Manual QA on real devices (acceptance-gating; document in QA notes)
- On **one real iOS** and **one real Android** touchscreen:
  - Draw a multi-segment wall chain with grid/endpoint snapping using taps; finish the chain; no
    accidental page scroll or zoom (confirms `touch-action:none` still holds).
  - Confirm the **snap crosshair/tag is visible near the fingertip via the magnifier** while
    drawing.
  - Confirm a placed vertex **lands exactly under the finger across all four corners and edges** of
    the canvas (the core fix).
  - One-finger drag moves a selected symbol; resize/rotate handles are finger-hittable (44px).
  - Two-finger pinch zooms and two-finger drag pans without triggering draw/selection.
- **Desktop regression:** mouse/trackpad drawing, selection, pan, and wheel-zoom behave exactly as
  before; the loupe never appears.
