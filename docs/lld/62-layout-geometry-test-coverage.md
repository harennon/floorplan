# LLD 62: Test coverage — layout/geometry assertions for dimEntry/symbolDimEntry/hud/clearancePanel/grid

## Scope

Follow-up to LLD 38 §4 and sibling LLD 61 (Tier 1). Tier 1 covered *what SVG gets drawn*
(`wallRender`/`symbolRender`/`exportImg` structure). This LLD (Tier 2) covers *where things
land on screen* — the layout/positioning class of regression LLD 38 §4 named ("overlapping
toolbars, a broken grid, a clipped HUD," and mispositioned floating inline editors).

**Covers** — new `describe` blocks in `test/tests.html`, one or more per module, asserting real
laid-out geometry via `getBoundingClientRect()` / element attributes at a **fixed stage size**:

1. **`dimEntry.js`** — begin edit on a known wall edge; assert the floating `.dim-input`'s
   projected position (`_positionInput` → `worldToScreen`) matches the edge screen-midpoint
   within tolerance, and its bounding rect sits inside the stage bounds (not clipped off-canvas).
2. **`symbolDimEntry.js`** — begin a width and a depth edit on a known symbol; assert the
   `.sym-dim-input` lands near the symbol's top-edge / left-edge midpoints (offset outward per
   the module's 14px offset) within tolerance, inside stage bounds.
3. **`hud.js`** — after `init` + `update` with the real HUD DOM + app positioning CSS, assert the
   HUD cells are visible (non-zero size, populated), the HUD block sits inside the viewport
   container, and does not overlap the tool-rail (toolbar) rect.
4. **`clearancePanel.js`** — with a plan that produces clearance rows and a selected symbol,
   assert the rendered panel rect sits **inside a fixed viewport container** (the new
   layout/containment check). Row-count and empty/off (`.clr-empty`) assertions already exist in
   the current suite (see Dependencies / Category 4) and are **not** re-stated here.
5. **`grid.js` `drawGrid()`** — for a known identity view and fixed `W×H`, assert the emitted
   line count, that `grid-major` lines are spaced `MAJOR_EVERY` steps apart, and that vertical
   lines span the full `H` / horizontal lines span the full `W`.

**Explicitly does NOT cover:**
- **No pixel / screenshot / visual-diff / color-contrast / font-rendering assertions.** This is
  Tier 2 (element rectangles + attributes). `exportImg.js` visual appearance (palette contrast,
  DM Mono rendering, z-order) remains the deliberately-out-of-scope Tier-3 pixel-baseline work
  named in LLD 38.
- **No changes to `ci.yml`, `.github/run-tests.mjs`, or the harness engine**
  (`describe`/`it`/`expect`). Tests-only, plus one shared rig helper.
- **No production code changes** to `dimEntry.js`, `symbolDimEntry.js`, `hud.js`,
  `clearancePanel.js`, `grid.js`, or any dependency. Tests only.
- **No edit to `.claude/project.json`** `autoMerge.renderPaths`. After Tier-1 + Tier-2 land these
  five files become *candidates* for trimming from the render-path gate; that trim is a separate
  human-gated PR and must be called out in the PR description only (see Dependencies).
- **No changes to the `mcp/` Node suite.** It is untouched and unaffected.
- Not re-covering the SVG-structural assertions from LLD 61 (element counts of render output);
  this is layout/position, not draw-structure.

## Approach

### The central constraint: `test/tests.html` does not load the app's layout CSS
The app's layout rules (`.stage`, `.dim-input`, `.hud`, `.tool-rail`, `.clearance`, `.dim-labels`)
live **inline in `src/index.html`**, not in a shared stylesheet. `test/tests.html` has only a
tiny inline `<style>` for the results list. This is why the existing `dimEntry`/`symbolDimEntry`
suites assert **computed positions** (`_positionInput` writes `style.left/top` from
`worldToScreen`) rather than laid-out rects — with no CSS, `getBoundingClientRect()` of an
absolutely-positioned overlay reflects only what JS set.

Two module classes, two strategies:

- **`dimEntry` / `symbolDimEntry` / `grid`** — position is *set by the module in JS*
  (`style.left/top`; SVG line coordinate attributes). These need **no app CSS**: assert on the
  values the module computes (`parseFloat(style.left)`, line `x1/y1/x2/y2`) against the
  hand-computed `worldToScreen` projection, using the existing detached-node rig pattern. This is
  the bulk of the value and is fully deterministic.
- **`hud` / `clearancePanel`** — the "no overlap / inside viewport" checks are only meaningful
  with the app positioning rules present. For these, the rig **injects the minimal subset of
  positioning CSS** the assertion depends on (a small, documented `<style>` string appended in
  the rig, copied from `index.html` with a comment pointing at the source lines) and appends the
  rig into a **fixed-size container** mounted on `document.body`. Assertions use tolerances and
  test *relationships* (A does not overlap B; A is inside container) — never absolute pixel
  values — so they survive minor CSS drift and font differences.

*Alternative considered — load `index.html`'s full CSS into the test page* (extract to a shared
file and `<link>` it): rejected. It would require a production refactor (extracting inline CSS),
which violates "no production changes," and would couple the whole suite to the full app layout
(fragile, wide blast radius). The minimal documented-subset approach keeps each assertion's CSS
dependency explicit and local.

