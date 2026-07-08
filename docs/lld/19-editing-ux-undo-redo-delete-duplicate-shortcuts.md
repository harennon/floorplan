# LLD 19: MVP-5 — Editing UX: Undo/Redo, Delete, Duplicate, Keyboard Shortcuts

Phase 5 of 6 of the MVP epic (#1). A thin, cross-cutting **editing layer** over the shipped
wall model (LLD 4 / #6) and symbol model (#8). Adds a global undo/redo history, wires
delete/duplicate for the current selection, and lands a small set of documented keyboard
shortcuts plus a cheat sheet. Client-side only; nothing new is sent to a server.

## Scope

**Covers:**
- **Undo/redo** over the whole plan (walls + symbols), at **per-committed-gesture**
  granularity: a finished room = 1 step, a symbol drag/rotate/resize = 1 step, a
  delete/duplicate = 1 step, a placed wall point = 1 step. A linear history with a redo
  stack that is truncated on the next new gesture.
- An **undo/redo cluster** in the tool rail, below the existing tool buttons, separated by a
  hairline. Always visible; each button disabled when its stack is empty. Platform-correct
  chord tooltips (⌘Z / ⌘⇧Z on Mac, Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) elsewhere).
- **Keyboard shortcuts:** Undo (⌘/Ctrl+Z), Redo (⌘⇧Z / Ctrl+Y / Ctrl+Shift+Z), plus the
  already-shipped selection shortcuts surfaced as documented hints: Delete/Backspace (delete
  selected symbol), ⌘/Ctrl+D **or** `D` (duplicate selected symbol), `R` (rotate 90°).
- **Delete + duplicate** on the current selection, kept in the existing floating **symbol
  inspector** with key-hint tooltips. Reuse the current inspector component — no new panel.
- **Toasts:** destructive actions (delete) show the existing toast with a one-tap **Undo**
  affordance; duplicate shows a brief non-actionable confirmation toast. Reuse the existing
  `actions.js` toast component.
- **Shortcuts cheat sheet** opened by `?`, plus a small `?` help button near the zoom
  cluster that opens the same overlay.
- New unit tests in `src/tests.html` for the history stack.

**Does NOT cover (explicitly out, later phases):**
- **Wall/room selection.** Delete/duplicate act on **symbols only** (as today, via the
  unified inspector). Undo/redo covers wall-drawing operations, but there is no wall/room
  *selection* and thus no delete/duplicate for walls. Full wall/room selection under the
  unified "any selectable element" inspector is deferred to **Phase 2 polish (#3)**. Rationale
  (CEO): undo already gives a path to remove a just-committed wall/room, so there is no
  functional hole for v1; adding wall/room selection is a genuine scope expansion.
- **Per-atomic-op history** (e.g. every pixel of a drag as its own step) — explicitly
  rejected in favor of per-committed-gesture. Do NOT implement.
- **Full power-user shortcut coverage / ergonomics** — Phase 2 polish (#3).
- **Persisted history.** The undo stack lives in memory only and is discarded on reload
  (localStorage still autosaves the *current* plan, unchanged).

## Approach

**Snapshot-based history, not a command log.** Rather than building reversible command
objects for every mutation type (walls, symbols, moves, rotates, resizes…), we reuse the
existing serialization contract. After each *committed gesture* we capture a deep,
JSON-safe snapshot of the document (walls + symbols) and push it onto a linear undo stack.
Undo/redo restores a snapshot by hydrating the models in place. This is dramatically
simpler than N command classes, is inherently correct (the snapshot *is* the state), and
piggybacks on the already-tested `walls.hydrate` / `symbols.hydrate` and the deep-clone
pattern in `plan.buildPlan`. Snapshots are small (plain vertex/symbol arrays) for the plan
sizes v1 targets, so memory is a non-issue; a cap bounds the worst case.

**Document-only snapshots — undo never moves the camera or flips units.** A snapshot is
`{ walls:{rooms,chain}, symbols:{symbols} }` — deliberately **excluding** `view` and `unit`.
Undoing a delete must not also rewind a pan/zoom the user did afterward, and must not
change ft/m. (This is the one place we intentionally diverge from `plan.buildPlan`, which
includes view+unit for share/save.) A new `history.snapshotDoc()` / `history.restoreDoc()`
pair encapsulates this document subset.

**A single "commit" chokepoint.** All history growth goes through one function,
`history.commit()`, called *after* a gesture finishes and the model is already mutated.
`commit()` snapshots current document state, and — if it differs from the top of the
stack — pushes it and clears the redo stack. Callers never build diffs. The existing
mutation sites already funnel through a small number of controllers, so we add `commit()`
calls at the *end* of each committed gesture:
  - `wallTool`: after `placeVertex` (point placed), after `closeRoom`, after `finishChain`,
    after `undoPoint` (the draw-mode chain edit — see below), after the rail Undo/Finish.
  - `symbolTool`: after a drop (placement), after `onSelectUp` **iff** a move/rotate
    actually changed geometry, after rotate-90, duplicate, delete.
  - `symbolDimEntry.commit`: after a successful resize.

**Seed baseline at boot.** On boot (after `applyPlan`/empty start), `history.init()` records
the initial document as the baseline snapshot (stack = [baseline], redo = []). This makes the
"nothing to undo" state well-defined and lets the *first* user gesture produce exactly one
undoable step back to the loaded/empty plan. Boot-restore paths (local, shared, conflict
choice, reset, import) all re-seed via `history.reset()` so you cannot undo *into* a previous
document that was replaced wholesale.

**Two distinct "undo last point" affordances, kept separate (CEO constraint).** The
draw-mode **Backspace / rail "remove last point"** stays exactly as shipped: chain-scoped,
pops one in-progress vertex. The new **global Undo (⌘/Ctrl+Z)** operates on the committed
history. They can agree in the middle of drawing (see Edge Cases) but are wired
independently: Backspace is handled in `wallTool` and does not touch the history stack via
the global path; instead, popping a point is itself a committed gesture pushed onto history,
so ⌘Z can also reverse it. The rail keeps the existing "remove last point" button; the new
undo/redo cluster is a separate group below the hairline.

**Undo/redo mutate, then re-render + re-seed derived UI.** After a restore, we
`scheduleRender()` and clear any transient selection/edit that now points at a vanished
element (e.g. a symbol that a redo removed). Restoration uses the in-place `hydrate`
functions so array identities are preserved (measure/symbolRender read `model` by
reference).

**Keyboard: global handler in `history.js`, guarded.** ⌘/Ctrl+Z and redo chords are handled
by a single `window` keydown listener owned by the history module. It ignores events when an
editable element (`INPUT`/`TEXTAREA`/`SELECT`) is focused (so typing a dimension value and
hitting ⌘Z does the browser's text-undo, not a plan undo) and calls `preventDefault()` when
it consumes a chord. The existing per-module keyboard handlers (`wallTool`, `symbolTool`)
keep their own non-chord keys; we only **add** the `D` (duplicate) and `R` (rotate) plain-key
shortcuts and the `?` cheat-sheet toggle where they belong, all behind the same
modifier/editable guards already in place.

**Reference mockup.** `editing-ux-undo-redo-delete-duplicate-shortcuts.html` (gh-pages) is
the visual reference for the rail cluster, the inspector key-hint tooltips, the undo-toast,
and the cheat-sheet overlay. Where this doc and the mockup disagree, this doc wins. All
chrome reuses existing tokens/components — no new visual language (CEO).

## Interfaces / Types

One new ES module `src/js/history.js`, plus surgical additions to existing modules. No
bundler; loaded by the existing `<script type="module">`.

### `history.js` — the undo/redo core (new)

```js
/** A document snapshot: walls + symbols only. No view, no unit. */
/** @typedef {{ walls:{rooms:Room[],chain:Vertex[]}, symbols:{symbols:Sym[]} }} DocSnap */

export const HISTORY_CAP = 100;   // max undo steps kept (older ones dropped from the bottom)

// ── Boot / lifecycle ────────────────────────────────────────────────
// Bind rail buttons + cheat-sheet DOM; wire the global keydown handler.
export function init(refs: {
  btnUndo:  Element,   // rail global-undo button
  btnRedo:  Element,   // rail global-redo button
  btnHelp:  Element,   // "?" help button near zoom cluster
  sheet:    Element,   // cheat-sheet overlay root
  sheetClose: Element, // its close button
  onAfterRestore?: () => void,  // injected: clears stale selection/edit (from main.js)
}): void;

// Seed the baseline snapshot from current live model. Clears both stacks.
// Called at boot AND after any wholesale document replacement
// (applyPlan/reset/import/conflict-choice).
export function reset(): void;

// Capture current document; if it differs from the stack top, push it and
// clear the redo stack. This is the ONE chokepoint every gesture calls.
export function commit(): void;

// Restore the previous / next snapshot. No-op when the respective stack is
// exhausted. Hydrates models in place, updates button state, fires
// onAfterRestore, and scheduleRender()s. Returns true if it moved.
export function undo(): boolean;
export function redo(): boolean;

// Stack availability (drives button disabled state + tests).
export function canUndo(): boolean;   // undo stack has a prior snapshot
export function canRedo(): boolean;   // redo stack non-empty

// Pure helpers (testable without DOM):
export function snapshotDoc(): DocSnap;              // deep clone of live walls+symbols
export function restoreDoc(snap: DocSnap): void;     // hydrate walls+symbols in place
```

Internal state:
```js
let _undo = /** @type {DocSnap[]} */ ([]);  // _undo[_undo.length-1] === current doc
let _redo = /** @type {DocSnap[]} */ ([]);
```
`snapshotDoc` reuses the `JSON.parse(JSON.stringify(...))` deep-clone already used in
`plan.buildPlan`. `restoreDoc` calls `hydrateWalls(snap.walls)` and
`hydrateSymbols(snap.symbols)` (both in-place, id-counter-safe). Equality on commit is a
cheap `JSON.stringify` compare against the stack top (same approach `store.js` uses for
dirty-checking) — a gesture that produced no net change adds no history entry.

### `platform.js` — tiny helper (new, or inline in `history.js`)

```js
// True on Apple platforms → use ⌘ in tooltips and treat metaKey as the accelerator.
export function isMac(): boolean;   // /Mac|iPhone|iPad|iPod/.test(navigator.platform||UA)
// The accelerator modifier for the current platform on a keyboard event.
export function accel(e: KeyboardEvent): boolean;   // isMac() ? e.metaKey : e.ctrlKey
```
Kept minimal; may live as private helpers inside `history.js`.

### `wallTool.js` — additions (surgical)

Import `commit` from `history.js`. Call `commit()` at the end of each committed gesture:
after a successful `placeVertex`/`closeRoom` in `onClick`, after `finishChain`
(Esc/Enter/rail Finish/tool-switch auto-finish), after `undoPoint`
(Backspace/rail remove-point). No signature changes to existing exports.

### `symbolTool.js` — additions (surgical)

Import `commit` from `history.js`. Track a per-drag "changed" flag (compare start vs. end
pose) so a click that selects-but-doesn't-move does not create a history step. Call
`commit()`:
- after a dock drop (placement) in `_onUp`,
- in `onSelectUp` **iff** the symbol's `{x,y,rot}` changed since `onSelectDown`,
- at the end of `_onRotate90`, `_onDuplicate`, `_deleteSelected`.

Delete/duplicate additionally trigger the appropriate toast (see below). New key handling:
`D`/⌘D (duplicate) and `R` (rotate 90°) added to the existing `_onKeyDown`, behind the same
guards, only when a symbol is selected and not in draw mode.

### `symbolDimEntry.js` — additions (surgical)

Import `commit`; call `commit()` after a successful `resizeSymbol` in `commit()` (the resize
path), *after* `scheduleRender()`. No history entry when the value was a no-op (the existing
`fmtLen` round-trip guard already returns early).

### `actions.js` — toast additions

`showToast` gains an optional action affordance. Add a variant:
```js
// Show a toast with a single inline action button (e.g. "Undo").
export function showToastAction(msg: string, actionLabel: string, onAction: ()=>void): void;
```
Implemented by rendering `msg` + a `<button>` inside `#toast` (built via DOM APIs /
`textContent`, no `innerHTML` from dynamic strings). The button is cleared and listeners
detached when the toast hides or is replaced. Used by delete ("Symbol deleted" + "Undo").
Duplicate uses the plain `showToast("Duplicated")`.

### `main.js` — wiring

Import and `initHistory({...})` after all other modules init; pass an `onAfterRestore`
callback that clears symbol selection/inspector and any open dim-edit, then re-renders.
Call `history.reset()` in every boot-restore branch (local / shared / conflict choice /
empty) and expose it to `actions.js` for reset/import (via an injected reference, mirroring
how `setTool`/hooks are injected — no new import cycle). Grab and pass the new rail
undo/redo buttons, the `?` help button, and the cheat-sheet overlay elements.


## State Model

**All history state is in-memory only; discarded on reload.** Persistence (localStorage,
URL hash) continues to store only the *current* plan via the existing `store.js` / `share.js`
paths — the undo stack is never serialized.

**History stacks (`history.js`):**
- `_undo: DocSnap[]` — the invariant is that `_undo[_undo.length-1]` is always a snapshot of
  the *current* live document. Length ≥ 1 after `reset()`.
- `_redo: DocSnap[]` — snapshots that were undone past; cleared whenever a new `commit()`
  pushes a fresh gesture.
- `canUndo()` ⇔ `_undo.length > 1`. `canRedo()` ⇔ `_redo.length > 0`.
- Cap: on push, if `_undo.length > HISTORY_CAP` shift the oldest off the bottom (baseline
  loss is acceptable — undoing 100 gestures back is well beyond v1 need).

**Snapshot boundary (what is vs. isn't in a `DocSnap`):**
- **In:** `walls.model.rooms`, `walls.model.chain`, `symbols.model.symbols` (deep-cloned).
- **Out:** `view` (zoom/pan) and `unit` — intentionally, so undo is document-only.
- **Also out (derived, recomputed on render):** measure totals, snap state, selection,
  ghost, open dim-edit input, save-pill state, HUD.

**Lifecycle / re-seed points (call `history.reset()`):** boot empty start, boot local
restore, boot shared-plan open, conflict-banner choice (both branches), Reset plan, Import
JSON. After each of these the live models were replaced wholesale, so the previous history
is meaningless and must be dropped; `reset()` re-seeds the baseline from the new live models.

**Commit points (call `history.commit()`), one per finished gesture:**

| Gesture | Site | Notes |
| --- | --- | --- |
| Place wall point | `wallTool.onClick` (after `placeVertex`) | includes the point that closes a room |
| Close room | covered by the same `onClick` commit | one step |
| Finish chain | `wallTool` finish paths (Esc/Enter/rail/auto-finish on tool switch) | |
| Remove last point | `wallTool` Backspace / rail remove-point (after `undoPoint`) | still its own committed step |
| Place symbol | `symbolTool._onUp` (drop on canvas) | |
| Move / rotate (drag) | `symbolTool.onSelectUp` | only if pose changed |
| Rotate 90° | `symbolTool._onRotate90` | |
| Duplicate symbol | `symbolTool._onDuplicate` | |
| Delete symbol | `symbolTool._deleteSelected` | |
| Resize symbol | `symbolDimEntry.commit` (after `resizeSymbol`) | no-op edits skipped |

**Ordering with autosave.** `store.js` autosaves on the `onRender` hook and dirty-checks by
serialized plan; nothing changes there. `commit()` runs synchronously right before/around
the `scheduleRender()` the gesture already triggers, so a committed gesture both lands in
history and (debounced) autosaves. Undo/redo call `scheduleRender()` too, so a restored
document autosaves as the new current plan — correct: reloading after undo keeps the undone
state.

**Render flow is unchanged.** History does not add a render hook; it drives renders
imperatively via `scheduleRender()` on undo/redo, exactly like every other controller.

## Edge Cases

1. **Undo mid-drawing chain.** Global Undo reverses committed steps, including individual
   placed points and `undoPoint` pops. Because both "place point" and "remove last point" are
   committed steps, ⌘Z after placing a 4th point restores the 3-point chain; a further ⌘Z
   restores 2 points, etc. This overlaps Backspace's behavior *while drawing* — that is
   acceptable and expected. Backspace remains available and chain-scoped; ⌘Z is the general
   path. Neither is removed.
2. **Empty stacks.** `undo()`/`redo()` are no-ops when their stack is exhausted; the
   corresponding rail button is `disabled` and the keyboard chord, if pressed, is consumed
   (preventDefault) but does nothing. At boot with an empty plan, both are disabled.
3. **Redo truncation.** Any new committed gesture after one or more undos clears the redo
   stack (standard linear-history semantics). No branching history in v1.
4. **No-op gestures don't grow history.** A click that selects a symbol without moving it, a
   drag that returns to the same pose, or a dim-edit committed to the same value produce no
   snapshot (equality check against stack top). Prevents "dead" undo steps.
5. **Undo removes the selected symbol.** If undo/redo restores a document where the currently
   selected symbol id no longer exists, `onAfterRestore` clears the selection, hides the
   inspector, and cancels any open dim-edit (the existing `symbolDimEntry.reposition` guard
   already closes an input whose symbol vanished, but we clear proactively).
6. **Undo while a dim-edit input is open and focused.** The global keydown handler ignores
   ⌘Z when focus is in an `INPUT`/`TEXTAREA`/`SELECT`, so the browser's native text-undo
   applies inside the field — the plan is not touched. (Consistent with existing keyboard
   guards across `wallTool`/`symbolTool`.)
7. **Delete toast Undo vs. global redo.** The delete toast's inline "Undo" calls
   `history.undo()` — the same path as ⌘Z — so there is exactly one undo mechanism; the toast
   is just a second trigger. If the toast times out, ⌘Z still works.
8. **Duplicate then undo.** Duplicate is one committed step; undo removes the duplicate and
   restores selection state via `onAfterRestore` (selection cleared, since the duplicate — the
   selected symbol — is gone). Duplicate shows a brief non-actionable toast only.
9. **Reset / Import / shared-plan open.** These replace the document wholesale and call
   `history.reset()`, so you cannot ⌘Z back into the pre-reset plan (matching the existing
   `window.confirm("…can't be undone")` contract for Reset). This is deliberate.
10. **`D` key ambiguity.** Plain `D` duplicates the selected symbol; ⌘/Ctrl+D also duplicates
    (and preventDefault's the browser bookmark). Both are guarded to require a current
    selection and select-mode (not draw-mode) and an unfocused editable — otherwise ignored.
11. **`R` rotate vs. future tools.** Plain `R` rotates the selected symbol 90° (mirrors the
    inspector button). Guarded identically to `D`. If no symbol is selected it is ignored
    (does not conflict with pan/zoom).
12. **Cheat sheet toggling.** `?` (Shift+/) opens the overlay; `?` again or `Esc` or the
    close button or an outside click closes it. While open it does not block canvas shortcuts
    except that `Esc` first closes the sheet. The `?` guard ignores the key when an editable
    element is focused.
13. **HISTORY_CAP overflow.** After 100 committed gestures the oldest snapshot is dropped;
    undo simply cannot reach that far back. No error, no user-visible glitch.
14. **Rapid undo/redo (key repeat / mashing).** Each call mutates then `scheduleRender()`s;
    renders coalesce via RAF (existing surface loop), so holding ⌘Z steps back one snapshot
    per keydown without flooding the DOM.
15. **Platform tooltip correctness.** On macOS the rail tooltips read “Undo (⌘Z)” / “Redo
    (⌘⇧Z)”; elsewhere “Undo (Ctrl+Z)” / “Redo (Ctrl+Y)”. Both platforms accept ⌘⇧Z / Ctrl+Y /
    Ctrl+Shift+Z for redo to cover muscle memory.
16. **Undo after autosave/reload.** History is not persisted; after a reload the stack is
    re-seeded from the restored plan (`reset()`), so ⌘Z at that point does nothing until the
    user makes a new gesture. Expected — undo is a session affordance.
17. **Symbol id counter safety across undo.** `restoreDoc` uses the existing `hydrate`
    functions, which re-sync the `s<n>`/`w<n>` id counters past the max restored id, so a new
    create/duplicate after an undo cannot collide with a restored id.
18. **Draw-mode tool switch auto-finish.** Switching to Select mid-chain auto-`finishChain`s
    (existing edge case 8 from LLD 4); that finish now also `commit()`s, so the auto-committed
    open polyline is a single undoable step.

## Dependencies

- **Must exist first (all shipped):** `walls.js` (`model`, `hydrate`), `symbols.js`
  (`model`, `hydrate`, `duplicateSymbol`, `removeSymbol`, `rotateSymbol`), `plan.js`
  (deep-clone pattern), `surface.js` (`scheduleRender`/`onRender`), `wallTool.js`,
  `symbolTool.js`, `symbolDimEntry.js`, `actions.js` (toast), `main.js`, `index.html`.
- **Reused contracts (do not change):** `walls.hydrate` / `symbols.hydrate` (in-place,
  id-counter-safe); the `JSON.parse(JSON.stringify(...))` clone used by `plan.buildPlan`;
  `surface.scheduleRender`; the existing keyboard guards (skip when modifier keys / editable
  focus).
- **New:** `src/js/history.js` (undo/redo core + keyboard + rail/help/cheat-sheet wiring);
  optional `platform.js` helper (or inline).
- **Modified (surgical):**
  - `wallTool.js` — `commit()` calls at gesture ends.
  - `symbolTool.js` — `commit()` calls; drag-changed tracking; `D`/`R` shortcuts.
  - `symbolDimEntry.js` — `commit()` after successful resize.
  - `actions.js` — `showToastAction` (undo affordance); accept an injected `history.reset`
    reference for Reset/Import.
  - `main.js` — init history, wire `onAfterRestore`, grab new DOM refs, call `reset()` in all
    boot-restore branches.
  - `index.html` — add the rail undo/redo cluster (below a hairline separator), the `?` help
    button near the zoom cluster, the cheat-sheet overlay markup + CSS, and the toast-action
    button styling. All from existing tokens.
- **Downstream:** Phase 2 polish (#3) adds wall/room selection under the unified inspector and
  can extend the same `history.commit()` chokepoint to those gestures without changing the
  history core.
- **Platform:** static `src/`, no build step, no npm, no framework, no backend. No new network
  calls (Google Fonts `<link>` remains the only one).

## Test Requirements

Extend `src/tests.html` (same in-page `describe`/`it`/`expect` harness). Import from
`history.js`, `walls.js`, `symbols.js`. Reset `walls.model` / `symbols.model` and call
`history.reset()` between suites.

**Unit — history stack (`snapshotDoc`, `restoreDoc`, `commit`, `undo`, `redo`):**
- `snapshotDoc` returns a deep clone: mutating the returned object does not touch
  `walls.model` / `symbols.model`, and vice-versa.
- `restoreDoc` rehydrates walls + symbols in place (same array identity as `model.rooms` /
  `model.symbols`) and does NOT alter `view` or `unit`.
- After `reset()`: `canUndo()===false`, `canRedo()===false`, `_undo.length===1`.
- `commit()` after a real mutation pushes one snapshot; `canUndo()` becomes true.
- `commit()` with no net change (identical to stack top) pushes nothing.
- `undo()` restores the prior document and returns true; a second `undo()` past baseline
  returns false and leaves the document unchanged.
- `redo()` re-applies an undone snapshot; returns false when redo stack empty.
- A new `commit()` after an `undo()` truncates the redo stack (`canRedo()===false`).
- `HISTORY_CAP`: after CAP+N commits, `_undo.length === HISTORY_CAP` and the oldest snapshot
  is gone (undo cannot reach the pre-cap state).

**Unit — commit integration (drive model + controllers where feasible headlessly):**
- Placing a wall point, closing a room, and finishing a chain each yield exactly one
  undoable step; `undo()` reverses each.
- Duplicate then `undo()` returns `symbols.model.symbols.length` to its prior value.
- Delete then `undo()` restores the deleted symbol (id, pose, dims).
- A move that returns a symbol to its original pose adds no history step.

**Integration / behavioral (in-browser, manual or scripted):**
- Draw a room, then ⌘/Ctrl+Z steps back point-by-point / gesture-by-gesture; ⌘⇧Z (and
  Ctrl+Y) replays; rail Undo/Redo buttons do the same and disable at stack ends.
- Place a symbol, move it, rotate it, resize it — each is one undo step in reverse order.
- Delete a symbol → toast appears with an "Undo" button; tapping it restores the symbol;
  the same is achievable with ⌘Z after the toast dismisses.
- Duplicate a symbol → brief non-actionable toast; duplicate is selected; ⌘Z removes it.
- `D` and ⌘/Ctrl+D duplicate the selected symbol; `R` rotates 90°; Delete/Backspace deletes
  — all only in select mode with a selection, and never while typing in a dim input.
- Backspace still removes the last in-progress wall point (chain-scoped) independently of the
  global undo cluster.
- `?` opens the cheat sheet; `Esc` / outside click / close button dismisses it; the `?` help
  button near the zoom cluster opens the same overlay.
- Undo does not move the camera or flip units; pan/zoom after a delete, then undo — the view
  stays put and only the geometry returns.
- Reset / Import / opening a shared link clears history (⌘Z afterward is a no-op until a new
  gesture).
- One render per animation frame while holding ⌘Z (RAF coalescing intact); no console errors.

**Accessibility:**
- Rail undo/redo buttons have `aria-label` including the platform chord, correct `disabled`
  state, and are keyboard-focusable.
- The `?` help button has an `aria-label`; the cheat-sheet overlay has `role="dialog"`,
  `aria-modal`, a labelled heading, focus moves into it on open and returns to the trigger on
  close, and `Esc` closes it.
- The delete toast's "Undo" button is a real focusable `<button>` with an `aria-label`.

**Security:**
- No new network calls; the undo stack never leaves the client.
- Toast text and the toast-action button are built via DOM APIs / `textContent` — no
  `innerHTML` from dynamic/user-derived strings (no injection surface).
- Snapshots are plain JSON-safe objects; `restoreDoc` goes through the same validated
  `hydrate` path, so a corrupt snapshot cannot inject non-conforming geometry.

## Frontend Design

**CEO decision (LOCKED):** approve the editing layer as mocked, with two scope calls to keep
MVP-5 tight. All chrome **reuses existing warm-blueprint tokens and components — no new
visual language.** Human can override with a later `Frontend decision:` or `Restart:` comment.

**Two locked scope calls:**
- **Undo/redo granularity = per-committed-gesture.** A finished room = 1 step, a drag = 1
  step. NOT per-atomic-op. (Matches the toast model and the "instant, fun to poke at" CX bar.)
- **Wall/room selection is OUT of MVP-5.** Delete/duplicate ship for **symbols only** via the
  existing inspector; undo/redo covers wall-drawing ops but not wall selection. Full wall/room
  selection → Phase 2 polish (#3).

**1. Undo/redo cluster in the tool rail.** A new group appended to `.tool-rail`, below the
existing tools, separated by a `.tool-rail-sep` hairline — visually distinct from the
draw-mode "remove last point" button (which stays where it is, above the separator, still
bound to Backspace and chain-scoped). Two buttons reusing the existing `.tool-rail button`
styling (transparent, gold-on-active, `:disabled` at 0.35 opacity):
- **Undo** — curved-back-arrow glyph; `aria-label`/`title` = platform chord
  (“Undo (⌘Z)” on Mac, “Undo (Ctrl+Z)” elsewhere); `disabled` when `canUndo()===false`.
- **Redo** — mirrored forward-arrow glyph; `aria-label`/`title` = “Redo (⌘⇧Z)” / “Redo
  (Ctrl+Y)”; `disabled` when `canRedo()===false`.
Always visible (both desktop and mobile). On the compact/collapsible mobile rail they follow
the same rules as the other rail buttons (key hints hidden ≤640px; part of the collapsible
group ≤480px). Button `disabled` state is refreshed by `history` after every commit/undo/redo
(a small `_updateButtons()` mirroring `wallTool._updateRail`).

**2. Delete + duplicate in the existing floating symbol inspector.** No new component — the
shipped `#symbol-inspector` (rotate90 / duplicate / delete / lock-aspect) is reused verbatim.
Add **key-hint tooltips** via `title`/`aria-label` on the existing `.insp-btn`s:
duplicate → “Duplicate (⌘D)”, delete → “Delete (⌫)”, rotate90 → “Rotate 90° (R)”. No layout
change; hints are tooltip-only to keep the compact toolbar unchanged.

**3. Toasts (reuse `#toast`).** Destructive delete uses `showToastAction("Symbol deleted",
"Undo", …)` — the existing toast pill with a single inline gold-text `<button>` appended
(styled from `--gold`/`--hairline`, min tap target ≥ 32px, focusable). Duplicate uses the
plain `showToast("Duplicated")` — brief, non-actionable. Toast timing/position/reduced-motion
handling are unchanged from `actions.js`.

**4. Shortcuts cheat sheet.** A centered overlay (`role="dialog"`, `aria-modal="true"`,
`.panel` background, `--hairline` border, blur, same aesthetic as the menus/banner), opened
by `?` (Shift+/) or a small **`?` help button** placed just above the zoom cluster
(bottom-left), styled like a `.zoom-cluster button` (2.2rem square, mono `?`). Contents: a
simple two-column mono list of the documented shortcuts, platform-adjusted:

```
Draw wall            W          Undo               ⌘Z / Ctrl+Z
Select               V          Redo               ⌘⇧Z / Ctrl+Y
Finish chain         Enter/Esc  Duplicate          ⌘D / D
Remove last point    ⌫          Delete             ⌫ / Delete
Free snap (hold)     Alt        Rotate 90°         R
Pan                  Space-drag Shortcuts          ?
```

Dismiss: `?` again, `Esc`, the close button, or an outside click. Focus moves into the dialog
on open and returns to the trigger on close (accessibility). Reduced-motion: no transition.

**Mobile.** The rail stays the hero-clearing lean dock from LLD 4; undo/redo join the
collapsible group. The `?` help button sits above the zoom cluster and follows the same
bottom-left safe-area insets. The cheat sheet is full-width-minus-margins and scrollable on
short screens. Nothing new covers the canvas center.
