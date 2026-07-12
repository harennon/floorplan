# LLD 97: Realistic color options for furniture & floors

## Scope

**Covers.** One coherent increment giving each furniture symbol and each closed
room an optional, user-chosen realistic color:

1. An **optional** `color` field on `Sym` (`symbols.js`) and on `Room`
   (`walls.js`). Absent ⇒ current theme fill. Additive and backward-compatible:
   existing localStorage autosaves, JSON files, and old URL-hash share links
   decode **unchanged**, with **no `schema` bump**.
2. A **curated swatch set** (`palette.js` new module) — wood tones, neutral
   upholstery colors, white/black appliances, floor tones — literal hex, not a
   raw hex wheel.
3. A **swatch picker** in the symbol inspector, plus a small **room/floor color
   equivalent** reached from the selected room.
4. Round-tripping the new field through **every** serialization surface:
   `buildPlan`/`validatePlan`, the compact codec (`buildCompact`/`parseCompact`),
   `serializePlan`, localStorage autosave, and PNG/SVG export.

**Does NOT cover (v1, explicit non-goals).**
- Textures / patterns / image fills — flat color only.
- Wall colors / wallpaper (walls stay theme-driven; only the room **floor fill**
  is colorable).
- Gradients or per-face / per-glyph coloring (one fill per object; interior
  glyphs keep using the theme stroke/ink).
- Auto category-aware default seeding at creation time (see Approach — deferred;
  the fallback path already makes zero-pick plans look exactly as today).

## Approach

**One LLD, furniture + floor together.** Per the selection guidance the shared
schema/persistence plumbing (the field, validation, all codecs, export) is done
once for both object kinds in this increment; the *only* thing that could split
to a fast-follow is the room/floor picker UI. We keep it in-scope because the
plumbing is identical and splitting would double schema churn. If implementation
runs long, the safe cut line is "ship symbol picker + full plumbing (incl. room
`color` round-trip); land room picker UI second" — the room field still
round-trips from day one.

**Optional field, theme fallback (no schema bump).** Renderers already read
`p.symFill` / `p.roomFill` from the cached palette. We change exactly one line
each: `fill = sym.color || p.symFill` and `fill = room.color || p.roomFill`. A
missing/empty `color` reproduces today's output byte-for-byte, so old plans are
visually identical and `PLAN_SCHEMA` stays `1`.

**Curated literal colors, not theme-derived.** Chosen colors are stored as
literal hex strings and rendered identically in light and dark. This is
deliberate: a navy sofa must look navy in both themes. The swatch set is tuned
(see Frontend Design) for legibility on both the dark (`#14140f`) and light
editor backgrounds, and every swatch keeps enough contrast against the gold
selection stroke (`p.gold`) and grid that selection/added glyphs stay readable.

**Validation is lenient + defensive.** `color`, when present, must be a string
matching a strict `#rgb`/`#rrggbb` hex pattern; anything else (wrong type,
non-hex, `rgba()`, arbitrary CSS) is **dropped to `undefined`** rather than
rejecting the whole plan — an untrusted share link cannot inject arbitrary
strings into an SVG `fill=` attribute, and a malformed field degrades to the
theme fallback instead of failing the decode. We do **not** constrain the value
to the curated set on decode (a plan authored in a newer catalog still opens).

**Compact codec: omit when absent.** `buildCompact` adds `color` to a symbol's
compact object only when set; `parseCompact` passes it through only when present.
No wasted bytes for the common (uncolored) case, preserving LLD 77's lean links.

**Category-aware default seeding: deferred.** Tempting but adds product risk
(every fresh plan suddenly changes appearance) and interacts with template plans
(LLD 43). v1 keeps `createSymbol`/`closeRoom` emitting no `color`, so the
zero-pick experience is exactly today's. A future LLD can seed defaults behind
the same field with no schema change.

## Frontend Design

**Decision: Option A** — a compact inline swatch row appended to the existing
floating inspectors, not a separate popover/modal. Rationale: the symbol
inspector is already a floating toolbar that tracks the selection; adding one
more row of round swatches keeps chrome minimal, needs no new focus-management
layer, and works on touch (swatches are ≥28px hit targets).

