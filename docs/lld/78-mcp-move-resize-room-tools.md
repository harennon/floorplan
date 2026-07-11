# LLD 78: MCP — add `move_room` + `resize_room` tools (non-destructive resizer, closes LLD 32 M2 gap)

Follow-up from **LLD 63** (room editing: rigid move + rectangle-preserving resize), which added
three Node-clean pure functions to `src/js/walls.js` *specifically* so the MCP server could surface
them later, and explicitly deferred the MCP wiring to "its own LLD (tool schema, agent-loop
guidance, convergence-harness updates)". This is that LLD. It closes the gap **LLD 32 M2**
documents: the MCP server has no `resize_room` tool, and `set_edge_length`→`rescaleEdge` *deforms* a
rectangle into a parallelogram rather than resizing it — so today the agent's only fix for a
mis-sized room is destructive (`new_plan` + `add_room` from scratch, re-placing all furniture).

## Scope

**In scope** — MCP-layer wiring only:

- Re-export the LLD-63 pure functions `moveRoom`, `rescaleRectEdge`, `isRectangle`, and the helper
  `pointNearRoomWall` from `mcp/src/core.js` (they already exist and are Node-clean; **no geometry is
  re-implemented here**).
- `tool_move_room({ roomId, dx, dy })` in `mcp/src/tools.js` — rigid translate, carrying contained
  furniture (mirrors the LLD 63 editor rule).
- `tool_resize_room({ roomId, w, h })` in `mcp/src/tools.js` — non-destructive rectangle resize
  implemented as up to two `rescaleRectEdge` calls; guards non-rectangles with a clear `isError`.
- `server.js` registration for both tools (inputSchema + description, `asResult`/`isError`
  conventions).
- Update the `check_brief` oracle's room-size `unmet` guidance to prefer `resize_room` over the
  destructive `new_plan` + `add_room` rebuild.
- Update the `add_room` single-room-brief reject message (currently steers to `set_edge_length`) for
  consistency.
- Tests in `mcp/test/` mirroring the existing mutator / EC5 / invariant style, plus a
  convergence-harness case proving the loop can now *repair* a mis-sized room instead of rebuilding.

**Explicitly NOT in scope**

- **Any geometry change in `src/js/walls.js`.** The pure functions are done (LLD 63, merged 8fd7ebb);
  `walls.js` stays Node-clean. This LLD only wires the MCP layer.
