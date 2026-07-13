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

### 2. Projection: single fixed axonometric angle — projection lives in `view.js`

Use a **fixed axonometric projection** (no rotation UI). The dimetric fold, in world
metres, is:

```
isoWX = (wx - wy) * cos(θ)
isoWY = (wx + wy) * sin(θ) - wz * ISO_KZ
```

with θ = 30°. This produces a folded world-metre coordinate that is then run through the
**same** zoom/pan pipeline as the 2D editor so the preview stays framed with the plan.

**Invariant compliance (was BLOCKING).** `view.js` documents a load-bearing contract:
"All world↔screen conversion must go through this module. No other module may read
panX/panY/zoom and do its own math." The earlier draft violated this by having
`isoRender` read `view.panX/panY`. **Resolution:** the projection (including the z term)
is added to `view.js` as a new exported function, and `isoRender` consumes it — reading
pan/zoom stays entirely inside `view.js`. We add to `view.js`:

```js
// view.js — new exports; θ and vertical scale live with the projection math.
export const ISO_THETA = Math.PI / 6;   // 30°
export const ISO_KZ    = 0.82;          // metres-of-height → folded-metres; nonzero so
                                        // height changes visibly raise top faces

/**
 * Axonometric world→screen projection. Folds (wx,wy,wz) world metres into the
 * dimetric plane, then applies the SAME zoom/pan as worldToScreen so the iso
 * scene shares the 2D editor's framing. wz is up (decreases screen y).
 * @returns {{ x:number, y:number }} screen pixels
 */
export function worldToScreenIso(wx, wy, wz) {
  const isoWX = (wx - wy) * Math.cos(ISO_THETA);
  const isoWY = (wx + wy) * Math.sin(ISO_THETA) - wz * ISO_KZ;
  return worldToScreen(isoWX, isoWY);   // reuses pxPerM() + panX/panY internally
}
```

`isoRender` calls `worldToScreenIso(wx, wy, wz)` and never touches `view.panX/panY/zoom`
or `pxPerM()` directly. The 2D `worldToScreen` is left untouched. Because the fold reuses
`worldToScreen`, the preview pans/zooms consistently with the 2D framing for free
(Edge Case 11). `view.js`'s header comment is updated to note the iso variant is the
sanctioned z-aware projection so future readers don't treat the invariant as forbidding
it.

### 3. Extruded box geometry — 3 faces, painter's sort

**Wall segment source (was BLOCKING).** `walls.wallSegments()` is NOT the extrusion source:
it returns segments for *all* rooms (open included) **plus the active draft chain**, which
would contradict "open walls don't appear" (Edge Case 3) and "preview hides the in-progress
chain" (Edge Case 9). Instead `buildItems` iterates `walls.model.rooms` directly, keeps
only `room.closed === true` rooms, and **never reads `walls.model.chain`**. For each kept
room it walks consecutive vertex pairs plus the closing edge (`verts[n-1]→verts[0]`) and
turns each edge into a wall quad footprint of thickness `WALL_M` (centered on the edge
centerline, mirroring how the 2D wall body is drawn), skipping edges shorter than
`MIN_SEG_M`. This keeps the extrusion set aligned with what actually renders as enclosed
rooms.

Each extruded item (wall quad footprint or furniture footprint) is a **prism**: a bottom
polygon at z=0 and a top polygon at z=height, connected by vertical side faces. For the
blocky read we draw only the visible faces given the fixed camera:

- **Top face** — the footprint polygon lifted to z=height (lightest shade).
- **Two side faces** — the two silhouette-facing vertical walls of the box, one per the
  camera-facing pair of edges (mid and dark shades).

Because the camera is fixed, exactly which two of the four vertical faces are "front-left"
and "front-right" is constant, so we pick them deterministically (the two edges whose
outward normal faces the camera). Each face is a 4-point SVG `<polygon>`.

**Opaque, distinguishable base color derivation (was BLOCKING).** The 2D editor's base
fills are *translucent and shared* — uncolored furniture is `symFill`
`rgba(201,168,76,0.12)`, walls are `wallBody` `rgba(201,168,76,0.30)`. Using those
directly would make every box the same near-transparent gold: faces would show through
each other (breaking painter occlusion) and `shade()`'s RGB multiply would ignore the
alpha. So the preview does **not** consume those fills. Instead `buildItems` resolves each
item to an **opaque** RGB base color via this deterministic rule:

