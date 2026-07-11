# LLD 71: MCP hardening — validate room count + opening-on-wall placement

## Scope

Two independent input-validation gaps in the **dev-only MCP server** (`mcp/`), surfaced
while exercising the tools end-to-end. Both let an agent build a nonsense plan that still
passes every evaluator (`check_clearance` / `check_brief`) — the same "false satisfied"
class the containment fix (PR #70) closed. Follows the LLD 47 hardening-nits pattern:
small, additive, reject-at-the-mutator.

Covers exactly two items, landing together:

- **Gap A — single-room count guard** (`tool_add_room`, `mcp/src/tools.js` ~L102).
  Under a single-room brief (`getBrief().room` set) with a closed room already present,
  reject a further `add_room`.
- **Gap B — opening-on-wall placement guard** (`tool_place_symbol` ~L174 and
  `tool_move_symbol` ~L222). Reject placing/moving a `door`/`window`
  (`CATALOG[type].openings`) whose footprint is not adjacent to any wall segment.

**Explicitly NOT in scope** (stays deferred — do not drift):
- Room-to-room polygon overlap / general multi-room validation (LLD 32 Q8). Gap A is a
  **count** guard only; when multi-room briefs exist this guard is superseded, not extended
  here.
- Any opening validation beyond wall-adjacency at place/move time (e.g. two openings
  overlapping on the same wall span, opening wider than its wall).
- Rotate/resize re-validation of an already-placed opening (see Edge Cases).
- Any change to the shared editor (`src/js/*` runtime behaviour). The only `src/js`
  touch is a read of existing pure geometry; `walls.js` / `symbols.js` / `clearance.js`
  must stay Node-clean (no DOM/browser globals) — the MCP server imports them.

## Approach

### Gap A — single-room count guard (`tool_add_room`)

Add a guard at the **top of `tool_add_room`, before any arg parsing or `placeVertex`**, so
a rejected call never mutates `wallsModel` (no chain junk, no sliver — matches the existing
`< 3` / zero-area reject discipline of leaving state untouched).

Guard condition:
```
const brief = getBrief();
if (brief && brief.room && wallsModel.rooms.some((r) => r.closed)) {
  return { ok: false, reason: <actionable> };
}
```
- `getBrief()` is already imported in `tools.js`.
- Only fires when the brief specifies a **single room** (`brief.room` truthy). A brief with
  no `room` requirement, or no brief at all, is unaffected — the tool stays maximally
  permissive when nothing says "one room."
- Only a **closed** room blocks (`r.closed`); an open polyline chain does not (there should
  be none under a single-room flow, but the check is precise about what "already has a
  room" means).
- **Reason string** must guide the agent to the two valid recoveries — start over, or edit
  the existing room:
  `"single-room brief already has a room (<id>); call new_plan to start over, or
  set_edge_length to resize the existing room instead of adding another"`.
  (`<id>` = the existing closed room's id, so the agent can target `set_edge_length`.)

Rationale: this is LLD 32 Q8's recommended cheap mitigation. It closes the "second disjoint
/ overlapping room slips through `check_brief`" hole (no evaluator counts rooms or tests
room-to-room overlap) without taking on polygon-overlap geometry, which stays deferred until
multi-room briefs are a real feature.

### Gap B — opening-on-wall placement guard (`tool_place_symbol`, `tool_move_symbol`)

Openings (`door`, `window`) are the only symbols `computeClearances` skips (returns `[]`,
`clearance.js` L248) — so a door dropped floating in the middle of a room is invisible to
`check_clearance` and `check_brief`. Reject off-wall openings **at placement/move time**
(simpler than, and consistent with, the existing per-mutator validation style; avoids
inventing a new `check_brief` "unmet" category for a thing the clearance engine can't see).

**New pure helper** (module-private in `tools.js`), mirroring `nearestWallFlush`'s
parallel + adjacency math (`src/js/symbols.js` L293) trimmed to a boolean:

```
openingOnWall(sym, segments, tolM) -> boolean
```
For each wall segment it checks, exactly as `nearestWallFlush` does:
1. **Parallel:** the segment direction is within `PARALLEL_TOL_DEG` (12°) of the symbol's
   local x- or y-axis (`|cos angle| >= cos(tol)`).
2. **Overlap:** the symbol's projected t-span onto the segment direction overlaps the
   segment's own `[0, segLen]` span (footprint actually spans part of that wall).
3. **Adjacency:** the smaller `|gap|` from the symbol's near edge to either wall face
   (`n = ±WALL_M/2`) is `<= tolM`.

Returns `true` on the first segment satisfying all three; `false` if none do.

- **Inputs are injected** (pure, Node-clean): `corners(sym)` (already exported via
  `core.js`), `wallSegments()` (see Interfaces — add the re-export), and `WALL_M` (already
  re-exported).
- **Tolerance** `WALL_ADJ_TOL_M = 0.15` (module const in `tools.js`). An opening seated on a
  wall has near-edge-to-face gap ≈ 0 (a door of depth `WALL_M` centred on the centerline,
  or edge-flush to the inner face, both land ≈ 0). 0.15 m gives an agent placement slack
  (grid snap, off-by-a-cell) while a door ≥ 0.15 m off every wall face — i.e. floating in the
  room — is rejected. Not tied to the editor's `WALL_FLUSH_PX` (that is a screen-px tolerance
  with no meaning server-side).

Why mirror rather than call `nearestWallFlush` directly: only `wallSegments` is added to the
`core.js` boundary (one line); the boolean helper needs neither the flush translation vector
nor the guide segment `nearestWallFlush` returns, so a trimmed local copy is smaller than
threading the full candidate object and its extra exports. The math is identical, so behaviour
tracks the editor's flush notion of "on a wall."

**Wiring — `tool_place_symbol`:** after `createSymbol` + w/rot applied, **before**
`addSymbol`, if `isOpening` and `!openingOnWall(sym, wallSegments(), WALL_ADJ_TOL_M)` →
`return { ok:false, reason }`. The symbol was never added, so no rollback is needed. Reason:
`"a <label> must sit on a wall; place it within 0.15 m of a wall segment (center on the
wall line)"`.

**Wiring — `tool_move_symbol`:** openings only. Capture `prevX/prevY`, `moveSymbol`, then if
`isOpening` and `!openingOnWall(...)` → restore `moveSymbol(sym, prevX, prevY)` and return
`{ ok:false, reason }`. Non-openings skip the check entirely.

**Furniture is unaffected:** the check is gated on `CATALOG[type].openings`; every non-opening
`place_symbol` / `move_symbol` path is byte-for-byte unchanged.

## Interfaces / Types

No public MCP tool signature changes. The set of inputs that yield `{ ok:false, reason }`
grows for `tool_add_room`, `tool_place_symbol`, `tool_move_symbol`.

**`mcp/src/core.js`** — add one re-export (`wallSegments` is currently *not* on the boundary):
```
// in the walls.js re-export block:
wallSegments,
```
(from `../../src/js/walls.js`; it is pure — no DOM.) `corners`, `WALL_M`, `CATALOG`,
`getBrief` are already available.

**`mcp/src/tools.js`** — module-private additions (not exported):
```
const WALL_ADJ_TOL_M = 0.15;   // metres; opening near-edge-to-wall-face adjacency slack

/** True if an opening's footprint is parallel-and-adjacent to some wall segment.
 *  Mirrors nearestWallFlush parallel+overlap+face-gap math, reduced to a boolean. */
function openingOnWall(sym, segments, tolM)  // -> boolean
```
`PARALLEL_TOL_DEG` (12) may be re-exported from `core.js` for reuse, or inlined as a local
const in the helper — implementer's choice; prefer re-export to keep one source of truth.

## State Model

No change to what is persisted vs in-memory. The server keeps its single plan in the core
singletons (`wallsModel` / `symbolsModel`); nothing here adds persistence, and `getBrief()`
reads session-only brief state (never serialized).

- **Gap A** reject path runs before any mutation → `wallsModel` is untouched (no room, no
  chain residue). A failed `add_room` is a no-op on state.
- **Gap B — place** reject path runs before `addSymbol` → `symbolsModel` is untouched.
- **Gap B — move** reject path restores the prior center via a second `moveSymbol`, so the
  opening keeps its original valid position; net state unchanged.

## Edge Cases

1. **No brief set / brief without `room`** → Gap A guard does not fire; `add_room` behaves
   as today (multi-room drawing still allowed when nothing constrains it).
2. **Single-room brief, first room** → guard sees no closed room, allows it. Second closed
   room → rejected, state untouched.
3. **Single-room brief with only an open chain present** → `some(r => r.closed)` is false, so
   `add_room` is allowed (there is no completed room yet).
4. **Gap A ordering vs. bad args** → guard runs first, so `add_room({})` under a satisfied
   single-room brief returns the count reason, not the arg-shape reason. Acceptable: the
   agent's real problem is "you already have your room."
5. **Opening centered exactly on the wall centerline** → near-edge-to-face gap ≈ 0 → accepted.
6. **Opening placed with its inner edge flush to the wall face** → near edge gap ≈ 0 →
   accepted.
7. **Opening floating in the room interior (> tol from every wall)** → no segment passes the
   adjacency test → rejected. This is the primary bug being closed.
8. **Opening parallel-adjacent to a wall but beyond the wall's ends** (t-span no overlap) →
   rejected (overlap check fails) — a door hanging off the corner past the wall is not "on"
   it.
9. **Rotated opening not parallel to any wall** → fails the parallel check → rejected. (An
   agent must orient a door along the wall it sits on.)
10. **`move_symbol` of a furniture item** → not an opening → check skipped → unchanged
    behaviour (regression guard).
11. **`move_symbol` of an opening to a still-valid on-wall spot** → accepted, returns fresh
    clearance as today.
12. **`rotate_symbol` / `resize_symbol` taking a placed opening off-wall** → NOT re-validated
    (out of scope). A rotate that swings a door off-parallel would leave it "off wall" without
    a reject. Documented gap; place/move are the entry points that matter for the tested
    failure. Revisit only if it surfaces.
13. **No walls drawn yet, then `place_symbol` of an opening** → `wallSegments()` empty →
    `openingOnWall` false → rejected with the same reason (correct: nothing to seat on).

## Dependencies

- **Existing source, modified:** `mcp/src/tools.js` (both gaps), `mcp/src/core.js` (one
  `wallSegments` re-export; optional `PARALLEL_TOL_DEG` re-export).
- **Existing pure geometry, read-only reuse:** `src/js/walls.js` `wallSegments()`,
  `src/js/symbols.js` `nearestWallFlush` (as the math being mirrored), `corners`,
  `PARALLEL_TOL_DEG`, `WALL_M`. All already Node-clean and verified by the import-smoke test
  (`mcp/test/import-boundary.test.js`) — the new `wallSegments` export must keep that test
  green.
- **Existing brief store:** `mcp/src/brief.js` `getBrief()` (already imported in `tools.js`).
- **Related shipped work:** PR #70 (MCP furniture containment + walkway re-grounding);
  LLD 47 (`docs/lld/47-mcp-server-hardening-nits.md`) — the reject-at-mutator pattern this
  follows; LLD 32 Q8 — the deferred room-overlap analysis Gap A partially mitigates.
- **Test runner:** `node --test` over `mcp/`, already wired into the validate workflow. No new
  tooling or dependency (consistent with "deploy cheap / no build step").
- The two gaps are independent of each other and can land in one PR.

## Test Requirements

Add to `mcp/test/mutators.test.js` (mirror the existing containment / EC5 cases). Organized by
category; specify what, not how.

### Unit — Gap A (`tool_add_room` count guard)
- **Second room under single-room brief rejected, no sliver:** `set_brief({room:{w,h}})`,
  `new_plan`, `add_room` (rect) → ok; a second `add_room` → `{ ok:false }` with a reason
  matching `/already has a room/` (or similar), and `wallsModel.rooms.length === 1` (no
  sliver/second room persisted).
- **First room still accepted under single-room brief** (regression): the one allowed
  `add_room` returns `{ ok:true }`.
- **No brief / brief without `room` → multi-room still allowed** (regression): two
  `add_room` calls both succeed when no single-room constraint exists.
- **Guard is a no-op on state when it rejects:** rooms count and chain length unchanged after
  the rejected call.

### Unit — Gap B (opening-on-wall)
- **Opening off-wall rejected:** room `add_room({rect:{0,0,4,4}})`, `place_symbol` a `door`
  at the room center `(2,2)` → `{ ok:false }`, `symbolsModel.symbols.length === 0`.
- **Opening on-wall accepted:** `place_symbol` a `door` centered on a wall (e.g. `(2,0)`
  on the top wall of the 4×4 room, appropriately oriented) → `{ ok:true }`, symbol added.
- **`move_symbol` an on-wall opening off-wall → rejected + restored:** place a valid door,
  move it to `(2,2)` → `{ ok:false }`, and the door's center is unchanged (still on the
  wall).
- **Furniture unaffected (regression):** placing and moving a `bed`/`sofa` anywhere
  (including mid-room) still succeeds — the wall check never runs for non-openings.
- **No walls → opening rejected:** `new_plan` with no room, `place_symbol` a `window` →
  `{ ok:false }`.

### Structural / boundary
- **Import-smoke stays green:** `mcp/test/import-boundary.test.js` must still pass after the
  `wallSegments` (and optional `PARALLEL_TOL_DEG`) re-export — confirms no DOM leak entered
  the boundary.
</content>
</invoke>
