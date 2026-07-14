# LLD 142: Per-room preview scoping + door/window opening height fidelity

Parent: #101 · Order 2 of 4 · Effort: medium
Depends on: LLD 130 (true 3D preview via three.js — `render3d.js` / `render3dEngine.js`), shipped in #135.

## Scope

Supervised rework of the just-merged **three.js** renderer (`render3d.js`, LLD 130) — **not**
a from-scratch feature and **not** the retired 2.5D `isoRender` path. Two coupled deliverables
share one data source (`buildItems()` → `buildSceneDescriptors()`):

1. **Per-room preview scoping.** Let the user preview a single room's extruded volume instead
   of the whole plan. This is a **pure projection filter** over the live 2D models feeding the
   scene build — there is **no state fork** of `walls.model`/`symbols.model`. Whole-plan preview
   stays the default and remains available.

2. **Door/window opening height fidelity.** Give openings realistic sill/head heights and render
   them as recesses/reveals in the extruded walls, so a wall reads as a wall-with-opening rather
   than a solid slab. This is the fix for a live bug (below): `buildItems()` currently emits
   openings as floor-up solid boxes.

**In scope**

- New **catalog** `sill`/`head` fields for `door` and `window` (salvaged from closed PR #134:
  door `sill:0, head:2.03`; window `sill:0.9, head:2.1`). Constants, not per-instance plan data.
- `buildItems()` opening fix: openings emit `z0 = sill`, `z1 = head` (today they emit `z0:0`,
  `z1 = cat.z`, mis-classified as `kind:"furniture"`, so a window is a floor-up slab).
- A new `kind:"opening"` descriptor class from `buildSceneDescriptors()`, consumed in the SAME
  increment by `render3d.js`: doors as a **see-through cut** through the parent wall over
  `[sill, head]`; windows as a **recessed/lighter or translucent reveal** floating in
  `[sill, head]`. No dead data.
- **Scope state** (`getScope`/`setScope`) added to `preview.js` + a **scope popover/caret** on the
  `#tool-preview` toggle (Frontend Option A). UX is salvaged from PR #134 but the wiring is
  re-pointed at `render3d`, not `isoRender.render()`.
