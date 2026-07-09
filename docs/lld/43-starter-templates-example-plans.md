# LLD 43: Starter templates / example plans to kill the blank-grid problem

## Scope

**Covers:** A small, curated set of 3-5 pre-authored starter plans (e.g. Studio apartment,
1-bedroom, Rectangular room, Small office/bathroom) that a user loads with one click. Each
template is a static, in-bundle `Plan` document (the exact shape produced by `buildPlan` and
accepted by `validatePlan` in `src/js/plan.js`). Loading a template runs it through the
existing `validatePlan → applyPlan → render` pipeline — identical to opening a shared link or
importing JSON — so a loaded template behaves as an ordinary hand-drawn plan: live
area/perimeter, clearance, autosave, undo/redo, export (PNG/SVG/JSON), and URL-hash share all
work unchanged.

Also covers: a "Start from a template" gallery UI (modal following the existing `help.js` /
`#help-overlay` pattern), an entry point to open it, SVG thumbnails per template, and a
confirmation gate before a template replaces a non-empty plan.

**Does NOT cover:**
- User-created / user-saved templates or any persistence beyond the existing localStorage
  autosave (later phase — needs a storage subsystem).
- A large, maintained, or remotely-fetched template library. The set is small, static, and
  in-bundle. No network fetch.
- Any change to the `Plan` schema, `PLAN_SCHEMA` version, walls/symbols models, or the
  validate/apply/serialize contract.
- A new modal framework. The gallery reuses the help-overlay visual + lifecycle pattern.

## Approach

**Templates are plain data, not a special mode.** Each template is a frozen `Plan` object
literal living in a new `src/js/templates.js` module. There is no "template mode": once
applied, the live models hold ordinary walls/symbols and the app cannot tell a template from a
hand-drawn plan. This satisfies the acceptance criteria (round-trip export/share, live
metrics/clearance) for free because we reuse the existing load path.

**Reuse the existing load pipeline.** Loading a template calls the same three steps the boot
restore and JSON-import paths already use:
1. `validatePlan(rawTemplate)` — defensive; returns a normalised `Plan` or `null`.
2. `applyPlan(plan)` — hydrates walls + symbols, sets view + unit.
3. `historyReset()` then `render()` — reseed the undo baseline (matching the boot-restore /
   Edge Case 12 pattern in `main.js`) so undo cannot resurrect the pre-template plan, and
   paint.
   Then `fitToContent(bounds, W, H)` (as the share-open path does) so the loaded room fills
   the viewport rather than sitting at the template's authored pan/zoom.

**New module `templates.js` (data + gallery controller).** Following `help.js`, a single
module owns: (a) the `TEMPLATES` array of `{ id, name, description, plan, thumb }` records, and
(b) the gallery modal controller (`init`, `open`, `close`, `isOpen`). It depends on `plan.js`
(`validatePlan`, `applyPlan`, `isEmptyPlan`) and receives `render`, `historyReset`,
`fitToContent`, `showToast` and viewport dims via injection from `main.js` to avoid circular
imports (mirroring how `actions.js` receives `setHistoryReset`).

**Confirmation gate (the key pitfall).** Before applying, if `isEmptyPlan()` is `false`, show a
`window.confirm("Replace current plan with this template? This can't be undone.")` — matching
the existing Reset confirm wording in `actions.js._confirmReset`. On cancel, do nothing (modal
stays open). If the plan is empty, apply immediately with no prompt. This is the sole guard
against destroying in-progress work.

**Thumbnails are inline static SVG**, authored by hand in the template record (a small
`viewBox` sketch of the room outline + a couple of furniture rects). They are decorative
previews, NOT rendered from the plan at runtime — keeping the gallery cheap and build-free.
Rationale: rendering true thumbnails would require instantiating the wall/symbol renderers
off-screen, which is far more code than a hand-drawn 120×90 SVG per template and buys little.

**Entry points.** Two affordances, both opening the same gallery:
- A "Templates" item in the existing overflow menu (`#overflow-menu`) — always reachable.
- An empty-state affordance: when the app boots with no hash, no local plan, and an empty
  plan, show a lightweight "Start from a template" button/link near the canvas that opens the
  gallery. This directly attacks the blank grid for first-timers.

**No build step, client-side only.** `templates.js` is a static ES module imported like every
other module; thumbnails are inline SVG strings. Nothing is fetched. Consistent with the
no-build / client-side-only invariant.
## Frontend Design

**Decision: Variant A — modal gallery reusing the help-overlay pattern.** Do not invent a new
modal system and do not add a build step.

**Markup (`src/index.html`).** Add a `#template-overlay` sibling to `#help-overlay`, reusing
the same class conventions (`role="dialog"`, `aria-modal="true"`, a `--visible` class toggled
by JS, an inner panel). Structure:

