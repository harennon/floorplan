# LLD 60: Lightweight onboarding to get a first-timer drawing in seconds

## Scope

**Covers:** A minimal, dismissible first-run experience implemented as **two anchored
coach-marks** — small tooltips that point at the real UI so a first-timer learns *where*
the two primary actions live:

1. **Draw a wall** — anchored to the wall-tool button `#tool-wall` on the left tool rail.
2. **Start from a template** — anchored to the empty-state CTA `#empty-cta` (from LLD-43),
   which already appears only on an empty boot.

The coach-marks appear **only on an empty first run** (no prior plan, and never dismissed
before), never block the canvas, dismiss on the first meaningful interaction, and offer an
explicit "Got it — hide tips" affordance. A `seen` flag persists in `prefs.js` under the
existing `floorplan:prefs:v1` key. A new module `src/js/onboarding.js` owns this behaviour,
mirroring the controller style of `help.js` / `templates.js`.

**Does NOT cover:**
- A multi-step guided tour, carousel, video, or modal wall. This is intentionally
  hint/coach-mark scale (per the issue "Out of scope").
- Any change to the drawing, template, plan, or persistence subsystems. Onboarding only
  *reads* existing state (`isEmptyPlan`) and *renders* transient DOM anchored to existing
  elements.
- New color tokens, a new modal framework, or a build step.
- Re-showing onboarding for returning users, or a "reset tips" setting (out of scope; the
  flag is one-way for v1).
- Teaching the full shortcut set — that is `help.js`'s job (`?` overlay).

## Approach

**Direction is LOCKED: Option B — anchored coach-marks, not a floating card or hero.** The
rationale (from the owner): onboarding should teach *where* things are, so the tips point at
the real DOM elements the user will actually click.

**New module `src/js/onboarding.js` (controller only, no data model).** Following the
`help.js`/`templates.js` pattern, a single module owns `init`, `maybeShow`, `dismiss`, and
`isShown`. It receives DOM anchor refs and an `isEmpty: () => boolean` callback via injection
from `main.js` (no static imports of view/history/surface — avoids circular imports). It
imports only `prefs.js` for the seen-flag.

**Gating — show only on an empty first run.** `maybeShow()` returns early (shows nothing)
unless **all** of:
- `prefs.onboardingSeen()` is `false` (never dismissed before), **and**
- `isEmpty()` is `true` (empty live plan — nothing drawn/restored), **and**
- boot took the "empty start" branch (no share hash, no local plan). `main.js` only calls
  `maybeShow()` from that branch, so a returning user with a saved plan or an opened share
  link never sees it. This directly satisfies "does not nag returning users."

