# LLD 24: Phase 1 — "does my couch fit?" clearance checking

## Scope

The differentiating feature: when a piece of furniture is **selected**, show live
clearance distances from its edges to the nearest walls and to nearby furniture, and
flag gaps that are too tight to walk through. This is a **readout layered on top of the
existing editor** — not a new tool/mode. Everything stays client-side.

**In scope**
- A pure geometry core (`clearance.js`) computing gaps from the selected symbol's
  axis-aligned-in-its-own-frame footprint to (a) the four sides of each closed room it
  sits in / the nearest wall segments, and (b) every other symbol.
- Per-neighbour gap classification against a configurable **min-clearance threshold**
  (default 60 cm / ~24 in walkway): `ok` (teal) / `tight` (amber) / `bad` (red).
- On-canvas annotations: distance leader + end ticks + midpoint chip per gap, plus a
  perpendicular "band" fill on flagged gaps (pulsing, motion-safe).
- A floating **fit-verdict pill** under the selected item (worst-status summary).
- A right-side **Clearance panel**: master status dot + verdict, live min-gap slider,
  tightest-first sorted gap list, density segmented control, and an on/off switch.
- **Default annotation density = Flagged only** (draw canvas annotations only for gaps
  at or under threshold); "All gaps" is one click away in the panel.

**Explicitly NOT in scope**
- No clearance evaluation while nothing is selected (the pill/leaders only appear for the
  selected symbol; the panel shows an empty prompt).
- No clearance for openings (doors/windows) as the *subject* of the check — see Edge
  Cases; the core job is furniture. Openings may still be listed as neighbours only if a
  later iteration wants it; v1 excludes them from both subject and neighbour sets.
- No rotated-footprint exact polygon clearance in v1 — clearance uses the symbol's
  **axis-aligned bounding box (AABB)** in world space (see Approach for rationale).
- No door-swing arc collision (flagging a gap that blocks a door from opening) — deferred;
  v1 threshold covers "walk through," not "swing a door."
- No persistence of clearance settings to the plan JSON or share hash (threshold/density/
  on-off are session UI state only). This is a deliberate choice: clearance is a transient
  inspection overlay, not part of the drawn plan, and keeping it out of the schema means
  share links / exports stay byte-identical to today (clearance adds zero fields).
- No new export rendering (PNG/SVG exports do not include clearance overlays in v1).
- No backend, no build step.

## Approach

**Module split, mirroring the existing walls/measure pattern.**

1. `src/js/clearance.js` — **pure geometry + state core** (no DOM, no events), the
   testable analogue of `walls.js`/`symbols.js`. Owns: the min-gap threshold, density,
   and on/off flags; the `computeClearances(sym)` function; and status classification.
2. `src/js/clearanceRender.js` — **SVG + HTML-overlay renderer**, registered as a
   `surface.onRender` hook (like `symbolRender.js`). Reads the selected id + the core,
   paints leaders/ticks/bands into a new `#clearance` SVG group and chips/pill into the
   existing `.dim-labels` overlay.
3. `src/js/clearancePanel.js` — **right-side panel controller** (analogue of
   `measure.js`): renders the sorted list, verdict, threshold slider, density control,
   on/off switch; writes back into `clearance.js` state and calls `scheduleRender()`.

