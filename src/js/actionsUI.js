/**
 * actionsUI.js — actions cluster chrome (LLD 15)
 *
 * Owns:
 *  - Share button + popover (Copy link)
 *  - Export ▾ menu (PNG / SVG / JSON)
 *  - Overflow ⋯ menu (Import JSON… / Reset plan)
 *  - Save-status pill
 *  - Restore/conflict banner
 *
 * boot(W, H) performs the restore-vs-share decision described in the LLD.
 */

import { serialize, deserialize, loadFromStorage, hasStoredPlan, saveNow, onStatusChange } from "./persist.js";
import { encode, decode, readHash, buildShareURL, clearHash, LARGE_LINK_CHARS } from "./share.js";
import { exportJSON, exportSVG, exportPNG, importJSON, planBBox } from "./exporter.js";
import { clearAll as clearWalls } from "./walls.js";
import { clearAll as clearSymbols } from "./symbols.js";
import { fitView, resetView } from "./view.js";
import { render } from "./surface.js";

// ── DOM refs (set via init) ───────────────────────────────────────────────────

let _actionsCluster = null;
let _btnShare       = null;
let _btnExport      = null;
let _btnOverflow    = null;
let _sharePopover   = null;
let _exportMenu     = null;
let _overflowMenu   = null;
let _banner         = null;
let _statusPill     = null;
let _fileInput      = null;

// ── Internal state ────────────────────────────────────────────────────────────

let _W = 0;
let _H = 0;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM references and wire all event listeners.
 * @param {{ actionsCluster, btnShare, btnExport, btnOverflow,
 *           sharePopover, exportMenu, overflowMenu, banner, statusPill, fileInput }} refs
 */
export function init(refs) {
  _actionsCluster = refs.actionsCluster;
  _btnShare       = refs.btnShare;
  _btnExport      = refs.btnExport;
  _btnOverflow    = refs.btnOverflow;
  _sharePopover   = refs.sharePopover;
  _exportMenu     = refs.exportMenu;
  _overflowMenu   = refs.overflowMenu;
  _banner         = refs.banner;
  _statusPill     = refs.statusPill;
  _fileInput      = refs.fileInput;

  // Share button
  _btnShare?.addEventListener("click", _onShareClick);

  // Export menu toggle
  _btnExport?.addEventListener("click", (e) => {
    e.stopPropagation();
    _closeAllMenus(_exportMenu);
    _toggleMenu(_exportMenu, _btnExport);
  });

  // Export menu items
  _exportMenu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    _closeAllMenus();
    const action = item.dataset.action;
    if (action === "export-png")  exportPNG().catch(console.error);
    if (action === "export-svg")  exportSVG();
    if (action === "export-json") exportJSON();
  });

  // Overflow menu toggle
  _btnOverflow?.addEventListener("click", (e) => {
    e.stopPropagation();
    _closeAllMenus(_overflowMenu);
    _toggleMenu(_overflowMenu, _btnOverflow);
  });

  // Overflow menu items
  _overflowMenu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    _closeAllMenus();
    if (item.dataset.action === "import-json") _fileInput?.click();
    if (item.dataset.action === "reset-plan")  _onResetClick();
  });

  // File input (import JSON)
  _fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    _fileInput.value = "";  // allow re-selection of same file
    const doc = await importJSON(file);
    if (!doc) {
      _showToast("Not a valid floorplan file");
      return;
    }
    deserialize(doc);
    const bbox = planBBox();
    fitView(_W, _H, bbox);
    render();
    saveNow();
  });

  // Share popover close on copy
  _sharePopover?.querySelector("[data-action='copy-link']")?.addEventListener("click", _onCopyLink);

  // Close popover/menus on outside click
  document.addEventListener("click", (e) => {
    if (!_sharePopover?.contains(e.target) && e.target !== _btnShare) {
      _closePopover(_sharePopover);
    }
    if (!_exportMenu?.contains(e.target) && e.target !== _btnExport) {
      _closeMenu(_exportMenu, _btnExport);
    }
    if (!_overflowMenu?.contains(e.target) && e.target !== _btnOverflow) {
      _closeMenu(_overflowMenu, _btnOverflow);
    }
  });

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") _closeAllMenus();
  });

  // Save status pill
  onStatusChange(_updateStatusPill);
  _updateStatusPill("saved");
}

// ── Boot: restore-vs-share decision ──────────────────────────────────────────

