# LLD 61: Test coverage — SVG structural assertions for wallRender/symbolRender/exportImg

## Scope

Follow-up to LLD 38 §4 / §Scope. LLD 38 gates auto-merge for any PR touching render/layout
paths because a green unit suite does not prove the drawing looks right, and it explicitly
defers the visual-diff/screenshot harness. This LLD closes the cheapest slice of that gap:
**structural SVG assertions** on the three modules that emit SVG, so their correctness is no
longer entirely untested.

**Covers:**
- New `describe` blocks in `test/tests.html` that render known fixture plans and assert on the
  emitted SVG **structure** (element counts, tag types, coordinate/attribute values, palette
  color tokens, transforms, escaped text). Three modules exercised:
  1. `exportImg.buildExportSvg()` — the pure SVG-string builder (highest ROI: no DOM mounting).
  2. `wallRender.render()` — mounted into stub `<svg>` groups.
  3. `symbolRender.render()` — mounted into stub `<svg>` groups.
- A small test rig (mount points + view/theme setup) reused across the two render suites.

**Explicitly does NOT cover:**
- **No pixel / screenshot / visual-diff comparison.** No image baselines, no new CI tooling.
  Assertions are coordinate/structure-level only. This is Tier 1; the pixel-diff harness
  remains the separate follow-up named in LLD 38.
- **No changes to `ci.yml`, `run-tests.mjs`, or the harness engine** (`describe`/`it`/`expect`).
  We only add test suites and, if needed, extend `expect` with additive matchers (see Approach).
- **No production code changes** to `wallRender.js`, `symbolRender.js`, `exportImg.js`,
  `view.js`, or `theme.js`. These are tests only.
- **No edit to `.claude/project.json`** `autoMerge.renderPaths`. Removing these three files from
  the render-path gate is a separate human-gated PR; this LLD only makes them *candidates* and
  the PR description must call that out (see Dependencies).
- Not covering `clearanceRender.js` (already has coverage per existing suites), the interactive
  chip HTML overlays beyond a basic count, or exact interior-glyph geometry per furniture type
  (structural presence only).

## Approach

### Sequence by ROI
Implement in this order, each as its own `describe` block(s) appended to `test/tests.html`:

1. **`exportImg.buildExportSvg()` first.** It is a pure function returning an SVG *string*, so
   no DOM mounting is required — highest value per line. `test/tests.html` already imports
   `contentBounds, buildExportSvg` (line ~2426) and has a thin `exportImg.buildExportSvg` block
   that only string-`includes()`-checks. We **add a new, deeper block** (e.g.
   `"exportImg.buildExportSvg — structural"`) that parses the string with `DOMParser` and asserts
   on the real element tree. Leave the existing shallow block in place (surgical; don't refactor
   working tests).
2. **`wallRender.render()`** — requires mounting SVG `<g>` groups and stubbing view state.
3. **`symbolRender.render()`** — same rig shape as wallRender.

### Parsing emitted SVG (exportImg)
`buildExportSvg()` returns a full XML document string. Parse it in-page with
`new DOMParser().parseFromString(svgStr, "image/svg+xml")`, then use
`doc.querySelectorAll("polygon")`, `getAttribute("points")`, `doc.querySelectorAll("text")`,
etc. This gives structural access without regex. Coordinate assertions multiply world metres by
`EXPORT_PX_PER_M = 96` and account for the `MARGIN_M = 0.5` origin offset (origin =
`bounds.min − 0.5`), so a room vertex at world `(0,0)` with bounds min `(0,0)` maps to export px
`(0.5*96, 0.5*96) = (48, 48)`. Use `expect(...).toBeCloseTo(...)` for float coords.

Because `EXPORT_PX_PER_M`, `MARGIN_M` are module-private (not exported), the tests **hardcode
these constants as documented literals** with a comment pointing at `exportImg.js`. Do not add
new exports to production code (Scope: no prod changes). If a constant ever changes, the test
fails loudly — acceptable and desirable for a value that defines export scale.

