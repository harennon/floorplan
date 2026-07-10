# LLD 58: Light mode for the floor-plan editor (light background option)

## Scope

Adds a **light theme** ("P1 Paper" — warm cream ground, sepia ink, portfolio gold
accent retained) alongside the existing dark "warm blueprint" theme, plus a persisted
**theme toggle** and theme-aware **PNG/SVG export**.

**Locked direction (do not re-open):**
- Palette = P1 Paper: cream ground (~`#f3ecda`), sepia ink, retain the portfolio gold
  accent and the Libre Baskerville / DM Mono type pairing.
- **LIGHT is the default.** Initial theme follows `prefers-color-scheme`; when the OS
  expresses no/`light` preference it resolves to **light**, `dark` resolves to dark.
- Dark theme stays fully working at side-by-side parity.

In scope:
1. A persisted theme preference (localStorage), default resolved from
   `prefers-color-scheme` → light fallback.
2. A sun/moon toggle pill in the top-right chrome cluster (near Share / unit toggle).
3. **Unifying the split palette** so there is one source of truth: chrome already uses
   CSS custom properties in `:root`; the SVG render layer (`wallRender.js`,
   `symbolRender.js`) and `exportImg.js` currently use **hardcoded hex constants** and
   must be switched to read the active theme's tokens.
4. Theme-aware export: `exportImg.js` background / wall / room / symbol colors switch
   with the active theme (light export → light ground). This is an acceptance criterion.

Explicitly NOT covered:
- Full re-theming of unrelated surfaces beyond the editor and its exports.
- Template-gallery thumbnail SVGs (`templates.js`) — hardcoded palette; see Edge Cases
  (they render acceptably on both grounds and are chrome preview art, not the editor
  surface). Noted, not addressed here.
- Any change to plan-document schema, share-hash payload, or export geometry.
- A third/system-"auto" live-following mode after first load (toggle is a binary
  light/dark once the user picks; see Edge Cases).

## Approach

### One source of truth: CSS custom properties, read by the render layer

The chrome is already fully tokenised via `:root` custom properties in `index.html`.
The drift problem is that `wallRender.js`, `symbolRender.js`, and `exportImg.js` duplicate
those colors as hardcoded JS hex constants. The fix (per frontend-architect note) is to
make **CSS custom properties the single source of truth** and have the render/export
layers *read* them, rather than introducing a second hardcoded light palette (which would
double the drift).

Decision (recommended): **CSS-as-source + a thin `theme.js` cache.**

- All palette values (chrome + render + export) live as CSS custom properties in
  `index.html`: the existing `:root` block holds the **dark** values; a new
  `html[data-theme="light"] { … }` block overrides them for light.
- A new `theme.js` module:
  - Owns applying `data-theme` to `document.documentElement`.
  - Resolves the render/export tokens **once per theme change** via
    `getComputedStyle(document.documentElement).getPropertyValue(...)` into a cached
    plain-object `palette`, then notifies listeners.
  - Exposes `palette()` returning concrete color strings (and base RGB triples for
    alpha-composited fills — see below).
- `wallRender.js` / `symbolRender.js` replace their `const XXX = "#…"` with reads from
  `theme.palette()`. `exportImg.js` does the same when building the standalone SVG, so
  the exported file embeds concrete colors for the active theme (it cannot rely on CSS
  vars once opened outside the app).
- The grid (`grid.js`) already renders via CSS classes (`.grid-fine/major/axis`) that
  reference vars, so it re-themes automatically with no JS change.

**Alpha ladder via base RGB.** The render layers use many translucent gold fills at
varying alpha (`rgba(201,168,76,0.07 … 0.30)`). Rather than inventing a dozen tokens,
expose one base RGB triple token per accent (`--accent-rgb`, `--sym-ink-rgb`) and compose
`rgba(${rgb}, ${alpha})` in JS. This keeps the alpha ladder intact while themed by a
single value. Solid line/stroke colors remain their own concrete tokens.

**Alternative considered — JS-as-source (palette object in `theme.js`, injected into CSS
vars at runtime):** rejected. It would duplicate the chrome tokens already declared in
`index.html` (or force moving all of them into JS), reintroducing the drift the note
warns against. CSS-as-source keeps the existing chrome untouched.

