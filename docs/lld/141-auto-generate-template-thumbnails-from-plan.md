# LLD 141: Auto-generate template thumbnails from plan data instead of hand-authored inline SVG

## Scope

**Covers.** A new `src/js/thumbRender.js` module exposing a single pure function
`renderThumbnail(plan, opts)` that returns an SVG-markup **string** rendered directly
from a `plan` object (rooms + room fills + symbol footprints + symbol interior glyphs).
`templates.js` drops the hand-authored `thumb` field from every `Template` and calls
`renderThumbnail(t.plan)` when building each gallery card. One headless unit test
asserting a known plan yields non-empty markup containing its rooms and symbols.

**Does NOT cover.**
- Interactive previews (hover-to-pan, zoom, click-through). Thumbnails are static markup.
- The 2.5D isometric / true-3D preview arc (#101 / #124) — thumbnails are top-down 2D only.
- The blueprint visual identity (#46).
- Gallery card chrome, hover/focus states, grid layout, or the overlay controller in
  `templates.js` — untouched beyond swapping how `.template-thumb` is filled.
- Changes to `exportImg.js`, `wallRender.js`, or `symbolRender.js` behaviour. This module
  composes the *same visual language* but does not modify those files (see Approach for
  the geometry-reuse note).
- The starter-gallery expansion itself (the dependency issue) — this issue only removes
  the need for hand-authored `thumb` on whatever templates exist.

## Approach

**Decision (fixed by selection): Option A — detailed glyphs.** Thumbnails paint each
symbol's footprint *and* its interior glyph (bed pillow, sofa back, stove burners, etc.),
so a card reads like a real miniature of the plan, not a set of blank boxes. This reuses
the interior-glyph recipes that already exist in `symbolRender.js`.

**New module `src/js/thumbRender.js`, pure string builder.** It mirrors the standalone,
view-independent approach of `exportImg.js` (compute world bounds → local projection →
emit SVG), but:
- takes an explicit `plan` argument instead of reading the global `walls`/`symbols`
  models, so it never touches or races the live editor state;
- returns a **fragment string** (an `<svg>…</svg>` element, no `<?xml?>` prolog) suitable
  for `innerHTML` injection into `.template-thumb`;
- emits **no** dimension labels, type-text labels, grid, snap glyphs, or measurements —
  the silence is what distinguishes a preview from an export (criterion: silent preview).

**Genuine glyph reuse via a behaviour-preserving extraction in `symbolRender.js`.** The
interior-glyph code (`_renderInterior`) currently reads the module-global `worldToScreen`
and `pxPerM()`. To reuse it off an arbitrary plan without a second copy of ~25 glyph
recipes, extract it into an exported pure helper that takes an injected projector instead
of reading globals:

```
export function appendSymbolInterior(parent, sym, cs, p, project, ppm)
```

`symbolRender.render()` keeps its current behaviour by calling it with the live
`worldToScreen` / `pxPerM()`; `thumbRender` calls it with its own local projector. This is
a pure refactor — no visual change to the live editor — and is the only edit to
`symbolRender.js`. Footprint polygons, room fills, wall bodies/centerlines, and rug
fills+hatch are short enough that `thumbRender` builds them directly (the same recipe as
`exportImg.js`), so no extraction is needed there.

> NB: `symbolRender` builds real SVG DOM nodes (`createElementNS`), while `thumbRender`
> emits a markup **string**. The cleanest reuse is a `project(worldX, worldY) -> {x,y}`
> function plus a tiny node-appending target. Since the glyph recipes call
> `parent.appendChild(document.createElementNS(...))`, `thumbRender` builds its symbol
> layer as a detached `<g>` DOM node, runs the shared helper against it, then serialises
> via `XMLSerializer`/`outerHTML` and concatenates into the fragment string. This keeps
> ONE copy of the glyph recipes. If serialising a detached node proves awkward in the
> headless test env, that is the trigger to fall back to Option B (see below).

**Paint order matches export** (`exportImg.js`): room fills + walls → rugs (floor layer) →
furniture footprints+glyphs → openings (doors/windows). Openings are ordinary symbols in
`plan.symbols.symbols`, so they fall out of the furniture pass; their opening marker/arc
glyph comes from the shared interior helper.

**Colors follow the active theme.** `thumbRender` reads resolved colors from
`palette()` (theme.js) at build time, exactly like `wallRender`/`exportImg`. Because cards
are rebuilt on gallery open (`_renderCards`), thumbnails reflect whatever theme is active
then. (Live re-theme of an already-open gallery is out of scope.)

**Fit-to-box.** viewBox is expressed in **world metres**: `viewBox="ox oy wM hM"` where
`ox = minX - margin`, `oy = minY - margin`, and `wM`/`hM` span content + margin. Combined
with `preserveAspectRatio="xMidYMid meet"` and the existing CSS
`.template-thumb { aspect-ratio: 4/3 }` box, any plan proportion is centered and
letterboxed into the card without distortion — no per-template tuning. Stroke widths use
`vector-effect="non-scaling-stroke"` so wall and glyph line weights stay crisp regardless
of how much the plan is scaled to fit.

**Fallback (flag, don't silently switch).** If wiring the projector through the interior
recipes proves heavier than expected (e.g. the detached-node serialisation is awkward, or
a glyph recipe hides a global dependency the extraction can't cleanly thread), fall back
to **Option B**: footprint polygons only (flat rotated bounding boxes, no interior
glyphs), which still satisfies every acceptance criterion. Raise this in code review
rather than switching quietly.

## Frontend Design

**Thumbnail is a silent top-down miniature of the plan.** Same marks and paint order as
PNG/SVG export, minus every textual/interactive affordance:

| Layer | Source | Notes |
| --- | --- | --- |
| Card background | CSS `.template-thumb` | Untouched (keeps 4:3 box + hairline). |
| Room fill | `room.color \|\| palette().roomFill` | Closed rooms with ≥3 verts. |
| Wall body | `palette().wallBody`, width `WALL_M` | `non-scaling-stroke`. |
| Wall centerline | `palette().wallLine`, 1.5px | `non-scaling-stroke`. |
| Rug (floor layer) | dashed edge + hatch | Same recipe as `exportImg.js` rug pass. |
| Furniture footprint | `sym.color \|\| palette().symFill` + `symStroke` | Rotated box via `corners(sym)`. |
| Furniture glyph | shared `appendSymbolInterior` | Option A detail. |
| Opening (door/window) | shared glyph (marker line + door arc) | Openings carry no fill label. |

**Explicitly omitted (what makes it a preview, not an export):** dimension chips, per-edge
length labels, symbol type-text labels, the grid, snap glyphs, selection boxes, rotate
handles, ghosts, and measurement lines.

**Framing.** `preserveAspectRatio="xMidYMid meet"` + world-metre viewBox with a small
world-space margin (reuse `MARGIN_M = 0.5` sensibility, may shrink to taste). A wide plan
letterboxes top/bottom; a tall plan letterboxes left/right. No plan-specific code.

**Accessibility.** The generated `<svg>` carries `aria-hidden="true"` (matching the
current hand-authored thumbs); the card's `aria-label` (name + description) already
conveys meaning, so the decorative preview stays out of the a11y tree.

**Not touched.** `.template-card` chrome, hover/focus styles, grid layout, overlay
open/close, Esc handling, outside-click — all unchanged.

## Interfaces / Types

### `src/js/thumbRender.js` (new)

```js
/**
 * @typedef {Object} ThumbOpts
 * @property {number} [marginM=0.5]  world-space margin around content (metres)
 */

/**
 * Render a static, silent SVG-markup string from a plan.
 * Rooms + fills + rug/furniture footprints + interior glyphs + opening glyphs.
 * NO dimension labels, type text, grid, snap glyphs, or measurements.
 * Colors are read from the active theme palette at call time.
 * Returns a minimal, valid placeholder <svg> if the plan has no drawable content.
 *
 * @param {import("./plan.js").Plan} plan
 * @param {ThumbOpts} [opts]
 * @returns {string}   an <svg …>…</svg> fragment (no <?xml?> prolog)
 */
export function renderThumbnail(plan, opts) { /* … */ }

/**
 * World-space bounds over a plan's room verts + symbol footprints.
 * Mirrors exportImg.contentBounds but reads the passed plan, not globals.
 * @returns {{minX,minY,maxX,maxY}|null}  null when nothing is drawable
 */
function planBounds(plan) { /* … */ }
```

The emitted root element:

```
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"
     viewBox="ox oy wM hM" preserveAspectRatio="xMidYMid meet">
  …fills, walls, rugs, furniture+glyphs, openings…
</svg>
```

(Width/height come from the CSS box — `.template-thumb svg { width:100%; height:100% }`.)

### `src/js/symbolRender.js` (edit — pure extraction)

```js
/**
 * Append a symbol's interior glyph to `parent`, using an injected projector
 * so the recipe is reusable off any coordinate system (live view OR thumbnail).
 * @param {SVGElement} parent
 * @param {import("./symbols.js").Sym} sym
 * @param {{x:number,y:number}[]} cs         screen/local corners [TL,TR,BR,BL]
 * @param {import("./theme.js").Palette} p
 * @param {(wx:number,wy:number)=>{x:number,y:number}} project  world→target
 * @param {number} ppm                        pixels/target-units per metre
 */
export function appendSymbolInterior(parent, sym, cs, p, project, ppm) { /* moved body of _renderInterior */ }
```

`render()` in the same file calls `appendSymbolInterior(parent, sym, cs, p, worldToScreen, pxPerM())`.

### `src/js/templates.js` (edit)

- Remove the `thumb` field from every `Template` literal and from the `@typedef`.
- In `_renderCards()`, replace `thumbSpan.innerHTML = t.thumb;` with
  `thumbSpan.innerHTML = renderThumbnail(t.plan);` (import `renderThumbnail`).

## State Model

**Stateless / pure.** `renderThumbnail` holds no module state. Its only reads are:
- the `plan` argument (rooms, chain, symbols) — never mutated;
- `palette()` from theme.js (a cached snapshot of resolved CSS-var colors);
- `CATALOG` / `corners` / `WALL_M` constants from `symbols.js` / `walls.js`.

**Nothing persisted, nothing in-memory beyond the call.** Thumbnails are produced on
demand inside `_renderCards()` (once per gallery open) and live only as `innerHTML` on the
card DOM. There is no cache; regeneration is cheap (a handful of templates, a few dozen
SVG elements each). No `localStorage`, no globals, no listeners.

**Independence from live editor.** Because `thumbRender` reads the passed plan rather than
the `walls`/`symbols` singletons, generating a thumbnail cannot perturb — and is not
perturbed by — whatever the user currently has drawn. This is the key difference from
`exportImg.js` (which intentionally reads the live models).

## Edge Cases

1. **Empty / no-content plan** (no rooms, no symbols): `planBounds` returns `null`. Emit a
   minimal valid placeholder `<svg>` (e.g. an empty 5×5m viewBox, background only) so the
   card still has a box. Mirrors `exportImg.buildExportSvg`'s empty branch.
2. **Symbols but no rooms** (or rooms but no symbols): bounds still computed from whatever
   exists; the fit logic is agnostic to which layers are present.
3. **Zero-width or zero-height content** (single point, or a degenerate 1-D plan): guard
   the viewBox against `wM<=0`/`hM<=0` by flooring to a small positive extent (margin
   already gives ≥ `2*marginM`), so no invalid viewBox / division by zero.
4. **Rotated symbols** (`rot ≠ 0`): footprint uses `corners(sym)`; glyphs use the injected
   projector — rotation is handled by the shared recipe exactly as in the live view.
5. **`sym.color` set**: honored for fill (matches export). Interior-glyph stroke keeps the
   theme `symStroke` (recipe already does this).
6. **Unknown symbol type** (`CATALOG[type]` missing): footprint still draws; the shared
   interior helper no-ops for unknown types (it only draws recognised recipes). Never throw.
7. **Rug (floor-layer) symbols**: painted in the floor pass below furniture with the dashed
   edge + hatch recipe; no glyph, matching export.
8. **Very large plan scaled tiny**: `non-scaling-stroke` keeps lines visible; glyph detail
   may become dense but stays legible enough for a thumbnail (acceptable — it's a preview).
9. **XML validity**: color strings from the palette can be `rgba(...)`; ensure attribute
   quoting matches `exportImg.js` (double-quoted attributes, no JSON.stringify). No user
   text is injected (labels are omitted), so no XML-escaping of dynamic strings is needed.
10. **Theme = light**: colors come from `palette()`, so a light-theme gallery yields
    light-theme thumbnails automatically. No hardcoded hex (unlike the old `thumb` SVGs,
    which were dark-only).

## Dependencies

**Must exist / true before implementation:**
- Existing modules reused as-is: `symbols.js` (`CATALOG`, `corners`), `walls.js`
  (`WALL_M`), `theme.js` (`palette`). These are stable.
- The `_renderInterior` recipes in `symbolRender.js` (the extraction source).
- The `.template-thumb { aspect-ratio: 4/3 }` CSS box in `index.html` — already present;
  relied on for fit-to-box. No CSS change required.
- **Issue dependency (ordering only):** "Expand starter-template gallery with
  catalog-showcase plans". This LLD does not require those templates to land first — it
  works against whatever `TEMPLATES` array exists — but shipping after the expansion means
  the new templates get correct previews for free (the point of the reuse path).

**No new runtime dependency added** (criterion #4). Pure vanilla JS + existing primitives;
no npm package, no `three`, no new rendering stack.

## Test Requirements

Headless unit test added to `test/tests.html` (the existing browser harness), consistent
with the surrounding suites.

**Unit — `thumbRender.js` (required by criterion #5):**
1. **Non-empty, room-bearing markup**: `renderThumbnail(studioPlan)` returns a string
   containing `<svg`, at least one `<polygon` for the room, and `preserveAspectRatio`.
2. **Symbols present**: for a plan with known symbols (e.g. a `bed` and a `sofa`), the
   markup contains a footprint polygon per symbol and the corresponding interior-glyph
   marks (assert on element count or a glyph-specific attribute, not on any type-*text*
   label — there are none).
3. **Silence assertions** (guards the preview/export boundary): markup contains no
   dimension-label text, no `type`-text label, and no grid/snap markup. Practical check:
   assert there is no `<text` element in the output.
4. **Empty plan**: `renderThumbnail({…walls:{rooms:[],chain:[]}, symbols:{symbols:[]}…})`
   returns a valid non-empty `<svg` string (placeholder branch), does not throw.
5. **Fit invariants**: viewBox width/height are positive and the viewBox origin reflects
   `minX - margin` for a known plan (proportion/margin sanity).

**Regression:**
6. **Existing suite still green** — run the full `test/tests.html`; the `symbolRender`
   extraction is behaviour-preserving, so no existing case should change. If a
   `symbolRender`/live-view snapshot test exists, it must remain unchanged.
7. **`templates.js` shape**: a light assertion that every `TEMPLATES` entry now has a valid
   `plan` and no longer needs `thumb` (i.e. `renderThumbnail(t.plan)` yields non-empty
   markup for each), demonstrating criterion #2 (plan alone suffices).

**Manual / QA (not automated here):** open the gallery in both light and dark themes and
confirm each card's thumbnail visually corresponds to the plan it loads (criterion #3).
