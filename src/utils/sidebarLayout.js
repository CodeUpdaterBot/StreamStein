// ── Sidebar Menu Layout Utilities ─────────────────────────────────────────────
// Shared between SettingsPage (editing) and Sidebar (reading).

import { storage } from "./storage";

export const SIDEBAR_NAV_ITEMS = [
  { id: "home", label: "Home", zone: "main" },
  { id: "history", label: "Library & History", zone: "main" },
  { id: "downloads", label: "Downloads", zone: "main" },
  { id: "youtube", label: "YouTube", zone: "main" },
  { id: "help", label: "Help & Shortcuts", zone: "bottom" },
  { id: "settings", label: "Settings", zone: "bottom" },
  { id: "quit", label: "Quit App", zone: "bottom" },
];

const DEFAULT_ORDER = SIDEBAR_NAV_ITEMS.map((item) => item.id);
const DEFAULT_VISIBLE = Object.fromEntries(
  SIDEBAR_NAV_ITEMS.map((item) => [item.id, true]),
);

const MAIN_IDS = new Set(
  SIDEBAR_NAV_ITEMS.filter((item) => item.zone === "main").map((item) => item.id),
);
const BOTTOM_IDS = new Set(
  SIDEBAR_NAV_ITEMS.filter((item) => item.zone === "bottom").map(
    (item) => item.id,
  ),
);

export const SIDEBAR_LAYOUT_CHANGED = "streamstein:sidebar-layout-changed";

export function loadSidebarLayout() {
  const savedOrder = storage.get("sidebarNavOrder");
  const savedVisible = storage.get("sidebarNavVisible");
  const knownIds = new Set(SIDEBAR_NAV_ITEMS.map((item) => item.id));

  const order = savedOrder
    ? [
        ...savedOrder.filter((id) => knownIds.has(id)),
        ...DEFAULT_ORDER.filter((id) => !savedOrder.includes(id)),
      ]
    : DEFAULT_ORDER;

  const visible = savedVisible
    ? { ...DEFAULT_VISIBLE, ...savedVisible }
    : DEFAULT_VISIBLE;

  return { order, visible };
}

export function saveSidebarLayout(order, visible) {
  storage.set("sidebarNavOrder", order);
  storage.set("sidebarNavVisible", visible);
  window.dispatchEvent(new CustomEvent(SIDEBAR_LAYOUT_CHANGED));
}

/** Split saved order into main nav + bottom nav while preserving relative order. */
export function partitionSidebarNav(order, visible) {
  const main = [];
  const bottom = [];
  for (const id of order) {
    if (!visible[id]) continue;
    if (MAIN_IDS.has(id)) main.push(id);
    else if (BOTTOM_IDS.has(id)) bottom.push(id);
  }
  return { main, bottom };
}

export const SIDEBAR_ITEM_LABELS = Object.fromEntries(
  SIDEBAR_NAV_ITEMS.map((item) => [item.id, item.label]),
);
