# LLD 151: Add a printed scale bar to PNG/SVG export

## Scope

Add a labeled **scale bar** to the exported document produced by
`src/js/exportImg.js` `buildExportSvg()` (which the PNG raster path in `exportPng()`
consumes unchanged). The bar is drawn in a new dedicated **bottom margin band** so it
never overlaps geometry, and reads correctly in both metric and imperial per the active
unit toggle at export time. Visual treatment is **Style A — the ruler ladder** (see
Frontend Design).

**Covers:**
- A reusable bottom-band region appended below the content viewport in the export SVG.
- A Style A ruler-ladder scale bar in that band, whose on-image pixel width is exactly
  `realLength_metres × EXPORT_PX_PER_M` (the testable invariant).
- Round-length selection driven by the active unit (`unitLabel()`): metric picks a round
  metre length, imperial a round foot length.
- Resolved concrete palette colors (both themes), consistent with existing export text.

**Explicitly does NOT cover (guards):**
- No change to *which* geometry is exported, no new export formats, no new
  dependency/build step, no change to on-canvas editor rendering (`wallRender`/
  `symbolRender`/`view`). Export path only.
- **No title/area caption and no credit line** — those are sub-issues #147 and #148,
  which will extend the band this LLD establishes.
- No new persisted state, no localStorage/URL-hash changes.

## Approach

### The band is the load-bearing structure
The band is the primitive #147 (caption) and #148 (finalize) build on, so it is defined
once as a clean region, not a one-off around the bar:

- **Content region** occupies `y ∈ [0, contentH]` where `contentH = hM × EXPORT_PX_PER_M`.
  The existing world→pixel maps `wx`/`wy` are **unchanged**, so all existing geometry
  coordinates are byte-identical to today (the band is purely additive below content).
- **Band region** occupies `y ∈ [contentH, contentH + BAND_PX]`.
- **Total height** `H = contentH + BAND_PX` for a non-empty plan. Total width `W` is
  unchanged (`wM × EXPORT_PX_PER_M`). The background `<rect>` grows to cover the band.

New module-private constants (siblings of the existing `EXPORT_PX_PER_M`/`MARGIN_M`):

```js
const BAND_PX      = 56;   // bottom band height, export px — houses scale bar; #147/#148 extend
const BAND_PAD_PX  = 16;   // inset from band/image edges
```

### Round-length selection (respects the unit toggle)
A ladder of round display-unit lengths; pick the **largest** that fits the available band
width (`W − 2·BAND_PAD_PX`), else the smallest:

```js
const SCALE_LADDER_M  = [1, 2, 5];       // metres
const SCALE_LADDER_FT = [1, 3, 5, 10];   // feet
```

- Active unit comes from `unitLabel()` (`"m"` | `"ft"`) — this is how the toggle is
  respected at export time, per guidance.
- `metres = (unit === "m") ? L : L × M_PER_FT` (import `M_PER_FT` from `units.js`).
- **Bar pixel width `barPx = metres × EXPORT_PX_PER_M`** — the invariant. The bar is never
  scaled to "fit"; selection only chooses which round L to draw.

### Label formatting
Label text = `` `${L} ${unitLabel()}` `` → `"1 m"`, `"3 ft"`. `unitLabel()` is reused so the
suffix tracks the toggle. `fmtLen()` is intentionally **not** used for the numeral: it emits
fixed decimals (`"1.00 m"`, `"3.0 ft"`) which reads wrong on a scale reference; `L` is
already a round integer in display units. All text runs through the existing `_escapeXml`.

### Empty plan → bar omitted
When `contentBounds()` is `null`, **omit the band and the bar entirely** — the export stays
the existing minimal 5×5 m frame with no band. This is the simplest valid behavior, matches
the acceptance criterion ("scale bar omitted"), and keeps the existing empty-plan structural
test green unchanged. (A scale bar with no geometry to measure adds no value.)

### Why lines, not polygons
The ruler is composed of `<line>` + `<text>` elements only. This keeps existing
`<polygon>`/`<polyline>` structural counts (room fill/body) unaffected — only `<text>`
count and total `H` change (see Test Requirements for the exact existing-test updates).

