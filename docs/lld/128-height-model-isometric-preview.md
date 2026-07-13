# LLD 128: Height model + whole-plan 2.5D isometric SVG preview (view-only)

Parent: #101 · Order 1 of 4 · Effort: medium

## Scope

The first shippable cut of the 3D-preview feature (#101): a **whole-plan, read-only 2.5D
preview** that extrudes wall centerlines and furniture footprints to height and renders
them as an isometric/axonometric SVG. This bundles the **height data model** with the
**renderer that consumes it** — per CLAUDE.md ("nothing speculative"), height fields do
not land as a standalone increment because no code would read them yet.

**In scope**

- **Height model (data):**
  - Per-type default height `z` added to every `CATALOG` entry in `symbols.js` (metres).
  - A single module-level ceiling-height default (`CEILING_M ≈ 2.4`) used for wall
    extrusion. No per-room override this cut.
- **Renderer (`isoRender.js`, new):** a pure projection core + an SVG painter that draws
  extruded **colored boxes only** — walls extruded to ceiling height, furniture extruded
  to its catalog height — plus a faint floor slab per closed room. Reuses the existing
  vanilla SVG stack and follows `wallRender.js` / `symbolRender.js` conventions.
- **Preview toggle:** a whole-plan preview **view mode** wired into the tool rail,
  mirroring the measure/clearance toggle wiring in `main.js` (aria-pressed, `P` shortcut,
  `Esc` to exit).
- **Back-compat:** the new `z` fields round-trip through localStorage, the share hash, and
  JSON export, following the optional-additive pattern from LLD 81 — old plans (no `z`)
  load cleanly on catalog defaults.

**Explicitly OUT of scope (guards)**

- NO textures, materials, lighting, shadows, gradients-as-lighting, 3D furniture models,
  or first-person/orbit camera. Flat 3-shade faces only.
- NO editing in 3D — preview is strictly read-only; the 2D editor stays the single source
  of truth.
- NO per-room ceiling override (whole-plan single ceiling only — follow-up sub-issue).
- NO camera rotation UI (single fixed axonometric angle only — follow-up sub-issue).
- NO three.js / WebGL / any new runtime dependency and NO build step (keeps this unblocked
  by #102).
- The preview does NOT appear in PNG/SVG export or the share link yet (follow-up
  sub-issues). It is view-only, in-app.

## Approach

### 1. Height data on the catalog (not on the instance)

Height is a **type property**, not a per-instance edited dimension in this cut. We add a
single `z` field (metres, the extrusion height) to every `CATALOG` entry in `symbols.js`,
alongside the existing `w`/`h` footprint. We deliberately do **not** add a `z` to the
`Sym` instance shape yet — there is no UI to edit per-instance height, so an instance
field would be dead data (same reasoning the issue applies to standalone height data). The
renderer reads `CATALOG[sym.type].z`.

Rationale for keeping ceiling height as a module constant rather than a `Room` field: the
`Room` shape is `{id,closed,verts,color?}` with no height; adding a per-room field with no
editing UI and no renderer branch that varies by room would be speculative. A single
`CEILING_M` constant in the new render module satisfies "consumed by the renderer" while
staying minimal. Per-room override is called out as a follow-up.

Default heights (metres) are grounded in the same catalog-realism spirit as the existing
per-axis bounds/presets (PR #98). Representative values:

| type | z | type | z | type | z |
|---|---|---|---|---|---|
| door | 2.03 | window | 1.20 | bed | 0.55 |
| sofa | 0.85 | armchair | 0.90 | table | 0.75 |
| coffee-table | 0.45 | dining-table-round | 0.75 | chair | 0.90 |
| desk | 0.75 | tv | 0.70 | bookshelf | 1.80 |
| fridge | 1.70 | stove | 0.90 | sink | 0.90 |
| washer | 0.85 | wardrobe | 2.00 | nightstand | 0.50 |
| dresser | 0.80 | cabinet | 0.90 | toilet | 0.75 |
| bathtub | 0.55 | monitor | 0.45 | gaming-chair | 1.20 |
| patio-table | 0.75 | patio-chair | 0.90 | parasol | 2.40 |
| planter | 0.50 | rug | 0.01 | | |

`rug` (floorLayer) is given a near-zero `z` so it renders as a flat floor decal, never a
box (see Edge Cases). Openings (`door`, `window`) get a realistic leaf height but are
extruded as boxes flush in the wall plane like any other footprint this cut (no cut-out
geometry — a documented simplification).

### 2. Projection: single fixed axonometric angle

Use a **fixed axonometric projection** (no rotation UI). We project world metres → screen
using a 2:1 dimetric-style transform, standard for "video-game isometric" reads:

```
isoX = (wx - wy) * cos(θ)
isoY = (wx + wy) * sin(θ) - wz * kZ
```

with θ = 30° and `kZ` a vertical scale for height. The world→screen pipeline still runs
through `view.js` for pan/zoom of the whole scene (the preview honours the current
zoom/pan so the plan stays framed), but the axonometric fold is applied in a pure helper
inside `isoRender.js` operating on `(wx, wy, wz)` in metres, producing screen offsets that
are then scaled by `pxPerM()` and translated by the view pan. Height `wz` is up (screen
−y).

We do NOT reuse `worldToScreen` directly for the fold because that function is a pure
2D affine with no z term; instead `isoRender` computes iso screen coordinates from world
metres using `pxPerM()` and `view.panX/panY` (read via a small projection helper) so the
scene pans/zooms consistently with the 2D editor's framing.

### 3. Extruded box geometry — 3 faces, painter's sort

Each extruded item (wall quad segment or furniture footprint) is a **prism**: a bottom
polygon at z=0 and a top polygon at z=height, connected by vertical side faces. For the
blocky read we draw only the visible faces given the fixed camera:

- **Top face** — the footprint polygon lifted to z=height (lightest shade).
- **Two side faces** — the two silhouette-facing vertical walls of the box, one per the
  camera-facing pair of edges (mid and dark shades).

Because the camera is fixed, exactly which two of the four vertical faces are "front-left"
and "front-right" is constant, so we pick them deterministically (the two edges whose
outward normal faces the camera). Each face is a 4-point SVG `<polygon>`. Three flat
shades per box are derived from the item's base fill color:

- top = base color at full/High lightness,
- left side = base color scaled to ~0.72 lightness,
- right side = base color scaled to ~0.58 lightness.

This gives the 3-shade blocky look with NO lighting/gradients — just three precomputed
solid fills.

### 4. Painter's algorithm (back-to-front)

There is no z-buffer in SVG, so correctness comes from **draw order**. We sort all
extruded items back-to-front by their footprint's depth key (for this camera,
`sortKey = (wx + wy)` of the footprint centroid; larger = nearer = drawn later). Walls and
furniture are merged into one list and sorted together so furniture in front of a wall
correctly occludes it. The faint floor slab for each room is drawn first (furthest back),
before any boxes. Within a single box, faces are emitted bottom→sides→top so the top always
paints last.

### 5. Renderer structure — pure core + SVG painter

`isoRender.js` splits into:

- **Pure functions** (no DOM): `projectIso(wx, wy, wz)`, `extrudeFootprint(corners, z0,
  z1)` → prism faces, `boxFaces(sym)` / `wallBoxFaces(segment)` → the visible face polygons
  in world/iso space, `depthSort(items)`. These are unit-testable without a DOM.
- **`render()`** (DOM): clears the `#iso` SVG group, and when preview is active, builds the
  floor slabs + sorted boxes as SVG polygons and appends them. Registered as a
  surface `onRender` hook, and short-circuits (draws nothing) when preview is off.

### 6. Preview is a view mode, layered over a hidden 2D scene

When preview is ON:

- The normal 2D SVG groups (`#world`, `#draft`, `#snap`, `#rugs`, `#symbols`, `#clearance`,
  `#measure`, `#symbol-overlay`) and the HTML chip overlays are **hidden** (a CSS class on
  the stage, e.g. `.stage--preview`), and the `#iso` group is shown.
- No model mutation occurs — preview only reads `walls.model` + `symbols.model`.
- Interactions (draw/select/measure) are suppressed while preview is on (guarded in
  `main.js`; the simplest form is that the tool pointer handlers early-return when
  `preview.isActive()`), so the read-only guarantee holds even if a pointer lands on the
  stage.

When preview is OFF everything reverts by removing the class — the 2D DOM was never
touched, so there is zero state loss.

## Frontend Design

Frontend decisions are **DONE** (CEO call, from issue comments) — do not re-park on
`blocked:frontend-decision`. The three settled calls:

1. **Toggle placement — tool rail.** The preview is a *view mode*, and every other mode
   switch (Select, Wall, Measure) lives in the rail; the top-right actions cluster is
   reserved for output artifacts (Share/Export). Add a **new preview button in its own
   group after a hairline `.tool-rail-sep`** (the same separator pattern already used
   between draw tools and the history cluster in `index.html`). Active state: solid-gold
   fill with an accent ring, driven by `aria-pressed="true"` (reuse the existing
   `.tool-rail button[aria-pressed="true"]` style; add the ring as a small extra rule if
   the current style lacks it). Button carries `aria-label="3D preview (P)"` and a
   `.tool-key-hint` "P" span like its siblings.

2. **Camera angle — single fixed axonometric angle.** No NE/NW/SE rotation buttons this
   cut. One deterministic dimetric angle (θ = 30°). Rotation is a follow-up once the
   preview earns its keep.

3. **Floor slab — keep the faint floor polygon.** Render each closed room's footprint as a
   subtle ground plane (low-alpha theme neutral, e.g. `roomFill`-like) projected at z=0,
   drawn behind all boxes. Keep it subtle so walls/furniture stay the focus. This makes
   rooms read as rooms rather than floating walls and reinforces the isometric read — it
   directly serves the CX goal ("peek into the space" that's screenshot/share-worthy).

Interaction contract mirrors the measure/clearance toggles:

- Click the preview button → toggles preview on/off, updates `aria-pressed`, calls
  `scheduleRender()`.
- `P` keyboard shortcut toggles preview (added to the existing `keydown` handler block in
  `main.js` alongside `W`/`V`/`M`; guarded by the same "not typing in an input" checks the
  other single-key shortcuts use).
- `Esc` while preview is active exits back to 2D (added to the existing non-meta `Escape`
  branch in `main.js`).
- Entering preview does not change the active drawing tool; on exit the previous tool and
  all 2D state are exactly as they were.

No new panel/inspector is introduced. The preview has no controls of its own this cut
(single angle, single ceiling) — it is purely the rail toggle plus the rendered `#iso`
layer.

## Interfaces / Types

### `symbols.js` — catalog height field

Every `CATALOG[type]` entry gains a required `z:number` (metres). The catalog typedef is
extended:

```js
/** @type {Record<SymbolType, { label, category, ...existing..., z:number }>} */
```

No change to the `Sym` instance typedef, `createSymbol`, `resizeSymbol`, or any existing
geometry function. `corners(sym)` continues to return the 2D footprint; the renderer lifts
it to 3D itself.

### `preview.js` (new) — view-mode state (session-only, like `clearance.js`)

```js
/** @returns {boolean} */            export function isActive();
/** @param {boolean} on */           export function setActive(on);   // fires onChange
export function toggle();            // convenience; fires onChange
/** @param {()=>void} cb */          export function onChange(cb);
```

State is a single module-level `let _active = false`. NOT persisted (preview is transient
inspection state, exactly like clearance `enabled`/`threshold`).

### `isoRender.js` (new) — projection core + SVG painter

```js
// Fixed camera constants
export const ISO_THETA = Math.PI / 6;   // 30°
export const ISO_KZ    = <vertical scale for height>;
export const CEILING_M = 2.4;           // whole-plan ceiling height (metres)

/**
 * Pure axonometric fold: world metres (wx, wy up-is-+y screen-plane, wz up) →
 * screen-pixel offset relative to the projected world origin, honouring pxPerM().
 * @returns {{ x:number, y:number }}
 */
export function projectIso(wx, wy, wz);

/**
 * The visible faces of a box given its 2D footprint corners (world) and z-range.
 * Returns an ordered list of faces (bottom/sides/top order), each a list of
 * projected screen points and a shade role.
 * @param {{x,y}[]} footprint  world-metre polygon (e.g. corners(sym) or a wall quad)
 * @param {number} z0  base height (metres, usually 0)
 * @param {number} z1  top height (metres)
 * @returns {{ role:"top"|"left"|"right"|"bottom", pts:{x,y}[] }[]}
 */
export function extrudeFootprint(footprint, z0, z1);

/**
 * Build the extrudable item list from the live models: one item per closed-room
 * wall quad segment (z0=0, z1=CEILING_M) and one per non-floorLayer symbol
 * (z0=0, z1=CATALOG[type].z). floorLayer symbols (rugs) become flat floor decals,
 * not boxes. Returns items with a precomputed depth sort key.
 * @returns {{ footprint:{x,y}[], z0:number, z1:number, baseColor:string, sortKey:number }[]}
 */
export function buildItems(wallsModel, symbolsModel);

/** Stable back-to-front sort (ascending sortKey). Pure; returns a new array. */
export function depthSort(items);

/** Bind SVG group refs + getters. Called once from main.js. */
export function init(gIso, getActive);

/** surface.onRender hook. No-op (clears #iso) when getActive() is false. */
export function render();
```

Shade derivation is a pure helper `shade(baseColor, factor)` (multiply RGB channels by
`factor`, clamp) so the three face fills are deterministic and testable.

### `index.html`

- New SVG group `<g id="iso"></g>` inside `#drawing`, appended LAST (topmost) so the whole
  preview overlays the hidden 2D layers.
- New `.tool-rail-sep` + `<button id="tool-preview" aria-label="3D preview (P)"
  aria-pressed="false">` with an icon and `<span class="tool-key-hint">P</span>`.
- CSS: a `.stage--preview` class on `#stage` that hides the 2D layers/overlays and shows
  `#iso`; the accent-ring active style for `#tool-preview[aria-pressed="true"]`.

### `main.js` wiring (mirrors clearance/measure)

- Import `preview` + `isoRender`; `initIsoRender(gIso, preview.isActive)`.
- `onRender(isoRenderFn)` registered after the 2D render hooks.
- Preview button click handler: `preview.toggle()`, sync `aria-pressed`, toggle
  `.stage--preview`, `scheduleRender()`.
- `preview.onChange(scheduleRender)` and a listener that syncs the stage class + button
  state.
- `P` shortcut and `Esc`-exit added to the existing keydown handlers.
- Tool pointer handlers guarded to early-return while `preview.isActive()`.

## State Model

### Persisted plan state — back-compat (critical)

Height lives on the **catalog** (`CATALOG[type].z`), which is code, not plan data. This is
the key back-compat win: because height is a type constant and **not** a per-instance
field, the serialized plan shape (`walls`, `symbols[].{id,type,x,y,w,h,rot,color?}`,
`measurements`, `view`, `unit`) is **unchanged**. Old plans deserialize byte-for-byte as
before, and the renderer looks up height by type at draw time.

Consequences for the three transports:

- **localStorage / JSON export (`buildPlan`/`validatePlan`):** no schema change; no bump to
  `PLAN_SCHEMA`. `validatePlan` needs no new normalisation because there is no new plan
  field. Old and new plans validate identically.
- **Share hash (`buildCompact`/`parseCompact`):** unchanged. No `z` is written or read.
  The existing "omit `w`/`h` when equal to catalog default" logic is untouched.
- **Ceiling height:** a module constant (`CEILING_M`), not plan data — never serialized.

This means the optional-additive LLD 81 pattern is satisfied trivially in the strongest
form: the only "new field" (`z`) is additive on the **catalog definition**, so absent
data in old plans already resolves to the catalog default by construction. If a future
sub-issue introduces a per-instance or per-room height override, THAT increment must add
`validatePlan` normalisation (absent → catalog default) and `buildCompact`/`parseCompact`
omit-when-default handling — this cut deliberately does not, because it has no override.

> Design note: keeping `z` off the instance is the deliberate, minimal choice that makes
> back-compat a non-event. It is called out explicitly so the reviewer can confirm no
> serialization path changed.

### Session-only view state

`preview._active` (in `preview.js`) is transient UI state, never persisted — identical
treatment to `clearance.enabled`. Reloading the page starts in 2D. The `.stage--preview`
class is derived from `_active` and reset on load.

### In-memory vs computed

- **Persisted / in-memory model:** `walls.model`, `symbols.model` — the single source of
  truth, never mutated by the preview.
- **Computed per render:** the extruded item list, projected face polygons, depth sort,
  and shade fills are all recomputed each `isoRender.render()` from the live models. No
  cached 3D state; the preview is a pure function of the current plan + camera constants +
  view zoom/pan.

## Edge Cases

1. **Old plan with no height data.** By construction there is no per-instance `z`, so every
   symbol resolves height via `CATALOG[type].z`. No migration, no normalisation needed.
   Verified by a round-trip test.
2. **Empty plan (no rooms, no symbols).** Preview renders nothing (empty `#iso` group);
   toggling on/off is a no-op visually. No crash.
3. **Open rooms (unclosed chains / open polylines).** No enclosed footprint → no floor slab
   and no wall boxes for that room this cut (walls are extruded from closed-room wall quad
   segments). Document as a known limitation; open walls simply don't appear in 3D. (A
   follow-up may extrude open wall segments as thin slabs.)
4. **Rug / floorLayer symbols.** `z ≈ 0.01` → rendered as a flat projected floor decal at
   z=0 (top face only, no visible side faces), never a box. Keeps the "peek" clean.
5. **Openings (door/window).** Extruded as boxes at their leaf height, flush in the wall
   footprint. No cut-out/void geometry this cut — a documented simplification (a door reads
   as a colored panel, not a hole).
6. **Rotated furniture.** `corners(sym)` already returns the rotated footprint; extrusion
   lifts those rotated corners, so rotation is handled for free. The camera-facing side
   faces are chosen from the rotated edges' outward normals.
7. **Overlapping furniture / furniture on a rug.** Painter's back-to-front sort resolves
   occlusion; rug decals sort behind boxes because their footprint centroid depth key plus
   their z=0 top keeps them at the floor. Intentional overlap (LLD 107) still reads.
8. **Very tall item vs ceiling (e.g. wardrobe 2.0m, bookshelf 1.8m).** Furniture is
   extruded to its own `z` independent of `CEILING_M`; an item taller than the ceiling is
   allowed to poke above wall tops (rare, realistic-ish, and cheap). No clamping.
9. **Preview toggled on mid-draw (active chain in progress).** The chain is draft-only 2D
   state; preview hides it and does not commit or discard it. Exiting preview restores the
   in-progress chain untouched.
10. **Pointer events on the stage while preview is active.** Tool handlers early-return on
    `preview.isActive()`, so no vertex placement / selection / measurement can mutate the
    plan. Guarantees read-only.
11. **Zoom/pan while preview active.** The iso projection reads `pxPerM()` + view pan, so
    the scene pans/zooms consistently; no separate camera state to desync.
12. **Degenerate footprint (zero-area / collinear).** Skipped (no faces emitted), mirroring
    how `roomCentroids`/`wallSegments` skip degenerate geometry.
13. **Theme switch (dark/light) while preview active.** Face shades derive from the live
    palette base colors at render time, so a theme toggle re-derives shades on the next
    `scheduleRender()` (already fired by `onThemeChange`).

## Dependencies

Everything needed already exists in the codebase; no new runtime dependency, no build step.

- **`symbols.js`** — `CATALOG` (add `z` per type), `corners(sym)` (footprint), `CATALOG`
  `floorLayer`/`openings` flags (rug/opening handling), `model`.
- **`walls.js`** — `model.rooms`, `wallSegments()` (source of wall quads to extrude),
  `roomCentroids()` (floor-slab source + depth key aid), `WALL_M` (wall thickness for the
  wall quad width).
- **`view.js`** — `pxPerM()`, `view.panX/panY` for scene framing (zoom/pan consistency);
  `onChange` already re-renders.
- **`surface.js`** — `onRender(cb)` hook registration + `scheduleRender()`.
- **`theme.js`** — `palette()` for base fill colors + `onThemeChange` (already wired to
  re-render).
- **`main.js`** — tool-rail toggle wiring, keydown handlers (mirror measure/clearance).
- **`plan.js`** — referenced only to confirm NO change is required (back-compat is a
  non-event because height is a catalog constant).
- **`index.html`** — add `#iso` SVG group, `#tool-preview` button + separator, and CSS for
  `.stage--preview` and the active-ring state.

No dependency on unshipped issues; explicitly independent of #102 (WebGL/3D-lib) by
staying in vanilla SVG.

## Test Requirements

Added to `test/tests.html` in the existing `describe`/`it`/`expect` harness. Pure functions
are tested directly; SVG-structural tests follow the render-module pattern (LLD 61) —
build a detached SVG group, call `render()`, assert on child polygons.

### Unit — height model

- Every `CATALOG` entry has a finite positive `z` (loop the whole catalog). Guards against
  a missing height when a new type is added later.
- `createSymbol` output is unchanged (still `{id,type,x,y,w,h,rot}` with no `z`) — instance
  shape did not grow.

### Unit — projection core (pure)

- `projectIso(0,0,0)` maps to origin offset; `projectIso` is linear in each of wx/wy/wz.
- Increasing `wz` moves the projected point strictly up (screen −y) — height reads as up.
- `extrudeFootprint` returns the expected face count for a 4-corner footprint: 1 top + 2
  camera-facing sides (+ bottom if emitted) — assert the exact number of `role:"top"` /
  `role:"left"` / `role:"right"` faces.
- `shade(base, factor)` produces darker fills for smaller factors and is deterministic.
- `depthSort` orders items ascending by `sortKey` (back-to-front), stable for ties.

### Unit — item build

- `buildItems` produces one box per closed-room wall segment (z0=0, z1=CEILING_M) and one
  per non-floorLayer symbol (z1 = catalog `z`); floorLayer (rug) items are flat (z1≈z0)
  decals, not boxes.
- Open rooms contribute no wall boxes; empty model → empty item list.

### SVG-structural — renderer (LLD 61 pattern)

- Preview OFF: `render()` leaves `#iso` empty.
- Preview ON with one closed rectangular room + one symbol: `#iso` contains the expected
  number of `<polygon>` elements — floor slab(s) + (walls × faces) + (furniture × faces).
  Assert the extruded-**face count** matches `buildItems` × visible-faces-per-box.
- **Height sensitivity:** rendering the same plan with a larger `CATALOG[type].z` (or a
  larger `CEILING_M`) changes the projected top-face polygon points (top moves up) — assert
  a specific top-face vertex's y decreases. This is the acceptance-criterion test that
  "a change in height/ceiling changes the projected geometry."
- Rug renders a flat decal (single top polygon, no side faces).
- Painter order: the polygon for a nearer item appears **after** (later in child order than)
  a farther item it overlaps.

### Integration — back-compat round-trip (acceptance)

- A plan saved before this change (no `z` anywhere — it never had it) validates via
  `validatePlan` and renders in preview using catalog defaults (no error).
- Round-trip a plan through all three transports and confirm byte-stability of the symbol
  shape: `buildPlan → serializePlan`, `buildCompact → parseCompact → validatePlan`, and a
  `localStorage` write/read all produce a plan with unchanged symbol fields (no `z` leaked
  into serialization).

### Behavioral — view mode / read-only

- Toggling preview on then off leaves `walls.model` and `symbols.model` deeply equal to
  their pre-toggle snapshots (no mutation).
- `preview.toggle()` flips `isActive()` and fires `onChange`.
- Toggle button `aria-pressed` reflects `isActive()` after a click (mirror the existing
  clearance-switch aria-pressed test).

### Not tested (out of scope)

Export/share inclusion of the preview, camera rotation, per-room ceilings — all follow-up
sub-issues.