### Rendering into stub SVG (wallRender / symbolRender)
Both modules take DOM mount points via `init(...)` and read screen-space geometry through
`view.js`'s `worldToScreen` / `pxPerM`. **We do not mock `view.js`** — it is a pure, already-
tested module with mutable exported `view` state. Instead the rig sets a **known, identity-ish
transform** by writing `view.zoom`/`view.panX`/`view.panY` directly (the existing suites at
lines ~2449, ~2482 already do exactly this). With `zoom = 1`, `pxPerM() = BASE_PX_PER_M = 40`,
`panX = panY = 0`, world `(wx,wy)` → screen `(wx*40, wy*40)`. That makes every asserted
coordinate a trivial hand-computed value.

Rig construction (mirrors the existing symbolDimEntry / clearance rigs in the file):
- Create SVG groups with `document.createElementNS("http://www.w3.org/2000/svg", "g")` and, for
  wallRender, HTML `<div>`s for the label / dim-label overlays.
- Call the module's `init(...)` with those nodes plus stub getters (`() => null`, or a fixed
  snap / selection object where a case needs it).
- Populate `walls.model` / `symbols.model` directly (push rooms / `addSymbol`), then call
  `render()` and assert on the group's children.
- Reset model + view in each `it` via the existing `resetAll()` helper (or a local reset) so
  suites are order-independent.

### Palette / theme wiring assertion
The point of the theme-wiring check is that colors come from `palette()`, not hardcoded strings.
Import `palette` (already imported at line ~8900) and, in the test, read the live palette then
assert the emitted `stroke` / `fill` attribute equals the corresponding token (e.g.
`el.getAttribute("stroke") === p.wallLine`). In the headless test env CSS vars resolve to the
dark-theme fallback (`theme.js _buildFallback()`), so `p.wallBody === "rgba(201,168,76,0.30)"`
etc. Assert against `palette()` return values, **not** literal hex, so the test tracks the
palette rather than duplicating it — except `exportImg`'s bg rect, whose existing test already
pins `#14140f`; keep that pin.