- **Any editor / DOM behaviour.** The website's room move/resize UX is LLD 63 and is untouched.
- **A tool-granularity / tool-shape redesign** (that is #49's job). We add exactly two tools in the
  existing mutator idiom — no reshaping of the tool surface.
- **Multi-room resize semantics, room rotation, per-vertex edits, L-shape resize.** `resize_room`
  handles rectangles only (the shape `add_room` produces); non-rectangles are rejected, not
  approximated.
- **Grid snapping of tool coordinates.** MCP mutators operate in raw metres (like `move_symbol` /
  `place_symbol`); `move_room` applies `dx`/`dy` verbatim.

## Approach

### Re-exports (`mcp/src/core.js`)

Add to the existing `walls.js` re-export block: `moveRoom`, `rescaleRectEdge`, `isRectangle`,
`pointNearRoomWall`. `pointInRoom` (furniture-carry interior test) and `moveSymbol` are already
re-exported. This keeps the single-import-boundary contract (Q6) intact — the import-smoke test
(`import-boundary.test.js`) already asserts `core.js` loads clean under Node, and these four symbols
are pure (verified DOM-free in LLD 63).

### `tool_resize_room({ roomId, w, h })` — the shape decision

**Chosen shape: `{ roomId, w, h }` (target dimensions), NOT `{ roomId, edgeIndex, lengthM }`.**
Rationale: an agent reasoning from a brief knows the target *dimensions* ("make it 5×7 m"), not
which internal edge index maps to width vs height. `{ w, h }` matches how the agent already thinks
(and mirrors `add_room {rect:{…w,h}}` and the brief's `room:{w,h}`), so a mis-sized room is fixed
with the same vocabulary it was created with. `edgeIndex`/`lengthM` remains available via the
existing `set_edge_length` for the rare deliberate single-edge tweak.

**Implementation:** up to two internal `rescaleRectEdge` calls on the room the agent built with
`add_room`:

- `add_room {rect:{x,y,w,h}}` produces axis-aligned verts `[(x,y),(x+w,y),(x+w,y+h),(x,y+h)]`, so
  **edge 0** (`v0→v1`) is the width and **edge 1** (`v1→v2`) is the height.
- `resize_room` sets `w` via `rescaleRectEdge(room, 0, w)` and `h` via `rescaleRectEdge(room, 1, h)`.
- `rescaleRectEdge` anchors `v0` for edge 0 (moves `v1,v2`) and anchors `v1` for edge 1 (moves
  `v2,v3`); the net anchor across both calls is `v0` (the top-left origin corner), so the room grows
  from its origin corner and stays a rectangle. Edge indices are stable (vert count stays 4).
- `w` and `h` are **both optional-but-at-least-one** is rejected for simplicity — both are required
  (an agent fixing size supplies both target dims; omit-one is an ambiguous partial resize we don't
  need). See Edge Cases for the validation order.

**Guarding non-rectangles (do NOT silently pass).** `rescaleRectEdge` already self-guards
(`!isRectangle(room)` → returns `false`, no-op). We surface that explicitly: `tool_resize_room`
checks `isRectangle(room)` up front and returns `{ ok:false, reason: "resize_room only works on
rectangular rooms; this room is not a rectangle — rebuild it via new_plan + add_room" }`. This
prevents a silent no-op that the agent would misread as success.

### `tool_move_room({ roomId, dx, dy })` — furniture carry

Mirror the LLD 63 editor decision A1 (carry-at-drag-start) exactly, so the two surfaces stay
consistent:

- **Membership snapshot BEFORE mutating** (keeps the mutator synchronous and the carry set stable):
  for each symbol, decide carry by kind —
  - **furniture** (non-opening, `!CATALOG[type].openings`): carried iff `pointInRoom(room, sym.x,
    sym.y)` (strict interior).
  - **openings** (`CATALOG[type].openings`): carried iff `pointNearRoomWall(room, sym.x, sym.y,
    WALL_M)` — an opening's center sits ≈ 0.06 m off the wall centerline where `pointInRoom` is
    unreliable, so it uses the room's-own-wall proximity test (scoped to this room's segments).
- **Apply:** `moveRoom(room, dx, dy)` translates verts; each carried symbol is translated by the
  same delta via `moveSymbol(sym, sym.x + dx, sym.y + dy)`. Because the room and its wall-mounted
  openings translate rigidly, carried openings stay flush — **no opening-on-wall re-validation is
  needed** (unlike `move_symbol`, which moves one symbol independently of its wall).
- **No grid snap** (raw metres, per Scope). No history (the MCP session has no undo stack; LLD 32).

**Result shape:** `{ ok:true, roomId, metrics, carried: string[] }` where `carried` is the list of
symbol ids that moved with the room (lets the agent reason about what shifted). `metrics` echoes
`roomMetrics(room)` for parity with `add_room`.

### `check_brief` oracle guidance (`tools.js`, room-size `unmet` branch)

Two messages change from "rebuild via new_plan + add_room" to prefer the non-destructive path:

- **Room drawn but wrong size:** now names `resize_room` with the concrete target and the room id,
  e.g. `room is 4.00×4.00 m; brief asked 5×7 m (±0.025 m) — call resize_room {roomId:"w0", w:5,
  h:7} to fix it non-destructively (no rebuild needed)`. (Falls back to rebuild only if the room is
  not a rectangle — noted in the message tail.)
- **No room drawn:** unchanged intent (`add_room` at target dims) since there is nothing to resize;
  wording stays `add_room` first.

The `add_room` single-room-brief reject (which today suggests `set_edge_length to resize the
existing room`) is updated to suggest `resize_room` for the same non-destructive reason.

## Interfaces / Types

### `mcp/src/core.js` — re-export additions

```js
export {
  // …existing walls.js re-exports…
  moveRoom,          // (room, dx, dy) → void   — rigid translate (LLD 63)
  rescaleRectEdge,   // (room, edgeIndex, targetLenM) → boolean — rect-preserving resize (LLD 63)
  isRectangle,       // (room) → boolean         — axis-agnostic rectangle test (LLD 63)
  pointNearRoomWall, // (room, x, y, tolM) → boolean — opening-carry proximity test (LLD 63)
} from "../../src/js/walls.js";
```

### `mcp/src/tools.js` — new handlers (sync, no `await` — invariant test applies)

```js
/**
 * move_room: { roomId, dx, dy }. Rigid translate; carries contained furniture
 * (center ∈ room) and the room's own wall-mounted openings (within WALL_M of a
 * wall). Returns { ok, roomId, metrics, carried:[id…] } or { ok:false, reason }.
 */
export function tool_move_room(args) { /* … */ }

/**
 * resize_room: { roomId, w, h }. Non-destructive rectangle resize (LLD 32 M2 gap).
 * Sets edge 0 → w and edge 1 → h via rescaleRectEdge, anchored at the origin corner.
 * Returns { ok, roomId, newMetrics } or { ok:false, reason } (no such room /
 * not a rectangle / w or h below MIN_SEG_M).
 */
export function tool_resize_room(args) { /* … */ }
```

**Validation order for `tool_resize_room`** (reject → no mutation, mirroring `tool_set_edge_length`):
1. `room = wallsModel.rooms.find(r => r.id === roomId)`; `!room` → `{ ok:false, reason:"no such room" }`.
2. `w`,`h` both finite and `> 0` → else `{ ok:false, reason:"w and h must be finite positive" }`.
3. `!isRectangle(room)` → `{ ok:false, reason:"resize_room only works on rectangular rooms…" }`.
4. `w < MIN_SEG_M || h < MIN_SEG_M` → `{ ok:false, reason:"w and h must be ≥ <MIN_SEG_M> m" }`
   (checked before mutating so a partial resize can't leave edge 0 applied and edge 1 rejected).
5. `rescaleRectEdge(room, 0, w)` then `rescaleRectEdge(room, 1, h)`; both guaranteed `true` given the
   guards above. Return `{ ok:true, roomId, newMetrics: roomMetrics(room) }`.

**Validation order for `tool_move_room`:**
1. `!room` → `{ ok:false, reason:"no such room" }`.
2. `dx`,`dy` finite → else `{ ok:false, reason:"dx,dy must be finite" }`.
3. Snapshot carried ids (furniture via `pointInRoom`, openings via `pointNearRoomWall`).
4. `moveRoom` + translate carried symbols. Return `{ ok:true, roomId, metrics, carried }`.

### `mcp/src/server.js` — registrations (existing idiom)

```js
server.registerTool("move_room", {
  description: "Move a whole room by (dx,dy), carrying its furniture and its own doors/windows. " +
    "Non-destructive; returns the carried symbol ids." + FRAME,
  inputSchema: { roomId: z.string(), dx: z.number(), dy: z.number() },
}, (args) => asResult(tools.tool_move_room(args)));

server.registerTool("resize_room", {
  description: "Resize a RECTANGULAR room to exact target w×h metres (anchored at its origin " +
    "corner), non-destructively — use this instead of rebuilding a mis-sized room. " +
    "Fails on non-rectangular rooms.",
  inputSchema: { roomId: z.string(), w: z.number(), h: z.number() },
}, (args) => asResult(tools.tool_resize_room(args)));
```

Both follow `asResult`: `{ ok:false }` results auto-flag `isError:true`; success shapes need no
outputSchema (the mutators don't declare one today).

## State Model

- **No new persisted state, no schema change.** Both tools mutate `wallsModel.rooms[*].verts` (and,
  for carry, `symbolsModel.symbols[*].x/y`) in place — the same arrays `buildPlan`/`serializePlan`
  already emit and `validatePlan` already checks. `get_plan` / `save_plan` / `get_share_url`
  round-trip unchanged.
- **Synchronous mutators** (no `await`): both handlers are fully synchronous, satisfying the LLD 32
  concurrency contract enforced by `mutator-invariant.test.js`. Do not introduce the token `await`
  in these bodies.
- **No MCP undo.** The MCP session has no history stack (unlike the editor). `move_room` is reversed
  by an inverse `move_room`; `resize_room` by another `resize_room`. This is acceptable — the whole
  point is that resize is now cheap and repeatable.
- **Carry membership is transient**, computed once per call from geometry; never persisted (matches
  LLD 63's no-back-link decision).

## Edge Cases

1. **`resize_room` on a non-rectangular room** (L-shape, triangle, 5+ verts, open polyline).
   `isRectangle` false → `{ ok:false, reason }` explicitly (NOT a silent no-op). Agent is told to
   rebuild.
2. **`resize_room` `w` or `h` below `MIN_SEG_M`.** Rejected before any mutation → `{ ok:false }`;
   room unchanged (no partial edge-0-only resize).
3. **`resize_room` non-finite / non-positive `w`/`h` (NaN, 0, negative).** Rejected at step 2.
4. **`resize_room` on a room rotated off-axis** (a valid rectangle drawn at an angle). `w`→edge 0,
   `h`→edge 1 still apply along the rectangle's own local axes; the mapping is edge-index based, so
   for a 90°-rotated room `w` sets what was originally the vertical edge. Agents build axis-aligned
   rooms via `add_room`, so this is a non-issue in practice; documented so it isn't a surprise. For a
   deliberate single-edge change on such a room, use `set_edge_length`.
5. **`resize_room` no-op (target already equals current dims).** `rescaleRectEdge` computes
   `delta = target − |edge|` ≈ 0 and shifts by ~0; returns `true`; `newMetrics` reflects the
   (unchanged) size. `{ ok:true }`. Harmless.
6. **`resize_room` under a single-room brief.** No count guard needed — resize mutates the existing
   room, never adds one. (Contrast `add_room`'s Gap A guard.)
7. **`move_room` unknown `roomId`.** `{ ok:false, reason:"no such room" }`, no mutation.
8. **`move_room` non-finite `dx`/`dy`.** Rejected, no mutation.
9. **`move_room` with `dx===0 && dy===0`.** `moveRoom` is no-op-safe; carried symbols shift by 0;
   `{ ok:true, carried:[…] }`. (Carry set still computed/returned.)
10. **`move_room` carries the room's own door/window.** Openings ride via `pointNearRoomWall(room,…,
    WALL_M)`; rigid translate keeps them flush, so no opening-on-wall re-check is required and none
    is left behind. An opening on a *neighbour's* wall is not grabbed (per-room segment scoping).
11. **`move_room` symbol exactly on the room boundary.** Non-openings use strict `pointInRoom`
    (even-odd ray cast) — a center exactly on an edge is a coin-flip, same as the editor; acceptable
    (matches LLD 63). Openings use the wall-proximity band, which is the reliable path for
    boundary-adjacent symbols.
12. **`move_room` pushes the room off-screen / overlapping another room.** Allowed — freeform
    sketcher, no constraint solver (matches editor Edge Case 7 and `move_symbol` behaviour).
13. **`move_room` on an open polyline room** (`closed !== false` matters only for carry). `moveRoom`
    works on open rooms too (translates all verts); furniture carry via `pointInRoom` needs a closed
    polygon — an open room carries nothing (interior undefined). `{ ok:true, carried:[] }`. Not a
    primary path (MCP rooms are closed via `add_room`), but does not throw.
14. **`check_brief` guidance when the mis-sized room is non-rectangular.** The `unmet` message
    prefers `resize_room` but appends the rebuild fallback, so an agent that gets a `resize_room`
    rejection (EC1) has the alternative in hand.

## Dependencies

**Must already exist (all present):**

- **LLD 63 merged (commit 8fd7ebb):** `moveRoom(room, dx, dy)`, `rescaleRectEdge(room, edgeIndex,
  targetLenM)`, `isRectangle(room)`, `pointNearRoomWall(room, x, y, tolM)`, and `RIGHT_ANGLE_COS_TOL`
  in `src/js/walls.js` — verified Node-clean. **This is the hard blocker and it is cleared.**
- `mcp/src/core.js` re-export boundary; `pointInRoom` and `moveSymbol` already re-exported.
- `mcp/src/tools.js` mutator idiom (`isFiniteNum`, reject-before-mutate, `roomMetrics`), `CATALOG`,
  `WALL_M`, `MIN_SEG_M`.
- `mcp/src/server.js` `registerTool` + `asResult`/`isError` + `FRAME` conventions.
- `import-boundary.test.js` (guards the new re-exports stay Node-clean) and
  `mutator-invariant.test.js` (guards the new handlers stay synchronous).

**No new third-party deps, no build step.** `walls.js` stays Node-clean (unchanged).

## Test Requirements

New tests in `mcp/test/` (node `--test`), mirroring `mutators.test.js` / `convergence.test.js`
style (`beforeEach(() => session.resetAll())`).

### Unit — `resize_room` (mutators.test.js additions)

- **Resizes a rectangle to exact w×h non-destructively:** `add_room {rect:0,0,4,4}` → `resize_room
  {roomId, w:5, h:7}` → `ok:true`; `newMetrics.area === 35`; room still 4 verts & closed;
  `isRectangle(room)` still true; the origin corner `v0` unchanged (anchor). Assert this is a *resize*
  not a shear (all four corners ~90°).
- **Furniture placed after resize is unaffected; furniture is NOT re-placed** (the whole point vs the
  destructive rebuild) — place a symbol, resize, assert the symbol still exists at its coordinates.
- **Non-rectangle rejected with a clear reason, no mutation:** build a triangle / L-shape (via
  `verts`), `resize_room` → `ok:false`, `reason` matches `/rectangular/`, verts unchanged.
- **`w`/`h` below `MIN_SEG_M` rejected, no partial resize:** assert edge 0 was NOT applied
  (room unchanged) when `h` is too small.
- **Non-finite / non-positive `w`/`h` rejected** (`NaN`, `0`, negative) without throwing.
- **Unknown `roomId` → `ok:false`.**

### Unit — `move_room` (mutators.test.js additions)

- **Rigid translate:** `add_room`, `move_room {dx:2, dy:3}`; every vert shifted by exactly (2,3);
  `metrics.area` invariant.
- **Carries contained furniture:** place a bed at room center, `move_room`; the bed's `x/y` shifted
  by the same delta; `carried` includes the bed id.
- **Does NOT carry outside furniture:** a symbol outside the room polygon is unchanged and absent
  from `carried`.
- **Carries the room's own opening (door/window):** place a door on the top wall, `move_room`; the
  door moved with the room and remains valid (still on the moved wall); door id in `carried`.
- **`dx===0 && dy===0` no-op-safe:** `ok:true`, verts/symbols numerically identical.
- **Unknown `roomId` / non-finite `dx`/`dy` → `ok:false`, no mutation.**

### Unit — `check_brief` guidance (mutators.test.js additions / update)

- **Wrong-size room `unmet` message now references `resize_room`** (assert `/resize_room/` in the
  message) instead of the old `new_plan + add_room` rebuild string.
- **No-room-drawn message still references `add_room`** (nothing to resize).

### Integration — convergence harness (convergence.test.js addition)

- **Repair-by-resize loop:** set a `{ room:{w:5,h:7} }` brief, `add_room` the room at the *wrong*
  size (e.g. 4×4), confirm `check_brief` unsatisfied and its `unmet` steers to `resize_room`; the
  scripted agent calls `resize_room {roomId, w:5, h:7}`; assert `check_brief` room-size requirement
  now satisfied **without** any `new_plan`/re-`add_room`/re-`place_symbol` — proving the loop repairs
  instead of rebuilding (the LLD 32 M2 gap closed).

### Structural / regression (must stay green unchanged)

- `mutator-invariant.test.js` — the two new handlers must contain no `await` (auto-covered once
  added; they are synchronous by design).
- `import-boundary.test.js` — `core.js` still loads clean under Node with the four new re-exports.
- Existing `set_edge_length` tests — **unchanged**; `rescaleEdge` and `set_edge_length` are not
  touched by this LLD (the footgun tool remains for deliberate single-edge edits).
