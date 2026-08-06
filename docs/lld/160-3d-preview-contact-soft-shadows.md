# LLD 160: 3D preview — basic contact / soft shadows

Parent: #101 · Follow-up from LLD 130 (#124, true 3D preview via three.js + orbit camera).
Filed there as follow-up #133. Frontend decision: **C (soft ground)** — CEO-settled.

## Scope

LLD 130 shipped the true-3D preview with **ambient + one non-shadow-casting directional
light** and flat-shaded matte Lambert boxes; shadows were explicitly excluded (#124) to keep
the first WebGL cut minimal. This cut adds **basic soft ground shadows** cast by the single
existing directional light onto the floor slab, purely to improve the depth read of the
extruded plan. It is a **fidelity increment on the already-shipped preview**, not a rework of
the toggle, canvas mount, orbit camera, presets, loading, or fallback — all of those are
fixed and untouched.

**In scope**

- Turn on the WebGLRenderer's shadow map (`renderer.shadowMap.enabled = true`,
  `type = PCFSoftShadowMap`) — the "soft" character of frontend decision C.
- `castShadow = true` on the **single existing** `DirectionalLight` (no new lights), with a
  tuned **orthographic shadow camera** whose frustum is fit tightly to the plan bounds so the
  capped map resolution is not wasted.
- `castShadow = true` / `receiveShadow = true` on the extruded **wall + furniture** box
  meshes; `receiveShadow = true` on the **floor slab** (the ground that catches the contact
  shadow). Rugs cast/receive per the rules in Approach §3.
- A **capped shadow map** (`1024²`) plus a single tuned **`shadow.bias`** and
  **`shadow.normalBias`** to suppress shadow acne / peter-panning — the deploy-cheap ceiling.
- Rebuild the shadow-camera frustum whenever the plan group is rebuilt (on entry), since the
  frustum is a function of `_bounds`.

**Explicitly OUT of scope (guards)**

- **No second light, no ambient-occlusion, no IBL / environment map, no textures, no PBR
  materials.** The material stays `MeshLambertMaterial`, flat-shaded (LLD 130 §5). Lambert
  supports `receiveShadow`/`castShadow`, so no material-class change is needed.
- **No hard/punchy shadow** (that is fallback option B, not chosen). No contact-shadow
  texture trick, no baked AO ground plane.
- **No change** to the `#tool-preview` toggle, `P` shortcut, `Esc`-exit, OrbitControls,
  reset/preset camera (LLD 152), loading state, or the 2.5D WebGL-unavailable fallback.
- **No change** to the 2D editor, the persisted plan schema, the share hash, JSON export, or
  the PNG/SVG export path (`exportImg.js` rasterizes the **SVG**, not the WebGL canvas — see
  Edge Case 8). No new plan data.

## Approach

All changes live in `render3d.js` (plus the `render3dEngine.js` facade re-export of the two
new three.js symbols). Nothing else is touched.

### 1. Enable the shadow map on the renderer (once, in `_ensureEngine`)

In `_ensureEngine` (`render3d.js:344`), right after the `WebGLRenderer` is constructed and
before `setSize`, enable soft shadow mapping:

```
_renderer.shadowMap.enabled = true;
_renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // decision C: soft edges
```

`PCFSoftShadowMap` is the softest of three's built-in software filters and costs no extra
passes or textures beyond the single shadow map — it just changes the depth-compare sampling
in the shader. This is set **once** on the reused renderer (the renderer survives
exit/re-entry per LLD 130 §7), so it is not touched again on rebuilds.

### 2. Make the existing directional light a shadow caster with a bounds-fit frustum

The single `DirectionalLight` already added in `_ensureEngine` (`render3d.js:360-362`,
`intensity 1.6`, `position (1, 1.4, 1)`) becomes the shadow caster. **No new light is added**
and the ambient fill (`0.85`) is kept so shadowed faces are lifted off pure black.

```
dir.castShadow = true;
dir.shadow.mapSize.set(1024, 1024);        // capped (deploy-cheap)
dir.shadow.bias = -0.0005;                 // single tuned bias (acne)
dir.shadow.normalBias = 0.02;              // peter-panning on thin/vertical faces
```

A `DirectionalLight`'s shadow uses an **orthographic** camera (`dir.shadow.camera`, an
`OrthographicCamera`). Its default frustum (`±5`, near 0.5, far 500) will not match an
arbitrary plan, so the limited 1024² resolution would be spread over mostly-empty space,
giving blocky shadows. We fit the frustum tightly to the plan in a new helper
`_fitShadowCamera()` (Approach §4), called from `_buildPlanGroup` after `_bounds` is known.