### Harness matchers
The existing `expect` supports `toBe`, `toBeCloseTo`, `toBeGreaterThanOrEqual`,
`toBeLessThanOrEqual`, `toThrow`. Element-count and attribute checks fit these plus plain
`throw new Error(...)` guards (the file's dominant style). **Prefer plain guards / existing
matchers**; the default recommendation is **no matcher changes**. Only if a new matcher would be
reused ≥3× may one additive matcher be added — additive only, never altering existing behavior.

### Alternatives considered
- **Mock `view.js` via a fake module** — rejected: identity transform via the real module is
  simpler, matches existing suites, and avoids ESM mocking machinery the harness lacks.
- **Regex over the SVG string for wall/symbol render** — rejected: those render into live DOM
  nodes, so `querySelectorAll` on the mounted group is the natural, robust assertion surface.
- **Exporting `EXPORT_PX_PER_M` for the test** — rejected: violates "no prod changes"; a
  documented literal in the test is sufficient and fails loudly on drift.

## Interfaces / Types

No new production interfaces. The tests consume the existing, already-exported surfaces:

**exportImg.js** (already imported in tests):
```js
export function contentBounds(): { minX, minY, maxX, maxY } | null
export function buildExportSvg(): string   // full "<?xml …><svg …>…</svg>" document
```
Module-private constants the tests hardcode as documented literals:
`EXPORT_PX_PER_M = 96`, `MARGIN_M = 0.5`, `wallPx = max(6, WALL_M*96)`.

**wallRender.js**:
```js
export function init(gWorld, gDraft, gSnap, labelsEl, dimLabelsEl,
                     getSnap, getHighlight, getEditingEdge): void
export function render(): void   // clears + repopulates the mounted groups
```
Test-supplied args: three `<g>` SVG nodes; two HTML `<div>`s (`labelsEl`, `dimLabelsEl`);
`getSnap`/`getHighlight`/`getEditingEdge` as `() => null` (or fixed objects per case).

**symbolRender.js**:
```js
export function init(gSymbols, gOverlay, dimLabels,
                     getSelectedId, getPlacementGhost, getEditingDim): void
export function render(): void
export function getRotateHandleScreen(sym): { x, y }
```

**Supporting (all already exported / imported in the file):**
- `view.js`: `view` (mutable `{zoom,panX,panY}`), `pxPerM`, `worldToScreen`, `BASE_PX_PER_M`.
- `theme.js`: `palette()` → `Palette` token object (dark-fallback in test env).
- `walls.js`: `model` (`{rooms, chain}`), `WALL_M`, `edgeLength`.
- `symbols.js`: `model` (`{symbols}`), `createSymbol`, `addSymbol`, `corners`, `CATALOG`.
- `units.js`: `setUnit`, `fmtLen`, `unitLabel` (to make dimension-label text deterministic).

**Test-local helper (new, in `test/tests.html`):**
```js
// Mount SVG groups + overlays, set identity view, init the render module.
function makeRenderRig() -> { gWorld, gDraft, gSnap, labels, dimLabels,
                              gSymbols, gOverlay }
// Parse an exportImg SVG string into a queryable Document.
function parseSvg(svgStr) -> Document   // via DOMParser, "image/svg+xml"
```
`makeRenderRig` may be split per module if that reads cleaner; a single shared helper is fine
since both rigs need SVG `<g>` nodes + a dim-labels `<div>`.

## State Model

All state is transient, per-test, in-page. Nothing persisted.

- **Module singletons are shared mutable state.** `walls.model`, `symbols.model`, `view`, and
  the `units` mode are module-level singletons imported by every suite in `test/tests.html`.
  wallRender/symbolRender also hold their own module-level DOM refs set by `init(...)`. The new
  suites therefore **must reset** at the start of each `it`: clear `model.rooms`/`model.chain`/
  `symbols.model`, set `view` to identity (`zoom:1,pan:0`), and set a known unit. The existing
  `resetAll()` (line ~2444) already does the model+view+unit reset and is reused.
- **`init(...)` is idempotent per rig.** Each test builds a fresh rig (fresh detached `<g>`
  nodes) and re-calls `init`, so the module's DOM refs point at that test's nodes. Because
  `render()` clears its groups first, re-rendering within a test is safe.
- **Palette cache.** `theme.js` caches `_palette`; in the headless run CSS vars are absent so
  the dark fallback is used. Theme-toggling suites elsewhere in the file may leave the theme in
  either state, but the fallback keys are stable regardless, and assertions compare against the
  live `palette()` return, so no cross-suite ordering dependency is introduced.
- **No localStorage / URL-hash / network state** touched — consistent with the client-side-only
  invariant. Mount nodes are detached (never appended to `document.body`), so no layout/reflow
  and no cleanup needed.

## Edge Cases

These are the fixture / assertion pitfalls the implementation must handle:

1. **Empty plan → exportImg.** `contentBounds()` returns `null`; `buildExportSvg()` still returns
   a valid SVG (`5×5 m` default frame, bg rect, no polygons/text). Assert: parses OK, exactly one
   `<svg>`, one `<rect>`, **zero** `<polygon>` and **zero** `<text>`. Confirms the `contentBounds`
   guard. (The existing shallow block checks the string starts with `<?xml`; the new block
   verifies element counts.)
2. **Margin offset in coordinates.** Export coords are offset by `MARGIN_M` (origin = min − 0.5),
   not raw `world*96`. A test that forgets the offset will assert wrong values. Document the
   formula in-test and use a room whose min is `(0,0)` so the offset is the whole coordinate.
3. **Open vs closed room.** Closed room → `<polygon>` (fill + body + centerline = up to 3 polygon
   elements for one room) and `n` edge labels; open polyline → `<polyline>` and `n−1` labels, no
   fill. Assert the correct tag and label count for each. Zero-length edges are skipped
   (`len < 1e-6` / `=== 0`), so use non-degenerate fixtures.
4. **Text escaping.** Dimension/label text is XML-escaped via `_escapeXml`. The default unit
   labels (`m`, `ft`) contain no special chars, so to exercise escaping assert that a symbol whose
   `CATALOG` label or a unit string contains `&`/`<`/`"` is emitted escaped. Simplest deterministic
   path: assert the emitted `<text>` textContent round-trips through the parser (no raw `<`/`&`),
   and add one focused case feeding a value with `&`/`<` (e.g. via a symbol type whose label we
   can assert) — if no catalog label contains special chars, assert the escape helper's effect
   indirectly by confirming the raw SVG string never contains an unescaped `&` outside entities.
5. **Symbol label count.** exportImg emits **one `<text>` per symbol** (center label) plus one per
   room edge. A fixture with R closed-room edges + S symbols → `R + S` `<text>` nodes. Assert the
   exact total.
6. **wallRender needs `≥2` verts for body/centerline, `≥3` for fill.** A 1-vertex chain renders
   only vertex dots. Choose fixtures deliberately: a closed 4-vertex room yields fill polygon +
   body polygon + centerline polygon + 4 vertex-dot circles in `#world`.
7. **Rubber-band / snap require a non-null snap getter.** With `getSnap → null` no rubber-band,
   no snap glyph, no close-preview render. To assert snap-glyph structure, a case supplies a fixed
   snap object (`{x,y,type:"grid"}`) and asserts the diamond `<polygon>` + dot in `#snap`.
8. **symbolRender selection styling.** Unselected body: `stroke = p.symStroke`,
   `stroke-width = "1.5"`, `fill = p.symFill`. Selected (getSelectedId returns the id): `stroke =
   p.gold`, `stroke-width = "2"`, `fill = p.symSelFill`, plus a selection-box polygon + rotate
   handle in `#overlay`. Assert the two states differ on these attributes.
9. **Symbol transform / position.** Assert the body polygon `points` equal the screen-projected
   `corners(sym)` (world→screen at identity = `*40`). For a rotated symbol, assert points reflect
   rotation (not axis-aligned). The `toilet` interior `<ellipse>` carries a `transform="rotate(...)"`
   — only assert that if a toilet fixture is used; keep furniture fixtures to simple types
   (e.g. `bed`, `table`) unless a case specifically targets rotation.
10. **dim-labels are appended, not cleared, by symbolRender.** wallRender clears `.dim-labels`;
    symbolRender only appends. Since the render suites are separate, give each its own fresh
    dim-labels `<div>` so counts are isolated. Do not assert cross-module ordering.
11. **`DOMParser` parse errors.** A malformed SVG yields a `<parsererror>` node rather than
    throwing. The exportImg tests should assert `doc.querySelector("parsererror")` is null before
    other assertions, so a structural break surfaces clearly.
12. **Float formatting in `points`.** Attribute strings are `"x,y x,y …"` with full-precision
    floats. Parse each pair with `parseFloat` and compare via `toBeCloseTo`; never string-equal a
    coordinate list.

## Dependencies

**Must already exist (all satisfied):**
- `test/tests.html` harness (`describe`/`it`/`expect`, `window.__testResult`) and the headless
  runner `.github/run-tests.mjs` (Playwright + headless Chromium). No changes to either.
- Exported surfaces of `exportImg.js`, `wallRender.js`, `symbolRender.js`, `view.js`, `theme.js`,
  `walls.js`, `symbols.js`, `units.js` (all present and imported today).
- `DOMParser` and SVG `createElementNS` — available in the Chromium test environment.

**Ordering / handoff:**
- Independent of any other in-flight LLD; this is test-only and touches only `test/tests.html`,
  which is **outside** `autoMerge.renderPaths`, so this PR is itself auto-merge eligible.
- **PR description must call out** that once this lands, `src/js/wallRender.js`,
  `src/js/symbolRender.js`, and `src/js/exportImg.js` become candidates for removal from
  `autoMerge.renderPaths` in `.claude/project.json` — to be done in a **separate, human-gated
  PR** (editing `.claude/` is a gated path). **Do NOT edit `project.json` in this PR.** Note the
  nuance: structural assertions cover geometry/structure/palette wiring, not final appearance, so
  the human reviewer decides whether that is sufficient to ungate each file; exportImg (the
  product-wedge export) may warrant staying gated until the pixel-diff harness exists. Frame it
  as "candidates," not a done deal.

**Not blocked by / independent of:** app runtime, localStorage/URL-hash, Cloudflare deploy path.

## Test Requirements

All new tests are unit tests added to `test/tests.html`. Acceptance: each of the three modules
is imported and exercised by ≥1 new `describe` block; full suite green headless via
`node .github/run-tests.mjs`; MCP tests unaffected.

### Category 1 — exportImg.buildExportSvg (structural)
New `describe("exportImg.buildExportSvg — structural")`:
- **Single root `<svg>` with `viewBox="0 0 W H"`** where `W = wM*96`, `H = hM*96` for a known
  fixture; assert `viewBox`, `width`, `height` are consistent and no `<parsererror>`.
- **Known room → one `<polygon>` with expected `points`.** Closed rectangle at known world
  coords; assert the fill polygon's `points` equal world→export px (`*96`, offset by margin),
  compared with `toBeCloseTo`.
- **One `<text>` dimension label per edge** for a closed room (n edges → n edge labels) plus
  **one `<text>` per symbol**; assert exact total `<text>` count for a fixture with rooms +
  symbols.
- **Escaped text content** (Edge Case 4): assert emitted label text is XML-safe (no raw `<`/`&`),
  and the round-tripped textContent matches the expected `fmtLen + unitLabel` / catalog label.
- **Empty plan → minimal SVG** (Edge Case 1): zero `<polygon>`, zero `<text>`, one `<rect>` bg.
- **Coordinate scale ties to `EXPORT_PX_PER_M`** (documented literal 96) — a 2 m edge spans
  192 px in export space.

### Category 2 — wallRender.render (mounted SVG)
New `describe("wallRender.render")`:
- **Layer groups populated correctly:** with a committed closed room and empty chain, `#world`
  gets fill + body + centerline polygons + N vertex-dot `<circle>`s; `#draft`/`#snap` empty.
  Assert child element counts by tag.
- **Geometry:** body/centerline `points` equal `worldToScreen` of room verts at identity view
  (`*40`); vertex-dot `cx/cy` match. Use `toBeCloseTo`.
- **Chain rendering:** a 2-vertex chain populates `#draft` (body + centerline polyline + dots);
  a 1-vertex chain renders only dots.
- **Snap glyph:** with a fixed `getSnap → {x,y,type:"grid"}`, `#snap` contains the diamond
  `<polygon>` + center `<circle>`.
- **Palette/theme wiring:** assert `stroke`/`fill` attributes equal `palette()` tokens
  (`wallBody`, `wallLine`, `roomFill`), not hardcoded strings.
- **Idempotent redraw:** calling `render()` twice yields the same child count (clears first).

### Category 3 — symbolRender.render (mounted SVG)
New `describe("symbolRender.render")`:
- **One group/body per symbol:** two symbols → two body `<polygon>`s in `#symbols`; assert count.
- **Transform/position:** body `points` equal screen-projected `corners(sym)`; a rotated symbol
  produces non-axis-aligned points.
- **Selected vs unselected styling differ** (Edge Case 8): unselected uses `symStroke`/`1.5`/
  `symFill`; selected uses `gold`/`2`/`symSelFill` and adds a selection-box polygon + rotate
  handle `<circle>` in `#overlay`. Assert both states and that they differ.
- **Palette wiring:** body colors come from `palette()` tokens.
- **Ghost:** with `getPlacementGhost` returning a ghost, `#overlay` gains the dashed ghost
  `<polygon>` + center snap `<circle>`.

### Regression / infra
- **Full suite green headless:** `node .github/run-tests.mjs` exits 0; new tests counted in
  `window.__testResult.total`.
- **MCP / other suites unaffected:** no shared-state leakage — each new `it` resets model, view,
  and unit (State Model). Run the suite twice / observe order-independence.
- **No production file diff:** the PR changes only `test/tests.html` (and this doc). Confirm
  `wallRender.js`, `symbolRender.js`, `exportImg.js`, `view.js`, `theme.js` are byte-unchanged.
