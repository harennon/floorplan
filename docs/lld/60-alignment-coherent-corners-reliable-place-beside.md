# LLD 60: Object-alignment snapping — coherent corners + reliable place-beside + flush-contact reads as a fit (three defect fixes)

Builds on / must not silently contradict: LLD 34 (object-to-object alignment), LLD 26
(wall-flush + snap toggle), LLD 37 (`nearestRoomCenter`), LLD 24 (clearance model), LLD 59
(wall-flush clearance sign-flip — the pattern Defect 3 mirrors). Effort: small–medium.

**Why three defects in one LLD:** all three sit on the same "place a piece beside another
and read whether it fits" user story. Defect 2 makes place-beside snapping *reliably*
produce 0-gap contacts; Defect 3 fixes the clearance readout that those very contacts now
trigger (it currently says "overlap"). Shipping 2 without 3 would make a successful snap
look like a collision.

## Scope

Fixes three confirmed defects on the "place beside + does it fit" user story. Defects 1–2
live in the object-to-object alignment path built by LLD 34 (`src/js/symbols.js`,
`symbolTool.js`); Defect 3 lives in the clearance readout (`src/js/clearance.js`).

**DEFECT 1 — "phantom corners."** `nearestObjectAlignment` (`symbols.js`) picks `bestX`
and `bestY` fully independently, each the global smallest-|gap| across *all* candidates.
During one drag, X can snap to neighbour P's edge while Y snaps to a *different* neighbour
Q's edge, so the piece lands on a "corner" that aligns with no single object. There is no
first-class corner concept; a real corner only happens by accident when one neighbour
wins both axes. Fix: make a single candidate that matches on **both** axes the preferred
outcome, so corner-to-corner (two edges/centers of the *same* neighbour) is coherent.
Removing simultaneous two-object alignment is a deliberate *simplicity* tradeoff, not
solely a bug fix: a resolved corner now means exactly one neighbour, which is both easier
to reason about and cheaper to guarantee than a general multi-object corner model. The
guarantee is **object-to-object only** — the resolver's separate object-vs-room-center
merge is per-axis and out of scope here, so an object-X + room-center-Y corner remains
possible BY DESIGN (see Edge Case 9).

**DEFECT 2 — "too finicky."** `ALIGN_PX = 8` screen-px is a tight symmetric window used
for both *place-beside / contact* (facing-edge, e.g. right-edge→left-edge, 0-gap) and
*edge alignment* (same-side edges line up). At low zoom, contact is hard to trigger. Fix:
widen the alignment catch and give facing-edge (contact) matches a slightly larger
threshold than same-side edge/center alignment, while preserving `ALIGN < WALL_FLUSH` so a
nearby wall still wins a contested axis.

**DEFECT 3 — flush symbol-to-symbol contact reads "overlap", not a fit.** In
`clearance.js` `computeClearances`, the symbol-to-symbol branches classify a positive
axis-separation gap fine via `classify(gap)`, but the true-contact case falls into the
final `else` branch (`dx <= 0 && dy <= 0`) which hard-codes `gap: 0, status: "bad"`. Two
tables seated flush beside each other (B.left === A.right, full y-overlap → `dx === 0`,
`dy < 0`) therefore read **"overlap"/bad**, while nudging them 0.5 cm apart reads `tight` (a
fit). Touching reads *worse* than a small gap — a discontinuity, and exactly the symbol
analog of the wall bug LLD 59 fixed for wall faces. Fix: treat a symbol-to-symbol AABB gap
within a tiny epsilon of 0 (contact on one axis, overlap on the other) as `tight` (a fit),
while genuine 2-D interpenetration stays `bad`.

**In scope**

- Coherent per-candidate resolution in `nearestObjectAlignment` (Defect 1), keeping the
  function pure and its `AlignResult` return shape.
- Two-tier alignment threshold: a wider new `ALIGN_CONTACT_PX` for facing-edge/contact
  matches and the existing `ALIGN_PX` (unchanged at 8) for same-side edge and center matches
  (Defect 2). Both converted screen-px→metres at resolve time via `pxPerM()`.
- The per-axis match now carries enough classification (`facing` vs same-side vs center)
  for the resolver to apply the right threshold and for the guide/label to be unchanged.
- A `SYM_CONTACT_EPS` tolerance + a small symbol-branch classification change in
  `clearance.js` so a flush symbol-to-symbol contact classifies `tight` (a fit) not `bad`
  (Defect 3), while genuine 2-D overlap stays `bad`. `clearance.js` stays DOM-free /
  Node-clean (the MCP server imports it).
- New/updated tests in `test/tests.html` covering all three regressions.

## Approach

### DEFECT 1 — coherent corners: single-candidate ("primary object") resolution

**Root cause.** `nearestObjectAlignment` tracks `bestX` and `bestY` with two independent
"smallest |gap|" scans over all candidates (`symbols.js` lines 445–531). Nothing ties the
two winners to the same candidate, so `bestX` can come from neighbour P and `bestY` from
neighbour Q — a corner that belongs to no object.

**Chosen fix (task option a — prefer a single best candidate; keep the function pure).**
Restructure the scan into two phases:

