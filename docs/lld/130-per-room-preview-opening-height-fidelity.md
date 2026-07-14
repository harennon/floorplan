# LLD 130: Per-room preview scoping + door/window opening height fidelity

Parent: #101 · Order 2 of 4 · Effort: medium · Depends on: LLD 128 (whole-plan 2.5D preview)

## Scope

The second increment of the 3D-preview feature (#101). It layers **fidelity + scoping**
on top of the shipped whole-plan renderer (LLD 128, `isoRender.js`), **without rewriting
it**. Two paired deliverables land together (no dead data):

**In scope**

1. **Opening height fidelity (data + renderer, paired):**
   - Add optional **`sill`/`head`** height fields (metres from floor) to the `door`/`window`
     `CATALOG` entries in `symbols.js` — e.g. door `sill:0`, `head:2.03`; window `sill:0.9`,
     `head:2.1`. Existing `z` (leaf height) stays; `sill`/`head` are additive.
   - Render doors/windows as **recessed dark reveals** cut into the extruded wall at the
     correct vertical band (`sill`→`head`), consumed in the *same* increment. The opening
     is no longer a flush colored panel (LLD 128 §Edge Case 5) but reads as a wall-with-a-hole.

2. **Per-room preview scoping:**
   - A **top-center segmented scope pill** lets the user preview one room's extruded volume
     (with its openings + contained furniture) instead of the whole plan. "All" remains the
     default and preserves the LLD 128 whole-plan behaviour exactly.
   - Scoping is a **projection filter over existing geometry** — the 2D `walls.model` /
     `symbols.model` stay the single source of truth. No state fork, no per-room duplication.

3. **Preview polish:**
   - Sensible framing on entering preview / switching scope (reuse `view.fitToContent`).
   - A clear **empty state** (previewing a room with no walls, or an empty plan).

**Explicitly OUT of scope (guards)**

- Still extruded colored boxes + flat 3-shade faces only. NO textures, materials, lighting,
  shadows, gradients-as-lighting, 3D models, orbit/first-person camera, or camera rotation
  UI. (Orbit camera is #124, gated; lighting is #112 — do NOT pull either in.)
- Still read-only; the 2D editor remains the single source of truth.
- NO new runtime dependency and NO build-step change.
- Preview still does NOT appear in PNG/SVG export or the share link (that is a separate
  follow-up, #123 — this ships *before* it).
- NO per-room ceiling override (single `CEILING_M` still governs wall height).

## Approach

Everything below is **additive to the shipped `isoRender.js`** — no renderer rewrite. The
two new behaviours plug into the existing `buildItems` → `depthSort` → `render` pipeline.

### 1. Opening height data on the catalog (additive, like `z`)

Add two optional constants to the `door`/`window` `CATALOG` entries — same "type constant,
not plan data" pattern LLD 128 used for `z`, so back-compat stays a non-event:

| type | `sill` (m) | `head` (m) |
|---|---|---|
| door | 0 | 2.03 |
| window | 0.9 | 2.1 |

`z` (existing leaf height) is left in place for compatibility but is **superseded for
openings** by `[sill, head]` in the renderer. Fields are optional in the typedef; the
renderer defaults absent values (`sill ?? 0`, `head ?? cat.z`) so a future opening type
that omits them still renders.

### 2. Opening treatment — recessed dark reveal (not a boolean cut)

Frontend decision **B(a)**: an opening is painted as a **recessed dark reveal** over its
wall, not as a see-through gap (a true gap risks reading as a dropped polygon). We do **no**
2D polygon boolean subtraction — the wall box is still drawn full-height; the reveal is a
second item painted **on top of** the wall, spanning only the `[sill, head]` z-band, in a
dark recess color. The wall above a door (lintel) and above/below a window (spandrel/sill
wall) stay visible because the wall box underneath is untouched — so it reads as
wall-with-an-opening.

Mechanically, in `buildItems` an `openings`-category symbol becomes
`kind:"opening"` (instead of a normal furniture box):

- `z0 = cat.sill ?? 0`, `z1 = cat.head ?? cat.z`.
- `baseColor` = an **opaque dark recess color** derived from the theme (a heavily-darkened
  neutral, e.g. `shade(wallBase, 0.4)` composited opaque), NOT the `openings` category color.
- `sortKey = parentWallSortKey + OPENING_BIAS` where `OPENING_BIAS` is a tiny positive value
  (e.g. `1e-3`) — see the parent-wall binding below. This is the load-bearing correction over
  the naïve "opening centroid + bias" (which is wrong for off-center openings, per below).

**Parent-wall depth binding (critical).** A wall edge is emitted as a *single* item whose
`sortKey` is the **whole-edge midpoint** (`cx+cy` of the wall quad, LLD 128 `buildItems`
lines 284–295). An opening only occupies a slice of that edge, so binding the opening's depth
to *its own* footprint centroid is unsound: a door near one end of a long wall has an
`x+y` that differs from the wall midpoint by far more than `OPENING_BIAS`. When it lands on
the near-origin half of the edge its own-centroid key is **less** than the wall's, `depthSort`
paints the wall *after* (over) the reveal, and the opening is fully occluded.
(Concrete failure: room `(0,0)–(4,3)`, bottom wall midpoint sortKey `= 2`; a door centered at
`x=1` has own-centroid key `≈ 1.06 < 2`, so it paints behind the wall's visible inner face.)
This hits a large fraction of realistic (non-centered) door/window placements.

Therefore each opening is bound to the **specific wall segment it cuts**, not its own
centroid:

- During the wall loop, `buildItems` retains, per emitted wall item, its centerline endpoints
  `{a, b}` and its `sortKey` (the value already computed at LLD 128 lines 284–295).
- For each `openings` symbol, the **parent wall** is the retained wall segment minimising the
  point-to-segment distance from the opening center `(sym.x, sym.y)` to the segment `a→b`
  (same squared point-to-segment math as `walls.pointNearRoomWall`). The opening's
  `sortKey = parentWall.sortKey + OPENING_BIAS`, which guarantees the reveal sorts **immediately
  after** (paints over) the exact wall it cuts — for centered *and* off-center openings alike.
- **Fallback:** if no wall item exists (e.g. an opening dropped on an open polyline that emits
  no wall — Edge Case 2), the opening falls back to `ownCentroid + OPENING_BIAS`. It has no
  wall behind it, so ordering is moot; it simply floats at its band.

`render` handles `kind:"opening"` by calling the **existing** `extrudeFootprint(footprint,
sill, head)` and filling its faces with recess shades (top/left/right darkened further than
a normal box). No new geometry primitive. This reuses the shipped extrusion + painter path.

> The per-object centroid sort limitation from LLD 128 §4 still applies to **furniture vs.
> walls** (unchanged, unaddressed here). It does **not** apply to opening-vs-its-parent-wall,
> because openings no longer use centroid sort against walls — they inherit the parent wall's
> key + bias, which is a *guarantee* for that specific pair, off-center included. There is no
> contradiction: the guarantee is scoped to the opening/parent-wall pair, and the LLD 128
> caveat is scoped to the general furniture case.

### 3. Per-room scoping — a projection filter, not a state fork

Scope is session-only state in `preview.js`: `_scope` is `"all"` (default) or a `room.id`.
A pure `scopeFilter(wallsModel, symbolsModel, scopeId)` returns a **filtered view**
`{ rooms, symbols }` that `render` feeds into the *existing* floor-slab loop and
`buildItems`. The live models are never mutated or copied per-room.

- `scopeId === "all"` → pass the models through unchanged (exact LLD 128 behaviour).
- otherwise → `rooms` = the single closed room whose `id === scopeId` (empty if none);
  `symbols` = the symbols that belong to that room, decided by the **shared membership
  predicate** described next.

**Reuse the existing membership predicate — don't restate it.** The furniture-vs-opening
rule this needs is *already* implemented and battle-tested in
`roomTool.js._carriedSymbolsFor` (lines 265–275):

- **furniture / rug** — belongs when its center `(sym.x, sym.y)` is inside the room polygon
  (`clearance.pointInRoom(room, x, y)`, the **existing exported** ray-cast helper).
- **openings** (`CATALOG[sym.type].openings`) — sit on the boundary, so belong when near one
  of the room's walls via the existing `walls.pointNearRoomWall(room, x, y, WALL_M)`.

To avoid two copies of that rule drifting, **factor the per-symbol test out of
`_carriedSymbolsFor` into one pure exported predicate** and reuse it in both call sites:

```js
// clearance.js (already imports CATALOG from symbols.js, WALL_M from walls.js,
// pointNearRoomWall from walls.js, and defines pointInRoom locally — the natural home)
export function symbolBelongsToRoom(room, sym) {
  return CATALOG[sym.type]?.openings
    ? pointNearRoomWall(room, sym.x, sym.y, WALL_M)
    : pointInRoom(room, sym.x, sym.y);
}
```

`roomTool._carriedSymbolsFor` is refactored to call `symbolBelongsToRoom(room, sym)` per
symbol (behaviour identical — same predicate, just extracted), and `scopeFilter` filters
`symbolsModel.symbols` through the same function. One rule, one place.

**Semantics of the reused `clearance.pointInRoom`** (state precisely so the implementer
does not assume a check that isn't there): it is a plain even-odd ray-cast over `room.verts`
and does **not** inspect `room.closed`. It returns `false` for a polygon with `< 3` verts (no
edges straddle the ray), but for an *open* 3+-vert room it would still run the ray-cast against
whatever verts exist. This is harmless here because `scopeFilter` only ever passes a **closed**
room (it selects `rooms` from `model.rooms` where the room resolves as closed — see §5), so the
open/degenerate cases never reach it. Do **not** add an open/`<3`-vert guard inside the shared
helper for this feature; if such a guard is ever wanted, wrap it at the call site.

`buildItems` and the floor-slab loop are refactored minimally to accept the filtered
`{rooms}` / `{symbols}` arrays rather than reading `wallsModel.rooms` / `symbolsModel.symbols`
directly — a one-line indirection so scoping is a filter, not a branch inside the builder.

### 4. Framing + empty state

- **Framing:** on entering preview and on every scope change, `main.js` computes the
  **folded-world AABB** of the in-scope geometry via the pure `isoBounds(items)` helper and
  calls the existing `view.fitToContent(bounds, W, H)`. `items` is the **built-items list**
  (`buildItems(rooms, symbols)` output) — each item carries its `footprint` + `z0`/`z1`, which
  is exactly what the fold needs, so `isoBounds` folds each footprint corner at z0 and z1 via
  the iso projection math (no pan/zoom) and unions the results. Feeding the built items (rather
  than raw rooms/symbols) means `isoBounds` does not re-derive wall quads or opening bands — it
  reuses the geometry the renderer already builds. Because `worldToScreenIso` feeds *folded*
  coordinates through `worldToScreen`, fitting to folded bounds frames the iso scene correctly
  and reuses the shipped fit logic. Returning to "All" reframes to the whole plan.
- **Empty state:** when the in-scope filter yields no wall geometry (empty plan, or a scope
  that no longer resolves to a closed room), `render` appends a single centered SVG `<text>`
  hint (e.g. "No walls to preview") to `#iso` and returns. No crash, no boxes.

### 5. Scope integrity guards

- Scope resets to `"all"` whenever preview is turned **off**, and on load.
- If `_scope` points at a room id that no longer exists / is no longer closed (deleted,
  un-closed), `render`/the pill rebuild treat it as `"all"` (fail-safe), so a stale scope
  never blanks the preview.

## Frontend Design

Both decisions are execution calls on the visual language already set by LLD 128 / #121 — no
new brand decision. Settled: **A(a) top-center scope pill + B(a) recessed dark reveal.**

### A. Scope switcher — top-center segmented pill

- A **segmented pill** (`#preview-scope`) shown only while preview is active, positioned
  **top-center** of the stage (consistent with the view-mode chrome established in #121).
  Hidden entirely in 2D mode (same `.stage--preview` gating already used for other overlays).
- One segment per **closed room** plus a leading **"All"** segment. Each room segment shows
  the room's name/index and its **area label**, e.g. `All | Bedroom 12.2 m² | Living/Kitchen
  22.3 m²`. Area comes from `walls.roomMetrics(room).area` formatted with `units.fmtArea` +
  `areaUnitLabel()`; rooms have no name field today, so label = `Room N` by index (1-based,
  in `model.rooms` order) — keep it that simple, no new name state.
- The active segment uses the same solid-gold `aria-pressed="true"` treatment as the tool
  rail buttons. The whole control is a `role="group"` of buttons; each segment is a
  `<button aria-pressed>` with `aria-label="Preview {label}"`.
- **Overflow:** with the typical handful of rooms this fits comfortably. The pill is
  horizontally scrollable (`overflow-x:auto`, momentum scroll) for the rare ~6+ room case —
  no truncation, no dropdown. This is the accepted tradeoff from the decision.
- The pill is **rebuilt** each time preview is entered and whenever the room set changes
  while active (rooms can only change via the 2D editor, which is suppressed in preview, so
  in practice it is built once per preview session).

### B. Opening treatment — recessed dark reveal

- Doors/windows render as a **recessed dark reveal** at the correct `[sill, head]` band (see
  Approach §2). A window shows wall below the sill and above the head; a door shows the
  lintel wall above it — so the opening reads unambiguously as intentional, never as a
  missing polygon.
- Recess color is a theme-derived opaque dark neutral so it reads as shadow/depth in both
  light and dark themes. No lighting model — just precomputed darker flat shades, exactly
  like the existing 3-shade boxes.

### Interaction contract (extends LLD 128)

- Clicking a scope segment sets `preview.setScope(id)`, refits the view, and re-renders. The
  `P`/`Esc`/tool-suppression behaviour from LLD 128 is unchanged.
- Entering preview builds the pill and frames the whole plan (scope defaults to "All").
- Exiting preview hides the pill and resets scope to "All".
- No new keyboard shortcut for scope (mouse/touch on the pill only) — keeps the shortcut
  surface unchanged.

Reference mockup (behaviour only): boots into preview, `P` toggles —
`https://harennon.github.io/floorplan/per-room-preview-opening-height-fidelity.html`

## Interfaces / Types

### `symbols.js` — catalog opening-height fields

`door` and `window` `CATALOG` entries gain optional `sill`/`head` (metres). Typedef extended:

```js
/** @type {Record<SymbolType, { ...existing..., z:number, sill?:number, head?:number }>} */
// door:   { ..., z: 2.03, sill: 0,   head: 2.03 }
// window: { ..., z: 1.20, sill: 0.9, head: 2.10 }
```

No change to the `Sym` instance shape, `createSymbol`, `resizeSymbol`, or `corners()`.

### `clearance.js` — reuse `pointInRoom`, add one shared membership predicate

**No new `pointInRoom`.** `clearance.js` already exports the ray-cast
`pointInRoom(room, x, y)` (lines 169–183) — reuse it directly; `isoRender.js` can import it
with no circular-import risk (clearance.js imports only `symbols.js` + `walls.js`).
Exact semantics to rely on: plain even-odd ray-cast over `room.verts`; **does not** check
`room.closed`; returns `false` for `< 3` verts; for an open 3+-vert polygon it still runs the
ray-cast (acceptable — `scopeFilter` only passes closed rooms).

Add the single shared symbol-membership predicate (factored out of
`roomTool._carriedSymbolsFor`, see Approach §3):

```js
/**
 * True if `sym` belongs to `room`: openings by proximity to the room's walls
 * (pointNearRoomWall, WALL_M), all other symbols by center-in-polygon
 * (pointInRoom). Pure. Assumes a closed room (see pointInRoom semantics).
 * @param {Room} room
 * @param {Sym} sym
 * @returns {boolean}
 */
export function symbolBelongsToRoom(room, sym);
```

(`walls.pointNearRoomWall` already exists — used internally by the predicate.)

### `roomTool.js` — reuse the extracted predicate (no behaviour change)

`_carriedSymbolsFor` is refactored to call `clearance.symbolBelongsToRoom(room, sym)` per
symbol instead of inlining the open-coded `openings ? pointNearRoomWall : pointInRoom` test.
Identical result; single source for the rule.

### `preview.js` — add scope state (session-only)

Extends the shipped module; existing `isActive`/`setActive`/`toggle`/`onChange` unchanged.

```js
/** @returns {"all"|string} current scope: "all" or a room id */
export function getScope();
/** @param {"all"|string} scopeId  set scope; fires onChange if changed */
export function setScope(scopeId);
```

`setActive(false)` / `toggle()`-to-off must reset `_scope = "all"`. `_scope` is NOT persisted
(transient, like `_active`).

### `isoRender.js` — additive changes (NO rewrite)

```js
/** Tiny sort bias added to an opening's PARENT wall sortKey so the reveal
 *  paints just over the specific wall segment it cuts (off-center included). */
const OPENING_BIAS = 1e-3;

/**
 * Filter live models to the in-scope subset. Pure.
 * "all" → the models unchanged. A room id → that closed room + the symbols
 * belonging to it, decided by the shared clearance.symbolBelongsToRoom predicate
 * (furniture/rug by center-in-room; openings by near-wall). Imports pointInRoom /
 * symbolBelongsToRoom from clearance.js (no circular-import risk).
 * @returns {{ rooms: Room[], symbols: Sym[] }}
 */
export function scopeFilter(wallsModel, symbolsModel, scopeId);

/**
 * Folded-world AABB of the in-scope geometry for framing (pure, no pan/zoom).
 * Takes the BUILT-items list (buildItems output); folds each item's footprint
 * corner at its z0 and z1 with the iso math and returns
 * { minX, minY, maxX, maxY } in folded-world metres for view.fitToContent.
 * @param {ReturnType<typeof buildItems>} items
 * @returns {{minX,minY,maxX,maxY}|null}  null when empty
 */
export function isoBounds(items);
```

`buildItems` signature changes to accept the **filtered arrays** rather than reading the
models directly:

```js
// before: buildItems(wallsModel, symbolsModel)
// after:  buildItems(rooms, symbols)   // rooms: Room[]; symbols: Sym[]
```

Inside `buildItems`, `openings`-category symbols now emit `kind:"opening"` with
`z0=cat.sill ?? 0`, `z1=cat.head ?? cat.z`, the dark recess `baseColor`, and
`sortKey = parentWall.sortKey + OPENING_BIAS` (parent wall = the emitted wall segment nearest
the opening center by point-to-segment distance; own-centroid fallback if no wall exists — see
Approach §2). This requires the wall loop to retain each wall item's centerline endpoints and
its `sortKey` so the symbol loop can bind against them; walls are built before symbols already.
`render` gains a `case "opening"` that extrudes `[sill,head]` and fills with recess shades; the
wall box beneath is unchanged.

`render` computes `const { rooms, symbols } = scopeFilter(_wallsMod.model, _symbolsMod.model,
getScope())`, draws floor slabs from `rooms`, boxes from `buildItems(rooms, symbols)`, and the
empty-state `<text>` when `rooms` has no drawable geometry. A new `getScope` getter is passed
into `initIsoRender`.

### `main.js` wiring (mirrors LLD 128 preview wiring)

- Pass `preview.getScope` into `initIsoRender(gIso, previewIsActive, previewGetScope,
  _wallsModRef, _symbolsModRef)`.
- Build/refresh the scope pill in `_syncPreview()` when preview turns on; clear it when off.
- Pill segment click → `preview.setScope(id)` → refit → `scheduleRender()`. The refit helper
  computes the in-scope items (`buildItems(scopeFilter(...).rooms, ...symbols)`), passes them to
  `isoBounds(items)`, and calls `view.fitToContent(bounds, W, H)`.
- On preview enter (and on scope change) call the same refit helper.

### `index.html`

- New top-center `<div id="preview-scope" role="group" aria-label="Preview scope"></div>`
  (segments built by `main.js`), gated visible only under `.stage--preview`.
- CSS: pill container (top-center, scrollable), segment button + active `aria-pressed` style
  reusing tool-rail tokens; recess color custom property if theme-driven.

### `help.js`

No change — no new keyboard shortcut is added this cut.

## State Model

### Persisted plan state — back-compat (critical, same win as LLD 128)

The only new persisted-surface change is `sill`/`head` on the **catalog** (`CATALOG.door`,
`CATALOG.window`), which is **code, not plan data**. The serialized plan shape
(`walls`, `symbols[].{id,type,x,y,w,h,rot,color?}`, `measurements`, `view`, `unit`) is
**unchanged**. Consequently:

- **localStorage / JSON export (`buildPlan`/`validatePlan`/`serializePlan`):** no schema
  change, no `PLAN_SCHEMA` bump, no new `validatePlan` normalisation. Old and new plans
  validate byte-identically.
- **Share hash (`buildCompact`/`parseCompact`):** unchanged. `sill`/`head` are never written
  or read; the existing "omit `w`/`h` at catalog default" logic is untouched.
- **Old plans (no `sill`/`head` anywhere — they never had it):** resolve opening heights from
  the catalog at render time. This satisfies the "old plans load on defaults, optional-additive"
  acceptance criterion trivially, in the strongest form (the new fields live on the catalog
  definition, so absent data resolves to the default by construction).

This mirrors LLD 128 exactly: because heights are type constants, **no serialization path
changes**. The acceptance criterion "new opening-height fields round-trip through
localStorage, share hash, and JSON export with old plans loading on defaults" is met because
there is nothing new to serialize — a round-trip test asserts the symbol shape stays free of
`sill`/`head`.

### Session-only view state

- `preview._active` — existing (LLD 128), transient, reset on load.
- `preview._scope` — **new**, `"all" | <roomId>`, transient. Reset to `"all"` on preview-off
  and on load. Never serialized.
- The scope pill DOM + `.stage--preview` gating are derived from these; no other new state.

### In-memory vs computed (per render)

- **Source of truth:** `walls.model`, `symbols.model` — never mutated or forked by scoping.
- **Computed each `render()`:** `scopeFilter` result (`{rooms, symbols}`), the item list
  (incl. `kind:"opening"` items), depth sort, projected faces, and recess/box shades. The
  framing AABB (`isoBounds`) is computed on preview-enter and scope-change only. No cached 3D
  state; preview is a pure function of the current plan + scope + camera constants + view.

## Edge Cases

1. **Old plan with no `sill`/`head`.** By construction there is no per-instance opening
   height; the renderer resolves `[cat.sill ?? 0, cat.head ?? cat.z]`. No migration.
2. **Opening on a wall not part of any closed room** (e.g. a door dropped on an open
   polyline). In "All" it renders on nothing behind it (LLD 128 already omits open walls) —
   the reveal box just floats at its band; acceptable and rare. In a room scope it is
   excluded unless `pointNearRoomWall` matches a wall of the scoped room.
3. **Window sill above floor / head below ceiling.** The wall box is full-height
   (`0..CEILING_M`); the reveal spans only `[sill, head]`, so the spandrel wall above and
   the sill wall below stay painted. This is the intended "reads as a window" behaviour.
4. **Door head above the wall / opening taller than `CEILING_M`.** Reveal is clamped for
   drawing to `min(head, CEILING_M)` so it never pokes above the wall top (openings are in
   walls). Furniture is NOT clamped (LLD 128 §Edge Case 8 unchanged).
5. **Scope = room with no walls / empty plan.** `scopeFilter` returns empty `rooms`; `render`
   draws the empty-state `<text>` hint and no boxes. No crash.
6. **Stale scope id** (scoped room deleted or un-closed via 2D then re-entering preview, or a
   loaded plan). `scopeFilter`/pill treat an unresolved id as `"all"` (fail-safe); the pill
   rebuild drops the missing segment.
7. **Furniture straddling two rooms / on a shared wall.** Assigned by **center point**
   (`pointInRoom(sym.x, sym.y)`) — a single deterministic owner; a piece whose center is
   outside all rooms appears only in "All". Documented, simple.
8. **Rug spanning a room boundary.** Same center-point rule; a rug centered in the scoped
   room is included and still drawn as a flat decal (LLD 128 §Edge Case 4 unchanged).
9. **Rotated opening.** `corners(sym)` already returns the rotated footprint; the reveal
   extrudes those rotated corners exactly like a normal box (LLD 128 §Edge Case 6).
10. **Single-room plan.** Pill shows `All | Room 1`; both frame the same geometry — harmless
    and consistent, no special-casing.
11. **Theme switch while previewing.** Recess + box shades derive from the live palette at
    render time, so `onThemeChange` → `scheduleRender()` re-derives them (LLD 128 §Edge Case 13).
12. **Zoom/pan while scoped.** Framing is applied once on scope change; subsequent manual
    zoom/pan works through `worldToScreenIso`'s reuse of `worldToScreen` exactly as in LLD 128
    — no separate camera state.
13. **Opening depth-sort vs its wall (incl. off-center).** The opening inherits its **parent
    wall segment's** `sortKey` (the wall it cuts, found by min point-to-segment distance) plus
    `OPENING_BIAS`, so the reveal paints immediately after that exact wall regardless of where
    along the wall it sits — a door near one end sorts correctly, not just a centered one. The
    general furniture-vs-long-wall mis-order limitation (LLD 128 §4) is unchanged and not
    addressed here; it does not affect opening-vs-parent-wall because openings no longer use
    own-centroid sort against walls.

## Dependencies

**Hard dependency: LLD 128 must be shipped** (whole-plan `isoRender.js`, `preview.js`,
`view.worldToScreenIso`, the `#iso` group, `#tool-preview`, `.stage--preview`). This LLD is
strictly additive on that base — no rewrite. No new runtime dependency, no build-step change.

- **`symbols.js`** — add `sill`/`head` to `door`/`window` `CATALOG`; `corners()` reused for
  opening footprints; `openings` category flag used to route `kind:"opening"`.
- **`clearance.js`** — **reuse** existing exported `pointInRoom(room,x,y)` (lines 169–183, NOT
  a new helper); **add** the shared `symbolBelongsToRoom(room, sym)` predicate factored out of
  `roomTool._carriedSymbolsFor`. Both imported by `isoRender.scopeFilter` (no circular import —
  clearance.js imports only symbols.js + walls.js).
- **`walls.js`** — existing `pointNearRoomWall`, `roomMetrics`, `WALL_M`, `model.rooms` (ids),
  `roomCentroids`/geometry reused. **No new export** (pointInRoom already lives in clearance.js).
- **`roomTool.js`** — refactor `_carriedSymbolsFor` to call the extracted
  `clearance.symbolBelongsToRoom` (behaviour-preserving; removes the duplicated rule).
- **`isoRender.js`** — extend: `scopeFilter`, `isoBounds`, `kind:"opening"` in `buildItems` +
  `render`, `buildItems(rooms, symbols)` signature, `getScope` in `initIsoRender`. Reuse
  `extrudeFootprint`, `depthSort`, `shade`, `toOpaqueRgb`, `CATEGORY_BASE`, and
  `clearance.pointInRoom` / `clearance.symbolBelongsToRoom`.
- **`preview.js`** — add `getScope`/`setScope` + scope reset on off.
- **`view.js`** — reuse `worldToScreenIso`, `fitToContent`, `W`/`H`; NO new export.
- **`units.js`** — `fmtArea`, `areaUnitLabel` for pill labels.
- **`main.js`** — pass `getScope` to `initIsoRender`; build/refresh scope pill; wire segment
  clicks + refit; reset scope on preview off.
- **`index.html`** — `#preview-scope` container + CSS (top-center, scrollable, active state,
  recess color).
- **`plan.js`** — referenced only to confirm NO change (back-compat non-event).
- **`help.js`** — no change (no new shortcut).

Independent of #123 (export/share inclusion — this ships before it), #124 (orbit camera,
gated), and #112 (lighting — explicitly not pulled in).

## Test Requirements

Added to `test/tests.html` in the existing `describe`/`it`/`expect` harness. Pure functions
tested directly; SVG-structural tests follow the LLD 61 / 128 render pattern (detached `#iso`
group, call `render()`, assert on child polygons).

### Unit — opening height data

- `CATALOG.door` and `CATALOG.window` have finite `sill`/`head` with `0 <= sill < head`.
- `createSymbol("door", …)` output is unchanged (no `sill`/`head`/`z` on the instance) — the
  instance shape did not grow.

### Unit — scope filter (pure)

- `scopeFilter(walls, symbols, "all")` returns the models' rooms/symbols unchanged.
- `scopeFilter(..., roomId)` returns only that closed room and only the symbols whose center
  is inside it (furniture) or near its walls (openings). A symbol in another room is excluded.
- Unknown/stale `roomId` → behaves as `"all"` (fail-safe).
- `symbolBelongsToRoom` (shared predicate) — an opening near a room wall belongs; a furniture
  piece centered inside belongs; one centered outside does not. (Reuses the existing
  `clearance.pointInRoom`, already covered by clearance tests — no new pointInRoom test needed.)
- **Regression guard on the extraction:** `roomTool._carriedSymbolsFor` still returns the same
  carried-symbol ids after refactoring to `symbolBelongsToRoom` (existing roomTool/nudge tests
  must stay green — behaviour is identical).

### Unit — item build (openings)

- `buildItems([room],[door])` emits the door as `kind:"opening"` with `z0=sill`, `z1=head`
  (from catalog), not a normal furniture box.
- Opening `baseColor` is opaque and darker than the `openings` category color (recess).
- **Off-center opening ordering (parent-wall binding).** On a long wall (e.g. bottom edge of
  room `(0,0)–(4,3)`), a door placed near one end (`x≈1`) — where its *own* centroid key is
  **less** than the wall midpoint key — must still emit `sortKey > that wall's sortKey`
  (parent = the wall it cuts, not its own centroid). Assert the door sorts after that specific
  wall in `depthSort` output. This is the regression the previous "co-located/centered opening"
  test could not catch.
- Opening `sortKey` = its parent wall's key + `OPENING_BIAS` (also verified for a centered
  opening, so both centered and off-center cases are covered).
- Non-opening furniture still builds as before (regression guard on the refactored signature).

> **Migration note (not a regression):** `buildItems`'s signature changes from
> `buildItems(wallsModel, symbolsModel)` to `buildItems(rooms, symbols)`. The existing LLD 128
> **direct** `buildItems` unit tests (`test/tests.html` ~line 17173+, which call
> `buildItems({rooms,chain}, {symbols})`) therefore MUST be updated to the new signature
> (`buildItems(rooms, symbols)`) — this breakage is expected and intended, not a regression to
> fix. Only the `render()`-driven tests (which call `render()`, not `buildItems` directly) and
> the 2D tests are unaffected by the signature change.

### SVG-structural — renderer (LLD 61/128 pattern)

- **Scoping:** a two-room plan rendered with scope = room A yields `#iso` polygons for only
  room A's walls/floor/contents; room B's geometry is absent. Scope = "all" yields both
  (regression: matches LLD 128 whole-plan output).
- **Cutout geometry / height band:** a wall with a window produces a recess reveal whose
  projected polygon occupies the expected **vertical band** — assert the reveal's top-face
  vertices project higher (smaller screen y) than its bottom-face vertices, and that the band
  corresponds to `[sill, head]` (e.g. reveal bottom is above the wall base because
  `sill > 0`). Assert the reveal paints **after** its wall in child order.
- **Door band:** a door reveal's bottom sits at the floor (`sill = 0`) and its top below the
  wall top (`head < CEILING_M`) — the lintel wall remains painted above it.
- **Off-center reveal is visible (parent-wall ordering, structural):** a door offset toward one
  end of a long wall (e.g. `x≈1` on the bottom edge of room `(0,0)–(4,3)`) renders with its
  reveal polygon painted **after** (later in `#iso` child order than) that wall's faces and thus
  visible — not occluded. This is the SVG-structural counterpart to the off-center unit test and
  is the case that would silently regress under own-centroid sorting.
- **Empty state:** scope with no walls (or empty plan) renders the `<text>` hint and no box
  polygons.
- **Whole-plan unaffected:** preview OFF leaves `#iso` empty; "All" scope reproduces the
  LLD 128 face counts (no regression).

### Integration — back-compat round-trip (acceptance)

- A plan saved before this change validates via `validatePlan` and previews using catalog
  opening heights (no error).
- Round-trip through all three transports (`buildPlan`/`serializePlan`,
  `buildCompact`/`parseCompact`/`validatePlan`, localStorage write/read) produces a plan whose
  symbol shape is unchanged — no `sill`/`head` leaked into serialization.

### Behavioral — scope state / read-only

- `preview.setScope(id)` flips `getScope()` and fires `onChange`; turning preview off resets
  scope to `"all"`.
- Entering preview + switching scope + exiting leaves `walls.model` and `symbols.model` deeply
  equal to their pre-toggle snapshots (no mutation — scoping is a filter).
- The 2D editing path and the LLD 128 whole-plan preview are unaffected: all `render()`-driven
  preview tests and 2D tests still pass unchanged. (The **direct** `buildItems` unit tests are
  the sole exception — they are updated to the new signature per the migration note above; that
  is a deliberate call-site update, not a behavioral regression.)

### Not tested (out of scope)

Export/share inclusion of the preview (#123), orbit camera (#124), lighting (#112), per-room
ceiling override.
