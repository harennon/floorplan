# LLD 2: MVP-1 — Drawing Surface Foundation (SVG canvas, pan/zoom, grid)

Phase 1 of 6 of the MVP epic (#1). This is the foundation every later phase draws on:
wall drawing (#MVP-2), snapping/dimensions (#MVP-3), symbols (#MVP-4), editing/undo
(#MVP-5), persistence/share (#MVP-6). Nothing here talks to a server.

## Scope

**Covers:**
- A full-viewport SVG drawing surface that fills the browser on mobile and desktop.
- A **world coordinate system** (world unit = **metre**) with a defined metre→pixel scale,
  exposed as a small reusable module later phases build wall geometry on.
- **Pan** (drag empty space; hold Space and drag) and **zoom** (mouse wheel; touch pinch;
  on-screen +/−/RESET buttons), zoom clamped to sane limits.
- An **adaptive grid** locked to world space that changes density as you zoom, drawn with
  fine / major / axis line tiers.
- A **HUD** (scale, zoom %, cursor coordinates) and a **unit toggle** (imperial ⇄ metric).
- Minimal floating chrome in the Direction A "warm blueprint" aesthetic.

**Does NOT cover (explicitly out, later phases):**
- Any drawable geometry (walls, rooms, doors, windows, furniture). A faint placeholder
  rectangle is allowed only to convey scale; it is not a data model and not editable.
- Snapping logic, dimension labels, area/perimeter computation.
- Selection, editing, undo/redo, keyboard shortcuts beyond Space-to-pan.
- Persistence (localStorage), URL-hash share, export (PNG/SVG/JSON).
- The unit *preference* is not persisted in this phase (persistence is #MVP-6); it resets
  to the imperial default on reload.

## Approach

**SVG, not `<canvas>`.** Later phases need hit-testing, per-element styling, and SVG
export "for free"; walls/symbols are a modest element count, not a particle system. SVG
keeps DOM-level interaction simple and matches the "shareable vector artifact" principle.
Revisit only if profiling on a dense plan shows redraw cost is a problem.

**Screen-space rendering, not SVG `viewBox` transforms.** We keep the SVG viewBox pinned
to pixel dimensions (`0 0 W H`) and project world→screen coordinates ourselves on every
render. Rationale: (a) grid line *density* must adapt to zoom (a viewBox scale would just
blow up the same lines and thicken strokes); (b) later phases want screen-constant stroke
widths and label sizes regardless of zoom; (c) a single documented projection is easier
for downstream LLDs to reason about than a compound SVG transform. Cost: we redraw on pan
(acceptable at MVP element counts; see Edge Cases for the throttling note).

**One projection, defined once.** All world↔screen conversion goes through the coordinate
module (`view.js` below). No other module may read `panX/panY/zoom` and do its own math.

**Base scale: 40px = 1m at zoom 1** (a 5m wall ≈ 200px). Confirmed frontend decision.

**Imperial-first.** Default unit is feet; the metric/imperial toggle stays but starts on
imperial because the primary audience skews US. World storage stays in **metres**
regardless of display unit — the unit only affects formatting in the HUD (and later,
dimension labels). This keeps one canonical internal unit for all geometry.

**Adaptive grid via a "nice number" ladder.** Pick the smallest step from a fixed ladder
`[0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100]` metres whose on-screen spacing is ≥ a target
(~56px). Every 5th line is a "major" line; the world origin lines are the "axis" tier.
This keeps fine cells between roughly 24–120px across the whole zoom range so the grid
never turns to mush or to a handful of lines.

**Zoom about a cursor anchor.** Wheel/pinch zoom keeps the world point under the
cursor/pinch-midpoint fixed by adjusting pan after changing zoom (see `zoomAbout`).

**Reference implementation.** The gh-pages mockup
`drawing-surface-foundation.html` (Direction A / warm blueprint) is the visual and
behavioral reference. The LLD promotes its inline script into named modules and flips the
unit default to imperial. Where this doc and the mockup disagree, this doc wins.

## Frontend Design

**Direction A — "Warm Blueprint".** Carries `src/index.html` palette forward for
portfolio cohesion (dark warm ground, gold ink).

- **Palette / tokens (CSS custom properties):**
  - `--bg: #14140f`, `--bg-deep: #100f0b`, `--ink: #ece7d6`, `--muted: #8f8a78`
  - `--gold: #c9a84c`, `--gold-soft: rgba(201,168,76,0.55)`
  - Grid tiers keyed off gold: `--grid-fine: rgba(201,168,76,0.055)`,
    `--grid-major: rgba(201,168,76,0.14)`, `--grid-axis: rgba(201,168,76,0.34)`
  - Chrome: `--panel: rgba(20,20,15,0.72)`, `--hairline: rgba(201,168,76,0.18)`
- **Type:** `--font-ui` DM Sans, `--font-mono` DM Mono (HUD / drafting readouts),
  `--font-display` Libre Baskerville (brand wordmark). Loaded from Google Fonts via
  `<link>` (no build step; matches existing `index.html`).
- **Stage texture:** radial-gradient "table" ground, an inset **vignette**, and a faint
  SVG-noise **grain** overlay (`mix-blend-mode: overlay`), all `pointer-events: none`.
- **Floating chrome, minimal:**
  - `.brand` top-left: wordmark + "warm blueprint" crumb, `pointer-events: none`.
  - `.unit-toggle` top-right: two pill buttons, IMPERIAL / METRIC. **IMPERIAL is
    `aria-pressed="true"` on load** (default flipped from the mockup).
  - `.zoom-cluster` bottom-left (thumb-reachable): `+`, `−`, `RESET`.
  - `.hud` bottom-right: monospace cells — Scale (units/cell), Zoom (%), Cursor (world
    coords). The Cursor cell is hidden under 560px to keep the HUD compact on phones.
  - `.hint` centered: dismissible one-time instruction ("scroll/pinch to zoom, drag or
    hold Space to pan"); fades out on first interaction.
- **Layout:** `.app { position: fixed; inset: 0 }` → `.stage` fills it; chrome is
  absolutely positioned over the stage. Zoom/HUD clusters use
  `env(safe-area-inset-bottom)` so they clear the iOS home indicator.
- **Cursor states:** `.stage` grab / `.panning` grabbing / `.space-ready` grab.
- **Touch:** `touch-action: none` on the stage (we own all gestures);
  `overscroll-behavior: none` + `overflow: hidden` on `html, body` to kill rubber-banding;
  viewport meta `maximum-scale=1.0, user-scalable=no` so browser pinch doesn't fight ours;
  `-webkit-tap-highlight-color: transparent`.

## Interfaces / Types

Ship as a small set of vanilla-JS ES modules under `src/js/`, loaded via
`<script type="module">`. No bundler. Suggested files: `view.js` (coordinate/scale +
state), `grid.js`, `surface.js` (SVG render + resize), `interactions.js` (pointer/wheel/
keyboard), `hud.js`, `units.js`, `main.js` (wiring/boot).

### Coordinate / scale module — `view.js` (the load-bearing contract)

This is the module later phases build wall geometry on. Its contract must stay stable.

```js
// World unit is METRES. At zoom 1, BASE_PX_PER_M px == 1 world metre.
// screen = world * (zoom * BASE_PX_PER_M) + pan
// world  = (screen - pan) / (zoom * BASE_PX_PER_M)

export const BASE_PX_PER_M = 40;   // confirmed: 40px = 1m at zoom 1
export const MIN_ZOOM = 0.15;      // ~6px/m — whole floors visible
export const MAX_ZOOM = 8;         // ~320px/m — detail work

// Mutable view state (single source of truth; only view.js writes these).
export const view = { zoom: 1, panX: 0, panY: 0 };

export function pxPerM(): number;                 // view.zoom * BASE_PX_PER_M
export function worldToScreen(wx, wy): {x, y};    // world m  -> screen px
export function screenToWorld(sx, sy): {x, y};    // screen px -> world m
export function clampZoom(z): number;             // MIN..MAX

// Zoom by `factor`, keeping the world point under (sx,sy) fixed on screen.
export function zoomAbout(sx, sy, factor): void;

// Reset to a sensible initial frame given current viewport W/H.
export function resetView(W, H): void;

// Register a callback fired after any view mutation (render trigger).
export function onChange(cb: () => void): void;
```

Downstream contract: a wall vertex is stored as `{x, y}` in **metres**. To render it,
call `worldToScreen`. To convert a pointer event to a candidate vertex, call
`screenToWorld`. Stroke widths and label font sizes are chosen in **screen px** and are
NOT scaled by zoom.

### Units module — `units.js`

```js
export const M_PER_FT = 0.3048;
export let unit = "ft";              // "ft" | "m"  — DEFAULT IMPERIAL
export function setUnit(u): void;    // updates state, fires onChange
export function fmtLen(meters): string;   // "16.4" (ft, 1dp) | "5.00" (m, 2dp)
export function unitLabel(): string;      // "ft" | "m"
```

### Grid module — `grid.js`

```js
export const NICE_STEPS = [0.1,0.25,0.5,1,2,5,10,20,50,100]; // metres
export const MAJOR_EVERY = 5;
// smallest NICE step whose on-screen spacing >= targetPx
export function chooseGridStep(targetPx = 56): number;
// draw fine/major/axis lines covering the visible world rect into <g id="grid">
export function drawGrid(gGrid, W, H): void;
```

### Surface / render — `surface.js`

```js
export function resize(): { W, H };   // read stage rect, set svg viewBox "0 0 W H"
export function render(): void;       // drawGrid + placeholder + HUD sync
```

## State Model

All state is **in-memory only** this phase (no localStorage, no URL — those are #MVP-6).

- **View state** (`view.js`): `{ zoom, panX, panY }`. `panX/panY` are the screen-pixel
  offset of the world origin. Single source of truth for the projection. Mutated only by
  `zoomAbout`, pan handlers (through a setter), and `resetView`.
- **Unit state** (`units.js`): `unit ∈ {"ft","m"}`, initial `"ft"`. Display-only; never
  affects stored geometry. Resets to `"ft"` on reload (not persisted).
- **Transient interaction state** (`interactions.js`): drag flag + last pointer position,
  `spaceHeld` flag, a `Map<pointerId, event>` for multi-touch, and pinch anchors
  (`pinchStartDist`, `pinchStartZoom`, `pinchMid`). All ephemeral; discarded on
  pointerup/cancel.
- **Viewport size** (`W`, `H`, from `resize()`): recomputed on window resize.
- **Hint dismissed** flag: one-way `false → true` on first interaction.

**Render flow:** any view/unit mutation → `onChange` → `render()` → `drawGrid()` +
placeholder + HUD text update. Render is idempotent: it clears `<g id="grid">` and
redraws from current state; no incremental diffing.

**Persisted vs in-memory:** nothing is persisted in this phase.

## Edge Cases

1. **Zoom clamping.** `zoomAbout` clamps to `[MIN_ZOOM, MAX_ZOOM]`. When clamped, the
   anchor-preserving pan adjustment must use the *clamped* zoom so the cursor stays put at
   the limit (no drift). Wheel/pinch/buttons all route through `clampZoom`.
2. **Pinch that also looks like a drag.** On the second pointerdown, cancel any in-flight
   single-pointer pan (`dragging = false`) so a two-finger gesture never also pans from
   one finger's delta.
3. **Losing a pointer mid-pinch.** On pointerup/pointercancel, remove it from the map; if
   fewer than 2 remain, clear `pinchStartDist` so the next move re-seeds the pinch instead
   of jumping. `pointercancel` (OS gesture steal, notifications) must reset drag/pinch the
   same as pointerup.
4. **Page scroll / browser zoom stealing gestures.** `wheel` handler calls
   `preventDefault()` and is registered `{ passive: false }`; stage has
   `touch-action: none`; body has `overscroll-behavior: none`. Verify no console
   "passive event listener" warnings.
5. **Grid over-draw at extreme zoom-out.** Because the step comes from the NICE ladder,
   the visible line count stays bounded; still, cap the loop defensively (e.g. bail if a
   tier would emit > ~2000 lines) so a degenerate `W/H` or zoom can't hang the main
   thread. Iterate by integer index off the origin, not by float accumulation, to avoid
   drift over long spans (`wx = idx * step`).
6. **Float precision near origin.** Use `Math.round(wx / step)` to classify axis/major so
   accumulated float error doesn't misclassify the origin line. Compare loop bounds with a
   small epsilon.
7. **HiDPI / devicePixelRatio.** SVG is resolution-independent; no manual DPR scaling
   needed (unlike canvas). `crispEdges` on grid lines keeps hairlines from blurring.
8. **Resize / orientation change.** On `resize`, recompute `W/H` and viewBox, then
   `render()`. `resetView` framing is expressed as fractions of `W/H` so it re-centers
   sensibly after rotation.
9. **Rapid pan/wheel performance.** Redraw is full each event. Coalesce renders with
   `requestAnimationFrame` (one render per frame max) so a fast wheel/drag doesn't queue
   dozens of synchronous DOM rebuilds. Build lines into a `DocumentFragment` and append
   once.
10. **Zero-area viewport.** If `stage.getBoundingClientRect()` returns `0×0` (hidden tab,
    pre-layout), skip render until a non-zero size arrives; guard divisions by `pxPerM()`
    (never zero since zoom is clamped > 0).
11. **RESET while zoomed/panned far away.** `resetView` restores `zoom = 1` and a framing
    that places the world origin up-left of center, guaranteeing the origin + grid are on
    screen regardless of prior state.
12. **Unit toggle mid-session.** Switching units only reformats HUD text; it must not move
    the view or alter any stored coordinate.

## Dependencies

- **Existing code:** `src/index.html` (palette + fonts to carry forward). This phase
  replaces the placeholder `index.html` body with the app shell but keeps the head's
  meta/fonts/OG tags and the color tokens.
- **Design reference:** gh-pages mockup `drawing-surface-foundation.html` (Direction A).
- **Platform:** static files in `src/` served by Cloudflare Pages; **no build step**, no
  npm, no framework. ES modules loaded directly by the browser.
- **Downstream:** #MVP-2..6 depend on `view.js`'s `worldToScreen` / `screenToWorld` /
  `view` contract and on the `<g id="world">` group as the mount point for future
  geometry. This LLD must land before any of them.
- **Nothing net-new** (no libraries, no backend).

## Test Requirements

No build step means no test runner is assumed; tests may be a lightweight in-page harness
or manual QA checklist. What must be covered:

**Unit (pure functions in `view.js` / `grid.js` / `units.js`):**
- `worldToScreen`/`screenToWorld` are exact inverses across a range of zoom/pan values
  (round-trip within float epsilon).
- At `zoom = 1`, `pxPerM() === 40`; a 5m span maps to 200px.
- `clampZoom` clamps at both ends and passes mid-range values through.
- `zoomAbout` keeps the anchor world point fixed on screen — including when the target
  zoom is clamped (no drift at MIN/MAX).
- `chooseGridStep` returns the correct NICE step at representative zooms and keeps
  on-screen spacing within the ~24–120px band; picks the top of the ladder when nothing
  qualifies.
- `fmtLen`/`unitLabel`: metres formatted to 2dp with "m"; feet = metres/0.3048 to 1dp with
  "ft"; default unit is `"ft"`.

**Integration / behavioral (in-browser):**
- Surface renders full-viewport on desktop and mobile widths with no modal/signup and no
  console errors.
- Wheel zoom, pinch zoom, and +/−/RESET all change zoom, stay clamped, and keep the grid
  locked to world space (a fixed world point stays under the cursor through a zoom).
- Drag-pan and Space-drag pan move the world under the pointer 1:1; grid stays aligned.
- Grid density visibly changes across the zoom range; axis lines mark the world origin;
  major every 5th.
- HUD updates live: cursor coords, zoom %, scale/cell; unit toggle reformats without
  moving the view.
- Resize / device rotation re-fits without breaking alignment; `pointercancel` cleanly
  ends drag/pinch.
- One render per animation frame under a fast continuous wheel/drag (no synchronous
  redraw storm).

**Security:**
- No network calls other than the Google Fonts `<link>` (matches existing `index.html`);
  no data leaves the client.
- Placeholder/HUD content is static or built via DOM APIs / numeric formatting — no
  `innerHTML` from any external or user-derived string (no injection surface). If
  `innerHTML` is used for HUD convenience, values must be numbers passed through
  `fmtLen`, never raw event data.
