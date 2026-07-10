/**
 * loupe.js — in-place magnifier bubble for touch drawing (LLD 57).
 *
 * Visual-only affordance; never affects commit coordinates. Shows a zoomed
 * live view of the snap point while a finger is held on the canvas, so the
 * user can see where the vertex will land even though the finger occludes it.
 *
 * Module constants:
 */
const LOUPE_DIAM_PX = 112;   // bubble diameter
const LOUPE_LIFT_PX = 72;    // bubble-center offset above the fingertip
const LOUPE_MAG     = 2.5;   // magnification factor

const SNAP_COLORS = {
  grid:  "#7fd0c8",
  point: "#e0b64f",
  close: "#9cd67a",
  free:  "#8f8a78",
};

// ── Module state ──────────────────────────────────────────────────────────────

let _stage   = null;   // .stage HTMLElement
let _drawing = null;   // #drawing SVGSVGElement (world/draft/snap source)
let _el      = null;   // .loupe div
let _svg     = null;   // <svg> inside the loupe
let _content = null;   // <g> that holds the zoomed-clone transform
let _cross   = null;   // crosshair <g>
let _visible = false;

// Current finger/snap state for reposition()
let _fingerSx = 0;
let _fingerSy = 0;
/** @type {import("./walls.js").Snap|null} */
let _snap = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM refs and append the loupe element. Called once from main.js.
 * @param {HTMLElement}    stage   .stage container
 * @param {SVGSVGElement}  drawing #drawing svg (source for the zoomed clone)
 */
