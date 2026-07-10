# LLD 52: Clearance — flush-to-wall verdict inconsistency (FP sign flip at gap=0)

## Scope

A **pure geometry / floating-point bug fix** in `src/js/clearance.js`. When a symbol is
flush-snapped to a wall (the LLD 26 "seat against the wall" gesture), the clearance
verdict is inconsistent depending on which wall it is snapped to: flush against the
**right** wall reads "Won't fit — overlap" (red), while flush against the **top** wall
reads "It fits" with the gap shown as `0.0 m`. Both are the same physical situation — the
symbol's near edge coincident with the wall's inner face — and must read identically.

**In scope**
- Add a small **flush epsilon** (`WALL_FLUSH_EPS = 1e-4` m, 0.1 mm) to `clearance.js`.
- Add one centralized helper `wallFaceStatus(faceGap)` that maps a signed face-gap to
  `{ gap, status }`, with a symmetric tolerance band around zero so "flush / touching"
  classifies as `tight` (gap displayed `0.0`), never `bad`.
- Apply that helper to the four near-identical wall-side blocks in
  `computeClearances()` (left / right / top / bottom), replacing the ad-hoc
  `gap = Math.max(0, rawGap - wallHalf)` + `classify(gap)` pairs.
- Adjust the two chip/row `overlap`-guard sites in `clearanceRender.js` and
  `clearancePanel.js` to branch on `status === "bad"` rather than `gap <= 0`, so a flush
  gap (`gap:0, status:tight`) shows `0.0 m` in gold (see Frontend Design).
- Add clearance-suite tests in `src/tests.html`.

**Explicitly NOT in scope**
- **No change to `classify()`'s unit semantics.** `classify()` keeps its existing
  `gap<=0 → bad` boundary; the epsilon lives only in the new wall-face path. Existing
  `classify()` unit tests remain unchanged and must still pass.
- **No new copy, CSS tokens, or status value** (Frontend decision: Option A — reuse the
  existing `tight`/gold treatment; see Frontend Design). No new verdict *strings*. The
  only render-side change is a one-token guard adjustment in two sites (`c.gap <= 0` →
  `c.status === "bad"`) so a flush gap (`gap:0, status:tight`) shows the gold `0.0 m`
  treatment instead of red `overlap` — see Frontend Design for why.
- **No change to the symbol-to-symbol gap path**, the straddle (opposite-ray) branch, or
  the AABB / raycast geometry. The straddle branch already emits `bad` intentionally
  (Edge Case 8) and is not touched.
- **No change to `symbols.js` `nearestWallFlush`** — the flush seat geometry is correct;
  the bug is entirely in how the re-derived gap is classified.
- No persistence, export, or share-hash change (clearance is session-only per LLD 24).

## Approach

### Root cause

Two independent code paths compute the same physical gap and disagree by floating-point
noise exactly at the boundary `classify()` splits on:

- `symbols.js` `nearestWallFlush()` seats the symbol's near edge exactly on the wall inner
  face (`faceN = ±WALL_M/2`) via the translation `-gap * n`.
- `clearance.js` `computeClearances()` re-derives the gap independently by raycasting to
  the wall **centerline** and subtracting the wall half-thickness:
  `gap = Math.max(0, rawGap - wallHalf)` where `wallHalf = WALL_M/2`.

In exact arithmetic both give `gap = 0`. In IEEE-754 the two derivations round
differently. The asymmetry is **systematic**, not random: the flush offset is applied on
different axes per wall orientation, and the `_wallDist` helper **reflects coordinates**
(`-ox`, `-v0.x`) for the `left`/`up` directions, which rounds differently than the
straight `right`/`down` paths. Concretely (5×4 m room, 1×1 m symbol, verified
numerically):

- Right wall: `rawGap - wallHalf` lands at `-4e-17` → `Math.max(0, …)` clamps to `0` →
  `classify(0)` returns `bad` → pill "Won't fit — overlap".
