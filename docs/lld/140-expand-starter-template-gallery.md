# LLD 140: Expand starter-template gallery with catalog-showcase plans (gaming room, kitchen, cozy living room)

## Scope

Pure **data authoring**. Append 3 new curated `Template` records to the frozen
`TEMPLATES` array in `src/js/templates.js`, matching the exact shape of the existing 4
(`id`, `name`, `description`, `thumb`, `plan`):

1. **Gaming room** — desk + monitor(s) + gaming-chair + rug (battlestation).
2. **Kitchen** — fridge + stove + sink + counter (cabinet) + table (work-triangle).
3. **Cozy living room** — sofa + armchair + coffee-table + tv + rug (conversation group).

Each record's `plan` is a full, valid `Plan` document (`schema:1`, `app:"floorplan"`,
`unit:"m"`) that passes `validatePlan`.

**In scope:** the 3 data records, their inline-SVG thumbnails, and one bumped/extended
test assertion so the gallery still passes (see Test Requirements — the existing
`TEMPLATES.length` bound of 3–5 must widen to admit 7).

**Explicitly NOT in scope:**
- Any new furniture/symbol types (#110/#113). Every symbol MUST resolve to an existing
  `CATALOG` type in `src/js/symbols.js`.
- Changes to `plan.js`, `symbols.js`, `main.js`, the gallery controller/render path, CSS,
  or `templates.js` logic (only the `TEMPLATES` array literal grows).
- Thumbnail auto-generation (#—) — thumbnails are hand-authored inline SVG.
- The blueprint visual identity (#46).
- New modules or dependencies.

## Approach

**Reuse, don't extend.** The gallery already renders one card per `TEMPLATES` entry
(`_renderCards`), and the load path (`applyTemplate` → `validatePlan` → confirm-if-dirty →
injected `apply` which calls `applyPlan` + `fitToContent`) is unchanged. This issue only
grows the `TEMPLATES` array literal. No control-flow, no CSS, no new module.

### Coordinate authoring rules (from `symbols.js` contract)
- Rooms are closed polygons; vertices are world **metres** near the origin. `fitToContent`
  re-centres on load, so absolute placement doesn't matter — only shape/scale do. Keep all
  three plans `unit: "m"`.
- Symbol `x,y` = **center**; `w` = width across local-x, `h` = depth along local-y; `rot`
  in degrees CW. A piece rotated 90° swaps its effective footprint (w↔h) — account for that
  when seating against a vertical wall.
- **Every symbol must lie inside its room** (footprint within the wall polygon), with the
  wall-adjacent edge flush-ish to the wall (small ~0.05 m gap is fine, like the shipped
  studio bed). **Doors sit ON a wall line** (center on the polygon edge), never mid-room,
  matching the existing templates (e.g. studio door `x:5.5` on the right wall).
- **No furniture–furniture overlap.** Exception: `rug` is a `floorLayer` — furniture is
  meant to sit on top of it (LLD 107), so a rug intentionally overlaps the group it anchors.
- Reuse only existing catalog widths/depths (defaults or documented presets) so each piece
  reads as a real product and `buildCompact`'s default-omission stays meaningful.

### Per-plan arrangement (interior-design principles)
- **Gaming room (~11 m², 3.5×3.2):** a battlestation — desk flush to one wall, two monitors
  seated at the back of the desk, gaming-chair centered in front with pull-in clearance, a
  5×8 rug under the seat/desk zone. Door on a free wall; window opposite the desk.
- **Kitchen (~10.8 m², 3.6×3.0):** a work-triangle — fridge and stove along the top wall,
  sink on the adjacent (left) wall rotated 90°, a cabinet run as counter, and a dining
  table with two chairs in the open lower half. Door on the bottom wall; window on the right.
- **Cozy living room (~15 m², 4.2×3.6):** a conversation group — sofa facing a wall-mounted
  TV across a coffee-table, one armchair angled in on the side, an 8×10 rug (rotated to
  landscape) anchoring the group. Door on the left wall; window on the right.

### Thumbnails
Hand-authored inline SVG, mirroring the shipped 4 exactly: `viewBox="0 0 120 90"`,
`xmlns`, `aria-hidden="true"`; room outline `rect` `fill:rgba(201,168,76,0.07)`
`stroke:#d9be6e` `stroke-width:1.5`; furniture `rect`s `fill:rgba(201,168,76,0.12–0.18)`
`stroke:#d9be6e` `stroke-width:1`; accent bands `rgba(201,168,76,0.28–0.30)`; round seats
as `<circle>`. Thumbnails are decorative/schematic — they need not be pixel-accurate to the
plan, only recognizable and stylistically consistent.

## Frontend Design

**Decision: proceed** — approved in the issue comments; no frontend gate to re-park.

The gallery's visual surface (card grid, thumbnail slot, hover/focus states, overlay
chrome) is already built and unchanged. The only frontend artifact this issue produces is
three inline-SVG thumbnails, and the design decision is simply to **mirror the established
thumbnail visual language** rather than introduce anything new:

- Palette locked to the existing gold-on-dark scheme (`#d9be6e` strokes, `rgba(201,168,76,*)`
  fills) so the new cards are visually indistinguishable in treatment from the shipped four.
- Same `120×90` viewBox and layering convention (room outline first, then furniture rects,
  then accent bands / circular seats).
- Each thumbnail should telegraph the plan's showcase pieces at a glance (a desk+chair+screens
  silhouette for gaming; appliance blocks along a wall for kitchen; a sofa/coffee-table/TV
  cluster for living), reinforcing the "look what the tool can do now" goal of the expansion.

No new CSS, no responsive/layout changes — the grid already reflows for N cards.

## Interfaces / Types

No new interfaces. Each new entry conforms to the existing `Template` typedef
(`src/js/templates.js` lines 25–32) and the `Plan` typedef (`plan.js`):

```js
/** @type {Template} */
{
  id: "gaming-room",            // stable, unique slug (kebab-case)
  name: "Gaming room",          // display name
  description: "~11 m² battlestation with desk, dual monitors & gaming chair",
  thumb: `<svg viewBox="0 0 120 90" ...>...</svg>`,  // inline SVG, mirrors existing 4
  plan: {
    schema: 1,
    app: "floorplan",
    walls: { rooms: [ { id: "r0", closed: true, verts: [ {x,y}, ... ] } ], chain: [] },
    symbols: { symbols: [ { id: "s0", type: <CATALOG key>, x, y, w, h, rot }, ... ] },
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  },
}
```

### Symbol types used (all pre-existing `CATALOG` keys — verified against `symbols.js`)
- **Gaming room:** `desk` (1.4×0.7), `monitor` (0.62×0.22, ×2), `gaming-chair` (0.66×0.66),
  `rug` (`5×8` preset 1.52×2.44), `door` (0.81×0.12), `window` (0.91×0.12).
- **Kitchen:** `fridge` (0.76×0.81), `stove` (0.76×0.71), `sink` (0.76×0.51, rot 90),
  `cabinet` (0.90×0.45 as counter run), `table` (`Dining 4` 1.22×0.90), `chair` (0.5×0.5,
  ×2), `door`, `window`.
- **Cozy living room:** `sofa` (2.0×0.9), `armchair` (0.8×0.8), `coffee-table` (1.1×0.55),
  `tv` (1.4×0.4), `rug` (`8×10` 2.44×3.05, rotated to landscape), `door`, `window`.

Each `id` within a plan is a unique `s<n>` string; `rooms[].id` is `r0` (or `w`-prefixed —
either passes `validatePlan`, which only requires a string). Follow the shipped `r0`/`s<n>`
convention for consistency.

## State Model

Unchanged. `TEMPLATES` is a module-level `Object.freeze`d constant — static data compiled
into the bundle, never mutated at runtime, never persisted. When a user selects a card:

1. `applyTemplate(id)` looks up the frozen record.
2. `validatePlan(record.plan)` returns a fresh normalised **copy** (deep-cloned via the
   normalise path) — the frozen literal is never handed to the live model.
3. Injected `apply(plan)` (in `main.js`) calls `applyPlan` (hydrates walls/symbols/
   measurements/view/unit modules in place) then `fitToContent` to frame it.
4. From there the plan participates in the normal in-memory → `localStorage` autosave and
   URL-hash/export flows like any user-drawn plan. Templates add no new persisted state.

## Edge Cases
## Edge Cases

1. **Existing `TEMPLATES.length` bound (3–5) will fail at 7.** `test/tests.html`
   ("LLD-43 — TEMPLATES metadata integrity") asserts `3 ≤ length ≤ 5`. Adding 3 to the
   current 4 makes 7. This assertion MUST be updated (widen the upper bound, e.g. to ≥7, or
   assert only a lower bound). Non-negotiable — otherwise the suite fails.
2. **Unknown symbol type → whole plan rejected.** `validatePlan` returns `null` if any
   `sym.type` is not `in CATALOG`, which the card-render path would surface as a broken load.
   Mitigation: only use the verified `CATALOG` keys listed above; the added
   "every entry validates" assertion catches regressions.
3. **Symbol dimensions outside catalog bounds.** `validatePlan` only checks finiteness, not
   `min/max_w/h`, so an out-of-range size would pass validation but render as an unrealistic
   piece. Mitigation: use catalog defaults or documented presets for every piece.
4. **Compact/URL-hash default omission (`buildCompact`).** `w`/`h` are dropped from the
   compact link only when strictly equal to `CATALOG[type].w/h`; `rot` dropped only when
   `0`. Non-default presets (e.g. rug 5×8, `Dining 4` table) simply serialize `w`/`h`
   explicitly — still lossless. No action needed; covered by the round-trip test.
5. **Furniture overlap vs. rug floor-layer.** A `rug` intentionally overlaps the furniture on
   top of it (LLD 107 `floorLayer` + two-tier `pickSymbol`). Non-rug pieces must NOT overlap
   each other. Verified visually + by the "loads and renders" QA step.
6. **Door placed off the wall line.** A door whose center isn't on a polygon edge renders
   floating mid-room. Mitigation: set door `x`/`y` on a room-edge coordinate and `rot` to
   match the wall orientation (0 for horizontal walls, 90 for vertical), exactly as the
   shipped studio/one-bedroom templates do.
7. **`fitToContent` with content near origin.** Plans are authored near origin; `fitToContent`
   computes bounds and re-centres, so no manual `view`/pan tuning is needed (leave
   `view:{zoom:1,panX:0,panY:0}` like the existing 4).
8. **Duplicate id collision.** New `id`s (`gaming-room`, `kitchen`, `cozy-living-room`) must
   not clash with existing (`studio`, `one-bedroom`, `single-room`, `small-office`); the
   "all ids unique" test guards this.

## Dependencies

All already exist — nothing new must be built first:
- `src/js/symbols.js` `CATALOG` — must already contain every type used (it does: `desk`,
  `monitor`, `gaming-chair`, `rug`, `fridge`, `stove`, `sink`, `cabinet`, `table`, `chair`,
  `sofa`, `armchair`, `coffee-table`, `tv`, `door`, `window`). This LLD adds **no** types.
- `src/js/plan.js` — `validatePlan`, `applyPlan`, `buildCompact`/`parseCompact`,
  `serializePlan` (unchanged; consumed as-is).
- `src/js/templates.js` — `TEMPLATES` array + gallery controller/render path (append-only).
- `src/js/main.js` — the injected `apply` callback wiring `applyPlan` + `fitToContent`
  (unchanged).
- `test/tests.html` — the existing "LLD-43" template test blocks (extended, see below).

Prior LLDs referenced (context only, no code dependency): LLD 43 (gallery), LLD 107 (rug
floor-layer), LLD 77/81 (compact codec), LLD 99 (presets).

## Test Requirements

Extend the existing `test/tests.html` "LLD-43" blocks; do not add a new test file.

**Unit (data integrity):**
- **Update the count bound** ("LLD-43 — TEMPLATES metadata integrity" › "has between 3 and
  5 templates") so 7 entries pass — widen the upper bound (or assert `>= 4`). Required to
  keep the suite green (Edge Case 1).
- Assert (or confirm existing loop covers) that **every** `TEMPLATES` entry passes
  `validatePlan` (Acceptance #1) — the existing "every template passes validatePlan" block
  already loops over all entries, so it covers the new ones automatically once added.
- Assert every symbol `type` in each new plan is `in CATALOG` (Acceptance #3). The
  `validatePlan` check already enforces this transitively; an explicit per-symbol assertion
  is optional but cheap.

**Integration (load + round-trip):**
- Existing "each template applies without error and is non-empty" and "walls model reflects
  the template after apply" loops cover the 3 new plans (Acceptance #2, load path).
- Existing "template round-trip: serialize → re-validate succeeds" loop covers
  export→import stability (Acceptance #4).
- Add/confirm a **compact-codec round-trip** for each template:
  `validatePlan(parseCompact(buildCompact(validatePlan(t.plan))))` succeeds and preserves
  room + symbol counts — this exercises the URL-hash share path (Acceptance #4). If the
  existing compact-codec suite doesn't already iterate `TEMPLATES`, add a small loop that does.

**Manual / QA (visual, not automated):**
- Open the gallery: a card renders for each new plan with its thumbnail, name, description.
- Click each: the plan loads and `fitToContent` frames it centered (Acceptance #2).
- No non-rug furniture overlaps; furniture sits inside walls; doors sit on wall lines; rug
  sits under its group.
- Live area/perimeter readout shows a sane value matching the authored room dimensions.

**Regression:** the full existing suite must stay green (Acceptance #5) — in particular the
metadata-integrity, apply, and round-trip blocks after the count-bound update.
