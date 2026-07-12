# LLD 99: Hard-snap discrete furniture types to standard sizes (beds, appliances)

## Scope

Some furniture is genuinely discrete in the real world: beds come in 6 US mattress
sizes; ranges/fridges/washers come in fixed imperial cabinet widths. The catalog
(`src/js/symbols.js`) already encodes these as `presets`, but resize still
*free-scales* within the per-axis bounds (`clampDim`), so a bed can land at e.g.
1.20 m wide — between Full (1.37) and Twin (0.97), a size no mattress ships in.

This LLD adds a `discrete: true` flag to the genuinely-discrete catalog types and a
`snapToPreset(type, w, h)` helper, then applies that snap inside `resizeSymbol` after
the existing `clampDim` step. The snap picks the **nearest whole preset (w,h) pair**
(both dimensions move together), never a per-axis blend.

**In scope**
- `discrete: true` flag on: `bed`, `fridge`, `stove`, `washer`.
- `snapToPreset(type, w, h) -> {w, h}` pure helper in `symbols.js`.
- Snap applied inside `resizeSymbol` (covers the dim-entry chip commit **and** — via
  the `core.js` re-export — the MCP `resize_symbol` / `place_symbol` paths).

**Explicitly NOT in scope**
- Continuous-sizing types keep free-scaling within bounds: sofas, tables, desks,
  chairs, dressers, wardrobes, bookshelves, TVs, planters, patio pieces, etc. These
  are not flagged even where they carry `presets` (presets there are convenience
  starting points, not the only legal sizes).
- `sink` and `bathtub` are **deferred**: their presets are standard too, but the
  original per-axis-bounds PR scoped the discrete set to beds + ranges/fridges/washers.
  Kept out to stay surgical; noted as future candidates (Edge Case 7).
- `dining-table-round` (`circular: true`, has presets) stays continuous — a round
  table is legitimately any diameter.
- No new drag-to-resize UI, no live snapping affordance, no MCP catalog changes.

## Approach

**1. Flag the discrete types.** Add `discrete: true` to exactly `bed`, `fridge`,
`stove`, `washer` in `CATALOG`. Each already has `presets` and per-axis bounds; the
flag only changes resize behavior, not defaults or placement.

**2. Snap the whole pair, not each axis.** A bed's width and depth are not
independent — Twin is 0.97×1.91, Twin XL is 0.97×2.03. Snapping axes independently
could synthesize a (0.97, 1.97) that no product has. `snapToPreset` therefore chooses
the single preset pair minimizing **raw (un-normalized) squared distance in metres**:

```
d² = (w - p.w)² + (h - p.h)²
```

*Rationale — why raw, not span-normalized.* A resize edits exactly **one** axis at a
time (see step 3): the candidate pair is `(edited-axis value, current other-axis
value)`, so the other axis is *frozen* at whatever it already was. The choice of
metric decides how much that frozen axis influences the preset picked for the axis the
user actually typed:

- **Raw metric (chosen).** Because beds span a wide width range (0.97→1.93 m) but a
  narrow depth range (1.91→2.13 m), width differences naturally carry larger magnitude
  than depth differences. The edited-width term therefore dominates the pick, and the
  frozen depth acts as a gentle **tiebreaker** between presets that share a width
  (e.g. Twin 0.97×1.91 vs Twin XL 0.97×2.03). This is the intuitive behavior: typing a
  wider number yields a wider bed.
- **Span-normalized (rejected).** Dividing each term by its axis's bound span
  (spanW≈0.96, spanH≈0.22) *amplifies* depth differences ~4.4× relative to width. The
  frozen depth axis then swamps the width the user typed. Verified numerically on a
  default Queen (1.52×2.03), typing width **1.20 m**: normalized picks Twin XL
  (0.97×2.03, d²≈0.057) — a 0.97 m-wide bed — over Full (1.37×1.91, d²≈0.329), purely
  because Twin XL's depth matches the frozen 2.03. A user asking for a *wider* bed gets
  a much *narrower* one. Rejected.

