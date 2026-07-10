# LLD 59: Clearance — flush-to-wall symbol reads "Won't fit" on some walls but "0.0m fits" on others (FP sign flip at gap=0)

## Scope

Fixes an inconsistency in `src/js/clearance.js`: a symbol flush-snapped (LLD 26) to a
wall reports a different verdict depending on which of the four walls it touches —
"Won't fit — overlap" on some, "It fits / 0.0m" on others. The two states are the same
physical situation (symbol edge on the wall inner face) and must classify identically.

**In scope**
- Introduce a flush tolerance band around a zero wall-face gap.
- Centralize the wall-face → `{gap, status}` decision in one helper applied to all four
  wall sides, so treatment cannot drift per side.
- Preserve the genuine-overlap / straddle `bad` verdicts (a symbol edge truly inside the
  wall body still reads `bad`).
- Correct corner behaviour: a symbol flush against **two** walls at once reads a fit on
  both (frontend decision B).
- Tests in `src/tests.html` for all four walls + a corner + a real-overlap regression.

**Out of scope**
- Symbol-to-symbol gap logic (the `dx`/`dy` branches) — untouched.
- The `nearestWallFlush()` seating math in `symbols.js` — untouched; it already seats
  correctly, this LLD only fixes the downstream classification.
- Verdict copy wording in `clearanceRender.js` / `clearancePanel.js` — no new "flush"
  string is required; a flush symbol simply reads as a `tight` 0.0m fit.
- `classify()`'s own contract for symbol gaps — the epsilon lives on the wall-face path,
  not inside `classify()`.

## Approach

### Root cause
`computeClearances()` derives each wall gap as `gap = Math.max(0, rawGap - wallHalf)`,
where `rawGap` is a raycast distance from the AABB edge to the wall **centerline** and
`wallHalf = WALL_M/2`. For a flush-snapped symbol the true value of `rawGap - wallHalf`
is exactly 0, but the four wall sides compute it through different code paths:

- vertical walls apply the flush offset on `dx`, horizontal walls on `dy`;
- the "left" and "up" raycasts reflect coordinates (`_rayHitH(-ox, …)`,
  `_rayHitV(ox, -oy, …)`) while "right"/"down" do not.

These round differently, so `rawGap - wallHalf` lands at a systematically signed
sub-picometre residual (e.g. `-4e-17` on the right wall, `+5.55e-17` on the top). The
`Math.max(0, …)` clamp then collapses the negative residual to a clean `0`, which trips
`classify()`'s `gap <= 0 → "bad"` branch — while the positive residual survives as a
tiny positive gap that reads `tight` (displayed `0.0m`). Same physical state, opposite
verdicts.

### Decision: single shared helper + tolerance band (implementation option a)
Add a `WALL_FLUSH_EPS = 1e-4` (0.1mm) tolerance and route every wall side through one
helper that decides `{gap, status}` from the raw **face gap** (`rawGap - wallHalf`,
computed *before* any clamp):

- `faceGap < -EPS` → genuinely inside the wall body → `{ gap: 0, status: "bad" }`.
- `-EPS ≤ faceGap ≤ EPS` → flush / touching → `{ gap: 0, status: "tight" }` (a fit,
  displays `0.0m`, never "overlap").
- `faceGap > EPS` → real walkway → `{ gap: faceGap, status: classify(faceGap) }`.

Rationale for `1e-4`: it is two orders of magnitude below the 0.01m (1cm) display
precision — so a flush symbol still shows `0.0m` — and ~13 orders of magnitude above the
`~1e-17` FP residue, so it cannot be tripped by float noise. It is also far smaller than
any real overlap a user could create by dragging (the smallest meaningful nudge is
sub-millimetre but still ≥ mm at snap resolution), so a symbol pushed into the wall body
still reads `bad`.

**Why a shared helper (not per-branch edits):** the bug exists precisely because the four
sides are near-identical copies that rounded differently. Funneling all four through one
function guarantees identical treatment and prevents future drift. `classify()` itself is
left unchanged so its symbol-gap contract and existing unit tests are unaffected.

**Straddle branches unchanged:** the `else if (dRight0 !== null)` etc. branches (AABB
edge fully crossed the wall, LLD Edge Case 8) already hard-code `gap: 0, status: "bad"`
and are a distinct code path from the flush case. They stay as-is — a symbol whose edge
has crossed to the far side of the wall is a real overlap.

