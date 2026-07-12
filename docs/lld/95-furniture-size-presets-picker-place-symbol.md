# LLD 95: Furniture size presets — picker UI + place_symbol preset param

## Scope

The catalog carries named, real-product `presets` on `CATALOG[type]` in
`src/js/symbols.js` (mattress sizes, appliance widths, door/window leaves,
round-table seat counts). Today nothing consumes them except the
`floorplan://catalog` MCP resource. This LLD adds the ergonomic layer that lets
users and agents pick a real size by name.

**In scope — two bounded, additive pieces:**

1. **Frontend picker.** A quick-pick chip row rendered in the floating symbol
   inspector (`#symbol-inspector`), one chip per entry in
   `CATALOG[type].presets`. Tapping a chip sets the selected symbol's `w`/`h` to
   the preset's exact `{w,h}`. A synthetic **"Custom"** chip shows as active when
   the current `w`/`h` diverge from every preset.
2. **MCP `preset` arg.** An optional `preset:"<name>"` string arg on
   `place_symbol` that resolves via `CATALOG[type].presets` (by name) to the
   exact `{w,h}` before placement.

**Explicitly NOT in scope:**

- Redefining or duplicating preset data — presets already live in `symbols.js`;
  both consumers read them from there.
- Any change to the free-drag resize path, the inline dim-entry path
  (`symbolDimEntry.js`), or `resizeSymbol` semantics. Free-drag resize continues
  to work unchanged.
- Any change to the share-link / URL-hash codec (LLD 77) or the persisted plan
  shape. A preset only sets `w`/`h`; **no new persisted field** is introduced.
- Snap-on-resize behaviour — that is #96's scope.
- A `set_preset` MCP tool. The description floated `and/or a set_preset tool`; we
  choose the single `preset` arg on `place_symbol` as the minimal surface (see
  Approach). Applying a preset to an already-placed symbol via MCP is achievable
  with the existing `resize_symbol` tool, so a new tool is not warranted.
- Types with no `presets` (e.g. `chair`, `desk`, `nightstand`): they render no
  chip row and are unaffected on both surfaces.

## Approach

**Single source of truth.** Both consumers read `CATALOG[type].presets` from
`symbols.js`. No preset arrays are copied into `symbolTool.js`, HTML, or the MCP
layer. The MCP already imports `CATALOG` from `./core.js` (which re-exports the
same `symbols.js` catalog).

**Preset match is defined by exact `{w,h}` equality.** A symbol "is" preset P
iff `sym.w === P.w && sym.h === P.h`. Preset values are authored at 2-decimal
metre precision and `resizeSymbol` stores them verbatim (no rounding), so strict
`===` is safe — no epsilon needed. This keeps the "Custom" determination trivial
and deterministic, and means a free-drag resize that happens to land exactly on a
preset footprint correctly highlights that preset's chip (acceptable, expected).

**Applying a preset = two clamped `resizeSymbol` calls.** Tapping a chip calls
the existing `resizeSymbol(sym, "w", P.w)` then `resizeSymbol(sym, "h", P.h)`
with `lockAspect=false`. Because every preset lies within the type's per-axis
bounds (guaranteed by the catalog author), the clamp is a no-op and the exact
values land. Openings ignore the `"h"` call (their `min_h===max_h`), which is
correct — their presets only vary width. Circular types mirror w→h on the first
call, so the second call is redundant but harmless. Reusing `resizeSymbol` means
we inherit all existing openings/circular/clamp semantics for free.

**MCP: resolve `preset` → `{w,h}`, then reuse the existing clamp path.** In
`tool_place_symbol`, if `preset` is supplied, look it up in
`CATALOG[type].presets` by exact name. On miss, return
`{ok:false, reason:…}` listing the valid names (fail fast — an agent typo should
not silently place a default-sized symbol). On hit, inject the preset's `w`/`h`
into the same code path the explicit `w`/`h` args use. **Precedence:** explicit
`w`/`h` args override the preset per-axis (a caller who passes both
`preset:"Queen"` and `w:1.6` clearly wants the override); document this. The
resolved dims still flow through `clampDim`/`resizeSymbol` exactly as today.

**No new persisted field.** The preset name is never stored on the `Sym`. It is
a transient input that resolves to `w`/`h`. Plan serialization, the URL-hash
codec, and hydrate are untouched. Re-opening a plan re-derives chip active-state
from `w`/`h` alone.

