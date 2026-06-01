/**
 * Single source of truth for the CLI **mosaic** themes — the chrome the
 * Rust `managet group open` / `stack open` multipane draws (pane borders,
 * titles, status bar, picker, confirm). This is DISTINCT from the dashboard's
 * own appearance theme in src/lib/themes/presets.ts (which skins the web UI +
 * xterm).
 *
 * A mosaic theme = 19 semantic color roles + a border line style. The 6
 * built-in presets here are ported byte-for-byte from `theme_by_name` in
 * agent/src/cli_dashboard.rs so the web preview and the CLI render identically.
 *
 * Colors are encoded as either a named crossterm token ("cyan", "dark_grey",
 * …) or a "#rrggbb" hex string. Named tokens keep the `default` preset's
 * terminal-adaptive look on the CLI; the web preview approximates them via
 * NAMED_COLOR_HEX. Custom themes (from the web designer) are always hex.
 *
 * Border glyphs are resolved from LINE_STYLES; the server sends the resolved
 * 6 glyphs to the CLI, so adding a new line type is a change HERE ONLY — no
 * Rust rebuild needed.
 */

export type MosaicColorToken = string; // named token (see NAMED_COLOR_HEX) or "#rrggbb"

export interface MosaicThemeColors {
  borderActive: MosaicColorToken;
  borderInactive: MosaicColorToken;
  titleActive: MosaicColorToken;
  titleInactive: MosaicColorToken;
  heading: MosaicColorToken;
  name: MosaicColorToken;
  separator: MosaicColorToken;
  info: MosaicColorToken;
  hint: MosaicColorToken;
  serverLabel: MosaicColorToken;
  accent: MosaicColorToken;
  selectedFg: MosaicColorToken;
  selectedBg: MosaicColorToken;
  warning: MosaicColorToken;
  danger: MosaicColorToken;
  statusRunning: MosaicColorToken;
  statusIdle: MosaicColorToken;
  statusClosed: MosaicColorToken;
  statusUnknown: MosaicColorToken;
}

export interface MosaicBorders {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export interface MosaicTheme {
  name: string;
  builtin: boolean;
  lineStyle: string; // key into LINE_STYLES
  colors: MosaicThemeColors;
}

/** The 19 roles in designer display order. */
export const MOSAIC_ROLE_KEYS: (keyof MosaicThemeColors)[] = [
  "borderActive",
  "borderInactive",
  "titleActive",
  "titleInactive",
  "heading",
  "name",
  "separator",
  "info",
  "hint",
  "serverLabel",
  "accent",
  "selectedFg",
  "selectedBg",
  "warning",
  "danger",
  "statusRunning",
  "statusIdle",
  "statusClosed",
  "statusUnknown",
];

export const MOSAIC_ROLE_LABELS: Record<keyof MosaicThemeColors, string> = {
  borderActive: "Border (focused)",
  borderInactive: "Border (unfocused)",
  titleActive: "Title (focused)",
  titleInactive: "Title (unfocused)",
  heading: "Status-bar heading",
  name: "Group / stack name",
  separator: "Separators",
  info: "Status-bar info",
  hint: "Key hints",
  serverLabel: "Server label",
  accent: "Accent (picker)",
  selectedFg: "Selected text",
  selectedBg: "Selected background",
  warning: "Warning",
  danger: "Danger",
  statusRunning: "Status · running",
  statusIdle: "Status · idle",
  statusClosed: "Status · closed",
  statusUnknown: "Status · unknown",
};

/** Designer grouping of the roles into labeled sections. */
export const MOSAIC_ROLE_GROUPS: { label: string; keys: (keyof MosaicThemeColors)[] }[] = [
  { label: "Borders", keys: ["borderActive", "borderInactive"] },
  {
    label: "Titles & text",
    keys: ["titleActive", "titleInactive", "heading", "name", "separator", "info", "hint", "serverLabel"],
  },
  { label: "Accent & selection", keys: ["accent", "selectedFg", "selectedBg"] },
  {
    label: "Status",
    keys: ["warning", "danger", "statusRunning", "statusIdle", "statusClosed", "statusUnknown"],
  },
];

// ---------------------------------------------------------------------------
// Line styles (border glyph sets). Adding an entry here is all that's needed
// to offer a new line type — the server resolves it to glyphs for the CLI.
// ---------------------------------------------------------------------------

export const LINE_STYLES: Record<string, MosaicBorders> = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┄", v: "┊" },
  "heavy-dashed": { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "┅", v: "┋" },
  dotted: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "┈", v: "┆" },
  blank: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: " " },
};