1. **Per-candidate best.** For each candidate, compute its own nearest in-threshold X
   match (`mx`) and nearest in-threshold Y match (`my`) using the *existing* per-pair gap
   logic and the *existing* within-candidate tie rule (center preferred over edge). Either
   may be `null`.
2. **Pick one primary candidate**, then emit *only that candidate's* `mx` and `my`. No
   other candidate contributes an axis. This makes the resolved corner always belong to a
   single object; when the primary matches both axes the two crossing guides form a real,
   coherent corner.

**Primary-candidate comparator** (deterministic; documented, only the top rule is
load-bearing):

1. Smaller `bestAxisGap` wins, where `bestAxisGap = min(|mx.gap|, |my.gap|)` over the
   candidate's non-null axis matches — i.e. the object the drag is most clearly aligning to.
2. Tie within `TIE_EPS` (1e-9): the candidate matching **both** axes wins (corner-affinity —
   makes corner-to-corner a first-class, *preferred* outcome on ties without overriding a
   clearly-tighter single-edge alignment).
3. Further tie: more `center` matches, then first-seen.

**Why this over the alternatives.** A *corner-affinity bonus* (option b) alone does not
prevent the phantom when no candidate matches both axes — X-from-P and Y-from-Q could still
both apply. *Explicit corner detection* (option c) adds a special-case code path and a new
return shape. The primary-candidate model is the minimal change that (a) structurally
guarantees both applied axes come from one candidate (killing the phantom), (b) preferences
same-object corners via the tie-break, and (c) keeps `nearestObjectAlignment` pure, its
`AlignResult` shape unchanged, and every existing single-candidate unit test green.

**Not phantom-safe by accident — proven by rule 2's absence of cross-candidate axis fill:**
when neighbour P offers only X and neighbour Q offers only Y, `bestAxisGap` picks one of
them (smaller gap, else first-seen) and emits its single axis; the orthogonal axis stays
`null` and falls through to grid/raw. The two never both apply. This is the required
regression assertion.

### DEFECT 2 — reliability: two-tier threshold (facing-edge wider than same-side/center)

**Root cause.** One symmetric `ALIGN_PX = 8` screen-px window gates both *place-beside /
contact* (facing edges, e.g. drag right edge → candidate left edge) and *same-side edge /
center alignment*. 8px is a small target to land contact on, especially with a mouse/finger
at low zoom.

**Chosen fix.** Split the threshold by match geometry, applied *inside* the pure function so
the resolver stays a thin caller:

| match geometry | example pair | px constant | metres @ zoom 1 (40 px/m) |
| --- | --- | --- | --- |
| facing edge (contact / place-beside) | drag.maxX ↔ cand.minX; drag.minX ↔ cand.maxX | `ALIGN_CONTACT_PX = 11` | 0.275 |
| same-side edge + center + edge↔center | minX↔minX, maxX↔maxX, cx↔cx, edge↔cx | `ALIGN_PX = 8` (unchanged) | 0.20 |

- **`ALIGN_CONTACT_PX = 11`**, a wider band for the hero "make two pieces touch" gesture —
  the reported pain and a differentiator vs. incumbents.
- **`ALIGN_PX` stays 8** for same-side/center: these are fine adjustments and a tight window
  here avoids over-eager sticking when many parallel edges are nearby.
- **Both stay `< WALL_FLUSH_PX = 12`**, preserving LLD-34 Edge Case 13's feel (a wall
  "grabs" from slightly farther than a neighbour) *and* the existing
  `ALIGN_PX < WALL_FLUSH_PX` resolver test.

