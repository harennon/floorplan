/**
 * clearancePanel.js — right-side Clearance panel controller.
 *
 * Analogue of measure.js. Renders the sorted gap list, verdict banner, threshold
 * slider, density segmented control, and on/off switch. Writes back into
 * clearance.js state and calls scheduleRender().
 */

import { model as symbolsModel } from "./symbols.js";
import { model as wallsModel } from "./walls.js";
import { fmtLen, unitLabel } from "./units.js";
import { scheduleRender } from "./surface.js";
import {
  threshold, density, enabled,
  THRESH_MIN, THRESH_MAX, THRESH_STEP,
  setThreshold, setDensity, setEnabled,
  computeClearances, worstStatus,
} from "./clearance.js";

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _panel         = null;
let _body          = null;
let _toggle        = null;
let _getSelectedId = () => null;
let _getSymbol     = () => null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {{ panel:Element, body:Element, toggle:Element,
 *           getSelectedId:()=>string|null,
 *           getSymbol:(id:string)=>import("./symbols.js").Sym|null }} refs
 */
export function init(refs) {
  _panel         = refs.panel;
  _body          = refs.body;
  _toggle        = refs.toggle;
  _getSelectedId = refs.getSelectedId || (() => null);
  _getSymbol     = refs.getSymbol     || (() => null);

  // Collapse/expand toggle (mirrors measure.js)
  if (_toggle) {
    _toggle.addEventListener("click", () => {
      const willCollapse = !_panel.classList.contains("clearance--collapsed");
      _panel.classList.toggle("clearance--collapsed");
      _toggle.setAttribute("aria-expanded", willCollapse ? "false" : "true");
      _toggle.textContent = willCollapse ? "▸" : "▾";
    });
  }
}

// ── onRender hook ──────────────────────────────────────────────────────────────

/**
 * Rebuild the Clearance panel DOM from current state.
 * Registered via surface.onRender.
 */