### Fixed viewport / stage size for determinism
Every rig sets a **fixed stage size** so rects are deterministic and independent of the headless
window size. `dimEntry`/`symbolDimEntry` rigs give the `.stage` an explicit
`width:800px; height:600px; position:relative`. The `hud`/`clearancePanel` rigs mount into an
`800×600` `position:relative` container. Never rely on the ambient browser window dimensions.

### Identity view for hand-computed projections
As the LLD-61 render rig and existing dim suites do, set `view.zoom = 1; view.panX = 0;
view.panY = 0` so `pxPerM() = BASE_PX_PER_M = 40` and `worldToScreen(wx,wy) = (wx*40, wy*40)`.
Every asserted screen coordinate is then a trivial hand value. Reset view + models + unit at the
start of each `it` (reuse `resetAll()` / `resetSymbolModel()` / the existing rig factories).

### Tolerances, never exact pixels
Position assertions use `toBeCloseTo` with a **loose places value** (e.g. `places = 0`, ~±0.5 px,
or an explicit `Math.abs(a-b) <= TOL` with `TOL` = a few px for CSS-transform/offset cases).
Overlap/containment checks are boolean relationships on rects (`aLeft >= bRight || …`), not pixel
values. No assertion reads pixel color or depends on font metrics (text may be zero-width without
fonts — assert element presence and box, not text width).

### Reuse existing rigs and imports — do NOT re-create or re-import
The suite **already** has substantial HUD/clearance infrastructure; this LLD extends it, never
duplicates it:
- **Imports already present.** `hud.js` (`initHud`/`updateHud`, line 3741), `clearance.js`
  (line 4248), and `clearancePanel.js` (`initClearancePanel`/`clrPanelUpdate`, line 4942) are
  **already imported** in `test/tests.html`. **Do NOT add new `import` statements for these** —
  a duplicate top-level `import` binding is a `SyntaxError` that fails the whole suite. Reuse the
  existing bindings.
- **Rig naming — avoid collisions.** A `function makeHudRig()` already exists (line 4137, used by
  ~6 LLD-22 HUD tests; it builds bare `<span>`/`<button>` nodes on `document.body` with **no
  fixed container / no CSS subset**). A second top-level `function makeHudRig()` in the same module
  scope would shadow it and silently break those tests. The new fixed-container + CSS-subset HUD
  rig **must use a distinct name — `makeHudLayoutRig()`**. Likewise the new clearance layout rig
  is **`makeClearanceLayoutRig()`** to avoid colliding with `makePanelRig()` (line 4977).
- **`makePanelRig()` (line 4977) already builds the `.clearance` panel DOM** (`.clr-header`,
  `.clr-body`, toggle) on `document.body`. For the clearance *containment* check, **extend/wrap
  `makePanelRig` output** (mount its `panel` into a fixed `position:relative` 800×600 container +
  inject the panel positioning CSS subset) rather than rebuilding the panel DOM from scratch.

Reuse the LLD-61 `makeRenderRig61` / `parseSvg` / `parsePoints` helpers and the existing
`makeDimRig` / `makeSymbolDimRig` factories where they fit. Follow the file's dominant assertion
style (plain `throw new Error(...)` guards + existing `expect` matchers); **no new matchers**.

