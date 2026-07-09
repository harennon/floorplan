# LLD 46: Mobile-touch drawing ergonomics (draw & snap with a finger)

## Scope

Make the existing pointer-driven drawing loop comfortable on a touchscreen finger,
**without** rewriting the shared mouse/trackpad path. The interaction code
(`interactions.js`, `wallTool.js`, `symbolTool.js`) already uses Pointer Events and
already has partial multi-touch (pinch) handling; this LLD tightens gesture
disambiguation, adds finger-sized hit targets, adds an **offset loupe** so the fingertip
never hides the snap point, and makes the furniture dock thumb-friendly.

**Covers:**
- **Offset loupe (Option A).** In draw mode on touch, the resolved snap coordinate that
  gets committed is offset to a floating crosshair rendered ~56px **above** the fingertip.
  Today's exact pointer model is unchanged: down → drag → up commits a vertex.
- **Gesture disambiguation.** 1 finger = draw / move / pan; 2 fingers = pinch-zoom + pan.
  A second finger touching down **cancels any in-flight one-finger draw** so no stray
  vertex is committed. ~10px tap/drag threshold tuned for finger jitter (mouse keeps 6px).
- **Touch-sized hit targets.** Rotate/resize handle hit radii and the symbol pick
  tolerance grow to ≥44px effective (≈28px visual + invisible pad) **only** under a
  coarse-pointer device; the mouse path keeps today's small targets.
- **Furniture dock as a swipeable bottom sheet** clear of the thumb-draw zone and OS
  edge-swipe areas (safe-area insets).
- **Page-gesture suppression.** `touch-action: none` (already on `.stage`) plus explicit
  prevention of double-tap zoom / long-press callout so a draw gesture never scrolls or
  zooms the page.
- Real-device verification on one iOS and one Android device.

**Does NOT cover:**
- Any broader mobile layout / visual-identity redesign beyond what touch ergonomics
  require (tracked separately).
- Option B's reticle / ⊕-commit-button model — explicitly rejected by the frontend
  decision. Do not implement it.
- New drawing mechanics, new snap types, or changes to `walls.resolveSnap` /
  `symbolTool._resolvePlacement` math.
- Haptics, PWA install, offline — out of this issue.

## Approach

### Guiding constraint: branch, don't rewrite
All new behavior is gated so the desktop mouse/trackpad path is byte-for-byte unchanged.
Two orthogonal signals:

1. **Per-event `pointerType`** (`e.pointerType === "touch"`) — used for per-gesture
   decisions (loupe offset, threshold selection). A mouse event never sees the touch
   branch even on a hybrid device.
2. **Coarse-pointer capability** (`matchMedia("(pointer: coarse)")` / `(any-pointer: coarse)`)
   — used for *static* sizing decisions that must be set before any event fires (handle
   hit radii, dock layout). Evaluated once at init, cached in a module boolean.

### 1. Offset loupe (draw mode, touch only)
Today (`interactions.js` `_onPointerDown`/`_onPointerEnd`), a draw-mode tap records the
down point and commits a vertex at the **up** point via `_drawHooks.onClick(clientX, clientY)`.
The finger covers that point, so the user can't see what they're snapping to.

Fix: when `e.pointerType === "touch"`, feed a **display-offset** screen coordinate into the
draw hooks. The hooks already take screen `(sx, sy)`; we pass `(sx, sy - LOUPE_OFFSET_PX)`
where `LOUPE_OFFSET_PX = 56`. Snapping (`resolveSnap`) then resolves at the crosshair
position, the snap glyph renders there, and `placeVertex` commits there. The finger stays
below, unobscured. This applies to `onHover`, `onClick`, and the drag-threshold preview —
consistently, so preview and commit agree.

Implementation choice: rather than sprinkle `- 56` at each call site, `interactions.js`
computes an effective `(hx, hy)` for the active pointer once per event
(`_effectiveDrawPoint(e)`), returning the raw point for mouse/pen and the offset point for
touch. All three draw-hook calls use it. No change inside `wallTool.js` or `walls.js`.

The loupe is *purely a coordinate offset* — no new UI element is strictly required because
the existing snap glyph (`wallRender._renderSnapGlyph`) already renders a crosshair/diamond
at the resolved snap point, which is now 56px above the finger. Optionally a faint vertical
"tether" line from finger to crosshair improves legibility (see Frontend Design); it is a
render-only affordance and does not affect geometry.