export function update() {
  if (!_panel || !_body) return;

  const selectedId = _getSelectedId();
  const sym = selectedId ? _getSymbol(selectedId) : null;

  // Compute clearances (or empty list)
  const clearances = sym ? computeClearances(sym, {
    rooms: wallsModel.rooms,
    symbols: symbolsModel.symbols,
  }) : [];

  // Sort tightest first (ascending gap)
  const sorted = [...clearances].sort((a, b) => a.gap - b.gap);
  const worst  = worstStatus(sorted);

  // Rebuild body content
  _body.innerHTML = "";

  // ── Controls row: threshold slider ──────────────────────────────────────

  const ctrlsDiv = document.createElement("div");
  ctrlsDiv.className = "clr-controls";

  // Threshold slider row
  const sliderRow = document.createElement("div");
  sliderRow.className = "clr-slider-row";

  const sliderLabel = document.createElement("label");
  sliderLabel.className = "clr-slider-label";
  sliderLabel.textContent = "Min walkway";
  sliderLabel.setAttribute("for", "clr-threshold-slider");

  const slider = document.createElement("input");
  slider.type  = "range";
  slider.id    = "clr-threshold-slider";
  slider.className = "clr-slider";
  slider.min   = String(THRESH_MIN);
  slider.max   = String(THRESH_MAX);
  slider.step  = String(THRESH_STEP);
  slider.value = String(threshold);
  slider.disabled = !enabled;
  slider.setAttribute("aria-label", "Minimum walkway clearance threshold");
  slider.addEventListener("input", () => {
    setThreshold(parseFloat(slider.value));
    scheduleRender();
  });

  const sliderVal = document.createElement("span");
  sliderVal.className = "clr-slider-val";
  sliderVal.textContent = fmtLen(threshold) + " " + unitLabel();
  // Update the value display as the slider moves without waiting for render
  slider.addEventListener("input", () => {
    sliderVal.textContent = fmtLen(parseFloat(slider.value)) + " " + unitLabel();
  });

  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(slider);
  sliderRow.appendChild(sliderVal);
  ctrlsDiv.appendChild(sliderRow);

  // Density segmented control
  const densityRow = document.createElement("div");
  densityRow.className = "clr-density-row";
  densityRow.setAttribute("role", "group");
  densityRow.setAttribute("aria-label", "Annotation density");

  for (const [val, label] of [["all", "All gaps"], ["flagged", "Flagged only"]]) {
    const btn = document.createElement("button");
    btn.className = "clr-density-btn";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(density === val));
    btn.disabled = !enabled;
    btn.addEventListener("click", () => {
      setDensity(/** @type {import("./clearance.js").ClrDensity} */ (val));
      scheduleRender();
    });
    densityRow.appendChild(btn);
  }
  ctrlsDiv.appendChild(densityRow);
  _body.appendChild(ctrlsDiv);

  // ── Gap list ─────────────────────────────────────────────────────────────

  const listDiv = document.createElement("div");
  listDiv.className = "clr-list";

  if (!enabled) {
    const offMsg = document.createElement("div");
    offMsg.className = "clr-empty";
    offMsg.textContent = "Clearance overlay is off";
    listDiv.appendChild(offMsg);
  } else if (!sym) {
    const prompt = document.createElement("div");
    prompt.className = "clr-empty";
    prompt.textContent = "Select a piece of furniture to see its clearances.";
    listDiv.appendChild(prompt);
  } else if (sorted.length === 0) {
    const noneMsg = document.createElement("div");
    noneMsg.className = "clr-empty";
    noneMsg.textContent = "Nothing nearby to measure.";
    listDiv.appendChild(noneMsg);
  } else {
    for (const c of sorted) {
      const row = document.createElement("div");
      row.className = "clr-row";

      const dot = document.createElement("span");
      dot.className = "clr-dot clr-dot--" + c.status;
      dot.setAttribute("aria-hidden", "true");

      const rowLabel = document.createElement("span");
      rowLabel.className = "clr-row-label";
      rowLabel.textContent = "to " + c.label;

      const rowVal = document.createElement("span");
      rowVal.className = "clr-row-val";
      if (c.gap <= 0) {
        rowVal.textContent = "overlap";
        rowVal.style.color = "var(--clr-bad)";
      } else {
        rowVal.textContent = fmtLen(c.gap) + " " + unitLabel();
        rowVal.style.color = _statusColor(c.status);
      }

      row.appendChild(dot);
      row.appendChild(rowLabel);
      row.appendChild(rowVal);
      listDiv.appendChild(row);
    }
  }

  _body.appendChild(listDiv);

  // ── Verdict banner ────────────────────────────────────────────────────────

  if (enabled && sym) {
    const banner = document.createElement("div");
    banner.className = "clr-verdict";
    banner.setAttribute("aria-live", "polite");
    banner.setAttribute("aria-atomic", "true");

    if (sorted.length === 0) {
      banner.textContent = "Nothing nearby";
      banner.style.color = "var(--clr-ok)";
    } else {
      banner.textContent = _verdictText(worst);
      banner.style.color = _statusColor(worst);
    }
    _body.appendChild(banner);
  }

  // Update header status dot and on/off switch (they are in the panel element,
  // not the body — update them by ID if present)
  const statusDot = _panel.querySelector(".clr-header-dot");
  if (statusDot) {
    statusDot.className = "clr-header-dot clr-dot--" + (enabled && sym ? worst : "ok");
  }

  const enableSwitch = _panel.querySelector(".clr-enable-switch");
  if (enableSwitch) {
    enableSwitch.setAttribute("aria-pressed", String(enabled));
    enableSwitch.textContent = enabled ? "On" : "Off";
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

/** Map ClrStatus to CSS color variable. */
function _statusColor(status) {
  if (status === "bad")   return "var(--clr-bad)";
  if (status === "tight") return "var(--clr-tight)";
  return "var(--clr-ok)";
}

/** Verdict copy for the panel banner (mirrors render pill text).
 * Simplified: any bad status means gap<=0 (classify clamps), so the
 * "no walkway" branch was unreachable. Uses "overlap" for all bad cases. */
function _verdictText(worst) {
  if (worst === "bad")   return "Won't fit — overlap";
  if (worst === "tight") return `Tight — under ${fmtLen(threshold)} ${unitLabel()} walkway`;
  return "It fits — room to spare";
}
