/**
 * feedback.js — the loop-closing feedback shaper (LLD 32, the differentiator).
 *
 * Converts clearance.js's raw Clearance[] into a ClearanceReport an agent can
 * converge on: per-gap centimetres + a DIRECTION vector (not just a magnitude),
 * a resolved per-symbol suggestedMove that reconciles multiple gaps, a boxed-in
 * infeasibility signal, and a natural-language violations list — plus a single
 * `satisfied` boolean for the stopping condition.
 *
 * Axis convention (world = screen coords, y-down): +x=right, -x=left,
 * +y=down, -y=up. All lengths metres; feedback strings echo centimetres.
 */

import {
  computeClearances,
  classify,
  worstStatus,
  setThreshold,
  effectiveThreshold,
  CATALOG,
} from "./core.js";

const AXIS_CONVENTION = "+x=right, +y=down (screen coords); metres";

// A tiny outward margin (metres) added to a resolved push so the target clears
// the threshold rather than landing exactly on the float boundary (where
// classify() could still read "tight"). ~1 mm — below the app's finest snap.
const PUSH_EPS_M = 0.001;

const round = Math.round;
const cm = (m) => round(m * 100);

/**
 * Derive the axis + open direction of a gap from its leader endpoints a/b.
 * a is on the subject's side, b on the neighbour's side; moving the subject in
 * `openDir` grows the gap.
 * @param {{a:{x,y}, b:{x,y}}} c
 * @returns {{ axis:"x"|"y", openDir:"+x"|"-x"|"+y"|"-y" }}
 */
function deriveDirection(c) {
  // Horizontal leader → x-axis; vertical → y-axis. (Overlap leaders are
  // center-to-center and may be diagonal; handled by the caller.)
  if (c.a.y === c.b.y) {
    // sign of (a - b): a further +x than b ⇒ move subject +x to open
    return { axis: "x", openDir: c.a.x - c.b.x >= 0 ? "+x" : "-x" };
  }
  return { axis: "y", openDir: c.a.y - c.b.y >= 0 ? "+y" : "-y" };
}

/**
 * Build one Gap object from a raw Clearance, given the effective threshold and
 * whether the neighbour is diagonally separated (both axes) from the subject.
 */
function buildGap(c, thresholdM, diagonal) {
  const { axis, openDir } = deriveDirection(c);
  const gapM = c.gap;
  const deficitCm = Math.max(0, round((thresholdM - gapM) * 100));
  return {
    to: c.label,
    kind: c.kind,
    ...(c.neighbourId !== undefined ? { neighbourId: c.neighbourId } : {}),
    axis,
    openDir,
    gapM,
    gapCm: cm(gapM),
    deficitCm,
    status: c.status, // classify() verbatim — bad only for gap<=0
    diagonal,
  };
}

/**
 * Is the neighbour symbol separated from the subject on BOTH axes (diagonal)?
 * computeClearances reports min(dx,dy) for such pairs and under-reports the true
 * corner gap, so we flag it. Only meaningful for symbol neighbours.
 */
function isDiagonal(subjectAabb, other, aabbOf) {
  if (!other) return false;
  const ob = aabbOf(other);
  const dx = Math.max(ob.l - subjectAabb.r, subjectAabb.l - ob.r);
  const dy = Math.max(ob.t - subjectAabb.b, subjectAabb.t - ob.b);
  return dx > 0 && dy > 0;
}

/**
 * M6: is a flank a FIXED span boundary, or a MOVABLE piece with room behind it?
 * A wall flank is always fixed. A symbol flank is fixed only if it is itself
 * wall-pinned — i.e. its own clearance in the direction BEHIND it (away from the
 * subject, which is the subject's `openDir` toward it) is < thresholdM.
 *
 * Returns { fixed:boolean, neighbourId?:string, roomBehindM?:number } — roomBehind
 * is the neighbour's clearance behind it (how far it can yield), for the "move the
 * neighbour" instruction.
 *
 * @param {Gap} gap        the subject's gap defining this flank
 * @param {"+x"|"-x"|"+y"|"-y"} openDir  the flank's openDir (subject→neighbour side)
 */
function classifyFlank(gap, openDir, thresholdM, world, getSymbolById, clearancesFor) {
  if (gap.kind === "wall") return { fixed: true };
  const nb = gap.neighbourId ? getSymbolById(gap.neighbourId) : null;
  if (!nb) return { fixed: true }; // unknown → treat as fixed (conservative)

  // The neighbour's clearance BEHIND it is its own gap in the SAME openDir as the
  // subject's gap to it (the subject's escape direction points past the neighbour).
  const nbClear = clearancesFor(nb);
  let roomBehindM = Infinity;
  for (const c of nbClear) {
    const cAxis = c.a.y === c.b.y ? "x" : "y";
    const cDir = cAxis === "x"
      ? (c.a.x - c.b.x >= 0 ? "+x" : "-x")
      : (c.a.y - c.b.y >= 0 ? "+y" : "-y");
    if (cDir === openDir) roomBehindM = Math.min(roomBehindM, c.gap);
  }
  return {
    fixed: roomBehindM < thresholdM,
    neighbourId: gap.neighbourId,
    roomBehindM: roomBehindM === Infinity ? null : roomBehindM,
  };
}

