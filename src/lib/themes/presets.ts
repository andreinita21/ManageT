/**
 * Theme presets — one definition supplies both the UI palette (CSS
 * variables applied to documentElement at runtime by ThemeProvider)
 * and the xterm Terminal theme. "Linked" mode means one selection
 * drives both surfaces; we keep them in one struct so they can't drift.
 *
 * To add a new preset: add an entry to PRESETS with a unique key,
 * fill in both `ui` and `terminal` palettes from the source theme's
 * spec, and add the key to the union type ThemeKey. The Appearance
 * settings page picks them up automatically from PRESETS_BY_KEY.
 */
import type { MosaicTheme } from "@/lib/mosaic-themes/presets";

export interface UiPalette {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  accent: string;
  accentBright: string;
  accentDim: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderHover: string;
  // Semantic status colours. Each preset pulls these from its own
  // terminal palette so e.g. "online" picks up Catppuccin's green
  // instead of Tailwind's emerald. Custom themes can override every
  // value via the Appearance settings.
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeColors {
  ui: UiPalette;
  terminal: TerminalPalette;
}

export interface ThemePreset {
  key: string;
  label: string;
  group: string;
  isDark: boolean;
  colors: ThemeColors;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a UI palette from a terminal palette and an accent color.
 * Most presets only publish a foreground/background + ANSI 16, so we
 * synthesise UI tones by lightening/darkening the background. This
 * keeps the panel hierarchy readable without per-theme bespoke work.
 */
function uiFromTerminal(
  t: TerminalPalette,
  opts: { accent: string; accentBright: string; accentDim: string; isDark: boolean }
): UiPalette {
  const lift = (color: string, amount: number): string =>
    opts.isDark ? lighten(color, amount) : darken(color, amount);
  return {
    bg: t.background,
    bgSecondary: lift(t.background, 0.04),
    bgTertiary: lift(t.background, 0.08),
    bgHover: lift(t.background, 0.12),
    bgActive: lift(t.background, 0.18),
    accent: opts.accent,
    accentBright: opts.accentBright,
    accentDim: opts.accentDim,
    text: t.foreground,
    textSecondary: opts.isDark
      ? darken(t.foreground, 0.2)
      : lighten(t.foreground, 0.2),
    textTertiary: opts.isDark
      ? darken(t.foreground, 0.4)
      : lighten(t.foreground, 0.4),
    border: lift(t.background, 0.1),
    borderHover: lift(t.background, 0.2),
    // Semantic colours derived from the terminal palette — bright
    // variants tend to read better on dark backgrounds; on light
    // themes we drop to the non-bright tones for legibility.
    success: opts.isDark ? t.brightGreen : t.green,
    warning: opts.isDark ? t.brightYellow : t.yellow,
    danger: opts.isDark ? t.brightRed : t.red,
    info: opts.isDark ? t.brightBlue : t.blue,
  };
}

/**
 * Fill in any missing semantic UI tokens on a legacy palette by
 * deriving them from the paired terminal palette. Keeps backward
 * compatibility for `customTheme` rows persisted before we added the
 * status tokens.
 */
function withSemanticDefaults(colors: ThemeColors): ThemeColors {
  const ui = colors.ui as Partial<UiPalette> & UiPalette;
  if (ui.success && ui.warning && ui.danger && ui.info) return colors;
  const t = colors.terminal;
  return {
    terminal: colors.terminal,
    ui: {
      ...ui,
      success: ui.success ?? t.brightGreen ?? t.green,
      warning: ui.warning ?? t.brightYellow ?? t.yellow,
      danger: ui.danger ?? t.brightRed ?? t.red,
      info: ui.info ?? t.brightBlue ?? t.blue,
    },
  };
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h,
    16
  );
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((c) => clamp(c).toString(16).padStart(2, "0"))
      .join("")
  );
}

