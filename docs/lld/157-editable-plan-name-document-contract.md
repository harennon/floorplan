# LLD 157: Add an editable plan name to the document contract (localStorage + JSON + share round-trip)

Part of #3 (Phase 2: polish & delight). Order 1 of 3 in the plan-name arc (#157 → #154 → #155).

## Scope

### In scope
- Add an optional `name` (string) to the plan document contract in `src/js/plan.js`: produced by `buildPlan`, normalised/capped by `validatePlan`, consumed by `applyPlan`, and included in `serializePlan`.
- Round-trip `name` through all three persistence paths that share the contract:
  - localStorage autosave (`store.js`),
  - JSON export/import (`exportJson.js`),
  - URL-hash share encoding (compact codec `buildCompact`/`parseCompact` in `plan.js`, used by `share.js`).
- A new tiny live-state module `src/js/planName.js` holding the current plan name (mirrors `units.js`).
- Surface the name as an inline, borderless, editable title in the header brand slot (Variant A — see **Frontend Design**), defaulting to a `"Untitled plan"` placeholder.
- Scoped to the **single current plan** only.

### Explicitly NOT in scope
- No multi-plan library / switcher / rename-list UI.
- Do **NOT** touch the export caption literal ("Floor plan", LLD 153) — that is #154.
- Do **NOT** touch the browser tab `<title>`, `og:title`, or share/copy greeting — that is #155.
- Name does NOT participate in undo/redo history (consistent with `unit` and `view`, which `history.js` also does not snapshot).

## Approach

**Key decisions & rationale:**

1. **`name` is document-level, not geometry.** It lives in its own live-state module `planName.js` (get/set/onChange), exactly like `units.js` owns `unit`. `plan.js` stays DOM-free and reads/writes the name through that module — no import of the header DOM.

2. **Optional-additive contract, mirroring the `color` and `measurements` precedents.** `validatePlan` never *rejects* a plan because of `name`: a missing, non-string, or otherwise unusable name normalises to *omitted* (→ placeholder at the UI), just as a bad `color` degrades to `undefined` and absent `measurements` normalises to `[]`. This guarantees back-compat: every pre-existing saved plan / share link / JSON file loads unchanged.

3. **Do NOT bump `COMPACT_VERSION`.** Adding an optional `n` key inside the existing `v:1` compact object is fully backward- and forward-compatible: old links simply lack `n` (→ placeholder), and an old decoder reading a new link ignores the unknown `n` key. `parseCompact` already hard-rejects any `compact.v !== COMPACT_VERSION`, so bumping the version would *break every existing share link* — which the back-compat requirement forbids. Keeping `v:1` is both simpler and safer.

4. **Sanitise-and-cap on the way in, at every boundary.** A single `_coerceName(raw)` helper in `plan.js` is the one place that trims, strips control/newline characters, and caps at `MAX_NAME_LEN = 60`. `validatePlan` and `parseCompact` both route through it; `setPlanName` in `planName.js` also caps so live state is always ≤ 60. The `<input>` carries `maxlength="60"` as a first line of defence. XSS is not a concern: the name is only ever written via `.value`/`.textContent`, never `innerHTML`.

5. **Reuse the existing render-driven autosave.** A name edit calls `setPlanName(v)` then `scheduleRender()`, which fires the `onRender` hook that `store.js` already debounces (800 ms) into a save — the identical path `unit` changes use (`onUnitChange(scheduleRender)`). No new save plumbing. Because `serializePlan` now includes `name`, the store's dirty-check and `main.js`'s hash-vs-local conflict compare both account for the name automatically.

## Interfaces / Types

### `src/js/plan.js`

```js
/** Max stored plan-name length (characters). */
export const MAX_NAME_LEN = 60;

/**
 * @typedef {Object} Plan
 * ... existing fields ...
 * @property {string} [name]   Optional plan name. Absent ⇒ "Untitled plan" at UI.
 */

/**
 * Normalise a raw name value into a safe, capped string, or undefined.
 * Never throws. Trims, strips control/newline chars, caps at MAX_NAME_LEN.
 * Returns undefined for non-strings or empty/whitespace-only input.
 * @param {unknown} raw
 * @returns {string|undefined}
 */
function _coerceName(raw) { /* ... */ }
```

- `buildPlan()`: add `name: getPlanName() || undefined` (omit when empty so serialized shape matches a name-less plan). Import `getPlanName` from `./planName.js`.
- `validatePlan(raw)`: after existing checks, compute `const nm = _coerceName(raw.name);` and include `name: nm` in the returned object only when `nm !== undefined`. Never rejects on `name`.
- `applyPlan(plan)`: add `setPlanName(plan.name || "")` (import `setPlanName`).
- `serializePlan(plan)`: add `name: plan.name` to the fixed-key-order object (undefined ⇒ omitted by `JSON.stringify`, so name-less plans serialize identically to before).
- `buildCompact(plan)`: after building the object, `if (plan.name) out.n = plan.name;` (omit when empty — keeps links lean). Add `@property {string} [n]` to the `CompactPlan` typedef. `COMPACT_VERSION` stays `1`.
- `parseCompact(compact)`: on the returned object, `const nm = _coerceName(compact.n); if (nm !== undefined) obj.name = nm;` — tolerant of absent `n`.

