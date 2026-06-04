// ── Accent colour & app theme presets ────────────────────────────────────────
// Kept in a separate file so both App.jsx and SettingsPage.jsx can import
// without creating a circular dependency.

export const ACCENT_PRESETS = [
  { id: "red",    label: "Red",    color: "#e50914", color2: "#ff1a24", dim: "rgba(229,9,20,0.15)",    glow: "0 0 30px rgba(229,9,20,0.3)" },
  { id: "blue",   label: "Blue",   color: "#2563eb", color2: "#3b82f6", dim: "rgba(37,99,235,0.15)",   glow: "0 0 30px rgba(37,99,235,0.3)" },
  { id: "purple", label: "Purple", color: "#7c3aed", color2: "#8b5cf6", dim: "rgba(124,58,237,0.15)",  glow: "0 0 30px rgba(124,58,237,0.3)" },
  { id: "green",  label: "Green",  color: "#059669", color2: "#10b981", dim: "rgba(5,150,105,0.15)",   glow: "0 0 30px rgba(5,150,105,0.3)" },
  { id: "orange", label: "Orange", color: "#d97706", color2: "#f59e0b", dim: "rgba(217,119,6,0.15)",   glow: "0 0 30px rgba(217,119,6,0.3)" },
  { id: "pink",   label: "Pink",   color: "#db2777", color2: "#ec4899", dim: "rgba(219,39,119,0.15)",  glow: "0 0 30px rgba(219,39,119,0.3)" },
];

/** Shared elevation tokens — same layout structure on every theme. */
const SHADOWS_ELEVATED_DARK = {
  shadowCard:
    "0 2px 6px rgba(0, 0, 0, 0.28), 0 1px 2px rgba(0, 0, 0, 0.2)",
  shadowHeader:
    "0 1px 0 rgba(255, 255, 255, 0.05), 0 4px 12px rgba(0, 0, 0, 0.25)",
  shadowInset: "inset 0 1px 2px rgba(0, 0, 0, 0.35)",
  shadowSidebar: "2px 0 12px rgba(0, 0, 0, 0.2)",
};

const SHADOWS_ELEVATED_LIGHT = {
  shadowCard:
    "0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 14px rgba(15, 23, 42, 0.08)",
  shadowHeader:
    "0 1px 0 rgba(15, 23, 42, 0.08), 0 2px 10px rgba(15, 23, 42, 0.05)",
  shadowInset: "inset 0 1px 2px rgba(15, 23, 42, 0.08)",
  shadowSidebar: "2px 0 12px rgba(15, 23, 42, 0.08)",
};

/** Title bar stays dark on light content themes so STREAMSTEIN stays readable. */
const TITLEBAR_DARK = {
  bg: "#0a0a0a",
  border: "rgba(255, 255, 255, 0.06)",
  fg: "rgba(255, 255, 255, 0.35)",
  btn: "rgba(255, 255, 255, 0.55)",
  btnHover: "rgba(255, 255, 255, 0.08)",
};

