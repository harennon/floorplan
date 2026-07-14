# LLD 138: Expand starter-template gallery with catalog-showcase plans (gaming room, kitchen, cozy living room)

## Scope

**Covers:** Adding 3 new curated `Template` records to the frozen `TEMPLATES` array in
`src/js/templates.js` — a **gaming room**, a **kitchen**, and a **cozy living room** — each a
full, valid `Plan` document that showcases catalog pieces added since the original gallery
shipped (#41 / LLD 43). Each new record follows the existing `{ id, name, description, thumb,
plan }` shape and reuses the existing gallery renderer and load path unchanged. Also covers
extending the test suite so the added templates are exercised by the existing `TEMPLATES`
iteration and asserting the count/metadata bounds still hold.

**Does NOT cover:**
- Any new furniture/symbol types. Every symbol used must already exist in `CATALOG` in
  `src/js/symbols.js` (tracked separately: fireplace #113, others #110). The cozy living room
  uses **sofa + armchair + coffee-table + rug + tv**, NOT a fireplace.
- Thumbnail auto-generation from the plan (separate sub-issue). Thumbnails remain hand-authored
  inline SVG per the LLD 43 convention.
- The blueprint visual identity (#46).
- Any change to `plan.js`, `symbols.js`, `share.js`, `store.js`, the gallery controller logic,
  the overlay markup/CSS, or the `Plan` schema. No new modules, no new dependencies.

## Approach

**Data-only change.** This issue appends three object literals to the existing frozen
`TEMPLATES` array. The gallery renderer (`_renderCards` in `templates.js`) already builds one
`.template-card` per entry, and `applyTemplate(id)` already runs the full load path
(`validatePlan` → confirm-if-dirty → injected `apply` = `applyPlan` + `historyReset` +
`fitToContent` + `render`). No control-flow code changes are required; the new plans ride the
existing machinery. This directly satisfies the reuse-path constraint and the client-side-only /
lean-build invariants.

**Authoring method (hard requirement).** Each plan MUST be authored by drawing the room in the
live app and exporting JSON (the documented path in the `templates.js` header comment), then
pasted as the `plan` literal. Do NOT hand-fabricate coordinates. This is the fastest way to
guarantee in-catalog geometry, valid vertices, sensible symbol `w`/`h` within each type's
`min`/`max`, and non-overlapping placement that reads well. All plans use `unit: "m"` (world
coords are metres), matching the 4 existing templates.

**Catalog constraint (hard requirement).** Every `symbol.type` in every new plan must be a key
present in `CATALOG` (`src/js/symbols.js`). `validatePlan` rejects any plan containing an
unknown type (`if (!(sym.type in CATALOG)) return null;`, plan.js:256), so an out-of-catalog
type would fail the gating test rather than silently rendering a fallback. Confirmed available
catalog types for the three plans:
- **Gaming room:** `gaming-chair`, `monitor`, `desk`, `rug` (+ `door`, `window` for the shell).
- **Kitchen:** `fridge`, `stove`, `sink`, `table` (or `dining-table-round`) (+ `door`,
  `window`). "counter" is not a catalog type — approximate counters with `sink`/`stove`
  appliances and a `cabinet` if a run is wanted; do not invent a type.
- **Cozy living room:** `sofa`, `armchair`, `coffee-table`, `rug`, `tv` (+ `door`, `window`).

**Symbol sizing.** Prefer catalog default or preset `w`/`h` for each type so pieces read as
to-scale (e.g. `gaming-chair` 0.66×0.66, `monitor` 0.62×0.22, `desk` 1.40×0.70, `rug` presets,
`sofa` 2.10×0.95, `coffee-table` 1.10×0.55, `tv` 1.40×0.40, `fridge` 0.76×0.81). Sizes are not
strictly validated but should stay within per-type `min`/`max` for a clean look and to match the
"does my couch fit?" measuring focus.

**Thumbnails.** Author one decorative inline-SVG thumbnail per new template following the exact
pattern of the existing four (120×90 `viewBox`, blueprint palette: fill `rgba(201,168,76,0.07)`
room, stroke `#d9be6e`, furniture rects at higher fill alpha, `aria-hidden="true"`). The thumb
is a sketch, not a render of the plan.