**World units.** Existing model stores metres; `units.fmtLen` handles display. The
mockup used centimetres — we ignore that and work in metres, formatting the default
threshold as `0.60 m`. Threshold slider range: `0.30 m`–`1.20 m`, step `0.05 m`
(matches the mockup's 30–120cm/5cm, expressed in metres).

**Geometry model — AABB, not rotated polygon (decision).** `symbols.js` symbols carry
rotation, and `corners(sym)` yields the true rotated box. Two candidate approaches:

- *(A) Exact rotated polygon-to-polygon min distance.* Most accurate; requires
  segment/segment distance and orientation-aware leader placement. Heavier, and leaders
  drawn at arbitrary angles are visually noisy and hard to label.
- *(B) Axis-aligned bounding box (AABB) in world space.* Compute each symbol's world AABB
  from `corners()` (min/max of x and y), then do axis-separated gap math exactly as the
  approved mockup does. Leaders are always horizontal/vertical, chips are legible, and it
  matches the mockup 1:1.

**Recommendation: (B) AABB.** It matches the approved mockup, keeps leaders/labels
glanceable (the CLAUDE.md "glanceable, minimal chrome" bar), and is small surface area.
For unrotated furniture (the overwhelming common case) AABB is exact. For rotated pieces
it is a slight over-estimate of the footprint (gap is conservative/smaller), which is the
safe direction for a "does it fit?" check. Note this limitation in a code comment and the
panel is honest ("gaps use bounding boxes").

**Walls.** The mockup assumed a single rectangular room. Real plans have arbitrary
polygons (`walls.model.rooms`, each `{closed, verts[]}`). v1 wall clearance:
for each **closed** room whose interior contains the selected symbol's centre, compute
the gap from each of the symbol's four AABB sides to the nearest room edge **along the
axis** (left/right → horizontal ray from the mid-height of that side; top/bottom →
vertical ray from mid-width), by intersecting the axis ray with the room's polygon edges
and taking the nearest interior hit. Open polylines and rooms not containing the centre
are ignored in v1 (documented limitation — keeps it lightweight and avoids annotating
gaps to walls on the far side of the plan). If the symbol is inside no closed room, only
furniture-to-furniture gaps are shown (wall rows omitted; the panel still works).

**Wall thickness — measure to the inner wall FACE, not the centerline (decision).**
`room.verts` are the wall **centerlines**: `wallRender.js` draws each room as a stroke of
width `WALL_M` (0.12 m, from `walls.js`) *centered* on `verts`, so the true inner face of
the wall sits `WALL_M / 2 = 0.06 m` *inside* each `verts` edge (toward the room interior).
A naive ray-to-`verts`-edge gap therefore over-reports walkable clearance by ~0.06 m per
wall — the **unsafe** direction for a "does it fit?" check, and enough to flip a `tight`
gap to `ok` at the 0.60 m default (~10% error). This contradicts the AABB decision's
"err conservative/smaller" stance, so v1 **corrects for it**: after finding the nearest
axis-ray hit distance `d` to a `verts` edge, subtract the wall half-thickness to get the
gap to the inner face: `wallGap = d - WALL_M / 2` (clamped to `>= 0`). `clearance.js`
imports `WALL_M` from `walls.js` so the constant stays single-sourced. Rationale for
subtracting a flat `WALL_M / 2` rather than geometrically insetting each polygon edge:
for the axis-aligned rays used here the perpendicular offset of a wall face from its
centerline is `WALL_M / 2` regardless of edge orientation *for the axis-facing component*;
a flat subtraction is exact for walls perpendicular to the ray (the common rectangular
case) and remains conservative for oblique walls (it never over-reports). Full per-edge
polygon inset is deferred as unnecessary complexity for v1's axis-aligned readout.

**Wiring.** `clearanceRender.render` is registered via `onRender` **after**
`symbolRenderFn` so leaders sit above symbol bodies but the selection overlay/handles
(drawn into `#symbol-overlay`, which is later in the SVG) stay on top. The panel updater
is registered like `measureUpdate`. `main.js` gains DOM refs for the new `#clearance`
group and the panel, and getter injection for the selected id (reuse
`symbolTool.getSelectedId`) and the selected `Sym` (reuse `symbols.getSymbol`).

**No new mode.** No tool-rail button, no keyboard shortcut, no pointer handling. The
feature reacts entirely to existing selection state and the panel controls. This honours
the "readout on top of the editor" constraint.

## Interfaces / Types

```js
/** @typedef {"ok"|"tight"|"bad"} ClrStatus */
/** @typedef {"all"|"flagged"} ClrDensity */

/**
 * One computed gap from the selected symbol to a neighbour (wall or symbol).
 * a/b are the world-metre endpoints of the leader line; gap is metres (0 = overlap).
 * @typedef {{
 *   label: string,       // "left wall" | "Sofa" | "Table"…
 *   kind:  "wall"|"symbol",
 *   gap:   number,       // metres; 0 when overlapping
 *   status: ClrStatus,
 *   a:     { x:number, y:number },   // leader endpoint on the selected symbol's edge
 *   b:     { x:number, y:number },   // leader endpoint on the neighbour (wall face / edge)
 *   neighbourId?: string // symbol id when kind==="symbol" (for future hover-link)
 * }} Clearance
 */
```

### `clearance.js` (pure core)

```js
// ── State (session-only UI prefs; NOT persisted) ──
export let threshold; // metres, default 0.60
export let density;   // ClrDensity, default "flagged"
export let enabled;   // boolean, default true

export const THRESH_MIN = 0.30;  // slider bounds, metres
export const THRESH_MAX = 1.20;
export const THRESH_STEP = 0.05;
export const DEFAULT_THRESHOLD = 0.60;

export function setThreshold(m);          // clamps to [MIN,MAX]; fires onChange
export function setDensity(d);            // "all"|"flagged"; fires onChange
export function setEnabled(on);           // fires onChange
export function onChange(cb);             // subscribe (panel + render re-run)

/** Classify a gap (metres) against the current threshold. */
export function classify(gap); // gap<=0 → "bad"; gap<threshold → "tight"; else "ok"

/** World-space AABB of a symbol: {l,r,t,b} in metres. From corners(sym). */
export function aabb(sym);

/** True if world point (x,y) is inside a closed room polygon (even-odd). */
export function pointInRoom(room, x, y);

/**
 * Compute all clearances FROM the selected symbol.
 * - Walls: for each closed room containing sym's centre, gap from each AABB side
 *   to nearest room edge along that axis, minus WALL_M/2 so the gap is to the
 *   inner wall FACE (verts are centerlines), clamped >= 0.
 * - Symbols: AABB axis-separated gap to every other symbol (skip openings).
 * Returns [] when sym is null/opening or enabled===false.
 * @param {Sym|null} sym
 * @param {{rooms:Room[], symbols:Sym[]}} world
 * @returns {Clearance[]}
 */
export function computeClearances(sym, world);

/** Worst status across a list ("bad">"tight">"ok"); "ok" for empty. */
export function worstStatus(list);
```

### `clearanceRender.js`

```js
/**
 * @param {SVGGElement} gClearance       // new #clearance group
 * @param {HTMLElement} overlayEl        // reuse .dim-labels (chips + pill)
 * @param {()=>string|null} getSelectedId
 * @param {(id:string)=>Sym|null} getSymbol
 */
export function init(gClearance, overlayEl, getSelectedId, getSymbol);

/** onRender hook: clears #clearance, redraws leaders/ticks/bands + chips + pill. */
export function render();
```

### `clearancePanel.js`

```js
/**
 * @param {{ panel:Element, body:Element, toggle:Element,
 *           getSelectedId:()=>string|null, getSymbol:(id)=>Sym|null }} refs
 */
export function init(refs);

/** onRender hook: rebuilds panel (verdict, slider, density, sorted rows). */
export function update();
```

### Changes to existing code

- **`src/index.html`**: add `<g id="clearance"></g>` inside `#drawing` between
  `#symbols` and `#symbol-overlay` (leaders above bodies, below selection handles); add
  the `.clearance` `<aside>` panel markup and the clearance CSS tokens/classes (ported
  from the mockup); add `.clr-*` styles.
- **`src/js/main.js`**: grab new refs, `initClearanceRender(...)`,
  `initClearancePanel(...)`, register both as `onRender` hooks in the documented order,
  and subscribe `clearance.onChange(scheduleRender)`.
- No changes to `symbols.js`, `walls.js`, `symbolTool.js` logic — only their **exported
  getters are reused** (`getSelectedId`, `getSymbol`, `walls.model`, `symbols.model`,
  `corners`, `CATALOG`).

## State Model

**Persisted (localStorage / share hash): nothing new.** Clearance adds no fields to the
plan JSON. This preserves the existing `plan.js` serialization contract and keeps share
links byte-identical to today. (Note: unlike `units.unit` — which `plan.js` *does*
serialize and restore — clearance settings are deliberately transient inspection state
and stay session-only.)

**Session UI state (in `clearance.js` module scope, resets on reload):**
- `threshold` — metres, default `0.60`. Written by the panel slider.
- `density` — `"flagged"` (default) | `"all"`. Written by the panel segmented control.
- `enabled` — `true` (default). Written by the panel on/off switch.

These three fire `onChange` listeners; `main.js` subscribes `scheduleRender` so any
change re-runs the render hooks (which recompute from live `symbols.model` /
`walls.model`) and rebuilds the panel.

**Derived / in-memory per frame (never stored):** the `Clearance[]` list is recomputed
from scratch each render inside `clearanceRender.render` and `clearancePanel.update`
from the current selected `Sym` + `walls.model.rooms` + `symbols.model.symbols`. There
is no caching; the sets are tiny (single-digit to low-dozens of symbols), and this keeps
the code stateless and correct under undo/redo, move, resize, rotate, and delete without
any invalidation logic. Both hooks compute the same list; if profiling ever shows this
matters, memoize on a frame token — not needed for v1.

**Selection is the single source of truth.** Clearance renders iff
`getSelectedId()` resolves to a non-opening `Sym` and `enabled === true`. Deselect (tap
empty, switch to draw mode, delete) → empty list → no leaders, no pill, panel shows the
"select a piece" prompt. No separate clearance-active flag is needed.

## Frontend Design

Ports the approved mockup (`design-mockups/does-my-couch-fit-clearance-checking.html`,
branch `lld-23-…`) into the live editor's idiom. Reuses the existing gold/teal/red
palette and the Measure inspector's placement and visual language so it reads as native.

### CEO frontend decisions (must follow)

1. **Default annotation density = `Flagged only`.** On-canvas leaders/ticks/bands/chips
   are drawn **only for gaps with status `tight` or `bad`** (i.e. at or under threshold).
   The default view surfaces problems, not every measurement — keeping the canvas clean
   per CLAUDE.md "minimal chrome / glanceable." `All gaps` is a one-click segmented-control
   toggle in the panel that annotates every neighbour (including `ok`/teal). The **panel
   list always shows every neighbour** regardless of density — density only governs
   canvas annotation volume.
2. **Keep BOTH verdict surfaces.** (a) The floating **fit pill** under the selected item is
   the glanceable on-canvas answer ("It fits — room to spare" / "Tight — under 0.60 m
   walkway" / "Won't fit — overlap"), colored by worst status. (b) The **panel master
   verdict** (status dot in header + verdict banner) anchors the detailed sorted list.
   Cheap redundancy serving glance-vs-inspect reading modes.
3. **Keep the right-side Clearance panel.** It houses the tightest-first sorted gap list
   and the live min-gap threshold slider — both awkward on-canvas. Placed top-right using
   the Measure inspector idiom; see layout note below.

### Palette / tokens (add to `:root` in `index.html`)

```
--clr-ok:     #7fd0c8;  /* snap-teal — comfortable    */
--clr-tight:  #e0b64f;  /* amber — below threshold     */
--clr-bad:    #e57373;  /* error red — overlap/no walk */
--clr-ok-fill:    rgba(127,208,200,0.14);
--clr-tight-fill: rgba(224,182,79,0.16);
--clr-bad-fill:   rgba(229,115,115,0.18);
```
(These match the existing `--snap-grid`/`--snap-point`/`--error` values, so status colors
are consistent with the rest of the app.) Status mapping: teal = comfortable, amber =
below threshold, red = overlap or no walkway.

### On-canvas elements (from `clearanceRender.js`)

- **Leader line** edge→neighbour + small end ticks, colored by status (`.clr-leader`,
  `.clr-tick`).
- **Band** (perpendicular ribbon fill) drawn only for `tight`/`bad` gaps (`.clr-band`),
  with a **pulsing** opacity animation `clr-pulse 1.6s`. **MUST** be wrapped in
  `@media (prefers-reduced-motion: reduce){ .clr-band{ animation:none !important } }`
  (the app already sets this precedent for `.snap-pulse`).
- **Distance chip** at leader midpoint (`.clr-chip`, HTML in `.dim-labels`), status icon
  + formatted gap via `units.fmtLen` + `unitLabel()` (e.g. `2.0 ft`, `0.61 m`); shows
  `overlap` when gap ≤ 0.
- **Fit pill** (`.fit-pill`, HTML in `.dim-labels`) positioned just below the selected
  symbol's AABB bottom-center in screen space.

Chips and the pill live in the existing `.dim-labels` HTML overlay (same pattern as
symbol dim chips), so they are crisp text, not SVG. `clearanceRender` must **only append**
its own nodes (class-tagged `clr-chip`/`fit-pill`) and clear only those it created — it
must not clear wall/symbol dim chips. Implementation: clear by removing
`.dim-labels > .clr-chip, .fit-pill` at the top of its render.

### Panel (from `clearancePanel.js`)

Right-side `<aside class="clearance">`, positioned **below the Measure inspector** (which
sits below the unit toggle). Reuses `.measure`-style panel chrome (panel bg, hairline,
blur, mono font, collapse toggle). Contents top→bottom: header (title + status dot +
on/off switch), threshold slider row (label + `<input type=range>` + live value), density
segmented control (`All gaps` / `Flagged only`, `aria-pressed`), sorted rows
(`min…max` by gap, dot + `to <label>` + value; `overlap` in red), verdict banner. When
`enabled===false`: rows replaced with "Clearance overlay is off" and slider/density
disabled. When nothing selected: "Select a piece of furniture to see its clearances."

**Layout note (stacking with Measure).** The Measure inspector currently sits at
`top: calc(1.25rem + 2.2rem + 0.5rem)` right-aligned with a variable height (room list).
Two options: *(A)* stack the Clearance panel statically beneath it with a fixed top
offset — risks overlap when the room list is long; *(B)* make the right rail a flex
column container holding both panels so they stack naturally. **Recommend (B)**: wrap
Measure + Clearance in a right-docked flex column (`gap`), avoiding brittle magic offsets;
falls back gracefully on mobile where both default to collapsed. Keep both panels
collapsible (Clearance defaults collapsed on `max-width: 640px`, matching Measure).

### Accessibility / responsiveness

- Panel controls are real `<input type=range>` / `<button aria-pressed>` / checkbox
  switch — keyboard-operable, labeled.
- Verdict banner and status changes: give the panel verdict `aria-live="polite"` so the
  fit outcome is announced when it changes (e.g. crossing into `tight`).
- Reduced motion honored on the band pulse (see above).
- Mobile: panel collapses by default; canvas chips already scale down via existing
  `.dim-chip` media query — add matching `.clr-chip` rule.

## Edge Cases

1. **Nothing selected.** No leaders, no pill; panel shows "Select a piece of furniture to
   see its clearances." (`computeClearances(null,…)` → `[]`.)
2. **Selected item is an opening (door/window).** Openings are excluded as the subject —
   `computeClearances` returns `[]` for `CATALOG[type].openings`. Rationale: door/window
   clearance ("can it open?") is out of scope; treat as "nothing to check."
3. **Overlapping symbols.** AABB separation yields `dx<=0 && dy<=0` → `gap = 0` → status
   `bad`; chip/row show `overlap`; leader drawn center→center; pill = "Won't fit — overlap."
4. **Symbol not inside any closed room.** Wall rows omitted (no containing polygon);
   furniture-to-furniture gaps still computed. Panel/pill reflect only symbol gaps; if no
   other symbols either, list is empty and verdict is neutral/`ok` ("nothing nearby").
5. **Only one symbol on the canvas, inside a room.** Wall gaps shown; no symbol gaps.
6. **Only one symbol, no room.** Empty list → panel prompt "Nothing nearby to measure."
   (Distinct copy from the no-selection prompt.) Pill suppressed when list empty.
7. **Non-convex / L-shaped room polygon.** Axis-ray-to-nearest-edge handles concavity by
   taking the nearest edge intersection along the ray; document that a side facing a
   re-entrant corner measures to the nearest wall the ray actually hits (may skip a closer
   wall not on that axis — acceptable for v1's axis-aligned readout).
8. **Symbol straddling a wall (partly outside the room).** A side's outward ray may exit
   the polygon immediately → gap ≤ 0 for that side → `bad`. This correctly flags "sticking
   through the wall."
9. **Rotated furniture.** AABB over-estimates footprint → conservative (smaller) gaps.
   Documented; safe for a fit check. Leaders remain axis-aligned.
10. **Threshold moved live.** Slider `input` re-runs `setThreshold`→`onChange`→
    `scheduleRender`; statuses/flags/pill/rows re-evaluate on the next frame with no
    recompute of geometry needed beyond reclassification.
11. **Density = Flagged only, everything comfortable.** No canvas annotations at all
    (clean canvas), pill still shows "It fits," panel still lists all gaps as `ok`. This
    is the intended default resting state.
12. **`enabled === false`.** No SVG/overlay clearance nodes; pill suppressed; panel shows
    "Clearance overlay is off," slider + density disabled. Selection still works normally.
13. **Very small gap vs. formatting rounding.** `fmtLen` rounds (1dp ft / 2dp m). A gap of
    0 is shown as literal `overlap`, never `0.0`. Positive sub-display-precision gaps
    (e.g. 0.004 m) still classify by the true metre value, not the rounded string.
14. **Undo/redo / move / resize / rotate / delete of the selected or a neighbour.** Each
    triggers `scheduleRender` through existing paths; stateless recompute keeps the
    readout correct. If the selected symbol is deleted, selection clears → case 1.
15. **Zoom / pan.** Leaders/bands are drawn in screen space each frame via
    `worldToScreen`; chips/pill repositioned each frame (same as dim chips). No stale
    geometry.
16. **Degenerate / zero-size neighbour or self.** Guard against division by zero in AABB
    (a symbol always has w,h ≥ catalog min > 0, so safe); still clamp gaps to `>= 0`.
17. **Reduced motion.** Band pulse disabled via media query; static fill retained so the
    flag is still visible without animation.

## Dependencies

**Must exist before implementation (all shipped in MVP):**
- `symbols.js` — `model.symbols`, `getSymbol(id)`, `corners(sym)`, `CATALOG` (for the
  `openings` flag). *(present)*
- `symbolTool.js` — `getSelectedId()` selection state. *(present)*
- `walls.js` — `model.rooms` (closed polygons with `verts`), `WALL_M` (wall thickness
  constant, 0.12 m, needed to convert centerline-edge gaps to inner-face gaps). *(present)*
- `units.js` — `fmtLen`, `unitLabel`, `onChange` (re-render on unit switch). *(present)*
- `surface.js` — `onRender(cb)` hook registration + `scheduleRender`. *(present)*
- `view.js` — `worldToScreen`, `pxPerM` for screen-space drawing. *(present)*

**No dependency on** persistence (`plan.js`/`store.js`/`share.js`), history, or export
modules — clearance is UI-only and adds nothing to their contracts.

**New files:** `src/js/clearance.js`, `src/js/clearanceRender.js`,
`src/js/clearancePanel.js`. **Edited:** `src/index.html` (SVG group, panel markup, CSS),
`src/js/main.js` (wiring). No new external libraries; no build step.

## Test Requirements

Match the existing pure-core test style (`walls.js`/`symbols.js` have DOM-free unit
tests). `clearance.js` is the primary unit-test target; render/panel get lighter
integration coverage.

### Unit — `clearance.js` (pure, no DOM)
- `aabb(sym)`: unrotated box → exact `{l,r,t,b}`; rotated 45° → enclosing AABB larger than
  the footprint (conservative).
- `classify(gap)`: `gap<=0`→`bad`; `0<gap<threshold`→`tight`; `gap>=threshold`→`ok`;
  boundary at exactly `threshold` → `ok`.
- `pointInRoom`: point inside a rectangle; outside; inside an L-shaped (non-convex)
  polygon; on/near an edge.
- `computeClearances`:
  - Returns `[]` for `null`, for an opening subject, and when `enabled===false`.
  - Two axis-aligned furniture pieces with a known horizontal gap → correct `gap`,
    `status`, and leader endpoints at the facing edges' mid-span.
  - Overlapping pieces → `gap===0`, `status==="bad"`, center-to-center leader.
  - Vertical gap vs horizontal gap selection (`dy>dx`) picks the correct axis.
  - Symbol inside a rectangular room → four wall gaps with correct distances; symbol
    inside no room → zero wall rows.
  - Wall gap is measured to the inner wall **face**, not the centerline: for a symbol a
    known distance `d` from a `verts` edge, the returned wall gap equals `d - WALL_M/2`
    (not `d`); a symbol whose face is within `WALL_M/2` of the centerline clamps to `0`.
  - Symbol partly outside room (straddling a wall) → that side's gap ≤ 0 / `bad`.
- `worstStatus`: `[ok,ok]`→`ok`; `[ok,tight]`→`tight`; `[tight,bad]`→`bad`; `[]`→`ok`.
- Threshold clamping in `setThreshold` to `[0.30,1.20]`; `onChange` fires for each setter.

### Integration — render + panel (jsdom / DOM harness like measure tests)
- Selecting a furniture symbol appends leaders to `#clearance` and a `.fit-pill` to
  `.dim-labels`; deselecting removes them and leaves wall/symbol dim chips intact.
- Density `flagged` (default): only `tight`/`bad` gaps produce canvas annotations; `all`
  produces one per neighbour. Panel list length is unchanged by density.
- Threshold slider input updates statuses live (a gap flips `ok`→`tight` when threshold
  crosses it) and re-renders without recomputing selection.
- On/off switch clears canvas annotations and pill; panel shows the off state; slider and
  density disabled.
- Panel rows sorted tightest-first; `overlap` rendered for gap 0.
- Unit toggle (`ft`↔`m`) reformats chips, pill text, slider value, and rows.
- Empty states: no selection prompt vs. "nothing nearby" prompt.

### Regression / non-goals
- Plan JSON serialization and share-hash output are **byte-identical** before/after this
  feature (no persisted clearance state). Add an assertion in the persistence test suite.
- `.dim-labels` still contains correct wall + symbol dim chips when clearance is active
  (no cross-clearing).

### Visual / motion (manual or snapshot)
- `prefers-reduced-motion: reduce` disables the band pulse (assert no `animation` /
  static fill). Palette classes resolve to the teal/amber/red tokens.
