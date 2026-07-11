# LLD 88: Enforce circularity on round dining table (lock w == h)

## Scope

A `dining-table-round` is modeled as a w×h box (diameter = w = h), rendered as an
inscribed circle (`symbolRender.js` uses `Math.min(sw, sh)`) and hit-tested as the box
(`hitTest`). Its per-axis bounds are equal (`[0.60, 1.83]` on both) and every preset has
`w === h`, but width and depth can still be resized independently — through the inline
dim chips (`symbolDimEntry.commit → resizeSymbol`) or the MCP `resize_symbol` mutator
(`tool_resize_symbol → resizeSymbol`) — yielding a non-circular "round" table.

**This covers:** treating a round table's w and h as one diameter so a resize on either
axis sets both, via a general catalog flag honored in the single `resizeSymbol` choke
point.

**This does NOT cover:**
- A dedicated single "diameter" resize handle / chip UI. Both existing chips remain and
  stay in sync (see Frontend Design). Collapsing to one chip is deferred.
- Changing render or hit-test geometry (already circle-correct; enforcing `w === h` only
  removes the degenerate ellipse case).
- Applying the flag to other types (`parasol`, `patio-table` intentionally keep an
  editable oval footprint per their current bounds — they are NOT flagged here).
- The session-wide `lockAspect` inspector toggle (a separate, orthogonal feature).

## Approach

**Option A (selected):** add a general catalog flag and honor it in `resizeSymbol`.

1. **Catalog flag.** Add `circular: true` to the `dining-table-round` entry in
   `CATALOG` (`src/js/symbols.js`). Prefer a general flag over a `sym.type ===`
   special-case so future round objects reuse it by opting in.

2. **Single choke point.** Both edit paths (inline dim entry and MCP) already funnel
   through `resizeSymbol(sym, dim, metres, lockAspect)`. Add one branch there: when the
   symbol's catalog entry is `circular`, clamp the requested value and assign it to
   **both** `w` and `h`. This makes mirroring automatic everywhere without touching the
   callers.

3. **Minimal.** No refactor of the broader resize/lockAspect logic. The circular branch
   is checked first and short-circuits (a circular type ignores `lockAspect`, since a
   1:1 mirror already preserves the only valid aspect).

Rationale: equal per-axis bounds mean clamping either axis is identical, so a single
clamped diameter is unambiguous. Placing the rule in `resizeSymbol` (not the two UI/MCP
callers) is the smallest change that fixes every entry point at once.

## Interfaces / Types

`src/js/symbols.js` — catalog entry gains an optional flag:

```js
/** @type {Record<SymbolType, {label, category, openings?, circular?, w, h,
 *   min_w, max_w, min_h, max_h, presets?}>} */
"dining-table-round": {
  label: "Round Dining Table", category: "living", circular: true,
  w: 1.20, h: 1.20, min_w: 0.60, max_w: 1.83, min_h: 0.60, max_h: 1.83,
  presets: [ /* unchanged; all w === h */ ],
},
```

`resizeSymbol` — new branch, existing signature unchanged:

```js
export function resizeSymbol(sym, dim, metres, lockAspect = false) {
  if (CATALOG[sym.type]?.openings && dim === "h") return false;

  const clamped = clampDim(sym.type, dim, metres);

  // Circular: one diameter — a resize on either axis mirrors to both.
  // Takes precedence over lockAspect (a 1:1 mirror is the only valid aspect).
  if (CATALOG[sym.type]?.circular) {
    const changed = sym.w !== clamped || sym.h !== clamped;
    sym.w = clamped;
    sym.h = clamped;
    return changed;
  }

  // ...existing lockAspect + per-axis branches unchanged...
}
```

No signature changes to `tool_resize_symbol`, `symbolDimEntry.commit`, or
`clampDim`. `clampDim(type, "w"|"h", m)` returns the same value for a circular type
(equal bounds), so callers that compute `clamped` for reporting stay correct.

## State Model

- **In-memory:** `Sym.w` and `Sym.h` remain independent fields; the invariant
  `w === h` for circular types is enforced only through `resizeSymbol`. No new fields.