## Frontend Design

**Approved direction: Option A — a quick-pick chip row inside the existing
floating inspector**, placed directly under the current icon toolbar row.

### Layout

The `#symbol-inspector` (`src/index.html` ~line 2204) is today a single
horizontal `role="toolbar"` flex row of `.insp-btn` icons. To host a second row,
wrap the existing icon buttons in an `.insp-row` div and append a second
`.insp-presets` row below it. The inspector's own `display:flex` becomes
`flex-direction: column` with the two rows stacked; each row keeps its own
horizontal flex.

```
┌─────────────────────────────────────┐
│  ⟳   ⧉   🗑   |   🔒                  │  ← existing icon toolbar (.insp-row)
│  [Twin][Full][Queen●][King][Custom]  │  ← preset chips (.insp-presets)
└─────────────────────────────────────┘
```

- The chip row is present only when `CATALOG[type].presets` exists and is
  non-empty; otherwise the row is left empty / hidden (`display:none`) so
  preset-less types keep the compact single-row inspector.
- Chips overflow-scroll horizontally (`overflow-x:auto`, `flex-wrap:nowrap`) so
  long lists (window has 7 presets) stay on one row without widening the
  inspector past the viewport clamp already enforced by `_positionInspector`.
  Because adding a row makes the inspector taller, `_positionInspector` already
  reads `_inspector.offsetHeight` each frame, so vertical placement/clamping
  auto-adjusts — no positioning code change needed beyond it recomputing height.

### Chip element

Each chip is a `<button class="insp-chip" data-preset-name="<name>">` with the
preset name as its text label. One synthetic trailing chip
`<button class="insp-chip" data-preset-name="__custom__">Custom</button>` is
always rendered when a preset row exists.

Active state: `aria-pressed="true"` + an `.insp-chip--active` visual (reuse the
gold-fill treatment already defined for `.insp-btn[aria-pressed="true"]`). At
most one chip is active at a time:

- If `sym.w/sym.h` exactly match some preset → that preset's chip is active.
- Otherwise → the **Custom** chip is active.

The Custom chip is a passive indicator, not an action: tapping it is a no-op
(it has nothing to resize to). It exists purely to show "your current size is
off-catalog." (Alternative considered: hide Custom and show no active chip when
off-catalog. Rejected — an explicit Custom affordance reads more clearly and
matches the issue's "'Custom' active-state chip" wording.)

### Rendering & wiring (`symbolTool.js`)

- `_showInspector(sym)` gains a call to a new `_renderPresetChips(sym)` that
  (re)builds the `.insp-presets` row for `sym.type`. It clears the row, and for
  each `CATALOG[sym.type].presets` entry appends a chip; then appends the Custom
  chip. It sets the active chip via the exact-match rule above.
- A single delegated `click` listener on the `.insp-presets` container (wired
  once in `init`, mirroring the existing `_inspector.querySelector` button
  wiring) reads `data-preset-name`; ignores `__custom__`; else looks up the
  preset in `CATALOG[sym.type].presets`, applies it via the two `resizeSymbol`
  calls, then `flushNudge()` → `_historyCommit()` → `_renderPresetChips(sym)`
  (to move the active state) → `repositionInspector()` (height may change) →
  `scheduleRender()`.
- Applying a preset must also cancel any open inline dim edit
  (`cancelDimEdit()` if `isDimEditing()`), consistent with other committing
  gestures, so a stale input doesn't overwrite the new size on blur.
- Because chip clicks live inside the inspector (a `position:fixed` DOM element,
  not the SVG stage), they do not enter the stage pointer pipeline — no pointer
  isolation like `symbolDimEntry` needs is required.

### CSS (`src/index.html`)

Add `.insp-presets` (horizontal scroll row, small top margin + hairline top
border to separate from the icon row) and `.insp-chip` (compact pill: mono
font, `~0.65rem`, `padding: 0.15rem 0.4rem`, `border-radius: 5px`,
`border: 1px solid transparent`, `white-space:nowrap`, `flex-shrink:0`). Reuse
the existing gold hover/active tokens (`--gold`, `--gold-soft`) used by
`.insp-btn`. Provide a coarse-pointer min height (~1.9rem) matching the existing
touch treatment. Respect the existing reduced-motion block (no new animation).

### Accessibility