/** Order: dark → gray (mid) → tinted light → bright light. */
export const THEME_PRESETS = [
  {
    id: "midnight",
    label: "Midnight",
    description: "Classic dark — near-black background with charcoal panels.",
    swatch: { sidebar: "#111111", bg: "#0a0a0a" },
    isLight: false,
    vars: {
      bg: "#0a0a0a",
      surface: "#111111",
      surface2: "#1a1a1a",
      surface3: "#222222",
      border: "#2a2a2a",
      text: "#f0f0f0",
      text2: "#c0c0c0",
      text3: "#909090",
      gold: "#c8a84b",
      sidebarBg: "#111111",
      sidebarFg: "#909090",
      sidebarBorder: "#2a2a2a",
      hover: "rgba(255, 255, 255, 0.08)",
      hoverStrong: "rgba(255, 255, 255, 0.12)",
      hoverSubtle: "rgba(255, 255, 255, 0.05)",
      hoverMedium: "rgba(255, 255, 255, 0.10)",
      overlay: "rgba(0, 0, 0, 0.75)",
      shadowLg: "0 24px 64px rgba(0, 0, 0, 0.6)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(0, 0, 0, 0.45)",
      inputBorder: "rgba(255, 255, 255, 0.15)",
      surfaceInset: "#070707",
      ...SHADOWS_ELEVATED_DARK,
    },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm charcoal dark with subtle brown undertones.",
    swatch: { sidebar: "#1a1614", bg: "#12100e" },
    isLight: false,
    vars: {
      bg: "#12100e",
      surface: "#1a1614",
      surface2: "#242018",
      surface3: "#2e2820",
      border: "#3d3530",
      text: "#f2ebe4",
      text2: "#c8bdb2",
      text3: "#968a80",
      gold: "#d4a84b",
      sidebarBg: "#1a1614",
      sidebarFg: "#968a80",
      sidebarBorder: "#3d3530",
      hover: "rgba(255, 240, 220, 0.07)",
      hoverStrong: "rgba(255, 240, 220, 0.11)",
      hoverSubtle: "rgba(255, 240, 220, 0.04)",
      hoverMedium: "rgba(255, 240, 220, 0.09)",
      overlay: "rgba(0, 0, 0, 0.78)",
      shadowLg: "0 24px 64px rgba(0, 0, 0, 0.65)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(0, 0, 0, 0.48)",
      inputBorder: "rgba(255, 240, 220, 0.14)",
      surfaceInset: "#0e0c0a",
      ...SHADOWS_ELEVATED_DARK,
    },
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool blue-gray dark — modern and easy on the eyes.",
    swatch: { sidebar: "#1a1f2e", bg: "#0f1219" },
    isLight: false,
    vars: {
      bg: "#0f1219",
      surface: "#1a1f2e",
      surface2: "#232a3d",
      surface3: "#2c354c",
      border: "#3a4560",
      text: "#e8ecf4",
      text2: "#b8c0d4",
      text3: "#8490a8",
      gold: "#c8a84b",
      sidebarBg: "#1a1f2e",
      sidebarFg: "#8490a8",
      sidebarBorder: "#3a4560",
      hover: "rgba(200, 210, 240, 0.08)",
      hoverStrong: "rgba(200, 210, 240, 0.12)",
      hoverSubtle: "rgba(200, 210, 240, 0.05)",
      hoverMedium: "rgba(200, 210, 240, 0.10)",
      overlay: "rgba(0, 0, 0, 0.75)",
      shadowLg: "0 24px 64px rgba(0, 0, 0, 0.6)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(0, 0, 0, 0.45)",
      inputBorder: "rgba(200, 210, 240, 0.14)",
      surfaceInset: "#0c0e14",
      ...SHADOWS_ELEVATED_DARK,
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep navy sidebar with cool blue-gray content tones.",
    swatch: { sidebar: "#0f2744", bg: "#e8eef4" },
    isLight: true,
    vars: {
      bg: "#e8eef4",
      surface: "#dce4ed",
      surface2: "#cfd9e5",
      surface3: "#c2cedc",
      border: "#b0becd",
      text: "#0f1f33",
      text2: "#2a3f5c",
      text3: "#4a6080",
      gold: "#8a7340",
      sidebarBg: "#0f2744",
      sidebarFg: "#8fa8c4",
      sidebarBorder: "rgba(255, 255, 255, 0.1)",
      hover: "rgba(15, 39, 68, 0.08)",
      hoverStrong: "rgba(15, 39, 68, 0.12)",
      hoverSubtle: "rgba(15, 39, 68, 0.05)",
      hoverMedium: "rgba(15, 39, 68, 0.10)",
      overlay: "rgba(8, 18, 32, 0.55)",
      shadowLg: "0 24px 48px rgba(8, 18, 32, 0.22)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(8, 18, 32, 0.42)",
      inputBorder: "rgba(15, 39, 68, 0.18)",
      surfaceInset: "#d4dce8",
      ...SHADOWS_ELEVATED_LIGHT,
    },
  },
  {
    id: "rose",
    label: "Rose",
    description: "Light blush-rose sidebar with a warm ivory content area.",
    swatch: { sidebar: "#e8b4b9", bg: "#faf5f0" },
    isLight: true,
    vars: {
      bg: "#faf5f0",
      surface: "#f5ebe8",
      surface2: "#ede0dc",
      surface3: "#e4d4cf",
      border: "#d4c4be",
      text: "#2a1f1f",
      text2: "#4a3838",
      text3: "#6e5858",
      gold: "#9a7340",
      sidebarBg: "#e8b4b9",
      sidebarFg: "#8a5a5f",
      sidebarBorder: "rgba(0, 0, 0, 0.08)",
      hover: "rgba(138, 90, 95, 0.10)",
      hoverStrong: "rgba(138, 90, 95, 0.14)",
      hoverSubtle: "rgba(138, 90, 95, 0.06)",
      hoverMedium: "rgba(138, 90, 95, 0.12)",
      overlay: "rgba(42, 31, 31, 0.5)",
      shadowLg: "0 24px 48px rgba(42, 31, 31, 0.18)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(42, 31, 31, 0.38)",
      inputBorder: "rgba(138, 90, 95, 0.18)",
      surfaceInset: "#ebe0da",
      ...SHADOWS_ELEVATED_LIGHT,
    },
  },
  {
    id: "gray",
    label: "Gray",
    description: "Layered mid-tone grays — recessed inputs, elevated cards, clear depth.",
    swatch: { sidebar: "#24242c", bg: "#16161a" },
    isLight: false,
    vars: {
      /* Layer 0: canvas (darkest) */
      bg: "#16161a",
      /* Layer 1: sidebar, top bars */
      surface: "#24242c",
      /* Layer 2: cards, panels, raised controls */
      surface2: "#30303a",
      /* Layer 3: menus, tooltips, hover peaks */
      surface3: "#40404c",
      border: "#565664",
      text: "#f0f0f4",
      text2: "#c4c4ce",
      text3: "#90909c",
      gold: "#c8a84b",
      sidebarBg: "#1e1e24",
      sidebarFg: "#90909c",
      sidebarBorder: "#484854",
      surfaceInset: "#121216",
      hover: "rgba(255, 255, 255, 0.07)",
      hoverStrong: "rgba(255, 255, 255, 0.11)",
      hoverSubtle: "rgba(255, 255, 255, 0.04)",
      hoverMedium: "rgba(255, 255, 255, 0.09)",
      overlay: "rgba(0, 0, 0, 0.68)",
      shadowLg: "0 24px 56px rgba(0, 0, 0, 0.5)",
      ...SHADOWS_ELEVATED_DARK,
      shadowCard:
        "0 2px 6px rgba(0, 0, 0, 0.32), 0 8px 24px rgba(0, 0, 0, 0.22)",
      shadowHeader:
        "0 1px 0 rgba(255, 255, 255, 0.06), 0 4px 16px rgba(0, 0, 0, 0.28)",
      onAccent: "#ffffff",
      heroOverlay: "rgba(0, 0, 0, 0.42)",
      inputBorder: "rgba(255, 255, 255, 0.14)",
    },
  },
  {
    id: "light",
    label: "Light",
    description: "Soft gray canvas with white elevated surfaces and subtle shadows.",
    swatch: { sidebar: "#ffffff", bg: "#e4e5ec" },
    isLight: true,
    vars: {
      /* Layer 0: content well (cool gray) */
      bg: "#e4e5ec",
      /* Layer 1: sidebar, header strip, modals */
      surface: "#ffffff",
      /* Layer 2: cards & panels (white, lifted by shadow) */
      surface2: "#ffffff",
      /* Layer 3: secondary / hover peaks */
      surface3: "#f4f5f9",
      border: "#c8cad4",
      text: "#18181b",
      text2: "#3f3f46",
      text3: "#71717a",
      gold: "#a67c00",
      sidebarBg: "#ffffff",
      sidebarFg: "#71717a",
      sidebarBorder: "#d8dae2",
      surfaceInset: "#d8dae4",
      hover: "rgba(0, 0, 0, 0.05)",
      hoverStrong: "rgba(0, 0, 0, 0.09)",
      hoverSubtle: "rgba(0, 0, 0, 0.03)",
      hoverMedium: "rgba(0, 0, 0, 0.07)",
      overlay: "rgba(0, 0, 0, 0.45)",
      shadowLg: "0 24px 48px rgba(15, 23, 42, 0.14)",
      ...SHADOWS_ELEVATED_LIGHT,
      onAccent: "#ffffff",
      heroOverlay: "rgba(0, 0, 0, 0.35)",
      inputBorder: "rgba(15, 23, 42, 0.12)",
    },
  },
];

const THEME_LEGACY_IDS = { forest: "rose" };

const THEME_VAR_MAP = {
  "--bg": "bg",
  "--surface": "surface",
  "--surface2": "surface2",
  "--surface3": "surface3",
  "--border": "border",
  "--text": "text",
  "--text2": "text2",
  "--text3": "text3",
  "--gold": "gold",
  "--sidebar-bg": "sidebarBg",
  "--sidebar-fg": "sidebarFg",
  "--sidebar-border": "sidebarBorder",
  "--hover": "hover",
  "--hover-strong": "hoverStrong",
  "--hover-subtle": "hoverSubtle",
  "--hover-medium": "hoverMedium",
  "--overlay": "overlay",
  "--shadow-lg": "shadowLg",
  "--on-accent": "onAccent",
  "--hero-overlay": "heroOverlay",
  "--input-border": "inputBorder",
  "--surface-inset": "surfaceInset",
  "--shadow-card": "shadowCard",
  "--shadow-header": "shadowHeader",
  "--shadow-inset": "shadowInset",
  "--shadow-sidebar": "shadowSidebar",
};

export function resolveThemeId(themeId) {
  if (!themeId) return "midnight";
  return THEME_LEGACY_IDS[themeId] ?? themeId;
}

export function applyAccentColor(presetId) {
  const preset = ACCENT_PRESETS.find((p) => p.id === presetId) ?? ACCENT_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty("--red",      preset.color);
  root.style.setProperty("--red2",     preset.color2);
  root.style.setProperty("--red-dim",  preset.dim);
  root.style.setProperty("--red-glow", preset.glow);
}

export function applyTheme(themeId) {
  const id = resolveThemeId(themeId);
  const preset = THEME_PRESETS.find((t) => t.id === id) ?? THEME_PRESETS[0];
  const root = document.documentElement;
  const v = preset.vars;

  for (const [cssVar, key] of Object.entries(THEME_VAR_MAP)) {
    if (v[key] !== undefined) root.style.setProperty(cssVar, v[key]);
  }

  const titlebar = preset.isLight ? TITLEBAR_DARK : {
    bg: v.bg,
    border: "rgba(255, 255, 255, 0.06)",
    fg: "rgba(255, 255, 255, 0.35)",
    btn: "rgba(255, 255, 255, 0.55)",
    btnHover: "rgba(255, 255, 255, 0.08)",
  };

  root.style.setProperty("--titlebar-bg", titlebar.bg);
  root.style.setProperty("--titlebar-border", titlebar.border);
  root.style.setProperty("--titlebar-fg", titlebar.fg);
  root.style.setProperty("--titlebar-btn", titlebar.btn);
  root.style.setProperty("--titlebar-btn-hover", titlebar.btnHover);

  root.dataset.theme = preset.id;
  root.dataset.themeLight = preset.isLight ? "true" : "false";
  document.body.classList.toggle("theme-light", preset.isLight);
}

/** Apply accent + theme together (e.g. on app startup). */
export function applyAppearance({ accentId, themeId } = {}) {
  if (themeId) applyTheme(themeId);
  if (accentId) applyAccentColor(accentId);
}
