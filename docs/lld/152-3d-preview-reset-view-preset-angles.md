# LLD 152: 3D preview — reset-view / preset camera angles

Parent: #101 · Issue: #152 · Follow-up from LLD 130 (#124, true 3D preview via three.js
+ orbit camera). Filed there as follow-up #131.

## Scope

After the first 3D cut (LLD 130), the OrbitControls camera is **free-orbit only** — a user
who spins to an awkward angle has no one-click way back to a sensible framing. This cut adds:

**In scope**

- A single primary **"Recenter" affordance** (button + `Home` key) that returns the orbit
  camera to the default fit-to-bounds three-quarter framing — the pose `render3d.frame()`
  already computes (`render3d.js:476`).
- **Preset bearings** as discreet keyboard shortcuts only (no extra buttons): `1`=NE,
  `2`=NW, `3`=SE, `4`=Top-down. These re-use the same fit-to-bounds distance/target math as
  reset, varying only the horizontal bearing (and, for Top, the elevation).
- A **short eased tween** on the OrbitControls target + orbit angles (azimuth/polar/radius)
  so the camera arcs to the goal rather than snapping — **no fly-through** of geometry.
- Reset is the **core requirement**; presets are **optional polish that degrade gracefully**
  — reset works even if the preset keys are cut.

**Explicitly OUT of scope**

- **No plan/schema/share-link change.** Camera state stays **session-only** (already true in
  LLD 130). This cut does **not** touch #123 share scope — nothing new is persisted or
  serialized.
- **No fly-to / cinematic transitions** beyond a single short ease. No path-through-space
  animation.
- **No new persisted "saved viewpoints"**, no per-plan default angle, no gizmo/view-cube, no
  centered pill bar (frontend decision B — see Frontend Design).
- **No change to the read-only guarantee**, the `#tool-preview` toggle, the `P` shortcut, the
  `Esc`-exit, or the 2.5D fallback path — all carried over unchanged from LLD 130.

## Approach

### 1. Reuse `frame()`'s pose math; add an animated view-setter

`render3d.frame()` (`render3d.js:476-513`) already computes, from the scene `_bounds`, the
canonical fit-to-bounds pose: target = bounds centre, distance = `(diag/2)/tan(fov/2)*1.15`,
bearing `normalize(1, 0.8, 1)`, plus `near`/`far`/`minDistance`/`maxDistance`. It applies
that pose **instantly** and is used on entry, context-restore, and resize — those callers
must stay instant, so `frame()` is left intact.

The new work factors the pose *computation* out of the pose *application*:

- **`_viewPose(bearing)` (new, internal, pure-ish)** — returns
  `{ target:Vec3, position:Vec3, near, far, minDistance, maxDistance }` for a given unit
  bearing vector, using the exact bounds/distance math `frame()` uses today. Default bearing
  is `(1, 0.8, 1)` (the current three-quarter). `frame()` is refactored to call `_viewPose`
  and apply the result instantly (no behavior change).
- **`resetView({ animate }={})` (new, exported)** — computes `_viewPose(DEFAULT_BEARING)`
  and moves the camera there. `animate` defaults to `true` → eased tween (§2); `animate:false`
  (or reduced-motion, §3) → apply instantly exactly as `frame()` does, then one `_renderOnce()`.
  This is what the Recenter button and `Home` invoke. Because it reuses `_viewPose`, "reset"
  is definitionally the same framing `frame()` produces.
- **`setPreset(name, { animate }={})` (new, exported)** — `name ∈ {"ne","nw","se","top"}`;
  looks up the bearing (§4), computes `_viewPose(bearing)`, tweens/snaps to it. Presets are a
  thin wrapper over the same machinery; if they are ever cut, `resetView` is untouched.

Rationale: keeping one pose-computation path means reset and every preset share the
fit-to-bounds distance, clamps, and empty-plan fallback — no second framing algorithm to keep
in sync, and no risk of a preset that doesn't actually fit the plan.