**Ordering rationale — consciously re-stated, not silently changed.** "Wall-flush wins a
contested axis" is guaranteed by the resolver's **per-axis precedence** (`Alt > wall-flush >
alignment > grid > raw`): wall-flush is Tier 2 and *claims* its axis before alignment (Tier
3) runs, so on any axis a wall matches, alignment is skipped regardless of the threshold
magnitudes. Keeping both alignment thresholds below `WALL_FLUSH_PX` is therefore a
feel/UX guideline (which we preserve), not a correctness invariant. This LLD does not touch
`WALL_FLUSH_PX` or the precedence order.

**Classification is geometric, `kind` is unchanged.** The facing/same-side/center
distinction is derived from the (referencePoint, candidateLine) index pair already computed
in the loop; it selects which threshold to test against. The existing `kind`
(`"center"` iff center↔center, else `"edge"`) — which drives guide color and label — is
**unchanged**, so guides/labels/CSS need no change. An optional `facing:boolean` is added to
`AlignAxisMatch` purely so tests can assert which band applied; it is not read by the
renderer.

### DEFECT 3 — flush contact reads as a fit (mirror LLD 59 for symbols)

**Root cause.** `computeClearances`'s symbol-to-symbol loop (`clearance.js` ~lines 415–530)
computes axis separations `dx = max(ob.l - box.r, box.l - ob.r)` and `dy = max(...)`
(positive ⇒ a gap on that axis). It then branches:

- `dx > 0 && dy <= 0` → horizontal gap `dx`, `classify(dx)` — fine.
- `dx <= 0 && dy > 0` → vertical gap `dy`, `classify(dy)` — fine.
- `dx > 0 && dy > 0` → diagonal, `classify(min(dx,dy))` — fine.
- **`else` (`dx <= 0 && dy <= 0`)** → hard-coded `gap: 0, status: "bad"`.

Flush contact seats the two AABBs so they *touch* on one axis and *overlap* on the other:
e.g. B.left === A.right gives `dx === 0` (touching, so `dx <= 0` is true) with `dy < 0`
(y-overlap). That lands in the `else` branch and reads `"bad"`/"overlap". A 0.5 cm nudge
makes `dx = 0.005 > 0`, which routes to the first branch and reads `tight` — hence the
"touching is worse than a small gap" discontinuity. This is the direct symbol analog of the
wall-face sign-flip LLD 59 fixed with `wallFaceStatus`.

**Key nuance vs. LLD 59 (walls).** Wall gaps subtract a `WALL_M/2` face offset, so a flush
wall gap is `rawGap − wallHalf` and lands at a *signed ~1e-17 FP residue*; LLD 59's epsilon
(1e-4 m) had to absorb that residue. **Symbol AABB gaps have no face offset** — an exact
flush contact is literally `dx === 0`, not `±1e-17`. So the epsilon here is *not* needed to
absorb FP noise; it exists to (a) classify exact contact (`dx === 0`) as a fit rather than
"bad", and (b) let sub-millimetre touches (e.g. a snap that lands at `dx = -3e-5` due to
float rounding of `pxPerM` round-trips) read as contact too. Because there is no residue to
fight, correctness does not depend on the epsilon's exact magnitude.

**Chosen fix.** Distinguish, inside the symbol loop, *1-D contact* (touch on one axis,
overlap on the other) from *2-D interpenetration* (both axes overlap by a meaningful
amount), and route only the former to a `tight` fit:

- Define the *contact* condition as: the two AABBs overlap on one axis and are within
  `SYM_CONTACT_EPS` of touching on the other — precisely, the more-separated axis value
  `sep = max(dx, dy)` satisfies `-SYM_CONTACT_EPS <= sep <= SYM_CONTACT_EPS` (the box is
  touching, not meaningfully overlapping, on its nearest axis). In the current `else`
  branch, `dx <= 0` and `dy <= 0`, so `sep = max(dx, dy)` is the (least-negative /
  zero) nearest-axis separation.
  - `sep >= -SYM_CONTACT_EPS` (i.e. within ±eps of 0, since here `sep <= 0`) → **contact** →
    `{ gap: 0, status: "tight" }`. Leader drawn along the touching faces (see below).
  - `sep < -SYM_CONTACT_EPS` (nearest axis is meaningfully negative ⇒ both axes truly
    interpenetrate) → **genuine 2-D overlap** → `{ gap: 0, status: "bad" }`, unchanged.

This keeps the exact-contact case (`dx === 0`, `sep === 0`) firmly on the `tight` side and a
real overlap (e.g. one box pushed 3 cm into another on both axes, `sep = -0.03`) on the
`bad` side.

**Reuse vs. new constant.** LLD 59's `WALL_FLUSH_EPS = 1e-4` is *module-private* to
`clearance.js` and semantically "wall-face flush tolerance." Rather than overload it, add a
sibling symbol-scoped constant `SYM_CONTACT_EPS = 1e-4` (same 0.1 mm magnitude — below the
0.01 m / 1 cm display precision, so a contact still reads `0.0m`; far above any float
rounding a drag can introduce). Same value, distinct name, so the two tolerances can be
tuned independently and each reads self-documenting at its use site. (An alternative —
factor a shared helper like `wallFaceStatus` — is *not* warranted: the symbol path needs a
2-D contact-vs-interpenetration test, not the wall path's 1-D signed-face test, so a shared
helper would take a flag and obscure both. Keep them parallel-but-separate, matching the
surgical-change principle.)

**Leader line for a contact row.** The existing `else` branch draws its leader
center-to-center (`a: {cx,cy}`, `b: neighbour center`). For a `tight` contact that reads
oddly (it implies overlap). Draw the contact leader along the touching faces instead — reuse
the horizontal/vertical face-pair leader math already present in the `dx > 0`/`dy > 0`
branches. Concretely: when the contact axis is X (`dx >= dy`, x-facing edges touch) reuse
the **`dx > 0` horizontal-face block** (shared-y-midspan `midY` + the `ob.l >= box.r`
face-x pick); when the contact axis is Y (`dy > dx`, y-facing edges touch) reuse the
**`dy > 0` vertical-face block** (shared-x-midspan `midX` + the `ob.t >= box.b` face-y
pick). Place a zero-length leader on that shared face midpoint. This is cosmetic; the
load-bearing change is `status: "tight"`, `gap: 0`.

**Render path — investigated, NO tweak needed.** LLD 59's render change already landed:
both `clearanceRender.js` (`_drawChip`, line ~214: `c.status === "bad" ? "overlap" :
fmtLen(c.gap)+…`) and `clearancePanel.js` (row value, line ~176: `if (c.status === "bad")
{ … "overlap" } else { fmtLen(c.gap)+… }`) already gate the "overlap" string on
`c.status === "bad"`, not on `c.gap <= 0`. So a symbol contact row carrying
`{ gap: 0, status: "tight" }` will render `fmtLen(0)+unit` = `0.0m` in the `tight` (amber)
style automatically. The verdict banner (`_verdictText`) keys off `worstStatus`, which is
already status-based. **No render/verdict-string change is required for Defect 3** — this is
the payoff of LLD 59 having centralized on `status`.

### Where the change lands

- **`src/js/symbols.js`** — rewrite the body of `nearestObjectAlignment` (per-candidate
  best + primary selection + two-tier threshold). Add `ALIGN_CONTACT_PX`. Extend the
  `AlignAxisMatch` typedef with optional `facing`. `aabb`, `corners`, `nearestWallFlush`,
  `nearestRoomCenter`, `ALIGN_PX`, `WALL_FLUSH_PX`, `ROOM_CENTER_PX` untouched.
- **`src/js/symbolTool.js`** — two-line change at the object-alignment call (lines ~582–584):
  import `ALIGN_CONTACT_PX`, compute both thresholds from `pxPerM()`, pass both. The
  resolver's per-axis precedence, room-center merge, guide plumbing, and `.snap-tag` are
  otherwise unchanged.
- **`src/js/clearance.js`** — add `SYM_CONTACT_EPS`; split the symbol-loop final `else`
  (`dx <= 0 && dy <= 0`) into a contact case (`tight`, `gap 0`, face-pair leader) and the
  existing genuine-overlap case (`bad`, `gap 0`). No exported-API change; stays DOM-free.
- **No change** to `clearanceRender.js` / `clearancePanel.js` (render already status-gated
  by LLD 59).

No new modules, no build step, no new dependencies, no CSS.

## Interfaces / Types

### `src/js/symbols.js`

**New constant** (beside `ALIGN_PX`):

```js
/** Screen-px threshold for FACING-edge (contact / place-beside) alignment; wider than
 *  ALIGN_PX so "make two pieces touch" is easier to hit. Converted to metres by caller.
 *  Kept < WALL_FLUSH_PX (12) so a nearby wall still wins a contested axis by feel. */