**Never block the canvas.** Coach-marks are `position: fixed`, `pointer-events: none` on the
tip body, with `pointer-events: auto` only on the small "Got it" button. The user can start
drawing immediately. Any of these dismiss the tips permanently:
- A pointerdown/click on the stage/canvas (first meaningful interaction).
- Clicking the wall tool, the empty-CTA, or opening the template gallery.
- The explicit "Got it — hide tips" button.
- `Esc` (parity with other overlays; capture-phase, but does **not** `stopPropagation` since
  coach-marks don't conflict with wall-chain Esc — see Edge Case 4).
On dismiss, `prefs.setOnboardingSeen(true)` persists so it never returns this session or
future ones.

**Anchoring is the chief pitfall — anchor to real DOM, reposition on layout change.**
Positions are computed from `getBoundingClientRect()` of each anchor at show time and
recomputed on `resize` and `orientationchange` (throttled via `requestAnimationFrame`).
Because both anchors and the tips are `position: fixed` in viewport coordinates, no scroll
offset math is needed (the app is a single non-scrolling viewport).

**Degrade gracefully — never point at nothing.** For each coach-mark, before showing, check
the anchor: it must exist, be visible (`offsetParent !== null` / non-zero rect), and lie
within the viewport. If an anchor fails any check (e.g. the tool rail is collapsed on mobile,
or `#empty-cta` is `hidden` because LLD-43 templates didn't ship / plan is non-empty), that
individual tip is **suppressed** — the other may still show. If *both* fail, `maybeShow()`
shows nothing and does **not** set the seen flag (so the user still gets tips on a later,
better-laid-out session). Reposition-on-resize re-runs the same visibility check and hides a
tip whose anchor has gone off-screen or collapsed.

**Respect the aesthetic and reduced motion.** Tips reuse the warm-blueprint tokens
(`--panel`, `--gold`, `--gold-soft`, `--muted`, `--font-mono`) already used by `.empty-cta`
and the overlays — no new tokens. A fade/slide-in transition is gated behind
`@media (prefers-reduced-motion: reduce)` (matching the existing overlay CSS).

**Client-side only.** The sole persisted state is the boolean seen-flag inside the existing
`floorplan:prefs:v1` object. No backend, no new storage key. Consistent with the
client-side-only v1 invariant.

## Frontend Design

**Decision: Option B — anchored coach-marks (LOCKED by owner).** Two small tooltips point at
the real UI: one at the wall tool on the left rail, one at the template entry point. NOT a
floating card, NOT a hero, NOT a tour. Rationale: onboarding should teach *where* things are.

**Markup (`src/index.html`).** Add one container that holds both coach-marks, as a sibling of
the existing overlays. It is `hidden` by default and shown by `onboarding.js`. Each tip has an
arrow element (a CSS-rotated square) that JS positions toward its anchor.

```html
<div id="onboarding" class="onboarding" hidden aria-live="polite">
  <div class="coach-mark" id="coach-wall" role="note" data-anchor="tool-wall" hidden>
    <span class="coach-arrow" aria-hidden="true"></span>
    <span class="coach-text">Draw a wall — click here, then click on the grid to start.</span>
  </div>
  <div class="coach-mark" id="coach-template" role="note" data-anchor="empty-cta" hidden>
    <span class="coach-arrow" aria-hidden="true"></span>
    <span class="coach-text">Or start from a template.</span>
  </div>
  <button class="coach-dismiss" id="coach-dismiss">Got it — hide tips</button>
</div>
```

**Styling (`src/index.html` `<style>`).** New rules under the existing overlay CSS block:
- `.onboarding` — `position: fixed; inset: 0; z-index: 6` (above `.empty-cta`'s `z-index:4`,
  below toasts/menus); `pointer-events: none` so it never blocks the canvas.
- `.coach-mark` — `position: fixed; max-width: 15rem; background: var(--panel); border: 1px
  solid var(--gold-soft); color: var(--ink); font-family: var(--font-mono); font-size:
  0.72rem; padding: 0.45rem 0.7rem; border-radius: 8px; backdrop-filter: blur(8px);` Left/top
  set inline by JS. `pointer-events: none` (informational only).
- `.coach-arrow` — an 8px `var(--panel)` square rotated 45° with a `--gold-soft` border on two
  edges; JS sets its side/offset via a `data-side` attribute (`left`/`right`/`top`/`bottom`).
- `.coach-dismiss` — reuses `.empty-cta` visual language (pill, `var(--gold)` text,
  `var(--gold-soft)` border); `position: fixed`; `pointer-events: auto`; placed near the
  bottom-center or beneath the lower tip. It is the one interactive element.
- `@media (prefers-reduced-motion: reduce)` — disable the entrance transition (match the
  `.empty-cta` / overlay guards already in the file).

**Anchor & position algorithm (`onboarding.js`).** On show and on each reposition:
1. For each coach-mark, resolve its anchor by `data-anchor` id.
2. Compute `rect = anchor.getBoundingClientRect()`.
3. Visibility guard: skip (hide the tip) if no anchor, `rect.width === 0 && rect.height === 0`,
   `anchor.offsetParent === null` (display:none/collapsed ancestor), or the rect center is
   outside the viewport.
4. Placement: the wall-tool tip sits to the **right** of the rail button
   (`left = rect.right + gap`, vertically centered on the button). The template tip sits
   **above** the `#empty-cta` (`bottom-anchored` above the pill). Clamp within an 8px viewport
   margin so the tip is never clipped; if clamping would overlap the anchor, flip side.
5. Set `.coach-mark` inline `left`/`top` and the arrow's `data-side` + offset accordingly.

**Entry / dismissal wiring.**
- `onboarding.init(refs)` registers: a one-shot capture-phase pointerdown listener on the
  stage; click listeners on `#tool-wall`, `#empty-cta`, and (via the same handler) the
  overflow "Start from a template" item; a `keydown` Esc listener; the `#coach-dismiss` click;
  and `resize`/`orientationchange` reposition listeners.
- `main.js` calls `onboarding.maybeShow()` **only in the "empty start" boot branch**, after
  the first `render()` (so `#empty-cta` visibility has been resolved by its `onRender` hook).

**Accessibility.** Container is `aria-live="polite"`; each tip is `role="note"`. The dismiss
button is a real `<button>` with visible text. Coach-marks add no focus trap and no
`aria-modal` (they are non-blocking hints, not dialogs). Esc dismisses.

**Mobile.** On narrow screens the rail may be collapsed (`.rail--collapsed`) — the wall-tool
anchor then fails the `offsetParent` check and that tip is suppressed; the template tip
(anchored to the always-centered `#empty-cta`) still shows. Tips use viewport-clamped `fixed`
positioning so they render correctly at small widths.

## Interfaces / Types

**`src/js/prefs.js` — extend the existing `Prefs` object with a one-way seen flag.**
No new storage key; the flag lives inside `floorplan:prefs:v1` alongside `gridSnap`/`theme`.

```js
/** @typedef {{ gridSnap: boolean, theme: "light"|"dark", onboardingSeen: boolean }} Prefs */

// _defaults gains:  onboardingSeen: false
// _load() gains:    if (typeof parsed.onboardingSeen === "boolean")
//                     _prefs.onboardingSeen = parsed.onboardingSeen;

/** True once the user has dismissed (or auto-dismissed) the first-run coach-marks. */
export function onboardingSeen();          // : boolean

/** Persist that onboarding has been seen; fires onPrefsChange listeners. */
export function setOnboardingSeen(seen);   // (seen: boolean) => void
```

Notes: the flag defaults to `false` (unseen). Unknown/missing key falls back to `false`
(so the flag is additive and forward/backward compatible with existing stored prefs). It is
never written into the plan document or export (prefs are session prefs, per prefs.js doc
comment).

**New module `src/js/onboarding.js`:**

```js
/**
 * Wire anchors + injected callbacks; register dismissal & reposition listeners.
 * Does NOT show anything — call maybeShow() when appropriate.
 * @param {{
 *   container:   Element,            // #onboarding
 *   wallTip:     Element,            // #coach-wall
 *   templateTip: Element,            // #coach-template
 *   dismissBtn:  Element,            // #coach-dismiss
 *   stage:       Element,            // #stage (first-interaction dismissal)
 *   wallBtn:     Element,            // #tool-wall (anchor + click-dismiss)
 *   emptyCta?:   Element,            // #empty-cta (anchor + click-dismiss)
 *   isEmpty:     () => boolean,      // isEmptyPlan
 * }} refs
 */
export function init(refs);

/**
 * Show the coach-marks iff: not seen before AND isEmpty() AND at least one anchor
 * is visible & on-screen. Suppresses individual tips whose anchor is unavailable.
 * If no tip can be shown, shows nothing and does NOT set the seen flag.
 * @returns {boolean} true if at least one tip was shown.
 */
export function maybeShow();

/** Hide all coach-marks and persist setOnboardingSeen(true). Idempotent. */
export function dismiss();

/** True while any coach-mark is visible (parity with help.isOpen / templates.isOpen). */
export function isShown();
```

**`src/js/main.js` wiring (in `DOMContentLoaded`):** grab the new DOM refs, call
`initOnboarding({...})` after `initTemplates(...)`, and call `onboarding.maybeShow()` inside
the **"empty start"** branch of the boot IIFE (after `resetView` + `render()`), guarded by the
same `if (refs present)` style used elsewhere. No other boot branch calls `maybeShow()`.

No changes to `plan.js`, `store.js`, `templates.js`, `help.js`, `actions.js`, `walls.js`, or
`symbols.js` signatures.

## State Model

- **Seen flag (persisted):** `onboardingSeen` boolean inside the existing `floorplan:prefs:v1`
  localStorage object, owned by `prefs.js`. Written once, on dismiss. One-way in v1 (no reset
  affordance). This is the *only* persisted state this feature adds.
- **Shown/visible (in-memory, transient):** `_shown` boolean in `onboarding.js`, plus per-tip
  visibility. Not persisted; recomputed each session by `maybeShow()`.
- **Anchor positions (derived, transient):** computed from `getBoundingClientRect()` at show
  time and on `resize`/`orientationchange`. Never stored.
- **No plan/document coupling:** onboarding only reads `isEmptyPlan()` via the injected
  `isEmpty` callback; it never mutates walls/symbols/view/history. Drawing a wall or loading a
  template proceeds through the existing paths untouched — onboarding merely dismisses itself.

**Lifecycle:**
1. Boot "empty start" branch → `render()` resolves `#empty-cta` visibility → `maybeShow()`.
2. `maybeShow()` gate passes → position visible tips → set `_shown = true`.
3. First interaction / wall-tool click / template open / dismiss button / Esc → `dismiss()` →
   hide container, `setOnboardingSeen(true)`, `_shown = false`, remove one-shot listeners.
4. Subsequent sessions: `onboardingSeen()` is `true` → `maybeShow()` returns `false`
   immediately.

## Edge Cases

1. **Returning user with a saved plan.** Boot takes the "only local plan" branch, which never
   calls `maybeShow()`. Even if it did, `isEmpty()` is false. No tips. (Primary "don't nag"
   guard.)
2. **User opened a share link.** Boot takes a hash branch (or shows the conflict banner);
   `maybeShow()` is not called. No tips over a shared plan or the banner.
3. **Already dismissed before (any prior session).** `onboardingSeen()` is `true` →
   `maybeShow()` returns `false` immediately, before any DOM work.
4. **Esc while a wall chain is active.** Coach-marks are non-blocking. The onboarding Esc
   handler dismisses tips but must **not** `stopPropagation`, so wallTool's bubble-phase Esc
   (finish/cancel chain) still fires. (Contrast with help.js, which *does* stop propagation —
   onboarding deliberately does not, since a tip is not a modal.) Simpler still: register at
   bubble phase and only dismiss; do not preventDefault.
5. **Rail collapsed on mobile.** `#tool-wall` fails the `offsetParent`/rect visibility check →
   the wall tip is suppressed; the template tip (anchored to centered `#empty-cta`) still
   shows. Never point at a hidden element.
6. **`#empty-cta` absent or hidden.** If LLD-43 didn't ship, or the CTA is `hidden` (non-empty
   plan / not the empty-start branch), the template tip is suppressed. If both tips are
   suppressed, `maybeShow()` shows nothing and does **not** set the seen flag, so the user can
   still be onboarded in a future, better-laid-out session.
7. **Window resized / device rotated while shown.** `resize`/`orientationchange` (rAF-throttled)
   recompute rects; a tip whose anchor moved off-screen or collapsed is hidden, others
   reposition. Never leaves a tip pointing at empty space.
8. **User draws a wall or opens templates without touching a tip.** Clicking `#tool-wall`,
   `#empty-cta`, the overflow template item, or first pointerdown on the stage all route to
   `dismiss()`. The underlying action proceeds normally (onboarding does not consume the event).
9. **localStorage unavailable (private mode / quota).** `prefs.setOnboardingSeen` swallows
   write errors (existing `_persist` behavior); the in-memory flag still flips so tips don't
   reappear within the session. Acceptable degradation.
10. **Corrupt prefs JSON.** `prefs._load` already falls back to defaults on parse failure →
    `onboardingSeen` defaults to `false`; the user is treated as a first-timer. Acceptable.
11. **`prefers-reduced-motion`.** Entrance transition disabled via media query; tips appear
    instantly. No functional change.
12. **maybeShow() called but plan somehow non-empty (race).** The `isEmpty()` gate re-checks at
    call time; if a plan materialized, no tips. Belt-and-suspenders against boot ordering.

## Dependencies

All on `main`; nothing new must be built first. Sequenced **after** LLD-43 (starter
templates), which has shipped — so the template anchor (`#empty-cta`) and the overflow item
already exist.

- `src/js/prefs.js` — extended with `onboardingSeen`/`setOnboardingSeen` and the
  `floorplan:prefs:v1` load/persist path (existing `PREFS_KEY`, `_load`, `_persist`,
  `onPrefsChange`).
- `src/js/plan.js` — `isEmptyPlan` (read via injected `isEmpty`; no changes).
- `src/index.html` — existing `#tool-wall` (left rail), `#empty-cta`, `#stage`,
  `#overflow-menu` `data-action="open-templates"` (LLD-43). Add `#onboarding` markup + coach
  CSS reusing existing tokens.
- `src/js/main.js` — grab refs, `initOnboarding(...)`, call `maybeShow()` in the empty-start
  boot branch.
- `src/js/help.js` / `src/js/templates.js` — reference patterns for the controller (not
  imported).

## Test Requirements

Tests live in `test/tests.html` (in-page `describe`/`it` harness, run headless via
`.github/run-tests.mjs`). Add a `prefs.js` case to the existing suite and a new
`onboarding.js` suite. Reset `localStorage`/prefs between cases as the existing prefs tests do.

**Unit — `prefs.js` (required, gating):**
- Default `onboardingSeen()` is `false` on a fresh prefs state.
- `setOnboardingSeen(true)` persists across a simulated reload (re-read from `PREFS_KEY`).
- `onboardingSeen` never leaks into plan serialization (extend the existing
  "theme never leaks into plan serialization" style test to cover the new key).
- Corrupt/missing `onboardingSeen` in stored JSON falls back to `false` (additive-key compat).

**Unit / behavioural — `onboarding.js` (required):**
- `maybeShow()` returns `false` and shows nothing when `onboardingSeen()` is `true`.
- `maybeShow()` returns `false` when `isEmpty()` returns `false`.
- `maybeShow()` shows tips (returns `true`, container not `hidden`) when unseen + empty +
  anchors visible (stub anchors with a non-zero `getBoundingClientRect`).
- When an anchor is missing/hidden (stub `offsetParent === null` or zero rect), the
  corresponding tip stays `hidden` and the other still shows.
- When *all* anchors are suppressed, `maybeShow()` returns `false` **and** does NOT call
  `setOnboardingSeen` (verify `onboardingSeen()` still `false`).
- `dismiss()` hides the container, sets `_shown` false, and persists
  `onboardingSeen() === true`; second `dismiss()` is a no-op.
- First stage pointerdown, wall-tool click, and dismiss-button click each trigger `dismiss()`.
- `Esc` triggers `dismiss()` but does not `stopPropagation` (assert an outer bubble-phase Esc
  listener still fires).

**Manual / QA checklist (not automated):**
- Fresh browser (cleared storage): coach-marks appear on empty boot pointing at the wall tool
  and the template CTA; drawing works while they're visible.
- Clicking "Got it — hide tips" dismisses; reload does not re-show.
- Returning user (saved plan) and share-link open: no coach-marks.
- Resize / rotate on mobile: tips reposition or gracefully hide; never point at empty space or
  a collapsed rail.
- Reduced-motion: tips appear without animation; warm-blueprint aesthetic matches the CTA.