- Top wall: lands at `+5.55e-17` → `classify(5.55e-17)` returns `tight` → gap rounds to
  display `0.0 m` → pill "It fits" (worst status tight; `tight` copy).

So the *same* flush gesture reads `bad` on one wall and `tight` on another. Neither the
red "overlap" nor the silent `0.0` is the intended read for a deliberately-seated symbol.

### Design intent (from prior LLDs)

- **LLD 24** §Edge Case 13: a gap of exactly 0 shows as literal `overlap`, never `0.0`;
  positive sub-display-precision gaps classify by their true metre value. LLD 24
  §Approach subtracts a flat `WALL_M/2` to get the inner-face gap, clamped `>= 0`.
- **LLD 26** makes wall-flush the hero "seat against the wall" gesture — the near edge
  *coincident* with the inner face is the intended success state, not a failure.

The current code treats "perfectly flush against the wall" (a success) identically to
"jammed 3 cm into the wall body" (a real overlap) because there is no tolerance band
around zero. The fix introduces one.

### Fix: a flush epsilon + one centralized wall-face classifier

Add a single tolerance constant and helper to `clearance.js`:

```js
// Below display precision (fmtLen rounds to 2dp m / 1dp ft) but far above FP noise
// (~1e-16). Anything within ±EPS of a wall inner face is "flush / touching".
export const WALL_FLUSH_EPS = 1e-4; // 0.1 mm

/**
 * Classify a symbol edge's SIGNED perpendicular gap to a wall inner face.
 * faceGap > 0  : clear space between edge and face (walkway).
 * faceGap ≈ 0  : flush / touching (the LLD-26 seat-against-wall success state).
 * faceGap < 0  : edge is inside the wall body (real overlap).
 * @param {number} faceGap  signed metres (rawGap - WALL_M/2, NOT pre-clamped)
 * @returns {{ gap:number, status:ClrStatus }}
 */
function wallFaceStatus(faceGap) {
  if (faceGap < -WALL_FLUSH_EPS) return { gap: 0, status: "bad" };   // inside wall body
  if (faceGap <=  WALL_FLUSH_EPS) return { gap: 0, status: "tight" }; // flush / touching
  return { gap: faceGap, status: classify(faceGap) };                // genuine walkway
}
```

Key points:

1. **The epsilon lives only in the wall-face path.** `classify()` is unchanged and still
   receives strictly-positive values from this helper (it is only called when
   `faceGap > WALL_FLUSH_EPS`), so its own `gap<=0 → bad` boundary and all its unit tests
   are untouched.
2. **Both flush cases collapse to `{ gap: 0, status: "tight" }`.** After the fix the
   right wall's `-4e-17` and the top wall's `+5.55e-17` both fall inside `[-EPS, +EPS]`
   → both `tight`, gap `0` → both display `0.0 m` and read identically.
3. **Regression guard preserved.** An edge genuinely inside the wall body — e.g. 3 cm past
   the inner face, `faceGap = -0.03` — is `< -EPS` → still `bad`. The fix does not soften
   real overlaps.
4. **`gap: 0` on the tight branch** keeps LLD 24's contract that a flush gap surfaces as
   `0.0`, and (per Frontend Design) the render/panel already show a numeric `0.0` for a
   tight status rather than the `overlap` literal (which is reserved for `bad`).

### Applying the helper to the four wall blocks

Each of the four `if (dX !== null)` branches in `computeClearances()` currently does:

```js
const rawGap = dLeft;                       // (or dRight / dTop / dBottom)
const gap = Math.max(0, rawGap - wallHalf); // pre-clamped, loses the sign
results.push({ …, gap, status: classify(gap), … });
```

Replace the `gap`/`status` derivation with the helper, passing the **un-clamped, signed**
face gap so the helper can distinguish "flush" (`≈0`) from "inside the wall body" (`<0`):