**Symbol inspector.** Append a `data-action`-free swatch strip below the
existing button toolbar inside `#symbol-inspector`:
- A horizontal row of ~5–7 round swatch buttons (`.swatch`) + one "default"
  chip (theme fill) shown first, marked selected when `sym.color` is unset.
- The swatch set shown is **filtered by the symbol's category** (from
  `CATALOG[type].category`): seating shows upholstery neutrals, tables/wood
  pieces show wood tones, appliances show white/black/steel, etc. A shared
  "neutrals" group is always appended so any piece can go grey/white/black.
- Clicking a swatch sets `sym.color` (or clears it for the default chip),
  pushes one history entry, and re-renders. The active swatch shows a gold ring
  (reuse `p.gold`).

**Room/floor picker.** When a room is selected (`roomTool.getSelectedRoomId()`),
show the same swatch strip in a small floating `#room-inspector` positioned near
the room centroid (mirrors how the symbol inspector is positioned). Its swatch
group is the **floor tones** set (light oak → walnut → grey → tile-neutral) plus
the default chip. Sets `room.color`.

**Swatch markup / CSS.** New `.swatch` class: a 28px circle, `background` = the
literal hex, 1px `var(--muted)` border for light-swatch-on-light-bg legibility,
`aria-pressed` for the active one, `aria-label` = the human name (e.g. "Walnut").
Keyboard: arrow keys move between swatches within the strip (roving tabindex),
Enter/Space applies. The strip lives in `index.html` markup so no runtime DOM
construction is needed for the symbol one; the room inspector is a sibling block.

**Legibility contract.** Every curated hex is chosen with:
- fill-vs-dark-bg and fill-vs-light-bg luminance separation so the body reads as
  a filled shape in both themes;
- interior glyphs continue to use `p.symStroke`/`p.symInkRgb` (theme ink), which
  keeps glyph contrast because glyphs are drawn *over* the fill — verify the
  darkest swatch (near-black appliance) still shows the lighter theme-ink glyphs,
  and the lightest (white) still shows the dark-theme ink. If a swatch would hide
  glyphs, the fill uses a slight alpha or the glyph stroke stays theme-driven
  (it already is), so no per-swatch glyph recoloring is needed in v1.

## Interfaces / Types

### Model (JSDoc updates)

```js
// symbols.js
/** @typedef {{ id:string, type:SymbolType, x:number, y:number,
 *   w:number, h:number, rot:number, color?:string }} Sym */

// walls.js
/** @typedef {{ id:string, closed:boolean, verts:Vertex[], color?:string }} Room */
```