Because the light must actually point **at** the plan for a directional shadow to land on it,
we also set the light's `target` to the scene-space bounds centre (a directional light shadows
along `position → target`). The light itself is positioned relative to the bounds centre so
the shadow direction is stable regardless of where the plan sits in world space (the current
fixed `position (1, 1.4, 1)` only works near the origin; an off-origin plan would otherwise
be lit/shadowed from an oblique, plan-dependent angle). See §4.

### 3. `castShadow` / `receiveShadow` per mesh kind

Set in the mesh factories, keyed off descriptor `kind`:

| Kind | `castShadow` | `receiveShadow` | Rationale |
|---|---|---|---|
| wall (`_makeBoxMesh`) | true | true | casts onto floor + neighbours; catches shadow from taller items |
| furniture (`_makeBoxMesh`) | true | true | the main depth-read win — furniture drops a contact shadow on the floor |
| floor slab (`_makeFlatMesh`, `kind:"floor"`) | false | **true** | the ground that catches contact shadows; never casts |
| rug (`_makeFlatMesh`, `kind:"rug"`) | false | true | a flat decal ~2 mm above the slab; casting from a zero-thickness sheet adds nothing but receiving lets furniture shadows fall across it so the rug doesn't look "cut out" |

The floor slab is `transparent:true, opacity:0.5` (LLD 130 §5). A **transparent** receiver
still receives shadows in three.js (the shadow darkens the lit result before the alpha blend),
so the soft ground shadow reads correctly on the semi-transparent slab — this is the whole
point of decision C ("soft ground"). No opacity change is needed.

`_makeBoxMesh` and `_makeFlatMesh` set the two flags on the `Mesh` after construction. This is
per-mesh boolean assignment; the cached **materials** are unchanged and still shared per
`kind|color` (shadow flags live on the mesh, not the material).

### 4. Fit the shadow camera to the plan bounds (`_fitShadowCamera`, new)

The directional light's orthographic shadow camera must cover the full plan XZ footprint and
its height, or shadows clip at the frustum edge. `_bounds` (already computed in
`_buildPlanGroup`, `render3d.js:483`) gives world `minX/maxX/minY/maxY` (→ scene X/Z) and
`minZ/maxZ` (→ scene Y). New internal helper, called at the end of `_buildPlanGroup` once
`_bounds` is set (and re-called on every rebuild, since bounds change with the plan):

- Compute the scene-space bounds centre `c` and the XZ half-extent + height, deriving a
  `radius` from the bounds diagonal (same diagonal `frame()`/`_viewPose` use).
- Position the light at `c + bearing * (radius * k)` for a fixed bearing matching the existing
  `(1, 1.4, 1)` direction (normalized), and set `dir.target.position = c`, then
  `dir.target.updateMatrixWorld()` (the target must be in the scene graph or have its world
  matrix updated for the light to aim). Add `dir.target` to the scene once in `_ensureEngine`.
- Set the ortho frustum to enclose the plan with a small margin:
  `left/right/top/bottom = ±(radius * 1.1)`, `near = 0.1`,
  `far = 2 * radius * k + diag` — comfortably past the far side of the plan.
- `dir.shadow.camera.updateProjectionMatrix()` after mutating the frustum.

