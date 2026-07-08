# LLD 16: MVP-6 — Persistence & Share (localStorage autosave, JSON/PNG/SVG export, URL-hash share)

Phase 6 of 6 of the MVP epic (#1). Builds a **thin persistence/share shell over the
existing serializable model** (walls.model, symbols.model, view.view, units.unit). When
this lands, close #1. It adds no new geometry and does not refactor the model — it only
reads the model out to durable/shareable artifacts and reads them back in. Client-side
only: nothing is ever sent to a server.

## Scope

**Covers:**
- **localStorage autosave** — the current plan persists across reloads with no signup;
  debounced write; ambient status pill (Saving / Saved / Unsaved / Not saved — export to
  keep); never blocks the canvas; graceful handling of quota-exceeded and private-mode
  failures.
- **JSON export / import** of the full plan, round-tripping **losslessly**; import
  validates and rejects unreadable / wrong-schema files with a toast (never throws).
- **PNG + SVG export** — a clean, self-contained snapshot (proper bounds/margins,
  dimension labels, no grid/snap/UI chrome, opaque background) suitable to send to a
  landlord or roommate.
- **Shareable URL** — plan → JSON → compressed → base64url in the `#hash`; opening the
  link reconstructs the exact plan on any device. Nothing hits a server.
- **Restore-conflict UX** — banner-with-choice ("Open shared" vs "Keep mine") when a
  share link opens over a non-empty local plan; light auto-dismiss "Restored your last
  plan" toast for the no-conflict local restore.
- **Destructive Reset** behind an overflow (⋯) menu with a replace-plan confirm.

**Does NOT cover:**
- Accounts / cloud sync / cross-device login (Phase 3 / #4 — deliberately later; relaxes
  the no-backend invariant).
- **QR code** for the share link — explicitly **deferred to a fast-follow** (see Frontend
  Design). v1 ships Copy link + link meta only.
- Any change to drawing, snapping, measurement, symbol, or unit *logic*. This layer is
  read/write only.
- Multiple named/saved plans, history/versioning, or undo of a Reset.
- Server-side OG image generation or link unfurling beyond the existing static meta tags.

## Approach

Key decisions and rationale:

1. **One plain plan object with a `schema` version.** Serialize the four existing
   sources into a single object (see Interfaces). `schema` is an integer for
   forward-compat: unknown/newer schema → treated as unreadable and rejected with a toast
   rather than mis-loaded. This is the single serialization format shared by localStorage,
   JSON export, and the URL hash — one encoder, one validator, three transports.

2. **New modules, no model refactor.** All logic lives in new files under `src/js/`:
   - `plan.js` — **pure** build / validate / apply of the plan object (the testable core;
     no DOM).
   - `store.js` — debounced localStorage autosave + status-pill state machine.
   - `share.js` — hash encode/decode (compress + base64url) + restore-conflict resolution.
   - `exportImg.js` — standalone SVG builder + PNG rasteriser (headless render, not tied
     to the live view transform).
   - `exportJson.js` — JSON file download + import (file picker, validate, apply).
   - `actions.js` — the actions cluster wiring (Share / Export menu / overflow ⋯ / toasts).
   `main.js` gains ~1 block: init these modules, run boot-restore before first render,
   register the autosave hook.

3. **Minimal, non-refactoring model additions.** `walls.js` and `symbols.js` keep
   private id counters (`_roomCounter`, `_counter`) that are **not** reflected when we
   repopulate `model` from a loaded plan. To prevent id collisions after load, add one
   thin exported helper to each model module — `hydrate(next)` — that (a) replaces the
   model arrays **in place** (so existing imported `model` references stay valid) and (b)
   re-syncs the private counter to `max(existing numeric id) + 1`. This is additive, not a
   refactor. `plan.applyPlan()` calls these.

4. **Autosave is driven by the render loop, dirty-checked — zero mutation-site edits.**
   Rather than instrument every mutation (closeRoom, moveSymbol, unit toggle, pan…), a
   single `onRender` hook schedules a **debounced** (~800 ms) autosave. The saver
   serializes the plan and compares its JSON string to the last-written string; it writes
   only on a real change. Renders already fire after every meaningful state change, so
   this captures everything (geometry, symbols, unit, view) with no invasive wiring, and
   the dirty-check + debounce keep writes cheap during rapid pan/zoom.

5. **Compression with zero new runtime dependency: native `CompressionStream`.** Use the
   browser-native `CompressionStream`/`DecompressionStream` with `"deflate-raw"` to
   compress the JSON before base64url. This is baseline-available (Chrome 80+, Firefox
   113+, Safari 16.4+) and adds **no** library, honouring "deploy cheap / no build step."
   A 1-char scheme prefix on the hash payload selects the codec so we can fall back to
   **uncompressed** base64url when `CompressionStream` is missing, and so future codecs
   stay decodable. No third-party compression library is bundled.

6. **Clipboard copy ordering (Safari user-activation).** The Share flow needs the
   compressed hash (an `await` on `CompressionStream`) before it can copy. Awaiting first
   and calling `navigator.clipboard.writeText` afterward risks Safari treating the gesture
   as spent (`NotAllowedError`), making the fallback the *common* path there. Two-part
   handling: keep a lazily-recomputed encoded-hash cache refreshed on the autosave/render
   dirty-check so the click handler usually has the URL **synchronously** and can
   `writeText` before yielding; and always wrap `writeText` in try/catch with a
   same-handler transient-input select fallback. Prefer the sync path; treat the fallback
   as the exceptional path, not the default. (Edge Case 18.)

7. **Export renders headless, independent of the live view.** PNG/SVG export must not
   bake in grid, snap glyphs, chrome, or the user's pan/zoom. `exportImg.js` computes a
   world-space bounding box over all room verts and symbol footprints, applies a fixed
   export scale + margin, and emits a fresh SVG mirroring the on-canvas styling (wall
   body/centerline, room fill, symbols, per-edge dimension labels, an opaque blueprint
   background). PNG is that SVG drawn to an offscreen `<canvas>` via a Blob-URL `Image`,
   then `canvas.toBlob("image/png")`.

## Interfaces / Types

### The plan object (shared format)

```js
/**
 * @typedef {Object} Plan
 * @property {number}  schema   Format version. v1 = 1.
 * @property {"floorplan"} app  Guard tag; import rejects if absent/mismatched.
 * @property {{ rooms: Room[], chain: Vertex[] }} walls   copy of walls.model
 * @property {{ symbols: Sym[] }}                 symbols copy of symbols.model
 * @property {{ zoom:number, panX:number, panY:number }} view  copy of view.view
 * @property {"ft"|"m"} unit    copy of units.unit
 */
export const PLAN_SCHEMA = 1;
```

### `plan.js` (pure, no DOM)

```js
/** Snapshot current live state → a fresh, JSON-safe Plan. */
export function buildPlan(): Plan

/**
 * Deep structural + type validation. Returns the normalised Plan or null.
 * Rejects: non-object, wrong app tag, schema !== PLAN_SCHEMA, missing/!array
 * rooms|chain|symbols, verts/symbols with non-finite numbers, unknown unit,
 * unknown symbol type. Also requires each room's `closed` to be a boolean and each
 * vertex to be an object of shape {x:number, y:number} (both finite). Never throws.
 */
export function validatePlan(raw: unknown): Plan | null

/**
 * Apply a validated Plan to the live modules IN PLACE:
 *  - walls.hydrate(plan.walls), symbols.hydrate(plan.symbols)
 *  - view.setView(plan.view), units.setUnit(plan.unit)
 * Caller triggers render afterward. Assumes plan already validated.
 */
export function applyPlan(plan: Plan): void

/** True when the live plan has no rooms, no chain, and no symbols. */
export function isEmptyPlan(): boolean

/** Stable JSON string of a Plan (key order fixed) for dirty-checking. */
export function serializePlan(plan: Plan): string
```

### `store.js` (localStorage autosave)

```js
export const STORAGE_KEY = "floorplan:plan:v1";

/** @typedef {"idle"|"saving"|"saved"|"unsaved"|"error"} SaveState */

/** Wire the pill element + register the debounced autosave onRender hook. */
export function init(pillEl: HTMLElement): void

/** Read + validate the persisted plan. Returns Plan|null (null on absent/corrupt). */
export function loadLocal(): Plan | null

/** Force an immediate (non-debounced) save. Used before Reset/import overwrite. */
export function saveNow(): void

/** Remove the persisted plan (used by Reset). */
export function clearLocal(): void

/** Current pill state (for tests). */
export function getState(): SaveState
```

### `share.js` (URL hash)

```js
/** Async: Plan → deflate-raw → base64url, prefixed with codec byte. */
export async function encodePlanToHash(plan: Plan): Promise<string>

/** Async: hash string → Plan|null (validated). Never throws. */
export async function decodeHashToPlan(hash: string): Promise<Plan | null>

/** Build the absolute share URL for the current plan (location.origin + path + #). */
export async function buildShareUrl(): Promise<string>

/** Read location.hash on boot; returns decoded Plan|null. Strips the hash after read. */
export async function readBootHash(): Promise<Plan | null>
```

### `exportImg.js`

```js
/** @typedef {{ minX,minY,maxX,maxY:number }} Bounds */

/** World-space bounds over all room verts + symbol footprints, or null if empty. */
export function contentBounds(): Bounds | null

/** Build a standalone SVG document string (opaque bg, dims, no chrome). */
export function buildExportSvg(): string

/** Trigger download of the SVG. */
export function exportSvg(): void

/** Rasterise the export SVG to PNG (2× device scale) and trigger download. */
export async function exportPng(): Promise<void>
```

### `exportJson.js`

```js
/** Serialize current Plan and trigger a .json download. */
export function exportJson(): void

/**
 * Open a file picker, read + validate the chosen file.
 * On success: apply + render + toast. On failure: reject toast, no state change.
 */
export function importJson(): void
```

### Thin model additions (additive, not a refactor)

```js
// walls.js
/** Replace rooms+chain arrays in place; re-sync _roomCounter past max wN id. */
export function hydrate(next: { rooms: Room[], chain: Vertex[] }): void

// symbols.js
/** Replace symbols array in place; re-sync _counter past max sN id. */
export function hydrate(next: { symbols: Sym[] }): void

// view.js
/** Set zoom/panX/panY (clamped zoom) and fire onChange. Used by applyPlan (verbatim
 *  same-device restore + JSON import). */
export function setView(v: { zoom:number, panX:number, panY:number }): void

/**
 * Compute and apply a zoom/pan that fits `bounds` (world-space) centered within a
 * W×H viewport with a small margin, then fire onChange. Zoom is clamped to
 * [MIN_ZOOM, MAX_ZOOM]. Used by share-open (applyShared) so a plan drawn on one device
 * frames correctly on another. No-op-safe: caller passes non-null bounds (empty plan
 * falls back to resetView).
 */
export function fitToContent(bounds: {minX,minY,maxX,maxY:number}, W:number, H:number): void
```

## State Model

**Sources of truth (unchanged):** `walls.model`, `symbols.model`, `view.view`,
`units.unit`. Persistence never introduces a parallel copy of the plan that could drift —
it always re-reads these on save and writes back into them on load.

**Persisted (localStorage, key `floorplan:plan:v1`):** the full serialized Plan JSON,
including `view` and `unit`. NOTE: this intentionally makes `unit` and `view` persistent
across reloads for a returning user, superseding units.js's current "unit resets to ft"
comment — acceptable and expected for a restored plan. (A brand-new visitor with no saved
plan still defaults to imperial.)

**In-memory only:** the save-state pill status, the last-written JSON string
(dirty-check baseline), the debounce timer, and any open menu/toast/banner DOM.

**Not persisted:** transient interaction state (active drag/ghost, current tool mode,
selection, in-progress dim-entry input, hint dismissal).

**Autosave lifecycle:**
1. Any render fires the `onRender` autosave hook → pill → `unsaved`, (re)arm debounce.
2. After ~800 ms idle: build plan, serialize; if equal to last-written → pill `saved`,
   no write. If changed → pill `saving` → `localStorage.setItem` → on success record
   baseline, pill `saved`; on `QuotaExceededError`/`SecurityError`/any throw → pill
   `error` ("Not saved — export to keep"), keep the unwritten change in memory.
3. Import / share-open / Reset call `saveNow()`-equivalents explicitly so the pill and
   baseline stay coherent.

**Boot restore order (in `main.js`, replacing the current unconditional
`resize()` → `resetView(W,H)` → `render()` tail, lines 156–167):**

> **CRITICAL — `resetView` must NOT run unconditionally.** Today `main.js` calls
> `resize()` then `resetView(W, H)` right before `render()`. `resetView` overwrites
> `view.zoom/panX/panY`. If left unconditional it will **clobber any restored view**
> (from `applyPlan`) on every reload and every share-open. The boot sequence below moves
> `resetView(W, H)` into the **empty-start branch only**: it runs when no plan is applied
> (and after the destructive Reset, Edge Case 16). Whenever a `hashPlan` or `localPlan` is
> applied, `resetView` is **skipped** and the view comes from the plan/frame logic below.
> `resize()` still always runs first (it only measures the viewport; it does not touch
> `view`).

1. `resize()` → `{ W, H }` (always; measures viewport only).
2. `readBootHash()` → `hashPlan`.
3. `loadLocal()` → `localPlan`.
4. Decision:
   - `hashPlan` present **and** `localPlan` present **and** `!isEmptyPlan`-equivalent for
     local (local has content) **and** the two serialize differently → **show
     banner-with-choice**; apply nothing yet, **do not** call `resetView`. The chosen
     branch (below) applies its plan and sets the view.
   - `hashPlan` present otherwise → apply `hashPlan` via `applyShared(hashPlan, W, H)`
     (see below); toast "Opened shared plan". **No `resetView`.**
   - else `localPlan` present → `applyPlan(localPlan)` (restores the stored view verbatim);
     light auto-dismiss toast "Restored your last plan". **No `resetView`.**
   - else → empty start: call `resetView(W, H)` (existing default frame).
5. Always strip `location.hash` after reading (so a later autosave/refresh doesn't
   re-trigger the shared-open path, and the URL is clean).
6. `render()`.

**Share-open view handling (`applyShared`) — cross-device fit, not raw pan.** A shared
plan's `view.panX/panY` are absolute *screen pixels* derived from the **sender's**
viewport (`worldToScreen = wx*scale + panX`; `resetView` sets `panX = W*0.15`). Applying
them verbatim on a differently-sized device (wide desktop → narrow phone, or vice-versa)
can render the plan partially or fully **off-screen** — a bad first impression for the
headline share feature. Therefore share-open does **not** trust the payload's pan/zoom:
after `applyPlan(hashPlan)` (which restores rooms/symbols/unit and the raw view),
`applyShared` immediately **reframes to fit content** for the *current* viewport via a new
`view.fitToContent(bounds, W, H)` helper (see Interfaces) using `contentBounds()` from
`exportImg.js`. If the plan is empty (`contentBounds` → null), fall back to
`resetView(W, H)`. This makes "opening the link reconstructs the exact plan on any device"
true for the *content* (walls/symbols/dimensions/unit are byte-exact) while the *frame* is
recomputed to guarantee the plan is visible and centered on the opener's screen.

> This treatment is **specific to share-open**. The same-device localStorage restore keeps
> the stored pan/zoom verbatim (via plain `applyPlan`) because the viewport is the same
> machine and the user's last frame is exactly what they expect back. `view` is still
> included in the persisted/shared payload (JSON round-trip stays lossless and
> same-device restore is exact); share-open simply overrides the *applied* frame after
> loading.

Banner choices: **Open shared** → `applyShared(hashPlan, W, H)` + render (fit-to-content
frame; local plan remains in localStorage until the next autosave overwrites it — so
nothing is lost until the user edits). **Keep mine** → `applyPlan(localPlan)` (stored view
verbatim) + render; discard `hashPlan`.

## Edge Cases

1. **localStorage unavailable (private mode / disabled cookies).** `setItem` throws
   `SecurityError` (or access throws). Catch on both read and write; boot restore treats
   read failure as "no saved plan"; autosave sets pill to "Not saved — export to keep" and
   stops spamming writes (arms only on further change). Canvas never blocked.
2. **Quota exceeded.** `setItem` throws `QuotaExceededError` → pill "Not saved — export to
   keep"; keep in-memory change; retry on next real change (which may succeed if user
   deleted content).