- Chip row is a `role="group"` with `aria-label="Size presets"` nested inside
  the existing toolbar, or the chips can remain plain buttons within the
  toolbar; keep each chip a real `<button>` with a discernible text label (the
  preset name) so screen readers announce it. `aria-pressed` conveys the active
  size.

## Interfaces / Types

### Existing (consumed, unchanged)

```js
// symbols.js
/** @typedef {{ name:string, w:number, h:number }} SymPreset */
CATALOG[type].presets?: SymPreset[]
resizeSymbol(sym, dim /* "w"|"h" */, metres, lockAspect=false): boolean
```

### New — frontend (`symbolTool.js`, module-private)

```js
/**
 * Find the preset whose {w,h} exactly matches the symbol, or null.
 * @param {Sym} sym
 * @returns {import("./symbols.js").SymPreset|null}
 */
function _matchingPreset(sym)   // returns presets.find(p => p.w===sym.w && p.h===sym.h) ?? null

/**
 * (Re)build the .insp-presets row for the given symbol's type and set the
 * active chip (matched preset, else Custom). No-op / hidden row when the type
 * has no presets.
 * @param {Sym} sym
 */
function _renderPresetChips(sym)

/**
 * Apply a preset by name to the selected symbol: two clamped resizeSymbol calls,
 * commit, re-render chips + inspector. No-op if name is "__custom__" or unknown.
 * @param {string} presetName
 */
function _applyPreset(presetName)
```

No changes to `symbolTool.js`'s exported API.

### New — MCP (`mcp/src/tools.js` + `mcp/src/server.js`)

```js
// place_symbol arg surface (server.js inputSchema) gains:
preset: z.string().optional()

// tool_place_symbol({ type, x, y, w?, h?, rot?, preset? })
// New result field on success when a preset was requested & resolved:
//   presetApplied: "<name>"   (omitted/undefined when no preset arg)
// New failure:
//   { ok:false, reason:"unknown preset '<name>' for <type>; valid: <names…>" }
```

Resolution helper (module-private in `tools.js`):

```js
/** Exact-name lookup in CATALOG[type].presets; null if type has none or no match. */
function _findPreset(type, name)  // CATALOG[type].presets?.find(p => p.name === name) ?? null
```

## State Model

- **Nothing new is persisted.** The `Sym` shape (`{id,type,x,y,w,h,rot}`) is
  unchanged. A preset resolves to `w`/`h`; the name is discarded after
  resolution.
- **Active-chip state is derived, not stored.** Computed on demand from the
  live `sym.w/sym.h` vs `CATALOG[type].presets` each time
  `_renderPresetChips` runs (on select, and after any preset apply). It is not
  cached, so free-drag/inline-resize/undo/redo/hydrate all reflect correctly the
  next time the inspector renders for that symbol.
- **The inspector already re-renders on selection** (`_showInspector` via
  `selectSymbol`/`onSelectDown`). `_renderPresetChips` piggybacks on that; no new
  render-scheduling machinery.
- **History:** a preset apply is a single committed step (via the existing
  injected `_historyCommit`), identical to how the inline dim-entry commit works
  — so one Undo reverts a chip tap.
- **MCP:** preset resolution happens entirely within the synchronous
  `tool_place_symbol` before `addSymbol`; the concurrency contract (mutators are
  sync, no await) is preserved.

## Edge Cases

### Frontend

1. **Type has no `presets`** (chair, desk, nightstand, cabinet, patio-chair):
   render no chip row (hidden). Inspector stays single-row/compact.
2. **Current size matches no preset** → Custom chip active; all named chips
   inactive.
3. **Current size matches a preset exactly after free-drag or inline resize** →
   that preset's chip becomes active on next inspector render. Expected, not a
   bug.
4. **Openings** (door/window): presets vary only `w`; the `resizeSymbol(sym,"h",…)`
   call is ignored (min_h===max_h). Chip matching still works because `sym.h`
   equals every preset's `h` (the fixed marker depth), so only `w` distinguishes.
5. **Circular type** (round dining table): first `resizeSymbol("w",…)` mirrors to
   `h`; second `"h"` call is redundant. Presets are authored with `w===h` so the
   match rule holds.
6. **Tapping the already-active named chip** → resolves to the same `{w,h}`;
   `resizeSymbol` reports no change and `_historyCommit`'s dirty-check makes it a
   no-op (no spurious undo step). Acceptable.
