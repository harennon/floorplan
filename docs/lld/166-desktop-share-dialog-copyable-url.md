# LLD 166: Desktop share dialog — show the share URL in a selectable field with a Copy button

## Scope

Part of #3 (Phase 2: polish & delight); order 2 of 3. Builds directly on the
clipboard fallback branch that LLD 165 (#159, shipped as PR #163) introduced, and
introduces the dialog surface that the QR sub-issue (#161) will hang on.

**In scope**
- On the **non-native-share path only** (browsers without `navigator.share`, i.e. most
  desktops), replace today's silent copy-and-toast with a small share dialog anchored to
  the page, opened when the user clicks `#btn-share`.
- Show the full share URL in a **read-only, pre-selected** text field so the user can
  inspect, select, and copy it manually.
- Include a **Copy** button that copies the URL via the existing copy logic (`_copyUrl`)
  and confirms with the existing toast.
- Dismiss on **Esc**, **outside-click**, and a **close (×) button**, with accessible
  focus handling that matches the existing help-overlay / template-overlay conventions.
- Surface the existing long-URL soft-limit warning **inside the dialog** (as visible
  static text) rather than as a transient toast, for the oversized-URL case.
- Client-side only. No new npm dependency. No document-contract or editor-state change.

**Out of scope**
- The QR code (next sub-issue #161) — the dialog is designed to leave room for it but
  adds no QR markup or logic here.
- Any change to the **native** `navigator.share` path from LLD 165 — that branch is
  untouched; the dialog must not hijack it.
- Any change to `src/js/share.js` encode/decode or the URL round-trip.
- Any reshaping of the header or brand identity (per Frontend note in the issue).

## Approach

**Where it hooks in.** LLD 165 split `_onShare()` into a synchronous dispatcher that
routes to `_nativeShare()` when `navigator.share` exists **and the URL cache is fresh**,
else falls through to `_shareViaClipboard()`. This LLD changes **only the desktop
sub-case of the fallback branch**.

**Critical: `_shareViaClipboard()` is also reached on mobile.** `_onShare` routes to
native only when `navigator.share && _cachedHashUrl && !_cacheStale`. When
`navigator.share` **is present but the cache is stale** (the brief window right after an
edit, before the background rebuild lands), it falls through to `_shareViaClipboard()`.
That path must NOT open the desktop modal, or a mobile user who taps Share during that
window would get the dialog instead of the OS share sheet — violating AC5. Therefore the
dialog is gated on `navigator.share` **absence**, decided inside `_shareViaClipboard()`
after the URL is resolved:

- `navigator.share` **absent** → `_openShareDialog(url)` (this LLD's new behavior).
- `navigator.share` **present** (stale-cache fall-through, mobile) → preserve LLD 165's
  behavior exactly: `_copyUrl(url)` (silent copy + toast), no dialog.

```
click → _onShare()   [sync dispatcher, unchanged from LLD 165]
  ├─ navigator.share present AND cache fresh → _nativeShare(url)          [UNCHANGED]
  └─ else → _shareViaClipboard()  → resolve url, then:
              ├─ navigator.share ABSENT   → _openShareDialog(url)          [NEW — desktop]
              └─ navigator.share PRESENT   → _copyUrl(url)  (copy + toast)  [UNCHANGED — mobile stale-cache]
```

**Getting the URL into the field.** The dialog needs the URL string synchronously to
show it selected, but `_shareViaClipboard()` already handles both the fresh-cache and
stale-cache cases (the latter `await`s `_buildAndCacheUrl()`). We keep that structure:
resolve the URL first (fast path from `_cachedHashUrl`, or `await _buildAndCacheUrl()`),
then branch on `navigator.share` presence — dialog when absent, `_copyUrl` when present
(see the critical note above). Because the dialog is reached only when `navigator.share`
is absent (no activation contract, and the manual Copy click is itself a fresh user
gesture), awaiting the build before opening is safe here — unlike the native path. On
build failure, keep today's `"Couldn't build share link"` toast and neither open the
dialog nor copy.

**Copy button reuses existing logic.** The dialog's Copy button calls the existing
`_copyUrl(url)` unchanged, which already: tries `navigator.clipboard.writeText`, falls
back to `execCommand`, fires the `"Link copied"` toast on success and the long-URL
`"Link copied — note: …"` variant when oversized. No new copy code. The field's value is
the same `url` string passed to `_copyUrl`, so "the field content matches what gets
copied" (acceptance criterion 2) holds by construction.

**Auto-select for manual copy.** On open, focus the read-only field and call `.select()`
(inside a `setTimeout(…, 0)` to run after the overlay becomes visible, mirroring
`templates.js` focusing the first card). This gives keyboard/`Ctrl+C` users an immediate
copy affordance without touching the Copy button.

**Dismissal + focus model — mirror `templates.js`, NOT `help.js`.** Reuse the established
overlay pattern rather than invent a new one, but specifically copy **`templates.js._onKey`**:
- A capture-phase `window` `keydown` listener closes on `Escape`, calling
  `e.stopPropagation()` + `e.preventDefault()` so the Esc never reaches the bubble-phase
  wallTool/measure listeners (the same Edge Case 15 / GAP-3 concern those modules solve).
- **Do NOT copy `help.js._onKey`'s early-return when `document.activeElement` is an
  `INPUT`/`TEXTAREA`/`SELECT`.** This dialog auto-focuses the read-only URL `input`, so
  that guard would swallow Esc and leave the dialog stuck open — breaking AC3.
  `templates.js._onKey` has no such guard (its overlay contains no focused input), which
  is exactly the behavior we need: Esc closes regardless of focus. The read-only input
  needs no native text-editing preservation, so skipping the guard is safe.
- A document bubble-phase click listener closes on outside-click, guarded so clicks on
  the panel itself (and on `#btn-share`, which has its own listener) do not close it.
- A close (×) button inside the panel calls the same close function.
- On close, return focus to `#btn-share` (the invoking control) for keyboard continuity.

**Module placement.** The dialog is a share concern owned by `actions.js`, and it must
reuse `_copyUrl`, `_cachedHashUrl`, `_buildAndCacheUrl`, and `showToast` — all private to
`actions.js`. So the controller lives **in `actions.js`** (small: open/close + three
listeners) rather than a new module, keeping the diff surgical and avoiding new exports.
New DOM refs (`#share-dialog`, its field, Copy button, close button) are looked up in
`init()` alongside the existing refs, or lazily via `document.getElementById` at first
open. Prefer wiring in `init()` for consistency with the other action controls.

## Frontend Design

**Decision: a centered modal dialog reusing the existing overlay chrome, NOT a
button-anchored popover.** The issue says "dialog/popover anchored to the Share button";
we resolve this to a centered scrim+panel modal matching `help.js` and `templates.js`.
Rationale: (a) the codebase has two proven, accessible centered-overlay implementations
and zero anchored-popover implementations — reusing one keeps the diff surgical and the
dismissal/focus behavior consistent; (b) a wide URL field and a future QR block fit a
panel better than a small anchored bubble; (c) it stays within the danbing.app
minimal-chrome aesthetic and inherits brand tokens (`--panel`, `--hairline`, `--gold`,
`--ink`, `--muted`, `--font-*`) exactly as the other overlays do. This routine-execution
UX does not reshape the header or brand identity (per the Frontend note).

New markup in `src/index.html`, modeled on the template-overlay block (scrim + relative
panel + × close), placed near the other overlays:

```html
<div id="share-dialog" class="share-dialog" role="dialog" aria-modal="true"
     aria-label="Share this plan">
  <div class="share-dialog-panel">
    <div class="share-dialog-title">Share this plan</div>
    <button class="share-dialog-close" aria-label="Close">×</button>
    <label class="share-dialog-label" for="share-url-field">Anyone with this link can open your plan.</label>
    <div class="share-dialog-row">
      <input id="share-url-field" class="share-url-field" type="text" readonly
             aria-label="Share URL" />
      <button id="share-copy-btn" class="share-copy-btn">Copy</button>
    </div>
    <!-- Long-URL warning: hidden by default, shown in-dialog when url > URL_SOFT_LIMIT -->
    <p id="share-url-warning" class="share-url-warning" hidden>
      Very large plan — this link may not work in all chat apps. Try PNG/JSON export instead.
    </p>
  </div>
</div>
```

New CSS reuses the `template-overlay` pattern (scrim `rgba(16,15,11,0.62)`, blurred
`--panel` card, `--gold` title, `.--visible` toggles `display:flex`). The URL field is a
full-width monospace read-only input with a subtle hairline border; the Copy button uses
the existing action-button styling. The warning paragraph is small `--muted`/warning-tone
text. No new fonts, colors, or icons beyond existing tokens. Reduced-motion honored as in
the sibling overlays. `z-index` at the overlay tier (40), same as help/template overlays.

**One additional CSS change (toast stacking):** bump `.toast` from `z-index:30` to
`z-index:50` so the `"Link copied"` confirmation renders **above** the open dialog scrim
(overlay tier is 40). Without this the toast would be hidden behind the scrim. See Edge
Case 3 — this is the chosen fix (raise the toast tier), not an in-dialog button state.

**Not building the QR here** — but the panel column layout leaves natural room to add a
QR block above the URL row in #161 without restructuring.

## Interfaces / Types

All additions are private to `src/js/actions.js`. No exported API changes.

```js
// New module-level DOM refs, set in init() from els:
let _shareDialogEl   = null;  // #share-dialog (scrim + panel)
let _shareUrlField   = null;  // #share-url-field  (readonly input)
let _shareCopyBtn    = null;  // #share-copy-btn
let _shareDialogClose= null;  // .share-dialog-close
let _shareWarningEl  = null;  // #share-url-warning
let _shareDialogOpen = false; // guard for Esc/outside-click handlers

// CHANGED: the LLD-165 fallback branch. URL resolution logic is unchanged; only the
// terminal action is now gated on navigator.share presence.
//   - navigator.share ABSENT (desktop) → open the dialog.
//   - navigator.share PRESENT (mobile stale-cache fall-through) → _copyUrl, exactly
//     as LLD 165 did — do NOT open the dialog (preserves AC5).
async function _shareViaClipboard() {
  let url;
  if (_cachedHashUrl && !_cacheStale) {
    url = _cachedHashUrl;
  } else {
    try { url = await _buildAndCacheUrl(); }
    catch { showToast("Couldn't build share link"); return; }
  }
  if (navigator.share) {
    _copyUrl(url);          // mobile stale-cache path — unchanged LLD-165 behavior
  } else {
    _openShareDialog(url);  // desktop — the new dialog
  }
}

// NEW: populate + show the dialog for a resolved URL string.
function _openShareDialog(url) {
  // set field value; toggle warning visibility by url.length > URL_SOFT_LIMIT;
  // add .share-dialog--visible; focus+select field via setTimeout(...,0);
  // set _shareDialogOpen = true.
}

// NEW: hide the dialog and restore focus to #btn-share.
function _closeShareDialog() { /* remove class; _shareDialogOpen = false; _btnShare?.focus(); */ }

// NEW: Copy button handler — reuses the existing _copyUrl unchanged.
//   () => _copyUrl(_shareUrlField.value)

// NEW: capture-phase Esc — mirrors templates.js _onKey (NO active-element/input guard,
// unlike help.js, because the dialog auto-focuses the URL input).
function _onShareDialogKey(e) { /* if Escape && _shareDialogOpen: stopPropagation+preventDefault+close */ }

// NEW: document bubble-phase outside-click (mirrors templates.js _onDocumentClick).
function _onShareDialogDocClick(e) { /* if open and click outside panel and not on #btn-share: close */ }
```

Wiring in `init(els)`:
- Read the new refs from `els` (add `shareDialog`, `shareUrlField`, `shareCopyBtn`,
  `shareDialogClose`, `shareWarning` to the `els` object passed from `main.js`), or fetch
  by id.
- `_shareCopyBtn?.addEventListener("click", () => _copyUrl(_shareUrlField.value))`.
- `_shareDialogClose?.addEventListener("click", _closeShareDialog)`.
- `window.addEventListener("keydown", _onShareDialogKey, true /* capture */)`.
- `document.addEventListener("click", _onShareDialogDocClick)`.

`main.js` change: add the new element lookups (`getElementById`) and pass them into the
existing `initActions({...})` call (the block at `main.js` ~line 489). No other wiring
changes.

`_copyUrl`, `_buildAndCacheUrl`, `_cachedHashUrl`, `_cacheStale`, `URL_SOFT_LIMIT`,
`showToast`, `_nativeShare`, `_onShare` — all reused/unchanged.

## State Model

No new persistent state; nothing sent to a server (client-side-only principle holds — the
dialog only displays a URL that already encodes the whole plan in its hash).

- **Share URL** — resolved at open time from the existing in-memory `_cachedHashUrl`
  (invalidated on every render, rebuilt in the background) or a fresh
  `await _buildAndCacheUrl()`. The dialog holds it only as the input field's `value` for
  the lifetime of the dialog; it is not separately cached. The field is **read-only**, so
  it is a display of, not a source of, state.
- **Dialog open flag** — `_shareDialogOpen` (in-memory boolean) gates the Esc and
  outside-click handlers, exactly like `_open` in `help.js`/`templates.js`.
- **Snapshot semantics** — the URL shown is a snapshot from the moment Share was clicked.
  If the plan is edited while the dialog is open, the field does not live-update; closing
  and reopening reflects the new plan. This matches the copy-path behavior today (the
  copied URL is likewise a click-time snapshot) and needs no invalidation wiring.
- **Plan name / capability** — unchanged from LLD 165; `navigator.share` presence is read
  at click time in `_onShare`, so the dialog is reached only on browsers lacking it.

## Edge Cases

1. **`navigator.share` present (mobile)** → the dialog is **never** opened, in either
   sub-case:
   - cache fresh → `_onShare` takes the `_nativeShare` branch (byte-identical to LLD 165);
   - cache stale → `_onShare` falls through to `_shareViaClipboard()`, which — because
     `navigator.share` is present — calls `_copyUrl(url)` (silent copy + toast), **not**
     the dialog. This is the LLD 165 behavior preserved. Guarantees AC5 (dialog never
     hijacks a share-capable device). See Approach "Critical" note and Fix 1.
2. **`navigator.share` absent (desktop)** → `_shareViaClipboard()` opens the dialog with
   the current URL pre-selected (acceptance criterion 1).
3. **Copy button clicked** → `_copyUrl(field.value)` runs the existing clipboard logic and
   fires the confirming `"Link copied"` toast; the copied string is exactly the field value
   (acceptance criterion 2). Dialog stays open so the user can still see/re-copy the link
   (matches the "inspect and copy" intent). **Toast stacking (decided):** `.toast` is
   currently `z-index:30` and the overlay tier is `z-index:40`, so the toast would render
   *behind* the scrim while the dialog is open. **Fix: raise `.toast` to `z-index:50`** (a
   single CSS value change) so it sits above any overlay/dialog. This keeps `_copyUrl`
   reused unchanged and needs no in-dialog button-state logic. The toast is a
   fixed-position, non-interactive (`pointer-events:none` at rest) element, so lifting it
   above the scrim has no side effects on the other overlays (help/template) either — a
   toast should always be the topmost feedback layer regardless.
4. **Esc while dialog open** → capture-phase handler closes it, `stopPropagation` +
   `preventDefault` so wallTool/measure Esc listeners never fire (acceptance criterion 3).
5. **Outside-click (on the scrim)** → closes; **click inside the panel** (field, buttons,
   title) does not close; **click on `#btn-share`** does not close (its own handler runs).
   Guard mirrors `templates.js._onDocumentClick` (acceptance criterion 3).
6. **Close (×) button** → `_closeShareDialog()`; focus returns to `#btn-share` (acceptance
   criterion 3, focus behavior).
7. **Long URL (`> URL_SOFT_LIMIT`, 8000)** → `#share-url-warning` is un-hidden inside the
   dialog (persistent visible text, not a transient toast), and if the user then clicks
   Copy, `_copyUrl` additionally fires its existing long-URL toast. The in-dialog warning
   is the primary surface required by acceptance criterion 4; the field still shows the
   full URL so nothing is truncated.
8. **Build failure on stale cache** (compression error in `_buildAndCacheUrl`) → the
   `catch` shows `"Couldn't build share link"` and the dialog does **not** open (no empty
   field). Same failure toast as today.
9. **Field must not be editable** → `readonly` (not `disabled`, so it stays focusable and
   selectable and copies cleanly). Auto-select on open via `.focus()` + `.select()`.
10. **Reopen after edit** → each open re-resolves the URL and re-toggles the warning, so a
    plan that grew past the soft limit (or shrank below it) shows the correct state.
11. **Double-click Share** → `_openShareDialog` is idempotent: it just re-populates and
    re-adds the `--visible` class; no duplicate dialogs.
12. **Reduced motion** → any transition is disabled under `prefers-reduced-motion`,
    matching the sibling overlays.

## Dependencies

All already exist in the repo; nothing new must be built first.

- **LLD 165 (#159, PR #163)** — the `_onShare` dispatcher and `_shareViaClipboard()`
  fallback branch this LLD modifies. Must be merged (it is, on `main`).
- `src/js/actions.js` — `_shareViaClipboard`, `_copyUrl`, `_buildAndCacheUrl`,
  `_cachedHashUrl`/`_cacheStale`, `URL_SOFT_LIMIT`, `showToast`, `_btnShare`.
- `src/js/share.js` — `encodePlanToHash` (via `_buildAndCacheUrl`); unchanged.
- `src/index.html` — `#btn-share` (unchanged), `#toast` (`.toast` z-index bump 30→50),
  and the new `#share-dialog` markup + CSS (modeled on the existing `.template-overlay`
  block).
- `src/js/main.js` — add the new element lookups and pass them into `initActions(...)`.
- Established overlay conventions in `src/js/help.js` and `src/js/templates.js`
  (capture-phase Esc, outside-click guard, focus handling) — copied, not imported.
- No new npm dependency (acceptance criterion 6).

## Test Requirements

Tests run headless via `.github/run-tests.mjs` (Playwright + Chromium) against the built
`dist/index.html`. The desktop path is exercised by **deleting `navigator.share` before
load** with `page.addInitScript` (same technique LLD 165's suite uses to stub/remove
`navigator.share`), so `_onShare` takes the dialog branch.

**Integration (new suite in `run-tests.mjs`, driving `dist/`):**
- With `navigator.share` removed, clicking `#btn-share` makes `#share-dialog` visible and
  `#share-url-field` contains the current `origin+pathname+#hash` URL, pre-selected
  (`selectionStart === 0 && selectionEnd === value.length`). (Acceptance 1)
- The field value equals the string passed to the clipboard write: click Copy, assert the
  clipboard/`execCommand` target equals `#share-url-field.value`, and the "Link copied"
  toast shows. (Acceptance 2)
- Field is `readonly` and its value cannot be mutated by typing.
- **Round-trip:** capture the field URL, load it as `location.hash` in a fresh page,
  assert the decoded plan matches the seeded plan (guards the field shows a real,
  openable link).
- **Dismissal:** Esc closes the dialog and does not trigger a wall/measure Esc side
  effect; clicking the scrim (outside the panel) closes it; clicking inside the panel does
  not; the × button closes it. After close, focus is on `#btn-share`. (Acceptance 3)
- **Esc with the URL field focused:** open the dialog (which auto-focuses
  `#share-url-field`), press Esc, assert the dialog closes. Guards against regressing to
  the `help.js` active-element guard that would swallow Esc while an input is focused.
  (Acceptance 3 / Fix 2)
- **Mobile stale-cache regression:** stub `navigator.share` **present** but force the
  cache stale (e.g. dispatch an edit/render immediately before clicking, so
  `_cacheStale` is true) → clicking Share does **NOT** open `#share-dialog`; it silently
  copies and shows the toast, exactly as LLD 165. (Acceptance 5 / Fix 1)
- **Long URL:** seed a plan whose hash exceeds `URL_SOFT_LIMIT`; open the dialog and
  assert `#share-url-warning` is visible (not `hidden`) and the field still holds the full
  URL. (Acceptance 4)
- **Toast above dialog:** after clicking Copy with the dialog open, assert the `#toast`
  computed `z-index` (50) exceeds the dialog's (40) so the confirmation is visible over the
  scrim. (Fix 3)
- **Native path still fires:** with `navigator.share` stubbed **present** and cache fresh,
  clicking Share calls `navigator.share` and does **not** open `#share-dialog`.
  (Acceptance 5)

**Unit (`test/tests.html` harness):**
- Warning-visibility logic: a URL longer than `URL_SOFT_LIMIT` un-hides the warning; a
  short URL keeps it hidden. (Only if the helper is exercised without excessive new
  exports — prefer integration coverage over adding exports that bloat the surgical diff.)

**Regression:**
- Mobile/native path (`navigator.share` present) unchanged from LLD 165.
- Existing help-overlay and template-overlay Esc/outside-click behavior unaffected by the
  new capture-phase listener (no cross-talk between overlays).
- No new npm dependency in `package.json` (CI). (Acceptance 6)

**Manual / QA:**
- On a real desktop browser: Share opens the dialog, URL is selected, `Ctrl/Cmd+C` copies
  it; Copy button copies + toasts; Esc / scrim / × all dismiss and return focus to Share.