### Persistence

Theme is an editor **preference** (must not appear in exported JSON / share hash), so it
belongs with `prefs.js` (the module whose docstring already states prefs must not leak
into exports). Extend `prefs.js` with a `theme` field; `theme.js` reads/writes it through
`prefs.js` and handles DOM application + palette caching + render re-trigger.

Default resolution at load (in `prefs.js`): persisted value wins; else
`matchMedia('(prefers-color-scheme: dark)').matches ? "dark" : "light"` (i.e. only an
explicit OS *dark* preference yields dark; everything else → light).

## Interfaces / Types

### `prefs.js` (extend)

```js
/** @typedef {{ gridSnap: boolean, theme: "light"|"dark" }} Prefs */

export function getTheme(): "light" | "dark"
export function setTheme(theme: "light" | "dark"): void   // persists + fires onPrefsChange
export function toggleTheme(): "light" | "dark"           // returns new value
```

- `_defaults.theme` is computed at module load from `prefers-color-scheme` (light
  fallback), NOT a hardcoded constant, so a first-time visitor with OS dark gets dark.
- `_load()` accepts a persisted `theme` of exactly `"light"` or `"dark"`; any other value
  falls back to the resolved default. Unknown keys ignored (existing behaviour).
- Persisted object now serialises both `gridSnap` and `theme`.

### `theme.js` (new module)

```js
/**
 * @typedef {{
 *   bg: string, bgDeep: string, ink: string, muted: string,
 *   gold: string, goldSoft: string,
 *   wallBody: string, wallLine: string, wallLineHi: string, draft: string,
 *   roomFill: string, roomFillHi: string,
 *   snapGrid: string, snapPoint: string, snapClose: string,
 *   symFill: string, symStroke: string, symSelFill: string,
 *   ghostFill: string, ghostStroke: string, snapTeal: string,
 *   dim: string,                 // dimension-label color (export)
 *   accentRgb: string,           // e.g. "201,168,76"  (compose rgba alphas)
 *   symInkRgb: string            // base rgb for symbol interior fills
 * }} Palette
 */

export function init(): void                 // apply persisted theme to <html>, build cache
export function getTheme(): "light"|"dark"   // delegates to prefs
export function setTheme(t): void            // prefs.setTheme + apply + refresh + notify
export function toggleTheme(): "light"|"dark"
export function palette(): Palette           // cached; concrete resolved color strings
export function onThemeChange(cb: (t) => void): void
```

- `init()` (called early in `main.js`, before first render): sets
  `document.documentElement.dataset.theme = prefs.getTheme()`, then `_refreshCache()`.
- `_refreshCache()` reads each token via
  `getComputedStyle(document.documentElement).getPropertyValue("--wall-line").trim()` etc.
- `setTheme`/`toggleTheme` → update `<html data-theme>`, `_refreshCache()`, fire
  `onThemeChange` listeners.

### Render modules (`wallRender.js`, `symbolRender.js`)

Replace top-of-file hardcoded color consts with per-render reads:
```js
import { palette } from "./theme.js";
// inside render(): const p = palette();
// use p.wallLine, `rgba(${p.accentRgb},0.30)`, etc.
```
No signature changes; the render loop already re-runs on `scheduleRender()`.

### `exportImg.js`

`buildExportSvg()` reads `palette()` at build time and substitutes the current
`BG_COLOR / WALL_BODY_COLOR / … / DIM_COLOR` constants with themed values. `FONT_FAMILY`
and geometry constants (`EXPORT_PX_PER_M`, `MARGIN_M`, `EXPORT_2X`) are unchanged.

### HTML / CSS (`index.html`)

- Existing `:root { … }` = dark values (unchanged), plus **new** render tokens that were
  previously JS-only: `--wall-line-hi`, `--sym-fill`, `--sym-stroke`, `--sym-sel-fill`,
  `--ghost-fill`, `--ghost-stroke`, `--snap-teal`, `--dim`, `--accent-rgb`,
  `--sym-ink-rgb`.
- New `html[data-theme="light"] { … }` override block with the P1 Paper values.
- New `.theme-toggle` button markup in the top-right cluster (see State/CX below).

## Frontend Design