7. **Tapping the Custom chip** → no-op (it carries `__custom__`; no lookup).
8. **Preset applied while an inline dim-edit input is open** → cancel the dim
   edit first, then apply, so a blur-commit can't clobber the preset size.
9. **Symbol deleted / deselected between render and click** → the delegated
   handler re-reads `_selectedId`/`getSymbol`; if null, no-op.
10. **Inspector taller with two rows near viewport top edge** → existing
    `_positionInspector` clamps `iy` to `[8, vh-ih-8]` using live `offsetHeight`;
    it flips/clamps automatically.

### MCP

11. **`preset` names an unknown/typo preset** → `{ok:false, reason:"unknown
    preset '<name>' for <type>; valid: <comma-list>"}`; nothing is placed.
12. **`preset` on a type with no `presets`** → same unknown-preset failure
    (valid list is empty → reason notes the type has no presets). Nothing placed.
13. **`preset` + explicit `w`/`h`** → explicit dim wins per-axis (documented in
    the tool description); the preset supplies only the axes not explicitly given.
14. **`preset` + `rot`** → rot applies normally; preset only touches `w`/`h`.
15. **`preset` is not a string** (e.g. number) → `{ok:false, reason:"preset must
    be a string"}` (or rely on zod `z.string().optional()` rejection at the
    schema boundary; validate in-handler too for the direct-call test path).
16. **`preset` on an opening whose resolved footprint isn't on a wall** →
    existing opening-on-wall guard (Gap B) still fires after dims are set;
    unchanged behaviour.

## Dependencies

All already exist; nothing new must be built first.

- `CATALOG[type].presets` in `src/js/symbols.js` (commit 60b2fc3) — the data.
- `resizeSymbol` / `clampDim` in `symbols.js` — the apply mechanism.
- Existing floating inspector `#symbol-inspector` and its wiring in
  `symbolTool.js` (`init`, `_showInspector`, `_positionInspector`,
  `repositionInspector`) — the host UI.
- Injected `_historyCommit`, `flushNudge`, `cancelDimEdit`/`isDimEditing` —
  commit + edit-state hygiene.
- MCP: `CATALOG` already imported into `tools.js` from `./core.js`; zod schema in
  `server.js`.

No interaction with the URL-hash codec (LLD 77), plan persistence (LLD 81), or
snap-on-resize (#96).

## Test Requirements

### Unit — frontend (`_matchingPreset` and helpers; add to symbol tool tests)

- `_matchingPreset` returns the correct preset when `w/h` match exactly (bed
  Queen → 1.52×2.03).
- Returns `null` when `w/h` diverge from every preset (→ Custom active).
- For an opening, matches on `w` with the fixed marker `h` (door Standard 32").
- For a circular type, matches when `w===h` equals a preset (round table Seats 4).
- Applying a preset sets `sym.w/sym.h` to the exact preset values (within-bounds
  presets are not clamped).

### Unit — MCP (`mcp`, `node --test`)

- `tool_place_symbol({type:"bed", x,y, preset:"Queen"})` → placed symbol has
  `w===1.52, h===2.03`, result `presetApplied:"Queen"`.
- Unknown preset name → `{ok:false}` with a reason listing valid names; no
  symbol added (assert `symbolsModel.symbols.length` unchanged).
- Preset on a type with no presets → `{ok:false}`; nothing placed.
- Explicit `w`/`h` override the preset per-axis (`preset:"Queen", w:1.6` →
  `w===1.6, h===2.03`).
- `preset` on an opening resolves width, then still enforces the on-wall guard.
- Existing `place_symbol` calls without `preset` behave exactly as before
  (regression guard).

### Integration / DOM (frontend, Playwright)

- Selecting a symbol with presets shows the chip row; the chip matching its
  current size is `aria-pressed="true"`.
- Tapping a different chip resizes the symbol and moves the active state to the
  tapped chip; one Undo reverts it.
- Free-drag or inline-resize to an off-catalog size makes **Custom** active on
  reselect.
- Selecting a preset-less type shows no chip row (inspector stays one row).
- Chip row scrolls horizontally for many-preset types (window) without
  overflowing the viewport; inspector stays clamped on-screen.

### Regression

- Share-link / URL-hash round-trip is byte-identical before/after this change
  for a plan (no new persisted field).
- Plan JSON serialization shape unchanged.
