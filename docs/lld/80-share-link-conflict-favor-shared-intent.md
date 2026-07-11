# LLD 80: Share link silently loses to local autosave when reopened by the author (only "works" in incognito)

## Scope

Fixes the boot-restore conflict path so an explicit share link (`#<hash>`) never silently
loses to a background autosaved plan. Refines two sites only:

- `src/js/main.js` boot-restore branch (~616–648) — the "both hash + local, and they
  differ" conflict case.
- `src/js/actions.js` `showConflictBanner` (~182–210) — including the silent
  no-banner-element fallback at ~184.

**Covers:**
- Making the shared plan the safer default when a hash conflicts with a differing local
  plan (author-revisit and MCP `get_share_url` consumption path).
- Removing the one genuinely silent local-wins fallback (`actions.js:184`).
- A test asserting: hash present + differing local → shared is applied (or a visible
  banner is shown), never a silent local-wins.

**Does NOT cover:**
- Any change to the share codec, plan schema, or persistence format (LLD 16 / LLD 77
  stay untouched).
- The identical-plan no-banner fast path (`main.js:621`) — kept exactly as-is.
- The hash-only, local-only, and empty-start boot branches — unchanged.
- Any new module, chrome family, or runtime dependency.

## Approach

**Root cause.** A present hash is an explicit user intent ("open this link"). Today the
conflict path (`main.js:629` → `showConflictBanner`) applies *nothing* until the user
picks a banner button, and the banner presents "Open shared" and "Keep mine" as
co-equal choices. For the author revisiting their own link over a prior autosave, it is
easy to dismiss/miss the banner and let local win — so the link reads as "broken outside
incognito." Incognito has no `localStorage`, so it skips the conflict entirely and the
hash applies cleanly, which is why it appears to work only there.

Additionally, `showConflictBanner` at `actions.js:184` silently calls `onChoice("local")`
when `_bannerEl` is missing — discarding the shared intent with no prompt at all.

**Decision — Option B: auto-open shared + one-tap undo toast (no banner for this path).**
When a hash conflicts with a differing local plan, **immediately apply the shared plan**
(the intent the user just acted on), reframe via `fitToContent`, and surface a
`showToast(...)` with a one-tap **"Keep my last plan instead"** action button that
restores the local plan. Rationale:

1. **Honors intent, reversible.** The shared plan (what the user clicked) shows instantly;
   the prior local plan is never touched in `localStorage` until the next autosave
   overwrites it, so the undo action can fully restore it in-session. Nothing is lost.
2. **Reuses existing UX.** `showToast(msg, {label, onClick})` already renders a one-tap
   action button (`actions.js:138–166`, CSS `.toast-action-btn`). This is the same idiom
   used elsewhere, so no new banner styling or DOM is required and the "hard to miss"
   requirement is met by the same toast the user already sees on every open.
3. **Fixes the silent fallback naturally.** `showConflictBanner` is no longer on the
   critical path for this case; the boot branch drives the decision. `showConflictBanner`
   is retained (see below) but its silent-fallback bug is fixed to favor share intent.

**`showConflictBanner` disposition.** The auto-open+undo pattern supersedes the banner for
the conflict path, so `main.js` stops calling `showConflictBanner` there. To satisfy the
guardrail "never silently discard the hash," `showConflictBanner`'s no-element fallback is
changed from `onChoice("local")` to `onChoice("shared")` — if the element is ever absent,
favor the explicit share intent instead of background autosave. This keeps the function
correct for any residual/ future caller and removes the last silent local-wins path.
(Rationale: the sole caller is being removed, but leaving a latent silent-local-wins bug
in an exported function is a trap; a one-line flip closes it.)

**What stays identical.**
- `main.js:621` identical-plan fast path (`hashSer === localSer`) → local restore, no
  prompt. Unchanged.
- Hash-only branch (`main.js:649`), local-only branch (`main.js:661`), empty-start branch
  (`main.js:667`). Unchanged.
- Share codec, plan schema, autosave, `fitToContent`/`contentBounds` behavior. Unchanged.

## Interfaces / Types

No new modules or exported signatures. Reuses existing exports:

