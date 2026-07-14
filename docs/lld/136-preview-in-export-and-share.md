# LLD 136: Include the 2.5D/3D preview in PNG/SVG export and the share link

Parent: #101 · Order 3 of 4 · Effort: small
Depends on: LLD 128 (height model + iso preview), LLD 130 (true 3D WebGL preview)

## Scope

Turn the in-app preview into a shareable artifact. Two additive capabilities:

1. **PNG export of the preview** — when preview mode is active, "Export → PNG image"
   captures the live WebGL 3D view (LLD 130) instead of the flat 2D plan.
2. **A preview-on share flag** — the share URL gains an optional, back-compatible
   `&pv=1` flag so a recipient opens straight into the preview.

Approved direction is **Option A + C** from the #101 comments (do not re-open the design
question):

- **A** — PNG-of-preview via a WebGL canvas read-back.
- **C** — additive `pv=1` share-link flag.

### Explicitly NOT in scope

- **No SVG-of-preview.** A WebGL scene cannot be emitted as true vector, and the retired
  2.5D iso painter (`isoRender.render`) is coupled to the live pan/zoom view transform
  (`worldToScreenIso` in `view.js`), not to a headless export scale — reusing it would
  require a **new headless iso-projection pipeline**, which the issue's guards forbid
  ("reuse the existing SVG export path, no new pipeline"; effort = small). Therefore **SVG
  export always emits the flat 2D plan**, and when preview is active we surface a one-time
  note steering the user to PNG. See Approach §2 for the rejected alternative and rationale.
  (This is the documented divergence the implementation guidance asked for; it supersedes
  the pre-LLD-130 acceptance-criteria wording that assumed SVG could carry the iso view.)
- No change to what the preview renders (still extruded boxes, read-only, no new
  dependency/build step).
- No new export formats beyond the existing PNG/SVG.
- No persistence of preview state to the plan/localStorage — preview stays session-only;
  `pv` lives only in the transient share URL.
- No hi-resolution/upscaled export of the 3D view (PNG captures at the on-screen canvas
  backing-store resolution). Future work.

## Approach

### 1. PNG-of-preview: render-then-read from the WebGL canvas (Option A)

`render3d.js` (LLD 130) constructs its renderer as
`new THREE.WebGLRenderer({ canvas, antialias: true })` — **no `preserveDrawingBuffer`**. By
default the drawing buffer is cleared once composited, so a `toBlob`/`toDataURL` grabbed at
an arbitrary later time yields a blank frame. Fix with an **explicit render-then-read in the
same JS task**: draw one fresh frame, then immediately snapshot the canvas. Per the HTML
spec, `canvas.toBlob` snapshots the bitmap synchronously at call time (only PNG *encoding*
is async), and the drawing buffer is still valid before the browser's next paint — so this
works without the always-on memory/perf cost of `preserveDrawingBuffer`.

New surface in `render3d.js`:

- `canCapture()` — true only when a live WebGL frame exists to grab (renderer created AND
  not in the 2.5D-SVG fallback path). Lets `actions.js` route correctly.
- `capturePngBlob()` — rebuilds the plan group from the live models (cheap; keeps the
  capture in sync with any edits since entry), calls the existing `_renderOnce()`, then
  `canvas.toBlob(..., "image/png")`.