```js
const { gap, status } = wallFaceStatus(rawGap - wallHalf);
results.push({ …, gap, status, … });
```

The `a`/`b` leader endpoints are computed from `rawGap` and are unchanged. The four
straddle (`else if (dX0 !== null)`) branches are unchanged — they already push
`gap: 0, status: "bad"` for the AABB-crossed-the-wall case (Edge Case 8), which is a real
overlap and correct.

Net change: add ~5 lines (const + helper), edit 4 lines (one per wall block). ~15 lines
total, surgical.

### Why epsilon = 1e-4 m

`fmtLen` rounds to 2 dp in metres (0.01 m = 1 cm) and 1 dp in feet. `1e-4` m (0.1 mm) is
an order of magnitude below the finest displayed unit, so no real, user-meaningful gap is
ever swallowed by the band; yet it is ~12 orders of magnitude above the observed FP noise
(`~1e-16`), so it reliably absorbs the sign flip. A symbol a visible distance from the
wall (≥ 1 mm) is unaffected and classifies normally.

## Interfaces / Types

New in `src/js/clearance.js`:

```js
/** Flush tolerance band (metres). Below display precision, above FP noise. */
export const WALL_FLUSH_EPS = 1e-4; // 0.1 mm

/**
 * Map a signed symbol-edge → wall-inner-face gap to {gap, status}.
 * Symmetric ±WALL_FLUSH_EPS band around 0 treats "flush/touching" as tight.
 * Module-private (not exported); called only inside computeClearances().
 * @param {number} faceGap  signed metres = rawGap - WALL_M/2 (un-clamped)
 * @returns {{ gap:number, status:ClrStatus }}
 */
function wallFaceStatus(faceGap);
```

Unchanged public signatures: `classify(gap)`, `aabb(sym)`, `pointInRoom(room,x,y)`,
`computeClearances(sym, world)`, `worstStatus(list)`. The `Clearance` typedef is
unchanged (`gap`/`status` fields keep their meaning). `WALL_FLUSH_EPS` is exported only so
a test can reference the exact band width; the helper stays private (an implementation
detail, matching the existing private `_rayHitH`/`_rayHitV`/`_wallDist` style).

`wallFaceStatus` takes only `faceGap` (no `threshold` argument): the threshold-dependent
decision is delegated to `classify(faceGap)` on the positive branch, so the helper does
not duplicate `classify`'s threshold logic.

## State Model

No change. `WALL_FLUSH_EPS` is a module-level `const`; `wallFaceStatus` is a pure
function of its input. Clearance remains session-only, derived-per-frame, and persisted
nowhere — the plan JSON, export, and share hash are byte-identical before and after this
change (LLD 24's serialization contract is untouched, since the fix adds no fields to any
`Clearance` object or the plan model).

## Frontend Design

**Frontend decision: Option A — reuse the existing `tight` (gold) treatment; add no new
CSS tokens, status value, or copy.**

A flush-seated symbol now reports `status: "tight"` with `gap: 0`. Verdict copy is
unchanged; two chip/row rendering sites need a one-token guard fix so the tight status
actually paints gold `0.0 m` rather than red `overlap`.

**Verdict text (no change):**
- **Fit pill** (`clearanceRender.js` `_verdictText`): worst status `tight` → the existing
  `Tight — under <threshold> walkway` copy, gold. No new "flush against wall" string.
- **Panel verdict banner** (`clearancePanel.js` `_verdictText`): same `tight` copy, gold
  dot. No change.

**Chip / row value guard (required one-token change):** today both sites branch on the
*gap value*:

```js
// clearanceRender.js ~L214 (chip) and clearancePanel.js ~L176 (row)
const gapText = c.gap <= 0 ? "overlap" : fmtLen(c.gap) + " " + unitLabel();
```

