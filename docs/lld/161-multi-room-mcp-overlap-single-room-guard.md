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
- **No `src/` changes.** The test lives entirely under `mcp/` (a self-contained `overlap.js`
  with its own point-in-polygon logic — it does *not* reuse `clearance.js`'s `pointInRoom`,
  whose on-edge behaviour is undefined). It adds no new `src/js` function and does not touch the
  `plan.js` document contract or the browser editor.
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
module is self-contained and pure (verts in, boolean out); it does **not** import
`clearance.js`'s `pointInRoom`, because that function explicitly disclaims on-edge results and
the overlap decision must be deterministic on boundary-touching configurations. `overlap.js`
carries its own `pointStrictlyInside` with an explicit boundary epsilon (below).

### The overlap definition (deterministic — the "interiors intersect" rule)

`add_room {rect}` produces axis-aligned rectangles, but `add_room {verts}` can produce convex
*or* concave polygons, so the test must be general.

**Definition.** Two closed rooms A, B **overlap** iff their *interiors* share positive area.
Boundary-only contact — a shared full edge (wall-adjacency), a shared partial edge, or a shared
single vertex — is **NOT** an overlap. This is the single rule from which every guarantee below
follows; it is what makes the two firm test assertions (identical rooms → `true`, shared-wall
rooms → `false`) consistent rather than contradictory.

**Why boundary handling must be explicit.** The obvious implementation — "any vertex of B lies
inside A" via `pointInRoom` — is *not* deterministic: `pointInRoom` (clearance.js:162-163)
disclaims on-edge results ("may return true or false — not guaranteed"). For two identical
rectangles A = B, *every* vertex of B lies exactly on A's boundary and no edge properly crosses,
so a vertex-based test could return either answer. The design below never queries a vertex; it
queries a **constructed strictly-interior point**, which by construction is off the other room's
boundary in exactly the degenerate cases (identical, adjacency, containment) that made the naive
test ambiguous. That is the fix.

**Algorithm.** `roomsOverlap(a, b)` returns `true` iff **either**:

1. **Proper edge crossing** — some edge of A and some edge of B cross at a point interior to
   *both* segments (`segmentsProperlyIntersect`, below). This is an orientation-sign test: it
   requires strict sign opposition of the two cross-products on each side, so **collinear
   overlaps, endpoint-only touches, and T-junctions all return `false`**. Catches every partial
   overlap and X-crossing. A shared collinear wall is collinear → not a proper crossing.

2. **Interior containment** — a *constructed strictly-interior point* of A lies strictly inside
   B, **or** a strictly-interior point of B lies strictly inside A (`pointStrictlyInside`,
   below). Catches full containment and the identical-room case, neither of which produces an
   edge crossing.

**Why one interior point per room is sufficient (and deterministic).** For two *simple*
polygons, if no pair of edges properly crosses then their boundaries do not interleave, so one
region is either wholly inside the other, wholly outside, or shares only boundary. Containment
is therefore all-or-nothing in the no-crossing branch: *any* interior point of the contained
room lies inside the container, so a single representative point decides it. And because we only
reach leg 2 when there is no proper crossing, the constructed interior point is never *on* the
other room's boundary for the cases we must decide firmly:

- **Identical rooms** (A = B): interior point of B is strictly inside B = strictly inside A →
  `pointStrictlyInside(A, …) === true` → overlap. Deterministic.
- **Shared-wall adjacency**: interior point of B is strictly inside B, held off the shared wall
  by B's own interior, and A's interior is disjoint from B's → `false` for both directions → no
  overlap. Deterministic.
- **Containment** (B inside A): interior point of B is strictly inside A → overlap.

### Constructing a strictly-interior point (`interiorPoint`)

`interiorPoint(poly)` returns a point guaranteed strictly inside a simple polygon, deterministic
and robust for convex *and* concave rooms (standard extreme-vertex/ear construction):

1. Pick the vertex `v` with the smallest `y` (ties broken by smallest `x`). An extreme vertex is
   always a *convex* corner. Let `u`, `w` be its polygon neighbours.
2. Scan the remaining vertices for any that fall strictly inside triangle `(u, v, w)`.
   - **None inside** → `(u, v, w)` is an "ear"; return its centroid `(u+v+w)/3`, which is
     strictly interior to the triangle and hence to the polygon.
   - **Some inside** → let `q` be the one maximising distance from the line `u–w` (the "deepest"
     reflex intruder); return the midpoint of segment `v–q`, which is strictly interior.

For a rectangle (or any convex room) no vertex is ever inside the corner triangle, so this
reduces to the corner-triangle centroid — always strictly interior. `interiorPoint` never
returns a vertex, so it is never on another room's edge in the degenerate cases above.