### 2. The eased tween — orbit-space interpolation, not straight-line flight

The hard constraint is a **short ease on target/azimuth, no fly-through**. Interpolating raw
camera XYZ would fly the camera through walls. Instead we tween in **orbit space** so the
camera arcs around the target on a sphere (the natural OrbitControls motion):

Goal state is derived from `_viewPose`: `targetGoal` (Vec3), and the spherical
`(radiusGoal, azimuthGoal, polarGoal)` of `positionGoal` **relative to** `targetGoal`. Start
state is read live from the controls: `targetStart = controls.target`, and
`(radiusStart, azimuthStart, polarStart)` from `camera.position - controls.target`
(OrbitControls also exposes `getAzimuthalAngle()`/`getPolarAngle()`).

Each tween frame at parameter `t∈[0,1]` (ease-out cubic `1-(1-t)³`, duration ~300 ms):

- `target = lerp(targetStart, targetGoal, e)`
- `azimuth = azimuthStart + shortestDelta(azimuthStart, azimuthGoal) * e` (wrap to shortest
  arc so NE→NW never spins the long way; `polar`, `radius` lerp linearly)
- reconstruct `camera.position = target + sphericalToCartesian(radius, azimuth, polar)`,
  clamp `polar` to `[0.01, controls.maxPolarAngle]` so Top never crosses under the floor,
  then `controls.update()` + `renderer.render()`.

On completion: apply `near`/`far`/`minDistance`/`maxDistance` from the pose, set
`controls.target`/`camera.position` to the exact goal, `controls.update()`, `_renderOnce()`.

The tween runs its **own rAF handle** (`_tweenHandle`), distinct from the existing
self-terminating damping loop (`_loopHandle`, `render3d.js:210`). A running tween is
**interruptible**: on any user input (`controls` `start` event) or a new `resetView`/
`setPreset` call, the current tween is cancelled (`cancelAnimationFrame`, clear handle) and
the damping loop takes over / the new tween starts from the current pose. This prevents the
tween and a user drag fighting over the camera.

### 3. Reduced motion → instant

If `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, `resetView`/`setPreset`
skip the tween and apply the pose instantly (same code path as `animate:false`). This is the
"reset must work even without the tween" degradation, and respects the OS accessibility
setting. The tween is pure polish; correctness never depends on it.

### 4. Preset bearings

Scene frame (from LLD 130 §3): +Y is up, ground is the XZ plane, `sceneX = worldX`,
`sceneZ = worldY`. In screen/compass terms the 2D "up/north" is `worldY-` → `sceneZ-`, "east"
is `sceneX+`. Bearings are unit vectors `(x, elevation, z)` from target to camera; elevation
`0.8` matches `frame()`'s current three-quarter tilt (~35°):

| Key | Preset | Bearing (x, y, z) | Reads as |
|---|---|---|---|
| `Home` | Reset (default) | `(1, 0.8, 1)` | current fit three-quarter (= `frame()`) |
| `1` | NE | `(1, 0.8, -1)` | look from the north-east corner |
| `2` | NW | `(-1, 0.8, -1)` | north-west corner |
| `3` | SE | `(1, 0.8, 1)` | south-east corner (same bearing as default) |
| `4` | Top | `(0, 1, 0.0001)` | plan view, straight down |

Bearings are normalized before use. Top uses a near-zero Z so `sphericalToCartesian` has a
defined azimuth (avoids a gimbal NaN at exactly straight-down); polar is clamped to `≥0.01`.
Distance/target/clamps are identical to reset for every preset (§1). Reset and SE coincide by
design — SE is the canonical framing; NE/NW give the two alternate front corners and Top the
overhead read. (SW is intentionally omitted: four keys, and the default already covers the
south side.)

### 5. UI wiring (frontend decision B)

- A single **`<button id="btn-recenter">`** lives inside `#stage`, bottom-right, shown only
  in preview success mode via CSS (`.stage--preview #btn-recenter { display:flex }`), hidden
  on the 2.5D fallback (`.stage--preview.preview--fallback #btn-recenter { display:none }`)
  and in normal 2D editing. `aria-label="Recenter view (Home)"`. Click → `render3d.resetView()`.