### 2. Gesture disambiguation
`interactions.js` already tracks pointers in `_pointers` Map and seeds pinch on the 2nd
pointer. Two gaps to close:

- **Second-finger cancels in-flight draw.** `_onPointerDown` already sets
  `_drawPending = false` when `_pointers.size === 2`, but it does **not** clear the
  wall tool's snap preview or guard the *up* that follows. Add: on entering pinch, call
  `_drawHooks.onLeave()` to clear the snap glyph, and set a `_drawCancelled` flag so the
  subsequent `pointerup` for either finger does **not** call `onClick` (no stray vertex).
  The flag clears when `_pointers.size` returns to 0.
- **Touch threshold.** `DRAG_THRESHOLD = 6` is right for a mouse but too tight for a
  finger. Introduce `TOUCH_DRAG_THRESHOLD = 10` and select per-gesture based on the
  down event's `pointerType`. Used for both the draw-mode pan/commit split and the
  select-mode tap-vs-drag split.

Move (1-finger drag of a selected symbol) and pan already work through the existing
`_selectHooks` / `_dragging` paths; they need only the threshold change and the loupe is
**not** applied to select/move (the user is dragging an object they can see, and the
existing `_dragOffsetX/Y` grab-offset already keeps the object under the finger).

### 3. Touch-sized hit targets
`symbolTool.js` constants `ROTATE_HIT_R = 14` and `MIN_HIT_PX = 12` are too small for a
finger. Add coarse-pointer-gated variants:
- `ROTATE_HIT_R` → 22 (≈44px diameter) when coarse.
- `MIN_HIT_PX` → 44 when coarse (tolerance = 22px → world).
The **visual** handle size (`ROTATE_HANDLE_R = 6` in `symbolRender.js`) grows to ~14 under
coarse pointer so the visible knob is ~28px and the invisible pad brings the *hit* area to
44px. Visual growth is CSS/attribute driven and gated the same way. Mouse path keeps 14/12/6.

### 4. Furniture dock → swipeable bottom sheet
The dock (`#symbol-dock`) is already a fixed bottom-center horizontally-scrollable bar with
`env(safe-area-inset-bottom)` padding and `touch-action: none`. On coarse-pointer /
narrow screens it needs: (a) full-width bottom-sheet layout so items are large tap targets;
(b) horizontal swipe to page through symbols without triggering canvas gestures; (c) to sit
**above** the OS edge-swipe / home-indicator zone. This is layout-only (CSS + a class
toggled by the existing `matchMedia`), no new JS module. Dock drag-placement
(`_onDockPointerDown`) is unchanged; it already captures its own pointer.

### 5. Page-gesture suppression
`.stage` already has `touch-action: none`. Add: `touch-action: manipulation`→`none` audit,
`-webkit-user-select: none` on the stage, and prevent the iOS double-tap-to-zoom / callout
by keeping `touch-action: none` and calling `e.preventDefault()` in the touch pointerdown
path where safe. Ensure the document/body cannot rubber-band scroll while a draw gesture is
active (overscroll-behavior). No viewport-meta change beyond confirming
`user-scalable` is not blocking pinch inside the app (app pinch is handled in JS, page
pinch is suppressed on the stage only).

## Frontend Design

**Approved direction: Option A (offset loupe).** Do NOT implement Option B's reticle /
⊕-commit-button model.

### Offset loupe visual
- When drawing on touch, the resolved snap point (crosshair/diamond glyph, already drawn by
  `wallRender._renderSnapGlyph`) sits `LOUPE_OFFSET_PX = 56` px directly **above** the
  fingertip in screen space (screen-y minus 56, toward the top of the viewport).
- Optional tether: a faint 1px vertical line from the fingertip screen point up to the
  crosshair, low opacity, so the eye connects finger↔commit point. Render-only, drawn into
  the `#snap` group, hidden when no snap is active. This is the only *new* visual element
  and is optional polish — the crosshair offset alone satisfies the acceptance criteria.
- The 56px offset applies to hover-preview, drag-preview, and commit identically so the
  glyph the user aims with is exactly where the vertex lands.
- The snap-tag label (`wallTool._positionSnapTag`) already clamps to the viewport, so its
  label stays visible even when the crosshair is near the top edge.

### Touch-sized handles
- Rotate knob and any resize handles render at ~28px visual diameter under coarse pointer
  (vs ~12px on desktop), plus an invisible hit pad reaching 44px. Gold styling and stem
  unchanged; only radii scale.