1. **Furniture with an explicit `sym.color`** (user-picked, LLD 97) → use it. These are
   opaque hex already; if a stored color ever carries alpha, composite it over the theme
   `bg` to force opacity before shading.
2. **Uncolored furniture** → an opaque per-category base color, so a sofa, a fridge and a
   bed are visually distinct instead of all-gold. Define a small
   `CATEGORY_BASE: Record<SymCategory, {light:string, dark:string}>` map in `isoRender.js`
   (opaque hex, one pair per existing `SymCategory`: openings/living/kitchen/bedroom/bath/
   outdoor), chosen to sit harmoniously with the blueprint palette. `buildItems` picks the
   light/dark member by the current theme (`theme.getTheme()`), giving readable boxes in
   both themes.
3. **Walls** → an opaque wall base color derived from the theme (a fully-opaque form of the
   gold `wallLine`/`gold` token, NOT the 0.30-alpha `wallBody`), so walls read as a
   consistent neutral shell distinct from furniture.
4. **Floor slab** → stays translucent on purpose (it is a ground plane drawn behind all
   boxes, never occluded by design), so it keeps using a low-alpha theme neutral.

Three flat shades per box are then derived from the resolved **opaque** base color:

- top = base color at full lightness,
- left side = base color scaled to ~0.72 lightness,
- right side = base color scaled to ~0.58 lightness.

Because the base is opaque, `shade()` (multiply RGB by a factor, clamp) is well-defined and
faces are fully opaque, so the painter's algorithm occludes correctly. This gives the
3-shade blocky look with NO lighting/gradients — just three precomputed solid fills.

`shade()` operates on `{r,g,b}` parsed from an opaque hex or `rgb()` string; a helper
`toOpaqueRgb(color, bgColor)` normalises any input (hex, `rgb()`, or `rgba()`) to opaque
RGB by compositing over `bgColor` when an alpha channel is present.

### 4. Painter's algorithm (back-to-front)

There is no z-buffer in SVG, so correctness comes from **draw order**. We sort all
extruded items back-to-front by their footprint's depth key (for this camera,
`sortKey = (wx + wy)` of the footprint centroid; larger = nearer = drawn later). Walls and
furniture are merged into one list and sorted together so furniture in front of a wall
correctly occludes it. The faint floor slab for each room is drawn first (furthest back),
before any boxes. Within a single box, faces are emitted bottom→sides→top so the top always
paints last.

**Known limitation (per-object centroid sort).** A single centroid depth key per object is
not a true per-face depth order. A long wall spanning a large depth range can sort as a
single unit and mis-order against furniture whose centroid falls "inside" that range,
producing occasional occlusion glitches (e.g. a chair against a long back wall). This is an
accepted tradeoff for this cut — a full BSP/per-face painter sort is out of scope. Stated
here (not asserted as correct) so the reviewer and follow-ups know it is a deliberate
simplification; the painter-order test asserts only the common furniture-vs-wall case, not
the degenerate long-wall case.

### 5. Renderer structure — pure core + SVG painter

`isoRender.js` splits into:

- **Pure functions** (no DOM): `extrudeFootprint(corners, z0, z1)` → prism faces (projected
  via `view.worldToScreenIso`), `buildItems(...)` → item list, `depthSort(items)`,
  `shade(baseColor, factor)`, `toOpaqueRgb(color, bgColor)`. The axonometric fold itself,
  `worldToScreenIso`, lives in `view.js` (Approach §2). These are unit-testable without a
  DOM (`view.js` runs headless; `worldToScreenIso` needs no DOM).
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
// Fixed camera constants — the projection + θ + vertical scale live in view.js
// (see Approach §2). isoRender re-exports CEILING_M and imports the projection.
export const CEILING_M = 2.4;           // whole-plan ceiling height (metres)
// ISO_THETA and ISO_KZ are exported from view.js:
//   ISO_KZ = 0.82  — nonzero so height changes visibly move top faces up
//                    (satisfies the height-sensitivity acceptance test).