### `src/js/planName.js` (new)

```js
/** planName.js — the single current plan's name (live UI state). DOM-free. */
import { MAX_NAME_LEN } from "./plan.js";   // or inline the cap to avoid cycle — see Edge Cases

let _name = "";
const _subs = [];

/** @returns {string} current name ("" ⇒ placeholder at UI). */
export function getPlanName() { return _name; }

/** Set + cap the name; notifies subscribers only on real change. @param {string} v */
export function setPlanName(v) { /* coerce/cap, if changed: _name = ...; notify */ }

/** Subscribe to name changes. @param {(name:string)=>void} cb */
export function onChange(cb) { _subs.push(cb); }
```

> Import-cycle note: `plan.js` importing `planName.js` (for get/set) and `planName.js` importing `MAX_NAME_LEN` from `plan.js` forms a cycle. Since `MAX_NAME_LEN` is a const, prefer **inlining the `60` cap in `planName.js`** (with a comment referencing `plan.js`) rather than the back-import. `plan.js → planName.js` stays one-directional.

### `src/js/main.js`

- Grab the title input: `const planTitleEl = document.getElementById("plan-title");`
- Wire edits → live state + autosave:
  ```js
  planTitleEl.addEventListener("input", () => {
    setPlanName(planTitleEl.value);
    scheduleRender();          // drives the existing debounced autosave
  });
  ```
- Wire `planName.onChange` → reflect programmatic changes (import / share open / local restore) back into the field: `onChange((n) => { planTitleEl.value = n; });`
- On every boot-restore branch that calls `applyPlan(...)`, `applyPlan` already sets `planName` state; the `onChange` handler updates the input. Ensure `onChange` is registered **before** the boot-restore IIFE runs.

## State Model

- **In-memory (session):** `planName._name` is the single source of truth for the current name. The header `<input>.value` is a view of it, kept in sync via `input` events (view→state) and the `onChange` subscription (state→view).
- **Persisted:**
  - **localStorage** (`floorplan:plan:v1`): `name` is a field of the serialized Plan. Written by the debounced autosave whenever the plan (now including name) changes.
  - **JSON export:** `name` is a field in the downloaded `.json` (via `serializePlan`).
  - **Share URL hash:** `name` rides as `n` inside the `v:1` compact payload (or in the full JSON for the `u`/`d` codecs).
- **Not persisted / transient:** the placeholder text is UI-only; an empty name is stored as *absent* (`buildPlan` omits it), never as the literal `"Untitled plan"`.
- **Lifecycle:** boot `applyPlan` → `setPlanName` → `onChange` → input shows name (or placeholder if empty). Reset plan → `applyPlan` with a name-less plan → `setPlanName("")` → placeholder.

## Edge Cases

1. **Name-less legacy localStorage plan** → `validatePlan` omits `name`, `applyPlan` sets `""`, UI shows placeholder. No error. (Top test priority.)
2. **Name-less legacy share link (`c` codec, `v:1`, no `n`)** → `parseCompact` returns object without `name`; decodes and shows placeholder. No version bump, link still valid.
3. **Name-less legacy JSON import** → imports cleanly, placeholder shown.
4. **`name` present but not a string** (e.g. number, object, `null`) → `_coerceName` returns `undefined` → dropped, placeholder shown, plan still valid (does NOT reject the whole plan).
5. **Over-cap name (> 60 chars)** in any payload → truncated to 60 by `_coerceName`; input has `maxlength="60"`. Never throws.
6. **Whitespace-only / empty name** → coerces to `undefined`/`""` → placeholder; stored as absent.
7. **Newlines / control characters** (from paste) → stripped by `_coerceName`; title stays single-line.
8. **Exactly 60 chars (near-cap)** → accepted verbatim, no truncation, no ellipsis in storage (visual ellipsis is CSS-only).
9. **Long name in header** → CSS `text-overflow: ellipsis` + bounded `max-width` so the title never pushes or overlaps the right-hand actions cluster (see Frontend Design).
10. **HTML/script-looking name** → rendered only via `.value`/`.textContent`; no injection. Round-trips as literal text.
11. **Name-only change (no geometry edit)** → still triggers autosave via `scheduleRender`; `serializePlan` includes `name` so the dirty-check sees the delta.
12. **Undo/redo after a name edit** → name is untouched by `history.js` (not snapshotted); consistent with `unit`/`view`. A name edit is not undoable — acceptable and documented.
13. **Share-vs-local conflict where only the name differs** → serialized strings differ, so `main.js` treats it as a conflict and shows the existing "Opened shared plan / Keep my last plan" toast — correct, no special-casing.

## Dependencies

- **Existing, already present** (no new packages): `plan.js`, `store.js`, `exportJson.js`, `share.js`, `main.js`, `units.js` (pattern reference), `surface.js` (`scheduleRender`/`onRender`).
- **Frontend decision:** Variant A is **decided** (CEO, see Frontend Design) — not blocked.
- **Must land before** #154 (export caption uses the name) and #155 (tab title / share greeting use the name). This LLD is the foundation those build on; it must not implement their surfaces.