- **Keys are handled in the existing `main.js` window `keydown` listener**, gated behind
  `previewIsActive()` so they never clash with 2D-mode bindings (e.g. `Shift+1` zoom-to-fit):
  `Home` → `resetView()`; `1`/`2`/`3`/`4` → `setPreset("ne"|"nw"|"se"|"top")`. Each
  `preventDefault()`s and returns. When preview is inactive or on the fallback path, the keys
  fall through untouched.
- No preset **buttons** (decision B): presets ride along as keycaps only. If WebGL is
  unavailable, both the button (CSS-hidden) and the keys (guarded to no-op — `resetView`
  early-returns when `_camera` is null) are inert, so the fallback path is unaffected.

## Interfaces / Types

### `render3d.js` — additions (all session-only, no persistence)

```js
/** Unit bearing (target→camera) for the default fit-to-bounds three-quarter view. */
const DEFAULT_BEARING = [1, 0.8, 1];

/** Named preset bearings (unit-normalized at use). @see Approach §4 */
const PRESET_BEARINGS = {
  ne: [1, 0.8, -1], nw: [-1, 0.8, -1], se: [1, 0.8, 1], top: [0, 1, 0.0001],
};

/**
 * Compute the canonical camera pose for a bearing from the current scene bounds.
 * Pure w.r.t. _bounds/_camera.fov; the single source of the fit-to-bounds math
 * (extracted from frame()). No tween, no side effects.
 * @param {[number,number,number]} bearing
 * @returns {{ target:{x,y,z}, position:{x,y,z}, near:number, far:number,
 *             minDistance:number, maxDistance:number }}
 */
function _viewPose(bearing);

/**
 * Return the orbit camera to the default fit-to-bounds framing (Recenter / Home).
 * Eased orbit-space tween by default; instant when animate:false or reduced-motion.
 * No-op if the engine/camera does not yet exist (loading / fallback).
 * @param {{ animate?: boolean }} [opts]
 */
export function resetView(opts);

/**
 * Snap/tween to a named preset bearing (NE/NW/SE/Top). Same pose machinery as
 * resetView; optional polish. No-op if name unknown or camera absent.
 * @param {"ne"|"nw"|"se"|"top"} name
 * @param {{ animate?: boolean }} [opts]
 */
export function setPreset(name, opts);
```

- **`frame()`** — refactored to delegate to `_viewPose(DEFAULT_BEARING)` and apply instantly.
  Its exported contract (instant re-frame, used by entry/resize/context-restore) is
  **unchanged**.
- **`_renderOnce()`** — already module-private (`render3d.js:526`); reused by the instant
  path. The tween uses its own frames (`controls.update()` + `renderer.render()`), matching
  the existing `_tick` shape.
- New internals: `_tweenHandle` (rAF handle, distinct from `_loopHandle`), `_cancelTween()`,
  and a `_reducedMotion()` helper.

### `index.html`

- Add `<button id="btn-recenter" type="button" aria-label="Recenter view (Home)">` inside
  `#stage` (sibling of `#stage3d`, after it in DOM order so it stacks above the canvas).
  Content: a small recenter/target glyph (inline SVG or text), matching the tool-rail button
  idiom.
- CSS (new block near the existing `#stage3d` rules, ~`:220`): absolutely position
  `#btn-recenter` bottom-right of `#stage` (`position:absolute; right:12px; bottom:12px;`),
  `display:none` by default; `.stage--preview #btn-recenter { display:flex }`;
  `.stage--preview.preview--fallback #btn-recenter { display:none }`. `touch-action`
  irrelevant (button, not the canvas). Keep chrome minimal — reuse existing button tokens.

### `main.js`