/**
 * The visible faces of a box given its 2D footprint corners (world) and z-range.
 * Projects each corner via view.worldToScreenIso(wx, wy, wz). Returns an ordered
 * list of faces (bottom/sides/top order), each a list of projected SCREEN points
 * and a shade role.
 * @param {{x,y}[]} footprint  world-metre polygon (e.g. corners(sym) or a wall quad)
 * @param {number} z0  base height (metres, usually 0)
 * @param {number} z1  top height (metres)
 * @returns {{ role:"top"|"left"|"right"|"bottom", pts:{x,y}[] }[]}
 */
export function extrudeFootprint(footprint, z0, z1);

/**
 * Build the extrudable item list from the live models.
 *
 * Walls: iterate wallsModel.rooms, keep ONLY room.closed === true; for each kept
 *   room, emit one item per edge (consecutive vert pairs + the closing edge),
 *   expanded to a WALL_M-thick quad footprint, z0=0, z1=CEILING_M. Open rooms and
 *   wallsModel.chain (the in-progress draft) are NEVER read — so open walls and the
 *   active chain do not appear (Edge Cases 3, 9).
 * Furniture: one item per non-floorLayer symbol (z0=0, z1=CATALOG[type].z).
 *   floorLayer symbols (rugs) become flat floor decals (z1≈z0), not boxes.
 *
 * baseColor is an OPAQUE color resolved per Approach §3 (sym.color, else the
 * per-category opaque base for the current theme; walls use the opaque wall base).
 * Returns items with a precomputed depth sort key.
 * @returns {{ kind:"wall"|"furniture"|"rug", footprint:{x,y}[], z0:number, z1:number, baseColor:string, sortKey:number }[]}
 */
export function buildItems(wallsModel, symbolsModel);

/** Stable back-to-front sort (ascending sortKey). Pure; returns a new array. */
export function depthSort(items);

/** Bind SVG group refs + getters. Called once from main.js. */
export function init(gIso, getActive);

/** surface.onRender hook. No-op (clears #iso) when getActive() is false. */
export function render();
```

Shade derivation is a pure helper `shade(baseColor, factor)` (parse to opaque RGB, multiply
channels by `factor`, clamp) so the three face fills are deterministic and testable.
`toOpaqueRgb(color, bgColor)` composites any alpha-bearing input over `bgColor` first so
`shade` always receives an opaque color (see Approach §3).

### `index.html`

- New SVG group `<g id="iso"></g>` inside `#drawing`, appended LAST (topmost) so the whole
  preview overlays the hidden 2D layers.
- New `.tool-rail-sep` + `<button id="tool-preview" aria-label="3D preview (P)"
  aria-pressed="false">` with an icon and `<span class="tool-key-hint">P</span>`.
- CSS: a `.stage--preview` class on `#stage` that hides the 2D layers/overlays and shows
  `#iso`; the accent-ring active style for `#tool-preview[aria-pressed="true"]`.

### `help.js` — shortcuts overlay (LLD 54)

Add one row to the `SHORTCUTS` data array so the new `P` shortcut appears in the cheat-sheet
overlay alongside the other tool keys:

```js
{ group: "Tools", action: "3D preview toggle", mac: "P", other: "P" },
```

No other change to `help.js` (it renders the table from the array).

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
3. **Open rooms (unclosed chains / open polylines).** `buildItems` keeps only
   `room.closed === true` rooms (it iterates `walls.model.rooms` directly, NOT
   `wallSegments()`), so an open room contributes no floor slab and no wall boxes this cut.
   Document as a known limitation; open walls simply don't appear in 3D. (A follow-up may
   extrude open wall segments as thin slabs.)
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
9. **Preview toggled on mid-draw (active chain in progress).** `buildItems` never reads
   `walls.model.chain`, so the in-progress draft contributes nothing to the preview. The
   chain is draft-only 2D state; preview does not commit or discard it, and exiting preview
   restores the in-progress chain untouched (it was never mutated).