export const LINE_STYLE_LIST: { key: string; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "heavy", label: "Heavy" },
  { key: "rounded", label: "Rounded" },
  { key: "double", label: "Double" },
  { key: "ascii", label: "ASCII" },
  { key: "dashed", label: "Dashed" },
  { key: "heavy-dashed", label: "Heavy dashed" },
  { key: "dotted", label: "Dotted" },
  { key: "blank", label: "Borderless" },
];

export const DEFAULT_LINE_STYLE = "light";

/** Resolve a theme's 6 border glyphs. */
export function resolveBorders(theme: MosaicTheme): MosaicBorders {
  return LINE_STYLES[theme.lineStyle] ?? LINE_STYLES.light;
}

// ---------------------------------------------------------------------------
// Built-in presets — ported from agent/src/cli_dashboard.rs theme_by_name().
// `default` uses named tokens (terminal-adaptive on the CLI); the rest use the
// exact RGB hex from the Rust source. lineStyle matches the Rust BORDERS_*.
// ---------------------------------------------------------------------------

export const MOSAIC_PRESETS: MosaicTheme[] = [
  {
    name: "default",
    builtin: true,
    lineStyle: "light",
    colors: {
      borderActive: "cyan",
      borderInactive: "dark_grey",
      titleActive: "cyan",
      titleInactive: "grey",
      heading: "magenta",
      name: "white",
      separator: "dark_grey",
      info: "cyan",
      hint: "dark_grey",
      serverLabel: "blue",
      accent: "cyan",
      selectedFg: "black",
      selectedBg: "cyan",
      warning: "yellow",
      danger: "red",
      statusRunning: "green",
      statusIdle: "yellow",
      statusClosed: "red",
      statusUnknown: "grey",
    },
  },
  {
    name: "ocean",
    builtin: true,
    lineStyle: "rounded",
    colors: {
      borderActive: "#38bdf8",
      borderInactive: "#334155",
      titleActive: "#7dd3fc",
      titleInactive: "#64748b",
      heading: "#2dd4bf",
      name: "#e0f2fe",
      separator: "#334155",
      info: "#38bdf8",
      hint: "#64748b",
      serverLabel: "#60a5fa",
      accent: "#2dd4bf",
      selectedFg: "#082f49",
      selectedBg: "#38bdf8",
      warning: "#facc15",
      danger: "#f87171",
      statusRunning: "#2dd4bf",
      statusIdle: "#facc15",
      statusClosed: "#f87171",
      statusUnknown: "#64748b",
    },
  },
  {
    name: "solarized",
    builtin: true,
    lineStyle: "light",
    colors: {
      borderActive: "#268bd2",
      borderInactive: "#586e75",
      titleActive: "#268bd2",
      titleInactive: "#839496",
      heading: "#d33682",
      name: "#eee8d5",
      separator: "#586e75",
      info: "#2aa198",
      hint: "#657b83",
      serverLabel: "#268bd2",
      accent: "#2aa198",
      selectedFg: "#002b36",
      selectedBg: "#2aa198",
      warning: "#b58900",
      danger: "#dc322f",
      statusRunning: "#859900",
      statusIdle: "#b58900",
      statusClosed: "#dc322f",
      statusUnknown: "#657b83",
    },
  },
  {
    name: "mono",
    builtin: true,
    lineStyle: "light",
    colors: {
      borderActive: "white",
      borderInactive: "#4b4b4b",
      titleActive: "white",
      titleInactive: "#969696",
      heading: "white",
      name: "white",
      separator: "#5a5a5a",
      info: "#d2d2d2",
      hint: "#787878",
      serverLabel: "#aaaaaa",
      accent: "white",
      selectedFg: "black",
      selectedBg: "white",
      warning: "#c8c8c8",
      danger: "#ebebeb",
      statusRunning: "white",
      statusIdle: "#969696",
      statusClosed: "#5a5a5a",
      statusUnknown: "#5a5a5a",
    },
  },
  {
    name: "matrix",
    builtin: true,
    lineStyle: "heavy",
    colors: {
      borderActive: "#00ff41",
      borderInactive: "#005a1e",
      titleActive: "#00ff41",
      titleInactive: "#008c32",
      heading: "#00ff41",
      name: "#b4ffb4",
      separator: "#005a1e",
      info: "#00ff41",
      hint: "#007828",
      serverLabel: "#50dc64",
      accent: "#00ff41",
      selectedFg: "black",
      selectedBg: "#00ff41",
      warning: "#adff2f",
      danger: "#ff5050",
      statusRunning: "#00ff41",
      statusIdle: "#adff2f",
      statusClosed: "#ff5050",
      statusUnknown: "#007828",
    },
  },
  {
    name: "sunset",
    builtin: true,
    lineStyle: "double",
    colors: {
      borderActive: "#fb923c",
      borderInactive: "#784632",
      titleActive: "#fdba74",
      titleInactive: "#a06e5a",
      heading: "#f43f5e",
      name: "#ffedd5",
      separator: "#784632",
      info: "#fb923c",
      hint: "#a06e5a",
      serverLabel: "#facc15",
      accent: "#fb923c",
      selectedFg: "#3c140a",
      selectedBg: "#fb923c",
      warning: "#facc15",
      danger: "#f43f5e",
      statusRunning: "#facc15",
      statusIdle: "#fb923c",
      statusClosed: "#f43f5e",
      statusUnknown: "#a06e5a",
    },
  },
];

