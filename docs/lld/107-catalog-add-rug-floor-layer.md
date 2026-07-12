# LLD 107: Catalog — add `rug` type (floor layer)

> Follow-up from **LLD 72a** ("Catalog gaps" #6) and **LLD 72** rule E1 (deferred). A rug is
> unusual: it is a **floor layer where overlap with furniture is DESIRED**, so it cannot be a
> normal clearance subject like every other type. This LLD adds a first-class `rug` catalog
> type plus the render layering and clearance carve-out that make "furniture sits on top of
> the rug" the intended reading, not an error. Frontend direction is **decided** ("proceed
> with recommendations" — see Frontend Design); this LLD implements that direction exactly.

## Scope

**Covers:**
- A new `rug` entry in `CATALOG` (`src/js/symbols.js`) flagged `floorLayer:true`, with
  standard-size presets (5×8, 8×10, 9×12 ft + a runner) and per-axis bounds.
- A render carve-out: rugs paint into a **new `#rugs` SVG group drawn BEFORE `#symbols`**, so
  furniture always draws on top. Rug body = dashed-edge full-footprint fill + subtle woven
  hatch, **no type glyph**.
- A clearance carve-out in `computeClearances()` (`src/js/clearance.js`): rugs are skipped in
  **both** subject and neighbour roles, mirroring the existing `CATALOG[type].openings` guard.
- A `pickSymbol` tweak-priority tweak so a rug never steals selection from furniture stacked
  on top of it.
- Dock entry (Living tab, badged `new`), export (SVG/PNG) parity, and MCP parity. The MCP
  re-exports the same `CATALOG` and shared `clearance.js`, so it inherits the type and the
  `computeClearances` carve-out for free — **but** the MCP's own report builder
  (`buildClearanceReport` in `mcp/src/feedback.js`) builds its **own** subject list and
  excludes only openings, so it needs a **one-line** `floorLayer` subject-exclusion added
  (mirroring its existing openings exclusion). This is the only MCP-side code change.
- Rug stays a **first-class symbol otherwise**: selectable, movable, rotatable, resizable,
  gold selection box, rotate handle, W×H chips, presets, color swatches.

**Does NOT cover:**
- Rug-sizing *guidance rules* (LLD 72 rule E1: front-legs-on-rug, dining ≥24 in past table,
  bedroom 18–24 in past bed). This LLD makes those rules *expressible* by adding the type; the
  skill prose that states them is a **separate follow-up** (interior-design skill, LLD 72a).
- Any change to the clearance *algorithm* beyond the skip guard, any new "rug covers N% of
  floor" metric, pile-height/z-axis, or layered/overlapping-rug semantics.
- Circular/round rugs (the catalog `circular` flag is not applied here; rectangular only in v1).

## Approach

**1. `floorLayer:true` is the single load-bearing flag.** One boolean on the catalog entry
(name chosen over `overlapOk`/`noClearance`) drives every carve-out: clearance skip, render
group routing, and pick de-prioritisation. Every other code path treats a rug like any
furniture symbol, so the change stays surgical and rides existing machinery (CRUD, resize,
rotate, presets, color, history, hydrate, share, export).

**2. Render layering, not per-symbol z-fighting.** Rather than sort within one group, rugs get
their own `#rugs` group positioned in the SVG *before* `#symbols`. SVG paints in document
order, so anything in `#rugs` is always beneath anything in `#symbols`. This guarantees
"furniture on top of rug" structurally, independent of `model.symbols` array order or the
order the user drops pieces.

**3. Clearance skip mirrors openings exactly.** `computeClearances()` already returns `[]`
when the *subject* is an opening and `continue`s past openings as *neighbours*. We add the
identical guard for `floorLayer`. A rug is therefore never measured (its edges are not a
"does it fit?" subject) and is never an obstacle (furniture measuring its own clearances
ignores the rug entirely). Rug edges CAN still be reasoned about by the skill via `get_plan`
AABBs — the carve-out only removes the rug from the automated gap engine.

**4. Pick de-prioritisation.** `pickSymbol` currently returns the topmost by array order. A rug
added *after* the furniture on it would otherwise be picked first even though it renders below.
Fix: within `pickSymbol`, prefer a non-`floorLayer` hit over a `floorLayer` hit; only fall back
to the rug when nothing else is under the cursor. This keeps selection intuitive (click the
sofa → get the sofa; click the exposed rug border → get the rug).

**5. One-line MCP subject exclusion (the MCP is NOT edit-free).** `mcp/src/core.js` re-exports
the shared `CATALOG` and imports the shared `clearance.js`, so adding the type to `symbols.js`
makes `floorplan://catalog` list the rug, and the `computeClearances` guards make the core
gap engine skip it — those inherit for free. **However**, the `check_clearance` tool does
**not** iterate `computeClearances()` over all symbols; it calls `buildClearanceReport()`
(`mcp/src/feedback.js`), which builds its **own** subject list (`world.symbols.filter(...)`,
feedback.js ~line 362) and excludes **only** openings
(`if (CATALOG[s.type]?.openings) return false;`). Without a matching `floorLayer` exclusion, a
full report enumerates the rug as a subject labelled "Rug", and — worse — the containment rule
(feedback.js ~line 402) flags **any** subject whose centre is not inside a closed room as
`worstStatus:"bad"` with an "outside room" move. A runner against a wall, or a rug in an
L-shaped room whose centroid falls outside the polygon, would get a spurious BAD flag — exactly
the failure this type exists to prevent. **Fix:** add one guard beside the openings one in
`buildClearanceReport`'s subject filter:
`if (CATALOG[s.type]?.floorLayer) return false;`. This is the single MCP-side change; verify it
by test.

## Interfaces / Types

**`src/js/symbols.js` — type + catalog.**

Extend the `SymbolType` typedef union with `"rug"`. Extend the catalog entry typedef (symbols.js
lines 58–61) to allow an optional `floorLayer?:boolean` flag. Note: that typedef currently lists
only `openings?` and `circular?` — the already-used `discrete` flag is also absent. If the
implementer wants the typedef authoritative, add `discrete?:boolean` alongside `floorLayer?`;
otherwise adding just `floorLayer?` is consistent with the existing loose practice.

Add the catalog entry (metres; ft presets converted at 2-decimal precision, matching the
existing convention). Category `living` (dock home per Frontend Design). Rectangular,
freely resizable within bounds; presets are soft choices (chips), **not** a `discrete` hard
snap:

```js
rug: {
  label: "Rug", category: "living", floorLayer: true,
  w: 2.44, h: 3.05,                       // 8×10 ft default
  min_w: 0.61, max_w: 3.66, min_h: 0.91, max_h: 3.66,
  presets: [
    { name: "Runner 2.5×8", w: 0.76, h: 2.44 },
    { name: "5×8",          w: 1.52, h: 2.44 },
    { name: "8×10",         w: 2.44, h: 3.05 },
    { name: "9×12",         w: 2.74, h: 3.66 },
  ],
},
```

`createSymbol`, `resizeSymbol` (non-discrete/non-circular branch), `clampDim`, `snapToPreset`,
`moveSymbol`, `rotateSymbol`, `duplicateSymbol`, `setSymbolColor`, `hydrate` all work
unchanged for the rug — no new code, only the data entry.

**`pickSymbol(wx, wy, tolWorld)` — de-prioritise floor layers.** Change the single reverse
scan into a two-tier pick: return the topmost **non-floorLayer** hit if any; otherwise the
topmost floorLayer hit; otherwise null. Signature unchanged.

**`src/js/clearance.js` — `computeClearances(sym, world)`.** Two additions, mirroring the
`openings` guards already present:
- Subject guard (with the existing opening guard): `if (CATALOG[sym.type]?.floorLayer) return [];`
- Neighbour guard (inside the `for (const other …)` loop, beside the opening `continue`):
  `if (CATALOG[other.type]?.floorLayer) continue;`

**`mcp/src/feedback.js` — `buildClearanceReport(...)` subject filter (the one MCP code change).**
Add a `floorLayer` exclusion beside the existing openings exclusion (~line 363) so the rug is
never a report subject:
```js
const subjects = world.symbols.filter((s) => {
  if (CATALOG[s.type]?.openings) return false;   // openings are not subjects
  if (CATALOG[s.type]?.floorLayer) return false; // floor layers are not subjects (NEW)
  if (onlyId !== undefined) return s.id === onlyId;
  return true;
});
```
This is necessary because `buildClearanceReport` builds its own subject list rather than
iterating `computeClearances()`, so the core carve-out does not cover it (see Approach step 5).

**`src/js/symbolRender.js` — new group ref + rug body renderer.**
- `init(...)` gains a `gRugs` parameter (a `<g id="rugs">` element); store as `_gRugs`.
- `render()` clears `_gRugs` alongside `_gSymbols`/`_gOverlay`, then in the body loop routes
  each symbol: `floorLayer` → `_renderRug(_gRugs, sym, …)`; else → `_renderSymbolBody(_gSymbols,…)`.
- `_renderInterior` grows **no** rug branch (rugs have no glyph); the rug renderer is separate.
- Selection box, rotate handle, and dim chips are emitted for a selected rug exactly as for
  any symbol (they live in `#symbol-overlay`, which is topmost, so a selected rug's gold box
  and handle sit above the furniture on it).

**`src/js/main.js`** — `const gRugs = document.getElementById("rugs");` and pass it into
`initSymbolRender(...)` as the new first render group.

**`src/index.html`** — add `<g id="rugs"></g>` immediately **before** `<g id="symbols">`. The
current group order is `symbols`, `clearance`, `measure`, `symbol-overlay` (lines ~2114–2120),
so inserting `#rugs` first places rugs beneath the clearance and measure overlays as well as
beneath furniture. That is **intended**: a rug is a floor surface and should sit under
everything except walls/grid, so clearance ticks and measurement annotations reading over a rug
is the desired layering. Add the Living-tab dock item (see Frontend Design); optionally add one
`<pattern>` in `<defs>` for the woven hatch (or draw the hatch procedurally in JS —
implementer's choice, see Frontend).

**`src/js/exportImg.js`** — in `buildExportSvg`, paint rug symbols (dashed edge + hatch, no
label) in a first pass **before** the furniture pass so export matches on-screen layering.

## State Model

- **A rug is an ordinary `Sym`** in `model.symbols`: `{ id, type:"rug", x, y, w, h, rot, color? }`.
  It persists to plan JSON, `localStorage`, and the URL-hash share exactly like any symbol —
  **no schema change**, no new field. `floorLayer` lives only in the static `CATALOG` constant,
  never in serialized state.
- **Render grouping is a pure function of `type`**, computed each frame from `CATALOG`; nothing
  about the layer is stored on the symbol or persisted.
- **Clearance state is unaffected** — the rug simply never appears in a `Clearance[]` result
  (neither as subject nor neighbour). No persisted clearance data exists to migrate.
- **Selection** stores only the rug's `id` in the existing `_selectedId`; no rug-specific
  selection state.
- **Backward/forward compatibility:** older plans have no rugs, so nothing to migrate. A plan
  containing a rug loaded by an older build would surface an unknown type — acceptable, this is
  additive and the share format already tolerates forward types by the existing validation path
  (implementer confirms `validatePlan` treats an unknown type as it does any other; no special
  handling added here).

## Edge Cases

1. **Furniture dropped on a rug** — intended, not a violation. Furniture renders in `#symbols`
   above `#rugs`; `computeClearances` for the furniture ignores the rug (neighbour guard), so no
   spurious "bad"/overlap flag. This is the whole reason the type exists.
2. **Rug selected while furniture sits on it** — `pickSymbol` returns the furniture when the
   cursor is over both; the rug is selected only where its border is exposed. A user who wants
   the covered rug can move the furniture, or the rug is still reachable at any exposed edge.
3. **Rug is the clearance *subject*** — `computeClearances` returns `[]`; the inspector/clearance
   overlay shows nothing for a selected rug. Consistent with how openings behave.
4. **Two overlapping rugs** — neither is an obstacle to the other (both `floorLayer`), so no
   flag; they simply stack in `#rugs` by array order. Acceptable; layered-rug semantics are out
   of scope.
5. **Rotated rug** — `corners()` handles rotation; the dashed border and hatch follow the rotated
   polygon. AABB-based reasoning (skill) stays conservative as for any rotated symbol.
6. **Rug resized to a preset** — the preset chips (Runner/5×8/8×10/9×12) apply via the standard
   `resizeSymbol` path (two clamped calls); no discrete hard-snap (a rug is not a `discrete` type).
7. **Export (SVG/PNG)** — rug paints under furniture with no type label; a viewer sees the woven
   fill beneath the furniture, matching the editor.
8. **MCP `place_symbol {type:"rug"}`** — works via the shared catalog. `check_clearance` targeting
   the rug (`onlyId=rug`) returns **no items** and a full `check_clearance` never lists the rug as
   a subject — **but only after** the `floorLayer` subject-exclusion is added to
   `buildClearanceReport` (feedback.js). Without that guard the report would enumerate the rug as
   a "Rug" subject and could spuriously flag it BAD via the containment rule (e.g. a runner whose
   centroid falls outside the room). Clearance for other pieces ignores the rug via the shared
   `computeClearances` neighbour guard. Covered by test.
9. **Color swatch for a rug** — the rug is colorable; it uses the existing LLD 97 **floor**
   swatch group (semantically correct for a floor covering) rather than the living
   wood/upholstery set — see Frontend Design for the one-line mapping.

## Dependencies

All present in this branch; nothing blocks implementation.

- **`src/js/symbols.js`** — `CATALOG`, `SymbolType`, CRUD, `pickSymbol`, `resizeSymbol`,
  `snapToPreset`, `corners`. (present)
- **`src/js/clearance.js`** — `computeClearances` with the existing `openings` subject/neighbour
  guards to mirror. (present)
- **`src/js/symbolRender.js`** + **`src/index.html`** SVG group ordering (`#symbols` before
  `#clearance`/`#symbol-overlay`); **`src/js/main.js`** group wiring. (present)
- **`src/js/palette.js`** — the existing **`floor`** swatch group (LLD 97), reused for rug color.
  (present)
- **`src/js/exportImg.js`** — export SVG builder to keep layering parity. (present)
- **MCP** (`mcp/src/core.js`) — re-exports shared `CATALOG` and imports shared `clearance.js`;
  inherits type + `computeClearances` carve-out for free. (present)
- **MCP** (`mcp/src/feedback.js`) — `buildClearanceReport` subject filter (~line 362) needs the
  one-line `floorLayer` exclusion added beside its openings exclusion; otherwise it lists the rug
  as a subject and can false-flag it BAD via containment. This is the only MCP code edit. (present)
- **LLD 72a** — the interior-design skill that will *consume* the type to express rule E1 rug
  sizing. This LLD unblocks it; the skill prose is a separate follow-up.

## Frontend Design

Frontend decision: **proceed with recommendations** — implement the mockup direction exactly;
the design questions are closed. Concretely:

1. **Catalog entry** as specified in Interfaces: `floorLayer:true` (approved flag name), presets
   5×8, 8×10, 9×12 ft + a runner, category `living`.
2. **Render treatment — soft floor layer.** Full-footprint fill of the (possibly rotated) rug
   polygon with a **dashed edge** (reuse the `5 3` dash rhythm used elsewhere) and a **subtle
   woven hatch** (thin cross-hatch or diagonal lines at low opacity, e.g. `symInkRgb` at ~0.10,
   or a wider spacing than furniture ink). **No type glyph** and **no center label** — the rug
   must read as a soft surface, not a boxed object. Fill uses `sym.color` when set (mapped to the
   **floor** swatch group), else a low-alpha theme neutral.
3. **Layer order.** Paint rugs into a **new `#rugs` SVG group placed BEFORE `#symbols`** in
   `index.html`, so furniture always draws on top. Overlap of furniture on the rug is INTENDED,
   never an error.
4. **Clearance carve-out.** Skip `floorLayer` in **both** subject and neighbour roles in
   `computeClearances()`, mirroring the `CATALOG[type].openings` guard. Rug edges may measure to
   walls/furniture via the skill's own reasoning, but the rug is **never** an automated obstacle.
   *Pitfall (do NOT regress):* a rug must not be a normal clearance subject — that is the entire
   reason it needs its own type.
5. **First-class symbol otherwise:** selectable, movable, rotatable, resizable, gold selection
   box, rotate handle, W×H chips, size presets, color swatches — all via existing machinery.
   `pickSymbol` de-prioritises the rug so furniture on top selects first (Edge Case 2).
6. **Dock home — Living tab, badged `new`.** Add the `data-type="rug"` dock item to the Living
   `#row-living` panel with a simple rug icon (a rounded rect with a couple of hatch lines and a
   fringe tick, in the 18×18 `viewBox` house style) and a small `new` badge. If the repo has no
   existing badge pattern, add a minimal `.dock-item__badge` (absolutely-positioned pill reading
   "new") scoped to this item; keep it CSS-only and remove-on-first-use is out of scope (static
   badge is fine for v1).

**Swatch mapping note (Edge Case 9):** the dock/category is `living` for tab placement, but a rug
is a floor covering — map its color picker to the existing **`floor`** swatch group. Smallest
surgical hook: in `symbolTool._populateSwatchStrip`, treat `type==="rug"` as category `"floor"`
when computing swatch groups (`swatchGroupsForCategory("floor")` already returns `["floor"]`).
This reuses LLD 97 infrastructure with a one-line special-case and no palette.js change.

## Test Requirements

**Unit (`src/js/symbols.js`, `clearance.js`, `pickSymbol`):**
- `CATALOG.rug` exists, `floorLayer===true`, category `living`, and every preset lies within its
  per-axis bounds (extend the existing catalog-invariant test that checks all types).
- `createSymbol("rug", …)` returns a valid `Sym` with catalog default w/h; `resizeSymbol` clamps
  to rug bounds; preset application produces exact preset w/h.
- `computeClearances(rug, world)` returns `[]` (subject guard).
- `computeClearances(sofa, world)` with a rug in `world.symbols` returns the SAME result as with
  the rug absent — i.e. the rug is never a neighbour/obstacle (add a case where a rug overlaps the
  sofa and assert no rug-derived `Clearance` and no `bad` from the rug).
- `pickSymbol` returns the furniture, not the rug, when both are hit at a point; returns the rug
  when only the rug is hit.
- `hydrate` round-trips a plan containing a rug (id counter advances, rug preserved).

**Integration / render (`symbolRender.js`, `exportImg.js`):**
- Render routes a rug into `#rugs` and furniture into `#symbols`; `#rugs` precedes `#symbols` in
  the DOM (layer order assertion).
- A rendered rug has a dashed-edge polygon + hatch and **no** center type label / glyph.
- Export SVG contains the rug polygon painted before the furniture polygons and with no rug type
  label.
- Selecting a rug renders the gold selection box + rotate handle + W×H chips (first-class parity).

**MCP parity (`mcp` — `cd mcp && node --test`):**
- `floorplan://catalog` includes `rug` with `floorLayer:true`.
- `buildClearanceReport` excludes the rug from its subject list: `place_symbol {type:"rug"}`
  succeeds; `check_clearance` targeting the rug (`onlyId`) returns **no items**; a full
  `check_clearance` report does **not** list the rug as a subject even when the rug's centroid
  lies outside the room (guards against the containment-rule false BAD). This test fails against
  the current `buildClearanceReport` and passes only after the `floorLayer` subject-exclusion is
  added — confirming that one-line MCP change is required.
- A furniture piece's `check_clearance` is unaffected by a rug overlapping it (shared neighbour
  guard).

**Regression:**
- Existing symbol/clearance/pick tests stay green (the two guards must not alter non-rug paths).
</content>
</invoke>