## Interfaces / Types

No changes to the public module surface (`contentBounds`, `buildExportSvg`, `exportSvg`,
`exportPng`). Two new module-private helpers in `exportImg.js`:

```js
/**
 * Choose the round scale-bar length for the active unit that fits availPx.
 * @param {number} availPx  usable band width = W - 2*BAND_PAD_PX
 * @returns {{ metres:number, label:string }}
 */
function _pickScaleBar(availPx)

/**
 * Emit the Style-A ruler-ladder scale bar inside the bottom band.
 * @param {number} W         total image width (px)
 * @param {number} contentH  height of content region (px); band starts here
 * @param {Palette} p        resolved theme palette (concrete colors)
 * @returns {string}         SVG fragment (a single <g class="scale-bar"> …)
 */
function _scaleBarSvg(W, contentH, p)
```

`buildExportSvg()` changes:
- Compute `contentH = H` (pre-band) then set `H = contentH + BAND_PX` **only when
  `bounds` is non-null**.
- Emit `bg <rect>` at the final `W × H`.
- After the existing body, if `bounds` is non-null, append `_scaleBarSvg(W, contentH, p)`.

New import: `import { fmtLen, unitLabel, M_PER_FT } from "./units.js";` (add `M_PER_FT`).

**Emitted structure (stable selectors for the test):**
```
<g class="scale-bar">
  <line class="scale-bar-line" x1=".." y1=".." x2=".." y2=".." stroke="{p.ink}" .../>  <!-- baseline -->
  <line .../>  <!-- end + subdivision ticks -->
  <text class="scale-bar-label" ...>{L} {unit}</text>
  <text ...>0</text>  <!-- origin mark -->
</g>
```
The baseline `<line class="scale-bar-line">` carries the invariant: `|x2 − x1| = barPx`.
The `<text class="scale-bar-label">` carries the label the test parses.

## State Model

Stateless and transient, consistent with the client-side-only invariant.
- No persisted state. The active unit is read live via `unitLabel()`; the theme palette via
  `palette()` (already resolved to concrete colors at build time, so the exported file is
  self-contained when opened outside the app).
- All band/bar geometry is computed per call to `buildExportSvg()`; nothing is cached.

## Edge Cases

1. **Empty plan** (`contentBounds()` null) → no band, no bar; minimal 5×5 m SVG unchanged.
   No crash.
2. **Metric vs imperial** → ladder + label switch on `unitLabel()`; `barPx` uses metres so
   both units land on exact pixel widths.
3. **Very narrow plan** (available band width < smallest ladder `barPx`) → draw the smallest
   ladder length anyway (invariant preserved; do NOT shrink the bar). Bar may approach the
   right inset on pathologically narrow plans — acceptable and rare; label stays legible.
4. **Bottom-edge dimension labels** sit at `≥ MARGIN_M` (0.5 m = 48 px) above `contentH`, so
   the band (below `contentH`) never overlaps them, walls, or symbols.
5. **XML safety** — label and "0" run through `_escapeXml` (defensive; current strings have
   no special chars).
6. **PNG path** — `exportPng()` parses `width`/`height` from the SVG via regex; the taller
   `H` flows through unchanged. No PNG-path code change needed.
7. **Theme** — colors come from `palette()`; dark/light both resolve concrete strings. In the
   headless test env this is the dark fallback (`p.ink = "#ece7d6"`, `p.dim = "#8f8a78"`).

## Dependencies

**Must already exist (all satisfied):**
- `exportImg.js` `buildExportSvg()` / `contentBounds()`; `EXPORT_PX_PER_M`, `MARGIN_M`.
- `units.js`: `unitLabel()`, `M_PER_FT` (already exported).
- `theme.js`: `palette()` → resolved `Palette`.

**Auto-merge / review gate:** `exportImg.js` is listed in `.claude/project.json`
`autoMerge.renderPaths` (per LLD 61). This PR modifies a render path, so it is **NOT
auto-merge eligible** and must go through the human render-path review gate. Do **not** edit
`project.json`.

