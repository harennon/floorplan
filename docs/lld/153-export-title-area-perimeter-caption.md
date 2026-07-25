# LLD 153: Add a title + area/perimeter caption to the exported plan

## Scope

Adds a **top caption band** to `buildExportSvg()` in `src/js/exportImg.js`. The band
shows a fixed title ("Floor plan") on the left and **total floor area · perimeter** on the
right, on a single baseline (drafting title-block convention, Option A). Values are the
same figures the live Measure HUD shows, so the caption can never disagree with the app.

Covered:
- New compact top band above the geometry; geometry + existing bottom scale bar shift down.
- Total area/perimeter computed by summing `roomMetrics(room)` over closed rooms — the
  exact code path `measure.js` uses (`src/js/measure.js:153-162`), not a re-implementation.
- Formatting via existing `fmtArea` + `areaUnitLabel` (area) and `fmtLen` + `unitLabel`
  (perimeter) so metric/imperial and m²/ft² are respected.
- Graceful degenerate handling: no enclosed area → caption omitted, SVG still valid.

NOT covered (guards):
- No editable/custom plan-name field — the title is the fixed literal "Floor plan".
- No credit line, no final margin reflow (that is #148).
- No typography/palette redesign (deferred to #46; colors inherited from `theme.palette()`).
- No new dependency, no build-step change; the export path only.

## Approach

**Frontend decision: Option A (split caption / title-block)** — see Frontend Design below.
Do NOT re-run the frontend gate.

- Add a **new** top band `CAPTION_PX` tall, kept separate from the existing bottom
  `BAND_PX = 56` scale-bar band (#146). Reuse the scale bar's band-layout conventions
  (`BAND_PAD_PX` inset, `FONT_FAMILY`, palette-driven colors, guard-on-`bounds` pattern),
  but the caption is its own `<g class="plan-caption">` fragment.
- **Layout:** title left-anchored at `BAND_PAD_PX`; metrics right-anchored at
  `W - BAND_PAD_PX`; both share one text baseline near the band's vertical centre. Keep
  `CAPTION_PX` small (recommend **40 px**) so the drawing stays dominant when thumbnailed.
- **Vertical composition:** extend `H` by the top-band height and translate the whole
  geometry-plus-scale-bar group down by that height so nothing overlaps. The caption is
  drawn in absolute top-band coordinates (no translate).
- **Value source of truth:** sum `roomMetrics(room).area` and `roomMetrics(room).perimeter`
  over `room.closed` rooms — identical to `measure.js update()`. This guarantees the
  caption equals the HUD's "Total Floor Area" and the summed per-room perimeter.
- Escape all text via the existing `_escapeXml`. Read colors from the resolved
  `palette()` (concrete hex, since the SVG may open outside the app).

## Interfaces / Types

New module-level constant in `exportImg.js`:
```js
const CAPTION_PX = 40;               // top caption band height, export px
const PLAN_TITLE = "Floor plan";     // fixed title (no custom-name field in v1)
```

New private helpers:
```js
/** Sum area + perimeter over closed rooms — same path as measure.js update(). */
function _planTotals()            // → { area:number, perimeter:number }

/** Emit the Option-A caption band (title left, "area · perimeter" right). */
function _captionSvg(W, p, totals) // → string  (<g class="plan-caption"> … </g>)
```

`_captionSvg` output (baseline `by = CAPTION_PX/2`, dominant-baseline="middle"):
- `<text class="plan-title" x="BAND_PAD_PX" y="by" text-anchor="start" …>Floor plan</text>`
- `<text class="plan-metrics" x="W - BAND_PAD_PX" y="by" text-anchor="end" …>{metrics}</text>`

Metrics string (separator is a middot per the Option-A decision; the mockup drew "/"):
```
`${fmtArea(area)} ${areaUnitLabel()} · ${fmtLen(perimeter)} ${unitLabel()}`
// e.g. imperial: "376.3 ft² · 113.5 ft"   metric: "34.96 m² · 34.60 m"
```

Colors: title `fill=p.ink`; metrics `fill=p.dim` (matches scale-bar label hierarchy).

`buildExportSvg()` changes:
```js
const totals = _planTotals();
const showCaption = !!bounds && totals.area > 0;   // enclosed area required
const topBand = showCaption ? CAPTION_PX : 0;
const H = (bounds ? contentH + BAND_PX : contentH) + topBand;
// wrap geometry + scale bar in a downward translate; caption stays in top-band space
const scaleBar = bounds ? _scaleBarSvg(W, contentH, p) : "";
const caption  = showCaption ? _captionSvg(W, p, totals) : "";
return [
  header…,
  `<rect width="${W}" height="${H}" fill="${p.bg}"/>`,
  `<g transform="translate(0,${topBand})">`, body, scaleBar, `</g>`,
  caption,
  `</svg>`,
].join("\n");
```

## State Model

Stateless / pure. No persistence, no new state. `buildExportSvg()` reads live
`walls.model.rooms` at call time (same models `measure.js` reads) and the active `unit`
from `units.js`. Nothing is stored; the caption reflects the model and unit at export.

## Edge Cases

1. **Empty plan (`bounds` null):** no caption, no scale bar, no top band; `H = contentH`
   (5×5 m placeholder). Unchanged from today; SVG valid.
2. **Open chains / furniture only, no closed room (`bounds` truthy, `area === 0`):**
   caption **omitted** (`showCaption` false → `topBand = 0`); scale bar still shown
   (guards on `bounds`). No enclosed area to report; SVG valid.
3. **Multiple closed rooms:** area and perimeter are the sums across all closed rooms —
   exactly matching the HUD total.
4. **Unit toggle (ft ↔ m):** formatting flows through `fmtArea`/`fmtLen`/labels, so the
   caption reflects the active unit; the perimeter separator/labels update accordingly.
5. **Very wide plan / long metrics string:** title is left-anchored, metrics right-anchored;
   on a narrow export they could meet in the middle. Acceptable for v1 (no wrapping/ellipsis);
   the band never overlaps geometry because it is its own top strip.
6. **Special characters:** title/metrics run through `_escapeXml` (labels contain `²`/`·`,
   which are valid UTF-8 text nodes; `_escapeXml` leaves them intact).
7. **PNG raster:** `exportPng()` parses `width`/`height` from the SVG; the taller `H` is
   picked up automatically — no change needed there.

## Dependencies

- **#146 scale bar (sub-issue 1) — already merged.** Provides `BAND_PX`, `BAND_PAD_PX`,
  `FONT_FAMILY`, `_scaleBarSvg`, and the guard-on-`bounds` pattern this LLD reuses.
- `walls.js`: `roomMetrics`, `polygonArea`, `perimeter` (existing).
- `units.js`: `fmtArea`, `areaUnitLabel`, `fmtLen`, `unitLabel` (existing).
- `theme.js`: `palette()` → `ink`, `dim`, `bg` (existing).
- No new packages, no build changes.

## Frontend Design

**Option A (split caption / title-block)** — CEO frontend decision on the issue; do not
re-open the gate. Typography/palette remain deferred to #46 and are inherited from
`theme.palette()`.

- **Layout:** single-baseline top band. Title ("Floor plan") flush-left at `BAND_PAD_PX`;
  `area · perimeter` flush-right at `W - BAND_PAD_PX`. This is the standard drafting
  title-block convention and reinforces the blueprint sensibility (CLAUDE.md "minimal
  chrome") without adding chrome.
- **Compactness:** `CAPTION_PX = 40` keeps the vertical footprint small so the geometry
  stays dominant when the PNG is thumbnailed in a DM — the core "sketch my studio and text
  the link" CX.
- **No hairline rule:** the bottom scale bar (#146) already anchors the lower band; a
  compact single-baseline top band balances the composition without Option C's extra rule.
- **Type scale:** title `font-size≈13`, metrics `font-size≈12`, `FONT_FAMILY` (DM Mono),
  matching the scale-bar label weight. Title uses `p.ink`; metrics use `p.dim`.
- **Both themes:** colors come from the concrete resolved palette, so dark and light
  exports both read correctly.
- **Degenerate:** when there is no enclosed area, the caption is omitted entirely (graceful,
  keeps the image clean); the SVG stays valid. (An alternative title-only placeholder was
  considered; omission is simpler and satisfies the acceptance criterion.)

## Test Requirements

Add to `test/tests.html` (`describe("exportImg.buildExportSvg …")`):

**Unit — value correctness (the key acceptance test):**
- For a known plan (e.g. the 3×2 m rectangle used by existing tests) in **metric** and in
  **imperial**, assert the `.plan-metrics` text equals
  `fmtArea(Σarea) + " " + areaUnitLabel() + " · " + fmtLen(Σperim) + " " + unitLabel()`,
  where `Σarea`/`Σperim` are computed from `roomMetrics` over the closed rooms — proving
  the caption cannot drift from the HUD source.
- Multi-room plan: metrics equal the summed totals across all closed rooms.

**Unit — structure & layout:**
- Non-empty plan with enclosed area: a `<g class="plan-caption">` exists with a
  `.plan-title` ("Floor plan") anchored `start` and a `.plan-metrics` anchored `end`.
- `H` grows by `CAPTION_PX` and geometry is wrapped in `translate(0, CAPTION_PX)` (verify
  the geometry group transform, or the new total `H = contentH + BAND_PX + CAPTION_PX`).
- Caption band does not overlap the scale bar (caption y within `[0, CAPTION_PX]`; scale
  bar y ≥ `CAPTION_PX`).

**Unit — degenerate:**
- Empty plan (`!bounds`): no `.plan-caption`; SVG parses without `parsererror`; `H = contentH`.
- Open-chain-only plan (`bounds` truthy, area 0): no `.plan-caption`; scale bar still
  present; SVG valid.

**Regression:**
- **Update the existing "viewBox consistent with content" test** (`tests.html` ~line 11003):
  it currently asserts `H = contentH + BAND_PX`; for a plan with enclosed area it must
  become `contentH + BAND_PX + CAPTION_PX`.
- All existing export + scale-bar tests must still pass (coordinate-scale, dimension-label
  count, palette-wiring, scale-bar presence/absence).