## Frontend Design

**Decision: proceed.** No frontend architecture change — this reuses the LLD 43 gallery UI
verbatim.

- **Rendering:** unchanged. `_renderCards()` iterates `TEMPLATES` and emits a `<button
  class="template-card" role="listitem">` with `.template-thumb` (innerHTML = `t.thumb`),
  `.template-card-name` (`t.name`), and `.template-card-desc` (`t.description`) for every entry,
  including the three new ones. No markup or CSS edits.
- **Grid layout:** the responsive `.template-grid` (`repeat(auto-fill, minmax(...))`) already
  reflows from 4 to 7 cards with no change; the modal panel scrolls if needed.
- **Card interaction:** unchanged — click → `applyTemplate(t.id)` → confirm-if-dirty →
  injected `apply` (applyPlan + historyReset + fitToContent + render) → `close()` → toast
  `"Loaded '<name>'"`.
- **Copy guidance:** `name` short and recognizable ("Gaming room", "Kitchen", "Cozy living
  room"); `description` a one-line blurb with approximate area and headline pieces, matching the
  existing tone (e.g. "~12 m² battlestation with desk, dual monitors & gaming chair").
- **Visual language:** thumbnails reuse the existing blueprint stroke/fill tokens; introduce no
  new color tokens.

## Interfaces / Types

No new or changed interfaces. New records conform to the existing `Template` typedef
(templates.js:25-32):

```js
/**
 * @typedef {Object} Template
 * @property {string} id           stable slug (unique across TEMPLATES)
 * @property {string} name         display name
 * @property {string} description  one-line card blurb
 * @property {string} thumb        inline SVG markup (decorative preview)
 * @property {import("./plan.js").Plan} plan  a full, valid Plan document
 */
```

New `id` slugs (must be unique vs. existing `studio`, `one-bedroom`, `single-room`,
`small-office`): `gaming-room`, `kitchen`, `living-room`.

Each `plan` literal is a full `Plan`:
```js
{
  schema: 1,
  app: "floorplan",
  walls: { rooms: [ { id, closed: true, verts: [ {x,y}, ... ] } ], chain: [] },
  symbols: { symbols: [ { id, type, x, y, w, h, rot }, ... ] },
  view: { zoom: 1, panX: 0, panY: 0 },
  unit: "m",
}
```
(`measurements` may be omitted; `validatePlan` normalises absent → `[]`, plan.js:276.)

## State Model

Identical to LLD 43 — no new state.
- **Template definitions:** static, in-bundle, frozen (`Object.freeze` on the array). Never
  fetched, never mutated. `applyTemplate` applies the `validatePlan` return value (a fresh deep
  copy), so the frozen source literals are never mutated by downstream live models.
- **Applied plan:** once loaded, lives in the ordinary `wallsModel` / `symbolsModel` / `view` /
  `unit`, indistinguishable from a hand-drawn plan. Autosave, undo baseline (`historyReset`),
  share-hash cache, and export all reuse the existing render/onRender hooks.
- **Persistence:** none added. No new localStorage keys, no schema bump.

## Edge Cases

1. **Out-of-catalog type slips into a plan.** `validatePlan` returns `null`; the gating test
   "every template passes validatePlan" fails the build before ship. Mitigation: author via the
   live-app export path so only catalog types are ever produced.
2. **"counter" / "kitchen island" temptation.** These are not catalog types. Approximate with
   `sink` + `stove` + `cabinet`/`fridge`; do NOT add a type in this issue.
3. **Duplicate `id`.** Existing metadata test ("all ids are unique") fails. Use the three slugs
   above, distinct from the four existing.
4. **Symbol `w`/`h` outside a type's `min`/`max`.** Not rejected by `validatePlan` (only
   finiteness is checked), so it will load, but reads off-scale. Author from catalog defaults/
   presets to avoid.
5. **Empty/degenerate room.** A plan whose room has < 3 verts or no symbols could load "empty".
   `validatePlan` accepts geometrically degenerate rooms, but the test "plan is non-empty after
   apply" guards against a blank load. Each plan must have a closed room + ≥1 symbol.