- Grab `const btnRecenter = document.getElementById("btn-recenter")` in the preview wiring
  block (~`:173-177`) and wire `btnRecenter?.addEventListener("click", () => render3d.resetView())`.
- In the window `keydown` listener (~`:629`), **before** the generic tool/zoom key handling
  and after the editable-focus guard, add a `previewIsActive()`-gated block:
  `Home` → `e.preventDefault(); render3d.resetView();`
  `1|2|3|4` → `e.preventDefault(); render3d.setPreset({1:"ne",2:"nw",3:"se",4:"top"}[e.key]);`
  Return after handling. Gated so it never runs in 2D mode.

### `help.js`

- Add rows to `SHORTCUTS` (`help.js:24`) under a new/existing group, e.g.:
  `{ group:"View", action:"Recenter 3D preview", mac:"Home", other:"Home" }` and one row
  covering presets: `{ group:"View", action:"3D preset angles (NE/NW/SE/Top)", mac:"1–4", other:"1–4" }`.

### `preview.js`, `isoRender.js`, `render3dEngine.js`, `exportImg.js`, `theme.js`

- **No change.** The reset/preset feature is entirely additive inside `render3d.js` + thin
  wiring. `render3dEngine.js` already re-exports everything the tween needs
  (`Vector3`, `Spherical` if used, or plain trig).

## State Model

- **Persisted plan state — unchanged.** No schema bump, no `validatePlan` change, no share-hash
  change, no JSON-export change. This cut adds **zero** plan data (restating LLD 130). #123
  share scope is untouched.
- **Camera / orbit state — session-only, in three.js objects only** (unchanged from LLD 130).
  Reset/presets mutate only the live `_camera`/`_controls`; nothing is written to
  `localStorage`, the URL hash, or the plan model. Reloading the page still starts in 2D with
  no remembered angle.
- **New transient module state:** `_tweenHandle` (rAF id or null). Cleared on tween
  completion, cancel, `exit()`, and `dispose()`. It is view-only and never serialized.
- **Teardown:** `exit()` and `dispose()` (`render3d.js:320,563`) gain a `_cancelTween()` call
  so an in-flight tween cannot outlive the preview or leak an rAF across a context release.

## Edge Cases

1. **Reset/preset before the engine exists** (during lazy load, or WebGL unavailable →
   fallback). `resetView`/`setPreset` early-return when `_camera`/`_controls` are null. Button
   is CSS-hidden until preview success; keys are `previewIsActive()`-gated and no-op on the
   fallback path. No crash, no error.
2. **Empty plan (`_bounds === null`).** `_viewPose` inherits `frame()`'s degenerate-bounds
   branch (default frame at origin, `diag=8`). Reset/presets orbit the empty default view; no
   NaN.
3. **Reduced motion.** `prefers-reduced-motion: reduce` → instant apply (no tween). Reset
   still works; presets still work. Degradation path for the core requirement.
4. **Tween interrupted by user drag.** A `controls` `start` during a tween cancels it
   (`_cancelTween`) and hands control to the damping loop; the camera stays wherever the tween
   had reached — no snap-back, no fight.
5. **Rapid key/click spam.** A new `resetView`/`setPreset` cancels any in-flight tween and
   starts fresh from the current pose. Idempotent target; no queue buildup.
6. **Preset already at goal.** Start ≈ goal → tween completes in ~1 frame (or the ease is a
   no-op); harmless.
7. **Azimuth wrap.** NE↔NW etc. use shortest-arc delta so the camera never spins the long way
   round (>180°).
8. **Top-down gimbal.** Bearing `(0,0.8-ish,~0)` would leave azimuth undefined at exactly
   straight-down; the `0.0001` Z and a `polar ≥ 0.01` clamp keep azimuth defined and keep the
   camera just shy of the pole, consistent with `controls.maxPolarAngle` (which only limits the
   *lower* bound / under-floor, `render3d.js:349`).
