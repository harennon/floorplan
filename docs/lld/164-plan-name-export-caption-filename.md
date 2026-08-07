# LLD 164: Use the plan name as the export caption title and the download filename

## Scope

Confined to `src/js/exportImg.js`. Swaps the two hard-coded literals that LLD 153 / LLD 146
left behind so the exported artifact reflects the plan name added in LLD 157:

Covered:
- Use `getPlanName()` (from `planName.js`) as the caption **title** in `_captionSvg`,
  replacing the fixed `PLAN_TITLE = "Floor plan"` literal (~line 26/416). Fall back to
  `"Floor plan"` when the name is empty/absent so the caption never renders blank.
- **Truncate the caption title with an ellipsis** (CEO frontend decision, Option A) so a
  long name never overlaps the right-aligned `area · perimeter` metrics. Reserve the
  metrics width, clip the title to fit, append `…`. Display-only.
- Derive the download **filename** from the *full* (un-truncated) name via a slug, driving
  both `exportSvg()` (~line 250) and `exportPng()` (~line 294). Fall back to
  `floorplan.svg` / `floorplan.png` when the slug is empty.
- Preserve LLD 153 degenerate handling: no enclosed area → caption band omitted, SVG still
  valid; the filename is still derived from the name even in that case.
- Applies to both the SVG path and the 2× PNG raster path.

NOT covered:
- No change to the plan-name contract, live-state module, header UI, or persistence (that
  is LLD 157, already landed — this LLD only *consumes* `getPlanName()`).