/**
 * Resolve the per-axis displacement + boxed-in axes for a subject from its FULL
 * gap set (violated AND currently-OK), per the LLD reconciliation rules.
 *
 * Returns { suggestedMove:{toX,toY}|null, boxedInAxes:[], spans:{x?,y?} }.
 * spans carries the per-axis span info used to build structural instructions.
 *
 * @param {{x:number,y:number}} center subject center (metres)
 * @param {number} subjectW subject AABB width (metres)
 * @param {number} subjectH subject AABB height (metres)
 * @param {Gap[]} gaps
 * @param {number} thresholdM effective threshold
 */
function reconcile(center, subjectW, subjectH, gaps, thresholdM, world, getSymbolById, clearancesFor) {
  const boxedInAxes = [];
  const comp = { x: 0, y: 0 };
  const spans = {};
  const moveNeighbours = {}; // axis → { neighbourId, roomBehindM } when a flank is movable
  const extent = { x: subjectW, y: subjectH };

  for (const axis of ["x", "y"]) {
    const onAxis = gaps.filter((g) => g.axis === axis);
    const neg = onAxis.filter((g) => g.openDir === `-${axis}`);
    const pos = onAxis.filter((g) => g.openDir === `+${axis}`);

    // Feasibility first, from ALL gaps on the axis (violated or not).
    if (neg.length && pos.length) {
      const gapNegM = Math.min(...neg.map((g) => g.gapM));
      const gapPosM = Math.min(...pos.map((g) => g.gapM));
      const spanM = gapNegM + extent[axis] + gapPosM;
      const neededM = extent[axis] + 2 * thresholdM;
      if (gapNegM + gapPosM < 2 * thresholdM - 1e-9) {
        // Span looks too narrow — but (M6) only a FIXED flank (wall or wall-pinned
        // piece) really bounds it. Classify the nearest flank on each side; if a
        // constraining flank is a MOVABLE piece with room behind it, the subject
        // is NOT boxed — that neighbour should move instead.
        const negGap = neg.reduce((a, b) => (b.gapM < a.gapM ? b : a));
        const posGap = pos.reduce((a, b) => (b.gapM < a.gapM ? b : a));
        const negFlank = classifyFlank(negGap, `-${axis}`, thresholdM, world, getSymbolById, clearancesFor);
        const posFlank = classifyFlank(posGap, `+${axis}`, thresholdM, world, getSymbolById, clearancesFor);
        if (negFlank.fixed && posFlank.fixed) {
          boxedInAxes.push(axis);
          spans[axis] = { spanM, neededM, gapNegM, gapPosM };
          continue; // genuinely boxed — no component on this axis
        }
        // A movable flank exists → not boxed. Record the movable neighbour so the
        // violation can instruct moving it; give the subject no component here.
        // (Full convergence through such a deadlock may need a joint two-piece
        // move — a documented deferred design iteration, see LLD M6.)
        const movable = !negFlank.fixed ? negFlank : posFlank;
        moveNeighbours[axis] = {
          neighbourId: movable.neighbourId,
          roomBehindM: movable.roomBehindM,
        };
        continue;
      }
      // Two-sided FEASIBLE axis. Convention: a gap's openDir is the way to move
      // the subject to GROW it, so moving +axis grows the +axis-openDir gap
      // (gapPosM) and shrinks the −axis-openDir gap (gapNegM), and vice-versa.
      //
      // Push away from the violating side by its deficit, but never so far that
      // the OPPOSING gap drops below threshold — that overshoot (which the raw
      // deficit + epsilon can cause when slack is tiny) is exactly the
      // near-boundary oscillation. The safe displacement window that keeps BOTH
      // gaps >= threshold is d ∈ [threshold − gapPos, gapNeg − threshold]
      // (a +d shifts gapNeg→gapNeg−d and gapPos→gapPos+d); feasibility guarantees
      // lo <= hi. Pick the end of that window nearest zero (smallest move that
      // satisfies both) — which for an ultra-tight symmetric band collapses to
      // the midpoint, and for an asymmetric case pushes just clear of the tight
      // side. No epsilon here: the window is closed on both ends by real gaps.
      const negViol = neg.some((g) => g.status !== "ok");
      const posViol = pos.some((g) => g.status !== "ok");
      if (negViol || posViol) {
        // The displacement window that keeps BOTH gaps >= threshold is
        // d ∈ [lo, hi] = [threshold − gapPos, gapNeg − threshold] (a +d shifts
        // gapNeg→gapNeg−d, gapPos→gapPos+d); feasibility guarantees lo <= hi.
        // Choose the point in the window closest to 0 (smallest move that
        // satisfies both sides), then back off any window edge by up to
        // PUSH_EPS_M so the target sits strictly inside — landing exactly on an
        // edge means a gap equals the threshold, which float-rounds to "tight"
        // and causes a near-boundary oscillation.
        const lo = thresholdM - gapPosM;
        const hi = gapNegM - thresholdM;
        const half = (hi - lo) / 2;
        const pad = Math.min(PUSH_EPS_M, half); // never cross the window's center
        comp[axis] = Math.min(Math.max(0, lo + pad), hi - pad);
      }
      continue;
    }

    // One-sided axis (flanked on a single side, or free on the other): push by
    // the largest same-side deficit. With no opposing constraint, a small
    // outward epsilon safely clears the float boundary (where classify() would
    // otherwise still read "tight") without any gap to knock back under.
    const violating = onAxis.filter((g) => g.status !== "ok");
    if (violating.length) {
      let dxNeg = 0, dxPos = 0;
      for (const g of violating) {
        const d = thresholdM - g.gapM + PUSH_EPS_M; // raw metres needed to clear
        if (g.openDir === `-${axis}`) dxNeg = Math.max(dxNeg, d);
        else dxPos = Math.max(dxPos, d);
      }
      comp[axis] = dxPos >= dxNeg ? dxPos : -dxNeg;
    }
  }

  if (boxedInAxes.length) {
    return { suggestedMove: null, boxedInAxes, spans, moveNeighbours };
  }
  // If an axis needs a neighbour moved (M6) and the subject has no useful move of
  // its own, suggestedMove is null on that basis — the neighbour is the actor.
  const hasMove = comp.x !== 0 || comp.y !== 0;
  const needsNeighbourMove = Object.keys(moveNeighbours).length > 0;
  if (needsNeighbourMove && !hasMove) {
    return { suggestedMove: null, boxedInAxes: [], spans, moveNeighbours };
  }
  return {
    suggestedMove: { toX: center.x + comp.x, toY: center.y + comp.y },
    boxedInAxes: [],
    spans,
    moveNeighbours,
  };
}