export const MOSAIC_PRESETS_BY_NAME: Record<string, MosaicTheme> = Object.fromEntries(
  MOSAIC_PRESETS.map((t) => [t.name, t])
);

export const DEFAULT_MOSAIC_THEME = "default";

// ---------------------------------------------------------------------------
// Color encoding helpers.
// ---------------------------------------------------------------------------

/** Approximate hex for each named crossterm token — web preview only. The CLI
 *  uses the terminal's true (adaptive) colors for named tokens. */
export const NAMED_COLOR_HEX: Record<string, string> = {
  black: "#000000",
  dark_grey: "#6e7681",
  grey: "#b0b6c0",
  white: "#ffffff",
  red: "#ff6b6b",
  dark_red: "#cc3333",
  green: "#5ed16a",
  dark_green: "#3a9e44",
  yellow: "#e3c558",
  dark_yellow: "#b58900",
  blue: "#6ea8fe",
  dark_blue: "#3b6db5",
  magenta: "#d782ff",
  dark_magenta: "#a33bb5",
  cyan: "#4fd1d9",
  dark_cyan: "#2a9ba1",
};

/** Render a token as a CSS color for the web preview. */
export function tokenToCss(token: MosaicColorToken): string {
  if (token.startsWith("#")) return token;
  return NAMED_COLOR_HEX[token] ?? "#ffffff";
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

/** Coerce a value to a valid mosaic token (named or #rrggbb), or null. */
export function normaliseMosaicToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v in NAMED_COLOR_HEX) return v;
  if (HEX6.test(v)) return v.toLowerCase();
  if (HEX3.test(v)) {
    const r = v[1], g = v[2], b = v[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

export const MOSAIC_CUSTOM_NAME_MAX = 40;
export const MOSAIC_CUSTOM_MAX = 50;

/** Coerce arbitrary input into a valid, de-duplicated MosaicTheme[]. Names
 *  colliding with a built-in are dropped; unknown line styles fall back to
 *  light; each missing/invalid role color falls back to the default preset's
 *  value. Used by both the browser PUT and (indirectly) the CLI catalog. */
export function sanitizeCustomThemes(input: unknown): MosaicTheme[] {
  if (!Array.isArray(input)) return [];
  const fallback = MOSAIC_PRESETS_BY_NAME[DEFAULT_MOSAIC_THEME].colors;
  const out: MosaicTheme[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MOSAIC_CUSTOM_MAX) break;
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > MOSAIC_CUSTOM_NAME_MAX) continue;
    if (name in MOSAIC_PRESETS_BY_NAME) continue; // can't shadow a built-in
    if (seen.has(name)) continue;
    const lineStyle =
      typeof entry.lineStyle === "string" && entry.lineStyle in LINE_STYLES
        ? entry.lineStyle
        : DEFAULT_LINE_STYLE;
    const rawColors =
      entry.colors && typeof entry.colors === "object"
        ? (entry.colors as Record<string, unknown>)
        : {};
    const colors = {} as MosaicThemeColors;
    for (const role of MOSAIC_ROLE_KEYS) {
      colors[role] = normaliseMosaicToken(rawColors[role]) ?? fallback[role];
    }
    seen.add(name);
    out.push({ name, builtin: false, lineStyle, colors });
  }
  return out;
}

/** Pick a valid active theme name given the user's customs. */
export function resolveActiveName(active: unknown, customs: MosaicTheme[]): string {
  if (typeof active === "string") {
    if (active in MOSAIC_PRESETS_BY_NAME) return active;
    if (customs.some((c) => c.name === active)) return active;
  }
  return DEFAULT_MOSAIC_THEME;
}

/** The full catalog (built-ins + customs) with resolved 6-glyph borders —
 *  the shape the CLI consumes from /api/cli/themes. */
export function buildThemeCatalog(customs: MosaicTheme[]) {
  return [...MOSAIC_PRESETS, ...customs].map((t) => ({
    name: t.name,
    builtin: t.builtin,
    colors: t.colors,
    borders: resolveBorders(t),
  }));
}