9. **Resize mid-tween.** The `resize()` path (`render3d.js:516`) updates aspect and renders;
   the tween keeps running against the updated camera. No special handling needed.
10. **Context loss mid-tween.** `webglcontextlost` (`render3d.js:251`) stops the damping loop;
    `_cancelTween()` is added there too so a tween doesn't render into a dead context. On
    restore, the scene rebuilds and re-frames instantly (existing behavior).
11. **Keys while focus in an input.** The existing editable-focus guard at the top of the
    `keydown` listener (`main.js:631-632`) already returns early; reset/preset keys inherit it.

## Dependencies

### Depends on (shipped)

- **LLD 130 / #124** (true 3D preview) — merged. Provides `render3d.js`, `frame()`,
  `_bounds`, `OrbitControls`, the `#tool-preview` toggle, `#stage3d`, the loading + fallback
  paths, and the `.stage--preview` / `.preview--fallback` CSS this feature keys off.

### Existing code reused / touched

- **`render3d.js`** — `frame()` refactor + `resetView`/`setPreset`/`_viewPose`/tween
  additions; `exit()`/`dispose()` gain `_cancelTween()`.
- **`main.js`** — Recenter button wiring + gated `Home`/`1-4` keys in the existing `keydown`
  listener.
- **`index.html`** — add `#btn-recenter` + its CSS.
- **`help.js`** — add shortcut rows.

### No new dependency

No new npm package. No new module. Vite build unaffected (no new chunk).

## Test Requirements

Mirror LLD 130's pure/impure split: pose math is unit-tested directly; the tween + WebGL are
smoke/behavior-tested. Tests in `test/tests.html` unless noted.

### Unit — pose computation (pure)

- `_viewPose(DEFAULT_BEARING)` returns a target at the bounds centre and a position offset
  along the normalized default bearing at the fit distance — i.e. **equals the pose `frame()`
  applies** (assert target/position parity with a `frame()`-driven camera on a fixed bounds).
- Each preset bearing produces the **same target and distance** as reset, differing only in
  direction (position lies on the same sphere around target).
- **Empty bounds** → default-origin pose, no NaN (target `y≈CEILING_M/2`, finite distance).
- Top preset yields a position essentially directly above the target (`x,z ≈ target.x,z`,
  `y > target.y`) with a defined (non-NaN) azimuth.

### Unit — tween interpolation (pure helper)

- `shortestDelta(a, b)` returns a signed delta in `(-π, π]` (NE→NW takes the short arc).
- Ease `e(t)` is monotonic with `e(0)=0`, `e(1)=1`.
- Interpolated `t=1` state equals the goal target/azimuth/polar/radius exactly.

### Behavior — reset/preset (drives the built app; WebGL-gated like LLD 130)

- With WebGL available: enter preview, orbit the camera to a non-default pose, click Recenter
  (or press `Home`) → after settling, `camera.position`/`controls.target` return to within ε
  of the default pose; no console/page error.
- `1`/`2`/`3`/`4` move to the expected bearing; each returns target to bounds centre.
- **Reduced-motion**: with `prefers-reduced-motion` forced, reset applies **instantly** (final
  pose reached without a multi-frame tween) — assert via a single-frame settle or a tween-skip
  probe.
- **Gating**: reset/preset keys are no-ops when preview is inactive (2D mode) — `Shift+1`
  zoom-to-fit and plain `1` still behave as before; the Recenter button is not visible in 2D.
- **Fallback**: with WebGL unavailable, Recenter button is hidden and the keys do not throw
  (camera absent → early return); the 2.5D fallback is unaffected.

### Behavior — read-only preserved

- Reset + every preset leave `walls.model` and `symbols.model` deeply equal to their
  pre-action snapshots (camera-only mutation) — extends the LLD 130 read-only assertion.

### Not tested (out of scope)

Exact tween easing curve / per-frame pixels, camera-angle exactness beyond ε, visual
regression of the 3D output (no headless GPU guarantee — deferred to manual QA).
