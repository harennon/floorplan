# LLD 15: MVP-6 — Persistence & Share (localStorage autosave, JSON/PNG/SVG export, URL-hash share)

Phase 6 of 6 of the MVP epic (#1). The plan model is already serializable — `walls.model`
(`{ rooms, chain }`) and `symbols.model` (`{ symbols }`) are plain objects of plain
`{x,y}` / catalog primitives, deliberately shaped this way in LLD 4 and LLD 12 for exactly
this phase. This LLD makes those models **durable** (localStorage autosave), **portable**
(JSON/PNG/SVG export + JSON import), and **shareable** (whole plan encoded in the URL
`#hash`). Everything stays client-side; nothing is sent to a server.

## Scope

**Covers:**
- **localStorage autosave** — debounced, non-blocking; the current plan (rooms + symbols)
  survives reload with no signup.
- **Restore on boot** — reload rehydrates the last plan; a share link in the URL takes
  precedence with an explicit conflict choice (see Frontend Design).
- **JSON export/import** — download the full plan as a `.json` file; re-import round-trips
  losslessly.
- **PNG + SVG export** — a clean, standalone, to-scale drawing (walls + symbols + dimension
  labels) suitable to send to a landlord/roommate. Rendered from the *model in world space*,
  not a screenshot of the live viewport.
- **Shareable URL** — serialize → compress → base64url into `location.hash`; opening the
  link reconstructs the exact plan on any device. Nothing hits a server.
- **Reset** — destructive "replace plan," tucked behind an overflow menu + confirm.
- Graceful failure of storage (private mode / quota) surfaced via a **"Not saved — export
  to keep"** pill.

**Does NOT cover (explicitly out):**
- **Accounts / cloud sync / cross-device auto-sync** — Phase 3 / #4. That relaxes the
  no-backend invariant and is deliberately later.
- **QR code** for the share link — deferred to a fast-follow (see Frontend Design §1). v1
  ships one-tap Copy link + link meta only, no QR dependency.
- **Undo/redo of load/reset** — out of v1 (LLD tracks undo separately).
- **Multi-plan library / named saves / thumbnails** — single autosaved plan slot in v1.
- **Cross-tab live sync** — last-write-wins; no `storage`-event mirroring in v1 (noted as an
  edge case only).
- **Persisting the in-progress draft chain** (`model.chain`) — transient; not serialized.
- **Persisting view (pan/zoom) or unit for autosave** — geometry only; see State Model.

## Approach

Four new modules, each single-responsibility, plus small new exports on existing model
modules. No third-party runtime dependency, no build step (ES modules, same as today).

1. **`persist.js` — serialization + localStorage.**
   - `serialize()` reads `walls.model.rooms` and `symbols.model.symbols` into a versioned
     `PlanDoc`. `deserialize(doc)` validates and loads it back.
   - Autosave is a **trailing-debounced** (`~800ms`) flush wired as a post-render hook. On
     flush it serializes, compares to the last-written string, and writes only on change —
     so pan/zoom (which also render) never write, and rapid edits collapse to one write.
   - All `localStorage` access is `try/catch`-wrapped; failure flips a "not saved" status
     rather than throwing. The canvas is never blocked (serialize is O(vertices) and runs
     after the settle delay, off the interaction path).

2. **`share.js` — URL-hash codec.**
   - `encode(doc): Promise<string>` → JSON → UTF-8 bytes → **gzip via native
     `CompressionStream`** → base64url. `decode(hash): Promise<PlanDoc|null>` reverses it.
   - **Zero dependency:** `CompressionStream`/`DecompressionStream` are built into modern
     browsers (Chrome/Edge 80+, Firefox 113+, Safari 16.4+), so no library is vendored.
     When unavailable, fall back to **uncompressed** base64url of the JSON (a `"1"` vs `"0"`
     one-char prefix on the payload records which path was used), so links still work
     everywhere — just longer.
   - The compression path keeps typical-studio links well under practical URL limits;
     coordinates are kept at full precision (no quantization) so JSON export and share are
     both lossless.

3. **`exporter.js` — JSON / SVG / PNG generation + JSON import.**
   - **JSON:** `exportJSON()` triggers a Blob download of `serialize()` (pretty-printed).
     `importJSON(file)` reads, `JSON.parse`s, validates via the same validator as
     `deserialize`, and loads.
   - **SVG:** `buildSVG()` constructs a **standalone** `<svg>` string from the model in
     world metres: computes the geometry bounding box, adds padding, sets `viewBox`/px size,
     and emits walls (body + centerline + fill), symbols, and dimension labels with inline
     styles (self-contained, no external CSS/fonts required to render). This is a fresh
     world-space render, independent of `wallRender.js`/`view.js` screen projection.
   - **PNG:** `exportPNG()` rasterizes the SVG string: load it into an `Image` via a
     `data:` URL, draw onto an offscreen `<canvas>` at a 2× scale factor (capped max
     dimension), `canvas.toBlob("image/png")` → download.

4. **`actionsUI.js` — the chrome.** Owns the top-right actions cluster (Share, Export ▾,
   overflow ⋯), the Share popover, the Export menu, the Reset confirm, the restore/conflict
   banner, and the save-status pill. It calls into `persist`/`share`/`exporter` and triggers
   `render()` after any load. Pure DOM wiring in the established warm-blueprint language.

**New exports on existing modules (model management):**
- `walls.js`: `replaceRooms(rooms)` (clears + reseeds `model.rooms`, clears `model.chain`)
  and `reseedRoomCounter(rooms)` (sets `_roomCounter` to `max(id)+1` so new rooms don't
  collide with loaded ids). `clearAll()` for reset.
- `symbols.js`: `replaceSymbols(syms)` + `reseedCounter(syms)` + `clearAll()`, mirroring.
- `view.js`: `fitView(W, H, bbox, padPx)` — center + zoom so a world bbox fits the viewport
  (used after loading/importing/opening a shared plan; better than `resetView` for showing
  someone the whole plan on a differently-sized screen).

**Boot integration (main.js):** after module init but before first render, run
`actionsUI.boot()` which decides restore-vs-share (see State Model), loads the chosen plan,
and fits the view. Then wire `onRender(persist.scheduleSave)`.

## Interfaces / Types

```js
// ── Plan document (the serialized shape) ────────────────────────────────────
/**
 * @typedef {Object} PlanDoc
 * @property {1}        v        schema version (integer; bump on breaking change)
 * @property {string}  app       "floorplan" — sanity guard for imported files
 * @property {Room[]}  rooms     from walls.model.rooms (closed + open); chain NOT included
 * @property {Sym[]}   symbols   from symbols.model.symbols
 */
// Room / Sym / Vertex reuse the existing JSDoc typedefs in walls.js / symbols.js.

// ── persist.js ──────────────────────────────────────────────────────────────
export const STORAGE_KEY = "floorplan.plan.v1";
export const SAVE_DEBOUNCE_MS = 800;

export function serialize(): PlanDoc;          // read live models → PlanDoc
export function deserialize(doc: PlanDoc): boolean; // validate + load into models; false on invalid
export function validate(doc: any): PlanDoc | null; // shape/range check; null if bad

export function loadFromStorage(): PlanDoc | null;  // parse STORAGE_KEY; null if absent/invalid/unavailable
export function saveNow(): "ok" | "error" | "empty"; // synchronous write; "empty" = nothing to persist
export function scheduleSave(): void;               // trailing-debounced saveNow(); the onRender hook
export function hasStoredPlan(): boolean;

export function onStatusChange(cb: (status: SaveStatus) => void): void;
/** @typedef {"saved"|"saving"|"unsaved"|"error"} SaveStatus */

// ── share.js ────────────────────────────────────────────────────────────────
export async function encode(doc: PlanDoc): Promise<string>;   // → base64url payload (no leading '#')
export async function decode(payload: string): Promise<PlanDoc | null>; // reverse; null on any failure
export function readHash(): string | null;     // strip leading '#'/'#plan='; null if none
export function buildShareURL(payload: string): string; // location.origin + pathname + '#plan=' + payload
export function clearHash(): void;             // history.replaceState to drop the hash without reload

// ── exporter.js ───────────────────────────────────────────────────────────────
export function exportJSON(): void;                     // triggers .json download
export async function importJSON(file: File): Promise<PlanDoc | null>; // parse+validate; caller loads
export function buildSVG(opts?: { padM?: number }): string;  // standalone <svg> string, world-space
export function exportSVG(): void;                      // buildSVG → .svg download
export async function exportPNG(opts?: { scale?: number, maxPx?: number }): Promise<void>; // → .png download
export function planBBox(): { minX, minY, maxX, maxY } | null; // world-metre bbox over all geometry; null if empty

// ── model management (added to existing modules) ──────────────────────────────
// walls.js
export function replaceRooms(rooms: Room[]): void;  // clears model.rooms + model.chain, pushes clones, reseeds counter
export function clearAll(): void;                   // empties rooms + chain, resets counter to 0
// symbols.js
export function replaceSymbols(syms: Sym[]): void;  // clears model.symbols, pushes clones, reseeds counter
export function clearAll(): void;                   // empties symbols, resets counter to 0
// view.js
export function fitView(W: number, H: number, bbox: {minX,minY,maxX,maxY} | null, padPx?: number): void;

// ── actionsUI.js ──────────────────────────────────────────────────────────────
export function init(refs: {
  actionsCluster: HTMLElement, btnShare, btnExport, btnOverflow,
  sharePopover, exportMenu, overflowMenu, banner, statusPill, fileInput
}): void;
export function boot(W: number, H: number): Promise<void>; // restore-vs-share decision + initial load + fitView
```

The `deserialize` / `replaceRooms` / `replaceSymbols` path **deep-clones** incoming vertices
and symbols into fresh objects — never aliases the parsed JSON — so no shared references
leak into the live model (which mutates in place during editing).

## State Model

**Source of truth stays where it is.** `walls.model` and `symbols.model` remain the single
in-memory source of truth for geometry. This LLD adds *no* parallel state store — it only
reads those models (serialize/export) and writes them wholesale on load (`replaceRooms` /
`replaceSymbols`). The module-private `_roomCounter` / `_counter` id sequences are reseeded
on load so ids stay unique after a restore.

**What is persisted (autosave + export + share):**
- `rooms[]` — closed + open, full vertex precision (metres).
- `symbols[]` — full precision.
- Schema `v` + `app` marker.

**What is NOT persisted (in-memory / session only):**
- `model.chain` — the in-progress draft polyline. Transient; if a user reloads mid-draw the
  committed rooms restore but the unfinished chain is dropped (documented tradeoff, matches
  "durable artifact" framing).
- **View** (`view.zoom/panX/panY`) — recomputed via `fitView` on load so the plan is framed
  for the current viewport/device, which is the point of a shared link opening "the exact
  plan" (geometry), not the exact camera.
- **Unit** (`units.unit`) — already defined as non-persisted (resets to imperial); unchanged.
- Selection, tool mode, inspector state.

**Storage layout:** one key, `STORAGE_KEY = "floorplan.plan.v1"`, value = `JSON.stringify`
of the uncompressed `PlanDoc` (localStorage is not URL-length constrained, so no compression
there — keeps debugging trivial). Single autosaved slot; last-write-wins.

**Autosave lifecycle:**
1. Any model mutation triggers `scheduleRender()` → `_doRender()` → the `onRender` hook
   `persist.scheduleSave()`.
2. `scheduleSave` sets status `"saving"` (pill), (re)arms the `SAVE_DEBOUNCE_MS` trailing
   timer.
3. On fire: `serialize()` → `JSON.stringify`. If equal to the last-written string, no write
   (status back to `"saved"`). Else `try` write → status `"saved"`; `catch` → status
   `"error"` (pill shows "Not saved — export to keep").
4. A `visibilitychange`/`pagehide` handler calls `saveNow()` (flush pending) so a close
   mid-debounce still persists where storage is available.

**Boot decision tree (`actionsUI.boot`):** run once, before first render.
```
hashPayload = share.readHash()
stored      = persist.hasStoredPlan()
if hashPayload:
    shared = await share.decode(hashPayload)
    if shared invalid            → toast "Couldn't open that link", fall through to stored/empty
    else if not stored OR stored-is-empty:
        load(shared); fitView; clearHash()           // no conflict → also show auto-dismiss "Opened shared plan"
    else (stored non-empty AND shared valid):
        show CONFLICT BANNER (Open shared | Keep mine)  // do NOT auto-load either; see Frontend Design §2
        - "Open shared" → load(shared); fitView; clearHash(); autosave overwrites slot
        - "Keep mine"   → clearHash(); load(stored); fitView   // shared discarded
elif stored:
    load(stored); fitView; show auto-dismiss "Restored your last plan"
else:
    empty plan (resetView as today)
```
`load(doc)` = `persist.deserialize(doc)` → `render()`. The conflict banner blocks neither
input nor autosave semantics beyond deferring which plan becomes active; autosave is armed
only after a plan is chosen.

## Frontend Design

Single cohesive direction, inside the established warm-blueprint language (floating panels,
hairline gold borders `--hairline`, `--panel` translucent bg with `backdrop-filter: blur`,
DM Mono micro-labels). **No new chrome idioms, no new dependencies.**

**Actions cluster — top-right, left of the existing unit toggle.** A new floating panel row:
`[ Share ]  [ Export ▾ ]  [ ⋯ ]`, styled like the tool rail / measure panel (same border,
radius, blur, font). It must not overlap the unit toggle or measure panel on narrow screens
— on `≤640px` it collapses label text to icons and reflows above/below the unit toggle per
existing responsive patterns. The save-status **pill** sits inline in this cluster.

**1. Share — one-tap Copy link (QR DEFERRED to a fast-follow).** Clicking **Share** builds
the URL-hash link (`await share.encode(serialize())`), writes it to `location.hash`, and
opens a small popover: a read-only link field + a primary **Copy** button
(`navigator.clipboard.writeText`, with a select-all fallback). On copy: button flips to
"Copied ✓" for ~1.5s. The popover also carries a one-line meta ("Anyone with this link sees
this exact plan — nothing is uploaded"). **No QR code in v1** — the Copy link fully covers
the "text it to a roommate" job; a QR is a separate small issue once the flow proves out
(avoids a rendering dependency + the ~2KB conditional-fit complexity, per CEO call).

**2. Restore / conflict UX — banner-with-choice.**
- **No-conflict restore** (stored plan, no share link): a lightweight **auto-dismiss banner**
  — "Restored your last plan" — fades after ~3s. Non-blocking, no buttons.
- **Conflict** (share link opened *and* a non-empty local plan exists): a **banner with an
  explicit choice** — "This link has a shared plan. **[Open shared]** **[Keep mine]**" —
  that does **not** silently clobber local work. Persists until the user chooses. This is the
  data-integrity guardrail; the extra surface is deliberate.
- Banner renders as a floating strip near the top-center, same panel styling; `role="status"`
  for the auto-dismiss variant, `role="alertdialog"`-style focus handling (focus first
  action) for the conflict variant.

**3. Reset — in the overflow `⋯` menu, behind a confirm.** Reset is destructive and rare, so
it is **not** surfaced top-level. The `⋯` menu holds **Import JSON…** and **Reset plan**.
Choosing **Reset plan** opens a small confirm ("Replace the current plan? This can't be
undone.") with **Cancel** / **Reset**. Confirm → `walls.clearAll()` + `symbols.clearAll()` +
`persist.saveNow()` (writes the now-empty slot) + `resetView` + `render()`.

**Export menu (`Export ▾`):** three items — **PNG**, **SVG**, **JSON** — each triggering the
corresponding `exporter` call. Downloaded filenames: `floorplan-YYYYMMDD-HHMM.{png|svg|json}`.

**Save-status pill states:** `saved` → subtle muted "Saved" (or hidden after fade);
`saving` → "Saving…"; `error`/private-mode → gold-bordered **"Not saved — export to keep"**
(persistent, nudges the durable artifact). Uses `--muted`/`--gold` tokens; no new colors.

**Motion / a11y:** all banner/popover transitions gated by
`@media (prefers-reduced-motion: reduce)` (no fade/slide — appear/disappear instantly),
consistent with existing rules in `index.html`. All new controls are real `<button>`s with
`aria-label`s; menus/popovers are keyboard-operable (Esc closes, focus trapped in the
conflict banner) and toggle `aria-expanded`.

## Edge Cases

1. **localStorage unavailable / disabled** (private mode, blocked cookies): `loadFromStorage`
   returns `null` (no throw); `saveNow` catches and sets status `"error"` → "Not saved —
   export to keep" pill. App stays fully usable; export/share still work.
2. **Quota exceeded** (huge plan): `saveNow` catch → same `"error"` status. No retry storm —
   next mutation re-attempts on the next debounce.
3. **Corrupt / hand-edited localStorage value**: `JSON.parse` throws or `validate` fails →
   treated as no stored plan (empty boot), and the bad value is left in place (not silently
   overwritten until the user edits) — avoids destroying possibly-recoverable data.
4. **Empty plan** (no rooms, no symbols): `serialize` still valid but `saveNow` treats a plan
   with zero geometry as `"empty"` and writes it (so Reset persists emptiness); `planBBox`
   returns `null` → export buttons disabled (nothing to draw); Share still works but produces
   a link to an empty plan (acceptable).
5. **Malformed share hash** (truncated, tampered, wrong codec prefix, decompress error):
   `decode` returns `null` (all failures caught) → toast "Couldn't open that link" and fall
   through to stored/empty. Never throws to the user.
6. **Share link opened with a local plan present** → conflict banner (Frontend §2); never
   silent clobber.
7. **Very large plan → URL too long for target platform** (some messengers truncate ~2–8k):
   compression keeps typical plans small; if `encode` output exceeds a soft cap
   (`~12000` chars), the Share popover shows a warning ("This plan is large — the link may not
   work everywhere; use Export JSON to be safe") but still offers the link.
8. **`CompressionStream` unsupported** (older Safari): fall back to uncompressed base64url
   with the codec prefix; `decode` reads the prefix and picks the matching path. Links remain
   cross-compatible in both directions.
9. **Imported JSON from a future schema `v`**: `validate` rejects unknown major `v` → toast
   "This file is from a newer version"; no partial load.
10. **Imported JSON wrong shape** (not a floorplan file, missing `app`/`rooms`): `validate`
    returns `null` → toast "Not a valid floorplan file"; current plan untouched.
11. **Id collisions after load** (loaded ids like `w3`, `s5`): counters reseeded to
    `max(existing numeric suffix)+1`; a non-numeric/absent suffix is skipped in the max so a
    hand-edited id can't wedge the sequence.
12. **PNG of an off-screen/huge plan**: PNG rasterizes from the *model bbox*, not the
    viewport, so pan/zoom is irrelevant; canvas dimension is clamped to `maxPx` (e.g. 4096)
    with aspect preserved to avoid OOM on giant plans.
13. **Fonts in exported SVG/PNG**: dimension labels use a generic monospace family in inline
    styles (no external font fetch) so the artifact renders identically offline and on the
    recipient's machine; do not rely on the DM Mono web font being present.
14. **Reload mid-draw** (active `model.chain`): chain is not persisted; committed rooms
    restore, draft is dropped. No crash.
15. **Autosave vs pan/zoom**: view changes trigger renders but not model changes; the
    string-equality guard in `saveNow` prevents redundant writes.
16. **Two tabs, same origin**: last-write-wins; opening tab B does not live-update tab A
    (no `storage` listener in v1). Documented limitation, not a bug.
17. **Clipboard API blocked** (non-secure context / permissions): `writeText` rejects →
    fall back to selecting the link field text and prompting "Press Ctrl/Cmd+C".
18. **Hash present but empty (`#` only) / unrelated hash**: `readHash` returns `null` for a
    hash without the `plan=` marker → normal restore path.

## Dependencies

**Must exist before implementation (all present):**
- `walls.js` — serializable `model.rooms`, geometry helpers (LLD 4). Adds
  `replaceRooms`/`clearAll` + counter reseed here.
- `symbols.js` — serializable `model.symbols`, catalog, geometry (LLD 12). Adds
  `replaceSymbols`/`clearAll` + counter reseed here.
- `view.js` — projection contract; adds `fitView` (LLD 2).
- `surface.js` — `render()` / `scheduleRender()` / `onRender()` render loop; autosave hooks
  onto `onRender` (LLD 2).
- `units.js` — `fmtLen`/`unitLabel` for dimension labels in SVG/PNG export (LLD 9).
- `wallRender.js` / `symbolRender.js` — reference geometry/styling for the standalone SVG
  builder (do not import their screen-space render; replicate world-space draw in
  `exporter.js` to keep the export self-contained).
- `main.js` — boot wiring point for `actionsUI.boot()` + `onRender(persist.scheduleSave)`.
- `index.html` — hosts the new actions cluster / banner / popover / pill markup + CSS.

**Platform:** native `CompressionStream`, `Blob`/`URL.createObjectURL`, `<canvas>.toBlob`,
`navigator.clipboard` — all with graceful fallbacks per Edge Cases. **No new npm/library
dependency; no build step** (per CLAUDE.md deploy-cheap principle).

**Downstream:** Phase 3 / #4 accounts+sync will layer on top of `serialize`/`deserialize`
(reuse the `PlanDoc` shape as the sync payload). Keep `PlanDoc` stable and versioned.

## Test Requirements

**Unit (pure, DOM-free — the priority, mirrors existing walls/symbols test style):**
- `serialize` → `deserialize` round-trips `rooms` (closed + open) and `symbols` with **bit-
  exact** coordinates (no precision loss). Deep-clone: mutating the live model after load does
  not affect a previously-serialized doc and vice-versa.
- `validate`: accepts a good doc; rejects null, wrong `app`, missing `rooms`, future `v`,
  non-array fields, NaN/Infinity coordinates, out-of-catalog symbol types.
- Counter reseed: after loading rooms `[w0,w3]` / symbols `[s2]`, a newly created room/symbol
  gets a non-colliding id; non-numeric suffixes are ignored.
- `encode`/`decode` round-trip a `PlanDoc` losslessly (both compressed and
  uncompressed-fallback paths); `decode` of tampered/truncated/garbage input returns `null`,
  never throws.
- `planBBox`: correct bbox for mixed rooms+symbols (including rotated symbols via `corners`);
  `null` for empty plan.
- `fitView`: given a bbox and viewport, the bbox maps within the padded viewport at the
  chosen zoom (clamped to MIN/MAX_ZOOM).

**Integration (jsdom or manual, DOM present):**
- Autosave: model change → after debounce, `STORAGE_KEY` holds the serialized plan; identical
  re-render does not rewrite (spy on `setItem`).
- Boot restore: seed `STORAGE_KEY`, boot → models populated, view fit, "Restored" banner.
- Boot conflict: seed storage + hash → conflict banner; "Open shared" loads shared + clears
  hash; "Keep mine" keeps stored + clears hash.
- Import JSON: valid file loads; invalid/foreign file leaves current plan untouched + toast.
- Reset: overflow → confirm → models empty, empty slot persisted, view reset.
- Export: `exportSVG` produces a well-formed standalone `<svg>` that parses; `exportPNG`
  produces a non-empty PNG Blob; downloads trigger with correct filenames.
- Failure modes: stub `localStorage.setItem` to throw → status "error" pill, app still usable;
  stub `CompressionStream` absent → uncompressed share path still round-trips.

**Security / robustness:**
- **No code execution from untrusted input**: share hash and imported JSON are parsed as
  data only (`JSON.parse`, never `eval`/`Function`); string fields (ids) are never injected
  as HTML — SVG/PNG builders emit numeric attributes and escape any text content.
- **XSS via crafted plan**: room/symbol ids and any text rendered into the exported SVG are
  XML-escaped; a malicious `id` cannot break out of an attribute or inject markup.
- **No exfiltration**: assert (by code review + a network-quiet integration check) that
  encode/decode/save/export make **zero** network requests — nothing hits a server, per the
  hard constraint.
- **DoS guard**: oversized decompressed payloads are bounded (reject a `PlanDoc` whose
  `rooms`/`symbols` counts exceed a sane cap, e.g. 10k, before allocating render structures).

**Acceptance mapping:**
- *Reload restores* → Boot restore + Autosave integration tests.
- *JSON round-trips losslessly* → serialize/deserialize + import unit tests.
- *Exported PNG/SVG presentable* → Export integration + manual QA (send to landlord check).
- *Shared link reopens exact plan, no account/backend* → encode/decode round-trip +
  network-quiet check + manual cross-device QA.