export const ALIGN_CONTACT_PX = 11;
```

`ALIGN_PX = 8` is **unchanged**.

**`AlignAxisMatch` typedef** — one optional field added (renderer ignores it):

```js
// before
// { delta, line, kind:"edge"|"center"|"room-center", guide:{a,b}, center? }
// after
// { delta, line, kind:"edge"|"center"|"room-center", guide:{a,b}, center?, facing?:boolean }
```

**`nearestObjectAlignment` signature — before / after:**

```js
// before
export function nearestObjectAlignment(dragAABB, candidates, thresholdM)

// after — two-tier threshold; contact defaults to edge threshold for back-compat
export function nearestObjectAlignment(dragAABB, candidates, edgeThresholdM, contactThresholdM = edgeThresholdM)
```

- `edgeThresholdM` gates same-side edge, center, and edge↔center pairs (was `thresholdM`).
- `contactThresholdM` gates facing-edge (contact) pairs; **defaults to `edgeThresholdM`** so
  every existing single-threshold unit test keeps its current behaviour with no edit.
- Return type `AlignResult` (`{ x: AlignAxisMatch|null, y: AlignAxisMatch|null }`) is
  **unchanged in shape**; `x` and `y`, when both non-null, now always originate from the
  same "primary" candidate (Defect 1). Each match may carry `facing:true`.
- Purity is preserved: no global reads; both thresholds injected.

**Facing-pair rule (per axis).** With reference indices `0=min, 1=max, 2=center` and the
same candidate-line indices, a pair is *facing* iff it is `drag.max ↔ cand.min` (ref 1,
line 0) or `drag.min ↔ cand.max` (ref 0, line 1). Those two use `contactThresholdM`; all
other pairs use `edgeThresholdM`. `kind` is still `center` only for ref 2 ∧ line 2, else
`edge` — unchanged.

### `src/js/symbolTool.js`

Import and call-site only (inside the existing `if (prefsGridSnap())` block, ~lines
582–584):

```js
// before
import { …, ALIGN_PX, aabb as symAabb, nearestObjectAlignment, … } from "./symbols.js";
…
const alignThreshM = ALIGN_PX / pxPerM();
objectAlignResult = nearestObjectAlignment(dragAABBVal, _candidateAABBs, alignThreshM);

// after
import { …, ALIGN_PX, ALIGN_CONTACT_PX, aabb as symAabb, nearestObjectAlignment, … } from "./symbols.js";
…
const ppm = pxPerM();
const alignThreshM = ALIGN_PX / ppm;
const contactThreshM = ALIGN_CONTACT_PX / ppm;
objectAlignResult = nearestObjectAlignment(dragAABBVal, _candidateAABBs, alignThreshM, contactThreshM);
```

No change to the per-axis precedence, the object-align-vs-room-center `|delta|` merge, the
`snapType` priority map, `_updateGuides`, `_updateSnapTag`, or `resolvePlacementForTest`
(its 3rd/4th test args are unaffected; it forwards to `_resolvePlacement`).

### `src/js/clearance.js`

**New module-private constant** (sibling to `WALL_FLUSH_EPS`, no exported-API change):

```js
/** Symbol-to-symbol contact tolerance: an AABB axis-separation within ±this (metres) of
 *  0 counts as touching (a fit), not overlapping. 0.1mm — below the 0.01m display
 *  precision (a contact still reads 0.0m) and above any drag/round-trip float noise.
 *  Symbol AABB gaps carry no WALL_M/2 face offset, so — unlike WALL_FLUSH_EPS — this is
 *  not absorbing an FP residue; it classifies exact/near-exact contact as a fit. */
