# LLD 167: Share dialog — scannable QR code of the share URL (desktop→phone handoff)

## Scope

Part of #3 (Phase 2: polish & delight); order 3 of 3, the integration/polish increment.
Builds **directly** on the desktop share dialog LLD 166 (#160, shipped as PR #164, merged
to `main`). This is the only sub-issue that adds a runtime dependency.

**In scope**
- Add one version-**pinned**, lightweight QR-generation npm dependency, bundled via Vite,
  running fully client-side (no network).
- Render a scannable QR code of the **current plan's share URL** inside the existing
  `#share-dialog` panel (from LLD 166), sized to scan comfortably on a typical monitor.
- Use the **same resolved URL string** the dialog already puts in `#share-url-field`
  (`_openShareDialog(url)`'s `url` argument) — do NOT rebuild the URL independently.
- Regenerate the QR on every open, so an edited plan (new URL) shows a fresh, matching QR
  (the dialog already re-resolves the URL per open; the QR piggybacks on that).
- Gracefully handle URLs too long to encode reliably: when `url.length > URL_SOFT_LIMIT`
  (the existing 8000-char soft limit that already un-hides `#share-url-warning`), **hide
  the QR** and keep the copyable-URL field + the existing long-URL warning. Never render an
  unscannable dense code.
- Client-side only; QR generated in-browser, nothing sent to a server.

**Out of scope**
- Embedding the plan PNG/SVG in the QR, or exporting/downloading the QR image itself.
- Any change to the URL codec (`src/js/share.js` `encodePlanToHash`/`decodePlanFromHash`).
- Any change to the LLD-165 native `navigator.share` path, or to the LLD-166 dialog's
  open/close/dismiss/focus/copy behavior (all reused unchanged).
- Any header or brand-identity reshaping.

## Approach

**Single integration point: `_openShareDialog(url)`.** LLD 166 already resolves the share
URL (fresh cache or `await _buildAndCacheUrl()`), then calls `_openShareDialog(url)` on the
desktop (no-`navigator.share`) path, which sets `_shareUrlField.value = url` and toggles
`#share-url-warning` by `url.length <= URL_SOFT_LIMIT`. The QR hangs on exactly this
function — it is the one place that already has the final, correct URL string and already
knows the long-URL verdict. We add QR rendering right after the field/warning are set:

```
_openShareDialog(url):                     [LLD 166, extended here]
  _shareUrlField.value = url
  tooLong = url.length > URL_SOFT_LIMIT
  _shareWarningEl.hidden = !tooLong        [unchanged]
  _renderShareQr(url, tooLong)             [NEW — this LLD]
  add .share-dialog--visible; _shareDialogOpen = true
  focus+select field  (setTimeout 0)       [unchanged]
```

This automatically satisfies:
- **Same URL as the field** — `_renderShareQr` receives the identical `url` argument; no
  independent URL construction.
- **Regenerate-on-change** — the dialog re-resolves the URL and re-calls `_openShareDialog`
  on every Share click; each open re-renders the QR from scratch. The snapshot semantics
  match LLD 166 exactly (edit → reopen → new URL → new QR). No live-update wiring, no cache.
- **Too-long fallback** — the QR is rendered only when `!tooLong`. When `tooLong`, the QR
  container is cleared/hidden and only the field + warning remain, reusing the existing
  `URL_SOFT_LIMIT` verdict rather than computing a second, separate capacity check.

**Why gate the QR on `URL_SOFT_LIMIT` (8000) rather than the QR spec's own max
(~2953 bytes for the lowest error-correction level).** Two reasons: (a) the dialog already
surfaces a long-URL warning at 8000 and reuses that single verdict — a second threshold
would mean the QR silently vanishes while the field shows no warning, which is confusing;
(b) practically, most real plans encode well under the QR ceiling, and any URL between the
QR max and 8000 would produce a version-40 code so dense it is unscannable on a monitor
anyway — hiding it (per the issue's "do not render an unscannable dense code") is correct.
The chosen library is asked to auto-select QR version/EC; if it *throws* on an
over-capacity input below the soft limit (edge belt-and-suspenders), `_renderShareQr`
catches it and hides the QR, leaving the field + a shown warning (see Edge Case 4). The
soft-limit gate is the primary control; the try/catch is the safety net.

**QR is generated to a `<canvas>` client-side.** No network. See the Dependency choice
section for library and output-format rationale (canvas vs SVG).

**Theme-aware colors.** The editor has a light/dark theme (`html[data-theme="light"]`
flips `--ink`/`--panel` etc.). A QR must be dark-on-light to scan reliably. We therefore
render the QR with **fixed** `#000000` modules on a `#ffffff` quiet-zone background
**regardless of theme** (not the blueprint `--ink`/`--panel` tokens), and frame it with a
small white padding card so it scans on both themes. This is a deliberate deviation from
"inherit brand tokens": scannability beats aesthetic tokens for the code matrix itself; the
surrounding panel chrome stays on-brand. (A dark-module-on-transparent QR over the dark
blueprint panel would be unscannable.)

**Module placement.** Like LLD 166, the QR is a share concern that needs `URL_SOFT_LIMIT`
and the dialog refs, all private to `actions.js`. The render helper `_renderShareQr` lives
**in `actions.js`** (a few lines: clear container, guard on `tooLong`, call the library,
append canvas). The QR library is imported at the top of `actions.js`. No new module, no
new exports — surgical, matching the LLD-166 decision.

## Dependency choice

**Chosen: `qrcode-generator` @ `1.4.4`** (pinned exact, no caret).

```
npm install qrcode-generator@1.4.4
```

This adds a `dependencies` entry `"qrcode-generator": "1.4.4"` (exact, matching the pinned
`"three": "0.185.1"` style already in `package.json`).

**Candidates evaluated:**

| Library | Min bundle (approx, minified) | Output | Deps | Fit |
| --- | --- | --- | --- | --- |
| `qrcode-generator` | **~4–5 KB** | you draw (canvas/SVG/`createDataURL`) | **0** | **chosen** |
| `qrcode` (soldair) | ~50 KB+ (pulls `pngjs`, `dijkstra`, node polyfills) | canvas/SVG/terminal | several | heavier; Node-oriented API, larger bundle |
| `qr-creator` | ~7 KB | canvas only | 0 | fine, canvas-only, less common/less maintained |

**Rationale (per the issue's criteria):**
- **Smallest that does pure client-side QR generation.** `qrcode-generator` is the classic
  Kazuhiko Arase implementation — zero dependencies, tiny, no Node/browser polyfills, so it
  tree-shakes and bundles cleanly through Vite with negligible weight added to `dist/`.
- **Pure client-side, no network.** It computes the QR matrix (Reed–Solomon EC included) in
  JS and hands back the module bitmap; nothing is fetched. Satisfies AC "generated entirely
  client-side; no network request."
- **API simplicity.** `qrcode-generator` exposes a small, stable factory:
  `const qr = qrcode(typeNumber, errorCorrectionLevel); qr.addData(url); qr.make();` then a
  render call. Using `typeNumber = 0` lets the library **auto-select** the smallest QR
  version that fits the data at the chosen EC level — exactly the "regenerate for whatever
  the current URL is" behavior we need, and it **throws** if the data exceeds capacity
  (our safety-net catch).
- **Canvas vs SVG.** The issue suggests preferring the format that matches the blueprint/SVG
  aesthetic. We choose **canvas** anyway, deliberately: (a) a QR must be a crisp
  black/white bitmap to scan; the panel is a fixed on-screen size, so a raster canvas at
  device-pixel-ratio scale is simplest and pixel-accurate; (b) we are **not** exporting the
  QR (out of scope), so SVG's vector-export advantage is moot; (c) canvas keeps the DOM
  light (one element vs hundreds of `<rect>`s). `qrcode-generator` can emit an SVG string or
  `createDataURL`/`createImgTag` too, so this stays reversible if a future issue wants QR in
  the SVG export. Implementer draws the module matrix onto a `<canvas>` (see Interfaces).
- **Maintenance / stability.** `qrcode-generator` is a long-standing, widely-depended-on,
  stable package (used transitively by many QR wrappers). `1.4.4` is a mature release. We
  pin the exact version (no `^`) per the CLAUDE.md "dependencies are version-locked" rule.

**Bundle-green confirmation.** The dep is ESM-importable (`import qrcode from
"qrcode-generator"`) and has no native/Node deps, so `npm run build` (Vite) stays green and
`dist/` grows by only a few KB. The implementer MUST run the exact install above (which
records the pinned version in `package.json` + `package-lock.json`) and confirm
`npm run build` succeeds before the tests.

> Note: `npm view`/`npm install` are blocked in this design sandbox, so `1.4.4` is stated
> from known-stable release history. The implementer MUST verify `1.4.4` resolves at install
> time; if it has been superseded, pin the current latest 1.4.x exact version and note it in
> the PR. The design does not depend on the specific patch, only on pinning an exact version.

## Frontend Design

**Placement in the panel.** LLD 166 explicitly left "natural room to add a QR block above
the URL row without restructuring." We add the QR container as the **first content element
inside `.share-dialog-panel`, between the title and the label** (i.e. above the URL row), so
the scan target is the visual focus and the copy field sits beneath it as the fallback path.

New markup (`src/index.html`, inside the existing `#share-dialog` panel):

```html
<div class="share-dialog-panel">
  <div class="share-dialog-title">Share this plan</div>
  <button class="share-dialog-close" aria-label="Close">×</button>
  <!-- NEW: QR block (LLD 167). Container is emptied+repopulated per open; hidden when URL too long. -->
  <div id="share-qr" class="share-qr" aria-hidden="true">
    <!-- <canvas> injected here by _renderShareQr; a small caption sits under it -->
  </div>
  <div class="share-qr-caption">Scan with your phone to open this plan</div>
  <label class="share-dialog-label" for="share-url-field">Anyone with this link can open your plan.</label>
  <div class="share-dialog-row"> … field + Copy … </div>
  <p id="share-url-warning" class="share-url-warning" hidden> … </p>
</div>
```

**Styling (reuse existing tokens for chrome; fixed B/W for the code):**
- `.share-qr` — centered, `margin: 0 auto 0.9rem`, a **white** rounded card
  (`background:#fff; padding:0.6rem; border-radius:8px`) providing the mandatory quiet zone
  so the dark modules scan on both themes. `width`/`height` sized to the canvas (see below).
  When hidden (too-long URL or render failure), toggled with the `hidden` attribute (and its
  caption hidden with it), so the panel collapses to the copy-URL + warning layout.
- Injected `<canvas>` — rendered at **~180 CSS px** square (comfortable monitor scan
  distance), drawn at `devicePixelRatio` scale for crispness (`canvas.width =
  cssPx * dpr`, `canvas.style.width = cssPx+"px"`, context scaled). Modules `#000`, quiet
  zone `#fff`. `image-rendering: pixelated` to keep edges sharp if the browser upscales.
- `.share-qr-caption` — small `--muted` `--font-mono` text (matches `.share-dialog-label`
  tone), centered, `margin-bottom:0.75rem`. Hidden together with the QR when too long.
- No new fonts/colors/icons beyond the QR's required black/white. Reduced-motion irrelevant
  (no animation on the QR). `z-index` unaffected — the QR lives inside the existing panel.

This keeps the danbing.app minimal-chrome / blueprint aesthetic for the panel while giving
the QR the neutral high-contrast field it needs to scan.

## Interfaces / Types

All additions are private to `src/js/actions.js`. No exported API changes.

```js
// Top of actions.js:
import qrcode from "qrcode-generator";

// New module-level DOM refs, set in init() from els (added to main.js lookups):
let _shareQrEl = null;   // #share-qr container (the white card that holds the canvas)

// EXTENDED (LLD 166 → 167): render the QR right after field/warning are set.
function _openShareDialog(url) {
  if (!_shareDialogEl || !_shareUrlField) { _copyUrl(url); return; }
  _shareUrlField.value = url;
  const tooLong = url.length > URL_SOFT_LIMIT;
  if (_shareWarningEl) _shareWarningEl.hidden = !tooLong;
  _renderShareQr(url, tooLong);                 // NEW
  _shareDialogEl.classList.add("share-dialog--visible");
  _shareDialogOpen = true;
  setTimeout(() => { _shareUrlField.focus(); _shareUrlField.select(); }, 0);
}

// NEW: draw (or hide) the QR for a resolved URL.
//   - tooLong  → clear + hide the container (keep field + warning only).
//   - else     → build QR (typeNumber 0 = auto-fit, EC level "M"), draw to a
//                fresh <canvas> at dpr scale, replace container contents, unhide.
//   - library throw (over-capacity edge) → treat as tooLong: clear + hide, and
//     un-hide the long-URL warning as a safety net.
function _renderShareQr(url, tooLong) {
  if (!_shareQrEl) return;                       // defensive: no QR markup
  _shareQrEl.replaceChildren();                  // clear previous canvas
  if (tooLong) { _shareQrEl.hidden = true; /* caption hidden via sibling */ return; }
  try {
    const qr = qrcode(0, "M");                   // 0 = auto version, "M" = ~15% EC
    qr.addData(url);
    qr.make();
    const canvas = /* build <canvas>, draw qr.getModuleCount()×getModule(r,c) */;
    _shareQrEl.appendChild(canvas);
    _shareQrEl.hidden = false;
  } catch {
    // Over QR capacity (below the 8000 soft limit) — hide QR, show warning.
    _shareQrEl.hidden = true;
    if (_shareWarningEl) _shareWarningEl.hidden = false;
  }
}
```

Notes:
- **Drawing loop** (implementer detail): `count = qr.getModuleCount()`;
  `cell = floor(cssPx / count)`; for each `qr.getModule(row, col)` truthy, fill a
  `cell × cell` black rect on a white-cleared canvas, offset by the quiet-zone padding
  handled by the container card. Set `canvas.width/height = cssPx * dpr` and scale the 2D
  context by `dpr` (or multiply cell math by `dpr`) for crisp modules.
- **EC level "M"** (~15%) is the standard default — good scan robustness without bloating
  the version. "L" would raise capacity slightly but reduce error tolerance; "M" is the
  right balance for a screen-displayed code. Not configurable (no speculative options).
- The `#share-qr-caption` is a static sibling; hide it in lock-step with the QR. Simplest:
  give the caption `id="share-qr-caption"`, add a ref, and set `.hidden` together — OR wrap
  QR+caption in one container toggled once. Implementer picks the simpler of the two; the
  design requires only that caption never shows without a QR.

Wiring:
- `main.js`: add `const shareQrEl = document.getElementById("share-qr");` (near the other
  `share-*` lookups at ~line 167) and pass `shareQr: shareQrEl` into the existing
  `initActions({...})` call (~line 503, alongside `shareDialog`, `shareWarning`, etc.).
- `actions.js` `init(els)`: `_shareQrEl = els.shareQr;` (beside the other LLD-166 refs).
- Reused unchanged: `_openShareDialog` caller chain (`_onShare` → `_shareViaClipboard`),
  `URL_SOFT_LIMIT`, `_shareWarningEl`, `_copyUrl`, `_closeShareDialog`, all dismissal/focus
  handlers. No change to `share.js` or the codec.

## State Model

No new persistent state; nothing sent to a server (client-side-only principle holds — the
QR merely encodes the same hash URL the field already shows, which itself encodes the whole
plan).

- **QR source** — the `url` string passed into `_openShareDialog` (identical to
  `#share-url-field.value`). Not separately cached; recomputed from the library on each open.
- **QR DOM** — a single `<canvas>` inside `#share-qr`, replaced (`replaceChildren`) on every
  open so no stale canvas accumulates. Lives only for the dialog's visible lifetime; not
  removed on close (hidden by the panel's `display:none`), and overwritten on next open.
- **Snapshot semantics** — same as LLD 166: the QR is a click-time snapshot. Editing the
  plan while the dialog is open does not live-update the QR; closing and reopening re-renders
  it from the newly-resolved URL. This satisfies the "editing then reopening shows an updated
  QR" acceptance criterion by reusing the dialog's existing re-resolve-per-open model.
- **Capability** — `navigator.share` presence is still read at click time in `_onShare`; the
  dialog (and thus the QR) is reached only on browsers lacking native share (desktop), per
  LLD 166. The QR does not change that gating.

## Edge Cases

1. **Normal plan (URL ≤ soft limit)** → QR renders from the field URL; scanning it opens the
   identical plan (acceptance criterion 1). QR appears above the copy field.
2. **Plan edited, dialog reopened** → the dialog re-resolves the URL and re-calls
   `_openShareDialog`, so `_renderShareQr` redraws from the new URL; the QR matches the new
   field value (acceptance criterion 2). No stale QR (previous canvas replaced).
3. **URL exceeds `URL_SOFT_LIMIT` (8000)** → `tooLong` is true; `_renderShareQr` clears and
   **hides** `#share-qr` (+ caption); the copyable field still shows the full URL and
   `#share-url-warning` is shown, exactly reusing the LLD-166 warning path (acceptance
   criterion 3). No dense/unscannable code is drawn.
4. **URL under 8000 but over the QR spec's capacity** (rare; the library throws) →
   `_renderShareQr`'s `catch` hides the QR and un-hides the warning, degrading to the same
   field-only + warning state as case 3. Belt-and-suspenders; the soft-limit gate is primary.
5. **No QR markup present** (defensive, e.g. old cached HTML) → `_renderShareQr` returns
   early on `!_shareQrEl`; the dialog still functions as the LLD-166 copy-URL dialog. And if
   the whole dialog is missing, `_openShareDialog` already falls back to `_copyUrl` (LLD 166).
6. **Light vs dark theme** → QR always drawn `#000` on `#fff` with a white card quiet zone,
   independent of `data-theme`, so it scans on both (see Approach). Not tied to `--ink`.
7. **HiDPI / Retina** → canvas drawn at `devicePixelRatio` scale so modules are crisp, not
   blurred, on high-density monitors.
8. **Double-click Share / reopen** → `_openShareDialog` is idempotent (LLD 166);
   `_renderShareQr` clears the container first, so no duplicate canvases stack up.
9. **Dialog dismissal (Esc / outside-click / ×)** → unchanged from LLD 166; the QR is inside
   the panel and hidden with it. No QR-specific teardown needed.
10. **Native share device (mobile)** → dialog never opens (LLD 166 gating), so the QR code
    path never runs there; no regression to the OS share sheet or the mobile stale-cache
    copy path (LLD 165/166 preserved).
11. **QR library import fails / bundle issue** → caught at build time (Vite build must be
    green before merge); at runtime the import is static, so a resolved bundle always has it.

## Dependencies

- **LLD 166 (#160, PR #164)** — the `#share-dialog` markup, `_openShareDialog(url)`, the
  `#share-url-warning` + `URL_SOFT_LIMIT` verdict, and the `main.js` element wiring this LLD
  extends. Merged on `main` (verified: commit `cd6ba98`).
- **New:** `qrcode-generator@1.4.4` (exact pin) in `package.json` `dependencies`, installed
  via `npm install qrcode-generator@1.4.4`, bundled by Vite. The only piece adding a dep.
- `src/js/actions.js` — extends `_openShareDialog`; adds `_renderShareQr` + `_shareQrEl`;
  adds the `import qrcode from "qrcode-generator"`.
- `src/index.html` — new `#share-qr` container + `.share-qr-caption` inside the existing
  `.share-dialog-panel`, and their CSS. `#share-dialog`, field, warning, Copy — unchanged.
- `src/js/main.js` — add `share-qr` `getElementById` and pass `shareQr` into `initActions`.
- `src/js/share.js` — **unchanged** (codec untouched, per scope).
- No backend, no network — client-side only (principle + acceptance criterion 4).

## Test Requirements

Tests run headless via `.github/run-tests.mjs` (Playwright + Chromium) against the built
`dist/index.html`. The desktop dialog path is reached by **removing `navigator.share` before
load** with `page.addInitScript` (same technique LLD 165/166 suites use), so `_onShare`
takes the dialog branch and `_openShareDialog` runs.

**Integration (extend the LLD-166 share-dialog suite in `run-tests.mjs`):**
- With `navigator.share` removed, clicking `#btn-share` opens `#share-dialog` and
  `#share-qr` contains a `<canvas>` (QR rendered) and is not `hidden`. (Acceptance 1)
- **URL round-trip:** the QR encodes the same string as `#share-url-field.value`. Decode the
  canvas is heavy in-browser; instead assert the QR was built from the field value by
  spying/confirming `_renderShareQr` received `#share-url-field.value` — OR, preferred
  black-box check: read back the field URL, load it as `location.hash` in a fresh page, and
  assert the decoded plan matches the seeded plan (this already guards the field→plan
  round-trip; the QR is built from that same string by construction). (Acceptance 1)
- **Regenerate on edit:** open the dialog, capture the field URL; close; make an edit that
  changes the plan (so the URL changes); reopen; assert the field URL changed AND a fresh
  `<canvas>` is present (only one canvas child — previous replaced). (Acceptance 2)
- **Too-long URL hides QR:** seed a plan whose hash URL exceeds `URL_SOFT_LIMIT`; open the
  dialog; assert `#share-qr` is `hidden` (no canvas / caption hidden), `#share-url-warning`
  is visible, and `#share-url-field` still holds the full URL. (Acceptance 3)
- **No network:** assert no network request is made when the dialog opens / QR renders (e.g.
  Playwright request interception counts zero requests attributable to QR generation).
  (Acceptance 4)
- **Single canvas on repeat opens:** open, close, open again → exactly one `<canvas>` in
  `#share-qr` (idempotent render, no accumulation).

**Build / dependency (CI):**
- `package.json` pins `qrcode-generator` to an exact version (no `^`/`~`). (Acceptance 5)
- `npm run build` (Vite) is green with the dependency bundled. (Acceptance 5)

**Regression:**
- LLD-166 dialog behavior unchanged: field pre-selected, Copy copies field value + toast,
  Esc / outside-click / × dismiss and return focus to `#btn-share`, toast renders above the
  scrim.
- LLD-165 native path (`navigator.share` present, cache fresh) and mobile stale-cache copy
  path (present + stale) both unchanged — the QR path never runs there.

**Manual / QA:**
- On a real desktop browser (both light and dark theme): Share opens the dialog, the QR is
  crisp and scans with a phone camera, opening the identical plan; editing then reopening
  shows a QR that scans to the new plan; a very large plan hides the QR and shows the
  warning while the copyable URL remains.