3. **Corrupt / partial localStorage value.** `loadLocal` runs `JSON.parse` in try/catch
   then `validatePlan`; any failure → return null (treat as no saved plan). Do **not**
   auto-clear it (avoid destroying possibly-recoverable data); the next successful
   autosave overwrites it.
4. **Unknown / future `schema`.** `validatePlan` rejects (schema must `=== PLAN_SCHEMA`).
   For localStorage → no restore. For JSON import / share → toast "This plan was made with
   a newer version of floorplan" (or generic "Couldn't read this plan"). Never partial-load.
5. **Malformed share hash** (truncated, bad base64, bad codec byte, decompress error).
   `decodeHashToPlan` returns null; boot falls through to local restore; a one-time toast
   "That share link couldn't be opened." Hash still stripped.
6. **`CompressionStream` unsupported.** `encodePlanToHash` falls back to uncompressed
   base64url (codec byte `u`); `decodeHashToPlan` honours the codec byte. Link is longer
   but works. No dependency added.
7. **Very large plan → long URL.** Some chat apps/browsers truncate long URLs. Compute the
   encoded length; if the final URL exceeds a soft threshold (~8000 chars after
   compression), still copy it but toast a non-blocking warning suggesting PNG/JSON export
   for very large plans. (No server fallback — that would break the no-backend invariant.)