10. **Pointer events on the stage while preview is active.** Tool handlers early-return on
    `preview.isActive()`, so no vertex placement / selection / measurement can mutate the
    plan. Guarantees read-only.
11. **Zoom/pan while preview active.** `worldToScreenIso` reuses `worldToScreen`'s
    `pxPerM()` + pan internally (Approach §2), so the scene pans/zooms consistently with the
    2D framing; no separate camera state to desync.
12. **Degenerate footprint (zero-area / collinear).** Skipped (no faces emitted): wall edges
    below `MIN_SEG_M` and zero-area footprints are dropped, mirroring how `roomCentroids`
    skips degenerate polygons.
13. **Theme switch (dark/light) while preview active.** Face shades derive from the live
    palette base colors at render time, so a theme toggle re-derives shades on the next
    `scheduleRender()` (already fired by `onThemeChange`).

## Dependencies

Everything needed already exists in the codebase; no new runtime dependency, no build step.

- **`symbols.js`** — `CATALOG` (add `z` per type), `corners(sym)` (footprint), `CATALOG`
  `floorLayer`/`openings` flags (rug/opening handling), `model`.
- **`walls.js`** — `model.rooms` (iterated directly; filter `room.closed`, exclude
  `model.chain` — NOT via `wallSegments()`, which includes open rooms + the draft chain),
  `roomCentroids()` (floor-slab footprints + depth-key aid), `WALL_M` (wall quad thickness),
  `MIN_SEG_M` (degenerate-edge skip).
- **`view.js`** — **NEW** `worldToScreenIso(wx,wy,wz)` + `ISO_THETA`/`ISO_KZ` exports
  (added here so pan/zoom reads stay inside `view.js`, honouring its invariant — Approach
  §2); `onChange` already re-renders on pan/zoom.
- **`surface.js`** — `onRender(cb)` hook registration + `scheduleRender()`.
- **`theme.js`** — `palette()` (opaque tokens: `bg` for compositing, `gold`/`wallLine` for
  the wall base), `getTheme()` (light/dark selection for the per-category base colors), and
  `onThemeChange` (already wired to re-render, so shades re-derive on theme switch).
- **`main.js`** — tool-rail toggle wiring, keydown handlers (mirror measure/clearance).
- **`help.js`** — add a `SHORTCUTS` row documenting the `P` shortcut in the cheat-sheet
  overlay (LLD 54).
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

- `worldToScreenIso(0,0,0)` equals `worldToScreen(0,0)`; `worldToScreenIso` is linear in
  each of wx/wy/wz at a fixed zoom/pan.
- Increasing `wz` moves the projected point strictly up (screen −y) — height reads as up.
  Requires `ISO_KZ > 0` (asserted nonzero; value 0.82).
- `extrudeFootprint` returns the expected face count for a 4-corner footprint: 1 top + 2
  camera-facing sides (+ bottom if emitted) — assert the exact number of `role:"top"` /
  `role:"left"` / `role:"right"` faces.
- `shade(base, factor)` produces darker fills for smaller factors and is deterministic.
- `toOpaqueRgb` composites an `rgba(...,a<1)` input over a bg to an opaque color (no alpha
  in output) and passes an already-opaque input through unchanged.
- `depthSort` orders items ascending by `sortKey` (back-to-front), stable for ties.

### Unit — item build

- `buildItems` produces one box per closed-room wall edge (z0=0, z1=CEILING_M) and one per
  non-floorLayer symbol (z1 = catalog `z`); floorLayer (rug) items are flat (z1≈z0) decals,
  not boxes.
- **Open rooms contribute no wall boxes** (a model with one open + one closed room yields
  wall items only for the closed room).
- **The active draft chain contributes nothing** (`buildItems` on a model with a non-empty
  `walls.model.chain` and no closed rooms yields an empty wall set).
- Empty model → empty item list.
- Every furniture/wall item's `baseColor` is opaque (no `rgba(...,a<1)`); two different
  categories yield different base colors.

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
- Painter order: for the common furniture-vs-wall case (a piece with a nearer centroid than
  a wall), the nearer item's polygons appear **after** (later in child order than) the
  farther item's. (The long-wall mis-order case in Approach §4 is a known limitation and is
  NOT asserted.)

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
