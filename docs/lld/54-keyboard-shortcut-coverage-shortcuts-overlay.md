# LLD 54: Full keyboard-shortcut coverage + complete the shortcuts overlay

Phase-2 editing polish (parent #3, order 2 of 5). Rounds out keyboard control of the
editor and guarantees the `?` help overlay lists every active shortcut, with correct
mac (⌘) vs non-mac (Ctrl) rendering. Builds directly on the shortcut handling added in
LLD 21 (the single global editing-shortcut keydown handler in `main.js`, the
capture-phase `help.js` overlay, and the existing `help-overlay` markup in
`src/index.html`). No new subsystem.

## Scope

**In scope** — the finalized shortcut set (candidate list from the issue, trimmed to what
is cheap and non-conflicting on the existing model):

| Group | Action | Key(s) | Owner (existing / new) |
| --- | --- | --- | --- |
| Tools | Draw wall | `W` | wallTool `_onKeyDown` (existing) |
| Tools | Select | `V` | wallTool `_onKeyDown` (existing) |
| Edit | Undo | `Ctrl/Cmd+Z` | main.js global handler (existing) |
| Edit | Redo | `Ctrl+Shift+Z` / `Ctrl+Y` | main.js global handler (existing) |
| Edit | Delete selected | `Del` / `Backspace` | main.js global handler (existing) |
| Edit | Duplicate selected | `Ctrl/Cmd+D` | main.js global handler (existing) |
| Object | Nudge selected symbol | `↑ ↓ ← →` | **new**, main.js global handler |
| Object | Coarse nudge | `Shift+↑↓←→` | **new**, main.js global handler |
| Object | Rotate selected 90° | `R` (`Shift+R` = −90°) | **new**, main.js global handler → symbolTool |
| View | Zoom in | `+` / `=` | **new**, main.js → interactions/view |
| View | Zoom out | `−` / `_` | **new**, main.js → interactions/view |
| View | Zoom to fit | `Shift+1` (and `0` reset) | **new**, main.js → view/fit |
| Snap | Toggle persistent grid-snap | `S` | **new**, main.js → prefs (coordinate w/ #29) |
| Snap | Free snap (momentary) | `Alt` (held) | symbolTool/wallTool (existing) |
| Chain | Finish chain | `Enter` | wallTool `_onKeyDown` (existing) |
| Chain | Remove last point (drawing) | `Backspace` | wallTool `_onKeyDown` (existing) |
| General | Deselect / cancel | `Esc` | help.js + symbolTool + wallTool (existing + extended) |
| Help | Toggle shortcuts overlay | `?` | help.js (existing) |

**Explicitly NOT in scope**
- **Rebindable / user-customizable shortcuts** — out of scope per the issue.
- **Select-all / copy-paste across the OS clipboard.** There is no multi-select model
  (selection is a single symbol, LLD 21), and clipboard interop is a separate feature.
  `Ctrl/Cmd+D` duplicate already covers the "copy this object" need cheaply; adding a
  bespoke copy/paste buffer is deferred (noted under Edge Cases as a rejected candidate).
- **Wall/room selection or nudge.** Nudge/rotate act on the selected *symbol* only, matching
  the LLD 21 selection contract (`symbolTool._selectedId`). No room/wall keyboard editing.
- **Panning by keyboard** (arrow keys are claimed for nudge; pan stays pointer/Space-drag).
- Any change to undo/redo internals, the history stack, or persistence — this LLD only adds
  new *dispatch* into existing mutation + commit paths.

## Approach

### Key decisions

1. **Extend the existing single global handler; do not add competing listeners.** All new
   editing/object/view/snap shortcuts are added to the one bubble-phase `window` keydown
   listener already registered in `main.js` (lines 283–335). New branches slot in after the
   existing undo/redo/duplicate/delete branches. This keeps one owner for editing keys,
   preserves the LLD 21 GAP-1 delete-ownership resolution, and avoids ordering hazards
   between multiple window listeners.

2. **One shared editable-focus guard, reused verbatim.** The existing guard
   (`tag === "INPUT" || "TEXTAREA" || "SELECT"` → early return) already sits at the top of
   the main.js handler. Every new shortcut lives *below* that guard, so dimension-entry
   typing is never hijacked (hard requirement 1). The `help.js` and `wallTool` handlers keep
   their own identical guards (unchanged). Factor the check into a tiny local helper
   `_isEditableTarget()` in main.js for readability, but its behavior is identical.

3. **Nudge routes through the existing symbol mutation + commit path.** Arrow keys call a new
   `symbolTool.nudgeSelected(dx, dy)` which mutates via the existing `moveSymbol(sym, x, y)`
   and, on key-up debounce (see decision 4), calls the injected `_historyCommit()`. This
   reuses the LLD 21 commit plumbing (`setHistoryAndToast`) so nudge is undoable with no new
   history code. Nudge does **not** run snap resolution — it applies a literal grid-step
   delta so repeated presses accumulate predictably.

4. **Coalesce a run of nudges into one undo step.** Holding/repeating an arrow key fires many
   `keydown` events. Each moves the symbol immediately (responsive), but the history
   `commit()` is deferred with a short debounce timer (`NUDGE_COMMIT_MS = 400`) that resets
   on every nudge and fires once the user pauses. Result: one arrow tap = 1 undo step; a
   burst of taps within 400 ms = 1 undo step. This mirrors the "per-committed-gesture"
   granularity principle of LLD 21 and avoids polluting the undo stack. A pending nudge is
   also flushed immediately on any other committing action (delete, duplicate, tool switch,
   undo/redo) so ordering is never scrambled — implemented by `symbolTool.flushNudge()`
   called at the top of those paths.

5. **Nudge step = current grid step; Shift = coarse.** Fine step = `snapStep()` from
   `grid.js` when non-null (Auto/0.25/0.1/0.025 m), falling back to `0.1 m` when snap is
   "off". `Shift` multiplies by 4 for a coarse step. This keeps nudge consistent with the
   snapping the user already sees, satisfying "sensible grid step" (hard requirement 3).
   Rationale for grid-step over a fixed px: it stays meaningful across zoom levels and
   matches on-canvas snapping.

6. **Rotate `R` reuses the inspector rotate path.** `R` calls a new
   `symbolTool.rotateSelected(90)` / `Shift+R` → `rotateSelected(-90)`, which is exactly the
   body of the existing `_onRotate90` (rotate + commit + render) generalized to a signed
   delta. `_onRotate90` is refactored to call `rotateSelected(90)`. No new mutation logic.

7. **Zoom + fit reuse `view.js` / `interactions.js`.** `main.js` already imports
   `resetView`, `fitToContent`, `W`, `H`, and `contentBounds` (from `exportImg.js`).
   Keyboard zoom-in/out call `view.zoomAbout(W/2, H/2, factor)` about viewport center with
   the same `1.25` factor the rail zoom buttons use, then `scheduleRender()`. Zoom-to-fit
   reuses the boot/template path: `const b = contentBounds(); b ? fitToContent(b, W, H) :
   resetView(W, H)`. `0` maps to `resetView` (matches the `#btn-zoom-reset` button). To avoid
   duplicating the `1.25`/center logic, expose `interactions.zoomInStep()` /
   `zoomOutStep()` / `zoomReset()` wrappers around the existing private `_stepZoom`/`_onReset`
   and call those from the main.js handler. **Zoom is not undoable** (LLD 21 excludes view
   from history — unchanged).

8. **Snap toggle `S` flips the persistent `prefs.gridSnap`.** `S` calls
   `prefs.toggleGridSnap()` (already exists, persists to localStorage, fires
   `onPrefsChange`). The HUD grid-toggle button (`#hud-grid-toggle`) already listens on
   `onPrefsChange`, so its label updates automatically — no extra wiring. **Coordination with
   #29 (snapping cluster):** `S` toggles the *persistent snap on/off* preference
   (`prefs.gridSnap`), NOT the snap-*precision* mode (`grid.cycleSnapMode`, bound to the HUD
   chip click). Precision cycling stays mouse-only via the chip to keep a single, learnable
   keyboard control; the overlay labels `S` as "Toggle snapping". A brief confirming toast
   ("Snapping on" / "Snapping off") gives feedback since the toggle is otherwise silent.
   If #29 renames the pref API, this shortcut binds to whatever the cluster exposes as the
   persistent on/off toggle.

9. **`R` / `S` / arrows / `+ − 0` all sit in the main.js global handler, gated below the
   editable guard and below the modifier checks.** Bare letter/arrow keys must NOT fire while
   `Ctrl`/`Cmd` is held (that space is reserved for undo/redo/dup and browser chords), so each
   bare-key branch is guarded by `if (meta) return;`-style checks — except the ones that are
   intentionally chords. `W`/`V` remain owned by `wallTool._onKeyDown` (unchanged) to avoid
   moving tool logic; `R`/`S`/arrows/zoom are new and live in main.js because they touch
   symbolTool/view/prefs which main.js already wires.

10. **Overlay parity is derived from a single source list.** To guarantee "no dead entry, no
    missing entry" (hard requirement 2, a QA checkpoint), the help overlay is rendered from a
    single `SHORTCUTS` data array in `help.js` rather than hand-maintained `<tr>` markup. Each
    entry declares its keys per-platform; `help.js` builds the table rows on `init()`, picking
    the mac vs non-mac chord via the same `_isMac` detection used for tooltips. The static
    `<tr>` rows currently in `index.html` are removed in favor of a single
    `<tbody id="help-table-body">` that `help.js` populates. This makes the handler set and
    the overlay share one list, so they cannot drift.

### Module plan

- **`src/js/main.js`** — extend the existing global keydown handler with new branches:
  arrow nudge, `R`/`Shift+R` rotate, `+`/`=`/`−`/`0`/`Shift+1` zoom, `S` snap toggle. Add a
  local `_isEditableTarget()` helper. Import the new symbolTool exports
  (`nudgeSelected`, `rotateSelected`, `flushNudge`), `interactions` zoom wrappers,
  `toggleGridSnap` from `prefs.js`, `contentBounds` (already imported), and pass `showToast`
  for the snap-toggle feedback (already imported). No second listener is added.
- **`src/js/symbolTool.js`** — add `nudgeSelected(dx, dy)`, `rotateSelected(deg)`,
  `flushNudge()`; internal nudge debounce timer. Refactor `_onRotate90` to call
  `rotateSelected(90)`. Call `flushNudge()` at the top of `deleteSelected`,
  `duplicateSelected`, and `onDrawModeEnter` so a pending nudge commits before the next
  gesture. No change to selection or inspector logic.
- **`src/js/interactions.js`** — export thin `zoomInStep()`, `zoomOutStep()`, `zoomReset()`
  wrappers around the existing private `_stepZoom(1.25)` / `_stepZoom(1/1.25)` / `_onReset`,
  so keyboard zoom and the rail buttons share one implementation.
- **`src/js/help.js`** — add the `SHORTCUTS` data array + a `_renderTable()` called from
  `init()` that fills `#help-table-body`, choosing mac/non-mac chords. Everything else
  (toggle, capture-phase Esc, outside-click) is unchanged.
- **`src/index.html`** — replace the hand-written `<tr>` rows in `#help-overlay` with an
  empty `<tbody id="help-table-body">`. No other markup change (button, overlay chrome,
  styles all already present).
- **`src/js/wallTool.js`** — no functional change; its `_onKeyDown` already owns `W`/`V`/
  `Enter`/`Backspace`/`Esc` and the `isHelpOpen()` guard. (Confirm `R`/`S`/arrows are NOT
  claimed there — they are not.)

### Rejected candidates (documented, not built)
- **Copy/paste + select-all** — no multi-select model; duplicate covers the cheap case.
- **Arrow-key panning** — arrows are used for nudge; pan stays Space-drag / pointer.
- **Keyboard snap-precision cycling** — kept mouse-only (chip) to avoid a confusing second
  snap key; `S` owns the on/off toggle only (see decision 8).

## Interfaces / Types

### `symbolTool.js` — new exports

```js
/**
 * Move the selected symbol by (dx, dy) world metres. No-op if nothing selected.
 * Applies the delta literally (no snap resolve), repositions inspector, renders.
 * Schedules a debounced history commit (NUDGE_COMMIT_MS) so a burst of nudges
 * collapses into a single undo step.
 */
export function nudgeSelected(dx, dy): void

/**
 * Rotate the selected symbol by `deg` (signed). No-op if nothing selected.
 * = body of the former _onRotate90 with a signed delta: rotateSymbol + commit + render.
 * Rotate commits immediately (discrete gesture, like the inspector button).
 */
export function rotateSelected(deg): void

/**
 * If a nudge commit is pending, cancel the timer and commit now. Safe to call
 * when none pending (no-op). Called before any other committing gesture so
 * undo-stack ordering stays correct (decision 4).
 */
export function flushNudge(): void
```

Internal nudge state (module-private):
```js
const NUDGE_COMMIT_MS = 400;
let _nudgeTimer = null;         // setTimeout handle for the deferred commit
```
`nudgeSelected` body: guard `_selectedId`; `flushNudge()` is NOT called here (we are
accumulating); `const sym = getSymbol(_selectedId); if (!sym) return;`
`moveSymbol(sym, sym.x + dx, sym.y + dy)`; `scheduleRender()`; then
`clearTimeout(_nudgeTimer); _nudgeTimer = setTimeout(() => { _historyCommit?.(); _nudgeTimer = null; }, NUDGE_COMMIT_MS)`.
`flushNudge` body: `if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; _historyCommit?.(); }`.

### `interactions.js` — new exports (thin wrappers)

```js
export function zoomInStep(): void   // = _stepZoom(1.25)
export function zoomOutStep(): void  // = _stepZoom(1 / 1.25)
export function zoomReset(): void    // = _onReset()  (resetView + render)
```

### `main.js` — new handler branches (added to the existing global keydown listener)

Pseudocode inserted after the existing Delete/Backspace branch, all below the shared
editable-focus guard and after `const meta = e.ctrlKey || e.metaKey;`:

```js
// Nudge — bare/Shift arrows, only when a symbol is selected and not a chord
if (!meta && (e.key === "ArrowUp" || "ArrowDown" || "ArrowLeft" || "ArrowRight")) {
  if (!hasSelection()) return;                 // let native scroll happen otherwise
  e.preventDefault();
  const base = snapStep() ?? 0.1;              // grid step, fallback 0.1m
  const step = e.shiftKey ? base * 4 : base;
  const [dx, dy] = dirFor(e.key, step);        // ±step on one axis
  nudgeSelected(dx, dy);
  return;
}

// Rotate — R (Shift+R = CCW), only with a selection, not a chord
if (!meta && (e.key === "r" || e.key === "R")) {
  if (!hasSelection()) return;
  e.preventDefault();
  rotateSelected(e.shiftKey ? -90 : 90);
  return;
}

// Zoom — + / = (in), - / _ (out), 0 (reset), Shift+1 = fit
if (!meta && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoomInStep();  return; }
if (!meta && (e.key === "-" || e.key === "_")) { e.preventDefault(); zoomOutStep(); return; }
if (!meta && e.key === "0")                    { e.preventDefault(); zoomReset();   return; }
if (!meta && e.key === "!")                    { // Shift+1 on US layouts
  e.preventDefault();
  const b = contentBounds();
  b ? fitToContent(b, W, H) : resetView(W, H);
  scheduleRender();
  return;
}

// Snap toggle — S flips persistent gridSnap pref (coordinate w/ #29)
if (!meta && (e.key === "s" || e.key === "S")) {
  e.preventDefault();
  const on = toggleGridSnap();
  showToast(on ? "Snapping on" : "Snapping off");
  scheduleRender();
  return;
}
```
`flushNudge()` is invoked at the top of the undo/redo branches too (so a pending nudge
commits before an undo), and inside `deleteSelected`/`duplicateSelected`/`onDrawModeEnter`
(handled in symbolTool). `dirFor` maps arrow key → `[dx, dy]` (Up = `-y`, Down = `+y`,
Left = `-x`, Right = `+x`).

### `help.js` — overlay data source

```js
/**
 * Single source of truth for the overlay. `mac`/`other` are display chord strings;
 * when equal, one is shown for both. Rendered into #help-table-body on init.
 * @type {{ group:string, action:string, mac:string, other:string }[]}
 */
const SHORTCUTS = [ /* Undo, Redo, Delete, Duplicate, W, V, R, arrows, +/-/0/fit, S,
                       Alt free-snap, Enter finish, Backspace remove-point, ?, Esc */ ];

function _renderTable(isMac) { /* build <tr> rows into #help-table-body */ }
```
`init(refs)` calls `_renderTable(_isMac)` once after wiring listeners. `_isMac` uses the
same detection as `main.js` (`/Mac|iPhone|iPad|iPod/.test(navigator.platform || UA)`).

## State Model

**No new persisted state.** All state touched by this LLD already exists:

- **Selection** — `symbolTool._selectedId` (in-memory). Nudge/rotate read and mutate the
  selected symbol; no change to selection lifecycle.
- **Geometry** — symbol `x`/`y`/`rot` mutated via existing `moveSymbol`/`rotateSymbol`, then
  committed to the LLD 21 history stack via the injected `_historyCommit`. Autosave
  (`store.js` `onRender`) persists as for any edit. Undo/redo of a nudge or rotate works
  because they go through the same commit path.
- **Nudge debounce** — `_nudgeTimer` is transient in-memory only; discarded on reload. It
  never persists and is flushed (committed) before any other gesture.
- **View (zoom/pan)** — mutated via `view.js`; **not** part of history (LLD 21 excludes
  view). Keyboard zoom behaves exactly like the rail buttons.
- **Snap preference** — `prefs.gridSnap` (already persisted to `localStorage:floorplan:prefs:v1`
  by `prefs.setGridSnap`). `S` flips it via `toggleGridSnap()`; the HUD reflects it through the
  existing `onPrefsChange` listener. Snap *precision* mode (`grid._snapMode`) is untouched.
- **Overlay open flag** — `help._open` (in-memory), unchanged.

**Commit lifecycle additions (who calls `history.commit()`):**

| Gesture | Call site | Granularity |
| --- | --- | --- |
| Symbol nudge (arrow keys) | debounced `_nudgeTimer` in `symbolTool` | 1 step per burst (≤400ms gap) |
| Symbol rotate (`R`/`Shift+R`) | `rotateSelected` (immediate) | 1 step per press |

Zoom/fit/reset and snap-toggle are **not** commit points (transient view / preference).

## Frontend Design

Incorporates the CEO frontend decision **Direction B**: *complete and data-drive the
existing overlay rather than add new visible chrome.* No new visual language, no new
on-screen controls — the work is (a) new invisible key bindings and (b) making the existing
`?` overlay authoritative and platform-correct. This keeps the "minimal chrome / instant"
principle and the blueprint aesthetic intact.

1. **Data-driven overlay, grouped and labelled.** The overlay renders from the `SHORTCUTS`
   array (see Interfaces) into the existing `#help-overlay` panel. Rows are grouped by the
   `group` field with a lightweight sub-header row per group (Tools · Edit · Object · View ·
   Snap · Drawing · General) so the (now longer) list stays scannable. Reuses existing
   `.help-table` / `.help-key` / `<kbd>` styles; group headers use a muted variant of the
   existing title token (no new palette entries).

2. **Correct mac vs non-mac rendering.** Each row shows a single chord for the current
   platform, chosen by `_isMac`: e.g. Undo shows `⌘Z` on mac, `Ctrl+Z` elsewhere; Redo shows
   `⇧⌘Z` vs `Ctrl+Shift+Z`. This replaces the current always-both `⌘Z / Ctrl+Z` rows, which
   are noisy and imply both work on every platform. Modifier glyphs: mac `⌘ ⇧ ⌥`, other
   `Ctrl+ Shift+ Alt+`. Arrow keys render as `↑ ↓ ← →`.

3. **Every active shortcut appears; nothing dead.** Because the handler branches and the
   overlay both derive from the same list conceptually (the `SHORTCUTS` array is the overlay's
   copy and must match the implemented branches), the QA parity check is a direct table:
   each `SHORTCUTS` row maps to exactly one implemented branch, and every implemented branch
   has a row. New rows added vs today: Nudge, Coarse nudge, Rotate, Zoom in/out, Zoom to fit,
   Reset zoom, Toggle snapping. The stale "Grid chip / cycle snap precision" row stays (it is
   a real mouse affordance, labelled as a chip not a key) — but is moved under a "Mouse"-style
   note so it is not mistaken for a dead keyboard entry.

4. **No new buttons.** The `?` help button and overlay chrome are unchanged. Nudge/rotate/
   zoom/snap have no new on-screen controls (they mirror existing rail/inspector/HUD
   affordances), consistent with Direction B.

5. **Feedback for otherwise-silent shortcuts.** `S` (snap toggle) shows a transient toast
   ("Snapping on/off") reusing `#toast`; the HUD grid-toggle chip also updates via
   `onPrefsChange`. Rotate/nudge are visually self-evident on the canvas (the symbol moves),
   so no toast. Zoom updates the HUD zoom readout as today.

**Accessibility:** the overlay remains `role="dialog"` / `aria-modal="true"` and
keyboard-dismissable (`Esc`). Rendered `<kbd>` chords are readable text. No focus-trap change
from LLD 21. New shortcuts are all optional accelerators for actions already reachable by
pointer, so no keyboard-only capability regresses.

## Edge Cases

1. **Focus in a text field.** All new shortcuts sit below the shared
   `INPUT/TEXTAREA/SELECT` guard in the main.js handler, so typing a dimension (e.g. `2.5`,
   or `s`/`r` inside a numeric/text chip) is never hijacked (hard requirement 1). Verified
   against the existing guard at main.js line 285–286.

2. **Arrow keys with no selection.** If nothing is selected, the nudge branch returns
   *without* `preventDefault`, so arrows keep their native behavior (page scroll) — we only
   consume them when we actually nudge. No stray behavior.

3. **Nudge burst = one undo step.** Rapid/held arrows move immediately but commit once after
   a 400 ms pause (debounce). A single tap also commits once (after the pause). Undo then
   reverts the whole run to the pre-nudge position — matching per-gesture granularity.

4. **Interleaving a nudge with another gesture.** If a nudge is pending (timer live) and the
   user deletes/duplicates/switches tool/undoes, `flushNudge()` commits the nudge first so the
   undo stack stays correctly ordered (no "delete then nudge" inversion). `flushNudge()` is a
   no-op when nothing is pending.

5. **Nudge on a deleted/absent symbol.** `nudgeSelected` re-reads `getSymbol(_selectedId)` and
   returns if null (selection cleared underneath it), so a stale timer firing after delete is
   harmless; and `deleteSelected` flushes/clears first anyway.

6. **`R` / `S` collision with tool keys.** `W`/`V` are owned by `wallTool._onKeyDown`; `R`/`S`
   are new and unused elsewhere. Both handlers share the same editable-focus guard, so neither
   fires while typing. `R`/`S` are consumed (`preventDefault`) by main.js only when they act;
   they do not reach `wallTool` in a way that changes tool state (wallTool ignores `R`/`S`).

7. **`Ctrl/Cmd` chords must not trigger bare-key actions.** Every bare-letter/arrow/zoom
   branch is guarded by `!meta`, so `Cmd+R` (reload), `Cmd+S` (browser save), `Cmd+0`
   (browser zoom reset), `Cmd++`/`Cmd+-` (browser zoom) all pass through to the browser
   untouched. We deliberately do **not** intercept browser zoom chords.

8. **`Shift+1` vs `!` across layouts.** On US layouts Shift+1 yields `e.key === "!"`; we match
   `"!"`. `0` (reset) and `+`/`=`/`-`/`_` cover the common zoom keys. Non-US layouts where
   these glyphs differ still get zoom via the rail buttons and wheel; keyboard zoom is an
   accelerator, not the only path (acceptable; noted for QA).

9. **Nudge step when snapping is off.** `snapStep()` returns `null` in "off" mode; nudge falls
   back to `0.1 m` fine / `0.4 m` coarse so the keys still do something sensible. When snap is
   on, the step tracks the visible grid (Auto/0.25/0.1/0.025 m).

10. **Rotate is immediate, nudge is debounced — mixed.** Pressing `R` while a nudge is pending:
    `rotateSelected` should also `flushNudge()` first (add the call) so the pending nudge and
    the rotate are separate, correctly-ordered undo steps. (Cheap: add `flushNudge()` at the
    top of `rotateSelected` too.)

11. **Overlay open + shortcut keys.** While the help overlay is open, `help.js` capture-phase
    listener only consumes `?` and `Esc`; other keys still bubble to the main.js handler. That
    is acceptable — nudging/rotating with the cheat sheet open is harmless. `Esc` closes the
    overlay only (LLD 21 GAP-3 guarantee, unchanged).

12. **Zoom-to-fit with an empty plan.** `contentBounds()` returns null when there is no
    geometry; the branch falls back to `resetView(W, H)` (same as boot). No crash.

13. **Repeat-rate flooding.** Held arrows fire many keydowns; each `moveSymbol` + `scheduleRender`
    is cheap and render coalesces. The debounce ensures only one commit + one autosave write per
    burst. No unbounded history growth.

14. **Snap toggle coordination with #29.** `S` binds to the persistent snap on/off pref only.
    If #29 restructures the snapping cluster (e.g. merges on/off into the precision presets),
    rebind `S` to whatever that cluster exposes as the boolean toggle and keep the overlay
    label as "Toggle snapping". Precision cycling stays a mouse-only chip (no key) to avoid a
    confusing second snap key.

15. **Overlay parity drift (QA checkpoint).** The `SHORTCUTS` array must list exactly the
    active bindings. A test asserts the array’s action set equals the documented set and that
    mac/other chords are non-empty, catching a future added-handler-but-forgot-overlay-row (or
    vice versa) regression.

## Dependencies

All already merged; this LLD only extends them:
- **`main.js`** — the single global editing-shortcut keydown handler (lines 283–335) and the
  `_isMac` detection. **[present, to be extended]**
- **`symbolTool.js`** — `_selectedId`, `hasSelection`, `getSymbol`, `moveSymbol`,
  `rotateSymbol`, injected `_historyCommit` (via `setHistoryAndToast`), `_onRotate90`,
  `deleteSelected`, `duplicateSelected`, `onDrawModeEnter`. **[present, to be extended]**
- **`symbols.js`** — `moveSymbol`, `rotateSymbol` (mutators). **[present]**
- **`view.js`** — `zoomAbout`, `resetView`, `fitToContent`, `W`/`H` via surface. **[present]**
- **`interactions.js`** — private `_stepZoom`/`_onReset` to wrap as exports. **[present, to be extended]**
- **`grid.js`** — `snapStep()` for the nudge step. **[present]**
- **`prefs.js`** — `toggleGridSnap()`, `onPrefsChange` (HUD already listens). **[present]**
- **`help.js`** — `init`, capture-phase Esc, `isOpen`. **[present, to be extended with `SHORTCUTS` + `_renderTable`]**
- **`exportImg.js`** — `contentBounds()` for zoom-to-fit (already imported by main.js). **[present]**
- **`actions.js`** — `showToast` for the snap-toggle feedback (already imported). **[present]**
- **`index.html`** — `#help-overlay` panel + `.help-table`; replace static `<tr>` rows with
  `<tbody id="help-table-body">`. **[present, to be edited]**

**Coordination:** the persistent snap-toggle shortcut (`S`) must align with the snapping
cluster in **#29** — bind to whatever that work exposes as the on/off pref (currently
`prefs.gridSnap` / `toggleGridSnap`). No hard code dependency; a naming alignment only.

No new third-party dependencies. No build step. Vanilla ES modules only.

## Test Requirements

Tests live in the in-browser harness `src/tests.html` (`describe`/`it`/`expect`), run
headless via `.github/run-tests.mjs`. Favor pure dispatch-logic tests that don't need real
key events where practical.

**Unit — nudge / rotate dispatch (`symbolTool`):**
- `nudgeSelected(dx,dy)` with a selected symbol moves it by exactly `(dx,dy)` (no snap
  resolution applied); no-op when nothing selected or symbol missing.
- `rotateSelected(90)` / `rotateSelected(-90)` change `rot` by ±90 (normalised to `[0,360)`);
  no-op when nothing selected.
- `flushNudge()` with a pending timer calls `_historyCommit` once and clears the timer; is a
  no-op when nothing pending. (Inject a spy commit via `setHistoryAndToast`.)
- Nudge debounce: N rapid `nudgeSelected` calls schedule exactly **one** commit after the
  quiet window (assert spy commit count == 1 after advancing/awaiting the timer).
- `deleteSelected`/`duplicateSelected`/`rotateSelected` flush a pending nudge first (spy
  commit fires for the nudge before the gesture’s own commit).

**Unit — nudge step selection (helper logic):**
- Step derives from `snapStep()` when non-null; falls back to `0.1 m` when snap is "off";
  `Shift` yields 4× the base step. (Test the small pure `stepFor(shift)` helper.)

**Unit — overlay parity (`help.SHORTCUTS`):**
- The `SHORTCUTS` action set equals the documented active-shortcut set (no missing/dead
  entries — the QA parity checkpoint).
- Every entry has non-empty `mac` and `other` chord strings.
- `_renderTable(true)` vs `_renderTable(false)` produce different chord text for at least the
  modifier rows (mac ⌘ vs Ctrl+), proving platform rendering.

**Integration (DOM harness or documented manual):**
- Editable-focus guard: focus a dim input, press each new key (`R`, `S`, arrows, `+`/`-`/`0`)
  → no editor action fires; the input receives the keystroke.
- Arrow nudge moves the selected symbol by the grid step and is undoable (one `Ctrl/Cmd+Z`
  reverts the whole burst); `Shift+arrow` moves 4× as far.
- Arrows with no selection do not `preventDefault` (native scroll allowed).
- `R` rotates the selected symbol +90°, `Shift+R` −90°; each undoable as one step.
- `+`/`=` zoom in, `-`/`_` zoom out, `0` resets, `Shift+1` fits content; HUD zoom updates;
  view is **not** added to the undo stack.
- `S` toggles `prefs.gridSnap`, shows the toast, and the HUD grid-toggle label flips;
  snap *precision* mode is unchanged.
- `Cmd/Ctrl` chords (`Cmd+R`, `Cmd+S`, `Cmd+0`, `Cmd++`) are **not** intercepted (browser
  default preserved).

**Regression:**
- Existing `W`/`V`, undo/redo (`Ctrl/Cmd+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`), delete/duplicate,
  `Enter`/`Esc` finish-chain, `Backspace` remove-point, and `Alt` free-snap all still work.
- `Esc` while the help overlay is open closes only the overlay and does not finish an active
  wall chain (LLD 21 GAP-3 unchanged).
- Delete/Backspace ownership (LLD 21 GAP-1) unchanged: draw-mode chain → vertex removal;
  select-mode selection → single committing delete.