### Grid line assertions
`drawGrid(gGrid, W, H)` clears and repopulates `gGrid` with `<line class="grid-{axis|major|fine}">`
elements. Mount a detached `<g>`, set identity view, call `drawGrid(g, 800, 600)`, then:
- Count `g.querySelectorAll("line")` and split by class.
- Assert `grid-major` lines occur every `MAJOR_EVERY` (=5) steps: consecutive major vertical
  lines differ in screen-x by `5 * step * pxPerM()` within tolerance (`step = chooseGridStep(56)`).
- Assert vertical lines span full height (`y1≈0`, `y2≈H`) and horizontal lines span full width
  (`x1≈0`, `x2≈W`).
- Use a view where `chooseGridStep` is stable and the line count stays well under `MAX_LINES`.

## Interfaces / Types

No new production interfaces. Tests consume already-exported surfaces:

**dimEntry.js** (imported as `initDimEntry`, `beginEdit`, `reposition`, etc. — already in file):
```js
export function init({ stage, dimLabels }): void
export function beginEdit(roomId, edgeIndex): void   // creates+positions .dim-input in stage
export function reposition(): void                   // re-runs _positionInput
```
`_positionInput` sets `input.style.left/top` to the edge screen-midpoint via `worldToScreen`
(private; assert its *effect* on `style.left/top`, not the function).

**symbolDimEntry.js** (imported as `initSymbolDimEntry`, `beginSymbolEdit`, …):
```js
export function init({ stage, dimLabels, getLockAspect? }): void
export function beginEdit(symbolId, "w"|"h"): void   // positions .sym-dim-input
```
Position: width chip → top-edge midpoint of `corners(sym)` projected, offset outward 14px along
the symbol normal; depth chip → left-edge midpoint, offset 14px. Hand-compute at identity view
+ `rot = 0` (offset is `(0,-14)` for width, `(-14,0)` for depth).

**hud.js**:
```js
export function init(elZoom, elScale, elCursor, elUnitImp, elUnitMet, elSnapModeBtn, elGridToggleBtn): void
export function update(): void
export function setCursorScreen(x, y): void
```
Requires DOM nodes with the real IDs (`#hud-snap-mode-val`, `#hud-grid-toggle`,
`#hud-grid-toggle-val`) nested as in `index.html`. `update()` writes `textContent`/attributes.

**clearancePanel.js**:
```js
export function init({ panel, body, toggle, getSelectedId, getSymbol }): void
export function update(): void   // rebuilds body: .clr-controls, .clr-list (.clr-row*), .clr-verdict
```
`update()` reads `clearance.js` module state (`enabled`, `threshold`, `density`) and
`computeClearances(sym, {rooms, symbols})`. Selected symbol comes from `getSelectedId`/`getSymbol`.

**grid.js**:
```js
export const MAJOR_EVERY = 5
export function chooseGridStep(targetPx = 56): number
export function drawGrid(gGrid, W, H): void   // clears + appends <line class="grid-{tier}">
```

**Supporting (already imported):** `view` (`{zoom,panX,panY}`), `pxPerM`, `worldToScreen`,
`BASE_PX_PER_M`; `walls.model`, `edgeLength`; `symbols` `createSymbol`/`addSymbol`/`corners`;
`clearance.js` `computeClearances`/`setEnabled`/`setThreshold`; `units.setUnit`.

**New test-local helpers (in `test/tests.html`)** — all **new names**, chosen to avoid colliding
with the existing `makeHudRig` (4137) and `makePanelRig` (4977):
```js
// Fixed-size stage rig for dimEntry/symbolDimEntry layout (extends existing makeDimRig):
//   sets stage width/height explicitly; returns { stage, dimLabels, cleanup }.
function makeLayoutDimRig() -> {...}
// HUD LAYOUT rig (distinct from existing makeHudRig at 4137): builds the real HUD DOM +
// a tool-rail node inside an 800×600 position:relative container, injects the minimal
// positioning CSS subset, returns refs + cleanup.
function makeHudLayoutRig() -> { container, hud, toolRail, cells, cleanup }
// Clearance LAYOUT rig (distinct from existing makePanelRig at 4977): reuses/wraps the
// makePanelRig panel DOM, mounts it into the fixed 800×600 position:relative container,
// injects the panel positioning CSS subset, returns refs + cleanup.
function makeClearanceLayoutRig() -> { container, panel, body, toggle, cleanup }
// rect helpers:
function rectsOverlap(a, b) -> boolean
function rectInside(inner, outer, tol=1) -> boolean
```

