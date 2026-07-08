# LLD 22: Zoom cap (800%) too coarse for in-room adjustment — snap step stuck at 0.25 m (~0.8 ft)

## Scope

**Problem.** The finest positional increment for placing/adjusting furniture and drawing
walls is ~0.25 m (~0.8 ft) — too coarse for laying out a room by the inch. Two facts
combine (verified in source):

1. `MAX_ZOOM = 8` (800% → 320 px/m), clamped in `clampZoom` (`view.js:16,51`).
2. The snap increment is derived from zoom via `chooseGridStep` (`grid.js:30`), which
   returns the finest `NICE_STEP` whose on-screen spacing ≥ 56 px. At 320 px/m the 0.1 m
   cell is 32 px (rejected) and 0.25 m at 80 px is accepted. The 0.1 m grid would only
   unlock at zoom ≥ 14 — unreachable under the 8× cap. So no zoom yields a snap finer
   than 0.25 m.

Snap is consumed by wall drawing (`resolveSnap`/`gridSnap`, `walls.js`) via
`wallTool.js:146,163` and by symbol placement/move (`symbolTool.js:204,367`), both
passing `chooseGridStep()`.

**This LLD covers (Option C from the frontend thread):**
- A user-selectable **snap precision** setting, surfaced as a **"Snap" chip** in the HUD
  with presets: **Auto** (today's adaptive behavior), **0.25 m**, **0.1 m**, **0.025 m
  (~1 in)**, and **Off** (free placement).
- **Decoupling the snap step from the rendered grid step** so the chosen precision
  applies at any zoom, without forcing extreme zoom.
- Raising `MAX_ZOOM` from **8 to 16** so **Auto** can still reach fine cells.
- Preserving the existing **Alt** momentary free-placement behavior for wall drawing and
  symbol move/placement.
- The **Off** mode intentionally also satisfies the deferred #23 no-snap request.

**Explicitly NOT covered:**
- Alignment guides / smart-snap-to-other-objects (deferred, sibling of #23).
- Any change to the adaptive **grid rendering** tiers/aesthetic — `drawGrid` and its
  56 px target are unchanged; only the *snap* decision is decoupled.
- Angle/rotation snap (still fixed 15°) and endpoint/close snapping precedence.
- Persisting the setting across reloads via localStorage (see Edge Case: chosen default
  is in-memory only, matching the `units.js` precedent).

## Approach

### Core decision: a single `snapStep()` authority, decoupled from `chooseGridStep()`

Introduce a **snap-precision mode** owned by `grid.js` (it already owns step logic). The
mode is one of `"auto" | 0.25 | 0.1 | 0.025 | "off"`. A new pure function
`snapStep()` resolves the mode to the effective step in metres (or `null` for Off):

- `"auto"` → delegates to the existing `chooseGridStep(56)` (unchanged adaptive rule).
- a numeric preset → returns that number verbatim, **independent of zoom**.
- `"off"` → returns `null`.

All snap call sites switch from `chooseGridStep()` to `snapStep()`, and treat a `null`
result as "no grid snap" (equivalent to today's Alt free-placement, but sticky). This is
the decoupling: fixed presets no longer depend on zoom, so 0.025 m is reachable at any
zoom.

`chooseGridStep()` stays exactly as-is and remains the authority for **grid rendering**
(`drawGrid`) and the HUD **Scale** cell. Grid rendering and snapping are now independent.

### Raising MAX_ZOOM

`MAX_ZOOM: 8 → 16` (~640 px/m). This is needed only so **Auto** can reach the 0.1 m cell
(560 px/m). It does not affect fixed presets. `clampZoom`, `zoomAbout`, pinch, and
`fitToContent` already clamp through `MAX_ZOOM`, so no other view math changes.

### Alt interaction (must be preserved)

Alt remains a **momentary** override that forces free placement regardless of the sticky
mode. Precedence at each snap call site:

1. Alt held → free (raw world point). (unchanged)
2. Else mode `"off"` → free (raw world point). (new; sticky equivalent of Alt)
3. Else → snap to `snapStep()` metres.

For wall drawing, endpoint and close snaps still supersede grid snap (they already do in
`resolveSnap`); Off/Alt only bypass **grid** snap, exactly as Alt does today
(`walls.js:143`).

### Why the HUD "Snap" chip

The HUD already has a **Snap** cell (`#hud-snap-val`) — but today that shows the *wall
snap type* ("Grid"/"Point"/"Free"), owned by `wallTool.js`. To avoid overloading it, the
precision selector is a **separate, clickable chip** added to the HUD cluster. Clicking it
cycles presets (and/or opens a small popover — see Frontend Design). Keeping it in the HUD
matches the warm-blueprint chrome and the reporter's mental model ("how fine am I
snapping right now").
## Interfaces / Types

### `view.js` (one-line change)

```js
export const MAX_ZOOM = 16;   // was 8; ~640px/m so Auto snap can reach the 0.1m cell
```

### `grid.js` — new snap-mode authority (additive; `chooseGridStep` unchanged)

```js
/** Ordered presets for the HUD Snap chip. "auto" and "off" are sentinels;
 *  numbers are fixed steps in metres. */
export const SNAP_PRESETS = ["auto", 0.25, 0.1, 0.025, "off"];

/** @typedef {"auto" | 0.25 | 0.1 | 0.025 | "off"} SnapMode */

/** Current snap-precision mode. In-memory (not persisted), default "auto". */
let _snapMode = "auto";

/** @returns {SnapMode} */
export function getSnapMode() { return _snapMode; }

/** Set the snap mode. Must be one of SNAP_PRESETS. Fires onSnapModeChange listeners. */
export function setSnapMode(mode) { /* validate ∈ SNAP_PRESETS; assign; notify */ }

/** Advance to the next preset (wraps). Used by the HUD chip click. @returns {SnapMode} */
export function cycleSnapMode() { /* index = (idx+1) % len; setSnapMode(...) */ }

/**
 * Effective snap step in metres for the current mode, decoupled from render/zoom.
 *  - "auto"  → chooseGridStep(56)   (adaptive; zoom-dependent, unchanged rule)
 *  - number  → that value verbatim  (zoom-INDEPENDENT)
 *  - "off"   → null                 (free placement; caller skips grid snap)
 * @returns {number|null}
 */
export function snapStep() {
  if (_snapMode === "off") return null;
  if (_snapMode === "auto") return chooseGridStep(56);
  return _snapMode; // fixed numeric preset
}

/** Register a callback fired after the snap mode changes (HUD re-render). */
export function onSnapModeChange(cb) { /* push to listeners */ }
```

### `walls.js` — `resolveSnap` accepts a nullable step

`resolveSnap(sx, sy, { chain, rooms, altHeld, step })` gains one rule: when `step == null`
(Off mode) **and** no close/point snap applies, return the raw world point with
`type: "free"` — identical to the `altHeld` branch (`walls.js:143`). Signature unchanged;
only the `step`-handling branch is added. `gridSnap` is untouched.

### `symbolTool.js` — placement/move use `snapStep()`

Replace the two `chooseGridStep()` calls (`symbolTool.js:204` in `onSelectMove`,
`symbolTool.js:367` in `_snapToGrid`) with `snapStep()` and skip grid snap when it is
`null`:

```js
// onSelectMove (move drag)
const step = snapStep();
if (!_altHeld && step != null) {
  const s = gridSnap({ x: newX, y: newY }, step); newX = s.x; newY = s.y;
}
// _snapToGrid (dock placement ghost + drop)
function _snapToGrid(sx, sy, altHeld) {
  const wp = screenToWorld(sx, sy);
  const step = snapStep();
  if (altHeld || step == null) return wp;   // Alt OR Off → free
  return gridSnap(wp, step);
}
```
Import switches from `chooseGridStep` to `snapStep` (`symbolTool.js:17`).

### `wallTool.js` — draw hover/click use `snapStep()`

The two `resolveSnap(..., { step: chooseGridStep() })` calls (`wallTool.js:146,163`) pass
`step: snapStep()` instead. Off/Alt → `type: "free"` flows through the existing snap-tag
and `#hud-snap-val` labeling unchanged. Import switches to `snapStep`.

### `hud.js` — render the Snap-precision chip

`hud.js` gains a DOM ref for the new chip and a label formatter. It subscribes to
`grid.onSnapModeChange` and updates on `view` change (so Auto reflects live zoom).

```js
/** Human label for the chip, current units aware. */
function _snapChipLabel(mode) {
  if (mode === "off")  return "Off";
  if (mode === "auto") return `Auto (${fmtLen(chooseGridStep())} ${unitLabel()})`;
  return `${fmtLen(mode)} ${unitLabel()}`;   // 0.25 / 0.1 / 0.025 m in current unit
}
```
Chip click → `grid.cycleSnapMode()`. (Note: `hud.js` already duplicates step logic in
`_scaleForHud` to dodge a cycle; importing `chooseGridStep`/snap API from `grid.js` here
is acceptable since `grid.js` does not import `hud.js` — verify no cycle at wire time, or
keep the local mirror and only import the snap-mode getters.)

## State Model

- **`_snapMode`** (module-level in `grid.js`): single source of truth for snap precision.
  In-memory only; **not persisted** to localStorage or the plan, and **not** in the share
  hash — it is a view/editing preference, mirroring `units.js` (which resets on reload).
  Defaults to `"auto"` on every load → today's behavior is the default; zero behavior
  change for users who never touch the chip.
- **`_snapMode` change flow:** chip click → `cycleSnapMode()` → `setSnapMode()` → notify
  `onSnapModeChange` listeners → `hud.update()` refreshes the chip label + `scheduleRender`
  (via existing HUD/view render wiring) so any live placement ghost re-snaps on next move.
- **`MAX_ZOOM`**: compile-time constant; no runtime state. Existing persisted `view`
  (`plan.js`/`store.js`, restored via `setView` which re-clamps) is unaffected — a stored
  zoom ≤ 8 is still valid under the raised cap.
- **Snap step** is now **derived, never stored**: each pointer event recomputes
  `snapStep()`. Nothing about the mode is written into symbols, walls, or the plan — the
  geometry produced is plain metres, so plans authored at 0.025 m load identically
  everywhere.

## Frontend Design

**Frontend decision: C** — implemented as approved from the mockup thread. Do NOT re-open
the frontend gate; remove the `blocked:frontend-decision` label. Keep the warm-blueprint
aesthetic and the existing adaptive grid rendering intact.

1. **New "Snap" precision chip in the HUD cluster** (`.hud`, `src/index.html` ~L1255).
   Add a **clickable** `hud-cell` styled as a chip (reuse `.hud-cell` tokens; it is the
   only interactive HUD cell, so give it `role="button"`, `tabindex="0"`, `cursor:pointer`
   and a subtle hover/focus-visible outline consistent with `.dim-chip`):
   ```html
   <button class="hud-cell hud-snap-mode" id="hud-snap-mode"
           aria-label="Snap precision">Snap&nbsp;<span id="hud-snap-mode-val">Auto</span></button>
   ```
   Place it **before** the existing "Snap" (type) cell, or rename the existing label to
   avoid two "Snap" words: keep the existing `#hud-snap-val` (snap *type* while drawing)
   and label the new one **"Grid"** or **"Snap ▾"**. Recommended: label the new chip
   **"Snap"** with a small ▾ caret and relabel the wall-type cell context is enough; final
   copy is a visual-polish call for `frontend-architect` but must not add a second bare
   "Snap" token. The chip shows the current label from `_snapChipLabel()`.

2. **Interaction:** click / tap / Enter / Space **cycles** presets
   Auto → 0.25 m → 0.1 m → 0.025 m → Off → Auto (unit-formatted; imperial shows the ft/in
   equivalent via `fmtLen`). A brief existing `showToast` confirmation (e.g. "Snap: 1 in")
   is optional but recommended for tap discoverability. Cycling is the MVP; a popover
   menu listing all five presets is an acceptable enhancement using existing overlay
   tokens but is not required.

3. **Off mode affordance:** when Off, the chip reads **"Off"** and (optional) gets a muted
   treatment; this is the sticky counterpart to momentary **Alt**. The existing help
   sheet row "Free-snap Alt" stays; add a line noting the Snap chip's Off preset.

4. **No change to grid rendering or the blueprint palette.** The adaptive grid, major/axis
   tiers, and the HUD **Scale** cell continue to reflect `chooseGridStep()` — only the
   snap decision is decoupled. At high zoom under the new 16× cap the existing grid keeps
   subdividing exactly as designed.

**Accessibility:** the chip is a real `<button>` with `aria-label="Snap precision"`; its
value span is announced on change via the HUD's existing `aria-live` region context, or add
`aria-live="polite"` to the value span. Keyboard-operable (Enter/Space). Hit target ≥ the
existing HUD cell size (already ≥ 44 px tall on mobile is a polish check).
## Edge Cases

1. **Alt held while a fixed preset or Auto is active** → Alt wins (free placement),
   momentary; on Alt release the sticky mode resumes. (Preserves `symbolTool.js`
   `_altHeld` and `wallTool` altHeld behavior.)
2. **Off mode + Alt** → both mean free; no conflict, result is raw world point.
3. **Off mode + endpoint/close snap (wall drawing)** → endpoint/close still supersede
   (they precede the grid/free branch in `resolveSnap`). Off only disables *grid* snap,
   identical to Alt today.
4. **Auto at max zoom (16×, 640 px/m)** → `chooseGridStep(56)` now accepts 0.1 m (64 px);
   the ~0.8 ft floor is gone even without switching to a fixed preset.
5. **0.025 m preset at very low zoom** (e.g. 0.15×, 6 px/m) → snap step is 0.025 m = 0.15
   px on screen: snapping is mathematically correct but visually imperceptible and hard to
   control by pointer. Acceptable (user chose it); the grid render still shows a coarse
   cell. No clamp — but the chip label makes the active precision explicit.
6. **Stored view with zoom near old cap** restored via `setView`/`fitToContent` → still
   valid; raised cap only widens the allowed range. No migration needed.
7. **Unit toggle (m ↔ ft) while chip is shown** → chip re-renders via `units.onChange`
   already wired into `hud.update()`; 0.025 m shows as ~1 in, 0.1 m as ~0.3 ft, etc.
   Presets are defined in **metres** (world unit); only the label is unit-formatted.
8. **HUD import cycle risk:** `hud.js` importing `grid.js` — confirm `grid.js` does not
   import `hud.js` (it does not; it imports only `view.js`). If a cycle ever arises, keep
   `hud.js`'s local step mirror and import only `getSnapMode/cycleSnapMode/onSnapModeChange`.
9. **`snapStep()` returns `null`** must be handled at *every* call site (`wallTool` ×2,
   `symbolTool` ×2). A missed site would call `gridSnap(pt, null)` → `Math.round(x/null)`
   → `NaN` coordinates. All four sites must guard `step == null`.
10. **Invalid mode passed to `setSnapMode`** → validate against `SNAP_PRESETS`; ignore /
    throw (dev error). Chip only ever calls `cycleSnapMode`, so this guards programmatic
    misuse.
11. **Placement ghost already on screen when mode changes** → the ghost re-snaps on the
    next pointer move (ghost is recomputed each `_onMove`); a stale ghost for one frame is
    acceptable. `onSnapModeChange` triggers `scheduleRender` so the current frame refreshes.

## Dependencies

- **`view.js`** — `MAX_ZOOM` constant (this LLD edits it). No structural dependency.
- **`grid.js`** — existing `chooseGridStep`, `NICE_STEPS`; this LLD adds the snap-mode API
  alongside. `grid.js` imports only `view.js` (no cycle).
- **`walls.js`** — `resolveSnap`/`gridSnap` (LLD 04). `resolveSnap` step-branch edit.
- **`wallTool.js`**, **`symbolTool.js`** — snap call sites (LLD 04, LLD 12). Switch to
  `snapStep()`.
- **`hud.js`** + **`src/index.html`** HUD markup — new chip.
- **`units.js`** — `fmtLen`/`unitLabel`/`onChange` for chip labeling (existing).
- No new libraries, no build step, no backend — consistent with client-side-only v1.
- Must land after or alongside the existing snapping/editing stack (LLD 04, 12, 21); no
  blocking prerequisite work remains.

## Test Requirements

**Unit (pure logic):**
- `snapStep()` returns: `chooseGridStep(56)` for `"auto"`; exact `0.25/0.1/0.025` for
  numeric modes **regardless of `view.zoom`**; `null` for `"off"`.
- `snapStep()` for a fixed preset is **zoom-independent**: same value at zoom 0.15, 1, 16.
- `setSnapMode` validation rejects values outside `SNAP_PRESETS`; `cycleSnapMode` wraps
  Auto→…→Off→Auto in order and fires `onSnapModeChange` once per change.
- `chooseGridStep` unchanged: at the new 640 px/m (16×) it returns 0.1 m (regression that
  the render step still tracks zoom).
- `clampZoom` now permits up to 16 and still floors at `MIN_ZOOM`.
- `gridSnap` never receives `null` (guarded) — assert call sites skip snap when `null`.

**Integration (DOM / interaction):**
- Symbol move drag with mode `0.025` snaps to 0.025 m increments at 800% **and** at lower
  zoom (the reported bug: sub-0.25 m nudge now possible without max zoom).
- Symbol dock placement drop honors the active preset; Alt during drop forces free.
- Wall draw hover/click: fixed preset produces grid-snapped vertices at the preset step;
  Off produces free vertices; endpoint/close snap still wins over Off (Edge Case 3).
- Alt momentary override works in every mode and reverts on release/blur (`_onWindowBlur`).
- HUD chip: click/Enter/Space cycles presets; label updates and is unit-aware
  (0.025 m ↔ ~1 in on unit toggle).
- Auto mode reaches 0.1 m snap once zoom exceeds ~14× (now attainable under 16× cap).

**Regression / safety:**
- Default load = `"auto"` → identical snapping to pre-change behavior.
- Restoring a persisted plan/view with a large zoom does not throw and clamps correctly.
- No `NaN` symbol/vertex coordinates in any mode (guards the `snapStep()===null` path).
- Snap mode is absent from serialized plan and share hash (not persisted).
## Test Requirements
