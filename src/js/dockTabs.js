/**
 * dockTabs.js — category tab controller for the symbol dock.
 *
 * Session-only UI state: which tab is active lives in the DOM (aria-selected +
 * hidden attribute on rows). No persistence; reload resets to the first tab.
 *
 * ARIA pattern: role="tablist" / role="tab" / role="tabpanel" with roving
 * tabindex, aria-selected, aria-controls / aria-labelledby wiring.
 */

/**
 * Wire the dock category tabs to show/hide item rows. Session-only; persists nothing.
 * Activates the first tab in DOM order on init.
 * @param {HTMLElement} dock  the #symbol-dock element
 */
export function initDockTabs(dock) {
  const tablist = dock.querySelector("[role='tablist']");
  if (!tablist) return;

  // Event delegation — one listener on the tablist covers all tabs.
  tablist.addEventListener("click", (e) => {
    const tab = e.target.closest("[role='tab']");
    if (!tab) return;
    const category = tab.dataset.category;
    if (category) setActiveCategory(dock, category);
  });

  // Keyboard: roving tabindex — Left/Right arrows move selection; Enter/Space activate.
  tablist.addEventListener("keydown", (e) => {
    const tabs = Array.from(tablist.querySelectorAll("[role='tab']"));
    const focused = document.activeElement;
    const idx = tabs.indexOf(focused);
    if (idx === -1) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = tabs[(idx + 1) % tabs.length];
      next.focus();
      setActiveCategory(dock, next.dataset.category);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      prev.focus();
      setActiveCategory(dock, prev.dataset.category);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActiveCategory(dock, focused.dataset.category);
    }
  });

  // Activate the first tab on load.
  const firstTab = tablist.querySelector("[role='tab']");
  if (firstTab && firstTab.dataset.category) {
    setActiveCategory(dock, firstTab.dataset.category);
  }
}

/**
 * Activate a category tab: mark its tab selected, show its row, hide the others.
 * Exported for tests. No-op if the category has no tab/row.
 * @param {HTMLElement} dock
 * @param {string} category
 */
export function setActiveCategory(dock, category) {
  const tabs = Array.from(dock.querySelectorAll("[role='tab'][data-category]"));
  const rows = Array.from(dock.querySelectorAll("[role='tabpanel'][data-category]"));

  for (const tab of tabs) {
    const isActive = tab.dataset.category === category;
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    tab.tabIndex = isActive ? 0 : -1;
  }

  for (const row of rows) {
    if (row.dataset.category === category) {
      row.removeAttribute("hidden");
    } else {
      row.setAttribute("hidden", "");
    }
  }
}