- Selection outline stroke may thicken slightly (1→1.5px) under coarse pointer for
  visibility; optional.

### Furniture dock bottom sheet
- Under `(max-width: 640px)` / coarse pointer, the dock becomes a full-width sheet pinned
  to the bottom, content horizontally swipeable, each `.dock-item` sized ≥44px.
- Respects `env(safe-area-inset-bottom)` (already present) and adds bottom clearance for
  the iOS home indicator / Android gesture bar; must not overlap the OS edge-swipe zone.
- Interactive only in select mode; it has its own bounded hit area, so canvas draw
  pointerdowns below/around it are unaffected.
- No visual-identity redesign: reuse existing `--panel`, `--hairline`, blur, radius tokens.

### Motion / affordance
- No new animations required. Respect existing `prefers-reduced-motion` blocks.
- Cursor classes (`.draw-mode`, `.panning`) are mouse-only affordances, harmless on touch
  (no hover), so they stay.

## Interfaces / Types

No public module APIs change. All changes are internal to existing modules plus one small
shared helper. Signatures below are the exact touch points.

### New shared helper (`src/js/pointerEnv.js` — new tiny module)
```js
/** True when any input is a coarse pointer (touch). Evaluated once at load. */
export const isCoarsePointer: boolean;   // matchMedia("(any-pointer: coarse)").matches
/** Loupe offset in screen px (draw-mode touch only). */
export const LOUPE_OFFSET_PX = 56;
/** Drag/tap thresholds in screen px. */
export const MOUSE_DRAG_THRESHOLD = 6;
export const TOUCH_DRAG_THRESHOLD = 10;
```
Rationale: a single import site for the coarse-pointer flag and the constants keeps branch
logic identical across `interactions.js`, `symbolTool.js`, `symbolRender.js`.

### `interactions.js` (internal changes)
- `_threshold()` → returns `TOUCH_DRAG_THRESHOLD` when the active gesture's down
  `pointerType` is `"touch"`, else `MOUSE_DRAG_THRESHOLD`. Store the down pointerType per
  gesture (new `_downPointerType`).
- `_effectiveDrawPoint(e) → { x, y }` → for draw-mode hooks returns
  `{ x: e.clientX, y: e.clientY - LOUPE_OFFSET_PX }` when `e.pointerType === "touch"`,
  else the raw point. All three draw-hook calls (`onHover`, `onClick`, threshold-preview
  `onHover`) route through it. Note: the *threshold comparison* still uses the raw
  `clientX/Y` vs the raw down point — only the coordinate handed to the draw hooks is
  offset.
- New transient flag `_drawCancelled: boolean` — set true when a 2nd pointer arrives during
  a pending/active draw; blocks the trailing `onClick` in `_onPointerEnd`; reset when
  `_pointers.size === 0`.
- On entering pinch (`_pointers.size === 2`): additionally call `_drawHooks.onLeave()`.
- `setDrawHooks` / `setSelectHooks` interfaces are **unchanged** — they still receive
  screen `(sx, sy)`; the offset is applied by the caller.

### `symbolTool.js` (internal changes)
```js
// gated by isCoarsePointer:
const ROTATE_HIT_R = isCoarsePointer ? 22 : 14;
const MIN_HIT_PX   = isCoarsePointer ? 44 : 12;
```
No signature changes to `onSelectDown/Move/Up`, `onTapEmpty`, or `_resolvePlacement`.

### `symbolRender.js` (internal changes)
```js
const ROTATE_HANDLE_R = isCoarsePointer ? 14 : 6;   // visual knob radius
```
`getRotateHandleScreen` offset may bump to keep the larger knob clear of the body under
coarse pointer — if so, the hit test in `symbolTool` uses the same value (both read the
exported position, so no divergence).

### CSS (`index.html`)
- New rules under `@media (pointer: coarse)` and/or the existing `(max-width: 640px)`
  block for the bottom-sheet dock and thicker handles.
- `overscroll-behavior: none` on `html, body` (or the stage container) to stop rubber-band
  scroll during a draw gesture.

## State Model

All new state is **in-memory / transient**, living in `interactions.js` for the duration of
a gesture. Nothing new is persisted to `localStorage`, the URL hash, or the plan model —
the loupe and thresholds are pure input-mapping concerns and do not touch geometry.

Per-gesture transient state (added to `interactions.js`):
- `_downPointerType: "touch"|"mouse"|"pen"` — the pointerType of the primary pointer that
  started the current gesture; selects the drag threshold. Cleared when pointers reach 0.