/**
 * Run once at startup before first render. Decides which plan to load.
 * @param {number} W  viewport width
 * @param {number} H  viewport height
 */
export async function boot(W, H) {
  _W = W;
  _H = H;

  const hashPayload = readHash();
  const stored      = hasStoredPlan();

  if (hashPayload) {
    const shared = await decode(hashPayload);
    if (!shared) {
      _showToast("Couldn't open that link");
      _fallbackToStored(stored);
      return;
    }
    if (!stored) {
      // No conflict — load shared directly
      deserialize(shared);
      const bbox = planBBox();
      fitView(W, H, bbox);
      clearHash();
      _showAutoDismissBanner("Opened shared plan");
    } else {
      // Conflict: ask the user
      _showConflictBanner(shared);
    }
  } else if (stored) {
    const doc = loadFromStorage();
    if (doc) {
      deserialize(doc);
      const bbox = planBBox();
      fitView(W, H, bbox);
      _showAutoDismissBanner("Restored your last plan");
    }
  }
  // else: empty plan — resetView already called by main.js before boot
}

function _fallbackToStored(stored) {
  if (stored) {
    const doc = loadFromStorage();
    if (doc) {
      deserialize(doc);
      const bbox = planBBox();
      fitView(_W, _H, bbox);
    }
  }
  clearHash();
}

// ── Share ─────────────────────────────────────────────────────────────────────

async function _onShareClick(e) {
  e.stopPropagation();
  _closeAllMenus(_sharePopover);

  const doc = serialize();
  const payload = await encode(doc);
  const url = buildShareURL(payload);

  // Update location hash (so the URL bar reflects the share link)
  history.replaceState(null, "", "#plan=" + payload);

  // Populate popover link field
  const linkField = _sharePopover?.querySelector("[data-role='share-link']");
  if (linkField) linkField.value = url;

  // Large-link warning
  const warn = _sharePopover?.querySelector("[data-role='large-link-warn']");
  if (warn) {
    warn.hidden = payload.length <= LARGE_LINK_CHARS;
  }

  _openPopover(_sharePopover, _btnShare);
}

async function _onCopyLink(e) {
  const linkField = _sharePopover?.querySelector("[data-role='share-link']");
  const url = linkField?.value || location.href;
  const btn = e.currentTarget;

  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Fallback: select the field
    linkField?.select();
    _showToast("Press Ctrl+C / Cmd+C to copy");
    return;
  }

  const orig = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function _onResetClick() {
  const confirm = _showConfirmDialog(
    "Replace the current plan? This can't be undone.",
    "Reset",
    () => {
      clearWalls();
      clearSymbols();
      saveNow();
      resetView(_W, _H);
      render();
    }
  );
}

// ── Banners ───────────────────────────────────────────────────────────────────

function _showAutoDismissBanner(message) {
  if (!_banner) return;
  _banner.setAttribute("role", "status");
  _banner.setAttribute("aria-live", "polite");
  _banner.innerHTML = "";

  const msg = document.createElement("span");
  msg.textContent = message;
  _banner.appendChild(msg);

  _banner.hidden = false;
  _banner.classList.add("banner--visible");

  setTimeout(() => {
    _banner.classList.remove("banner--visible");
    setTimeout(() => { _banner.hidden = true; }, 300);
  }, 3000);
}

function _showConflictBanner(sharedDoc) {
  if (!_banner) return;
  _banner.setAttribute("role", "alertdialog");
  _banner.removeAttribute("aria-live");
  _banner.innerHTML = "";

  const msg = document.createElement("span");
  msg.textContent = "This link has a shared plan.";
  _banner.appendChild(msg);

  const btnOpen = document.createElement("button");
  btnOpen.className = "banner-btn banner-btn--primary";
  btnOpen.textContent = "Open shared";
  btnOpen.addEventListener("click", () => {
    deserialize(sharedDoc);
    const bbox = planBBox();
    fitView(_W, _H, bbox);
    clearHash();
    render();
    saveNow();
    _banner.hidden = true;
    _banner.innerHTML = "";
  });

  const btnKeep = document.createElement("button");
  btnKeep.className = "banner-btn";
  btnKeep.textContent = "Keep mine";
  btnKeep.addEventListener("click", () => {
    clearHash();
    const doc = loadFromStorage();
    if (doc) {
      deserialize(doc);
      const bbox = planBBox();
      fitView(_W, _H, bbox);
      render();
    }
    _banner.hidden = true;
    _banner.innerHTML = "";
  });

  _banner.appendChild(btnOpen);
  _banner.appendChild(btnKeep);
  _banner.hidden = false;
  _banner.classList.add("banner--visible");

  // Focus the first action button for accessibility
  setTimeout(() => btnOpen.focus(), 50);
}