```html
<div id="template-overlay" class="template-overlay" role="dialog" aria-modal="true"
     aria-label="Start from a template">
  <div class="template-overlay-panel">
    <div class="template-overlay-title">Start from a template</div>
    <button class="template-overlay-close" aria-label="Close">×</button>
    <div class="template-grid" role="list">
      <!-- one card per template, populated by JS from TEMPLATES -->
      <button class="template-card" role="listitem" data-template-id="studio">
        <span class="template-thumb"><!-- inline SVG --></span>
        <span class="template-card-name">Studio apartment</span>
        <span class="template-card-desc">~28 m² studio with bed, sofa, kitchenette</span>
      </button>
      ...
    </div>
  </div>
</div>
```

Cards are rendered by `templates.js` from the `TEMPLATES` array on `init` (so the data is the
single source of truth), OR authored statically in HTML if the set is fixed — prefer
JS-populated to keep name/desc/thumb colocated with the plan data. Each card's `data-template-id`
maps to a `TEMPLATES` entry.

**Styling (`src/index.html` `<style>`).** Reuse `.help-overlay` rules as the base (full-screen
scrim, centered panel, fade transition, `prefers-reduced-motion` guard already present for the
help overlay). Add a responsive grid for `.template-grid` (e.g. `display:grid;
grid-template-columns: repeat(auto-fill, minmax(160px,1fr))`). Thumbnails are fixed-aspect
(e.g. 4:3) inline SVG using `currentColor` / the existing blueprint stroke palette so they read
as part of the graph-paper aesthetic. Match the danbing/blueprint visual language already in
the stylesheet; do not introduce new color tokens.

**Overlay lifecycle — mirror `help.js` exactly:**
- `open()` adds `template-overlay--visible`; `close()` removes it.
- Capture-phase `keydown` listener: `Esc` closes the overlay and calls
  `e.stopPropagation()` + `e.preventDefault()` so the event never reaches the bubble-phase
  wallTool Esc handler (same reasoning as help.js / Edge Case 15).
- Outside-click on the scrim closes; clicks inside the panel do not.
- Only one overlay open at a time: opening the template gallery should close the help overlay
  and vice-versa (call the other's close, or rely on independent controllers — keep simple:
  each closes on outside-click, so opening one via a button click closes the other).

**Entry points:**
1. Overflow menu: add `<button data-action="open-templates" role="menuitem">Start from a
   template…</button>` to `#overflow-menu`. Wire in `actions.js._onOverflowAction` (new branch)
   which calls an injected `openTemplates()` callback (injected from `main.js`, same pattern as
   `setHistoryReset`).
2. Empty-state affordance: a `#empty-cta` element (button reading "Start from a template")
   shown only when the plan is empty on boot. Hidden as soon as any content exists. It is
   simplest to toggle its visibility from the `onRender` hook based on `isEmptyPlan()`, or show
   it once at boot in the "empty start" branch of `main.js` and hide it on first content /
   first render with content. Recommended: register an `onRender` hook that sets
   `#empty-cta` `hidden = !isEmptyPlan()`.

**Card interaction.** Clicking a card calls `templates.applyTemplate(id)`:
1. Look up the record; if missing, `showToast("Template not found")` and return.
2. `validatePlan(record.plan)` → if `null`, `showToast("Couldn't load template")` and return
   (defensive; a shipped template should never fail — the test suite guarantees this).
3. If `!isEmptyPlan()` → `window.confirm(...)`; on cancel, return (leave modal open).
4. `saveNow()` (keep the save pill coherent, matching `_confirmReset`), `applyPlan(plan)`,
   `historyReset()`, `fitToContent`/`resetView`, invalidate the share cache implicitly via
   `render()`'s `onRender` hooks, `render()`, `close()` the modal, and hide `#empty-cta`.
5. `showToast("Loaded '" + record.name + "'")`.

**Accessibility.** `role="dialog"`/`aria-modal`, focus the first card on open, `Esc` to close,
cards are real `<button>`s. Match the help overlay's existing a11y treatment.

## Interfaces / Types

New module `src/js/templates.js`:

```js
/**
 * @typedef {Object} Template
 * @property {string} id           stable slug, e.g. "studio"
 * @property {string} name         display name, e.g. "Studio apartment"
 * @property {string} description  one-line blurb for the card
 * @property {string} thumb        inline SVG markup string (decorative preview)
 * @property {import("./plan.js").Plan} plan  a full, valid Plan document literal
 */

/** The curated, in-bundle set (3-5 entries). Frozen. */
export const TEMPLATES; // : Template[]

/**
 * Wire DOM refs + injected callbacks; render the cards; register listeners.
 * @param {{
 *   overlay: Element,          // #template-overlay
 *   grid: Element,             // .template-grid (card container)
 *   closeBtn: Element,         // .template-overlay-close
 *   emptyCta?: Element,        // #empty-cta (optional)
 *   apply: (plan:import("./plan.js").Plan)=>void,  // applyPlan + historyReset + fit + render
 *   isEmpty: ()=>boolean,      // isEmptyPlan
 *   toast: (msg:string)=>void, // showToast
 * }} refs
 */
export function init(refs);

/** Show the gallery. */
export function open();

/** Hide the gallery. */
export function close();

/** True while the gallery is visible (parity with help.isOpen). */
export function isOpen();

/**
 * Validate → confirm-if-dirty → apply a template by id. Returns true if applied.
 * @param {string} id
 * @returns {boolean}
 */
export function applyTemplate(id);
```

Notes:
- `TEMPLATES` and each `plan` are deep-frozen (or `applyTemplate` always applies the
  `validatePlan` return value, which is a fresh deep copy — preferred, so the frozen source is
  never mutated by downstream models).
- The `apply` callback passed from `main.js` encapsulates the `applyPlan → historyReset →
  fitToContent/resetView → render` sequence so `templates.js` needs no static imports of
  `history.js`, `view.js`, `exportImg.js`, or `surface.js` (avoids circular imports; mirrors
  the injection style already used in `actions.js`/`main.js`).

`actions.js` gains a setter mirroring `setHistoryReset`:

```js
/** Inject the "open template gallery" callback from main.js. */
export function setOpenTemplates(fn); // fn: ()=>void
```
and a new `"open-templates"` branch in `_onOverflowAction`.

No changes to `plan.js`, `walls.js`, `symbols.js`, `share.js`, or `store.js` signatures.

## State Model

- **Template definitions:** static, in-bundle, immutable. Compiled into the JS bundle; never
  fetched, never written. Authored once in `templates.js`.
- **Overlay open/closed:** transient in-memory boolean in `templates.js` (`_open`), identical
  in lifecycle to `help.js._open`. Not persisted.
- **Applied plan:** once `applyTemplate` runs, the plan lives in the ordinary live models
  (`wallsModel`, `symbolsModel`, `view`, `unit`) — exactly as any other plan. From that moment
  it is indistinguishable from hand-drawn work.
- **Persistence:** the existing `store.js` autosave `onRender` hook fires on the `render()`
  call at the end of `applyTemplate`, so the loaded template is written to `localStorage`
  (`floorplan:plan:v1`) by the normal debounced path. No new storage keys.
- **Undo baseline:** `historyReset()` is called after apply (via the injected `apply`
  callback), so the applied template becomes the new undo baseline; the pre-template plan is
  intentionally not recoverable via undo (parity with Reset / share-open, and the reason the
  confirm gate exists).
- **Share cache:** the `onRender` hooks in `actions.js` invalidate + rebuild the share hash
  cache on the post-apply `render()`, so the Share button reflects the template immediately. No
  special handling needed.

## Edge Cases

1. **Non-empty current plan.** `isEmptyPlan()` is false → `window.confirm` before applying. On
   cancel: no mutation, modal stays open. This is the primary data-loss guard.
2. **Empty current plan.** Apply immediately, no confirm — nothing to lose.
3. **Malformed shipped template.** `validatePlan` returns `null` → `showToast("Couldn't load
   template")`, no mutation. Should never happen in production (guarded by the required test),
   but handled defensively rather than throwing.
4. **Unknown template id** (e.g. stale `data-template-id`): `applyTemplate` finds no record →
   toast + return, no mutation.
5. **Template opened over a share-link conflict banner:** the banner in `main.js` blocks the
   boot render until a choice is made. The overflow menu is available, so a user could open
   templates while the banner is up. Applying a template resolves the situation by replacing
   everything; ensure applying does not leave the banner visible — closing the banner is out of
   `templates.js`' scope, so keep the empty-state CTA and gallery independent of the banner and
   accept that this is a rare interleaving. Recommendation: the empty-state CTA is only shown in
   the "empty start" boot branch (no hash, no local), so it never coexists with the banner. The
   overflow-menu entry is the only path during a banner, and it's acceptable there.
6. **Esc key while gallery open:** capture-phase handler closes gallery and stops propagation so
   wallTool's Esc (finishChain) does not also fire (mirrors help.js Edge Case 15).
7. **Both help and template overlays:** opening one closes the other via outside-click / button
   click; do not allow both `--visible` simultaneously. Keep the interaction simple; a stacked
   state is not required.