const SYM_CONTACT_EPS = 1e-4;
```

**Symbol-loop final branch — before / after (structure, not full code):**

```js
// before  (else: dx <= 0 && dy <= 0)
} else {
  const gap = 0;
  results.push({ label, kind:"symbol", gap, status:"bad",
                 a:{x:cx,y:cy}, b:{x:(ob.l+ob.r)/2, y:(ob.t+ob.b)/2}, neighbourId: other.id });
}

// after
} else {
  const sep = Math.max(dx, dy);          // nearest-axis separation (≤ 0 here)
  if (sep >= -SYM_CONTACT_EPS) {
    // 1-D contact (touch on one axis, overlap on the other) → a fit
    // leader along the touching face pair (reuse dx/dy face-leader math)
    results.push({ label, kind:"symbol", gap:0, status:"tight", a:{…faceA}, b:{…faceB}, neighbourId: other.id });
  } else {
    // genuine 2-D interpenetration → overlap (unchanged)
    results.push({ label, kind:"symbol", gap:0, status:"bad",
                   a:{x:cx,y:cy}, b:{x:(ob.l+ob.r)/2, y:(ob.t+ob.b)/2}, neighbourId: other.id });
  }
}
```

`classify()`, `worstStatus()`, `computeClearances()` signatures and the wall branches
(incl. LLD-59 `wallFaceStatus`) are **unchanged**. `clearance.js` remains pure and DOM-free.

### Unchanged / reused

`aabb`, `corners`, `nearestWallFlush`, `WALL_FLUSH_PX`, `PARALLEL_TOL_DEG`,
`nearestRoomCenter`, `ROOM_CENTER_PX`; `view.pxPerM`; `prefs.gridSnap`; `grid.snapStep`;
`#symbol-overlay`, `.snap-tag`, guide CSS/colors. MCP server imports `aabb`/geometry but
**not** `nearestObjectAlignment`, so it is unaffected.

## State Model

No change to persisted or session state. This LLD only alters how a transient, per-frame
value is *computed*:

- `nearestObjectAlignment` is pure and stateless — same inputs, same outputs. The two-phase
  restructure keeps two module-local scan accumulators per candidate instead of two global
  accumulators; nothing escapes the function.
- Alignment matches, guides, `_candidateAABBs`, `_roomCenters`, and `_activeGuides` remain
  fully transient: rebuilt each pointer move, cleared on gesture end (`onSelectUp`, dock
  `_onUp`) exactly as today (LLD 34 State Model). Nothing is added to the plan document,
  export JSON, localStorage, or the share hash.
- No new persisted preference. Thresholds are code constants; `prefs.gridSnap` still gates
  both alignment and grid unchanged.
- The optional `facing` flag lives only on the transient `AlignAxisMatch` returned per
  frame; it is never serialized (asserted by the existing "no new keys in plan JSON" test,
  extended to also reject `facing`/`ALIGN_CONTACT_PX` string leakage).
- **Defect 3 / clearance:** `computeClearances` stays a pure function of `(sym, world)`;
  clearance results are transient, session-only inspection state (not persisted to plan
  JSON, localStorage, or the share hash — per LLD 24/59). The fix only changes the
  in-memory `{gap, status}` derived for one branch; `SYM_CONTACT_EPS` is a code constant,
  nothing new is stored or serialized.

## Edge Cases

1. **Phantom corner (the Defect-1 bug).** Neighbour P in range on X only, neighbour Q in
   range on Y only. Primary selection picks one candidate by `bestAxisGap`; it emits only
   *its* axis. The orthogonal axis is `null` → grid/raw. **X-from-P and Y-from-Q never both
   apply.** (Regression test.)
2. **True corner-to-corner.** One neighbour is in range on both axes. It has the smallest
   `bestAxisGap` (or wins the both-axes tie-break) → both `mx` and `my` emitted from it; two
   crossing guides form a coherent corner. (Test.)
3. **Both-axes tie-break.** Candidate A matches only X at gap g; candidate B matches both
   axes with its best-axis gap also g (within `TIE_EPS`). B wins (rule 2, corner-affinity),
   so the drag prefers the same-object corner. But if A's single-axis gap is *strictly*
   smaller, A wins — a clearly tighter single alignment is not overridden.
4. **Facing edge just outside `ALIGN_PX` but inside `ALIGN_CONTACT_PX`** (gap ∈ (0.20,
   0.275] m @ zoom 1): now snaps as contact (the Defect-2 fix). Previously did not snap.
   (Test.)
5. **Same-side edge at the same gap** (e.g. 0.25 m): does **not** snap — same-side/center
   still uses the tighter `ALIGN_PX`. Confirms the two-tier split is asymmetric by design.
6. **Contact vs same-side within `ALIGN_PX` on one axis, same candidate.** Both are ≤
   `ALIGN_PX ≤ ALIGN_CONTACT_PX`; the existing smallest-|gap| + center-preference tie rule
   picks the winner exactly as before (no behaviour change inside the old window).