## Frontend Design

**Decision: Variant A — the plan name IS the top-left brand identity.** (CEO call to unblock the plan-name arc after ~12 days idle on `blocked:frontend-decision`; a human may override with a later `Frontend decision:` / `Restart:` comment.)

Rationale: serves the CX north star (the name is the artifact you read/screenshot when you text a link to a roommate); lowest chrome (repurposes the existing brand slot, adds zero new elements — unlike the rejected centered-bar B and stacked-line C); no new visual identity (reuses the warm-blueprint tokens and Libre Baskerville — a placement choice, not a brand/palette/type change).

**Markup** — replace the current two-line, `aria-hidden`, `pointer-events:none` brand block:

```html
<!-- Brand + editable plan title (Variant A) -->
<div class="brand">
  <div class="brand-eyebrow">floorplan</div>
  <input
    id="plan-title"
    class="brand-title"
    type="text"
    maxlength="60"
    placeholder="Untitled plan"
    aria-label="Plan name"
    autocomplete="off"
    spellcheck="false"
  />
</div>
```

- The wordmark "floorplan" demotes to a small mono/uppercase **eyebrow** (reuse the old `.brand-sub` styling: `--font-mono`, `--muted`, uppercase, ~0.65rem). The former `"warm blueprint"` tagline is dropped (it becomes the eyebrow's role). The editable plan name is the **big display line**.
- `.brand` loses `pointer-events:none` and `aria-hidden` (the input must be focusable). Keep absolute top-left at `1.25rem/1.25rem`.

**Styling (`.brand-title`):**
- `font-family: var(--font-display)` (Libre Baskerville), ~1.1rem, weight 700, `color: var(--gold)` — visually identical to the old `.brand-name`.
- Borderless by default: `background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 0.1rem 0.35rem;` so it reads as a title, not a form field.
- Placeholder styled `color: var(--muted)` (dimmer than an entered name).
- **Hover affordance:** subtle border (`border-color: var(--hairline)`) + a small pencil glyph cue (e.g. a `::after` ✎ or background icon that fades in) signalling "editable". Pointer cursor `text`.
- **Focus:** focus ring using `--gold-soft` (e.g. `border-color: var(--gold-soft); box-shadow: 0 0 0 2px var(--gold-soft)`), matching the unit/actions focus feel.
- **Truncation:** `text-overflow: ellipsis; overflow: hidden; white-space: nowrap;` with a bounded `max-width` (e.g. `min(46vw, 22rem)`) so a long name shows an ellipsis and **never pushes or collides with the right-hand `.actions-cluster`**. On focus the field may keep the same max-width (scrolls internally) — it must not expand into the actions region.
- Respect `prefers-reduced-motion` for any hover/focus transition (match existing pattern).
- Light-theme tokens already resolve (`--gold`, `--muted`, `--hairline`, `--gold-soft` are themed) — no new theme variables.

**Behaviour:** typing updates live state + autosave (see Interfaces). Blur/Enter need no special handling (state updates on `input`); optionally `Enter` blurs the field. The global keyboard handler already ignores keys while an `INPUT` is focused, so drawing/tool shortcuts won't fire while renaming.

## Test Requirements

**Unit (add to `test/tests.html`, the `plan.js` sections near existing build/validate/round-trip blocks):**
- `buildPlan` includes `name` when `planName` is set; omits it when empty.
- Full round-trip **with** a name: `buildPlan → serializePlan → JSON.parse → validatePlan` preserves the exact name.
- Full round-trip **without** a name: name-less plan validates and stays name-less (no `"Untitled plan"` literal leaks into storage).
- **Length cap:** a 61+ char name is truncated to exactly 60 by `validatePlan`/`_coerceName`.
- **Malformed name never throws / never rejects the plan:** `name` as number, object, `null`, array → `validatePlan` returns a valid plan with `name` omitted (assert it did not return `null` and did not throw).
- Whitespace-only and newline/control-char names normalise to omitted / single-line.
- **Compact codec round-trip:** `buildCompact` emits `n` only when named; `parseCompact` restores it; `COMPACT_VERSION` unchanged (assert `=== 1`).
- **Back-compat (top priority):** a hand-built `v:1` compact object with **no `n`** → `parseCompact` → `validatePlan` yields a valid, name-less plan (assert no throw, name absent). Likewise a legacy full-JSON Plan with no `name` validates.
- `applyPlan` sets `planName` live state to the plan's name (or `""` when absent).

**Integration (drive `dist/index.html` via the Playwright rig, alongside existing LLD 82/130 integration tests):**
- Type a name in `#plan-title`, reload, assert the name persists (localStorage round-trip) and the input shows it.
- Type a name → build a share link → open it in a fresh context → assert the name is restored.
- Assert a long (60-char) name does not overflow/push the `.actions-cluster` (bounding-box non-overlap check).

**Security:**
- A name containing `<script>`/HTML markup round-trips as literal text and is never interpreted as HTML (assert it appears verbatim in the input value / no injected node).