function lighten(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

function darken(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * (1 - t), g * (1 - t), b * (1 - t));
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

// The shipped purple theme that the app launched with, kept as the
// default so existing users see no visual change until they pick
// something different.
const MG_DEFAULT_TERMINAL: TerminalPalette = {
  background: "#0d0d14",
  foreground: "#e4e4e7",
  cursor: "#a855f7",
  cursorAccent: "#0d0d14",
  selectionBackground: "rgba(168, 85, 247, 0.3)",
  black: "#27272a",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

const MG_DEFAULT_UI: UiPalette = {
  bg: "#0a0a0f",
  bgSecondary: "#12121a",
  bgTertiary: "#1a1a2e",
  bgHover: "#232340",
  bgActive: "#2a2a4a",
  accent: "#a855f7",
  accentBright: "#c084fc",
  accentDim: "#7c3aed",
  text: "#e4e4e7",
  textSecondary: "#a1a1aa",
  textTertiary: "#71717a",
  border: "#27272a",
  borderHover: "#3f3f46",
  success: "#4ade80",
  warning: "#facc15",
  danger: "#f87171",
  info: "#60a5fa",
};

// Catppuccin (https://github.com/catppuccin/catppuccin) — RGB hex from the
// official spec. Mocha/Macchiato/Frappé are dark; Latte is light.
const CATPPUCCIN_MOCHA: TerminalPalette = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "rgba(245, 224, 220, 0.25)",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

const CATPPUCCIN_MACCHIATO: TerminalPalette = {
  background: "#24273a",
  foreground: "#cad3f5",
  cursor: "#f4dbd6",
  cursorAccent: "#24273a",
  selectionBackground: "rgba(244, 219, 214, 0.25)",
  black: "#494d64",
  red: "#ed8796",
  green: "#a6da95",
  yellow: "#eed49f",
  blue: "#8aadf4",
  magenta: "#f5bde6",
  cyan: "#8bd5ca",
  white: "#b8c0e0",
  brightBlack: "#5b6078",
  brightRed: "#ed8796",
  brightGreen: "#a6da95",
  brightYellow: "#eed49f",
  brightBlue: "#8aadf4",
  brightMagenta: "#f5bde6",
  brightCyan: "#8bd5ca",
  brightWhite: "#a5adcb",
};

const CATPPUCCIN_FRAPPE: TerminalPalette = {
  background: "#303446",
  foreground: "#c6d0f5",
  cursor: "#f2d5cf",
  cursorAccent: "#303446",
  selectionBackground: "rgba(242, 213, 207, 0.25)",
  black: "#51576d",
  red: "#e78284",
  green: "#a6d189",
  yellow: "#e5c890",
  blue: "#8caaee",
  magenta: "#f4b8e4",
  cyan: "#81c8be",
  white: "#b5bfe2",
  brightBlack: "#626880",
  brightRed: "#e78284",
  brightGreen: "#a6d189",
  brightYellow: "#e5c890",
  brightBlue: "#8caaee",
  brightMagenta: "#f4b8e4",
  brightCyan: "#81c8be",
  brightWhite: "#a5adce",
};

const CATPPUCCIN_LATTE: TerminalPalette = {
  background: "#eff1f5",
  foreground: "#4c4f69",
  cursor: "#dc8a78",
  cursorAccent: "#eff1f5",
  selectionBackground: "rgba(220, 138, 120, 0.25)",
  black: "#5c5f77",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  magenta: "#ea76cb",
  cyan: "#179299",
  white: "#acb0be",
  brightBlack: "#6c6f85",
  brightRed: "#d20f39",
  brightGreen: "#40a02b",
  brightYellow: "#df8e1d",
  brightBlue: "#1e66f5",
  brightMagenta: "#ea76cb",
  brightCyan: "#179299",
  brightWhite: "#bcc0cc",
};

// Classic xterm — neutral black background, near-CGA primaries, what
// users expect when they tick "give me a vanilla xterm please".
const XTERM_DEFAULT: TerminalPalette = {
  background: "#000000",
  foreground: "#e5e5e5",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255, 255, 255, 0.25)",
  black: "#000000",
  red: "#cd0000",
  green: "#00cd00",
  yellow: "#cdcd00",
  blue: "#0000ee",
  magenta: "#cd00cd",
  cyan: "#00cdcd",
  white: "#e5e5e5",
  brightBlack: "#7f7f7f",
  brightRed: "#ff0000",
  brightGreen: "#00ff00",
  brightYellow: "#ffff00",
  brightBlue: "#5c5cff",
  brightMagenta: "#ff00ff",
  brightCyan: "#00ffff",
  brightWhite: "#ffffff",
};

// Solarized (Ethan Schoonover). Dark and light variants share the
// accent palette; only base tones flip.
const SOLARIZED_DARK: TerminalPalette = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  cursorAccent: "#002b36",
  selectionBackground: "rgba(147, 161, 161, 0.25)",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const SOLARIZED_LIGHT: TerminalPalette = {
  background: "#fdf6e3",
  foreground: "#657b83",
  cursor: "#586e75",
  cursorAccent: "#fdf6e3",
  selectionBackground: "rgba(88, 110, 117, 0.2)",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

// Dracula (https://draculatheme.com/contribute) — official spec.
const DRACULA: TerminalPalette = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#bbbbbb",
  cursorAccent: "#282a36",
  selectionBackground: "rgba(68, 71, 90, 0.6)",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

// Nord (https://www.nordtheme.com/docs/colors-and-palettes)
const NORD: TerminalPalette = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  cursorAccent: "#2e3440",
  selectionBackground: "rgba(67, 76, 94, 0.5)",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

// Gruvbox Dark (Pavel Pertsev)
const GRUVBOX: TerminalPalette = {
  background: "#282828",
  foreground: "#ebdbb2",
  cursor: "#ebdbb2",
  cursorAccent: "#282828",
  selectionBackground: "rgba(168, 153, 132, 0.3)",
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#a89984",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#ebdbb2",
};

// Tokyo Night (Enkia / folke)
const TOKYO_NIGHT: TerminalPalette = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#1a1b26",
  selectionBackground: "rgba(40, 52, 87, 0.7)",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

// One Dark (Atom)
const ONE_DARK: TerminalPalette = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  cursorAccent: "#282c34",
  selectionBackground: "rgba(62, 68, 81, 0.6)",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

// Monokai
const MONOKAI: TerminalPalette = {
  background: "#272822",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  cursorAccent: "#272822",
  selectionBackground: "rgba(73, 72, 62, 0.7)",
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

// Rosé Pine (main, dark)
const ROSE_PINE: TerminalPalette = {
  background: "#191724",
  foreground: "#e0def4",
  cursor: "#524f67",
  cursorAccent: "#191724",
  selectionBackground: "rgba(110, 106, 134, 0.4)",
  black: "#26233a",
  red: "#eb6f92",
  green: "#31748f",
  yellow: "#f6c177",
  blue: "#9ccfd8",
  magenta: "#c4a7e7",
  cyan: "#ebbcba",
  white: "#e0def4",
  brightBlack: "#6e6a86",
  brightRed: "#eb6f92",
  brightGreen: "#31748f",
  brightYellow: "#f6c177",
  brightBlue: "#9ccfd8",
  brightMagenta: "#c4a7e7",
  brightCyan: "#ebbcba",
  brightWhite: "#e0def4",
};

// Rosé Pine Dawn (light)
const ROSE_PINE_DAWN: TerminalPalette = {
  background: "#faf4ed",
  foreground: "#575279",
  cursor: "#cecacd",
  cursorAccent: "#faf4ed",
  selectionBackground: "rgba(110, 106, 134, 0.18)",
  black: "#f2e9e1",
  red: "#b4637a",
  green: "#286983",
  yellow: "#ea9d34",
  blue: "#56949f",
  magenta: "#907aa9",
  cyan: "#d7827e",
  white: "#575279",
  brightBlack: "#9893a5",
  brightRed: "#b4637a",
  brightGreen: "#286983",
  brightYellow: "#ea9d34",
  brightBlue: "#56949f",
  brightMagenta: "#907aa9",
  brightCyan: "#d7827e",
  brightWhite: "#575279",
};

// Everforest (dark, medium)
const EVERFOREST: TerminalPalette = {
  background: "#2d353b",
  foreground: "#d3c6aa",
  cursor: "#d3c6aa",
  cursorAccent: "#2d353b",
  selectionBackground: "rgba(83, 103, 109, 0.5)",
  black: "#475258",
  red: "#e67e80",
  green: "#a7c080",
  yellow: "#dbbc7f",
  blue: "#7fbbb3",
  magenta: "#d699b6",
  cyan: "#83c092",
  white: "#d3c6aa",
  brightBlack: "#5c6a72",
  brightRed: "#e67e80",
  brightGreen: "#a7c080",
  brightYellow: "#dbbc7f",
  brightBlue: "#7fbbb3",
  brightMagenta: "#d699b6",
  brightCyan: "#83c092",
  brightWhite: "#d3c6aa",
};

// GitHub Dark (official Primer spec)
const GITHUB_DARK: TerminalPalette = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "rgba(56, 139, 253, 0.4)",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

// GitHub Light (official Primer spec)
const GITHUB_LIGHT: TerminalPalette = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(9, 105, 218, 0.18)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#953800",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#bf3989",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

// Ayu Mirage
const AYU_MIRAGE: TerminalPalette = {
  background: "#1f2430",
  foreground: "#cbccc6",
  cursor: "#ffcc66",
  cursorAccent: "#1f2430",
  selectionBackground: "rgba(64, 159, 255, 0.25)",
  black: "#191e2a",
  red: "#ed8274",
  green: "#a6cc70",
  yellow: "#fad07b",
  blue: "#6dcbfa",
  magenta: "#cfbafa",
  cyan: "#90e1c6",
  white: "#c7c7c7",
  brightBlack: "#686868",
  brightRed: "#f28779",
  brightGreen: "#bae67e",
  brightYellow: "#ffd580",
  brightBlue: "#73d0ff",
  brightMagenta: "#d4bfff",
  brightCyan: "#95e6cb",
  brightWhite: "#ffffff",
};

// Kanagawa (Wave)
const KANAGAWA: TerminalPalette = {
  background: "#1f1f28",
  foreground: "#dcd7ba",
  cursor: "#c8c093",
  cursorAccent: "#1f1f28",
  selectionBackground: "rgba(54, 54, 70, 0.7)",
  black: "#16161d",
  red: "#c34043",
  green: "#76946a",
  yellow: "#c0a36e",
  blue: "#7e9cd8",
  magenta: "#957fb8",
  cyan: "#6a9589",
  white: "#c8c093",
  brightBlack: "#727169",
  brightRed: "#e82424",
  brightGreen: "#98bb6c",
  brightYellow: "#e6c384",
  brightBlue: "#7fb4ca",
  brightMagenta: "#938aa9",
  brightCyan: "#7aa89f",
  brightWhite: "#dcd7ba",
};

// ---------------------------------------------------------------------------
// Assemble presets
// ---------------------------------------------------------------------------

export const PRESETS: ThemePreset[] = [
  {
    key: "mg-default",
    label: "ManageT Purple (default)",
    group: "ManageT",
    isDark: true,
    colors: { ui: MG_DEFAULT_UI, terminal: MG_DEFAULT_TERMINAL },
  },
  {
    key: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    group: "Catppuccin",
    isDark: true,
    colors: {
      ui: uiFromTerminal(CATPPUCCIN_MOCHA, {
        accent: "#cba6f7",
        accentBright: "#f5c2e7",
        accentDim: "#b4befe",
        isDark: true,
      }),
      terminal: CATPPUCCIN_MOCHA,
    },
  },
  {
    key: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    group: "Catppuccin",
    isDark: true,
    colors: {
      ui: uiFromTerminal(CATPPUCCIN_MACCHIATO, {
        accent: "#c6a0f6",
        accentBright: "#f5bde6",
        accentDim: "#b7bdf8",
        isDark: true,
      }),
      terminal: CATPPUCCIN_MACCHIATO,
    },
  },
  {
    key: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    group: "Catppuccin",
    isDark: true,
    colors: {
      ui: uiFromTerminal(CATPPUCCIN_FRAPPE, {
        accent: "#ca9ee6",
        accentBright: "#f4b8e4",
        accentDim: "#babbf1",
        isDark: true,
      }),
      terminal: CATPPUCCIN_FRAPPE,
    },
  },
  {
    key: "catppuccin-latte",
    label: "Catppuccin Latte",
    group: "Catppuccin",
    isDark: false,
    colors: {
      ui: uiFromTerminal(CATPPUCCIN_LATTE, {
        accent: "#8839ef",
        accentBright: "#ea76cb",
        accentDim: "#7287fd",
        isDark: false,
      }),
      terminal: CATPPUCCIN_LATTE,
    },
  },
  {
    key: "xterm",
    label: "xterm default",
    group: "Classic",
    isDark: true,
    colors: {
      ui: uiFromTerminal(XTERM_DEFAULT, {
        accent: "#5c5cff",
        accentBright: "#7c7cff",
        accentDim: "#0000ee",
        isDark: true,
      }),
      terminal: XTERM_DEFAULT,
    },
  },
  {
    key: "solarized-dark",
    label: "Solarized Dark",
    group: "Solarized",
    isDark: true,
    colors: {
      ui: uiFromTerminal(SOLARIZED_DARK, {
        accent: "#268bd2",
        accentBright: "#2aa198",
        accentDim: "#586e75",
        isDark: true,
      }),
      terminal: SOLARIZED_DARK,
    },
  },
  {
    key: "solarized-light",
    label: "Solarized Light",
    group: "Solarized",
    isDark: false,
    colors: {
      ui: uiFromTerminal(SOLARIZED_LIGHT, {
        accent: "#268bd2",
        accentBright: "#2aa198",
        accentDim: "#93a1a1",
        isDark: false,
      }),
      terminal: SOLARIZED_LIGHT,
    },
  },
  {
    key: "dracula",
    label: "Dracula",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(DRACULA, {
        accent: "#bd93f9",
        accentBright: "#ff79c6",
        accentDim: "#6272a4",
        isDark: true,
      }),
      terminal: DRACULA,
    },
  },
  {
    key: "nord",
    label: "Nord",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(NORD, {
        accent: "#88c0d0",
        accentBright: "#8fbcbb",
        accentDim: "#5e81ac",
        isDark: true,
      }),
      terminal: NORD,
    },
  },
  {
    key: "gruvbox",
    label: "Gruvbox Dark",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(GRUVBOX, {
        accent: "#fabd2f",
        accentBright: "#fe8019",
        accentDim: "#928374",
        isDark: true,
      }),
      terminal: GRUVBOX,
    },
  },
  {
    key: "tokyo-night",
    label: "Tokyo Night",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(TOKYO_NIGHT, {
        accent: "#7aa2f7",
        accentBright: "#bb9af7",
        accentDim: "#414868",
        isDark: true,
      }),
      terminal: TOKYO_NIGHT,
    },
  },
  {
    key: "one-dark",
    label: "One Dark",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(ONE_DARK, {
        accent: "#61afef",
        accentBright: "#56b6c2",
        accentDim: "#528bff",
        isDark: true,
      }),
      terminal: ONE_DARK,
    },
  },
  {
    key: "monokai",
    label: "Monokai",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(MONOKAI, {
        accent: "#f92672",
        accentBright: "#fd971f",
        accentDim: "#ae81ff",
        isDark: true,
      }),
      terminal: MONOKAI,
    },
  },
  {
    key: "ayu-mirage",
    label: "Ayu Mirage",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(AYU_MIRAGE, {
        accent: "#ffcc66",
        accentBright: "#ffd580",
        accentDim: "#ffa759",
        isDark: true,
      }),
      terminal: AYU_MIRAGE,
    },
  },
  {
    key: "kanagawa",
    label: "Kanagawa",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(KANAGAWA, {
        accent: "#7e9cd8",
        accentBright: "#7fb4ca",
        accentDim: "#957fb8",
        isDark: true,
      }),
      terminal: KANAGAWA,
    },
  },
  {
    key: "everforest",
    label: "Everforest Dark",
    group: "Community",
    isDark: true,
    colors: {
      ui: uiFromTerminal(EVERFOREST, {
        accent: "#a7c080",
        accentBright: "#83c092",
        accentDim: "#7fbbb3",
        isDark: true,
      }),
      terminal: EVERFOREST,
    },
  },
  {
    key: "rose-pine",
    label: "Rosé Pine",
    group: "Rosé Pine",
    isDark: true,
    colors: {
      ui: uiFromTerminal(ROSE_PINE, {
        accent: "#c4a7e7",
        accentBright: "#ebbcba",
        accentDim: "#9ccfd8",
        isDark: true,
      }),
      terminal: ROSE_PINE,
    },
  },
  {
    key: "rose-pine-dawn",
    label: "Rosé Pine Dawn",
    group: "Rosé Pine",
    isDark: false,
    colors: {
      ui: uiFromTerminal(ROSE_PINE_DAWN, {
        accent: "#907aa9",
        accentBright: "#d7827e",
        accentDim: "#56949f",
        isDark: false,
      }),
      terminal: ROSE_PINE_DAWN,
    },
  },
  {
    key: "github-dark",
    label: "GitHub Dark",
    group: "GitHub",
    isDark: true,
    colors: {
      ui: uiFromTerminal(GITHUB_DARK, {
        accent: "#58a6ff",
        accentBright: "#79c0ff",
        accentDim: "#1f6feb",
        isDark: true,
      }),
      terminal: GITHUB_DARK,
    },
  },
  {
    key: "github-light",
    label: "GitHub Light",
    group: "GitHub",
    isDark: false,
    colors: {
      ui: uiFromTerminal(GITHUB_LIGHT, {
        accent: "#0969da",
        accentBright: "#218bff",
        accentDim: "#0550ae",
        isDark: false,
      }),
      terminal: GITHUB_LIGHT,
    },
  },
];

