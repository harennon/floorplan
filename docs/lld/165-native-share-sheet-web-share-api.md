# LLD 165: Native OS share sheet on the Share button (Web Share API) with clipboard fallback

## Scope

Part of #3 (Phase 2: polish & delight); order 1 of 3, and the foundation the later
share-dialog and QR sub-issues build on.

**In scope**
- Make the existing Share button (`#btn-share`) open the device's native share sheet
  via `navigator.share` when available, so a mobile user can tap Share and pick
  Messages / WhatsApp / etc. to text the plan link — the CX north star.
- Feature-detect `navigator.share`; call it **directly** and **synchronously** from
  the click handler (preserve the user-activation gesture — do not `await` before the
  `navigator.share` call or iOS/Safari rejects it).
- Share the current plan's share URL (the same hash URL the copy path already builds
  today) plus a short title.
- Preserve today's clipboard-copy + "Link copied" toast as the fallback when
  `navigator.share` is absent or throws a non-cancel error.
- Preserve the existing long-URL soft-limit warning on both paths.
- User-cancel of the sheet (`AbortError`) must be swallowed silently — no error toast.
- Update the button's `aria-label` from "Copy share link" to "Share plan" (Option 1 —
  see Frontend Design).

**Out of scope**
- Sharing the PNG/SVG as a file via Web Share (`navigator.canShare`/`files`) — link only.
- Any new dialog/popover/QR UI (that is the next sub-issue).
- Any visible label or icon change on the button (Option 2 rejected — see Frontend Design).
- Any change to `share.js` encode/decode or the URL round-trip.
- New npm dependency.

## Approach

All work is in `src/js/actions.js` (behavior) plus a one-attribute change in
`src/index.html`. No change to `src/js/share.js` — the URL is still built by the
existing `encodePlanToHash` path via the cached-URL machinery already in `actions.js`.

**The user-activation constraint drives the shape.** `navigator.share()` must be
invoked inside the synchronous portion of the click handler's task, before any `await`,
or Safari/iOS reject it with `NotAllowedError`. `actions.js` already solves the identical
problem for the clipboard path by keeping a pre-computed `_cachedHashUrl` that is
invalidated on every render (`_onRenderInvalidateCache`) and rebuilt asynchronously in
the background (`_rebuildCacheAsync`). We reuse that cache verbatim: when it is fresh,
we have the URL synchronously and can call `navigator.share` directly.

**Handler restructure (surgical).** Today `_onShare` is `async` and does both the fresh
and stale cases. Split it into a synchronous dispatcher plus the existing async
copy logic:

1. `_onShare()` becomes **synchronous** (not `async`). It decides the path:
   - If `navigator.share` exists **and** `_cachedHashUrl && !_cacheStale` → call
     `_nativeShare(_cachedHashUrl)` synchronously and return. Activation is preserved.
   - Otherwise → call the existing clipboard logic (moved into `_shareViaClipboard()`,
     which is the current `_onShare` body unchanged — fresh-cache fast path plus the
     `await _buildAndCacheUrl()` stale path).
2. `_nativeShare(url)`:
   - Fire the long-URL soft-limit toast if `url.length > URL_SOFT_LIMIT` (neutral
     wording — see Edge Cases; must not say "Link copied").
   - Call `navigator.share({ title: _shareTitle(), url })`.
   - `.catch(err)`: if `err?.name === "AbortError"` → return silently (user cancelled).
     Any other error → fall back to `_copyUrl(url)` (clipboard + toast, unchanged).
     The `.catch` runs after activation is already consumed, so it is safe to be async.

**Why native share is gated on a fresh cache.** When the cache is stale (only the brief
window after an edit, before the background rebuild finishes) we cannot produce the URL
synchronously — building it requires `await encodePlanToHash`, which would forfeit
activation. In that rare case we fall through to the clipboard path (which safely
`await`s the build). This keeps the activation contract airtight and Share never blocks.
Because the cache is pre-warmed on `init()` and rebuilt on every render, the fresh path
is the norm; a user who taps Share after a plan settles gets the native sheet.

**Title.** `_shareTitle()` returns a short string using the current plan name when set:
`getPlanName()` non-empty → `` `Floor plan: ${name}` ``, else `"My floor plan"`. Import
`getPlanName` from `./planName.js` (already the source of truth for the name;
`actions.js` already imports `setPlanName` from it).

**No text field.** We pass only `{ title, url }`, not `text`, so the URL is the sole
link the target app receives (some apps concatenate `text` + `url`, which would produce
a duplicated/garbled message).

## Frontend Design

**Decision: Option 1 — keep the "Share" label; zero markup change.** (CEO-confirmed:
routine execution UX on an existing button, no new visual surface, so no human sign-off
needed.)

The only DOM change is the button's accessible name:

```html
<!-- src/index.html #btn-share -->
- <button id="btn-share" aria-label="Copy share link">
+ <button id="btn-share" aria-label="Share plan">
```

The visible label stays "Share" and the SVG glyph is untouched. "Share" reads correctly
on **both** paths — the native share sheet ("share") and the clipboard fallback
("share by copying the link"). The `aria-label` moves off "Copy share link" because that
wording now under-describes the native path and implies copy-only.

**Option 2 (adaptive label/icon that swaps based on `navigator.share` support) was
rejected.** It adds DOM-mutation surface and load-time flicker risk (the button would
render one way then change once capability is detected) for no user benefit in this
small Phase 2 increment. The button is a capability branch behind one existing control,
not a redesign. This frontend question is resolved — do not re-open it.

No CSS change. No new element, no new toast string for the success case on the native
path (the OS sheet is its own feedback; we deliberately show no "shared" toast).

## Interfaces / Types

All private to `src/js/actions.js`. No exported API changes.

```js
// Synchronous click handler (was async). Chooses native vs clipboard while the
// user-activation gesture is still live. Registered exactly as today:
//   _btnShare?.addEventListener("click", _onShare);
function _onShare() { /* sync dispatch */ }

// Native path. Called ONLY with a synchronously-available URL (fresh cache),
// so navigator.share fires inside the activation task.
// @param {string} url
function _nativeShare(url) { /* soft-limit toast; navigator.share(...).catch(...) */ }

// The current _onShare body, renamed. Unchanged behavior: fresh-cache fast copy,
// else await _buildAndCacheUrl() then copy; "Couldn't build share link" on failure.
async function _shareViaClipboard() { /* existing logic */ }

// Short human title for the share sheet.
// @returns {string}
function _shareTitle() {
  const name = getPlanName();            // from ./planName.js
  return name ? `Floor plan: ${name}` : "My floor plan";
}
```

New import at top of `actions.js`:

```js
import { getPlanName } from "./planName.js";
```

`navigator.share` payload: `{ title: string, url: string }` — no `text` key.

Unchanged and reused as-is: `_copyUrl`, `_fallbackCopy`, `_buildAndCacheUrl`,
`_onRenderInvalidateCache`, `_rebuildCacheAsync`, `_cachedHashUrl`, `_cacheStale`,
`URL_SOFT_LIMIT`, `showToast`.

## State Model

No new persistent or module state. This feature reads state that already exists:

- **Share URL** — held in `_cachedHashUrl` (in-memory), invalidated on every render and
  rebuilt in the background. Both paths consume it identically. Nothing new is persisted.
- **Plan name** — read live from `planName.js` via `getPlanName()` at share time. Not
  cached; always reflects the current header input.
- **Capability** — `navigator.share` presence is read at click time (not cached), so a
  browser that gains/loses the API mid-session is always evaluated freshly. Cheap; no
  need to memoize.

Nothing is sent to a server — the native OS sheet is a client-side handoff of a URL that
already encodes the whole plan in its hash (client-side-only principle holds).

Control flow at click:

```
click → _onShare()
  ├─ navigator.share present AND cache fresh?
  │     ├─ yes → _nativeShare(freshUrl)          [sync; activation preserved]
  │     │          ├─ url too long → soft-limit toast
  │     │          ├─ navigator.share({title,url})
  │     │          │     ├─ resolve → (OS sheet handled it; no toast)
  │     │          │     └─ reject
  │     │          │           ├─ AbortError → silent
  │     │          │           └─ other      → _copyUrl(url)  [clipboard fallback]
  │     └─ no  → _shareViaClipboard()             [today's behavior, unchanged]
```

## Edge Cases

1. **`navigator.share` absent (most desktop browsers)** → `_onShare` takes the
   `_shareViaClipboard()` branch. Behavior byte-identical to today: copy + "Link copied"
   toast, including long-URL warning. Acceptance criterion 2.
2. **User cancels the native sheet** → `navigator.share` rejects with a `DOMException`
   whose `name === "AbortError"`. Swallow silently; no toast, no clipboard fallback.
   Acceptance criterion 3.
3. **`navigator.share` throws a non-cancel error** (e.g. `NotAllowedError` when
   activation was lost, or an internal share failure) → fall back to `_copyUrl(url)` so
   the user still gets the link on the clipboard with the normal toast.
