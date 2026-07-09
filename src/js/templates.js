/**
 * templates.js — starter template gallery controller
 *
 * Owns: (a) the TEMPLATES array of curated Plan records, and
 *       (b) the gallery modal controller (init, open, close, isOpen).
 *
 * Mirrors the help.js overlay pattern:
 *   - open() adds template-overlay--visible; close() removes it.
 *   - Capture-phase keydown: Esc closes + stops propagation (Edge Case 6).
 *   - Outside-click closes (document bubble phase).
 *
 * Depends on plan.js (validatePlan, applyPlan, isEmptyPlan) and receives
 * render/historyReset/fitToContent/showToast/saveNow via injection from
 * main.js to avoid circular imports.
 */

import { validatePlan, isEmptyPlan } from "./plan.js";

// ── Template plan data ────────────────────────────────────────────────────────
//
// Plans were authored by drawing rooms in the live app and exporting JSON, then
// pasted as literals here.  All plans use unit "m" (world coords are metres).
// Coordinates: rooms are placed near origin; fitToContent re-centres on load.

/**
 * @typedef {Object} Template
 * @property {string} id           stable slug
 * @property {string} name         display name
 * @property {string} description  one-line card blurb
 * @property {string} thumb        inline SVG markup (decorative preview)
 * @property {import("./plan.js").Plan} plan  a full, valid Plan document
 */

