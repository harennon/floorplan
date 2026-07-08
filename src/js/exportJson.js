/**
 * exportJson.js — JSON file download + import (file picker, validate, apply)
 *
 * Client-side only. No server interaction.
 */

import { buildPlan, validatePlan, applyPlan, serializePlan } from "./plan.js";
import { render } from "./surface.js";

/** Registered toast callback (set by actions.js). */
let _showToast = (_msg) => {};

/**
 * Inject the toast callback from actions.js so exportJson can show feedback.
 * @param {(msg:string)=>void} cb
 */
export function setToastCallback(cb) {
  _showToast = cb;
}

/**
 * Serialize current Plan and trigger a .json download.
 */
export function exportJson() {
  const plan = buildPlan();
  const json = serializePlan(plan);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "floorplan.json";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Open a file picker, read + validate the chosen file.
 * On success: apply + render + toast. On failure: reject toast, no state change.
 */
export function importJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);

  input.onchange = () => {
    const file = input.files?.[0];
    document.body.removeChild(input);
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const plan = validatePlan(parsed);
        if (!plan) {
          const msg = (parsed && typeof parsed === "object" && parsed.schema > 1)
            ? "This plan was made with a newer version of floorplan"
            : "Couldn't read this plan — the file may be corrupt or from a different app";
          _showToast(msg);
          return;
        }
        applyPlan(plan);
        render();
        _showToast("Plan imported");
      } catch {
        _showToast("Couldn't read this file");
      }
    };
    reader.onerror = () => {
      _showToast("Couldn't read this file");
    };
    reader.readAsText(file);
  };

  input.oncancel = () => {
    document.body.removeChild(input);
  };

  document.body.appendChild(input);
  input.click();
}
