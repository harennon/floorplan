# LLD 130: True 3D preview via three.js (npm) with orbit camera

Parent: #101 · Issue: #124 · Order 4 of 4 · Effort: medium

## Scope

Phase 2 of the 3D-preview feature (#101): upgrade the read-only preview from the shipped
2.5D isometric SVG (LLD 128) to **true 3D WebGL via three.js**, with an **orbit camera**
the user can rotate, pan, and zoom around the extruded plan. three.js is **npm-installed,
version-locked, tree-shaken, and lazy-loaded** — it loads only on first preview entry so
the default editor load is unaffected (the build-step/dependency question was settled in
#102; three.js chosen over Zdog by the CEO for real orbit camera + future lighting
headroom).

This cut **reuses the height model and the pure extrusion core already in `main`**:
`buildItems(wallsModel, symbolsModel)` (`isoRender.js`) already returns exactly the data a
3D renderer needs — per-item `{ kind, footprint (world-metre polygon), z0, z1, baseColor,
sortKey }`. The 3D renderer consumes that output directly. The hand-rolled 2.5D-specific
machinery (`extrudeFootprint`, `depthSort`, `shade`, `worldToScreenIso`) is **replaced** by
WebGL's depth buffer + a real `PerspectiveCamera` + real lighting; none of it is reused.

**In scope**

- **New module `render3d.js`** with a clean **pure/impure split**:
  - a pure `buildSceneDescriptors(items)` that maps `buildItems()` output to a
    framework-agnostic list of **mesh descriptors** (`{ kind, footprint, z0, z1, color,
    flat }`) plus a computed scene `bounds` — no `import` of three.js, unit-testable
    headless.
  - an impure WebGL layer (`initRender3d`, `enter`, `exit`, `frame`, `dispose`) that
    consumes descriptors and the lazily-imported `THREE` module to build geometries,
    meshes, lights, camera, and `OrbitControls`.
- **Lazy dynamic `import()`** of three.js on first preview entry, with a loading state and
  a failure fallback (drop back to the 2.5D SVG preview — LLD 128 stays in the build).
- **A `<canvas>` overlay** mounted inside `#stage`, shown/hidden alongside preview mode.
- **Reuse of `preview.js`** view-mode state, the `#tool-preview` tool-rail toggle, the `P`
  shortcut, and the `Esc`-exit — this issue **replaces** the 2.5D renderer as the target of
  the existing toggle rather than adding a new toggle (see Approach §1).
- **Scene teardown on exit** (dispose geometries, materials, renderer, controls) to avoid
  WebGL context leaks.
- **Read-only enforcement** carried over from LLD 128 / PR #130: the canvas cannot mutate
  the plan, and the three #130 leak classes are re-audited for the WebGL overlay.

**Explicitly OUT of scope (guards — restated from #124)**

- NO textures, NO materials beyond a single flat-shaded standard material, NO realistic
  lighting/shadows (a basic ambient + one directional light for face differentiation is the
  ceiling — see Approach §5), NO 3D furniture models, NO first-person / VR walkthrough.
- NO editing geometry in 3D — still a read-only view mode; the 2D editor stays the single
  source of truth.
- NO export/share inclusion of the 3D view (that is #123, separate and still targets the
  2.5D artifact).
- NO per-room scoping and NO door/window cut-out geometry (that is #122; openings remain
  flush colored boxes, exactly as in LLD 128).
- NO per-room ceiling override (whole-plan single `CEILING_M`, reused from LLD 128).
- NO change to the persisted plan schema, the share hash, or JSON export (this cut adds no
  plan data — height still lives on the catalog as a code constant).

## Approach

### 1. 3D replaces the 2.5D renderer behind the existing single toggle (decision)

**Decision: 3D is a drop-in replacement for the 2.5D SVG renderer, driven by the same
`#tool-preview` toggle — not a third mode.** The rejected alternatives and rationale:

| Option | Verdict |
|---|---|
| **A. 3D replaces 2.5D behind the one toggle** (chosen) | One "preview" affordance, one mental model. `preview.isActive()` stays the single source of truth; the `P` shortcut and `Esc`-exit are unchanged. The 2.5D SVG path is retained *only* as the lazy-load fallback (Approach §6), so no UI grows. Matches the issue's own framing ("upgrades the read-only preview … to true 3D"). |
| **B. Third mode (2D → 2.5D → 3D)** | Rejected. Adds a second preview affordance and a tri-state to explain, for no user value once 3D works — the 2.5D look was always the *cheap first cut* to validate appetite (#101 phasing), never a co-equal end state. Would also force export/share (#123) to pick which preview it captures. |
| **C. Separate 3D toggle beside the 2.5D toggle** | Rejected for the same reason as B, plus two rail buttons for one concept. |

Consequences of Option A that this LLD commits to:

- `preview.js` is **unchanged** — `isActive()`/`toggle()`/`setActive()`/`onChange()` keep
  their exact contract. The renderer swapped behind the toggle is an implementation detail.
- The `.stage--preview` CSS class keeps hiding all 2D SVG layers and HTML overlays. It
  gains one rule: it also shows the new 3D `<canvas>` (Approach §2).
- `isoRender.render()` (the 2.5D SVG painter) is **no longer registered as an `onRender`
  hook in the normal path**. Instead `render3d` owns the preview surface. `isoRender.js`
  stays in the tree because (a) its pure `buildItems`/`toOpaqueRgb`/`CATALOG` height reuse
  is the 3D data source, and (b) its `render()` is the WebGL-unavailable fallback painter
  (Approach §6). The `#iso` SVG group stays in `index.html` for that fallback.

### 2. Canvas mount: a sibling `<canvas>` inside `#stage`, shown/hidden by the preview class

The 3D output is a single `<canvas id="stage3d">` added inside `#stage`, as a **later
sibling of `#drawing`** (the 2D SVG) and of the `.labels`/`.dim-labels` HTML overlays. It
is absolutely positioned to fill the stage, sits on top by DOM order, and is
`display:none` by default. Rationale for canvas-as-sibling rather than replacing/reusing
the SVG:

- WebGL requires a `<canvas>`; it cannot render into the existing `<svg>`.
- Keeping the SVG untouched (just hidden by `.stage--preview`, exactly as LLD 128 already
  does) means **zero state loss** on exit — the 2D DOM was never mutated, identical to the
  LLD 128 guarantee.
- The canvas is created **empty in markup** (or created lazily in JS on first entry — see
  §6); it holds no WebGL context until three.js loads, so it costs nothing on default load.

CSS changes to the existing LLD 128 block in `index.html`:

```css
#stage3d { display: none; position: absolute; inset: 0; width: 100%; height: 100%;
           touch-action: none; /* OrbitControls needs raw pointer/touch */ }
.stage--preview #stage3d { display: block; }
/* #iso (the 2.5D SVG fallback group) is now shown ONLY on the WebGL-unavailable path,
   gated behind the extra preview--fallback class (default success path is the canvas). */
.stage--preview.preview--fallback #iso { display: block; }
```

**Required edit to the two existing rules (do not leave them unconditional).** Today
`index.html` has `.stage--preview #iso { display: block; }` **twice** (`:198` and `:211`).
Both must be **changed to `.stage--preview.preview--fallback #iso { display: block; }`** —
otherwise `#iso` would be `display:block` on the WebGL-success path too (harmless because the
opaque canvas covers it, but it contradicts the design and wastes an SVG paint). The
unconditional `#iso { display: none; }` base rule (`:210`) stays as-is. Net: `#iso` is hidden
by default, shown only when both `.stage--preview` and `.preview--fallback` are present.

The canvas has `touch-action:none` so OrbitControls' pointer/pinch handling isn't fought by
the browser's default scroll/zoom. Because the canvas is opaque WebGL output, it fully
covers the hidden 2D layers.

### 3. Coordinate mapping — world metres → three.js scene units, handling the y-down frame

The 2D editor's world frame is **y-down** (screen convention). three.js is a **y-up,
right-handed** frame with the ground conventionally the XZ plane. We map so that the plan
lies flat on the ground and "height" (`z0`/`z1` metres) becomes three.js **+Y**:

```
threeX =  worldX
threeY =  worldZ           // extrusion height (z0/z1 metres) → up
threeZ =  worldY           // world-y (depth) → three.js +Z
```

- **Units are 1:1** — one world metre = one three.js unit. No scaling; the camera framing
  (Approach §4) handles apparent size, and keeping metres avoids a second unit system to
  reason about.
- The plan is **not** re-centred at the origin in world space; instead the camera's target
  and position are computed from the scene `bounds` (Approach §4), so an off-origin plan is
  framed correctly without mutating geometry.

**Winding & face orientation — the LLD 128 bug #2 hazard, re-incarnated in WebGL.** The two
footprint producers wind **oppositely**: `corners(sym)` (furniture) winds **CCW** and
`_wallQuad` (walls) winds **CW** in the y-down world frame — this is documented in
`isoRender.js:208-209` and was the root cause of LLD 128's back-face bug. Two consequences
this design must handle correctly:

1. The `{ threeX:worldX, threeY:worldZ, threeZ:worldY }` map above is a **bare y↔z axis swap,
   which is a reflection (determinant −1) and therefore FLIPS winding/handedness** — it does
   *not* preserve it. So after mapping, the furniture and wall footprints still wind
   oppositely, and each producer's flip is inverted relative to the world frame.
2. Under `ExtrudeGeometry` with the default `material.side = THREE.FrontSide`, opposite
   windings mean the extruded side-wall normals point **outward for one** of {walls,
   furniture} and **inward for the other** — the inward-normal class would render inside-out
   (hollow / see-through boxes). This is exactly the WebGL re-incarnation of the bug #130
   fixed with a winding-independent centroid normal.

**Resolution (required, not optional): all extruded box meshes use `side: THREE.DoubleSide`.**
DoubleSide renders both faces of every triangle, so the extruded walls are visible and solid
regardless of which way either producer winds — it makes face correctness winding-independent
without needing to normalize either producer's polygon order. This is a hard requirement of
the material spec (Approach §5), not a defensive nicety. (The alternative — normalizing
winding to a single orientation in `buildSceneDescriptors` via a signed-area check and
reversing CW polygons — is more code and more failure surface for zero visual benefit here,
since the boxes are opaque and we are not doing single-sided lighting tricks. DoubleSide is
the chosen approach.)

### 4. Scene construction from `buildItems()`

`render3d.buildScene(items, THREE)` walks the descriptor list (from
`buildSceneDescriptors(buildItems(...))`) and produces meshes:

- **Walls & furniture (boxes):** each item's `footprint` (a world-metre polygon: a
  `WALL_M`-thick quad for walls, `corners(sym)` for furniture, both convex) is turned into
  a `THREE.Shape` in the XZ plane and extruded by `(z1 - z0)` via **`ExtrudeGeometry`** with
  `{ depth: z1 - z0, bevelEnabled: false }`, then translated so its base sits at
  `threeY = z0`. `ExtrudeGeometry` extrudes along +Z of the shape's local plane, so the
  geometry is rotated `-90°` about X to stand the extrusion up along +Y. (Alternative:
  `BoxGeometry` per item — rejected because rotated furniture footprints aren't
  axis-aligned; `ExtrudeGeometry` from the actual polygon handles arbitrary rotation for
  free, mirroring how `corners(sym)` already returns rotated corners.)
- **Rugs (`kind:"rug"`, flat, z1≈z0=0):** handled specially — **not extruded**. A rug
  becomes a flat `ShapeGeometry` (a filled polygon) laid on the ground at
  `threeY = 0.002` (a tiny lift to avoid z-fighting with the floor slab), single-sided,
  rendered with the rug color. This mirrors the LLD 128 "flat decal, never a box" handling
  (Edge Case 4 there).
- **Floor slabs:** each closed room's footprint (from `wallsModel.rooms`, `room.closed`,
  reusing the exact filter `buildItems` uses) becomes a `ShapeGeometry` at `threeY = 0`
  with a subtle, semi-transparent neutral material (theme `roomFill`-derived, opaque-ised
  the same way §5 does colors). Drawn under everything; gives the "rooms read as rooms"
  cue that LLD 128's frontend decision established.

All meshes are added to a single `THREE.Group` (`_planGroup`) so the whole plan can be
disposed/rebuilt as a unit (§7).

Colors: descriptors carry the **opaque** `baseColor` already resolved by `buildItems`
(user `sym.color`, else per-category opaque base, else the wall base — LLD 128 §3). WebGL
lighting supplies the face-to-face differentiation that LLD 128 faked with three precomputed
shades, so `render3d` does **not** re-derive `shade()` tints; it feeds `baseColor` straight
into one material per mesh (Approach §5).

### 5. Lighting & materials — minimal, just enough for face differentiation

The issue forbids textures / realistic lighting / shadows / 3D models. With a real engine
now available, the minimum that makes boxes readable (so a cube doesn't render as a flat
silhouette) is:

- **One `THREE.AmbientLight`** (moderate intensity) for base fill so no face is pure black.
- **One `THREE.DirectionalLight`** placed up-and-to-a-corner (e.g. from +X/+Y/+Z) for
  gentle face-to-face luminance differences — the WebGL analogue of LLD 128's 3-shade look.
  **`castShadow` stays `false`** (shadows are explicitly out of scope; they'd also need a
  shadow map + tuning we don't want).
- **Material: `THREE.MeshLambertMaterial`** (or `MeshStandardMaterial` with
  `metalness:0, roughness:1`) per mesh, `color = descriptor.color`, `flatShading: true`,
  and **`side: THREE.DoubleSide` (required)** on the extruded box meshes. DoubleSide is
  mandatory, not optional — it is what makes face orientation correct given the opposite
  windings of the two footprint producers (Approach §3); without it, one of {walls,
  furniture} renders inside-out. Lambert is chosen over `MeshBasicMaterial` because Basic
  ignores lights (every face identical, defeating the point) and over `MeshPhongMaterial`
  because we want matte, not specular highlights (which would read as "realistic materials",
  out of scope). One material instance **per distinct color** is cached in a `Map` and reused
  across meshes to cut material count and simplify disposal (all box materials share the
  DoubleSide setting).
- **Floor slab & rug** use the same Lambert material with their neutral/rug color; the
  floor slab material sets `transparent:true, opacity:~0.5` for the subtle read. Flat
  ground geometry (`ShapeGeometry`) is only ever viewed from above by the orbit camera
  (`maxPolarAngle` keeps the camera above the floor — §Frontend), so it can stay
  single-sided; only the extruded boxes need DoubleSide.

This is the explicit in/out line: **in** = ambient + one directional light, flat-shaded
matte Lambert, one color per material. **Out** = textures, maps, shadows, environment/IBL,
multiple/animated lights, PBR metalness/roughness variety, tone mapping beyond the default.

### 6. Lazy loading — dynamic `import()`, loading state, WebGL fallback

three.js (~150 KB gzipped) must not touch the default editor load. It is imported **only on
first preview entry**:

```js
// render3d.js — module-level cache of the loaded engine
let _three = null;               // resolved THREE namespace
let _loadPromise = null;         // in-flight import promise (dedupes rapid toggles)

async function ensureThree() {
  if (_three) return _three;
  if (!_loadPromise) {
    _loadPromise = Promise.all([
      import("three"),
      import("three/examples/jsm/controls/OrbitControls.js"),
    ]).then(([three, oc]) => { _three = { ...three, OrbitControls: oc.OrbitControls }; return _three; });
  }
  return _loadPromise;
}
```

> **Tree-shaking caveat (implementation-time).** The `import("three")` namespace import +
> `{ ...three }` spread shown above is the readable form but is **tree-shaking-hostile** — a
> whole-namespace import can defeat Vite's dead-code elimination and pull far more than the
> ~150 KB budget. See Approach §9 for the required build-time measurement step and the
> named-import fallback (`import { Scene, PerspectiveCamera, ... } from "three"`) if the
> chunk is over budget. Also pin the exact `three` version and confirm the OrbitControls
> import path is valid for it — recent releases expose it at both
> `three/examples/jsm/controls/OrbitControls.js` and `three/addons/controls/OrbitControls.js`.

Flow when the user toggles preview on:

1. `preview.onChange` fires; `main.js` adds `.stage--preview`, calls `render3d.enter()`.
2. `enter()` shows a lightweight **loading state** (a centered "Loading 3D…" element over
   the stage — reuse the existing toast/spinner idiom; no new heavy component) and awaits
   `ensureThree()`.
3. On resolve: build renderer/scene/camera/controls (first time) or rebuild the plan group,
   `frame()` the camera to the plan bounds, start the render loop, hide the loading state.
4. On **reject or WebGL unavailable** (see below): fall back to the 2.5D SVG preview —
   add a `preview--fallback` class so CSS shows `#iso`, call the retained
   `isoRender.render()` once, and surface a one-line toast ("3D unavailable — showing 2.5D
   preview"). The user still gets a preview; no dead end.

**WebGL availability check** before attempting the engine: `webglAvailable()` tries
`canvas.getContext("webgl2") || canvas.getContext("webgl")` on a throwaway canvas; if null
(headless/old browser/blocked), go straight to the fallback path without importing three.js.
It accepts an optional canvas/factory argument so tests can inject a stub (Interfaces).

**Render loop (damping-aware, self-terminating).** The intent is: no always-on rAF on a
static scene, but smooth OrbitControls damping while the camera is settling. Event-driven
"render once per `controls.change`" alone does **not** achieve damping — with
`enableDamping`, `controls.update()` must be called **every frame after the input ends**
until the residual velocity settles, and each `update()` that produces movement itself emits
`change`. The mechanism:

- On any user input to the controls (`controls` `start`/`change`), if no loop is running,
  **start a short-lived rAF loop**. Each frame: `controls.update()` then `renderer.render()`.
- `controls.update()` returns `true` while it is still applying damping and `false` once the
  camera has settled (three.js exposes this). When it returns `false` (or on the `controls`
  `end` event after motion has decayed), **stop the loop** (`cancelAnimationFrame`, clear the
  handle). The scene is now static and no rAF runs.
- A single explicit `renderer.render()` on `frame()`/entry covers the initial static draw.

So the loop exists only during and immediately after interaction, then self-terminates —
matching the app's existing `scheduleRender` "coalesce, don't spin" philosophy while still
producing real damping. (Alternative if damping proves fiddly: set `enableDamping = false`
and render purely on `controls.change` — acceptable but slightly less smooth. Damping-with-
self-terminating-loop is the chosen default.)

### 7. Teardown — dispose on exit to avoid WebGL context leaks

On `preview` toggle-off (`render3d.exit()`):

- Stop the rAF/animation loop and remove the `controls` `change` listener.
- Traverse `_planGroup`, calling `.geometry.dispose()` on every mesh and `.dispose()` on
  each **cached** material (dispose the material `Map`, once each), then remove the group
  from the scene.
- **Keep** the `WebGLRenderer`, `scene`, `camera`, and `controls` alive for cheap re-entry
  (creating a renderer/context is the expensive part; a repeatedly-toggled preview
  shouldn't thrash contexts). Only the per-plan geometry/materials churn.
- On a hard teardown (page unload, or an explicit "release" path if ever needed):
  `renderer.dispose()`, `renderer.forceContextLoss()`, drop the canvas context, null the
  refs. Guards against the classic "too many active WebGL contexts" leak.
- **Rebuild trigger:** because the 2D editor is fully hidden and inert during preview
  (Approach §8), the plan cannot change while preview is on. So the scene is built **on
  entry** and **not** live-synced. If preview is entered, exited, edited, and re-entered,
  `_planGroup` is disposed on exit and rebuilt fresh on the next entry from the current
  models — always a pure function of the live plan at entry time. (This matches LLD 128,
  which recomputes from the live models each render.)

### 8. Read-only enforcement — carry LLD 128 / PR #130 guarantees to the WebGL overlay

The preview is read-only. The plan is never mutated by 3D. Concretely:

- **Model access is read-only:** `buildItems(wallsModel, symbolsModel)` and
  `buildSceneDescriptors` only read `walls.model` / `symbols.model`; they never mutate. The
  camera/controls state lives entirely in three.js objects, never in the plan.
- **The three #130 leak classes, re-audited for the canvas overlay:**
  1. **Child HTML overlays (labels / dim-chips).** Already hidden by the LLD 128 descendant
     selectors `.stage--preview .labels`/`.dim-labels`. The opaque canvas sits above them
     regardless, but we keep the CSS hide so no interactive dim-chip can receive pointer
     events. **N/A to new regressions** — no new child overlay is added.
  2. **Back-face / winding correctness.** In LLD 128 this was an SVG painter bug rooted in
     the opposite windings of `corners()` (CCW) and `_wallQuad` (CW). **Winding correctness
     still matters under WebGL** — it is not eliminated, just enforced differently: the depth
     buffer resolves occlusion, but face *orientation* under the default `FrontSide` would
     still render one of {walls, furniture} inside-out (Approach §3). This design enforces
     correctness via **`material.side = THREE.DoubleSide` (required, Approach §5)** rather
     than hand-rolled per-face selection, so both windings render solid. The failure mode is
     the same class of bug as #130; the guard is the mandatory DoubleSide material, and the
     descriptor-level tests do not need to assert winding (DoubleSide is winding-independent).
  3. **Sibling mutation panels (symbol dock / inspector).** Hidden by the existing
     `.stage--preview ~ #symbol-dock`/`#symbol-inspector` rules, **and** the JS guard
     `_onDockPointerDown` early-returns on `previewIsActive()` (`symbolTool.js:383`). Both
     survive unchanged. The new canvas is a *child* of `#stage`, so it does not sit between
     `#stage` and those siblings and cannot re-expose them.
- **Pointer events on the stage** (draw / select / measure) already early-return while
  `previewIsActive()` (`main.js` draw/select/measure hooks). OrbitControls listens on the
  **canvas only**, so its drag/zoom gestures drive the camera and never reach the 2D tool
  handlers (which are also inert). No new guard needed; the existing `previewIsActive()`
  gate is the single choke point.

### 9. Bundle-size guardrail

Per CLAUDE.md "lean deps": three.js is added to `dependencies` (version-locked, e.g.
`"three": "0.16x.x"` pinned exact) and is **code-split into its own chunk** by the dynamic
`import()`. Vite emits it as a separate `assets/three-<hash>.js` that is **not** referenced
by the entry HTML, so it is never fetched on the default editor load — only when preview is
first entered. Guardrails:

- The **build-smoke** test already asserts the entry `dist/index.html` references only the
  hashed app bundle; we add an assertion that the entry HTML/its eager imports do **not**
  statically pull `three` (i.e. three lands in a distinct chunk). See Test Requirements.
- Expected added weight: ~150 KB gzipped for the three core + OrbitControls, in a lazy
  chunk. `OrbitControls` from `three/examples/jsm/controls/OrbitControls.js` is a plain ES
  module that imports a handful of three core classes; it tree-shakes and adds only a few KB
  on top of core (it does not pull the whole examples tree).
- **Required implementation-time acceptance step (tree-shaking).** After `npm run build`,
  **measure the emitted `assets/*three*` chunk gzipped** and compare it against the ~150 KB
  budget. The `import("three")` + `{ ...three }` namespace form (Approach §6) is
  tree-shaking-hostile and may blow the budget; if the measured chunk is well over ~150 KB
  gzipped, **switch to explicit named imports** (`import { Scene, PerspectiveCamera,
  WebGLRenderer, ExtrudeGeometry, ShapeGeometry, MeshLambertMaterial, AmbientLight,
  DirectionalLight, Group, Mesh, DoubleSide, Shape, Vector3 } from "three"`) so Vite can
  drop the unused surface. This is a build-verified acceptance gate, not an assumption. Also
  pin the exact `three` version in `package.json` and confirm the OrbitControls import path
  resolves for that version (`three/examples/jsm/…` vs `three/addons/…`).

## Frontend Design

The toggle affordance is **unchanged from LLD 128** (CEO-settled): the same `#tool-preview`
tool-rail button, the same `aria-label="3D preview (P)"`, the same active-ring
`aria-pressed="true"` style, the same `P` shortcut and `Esc`-exit. This issue only changes
what renders behind the toggle. No new panel, no new button, no new controls in the rail.

**Camera & initial framing (`frame()`):**

- **`PerspectiveCamera`** (fov ~45°, near 0.1, far sized to the scene diagonal × a few).
- **Initial position:** a pleasant three-quarter view that echoes the retired isometric
  angle — camera placed above and to a corner of the plan looking down at ~30–35°. Concretely,
  target = the plan's XZ centroid at a mid height (`bounds` centre, `threeY ≈ CEILING_M/2`);
  position = target offset by a vector whose horizontal bearing is the old dimetric corner
  and whose distance is derived from the bounds diagonal and the camera fov so the whole
  plan fits with a ~10% margin. This mirrors `view.fitToContent`'s "fit bounds with 10%
  margin" behaviour, in 3D. Scene `bounds` come from the descriptor pass (which unions all
  footprints in world XZ and `[0, max(z1, CEILING_M)]` in Y) — the same content-bounds
  spirit as `exportImg.contentBounds()`, but computed inside `buildSceneDescriptors` so it
  is pure and testable.
- **Empty plan:** if `bounds` is degenerate (no closed rooms, no symbols), frame a default
  camera looking at the origin (no crash) — the analogue of `view.resetView`.

**OrbitControls (rotate / pan / zoom):**

- **Rotate:** left-drag (one-finger touch). **Zoom:** wheel / pinch. **Pan:** right-drag or
  two-finger touch (`controls.enablePan = true`).
- `enableDamping = true` for smooth feel; render on the controls `change` event (§6).
- **Constrain `maxPolarAngle`** to just under 90° so the user can't orbit under the floor
  (keeps the "peek into the space" read; a fully-free camera under the slab looks broken).
  `minDistance`/`maxDistance` clamped to sane multiples of the bounds diagonal so zoom can't
  fly infinitely out or clip through geometry.
- The controls are **the only camera UI this cut** — no reset button, no preset-angle
  buttons (a "reset view" control is a listed follow-up, not required by #124's acceptance
  criteria).

**Loading & fallback affordances:**

- A centered, unobtrusive **"Loading 3D…"** indicator over the stage while the chunk
  downloads on first entry (reuse the existing toast styling; it appears only once per
  session because the module is cached after first load).
- If WebGL is unavailable or the import fails, the stage shows the **2.5D SVG preview**
  (LLD 128) plus a single toast "3D unavailable — showing 2.5D preview". The user is never
  left with a blank stage.

**Help overlay:** the existing `P` row in `help.js` `SHORTCUTS` (added by LLD 128) still
reads "3D preview toggle" — no change needed; it is now literally 3D.

## Interfaces / Types

### `render3d.js` (new) — pure descriptor builder + impure WebGL layer

The module is split so the geometry-mapping logic is testable without a DOM or a GPU
(mirroring how `buildItems`/`extrudeFootprint` are pure and unit-tested in LLD 128).

```js
// ── Pure (no DOM, no three.js import) — unit-testable headless ───────────────

/**
 * @typedef {{
 *   kind: "wall"|"furniture"|"rug"|"floor",
 *   footprint: {x:number,y:number}[],  // world-metre polygon (convex)
 *   z0: number,                        // base height (m)
 *   z1: number,                        // top height (m); ≈ z0 for flat items
 *   color: string,                     // opaque rgb()/hex (from buildItems.baseColor)
 *   flat: boolean                      // true → ShapeGeometry on ground (rug/floor)
 * }} MeshDescriptor
 */

/**
 * @typedef {{
 *   minX:number, minY:number, maxX:number, maxY:number,  // world XY (plan footprint)
 *   minZ:number, maxZ:number                             // height range (m)
 * } | null} SceneBounds
 */

/**
 * Map buildItems() output + closed-room floor slabs into framework-agnostic mesh
 * descriptors and compute the scene bounds. Does NOT import three.js.
 *
 * - walls/furniture → flat:false box descriptors (z0..z1)
 * - rugs (kind:"rug") → flat:true ground decals
 * - floor slabs (one per closed room) → kind:"floor", flat:true
 *
 * @param {ReturnType<import("./isoRender.js").buildItems>} items
 * @param {{ rooms:{closed:boolean,verts:{x:number,y:number}[]}[] }} wallsModel  // for floor slabs
 * @param {string} floorColor  // opaque neutral for slabs (theme roomFill, opaque-ised)
 * @returns {{ descriptors: MeshDescriptor[], bounds: SceneBounds }}
 */
export function buildSceneDescriptors(items, wallsModel, floorColor);

/**
 * World-metre point → three.js scene coords (y-up). z is height (m).
 * Pure; the single place the y-down→y-up + XZ-ground mapping lives.
 * @returns {{x:number,y:number,z:number}}
 */
export function worldToScene(wx, wy, wz);   // {x:wx, y:wz, z:wy}

// ── Impure (DOM + lazily-imported three.js) ──────────────────────────────────

/** Bind the canvas + model refs + active getter. Called once from main.js. */
export function initRender3d(canvasEl, getActive, wallsMod, symbolsMod, loadingEl);

/**
 * Enter preview: lazy-load three.js (once), build renderer/scene/camera/controls
 * if needed, (re)build the plan group from live models, frame the camera, render
 * the initial static frame (the on-input self-terminating damping loop, Approach
 * §6, is armed via the controls listeners, not a persistent rAF). Shows loading
 * state while importing; on failure/WebGL-absent, resolves to a { fallback:true }
 * result so main.js shows the 2.5D SVG path.
 * @returns {Promise<{ ok:true } | { ok:false, fallback:true, reason:string }>}
 */
export async function enter();

/** Exit preview: stop loop, dispose the plan group + cached materials, keep
 *  renderer/scene/camera/controls for cheap re-entry (Approach §7). */
export function exit();

/** Recompute camera to fit current scene bounds (~10% margin). */
export function frame();

/** Full release (page unload): dispose renderer, forceContextLoss, null refs.
 *  Wired to a `pagehide` listener in main.js (see wiring below). */
export function dispose();

/**
 * True if a WebGL(2) context is obtainable — gate before importing three.
 * Takes an OPTIONAL canvas (or a zero-arg factory returning one) so unit tests
 * can inject a stub whose getContext returns null, without monkeypatching the
 * global `document`. Defaults to a throwaway `document.createElement("canvas")`.
 * @param {HTMLCanvasElement|(()=>HTMLCanvasElement)} [canvasOrFactory]
 * @returns {boolean}
 */
export function webglAvailable(canvasOrFactory);
```

### `isoRender.js` — reused, one small change

- **Reused unchanged:** `buildItems`, `toOpaqueRgb`, `CEILING_M`, `CATEGORY_BASE`
  resolution — these are the 3D data source.
- **Change:** its `render()` is **no longer registered as an `onRender` hook in the normal
  path** (`main.js`). It is retained and invoked **only** on the WebGL-fallback path
  (Approach §6). `extrudeFootprint`/`depthSort`/`shade` stay exported for that fallback and
  for their existing LLD 128 tests; they are not used by `render3d`.

### `preview.js` — unchanged

No change. `render3d` consumes the same `isActive()`/`toggle()`/`onChange()` contract.

### `index.html`

- Add `<canvas id="stage3d" aria-hidden="true"></canvas>` inside `#stage`, after `#drawing`
  and the `.labels`/`.dim-labels` overlays.
- Add a `<div id="preview-loading" hidden>Loading 3D…</div>` (or reuse the toast) for the
  loading state.
- CSS: add the `#stage3d` show/hide rules; **change** the two existing unconditional
  `.stage--preview #iso { display: block; }` rules (`:198`, `:211`) to
  `.stage--preview.preview--fallback #iso` so `#iso` shows only on the fallback path
  (Approach §2). The existing `.stage--preview` 2D-hide rules from LLD 128 are kept.

### `main.js` wiring (extends the LLD 128 preview block)

- Import `render3d`; `initRender3d(canvas3d, previewIsActive, _wallsModRef, _symbolsModRef,
  loadingEl)`.
- **Remove** `onRender(isoRenderFn)` from the normal hook chain (it becomes fallback-only).
- **Single choke point for the renderer side-effects (fixes double-invocation).** Today both
  the `btnPreview` click handler (`main.js:505-509`) *and* the `previewOnChange` listener
  (`:513-516`) run on a button click (the click calls `previewToggle()`, which fires
  `onChange`). To avoid firing `render3d.enter()`/`exit()` twice on one click, the button/`P`
  handlers keep doing **only** `previewToggle()` (plus the existing `_syncPreview()`), and
  **all renderer entry/exit lives in the `previewOnChange` listener** — the one place every
  path (button, `P`, `Esc`, any programmatic `setActive`) converges. The listener becomes:

  ```
  previewOnChange(async () => {
    _syncPreview();                       // aria-pressed + .stage--preview (existing)
    if (previewIsActive()) {
      const r = await render3d.enter();   // lazy-load + build + frame
      if (!previewIsActive()) { render3d.exit(); return; }  // toggled off mid-load (Edge Case 3)
      if (r.ok === false && r.fallback) {                   // WebGL/import failed
        stage.classList.add("preview--fallback");
        isoRender.render();               // paint the 2.5D SVG fallback once
        // + show the "3D unavailable" toast
      }
    } else {
      render3d.exit();
      stage.classList.remove("preview--fallback");
    }
  });
  ```

  So the button click, the `P` shortcut, and the `Esc`-exit branch each just call
  `previewToggle()` (as they already do in LLD 128) — no separate `_enterPreview()` helper is
  needed, and `enter()` cannot be invoked twice per toggle.
- On `window` resize while preview active: call `render3d`'s resize (update renderer size +
  camera aspect); the existing resize listener gains one call.
- **`dispose()` trigger (fixes the unwired hard-teardown).** Add a one-line
  `window.addEventListener("pagehide", () => render3d.dispose())` in the wiring block so the
  WebGL context is explicitly released on navigation/unload. (`pagehide` is chosen over
  `beforeunload` because it also fires for bfcache and mobile tab suspension. If the
  reviewer prefers, this can be dropped entirely since browsers reclaim GL contexts on real
  unload — but wiring one listener is cheap insurance against context accumulation in SPA-like
  bfcache restores, so it is kept.)

### `package.json`

- Add `"three": "<exact pinned version>"` to `dependencies` (a new `dependencies` block;
  currently only `devDependencies` exists). Version-locked exact, per the lean-deps rule.

## State Model

### Persisted plan state — unchanged (no schema change)

Like LLD 128, this cut adds **no plan data**. Height still lives on the catalog
(`CATALOG[type].z`), which is code, not plan data. The serialized plan shape (`walls`,
`symbols[].{id,type,x,y,w,h,rot,color?}`, `measurements`, `view`, `unit`) is untouched:

- **localStorage / JSON export:** no schema change, no `PLAN_SCHEMA` bump, no new
  `validatePlan` normalisation.
- **Share hash:** unchanged; no camera state is serialized.
- **Camera / orbit state is session-only and NOT persisted.** Each entry re-frames from the
  plan bounds (Approach §4). Reloading the page starts in 2D. This is deliberate — a shared
  link opening at a specific camera angle is a future consideration under #123, not this cut.

### Session-only view state (never persisted)

- `preview._active` — unchanged from LLD 128; transient, reset to false on load.
- `render3d` internal state: `_three` (loaded engine, cached for the session),
  `_renderer`/`_scene`/`_camera`/`_controls` (created once, kept for cheap re-entry),
  `_planGroup` (disposed on exit, rebuilt on entry), `_materialCache` (Map keyed by color,
  disposed with the group). None of this is persisted or serialized.

### In-memory vs computed

- **Persisted / in-memory model:** `walls.model`, `symbols.model` — single source of truth,
  never mutated by the preview.
- **Computed on entry:** the descriptor list, three.js geometries/materials/meshes, and the
  camera frame are all computed from the live models **at entry time** and disposed on exit.
  No cached 3D state survives an exit; the preview is a pure function of the current plan +
  the (session-only) camera the user has orbited to.

### Why rebuild-on-entry is sufficient (not live-sync)

While preview is active the 2D editor is fully hidden and all mutation paths are inert
(Approach §8), so the plan **cannot change** during preview. Therefore the scene is built
once on entry and never diffed against live edits. Edit → exit → re-enter yields a fresh
scene from the then-current models. This matches LLD 128 (recompute each render from live
models) and keeps the WebGL layer free of an incremental-update code path.

## Edge Cases

1. **WebGL unavailable** (headless CI, old browser, GPU blocklisted, context creation
   fails). `webglAvailable()` returns false before importing three.js → fall back to the
   2.5D SVG preview (`isoRender.render()`) + a toast. No crash, no blank stage, no wasted
   three.js download.
2. **three.js import fails** (network error on the lazy chunk, offline). `enter()` rejects
   → same 2.5D fallback path as (1). The import promise cache is reset on failure so a later
   re-entry can retry the download.
3. **Rapid toggle spam while the chunk is still loading.** `_loadPromise` dedupes concurrent
   imports; `enter()`/`exit()` are guarded so an `exit()` that arrives before the import
   resolves cancels the pending build (check `previewIsActive()` after the await before
   building/framing).
4. **Empty plan (no rooms, no symbols).** `bounds` is null → default camera at origin, empty
   `_planGroup`. Orbit works over empty space; no crash.
5. **Open rooms / in-progress draft chain.** Inherited from `buildItems`: only
   `room.closed === true` rooms contribute walls + floor slabs; `walls.model.chain` is never
   read. Open walls and the active draft do not appear in 3D (same known limitation as
   LLD 128 Edge Cases 3 & 9).
6. **Rugs / floorLayer symbols.** `kind:"rug"` → flat `ShapeGeometry` on the ground, never
   extruded (Approach §4). A rug lifted `~0.002 m` above the floor slab avoids z-fighting.
7. **Rotated furniture.** `corners(sym)` already returns rotated footprint corners;
   `ExtrudeGeometry` from that polygon handles arbitrary rotation with no special case
   (unlike an axis-aligned `BoxGeometry`).
8. **Item taller than the ceiling** (wardrobe 2.0 m, bookshelf 1.8 m vs `CEILING_M` 2.4 m —
   or a future taller item). Each mesh is extruded to its own `z1`; a tall item may poke
   above wall tops. Allowed and realistic; no clamping (matches LLD 128 Edge Case 8). Camera
   `far`/bounds include `max(z1)` so nothing is clipped.
9. **Openings (door / window).** Extruded as flush colored boxes at their leaf height, no
   cut-out (same simplification as LLD 128 Edge Case 5). Real cut-outs are #122, out of scope
   here.
10. **Theme switch while preview active.** Colors come from `buildItems` at build time. A
    theme change would need a rebuild to recolor. Because the 2D editor (and thus the theme
    toggle) is hidden during preview, the theme cannot change mid-preview — so no live
    recolor path is needed. On the next entry, colors re-derive from the current theme.
    (If a future change lets the theme toggle fire during preview, that increment must add a
    rebuild on `onThemeChange` — noted, not built.)
11. **WebGL context loss** (GPU reset, tab backgrounded on some drivers). Add a
    `webglcontextlost`/`webglcontextrestored` listener on the canvas: on lost, stop the loop
    and show the fallback/toast; on restored (if still in preview), rebuild the scene. Low
    frequency but cheap to guard and a common real-world WebGL leak/crash source.
12. **Resize while preview active.** Update `renderer.setSize(W,H)` and
    `camera.aspect = W/H; camera.updateProjectionMatrix()` on the window resize event; one
    render. Without this the canvas stretches.
13. **Degenerate footprint (zero-area / collinear / <3 corners).** Skipped in
    `buildSceneDescriptors` (no descriptor emitted), mirroring how `buildItems`/`extrudeFootprint`
    already drop degenerate polygons and how `roomCentroids` skips them.
14. **Very large / deep plan.** `PerspectiveCamera` near/far are derived from the bounds
    diagonal so a big plan doesn't clip; `minDistance`/`maxDistance` scale with bounds so zoom
    stays usable. No fixed magic numbers.
15. **HiDPI / retina.** `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` —
    cap at 2 to keep fill-rate bounded on 3× phones (perf, not correctness).

## Dependencies

### New runtime dependency (the one deliberate addition)

- **`three`** (npm, exact-pinned version in `package.json` `dependencies`), imported
  dynamically. `three/examples/jsm/controls/OrbitControls.js` for the orbit camera. This is
  the only new dependency; it is justified by the settled #102 + #124 decision and is
  code-split so it does not affect default load (Approach §6, §9). **No other new
  dependency.** Vite (already present) handles the code-splitting and content-hashing.

### Existing code reused (already in `main`)

- **`isoRender.js`** — `buildItems(wallsModel, symbolsModel)` (the extrusion data source),
  `toOpaqueRgb`, `CEILING_M`, per-category color resolution. Its `render()` +
  `extrudeFootprint`/`depthSort`/`shade` are retained as the WebGL-unavailable fallback
  painter (no longer in the normal `onRender` chain).
- **`symbols.js`** — `CATALOG[type].z` (height), `corners(sym)` (rotated footprint),
  `floorLayer` flag (rug handling), `model`.
- **`walls.js`** — `model.rooms` (closed-room filter for walls + floor slabs; `chain` never
  read), `WALL_M`, `MIN_SEG_M` — all already consumed transitively via `buildItems`.
- **`preview.js`** — `isActive`/`toggle`/`setActive`/`onChange` (unchanged contract).
- **`theme.js`** — `palette()` (`roomFill`/`bg` for the floor slab + opaque compositing),
  `getTheme()` — consumed transitively via `buildItems`.
- **`surface.js`** — the render pipeline (`onRender` no longer used for the 2.5D preview in
  the normal path; `render3d` owns the canvas independently). `W`/`H` for renderer sizing.
- **`view.js`** — referenced only for the framing *concept* (`fitToContent`'s 10% margin);
  `render3d` computes its own camera frame and does **not** touch `panX/panY/zoom` (the
  y-up 3D camera is a separate coordinate system, so the view.js world↔screen invariant is
  not in play — noted so the design reviewer doesn't flag a false invariant violation).
- **`main.js`** — the existing LLD 128 preview wiring block (extended to call `render3d`).
- **`index.html`** — add the `#stage3d` canvas + loading element + CSS; keep the `#iso`
  group and `.stage--preview` rules for the fallback.
- **`exportImg.js`** — **no change**; export/share of the preview is #123, out of scope.
- **`help.js`** — **no change**; the `P` shortcut row from LLD 128 already covers it.

### Depends on (shipped)

- **#102** (build step) — CLOSED, Vite live; enables npm deps + code-splitting.
- **#121 / LLD 128** (height model + 2.5D preview) — merged to `main`; provides `buildItems`,
  `CATALOG[type].z`, `CEILING_M`, `preview.js`, the toggle, and the fallback renderer.

No dependency on unshipped issues. #122 (per-room + opening cut-outs) and #123 (export/share)
build *after* this and are explicitly out of scope.

## Test Requirements

WebGL is hard to unit-test headless (CI Chromium has no reliable GPU), so the strategy
**mirrors LLD 128's pure/impure split**: the geometry-mapping logic is a pure function
tested directly; the WebGL calls are behind a thin impure layer that is smoke-tested for
"boots without error / falls back cleanly," not pixel-asserted. Tests go in `test/tests.html`
(`describe`/`it`/`expect`) unless noted; the build assertion goes in `build-smoke.mjs`.

### Unit — `buildSceneDescriptors` (pure, no three.js, headless)

- Maps a closed-room-plus-symbol model to descriptors: one box descriptor per wall edge
  (`flat:false`, `z0=0`, `z1=CEILING_M`), one per non-rug symbol (`z1 = CATALOG[type].z`),
  one `flat:true` rug decal per rug, one `kind:"floor"` slab per closed room.
- **Rugs are flat, boxes are not:** a rug descriptor has `flat:true` and `z1 ≈ z0`; a sofa
  descriptor has `flat:false` and `z1 > 0`.
- **Open rooms / draft chain contribute nothing** (inherited from `buildItems`, re-asserted
  at the descriptor level: an open + closed room yields walls/slab only for the closed one).
- **Colors are opaque** — every descriptor `color` is a non-alpha `rgb()`/hex (passthrough
  from `buildItems.baseColor`); two different categories yield different colors.
- **Degenerate footprints skipped** — a zero-area or <3-corner footprint emits no descriptor.
- **Bounds:** `bounds` unions all footprint XY and `[0, max(z1, CEILING_M)]`; empty model →
  `bounds === null`.

### Unit — `worldToScene` (pure)

- `worldToScene(x,y,z)` maps to `{x, y:z, z:y}` (y-down world → y-up scene, height→+Y);
  linear in each argument; ground (`wz=0`) maps to `sceneY=0`.

### Unit — `webglAvailable` gate

- Returns a boolean; passing a **stub canvas** (via the optional `canvasOrFactory` param —
  Interfaces) whose `getContext` returns null makes `webglAvailable()` return false (so the
  fallback path is chosen without importing three.js), and a stub returning a truthy context
  makes it return true. The injectable param is what makes this unit-testable without
  monkeypatching the global `document`.

### Integration — lazy-load & fallback (drives the built app, like the LLD 82 rig)

- **Default load does not fetch three.js:** after boot (no preview entered), assert no
  network request for the `three` chunk occurred (Playwright request log) — proves lazy.
- **WebGL-available entry:** toggle preview on in headless Chromium (if a GL context is
  available); assert the `#stage3d` canvas becomes visible, `.stage--preview` is set, and no
  console/page errors fire. If the CI Chromium lacks WebGL, this test asserts the **fallback
  path** instead (below) — the runner detects `webglAvailable()` and branches.
- **Fallback path:** with WebGL forced unavailable (stub or `--disable-gpu`), toggling
  preview shows the `#iso` 2.5D group (class `preview--fallback`) and a toast, with no error.
- **Teardown:** toggle preview on then off; assert the plan group is disposed (no growth in a
  probe counter of live geometries across N on/off cycles — expose a test-only
  `render3d.__liveGeometryCount()` or assert via a spy) and that repeated cycling does not
  create additional WebGL contexts (renderer reused).

### Build-smoke — bundle guardrail (`build-smoke.mjs`)

- The entry `dist/index.html` (and its eagerly-loaded app chunk) does **not** statically
  reference `three` — `three` must appear only in a **separate lazy chunk** under `assets/`.
  Assert: an `assets/*three*` (or the dynamic-import chunk) exists AND the entry HTML's
  eager `<script>`/`modulepreload` set does not include it. This is the concrete
  "does-not-slow-default-load" acceptance check.

### Behavioral — read-only (carry LLD 128 guarantees)

- Toggling preview on then off leaves `walls.model` and `symbols.model` deeply equal to
  their pre-toggle snapshots (no mutation) — same assertion as LLD 128, now with the 3D path.
- With preview active, a synthetic pointerdown on the `#stage3d` canvas does not mutate the
  plan (the tool handlers early-return on `previewIsActive()`; OrbitControls only moves the
  camera).
- `#symbol-dock`/`#symbol-inspector` remain hidden and `_onDockPointerDown` early-returns
  while preview is active (re-assert the #130 guard holds with the canvas overlay present).

### Not tested (out of scope)

Pixel-level render correctness / visual regression of the 3D output (no headless GPU
guarantee; deferred to manual QA), camera-angle exactness, export/share of the 3D view
(#123), per-room scoping and opening cut-outs (#122).

## Follow-ups (file as issues)

Per project convention, deferred items are tracked as GitHub issues, not left in the doc.

**Already covered by existing issues (no new issue needed):**

- Export / share the preview → **#123** (still targets the 2.5D artifact; whether the 3D
  view or an isometric snapshot is the exported form is that issue's call).
- Per-room preview scoping + door/window opening cut-out geometry → **#122**.

**New follow-ups (filed as GitHub issues):**

1. **#131 — "Reset view" / preset camera angles for the 3D preview.** A control to snap the
   orbit camera back to the default framing (and optionally NE/NW/SE/top presets).
   Deliberately omitted here to keep the first 3D cut to just OrbitControls.
2. **#132 — Live theme recolor during 3D preview.** Only becomes relevant if a future change
   lets the theme toggle fire while preview is active (Edge Case 10); would add a scene
   rebuild on `onThemeChange`. Dead code under the current UX, so not built now.
3. **#133 — Basic contact / soft shadows in the 3D preview.** Explicitly out of scope now
   (issue #124), but the natural "next fidelity step" three.js unlocks; filed so the
   appetite can be judged after this ships.