**Approved direction: P1 Paper, light default.** Exact hex values are authored in the
reference mockup `design-mockups/light-mode-editor.html` (frontend-architect); that mockup
is the source of truth for the light palette and the toggle's visual treatment. The tokens
below are the implementation starting point and must be reconciled against the mockup
before merge.

Candidate light palette (`html[data-theme="light"]`):

| Token | Dark (current) | Light (P1 Paper, candidate) |
| --- | --- | --- |
| `--bg` | `#14140f` | `#f3ecda` (warm cream) |
| `--bg-deep` | `#100f0b` | `#e7dcc2` (deeper cream, vignette) |
| `--ink` | `#ece7d6` | `#3a3020` (sepia) |
| `--muted` | `#8f8a78` | `#8a7c60` |
| `--gold` | `#c9a84c` | `#a9812a` (deepened for contrast on cream) |
| `--gold-soft` | `rgba(201,168,76,.55)` | `rgba(169,129,42,.5)` |
| `--grid-fine` | `rgba(201,168,76,.055)` | `rgba(120,96,50,.07)` |
| `--grid-major`| `rgba(201,168,76,.14)` | `rgba(120,96,50,.16)` |
| `--grid-axis` | `rgba(201,168,76,.34)` | `rgba(120,96,50,.36)` |
| `--panel` | `rgba(20,20,15,.72)` | `rgba(248,242,228,.82)` |
| `--hairline` | `rgba(201,168,76,.18)` | `rgba(120,96,50,.22)` |
| `--wall-line` | `#d9be6e` | `#6b5836` (sepia ink) |
| `--wall-line-hi` | `#e8cf7a` | `#4f4022` |
| `--draft` | `#d9be6e` | `#6b5836` |
| `--accent-rgb` | `201,168,76` | `107,88,54` (sepia; powers wall-body/room fills) |
| `--sym-ink-rgb` | `201,168,76` | `107,88,54` |
| `--sym-stroke` | `#d9be6e` | `#6b5836` |
| `--snap-grid` / `--snap-teal` | `#7fd0c8` | `#2f8f86` |
| `--snap-point` | `#e0b64f` | `#b07d1e` |
| `--snap-close` | `#9cd67a` | `#3f8a2f` |
| `--dim` | `#8f8a78` | `#8a7c60` |

Design notes:
- **Gold accent retained** but deepened on cream so pressed/active chrome stays legible;
  frontend-architect confirms portfolio cohesion via the mockup.
- **Grain overlay** (`.grain`, `mix-blend-mode: overlay; opacity .035`) reads as a subtle
  darkening on cream — acceptable; if it muddies, gate opacity per theme (Edge Cases).
- The stage radial "table" gradient uses `--bg`/`--bg-deep`, so it re-themes for free.
- **Toggle affordance:** a single pill button `.theme-toggle` placed in the
  `.actions-cluster` / unit-toggle area (top-right). Shows a sun glyph in dark mode
  (click → go light) and a moon glyph in light mode (click → go dark);
  `aria-pressed`/`aria-label` reflect the *current* theme. Styled like the existing unit
  pills (uses `--panel`, `--hairline`, `--gold`).

## State Model

- **Theme preference:** `"light" | "dark"`, owned by `prefs.js`, persisted to
  `localStorage["floorplan:prefs:v1"]` alongside `gridSnap`. In-memory copy is the live
  authority. **Never** written to the plan document, export JSON, or share hash.
- **Applied theme (DOM):** `document.documentElement[data-theme]` — drives all chrome via
  CSS var cascade.
- **Cached palette:** in-memory object in `theme.js`, rebuilt on each theme change from
  computed CSS vars; read by render + export. Not persisted.
- **Default resolution:** persisted value → else `prefers-color-scheme` (dark→dark, else
  light). Resolved once at load; the toggle then sets an explicit value.

Boot order (in `main.js`, before first `render()`):
`prefs` load → `theme.init()` (sets `data-theme`, builds palette cache) → module inits →
first render.

Flow on toggle: click → `theme.toggleTheme()` → `prefs.setTheme` (persist) →
`data-theme` updated → palette cache refreshed → `onThemeChange` → `surface.scheduleRender()`
(re-paints SVG with new tokens; chrome updates via CSS automatically) → HUD/toggle labels
update via existing `onPrefsChange`.

## Edge Cases