export const PRESETS_BY_KEY: Record<string, ThemePreset> = Object.fromEntries(
  PRESETS.map((p) => [p.key, p])
);

export const DEFAULT_PRESET_KEY = "mg-default";

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Fonts the terminal font-family dropdown picks from. The user can also
 * type any other family name in the "Custom" input and we'll pass it
 * straight to xterm — these are just the curated suggestions.
 */
export const TERMINAL_FONTS: { value: string; label: string }[] = [
  { value: "JetBrains Mono", label: "JetBrains Mono (default)" },
  { value: "Fira Code", label: "Fira Code" },
  { value: "Source Code Pro", label: "Source Code Pro" },
  { value: "Hack", label: "Hack" },
  { value: "IBM Plex Mono", label: "IBM Plex Mono" },
  { value: "Cascadia Code", label: "Cascadia Code" },
  { value: "Menlo", label: "Menlo" },
  { value: "Consolas", label: "Consolas" },
  { value: "monospace", label: "System monospace" },
];

export const TERMINAL_FONT_SIZES: number[] = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What to show as the server identifier in the group-mosaic cell title
 *  bar — the SSH host or the user-assigned friendly name. */
export type GroupViewServerLabel = "host" | "name";

export interface AppearancePreferences {
  themeKey: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  customTheme: ThemeColors | null;
  groupViewServerLabel: GroupViewServerLabel;
  /** Active CLI-mosaic theme (built-in preset key or a custom theme name).
   *  Synced to the Rust CLI via /api/cli/themes. */
  mosaicThemeActive: string;
  /** User-defined CLI-mosaic themes. See src/lib/mosaic-themes/presets.ts. */
  mosaicCustomThemes: MosaicTheme[];
}