Under the raw metric the same input (Queen, width 1.20 m → candidate (1.20, 2.03))
snaps to **Full 1.37×1.91** (d²=0.17²+0.12²=0.0433), beating Twin XL (d²=0.0529) and
Twin (d²=0.0673) — the intuitive result.

The chosen preset's exact `w`/`h` are returned, so results land on catalog numbers that
round-trip losslessly through plan JSON.

**3. Apply after clamp, take precedence over lockAspect.** Inside `resizeSymbol`,
after `clampDim`, if the type is `discrete`: form the candidate pair from the clamped
edited axis plus the current other axis, snap it, and set both dims. This branch
returns early — it takes precedence over the `lockAspect` scaling branch (a preset
pair already fixes the aspect). No discrete type is `circular`, so the two branches
never interact; the discrete branch is placed after the `circular` branch guard for
that reason (documented, not load-bearing today).

**4. MCP path inherits the snap logic; one small response field is added.**
`mcp/src/core.js` re-exports `resizeSymbol` (and `clampDim`) *directly* from
`../../src/js/symbols.js` — there is **no** duplicated catalog or resize implementation
in the `mcp/` package (verified). So `tool_resize_symbol` and `tool_place_symbol`
(which call `resizeSymbol`) inherit the snap **behavior** with no logic changes. This
corrects the issue note's assumption of a "mirror copy that must stay identical": the
MCP core mirrors by *re-export*, not by duplication, so there is nothing to keep in
sync. `snapToPreset` is pure and DOM-free, so the M4 import-boundary drift guard
(`mcp/test/import-boundary.test.js`) still passes.

The only MCP-side edit is additive reporting: both tools already track `clamped`
(`clampDim(...) !== metres`). Because snap can change `w`/`h` without clamping, each
tool also computes a `snapped:boolean` — true when, after `resizeSymbol`, `sym.w`/`sym.h`
differ from the clamped request — and includes it in the response for discrete types
(Edge Case 8). This is a pure comparison of already-available values; no new logic in
`symbols.js`.

## Interfaces / Types

New pure function in `src/js/symbols.js`:

```js
/**
 * Snap a (w,h) footprint to the nearest catalog preset PAIR for a discrete type.
 * Chooses the preset minimizing raw squared distance in metres —
 * (w-p.w)² + (h-p.h)² — so both axes move together to a real, buyable size and the
 * axis the user edits dominates the pick (see LLD Approach step 2). No-op (returns
 * {w,h} unchanged) if the type has no presets. Pure; does not mutate.
 * @param {SymbolType} type
 * @param {number} w  metres
 * @param {number} h  metres
 * @returns {{ w:number, h:number }}
 */
export function snapToPreset(type, w, h) { … }
```

Catalog flag (existing type widened):

```js
// Record<SymbolType, { …, discrete?:boolean, presets?:SymPreset[] }>
bed:    { …, discrete: true, presets: [ …6 mattress sizes… ] },
fridge: { …, discrete: true, presets: [ 24" / 30" / 33" / 36" ] },
stove:  { …, discrete: true, presets: [ 24" / 30" / 36" ] },
washer: { …, discrete: true, presets: [ 24" compact / 27" standard ] },
```

`resizeSymbol` signature is unchanged. New behavior inserted after `clampDim`:

```js
const cat = CATALOG[sym.type];
if (cat?.discrete && cat.presets) {
  const candW = dim === "w" ? clamped : sym.w;
  const candH = dim === "h" ? clamped : sym.h;
  const snapped = snapToPreset(sym.type, candW, candH);
  const changed = sym.w !== snapped.w || sym.h !== snapped.h;
  sym.w = snapped.w;
  sym.h = snapped.h;
  return changed;
}
```