## State Model

All state is transient, per-test, in-page. Nothing persisted.

- **Shared module singletons.** `walls.model`, `symbols.model`, `view`, the `units` mode, and
  `clearance.js` state (`enabled`/`threshold`/`density`) are module-level singletons shared by
  every suite. Each new `it` **must reset** them first: `resetAll()` (model+view+unit),
  `resetSymbolModel()`, `view.zoom=1;panX=0;panY=0`, `setUnit("m")`, and — for clearance —
  `setEnabled(true)` + a known `setThreshold(...)` so row classification is deterministic.
- **Editor module refs.** `dimEntry`/`symbolDimEntry` hold module-level DOM refs and a single
  lazily-created `<input>` set by `init(...)`. `init` resets the old input (`_input = null`,
  `display:none`) so re-calling with a fresh rig re-parents the input into the new stage. Each
  test builds a fresh rig and calls `init`, so the input lands in that test's stage.
- **`hud`/`clearancePanel` DOM.** These rigs mount real nodes into a fixed container on
  `document.body`; each `it` (or the rig `cleanup()`) removes them so no layout leaks across
  tests. `hud.init` also registers `onSnapModeChange`/`onPrefsChange` listeners (module-global,
  append-only) — harmless duplicates across tests; assertions read current DOM after `update()`,
  not listener counts.
- **CSS injection.** The minimal positioning `<style>` blocks are appended once per rig into the
  rig container (scoped, removed by `cleanup()`); no global stylesheet mutation persists.
- **No localStorage / URL-hash / network state** touched — consistent with the client-side-only
  invariant.

## Edge Cases

Fixture / assertion pitfalls the implementation must handle:

1. **No app CSS in the test page.** Overlay `getBoundingClientRect()` reflects only JS-set
   `style.left/top` unless CSS is injected. For `dimEntry`/`symbolDimEntry`/`grid` assert the
   *computed values* (`parseFloat(style.left)`, line attributes); for `hud`/`clearancePanel`
   inject the minimal positioning subset (Approach). Do not assume ambient layout.
2. **Zero-width text without fonts.** Headless env may lack DM Mono; text nodes can measure
   0-width. Assert element presence, box, and populated `textContent` — never text pixel width.
3. **`transform: translate(-50%,-50%)` on `.dim-input`.** The input is centered on its
   `left/top` point via CSS transform. When asserting the *rect center* vs the edge midpoint,
   account for the transform (rect center ≈ `left/top`); when asserting the raw computed anchor,
   read `style.left/top` directly (no transform applied to the inline value). Prefer asserting
   `style.left/top` for `dimEntry`/`symbolDimEntry` to sidestep transform math.
4. **Symbol input 14px outward offset.** `symbolDimEntry` offsets the input 14px along the
   symbol normal (`sin/cos(rot)`). At `rot = 0`: width → `(cx, cy-14)`, depth → `(cx-14, cy)`.
   Use `rot = 0` fixtures and include the offset in the expected value (tolerance ±1px).
5. **Edge index bounds.** `dimEntry.beginEdit` no-ops if `edgeIndex` is out of range
   (`> n-1` closed / `> n-2` open) or room missing — nothing renders. Use a valid closed-room
   fixture (e.g. 4 verts, edge 0) so the input is created.
6. **Openings allow width only.** `symbolDimEntry.beginEdit(id,"h")` for an opening-type symbol
   (door/window) no-ops. Use a furniture type (e.g. `bed`, `table`) for the depth-edit case.
7. **Clearance containment needs a populated panel.** For the (only new) panel-containment check,
   `clrPanelUpdate()` must render a non-empty panel: `enabled=true`, a symbol selected via
   `getSelectedId`, and `computeClearances` returning rows (closed room + symbol placed inside near
   walls). A collapsed/empty panel still has a valid rect, but use a populated fixture so the
   containment assertion reflects the real rendered panel size. (Row-count and `.clr-empty`
   behaviour is out of scope here — already covered elsewhere; do not re-assert.)
8. **HUD `update()` early-returns if not initialised.** `update()` guards on `_elZoom`. Always
   call `init(...)` with real nodes before `update()`. Also `setCursorScreen(x,y)` before
   `update()` so the cursor cell is populated deterministically.