export function init(stage, drawing) {
  _stage   = stage;
  _drawing = drawing;

  // Build loupe DOM
  _el = document.createElement("div");
  _el.className = "loupe";
  _el.setAttribute("aria-hidden", "true");
  _el.style.cssText = `
    display: none;
    position: fixed;
    pointer-events: none;
    z-index: 20;
    width: ${LOUPE_DIAM_PX}px;
    height: ${LOUPE_DIAM_PX}px;
    border-radius: 50%;
    overflow: hidden;
    border: 1.5px solid rgba(201,168,76,0.30);
    background: rgba(20,20,15,0.88);
    box-shadow: 0 4px 20px rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  `.trim().replace(/\s*\n\s*/g, " ");

  const R = LOUPE_DIAM_PX / 2;

  // SVG viewport clipped to the circular area
  _svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  _svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  _svg.setAttribute("width",  LOUPE_DIAM_PX);
  _svg.setAttribute("height", LOUPE_DIAM_PX);
  _svg.setAttribute("viewBox", `0 0 ${LOUPE_DIAM_PX} ${LOUPE_DIAM_PX}`);
  _svg.style.cssText = "display:block;";

  // Clip path so world content is circular
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const clipPath = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
  clipPath.id = "loupe-clip";
  const clipCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  clipCircle.setAttribute("cx", R);
  clipCircle.setAttribute("cy", R);
  clipCircle.setAttribute("r",  R);
  clipPath.appendChild(clipCircle);
  defs.appendChild(clipPath);
  _svg.appendChild(defs);

  // Content group: holds the zoomed world-content transform
  _content = document.createElementNS("http://www.w3.org/2000/svg", "g");
  _content.setAttribute("clip-path", "url(#loupe-clip)");
  _svg.appendChild(_content);

  // Crosshair group: drawn on top, pinned to bubble center
  _cross = document.createElementNS("http://www.w3.org/2000/svg", "g");
  _cross.setAttribute("clip-path", "url(#loupe-clip)");
  _svg.appendChild(_cross);

  _buildCrosshair(R, "#7fd0c8"); // default color; updated on each show/update

  // Downward-pointing tail notch (small triangle below bubble)
  _buildTail();

  _el.appendChild(_svg);
  stage.appendChild(_el);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Show or update the loupe with a new finger position and snap.
 * @param {number} fingerSx  fingertip screen x (clientX)
 * @param {number} fingerSy  fingertip screen y (clientY)
 * @param {import("./walls.js").Snap} snap  resolved snap (world x, y, type)
 */
export function show(fingerSx, fingerSy, snap) {
  if (!_el) return;
  _fingerSx = fingerSx;
  _fingerSy = fingerSy;
  _snap = snap;
  _visible = true;
  _render();
}

/** Hide the loupe (gesture end / cancel / leave / non-touch). */
export function hide() {
  if (!_el) return;
  _visible = false;
  _snap = null;
  _el.style.display = "none";
}

/**
 * Reposition the loupe's zoomed content after a view change.
 * Call from a surface.onRender hook so the loupe stays aligned
 * during pinch-zoom/pan that happen around it.
 */
export function reposition() {
  if (!_visible || !_snap) return;
  _render();
}

// ── Placement math (exported for unit tests) ──────────────────────────────────

/**
 * Pure helper: compute the bubble's screen-space center and whether it is
 * flipped below the finger (near top edge) or clamped (near side edges).
 * No DOM access; safe to test headlessly.
 *
 * @param {number} fingerSx  fingertip clientX
 * @param {number} fingerSy  fingertip clientY
 * @param {number} vw        viewport width
 * @param {number} vh        viewport height
 * @param {number} diam      bubble diameter
 * @param {number} lift      lift above finger (center-to-fingertip)
 * @returns {{ cx:number, cy:number, flipped:boolean }}
 */
export function computeLoupeRect(fingerSx, fingerSy, vw, vh, diam, lift) {
  const R = diam / 2;
  let cx = fingerSx;
  let cy = fingerSy - lift;
  let flipped = false;

  // Flip below finger if too close to top edge
  if (cy - R < 8) {
    cy = fingerSy + lift;
    flipped = true;
  }

  // Clamp horizontally
  if (cx - R < 8) cx = R + 8;
  if (cx + R > vw - 8) cx = vw - R - 8;

  // Clamp vertically (if flipped, ensure bottom edge is on-screen too)
  if (cy + R > vh - 8) cy = vh - R - 8;

  return { cx, cy, flipped };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _render() {
  if (!_el || !_drawing || !_snap) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { cx, cy, flipped } = computeLoupeRect(
    _fingerSx, _fingerSy, vw, vh,
    LOUPE_DIAM_PX, LOUPE_LIFT_PX
  );

  // Position the bubble element
  const R = LOUPE_DIAM_PX / 2;
  _el.style.left   = (cx - R) + "px";
  _el.style.top    = (cy - R) + "px";
  _el.style.display = "block";

  // Update tail visibility
  const tail = _el.querySelector(".loupe-tail");
  if (tail) tail.style.display = flipped ? "none" : "block";

  // Update crosshair color for snap type
  const color = SNAP_COLORS[_snap.type] || SNAP_COLORS.free;
  _updateCrosshairColor(color);

  // Build the zoomed world content
  _renderContent(cx, cy);
}

/**
 * Project world content into the loupe.
 * We re-project the existing SVG groups (#world, #draft, #snap) using a
 * transform that maps the snap world point to the bubble center at LOUPE_MAG.
 *
 * Transform derivation:
 *   screen_original = worldPt * pxPerM + pan
 *   loupe_center = R (= LOUPE_DIAM_PX / 2)
 *   We want: snap.worldPt → bubble center R
 *   loupe_x = (world_x - snap.x) * (pxPerM * LOUPE_MAG) + R
 *   loupe_y = (world_y - snap.y) * (pxPerM * LOUPE_MAG) + R
 *   SVG transform: translate(R, R) scale(LOUPE_MAG) translate(-snapScreenX, -snapScreenY)
 *   where snapScreenX/Y are the snap point's current screen coords.
 */
function _renderContent(bubbleCx, bubbleCy) {
  // Get current view state from the drawing SVG's coordinate system.
  // We use the live viewBox / transform on the #world group if available,
  // but the simplest and most robust approach is to import view directly.
  // Since this is a module, we import lazily to avoid circular deps at load time.
  const { view, pxPerM, worldToScreen } = _getViewModule();
  if (!view) return;

  const R = LOUPE_DIAM_PX / 2;
  const snapScreen = worldToScreen(_snap.x, _snap.y);

  // Remove any previous clone
  while (_content.firstChild) _content.removeChild(_content.firstChild);

  // Background to mask any gaps
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", 0);
  bg.setAttribute("y", 0);
  bg.setAttribute("width", LOUPE_DIAM_PX);
  bg.setAttribute("height", LOUPE_DIAM_PX);
  bg.setAttribute("fill", "#14140f");
  _content.appendChild(bg);

  // Clone the relevant drawing groups
  const groupIds = ["grid", "world", "draft", "snap"];
  for (const id of groupIds) {
    const src = _drawing.getElementById(id) || _drawing.querySelector("#" + id);
    if (!src) continue;
    const clone = src.cloneNode(true);
    clone.removeAttribute("id");
    _content.appendChild(clone);
  }

  // Apply magnifying transform to position snap point at bubble center
  // The source SVG groups are in screen coordinates already (they use
  // the same coordinate system as the drawing surface).
  // We need: snapScreen.x → R, snapScreen.y → R, scaled by LOUPE_MAG
  const tx = R - snapScreen.x * LOUPE_MAG;
  const ty = R - snapScreen.y * LOUPE_MAG;
  // Apply to each cloned group
  for (const child of _content.children) {
    if (child.tagName === "rect") continue; // background
    child.setAttribute("transform", `scale(${LOUPE_MAG}) translate(${tx / LOUPE_MAG}, ${ty / LOUPE_MAG})`);
  }
}

/** Lazy getter for view module to avoid circular dependency at load time. */
let _viewModule = null;
function _getViewModule() {
  if (_viewModule) return _viewModule;
  // Dynamic import is async; instead we access via a stored ref set by main.js.
  // Fall back to a no-op if not yet injected.
  return _viewModule || {};
}

/**
 * Inject the view module reference. Called from main.js after init.
 * @param {{ view:object, pxPerM:Function, worldToScreen:Function }} mod
 */
export function setViewModule(mod) {
  _viewModule = mod;
}

function _buildCrosshair(R, color) {
  while (_cross.firstChild) _cross.removeChild(_cross.firstChild);

  const size = 10; // half-length of crosshair arms
  const gap  =  4; // gap around center dot

  const attrs = [
    // Horizontal line (left segment)
    { x1: R - size, y1: R, x2: R - gap, y2: R },
    // Horizontal line (right segment)
    { x1: R + gap,  y1: R, x2: R + size, y2: R },
    // Vertical line (top segment)
    { x1: R, y1: R - size, x2: R, y2: R - gap },
    // Vertical line (bottom segment)
    { x1: R, y1: R + gap,  x2: R, y2: R + size },
  ];

  for (const a of attrs) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x1); line.setAttribute("y1", a.y1);
    line.setAttribute("x2", a.x2); line.setAttribute("y2", a.y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linecap", "round");
    line.classList.add("loupe-crosshair-line");
    _cross.appendChild(line);
  }

  // Center dot
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", R); dot.setAttribute("cy", R); dot.setAttribute("r", 2);
  dot.setAttribute("fill", color);
  dot.classList.add("loupe-crosshair-dot");
  _cross.appendChild(dot);

  // Snap-type ring (pulsing border; respects prefers-reduced-motion via CSS)
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  ring.setAttribute("cx", R); ring.setAttribute("cy", R); ring.setAttribute("r", 8);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", color);
  ring.setAttribute("stroke-width", "1");
  ring.setAttribute("stroke-opacity", "0.7");
  ring.classList.add("loupe-snap-ring");
  _cross.appendChild(ring);
}

function _updateCrosshairColor(color) {
  for (const el of _cross.querySelectorAll(".loupe-crosshair-line")) {
    el.setAttribute("stroke", color);
  }
  for (const el of _cross.querySelectorAll(".loupe-crosshair-dot")) {
    el.setAttribute("fill", color);
  }
  for (const el of _cross.querySelectorAll(".loupe-snap-ring")) {
    el.setAttribute("stroke", color);
  }
}

function _buildTail() {
  // Small triangle pointer below the bubble, pointing down toward the fingertip
  const tail = document.createElement("div");
  tail.className = "loupe-tail";
  tail.style.cssText = `
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid rgba(201,168,76,0.30);
    pointer-events: none;
  `.trim().replace(/\s*\n\s*/g, " ");
  _el.appendChild(tail);
}