- `_drawCancelled: boolean` — true after a second finger cancels an in-flight draw; blocks
  the trailing commit. Cleared when pointers reach 0.

Static, evaluated once at module load:
- `isCoarsePointer` (in `pointerEnv.js`) — device capability; drives handle sizing and dock
  layout. Not reactive to hot-plugging a mouse (acceptable; matches how the codebase already
  reads `matchMedia` once at boot in `main.js`).

Existing state (`_pointers` Map, `_pinch*`, `_dragging`, `_drawPending`, `_selectConsumed`,
symbol `_dragMode`/`_selectedId`) is reused unchanged. The loupe does **not** add state: the
offset is recomputed from the live event each time.

The committed vertex coordinate (`walls.model.chain`) is identical whether the loupe was
used or not — it is always the *resolved snap* at the crosshair. There is no "loupe mode"
persisted; a plan drawn on touch and one drawn on desktop are indistinguishable in storage.

## Edge Cases

1. **Second finger lands mid-draw.** Pinch begins; the in-flight one-finger draw is
   cancelled (`_drawCancelled = true`, `onLeave()` clears the snap glyph). Neither the
   lift of the first nor the second finger commits a vertex. The chain built so far is
   preserved (not discarded) — the user can resume drawing after the pinch ends.
2. **Second finger lifts, one finger remains.** Existing pinch teardown re-seeds; because
   `_drawCancelled` stays set until *all* pointers lift, the remaining finger does not
   spuriously commit. The user must lift fully and tap again to place the next vertex.
   (Documented behavior; avoids ambiguous "was that a draw or a leftover pinch finger?")
3. **Tap without drag (touch).** Movement under `TOUCH_DRAG_THRESHOLD` (10px) = a tap →
   commit at the offset crosshair. Finger jitter below 10px does not turn a tap into a pan.
4. **Very fast tap (down+up, no move event).** `onClick` fires at the down point's offset
   coordinate; the offset is applied from the up event's `pointerType`/position, so a
   move-less tap still lands 56px above the finger.
5. **Loupe crosshair above the viewport top / behind HUD.** Drawing still resolves and
   commits at the offset world point (the world is pannable, nothing is clipped). The
   snap-tag label clamps into view via existing `_positionSnapTag` logic.
6. **Hybrid device (touch + mouse, e.g. laptop w/ touchscreen).** `pointerType` per event
   keeps the mouse path exact (no loupe, 6px threshold) and gives touch events the loupe +
   10px threshold. `isCoarsePointer` may be true on such devices → handles render larger,
   which is acceptable and does not break mouse hit-testing (larger targets still work).
7. **Pen/stylus.** Treated as non-touch for the loupe (a stylus tip is precise and visible),
   `pointerType === "pen"` → raw point, mouse threshold. Handle sizing still follows
   `isCoarsePointer`.
8. **Dock swipe vs canvas draw.** The bottom-sheet dock owns its own pointer capture
   (`_onDockPointerDown` already `setPointerCapture`s). A horizontal swipe inside the dock
   pages the sheet and never reaches the canvas; a draw gesture starts on the canvas
   outside the dock's bounds.
9. **Dock over OS gesture zone.** Safe-area insets + extra bottom clearance keep the dock
   above the iOS home indicator / Android nav; an OS edge-swipe does not land on a dock item.
10. **Page pinch-zoom / double-tap zoom.** `touch-action: none` on `.stage` plus
    `overscroll-behavior: none` suppress browser zoom/scroll inside the canvas; app pinch is
    handled in JS. Chrome outside the stage retains normal touch behavior.
11. **Rotate handle vs move drag on touch.** With `ROTATE_HIT_R = 22`, the enlarged rotate
    hit zone could overlap the symbol body for small symbols. Precedence is unchanged
    (`onSelectDown` checks the rotate handle first), so a tap in the overlap rotates. This
    matches desktop precedence; acceptable. If the symbol is smaller than the handle zone,
    the user pans/moves by grabbing the body center (handle is offset above the top edge).
12. **Existing pinch drift.** No change to pinch math (`_seedPinch`/`_handlePinch`); the
    only addition is the `onLeave()` call and cancel flag. Regression risk is limited to
    those two lines.
13. **Reduced motion.** The optional loupe tether is static (no animation); no special
    handling needed beyond hiding it when no snap is active.

## Dependencies