- `symbolBelongsToRoom(room, sym)` (re-added; salvaged from PR #134) to decide which openings +
  furniture project when a single room is scoped.
- Per-room **camera re-framing** (reuse `frame()` against the scoped bounds) and an **empty state**
  for a scoped room that has no closed walls.
- SVG/geometry-structural tests for scoping and opening cut-outs.

**Explicitly OUT of scope (guards)**

- Still **extruded flat-matte boxes** — no textures, no materials beyond the LLD 130 Lambert,
  no realistic lighting/shadows, no 3D furniture models. Windows may use one translucent
  material; that is the ceiling.
- Still **read-only**; still **no new dependency and no new build step** (three.js already added
  by LLD 130).
- Still **view-only in-app** — export/share of the preview is a separate follow-up (#123).
- **No new persisted plan data.** `sill`/`head` are catalog constants and round-trip for free.
  Scope selection is **session-only** (like `preview._active`), never persisted.
- No per-room ceiling override; whole-plan `CEILING_M` is retained.
- The old `isoRender.render()` fallback painter keeps LLD 130's flush-box opening behaviour — the
  fidelity work targets the WebGL path only (the current preview path). See Edge Case 10.

## Approach

### 1. Opening height fix — catalog data + `buildItems()` (the core bug)

**The bug.** `buildItems()` (`isoRender.js:300-334`) treats every non-rug symbol identically:
`z0:0`, `z1 = cat.z ?? 0.75`, `kind:"furniture"`. For a window (`cat.z = 1.20`) that produces a
solid box from the floor (0) to 1.20 m — a floor-up slab, not a window. Doors (`cat.z = 2.03`)
are a floor-to-head slab. Neither reads as an opening.

**Catalog change (`symbols.js`).** Add two optional numeric fields to the two `openings:true`
catalog entries (salvaged from PR #134):

| type | `sill` (m) | `head` (m) | notes |
|---|---|---|---|
| `door` | `0` | `2.03` | full-height gap, floor to head |
| `window` | `0.9` | `2.1` | realistic sill; the default sill MUST be 0.9, not 0 |

`z` is left on both entries unchanged (still used by the `isoRender` fallback painter and any
non-3D consumer); the 3D path reads `sill`/`head` when present. The `head` value equals the old
`door.z` (2.03) by design; `window.head` (2.1) is a small, deliberate bump over the old `z` (1.20,
which was actually the sill-to-nothing height, hence the bug).

**`buildItems()` change.** For symbols whose catalog entry is an opening (`cat.openings === true`),
emit `z0 = cat.sill ?? 0`, `z1 = cat.head ?? cat.z`, and tag the item `kind:"opening"` (a new item
kind, distinct from `"furniture"`). Non-opening furniture is unchanged (`z0:0`, `z1 = cat.z`,
`kind:"furniture"`). Rugs and walls unchanged. The `?? 0` / `?? cat.z` fallbacks mean an old plan
or a hand-authored catalog without the new fields still produces a sane box — but the shipped
catalog always has them, so there is no dead-default path in practice.

Rationale for a new `kind` rather than overloading `"furniture"`: the renderer needs to treat an
opening as a **subtraction from / reveal inside a wall**, which is categorically different from a
free-standing box. A distinct kind keeps `buildSceneDescriptors` and the mesh factory honest and
keeps the tests legible.

### 2. Opening geometry in `render3d.js` — cut, don't extrude a solid box

The clarified requirement: **subtract the opening band `[sill, head]` from the parent wall
segment** (or split the wall into two pieces around it) rather than extruding the opening as its
own solid box. Two candidate implementations were considered:

| Option | Verdict |
|---|---|
| **A. CSG boolean subtract** the opening prism from the wall mesh | Rejected. Needs a CSG library (new dependency, out of scope) or hand-rolled BSP — heavy, fragile, and overkill for axis-aligned rectangular gaps. |
| **B. Split the wall segment into pieces around the opening's along-wall span, and cap the band** (chosen) | No new dependency. A wall edge that hosts an opening is emitted as up-to-three boxes: the left pier, the right pier, and a **lintel** above the opening (`[head, CEILING_M]`) plus, for a window, a **sill wall** below (`[0, sill]`). The door's gap is genuinely see-through (no geometry in `[0, head]` over the opening's width); the window's opening band `[sill, head]` gets a thin translucent/lighter **reveal** pane so it reads as glazing. |

**Why B is tractable here.** Openings are placed flush on a wall (the editor's wall-flush snapping,
LLD 26). For the preview we do **not** need a perfect boolean against an arbitrarily-angled wall;
we need the wall to visibly break at the opening. The chosen construction, done per wall edge in
the descriptor builder:

1. For each closed-room wall edge, find openings that belong to it (see §3 association).
2. Project each hosted opening's center + width onto the edge's along-axis to get a 1-D span
   `[t0, t1]` on the edge. Clip to the edge.
3. Emit the wall as boxes for the **complementary** spans (piers) at full height `[0, CEILING_M]`,
   plus a **lintel** box spanning `[t0, t1]` over `[head, CEILING_M]`, plus (windows only) a
   **sill** box spanning `[t0, t1]` over `[0, sill]`. The band `[sill, head]` (door: `[0, head]`)
   is left open.
4. For a **window**, additionally emit an `kind:"opening"` descriptor for the reveal pane: a thin
   box (or single quad) filling `[t0,t1] × [sill,head]` at the wall's centerline, flagged so the
   mesh factory gives it the translucent/lighter material. A **door** emits no pane (pure gap).

This "split the wall" work happens in the **pure** `buildSceneDescriptors` layer (or a pure helper
it calls), so it is headless-testable via the descriptor list — no GPU needed to assert "the wall
has a gap in the right height band."

**Simplicity guard.** If an opening's span cannot be resolved to a host edge (association fails),
fall back to the LLD 130 behaviour for that symbol: emit a single box `[sill, head]` tagged
`kind:"opening"` at the symbol footprint. It still lands at the correct height band (fixing the
floor-slab bug) even without a clean wall cut. This keeps the core bug fixed unconditionally.

### 3. Opening → wall association (`symbolBelongsToRoom` + edge projection)

Splitting a wall needs to know which openings sit on which edge, and scoping needs to know which
symbols belong to a room. Re-add `symbolBelongsToRoom(room, sym)` (salvaged from PR #134) — it is a
pure predicate: an opening/furniture symbol belongs to a room when its center is inside the room
polygon (`pointInRoom`, reused from `clearance.js`) OR, for openings specifically, when it lies on
one of the room's wall edges within a small tolerance (openings sit *on* the boundary, so a strict
inside-test would miss them). The edge-hosting test reuses the along/normal projection already used
by `nearestWallFlush` (`symbols.js`): an opening hosts on edge `(a,b)` when its center's normal
distance to the centerline is `≤ WALL_M/2 + ε` and its along-projection overlaps the edge span.

For the wall-split (§2), the same edge-projection yields the `[t0, t1]` along-span per opening.

### 4. Per-room scoping — a pure projection filter, no state fork

**Decision: scoping is a filter applied while building descriptors, not a separate model.** The
live `walls.model` / `symbols.model` are never copied or mutated. `render3d._buildPlanGroup()`
already calls `buildItems(wallsModel, symbolsModel)` then `buildSceneDescriptors(...)`. Scoping
inserts a filter between "live models" and "buildItems":

- Read the current scope from `preview.getScope()` → either `null` (whole plan) or a room id.
- If a room id is set, resolve the room from `walls.model.rooms`. Build a **filtered view** of the
  models (plain objects, not mutations): `{ rooms: [thatRoom], chain: [] }` for walls, and
  `{ symbols: symbols.filter(s => symbolBelongsToRoom(room, s)) }` for symbols.
- Pass the filtered views to `buildItems`. Everything downstream (descriptors, bounds, meshes,
  camera framing) is unchanged and operates on the scoped subset for free.

Because `buildItems`/`buildSceneDescriptors` are already **pure functions of their model
arguments**, the filter is the entire mechanism — no new rendering path, no scene-diffing. Bounds
computed from the scoped descriptors drive `frame()`, so the camera re-frames to just that room
(§Frontend). This is the "pure projection filter" the selection mandates.

The filtered-view construction lives in a small pure helper (e.g. `scopeModels(wallsModel,
symbolsModel, scope)` in `render3d.js`) so it is unit-testable headless: "given scope=roomB, only
roomB's walls/floor and roomB's symbols appear in the descriptors."

### 5. Rebuild on scope change

Scope is changed only from the scope popover, which is only reachable while preview is active. On
`setScope(id)`, `preview.js` fires its existing `onChange` listeners. `main.js` gains one branch:
if preview is active and the change was a scope change, call a lightweight `render3d.rebuild()`
(dispose `_planGroup`, rebuild from the now-scoped models, `frame()`, render once) instead of a
full `enter()`/`exit()`. Since the 2D editor is inert during preview (LLD 130 §8), the models can't
change underneath us; rebuild-on-scope-change is a pure recompute, mirroring rebuild-on-entry.

To avoid a second `onChange` overload, `preview.js` distinguishes the two transitions: `setActive`
toggles `_active` (enter/exit); `setScope` changes `_scope` (rebuild). The `onChange` callback in
`main.js` reads both and dispatches: active-edge → `enter()`/`exit()`; scope-edge while active →
`rebuild()`. (Alternative: a separate `onScopeChange` emitter — rejected as more surface for one
extra transition.)

### 6. Camera re-framing on scope

`frame()` (LLD 130) already fits the camera to `_bounds`, and `_bounds` is recomputed by
`_buildPlanGroup()` from the current descriptors. Because scoping filters the descriptors, the
scoped bounds are simply the selected room's extent, so calling `frame()` after a scoped rebuild
re-frames to that room with the existing ~10-15% margin — no new framing math. Per the thread's
"note the comments on reframe": re-framing is automatic on every scope change (including back to
whole-plan), so the user always sees the scoped subject filled to the viewport.

### 7. Empty state — scoped room with no closed walls

A user can scope to a room that has no closed walls contributing geometry (e.g. an open room, or a
degenerate one). After filtering, `buildItems` yields no wall boxes and `buildSceneDescriptors`
yields `bounds === null` (LLD 130 already returns null for an empty descriptor set). `frame()`
already handles null bounds with a default origin camera (LLD 130 Edge Case 4), so there is no
crash. On top of that, show a **non-blocking empty-state overlay** ("This room has no walls to
preview") so the user understands the empty stage rather than seeing a blank canvas — reuse the
loading-element idiom (`#preview-loading`) styling. The overlay is shown when a scope is set AND the
scoped descriptor set is empty; hidden otherwise.

## Frontend Design

**Decision: Option A (settled — do not re-open).** A **scope popover** anchored to a small caret on
the `#tool-preview` toggle, with **"Whole plan" pinned at the top** and one entry per closed room
below it. Rejected alternatives (per-room toggle buttons in the rail; a separate scope dropdown in
a toolbar) added chrome for a secondary control; the caret keeps scoping subordinate to the single
preview affordance.

- **Affordance.** The existing `#tool-preview` button is unchanged for the primary toggle (click /
  `P` / `Esc` still enter/exit whole-plan preview). A small **caret** on the button opens the scope
  popover. The popover only makes sense while preview is active, so opening it also ensures preview
  is on (entering if needed). Whole-plan preview remains the default when preview is first entered
  (scope defaults to `null`).
- **Popover contents.** A short list: **"Whole plan"** (pinned top, selected by default) then each
  closed room labelled by its name/id (reuse whatever room label the 2D editor shows; fall back to
  "Room N" by index). The current scope is marked (checkmark / `aria-current`). Selecting an entry
  calls `preview.setScope(id | null)` and closes the popover. Rooms list is derived from
  `walls.model.rooms.filter(r => r.closed)` at popover-open time.
- **Reframe (thread comment).** Every scope selection **re-frames the camera** to the chosen subject
  (§Approach 6) — selecting a room flies/fits to that room; selecting "Whole plan" fits the whole
  plan. Reframe is immediate and automatic; there is no manual "fit" button. This is the primary
  feedback that a scope change took effect.
- **Feedback (thread comment).** Beyond the reframe, surface the active scope explicitly so the user
  isn't confused about why only one room shows: reflect the current scope as a **label/pill** on or
  beside the preview control (e.g. the button's `aria-label` / a small text pill reads "Room 2" vs
  "Whole plan"). When a scoped room is empty (§Approach 7), the empty-state overlay is the feedback.
- **Accessibility.** The caret is a real button with `aria-haspopup="menu"`, `aria-expanded`; the
  popover is a menu with `role="menu"`/`menuitem`, keyboard navigable, `Esc` closes the popover
  (distinct from `Esc` exiting preview — popover-`Esc` is handled first when the popover is open).
- **Unchanged:** the `P` shortcut, the active-ring `aria-pressed` style, the loading indicator, and
  the WebGL-unavailable fallback toast all behave exactly as LLD 130. No new rail buttons.

## Interfaces / Types

### `symbols.js` — catalog additions (data only)

```js
// door entry gains:  sill: 0,   head: 2.03
// window entry gains: sill: 0.9, head: 2.1
// Typedef extended:
//   { ..., z:number, sill?:number, head?:number, presets?:SymPreset[] }
// sill/head are OPTIONAL and present only on openings (openings:true).
```

No new functions in `symbols.js`; `createSymbol`/`resizeSymbol`/serialization are untouched
(sill/head are catalog constants, never copied onto `Sym` instances).

### `clearance.js` (or a shared geometry module) — re-added pure predicate

```js
/**
 * True if a symbol belongs to a room for preview scoping.
 * - Non-opening symbols: center strictly inside the room polygon (pointInRoom).
 * - Openings (CATALOG[sym.type].openings): center inside OR hosted on one of the
 *   room's wall edges within WALL_M/2 + ε (openings sit ON the boundary).
 * Pure; no global reads. Salvaged as-is from closed PR #134.
 * @param {import("./walls.js").Room} room
 * @param {import("./symbols.js").Sym} sym
 * @returns {boolean}
 */
export function symbolBelongsToRoom(room, sym);
```

### `isoRender.js` — `buildItems()` opening branch

```js
// New item kind in the JSDoc union: "wall"|"furniture"|"rug"|"opening".
// For a symbol whose CATALOG entry has openings === true:
//   kind: "opening",
//   z0:   cat.sill ?? 0,
//   z1:   cat.head ?? cat.z,
//   footprint: corners(sym),      // unchanged
//   baseColor, sortKey            // unchanged
// Non-opening furniture unchanged (kind:"furniture", z0:0, z1:cat.z).
```

### `render3d.js` — descriptors, scoping, opening geometry

```js
/**
 * MeshDescriptor kind gains "opening". An opening descriptor is a thin reveal
 * pane (windows) OR is absent (doors — pure gap). Wall descriptors hosting an
 * opening are split into pier/lintel/sill boxes (all kind:"wall").
 * @typedef {{
 *   kind: "wall"|"furniture"|"rug"|"floor"|"opening",
 *   footprint: {x:number,y:number}[],
 *   z0:number, z1:number, color:string, flat:boolean,
 *   translucent?:boolean          // opening reveal pane → translucent/lighter material
 * }} MeshDescriptor
 */

/**
 * Build filtered (scoped) VIEWS of the live models — pure, no mutation.
 * scope === null → returns the models unchanged (whole plan).
 * scope === roomId → { walls:{rooms:[room],chain:[]}, symbols:{symbols:[…belongs]} }.
 * @param {{rooms:Room[],chain:any[]}} wallsModel
 * @param {{symbols:Sym[]}} symbolsModel
 * @param {string|null} scope
 * @returns {{ walls:{rooms:Room[],chain:any[]}, symbols:{symbols:Sym[]} }}
 */
export function scopeModels(wallsModel, symbolsModel, scope);

/**
 * Split a wall edge that hosts openings into pier/lintel/sill boxes + reveal
 * panes. Pure; returns descriptor fragments. Called by buildSceneDescriptors.
 * @param {{a:{x,y},b:{x,y}}} edge  wall centerline
 * @param {{sill:number,head:number,along:[number,number],isDoor:boolean}[]} openings
 * @param {number} ceilingM
 * @param {string} wallColor
 * @returns {MeshDescriptor[]}
 */
function _splitWallForOpenings(edge, openings, ceilingM, wallColor);  // internal

// buildSceneDescriptors gains a signature param for the opening/scoping data it
// needs — it already takes (items, wallsModel, floorColor); it additionally
// receives the symbol model (for opening→wall association) OR the association is
// precomputed and threaded via the items. Implementation detail; pure either way.

/** Rebuild the plan group from the current (scoped) models, reframe, render once.
 *  Used on scope change while preview is active (cheaper than exit()+enter()). */
export function rebuild();
```

`initRender3d`, `enter`, `exit`, `frame`, `resize`, `dispose`, `webglAvailable`, `worldToScene`
keep their LLD 130 signatures. `_buildPlanGroup()` internally calls `scopeModels(...)` before
`buildItems`.

### `preview.js` — scope state (session-only)

```js
/** @returns {string|null} current scope: null = whole plan, else a room id. */
export function getScope();

/** Set the scope (room id or null). Fires onChange if changed. Session-only. */
export function setScope(scopeOrNull);

// isActive()/setActive()/toggle()/onChange() unchanged. On setActive(false),
// scope resets to null so re-entry starts whole-plan (deliberate).
```

### `main.js` — wiring (extends the LLD 130 preview block)

- The single `previewOnChange` listener dispatches on which transition fired:
  active-edge → `render3d.enter()` / `render3d.exit()` (as today); scope-edge while active →
  `render3d.rebuild()`. Track the previous `_active`/`_scope` to detect the edge.
- Build the scope popover DOM (caret button + menu), populate from
  `walls.model.rooms.filter(r => r.closed)` on open, wire menuitem clicks to `preview.setScope`.
- Toggle the empty-state overlay based on `render3d`'s reported empty scoped set (a boolean return
  from `rebuild()`/`enter()`, or a `render3d.__isEmpty()` probe).

### `index.html`

- Add the scope **caret button** + **popover menu** markup near `#tool-preview`, and an
  **empty-state** element (`#preview-empty`, `hidden`) inside `#stage` (styled like
  `#preview-loading`). CSS for the popover and empty-state.

## State Model

### Persisted plan state — no schema change

Like LLD 128/130, this cut adds **no plan data**. `sill`/`head` live on `CATALOG` (code, not plan
data), exactly as `z` does. Consequences the acceptance criteria call out:

- **localStorage / JSON export / share hash:** unchanged shape. No `PLAN_SCHEMA` bump, no new
  `validatePlan` field. The new opening heights round-trip "for free" because they are catalog
  constants keyed by `sym.type`, which already round-trips.
- **Old plans load on defaults:** a plan saved before this change has the same `symbols[].type`
  values; on load, the current catalog supplies `sill`/`head`, so old doors/windows immediately
  render at correct heights with no migration. The `?? 0` / `?? cat.z` fallbacks in `buildItems`
  mean even a catalog entry lacking the fields degrades to a sane box.

### Session-only view state (never persisted)

- `preview._active` — unchanged from LLD 130.
- `preview._scope` — **new**: `null` (whole plan) or a room id. Transient; reset to `null` on load
  and on `setActive(false)`. Never serialized (a shared link opening scoped to one room is a future
  consideration, not this cut).
- `render3d` internals (`_renderer`/`_scene`/`_camera`/`_controls`/`_planGroup`/`_materialCache`/
  `_bounds`) — unchanged lifecycle; `_planGroup`/`_bounds` now reflect the scoped subset when a
  scope is set.

### In-memory vs computed

- **Source of truth:** `walls.model`, `symbols.model` — never mutated or forked by scoping. The
  scoped views built by `scopeModels()` are throwaway plain objects that reference the same room /
  symbol instances read-only.
- **Computed on entry / scope change:** scoped model views → items → descriptors → geometries →
  camera frame. All recomputed from live models; disposed on exit. Rebuild-on-scope-change is a
  pure recompute (§Approach 5), matching LLD 130's rebuild-on-entry model.

## Edge Cases

1. **Old plan without sill/head awareness.** Catalog supplies the fields by `type`; no migration.
   `buildItems` `?? 0`/`?? cat.z` fallbacks cover a catalog entry missing them. (State Model.)
2. **Opening not associated to any wall edge** (placed off-wall, or association tolerance missed).
   Fall back to a single box `[sill, head]` tagged `kind:"opening"` at the symbol footprint — still
   at the correct height band (bug fixed), just not cut into a wall (§Approach 2 simplicity guard).
3. **Opening wider than its host wall edge** / hanging off the end. Clip the along-span `[t0,t1]` to
   the edge; piers on the clipped side may be zero-width and are dropped (degenerate footprint,
   already skipped by `_isRenderable`).
4. **Two openings overlapping on one edge** (unusual, e.g. a door and window snapped together).
   Merge/union their along-spans before splitting so piers/lintels don't overlap or produce
   zero-width slivers. If merged span covers the whole edge, no full-height pier remains — only
   lintel/sill — which is correct.
5. **Door with sill 0.** The gap runs `[0, head]`; there is no sill box, only piers + a lintel
   above. No reveal pane (pure see-through gap).
6. **Window sill ≥ head or head > CEILING_M.** Defensive: if `sill ≥ head`, treat as a degenerate
   opening → skip the band cut, emit nothing for the pane (wall stays solid there) to avoid inverted
   geometry. If `head > CEILING_M`, clamp the lintel to zero height (no lintel) — the opening runs
   to the ceiling. (Shipped values `0.9/2.1` vs `CEILING_M 2.4` don't hit this; it's a guard.)
7. **Scope set to a room id that no longer exists** (room deleted between popover-open and select —
   can't happen mid-preview since the editor is inert, but guard anyway). `scopeModels` resolves the
   room by id; if not found, treat scope as `null` (whole plan) and optionally reset
   `preview._scope`.
8. **Scope to an open / wall-less / degenerate room.** Filtered descriptors are empty →
   `bounds === null` → default origin camera (LLD 130 EC4) + empty-state overlay (§Approach 7). No
   crash.
9. **Scoped room's symbols that straddle two rooms** (an opening on a shared wall). `symbolBelongsToRoom`
   returns true for both rooms' scopes (the opening hosts on the shared edge) — the opening appears
   in either scope, which is the intuitive result. Furniture is assigned by strict interior test, so
   it appears in exactly one scope.
10. **WebGL-unavailable fallback path.** The `isoRender.render()` 2.5D fallback painter is NOT
    updated for opening cut-outs in this cut — it keeps LLD 130's flush-box behaviour. Scope is also
    not applied to the fallback (it renders whole-plan). This is an accepted limitation: the fallback
    is a rare degraded path; the fidelity work targets the primary WebGL path. Noted so QA doesn't
    file it as a regression.
11. **Rapid scope switching.** `rebuild()` disposes `_planGroup` and rebuilds; repeated switches must
    not leak geometries/materials (same disposal discipline as LLD 130 exit). Covered by the
    live-geometry-count teardown probe.
12. **Theme switch** — same as LLD 130 EC10: editor (and theme toggle) hidden during preview, so no
    live recolor path; colors re-derive on next entry.
13. **Popover open while preview toggled off via `P`/`Esc`.** Closing preview resets scope to null
    and should close/hide the popover; `Esc` precedence: popover-open → close popover; else → exit
    preview.

## Dependencies

### Must exist before implementation (all shipped)

- **LLD 130 / #135** — the three.js `render3d.js` / `render3dEngine.js` WebGL preview. This LLD
  **reworks that renderer**; it is the target, not `isoRender`. Provides `buildSceneDescriptors`,
  `worldToScene`, `_buildPlanGroup`, `frame`, `enter`/`exit`, the `#stage3d` canvas, the
  `#tool-preview` toggle, and `preview.js`.
- **LLD 128 / #121** — `buildItems`, `CATALOG[type].z`, `CEILING_M`, `corners(sym)`,
  `pointInRoom` (in `clearance.js`), the wall-flush projection math in `symbols.js`
  (`nearestWallFlush`), `WALL_M`/`MIN_SEG_M`.
- **#102** — Vite build; no new dependency added by this cut.

### Salvaged from closed PR #134 (reuse as-is where noted)

- `door`/`window` `sill`/`head` catalog fields (door `0/2.03`, window `0.9/2.1`).
- `symbolBelongsToRoom(room, sym)` predicate.
- `preview.js` scope state (`getScope`/`setScope`) + the scope-pill / popover UX — reuse the UX,
  **re-point the wiring at `render3d`** (not `isoRender.render()`).

### Existing code reused / touched

- `symbols.js` — catalog edits (data), typedef extension. No logic change.
- `isoRender.js` — `buildItems()` opening branch; `render()` fallback unchanged.
- `render3d.js` — `scopeModels`, `_splitWallForOpenings`, `rebuild`, descriptor `kind:"opening"` +
  `translucent` handling, opening material.
- `clearance.js` — `symbolBelongsToRoom` (new export), reuses `pointInRoom`.
- `preview.js` — scope state.
- `main.js` — popover DOM + wiring, `onChange` dispatch, empty-state toggle.
- `index.html` — popover markup + CSS, empty-state element.
- **No change:** `exportImg.js` (export/share is #123), `help.js`, `walls.js`, `theme.js`,
  `view.js`, `surface.js`, `render3dEngine.js`.

No dependency on unshipped issues.

## Test Requirements

Strategy mirrors LLD 128/130: geometry logic is **pure and asserted directly on the descriptor
list** (headless, no GPU); the WebGL/DOM layer is smoke-tested. Unit tests live in
`test/tests.html`; integration tests drive the built app (`dist/index.html`) via the Playwright
runner.

### Unit — opening height (pure, `buildItems` + `buildSceneDescriptors`)

- A `window` symbol produces an item with `kind:"opening"`, `z0 === CATALOG.window.sill` (0.9),
  `z1 === CATALOG.window.head` (2.1) — **explicitly asserts the bug fix**: `z0 !== 0` and the box
  is not floor-up.
- A `door` symbol produces `kind:"opening"`, `z0 === 0`, `z1 === CATALOG.door.head` (2.03).
- Old-plan default: a catalog entry (or synthetic item) lacking `sill`/`head` falls back to
  `z0:0`, `z1:cat.z` without throwing.
- `door`/`window` catalog entries carry numeric `sill`/`head`; sanity: `0 <= sill < head`.

### Unit — opening cut-out geometry (pure, `buildSceneDescriptors` / `_splitWallForOpenings`)

- **Gap at the right height band:** a closed room with one door on an edge → the wall descriptors
  covering the door's along-span leave `[0, head]` open (no wall box spans that x-range over
  `[0, head]`); a **lintel** wall box exists spanning the door span over `[head, CEILING_M]`.
- **Window band:** a window on an edge → a **sill** wall box over `[0, sill]`, a **lintel** over
  `[head, CEILING_M]`, and an `kind:"opening"` reveal descriptor over `[sill, head]` flagged
  `translucent:true`. No solid wall box spans `[sill, head]` across the window's width.
- **Piers:** the wall edge outside the opening span is emitted at full `[0, CEILING_M]` height
  (left/right piers), and pier + lintel + sill along-spans partition the edge without overlap.
- **Association fallback:** an opening not on any edge → a single `kind:"opening"` box `[sill,head]`
  at its footprint (no wall split), still at the correct band (Edge Case 2).
- **Overlapping openings on one edge** merge spans (Edge Case 4): no zero-width sliver piers.
- **Degenerate guards:** window with `sill >= head` → no pane, wall stays solid (Edge Case 6).

### Unit — `symbolBelongsToRoom` (pure)

- Furniture centered inside a room → true; outside → false.
- An opening hosted on a room's wall edge → true even though its center is on the boundary (not
  strictly interior).
- An opening on a shared wall → true for both adjacent rooms (Edge Case 9).

### Unit — `scopeModels` + scoped descriptors (pure, no three.js)

- `scope === null` → returns models equivalent to whole-plan (all rooms' walls + all belonging
  symbols appear in descriptors).
- `scope === roomB` → **only roomB's geometry is projected**: descriptors contain roomB's wall
  boxes + floor slab + only symbols for which `symbolBelongsToRoom(roomB, …)` is true; roomA's
  walls/floor/symbols are absent.
- Scoping **does not mutate** `walls.model` / `symbols.model` (deep-equal before/after — mirrors the
  existing LLD 130 no-mutation descriptor test).
- Scoped bounds equal the selected room's extent (so `frame()` re-frames to it).
- Scope to an empty/open room → empty descriptor set and `bounds === null` (empty-state trigger).

### Integration / DOM (drives the built app)

- **Scope popover:** opening the caret lists "Whole plan" (top) + one entry per closed room;
  selecting a room sets `preview.getScope()` and triggers a `render3d` rebuild; the canvas stays
  visible; no console/page errors.
- **Reframe on scope:** after selecting a room then whole-plan, the camera target/bounds change
  (assert via a `render3d` bounds/target probe) — reframe fires on every scope change.
- **Empty-state overlay** shows when scoping a wall-less room and hides otherwise.
- **Teardown / no leak:** cycle scope changes N times; live-geometry count and WebGL context count
  do not grow (reuse LLD 130 `__liveGeometryCount`/`__hasRenderer` probes) (Edge Case 11).
- **Read-only preserved:** entering preview, scoping, and exiting leaves `walls.model` /
  `symbols.model` deep-equal to their pre-preview snapshots (carry the LLD 130 guarantee through the
  new scope path).

### Persistence / round-trip

- Save → reload a plan containing a door + window: openings render at correct sill/head with no
  schema field added (assert exported JSON has no new `symbols[]` key; heights come from catalog).
- A pre-change plan (no awareness of sill/head) loads and previews openings at correct heights
  (defaults from catalog).

### Not tested (out of scope)

Pixel-level 3D render correctness / visual regression (no headless GPU guarantee — manual QA),
opening cut-outs in the WebGL-unavailable 2.5D fallback (Edge Case 10), export/share of the scoped
or opening-fidelity view (#123).