/**
 * AABB of a symbol using the same rule clearance.js uses (via corners()).
 * Imported lazily to avoid a cycle; passed in by the caller.
 */

/**
 * Build the full ClearanceReport for a set of furniture subjects.
 *
 * @param {object} opts
 * @param {import("./core.js")} opts  (unused placeholder)
 * @param {{rooms:any[], symbols:any[]}} world
 * @param {number} thresholdM  requested threshold (already range-checked by caller)
 * @param {string|undefined} onlyId  evaluate a single subject if given
 * @param {(sym:any)=>{l,r,t,b}} aabbOf
 * @param {(id:string)=>any} getSymbolById
 */
export function buildClearanceReport(world, thresholdM, onlyId, aabbOf, getSymbolById) {
  // Apply threshold to the core so classify()/computeClearances use it, then
  // read back the EFFECTIVE (post-clamp) value for all report math (M1).
  setThreshold(thresholdM);
  const effThr = effectiveThreshold();

  const subjects = world.symbols.filter((s) => {
    if (CATALOG[s.type]?.openings) return false; // openings are not subjects
    if (onlyId !== undefined) return s.id === onlyId;
    return true;
  });

  // Per-report clearance cache: keyed by symbol id. world is constant within one
  // buildClearanceReport call, so caching by neighbour id is sound. Do NOT hoist
  // to module scope — that risks staleness after a mutation between calls.
  const clearanceCache = new Map();
  const clearancesFor = (sym) => {
    let c = clearanceCache.get(sym.id);
    if (!c) { c = computeClearances(sym, world); clearanceCache.set(sym.id, c); }
    return c;
  };

  const items = [];
  const violations = [];
  let anyTight = false;
  let anyBad = false;

  for (const sym of subjects) {
    const raw = clearancesFor(sym); // seeds the cache for this subject
    const box = aabbOf(sym);
    const subjectW = box.r - box.l;
    const subjectH = box.b - box.t;
    const center = { x: (box.l + box.r) / 2, y: (box.t + box.b) / 2 };

    const gaps = raw.map((c) => {
      const other = c.neighbourId ? getSymbolById(c.neighbourId) : null;
      const diagonal = c.kind === "symbol" && isDiagonal(box, other, aabbOf);
      return buildGap(c, effThr, diagonal);
    });

    const itemWorst = worstStatus(raw);
    if (itemWorst === "bad") anyBad = true;
    else if (itemWorst === "tight") anyTight = true;

    const { suggestedMove, boxedInAxes, spans, moveNeighbours } = reconcile(
      center, subjectW, subjectH, gaps, effThr, world, getSymbolById, clearancesFor
    );

    const label = CATALOG[sym.type]?.label || sym.type;
    items.push({
      id: sym.id,
      label,
      worstStatus: itemWorst,
      center: { x: center.x, y: center.y },
      gaps,
      suggestedMove,
      boxedInAxes,
    });

    // Build a NL violation string for this subject if it has any sub-threshold
    // gap (status tight or bad). Only sub-threshold gaps are listed.
    const bad = gaps.filter((g) => g.status !== "ok");
    if (bad.length) {
      // Edge case 9: for a rotated subject the gaps are computed from its
      // (larger) axis-aligned bounding box, so they are conservative/pessimistic
      // — note this so the agent isn't surprised by a slightly small number.
      const rotated = ((sym.rot % 360) + 360) % 360 !== 0;
      violations.push(
        buildViolationString(label, bad, suggestedMove, boxedInAxes, spans, subjectW, subjectH, effThr, center, rotated, moveNeighbours, getSymbolById)
      );
    }
  }

  const worst = anyBad ? "bad" : anyTight ? "tight" : "ok";
  const satisfied = !anyBad && !anyTight;

  return {
    thresholdM: effThr,
    satisfied,
    worstStatus: worst,
    axisConvention: AXIS_CONVENTION,
    items,
    violations,
  };
}

