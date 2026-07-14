# LLD 137: Show live-computed floor area on each template card instead of hard-coded text

## Scope

**In scope**
- Compute each template card's floor area from its own `plan` room polygons using `polygonArea` (the same geometry the HUD uses), and render it as a small badge on the card in `src/js/templates.js`.
- Format the badge for the current display unit (metric `m²` / imperial `ft²`) via the existing `fmtArea` / `areaUnitLabel` helpers.
- Re-render the badges when the display unit toggles, since `_renderCards` otherwise runs only once at init.
- Remove the hard-coded `~N m²` figure from each template `description` literal (the drift source).
- Badge styling in the template-card CSS block (in `src/index.html`).

**Explicitly NOT in scope**
- How templates load into the editor (`applyTemplate`, `_apply`, `validatePlan`) — unchanged.
- The HUD / `measure.js` readout logic — unchanged; this LLD reuses its helpers only.
- Persisting the unit preference (units.js already resets to `ft` on reload).
- Thumbnails, template plan data (coordinates), or adding/removing templates.

## Approach

**Option A (selected): additive display change in `_renderCards`.** For each template, compute area at render time from the plan's actual room polygons rather than from any stored string, then inject a `.template-card-area` badge span into the card. This makes the card and HUD share one source of truth (`polygonArea`), fixing the confirmed drift (the 1-bedroom card literal says `~55 m²` but its rooms compute to ~52.5 m²).

Key decisions:
- **Area = sum of `polygonArea(room.verts)` over closed rooms only**, mirroring `measure.js` which sums `roomMetrics(room).area` (area is `0` for non-closed rooms). Using `polygonArea` directly (not `roomMetrics`) is sufficient here since we gate on `room.closed` ourselves and only need area, not perimeter.
- **Unit reactivity:** `_renderCards` runs once at `init`. Subscribe to `units.onChange` inside `init()` so the cards re-render (or their badges update) when the user toggles m²/ft². This keeps the displayed value and `areaUnitLabel()` consistent with the HUD after a toggle. Re-running `_renderCards` is simplest and matches the existing pattern (main.js wires `onUnitChange(scheduleRender)`); the card list is tiny (4 entries) so a full re-render is cheap and avoids caching per-card badge nodes.
- **Descriptions become unit-neutral:** strip the `~N m²` phrase so the literal no longer carries a figure that can drift. The area now lives only in the badge.
- **No new module or dependency** — imports come from existing `walls.js` and `units.js`.

## Interfaces / Types

New imports at the top of `src/js/templates.js`:

```js
import { polygonArea } from "./walls.js";
import { fmtArea, areaUnitLabel, onChange as onUnitChange } from "./units.js";
```

New private helper:

```js
/**
 * Total floor area (m²) of a template's plan: sum of polygonArea over
 * closed rooms. Mirrors measure.js's HUD total (non-closed rooms contribute 0).
 * @param {import("./plan.js").Plan} plan
 * @returns {number} area in m²
 */
function _templateAreaM2(plan) { ... }
```

`init(refs)` signature is unchanged. Inside `init`, after the initial `_renderCards()`, register:

```js
onUnitChange(_renderCards);
```

`_renderCards` gains a badge span (see State Model). `Template.description` literals lose their `~N m²` prefix; the JSDoc `@property description` comment stays accurate (still a one-line blurb).

## State Model

- **No new persisted or module-level state.** Area is derived on every render from `TEMPLATES[i].plan`, which is already `Object.freeze`d and immutable.
- Display unit is read transitively through `fmtArea` / `areaUnitLabel`, which reference `units.unit` (module-level, not persisted — resets to `ft` on reload).
- **Render flow:** `init()` → `_renderCards()` (initial) and `onUnitChange` registration. On unit toggle, `units.setUnit` fires listeners → `_renderCards()` clears `_gridEl.innerHTML` and rebuilds all cards, each recomputing `_templateAreaM2` and re-formatting with the current unit.
- Badge DOM: a `<span class="template-card-area">` appended to each `.template-card`, adjacent to `.template-card-name` / `.template-card-desc`. Text = `fmtArea(area) + " " + areaUnitLabel()`.

## Frontend Design

**Selected: Option A** — badge rendered in the existing card builder, no new module.