### `pointStrictlyInside` and the epsilon rule

`pointStrictlyInside(poly, p)` is even-odd ray casting (the same rule as `clearance.js`
`pointInRoom`, reused conceptually) but with an explicit boundary guard: if `p` lies within
`OVERLAP_EPS` of any edge of `poly` it returns `false` (boundary is not "strictly inside").
`OVERLAP_EPS = 1e-9` metres — far below the 0.01 m display precision and the 1e-4 physical
contact tolerances already in `clearance.js`, and far above FP round-off (~1e-15). Because leg 2
only runs in the no-crossing branch, the query point is either clearly interior or clearly
exterior; the epsilon guard exists only to reject the measure-zero coincidence of a constructed
point landing on an edge, making the result deterministic in all cases. The same `OVERLAP_EPS`
governs the collinear/touch threshold in `segmentsProperlyIntersect` (|cross-product| ≤
`OVERLAP_EPS` ⇒ collinear ⇒ not a proper crossing).

This is the single "interior-vs-touch" rule the reviewer asked to be made explicit: **positive
epsilon of edge-proximity or collinearity counts as *touch* (not overlap); strict interior
crossing or strict interior containment counts as *overlap*.**

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
// mcp/src/overlap.js — new pure module. Vanilla JS + JSDoc (no TS annotations).

/** Boundary / collinearity tolerance (metres). Below display + contact precision,
 *  above FP round-off. |cross| ≤ this ⇒ collinear/touch; used by both fns below. */
const OVERLAP_EPS = 1e-9;

/**
 * True iff segments p1→p2 and p3→p4 cross at a point interior to BOTH segments.
 * Orientation-sign test with strict sign opposition; collinear overlaps,
 * endpoint-only touches, and T-junctions all return false (so shared room walls
 * are NOT treated as crossings). Uses OVERLAP_EPS as the collinearity threshold.
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @param {{x:number,y:number}} p3
 * @param {{x:number,y:number}} p4
 * @returns {boolean}
 */
export function segmentsProperlyIntersect(p1, p2, p3, p4)

/**
 * A point guaranteed STRICTLY inside a simple polygon (convex or concave),
 * constructed via the extreme-vertex ear method. Never returns a vertex, so it
 * never coincides with another room's edge in the degenerate (identical /
 * adjacent / contained) cases. Assumes ≥3 verts, non-self-intersecting.
 * @param {{x:number,y:number}[]} verts  polygon vertices in order
 * @returns {{x:number,y:number}}
 */
export function interiorPoint(verts)

/**
 * True iff point p is strictly inside poly (even-odd ray cast) AND farther than
 * OVERLAP_EPS from every edge of poly. On-boundary points return false.
 * @param {{x:number,y:number}[]} verts
 * @param {{x:number,y:number}} p
 * @returns {boolean}
 */
export function pointStrictlyInside(verts, p)

/**
 * True iff the INTERIORS of two CLOSED room polygons share positive area
 * (partial overlap, X-crossing, full containment, or identical rooms). Boundary-
 * only contact — shared full/partial edge or shared vertex — returns false, so
 * wall-adjacent rooms are NOT flagged. Deterministic for all configurations.
 * @param {import("../../src/js/walls.js").Room} a  closed room
 * @param {import("../../src/js/walls.js").Room} b  closed room
 * @returns {boolean}
 */