const DIR_WORD = { "+x": "right", "-x": "left", "+y": "down", "-y": "up" };

function buildViolationString(label, badGaps, suggestedMove, boxedInAxes, spans, subjectW, subjectH, thresholdM, center, rotated, moveNeighbours, getSymbolById) {
  const thrCm = cm(thresholdM);

  // Overlap first (gap <= 0).
  const overlaps = badGaps.filter((g) => g.status === "bad");
  const tight = badGaps.filter((g) => g.status === "tight");

  const parts = [];
  for (const g of overlaps) {
    parts.push(`overlaps ${g.to} — separate them`);
  }
  for (const g of tight) {
    parts.push(`${g.gapCm} cm from ${g.to} (needs ${thrCm})`);
  }
  let msg = `${label}: ${parts.join(" and ")}.`;

  if (boxedInAxes.length) {
    // Structural instruction, quantified from the span (LLD).
    for (const axis of boxedInAxes) {
      const s = spans[axis];
      if (!s) continue;
      const extentCm = cm(axis === "x" ? subjectW : subjectH);
      msg += ` ${label} is pinned on the ${axis}-axis: span is ${cm(s.spanM)} cm but ${label} (${extentCm} cm) needs ${extentCm} + 2×${thrCm} = ${cm(s.neededM)} cm to seat with ${thrCm} cm each side — widen the room or use smaller pieces.`;
    }
  } else if (suggestedMove) {
    // Concrete move + per-axis deltas in plain language (e.g. "left 42 cm and up
    // 20 cm"), so the instruction is self-contained (a direct move_symbol call).
    const dx = suggestedMove.toX - center.x;
    const dy = suggestedMove.toY - center.y;
    const deltas = [];
    if (Math.abs(dx) >= 0.005) deltas.push(`${DIR_WORD[dx > 0 ? "+x" : "-x"]} ${cm(Math.abs(dx))} cm`);
    if (Math.abs(dy) >= 0.005) deltas.push(`${DIR_WORD[dy > 0 ? "+y" : "-y"]} ${cm(Math.abs(dy))} cm`);
    msg += ` Move ${label} to ~(${suggestedMove.toX.toFixed(2)}, ${suggestedMove.toY.toFixed(2)}) m`;
    msg += deltas.length ? ` — ${deltas.join(" and ")}.` : ".";
  }

  // M6: an axis is constrained by a MOVABLE neighbour (not a wall). Name that
  // neighbour as the piece to reposition — the subject itself isn't boxed.
  if (moveNeighbours) {
    for (const axis of Object.keys(moveNeighbours)) {
      const mn = moveNeighbours[axis];
      const nb = mn.neighbourId && getSymbolById ? getSymbolById(mn.neighbourId) : null;
      const nbLabel = nb ? (CATALOG[nb.type]?.label || nb.type) : "the neighbour";
      const roomTxt = mn.roomBehindM != null ? ` (it has ~${cm(mn.roomBehindM)} cm of open space behind it)` : "";
      msg += ` ${label} is tight against ${nbLabel} with little room to move on the ${axis}-axis; move ${nbLabel} away${roomTxt}, then re-check.`;
    }
  }

  // Edge case 9: rotated subject → gaps are bounding-box based (conservative).
  if (rotated) {
    msg += ` (Note: ${label} is rotated, so gaps are measured from its bounding box and are conservative — re-check after moving.)`;
  }
  return msg;
}