**Downstream:** #147 (title/area caption) and #148 (layout finalize) build on the `BAND_PX`
band region and `_scaleBarSvg` structure introduced here.

## Test Requirements

### Unit — new (`test/tests.html`, in/near the `exportImg.buildExportSvg — structural` block)
- **Invariant (acceptance):** for a non-empty plan, parse the SVG, select
  `.scale-bar-line`, compute `|x2 − x1|`; read `.scale-bar-label` text, strip the unit, convert
  to metres (`m` → ×1, `ft` → ×`M_PER_FT`), multiply by `EXPORT_PX_PER_M` (documented literal
  96) and assert `toBeCloseTo` the measured pixel width.
- **Metric:** `setUnit("m")` → label ends in `" m"`, round integer numeral.
- **Imperial:** `setUnit("ft")` → label ends in `" ft"`, round integer numeral; invariant holds
  with `M_PER_FT` conversion.
- **Empty plan:** `resetAll()` → no `.scale-bar` group present; existing minimal-SVG counts
  (1 `<rect>`, 0 `<polygon>`, 0 `<text>`) still hold.
- **Palette wiring:** scale-bar stroke equals `palette().ink` (not a hardcoded hex).

### Unit — existing tests that MUST be updated (intended contract change)
The band height and the scale label change two invariants the LLD 61 structural block pins:
- `"single <svg> root with viewBox consistent with content"` — expected `H` becomes
  `contentH + BAND_PX` (was `288`; now `288 + BAND_PX`). Update both `viewBox` H and the
  `height` attribute assertion.
- `"dimension labels: n edges → n <text> nodes per closed room"` — now `n + 1` (adds the
  scale-bar label; note the `"0"` origin mark is a second `<text>` — count it, or exclude the
  `.scale-bar` group via selector). Update the expected count and/or scope the query to
  non-`.scale-bar` text.
- `"room edges + symbols → correct total <text> count"` — same adjustment (add the scale-bar
  text nodes, or scope the query).

The room-coordinate tests (`closed room → <polygon>`, `2 m edge spans 192 px`) and the shallow
`exportImg.buildExportSvg` block are **unaffected** (content mapping unchanged; bar uses
`<line>`, not polygon/polyline) and must stay green.

### Regression
- Full suite green headless via `node .github/run-tests.mjs`.
- Confirm PNG path still parses dimensions (no `exportPng` change) — covered indirectly by SVG
  width/height being well-formed.

## Frontend Design

**Style A — the ruler ladder** (CEO-selected to unblock the export-polish arc; a routine
execution choice — the bottom-band layout is shared across all three candidate styles, and
brand palette/typography is deferred to #46).

**Rationale (per product docs):** CLAUDE.md names a graph-paper / blueprint feel as the
candidate direction and the wedge is to-scale measuring ("does my couch fit?"). Style A reads
as a real measuring tool, reinforcing the differentiator rather than a generic map scale.

**Treatment (follow the approved Style A mockup for exact pixel values):**
- A horizontal **baseline** the full `barPx` width, left-anchored at `BAND_PAD_PX`, sitting in
  the band below `contentH`.
- **Subdivision ticks** along the bar at whole display sub-units (metric: 1 m boundaries, plus
  the 0.5 m midpoint when `L = 1`; imperial: 1 ft boundaries), with the **end ticks (at 0 and
  L) drawn taller** than interior ticks.
- A **"0" origin mark** under the left end and the **length label** (`"1 m"` / `"3 ft"`) at the
  right end / above the bar.
- Mono/blueprint aesthetic: baseline and ticks use `palette().ink`; label + "0" use
  `palette().dim` (matching existing dimension labels); font stack the module's `FONT_FAMILY`.
  Colors resolved concretely so both themes and external viewers render correctly.

Exact tick heights, spacing, and label offsets follow the approved mockup; the invariants that
must not drift: `barPx = realLength_metres × EXPORT_PX_PER_M`, unit tracks `unitLabel()`, colors
come from `palette()`.