All dependencies already exist in the codebase; nothing new must be built first.
- `interactions.js` — Pointer Events, `_pointers` Map, pinch seeding, draw/select hooks
  (LLD 02 / 04 / 12 foundation). Primary edit surface.
- `wallTool.js` `onHover`/`onClick`/`onLeave` and `walls.resolveSnap`/`placeVertex` — used
  as-is; the loupe only shifts the screen coordinate handed in.
- `symbolTool.js` `onSelectDown` + `ROTATE_HIT_R`/`MIN_HIT_PX`; `symbolRender.js`
  `ROTATE_HANDLE_R`/`getRotateHandleScreen`.
- `view.js` `screenToWorld`/`worldToScreen` — unchanged contract.
- `index.html` `.stage` (`touch-action: none`) and `#symbol-dock` CSS + `matchMedia`
  pattern already used in `main.js`.
- No new npm packages. No build step (per project principle: static files only).
- QA/CI: the Playwright headless harness (`.github/run-tests.mjs`, `src/tests.html`) for
  unit tests; **real-device manual QA is a hard requirement** (see below) and is not
  automatable in CI.

Deferrable follow-up (per issue): depends on none of the other Phase 2 sub-issues.

## Test Requirements

### Unit (add to `src/tests.html`; pure functions only)
- `pointerEnv`: `LOUPE_OFFSET_PX === 56`; threshold constants; `isCoarsePointer` is a
  boolean. (Capability flag itself is environment-driven; test the constants and that the
  module exports the flag.)
- Loupe coordinate mapping: a helper `_effectiveDrawPoint`-equivalent must subtract 56 from
  y for `pointerType:"touch"` and pass through for `"mouse"`/`"pen"`. Extract the mapping
  into a pure function so it is unit-testable without a live pointer.
- Threshold selection: touch gesture → 10px, mouse gesture → 6px.
- Handle-size gating: given a stubbed `isCoarsePointer`, `ROTATE_HIT_R`/`MIN_HIT_PX`/
  `ROTATE_HANDLE_R` resolve to the coarse vs fine values. (May require exposing the
  computed values or a small pure selector `handleSizes(isCoarse)`.)

### Integration (headless Chromium, synthetic pointer events via `dispatchEvent`)
- **Draw commit with loupe:** dispatch touch pointerdown→up in draw mode; assert the
  committed vertex equals `resolveSnap` at `(x, y-56)`, not at `(x, y)`.
- **Second-finger cancels draw:** touch pointerdown (draw) → second pointerdown → lift
  both; assert no vertex was committed and the chain length is unchanged, and the snap
  glyph was cleared.
- **Tap vs pan threshold on touch:** a move of 8px then up = commit (tap); a move of 15px =
  pan (no commit). Same test at 5px/8px for mouse to prove the 6px boundary is unchanged.
- **Mouse regression:** mouse pointerdown→up in draw mode commits at the raw point (no 56px
  offset); pinch/loupe code paths are not entered for `pointerType:"mouse"`.
- **Symbol move on touch:** one-finger drag of a selected symbol moves it (no loupe offset
  applied to the move path).
- **Enlarged handle hit (coarse):** with coarse pointer simulated, a tap 20px from the
  rotate knob center still enters rotate mode (would miss at desktop `ROTATE_HIT_R=14`).

### Manual real-device QA (hard requirement — document results in the PR/QA notes)
Exercise on **at least one real iOS device and one real Android device**:
- Draw a multi-segment wall chain with grid + endpoint snapping using taps/drags; finish
  the chain (Finish button / auto-finish). No accidental page scroll or zoom occurs.
- Confirm the snap crosshair is visible above the fingertip (loupe) throughout.
- One-finger drag moves a selected symbol; rotate/resize handles are hittable with a finger.
- Two-finger pinch zooms and two-finger drag pans; neither triggers a stray vertex or
  selection; a second finger during a draw cancels it cleanly.
- Furniture dock is reachable with the thumb, swipes horizontally, and sits clear of the OS
  home indicator / gesture bar.
- Regression pass on desktop mouse + trackpad: drawing, selection, pinch/wheel zoom, and
  handle hit behavior are unchanged.
- Record device models, OS versions, and browser (Safari iOS, Chrome Android) in the notes.

### Security
- No new network, storage, or input-injection surface. `e.preventDefault()` additions must
  be scoped to the stage/draw path so they do not break page scrolling elsewhere — verify
  no global scroll lock leaks outside the canvas.