7. **Wall-flush contests the axis.** Wall-flush (Tier 2) claims the axis before alignment
   (Tier 3) runs — alignment is skipped on that axis regardless of thresholds. Preserved.
   The orthogonal-axis co-existence case (Y flush + X align) is unchanged. (Existing tests.)
8. **Alt held / toggle OFF.** Unchanged: Alt → raw both axes, no guides; toggle OFF →
   alignment (and grid) gated off. Thresholds never consulted. (Existing tests.)
9. **Room-center vs object-align on the same axis.** Unchanged: resolver still picks the
   nearer by `|delta|`, object-align on tie. The primary-candidate change is internal to
   `nearestObjectAlignment` and does not alter the `AlignAxisMatch` it hands the resolver.
   The Defect-1 phantom-corner guarantee is **object-to-object only**: it ensures both
   *object-alignment* axes come from one neighbour. Because the resolver merges
   object-alignment against room-center *per axis* (and that merge is out of scope), an
   object-X + room-center-Y corner remains possible BY DESIGN — it is not a phantom.
10. **No candidates / empty in range.** `{x:null, y:null}` as today.
11. **Rotated furniture.** Still aligns via AABB extents; facing/same-side classification is
    on AABB edges, unaffected by rotation. (Existing rotated-AABB test stays green.)
12. **Degenerate candidate AABB** (`minX==maxX`, e.g. the existing tie fixture
    `mkAABB(1,1,5,6)`): center==both edges; facing vs same-side both resolve to gap 0 within
    either threshold; center still wins the tie. Behaviour unchanged.
13. **Many candidates in range.** Primary selection is a second O(n) pass over the same
    small candidate list (per LLD-34 Edge Case 16, n is small for a floor plan). No
    meaningful perf change; list still built once per gesture start.
14. **`contactThresholdM` omitted** (any caller passing three args, incl. all existing
    tests): defaults to `edgeThresholdM`, i.e. the pre-fix single-window behaviour. Safe.

### Defect 3 — symbol-to-symbol contact classification

15. **Exact flush contact (the Defect-3 bug).** B.left === A.right, full y-overlap →
    `dx === 0`, `dy < 0`, `sep = max(dx,dy) = 0 ≥ -EPS` → `tight`, `gap 0`. Reads a fit /
    `0.0m`, not "overlap". (Regression test — the headline case; also produced by a
    successful Defect-2 place-beside snap.)
16. **Sub-millimetre contact** (a snap landing at `dx = -3e-5` from float round-trips) →
    `sep = -3e-5 ≥ -1e-4` → `tight`. Same fit, no discontinuity from exact contact.
17. **0.5 cm gap (continuity).** `dx = 0.005 > 0` → first branch, `classify(0.005)` =
    `tight`. Contact (case 15) and a 0.5 cm gap now both read `tight` — the "touching is
    worse than a small gap" discontinuity is gone. (Continuity test.)
18. **Genuine 2-D overlap stays bad.** One box pushed ~3 cm into another on both axes →
    `dx ≈ -0.03`, `dy ≈ -0.03`, `sep = -0.03 < -EPS` → `bad`, `gap 0` = "overlap". Real
    collisions still flagged. (Regression guard.)
19. **Deep 1-axis overlap but the other axis meaningfully negative.** If the nearest-axis
    separation `sep < -EPS` (both axes overlap by > eps), it is 2-D interpenetration →
    `bad`. Only when the nearest axis is within ±eps of touching is it a contact. This is
    the precise 1-D-contact vs 2-D-overlap boundary.
20. **Opening neighbours skipped.** Doors/windows (`CATALOG[type].openings`) are already
    `continue`d in the symbol loop; contact classification never runs against them.
    Unchanged.
21. **Render of a `tight` 0.0m symbol row.** Because both render files gate "overlap" on
    `status === "bad"` (LLD 59), a `tight` contact row renders `0.0m` in amber; a genuine
    `bad` overlap still renders "overlap". No render change (verified in source).

## Dependencies

- **Blocks on:** nothing new. LLD 34 is merged (`nearestObjectAlignment`, `ALIGN_PX`,
  `aabb`, the resolver, guide/`.snap-tag` infra). **LLD 59 must be merged** (Defect 3 relies
  on its render-path change — both render files already gate "overlap" on
  `status === "bad"`, and its `WALL_FLUSH_EPS`/`wallFaceStatus` establish the pattern
  Defect 3 mirrors). It is merged.
- **Parent pattern:** LLD 59 (wall-flush clearance sign-flip). Defect 3 is its symbol-branch
  analog — LLD 59 explicitly scoped the symbol `dx`/`dy` branches OUT ("untouched"); this
  LLD closes that gap.
- **Builds on (do not change semantics):**
  - `symbols.js` — `nearestObjectAlignment` (rewritten body, same shape), `aabb`, `corners`,
    `ALIGN_PX`; add `ALIGN_CONTACT_PX`.
  - `symbolTool.js` — `_resolvePlacement` object-align call site + one import line only.
  - `clearance.js` — `computeClearances` symbol-loop final branch + `SYM_CONTACT_EPS`;
    `classify`, `worstStatus`, wall branches, `wallFaceStatus` untouched. Stays DOM-free.
  - `clearanceRender.js` / `clearancePanel.js` — **no change** (already status-gated by
    LLD 59).
  - `view.js` `pxPerM`, `prefs.js` `gridSnap`, `grid.js` `snapStep` — consumed, unchanged.
  - `#symbol-overlay`, `.snap-tag`, guide colors/CSS — unchanged (kind/label unchanged).