4. **Long URL (`> URL_SOFT_LIMIT`, 8000)** — native path fires a neutral soft-limit
   toast that does NOT claim "Link copied" (e.g. *"Note: very large plans may not work
   in all chat apps. Try PNG/JSON export instead."*). The clipboard path keeps its
   existing "Link copied — note: …" wording. Acceptance criterion 4 holds on both paths.
5. **Cache stale at click time** (brief window right after an edit, before the async
   rebuild lands) → even with `navigator.share` present, `_onShare` falls through to
   `_shareViaClipboard()` because we cannot produce the URL synchronously without an
   `await` that would forfeit activation. Acceptable: rare, and the user still gets a
   working link (copied). We deliberately do NOT attempt an awaited native share.
6. **`navigator.share` present but `_cachedHashUrl` null due to a compression failure**
   (`_rebuildCacheAsync` caught an error) → same as case 5: `_cacheStale` stays true, so
   we take the clipboard branch, which awaits a fresh build and shows
   "Couldn't build share link" only if that also fails.
7. **Plan name empty** → title is `"My floor plan"`; non-empty → `"Floor plan: <name>"`.
   Name is already trimmed/capped at 60 chars by `planName.js`.
8. **Rapid double-tap on Share** — first tap opens the OS sheet (which typically
   suppresses further page interaction); a second `navigator.share` while one is pending
   rejects with `InvalidStateError` (non-Abort) → case 3 fallback copies the link.
   Harmless.
9. **URL round-trip unaffected** — the shared URL is the exact string
   `location.origin + location.pathname + "#" + hash` from `_buildAndCacheUrl`, so
   `readBootHash`/`decodeHashToPlan` reconstruct the same plan. No encode/decode change.
   Acceptance criterion 5.

## Dependencies

All already exist in the repo; nothing new must be built first.

- `src/js/actions.js` — `_onShare`, `_copyUrl`, `_buildAndCacheUrl`, the
  `_cachedHashUrl`/`_cacheStale` cache, `URL_SOFT_LIMIT`, `showToast`.
- `src/js/share.js` — `encodePlanToHash` (via `_buildAndCacheUrl`); unchanged.
- `src/js/planName.js` — `getPlanName()` for the share title.
- `src/index.html` — `#btn-share` (aria-label edit only).
- Browser `navigator.share` (Web Share API) — feature-detected, no polyfill.
- No new npm dependency. Acceptance criterion 6.

## Test Requirements

Tests run headless via `.github/run-tests.mjs` (Playwright + Chromium) against the built
`dist/index.html`. `navigator.share` is not present/usable in headless CI Chromium, so
the native path is exercised by **stubbing `navigator.share` before load** with
`page.addInitScript` (mirroring the existing `forceNoWebgl` getContext-patch pattern),
recording the args it was called with, and controlling whether the stub resolves,
rejects with `AbortError`, or rejects with a generic error. The clipboard fallback is
already stubbable (headless Chromium grants clipboard or falls back to `execCommand`).

**Integration (new suite in `run-tests.mjs`, driving `dist/`):**
- Native share present + fresh cache: tapping `#btn-share` calls `navigator.share`
  exactly once with `{ title, url }`, where `url` equals the current
  `origin+pathname+#hash` and starts with the location origin. (Acceptance 1)
- The `url` passed to the stub round-trips: seed a known plan, capture the shared `url`,
  load it as `location.hash` in a fresh page, assert the decoded plan matches. (Acceptance 5)
- Stub rejects with `AbortError` → no toast becomes visible (`#toast` never gets
  `toast--visible`) and clipboard is NOT written. (Acceptance 3)
- Stub rejects with a generic `Error` → clipboard fallback runs and the "Link copied"
  toast shows. (Edge case 3)
- `navigator.share` deleted/undefined → clicking Share shows "Link copied" and does the
  copy, identical to today. (Acceptance 2)
- Long-plan URL (seed a plan whose hash exceeds `URL_SOFT_LIMIT`): on the native path the
  soft-limit toast fires and does not say "Link copied"; on the clipboard path the
  existing warning toast fires. (Acceptance 4)
- `#btn-share` `aria-label` is "Share plan". (Frontend Design)

**Unit (`test/tests.html` harness, if `_shareTitle` is exported for test or exercised
via the module):**
- `_shareTitle()` returns "My floor plan" when plan name is empty and
  "Floor plan: <name>" when set.
- Path selection: with `navigator.share` stubbed present and cache fresh, `_onShare`
  invokes the native path; with cache stale it invokes clipboard even when share exists
  (edge cases 5/6). (May be covered at integration level if internals aren't exported —
  do not add new exports solely for testing beyond `_shareTitle` if it complicates the
  surgical diff.)

**Manual / QA:**
- On a real mobile browser (iOS Safari, Android Chrome): tap Share → OS sheet opens
  pre-filled with the plan URL; cancel → no error toast; pick an app → link is shareable.
- Verify the activation gesture is honored (no `NotAllowedError` in the console on iOS).

**Regression:**
- Existing Share/clipboard behavior on desktop unchanged (no `navigator.share`).
- No new npm dependency in `package.json` (build-smoke / CI). (Acceptance 6)
