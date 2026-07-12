/**
 * core.js — the single import boundary to floorplan's geometry core (LLD 32).
 *
 * Everything the server needs from ../../src/js is re-exported here, so the
 * dev-checkout relative-import coupling (Q6, knowingly not self-contained —
 * breaks under npm publish) lives in exactly ONE place. The import-smoke test
 * loads this module under Node and asserts no throw, which is the early-warning
 * for a future src/ edit leaking a top-level DOM reference.
 *
 * Verified Node-clean at module load: plan.js → walls/symbols/view/units, and
 * clearance.js, and share.js all import without touching document/window.
 * share.js's buildShareUrl()/readBootHash() touch location/history and are
 * therefore NOT re-exported — the server only ever calls the pure functions.
 */

export {
  PLAN_SCHEMA,
  buildPlan,
  validatePlan,
  applyPlan,
  isEmptyPlan,
  serializePlan,
} from "../../src/js/plan.js";

export {
  model as wallsModel,
  hydrate as hydrateWalls,
  placeVertex,
  closeRoom,
  finishChain,
  rescaleEdge,
  polygonArea,
  perimeter,
  roomMetrics,
  wallSegments,
  moveRoom,
  rescaleRectEdge,
  isRectangle,
  pointNearRoomWall,
  WALL_M,
  MIN_SEG_M,
  setRoomColor,
} from "../../src/js/walls.js";

export {
  model as symbolsModel,
  hydrate as hydrateSymbols,
  CATALOG,
  createSymbol,
  addSymbol,
  moveSymbol,
  rotateSymbol,
  resizeSymbol,
  clampDim,
  snapToPreset,
  removeSymbol,
  duplicateSymbol,
  getSymbol,
  corners,
  PARALLEL_TOL_DEG,
  setSymbolColor,
} from "../../src/js/symbols.js";

export {
  computeClearances,
  classify,
  worstStatus,
  setThreshold,
  aabb,
  pointInRoom,
  THRESH_MIN,
  THRESH_MAX,
  DEFAULT_THRESHOLD,
} from "../../src/js/clearance.js";

export {
  model as measurementsModel,
  hydrate as hydrateMeasurements,
  add as addMeasurement,
  remove as removeMeasurement,
  getById as getMeasurementById,
  length as measurementLength,
} from "../../src/js/measurements.js";

// Live-binding read of the effective (post-clamp) threshold. A named import of
// `threshold` is a live binding, but re-reading via a namespace import is the
// clearest way to always see the value setThreshold() actually applied (M1).
export { encodePlanToHash, decodeHashToPlan } from "../../src/js/share.js";

import * as _clearance from "../../src/js/clearance.js";
/** The effective clearance threshold currently applied in the core (metres). */
export function effectiveThreshold() {
  return _clearance.threshold;
}