## Interfaces / Types

New module-private constant and helper in `clearance.js` (no exported API change):

```js
/** Flush tolerance: a wall-face gap within ±this (metres) counts as touching, not
 *  overlapping. 0.1mm — below the 0.01m display precision, far above FP noise (~1e-17). */
const WALL_FLUSH_EPS = 1e-4;

/**
 * Classify a symbol's near edge against a wall inner face.
 * @param {number} faceGap  metres from AABB edge to wall inner face
 *                          (rawGap - WALL_M/2), signed; negative = edge inside wall body.
 * @returns {{ gap: number, status: ClrStatus }}
 */
function wallFaceStatus(faceGap) {
  if (faceGap < -WALL_FLUSH_EPS) return { gap: 0, status: "bad" };   // inside wall body
  if (faceGap <=  WALL_FLUSH_EPS) return { gap: 0, status: "tight" }; // flush / touching
  return { gap: faceGap, status: classify(faceGap) };
}
```

Each of the four `if (dLeft !== null) { … }` (and right/top/bottom) blocks changes from:

```js
const rawGap = dLeft;
const gap = Math.max(0, rawGap - wallHalf);
results.push({ …, gap, status: classify(gap), … });
```

to:

```js
const rawGap = dLeft;
const { gap, status } = wallFaceStatus(rawGap - wallHalf);
results.push({ …, gap, status, … });
```

The leader-line `b` endpoint math (`bx`, `by`) is derived from `rawGap`/`wallHalf` and is
unchanged — only `gap` and `status` now come from the helper. `classify()` and
`worstStatus()` signatures are unchanged.

## State Model

No state changes. Clearance is transient, session-only inspection state (already
documented in `clearance.js`: not persisted to plan JSON, localStorage, or URL hash).
`computeClearances()` remains a pure function of `(sym, world)`. The fix is purely in the
in-memory gap→status derivation; nothing new is stored or serialized.

Display flow is unchanged: `clearanceRender.js` and `clearancePanel.js` already render
`gap <= 0` as the string `"overlap"` and `gap > 0` via `fmtLen()`. A flush symbol now
carries `gap: 0, status: "tight"`. Because `gap` is exactly `0`, both renderers currently
print `"overlap"` for it via their `c.gap <= 0 ? "overlap"` check — **this must change**:
a `tight` flush row must display `0.0m`, not `"overlap"`. See Edge Cases.

## Edge Cases

1. **Flush to each of the 4 walls** — `faceGap ≈ 0` (±1e-17) → `{gap:0, status:"tight"}`
   on every side. Verdict reads "It fits" / row shows `0.0m`. (The core bug.)
2. **Corner: flush against two walls at once** (frontend decision B) — e.g. symbol seated
   into the top-left corner touches both the left and top inner faces. Each side is
   evaluated independently through `wallFaceStatus`, so both report
   `{gap:0, status:"tight"}`; `worstStatus()` returns `tight` (a fit), not `bad`. No
   special corner code is needed — the shared helper makes this fall out naturally.
3. **Edge genuinely inside the wall body** (e.g. 3cm past the inner face) — `faceGap`
   ≈ `-0.03` < `-EPS` → `{gap:0, status:"bad"}`. Still reads "Won't fit". (Regression
   guard; matches the existing "clamps wall gap to 0" test whose faceGap is `-0.02`.)
4. **AABB fully crossed the wall (straddle, Edge Case 8)** — handled by the separate
   `else if (dRight0/dLeft0/dDown0/dUp0 !== null)` branches, untouched; still
   `gap:0, status:"bad"`.
5. **Display of a `tight` 0.0m row** — `clearanceRender.js` (`_drawChip`, ~line 214) and
   `clearancePanel.js` (row value, ~line 176) currently print `"overlap"` whenever
   `c.gap <= 0`. Change that condition to `c.gap <= 0 && c.status === "bad"` (or
   equivalently `c.status === "bad"`) so a `tight` flush row (`gap:0`) renders
   `fmtLen(0) + unit` = `0.0m` while a genuine `bad` overlap still reads `"overlap"`.
   The `_verdictText`/banner path already keys off `status`, so it is unaffected.
6. **Symbol just outside the tolerance** (`faceGap` slightly above `+EPS`, e.g. 0.5mm) —
   falls through to `classify(faceGap)`; with `faceGap` well under `threshold` it reads
   `tight` and displays `0.0m` (rounds to 1 decimal cm). Continuous with the flush case,
   no discontinuity in verdict.