/** @type {Template[]} */
export const TEMPLATES = Object.freeze([
  // ── 1. Studio apartment (~27 m²) ──────────────────────────────────────────
  {
    id: "studio",
    name: "Studio apartment",
    description: "~27 m² open plan with bed, sofa & kitchenette",
    thumb: `<svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="8" y="8" width="104" height="74" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- bed -->
      <rect x="14" y="13" width="22" height="30" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <rect x="14" y="13" width="22" height="8" rx="1" fill="rgba(201,168,76,0.30)" stroke="none"/>
      <!-- sofa -->
      <rect x="42" y="13" width="36" height="16" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <rect x="42" y="13" width="36" height="5" rx="1" fill="rgba(201,168,76,0.28)" stroke="none"/>
      <!-- table -->
      <rect x="46" y="34" width="24" height="16" rx="1" fill="rgba(201,168,76,0.12)" stroke="#d9be6e" stroke-width="1"/>
      <!-- fridge (kitchenette) -->
      <rect x="14" y="66" width="12" height="12" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
    </svg>`,
    plan: {
      schema: 1,
      app: "floorplan",
      walls: {
        rooms: [
          {
            id: "r0",
            closed: true,
            verts: [
              { x: 0, y: 0 },
              { x: 5.5, y: 0 },
              { x: 5.5, y: 4.9 },
              { x: 0, y: 4.9 },
            ],
          },
        ],
        chain: [],
      },
      symbols: {
        symbols: [
          { id: "s0", type: "bed",    x: 0.9,  y: 1.1,  w: 1.5, h: 2.0, rot: 0 },
          { id: "s1", type: "sofa",   x: 3.3,  y: 0.65, w: 2.0, h: 0.9, rot: 0 },
          { id: "s2", type: "table",  x: 3.3,  y: 2.0,  w: 1.2, h: 0.8, rot: 0 },
          { id: "s3", type: "fridge", x: 0.55, y: 4.35, w: 0.7, h: 0.7, rot: 0 },
          { id: "s4", type: "door",   x: 5.5,  y: 3.5,  w: 0.9, h: 0.12, rot: 90 },
        ],
      },
      view: { zoom: 1, panX: 0, panY: 0 },
      unit: "m",
    },
  },

  // ── 2. One-bedroom apartment (~55 m²) ─────────────────────────────────────
  {
    id: "one-bedroom",
    name: "1-bedroom apartment",
    description: "~55 m² with bedroom, living room & kitchen",
    thumb: `<svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <!-- bedroom -->
      <rect x="8" y="8" width="48" height="40" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- living room -->
      <rect x="56" y="8" width="56" height="40" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- kitchen strip -->
      <rect x="8" y="48" width="104" height="34" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- bed -->
      <rect x="13" y="13" width="22" height="28" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <rect x="13" y="13" width="22" height="7" rx="1" fill="rgba(201,168,76,0.28)" stroke="none"/>
      <!-- sofa -->
      <rect x="62" y="13" width="36" height="16" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <!-- table -->
      <rect x="67" y="34" width="24" height="12" rx="1" fill="rgba(201,168,76,0.12)" stroke="#d9be6e" stroke-width="1"/>
      <!-- fridge -->
      <rect x="13" y="53" width="12" height="12" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <!-- desk -->
      <rect x="30" y="53" width="20" height="12" rx="1" fill="rgba(201,168,76,0.12)" stroke="#d9be6e" stroke-width="1"/>
    </svg>`,
    plan: {
      schema: 1,
      app: "floorplan",
      walls: {
        rooms: [
          {
            id: "r0",
            closed: true,
            verts: [
              { x: 0, y: 0 },
              { x: 3.5, y: 0 },
              { x: 3.5, y: 3.5 },
              { x: 0, y: 3.5 },
            ],
          },
          {
            id: "r1",
            closed: true,
            verts: [
              { x: 3.5, y: 0 },
              { x: 7.5, y: 0 },
              { x: 7.5, y: 3.5 },
              { x: 3.5, y: 3.5 },
            ],
          },
          {
            id: "r2",
            closed: true,
            verts: [
              { x: 0, y: 3.5 },
              { x: 7.5, y: 3.5 },
              { x: 7.5, y: 7.0 },
              { x: 0, y: 7.0 },
            ],
          },
        ],
        chain: [],
      },
      symbols: {
        symbols: [
          { id: "s0", type: "bed",    x: 1.0,  y: 1.3,  w: 1.5, h: 2.0, rot: 0 },
          { id: "s1", type: "sofa",   x: 5.5,  y: 0.7,  w: 2.0, h: 0.9, rot: 0 },
          { id: "s2", type: "table",  x: 5.5,  y: 2.3,  w: 1.2, h: 0.8, rot: 0 },
          { id: "s3", type: "fridge", x: 0.55, y: 4.25, w: 0.7, h: 0.7, rot: 0 },
          { id: "s4", type: "desk",   x: 2.2,  y: 4.25, w: 1.4, h: 0.7, rot: 0 },
          { id: "s5", type: "door",   x: 1.75, y: 3.5,  w: 0.9, h: 0.12, rot: 0 },
          { id: "s6", type: "door",   x: 5.5,  y: 3.5,  w: 0.9, h: 0.12, rot: 0 },
          { id: "s7", type: "window", x: 7.5,  y: 1.75, w: 1.0, h: 0.12, rot: 90 },
        ],
      },
      view: { zoom: 1, panX: 0, panY: 0 },
      unit: "m",
    },
  },

  // ── 3. Single room (~20 m²) ───────────────────────────────────────────────
  {
    id: "single-room",
    name: "Rectangular room",
    description: "~20 m² blank room — add your own furniture",
    thumb: `<svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="12" y="12" width="96" height="66" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- door hint -->
      <path d="M 12 66 A 20 20 0 0 1 32 66" stroke="#d9be6e" stroke-width="1" stroke-dasharray="3 2" fill="none" opacity="0.5"/>
    </svg>`,
    plan: {
      schema: 1,
      app: "floorplan",
      walls: {
        rooms: [
          {
            id: "r0",
            closed: true,
            verts: [
              { x: 0, y: 0 },
              { x: 5.0, y: 0 },
              { x: 5.0, y: 4.0 },
              { x: 0, y: 4.0 },
            ],
          },
        ],
        chain: [],
      },
      symbols: {
        symbols: [
          { id: "s0", type: "door",   x: 0.6,  y: 4.0,  w: 0.9, h: 0.12, rot: 0 },
          { id: "s1", type: "window", x: 2.5,  y: 0,    w: 1.2, h: 0.12, rot: 0 },
        ],
      },
      view: { zoom: 1, panX: 0, panY: 0 },
      unit: "m",
    },
  },

  // ── 4. Small office (~15 m²) ──────────────────────────────────────────────
  {
    id: "small-office",
    name: "Small office",
    description: "~15 m² office with desk, chair & storage",
    thumb: `<svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="16" y="12" width="88" height="66" fill="rgba(201,168,76,0.07)" stroke="#d9be6e" stroke-width="1.5"/>
      <!-- desk L-shape suggestion -->
      <rect x="21" y="17" width="36" height="14" rx="1" fill="rgba(201,168,76,0.18)" stroke="#d9be6e" stroke-width="1"/>
      <rect x="21" y="31" width="14" height="14" rx="1" fill="rgba(201,168,76,0.14)" stroke="#d9be6e" stroke-width="1"/>
      <!-- chair (circle) -->
      <circle cx="81" cy="48" r="10" fill="rgba(201,168,76,0.12)" stroke="#d9be6e" stroke-width="1"/>
      <!-- table -->
      <rect x="56" y="30" width="30" height="18" rx="1" fill="rgba(201,168,76,0.12)" stroke="#d9be6e" stroke-width="1"/>
    </svg>`,
    plan: {
      schema: 1,
      app: "floorplan",
      walls: {
        rooms: [
          {
            id: "r0",
            closed: true,
            verts: [
              { x: 0, y: 0 },
              { x: 5.0, y: 0 },
              { x: 5.0, y: 3.0 },
              { x: 0, y: 3.0 },
            ],
          },
        ],
        chain: [],
      },
      symbols: {
        symbols: [
          { id: "s0", type: "desk",   x: 0.8,  y: 0.45, w: 1.4, h: 0.7, rot: 0 },
          { id: "s1", type: "chair",  x: 0.8,  y: 1.2,  w: 0.5, h: 0.5, rot: 0 },
          { id: "s2", type: "desk",   x: 3.2,  y: 1.5,  w: 1.4, h: 0.7, rot: 0 },
          { id: "s3", type: "chair",  x: 3.2,  y: 0.55, w: 0.5, h: 0.5, rot: 0 },
          { id: "s4", type: "table",  x: 2.2,  y: 2.1,  w: 1.2, h: 0.8, rot: 0 },
          { id: "s5", type: "door",   x: 4.4,  y: 3.0,  w: 0.9, h: 0.12, rot: 0 },
          { id: "s6", type: "window", x: 2.5,  y: 0,    w: 1.0, h: 0.12, rot: 0 },
        ],
      },
      view: { zoom: 1, panX: 0, panY: 0 },
      unit: "m",
    },
  },
]);

