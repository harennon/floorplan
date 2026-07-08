# LLD 26: Persistent snap toggle + wall-flush snapping for symbols

Parent issue: #23 · Order 1 of 3 · Effort: medium

## Scope

Delivers most of the "seat the couch against the wall" value on its own. Three deliverables,
built on top of the existing symbol placement/drag path in `symbolTool.js` (`_snapToGrid` and
the `onSelectMove` move branch):

1. **Persistent grid-snap on/off toggle** — a discoverable HUD button that turns grid snapping
   off/on, persisted to `localStorage` so the choice survives reload. When OFF, symbols drop at
   the raw world point.
2. **Wall-flush snapping** — when a placed/dragged symbol's nearest edge is within a small
   threshold of a nearby wall face, seat that edge flush (coincident) against the wall face.
3. **Precedence** — when a wall-flush target and the nearest grid line are both in range, the
   wall-flush target wins.

The transient hold-Alt bypass continues to work as a per-gesture override, **independent of the
toggle state** (Alt still means "raw point right now").

### Explicitly NOT in scope

- Object-to-object alignment (sibling sub-issue #2 of #23).
- Room-center snap (sibling sub-issue #3 of #23).
- Any change to `chooseGridStep` / zoom / the snap-precision chip logic (owned by #22/#27). This
  LLD does **not** re-touch that path; it composes on top of `snapStep()`.
- New guide-line *rendering system*: reuse the existing cursor-side `.snap-tag` element and the
  existing overlay ghost. Only a light, faded flush guide line is added to the existing overlay.
- Wall snapping for the wall-drawing tool (`resolveSnap` in `walls.js` is untouched).

## Approach

### Where the change lands

Today symbols snap in two places in `symbolTool.js`, both calling `snapStep()` then
`gridSnap()`:

- `_snapToGrid(sx, sy, altHeld)` — dock drag-placement (ghost + drop).
- The `move` branch of `onSelectMove()` — dragging an existing symbol.

We consolidate both into **one resolver** so grid-off, wall-flush, precedence, and Alt-bypass
behave identically for placement and drag. The resolver is a small pure-ish helper plus a new
geometry function in `symbols.js`. We do **not** touch `chooseGridStep`/`snapStep` internals
(owned by #22/#27) — we only consume `snapStep()` and compose on top of it.

### Three concerns, three decisions

**1. Persistent grid-snap toggle → new `prefs.js` module.**
The existing snap-*precision* chip (`grid.js` `_snapMode`) is a separate, in-memory concept
(Auto / 0.25 / 0.1 / 0.025 / Off) and is **not** persisted. Rather than overload it, add a tiny
dedicated `prefs.js` that owns persisted UI preferences, starting with one boolean
`gridSnap` (default `true`). It persists to its own `localStorage` key and exposes get/set/
toggle + an `onChange` listener list, mirroring the `grid.js` snap-mode API shape. This keeps
the plan-document store (`store.js` / `floorplan:plan:v1`) — which is *document* state — cleanly
separate from *editor preferences*. The symbol resolver reads `prefs.gridSnap()` as a master gate
on grid snapping.

**2. Wall-flush snapping → new pure geometry in `symbols.js`, reusing `walls.js`.**
Add `nearestWallFlush(sym, thresholdM)` to `symbols.js`. It reuses `symbols.corners(sym)` for the
symbol box and iterates the wall segments derived from `walls.model` (committed rooms' consecutive
vertex pairs + the active chain), reusing `walls.WALL_M` for wall thickness. For each segment it:

- builds the segment's unit direction `t` and unit normal `n`;
- offsets the centerline by `±WALL_M/2` along `n` to get the two **wall faces**;
- requires the symbol to be roughly **parallel** to the wall (angle between the symbol's local
  axes and the wall direction within `PARALLEL_TOL_DEG`, default 12°) — otherwise skip, so we
  never seat a symbol diagonally against a wall;
- projects the symbol's corners onto `n` to get its near-face offset toward the wall, and onto
  `t` to get its span; requires the symbol's `t`-span to **overlap** the segment's `t`-span (so
  the symbol is actually beside this wall, not off its end);
- computes the signed perpendicular gap between the symbol's near face and the closest wall face;
- if `|gap| <= thresholdM`, records a candidate `{ dx, dy, gap, faceType:"wall" }` where
  `(dx,dy) = gap * n` is the translation that makes the symbol's near edge coincident with the
  face, plus a guide segment (the wall face span) for rendering.

It returns the candidate with the smallest `|gap|`, or `null`. Translation-only — we never
auto-rotate the symbol (predictable; the user rotates via the inspector/90° first).

**3. Precedence + Alt bypass → in the resolver.** Resolution order:

1. **Alt held** → raw world point, no grid, no flush (transient full bypass; unchanged behavior).
   This is independent of the toggle — Alt always yields raw.
2. **Wall-flush** → if `nearestWallFlush` returns a candidate, apply its translation to the raw
   center. The flush constrains only the **perpendicular (normal) axis**. Along the wall
   direction, if grid is enabled, grid-snap the parallel component; otherwise leave it raw. Thus
   wall-flush wins over the nearest grid line on the axis that matters. **Wall-flush stays active
   regardless of the grid toggle** — it is the feature's core value ("seat the couch against the
   wall"), not "the grid." Users who want truly-free placement even next to a wall hold Alt.
3. **Grid** → else if `prefs.gridSnap()` is on and `snapStep()` returns a step, `gridSnap(raw,
   step)`.
4. **Raw** → else the raw world point (grid toggle off / snap mode "Off", no wall nearby).

The resolver returns `{ x, y, snapType }` where `snapType ∈ {"flush","grid","free"}`, driving the
`.snap-tag` label/color and the guide.

Threshold: `WALL_FLUSH_PX = 12` screen px, converted to metres via `pxPerM()` at resolve time so
it feels consistent across zoom (mirrors `walls.SNAP_PT_PX`).

### Rationale summary

- No new dependency; all client-side vanilla JS. No build step. (Aligns with "Deploy cheap.")
- Reuses `walls.allVertices`/segment structure and `symbols.corners` — no parallel geometry system.
- Leaves `chooseGridStep`/zoom (#22/#27) untouched.
- Preference persistence isolated from document persistence.

## Frontend Design

**Frontend decision: Option A.**

### Grid-snap toggle button (Option A — decided)

A new interactive HUD cell **stacked above** the existing Grid/precision chip in the `.hud`
column (bottom-right, `flex-direction: column; align-items: flex-end`). Insert it as the first
child so it renders topmost in the stack, matching existing chrome (`button.hud-snap-mode`
styling: mono font, `var(--panel)` bg, `var(--hairline)` border, 4px radius, `min-height:
1.75rem` touch target).

- **Markup:** `<button class="hud-cell hud-grid-toggle" id="hud-grid-toggle"
  aria-pressed="true" aria-label="Grid snap (on)">Snap&nbsp;<span
  id="hud-grid-toggle-val">On</span></button>`. (Note: the neighboring existing cell labeled
  "Snap … —" is the snap *type* readout; to avoid a label collision, this toggle uses the icon +
  "On/Off" value and its accessible name disambiguates. If reviewers find "Snap/Snap" confusing,
  label this one "Grid" — but the existing precision chip already begins with "Grid", so "Snap"
  is the recommended visible label with the icon carrying the meaning.)
- **Visual state (Option A):** a small square grid glyph. **On → filled gold**
  (`var(--accent)` / the gold used by `length-chip--live`, `#d9be6e`); **Off → hollow / muted**
  (`var(--muted)` outline, no fill). The `#hud-grid-toggle-val` text reads `On` / `Off`.
  `aria-pressed` reflects state for screen readers.
- **Interaction:** click / Enter / Space toggles `prefs.gridSnap`. Pointer-events enabled on the
  button (the `.hud` container is `pointer-events:none`; individual interactive cells opt back in,
  as `button.hud-snap-mode` already does).
- **Persistence feedback:** state restored on load from `prefs.js` before first render, so the
  button paints correctly with no flash.

### Snap feedback (reuse existing `.snap-tag`)

Reuse the existing cursor-side `.snap-tag` element (currently only driven by `wallTool.js` in
draw mode). Extend it to also show during symbol placement/drag in select mode, color-coded:

| snapType | label   | color                              |
| -------- | ------- | ---------------------------------- |
| flush    | `flush` | green `#9cd67a` (matches wall "close") |
| grid     | `grid`  | teal `#7fd0c8` (matches wall "grid")   |
| free     | `free`  | muted `#8f8a78`                    |

Position it near the cursor with the same clamping logic already in
`wallTool._positionSnapTag`. Hide it when no symbol drag/placement is active. To avoid the
wall-tool and symbol-tool fighting over the single element, the symbol path only writes to
`.snap-tag` while a symbol ghost/drag is active and select mode is current; on gesture end it
hides it. (wallTool already guards with `isDrawMode()`, so the two never run simultaneously.)

### Flush guide line

When `snapType === "flush"`, draw a single thin guide segment along the matched wall face into
the existing `#symbol-overlay` group (the same overlay that renders the ghost), styled like a
faint accent hairline. It **fades in over ~120ms** (CSS `transition: opacity 120ms`), and the
transition is disabled under `@media (prefers-reduced-motion: reduce)` (the stylesheet already
has such a block — extend it). The guide is cleared when snapType leaves "flush" or the gesture
ends. No new persistent overlay layer is introduced.

### Accessibility / mobile

- Touch: button meets the existing 1.75rem min touch target; the toggle works on tap.
- The flush behavior needs no keyboard equivalent; Alt-bypass is a desktop refinement and the
  toggle covers the discoverable path.
- `.snap-tag` and guide are `aria-hidden` decoration; state is conveyed by the button's
  `aria-pressed`.

## Interfaces / Types

### New module: `src/js/prefs.js`

```js
// Persisted editor preferences (distinct from the plan document in store.js).
export const PREFS_KEY = "floorplan:prefs:v1";

/** @typedef {{ gridSnap: boolean }} Prefs */

/** Read current grid-snap preference. Default true. */
export function gridSnap(): boolean;

/** Set grid-snap on/off; persists and fires onChange listeners. */
export function setGridSnap(on: boolean): void;

/** Toggle grid-snap; returns new value. */
export function toggleGridSnap(): boolean;

/** Register a callback fired after any pref changes. */
export function onPrefsChange(cb: () => void): void;
```

Behavior:
- On module load, read `PREFS_KEY` from `localStorage`; parse defensively (try/catch, like
  `store.loadLocal`); on any failure fall back to defaults (`{ gridSnap: true }`).
- `setGridSnap` writes JSON to `localStorage` inside try/catch (ignore quota/private-mode
  failures — the in-memory value still updates so the session behaves; mirrors `store.clearLocal`
  tolerance).

### New geometry in `src/js/symbols.js`

```js
/** Screen-px flush threshold, converted to metres by the caller before use. */
export const WALL_FLUSH_PX = 12;   // (declared where the resolver lives; see note)
export const PARALLEL_TOL_DEG = 12;

/**
 * @typedef {{
 *   dx:number, dy:number,          // translation to seat symbol flush (world m)
 *   gap:number,                    // signed perpendicular gap before snap (m)
 *   guide:{ a:{x,y}, b:{x,y} }     // wall-face segment for the guide line (world m)
 * }} FlushCandidate
 *
 * Nearest wall-face the symbol's near edge can seat flush against, or null.
 * Pure: reads walls.model via an injected accessor OR imports allVertices/segments.
 * @param {Sym} sym
 * @param {number} thresholdM   flush distance threshold in world metres
 * @returns {FlushCandidate|null}
 */
export function nearestWallFlush(sym, thresholdM): FlushCandidate | null;
```

Implementation notes:
- Wall segments = for each `room` in `walls.model.rooms`, consecutive vertex pairs (plus closing
  edge when `room.closed`), and consecutive pairs of `walls.model.chain`. To keep `symbols.js`
  DOM/coupling-free and avoid a `symbols → walls` hard import cycle risk, expose a helper
  `wallSegments()` in `walls.js` (reusing the existing iteration structure that `allVertices`
  and `resolveSnap` already use) and pass segments into `nearestWallFlush(sym, thresholdM,
  segments)`. `symbols.js` stays pure; `symbolTool.js` supplies `segments` + `WALL_M`.
- Reuse `corners(sym)` for the box; reuse `walls.WALL_M` for face offset.

Recommended concrete signature (keeps `symbols.js` decoupled):
`nearestWallFlush(corners, segments, wallM, thresholdM, parallelTolDeg) → FlushCandidate|null`.

### New export in `src/js/walls.js`

```js
/**
 * All wall segments as {a,b} vertex pairs: committed rooms (with closing edge
 * when closed) + active chain. Mirrors allVertices() structure.
 * @returns {{ a:Vertex, b:Vertex }[]}
 */
export function wallSegments(): { a: Vertex, b: Vertex }[];
```

### Resolver in `src/js/symbolTool.js` (replaces `_snapToGrid`)

```js
/**
 * Resolve a symbol's placement point for a given raw screen pointer.
 * @param {number} sx @param {number} sy
 * @param {boolean} altHeld
 * @param {{type,x,y,w,h,rot}} boxLike   ghost or live symbol (for flush geometry)
 * @returns {{ x:number, y:number, snapType:"flush"|"grid"|"free" }}
 */
function _resolvePlacement(sx, sy, altHeld, boxLike);
```

Order: Alt → flush → grid → free (see Approach). Existing call sites (`_onDockPointerDown`
seed/move/up, and `onSelectMove` move branch) call `_resolvePlacement` instead of `_snapToGrid`
+ `gridSnap`. The returned `snapType` is passed to the `.snap-tag`/guide updater.

### HUD wiring (`src/js/hud.js`)

`init(...)` gains a `elGridToggleBtn` ref; wires click/keydown → `prefs.toggleGridSnap()`, and
`prefs.onPrefsChange(() => update())`. `update()` sets the button's `aria-pressed`,
`aria-label`, and `#hud-grid-toggle-val` text + `data-state` (for CSS fill). `main.js` looks up
`#hud-grid-toggle` and passes it through.

## State Model

- **`prefs.gridSnap`** — persisted to `localStorage` under `floorplan:prefs:v1`. Read once at
  module init into an in-memory boolean; every set writes through. This is **editor preference**,
  intentionally separate from the plan document (`floorplan:plan:v1`) and from the URL-hash share
  payload — the shared link should not force a viewer's snap preference, and it does not belong in
  export JSON. Restored before first HUD render.
- **`grid._snapMode`** (precision chip) — unchanged, remains in-memory/not persisted (owned by
  #22/#27). The two are ANDed at resolve time: grid snapping applies only when
  `prefs.gridSnap() === true` **and** `snapStep()` returns a non-null step.
- **`_altHeld`** — unchanged transient in-memory flag in `symbolTool.js`. Independent of the
  toggle; cleared on window blur.
- **Flush candidate / guide** — transient, recomputed per pointer move; never persisted. Lives
  only for the duration of a placement/drag gesture. Cleared on gesture end.
- **`.snap-tag` label state** — transient DOM, driven per-move, hidden on gesture end.

Nothing new is added to the serialized plan, export JSON, or share hash.

## Edge Cases

1. **Grid toggle OFF, no wall near** → raw world point (`snapType:"free"`). Symbol lands exactly
   at pointer (minus drag offset).
2. **Alt held with toggle ON** → raw point regardless of toggle; no flush, no grid. Alt is the
   full transient bypass.
3. **Alt held with toggle OFF** → still raw (no-op difference); flush also suppressed. Consistent
   "Alt = raw."
4. **Wall-flush wins over grid** → when both a flush target and a grid line are in range, flush
   sets the perpendicular axis; the parallel axis is grid-snapped only if grid is enabled.
5. **Flush active while grid toggle is OFF** → flush still applies (it is not "grid"); parallel
   axis left raw. Hold Alt to defeat it.
6. **Two walls in range (inside corner)** → pick the smallest `|gap|`. Only one face is seated
   (translation-only); the perpendicular wall is handled on a later move as the user nudges. No
   attempt to solve a 2-constraint corner fit in this LLD.
7. **Symbol not parallel to wall (rotated)** → `PARALLEL_TOL_DEG` gate skips the segment; no
   flush. Prevents diagonal seating. Symbol still grid/free snaps.
8. **Symbol beside the wall's extension but past its end** → `t`-span overlap test fails; segment
   skipped. Avoids seating a couch flush to a wall it isn't actually alongside.
9. **No walls yet (empty plan / only chain of 1 pt)** → `wallSegments()` returns `[]`;
   `nearestWallFlush` returns null; behaves as pure grid/free.
10. **Very short wall segment (< MIN_SEG_M)** → skip (no direction), same guard style as
    `walls.rescaleEdge`.
11. **Zero-size or degenerate symbol box** → `corners` still returns 4 coincident-ish points;
    span tests degrade gracefully; flush simply won't trigger. No crash.
12. **`localStorage` unavailable / quota (private mode)** → `prefs` set is caught; in-memory
    value updates so the session works; button still reflects intent; nothing throws.
13. **Corrupt `floorplan:prefs:v1` value** → parse failure falls back to defaults
    (`gridSnap:true`); overwritten on next set.
14. **Zoom changes flush threshold feel** → threshold is `WALL_FLUSH_PX` converted via `pxPerM()`
    at resolve time, so it stays ~12px on screen; no dependency on `chooseGridStep`. No regression
    to zoom behavior.
15. **`.snap-tag` contention with wall tool** → symbol path writes the tag only in select mode
    during an active symbol gesture; wall tool writes only in draw mode. Guarded so they never
    both drive it.
16. **Duplicate offset (+0.3m) placing near a wall** → duplicate is a discrete create, not a
    drag; it does not run the flush resolver (matches current behavior). Out of scope to re-snap
    duplicates.

## Dependencies

- **Blocks on:** MVP-4 (#8) landing on `main` and the symbol code from PR #19
  (`symbolTool.js`, `symbols.js`, `symbolRender.js`) being merged. Per the issue note, do not
  start until then. (In this worktree the files already exist, confirming the merge assumption.)
- **Builds on (existing, do not modify semantics):**
  - `symbols.js` — `corners`, `Sym` type, `CATALOG`.
  - `walls.js` — `allVertices`, `model.rooms`/`model.chain`, `WALL_M`, `MIN_SEG_M`; add
    `wallSegments()` (new, additive).
  - `grid.js` — `snapStep()` (consumed as-is; **not** modified). `chooseGridStep`/zoom untouched
    (#22/#27).
  - `walls.gridSnap`, `view.pxPerM`/`screenToWorld`/`worldToScreen`.
  - `hud.js` init signature + `.hud` HUD container; `.snap-tag` element; `#symbol-overlay` group.
- **New files:** `src/js/prefs.js`.
- **No new third-party dependencies. No build step.** Pure client-side vanilla JS/CSS/HTML.

## Test Requirements

Tests live in the existing `src/tests.html` harness (same `describe`/`it` style already used for
walls/store/HUD).

### Unit — geometry (`symbols.nearestWallFlush` / `walls.wallSegments`)
- `wallSegments()` returns closing edge for closed rooms, none for open, includes chain pairs,
  `[]` when empty.
- Axis-aligned symbol just inside threshold of a horizontal wall face → candidate with `dy`
  seating the near edge coincident with the face; `dx == 0`.
- Same for vertical wall (`dx` nonzero, `dy == 0`).
- Symbol beyond threshold → null.
- Symbol rotated past `PARALLEL_TOL_DEG` → null.
- Symbol alongside wall's extension but past its end (no `t`-span overlap) → null.
- Two candidate faces (inside corner) → the smaller `|gap|` wins.
- Threshold respects `WALL_M/2` offset (seats against the face, not the centerline).

### Unit — prefs (`prefs.js`)
- Default `gridSnap()` is `true` with empty storage.
- `setGridSnap(false)` persists; a fresh read of storage reflects `false`.
- Corrupt stored JSON → falls back to default `true`.
- `setGridSnap` under a throwing `localStorage.setItem` stub → no throw, in-memory value updates
  (mirror the existing store quota test).
- `toggleGridSnap` flips and returns new value; `onPrefsChange` fires.

### Unit — resolver precedence (`_resolvePlacement`)
- Alt held → `snapType:"free"`, raw point (toggle ON and OFF).
- Toggle OFF, no wall → `"free"`, raw.
- Toggle ON, no wall, `snapStep()` non-null → `"grid"`, grid-snapped.
- Wall in range + grid line in range → `"flush"`; perpendicular axis flush; parallel axis
  grid-snapped when grid on, raw when off.
- `snapStep()` null (precision "Off") but toggle on → no grid; flush still applies if wall near,
  else raw.

### Integration (Playwright, `.github/run-tests.mjs`)
- Drag a symbol near a wall → its nearest edge visibly coincident with the wall face (assert on
  resulting `sym.x/sym.y` or rendered geometry), not merely on a grid line.
- Toggle button OFF → drop places symbol at raw pointer; reload page → button still OFF and
  behavior persists.
- Toggle ON → grid snapping resumes.
- Hold Alt during drag → raw placement regardless of toggle state.
- `.snap-tag` shows `flush`/`grid`/`free` with correct colors during a symbol gesture.

### Regression
- `chooseGridStep` / zoom / snap-precision chip behavior unchanged (existing LLD-22 tests still
  pass).
- Wall-drawing snapping (`resolveSnap`) unaffected.
- No new key added to plan JSON / export / share hash (serialize snapshot unchanged).

## Dependencies

## Test Requirements
