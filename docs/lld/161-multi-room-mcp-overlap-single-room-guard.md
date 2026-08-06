# LLD 161: Multi-room support for the MCP server — room-overlap evaluation + single-room guard (LLD 32 Q8)

## Scope

Closes the first half of LLD 32 Open-question **Q8**: no evaluator, in `src/` or `mcp/`,
checks whether two *room polygons* overlap. `validatePlan` is purely structural and
`clearance.js` is symbol-subject-only, so a plan with overlapping or disjoint rooms passes
every check. This is not a convergence blocker under today's single-room MVP brief, but it is
real the moment a brief has more than one room.

**In scope (the two shippable pieces):**
1. **Polygon–polygon intersection test** — a new pure function in the `mcp/` geometry layer
   (`mcp/src/overlap.js`) that decides whether two closed room polygons intersect. Wired into
   `check_brief` so an overlapping pair produces a natural-language `unmet` entry naming both
   rooms.
2. **Single-room guard** — reject a second `add_room` while the active `Brief` describes a
   single room. **This already exists** in `tool_add_room` (Gap A, shipped in #83) and is
   tested; this LLD documents it as the contract, closes one behavioural gap (it only fires
   when `brief.room` is set), and keeps it as the cheap MVP mitigation alongside the overlap
   evaluator.

**Explicitly NOT in scope (deferred within Q8 / to #50):**
- **No full multi-room brief model.** `Brief.room` stays a single optional `{w,h}`. A
  `rooms: [...]` brief array, per-room furniture assignment, and a rewritten `check_brief`
  oracle that evaluates multi-room requirements are **deferred** — the overlap check + guard
  are the deliverable, not multi-room modelling.
- **No coordinated multi-room convergence.** Driving an agent to *resolve* an overlap across
  two rooms (the joint-convergence loop) is #50 (M6 joint-convergence gap), not this.
- **No `src/` changes.** The test lives entirely under `mcp/`; it reuses `pointInRoom` from
  `clearance.js` (already exported through `core.js`) but adds no new `src/js` function and
  does not touch the `plan.js` document contract or the browser editor.
- **No overlap *auto-repair*** (no `suggestedMove` for rooms). `check_brief` only *reports*
  the overlap; repositioning rooms is the agent's job via `move_room`/`resize_room`.
- **No session-store migration.** The single-session → multi-session store migration noted in
  Q8/PR #47 is recorded as future work in the State Model, not built here.

## Approach

### Where the test lives

A new pure module **`mcp/src/overlap.js`**, exported through nothing else — imported directly
by `tools.js` for the `check_brief` wiring. Keeping it in `mcp/` (not `walls.js`) honours the
"stay isolated to `mcp/`, no `src/` change" constraint: the browser editor has no room-overlap
requirement today, so adding the primitive to `src/` would be speculative surface area. The
function is pure (verts in, boolean out) and reuses `pointInRoom` (already Node-clean, already
re-exported by `core.js`) for the containment leg.

### The intersection algorithm (general polygons, not just rectangles)

`add_room {rect}` produces axis-aligned rectangles, but `add_room {verts}` can produce convex
*or* concave polygons, so the test must be general. Two closed polygons A, B intersect iff
**any of**:

1. **An edge of A properly crosses an edge of B** — segment–segment intersection at an interior
   point (orientation-sign test; collinear/endpoint-only touches excluded). Catches partial
   overlaps and X-crossings.
2. **A vertex of B lies strictly inside A**, or a **vertex of A lies strictly inside B**
   (`pointInRoom`, strict interior). Catches full containment (one room entirely within
   another), which produces no edge crossing.

If neither holds, the rooms are **disjoint or merely edge-adjacent** (sharing a wall) → not an
overlap. This is deliberate: two rooms sharing a wall is a legitimate adjacent-room layout, not
a defect. Proper (interior-crossing, non-collinear) segment intersection returns `false` for a
shared collinear edge, and strict `pointInRoom` treats on-edge points as indeterminate, so a
clean shared wall does not false-positive.

### Wiring into `check_brief`

`tool_check_brief` gains a room-overlap pass **after** the room-size check and **before**
returning: enumerate all unordered pairs of `closed` rooms; for each pair where
`roomsOverlap(a, b)` is true, push one `unmet` string naming both room ids. Runs whenever there
are ≥ 2 closed rooms — which, given the single-room guard, only happens under a brief with **no**
`room` field (or none set) where the agent legitimately drew multiple rooms. `satisfied` stays
`unmet.length === 0`, so any overlap flips the brief to unsatisfied.

### The single-room guard (already shipped — documented + one gap closed)

`tool_add_room` already rejects a second closed room when `getBrief()?.room` is set (Gap A,
#83), returning `{ ok:false, reason: "single-room brief already has a room …" }` **before any
mutation** (no sliver room persists). It steers the agent to `new_plan` or `resize_room`
instead of stacking rooms. This LLD keeps that verbatim and notes its one intentional
limitation: the guard is a *brief-scoped* mitigation — it does nothing when no brief is set or
when a brief omits `room`. That residual multi-room case is exactly what the overlap evaluator
now covers, so the two pieces are complementary: the guard prevents the common single-room
foot-gun cheaply and synchronously; the evaluator catches genuine multi-room overlaps.

## Interfaces / Types

```js
// mcp/src/overlap.js — new pure module.

/**
 * True iff segments p1→p2 and p3→p4 cross at an interior point.
 * Orientation-sign test; collinear and endpoint-only touches return false
 * (so shared room walls are NOT treated as crossings).
 * @param {{x,y}} p1 @param {{x,y}} p2 @param {{x,y}} p3 @param {{x,y}} p4
 * @returns {boolean}
 */
export function segmentsProperlyIntersect(p1, p2, p3, p4): boolean

/**
 * True iff two CLOSED room polygons intersect (partial overlap, X-crossing, or
 * full containment). Edge-adjacent (shared-wall) rooms return false.
 * @param {import("../../src/js/walls.js").Room} a  closed room
 * @param {import("../../src/js/walls.js").Room} b  closed room
 * @returns {boolean}
 */
export function roomsOverlap(a, b): boolean
```

No change to `Brief`, `ClearanceReport`, `Gap`, or `BriefReport` types. The only observable
contract change is additional strings in `BriefReport.unmet`:

```
"rooms r0 and r1 overlap — move or resize one so they do not intersect"
```

The single-room guard's existing shape is unchanged:
```js
// tool_add_room, before any mutation (existing):
{ ok:false, reason:"single-room brief already has a room (r0); call new_plan … or resize_room …" }
```

## State Model

No new persisted or session state. `roomsOverlap` is pure — it reads only the `verts` arrays of
the two rooms passed in. `check_brief` reads the live `wallsModel.rooms` singleton (via the
existing `world()`/`wallsModel` access) exactly as it already does for the room-size check; no
snapshot, no mutation, so the "no mutator awaits" concurrency invariant is untouched (the
overlap pass is synchronous and read-only).

The single-room guard is likewise stateless beyond reading `getBrief()` and `wallsModel.rooms`.

**Migration note (recorded, not built):** if the server is ever made to serve multiple plans
(the single-session → multi-session store migration flagged in Q8 / PR #47), the overlap
evaluator is unaffected — it operates on whichever plan's `rooms` are passed to `check_brief`.
That migration remains future work.

## Edge Cases

1. **Fewer than 2 closed rooms.** Overlap pass iterates zero pairs → no `unmet` entry. The
   single-room MVP path is completely unaffected (no behaviour change, no cost).
2. **Shared-wall adjacency** (two rooms sharing a full edge). Not an overlap: proper segment
   intersection excludes collinear edges and strict `pointInRoom` excludes on-edge vertices.
   Reported as satisfied (correct — adjacent rooms are valid).
3. **Full containment** (room B entirely inside room A, no edge crossing). Caught by the
   vertex-in-polygon leg (a vertex of B is strictly inside A).
4. **Vertex exactly on the other room's edge** (degenerate touch). `pointInRoom` is documented
   as indeterminate on an edge; a pure boundary touch may or may not flag. Accepted for MVP —
   a genuine overlap always has a strictly-interior vertex or a proper crossing; a boundary
   kiss is not a meaningful overlap. Documented, not special-cased.
5. **Concave (e.g. L-shaped) room.** The general algorithm (any-edge-cross OR
   vertex-containment) handles concave polygons; no convexity assumption. `add_room {verts}`
   can produce these.
6. **Open / unclosed rooms.** `check_brief` filters to `r.closed` before pairing, matching the
   existing room-size logic; an in-progress chain is never tested.
7. **Self-overlap / degenerate room.** `add_room` already rejects zero-area and <3-corner
   rooms (`tool_add_room` EC5), so a persisted room is always a valid closed polygon; the
   overlap test assumes ≥3 verts.
8. **Guard: brief with no `room` field, agent draws 2 rooms that overlap.** Guard does not fire
   (no single-room brief); overlap evaluator catches it in `check_brief`. This is the exact
   residual case the evaluator exists for.
9. **Guard: no brief set.** Guard does not fire (matches existing behaviour); overlap evaluator
   still runs whenever ≥2 closed rooms exist, so overlaps are still reported.
10. **Many rooms (N).** Pairwise scan is O(N²) polygon pairs × O(E²) edge pairs. Room counts in
    a hand-authored plan are tiny (single digits); no spatial index needed. Not optimised.

## Dependencies

**Must exist before implementation (all present):**
- `mcp/src/core.js` — re-exports `pointInRoom` from `clearance.js` (present, Node-clean).
- `mcp/src/tools.js` — `tool_check_brief` (present) and `tool_add_room` with the existing
  single-room guard (present, #83).
- `mcp/src/brief.js` — `getBrief` (present); `Brief.room` shape unchanged.
- `src/js/walls.js` `Room` type (`{ id, verts:[{x,y}], closed }`) — read-only consumer.

**New (all under `mcp/`, no `src/` changes):**
- `mcp/src/overlap.js` — `segmentsProperlyIntersect`, `roomsOverlap`.
- `mcp/test/overlap.test.js` — unit tests for the geometry.
- Additions to an existing `check_brief` test file (or a new one) for the wiring.

No new external dependency. No `plan.js` contract change. No project.json change (the `mcp/`
Node suite is already run per LLD 32 M4 wiring).

## Test Requirements

Tests live under `mcp/`, run via `node --test` (headless, no browser). Organised by category.

**Unit — overlap geometry (`overlap.js`):**
- `segmentsProperlyIntersect`: crossing segments → true; disjoint → false; collinear-overlapping
  → false; endpoint-only touch → false; T-junction (endpoint on the other's interior) → false.
- `roomsOverlap`: two rectangles partially overlapping → true; disjoint rectangles → false;
  shared-wall-adjacent rectangles (sharing a full edge) → **false**; one rectangle fully inside
  another → **true**; concave (L-shaped) room overlapping a rectangle → true; two identical
  rooms → true.

**Unit — `check_brief` wiring (`tools.js`):**
- Two overlapping closed rooms in the plan → `check_brief` returns `satisfied:false` with an
  `unmet` string naming both room ids and the word "overlap".
- Two disjoint (or shared-wall-adjacent) rooms with all other requirements met → no overlap
  entry in `unmet`; if nothing else is unmet, `satisfied:true`.
- Single closed room (MVP path) → overlap pass adds nothing (regression: existing single-room
  briefs behave identically).

**Unit — single-room guard (`tools.js`, regression — already exists):**
- Second `add_room` under a `brief.room` single-room brief → `{ ok:false, reason:/already has a
  room/ }` and no sliver room persisted (existing test in `mutators.test.js`; keep passing).
- First `add_room` under a single-room brief still accepted (existing regression; keep passing).
- With **no** `room` in the brief, a second `add_room` is **allowed** (documents the guard's
  intentional brief-scoped limitation) and, if the two rooms overlap, `check_brief` reports it.
</content>
</invoke>