// ── Overlay state ─────────────────────────────────────────────────────────────

let _open       = false;
/** @type {Element|null} */
let _overlayEl  = null;
/** @type {Element|null} */
let _closeBtnEl = null;
/** @type {Element|null} */
let _gridEl     = null;
/** @type {Element|null} */
let _emptyCtaEl = null;

/** Injected callbacks, set by init(). */
let _apply  = null; // (plan) => void
let _isEmpty = null; // () => boolean
let _toast  = null; // (msg) => void

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wire DOM refs + injected callbacks; render the cards; register listeners.
 * @param {{
 *   overlay:   Element,
 *   grid:      Element,
 *   closeBtn:  Element,
 *   emptyCta?: Element,
 *   apply:     (plan: import("./plan.js").Plan) => void,
 *   isEmpty:   () => boolean,
 *   toast:     (msg: string) => void,
 * }} refs
 */
export function init(refs) {
  _overlayEl  = refs.overlay;
  _gridEl     = refs.grid;
  _closeBtnEl = refs.closeBtn;
  _emptyCtaEl = refs.emptyCta || null;
  _apply      = refs.apply;
  _isEmpty    = refs.isEmpty;
  _toast      = refs.toast;

  // Render cards from TEMPLATES data
  _renderCards();

  // Close button
  _closeBtnEl?.addEventListener("click", close);

  // Capture-phase Esc: close overlay + stop propagation (mirrors help.js Edge Case 15)
  window.addEventListener("keydown", _onKey, true /* capture */);

  // Outside-click dismissal (bubble phase on document)
  document.addEventListener("click", _onDocumentClick);

  // Empty-state CTA click
  _emptyCtaEl?.addEventListener("click", open);
}