- No change to the metrics string, scale bar, layout math, `CAPTION_PX`, or band geometry.
- No tab `<title>` / share greeting (that is #155).
- No new dependency, no build-step change.

## Approach

**Frontend decision: Option A — truncate the caption title with an ellipsis.** Decided by
the CEO; do not re-open the gate. See Frontend Design.

1. **Import the name at build time.** Add `import { getPlanName } from "./planName.js";`.
   In `_captionSvg`, resolve the display title as `getPlanName() || PLAN_TITLE`. Keep
   `PLAN_TITLE = "Floor plan"` as the fallback constant (do not delete it).

   **Control-char safety (do NOT assume the name is XML-clean).** `getPlanName()` returns
   only what `planName.js` `setPlanName` stores, and `setPlanName` (line 26–31) does
   *only* `.trim().slice(0, 60)` — it does **not** strip control characters. The
   control-char stripping (`/[\x00-\x1F\x7F]/g`, `plan.js` `_coerceName` line 34) runs
   *only* on the import/share deserialize path (`plan.js` lines 205, 362); the header input
   path (`main.js:911`) pipes `planTitleEl.value` straight into `setPlanName`, and
   `<input type=text>` value sanitization strips only CR/LF — not other C0 control chars.
   So a user who pastes a name containing e.g. U+0007 leaves that char in the live name.
   This LLD is the **first** code path to put the live name into the caption title, and
   XML 1.0 forbids most C0 control chars even as numeric character references — `_escapeXml`
   would emit them verbatim, `DOMParser` would raise `parsererror`, and `exportPng` would
   throw "PNG export failed" while the SVG downloads corrupt (directly harming the
   "shareable artifact" value).

   **Fix:** strip control characters on the caption-title path before escaping, reusing the
   same rule as `_coerceName`. Add a tiny pure helper `_stripControl(s)` in `exportImg.js`
   (`s.replace(/[\x00-\x1F\x7F]/g, "")`, `// eslint-disable-next-line no-control-regex`) and
   apply it to `rawTitle` before `_fitTitle`/`_escapeXml`. Do **not** reach into `plan.js`
   for this (would create an unwanted `exportImg → plan` coupling); a 1-line local copy of
   the character class is the surgical choice. The slug/filename path is **unaffected** —
   its `[a-z0-9-]` allowlist (step 4 of `_slugifyName`) already drops these chars.

2. **Truncation is display-only and lives in `_captionSvg`.** The band has a fixed width
   `W`; the metrics are right-anchored at `W - BAND_PAD_PX`, the title left-anchored at
   `BAND_PAD_PX`. Reserve the metrics width plus a gap, compute the title's available pixel
   width, and if the title overflows, drop trailing characters and append `…` until it
   fits. Because the SVG builder has no DOM text-measurement API, use a **monospace width
   estimate**: `FONT_FAMILY` is DM Mono, so every glyph advances a fixed fraction of the
   font size. Approximate title advance as `chars * TITLE_FONT_PX * MONO_CH_RATIO`
   (`MONO_CH_RATIO ≈ 0.6` for DM Mono at the `font-size="13"` title). This is a heuristic
   fit, not pixel-perfect metrics — sufficient to guarantee no visible overlap without
   pulling in a measurement dependency (aligns with CLAUDE.md "add a dependency only when
   it removes more complexity than it adds"). Metrics width is estimated the same way at
   its `font-size="12"`.

3. **Filename slug is derived from the full name**, computed once and shared by both export
   paths. New pure helper `_planFilename(ext)` returns `${slug || "floorplan"}.${ext}`.
   `exportSvg()` calls `_triggerDownload(url, _planFilename("svg"))`; `exportPng()` calls
   `_triggerDownload(url, _planFilename("png"))`. Slug is derived from `getPlanName()`, NOT
   the truncated caption title, so `"My Very Long Studio Name…"` (clipped in the caption)
   still yields `my-very-long-studio-name.svg`.

4. **Degenerate cases are untouched.** The `showCaption` guard (`!!bounds && area > 0`)
   and the empty-plan branch are unchanged. When the caption is omitted the filename is
   still derived from the name (so an unfinished, named, area-less plan still downloads
   under its name). When the name is empty everywhere, both fall back to `floorplan.*`.

## Interfaces / Types

`src/js/exportImg.js` additions/changes:

```js
import { getPlanName } from "./planName.js";           // NEW

// Title truncation tuning (monospace estimate; DM Mono ≈ 0.6 em advance).
const TITLE_FONT_PX   = 13;    // matches existing .plan-title font-size
const METRICS_FONT_PX = 12;    // matches existing .plan-metrics font-size
const MONO_CH_RATIO   = 0.6;   // approx glyph advance / font-size for DM Mono
const TITLE_METRICS_GAP_PX = 16; // min gap between title and metrics

/** Slug the plan name for a filename; "" when nothing usable remains. */
function _slugifyName(name) // → string   (e.g. "My Studio" → "my-studio")

/** Full download filename for an export. @param {"svg"|"png"} ext */
function _planFilename(ext) // → string   ("floorplan.<ext>" when slug empty)

/** Fit a title into availPx (monospace estimate), clipping with "…" if needed. */
function _fitTitle(title, availPx) // → string

/** Strip C0/DEL control chars so the caption title is XML-safe (see Approach §1). */
function _stripControl(s) // → string   (s.replace(/[\x00-\x1F\x7F]/g, ""))
```

`_slugifyName(name)` algorithm (order matters):
1. `name.normalize("NFKD")` then strip diacritic combining marks (`/[̀-ͯ]/g`).
2. Lowercase.
3. Replace runs of whitespace and underscores with a single `-`.
4. Drop every character not in `[a-z0-9-]`.
5. Collapse repeated `-` and trim leading/trailing `-`.
6. Return the result (may be `""`).

`_planFilename(ext)`:
```js
const slug = _slugifyName(getPlanName());
return `${slug || "floorplan"}.${ext}`;
```

`_captionSvg(W, p, totals)` change — resolve and fit the title:
```js
const rawTitle    = _stripControl(getPlanName()) || PLAN_TITLE; // control-char safe
const metricsPx   = metricsStr.length * METRICS_FONT_PX * MONO_CH_RATIO;
const titleAvailPx = (W - 2 * BAND_PAD_PX) - metricsPx - TITLE_METRICS_GAP_PX;
const title       = _fitTitle(rawTitle, titleAvailPx);
// … existing <text class="plan-title" …>${_escapeXml(title)}</text>
```
Note: `_stripControl` is applied **before** the `|| PLAN_TITLE` fallback so a name that is
all control chars (strips to `""`) correctly falls back to `"Floor plan"`.

`_fitTitle(title, availPx)`:
- If `availPx <= 0`, return `"…"` (never render nothing when a name is present).
- Compute `perChar = TITLE_FONT_PX * MONO_CH_RATIO`. If `title.length * perChar <= availPx`,
  return `title` unchanged.
- Otherwise `maxChars = max(0, floor(availPx / perChar) - 1)` (reserve one glyph for `…`);
  return `title.slice(0, maxChars).trimEnd() + "…"`.

`exportSvg()` / `exportPng()`: replace the literal `"floorplan.svg"` / `"floorplan.png"`
arguments to `_triggerDownload` with `_planFilename("svg")` / `_planFilename("png")`.

## State Model

Stateless / pure, unchanged from LLD 153. `buildExportSvg()` and the download helpers read
the live plan name at call time via `getPlanName()` (single source of truth in
`planName.js`). Nothing is persisted or added to any contract here. The caption title and
the filename both reflect the name in effect at export time; the caption applies
display-only truncation, the filename uses the full name.

## Edge Cases

1. **Named plan, short name** → caption title = name; filename = slug (`"My Studio"` →
   `my-studio.svg`).
2. **Unnamed plan (`getPlanName() === ""`)** → caption title = `"Floor plan"`; filename =
   `floorplan.svg` / `floorplan.png`. No regression vs. today.
3. **Long name that would overlap metrics** → title clipped with `…` so it fits
   `titleAvailPx`; metrics never overlapped; filename still uses the *full* name's slug.
4. **Slug reduces to empty** (emoji-only "🏠🏠", symbols-only "!!!", whitespace-only,
   or non-ASCII like Japanese "図面" with no diacritic base) → `_slugifyName` returns `""`
   → filename falls back to `floorplan.*`. The caption title still shows the raw name
   (escaped), since that is legible text even when un-sluggable.
5. **Diacritics** ("Café Plan") → NFKD + combining-mark strip → `cafe-plan.svg`.
6. **Special chars / punctuation** ("Flat #3 (v2)!") → non-`[a-z0-9-]` dropped, spaces →
   `-`, collapsed → `flat-3-v2.svg`.
7. **Underscores / mixed whitespace** ("my\_\_studio  plan") → `my-studio-plan.svg`.
8. **No enclosed area, name set** → caption band omitted (LLD 153 intact), SVG valid, but
   filename still derived from the name (e.g. `my-studio.svg`).
9. **Empty plan (`!bounds`)** → no caption; filename derived from name if any, else
   `floorplan.*`. SVG valid.
10. **Name with XML-significant chars** ("A & B <x>") in the caption → `_escapeXml` handles
    it (unchanged path); the slug drops `&`/`<`/`>` → `a-b-x.svg`.
11. **PNG path** → same `_planFilename("png")`; the taller `H` and caption are already
    picked up by the existing raster path (LLD 153 Edge Case 7). Consistent with SVG.
12. **Near-cap 60-char name** on a wide export where it fits → no truncation, full title;
    on a narrow export → truncated. Filename always uses the full 60-char slug.
13. **Name containing control chars** (e.g. a pasted string with U+0007, only trimmed/capped
    by `setPlanName`, never control-stripped for the header-input path) → `_stripControl`
    removes them before escaping → caption parses without `parsererror`, PNG export does not
    throw. If the name is *entirely* control chars, it strips to `""` and the title falls
    back to `"Floor plan"`. The slug path already drops these via its `[a-z0-9-]` allowlist.

## Dependencies

- **LLD 157 — landed.** Provides `getPlanName()` in `src/js/planName.js`. **Caveat:**
  `setPlanName` only trims and caps at 60 — it does **not** strip control characters (that
  lives in `plan.js` `_coerceName`, on the import/share path only). This LLD therefore
  strips control chars itself on the caption-title path (see Approach §1). Do not rely on
  `getPlanName()` being XML-clean.
- **LLD 153 — landed** (commit `6f5d074`). `_captionSvg`, `PLAN_TITLE`, `CAPTION_PX`, and
  the `showCaption` guard already exist in `src/js/exportImg.js`; this LLD edits them
  in place. No sequencing dependency remains.
- `planName.js` (existing), `theme.js`, `units.js`, `walls.js` — all existing; no new
  packages, no build change.

## Frontend Design

**Option A — truncate the caption title with an ellipsis.** CEO decision; do not re-open
the gate.

Rationale (CEO): the plan name is now user-controlled, so a long name on a narrow export is
a real state users will hit, and the export PNG/SVG is the artifact people send (the
"shareable artifacts" differentiator, CLAUDE.md). A title/metrics collision reads as broken
and undermines the "feels personal and finished" goal this issue serves. Option B's bounded
overlap is visibly ugly in exactly the personalized-name case being added. Option A's cost
is a small text-measurement pass in the SVG builder — a reasonable price to keep the
exported artifact clean.

Design specifics:
- **Truncation is caption-display only.** The filename is derived from the full,
  un-truncated name.
- **Reserve the metrics width first**, then fit the title into the remaining width minus a
  `TITLE_METRICS_GAP_PX` gutter, clipping with a single trailing `…`.
- **Monospace width estimate**, not DOM measurement: `FONT_FAMILY` is DM Mono (fixed
  advance), so `chars * font-size * MONO_CH_RATIO` is a close, dependency-free estimate.
  It biases slightly conservative (truncates a hair early) which is the safe direction for
  guaranteeing no overlap. Font-fallback ("Courier New"/generic monospace) is also
  fixed-advance, so the estimate holds across environments.
- **Never render an empty title** when a name is present: if the reserved space is
  degenerate (`availPx <= 0`), fall back to `"…"`.
- **Type scale, colors, layout, `CAPTION_PX` unchanged** from LLD 153 (title `p.ink`
  size 13; metrics `p.dim` size 12; single baseline). Both themes inherit from resolved
  `palette()`.
- **Degenerate handling preserved:** no enclosed area → caption band omitted, SVG still
  valid.

## Test Requirements

Add to `test/tests.html`. The download helpers trigger real DOM downloads, so **export the
filename helper** (or `_planFilename`) for direct assertion rather than intercepting
`_triggerDownload`. Add `_slugifyName`/`_planFilename` to the `exportImg.js` test import
block.

**Unit — caption title:**
- Named plan with enclosed area → `.plan-title` text equals the plan name (set via
  `setPlanName`), not `"Floor plan"`.
- Unnamed plan (name `""`) with enclosed area → `.plan-title` text equals `"Floor plan"`
  (fallback; no regression vs. LLD 153 tests).
- Long name (e.g. 60 chars) on the standard small test plan → `.plan-title` ends with `…`
  and is shorter than the raw name; assert the title does not extend past the metrics
  (estimated title end x < metrics start x, or simply that it was truncated).
- Name with XML-significant chars ("A & B <x>") → caption parses without `parsererror` and
  title round-trips as literal text.
- Name with a control char (e.g. `"PlanX"` set via `setPlanName`) with enclosed area →
  caption parses without `parsererror`, the exported SVG string round-trips through
  `DOMParser` cleanly, and `.plan-title` text has no control char. A name that is *only*
  control chars → title falls back to `"Floor plan"`.

**Unit — filename slug (`_slugifyName` / `_planFilename`):**
- `"My Studio"` → `my-studio`; `_planFilename("png")` → `my-studio.png`,
  `_planFilename("svg")` → `my-studio.svg`.
- Unnamed → `_planFilename` returns `floorplan.png` / `floorplan.svg`.
- Diacritics "Café Plan" → `cafe-plan`.
- Special chars "Flat #3 (v2)!" → `flat-3-v2`.
- Underscores/whitespace "my\_\_studio  plan" → `my-studio-plan`.
- Slug-empty edge cases (emoji-only, symbols-only, whitespace-only, non-ASCII Japanese) →
  `_slugifyName` returns `""` and `_planFilename` falls back to `floorplan.<ext>`.
- Filename uses the **full** name even when the caption title is truncated (set a long
  name; assert `_planFilename` slug is derived from the whole name, not the clipped title).

**Unit — degenerate (LLD 153 preserved):**
- No enclosed area (open chain / furniture only), name set → no `.plan-caption`; SVG parses
  without `parsererror`; `_planFilename` still returns the name's slug.
- Empty plan (`!bounds`) → no caption; SVG valid; `_planFilename` falls back to
  `floorplan.*` when unnamed.

**Regression:**
- Existing LLD 153 caption tests stay deterministic as-is: the caption `describe` block's
  `buildClosedPlan()` path calls `resetAll()`, which already calls `setPlanName("")`
  (`tests.html:3110`). So the existing `.plan-title` === "Floor plan" assertions keep
  passing with no new scaffolding. The **new** named-plan title test just needs to call
  `setPlanName("…")` *after* `buildClosedPlan()` (and rely on the next test's `resetAll()`
  to clear it). Do not add a redundant `setPlanName("")` reset — it already runs.