Because the fix sets a flush gap to `gap: 0` (per LLD 24's "flush surfaces as 0.0"
contract), `c.gap <= 0` would still render red `"overlap"` and contradict the gold
"Tight" pill. Change the guard in **both** sites to branch on *status* instead of value:

```js
c.status === "bad" ? "overlap" : fmtLen(c.gap) + " " + unitLabel();
```

This makes `overlap` mean exactly "real overlap" (the `bad` status), so a `tight` flush
gap renders `0.0 m` in gold — matching LLD 24 Edge Case 13 (flush shows `0.0`, overlap
shows `overlap`) and Option A's gold treatment. This is the minimal change that realizes
the issue's verified "both walls → 0.0 m, tight" outcome; a value-based guard alone would
leave the panel/chip still reading red. No CSS, no new strings.

Rationale for Option A over introducing distinct "flush against wall" copy: the issue is
a correctness bug, not a copy gap; the fix is that both walls read *identically* and
neither reads "Won't fit". Reusing the established gold `tight` treatment achieves that
with zero new surface area, honoring CLAUDE.md "minimal chrome" and "surgical changes". A
dedicated flush affordance is explicitly out of scope and can be a later, separate LLD if
product wants to celebrate the seat gesture.

Beyond the two-token chip/row guard above, no CSS, no `index.html`, and no verdict-copy
changes are required by this LLD.

## Edge Cases

1. **Flush against any of the 4 walls (the bug).** `faceGap ∈ [-EPS, +EPS]` for all four
   orientations → `{ gap: 0, status: "tight" }`. All four read identically: `0.0 m`,
   gold, "Tight" — never "Won't fit". This is the fix.
2. **Edge 3 cm inside the wall body (regression guard).** `faceGap = -0.03 < -EPS` →
   `{ gap: 0, status: "bad" }`. Real overlap still flagged red. The fix does not soften
   genuine penetration.
3. **Edge just outside EPS, e.g. 2 mm walkway.** `faceGap = 0.002 > EPS` →
   `classify(0.002)` → `tight` (below the 0.60 m threshold), gap displays `0.0 m` after
   rounding but is a true positive gap — unchanged from today's behavior for sub-cm gaps.
4. **Comfortable gap (≥ threshold).** `faceGap` large positive → `classify` → `ok`, gap =
   the real value. Unchanged.
5. **Straddle branch (AABB crossed the wall, outward ray misses).** Handled by the
   existing `else if (dX0 !== null)` branches, which push `gap:0, status:"bad"`
   directly and do **not** call `wallFaceStatus`. Unchanged (LLD 24 Edge Case 8).
6. **Symbol outside any closed room.** No containing polygon → no wall rows → helper never
   called. Unchanged.
7. **`classify()` boundary at exactly `threshold`.** Still `ok` (helper only reaches
   `classify` for `faceGap > EPS`, and passes the true value through). Existing
   `classify` tests unchanged.
8. **Negative `faceGap` between `-EPS` and `0` (sub-noise, symbol nominally flush but
   raycast rounded slightly negative).** Caught by the second branch (`<= EPS`) → `tight`.
   This is precisely the right-wall `-4e-17` case.

## Dependencies

All present; nothing new to build first.

- `src/js/clearance.js` — the file being edited (`computeClearances`, `classify`,
  `WALL_M` import). *(present)*
- `src/js/symbols.js` — `nearestWallFlush` produces the flush seat geometry the fix
  reconciles against; **not modified**, used only to construct realistic test inputs.
  *(present)*
- `src/js/walls.js` — `WALL_M` (0.12 m) already imported by `clearance.js`. *(present)*
- `src/tests.html` — existing clearance suite (`describe("clearance.js — computeClearances:
  wall gaps")`) is extended with new `it` blocks; helpers `resetClearance`,
  `resetSymbolModel`, `mkRoom`, `mkSym` are reused. *(present)*