Robustness fallback (documented, implementer's discretion): if any target browser returns a
blank capture with render-then-read, flip the renderer to `preserveDrawingBuffer: true`
(constant cost, no code-flow change). Preferred default is render-then-read.

`actions.js` export routing:

- **PNG**: `previewIsActive() && render3d.canCapture()` → download the captured 3D PNG;
  otherwise the existing `exportPng()` (flat 2D plan, unchanged).
- **SVG**: always `exportSvg()` (flat plan). If `previewIsActive()`, also show a one-time
  toast: *"SVG exports the 2D plan — use PNG for the 3D view."*

### 2. SVG-of-preview: suppress (recommended) vs. iso-fallback (rejected)

| Option | Cost | Verdict |
| --- | --- | --- |
| **Suppress** — SVG stays flat-plan; toast nudges to PNG | ~0 (reuse `buildExportSvg`) | **Recommended** |
| **Iso-fallback** — emit 2.5D iso SVG when preview active | New headless axonometric projection at export scale (existing iso math is view-transform-coupled) + own bounds/depth-sort path | Rejected: new pipeline, violates guards + "small" effort |

`isoRender`'s `buildItems`/`extrudeFootprint`/`depthSort` are pure but `extrudeFootprint`
calls `view.worldToScreenIso`, which bakes in live `panX/panY/zoom`. A headless SVG would
need a parallel export-space iso projection — that is a new pipeline, not "cheap." We
suppress and note it in the UI.

### 3. Share flag `pv=1` (Option C) — strictly additive, back-compatible

Existing hash is a single blob: `<codec-byte><base64url-payload>` (`share.js`). The base64url
alphabet is `[A-Za-z0-9-_]` with `=` padding stripped, and codec bytes are `c`/`d`/`u` — so
**`&` and `=` never appear in a legacy hash**. That makes `&` a safe, collision-free
delimiter.

- **Encode**: `#<codec><payload>` gains a suffix `&pv=1` **only when preview is active** at
  share time. `encodePlanToHash(plan)` is unchanged (still emits just the plan blob).
- **Decode**: split the raw hash on the **first `&`**. The left part is the plan hash (fed
  verbatim to the existing `decodeHashToPlan`, so old links are byte-for-byte unchanged);
  the remainder is parsed as `&`-joined `key=value` flag pairs. `pv` is truthy only when its
  value is exactly `1`; unknown flags and other values are ignored.

Do **not** alter the plan hash schema; the flag is appended text only.

### 4. Boot: open directly into preview

`main.js` boot restore reads the flag and, after the plan is applied and rendered, calls
`preview.setActive(true)` when `pv` is set. That converges on the existing
`previewOnChange` choke point (LLD 130), which lazy-loads three.js, builds, and frames — or
falls back to the 2.5D SVG if WebGL is unavailable. No new preview-entry code path.

## Interfaces / Types

### `render3d.js` (additions)

```js
/** True when a live WebGL frame of the current preview can be captured
 *  (renderer exists AND not in the 2.5D-SVG fallback path). Pure/cheap. */
export function canCapture(): boolean

/** Render one fresh frame of the current plan and return it as a PNG Blob.
 *  Rebuilds the plan group from live models first. Rejects if no renderer/canvas
 *  or if toBlob yields null. */
export async function capturePngBlob(): Promise<Blob>
```

### `exportImg.js` (additions)

```js
/** Reused download helper, promoted from the existing private _triggerDownload,
 *  so callers (actions.js) can download a Blob without duplicating anchor logic. */
export function downloadBlob(blob: Blob, filename: string): void
```

### `share.js` (additions; `encodePlanToHash`/`decodeHashToPlan` unchanged)

```js
/** Split a raw hash (no leading '#') into the plan blob + parsed flags.
 *  Legacy hashes (no '&') → { planHash: <whole>, flags: {} }.
 *  Never throws. */
export function parseHashParts(rawHash: string): { planHash: string, flags: { pv?: boolean } }

/** Build the full hash string for a plan, appending '&pv=1' when preview is on.
 *  Reuses encodePlanToHash for the blob. */
export async function encodeShareHash(plan: Plan, opts: { preview: boolean }): Promise<string>

/** CHANGED return type. Now returns both the decoded plan and boot flags.
 *  { plan: null, preview: false } when no hash. Still THROWS on a present-but-
 *  undecodable plan blob (caller toasts). Strips hash after reading, as today. */
export async function readBootHash(): Promise<{ plan: Plan | null, preview: boolean }>
```

### `actions.js` / `main.js`

- `actions.js` imports `previewIsActive` (from `preview.js`) and `render3d` to route PNG
  export and to append `pv` when building the share URL.
- `main.js` boot IIFE destructures `{ plan, preview }` from `readBootHash()` and calls
  `preview.setActive(true)` after applying+rendering the plan when `preview` is true.

## State Model

- **Preview active** — session-only in `preview.js` (`_active`). Never persisted to plan,
  localStorage, or the stored URL. Unchanged by this LLD.
- **`pv` flag** — exists **only** in a share URL at build/read time. Derived from
  `previewIsActive()` when encoding; consumed once at boot then discarded (the whole hash is
  stripped by `readBootHash`, as today). Not stored anywhere.
- **Share-URL cache** (`actions.js`) — the pre-computed URL now depends on preview state, so
  a preview toggle must invalidate it. Wire `preview.onChange` to the existing cache
  invalidation so the next Share click reflects the current `pv`.
- **Captured PNG** — transient Blob, downloaded and discarded; object URL revoked as in the
  existing download helper.

## Edge Cases

1. **Preview active but running in 2.5D-SVG fallback** (WebGL unavailable) — `canCapture()`
   is false → PNG exports the **flat 2D plan**. Documented limitation (the on-screen
   fallback SVG is view-coupled, not captured).
2. **Preview active, empty plan** — capture succeeds; `frame()` already handles empty bounds
   (default frame). PNG shows an empty scene, no crash.
3. **SVG export while preview active** — always flat plan + one-time nudge toast.
4. **Legacy share link (no `&`)** — `parseHashParts` returns the whole string as `planHash`,
   `pv` false → byte-identical to today's behavior. Back-compat guaranteed.
5. **`&pv=1` present but plan blob undecodable** — `readBootHash` still throws (existing
   "couldn't be opened" toast); flag is irrelevant.
6. **`&pv=0`, `&pv=`, or unknown flags** — `pv` truthy only for exact `1`; everything else
   ignored, no preview entry.
7. **`&pv=1` recipient without WebGL** — boot enters preview; `render3d.enter()` returns the
   fallback result and the existing handler paints the 2.5D SVG. Recipient still gets a peek.
8. **Share clicked while in preview** — URL carries `&pv=1`; cache was invalidated on the
   preview toggle so the copied link is current (Safari synchronous-copy path preserved).
9. **`toBlob` returns null** — `capturePngBlob` rejects → `actions.js` catch → "Couldn't
   export PNG — try SVG" toast (matches existing PNG-failure UX).
10. **Multiple `&` in hash** (defensive/hand-edited) — split on the **first** `&`; parse the
    remainder as `&`-joined pairs; ignore anything unrecognized.
11. **Undo/redo, autosave, history** — untouched; neither the flag nor the capture mutates
    the model (read-only guarantee from LLD 128/130 holds).

## Dependencies

- **LLD 130** — `render3d.js` (WebGL renderer, `#stage3d` canvas, `enter/exit/frame`,
  `_renderOnce`, `__hasRenderer`, `preview--fallback` stage class).
- **LLD 128** — `preview.js` session state (`isActive`/`setActive`/`onChange`).
- **LLD 16 / share** — `share.js` hash codec, `readBootHash`, `actions.js` share cache and
  export menu wiring, `main.js` boot-restore IIFE.
- **`exportImg.js`** — `exportPng`/`exportSvg`/`buildExportSvg` (flat-plan path, unchanged)
  and the download helper to promote.

**Blast radius (flag to code-review):** `render3d.js`, `exportImg.js`, `share.js`,
`actions.js`, `main.js`, plus minor `index.html`/copy for the toast string.

## Test Requirements

Tests run in `test/tests.html` (headless describe/it harness; **WebGL is unavailable in that
environment**, so true GPU capture is verified manually/QA, and unit tests cover the pure
logic + routing decisions).

### Unit

- `share.parseHashParts`: legacy hash (no `&`) → `{ planHash: whole, pv:false }`; `&pv=1` →
  `pv:true` with `planHash` intact and independently decodable; `&pv=0`/unknown/empty →
  `pv:false`; multiple `&` split on first; never throws on garbage.
- `share.encodeShareHash`: `{preview:true}` round-trips through `parseHashParts` →
  `pv:true` and `decodeHashToPlan(planHash)` deep-equals the source plan; `{preview:false}`
  emits **no** `&pv` suffix (identical to `encodePlanToHash`).
- **Back-compat regression**: existing `share.js` codec tests still pass; a hand-fixed
  legacy hash string decodes unchanged.
- `render3d.canCapture()`: false in the headless env (no renderer) — guards the routing.

### Integration (jsdom-limited)

- **Export routing (the acceptance-criteria test)**: with `render3d.canCapture` stubbed
  true and `previewIsActive` true, the PNG action selects the capture path; with either
  false, it selects the flat `exportPng` path. This is the "emits preview geometry when
  preview active, 2D plan when not" check adapted to WebGL-less CI.
- **SVG always flat**: `buildExportSvg()` output contains the flat plan polygons regardless
  of preview state (documents the intentional SVG-of-preview suppression).
- **Boot flag**: `readBootHash()` on a `#<blob>&pv=1` location returns `preview:true` and the
  boot flow calls `preview.setActive(true)` after applying the plan; a legacy `#<blob>`
  returns `preview:false` and does not enter preview.

### Security / privacy

- Flag parsing tolerates malformed/adversarial hashes without throwing; only `pv=1` is
  honored; unknown keys ignored; no `eval`/dynamic execution of hash content.
- Export and share remain **fully client-side** — no network calls introduced (principle:
  client-side only, free, ungated).

### Manual / QA (WebGL required)

- In a real browser: enter preview, Export → PNG yields a **non-blank** image of the 3D
  view; orbit the camera, re-export, confirm the new angle is captured.
- Open a `&pv=1` link → lands directly in preview; open the same link with WebGL disabled →
  lands in the 2.5D fallback. Open a legacy link → flat 2D, no preview.