```js
// actions.js (existing) — one-tap action toast, already supports the undo affordance
export function showToast(msg, action?: { label: string, onClick: () => void }): void

// plan.js (existing)
export function applyPlan(plan: Plan): void
export function serializePlan(plan: Plan): string

// view.js / exportImg.js (existing)
export function fitToContent(bounds, W, H): void
export function contentBounds(): Bounds | null
```

**Boot conflict branch (`main.js`, replaces the `else` block at ~627–648).** Sketch:

```js
} else {
  // Conflict: hash present AND differs from local. A present hash is explicit
  // user intent — auto-open the shared plan, offer a one-tap undo to local.
  const applyShared = () => {
    applyPlan(hashPlan);
    historyReset();
    const bounds = contentBounds();
    if (bounds) fitToContent(bounds, vW, vH); else resetView(vW, vH);
  };
  const applyLocal = () => {
    applyPlan(localPlan);
    historyReset();
    render();
  };
  applyShared();
  render();
  showToast("Opened shared plan", {
    label: "Keep my last plan instead",
    onClick: applyLocal,
  });
  return;
}
```

Notes:
- `historyReset()` is called on each apply to reseed the undo baseline (Edge Case 12 in
  LLD 16), matching the existing conflict-branch behavior.
- The undo `onClick` re-applies `localPlan` (still in memory from `loadLocal()`) and
  restores its stored view verbatim via plain `applyPlan` (no `fitToContent`), matching
  the "Keep mine" semantics of the old banner. `localStorage` is not overwritten until the
  next autosave, so the local plan is intact for the undo.

**`showConflictBanner` fallback fix (`actions.js:183–186`).**

```js
if (!_bannerEl) {
  // No banner element: favor explicit share intent (a hash was present), never
  // silently discard the shared plan in favor of background autosave.
  onChoice("shared");
  return;
}
```

## State Model

No new persisted or in-memory state. Sources of truth (`walls.model`, `symbols.model`,
`view.view`, `units.unit`) are unchanged.

**Ordering / persistence guarantees:**
- On conflict, the shared plan is applied to the live model immediately; the **local plan
  in `localStorage` is untouched** at boot. It is only overwritten by the debounced
  autosave (~800 ms, LLD 16) after a real change. This gives the in-session undo a valid
  `localPlan` snapshot to restore.
- If the user taps "Keep my last plan instead" before any autosave fires, the local plan
  is re-applied and localStorage already matches it — no data loss.
- If the user does nothing and starts editing the shared plan, autosave overwrites local
  with the shared-derived plan — the intended "I opened the link and kept it" outcome.
- `location.hash` is still stripped after `readBootHash()` (LLD 16), so a later
  refresh/autosave does not re-trigger the shared-open path.

Both `hashPlan` and `localPlan` are held in the boot IIFE closure, so the undo callback
captures `localPlan` without any extra storage.

## Frontend Design

**Decision: Option B — auto-open shared + one-tap "Keep my last plan instead" undo
toast.** No new DOM, no new CSS. Reuses the existing action-toast (`showToast(msg, action)`
→ `.toast` + `.toast-action-btn`, `index.html:1541`).

- On a hash/local conflict the shared plan renders instantly (fit-to-content frame), and a
  toast reads **"Opened shared plan"** with a single tap target **"Keep my last plan
  instead."** This satisfies the "shared is the safer, hard-to-miss default" requirement:
  the user sees the plan they asked for, with an obvious, reversible escape hatch.
- The toast auto-dismisses on the existing `TOAST_DURATION_MS` (3500 ms) timer; tapping the
  action dismisses immediately and restores local (existing behavior in
  `actions.js:151–157`).
- Motion respects `prefers-reduced-motion` via the existing `.toast { transition: none }`
  reduce block (`index.html:1531`). No banner animation is involved on this path.
- The `#conflict-banner` element and its CSS remain in `index.html` (unused by this path
  but harmless); no markup is removed, keeping the change surgical. `showConflictBanner`
  stays exported with its fallback fixed.