Empty plan (`_bounds === null`): fall back to a small fixed frustum around the origin
(`radius ≈ 4`, same spirit as `_viewPose`'s `diag=8` branch) so there is no NaN — there is
nothing to shadow, but the setup stays valid.

Rationale: fitting the frustom to `_bounds` is what makes 1024² enough for a crisp soft
shadow — the map resolution is spent only on the plan, not empty space. This is the
resolution-vs-quality lever the implementation guidance calls out.

### 5. Bias / normalBias tuning (acne vs peter-panning)

Two classic shadow-map artifacts, both controlled by a **single** tuned value each (no
per-object bias, no cascaded maps — deploy-cheap):

- **Shadow acne** (self-shadow moiré on lit faces): mitigated by a small negative
  `shadow.bias` (start `-0.0005`). Too large a magnitude causes peter-panning, so keep it
  minimal.
- **Peter-panning** (shadow detaching from the base of thin/vertical geometry — walls are thin
  slabs): mitigated by `shadow.normalBias` (start `0.02`), which offsets the shadow sample
  along the surface normal and is gentler on thin geometry than raw `bias`. The tight frustum
  (§4) also reduces the depth quantization that drives acne, so these starting values should
  be close; the implementer tunes them by eye against a plan with both walls and furniture and
  locks the final pair as constants.

These are module-level constants (`SHADOW_BIAS`, `SHADOW_NORMAL_BIAS`, `SHADOW_MAP_SIZE`) so
the tuning is in one place.

### 6. Rendering & perf — no new always-on cost

Shadows add one extra render pass (the shadow-map depth pass) **per rendered frame**, but the
scene is still only drawn on the existing triggers: the initial `_renderOnce()`, the
self-terminating damping loop during interaction, and the tween (LLD 130 §6 / LLD 152 §2).
There is **no new rAF and no per-frame shadow re-computation** — a `DirectionalLight`'s shadow
map is re-rendered by three each frame the scene draws, which is exactly the frames we already
draw. On a static scene (no interaction) nothing runs, so the idle cost is unchanged.

The shadow map (1024²) is re-rendered when the light/geometry could have changed; since the
plan is static within a preview session (LLD 130 §7 rebuild-on-entry), the shadow is
effectively stable after the camera settles. `dir.shadow.autoUpdate` is left at its default
`true` (simplest; re-renders only on frames we already draw). Capping `mapSize` at 1024² and
`setPixelRatio` at 2 (existing) keeps fill-rate bounded on mobile GPUs (Edge Case 6).

### 7. What is NOT changed

`buildSceneDescriptors`, `worldToScene`, `_viewPose`, `frame`, `resetView`, `setPreset`, the
tween, the damping loop, the fallback path, teardown/dispose, and the material cache keys are
all unchanged. The descriptor shape gains no field — cast/receive is derived from `kind` at
mesh-build time, so the **pure layer stays pure and its tests are untouched**.

## Frontend Design

**Frontend decision: C (soft ground). CEO-settled to keep the backlog moving.** This is a
routine fidelity increment on the already-shipped 3D preview (LLD 130), **not** a
brand-defining first-screen/identity choice — the toggle, canvas mount, orbit camera, presets,
and chrome are all fixed. The only design call is the **shadow character**, and C is chosen:

- **Soft-edged ground shadows** via `PCFSoftShadowMap` give the depth read the issue is after
  (furniture and walls visibly sit *on* the floor) while staying **quiet** enough for the calm
  utility / blueprint aesthetic in CLAUDE.md — a soft penumbra reads as a gentle grounding cue,
  not a hard sun.
- It honours **deploy-cheap**: a **single** directional light, `PCFSoftShadowMap` capped at
  **1024²**, a **single** tuned bias/normalBias — **no** AO, IBL, extra/animated lights,
  textures, or PBR.
- **Option B (hard contact shadow)** — `BasicShadowMap`, crisp edges, a punchier/sunnier read
  — is the **documented fallback** if the team later wants more contrast. Switching to B is a
  one-line `shadowMap.type` change plus bias re-tune; the rest of this design is identical, so
  B stays cheap to adopt later without rework.

**No new UI, no new control, no new affordance.** There is no shadow toggle, no intensity
slider, no quality setting — the shadow is always on when the WebGL preview succeeds and simply
absent on the 2.5D fallback (which has no lighting model at all). The change is invisible in
the tool rail, the help overlay, and the DOM; it manifests only as pixels in the existing
`#stage3d` canvas. Reduced-motion, keyboard, and pointer behaviour are all unchanged.

Perceptually: the directional light already differentiates faces (LLD 130 §5); shadows add the
missing **contact cue** so a sofa no longer appears to float. Because the light aims at the
bounds centre (Approach §4), the shadow direction is **consistent** as the user orbits — the
scene does not appear re-lit when panned to an off-origin part of the plan.

## Interfaces / Types

### `render3dEngine.js` — add two named re-exports

The lazy facade must statically import/re-export the new symbol(s) so tree-shaking keeps
working (LLD 130 §9). `PCFSoftShadowMap` is a **constant**, not a class:

```js
import { /* …existing… */ PCFSoftShadowMap, OrthographicCamera } from "three";
export { /* …existing… */ PCFSoftShadowMap, OrthographicCamera };
```

`OrthographicCamera` is listed only if `_fitShadowCamera` needs to reference the class
directly; in practice the directional light already **owns** its `shadow.camera`
(`OrthographicCamera` instance) so we mutate that in place and may not need the class export.
`PCFSoftShadowMap` (the `shadowMap.type` constant) is **required**. `Object3D`/the light's
`target` are already reachable via the existing `DirectionalLight` export. Confirm the final
import set against a `npm run build` tree-shake measurement (the LLD 130 §9 gate) — the added
constant is a few bytes and must not grow the lazy chunk beyond the ~150 KB budget.

### `render3d.js` — internal additions only (no exported-API change)

```js
/** Shadow tuning — single values, deploy-cheap (no per-object bias, no cascades). */
const SHADOW_MAP_SIZE   = 1024;      // capped resolution
const SHADOW_BIAS       = -0.0005;   // acne suppression (tune by eye, then lock)
const SHADOW_NORMAL_BIAS = 0.02;     // peter-panning on thin/vertical faces

/** @type {any} the single directional light, retained so _fitShadowCamera can re-aim it. */
let _dirLight = null;

/**
 * Fit the directional light's orthographic shadow-camera frustum tightly to the
 * current scene bounds, and aim the light at the bounds centre. Called at the end
 * of _buildPlanGroup (bounds-dependent → re-run on every rebuild). Falls back to a
 * small origin frustum when _bounds is null (empty plan). No THREE import beyond
 * the retained light/its shadow.camera.
 */
function _fitShadowCamera();
```

- **`_ensureEngine`** — gains `_renderer.shadowMap.enabled/type` (§1), stores the directional
  light in `_dirLight`, sets `dir.castShadow = true` + `mapSize`/`bias`/`normalBias`, and adds
  `dir.target` to the scene. Otherwise unchanged.
- **`_makeBoxMesh`** — sets `mesh.castShadow = true; mesh.receiveShadow = true;` before return.
- **`_makeFlatMesh`** — sets `mesh.receiveShadow = true;` for both floor and rug; `castShadow`
  stays false.
- **`_buildPlanGroup`** — after `_scene.add(_planGroup)`, calls `_fitShadowCamera()`.
- **`dispose`** — nulls `_dirLight` alongside the other refs (the light is owned by the scene;
  no separate dispose call is required, but the ref is cleared).

No change to any exported signature (`buildSceneDescriptors`, `worldToScene`, `webglAvailable`,
`initRender3d`, `enter`, `exit`, `frame`, `resetView`, `setPreset`, `resize`, `dispose`, or the
`__`-prefixed test accessors).

## State Model

- **Persisted plan state — unchanged.** No schema bump, no `validatePlan` change, no
  share-hash change, no JSON-export change. This cut adds **zero** plan data (restating
  LLD 130 / 152). Shadows are a pure rendering property.
- **Camera / orbit state — unchanged**, still session-only in three.js objects.
- **New transient module state:** `_dirLight` (the retained directional light reference). It
  is created once with the renderer/scene/camera (survives exit/re-entry like them) and nulled
  in `dispose()`. The shadow map is GPU-side, owned by the light; it is released when the
  renderer is disposed (`renderer.dispose()` in `dispose()`), no extra teardown needed.
- **Shadow-camera frustum** is recomputed from `_bounds` on every `_buildPlanGroup` (entry /
  context-restore), consistent with how the plan group + `_bounds` are already rebuilt. It is
  not persisted and not diffed against live edits (the plan cannot change mid-preview —
  LLD 130 §7).
- **In-memory vs computed:** the shadow map and frustum are computed GPU/scene state derived
  from the geometry + light + bounds at entry time; nothing survives an `exit()` beyond the
  retained renderer/light objects (which hold no per-plan shadow data once the plan group is
  disposed).

## Edge Cases

1. **Empty plan (`_bounds === null`).** `_fitShadowCamera` uses the small fixed-origin frustum
   fallback (`radius ≈ 4`); no geometry casts or receives, so the ground is simply
   unshadowed. No NaN, no crash (mirrors `_viewPose`'s `diag=8` branch).
2. **Off-origin plan.** The light is positioned relative to the **bounds centre** and aims at
   it (Approach §4), so the plan is shadowed from a consistent angle regardless of world
   position — fixes the latent issue that the old fixed `position (1,1.4,1)` only lit plans
   near the origin correctly. Verify a plan drawn far from origin still shows a correct contact
   shadow.
3. **Very large / deep plan.** The ortho frustum is derived from the bounds diagonal, so it
   scales with the plan; a large plan spreads 1024² over more area → softer/coarser shadow,
   which is acceptable (still a grounding cue). No clipping, since the frustum encloses the
   full bounds + margin. No dynamic map-size bump (deploy-cheap).
4. **Item taller than the ceiling** (wardrobe/bookshelf vs `CEILING_M`). The frustum `far`/top
   is derived from `_bounds.maxZ` which already includes `max(z1, CEILING_M)` (LLD 130), so a
   tall item is inside the shadow frustum and casts correctly.
5. **Rug / flat decal.** Zero-thickness sheet: `castShadow` stays **false** (a flat sheet casts
   no meaningful contact shadow and could self-shadow / z-fight), `receiveShadow` true so
   furniture shadows fall across the rug (Approach §3). The existing ~2 mm lift (LLD 130
   Edge Case 6) still avoids z-fighting with the slab.
6. **HiDPI / mobile fill-rate.** The added shadow depth pass is bounded by the 1024² map and
   the existing `setPixelRatio ≤ 2` cap. On a very weak GPU the extra pass is the main new
   cost; it is paid only on frames already drawn (interaction/tween), so idle cost is zero.
   No adaptive downscale in this cut (would be a future perf follow-up if QA finds jank).
7. **WebGL context loss / restore.** On restore, `_buildPlanGroup` + `frame()` already re-run
   (LLD 130 Edge Case 11); `_fitShadowCamera` runs inside `_buildPlanGroup`, so the shadow
   camera is re-fit on restore automatically. `shadowMap.enabled/type` live on the renderer,
   which is re-created only on hard `dispose()`; the context-restore path reuses the same
   renderer so the shadow flags persist. No extra handling.
8. **PNG / SVG export & share.** `exportImg.js` rasterizes the **2D SVG** (`exportImg.js:271`
   draws an SVG-derived `img` onto a 2D canvas) — it does **not** read the WebGL `#stage3d`
   canvas. So the shadow change **cannot break or slow the export/share render**: export never
   touches the 3D scene, and enabling the shadow map does not alter default (non-preview) load
   because three.js is still lazy-loaded only on preview entry (LLD 130 §9). This satisfies the
   selection-note requirement to coordinate with the export path — the paths are disjoint, so
   there is no interaction to break. (If a future issue adds WebGL-canvas capture to export, it
   must set `preserveDrawingBuffer` / render-on-demand itself; out of scope here.)
9. **Fallback (WebGL unavailable / import failed).** The 2.5D SVG fallback has no lighting or
   shadow model; nothing to do. All shadow setup lives after the `webglAvailable()` gate and
   inside the three.js-loaded path, so the fallback is byte-for-byte unaffected.
10. **Peter-panning on thin walls.** Walls are thin extruded slabs — the classic peter-panning
    trigger. Handled by `normalBias` (Approach §5); the implementer must verify wall bases stay
    visually attached to the floor after tuning, on a plan with both walls and furniture.
11. **Transparent floor slab as receiver.** The slab is `opacity:0.5` (LLD 130 §5). A
    transparent Lambert receiver still shows received shadows in three.js; verify the soft
    shadow is visible on the semi-transparent slab and does not vanish or double-darken. If
    tuning reveals the transparent receiver drops the shadow on the target three version, the
    minimal remedy is a dedicated opaque-ish shadow-catcher — but the default expectation
    (and the design) is that the transparent slab receives correctly; do not add a catcher
    speculatively.

## Dependencies

### Depends on (shipped)

- **LLD 130 / #124** (true 3D preview) — merged. Provides `render3d.js`, `render3dEngine.js`,
  the `WebGLRenderer`, the single `DirectionalLight`, `_ensureEngine`, `_makeBoxMesh`,
  `_makeFlatMesh`, `_buildPlanGroup`, `_bounds`, and the material cache this cut extends.
- **LLD 152 / #150** (reset-view / presets) — merged. No interaction beyond sharing
  `render3d.js`; the tween/reset paths are untouched (they just draw frames, which now include
  the shadow pass).

### Existing code touched

- **`render3d.js`** — `_ensureEngine` (shadow map + light cast + store `_dirLight` + add
  target), `_makeBoxMesh` / `_makeFlatMesh` (cast/receive flags), `_buildPlanGroup` (call
  `_fitShadowCamera`), new `_fitShadowCamera` helper + shadow constants, `dispose` (null
  `_dirLight`).
- **`render3dEngine.js`** — add `PCFSoftShadowMap` (and `OrthographicCamera` if referenced) to
  the static import + re-export list.

### No new dependency

**No new npm package.** `three` is already a dependency (LLD 130); shadows use only classes /
constants already in the tree-shaken bundle. No new module, no new chunk. Vite build unaffected
apart from a few bytes for the added constant re-export (must stay within the LLD 130 §9
~150 KB lazy-chunk budget — re-measure on build).

### Explicitly NOT touched

`exportImg.js` (export rasterizes SVG, not the WebGL canvas — Edge Case 8), `preview.js`,
`isoRender.js`, `main.js`, `index.html`, `help.js`, `theme.js`, the 2D editor, and the plan
schema.

## Test Requirements

Mirror LLD 130 / 152: WebGL is not reliably GPU-testable headless, so the shadow **pixels** are
manual-QA only. Automated tests assert the **wiring and invariants** that can be checked without
a GPU. Tests in `test/tests.html` (`describe`/`it`/`expect`) unless noted.

### Unit — pure layer unchanged (regression guard)

- `buildSceneDescriptors` output shape is **unchanged** — no new descriptor field for shadows.
  Re-run the existing LLD 130 descriptor tests as-is; they must still pass (proves the pure
  layer/tests were not perturbed by deriving cast/receive from `kind` at mesh time).

### Behavior — shadow wiring (drives the built app; WebGL-gated like LLD 130)

Expose minimal test-only accessors if needed (e.g. `__shadowEnabled()` returning
`_renderer.shadowMap.enabled`, and a probe for `_dirLight.castShadow` / a sampled mesh's
`castShadow`/`receiveShadow`), mirroring the existing `__hasRenderer`/`__liveGeometryCount`
idiom. With WebGL available:

- After entering preview, `renderer.shadowMap.enabled === true` and
  `renderer.shadowMap.type === PCFSoftShadowMap`.
- The single directional light has `castShadow === true`, `shadow.mapSize` is `1024×1024`, and
  `bias`/`normalBias` equal the tuned constants. There is still exactly **one**
  `DirectionalLight` and **one** `AmbientLight` in the scene (no extra lights added).
- A wall/furniture mesh has `castShadow === true && receiveShadow === true`; the floor-slab
  mesh has `castShadow === false && receiveShadow === true`; a rug mesh has
  `castShadow === false && receiveShadow === true`.
- **Shadow-camera fit:** after entry with a non-empty plan, the directional light's
  `shadow.camera` ortho frustum encloses the scene bounds (assert `left ≤ minSceneX` and
  `right ≥ maxSceneX` etc. within margin, and `far` exceeds the light→far-corner distance) —
  proves `_fitShadowCamera` tracked `_bounds`. Empty plan → finite fallback frustum, no NaN.
- **No error on entry/exit/re-entry** with shadows on; `__liveGeometryCount()` still returns to
  0 across on/off cycles (teardown unaffected) and the renderer is reused (`__hasRenderer`).

### Behavior — read-only preserved

- Toggling preview on/off with shadows enabled leaves `walls.model` / `symbols.model` deeply
  equal to their pre-toggle snapshots (extends the LLD 130 read-only assertion — shadows add no
  mutation).

### Behavior — export unaffected

- PNG/SVG export produces the same SVG-rasterized output whether or not the 3D preview has been
  entered (export reads the SVG, not `#stage3d` — Edge Case 8). Assert an export run does not
  reference/read the WebGL canvas and completes without entering the 3D path.

### Build-smoke — bundle guardrail (`build-smoke.mjs`)

- The LLD 130 assertion still holds: entry `dist/index.html` + eager chunks do **not** statically
  reference `three`; `three` (with the added shadow constant) stays in the lazy chunk. Re-measure
  the lazy chunk stays within the ~150 KB budget.

### Manual QA (no headless GPU) — the visual acceptance

- Furniture and walls cast a **soft-edged** contact shadow onto the floor; a sofa reads as
  sitting *on* the floor, not floating (the depth-read the issue targets).
- **No shadow acne** (moiré on lit faces) and **no peter-panning** (shadows detached from wall
  bases) after bias/normalBias tuning, on a plan containing both walls and furniture.
- Shadow direction stays consistent while orbiting and for an **off-origin** plan (Edge Case 2).
- **Perf:** orbiting stays smooth (no new stutter vs pre-shadow build) on a mid-range laptop and
  a phone; idle (no interaction) uses no CPU/GPU (no new rAF).

### Not tested (out of scope)

Pixel-level shadow correctness / visual regression (no headless GPU guarantee), exact
bias/softness values, hard-shadow (option B) rendering, AO/IBL/textures (all out of scope).