7. **Symbol-to-symbol gaps** — unchanged; the epsilon and helper are never applied to the
   `dx`/`dy` symbol branches.

## Frontend Design

**Decision B: ensure it works with corners (two flush walls).**

The flush gesture and clearance panel are read together on both desktop and mobile
(LLD 46 touch ergonomics), so the fix must be visually consistent, not just numerically:

- **Consistent pill/banner across walls.** After the fix, seating a symbol flush against
  any single wall shows the same verdict pill and panel banner ("It fits") with the wall
  row reading `0.0m` in the `tight` (amber) colour — never the red "Won't fit — overlap".
  This removes the reported jarring red-flash-on-one-wall-only behaviour.
- **Corner case must not regress to red.** When a symbol is seated into a corner touching
  two inner faces at once, both wall rows read `0.0m` / `tight` and the overall verdict
  stays a fit (`worstStatus` = `tight`). Because each side is classified independently
  through the shared `wallFaceStatus` helper, no dedicated corner logic is needed — the
  corner "just works," which is the intent of decision B. This is the acceptance bar for
  the visual behaviour: two flush walls read identically to one flush wall.
- **`0.0m` reads as intentional, not as an error.** The flush row shows `0.0m` in the
  `tight` styling (amber dot + amber value), distinct from a genuine overlap's red
  `"overlap"` text. This tells the user "you're seated exactly against the wall — good,"
  matching the LLD 26 hero "seat against the wall" gesture, rather than implying a
  collision. This requires the Edge Case 5 render-condition tweak
  (`c.status === "bad"` gate on the `"overlap"` string) in both `clearanceRender.js` and
  `clearancePanel.js`.
- **No new copy required.** A distinct "flush against wall" verdict string is explicitly
  optional and not part of this fix; the `tight` 0.0m reading is sufficient and keeps the
  chrome minimal (per the project's minimal-chrome design philosophy).

## Dependencies

- `src/js/clearance.js` — existing `classify()`, `computeClearances()`, `WALL_M` import
  from `walls.js`. This LLD is a self-contained edit to that file plus the two render
  condition tweaks.
- Behaviourally depends on LLD 26 (`nearestWallFlush` in `symbols.js`) as the gesture that
  produces the flush state, and LLD 24 (clearance model, `classify`, display precision
  contract). No code changes to either.
- No new modules, no build step, no external deps (consistent with the static
  no-build-step stack).

## Test Requirements

Add to the `clearance.js — computeClearances: wall gaps` suite in `src/tests.html`.
Use the existing `mkRoom` / `mkSym` helpers and `nearestWallFlush` from `symbols.js` (or
place the symbol AABB exactly on the inner face) to reproduce a true flush seat.

**Unit — flush consistency (the fix)**
- Flush-snap a symbol to the **left** wall → the `left wall` clearance has
  `status === "tight"` and `gap === 0` (NOT `"bad"`).
- Same for the **right**, **top**, and **bottom** walls — each independently `tight`,
  `gap 0`. Acceptance bar: **all four report a fit**.
- Assert `worstStatus(result)` is not `"bad"` for each single-wall flush.

**Unit — corner (frontend decision B)**
- Seat a symbol flush into a corner touching two walls (e.g. top-left). Assert **both**
  wall clearances are `tight`/`gap 0` and `worstStatus(result) === "tight"` (a fit).

**Unit — regression: real overlap still bad**
- Symbol edge ~3cm inside the wall body (`faceGap ≈ -0.03`) → that wall clearance
  `status === "bad"`, `gap === 0`.
- Keep the existing "symbol face within WALL_M/2 of centerline clamps wall gap to 0" test
  (faceGap `-0.02`) passing as `bad`.
- Keep the existing straddle / Edge Case 8 tests passing as `bad`.

**Unit — `classify()` untouched**
- Existing `classify` tests (`classify(0) === "bad"`, negatives `bad`, etc.) remain
  unchanged and passing — the epsilon is not in `classify()`.

**Render**
- (If the display-condition tweak is applied) a `tight` clearance with `gap === 0`
  formats its row/chip value as `0.0m` (via `fmtLen`), not the literal `"overlap"`;
  a `bad` clearance with `gap === 0` still formats as `"overlap"`.