export function roomsOverlap(a, b)
```

`roomsOverlap` is implemented directly in `overlap.js` on top of the three helpers above; it does
**not** call `pointInRoom` from `clearance.js` (that function disclaims on-edge results, which is
exactly the ambiguity this design removes). The `core.js` `pointInRoom` re-export is therefore no
longer a dependency of this LLD.

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
2. **Shared-wall adjacency** (two rooms sharing a full edge). **Firmly not an overlap** (`false`).
   The shared wall is collinear → no proper crossing (leg 1). Each room's *constructed interior
   point* sits strictly inside its own room, off the shared wall, and outside the other room →
   `pointStrictlyInside` is `false` both directions (leg 2). Deterministic; reported as satisfied
   (correct — adjacent rooms are valid).
3. **Full containment** (room B entirely inside room A, no edge crossing). Caught by leg 2: B's
   interior point is strictly inside A. Symmetric for A inside B.
4. **Identical rooms** (A = B). **Firmly an overlap** (`true`). No edge properly crosses (all
   edges collinear), so leg 1 is `false`; leg 2 decides it: B's constructed interior point is
   strictly inside B, which equals A, so `pointStrictlyInside(A, …)` is `true`. This is exactly
   the case the naive vertex-based test could not decide — resolved deterministically because the
   query point is a strict interior point, never a shared vertex.
5. **Pure boundary touch** — rooms meeting only at a shared vertex or along a partial shared edge,
   with no shared interior area. **Firmly not an overlap** (`false`), by the same reasoning as
   EC2: touching is collinear/endpoint contact (no proper crossing) and neither interior point
   lies inside the other room. Consistent with the "interiors share positive area" definition:
   zero shared area ⇒ not an overlap.
6. **Concave (e.g. L-shaped) room.** The general algorithm (proper-edge-cross OR
   interior-point-containment) handles concave polygons; no convexity assumption. `interiorPoint`
   uses the extreme-vertex ear construction, which is valid for concave simple polygons.
   `add_room {verts}` can produce these.
7. **Open / unclosed rooms.** `check_brief` filters to `r.closed` before pairing, matching the
   existing room-size logic; an in-progress chain is never tested.
8. **Self-overlap / degenerate room.** `add_room` already rejects zero-area and <3-corner
   rooms (`tool_add_room` EC5), so a persisted room is always a valid closed polygon; the
   overlap test assumes ≥3 verts.
9. **Guard: brief with no `room` field, agent draws 2 rooms that overlap.** Guard does not fire
   (no single-room brief); overlap evaluator catches it in `check_brief`. This is the exact
   residual case the evaluator exists for.
10. **Guard: no brief set.** Guard does not fire (matches existing behaviour); overlap evaluator
    still runs whenever ≥2 closed rooms exist, so overlaps are still reported.
11. **Many rooms (N).** Pairwise scan is O(N²) polygon pairs × O(E²) edge pairs. Room counts in
    a hand-authored plan are tiny (single digits); no spatial index needed. Not optimised.

## Dependencies

**Must exist before implementation (all present):**
- `mcp/src/tools.js` — `tool_check_brief` (present) and `tool_add_room` with the existing
  single-room guard (present, #83).
- `mcp/src/brief.js` — `getBrief` (present); `Brief.room` shape unchanged.
- `src/js/walls.js` `Room` type (`{ id, verts:[{x,y}], closed }`) — read-only consumer.

`mcp/src/core.js`'s `pointInRoom` re-export is **not** a dependency: `overlap.js` deliberately
does not use it (its on-edge behaviour is undefined) and carries its own `pointStrictlyInside`.

**New (all under `mcp/`, no `src/` changes):**
- `mcp/src/overlap.js` — `segmentsProperlyIntersect`, `interiorPoint`, `pointStrictlyInside`,
  `roomsOverlap`, and the module-private `OVERLAP_EPS`.
- `mcp/test/overlap.test.js` — unit tests for the geometry.
- Additions to an existing `check_brief` test file (or a new one) for the wiring.

No new external dependency. No `plan.js` contract change. No project.json change (the `mcp/`
Node suite is already run per LLD 32 M4 wiring).

## Test Requirements

Tests live under `mcp/`, run via `node --test` (headless, no browser). Organised by category.

**Unit — overlap geometry (`overlap.js`):**
- `segmentsProperlyIntersect`: crossing segments → true; disjoint → false; collinear-overlapping
  → false; endpoint-only touch → false; T-junction (endpoint on the other's interior) → false.
- `interiorPoint`: for a rectangle → a point strictly inside (verify via `pointStrictlyInside`);
  for a concave L-shaped polygon → a point strictly inside (and specifically *not* in the notch,
  which the ear construction guarantees); result is never equal to any input vertex.
- `pointStrictlyInside`: clearly-interior point → true; clearly-exterior point → false; point
  exactly on an edge → **false**; point exactly on a vertex → **false**; point within
  `OVERLAP_EPS` of an edge → **false** (boundary guard).
- `roomsOverlap` — the firm, deterministic assertions (each must hold every run, no
  indeterminacy):
  - two rectangles partially overlapping → **true**
  - disjoint rectangles → **false**
  - shared-wall-adjacent rectangles (sharing a full edge, e.g. A=[(0,0),(4,0),(4,3),(0,3)],
    B=[(4,0),(8,0),(8,3),(4,3)]) → **false**
  - two identical rectangles (A=B=[(0,0),(4,0),(4,3),(0,3)]) → **true**
  - rooms touching only at a single shared vertex → **false**
  - rooms sharing only a partial edge (collinear, no interior overlap) → **false**
  - one rectangle fully inside another → **true**
  - concave (L-shaped) room overlapping a rectangle → **true**
  - symmetry: `roomsOverlap(a,b) === roomsOverlap(b,a)` for all above pairs.

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
