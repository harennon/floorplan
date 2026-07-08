# LLD 20: MVP-5 — Editing UX (undo/redo, delete, duplicate, keyboard shortcuts)

Phase 5 of 6 of the MVP epic (#1). A **cross-cutting editing layer** over the existing
wall drawing (#6 / LLD 04) and symbol (#8 / LLD 12) code. It adds a single
history stack that both the wall and symbol code funnel committed edits through,
surfaces delete/duplicate on the existing symbol selection, and wires a small set of
keyboard shortcuts plus a cheat-sheet. It adds **no new geometry** and **no new
selectable element types** — it is an editing shell over the model that already
exists.

## Scope

**Covers:**
- **Undo/redo**, **per-committed-gesture**, across wall-drawing and symbol operations.
  A finished room/chain = 1 step; a whole move-drag = 1 step; a rotate, a resize, a
  duplicate, a delete = 1 step each.
- **Delete** and **duplicate** for the currently selected **symbol** (via the existing
  floating symbol inspector — already partly present; this LLD formalises it, adds the
  confirming/undo toast, and adds keyboard access).
- **Keyboard shortcuts** for the core operations, plus a **cheat-sheet modal** (`?`) and
  a small `?` help button near the zoom cluster.
- Reuse of existing chrome only (tool rail, inspector, toast) — no new visual language.

**Does NOT cover (explicitly out of scope):**
- **Wall/room selection.** Only symbols are selectable today; that stays true. Delete and
  duplicate apply to the symbol selection only. Undo/redo *does* reverse committed
  wall/room drawing ops, so there is no functional hole (undo removes a mistaken room).
  Full "any selectable element" delete/duplicate is Phase 2 polish (#3).
- **Per-atomic-op history** (e.g. each vertex, each move-tick as its own step). Explicitly
  rejected by the CEO frontend decision in favour of per-gesture.
- Full power-user shortcut coverage / customisation / chords beyond the core map (#3).
- Persisting the undo stack across reloads or into the plan/share/JSON artifacts.
- Undo of a **Reset** (already documented out of scope in LLD 16) or of view/pan/zoom and
  the unit toggle.

## Approach

Key decisions and rationale:

1. **Snapshot stack, not command objects.** The plan is already fully serializable
   (`plan.buildPlan()` / `hydrateWalls` / `hydrateSymbols` from LLD 16). Undo is therefore
   a stack of geometry **snapshots** (deep-copied `{ rooms, chain, symbols }`), not a set
   of invertible command objects. This reuses the proven serialize/hydrate path, is
   trivially correct for every mutation (no per-op inverse to get wrong), and matches the
   per-gesture granularity: we snapshot at gesture boundaries, never per atomic op.
   Snapshots are small plain-JSON strings; a hard cap bounds memory.

2. **A single `history.js` funnel.** Both wall and symbol code call `history.commit()` at
   **gesture-completion points** only. `commit()` diffs the live geometry against a
   retained baseline; if it changed, it pushes the baseline onto the undo stack, clears the
   redo stack, and adopts the new state as baseline. This auto-coalesces: a drag that fires
   hundreds of `moveSymbol` calls produces exactly one commit (at pointer-up), and a
   no-op gesture (returns to origin) produces zero. No module needs to reason about
   inverses — only about "a gesture just finished."

3. **Geometry-only snapshots.** Snapshots capture `walls.rooms`, `walls.chain`, and
   `symbols.symbols` — **not** `view` or `unit`. Panning, zooming, and unit toggles are
   never undoable (they are not edits). The active `chain` *is* included so restore is
   exact, but commits only happen once a chain is finished, so mid-draw state never lands
   on the stack (see Edge Cases).

4. **Delete/duplicate stay in the symbol inspector.** The inspector (LLD 12) already has
   rotate/duplicate/delete/lock buttons and `_deleteSelected`/`_onDuplicate`. This LLD:
   (a) routes those mutations through `history.commit()`, (b) fires the confirming
   **Undo toast** on delete and a brief non-actionable toast on duplicate, and (c) exposes
   `deleteSelected()` / `duplicateSelected()` / `rotateSelected()` / `hasSelection()` so the
   keyboard layer can invoke them.

5. **New chrome is additive, reuses existing components.**
   - A new **undo/redo cluster** in the tool rail, below the existing tool buttons, behind
     its own hairline separator, *distinct* from the existing draw-mode "remove last point"
     button (`#tool-undo`, Backspace).
   - The existing `#toast` gains an optional one-tap action button (Undo).
   - A new hidden **`#shortcuts-modal`** and a `#btn-help` (`?`) button in the zoom cluster.

6. **Keyboard split that avoids touching working handlers.** New global chords
   (`Ctrl/Cmd+Z/Y/Shift+Z`, `Ctrl/Cmd+D`, `?`) live in a new `shortcuts.js`. Existing
   non-chord keys (`V`/`W`/`Esc`/`Enter`/`Backspace`/`Alt`) stay in `wallTool.js` /
   `symbolTool.js` untouched — those handlers already bail when `ctrl/meta` is held, so the
   new chords don't collide. `R` (rotate) and `Delete`/`Backspace` (delete symbol) stay in
   `symbolTool.js` where the selection state lives.

7. **Client-side only, no build step.** Two new vanilla-JS ES modules
   (`src/js/history.js`, `src/js/shortcuts.js`), small additions to `plan.js`, `actions.js`,
   `symbolTool.js`, `wallTool.js`, `main.js`, and static HTML/CSS in `index.html`. No
   dependencies added.

## Interfaces / Types

### `plan.js` (additions — pure, no DOM)

```js
/** @typedef {{ walls: {rooms:Room[], chain:Vertex[]}, symbols:{symbols:Sym[]} }} GeometrySnapshot */

/** Deep-copied, JSON-safe geometry-only snapshot (no view/unit). */
export function snapshotGeometry() // → GeometrySnapshot

/** Stable JSON string of a snapshot, for dirty-checking (fixed key order). */
export function serializeGeometry(snap /*: GeometrySnapshot */) // → string

/** Hydrate walls+symbols in place from a snapshot. Caller renders. */
export function restoreGeometry(snap /*: GeometrySnapshot */) // → void
```
`snapshotGeometry` reuses the same `JSON.parse(JSON.stringify(...))` deep-copy already
used by `buildPlan`. `restoreGeometry` calls the existing `hydrateWalls` / `hydrateSymbols`
(same in-place array-identity contract as boot restore).

### `history.js` (new)

```js
/**
 * @param {{ btnUndo: HTMLButtonElement, btnRedo: HTMLButtonElement }} refs
 */
export function init(refs)      // wire rail buttons + set initial disabled state

/** Capture current geometry; if changed vs baseline, push a history step. */
export function commit()        // → void   (call at gesture-completion points)

/** Restore the previous / next snapshot. No-op when the respective stack is empty. */
export function undo()          // → boolean (true if a step was applied)
export function redo()          // → boolean

/** Clear both stacks and re-baseline from current live geometry.
 *  Called after any wholesale model swap (boot restore, import, share-open, reset). */
export function reset()         // → void

export function canUndo()       // → boolean
export function canRedo()       // → boolean
```

Internal state:
```js
let _baseline = /* string */ serializeGeometry(snapshotGeometry());
const _undo = /* string[] */ [];   // serialized snapshots, oldest → newest
const _redo = /* string[] */ [];
const MAX_STEPS = 100;             // hard cap; drop oldest on overflow
```
`commit()`: `const now = serialize(); if (now === _baseline) return;`
`_undo.push(_baseline); if (_undo.length > MAX_STEPS) _undo.shift(); _baseline = now;`
`_redo.length = 0; _updateButtons();`
`undo()`: `_redo.push(_baseline); _baseline = _undo.pop(); apply(_baseline); _updateButtons();`
`redo()` symmetric. `apply(str)` = `restoreGeometry(JSON.parse(str))` + `scheduleRender()`.
`_updateButtons()` sets `btnUndo.disabled = _undo.length === 0`, `btnRedo.disabled = _redo.length === 0`.

### `shortcuts.js` (new — global chords + cheat-sheet modal + help button)

```js
/**
 * @param {{
 *   undo:()=>void, redo:()=>void,
 *   duplicate:()=>void,            // Ctrl/Cmd+D → symbolTool.duplicateSelected
 *   modal: HTMLElement,            // #shortcuts-modal
 *   btnHelp: HTMLElement,          // #btn-help
 * }} refs
 */
export function init(refs)

/** True while the cheat-sheet is open (other shortcuts are suppressed). */
export function isModalOpen()      // → boolean

export const IS_MAC // boolean; drives ⌘ vs Ctrl tooltip/label text
```
`shortcuts.js` binds one `window` `keydown`:
- ignores events when `document.activeElement` is INPUT/TEXTAREA/SELECT (except `Esc`
  to close the modal);
- `?` (i.e. `e.key === "?"`) → toggle modal; `Esc` → close modal if open;
- `(ctrl||meta) && key==="z" && !shift` → `undo()`; `+shift` or `key==="y"` → `redo()`;
- `(ctrl||meta) && key==="d"` → `preventDefault()` + `duplicate()`.

### `symbolTool.js` (additions — new exports; existing private handlers reused)

```js
export function hasSelection()        // → boolean  (_selectedId !== null)
export function duplicateSelected()   // wraps _onDuplicate
export function deleteSelected()      // wraps _deleteSelected (already private)
export function rotateSelected()      // wraps _onRotate90 (R key)
```
Each mutation path (`_onDuplicate`, `_deleteSelected`, `_onRotate90`, `onSelectUp` after a
real move/rotate, dock-drop `addSymbol`) calls `history.commit()` after mutating. `R` is
handled in the existing `_onKeyDown` (non-chord) alongside Delete/Backspace.

### `actions.js` (toast extension)

```js
/**
 * @param {string} msg
 * @param {{ actionLabel?: string, onAction?: ()=>void }} [opts]
 */
export function showToast(msg, opts)   // backward-compatible; existing callers unaffected
```
When `opts.actionLabel` is present the toast renders `msg` + a `<button>`; the toast root
gets `toast--action` (which sets `pointer-events:auto`) and clicking the button runs
`onAction()` then dismisses. Without opts it behaves exactly as today (non-actionable,
auto-dismiss).

### HTML (new / changed in `index.html`)

- Tool rail: after `#tool-finish` add a hairline `<div class="tool-rail-sep">` then a new
  cluster:
  `<button id="hist-undo" disabled>` (undo glyph) and `<button id="hist-redo" disabled>`
  (redo glyph), each with a platform-correct `aria-label`/`title` chord tooltip.
- Zoom cluster: add `<button id="btn-help" class="reset-btn" aria-label="Keyboard shortcuts (?)">?</button>`.
- New `<div id="shortcuts-modal" class="shortcuts-modal" role="dialog" aria-modal="true" hidden>`
  containing a static two-column key/description table and a close (`×`) button.

## State Model

- **In-memory only.** `_baseline`, `_undo`, `_redo` live in `history.js`. Nothing is
  persisted: the undo stack is **not** part of `buildPlan()`, is not written to
  localStorage, not encoded in the share hash, not in JSON export. Reloading a page starts
  with an empty stack (documented, accepted for v1).
- **Baseline lifecycle.** `history.reset()` is called (from `main.js` / `actions.js`)
  immediately after every wholesale geometry swap: boot restore (all branches), JSON
  import, share-link open, and Reset. This re-baselines to the freshly loaded state so the
  first post-load `commit()` diffs correctly and the stacks start empty.
- **Commit points (the funnel).** `history.commit()` is called after, and only after, a
  committed gesture mutates the live model:
  - wall: `closeRoom()` / `finishChain()` completes (in `wallTool` `onClick` when the chain
    clears, and in the Esc/Enter/tool-switch finish paths).
  - symbol: dock-drop `addSymbol`; `onSelectUp` after a move or rotate **that changed the
    model**; inspector rotate-90 / duplicate / delete; `symbolDimEntry.commit` (resize);
    `dimEntry.commit` (wall edge rescale).
  - The commit diff makes double-calls and no-op gestures free (they push nothing).
- **Render/autosave interplay.** `undo()`/`redo()` mutate the model in place then
  `scheduleRender()`. The existing `store.js` `onRender` autosave hook then persists the
  restored state — so an undone plan survives reload as the current plan (the *stack* does
  not).
- **Selection after undo/redo.** `_selectedId` in `symbolTool` may point at a symbol that no
  longer exists after a restore. `history.apply` (or a small callback into symbolTool)
  clears selection / hides the inspector if the selected id is absent post-restore.

## Edge Cases

1. **Empty stack** — `undo`/`redo` are no-ops; rail buttons `disabled`; chords do nothing.
2. **Redo invalidation** — any `commit()` after an `undo()` clears the redo stack (standard
   linear history).
3. **Undo mid-draw (active chain present)** — snapshots include `chain`, but commits only
   fire once a chain finishes, so no partial-chain snapshot is ever on the stack. If the
   user hits `Ctrl+Z` while a chain is in progress, the previous committed geometry is
   restored (which sets `chain` to whatever the restored snapshot held — normally empty)
   and the active draft is discarded. This is acceptable: Backspace/Enter/Esc remain the
   in-draw controls; the cheat-sheet documents them separately.
4. **Undo/redo during an active pointer drag** — guarded: `shortcuts`/`history` ignore
   undo/redo/duplicate while `symbolTool` reports an in-progress drag (`_dragMode !== null`),
   since the gesture hasn't committed yet.
5. **Selected symbol removed by a restore** — clear `_selectedId` and hide the inspector so
   no stale handle is drawn (see State Model).
6. **Duplicate with nothing selected** — `Ctrl/Cmd+D` / inspector duplicate are no-ops and
   show **no** toast.
7. **Delete-key routing** — `Backspace` in draw mode removes the last chain point (existing);
   `Delete`/`Backspace` in select mode with a symbol selected deletes it (existing) and now
   fires the Undo toast. When we handle the key we `preventDefault()` (blocks browser
   back-nav); when nothing is selected in select mode we do not preventDefault.
8. **No-op gesture** — a move-drag that returns a symbol to its exact origin, or a resize to
   the same value, commits nothing (diff equal). No phantom history step.
9. **Cap overflow** — beyond `MAX_STEPS` (100) the oldest undo entry is dropped; redo is
   naturally bounded by undo depth.
10. **Toast Undo tap** — the delete toast's Undo button calls `history.undo()` (same path as
    the chord/rail), then dismisses the toast.
11. **Cheat-sheet open** — while `#shortcuts-modal` is open, all shortcuts except `Esc`
    (close) and the close button are suppressed; background stays interactive-safe (modal is
    an overlay). Clicking the backdrop closes it.
12. **`?` needs Shift+/** — detect via `e.key === "?"` (layout-independent for the produced
    char); suppressed when focus is in a text field.
13. **Platform chords** — `IS_MAC` selects `⌘Z / ⌘⇧Z / ⌘D` labels+tooltips on macOS/iPad,
    `Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+D` elsewhere. Redo accepts both `Cmd/Ctrl+Shift+Z`
    and `Cmd/Ctrl+Y`.
14. **Session UI state is not history** — lock-aspect toggle, tool switch, pan/zoom, and unit
    toggle never enter the stack.
15. **Reset re-baselines** — after Reset (which is itself not undoable, per LLD 16), the
    stacks are cleared so the empty plan can't be "undone" back to the pre-reset state.
16. **Rapid repeated undo/redo** — each applies synchronously and `scheduleRender()`
    coalesces to one frame; buttons update immediately from stack lengths.

## Dependencies

Must exist before implementation (all present on `main`):
- **LLD 04 / #6** — `walls.js` (`model`, `hydrate`), `wallTool.js` (finish/close/undoPoint
  paths, keyboard). Commit hooks are added here.
- **LLD 12 / #8** — `symbols.js` (CRUD), `symbolTool.js` (selection, inspector,
  duplicate/delete/rotate), `symbolDimEntry.js` (resize commit).
- **LLD 16 / #1-phase-6** — `plan.js` (`buildPlan`, deep-copy pattern, `hydrateWalls`,
  `hydrateSymbols`), `actions.js` (`showToast`), `store.js` autosave-on-render, and the
  `#toast` element + tool-rail / zoom-cluster / inspector chrome in `index.html`.
- `surface.js` `scheduleRender` / `onRender`.

## Test Requirements

**Unit (pure — `history.js` + `plan.js` additions):**
- `snapshotGeometry` deep-copies and excludes `view`/`unit`; mutating the live model after a
  snapshot does not alter the snapshot.
- `serializeGeometry` is stable (same geometry → identical string) for dirty-checking.
- `restoreGeometry` replaces rooms/chain/symbols in place (array identity preserved) and
  re-syncs id counters (via existing hydrate contract).
- `commit` pushes only on change; no-op when unchanged; clears redo on new commit; caps at
  `MAX_STEPS` dropping oldest.
- `undo`/`redo` move state between stacks correctly and return `false` on empty stacks;
  `canUndo`/`canRedo` track stack lengths; `reset` clears both and re-baselines.

**Integration (DOM / wiring):**
- Draw a room → `commit` produces one step; `undo` removes the room, `redo` restores it.
- Symbol: drop, move-drag, rotate, resize, duplicate, delete each undo/redo as **one** step.
- A move-drag returning to origin creates no step.
- Rail undo/redo buttons enable/disable with stack state; clicking them mirrors the chords.
- Delete shows a toast with a working one-tap Undo; duplicate shows a brief non-actionable
  toast.
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y`, `Ctrl/Cmd+D`, `Del`/`Backspace`, `R`, `?`,
  `Esc` behave per the map and do **not** break existing draw-mode keys (Backspace remove
  point, Enter finish, Alt free-place, V/W tool switch).
- Boot restore / JSON import / share-open / Reset each leave the undo stack empty
  (`reset()` called).
- Undo that removes the selected symbol clears the inspector/selection.

**Security / robustness:**
- History holds only serialized geometry strings (no functions/DOM); a malformed snapshot
  never reaches the stack because it is produced from the live model, not user input.
- Shortcut handler ignores key events originating in editable fields (no interference with
  dimension entry), and `preventDefault` is scoped to handled keys only.

**Accessibility:**
- New rail buttons and help button have descriptive `aria-label`s with platform-correct
  chord text; disabled state exposed via `disabled`.
- `#shortcuts-modal` uses `role="dialog"`/`aria-modal`, is focus-trapped while open, and
  closes on `Esc`.

## Frontend Design

Recorded CEO frontend decision (approve as mocked; reuse existing chrome; no new visual
language). Mockup: https://harennon.github.io/floorplan/editing-ux-undo-redo-delete-duplicate-shortcuts.html

1. **Undo/redo cluster** lives in the tool rail **below the tool buttons**, separated by a
   hairline (`.tool-rail-sep`), and is **distinct** from the draw-mode "remove last point"
   button (`#tool-undo`, Backspace). Both undo/redo buttons are **always visible**,
   **disabled when their stack is empty**, and carry **platform-correct chord tooltips**
   (`⌘Z`/`Ctrl+Z`, etc.). They reuse the existing `.tool-rail button` styling; the redo
   glyph is the undo glyph mirrored.
2. **Delete + duplicate** stay in the **floating symbol inspector** (existing buttons), now
   with **key-hint tooltips** (`Del`, `⌘D`/`Ctrl+D`).
3. **Destructive actions get the confirming toast with one-tap Undo.** Delete → toast
   "Deleted · **Undo**" (actionable). Duplicate → brief **non-actionable** toast
   "Duplicated". Toast reuses the existing `#toast` component with an added action variant.
4. **Shortcuts cheat-sheet** on `?` — a modal listing the core map — plus a small **`?` help
   button** placed in the **bottom-left zoom cluster**, styled like the existing `RESET`
   button.

**Core shortcut map (documented + functional):**

| Action | Shortcut |
| --- | --- |
| Undo | `Ctrl/Cmd+Z` |
| Redo | `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y` |
| Delete selected symbol | `Del` / `Backspace` (select mode) |
| Duplicate selected symbol | `Ctrl/Cmd+D` |
| Rotate selected symbol 90° | `R` |
| Clear / cancel selection or draft | `Esc` |
| Select tool / Wall tool | `V` / `W` |
| Keyboard shortcuts | `?` |

**Preserved draw-mode keys (must not break):** `Backspace` remove last point, `Enter`
finish chain, `Alt` free-place, `V`/`W` tool switch.

Everything reuses existing tokens (`--panel`, `--hairline`, `--gold`, mono font) — no new
visual language is introduced.