9. **Grid line count vs `MAX_LINES`.** `drawGrid` bails (draws nothing) if a degenerate range
    would exceed `MAX_LINES` (2000/axis). Keep the fixture view/zoom in a normal range so lines
    are emitted; assert count is nonzero and matches the hand-computed index range.
10. **`drawGrid` clears first.** Calling twice yields the same count. Include an idempotent-redraw
    case (mirrors LLD 61's render-idempotency check).
11. **Grid axis vs major classification.** `_tier` uses `Math.round(idx)`; index 0 = `axis`,
    multiples of `MAJOR_EVERY` = `major`, else `fine`. When asserting major spacing, filter to
    `.grid-major` only (exclude the `.grid-axis` line at origin) and compare adjacent x/y deltas.
12. **Container must be `position:relative` and mounted.** For `hud`/`clearancePanel` overlap/
    containment to be real, the fixed container must be appended to `document.body` and be
    `position:relative` with explicit size; children `position:absolute` resolve against it.
    `cleanup()` must remove it to avoid cross-test layout pollution.

## Dependencies

**Must already exist (all satisfied):**
- **LLD 61 / issue #67 (Tier 1) landed.** This LLD builds directly on the Tier-1 render rig
  (`makeRenderRig61`, `parseSvg`, `parsePoints`) and its mounted-SVG/fixed-stage pattern. **Do
  this after #67.**
- `test/tests.html` harness (`describe`/`it`/`expect`, `window.__testResult`) and the headless
  runner `.github/run-tests.mjs` (Playwright + real headless Chromium — so `getBoundingClientRect`
  returns true laid-out geometry). No changes to either.
- Existing rigs/factories: `makeDimRig`, `makeSymbolDimRig`, `makeHudRig` (4137),
  `makePanelRig` (4977), `resetAll`, `resetSymbolModel`, and the imports of
  `dimEntry`/`symbolDimEntry` already present in the file.
- Exported surfaces of `hud.js`, `clearancePanel.js`, `grid.js`, `clearance.js`, `view.js`,
  `walls.js`, `symbols.js`, `units.js` (all present today). **`hud.js` (line 3741),
  `clearance.js` (line 4248), and `clearancePanel.js` (line 4942) are ALREADY imported** into
  `test/tests.html`. This PR **reuses those existing bindings and must NOT add duplicate
  `import` statements** — a duplicate top-level import is a `SyntaxError` that fails the whole
  suite. Only `grid.js`'s exports (`MAJOR_EVERY`/`chooseGridStep`/`drawGrid`) may need adding if
  not already imported — verify before adding.
- **Existing clearancePanel coverage to reuse, not duplicate.** The suite already asserts
  `.clr-row` counts (tests near lines 4781, 5134, 5287, 5324) and `.clr-empty` off/no-selection
  states (5242, 5400, 5424) via `makePanelRig`. Category 4 here adds **only** the new
  panel-containment (inside-viewport) check and reuses that coverage for row-count/empty behaviour.
- The positioning CSS snippets copied from `src/index.html` (`.hud`, `.hud-cell`, `.tool-rail`,
  `.clearance`) as documented literals with a source-line comment; they fail loudly if the app's
  layout model changes materially, which is acceptable and desirable for layout coverage.

**Ordering / handoff:**
- Test-only PR (no production diff), so unlike LLD 61 it carries no bundled bugfix. However,
  `dimEntry.js`, `symbolDimEntry.js`, `hud.js`, `clearancePanel.js`, and `grid.js` are still in
  `autoMerge.renderPaths` (LLD 38 §4 / §C), so **this PR is render-path-touching only via its
  test additions** — it does not touch those production files, so classification depends solely
  on the changed file set (`test/tests.html`, this doc). Confirm the classifier treats a
  test-only change as logic-only; if `test/**` is outside `renderPaths` it is auto-merge
  eligible.
- **PR description must call out** that once Tier-1 (#67) + Tier-2 (this) land, `dimEntry.js`,
  `symbolDimEntry.js`, `hud.js`, `clearancePanel.js`, and `grid.js` become **candidates** for
  removal from `autoMerge.renderPaths` in `.claude/project.json`. That trim is a **separate,
  human-gated PR** (editing `.claude/` is a gated path). **Do NOT edit `project.json` in this
  PR.** Frame as candidates: Tier-2 covers positioning/geometry, not final pixel appearance, so
  the human reviewer decides per file whether it is sufficient to ungate.

**Not blocked by / independent of:** app runtime, localStorage/URL-hash, the `mcp/` Node suite,
Cloudflare deploy path.

## Test Requirements

All new tests are added to `test/tests.html`. Acceptance: each of the five files is exercised by
≥1 new layout `describe` block; full suite green headless via `node .github/run-tests.mjs`; MCP
suite unaffected. Deterministic across runs (fixed stage size; no font-metric or pixel-color
reliance).

### Category 1 — dimEntry layout
New `describe("dimEntry — floating input layout")`:
- **Anchor at edge midpoint.** Closed-room fixture at known world coords, identity view; after
  `beginEdit(roomId, 0)`, assert `parseFloat(input.style.left/top)` equals the screen midpoint of
  edge 0 (`worldToScreen` of its two verts, averaged) within tolerance.
- **Inside stage bounds (not clipped).** The input's bounding rect is within the fixed 800×600
  stage rect (left ≥ stage.left, right ≤ stage.right, etc., within tol).
- **`reposition()` tracks the edge.** After changing `view.panX/panY`, calling `reposition()`
  updates `style.left/top` to the new projected midpoint.

### Category 2 — symbolDimEntry layout
New `describe("symbolDimEntry — floating input layout")`:
- **Width chip anchor.** Symbol (`rot=0`) at known world pos; after `beginEdit(id,"w")`, assert
  `style.left/top` = top-edge midpoint of projected `corners(sym)` offset `(0,-14)`, within tol.
- **Depth chip anchor.** After `beginEdit(id,"h")`, assert left-edge midpoint offset `(-14,0)`.
- **Inside stage bounds** for both, on the fixed stage.

### Category 3 — hud layout
New `describe("hud — layout / no-collision")`:
- **Cells visible + populated.** After `init(...)` + `setCursorScreen(...)` + `update()`, each
  HUD cell has non-zero width/height and non-empty `textContent` (zoom `%`, scale, cursor).
- **HUD inside viewport container** (rect within the 800×600 container).
- **No overlap with tool-rail.** HUD rect and tool-rail rect do not intersect (`rectsOverlap`
  false) — the core "overlapping toolbars" regression check.

### Category 4 — clearancePanel layout (containment only)
New `describe("clearancePanel — panel containment")` — **the only new clearancePanel assertion**.
Row-count and `.clr-empty` off/no-selection behaviour are **already covered** (tests near lines
4781/5134/5287/5324 for rows; 5242/5400/5424 for empty states) and are **not** restated here.
- **Panel inside viewport container.** Using `makeClearanceLayoutRig()` (which wraps
  `makePanelRig`'s panel into the fixed 800×600 `position:relative` container + panel CSS subset),
  a selected-symbol fixture that produces rows, after `clrPanelUpdate()`: assert the panel's
  bounding rect sits within the container rect (`rectInside`) — the "clipped/off-canvas panel"
  regression check.

### Category 5 — grid.drawGrid layout
New `describe("grid.drawGrid — line placement")`:
- **Line count.** Identity view, `drawGrid(g, 800, 600)`; total `<line>` count equals the
  hand-computed index-range count (vertical + horizontal), nonzero, under `MAX_LINES`.
- **Major spacing = MAJOR_EVERY.** Adjacent `.grid-major` vertical lines differ in x by
  `MAJOR_EVERY * step * pxPerM()` (tolerance); same for horizontal in y.
- **Lines span full extent.** Vertical lines: `y1≈0`, `y2≈600`; horizontal: `x1≈0`, `x2≈800`.
- **Idempotent redraw.** Calling `drawGrid` twice yields the same line count (clears first).

### Regression / infra
- **Full suite green headless:** `node .github/run-tests.mjs` exits 0; new tests counted in
  `window.__testResult.total`.
- **Order-independent:** each new `it` resets model/view/unit/clearance state and removes any
  mounted rig container (`cleanup()`), so no cross-suite leakage. Verify by running twice.
- **No production diff:** `dimEntry.js`, `symbolDimEntry.js`, `hud.js`, `clearancePanel.js`,
  `grid.js`, and all dependencies are byte-unchanged. Only `test/tests.html` (and this doc) change.
- **MCP / other suites unaffected.**