export const DEFAULT_PREFERENCES: AppearancePreferences = {
  themeKey: DEFAULT_PRESET_KEY,
  terminalFontFamily: "JetBrains Mono",
  terminalFontSize: 14,
  customTheme: null,
  groupViewServerLabel: "host",
  mosaicThemeActive: "default",
  mosaicCustomThemes: [],
};

/**
 * Maps each UI palette key to the CSS custom property the app reads
 * (the same names Tailwind's `@theme` block in globals.css declares).
 * Single source of truth shared by the client ThemeProvider (which sets
 * these via documentElement.style) and the server-side layout (which
 * inlines them into a <style> tag so the first paint is already themed).
 */
export const UI_CSS_VAR_MAP: Record<keyof UiPalette, string> = {
  bg: "--color-mg-bg",
  bgSecondary: "--color-mg-bg-secondary",
  bgTertiary: "--color-mg-bg-tertiary",
  bgHover: "--color-mg-bg-hover",
  bgActive: "--color-mg-bg-active",
  accent: "--color-mg-accent",
  accentBright: "--color-mg-accent-bright",
  accentDim: "--color-mg-accent-dim",
  text: "--color-mg-text",
  textSecondary: "--color-mg-text-secondary",
  textTertiary: "--color-mg-text-tertiary",
  border: "--color-mg-border",
  borderHover: "--color-mg-border-hover",
  success: "--color-mg-success",
  warning: "--color-mg-warning",
  danger: "--color-mg-danger",
  info: "--color-mg-info",
};