`core.js` re-export list gains `snapToPreset` (optional; only needed if MCP tests want
to assert it directly — recommended for test symmetry, cheap, DOM-free).

## State Model

- No new persisted state. `discrete` is static catalog metadata, not serialized per
  symbol. A symbol still persists only `{ id, type, x, y, w, h, rot }`.
- Snapped `w`/`h` are exact preset numbers already present in the catalog, so they
  serialize and hydrate through plan JSON with no rounding drift.
- Snap is computed synchronously inside `resizeSymbol`; nothing is cached. In-memory
  model is the single source of truth, as today.

## Frontend Design

**Decision: Option A — snap on commit (no live-drag snapping).**

Resize in the editor happens *only* through the dimension-entry chip
(`symbolDimEntry.commit()` → `resizeSymbol`) — there is no drag-to-resize handle on
symbols. Because the sole resize entry point is a discrete commit of a typed value,
the snap is inherently "on commit": there is no mid-drag interaction to feel sticky.
Putting the snap inside `resizeSymbol` (rather than in a UI layer) means:

- The chip's typed value is clamped, then snapped, then the re-render reads the snapped
  `sym.w`/`sym.h` back into the chip — so the user immediately sees the real size
  (e.g. types `1.2 m` on a bed width, chip shows the snapped standard after commit).
- Dock drag-**placement** does not resize (it uses catalog defaults, which are already
  valid presets), so placement is unaffected.
- No new UI, no new guide, no new toast. The existing dimension chip is the feedback
  surface. (Showing the snapped preset *name* — "Full", "30\"" — in a toast is a
  possible future nicety; deferred to keep the diff minimal.)

This matches the guidance: prefer snap-on-commit; live discrete snapping is only
warranted when a drag is already in play, which resize here never is.

## Edge Cases

1. **Bed width toward a between-size value (1.20 m).** On a default Queen (1.52×2.03),
   typing width 1.20 m forms candidate (1.20, 2.03); under the raw metric it snaps to
   **Full 1.37×1.91** (d²=0.0433, vs Twin XL 0.0529, Twin 0.0673) — never 1.20. Both
   dims update. A test locks in this exact outcome (see Test Requirements).
2. **Editing width also moves depth.** Expected and correct — a mattress width implies
   its depth. Documented so it is not mistaken for a bug.
3. **Appliance to a between-rung width.** A fridge dragged toward ~0.70 m snaps to the
   nearest of 0.61/0.76/0.84/0.91 (24/30/33/36 in) with its paired depth.
4. **Non-discrete type with presets (sofa, dining table, dresser).** Not flagged →
   `discrete` branch skipped → free-scales within bounds exactly as today. Regression
   guard required in tests.
5. **`lockAspect` on a discrete type.** Discrete branch returns before the lockAspect
   branch, so lockAspect is ignored for discrete types (a preset pair already fixes the
   aspect). Documented.
6. **MCP `place_symbol` with both `w` and `h` on a discrete type.** `resizeSymbol` is
   called once per axis, so it snaps twice; the second call re-snaps using the already-
   snapped first axis. Final result is always a real preset pair (last axis wins on the
   pair choice, mirroring the existing `circular` "last axis wins" behavior). The
   returned `w`/`h` reflect the snapped pair.
7. **`sink` / `bathtub` still free-scale.** Deliberately not flagged (scope). Their
   presets remain convenience sizes; bounds keep them plausible. Future candidates.
8. **`clamped` flag semantics in MCP responses.** `tool_place_symbol` /
   `tool_resize_symbol` compute `clamped = clampDim(...) !== metres`; for a discrete
   type the returned `w`/`h` may now differ from the requested `metres` even when
   `clamped` is `false` (because snap, not clamp, changed it). To let MCP agents
   distinguish a snap from a clamp, add a `snapped:boolean` field to the discrete-type
   responses of both tools, set true when the discrete branch changed `w`/`h` from the
   clamped request. Low cost, DOM-free, improves agent-facing clarity. The returned
   `w`/`h` remain the source of truth; `snapped` is advisory. (This is the one small
   `mcp/src/tools.js` change in this LLD; the resize/catalog logic itself stays in
   `symbols.js` and is inherited by re-export — see Approach step 4.)