`color` is an optional literal hex string (`#rgb` or `#rrggbb`). Absent ⇒ theme
fill. `createSymbol`, `duplicateSymbol`, and `closeRoom` do NOT set it by default
(duplicate DOES copy an existing `color` — it clones the source's appearance).

### New module: `palette.js` (curated swatch data — pure, DOM-free)

```js
/** @typedef {{ hex:string, name:string }} Swatch */
/** @typedef {"wood"|"upholstery"|"appliance"|"neutral"|"floor"} SwatchGroup */

/** Ordered swatch groups. Each entry is a curated, real-material color. */
export const SWATCHES = {
  wood:       [ /* light oak, oak, teak, walnut, espresso … */ ],
  upholstery: [ /* linen beige, slate grey, navy, forest, rust … */ ],
  appliance:  [ /* white, stainless/steel grey, matte black … */ ],
  neutral:    [ /* white, light grey, mid grey, charcoal, black … */ ],
  floor:      [ /* light oak, honey, walnut, cool grey, tile … */ ],
};

/** Groups shown for a symbol category (openings → []); always append neutral. */
export function swatchGroupsForCategory(category) { /* → SwatchGroup[] */ }

/** Strict hex validator shared by validatePlan/parseCompact boundary. */
export function isValidHexColor(v) {
  return typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/** Coerce an untrusted value → valid hex or undefined. */
export function coerceColor(v) { return isValidHexColor(v) ? v : undefined; }
```

### Symbol / Room CRUD

- `setSymbolColor(sym, hexOrNull)` — mutates `sym.color`; `null`/`undefined`
  **deletes** the key (serializes clean, falls back to theme). Returns changed bool.
- `duplicateSymbol` — copies `sym.color` onto the clone when set.
- `setRoomColor(room, hexOrNull)` — same semantics for rooms.
- `roomTool` gains a public method to apply a color to the selected room and push
  one history entry (mirrors the symbol path).

### Serialization touch-points

- **`buildPlan`** — no code change: it deep-clones models via
  `JSON.parse(JSON.stringify)`, so `color` is carried once present, and JSON
  drops `undefined` so uncolored objects stay byte-identical. Confirm with a test.
- **`validatePlan`** — in the symbol loop and room loop: if `color !== undefined`
  and not a string → the field is dropped (not the plan). In the normalised
  output copy, run each `color` through `coerceColor` so non-hex strings degrade
  to `undefined`. A bad color NEVER fails a decode.
- **`buildCompact`** — per symbol: `if (sym.color) compact.k = sym.color;`
  (key `k` = "kolor"; `c` is already the room-closed flag). Per room: add
  `k: room.color` when set. Omit entirely when unset (keeps LLD 77 links lean).
- **`parseCompact`** — copy the color key back onto the expanded symbol/room when
  present (pass raw through; downstream `validatePlan` coerces).
- **`serializePlan`** — no code change; add a round-trip test.
- **`exportImg.buildExportSvg`** — symbols: `fill="${sym.color || p.symFill}"`;
  rooms: `fill="${room.color || p.roomFill}"`. Values are hex-validated at the
  decode boundary and contain no XML-special chars, so interpolation is safe.

### Render touch-points

- **`symbolRender._renderSymbolBody`** —
  `fill = selected ? (sym.color || p.symSelFill) : (sym.color || p.symFill)`.
  The gold dashed selection box (drawn separately) is unchanged, so a colored,
  selected symbol still reads as selected.
- **`wallRender._renderRoom`** —
  `fillColor = highlighted ? p.roomFillHi : (room.color || p.roomFill)`.
  The LLD 63 selected/hover treatments still layer on top unchanged.

## State Model

- **In-memory:** `color` lives on the same model objects as geometry
  (`symbols.model.symbols[i].color`, `walls.model.rooms[i].color`). No new store.
- **Session:** current selection (`_selectedId`, `_selectedRoomId`) already
  exists; the picker reads/writes the selected object's `color`.
- **Persisted (autosave localStorage, JSON export, share hash):** `color` flows
  through the single Plan snapshot (`buildPlan`) → all codecs. It is the only new
  persisted field. No `schema` bump.
- **Not persisted:** the swatch catalog (`palette.js` is static code), the
  filtered group shown in the picker, and picker open state.
- **Undo/redo:** a color change is a normal model mutation pushed as one history
  entry, identical to move/resize; the existing dirty-check autosave picks it up.
- **Ephemeral degradation:** a `color` that fails validation on load is silently
  normalised to `undefined` (theme fallback) — the object still loads.

## Edge Cases

1. **Legacy plan / old share link (no `color` anywhere).** Decodes unchanged;
   every object renders with the theme fill exactly as before. (Core backward-compat.)
2. **`color` present but not a string** (e.g. number, object). `validatePlan`
   drops the field to `undefined`; plan still valid. Does NOT reject the plan.
3. **`color` is a string but not valid hex** (`"red"`, `"rgba(…)"`,
   `"#12"`, injection attempt like `"#fff\" onload=…"`). `coerceColor` → `undefined`;
   theme fallback. Prevents arbitrary strings reaching an SVG `fill=` attribute.
4. **Openings (door/window).** Not colorable — `swatchGroupsForCategory("openings")`
   returns `[]`, so the picker strip is hidden for those types. Their body is a
   thin wall marker; coloring adds no value and risks legibility.
5. **Duplicate a colored symbol.** Clone inherits the source `color`.
6. **Colored symbol selected.** Fill stays the chosen color; gold dashed
   selection box still drawn on top so selection is unambiguous.
7. **Very light swatch (white) in dark theme / very dark swatch (black) in light
   theme.** The 1px `var(--muted)` swatch-button border and the shape's own
   stroke (`p.symStroke`) keep the body distinguishable from the canvas; verify
   both extremes in both themes.
8. **Interior glyph legibility over an extreme fill.** Glyphs use theme
   ink/stroke; verify the darkest appliance and lightest white keep visible
   glyphs. No per-swatch recolor in v1.
9. **Theme toggle after coloring.** Chosen colors are literal and do NOT change
   with theme (intended); only the *fallback* (uncolored) objects re-theme.
10. **Export fidelity.** PNG/SVG must show the identical chosen hex as on-canvas.
    Covered by comparing `buildExportSvg` output `fill` to `sym.color`.
11. **Compact link size.** Uncolored objects add zero bytes; colored objects add
    a short `k` key only. No blow-up of existing lean links.
12. **Newer/unknown swatch value from a future catalog.** Any valid hex is
    accepted on decode even if not in the current curated set — forward-compatible.
13. **Empty string `color: ""`.** Fails hex regex → coerced to `undefined` →
    theme fallback (and `|| p.symFill` also handles it defensively at render).

## Dependencies

- **Existing (build on):** `symbols.js` (`Sym`, CRUD, `CATALOG.category`),
  `walls.js` (`Room`), `symbolRender.js`, `wallRender.js`, `theme.js`
  (`p.symFill`/`p.symSelFill`/`p.roomFill`), `plan.js` (LLD 16 persistence +
  LLD 81 optional-additive `measurements` pattern to mirror), the LLD 77 compact
  codec (`buildCompact`/`parseCompact`), `exportImg.js`, `symbolTool.js`
  inspector, `roomTool.js` (`getSelectedRoomId`), and `index.html` inspector markup.
- **New:** `palette.js` (curated swatch data + hex validation/coercion) and the
  swatch-strip markup/CSS in `index.html`; a `#room-inspector` sibling block.
- **No new runtime/build dependency** (static, no build step — honors project
  principles). No backend.
- **Ordering:** the optional-additive `measurements` handling in `validatePlan`
  (LLD 81) is the template to copy for lenient, non-rejecting additive fields.

## Test Requirements

**Unit (pure, no DOM) — `plan.js` / `palette.js`:**
- `isValidHexColor` / `coerceColor`: accepts `#fff`, `#ffffff`; rejects `red`,
  `rgba(…)`, `#12`, `#gggggg`, numbers, objects, `""` → `undefined`.
- `validatePlan`: (a) plan with valid symbol/room `color` round-trips it;
  (b) plan with non-string `color` drops the field but stays valid;
  (c) plan with non-hex string `color` normalises to `undefined`;
  (d) legacy plan with no `color` validates unchanged.
- `buildCompact`/`parseCompact`: colored symbol and colored room survive the
  compact round-trip; uncolored objects emit no color key (assert absence).
- `serializePlan`: colored plan serializes and re-`validatePlan`s equal.
- **Full round-trip persistence tests** (the required ones): model → `buildPlan`
  → `serializePlan` → parse → `validatePlan` → `applyPlan` preserves every
  `color`; and model → `buildCompact` → `parseCompact` → `validatePlan` likewise.
- `duplicateSymbol` copies `color`.

**Integration / backward-compat:**
- A pre-LLD-97 share hash (fixture 'c' and 'u' payloads with no color) decodes
  to a valid plan and renders (guards "old links still open").
- `swatchGroupsForCategory` returns `[]` for `openings`, non-empty (incl. neutral)
  for furniture, floor group for rooms.

**Render / export (structural SVG, per LLD 61 style):**
- `symbolRender` emits `fill="<hex>"` when `sym.color` set, `fill="<p.symFill>"`
  when unset.
- `wallRender` emits room fill = `room.color` when set, else `p.roomFill`.
- `exportImg.buildExportSvg`: symbol and room `fill` equal the chosen hex →
  proves export fidelity matches canvas (not just on-canvas).

**Manual / QA (documented, not automated):**
- Legibility sweep: each curated swatch on both light and dark backgrounds;
  white swatch in dark theme and black swatch in light theme stay distinguishable;
  interior glyphs remain visible over the darkest and lightest fills; gold
  selection box stays visible on every swatch.