**Why not restyle the banner as primary-"Open shared".** The selection permits either
pattern but prefers auto-open+undo "if it fits the existing banner UX." It fits better:
the action-toast idiom already exists and is used across the app, so this needs zero new
styling and produces a lighter, less modal interruption than a persistent two-button strip
— a better match for the "text it to a roommate" instant-open story.

## Edge Cases

## Edge Cases

1. **Hash identical to local** (`hashSer === localSer`). Unchanged fast path: local
   restore, "Restored your last plan" toast, no conflict handling. (LLD 16 Edge Case 14.)
2. **Hash present, no local plan.** Unchanged hash-only branch: apply + fit-to-content +
   "Opened shared plan". No undo toast (nothing to keep).
3. **Local present, no hash.** Unchanged local-only branch: verbatim restore.
4. **Malformed / undecodable hash.** `readBootHash()` throws or returns null → handled by
   existing catch ("That share link couldn't be opened.") and the code falls through to
   the local/empty branches. This LLD's conflict branch is only reached when `hashPlan` is
   a valid decoded plan.
5. **Undo tapped after autosave already overwrote local.** Autosave debounce is ~800 ms;
   the toast persists 3500 ms, so an undo tap can land after an autosave that wrote the
   shared-derived plan. `localPlan` is still held in the closure, so the undo re-applies
   the correct prior plan to the live model regardless of what localStorage now holds; the
   next autosave then re-persists local. No data loss — the in-memory snapshot is
   authoritative for the undo.
6. **Undo tapped, empty local plan.** Not reachable: the conflict branch requires
   `localPlan` truthy and differing. (An empty local plan takes the hash-only-style
   branch.)
7. **`showConflictBanner` called with no `#conflict-banner` element.** Now favors
   `onChoice("shared")` (share intent) instead of the previous silent `"local"`. Element
   is normally always present (wired in `index.html:2124`), so this is a defensive path.
8. **`prefers-reduced-motion`.** Toast shows/hides instantly via existing reduce block.
9. **MCP `get_share_url` consumption.** A recipient opening an MCP-generated link over
   their own prior plan now gets the shared plan up-front with a one-tap keep-mine — the
   customer-facing consumption path no longer appears broken.

## Dependencies

All already shipped (LLD 16, LLD 77). No new dependency.

- `actions.js` `showToast(msg, action)` — action-toast with one-tap button (exists).
- `plan.js` `applyPlan`, `serializePlan` (exist).
- `view.js` `fitToContent`, `resetView`; `exportImg.js` `contentBounds` (exist).
- `history.js` `reset` (exists; called as `historyReset` in `main.js`).
- `share.js` `readBootHash`; `store.js` `loadLocal` (exist).
- `index.html` `#toast` and `.toast-action-btn` styling (exist).

No `index.html` markup or CSS changes required.

## Test Requirements

Extend the existing in-browser harness (`src/tests.html`, run via
`.github/run-tests.mjs`). Reset `walls.model`, `symbols.model`, `units.unit`, `view`, and
`localStorage` between suites.

**Behavioral — boot conflict path (the regression this LLD guards):**
- **Hash present + differing non-empty local → shared applied, never silent local-wins.**
  Seed `localStorage` with plan A; set `location.hash` to an encoded, *different* plan B;
  run the full boot sequence. Assert: the live model equals **B** (shared), a visible
  "Opened shared plan" toast with a "Keep my last plan instead" action is shown, and the
  hash is stripped. Explicitly assert the model is NOT A (no silent local-wins).
- **Undo action restores local.** After the above, invoke the toast action's `onClick`;
  assert the live model equals **A** (local) with its stored view.
- **Identical hash + local → no conflict toast** (unchanged fast path): live model equals
  the plan, "Restored your last plan" toast, and no "Keep my last plan instead" action.
- **Hash-only (no local) and local-only branches unchanged** (guard against regressions in
  the surrounding branches).

**Unit — `showConflictBanner` fallback:**
- With `_bannerEl` unset/null (init without a banner element), `showConflictBanner`
  invokes `onChoice("shared")`, not `"local"` — favoring share intent, never silently
  discarding the hash.

**Failure-mode:**
- Undo tapped after a simulated autosave overwrite of localStorage still restores plan A
  from the in-memory snapshot (Edge Case 5); no throw.