/** Show the gallery. */
export function open() {
  _open = true;
  if (_overlayEl) {
    _overlayEl.classList.add("template-overlay--visible");
    // Focus first card for accessibility
    const firstCard = _overlayEl.querySelector(".template-card");
    if (firstCard) {
      setTimeout(() => firstCard.focus(), 0);
    }
  }
}

/** Hide the gallery. */
export function close() {
  _open = false;
  if (_overlayEl) {
    _overlayEl.classList.remove("template-overlay--visible");
  }
}

/** True while the gallery is visible. */
export function isOpen() {
  return _open;
}

/**
 * Validate → confirm-if-dirty → apply a template by id.
 * Returns true if applied.
 * @param {string} id
 * @returns {boolean}
 */
export function applyTemplate(id) {
  const record = TEMPLATES.find(t => t.id === id);
  if (!record) {
    if (_toast) _toast("Template not found");
    return false;
  }

  const plan = validatePlan(record.plan);
  if (!plan) {
    if (_toast) _toast("Couldn't load template");
    return false;
  }

  // Confirm only when there's content to lose
  if (_isEmpty && !_isEmpty()) {
    const confirmed = window.confirm("Replace current plan with this template? This can't be undone.");
    if (!confirmed) return false;
  }

  if (_apply) _apply(plan);
  close();
  // Hide empty CTA — driven by render hooks from main.js, but be explicit
  if (_emptyCtaEl) _emptyCtaEl.hidden = true;
  if (_toast) _toast("Loaded '" + record.name + "'");
  return true;
}

// ── Private ────────────────────────────────────────────────────────────────────

/**
 * Populate the .template-grid element with one card per TEMPLATES entry.
 */
function _renderCards() {
  if (!_gridEl) return;
  _gridEl.innerHTML = "";
  for (const t of TEMPLATES) {
    const btn = document.createElement("button");
    btn.className = "template-card";
    btn.setAttribute("role", "listitem");
    btn.dataset.templateId = t.id;
    btn.setAttribute("aria-label", t.name + " — " + t.description);

    const thumbSpan = document.createElement("span");
    thumbSpan.className = "template-thumb";
    thumbSpan.innerHTML = t.thumb;

    const nameSpan = document.createElement("span");
    nameSpan.className = "template-card-name";
    nameSpan.textContent = t.name;

    const descSpan = document.createElement("span");
    descSpan.className = "template-card-desc";
    descSpan.textContent = t.description;

    btn.appendChild(thumbSpan);
    btn.appendChild(nameSpan);
    btn.appendChild(descSpan);

    btn.addEventListener("click", () => applyTemplate(t.id));
    _gridEl.appendChild(btn);
  }
}

/**
 * Capture-phase keydown handler.
 * Esc closes the overlay and stops propagation so the event never reaches
 * the bubble-phase wallTool Esc listener (Edge Case 6).
 */
function _onKey(e) {
  if (e.key === "Escape" && _open) {
    e.stopPropagation();
    e.preventDefault();
    close();
  }
}

/**
 * Document-level click handler: close when clicking outside the panel.
 */
function _onDocumentClick(e) {
  if (!_open) return;
  if (_overlayEl && _overlayEl.contains(/** @type {Node} */ (e.target))) {
    // Click inside — but only close if it was on the scrim itself
    // (i.e. not inside the panel). The panel has class template-overlay-panel.
    const panel = _overlayEl.querySelector(".template-overlay-panel");
    if (panel && panel.contains(/** @type {Node} */ (e.target))) return;
    close();
  }
}