/**
 * Serialise a UI palette into a `--color-mg-*: value;` declaration list
 * (no selector wrapper). Used by the SSR layout to build an inline
 * `:root { … }` block so the very first paint matches the user's theme
 * and there's no flash of the default purple palette.
 */
export function uiPaletteToCssVars(palette: UiPalette): string {
  return (Object.keys(UI_CSS_VAR_MAP) as (keyof UiPalette)[])
    .map((k) => {
      // Defence-in-depth: this string is injected via dangerouslySetInnerHTML.
      // Even though the write path validates customTheme, drop any value that
      // isn't a safe colour (e.g. a row persisted before validation existed)
      // so it can never break out of the CSS declaration. `inherit` is an
      // innocuous fallback that just leaves the cascade untouched.
      const raw = palette[k];
      const safe = isSafeColorValue(raw) ? raw : "inherit";
      return `${UI_CSS_VAR_MAP[k]}:${safe};`;
    })
    .join("");
}

/**
 * Strict allow-list for a single CSS colour value. Custom-theme colours are
 * concatenated into an inline `<style>` block via `uiPaletteToCssVars` and
 * injected with `dangerouslySetInnerHTML`, so a value containing `;`, `}` or
 * `</style>` would break out of the declaration. We accept only hex, rgb/rgba,
 * hsl/hsla and plain colour keywords — none of which can contain a CSS/HTML
 * break-out character. Reject everything else.
 */