- **Placement & markup:** add the area badge as a distinct span in the card (near the name), e.g. `<span class="template-card-area">27.00 m²</span>`. Keep the existing `.template-thumb`, `.template-card-name`, `.template-card-desc` order; append the badge so it reads as a small numeric chip. It must be visually secondary to the name but more prominent than the description (it is the differentiating "live area" value).
- **Styling (in the template-card CSS block in `src/index.html`, ~line 2053):** small monospace chip consistent with the blueprint/graph-paper aesthetic — reuse the gold accent tokens already used by cards (`var(--gold-soft)`, `rgba(201,168,76,…)`). Suggested: inline-block, `font-size: ~0.6rem`, gold text, subtle gold-tint background, small radius and horizontal padding, `align-self: flex-start` so it hugs its content within the column flex layout. Add a mobile size step in the existing `@media (max-width: 480px)` block alongside the name/desc rules.
- **Accessibility:** the card's `aria-label` currently concatenates `name + " — " + description`. Since the area moves out of the description, append the area to the `aria-label` (e.g. `name + " — " + description + " — " + areaText`) so screen-reader users still hear the area. The badge span itself needs no separate ARIA (it is inside the labelled button).
- **No motion/animation** beyond the card's existing hover transition; respect the existing `prefers-reduced-motion` rule.

## Edge Cases

1. **Non-closed rooms** — contribute 0 area (gate on `room.closed`), matching `measure.js`. All current templates use closed rooms.
2. **Multi-room templates** (e.g. `one-bedroom` has 3 rooms) — sum across all closed rooms; badge shows the combined total, exactly what the HUD shows after load.
3. **Rooms with < 3 verts** — `polygonArea` already returns 0 for `n < 3`; no special handling needed.
4. **Imperial default** — on first load `unit === "ft"`, so the badge shows `ft²` immediately; no metric leakage even though plan data is stored in metres.
5. **Rounding parity** — badge uses the same `fmtArea` rounding as the HUD, so acceptance criterion 2 ("equals the HUD readout within display rounding") holds by construction. Do not round before summing; sum in m² then format once.
6. **Unit toggle while gallery open** — `onUnitChange` re-renders cards live; open/close state (`_open`) and the overlay visibility class are untouched by `_renderCards` (it only rewrites `_gridEl`), so an open gallery updates in place.
7. **Empty/zero-area plan** — would render `0.00 m²`; acceptable and truthful. No current template hits this.

## Dependencies

- `polygonArea` exported from `src/js/walls.js` (exists, line 238).
- `fmtArea`, `areaUnitLabel`, `onChange` exported from `src/js/units.js` (exist).
- No changes required in `main.js` — `templates.js` self-registers its `onUnitChange` listener in `init()`. (Note: `main.js` also wires `onUnitChange(scheduleRender)`; a second independent listener for the cards is fine — `units.onChange` supports multiple callbacks.)
- CSS token variables (`--gold-soft`, `--muted`, `--font-mono`) already defined and used by the template-card block in `src/index.html`.
- No other LLDs block this.

## Test Requirements

**Unit (required by acceptance criterion 5)**
- For a known template (e.g. `studio`: single 5.5 × 4.9 room → 26.95 m²), assert `_templateAreaM2(plan)` equals `polygonArea` summed over the plan's closed rooms. Since `_templateAreaM2` is private, either export it for test or assert via the public path; recommend exporting it (small, pure) or testing the sum expression directly against `TEMPLATES` + `polygonArea`.
- Assert the multi-room case (`one-bedroom`) sums all three rooms (~52.5 m², proving the badge no longer matches the old `~55` literal — the drift fix).
- Assert non-closed rooms contribute 0 (construct a plan with `closed: false`).

**Integration / DOM**
- After `init` + `_renderCards`, each `.template-card` contains a `.template-card-area` span whose text matches `fmtArea(area) + " " + areaUnitLabel()` for the current unit.
- Toggling the unit via `setUnit("m")` / `setUnit("ft")` updates every badge's text (verifies the `onUnitChange` subscription).
- Assert no template `description` string contains `m²` / `~` area figures (guards criterion 4 against regression).

**Not needed:** security tests (no input, no network, static frozen data).