9. **Empty / single preset list.** `snapToPreset` returns the input unchanged when a
   type has no `presets`; with one preset it always returns that preset. (Guards a
   future discrete type added before its presets.)
10. **Ties in the distance metric.** If two presets are exactly equidistant under the
    raw metric, `snapToPreset` returns the first one encountered in `presets` order
    (stable, deterministic). Catalog preset order is fixed, so the result is
    reproducible. (The raw metric divides by nothing, so there is no zero-span /
    divide-by-zero concern that the earlier normalized metric would have needed.)

## Dependencies

- `src/js/symbols.js` — `CATALOG` (commit 60b2fc3 preset encoding), `clampDim`,
  `resizeSymbol`. Must exist before this LLD (they do).
- `src/js/symbolDimEntry.js` — the chip commit path that calls `resizeSymbol`;
  unchanged, inherits snap.
- `mcp/src/core.js` — re-exports `resizeSymbol`/`clampDim` from `src/js/symbols.js`;
  add `snapToPreset` to the re-export list (optional, for MCP test access).
- `mcp/src/tools.js` — `tool_resize_symbol` / `tool_place_symbol`; inherit the snap
  behavior via `resizeSymbol` (no logic change), plus a small additive `snapped:boolean`
  field on discrete-type responses (Edge Case 8). No catalog duplication exists here.
- No new external dependency, no build step (consistent with client-side-only v1).

## Test Requirements

**Unit (`test/tests.html`, `symbols.js` suite)**
- `snapToPreset` returns an exact preset pair for a between-size input (bed 1.20 m
  width → one of the mattress presets; both dims equal a catalog preset).
- `snapToPreset` is a no-op for a type with no presets, and returns the sole preset
  for a one-preset type; on an exact tie returns the first preset in catalog order.
- **Intuitive single-edit outcome (locks in the metric fix):** `resizeSymbol` on a
  default Queen bed (1.52×2.03) toward 1.20 m width snaps to **Full (1.37×1.91)** —
  exactly, `w===1.37 && h===1.91` — not to Twin XL/Twin. Asserts the raw metric so a
  future revert to span-normalization is caught. Result equals some `bed.presets[i]`.
- `resizeSymbol` on a discrete appliance (`fridge`/`stove`/`washer`) snaps width to a
  24/30/33/36-in rung with its paired depth.
- **Regression:** `resizeSymbol` on a non-discrete type (`sofa`, `table`, `desk`,
  `dining-table-round`) still free-scales within bounds — a between-preset value stays
  put (clamped only), proving discrete snap did not leak.
- `lockAspect: true` on a discrete type is ignored (result is still a preset pair).

**Integration — plan JSON round-trip (`test/tests.html` or MCP)**
- Place/resize a bed to a snapped size, `serializePlan` → hydrate → `w`/`h` unchanged
  (values are exact catalog numbers; lossless).

**MCP (`mcp/test/mutators.test.js`)**
- `tool_resize_symbol` on a bed with a between-size `metres` returns `w`/`h` equal to a
  mattress preset pair (agent-driven resize lands on a real size), and returns
  `snapped: true` with `clamped: false` when snap (not clamp) changed the size.
- `tool_place_symbol` for a discrete appliance with a between-rung `w` returns a
  snapped standard width.
- `tool_resize_symbol` on a non-discrete type (`sofa`) still returns the clamped, un-
  snapped value (mirrors the frontend regression guard).
- Existing `import-boundary.test.js` (M4 drift guard) continues to pass — asserts
  `core.js` loads clean under Node with the new pure helper.