8. **Units.** Templates author `unit` ("ft" or "m"); `applyPlan` calls `setUnit`, so the plan's
   unit becomes active. Author all templates with a consistent unit (recommend "m" internally
   since world coords are metres; display unit is a preference). Confirm each template's `unit`
   is one of `VALID_UNITS`.
9. **View/fit.** Templates may author any `view`, but after apply we `fitToContent(bounds, W,
   H)` so the room fills the viewport regardless of authored zoom/pan (parity with share-open).
   If `contentBounds()` is null (shouldn't happen for a real room), fall back to `resetView`.
10. **Empty-state CTA lingering.** After a template loads (or after any content is drawn), hide
    `#empty-cta`. Drive its visibility from `isEmptyPlan()` on render so it reappears if the user
    later resets to empty.
11. **Frozen-source mutation.** Downstream models mutate their arrays; always apply the
    `validatePlan` return (a fresh deep copy via `JSON.parse(JSON.stringify(...))`), never the
    literal, so re-loading a template yields the same result every time.
12. **Symbol type drift.** Every symbol in a template must use a `type` present in `symbols.js`
    `CATALOG`; `validatePlan` rejects unknown types. The template test catches this.

## Dependencies

All already on `main`; nothing new must be built first.
- `src/js/plan.js` — `validatePlan`, `applyPlan`, `isEmptyPlan`, `Plan` shape, `PLAN_SCHEMA`.
- `src/js/walls.js` / `src/js/symbols.js` — model shapes and `CATALOG` (constrains what
  templates may contain). Template symbol `w`/`h` should respect per-type `min`/`max` for a
  clean look (not strictly validated, but recommended).
- `src/js/units.js` — `setUnit`, `VALID_UNITS`.
- `src/js/view.js` (`fitToContent`, `resetView`) + `src/js/exportImg.js` (`contentBounds`) —
  used via the injected `apply` callback in `main.js`.
- `src/js/history.js` — `reset` (via injected `apply`).
- `src/js/actions.js` — `showToast`, plus new `setOpenTemplates` + `open-templates` overflow
  branch.
- `src/js/help.js` — reference pattern for the overlay controller (not imported).
- `src/index.html` — new `#template-overlay` markup, `#empty-cta`, overflow menu item, and
  reused overlay CSS.
- `src/js/main.js` — construct the `apply` callback, call `initTemplates(...)`, wire
  `setOpenTemplates`, and toggle `#empty-cta`.

Coordinate authoring: template `plan` literals are hand-authored. Author them by drawing the
room in the live app and copying the JSON export, then paste as the `plan` literal — the
fastest way to get valid, in-catalog geometry.

## Test Requirements

Tests live in `src/tests.html` (in-page `describe`/`it` harness, run headless via
`.github/run-tests.mjs`). Add a `templates.js` import and a new suite.

**Unit (required, gating):**
- **Every shipped template passes `validatePlan`.** Iterate `TEMPLATES`; assert
  `validatePlan(t.plan) !== null` for each. This is the acceptance-criteria guarantee that a
  malformed template can never ship.
- **Each template applies without error.** For each, `validatePlan` then `applyPlan` inside a
  try/save-restore of the live models; assert no throw and that `wallsModel`/`symbolsModel`
  reflect the template (e.g. rooms/symbols counts match the source).
- **Each template is non-empty after apply** (`isEmptyPlan()` is false) — a template that
  loads to a blank grid defeats the feature.
- **Template metadata integrity:** unique `id`s, non-empty `name`, non-empty `thumb`, and
  `TEMPLATES.length` between 3 and 5.
- **`unit` is valid** for each template (`VALID_UNITS.includes(t.plan.unit)`).
- **Round-trip:** for each template, `serializePlan(validatePlan(t.plan))` equals
  `serializePlan(validatePlan(t.plan))` (stable) and re-`validatePlan` of the applied+rebuilt
  plan succeeds — proving templates export/share like any plan.

**Behavioural (recommended, may be light given the harness):**
- `applyTemplate` returns false / does not mutate models when given an unknown id.
- With a non-empty live plan, `applyTemplate` respects a stubbed `confirm` returning false (no
  mutation); returning true applies. (Stub `window.confirm`.)
- `open()`/`close()`/`isOpen()` toggle the overlay's `--visible` class.

**Manual / QA checklist (not automated):**
- Overflow-menu entry and empty-state CTA both open the gallery.
- Loading a template with existing work prompts a confirm; cancel preserves work.
- Loaded template renders walls, dimensions, furniture; live area/perimeter and clearance
  update; Share/PNG/SVG/JSON all work.
- Esc and outside-click close the gallery; Esc does not finish an in-progress wall chain.