8. **Empty plan.** Share/PNG/SVG/JSON of an empty plan still produce valid artifacts
   (empty SVG with just background + margin; a hash that decodes to an empty plan). Copy
   link on empty plan is allowed but the actions may show a subtle disabled/hint state
   (see Frontend Design).
9. **Id-counter collision after load.** Without re-sync, `hydrate` leaving `_roomCounter`
   at 0 would mint `w0` again and collide with a loaded `w0`. `hydrate` MUST set the
   counter to `max(parsed numeric suffix) + 1` over loaded ids (ignore non-`w<n>`/`s<n>`
   ids defensively). Test explicitly.
10. **Active drawing chain at save/share/export.** The in-progress `chain` is part of
    `walls.model` and is serialized. On restore the chain reappears as a draft (acceptable
    and lossless). Export SVG/PNG: render committed rooms only? — **Decision:** render the
    chain too (as the current draft styling) so the artifact matches what the user sees;
    but omit snap glyph and rubber-band. Keep simple: draw chain as an open polyline.
11. **Unit at export.** Dimension labels in SVG/PNG use the *current* `units.unit`
    formatting (`fmtLen` + `unitLabel`), matching on-screen. JSON/share preserve the raw
    metres + the unit field, so a reopened plan shows the same unit.
12. **`prefers-reduced-motion`.** All toasts, the banner, and the pill transitions respect
    the reduce query (no slide/fade animations; instant show/hide). Reuse the existing
    media-query pattern in `index.html`.