- `src/js/clearanceRender.js` (~L214) and `src/js/clearancePanel.js` (~L176) — the two
  chip/row `overlap`-guard sites adjusted to branch on `status === "bad"`. *(present)*

No copy strings change; no new files, no third-party libs, no build step.

## Test Requirements

Add to the existing `clearance.js` suite in `src/tests.html`, matching the pure-core
style (`resetClearance`, `resetSymbolModel`, `mkRoom`, `mkSym`).

### Unit — `wallFaceStatus` via `computeClearances` (the fix)

New `describe("clearance.js — flush-to-wall verdict consistency (LLD 52)")`:

- **Flush to each of the 4 walls → identical `tight` / `0.0` verdict.** For a symbol
  seated flush against left, right, top, and bottom walls in turn, assert the
  corresponding wall clearance has `status === "tight"`, `gap === 0`, and the row is
  **not** `bad`. Critically, right wall and top wall must agree — this is the exact
  before/after the bug (before: right `bad`, top `tight`; after: both `tight`).
  - **Faithful setup (recommended):** reproduce the real two-path geometry. Build the
    room, place the symbol near a wall, seat it with `symbols.nearestWallFlush(corners(sym),
    wallSegments, WALL_M, thresholdM, PARALLEL_TOL_DEG)`, apply the returned `{dx,dy}`
    translation to the symbol, then run `computeClearances`. This exercises the same FP
    sign flip the bug arises from (5×4 m room, 1×1 m symbol reproduces it per the issue).
  - **Simpler equivalent:** place the symbol so its AABB edge sits exactly on the inner
    face (`rawGap === WALL_M/2`, i.e. AABB edge at wall-centerline ± `WALL_M/2`), for each
    of the four walls; assert `tight` / `gap 0` for that wall's row. Include at least one
    case that lands on the `-EPS < faceGap < 0` side to guard the negative-noise branch.
- **Worst-status / pill sanity:** `worstStatus(result)` for an otherwise-comfortable
  flush-seated symbol is `tight` (not `bad`), so the pill would read the gold "Tight" copy,
  not "Won't fit". (Assert on `worstStatus`, not on DOM.)

### Unit — regression guards

- **Edge 3 cm inside wall body → `bad`.** Symbol placed so a side's AABB edge is 3 cm
  past the inner face (`faceGap = -0.03 < -EPS`): that wall row is `gap === 0`,
  `status === "bad"`. Confirms the fix does not soften real overlaps.
- **Existing "symbol face within WALL_M/2 of centerline clamps to 0" test** (currently
  asserts `bad`) must be reconciled: that placement has the AABB edge `0.02 m` **inside**
  the inner face (`faceGap = -0.02 < -EPS`), so it correctly remains `bad` under the new
  helper. Verify this existing test still passes unchanged; if its intent was "just
  touching", split it into an explicit-flush case (tight) and an explicit-penetration case
  (bad).
- **True positive walkway gap unchanged:** the existing "wall gap measured to inner face"
  test (sofa 4 m from wall → `gap ≈ 3.94`) still returns the real value and `ok`/`tight`
  per threshold.

### Unit — `classify()` unchanged (guard)

- All existing `classify` tests (`classify(0) → bad`, `classify(-0.1) → bad`,
  `classify(0.01) → tight`, boundary at `threshold`, etc.) remain **unchanged and
  passing** — the epsilon must not leak into `classify`.

### Integration — chip/row guard (render + panel)

- A flush clearance (`gap:0, status:"tight"`) renders the chip and panel row as
  `0.0 <unit>` in the gold `tight` color, **not** red `overlap`. A `bad` clearance
  (`gap:0, status:"bad"`) still renders red `overlap`. Assert against the existing
  clearanceRender / clearancePanel DOM harness.

### Regression / non-goals

- Symbol-to-symbol gaps, straddle (Edge Case 8) `bad` behavior, and plan-serialization
  byte-identity tests are unaffected and continue to pass.