1. **Corrupt/unknown persisted theme value** → fall back to resolved default (light unless
   OS dark). Same guard style as existing `gridSnap` load.
2. **localStorage write fails** (quota / private mode) → in-memory theme still applies for
   the session; swallow the error (mirrors existing `prefs.setGridSnap`).
3. **`prefers-color-scheme` unsupported / `matchMedia` absent** → default to light.
4. **OS theme changes mid-session after the user already has a persisted value** → do NOT
   override the user's explicit choice. (No live `matchMedia` listener re-applies theme;
   `prefers-color-scheme` only seeds the *first-ever* default.)
5. **`getComputedStyle` returns empty string for a token** (var typo / missing) → the
   render code must tolerate it; specify a hardcoded dark fallback per token inside
   `_refreshCache()` so a missing var never yields an invisible/`""` stroke.
6. **Export while empty plan** → unchanged behaviour; the empty SVG's `rect` background
   still uses the themed `bg`, so a light export of an empty plan is cream.
7. **Export color contrast:** light theme uses opaque sepia ink lines and low-alpha sepia
   fills over cream so walls/labels stay legible on white (verify dimension labels and
   symbol type labels remain readable — `--dim`/`p.dim`).
8. **Grain overlay on cream** may read as dirty; if so, add
   `html[data-theme="light"] .grain { opacity: .02 }` (or 0). Decide against the mockup.
9. **Length-chip / align-guide labels** hardcode a dark text color (`#14140f`) on a gold
   chip background — the chip is gold in both themes, so dark text stays legible; leave
   as-is (documented, not changed).
10. **Reduced-motion / no-transition** paths unchanged; theme switch is instantaneous
    (no crossfade required). A CSS `transition` on `--bg` is optional and must respect
    `prefers-reduced-motion`.
11. **SSR/opening exported SVG standalone** — exported file must contain concrete colors,
    not `var(--…)`; guaranteed because `exportImg.js` reads resolved `palette()` strings.

## Dependencies

- `prefs.js` (LLD 26) — extended for the `theme` field. Must land first / same change.
- `surface.js` render loop + `onRender`/`scheduleRender` — used to repaint on toggle.
- `wallRender.js`, `symbolRender.js`, `exportImg.js` — the hardcoded-palette modules being
  unified (this is the bulk of the work).
- `grid.js` — no code change (already CSS-var driven); relied upon for auto-theming grid.
- `index.html` — CSS token additions + `html[data-theme="light"]` block + toggle markup.
- `main.js` — wire `theme.init()` early and the toggle button’s click handler.
- Reference mockup `design-mockups/light-mode-editor.html` (frontend-architect) —
  authoritative for exact light hex values and toggle visual; must exist before final
  palette values are locked.
- No new runtime deps; no build step (consistent with project principles).

## Test Requirements

Unit:
- `prefs.getTheme` returns persisted value; unknown/corrupt → resolved default.
- Default resolution: with mocked `matchMedia`, OS `dark` → `"dark"`; `light`/no-pref →
  `"light"`; `matchMedia` absent → `"light"`.
- `setTheme`/`toggleTheme` persist to localStorage and fire `onPrefsChange`; theme value
  never appears in `serializePlan()` output or the share hash payload.
- `theme.palette()` returns non-empty concrete strings for every token in both themes;
  each token has a working fallback when its CSS var resolves to `""`.

Integration (DOM / render):
- Toggling theme sets `document.documentElement[data-theme]` and triggers exactly one
  re-render; walls, symbols, door swing arcs, snap glyphs, vertex dots, length chips,
  dim chips, measure panel, clearance panel, and HUD all render in both themes without
  missing/invisible strokes.
- Boot with no persisted theme + mocked OS light → app loads in light; with OS dark →
  dark. Persisted value overrides OS on reload.
- Export parity: `buildExportSvg()` background `<rect>` fill equals the themed `bg`
  (cream in light, near-black in dark); wall/room/symbol/label colors match the active
  theme. PNG raster path (`exportPng`) succeeds for both themes.

Visual / QA (manual, both themes side by side):
- Portfolio cohesion of P1 Paper vs. mockup; gold accent legibility on cream; grain
  overlay acceptability; contrast of dimension and type labels on white ground.
</content>
</invoke>