const SAFE_COLOR_PATTERNS: RegExp[] = [
  /^#[0-9a-fA-F]{3,8}$/,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/,
  /^hsl\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?%\s*,\s*\d{1,3}(?:\.\d+)?%\s*\)$/,
  /^hsla\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?%\s*,\s*\d{1,3}(?:\.\d+)?%\s*,\s*(?:0|1|0?\.\d+)\s*\)$/,
  /^[a-zA-Z]{3,20}$/, // CSS colour keyword (e.g. "rebeccapurple", "transparent")
];

export function isSafeColorValue(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && SAFE_COLOR_PATTERNS.some((re) => re.test(v));
}

/**
 * Validate an untrusted `customTheme` payload: it must be a plain object
 * whose every string leaf is a safe CSS colour (see {@link isSafeColorValue}).
 * Walks nested objects (the `ui` / `terminal` palettes) and rejects arrays,
 * functions, or any unsafe colour string. Returns true only if the whole
 * structure is safe to persist and later inject as CSS.
 */
export function isSafeCustomTheme(obj: unknown, depth = 0): boolean {
  if (depth > 3) return false; // ThemeColors is { ui: {...}, terminal: {...} }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (!isSafeColorValue(value)) return false;
    } else if (value !== null && typeof value === "object") {
      if (!isSafeCustomTheme(value, depth + 1)) return false;
    } else {
      return false; // numbers, booleans, functions, undefined — not allowed
    }
  }
  return true;
}

/**
 * Resolve a preferences row into the concrete ThemeColors we'll apply.
 * If the user picked "custom" but no customTheme is present (data
 * corruption, half-finished save), fall back to the default preset.
 */
export function resolveColors(prefs: AppearancePreferences): ThemeColors {
  if (prefs.themeKey === "custom") {
    return withSemanticDefaults(
      prefs.customTheme ?? PRESETS_BY_KEY[DEFAULT_PRESET_KEY].colors
    );
  }
  const preset = PRESETS_BY_KEY[prefs.themeKey];
  return withSemanticDefaults(
    preset ? preset.colors : PRESETS_BY_KEY[DEFAULT_PRESET_KEY].colors
  );
}
