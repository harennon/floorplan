# LLD 10: MVP-3 — dimensions, live area/perimeter, metric/imperial toggle

Phase 3 of 6 of the #1 MVP epic. Builds on wall drawing (LLD 04 / #6) and the
closed/open `Room` polygon model (#5/#6). This is the "read off your area" payoff.

## Scope

**In scope**

- **Auto dimension labels** on every committed wall edge (closed rooms and open
  polylines), formatted in the active unit.
- **Numeric dimension entry** — click a wall's dimension chip, type an exact length
  (e.g. `3.2m`, `10'`, `320cm`, or a bare number in the current unit) to rescale that
  edge to the exact measurement.
- **Live area + perimeter** for closed rooms, rendered as an on-canvas tag stamped at
  the room centroid, updating as geometry changes.
- **Metric/imperial toggle** applied consistently to all readouts *and* entry parsing —
  display-only, never mutating stored geometry.

**Out of scope**

- Clearance / "does my couch fit" checking (Phase 1 / #2).
- Symbols, doors, windows, furniture (#8).
- Editing/dragging vertices directly, or editing the *active* (uncommitted) draft chain's
  segments — dimension entry targets **committed** rooms only (see Edge Cases).
- Persisting the unit preference (units.js intentionally resets to imperial on reload;
  this LLD keeps that contract).
- Angle/rotation entry — only edge *length* is editable in v1.

## Approach

Key decisions and rationale:

1. **Metric-as-storage is inviolable.** World geometry stays in metres in `walls.model`.
   The unit toggle and dimension entry are a pure display/parse layer over metres. There
   are **no** stored feet — so toggling units is lossless by construction (no round-trip).
   `units.setUnit` already fires `onChange`, which `main.js` wires to `scheduleRender`;
   every label re-derives its text from metres on each render, so the toggle "just works"
   for all readouts once the new labels/tags also format through `units.js`.

2. **Reuse the shipped `units.js` formatter; extend it, don't fork it.** The one new
   concern entry introduces is *parsing* a typed string back to metres. That is the
   inverse of `fmtLen` and belongs in the same module (`parseLen`), alongside a length
   formatter that already exists and an area formatter (`fmtArea`) that mirrors `fmtLen`.
   No second formatter module is introduced.

3. **Reuse the shipped `Room` model and pure-geometry home.** Area, perimeter, centroid,
   and edge-rescale are all pure functions with no DOM — they go in `walls.js` next to
   `gridSnap`/`resolveSnap`, keeping the testable core in one place. No parallel geometry
   model is created; we read `model.rooms[*].verts` and `.closed` exactly as LLD 04 wrote
   them.

4. **Rendering stays in `wallRender.js`; interaction goes in a new `dimensions.js`.**
   `wallRender` already owns the `.labels` overlay and an `_addLengthChip` helper. We
   extend it to (a) render an *interactive* dimension chip per committed edge and (b)
   render a centroid room tag. The click→inline-input→apply flow is a distinct concern
   with its own transient state, so it lives in a new small module `dimensions.js`,
   mirroring how `wallTool.js` is separate from `wallRender.js`.

5. **Accessibility container split — resolves the `aria-hidden` conflict.** The existing
   `.labels` overlay is declared `aria-hidden="true"` (`index.html`). That is correct for
   its current contents — the transient draft/rubber-band length chips are decorative
   drawing aids — but a **focusable** element placed inside an `aria-hidden` subtree is
   hidden from assistive tech while still being tab-reachable, which is a WCAG violation.
   Since this LLD makes dimension chips keyboard-focusable interactive controls
   (`tabindex="0"`, `role="button"`, Enter/Space), they **must not** live in `.labels`.
   Resolution: add **one new persistent overlay** `.dim-layer` as a sibling of `.labels`
   inside `.stage`, **not** `aria-hidden`, using the *identical* screen-space coordinate
   scheme (`worldToScreen` → `left`/`top` px, `pointer-events: none` on the container,
   children opt back in). Interactive dimension chips **and** the room tags (which carry
   meaningful area/perimeter text AT should read) render into `.dim-layer`. The draft /
   rubber-band length chips stay in the still-`aria-hidden` `.labels`. This keeps the
   reused coordinate scheme intact while making the interactive/informational content
   exposed to assistive tech. (Alternative considered: remove `aria-hidden` from `.labels`
   and re-tag each draft chip — rejected because the transient draft chips would then spam
   the a11y tree on every pointer move during drawing.)

6. **Direction A ("Living Chips") — binding.** Dimension labels are pill chips sitting on
   each wall centerline; clicking one opens inline numeric editing in place. Area &
   perimeter are shown as an on-canvas tag stamped at the room centroid. There is **no**
   docked "Measure" inspector panel (that was the dropped hybrid/B element). The **binding
   spec for this direction is the prose in the Frontend Design section below** — it is
   self-sufficient. (No reference mockup file currently exists under `design-mockups/`;
   earlier drafts named `dimensions-area-perimeter-unit-toggle.html`, but that artifact was
   never committed. Do not chase it; if a mockup is desired later, route to
   `frontend-architect`.)
   - *Known weakness:* centroid tags can collide/overflow on very small rooms. This LLD
     specifies a min-size gate (see Edge Cases). If QA finds the collision severe, flag it
     back to the CEO/design-reviewer — do **not** silently reintroduce the B inspector.

7. **Rescale semantics: fix the edge's start vertex, move its end vertex.** Editing the
   chip for edge *i* (vertices `A = verts[i]`, `B = verts[(i+1) % n]`) keeps `A` fixed and
   repositions `B` along the current `A→B` unit direction so that `|AB|` equals the typed
   length exactly. Because `B` is shared with the next edge, the adjacent edge `(B,C)`
   changes length/angle as a side effect — this is the simplest honest model for "set this
   wall to exactly X" and matches Direction A's on-canvas edit model. (Alternative considered: rigidly
   translate the whole downstream vertex run to preserve other edges — rejected for v1 as
   more surprising and heavier; revisit if users complain.)

## Interfaces / Types

### `units.js` (extend — stable existing exports unchanged)

```js
/**
 * Parse a user-typed length string to METRES, or null if unparseable.
 * Accepts (case-insensitive, whitespace-tolerant):
 *   - bare number  -> interpreted in the CURRENT display unit ("3.2" => 3.2 units)
 *   - metric suffix: "m", "cm", "mm"            (e.g. "3.2m", "320cm")
 *   - imperial suffix: "ft" | "'", "in" | "\""  (e.g. "10ft", "10'", "6in", "6\"")
 *   - feet+inches:   "10' 6\"" / "10ft 6in"
 * Returns a positive number of metres, or null for empty/NaN/non-positive input.
 * @param {string} str
 * @returns {number|null}
 */
export function parseLen(str) { /* ... */ }

/**
 * Format an area in square metres for display in the current unit.
 * m:  m2, 2 decimals ; ft: m2 / (M_PER_FT^2), 1 decimal.
 * @param {number} m2
 * @returns {string}
 */
export function fmtArea(m2) { /* ... */ }

/** Area unit label for the current display unit: "m²" | "ft²". */
export function areaUnitLabel() { /* ... */ }
```

`fmtLen`, `unitLabel`, `unit`, `setUnit`, `onChange`, `M_PER_FT` are reused as-is.

### `walls.js` (extend — add pure geometry + one mutation)

```js
/** Number of edges in a room (closed adds the closing edge back to verts[0]). */
export function edgeCount(room)            // closed ? verts.length : verts.length - 1

/** Endpoints of edge i as [A, B] vertex refs (B wraps to verts[0] on the closing edge). */
export function edgeEndpoints(room, i)     // => [Vertex, Vertex]

/** Signed-area shoelace magnitude in m² (0 for < 3 verts). Meaningful for closed rooms. */
export function polygonArea(verts)         // => number  (absolute area, m²)

/** Total edge length in metres. closed => includes closing edge. */
export function polygonPerimeter(verts, closed) // => number (m)

/** Area-weighted polygon centroid in world metres; falls back to vertex mean if degenerate. */
export function centroid(verts)            // => { x, y }

/** Find a committed room by id, or null. */
export function findRoom(id)               // => Room | null

/**
 * Set edge i of `room` to exactly `metres`, keeping the start vertex fixed and moving
 * the end vertex along the current edge direction. No-op (returns false) if the edge is
 * degenerate (zero-length, can't derive a direction) or metres < MIN_SEG_M.
 * Mutates room.verts in place.
 * @returns {boolean} true if geometry changed
 */
export function setEdgeLength(room, i, metres) // => boolean
```

Constants reused: `MIN_SEG_M` (minimum accepted edge length).

### `dimensions.js` (new — interaction controller)

```js
/**
 * Bind the dimension-edit interaction.
 * @param {{ dimLayer: HTMLElement, stage: HTMLElement,
 *           onCommit: () => void }} refs
 *   dimLayer - the .dim-layer overlay (NOT aria-hidden) that holds .dim-chip elements
 *   stage    - stage element the floating edit <input> is appended to
 *   onCommit - called after a successful rescale (wired to scheduleRender)
 */
export function init(refs) { /* ... */ }

/** Is an edit input currently open? (render loop / keyboard may consult this) */
export function isEditing() { /* => boolean */ }
```

Behavior:
- One **delegated** `click` (and `keydown`→Enter/Space for a11y) listener on `dimLayer`
  catches `.dim-chip` activation. Chips are rebuilt every render, so delegation avoids
  per-chip listener churn. Because `.dim-layer` is **not** `aria-hidden`, the focusable
  chips are correctly exposed to assistive tech (see Approach #5).
- On activate: read `data-room-id` and `data-edge-index` from the chip; open a floating
  `<input type="text" inputmode="decimal">` positioned at the chip's screen midpoint,
  pre-filled with the current length in the active unit (bare number, no unit suffix),
  text selected.
- Commit on **Enter** or **blur**: `parseLen(value)` → metres; if non-null and the room
  still exists, `setEdgeLength(room, i, metres)`; then `onCommit()`.
- Cancel on **Esc** (or empty/invalid on commit): discard, no geometry change.
- The input subscribes to `view.onChange` so pan/zoom keeps it over its edge; it closes
  itself if the target room/edge disappears.

### `wallRender.js` (extend — render committed dimension chips + room tags)

```js
// init() signature gains one param: the .dim-layer overlay (interactive/AT-exposed).
//   init(gWorld, gDraft, gSnap, labelsEl, dimLayerEl, getSnap)
// New private helpers:
//   _addDimChip(metres, sx, sy, roomId, edgeIndex)  -> interactive committed-edge chip
//   _renderRoomTag(room, ppm)                        -> centroid area+perimeter tag
```

- Committed dimension chips and room tags render into the new **`.dim-layer`** overlay
  (not `.labels`), because they are interactive/informational and must be exposed to
  assistive tech (Approach #5). `_clearLabels`-style clearing applies to both overlays
  each render.
- In `_renderRoom`, after drawing geometry, iterate edges and stamp `_addDimChip` at each
  edge midpoint (screen space). Chips carry `data-room-id` / `data-edge-index`.
- For `room.closed && verts.length >= 3`, stamp one `_renderRoomTag` at `centroid(verts)`,
  showing `fmtArea(area) areaUnitLabel()` and `fmtLen(perimeter) unitLabel()`.
- The existing draft/rubber-band length chips (`length-chip--live` / `--placed`) are
  **unchanged**, remain non-interactive, and continue to render into the still-`aria-hidden`
  `.labels` overlay.

### `main.js` (wire new module)

Grab the `.labels`, new `.dim-layer`, and `stage` refs, pass `dimLayer` into
`wallRender.init(...)`, and call `dimensions.init({ dimLayer, stage, onCommit:
scheduleRender })`. No change to existing init order/contracts.

### `index.html` (CSS + one new persistent overlay)

- **New DOM:** add `<div class="dim-layer"></div>` as a sibling of `.labels` inside
  `.stage`. It is **not** `aria-hidden` (unlike `.labels`), so its interactive chips and
  informational room tags are exposed to assistive tech.

New styles:
- `.dim-layer` — full-stage absolute overlay, same positioning as `.labels`,
  `pointer-events: none` (children opt back in). Not aria-hidden.
- `.dim-chip` — gold-outline pill on the wall centerline, `pointer-events: auto`,
  `cursor: pointer`, `:hover`/`:focus`(-visible) emphasis. Rendered with `tabindex="0"`
  and `role="button"` (set in JS).
- `.dim-input` — floating inline editor matching chip typography (`--font-mono`), gold
  border, appended to `.stage`, `z-index` above the overlays.
- `.room-tag` — centroid tag: two mono lines (area, perimeter), panel background,
  `pointer-events: none`, `transform: translate(-50%, -50%)`.

## State Model

- **Persisted:** nothing new. v1 remains client-side; geometry lives only in
  `walls.model` (in-memory, metres). Unit preference is **not** persisted (unchanged from
  units.js).
- **In-memory / source of truth:** `walls.model.rooms[*].verts` (metres) and `.closed`.
  Dimension entry mutates `verts` in place via `setEdgeLength`; area/perimeter/labels are
  **derived** every render — never stored.
- **Transient (dimensions.js):** the currently-open edit target `{ roomId, edgeIndex }`
  and its floating `<input>`. Cleared on commit/cancel/blur. Not part of the model.
- **Data flow (edit):** click chip → open input → Enter/blur → `parseLen` → metres →
  `setEdgeLength` (mutates metres) → `onCommit` → `scheduleRender` → `wallRender` re-derives
  all chips + room tag from metres. `hud.js` continues to update independently.
- **Data flow (unit toggle):** `setUnit` → units `onChange` → `scheduleRender` → all
  labels/tags re-format from the *same* metre values. No geometry touched.

## Edge Cases

1. **Bare number entry** ("3.2") — interpreted in the current display unit via `parseLen`;
   `320cm`, `3.2m`, `10'`, `6"`, `10' 6"` parse to metres regardless of active unit.
2. **Invalid / empty / non-positive input** — `parseLen` returns null; commit is a no-op,
   input closes, geometry unchanged.
3. **Rescale below `MIN_SEG_M`** — `setEdgeLength` returns false and does not mutate
   (prevents zero/degenerate edges).
4. **Degenerate edge (zero length, no direction)** — `setEdgeLength` returns false; a chip
   is not rendered for a zero-length edge anyway (mirrors the `len > 0` guard already in
   wallRender).
5. **Adjacent edge side-effect** — moving the shared end vertex changes the neighbouring
   edge's length/angle. This is intended; its chip re-renders with the new value live.
   (Documented in Approach #6.)
6. **Closing edge of a closed room** — edge index `verts.length - 1` runs from
   `verts[n-1]` to `verts[0]`; `edgeEndpoints` wraps `B` to `verts[0]`. Rescaling it moves
   `verts[0]`, which also affects edge 0 — expected.
7. **Open polyline** — dimension chips on each of its `n-1` edges are editable, but **no**
   area/perimeter room tag is drawn (area is meaningless; Direction A ties the tag to
   closed rooms).
8. **Very small / tightly-zoomed room** — if the room's on-screen bounding box is below a
   threshold (e.g. < ~64px on the smaller side), suppress the centroid room tag (and
   optionally thin out overlapping chips) to avoid the known centroid-collision weakness.
   Chips remain; tag reappears on zoom-in. Flag back if QA finds this insufficient.
9. **Self-intersecting polygon** — shoelace still yields a finite absolute area; we display
   it without special-casing (v1 does not police non-simple polygons).
10. **Unit toggled while an edit input is open** — resolved by commit-on-blur ordering,
    not a cancel path. The `IMPERIAL`/`METRIC` buttons live in the top-right HUD, outside
    `.stage`, and there is **no** keyboard shortcut for unit change. So activating a toggle
    always blurs the open `<input>` **first**, which fires the normal commit-on-blur:
    `parseLen(value)` is evaluated **in the old (still-active) unit** and applied, and the
    input is torn down. Only *then* does `setUnit` fire `units.onChange` → `scheduleRender`,
    which re-formats the now-committed chips/tag into the new unit. Net behavior: the typed
    value commits in the unit it was typed in (never silently reinterpreted), and no edit
    input is ever left open across a unit change. `dimensions.js` therefore needs **no**
    explicit `units.onChange` handler for the open-input case; the blur handler already
    guarantees the invariant. (If a future keyboard unit-toggle is added that could fire
    without blurring, it must first call a `dimensions.commitOpen()` helper — noted for
    that future work, not implemented in v1.)
11. **Keyboard tool shortcuts vs. the input** — `wallTool._onKeyDown` already ignores keys
    when `document.activeElement` is an INPUT/TEXTAREA/SELECT, so typing `w`/`v`/Backspace
    in the dimension input won't switch tools or undo. The new input relies on this
    existing guard; Esc/Enter are handled locally in dimensions.js.
12. **Pan/zoom while editing** — the floating input re-positions via `view.onChange`; a
    large pan that scrolls the edge off-screen still keeps the input reachable (it stays
    within the stage). Edit is not auto-cancelled by view changes; a unit toggle commits it
    via blur first (Edge Case 10), never cancels it.
13. **Room deleted/emptied mid-edit** — (no delete path in this phase, but) if the target
    room/edge is gone at commit time, `findRoom` returns null and commit is a no-op.
14. **Very long edge / large area** — formatters use fixed decimals; no thousands grouping
    required for v1. Values remain readable in the tag; tag width is content-sized.

## Frontend Design

**Binding frontend decision: Direction A — "Living Chips."** (Issue #7 has two
`Frontend decision:` comments; the human's later `Frontend decision: A` overrides the
CEO's earlier "Hybrid". The human comment wins — so no docked Measure inspector.) This
prose is the self-sufficient binding spec; there is no committed reference mockup (see
Approach #6).

- **Dimension chips (`.dim-chip`).** A gold-outline pill centered on each committed wall
  edge's midpoint (screen space), reading e.g. `10.5 ft`. Rendered into the new
  **`.dim-layer`** overlay (not the `aria-hidden` `.labels`), reusing the identical
  `worldToScreen`→`left`/`top` px coordinate scheme and the `--font-mono` / gold palette
  tokens already in `index.html`. Unlike the muted draft chips, these are *interactive*:
  `pointer-events: auto`, `cursor: pointer`, with hover/focus emphasis and `tabindex="0"`
  + `role="button"` for keyboard activation — which is why they live in the non-aria-hidden
  layer (Approach #5). They visually echo the draft `length-chip` so the language is
  consistent (placed→interactive is the only jump).
- **Inline edit (`.dim-input`).** Clicking/activating a chip swaps it for a floating
  `<input type="text" inputmode="decimal">` in the same spot, gold border, chip
  typography, pre-filled with the current length as a bare number in the active unit and
  text pre-selected. Enter/blur commits, Esc cancels. This is the "click-to-edit inline"
  half of Direction A — editing happens *on the canvas at the wall*, not in a side panel.
- **Room tag (`.room-tag`).** For each closed room, a centroid-stamped two-line tag:
  area (`fmtArea` + `areaUnitLabel`) on top, perimeter (`fmtLen` + `unitLabel`) below.
  Panel background, hairline border, `pointer-events: none`, centered on the area-weighted
  centroid. This is the on-canvas "read off your area" payoff — no docked inspector.
- **Unit toggle** reuses the existing top-right `IMPERIAL`/`METRIC` buttons and their
  `setUnit` wiring verbatim; every chip and tag re-formats on `units.onChange` →
  `scheduleRender`. Nothing about the toggle chrome changes.
- **Motion/consistency.** Chips/tags respect the existing warm-blueprint palette and the
  `prefers-reduced-motion` posture already in the stylesheet (no new animations required).
- **Known weakness (centroid collision on small rooms).** Handled by the min-size tag
  gate (Edge Case 8). If QA finds it severe, flag back rather than reintroducing the
  Direction B inspector.

## Dependencies

Must already exist (all shipped):
- `walls.js` — `Room`/`Vertex` model, `model.rooms`, `MIN_SEG_M` (LLD 04, #6).
- `units.js` — `fmtLen`, `unitLabel`, `unit`, `setUnit`, `onChange`, `M_PER_FT`.
- `wallRender.js` — `.labels` overlay rendering, `_addLengthChip`, render loop hook.
- `view.js` — `worldToScreen`, `pxPerM`, `onChange` (for input repositioning).
- `surface.js` — `scheduleRender` and the `_doRender` loop that calls `wallRender`.
- `main.js` — module wiring; `units.onChange` already routed to `scheduleRender`.

No new third-party deps, no build step (static ES modules under `src/`).

## Test Requirements

**Unit — `units.js`**
- `parseLen`: bare number in each active unit (m and ft); each suffix form
  (`m`,`cm`,`mm`,`ft`,`'`,`in`,`"`); `10' 6"` combined; whitespace/case tolerance;
  empty/garbage/negative/zero → null.
- `fmtArea` / `areaUnitLabel`: correct m² value and 2 decimals in metric; ft² conversion
  (÷ `M_PER_FT²`) and 1 decimal in imperial; label strings.
- Round-trip: `parseLen(fmtLen(x))` ≈ x within display rounding, for both units.

**Unit — `walls.js`**
- `polygonArea`: known rectangle/triangle; 0 for < 3 verts; absolute value regardless of
  winding.
- `polygonPerimeter`: open vs closed (closing edge included only when closed).
- `centroid`: rectangle → center; degenerate (collinear/zero-area) → vertex mean fallback.
- `edgeCount` / `edgeEndpoints`: open vs closed counts; closing-edge wrap to `verts[0]`.
- `setEdgeLength`: sets `|AB|` to exact metres keeping `A` fixed and direction unchanged;
  returns false for `< MIN_SEG_M` and for a zero-length edge; verifies metres-in-storage
  (no unit involvement).

**Integration (DOM/behavioral)**
- Typing `3.2m` (metric) and the equivalent in imperial both produce the same stored
  metre length and an updated chip/room tag — the core acceptance criterion.
- Area & perimeter tag updates live after a rescale.
- Unit toggle re-formats every chip and the room tag with **no** change to stored verts
  (assert `model.rooms` bytes unchanged across toggle) — lossless toggle criterion.
- Chip click opens the input pre-filled in the active unit; Enter commits, Esc cancels,
  blur commits.
- Toggling units while an input is open commits the typed value in the **old** unit (via
  blur) then re-formats into the new unit; no input is left open and the value is not
  silently reinterpreted (Edge Case 10).
- Open polyline shows edge chips but no room tag; small/zoomed-out room suppresses the tag.

**Accessibility**
- Interactive `.dim-chip` elements are within a container that is **not** `aria-hidden`
  (`.dim-layer`), and each exposes `role="button"` + `tabindex="0"`; assert they are both
  focusable and present in the accessibility tree (regression guard for the resolved
  `aria-hidden` conflict). Draft `length-chip`s in `.labels` remain aria-hidden.
- Enter/Space on a focused chip opens the editor (keyboard parity with click).

**Regression / non-goals**
- Draft chain length chips remain non-interactive and visually unchanged.
- Tool keyboard shortcuts do not fire while the dimension input is focused.
- No network calls; nothing written to `localStorage` by this feature.