- **MCP server:** imports `clearance.js` (and `aabb`/`corners`) but **not**
  `nearestObjectAlignment`. Defect 3 must therefore keep `clearance.js` Node-clean (no DOM,
  no browser globals) — it already is, and the change adds only a constant + branch logic.
  The default-arg on `nearestObjectAlignment` keeps that signature back-compatible.
- **No new third-party dependencies. No build step. No CSS.** Pure client-side vanilla JS.

### Rollout / testing considerations

- **Render-path auto-merge gate.** None of the three files this LLD edits (`symbols.js`,
  `symbolTool.js`, `clearance.js`) are in `autoMerge.renderPaths` (`clearancePanel.js` and
  `*Render.js` are — and this LLD deliberately does *not* touch them). But all three defects
  are visible in the live editor: snap feel, corner behaviour, and the clearance verdict a
  place-beside contact now shows. The PR should ship the tests below plus a short before/after
  note (screen recording of: a place-beside drag at low zoom snapping to contact, a corner
  drag, and the clearance panel reading `0.0m`/fit instead of "overlap" for the resulting
  contact) so the human render-glance can confirm the widened threshold isn't over-sticky,
  corners read coherently, and the contact verdict is a fit. Expect the render-path gate to
  hold the PR for that glance.
- **Threshold tuning is a one-line knob.** `ALIGN_CONTACT_PX` is isolated; if 11px feels
  sticky in review it can be dialed toward 9–10 without touching logic. The unit tests
  assert *behaviour at chosen boundaries* (see Test Requirements), so a retune only moves the
  fixtures, not the design.

## Test Requirements

Tests live in `test/tests.html` (the `describe`/`it` harness), alongside the existing
`nearestObjectAlignment` and resolver-precedence suites. Use the existing `mkAABB(minX,
maxX, minY, maxY)` and resolver helpers (`resetForResolver`, `makeBox`,
`resolvePlacementForTest`). All *existing* alignment unit tests must stay green unchanged
(the `contactThresholdM` default guarantees this).

### Unit — Defect 1 (coherent corners), `nearestObjectAlignment`

- **Phantom-corner regression (the headline test).** Candidate P in range on X only,
  candidate Q in range on Y only, from different AABBs. Assert that the result does **not**
  apply P's X *and* Q's Y simultaneously: exactly one axis is non-null, and the non-null
  axis's `line` matches the closer candidate. (Direct reproduction of the reported bug.)
- **Same-object corner preferred.** One candidate in range on both axes; assert both `x` and
  `y` non-null and that both `line` values come from that one candidate (crossing guides
  bracket that candidate).
- **Both-axes tie-break.** Candidate A in range on X only at gap g; candidate B in range on
  both axes with best-axis gap g (within `TIE_EPS`). Assert B wins (both axes emitted).
- **Strictly-tighter single wins over both-axes.** Candidate A single-axis gap strictly <
  candidate B best-axis gap. Assert A wins its single axis (no override by corner-affinity).

### Unit — Defect 2 (two-tier threshold), `nearestObjectAlignment`

- **Facing edge in the widened band.** Facing pair (drag.maxX ↔ cand.minX) at gap 0.25 with
  `edgeThresholdM=0.20, contactThresholdM=0.275` → X match, `facing:true`. Same fixture with
  a single 0.20 threshold (default contact) → **no** match. (Proves contact widening.)
- **Same-side edge NOT widened.** Same-side pair (minX ↔ minX) at gap 0.25 with the same two
  thresholds → **no** X match (same-side uses the tighter `edgeThresholdM`).
- **Within old window unchanged.** Facing pair at gap 0.1 → matches under both single- and
  two-threshold calls, identical `delta` — no behaviour drift inside 8px.
- **Back-compat default.** Three-arg call (no `contactThresholdM`) reproduces the pre-fix
  result on a facing pair at the boundary of `edgeThresholdM`.

### Unit — Defect 3 (symbol flush contact), `clearance.js` `computeClearances`

Add to the `clearance.js — computeClearances` suites in `test/tests.html`. Use existing
`mkSym` / `mkRoom` helpers and `worstStatus`.

- **Flush contact reads a fit (headline).** Two axis-aligned symbols seated so one's right
  edge === the other's left edge with full y-overlap (`dx === 0`, `dy < 0`). Assert the
  symbol clearance to the neighbour is `status === "tight"` and `gap === 0` (NOT `"bad"`),
  and `worstStatus(result)` is not `"bad"`.
- **Continuity: touching is not worse than a small gap.** Same pair at `dx === 0` → `tight`;
  nudged to `dx = 0.005` → `classify` also `tight`. Assert both classify `tight` (no
  worse-when-touching discontinuity).
- **Genuine 2-D overlap still bad.** Two symbols interpenetrating ~3 cm on both axes
  (`dx ≈ -0.03`, `dy ≈ -0.03`) → that clearance `status === "bad"`, `gap === 0`.