- **Persisted (localStorage / URL-hash / export JSON):** unchanged shape. Legacy plans
  may contain a round table with `w !== h`; these are NOT auto-migrated on load (render
  already tolerates it via `Math.min`). The next resize on either axis re-establishes
  `w === h`. `createSymbol` and all presets already produce `w === h`, so newly created
  tables are circular from birth.
- **Catalog:** `circular` is static config data, not persisted per-symbol.

## Edge Cases

1. **Inline dim chip edit of either axis** → `resizeSymbol` sets both; the other chip's
   label updates on the next `scheduleRender`. Confirm both chips reflect the new value.
2. **MCP `resize_symbol` with `dim:"h"`** → mirrors to `w`; response `w`/`h` both equal
   the clamped diameter; `changed` true iff either differed.
3. **Out-of-range value** → clamped to `[min, max]` (equal on both axes) before
   mirroring; MCP `clamped` flag still computed via `clampDim` and stays accurate.
4. **`lockAspect` true on a circular type** → circular branch wins (1:1 mirror);
   identical result, no double-scaling. Documented precedence.
5. **`tool_place_symbol` with differing `w` and `h`** (e.g. `w:1.0, h:1.5`) → it calls
   `resizeSymbol("w")` then `resizeSymbol("h")`; each mirrors, so the **last-specified
   axis (h) wins** and the table is circular. Acceptable; note in the tool's behavior.
6. **Legacy non-circular round table loaded from an old plan** → renders as the inscribed
   min-dimension circle (unchanged); first resize snaps `w === h`. No migration.
7. **Preset applied** (if/when presets are wired) → all round-table presets already have
   `w === h`; no special handling needed.
8. **Zero/degenerate value** → `clampDim` lifts to `min_w` (0.60); mirrored to both.
   `resizeSymbol`'s circular branch does not divide, so no divide-by-zero risk.

## Dependencies

- `src/js/symbols.js` — `CATALOG` entry + `resizeSymbol` (both here; no ordering
  dependency). This is the only functional change.
- `mcp/src/core.js` / `mcp/src/tools.js` — re-export the shared `symbols.js` model; no
  code change needed, inherits the new behavior automatically. Confirm the MCP bundle
  resolves the same `symbols.js`.
- No dependency on other LLDs. Descends from the per-axis-bounds change (commit
  `60b2fc3`), which is already merged.

## Frontend Design

**Decision: Option A — enforce in the model layer, keep the existing two-chip UI.**

- The round table keeps both the width and depth dim chips (`symbolRender._renderDimChips`
  is unchanged). Because both edits route through `resizeSymbol`, editing either chip
  mirrors to the other and both chip labels re-render in sync on the next frame — the user
  perceives a single diameter even with two controls.
- No new "diameter" handle, no chip hiding, no relabeling in this change (keeps the diff
  surgical; avoids touching render/hit-test which already treat the table as `w === h`).
  A future polish could collapse to one "⌀" chip labeled "diameter" gated on the same
  `circular` flag — explicitly deferred.
- Render/hit-test are visually verified unchanged: the body is still the inscribed circle
  (`Math.min(sw, sh)`), now guaranteed a true circle since `w === h` is enforced.

## Test Requirements

**Unit (`src/js` geometry — add to the existing symbols resize test suite):**
- `resizeSymbol` on a `circular` type with `dim:"w"` sets both `w` and `h`.
- `resizeSymbol` on a `circular` type with `dim:"h"` sets both `w` and `h`.
- Out-of-range value on a circular type clamps both axes to the same bound.
- `lockAspect` true on a circular type yields the same mirrored result (no double-scale).
- A non-circular type (e.g. `sofa`) still resizes one axis independently (regression:
  ensure the new branch does not leak).

**Integration (MCP — `mcp/test/mutators.test.js`):**
- `tool_resize_symbol` on a placed `dining-table-round` with `dim:"h"` returns `w === h`
  in the response and `changed:true`.
- `tool_place_symbol` for `dining-table-round` with differing `w`/`h` ends with
  `w === h` (last axis wins) — pins Edge Case 5.

**No security tests** (pure client-side geometry; no new input surface — values already
pass through `clampDim`/`isFiniteNum`).