// ── Save-status pill ──────────────────────────────────────────────────────────

function _updateStatusPill(status) {
  if (!_statusPill) return;
  _statusPill.setAttribute("data-status", status);
  if (status === "saved") {
    _statusPill.textContent = "Saved";
    _statusPill.hidden = false;
    // Fade out after 2s
    clearTimeout(_statusPill._fadeTimer);
    _statusPill._fadeTimer = setTimeout(() => {
      _statusPill.classList.add("pill--faded");
    }, 2000);
  } else if (status === "saving") {
    _statusPill.textContent = "Saving…";
    _statusPill.classList.remove("pill--faded");
    _statusPill.hidden = false;
  } else if (status === "error" || status === "unsaved") {
    _statusPill.textContent = "Not saved — export to keep";
    _statusPill.classList.remove("pill--faded");
    _statusPill.hidden = false;
  }
}

// ── Menu helpers ──────────────────────────────────────────────────────────────

function _toggleMenu(menu, btn) {
  if (!menu) return;
  const isOpen = !menu.hidden;
  if (isOpen) {
    _closeMenu(menu, btn);
  } else {
    menu.hidden = false;
    btn?.setAttribute("aria-expanded", "true");
    // Position below the button
    if (btn && menu.style) {
      const r = btn.getBoundingClientRect();
      menu.style.top  = (r.bottom + 4) + "px";
      menu.style.right = (window.innerWidth - r.right) + "px";
    }
  }
}

function _closeMenu(menu, btn) {
  if (!menu) return;
  menu.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
}

function _openPopover(popover, btn) {
  if (!popover) return;
  popover.hidden = false;
  btn?.setAttribute("aria-expanded", "true");
  if (btn && popover.style) {
    const r = btn.getBoundingClientRect();
    popover.style.top  = (r.bottom + 4) + "px";
    popover.style.right = (window.innerWidth - r.right) + "px";
  }
}

function _closePopover(popover) {
  if (!popover) return;
  popover.hidden = true;
  _btnShare?.setAttribute("aria-expanded", "false");
}

function _closeAllMenus(except) {
  if (_sharePopover   !== except) _closePopover(_sharePopover);
  if (_exportMenu     !== except) _closeMenu(_exportMenu,   _btnExport);
  if (_overflowMenu   !== except) _closeMenu(_overflowMenu, _btnOverflow);
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function _showConfirmDialog(message, confirmLabel, onConfirm) {
  // Simple inline confirm using the native dialog if available, else window.confirm
  if (typeof HTMLDialogElement !== "undefined") {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML = `
      <p class="confirm-msg"></p>
      <div class="confirm-actions">
        <button class="confirm-cancel">Cancel</button>
        <button class="confirm-ok"></button>
      </div>`;
    dialog.querySelector(".confirm-msg").textContent = message;
    dialog.querySelector(".confirm-ok").textContent = confirmLabel;
    document.body.appendChild(dialog);

    dialog.querySelector(".confirm-cancel").addEventListener("click", () => {
      dialog.close();
      document.body.removeChild(dialog);
    });
    dialog.querySelector(".confirm-ok").addEventListener("click", () => {
      dialog.close();
      document.body.removeChild(dialog);
      onConfirm();
    });
    dialog.showModal();
  } else {
    if (window.confirm(message)) onConfirm();
  }
}

// ── Toast helper ──────────────────────────────────────────────────────────────

function _showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  toast.style.cssText = [
    "position:fixed", "bottom:5rem", "left:50%", "transform:translateX(-50%)",
    "background:var(--panel,rgba(20,20,15,0.85))", "border:1px solid var(--hairline,rgba(201,168,76,0.18))",
    "color:var(--ink,#ece7d6)", "font-family:var(--font-mono,monospace)", "font-size:0.75rem",
    "padding:0.5rem 1.1rem", "border-radius:6px", "z-index:100",
    "backdrop-filter:blur(8px)", "pointer-events:none",
  ].join(";");
  document.body.appendChild(toast);
  setTimeout(() => {
    if (document.body.contains(toast)) document.body.removeChild(toast);
  }, 3000);
}
