# LLD 21: MVP-5 — Editing UX (undo/redo, delete, duplicate, keyboard shortcuts)

Phase 5 of 6 of the MVP epic (#1). A cross-cutting editing layer over the wall
model (`walls.js`) and the symbol model (`symbols.js`). Closes the last remaining
functional gap in the core editor.

## Scope

**In scope**
- **Undo/redo** over committed geometry operations, at **per-committed-gesture**
  granularity (a finished room = 1 step; a symbol drag = 1 step). New `history.js`
  snapshot stack.
- **Delete + duplicate** on the current selection — **symbols only** (via the existing
  floating symbol inspector, as today), plus keyboard shortcuts and toast feedback.
- **Core keyboard shortcuts**: undo `Ctrl/Cmd+Z`, redo `Ctrl+Shift+Z` / `Ctrl+Y`,
  delete `Del`/`Backspace`, duplicate `Ctrl/Cmd+D`.
- **Undo/redo rail cluster** (new buttons), destructive-action toast with one-tap Undo,
  duplicate confirmation toast, and a **shortcuts cheat sheet** (`?` key + help button).

**Explicitly NOT in scope**
- **Wall / room selection.** Rooms and wall chains cannot be selected, deleted, or
  duplicated directly in MVP-5. Undo already gives users a path to remove a committed
  room, so there is no functional hole. Full wall/room selection is deferred to Phase 2
  (#3), where the unified "any selectable element" inspector contract lands.
- Full power-user shortcut coverage / ergonomics (Phase 2 polish, #3).
- Undo/redo of **view** (pan/zoom) or **unit** changes — history tracks geometry only.
- Any server/backend involvement (client-side-only invariant holds).

## Approach

### Key decisions

1. **Snapshot-based history, not a command pattern.** The plan model is small, plain,
   JSON-serializable data. On each committed mutation we push a deep clone of the
   geometry (`rooms` + `symbols`) onto an undo stack. This is simpler and more robust
   than per-op inverse commands, and directly reuses the existing serialization plumbing
   (`plan.js` / `hydrate*`). Per implementation guidance (2), we prefer this unless a
   concrete reason emerges — none found.

2. **Per-committed-gesture granularity.** `history.commit()` is called once at the *end*
   of each committed gesture (room close/finish, symbol drop, drag-end, rotate, resize
   commit, delete, duplicate) — never per atomic op. `commit()` dirty-checks against the
   current snapshot and is a no-op when geometry is unchanged (e.g. a tap that only
   selected, or a drag that returned to origin).

3. **Reconcile mid-draw undo, do not duplicate it.** The existing `walls.undoPoint()` +
   `#tool-undo` rail button ("remove last point", `Backspace`) keeps popping vertices of
   the *in-progress* chain during active drawing. The new history stack reverts only
   *committed* operations. The two are visually and functionally distinct (separate rail
   cluster, separate hairline). `history` never touches `model.chain`: snapshots capture
   `rooms` + `symbols` only, and applying a snapshot preserves the live in-progress chain
   (see State Model / Edge Cases).

4. **History drives the same persisted state; it does not fight autosave.** Undo/redo
   mutate the live `walls`/`symbols` models via `hydrate*` and return; the **main.js
   caller** then calls `scheduleRender()` (history itself is DOM-free — see Module plan /
   Interfaces). The existing `store.js` autosave `onRender` hook then debounce-persists
   the resulting state exactly as for any other edit. No new persistence path. Any new
   committed action clears the redo (`future`) stack.

5. **Selection semantics.** "Selected element" = the currently selected **symbol**
   (`symbolTool._selectedId`). There is no room/wall selection in MVP-5. Delete/duplicate
   act on that symbol; the shortcuts are no-ops when nothing is selected. This keeps the
   existing `symbolTool` inspector as the single selection surface.

### Module plan

- **New `src/js/history.js`** — snapshot stack core. **DOM-free and tool-free**; imports
  only the two geometry models it snapshots: `import { model as wallsModel, hydrate as
  hydrateWalls } from "./walls.js"` and `import { model as symbolsModel, hydrate as
  hydrateSymbols } from "./symbols.js"`. (These `hydrate`/`model` symbols live in
  `walls.js` / `symbols.js`, **not** in `plan.js` — `plan.js` is only a *shape reference*
  for the capture/apply payload, not an import.) No import of `surface.js`, `main.js`,
  `symbolTool.js`, or `wallTool.js`, so the graph stays acyclic and the core is
  unit-testable without a DOM. **`history` never calls `render()`** — `undo()`/`redo()`
  mutate the models via `hydrate*` and return; the *caller* (the main.js rail/shortcut
  handler) triggers `scheduleRender()`. Exports `init`, `reset`, `commit`, `undo`,
  `redo`, `canUndo`, `canRedo`, `depth`, `onChange`.
- **New `src/js/help.js`** — shortcuts cheat-sheet overlay controller (toggle on `?`
  key + help button, dismiss on `Esc`/outside click). Static content, one boolean
  `_open`; exports `isOpen()` (see Edge Case 15). Registers a **capture-phase** window
  keydown listener so its `Esc` handling runs before the bubble-phase wall/symbol tool
  listeners.
- **`src/js/main.js`** — wires history into the app: injects `commit()` call sites,
  registers **the single global editing-shortcut keydown handler** (owns
  `Ctrl/Cmd+Z`, `Ctrl+Shift+Z`/`Ctrl+Y`, `Ctrl/Cmd+D`, **and `Del`/`Backspace` for
  symbol delete** — see GAP-1 resolution in Edge Case 5), calls `scheduleRender()` after
  each `undo()`/`redo()`, wires the new rail undo/redo buttons + help button, sets
  platform-correct tooltips, and refreshes button disabled state via `history.onChange`.
- **`src/js/symbolTool.js`** — call `history.commit()` after add/move-end/rotate/
  duplicate/delete; show delete/duplicate toasts; expose `duplicateSelected()`,
  `deleteSelected()`, `hasSelection()` for the global shortcut handler. **Remove the
  `Delete`/`Backspace` branch from the existing private `_onKeyDown` (lines 458-469)** so
  keyboard delete is owned solely by the main.js global handler and always routes through
  the committing `deleteSelected()` (see Edge Case 5). The `_onAltDown`/`_onAltUp` window
  listeners are unaffected; the now-empty `_onKeyDown` listener registration is dropped.
- **`src/js/wallTool.js`** — call `history.commit()` after a room is committed
  (`closeRoom` via `onClick`, and `finishChain` via Enter/Escape/tool-switch/button).
- **`src/js/symbolDimEntry.js`** — call `history.commit()` after a committed w/h resize.
- **`src/js/actions.js`** — extend `showToast(msg, action?)` to optionally render a
  one-tap action button (used for the "Undo" affordance).
- **`src/index.html`** — add rail undo/redo buttons, a `?` help button near the zoom
  cluster, and the cheat-sheet overlay markup + styles (reusing existing chrome/tokens).

## Interfaces / Types

### `history.js`

```js
/**
 * @typedef {{ rooms: import("./walls.js").Room[],
 *             symbols: import("./symbols.js").Sym[] }} GeomSnapshot
 */

/** Wire optional onChange listener refresh; seed baseline from current live state. */
export function init(): void

/**
 * Reset the stack and reseed the baseline from current live geometry.
 * Called after boot-restore and after Reset-plan so undo can't cross those.
 */
export function reset(): void

/**
 * Capture current live geometry. If it is identical (stable-stringify) to the
 * current baseline, no-op. Otherwise push the prior baseline onto `past`,
 * make the new capture the baseline, and clear `future`. Notifies onChange.
 */
export function commit(): void

/** Revert to the previous committed snapshot. No-op when !canUndo(). Returns applied?. */
export function undo(): boolean

/** Re-apply the next snapshot. No-op when !canRedo(). Returns applied?. */
export function redo(): boolean

export function canUndo(): boolean   // past.length > 0
export function canRedo(): boolean   // future.length > 0

/** Current undo depth (`_past.length`). Used by the delete toast to scope its
 *  one-tap Undo to the step it created (see Edge Case 14). */
export function depth(): number

/** Register a listener fired after any stack change (for rail button state). */
export function onChange(cb: () => void): void
```

Internal state:
```js
let _past    = /** @type {GeomSnapshot[]} */ ([]); // prior states, oldest→newest
let _present = /** @type {GeomSnapshot|null} */ (null); // current baseline
let _future  = /** @type {GeomSnapshot[]} */ ([]); // redo stack
const MAX_DEPTH = 100; // cap; drop oldest past entry beyond this (tiny data, generous)
```

Imports (DOM-free, tool-free — see Module plan):
```js
import { model as wallsModel,   hydrate as hydrateWalls   } from "./walls.js";
import { model as symbolsModel, hydrate as hydrateSymbols } from "./symbols.js";
```

Capture / apply (reuses existing `walls.hydrate`/`symbols.hydrate`, chain-preserving):
```js
function _capture() {                    // deep clone geometry only
  return {
    rooms:   JSON.parse(JSON.stringify(wallsModel.rooms)),
    symbols: JSON.parse(JSON.stringify(symbolsModel.symbols)),
  };
}
function _apply(snap) {                   // mutate models only; NO render here
  hydrateWalls({ rooms: snap.rooms, chain: [...wallsModel.chain] }); // preserve live chain
  hydrateSymbols({ symbols: snap.symbols });
  // history NEVER calls render(); the main.js caller triggers scheduleRender()
}
```

`undo()` = push `_present`→`_future`, pop `_past`→`_present`, `_apply(_present)`, notify
onChange, return `true`. **No render call** — the main.js rail/shortcut handler calls
`scheduleRender()` after a truthy return.
`redo()` = push `_present`→`_past`, pop `_future`→`_present`, `_apply(_present)`, notify
onChange, return `true`. Same caller-triggers-render contract.

### `actions.js` — toast with optional action

```js
/**
 * @param {string} msg
 * @param {{ label:string, onClick:()=>void }} [action]  optional one-tap button
 */
export function showToast(msg, action)
```
When `action` is present, the toast renders a trailing button (e.g. "Undo") wired to
`action.onClick`; clicking it dismisses the toast immediately. Auto-dismiss timer
unchanged (`TOAST_DURATION_MS`). Backward compatible — existing single-arg callers keep
working.

### `symbolTool.js` — exposed for global shortcuts

```js
export function hasSelection(): boolean        // _selectedId !== null
export function duplicateSelected(): void       // = current _onDuplicate + commit + toast
export function deleteSelected(): void          // = _deleteSelected + commit + toast+undo
```

### `help.js`

```js
export function init(refs: { button: Element, overlay: Element }): void
export function toggle(): void     // show/hide cheat sheet
export function isOpen(): boolean  // true while the overlay is shown (see Edge Case 15)
```
`init` registers a **capture-phase** window keydown listener
(`window.addEventListener("keydown", onKey, true)`) so `Esc` handling pre-empts the
bubble-phase wall/symbol tool listeners.

## State Model

**Persisted (localStorage / URL hash):** unchanged — the full `Plan` (rooms, chain,
symbols, view, unit) via `store.js` autosave and `share.js`. Undo/redo write through the
live models and let the existing autosave `onRender` hook persist the result.

**History stack (in-memory only, never persisted):** `{ past[], present, future[] }` of
`GeomSnapshot` (`rooms` + `symbols` deep clones). Discarded on reload; a reloaded plan
starts with an empty stack (baseline = restored geometry). This matches the "instant,
fun to poke at" bar and avoids persisting an unbounded stack.

**Commit lifecycle (who calls `history.commit()`):**

| Gesture | Call site | Notes |
| --- | --- | --- |
| Room closed | `wallTool.onClick` when chain→0 via close snap | 1 step |
| Chain finished (Enter/Esc/tool-switch/Finish button) | `wallTool` finish wrappers | 1 step; `<2` verts discards → dirty-check makes it a no-op |
| Symbol dropped from dock | `symbolTool` dock `_onUp` (successful drop) | 1 step |
| Symbol move-drag end | `symbolTool.onSelectUp` | dirty-check: no-op if unmoved |
| Symbol rotate (drag end + `rotate90` button) | `symbolTool.onSelectUp` / `_onRotate90` | 1 step |
| Symbol resize committed | `symbolDimEntry` commit | 1 step; cancel/no-change = no-op |
| Symbol deleted | `symbolTool.deleteSelected` | 1 step (+ Undo toast) |
| Symbol duplicated | `symbolTool.duplicateSelected` | 1 step (+ toast) |

**Not commit points (transient):** in-progress chain vertex place/pop
(`placeVertex`/`undoPoint`), live drag frames, live rotate frames, pan/zoom, unit toggle.

**Baseline reseed (`history.reset()`):** after boot-restore in `main.js` (all
`applyPlan` branches) and after `actions._confirmReset()`. This makes undo unable to
cross a fresh load or an explicit Reset.

**Rail button state:** `history.onChange` → `main.js` toggles
`#history-undo.disabled = !canUndo()` and `#history-redo.disabled = !canRedo()`.

## Frontend Design

Incorporates the CEO frontend decision (approved as mocked; all reuse existing chrome —
no new visual language):

1. **Undo/redo rail cluster.** Add two buttons to `.tool-rail` **below** the existing
   draw controls, separated by a new `.tool-rail-sep` hairline, so they read as a
   distinct cluster from the draw-mode "remove last point" (`#tool-undo`, `Backspace`):
   - `#history-undo` (curved back-arrow icon), `#history-redo` (mirrored).
   - **Always visible**; `disabled` when the corresponding stack is empty.
   - **Platform-correct chord tooltips** set in JS: `title="Undo (⌘Z)"` /
     `"Redo (⇧⌘Z)"` on macOS, `"Undo (Ctrl+Z)"` / `"Redo (Ctrl+Shift+Z)"` elsewhere.
   - Reuses existing `.tool-rail button` styling incl. the `:disabled` treatment.
   - Included in the mobile collapse/expand behavior like the other rail buttons.

2. **Delete + duplicate stay in the floating symbol inspector** (`#symbol-inspector`),
   exactly as today. Add small key-hint tooltips: duplicate `title="Duplicate (⌘D)"`,
   delete `title="Delete (Del)"` (platform-adjusted). No new controls; no wall/room
   inspector entry (out of scope).

3. **Toast feedback (reuses `#toast`).**
   - **Destructive (delete):** confirming toast **"Deleted"** with a one-tap **Undo**
     button that calls `history.undo()`. Uses the extended `showToast(msg, action)`.
   - **Duplicate:** brief non-actionable toast **"Duplicated"**.

4. **Shortcuts cheat sheet.** A small **`?` help button** placed near the `.zoom-cluster`
   (bottom-right), and pressing **`?`** (Shift+/) opens a centered overlay listing the
   core shortcuts. Dismiss on `Esc`, outside-click, or the button again. Reuses existing
   overlay/menu tokens (blueprint aesthetic); `role="dialog"`, focus-trap not required for
   MVP but the overlay must be keyboard-dismissable. Content:

   | Action | Shortcut |
   | --- | --- |
   | Undo | ⌘Z / Ctrl+Z |
   | Redo | ⇧⌘Z / Ctrl+Shift+Z (or Ctrl+Y) |
   | Delete selected | Del / Backspace |
   | Duplicate selected | ⌘D / Ctrl+D |
   | Draw wall / Select | W / V |
   | Finish chain | Enter · Remove last point Backspace · Free-snap Alt |

   Cheat-sheet rows are rendered with the same platform detection as the tooltips.

**Accessibility:** all new buttons carry `aria-label`; disabled state is real `disabled`
(not just visual). The overlay is `aria-modal="true"` with an accessible label. Toast
`aria-live="polite"` (existing) announces "Deleted"/"Duplicated".

## Edge Cases

1. **Undo while a chain is in progress.** `history` snapshots exclude `model.chain` and
   `_apply` preserves the live chain, so undo/redo revert committed rooms/symbols without
   disturbing the in-progress polyline. `Backspace` still owns single-vertex removal.
   (If no committed step exists yet, `Ctrl+Z` is a no-op — button disabled.)
2. **Dirty-check no-ops.** `commit()` after a tap-select, a zero-distance drag, a resize
   that clamped to the same value, or a `<2`-vertex chain finish must **not** push a
   history entry (stable-stringify equal to baseline). Prevents "dead" undo steps.
3. **Redo invalidation.** Any `commit()` clears `_future`. After undo→new edit, redo is
   unavailable (button disabled).
4. **Delete via keyboard vs inspector.** Both route through the *same* committing
   `symbolTool.deleteSelected()` → single commit + single Undo toast. The inspector's
   Delete button calls `deleteSelected()` directly; keyboard Delete/Backspace reaches it
   only via the main.js global handler (see Edge Case 5 for the single-owner mechanism).
   Selection is cleared after delete; the Undo toast restores geometry but **not** the
   prior selection (acceptable for MVP; symbol reappears unselected).
5. **`Del`/`Backspace` ownership — exactly one handler fires (GAP-1 resolution).** There
   are two window-level keydown listeners that historically reacted to Delete/Backspace:
   `symbolTool._onKeyDown` (private `_deleteSelected`, no commit/toast) and
   `wallTool._onKeyDown` (`undoPoint` in draw mode). To avoid double-handling:
   - **Remove** the `Delete`/`Backspace` branch from `symbolTool._onKeyDown` (lines
     458-469); that listener no longer handles delete at all (its remaining body is empty,
     so the `window.addEventListener("keydown", _onKeyDown)` registration for it is
     dropped). Symbol delete is now owned **solely** by the main.js global editing-shortcut
     handler, which calls the committing `symbolTool.deleteSelected()` exactly once.
   - The main.js handler guards draw mode first: **if `isDrawMode() && model.chain.length
     > 0`, it does nothing on Delete/Backspace** and lets the event reach `wallTool`'s
     listener, which removes the last chain vertex (`undoPoint`) as today. Otherwise, if
     `symbolTool.hasSelection()`, it `preventDefault()`s and calls `deleteSelected()`.
   - `wallTool._onKeyDown`'s `Backspace` branch is **unchanged** and still only fires when
     `_tool === "wall" && model.chain.length > 0`; in select mode it is inert, so there is
     no collision. Net effect: in draw mode with an active chain → vertex removal only; in
     select mode with a selected symbol → committing symbol delete only; never both.
6. **`Ctrl/Cmd+D` browser default.** Decision: the global handler calls `preventDefault()`
   **only when `symbolTool.hasSelection()` is true**, and in that same branch duplicates
   the selected symbol. When nothing is selected, the handler does **not** call
   `preventDefault` and does **not** act — the keystroke passes through to the browser's
   native bookmark behavior. (Rationale: we suppress the bookmark dialog only for
   keystrokes we actually consume, so a stray Ctrl/Cmd+D with no selection behaves
   normally.)
7. **`Ctrl+Z` in an input field.** The dimension-entry inputs and any `INPUT/TEXTAREA/
   SELECT` must be exempt — the global handler returns early when
   `document.activeElement` is editable (mirrors existing guards), so browser-native
   text undo works inside the dim chips.
8. **macOS `Cmd+Shift+Z` vs `Cmd+Y`.** Support redo via `Ctrl+Shift+Z` **and** `Ctrl+Y`
   (Windows convention) and `Cmd+Shift+Z` (mac). `Cmd+Y` is not a mac redo convention but
   is harmless to accept.
9. **Undo restoring `_roomCounter`/`_counter`.** `hydrateWalls`/`hydrateSymbols` already
   resync their id counters from the max id in the applied array, so redo of a
   delete+re-add does not collide ids. Confirmed against `walls.hydrate`/`symbols.hydrate`.
10. **Stack cap.** Beyond `MAX_DEPTH` (100), drop the oldest `_past` entry. Floor-plan
    data is tiny; 100 snapshots is generous and bounds memory.
11. **Reset plan.** `_confirmReset()` must call `history.reset()` after clearing models so
    undo cannot resurrect the wiped plan (Reset is intentionally irreversible, matching
    its existing "This can't be undone" copy).
12. **Boot restore.** After every `applyPlan` branch in `main.js` boot, call
    `history.reset()` so the restored plan is the baseline and undo can't cross the load.
13. **Delete during an open dim edit.** `deleteSelected` cancels an in-progress dim edit
    first (existing `_deleteSelected` already calls `cancelDimEdit()`), then commits.
14. **Toast Undo after further edits.** To avoid the one-tap Undo silently reversing a
    *later, unrelated* committed step: when `deleteSelected()` shows the toast, capture the
    delete's stack depth (e.g. `const at = history.canUndo() ? _pastLengthSnapshot : ...`
    — concretely, expose a lightweight `history.depth()` returning `_past.length` and
    record it at toast-creation time). The toast's Undo `onClick` calls `history.undo()`
    **only if `history.depth()` still equals the recorded value** (i.e. the delete is still
    the top of the undo stack); if the user committed another edit in the meantime the
    stack has grown, so the toast Undo becomes a no-op (and may briefly flag "nothing to
    undo" or simply do nothing). This keeps the affordance scoped to the delete it belongs
    to. The toast still auto-dismisses in `TOAST_DURATION_MS` (~3.5s) regardless.
15. **Help overlay + Esc — concrete ordering guarantee (GAP-3 resolution).** When the
    cheat sheet is open, `Esc` must close *only* the overlay and must **not** fall through
    to `wallTool._onKeyDown`'s draw-mode `Esc` (finish-chain), which is a bubble-phase
    window listener with no overlay awareness. Two bubble-phase window listeners are not
    ordered by `stopPropagation`, and the LLD drops focus-trap for MVP, so we cannot rely
    on either. Guarantee instead by **both** of:
    - `help.js` registers its keydown listener on `window` in the **capture phase**
      (`addEventListener("keydown", handler, true)`). Capture-phase listeners run before
      any bubble-phase listener regardless of registration order. When the overlay is open
      and the key is `Esc`, `help.js` closes the overlay and calls
      `e.stopPropagation()` + `e.preventDefault()`, so the event never reaches the
      bubble-phase `wallTool`/`symbolTool` listeners.
    - **Belt-and-suspenders:** `wallTool._onKeyDown`'s `Escape` branch adds a guard
      `if (help.isOpen()) return;` before `finishChain()`. This keeps the guarantee even
      if listener phases are ever refactored. (`help.isOpen()` is a cheap boolean read; no
      new import cycle since `wallTool` already sits above `help` in the graph.)
16. **Rapid undo/redo.** Each `undo`/`redo` calls `render()` synchronously (or
    `scheduleRender`), which coalesces; the autosave debounce (800ms) absorbs bursts.

## Dependencies

Must exist before implementation (all already merged):
- `walls.js` — `model`, `hydrate({rooms,chain})`, counter resync. **[present]**
- `symbols.js` — `model`, `hydrate({symbols})`, `removeSymbol`, `duplicateSymbol`,
  counter resync. **[present]**
- `plan.js` — `buildPlan`, `applyPlan` (reference for capture/apply shape). **[present]**
- `store.js` — autosave `onRender` hook (history relies on it for persistence).
  **[present]**
- `surface.js` — `render` / `scheduleRender`. **[present]**
- `symbolTool.js` — `_selectedId`, `_onDuplicate`, `_deleteSelected`, dock drop, and the
  existing private `_onKeyDown` Delete/Backspace branch (lines 458-469) **to be removed**
  so delete is single-owned by the main.js handler. **[present, to be extended]**
- `wallTool.js` — `closeRoom`/`finishChain` commit points; existing `_onKeyDown`
  `Escape`/`Backspace` branches to gain the `help.isOpen()` guard (Escape).
  **[present, to be extended]**
- `help.js` (new) — `isOpen()` consumed by `wallTool` Escape guard.
- `symbolDimEntry.js` — resize commit point. **[present, to be extended]**
- `actions.js` — `showToast` (to be extended with action arg). **[present]**
- `index.html` — `.tool-rail`, `#symbol-inspector`, `#toast`, `.zoom-cluster`.
  **[present, to be extended]**

No new third-party dependencies. No build step. Vanilla ES modules only.

## Test Requirements

Tests live in `src/tests.html` (existing in-browser harness: `describe`/`it`/`expect`).
Add a `history.js` suite plus targeted cases for the wiring. Pure-logic first.

**Unit — `history.js` (core, no DOM):**
- `commit()` on unchanged geometry is a no-op (`canUndo()` stays false).
- `commit()` after a real change makes `canUndo()` true; `undo()` restores the prior
  `rooms`/`symbols`; `redo()` re-applies.
- `undo()`/`redo()` are no-ops (return false) when the respective stack is empty.
- A new `commit()` after `undo()` clears `future` (`canRedo()` false).
- `_apply` preserves the live `model.chain` (mid-draw chain untouched by undo/redo).
- `reset()` empties `past`/`future` and reseeds baseline from current geometry.
- Stack cap: >`MAX_DEPTH` commits keep only the newest `MAX_DEPTH`; oldest dropped.
- Round-trip: delete-symbol → undo restores it with a non-colliding id; redo re-deletes.
- Room commit → undo removes the room; redo restores it (verts intact).

**Unit — dirty-check / stable stringify:**
- Two captures of identical geometry stringify equal (order-stable) → no push.

**Integration (DOM harness or documented manual):**
- Rail undo/redo buttons reflect `canUndo`/`canRedo` (disabled toggling via onChange).
- `Ctrl/Cmd+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` invoke undo/redo; ignored inside dim inputs.
- `Ctrl/Cmd+D` duplicates the selected symbol and shows the "Duplicated" toast; no-op
  (and no bookmark) with nothing selected.
- `Del`/`Backspace` in select mode deletes the selected symbol **exactly once** (single
  commit, single "Deleted" + Undo toast — verifies the symbolTool `_onKeyDown` branch was
  removed and only the main.js handler fires); the Undo button restores the symbol.
- `Backspace` in draw mode with an active chain removes a vertex (not a delete/undo);
  the main.js handler defers to `wallTool` (no symbol delete, no double-handling).
- Toast Undo scoping: delete a symbol, then commit an unrelated edit, then tap the toast
  Undo → it is a no-op (stack depth changed), not an undo of the unrelated edit.
- `Ctrl/Cmd+D` with no selection does not call `preventDefault` (browser default allowed);
  with a selection it duplicates and suppresses the bookmark dialog.
- Autosave: after undo/redo the persisted `localStorage` plan matches the reverted state
  (history drives the same `onRender` path).
- Help: `?` and the help button toggle the cheat sheet; `Esc`/outside-click dismiss;
  `Esc` while open does not finish the wall chain (verifies capture-phase listener +
  `wallTool` `help.isOpen()` guard — draw an active chain, open help, press `Esc`, assert
  the chain is still in progress and only the overlay closed).

**Regression:**
- Existing `walls.undoPoint` mid-draw behavior and `#tool-undo` button unchanged.
- Reset-plan followed by `Ctrl+Z` does not resurrect the wiped plan.
- Boot-restore followed by `Ctrl+Z` does not revert past the loaded plan.