6. **`TEMPLATES.length` bound.** Existing test asserts 3–5 entries; adding 3 to the current 4
   makes **7**, which exceeds the ceiling. **This test must be updated** to allow 7 (see Test
   Requirements) — the only test-file change strictly required.
7. **Rug overlap.** `rug` is a `floorLayer` type (`z: 0.01`) and intentionally paints under
   furniture (LLD 107). Placing a sofa/desk on top of a rug is expected, not a bug.
8. **fitToContent framing.** Author rooms near the origin; the load path re-frames via
   `fitToContent`, so authored `view` is irrelevant on load (keep `{ zoom:1, panX:0, panY:0 }`).
9. **Round-trip stability.** Each plan must survive `serializePlan(validatePlan(plan))` →
   re-`validatePlan` and the compact/URL-hash codec unchanged — guaranteed by reusing the
   existing `plan.js` contract and covered by the existing round-trip test iterating `TEMPLATES`.

## Dependencies

All already on `main`; nothing new must be built first.
- `src/js/templates.js` — the `TEMPLATES` array (append target) and gallery controller
  (unchanged).
- `src/js/plan.js` — `validatePlan` (catalog/schema gate), `applyPlan`, `isEmptyPlan`,
  `serializePlan`, `PLAN_SCHEMA` (=1), `VALID_UNITS` (["ft","m"]). Unchanged.
- `src/js/symbols.js` — `CATALOG`; constrains the allowed symbol `type`s. Unchanged. Relevant
  available types: `gaming-chair`, `monitor`, `desk`, `rug`, `sofa`, `armchair`, `coffee-table`,
  `tv`, `fridge`, `stove`, `sink`, `table`, `dining-table-round`, `cabinet`, `door`, `window`.
- `test/tests.html` — LLD-43 template suite (~line 8857 onward) already iterates `TEMPLATES`;
  update the count-bound assertion and (optionally) add a per-plan catalog-membership assertion.
- Authoring tool: the live app itself (draw → export JSON) — the documented authoring path.

## Test Requirements

The existing LLD-43 suite iterates over `TEMPLATES`, so the three new plans are automatically
covered by: passes-`validatePlan`, applies-without-error, non-empty-after-apply, walls-reflect-
template, serialize→re-validate round-trip, and metadata integrity (unique ids, non-empty
name/description/thumb, valid unit). Required work:

**Unit (required, gating):**
- **Update the count bound.** The current test asserts `TEMPLATES.length` between 3 and 5; with
  4 existing + 3 new = 7, raise the ceiling (e.g. 3–8) so the suite stays green. This is the one
  mandatory test-file edit.
- **Every `TEMPLATES` entry validates** — already asserted; must remain green for all 7 (this is
  acceptance criterion 5's core guarantee).
- **Add/extend a catalog-membership assertion:** for every symbol in every template's plan,
  assert `sym.type in CATALOG` (imported from `symbols.js`) — makes acceptance criterion 3
  ("every symbol resolves to an existing CATALOG type, no unknown-type fallbacks") explicit and
  independent of `validatePlan`'s internal check.

**Round-trip (required, reuses existing):**
- The existing "serialize → re-validate" test iterating `TEMPLATES` covers export→import parity.
  Confirm it passes for the new plans. Acceptance criterion 4 (compact/URL-hash share round-trip)
  is covered by the reused `buildCompact`/`parseCompact` contract in `plan.js` (LLD 77 suite);
  no per-template addition required, but a spot-check that each new plan survives
  `parseCompact(buildCompact(validatePlan(plan)))` is recommended.

**Behavioural (already present, keep green):**
- `applyTemplate` unknown-id and confirm-gate tests are id-agnostic and unaffected.

**Manual / QA checklist (not automated):**
- Open the gallery: 7 cards render, including gaming room / kitchen / cozy living room with
  correct name, description, and thumbnail.
- Click each new card on a dirty canvas → confirm prompt → accept → plan loads and
  `fitToContent` frames it; every piece renders with its real symbol glyph (no unknown-type
  fallback box).
- Loaded plans show live area/perimeter; Share/PNG/SVG/JSON export all work.
- Existing 4 templates still load correctly (regression).