- **Boundary.** Contact at `dx = -SYM_CONTACT_EPS` (edge of tolerance) → `tight`; at
  `dx` just below `-SYM_CONTACT_EPS` with the other axis also overlapping → `bad`.
- **Openings excluded.** A door/window neighbour produces no symbol contact row (existing
  `openings` skip) — spot-check unchanged.
- **`classify()` untouched.** Existing `classify(0) === "bad"` and negative-gap tests stay
  green (the epsilon lives in the symbol branch, not in `classify`).

### Unit — resolver precedence (`resolvePlacementForTest`) — regression, must stay green

- `ALIGN_PX < WALL_FLUSH_PX`: contested axis still resolves to `flush`.
- Same-axis contested (wall-flush + alignment) → `flush` wins; `_alignX`/`_alignY` null on
  the claimed axis.
- Per-axis co-existence (Y flush + X align) → `snapType:"flush"`, `_flushActive:true`, X
  aligned. (These use gaps well inside the windows; the two-tier split must not perturb them
  — verify the contested-flush fixtures still fall on the wall side.)
- Toggle OFF / Alt held → no alignment (unchanged).

### Integration (Playwright, `.github/run-tests.mjs`)

- **Place-beside reliability at low zoom.** Zoom out, drag one symbol toward another so the
  facing edges are ~10px apart (previously outside the 8px window); assert the edges become
  visibly coincident on drop (`sym.x`/`sym.y`) and a violet edge guide appeared during the
  drag. This is the acceptance bar for Defect 2.
- **Corner coherence.** Arrange two neighbours forming an L; drag a third piece into the
  inner corner so it is near P on X and Q on Y. Assert the dropped piece aligns to a single
  neighbour's corner (its resolved X and Y both trace to one object), not a mix — the
  acceptance bar for Defect 1.
- **No residue on drop.** Existing assertions (no `.align-guide` `<g>` left in
  `#symbol-overlay`, `.snap-tag` hidden after `onSelectUp`) must still pass.
- **Place-beside → clearance reads a fit (Defect 2 + 3 end-to-end).** After a place-beside
  snap produces a 0-gap contact, open/read the clearance panel and assert the neighbour row
  reads `0.0m` (or a fit-styled value), **not** "overlap", and the verdict is not "Won't fit
  — overlap". This is the joint acceptance bar proving Defects 2 and 3 cohere.

### Regression (unchanged behaviour to protect)

- LLD-26 wall-flush, grid toggle persistence, `.snap-tag` contention guard.
- LLD-37 room-center snap (`nearestRoomCenter` untouched; resolver merge unchanged).
- **LLD-59 wall-flush clearance:** all four wall-flush `tight`/`0.0m` tests and the
  real-overlap `bad` guards stay green (`wallFaceStatus` and the wall branches are
  untouched). The Defect-3 change is isolated to the symbol branch.
- LLD-24 clearance model: `classify`, `worstStatus`, display precision unchanged.
- No new key in plan JSON / export / share hash — extend the existing "alignment adds NO new
  keys" test to also reject `"facing"` and `"ALIGN_CONTACT_PX"` string leakage.

## Explicitly NOT in scope

- **Changing `WALL_FLUSH_PX` or the per-axis precedence order** (`Alt > wall-flush >
  alignment > grid > raw`). Wall-flush still wins a contested axis; that invariant is
  structural (Tier 2 claims before Tier 3), not threshold-dependent.
- **New guide styling, colors, labels, or a `facing`-specific guide.** `kind` is unchanged;
  a contact match still renders as the existing violet edge guide labelled `"edges"`. No CSS.
- **Room-center snapping semantics** (LLD 37) and the object-align-vs-room-center `|delta|`
  merge in the resolver — untouched.
- **Equal-spacing / distribution guides**, rotation/angle snapping, snapping to walls as
  alignment targets — all still out of scope per LLD 34.
- **A user-facing threshold setting or a separate alignment toggle.** Alignment still rides
  the single `prefs.gridSnap` toggle; thresholds remain code constants.
- **`chooseGridStep` / zoom / snap-precision chip** (#22/#27) and wall-drawing snap
  (`resolveSnap`) — unaffected.
- **Any change to `clearance.js` beyond the one symbol branch + `SYM_CONTACT_EPS`.** The
  wall branches, `wallFaceStatus`/`WALL_FLUSH_EPS` (LLD 59), `classify`, `worstStatus`, and
  `computeClearances`'s signature are untouched. No shared wall/symbol helper is introduced
  (the two contact tests differ — 1-D signed face vs 2-D contact-vs-interpenetration).
- **Render / verdict-string changes for Defect 3.** Verified unnecessary: both render files
  already gate "overlap" on `status === "bad"` (LLD 59). `clearanceRender.js` /
  `clearancePanel.js` are not edited.
- **A distinct "flush against symbol" verdict copy.** A `tight` `0.0m` reading is
  sufficient (mirrors LLD 59's decision for walls); no new string.
- **MCP server changes.** It imports `clearance.js` but not `nearestObjectAlignment`; the
  Defect-3 edit keeps `clearance.js` Node-clean, so no MCP change is needed.