13. **PNG rasterisation taint / async failure.** The SVG→Image→canvas path uses a Blob URL
    (same-origin, no external refs — fonts are drawn as plain text with a web-safe
    fallback so there's no cross-origin font fetch that could taint the canvas). If
    `toBlob` yields null or the Image errors, toast "Couldn't export PNG — try SVG."
14. **Hash present but identical to local.** If `hashPlan` serializes equal to `localPlan`,
    skip the conflict banner; just apply and show the light "Restored" toast (no needless
    choice prompt).
15. **Import file that is valid JSON but not a plan** (e.g. some other app's export). `app`
    tag guard + `validatePlan` → reject toast; live plan untouched.
16. **Reset.** Overflow ⋯ → Reset → confirm ("Replace current plan? This can't be
    undone."). On confirm: `walls.hydrate({rooms:[],chain:[]})`,
    `symbols.hydrate({symbols:[]})`, `clearLocal()`, `resetView(W,H)` (Reset is the one
    deliberate view-reset that survives the boot-restore change above), render, pill →
    `saved` (empty). No accidental one-click path.
17. **Hand-edited / foreign JSON with a missing or non-boolean `closed`.** `polygonArea`
    / `perimeter` treat a falsy `closed` as an open polyline, so a bad `closed` would
    silently mis-measure a room. `validatePlan` rejects any room whose `closed` is not a
    strict boolean (and any vertex not of shape `{x:number,y:number}`) → import/share
    reject toast, no partial load.
18. **Clipboard user-activation lost across `await` (Safari).** The Share handler must
    compress via `CompressionStream` (async) before it has a URL to copy. In Safari,
    awaiting across a microtask can spend the user-activation gesture, so a *later*
    `navigator.clipboard.writeText` rejects with `NotAllowedError` — pushing every Safari
    copy onto the fallback path. Mitigation: (a) `writeText` is still attempted and its
    rejection caught; (b) on rejection, fall back to selecting the URL in a transient
    input **within the same handler** so manual copy works; (c) optionally pre-compute /
    memoize the encoded hash on the last render so the click handler has the URL
    synchronously and can `writeText` before yielding. See Approach note 6.

## Dependencies

**Must exist (all already shipped):**
- `walls.js` — `model {rooms, chain}`, `edgeLength`, `polygonArea`, `perimeter` (LLD 4/9).
- `symbols.js` — `model {symbols}`, `CATALOG`, `corners` (LLD 12).
- `view.js` — `view {zoom,panX,panY}`, `worldToScreen`, `resetView`, `onChange`,
  `clampZoom` (LLD 2).
- `units.js` — `unit`, `setUnit`, `fmtLen`, `unitLabel`, `M_PER_FT` (LLD 9).
- `surface.js` — `onRender(cb)` hook (used by the autosave trigger), `render`, `W/H`.
- `wallRender.js` / `symbolRender.js` — referenced for styling constants to mirror in the
  export renderer (colors, `WALL_M`); export does **not** call them (they draw into the
  live view).

**New thin additions required in existing files:**
- `walls.hydrate`, `symbols.hydrate`, `view.setView`, `view.fitToContent` (see Interfaces).
  Share-open uses `view.fitToContent(contentBounds(), W, H)`; the boot tail moves
  `resetView(W,H)` into the empty-start / Reset branches only (no longer unconditional).
- `main.js` boot-restore block + `store.init` + register autosave `onRender` hook + wire
  the actions cluster.
- `index.html` — actions-cluster markup + save pill + toast/banner containers + CSS
  (warm-blueprint tokens; no new dependencies).

**Platform APIs:** `CompressionStream`/`DecompressionStream` (with fallback),
`localStorage`, `Blob`, `URL.createObjectURL`, `canvas.toBlob`, Clipboard API
(`navigator.clipboard.writeText` with a `document.execCommand('copy')`/select fallback).

**No new runtime/library dependency.** No build step. Deploys as static files.

## Frontend Design

Stays entirely inside the established **warm-blueprint** visual language (panel bg
`--panel`, hairline `--hairline`, gold accents, `--font-mono`, blurred glass chrome).
Adds one new floating cluster and reuses existing chip/panel idioms — **no new chrome
family, no new runtime dependency.**

**CEO-directed calls (honored, do not revisit in v1):**

1. **QR code — DEFERRED to a fast-follow, not v1.** The one-tap **Copy link** is the core
   hand-off and fully covers "text it to a roommate." Ship **Copy link + link meta** only.
   A QR would add a dependency and conditional-rendering complexity (the ~2 KB fit check)
   for marginal gain, cutting against "deploy cheap / keep v1 lean." QR returns as its own
   small issue once the share flow proves out.

2. **Restore-conflict UX — banner-with-choice.** When a share link opens over a non-empty
   local plan, show an explicit banner: **"Opened a shared plan — [Open shared] [Keep
   mine]."** Never silently clobber the local plan (data-integrity guardrail). For the
   no-conflict local restore, show only the lighter **auto-dismiss** toast "Restored your
   last plan."

3. **Reset placement — overflow ⋯ menu.** Reset is destructive and rare; it lives behind
   the overflow (⋯) menu plus a replace-plan confirm. It is **not** surfaced top-level.

**Layout (new "actions" cluster, top-right):** placed above/left of the existing unit
toggle so it doesn't collide with the measure inspector. Three affordances + an ambient
pill:
- **Share** button → primary action; on click copies the hash URL to clipboard and shows a
  "Link copied" toast. Prefer a pre-computed (cached, dirty-checked) hash so `writeText`
  runs before any `await` (Safari user-activation, Approach note 6 / Edge Case 18); fall
  back to selecting the URL in a transient input within the same handler on rejection.
  (Label reads "Copy link" / "Share".)
- **Export** button → small popover menu: **PNG**, **SVG**, **JSON**, divider, **Import
  JSON…**. Same panel/hairline styling as the symbol dock / inspector.
- **Overflow ⋯** button → menu with a single destructive **Reset** item (rendered in the
  `--error` tone), which opens the replace-plan confirm.
- **Save status pill** — small ambient text pill (mono, muted) reading **Saved / Saving… /
  Unsaved / Not saved — export to keep**. Non-interactive, `aria-live="polite"`. Sits
  inline in the cluster; never overlays or blocks the canvas.

**Toasts / banner:** a single bottom-or-top toast region (panel styling, `role="status"`,
`aria-live="polite"`) for transient messages (Link copied, Restored, error strings). The
conflict **banner** is a distinct, persistent (until dismissed by choice) top-center strip
with two buttons. **All motion respects `prefers-reduced-motion`** (instant show/hide,
reusing the existing reduce media-query block).

**Empty-plan affordance:** with an empty plan, Share/PNG/SVG are technically valid but low
value; keep them enabled (avoid dead-end confusion) — optionally dim Share with a tooltip
"Draw something to share." (Non-blocking; implementer's choice within the language.)

**Mobile:** the cluster collapses gracefully (icons over labels at ≤640px), mirroring the
tool-rail/measure responsive behavior; the Export/overflow menus open as the same popover.
Copy link uses the async Clipboard API; on failure it falls back to selecting the URL in a
transient input for manual copy.

## Test Requirements

Extend `src/tests.html` (in-page `describe`/`it`/`expect`). Reset `walls.model`,
`symbols.model`, `units.unit`, and `view` between suites (existing pattern). DOM-touching
cases run in the in-browser harness.

**Unit — `plan.js` (the core; must be lossless):**
- `buildPlan()` snapshots all four sources; result is plain and
  `JSON.parse(JSON.stringify(plan))` deep-equals it.
- **Round-trip:** `applyPlan(validatePlan(buildPlan()))` leaves `walls.model`,
  `symbols.model`, `view.view`, `units.unit` deep-equal to the originals (the core
  acceptance criterion — lossless).
- `validatePlan` accepts a good plan; returns `null` (never throws) for: non-object,
  missing/`wrong app` tag, `schema` ≠ `PLAN_SCHEMA`, non-array rooms/chain/symbols,
  non-finite vertex/symbol numbers, malformed vertex (missing/non-numeric `x`/`y`),
  non-boolean or missing room `closed`, unknown unit, unknown symbol type.
- `isEmptyPlan` true for a fresh model, false after adding a room or symbol.
- `serializePlan` is stable (same plan → identical string; key order fixed) so the
  dirty-check is reliable.

**Unit — model additions:**
- `walls.hydrate` replaces arrays in place (same array identity, new contents) and sets
  `_roomCounter` so the next `closeRoom` mints an id greater than any loaded `w<n>`
  (collision guard, Edge Case 9).
- `symbols.hydrate` likewise for `s<n>`.
- `view.setView` clamps zoom to `[MIN_ZOOM, MAX_ZOOM]` and fires `onChange`.
- `view.fitToContent(bounds, W, H)` produces a zoom (clamped) and pan such that the
  bounds map inside the W×H viewport with margin and are centered; fires `onChange`.
  Verify a plan that fits off-screen under the sender's raw pan lands on-screen after
  `fitToContent` for a different (narrower) W×H.

**Unit — `share.js` codec:**
- `decodeHashToPlan(await encodePlanToHash(p))` deep-equals `p` (compressed path).
- Fallback path (codec byte `u`, uncompressed) round-trips equally.
- `decodeHashToPlan` returns `null` for garbage / truncated / wrong-codec input (no throw).
- Encoded compressed hash is shorter than the raw JSON for a non-trivial plan (sanity).

**Unit — `exportImg.js`:**
- `contentBounds` returns correct min/max over rooms + rotated symbol footprints; `null`
  for an empty plan.
- `buildExportSvg` output contains no grid/snap/`#draft` chrome, includes an opaque
  background rect, includes one dimension label per room edge, and its viewBox equals the
  bounds + margin.

**Integration / behavioral (in-browser):**
- **Autosave:** mutating the model then advancing past the debounce writes a valid plan to
  `localStorage[STORAGE_KEY]`; pill transitions `unsaved → saving → saved`; a no-op render
  does not write (dirty-check).
- **Reload restore (view verbatim):** seed `localStorage` with a known plan whose stored
  `view` differs from the default frame, run the **full boot sequence** → model matches
  **and `view.view` equals the stored view** (i.e. `resetView` did NOT clobber it — the
  regression the reviewer flagged; note the pure `applyPlan(validatePlan(buildPlan()))`
  round-trip test does *not* exercise the boot tail, so this behavioral test is the one
  that guards it); light "Restored" toast; no conflict banner.
- **Empty-start view:** no hash, no local plan → boot calls `resetView(W,H)`; `view`
  equals the default frame.
- **Share open, no local plan:** set `location.hash` to an encoded plan, empty local → boot
  applies rooms/symbols/unit byte-exact, **reframes via `fitToContent`** (not the sender's
  raw pan) so content is on-screen for the current viewport, toast shown, hash stripped
  from URL. `resetView` is NOT called.
- **Share open, conflicting local plan:** non-empty local + differing hash → **banner
  shown**, nothing applied yet; "Open shared" applies hash + fit-to-content; "Keep mine"
  retains local with its stored view. Identical hash+local → no banner (Edge Case 14).
- **JSON round-trip:** `exportJson` produces a blob whose parsed content re-imports via the
  `importJson` validate path to a deep-equal model.
- **Import rejection:** feeding wrong-schema / non-plan JSON to the import handler shows a
  reject toast and leaves the live model unchanged (Edge Cases 4/15).
- **Reset:** confirm path clears model + `localStorage` + resets view; cancel path is a
  no-op.

**Failure-mode / security:**
- localStorage `setItem` throwing (stub to throw `QuotaExceededError`) → pill "Not saved —
  export to keep", no exception escapes, canvas still interactive.
- localStorage access throwing (private-mode stub) on boot → treated as no saved plan; app
  boots normally.
- Malformed hash on boot → app falls back to local/empty, one-time toast, no throw.
- **No network:** assert (by design/review) that no module performs `fetch`/XHR/WebSocket
  and the share URL is produced purely from `location` + the hash — nothing leaves the
  device.
- PNG export path handles `toBlob` → null / Image error gracefully with an SVG-fallback
  toast (Edge Case 13).
