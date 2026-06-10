//! Dashboard-backed features for the user-facing `managet` CLI.
//!
//! Local `managet attach` still talks directly to the agent socket on
//! the current host. Group views are different: a browser group can
//! contain sessions from several managed servers, so the CLI has to use
//! the dashboard as the cross-server router. This module owns that path:
//! user-scoped dashboard login, group metadata/layout REST calls, and a
//! small managet-owned multi-pane terminal view over the dashboard WS.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{IsTerminal, Stdout, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use crossterm::cursor::{Hide, MoveTo, MoveToColumn, MoveUp, Show};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{
    Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor,
    StyledContent, Stylize,
};
use crossterm::terminal::{
    self, disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{execute, queue};
use futures_util::{SinkExt, StreamExt};
use inquire::{Password, Select, Text};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DashboardCliConfig {
    api_url: String,
    token: String,
    /// Preferred mosaic theme name (see `managet theme list`). Optional so
    /// configs written before theming still parse; absent ⇒ "default".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
}

// ---------------------------------------------------------------------------
// Mosaic themes
//
// The group/stack multi-pane view draws its chrome — pane borders, titles,
// status bar, focus highlight, picker, confirm modal — from a `Theme`: a
// palette of crossterm colors plus a box-drawing glyph set ("lines"). Themes
// are named presets the user switches between (`managet theme set <name>`, or
// the per-run `--theme <name>` flag). The chosen theme is fixed for the life
// of a `group open`/`stack open` process, so it lives in a write-once global
// rather than being threaded through every draw function.
// ---------------------------------------------------------------------------

/// The six box-drawing glyphs used for every pane/modal border. Swapping
/// these is how a theme changes the "line" style (light, heavy, rounded,
/// double, …).
#[derive(Debug, Clone, Copy)]
struct Borders {
    tl: &'static str,
    tr: &'static str,
    bl: &'static str,
    br: &'static str,
    h: &'static str,
    v: &'static str,
}

const BORDERS_LIGHT: Borders = Borders { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
const BORDERS_HEAVY: Borders = Borders { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
const BORDERS_ROUND: Borders = Borders { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const BORDERS_DOUBLE: Borders = Borders { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" };

/// Every color role the mosaic chrome paints. Names are semantic so presets
/// stay readable and the draw functions don't reach for raw `Color::*`.
#[derive(Debug, Clone, Copy)]
struct Theme {
    border_active: Color,
    border_inactive: Color,
    title_active: Color,
    title_inactive: Color,
    heading: Color,       // "managet group:" / "managet stack:"
    name: Color,          // group / stack name
    separator: Color,     // │  ·  [  ]  @
    info: Color,          // status-bar active text
    hint: Color,          // status-bar key hints / dim helper text
    server_label: Color,  // "@ host" in pane titles
    accent: Color,        // picker border/title, focus emphasis
    selected_fg: Color,   // picker highlighted row foreground
    selected_bg: Color,   // picker highlighted row background
    warning: Color,       // picker-mode banner, "(no servers)"
    danger: Color,        // confirm modal, "session lost"
    status_running: Color,
    status_idle: Color,
    status_closed: Color,
    status_unknown: Color,
    borders: Borders,
}

/// Preset names in display order. The first, `default`, is the historical
/// look and the fallback for everything.
fn preset_names() -> &'static [&'static str] {
    &["default", "ocean", "solarized", "mono", "matrix", "sunset"]
}

fn theme_by_name(name: &str) -> Option<Theme> {
    let theme = match name {
        // Byte-for-byte the pre-theming palette + light lines.
        "default" => Theme {
            border_active: Color::Cyan,
            border_inactive: Color::DarkGrey,
            title_active: Color::Cyan,
            title_inactive: Color::Grey,
            heading: Color::Magenta,
            name: Color::White,
            separator: Color::DarkGrey,
            info: Color::Cyan,
            hint: Color::DarkGrey,
            server_label: Color::Blue,
            accent: Color::Cyan,
            selected_fg: Color::Black,
            selected_bg: Color::Cyan,
            warning: Color::Yellow,
            danger: Color::Red,
            status_running: Color::Green,
            status_idle: Color::Yellow,
            status_closed: Color::Red,
            status_unknown: Color::Grey,
            borders: BORDERS_LIGHT,
        },
        "ocean" => Theme {
            border_active: Color::Rgb { r: 56, g: 189, b: 248 },
            border_inactive: Color::Rgb { r: 51, g: 65, b: 85 },
            title_active: Color::Rgb { r: 125, g: 211, b: 252 },
            title_inactive: Color::Rgb { r: 100, g: 116, b: 139 },
            heading: Color::Rgb { r: 45, g: 212, b: 191 },
            name: Color::Rgb { r: 224, g: 242, b: 254 },
            separator: Color::Rgb { r: 51, g: 65, b: 85 },
            info: Color::Rgb { r: 56, g: 189, b: 248 },
            hint: Color::Rgb { r: 100, g: 116, b: 139 },
            server_label: Color::Rgb { r: 96, g: 165, b: 250 },
            accent: Color::Rgb { r: 45, g: 212, b: 191 },
            selected_fg: Color::Rgb { r: 8, g: 47, b: 73 },
            selected_bg: Color::Rgb { r: 56, g: 189, b: 248 },
            warning: Color::Rgb { r: 250, g: 204, b: 21 },
            danger: Color::Rgb { r: 248, g: 113, b: 113 },
            status_running: Color::Rgb { r: 45, g: 212, b: 191 },
            status_idle: Color::Rgb { r: 250, g: 204, b: 21 },
            status_closed: Color::Rgb { r: 248, g: 113, b: 113 },
            status_unknown: Color::Rgb { r: 100, g: 116, b: 139 },
            borders: BORDERS_ROUND,
        },
        "solarized" => Theme {
            border_active: Color::Rgb { r: 38, g: 139, b: 210 },
            border_inactive: Color::Rgb { r: 88, g: 110, b: 117 },
            title_active: Color::Rgb { r: 38, g: 139, b: 210 },
            title_inactive: Color::Rgb { r: 131, g: 148, b: 150 },
            heading: Color::Rgb { r: 211, g: 54, b: 130 },
            name: Color::Rgb { r: 238, g: 232, b: 213 },
            separator: Color::Rgb { r: 88, g: 110, b: 117 },
            info: Color::Rgb { r: 42, g: 161, b: 152 },
            hint: Color::Rgb { r: 101, g: 123, b: 131 },
            server_label: Color::Rgb { r: 38, g: 139, b: 210 },
            accent: Color::Rgb { r: 42, g: 161, b: 152 },
            selected_fg: Color::Rgb { r: 0, g: 43, b: 54 },
            selected_bg: Color::Rgb { r: 42, g: 161, b: 152 },
            warning: Color::Rgb { r: 181, g: 137, b: 0 },
            danger: Color::Rgb { r: 220, g: 50, b: 47 },
            status_running: Color::Rgb { r: 133, g: 153, b: 0 },
            status_idle: Color::Rgb { r: 181, g: 137, b: 0 },
            status_closed: Color::Rgb { r: 220, g: 50, b: 47 },
            status_unknown: Color::Rgb { r: 101, g: 123, b: 131 },
            borders: BORDERS_LIGHT,
        },
        "mono" => Theme {
            border_active: Color::White,
            border_inactive: Color::Rgb { r: 75, g: 75, b: 75 },
            title_active: Color::White,
            title_inactive: Color::Rgb { r: 150, g: 150, b: 150 },
            heading: Color::White,
            name: Color::White,
            separator: Color::Rgb { r: 90, g: 90, b: 90 },
            info: Color::Rgb { r: 210, g: 210, b: 210 },
            hint: Color::Rgb { r: 120, g: 120, b: 120 },
            server_label: Color::Rgb { r: 170, g: 170, b: 170 },
            accent: Color::White,
            selected_fg: Color::Black,
            selected_bg: Color::White,
            warning: Color::Rgb { r: 200, g: 200, b: 200 },
            danger: Color::Rgb { r: 235, g: 235, b: 235 },
            status_running: Color::White,
            status_idle: Color::Rgb { r: 150, g: 150, b: 150 },
            status_closed: Color::Rgb { r: 90, g: 90, b: 90 },
            status_unknown: Color::Rgb { r: 90, g: 90, b: 90 },
            borders: BORDERS_LIGHT,
        },
        "matrix" => Theme {
            border_active: Color::Rgb { r: 0, g: 255, b: 65 },
            border_inactive: Color::Rgb { r: 0, g: 90, b: 30 },
            title_active: Color::Rgb { r: 0, g: 255, b: 65 },
            title_inactive: Color::Rgb { r: 0, g: 140, b: 50 },
            heading: Color::Rgb { r: 0, g: 255, b: 65 },
            name: Color::Rgb { r: 180, g: 255, b: 180 },
            separator: Color::Rgb { r: 0, g: 90, b: 30 },
            info: Color::Rgb { r: 0, g: 255, b: 65 },
            hint: Color::Rgb { r: 0, g: 120, b: 40 },
            server_label: Color::Rgb { r: 80, g: 220, b: 100 },
            accent: Color::Rgb { r: 0, g: 255, b: 65 },
            selected_fg: Color::Black,
            selected_bg: Color::Rgb { r: 0, g: 255, b: 65 },
            warning: Color::Rgb { r: 173, g: 255, b: 47 },
            danger: Color::Rgb { r: 255, g: 80, b: 80 },
            status_running: Color::Rgb { r: 0, g: 255, b: 65 },
            status_idle: Color::Rgb { r: 173, g: 255, b: 47 },
            status_closed: Color::Rgb { r: 255, g: 80, b: 80 },
            status_unknown: Color::Rgb { r: 0, g: 120, b: 40 },
            borders: BORDERS_HEAVY,
        },
        "sunset" => Theme {
            border_active: Color::Rgb { r: 251, g: 146, b: 60 },
            border_inactive: Color::Rgb { r: 120, g: 70, b: 50 },
            title_active: Color::Rgb { r: 253, g: 186, b: 116 },
            title_inactive: Color::Rgb { r: 160, g: 110, b: 90 },
            heading: Color::Rgb { r: 244, g: 63, b: 94 },
            name: Color::Rgb { r: 255, g: 237, b: 213 },
            separator: Color::Rgb { r: 120, g: 70, b: 50 },
            info: Color::Rgb { r: 251, g: 146, b: 60 },
            hint: Color::Rgb { r: 160, g: 110, b: 90 },
            server_label: Color::Rgb { r: 250, g: 204, b: 21 },
            accent: Color::Rgb { r: 251, g: 146, b: 60 },
            selected_fg: Color::Rgb { r: 60, g: 20, b: 10 },
            selected_bg: Color::Rgb { r: 251, g: 146, b: 60 },
            warning: Color::Rgb { r: 250, g: 204, b: 21 },
            danger: Color::Rgb { r: 244, g: 63, b: 94 },
            status_running: Color::Rgb { r: 250, g: 204, b: 21 },
            status_idle: Color::Rgb { r: 251, g: 146, b: 60 },
            status_closed: Color::Rgb { r: 244, g: 63, b: 94 },
            status_unknown: Color::Rgb { r: 160, g: 110, b: 90 },
            borders: BORDERS_DOUBLE,
        },
        _ => return None,
    };
    Some(theme)
}

static ACTIVE_THEME: OnceLock<Theme> = OnceLock::new();

/// The theme for the running mosaic. Falls back to `default` if never set
/// (e.g. a draw helper hit outside an `open` command), so it's always safe
/// to call.
fn theme() -> &'static Theme {
    ACTIVE_THEME.get_or_init(|| theme_by_name("default").expect("default theme exists"))
}

/// Fix the active theme for this process. Idempotent-ish: the first set
/// wins (a single `open` command sets it once before drawing).
fn set_active_theme(theme: Theme) {
    let _ = ACTIVE_THEME.set(theme);
}

/// Resolve which theme to use: `--theme` flag > config `theme` > "default".
/// Errors (before raw mode) on an unknown name so the message lands on a
/// normal screen.
fn resolve_theme(cfg: &DashboardCliConfig, override_name: Option<&str>) -> Result<Theme> {
    let name = override_name
        .map(|s| s.to_string())
        .or_else(|| cfg.theme.clone())
        .unwrap_or_else(|| "default".to_string());
    theme_by_name(&name).ok_or_else(|| {
        anyhow!(
            "unknown theme '{name}'; available: {}",
            preset_names().join(", ")
        )
    })
}

// --- Server-synced theme catalog ------------------------------------------
// The dashboard is the source of truth for the theme catalog (built-in
// presets + the user's web-designed customs) and the active selection. The
// CLI fetches `/api/cli/themes`, which sends each theme's colors AND the 6
// resolved border glyphs — so new line styles are a server-only change. The
// compiled-in presets above remain the offline fallback.

#[derive(Debug, Clone, Deserialize)]
struct ThemeCatalogDto {
    active: String,
    themes: Vec<MosaicThemeDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MosaicThemeDto {
    name: String,
    #[serde(default)]
    builtin: bool,
    colors: MosaicColorsDto,
    borders: BordersDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MosaicColorsDto {
    border_active: String,
    border_inactive: String,
    title_active: String,
    title_inactive: String,
    heading: String,
    name: String,
    separator: String,
    info: String,
    hint: String,
    server_label: String,
    accent: String,
    selected_fg: String,
    selected_bg: String,
    warning: String,
    danger: String,
    status_running: String,
    status_idle: String,
    status_closed: String,
    status_unknown: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BordersDto {
    tl: String,
    tr: String,
    bl: String,
    br: String,
    h: String,
    v: String,
}

/// Parse a transport color token into a crossterm `Color`: `#rrggbb` → Rgb,
/// a named token → the matching `Color::*` (so the `default` theme keeps its
/// terminal-adaptive ANSI look), anything else → grey.
fn parse_color(s: &str) -> Color {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&hex[0..2], 16),
                u8::from_str_radix(&hex[2..4], 16),
                u8::from_str_radix(&hex[4..6], 16),
            ) {
                return Color::Rgb { r, g, b };
            }
        }
        return Color::Grey;
    }
    match s {
        "black" => Color::Black,
        "dark_grey" | "dark_gray" => Color::DarkGrey,
        "red" => Color::Red,
        "dark_red" => Color::DarkRed,
        "green" => Color::Green,
        "dark_green" => Color::DarkGreen,
        "yellow" => Color::Yellow,
        "dark_yellow" => Color::DarkYellow,
        "blue" => Color::Blue,
        "dark_blue" => Color::DarkBlue,
        "magenta" => Color::Magenta,
        "dark_magenta" => Color::DarkMagenta,
        "cyan" => Color::Cyan,
        "dark_cyan" => Color::DarkCyan,
        "white" => Color::White,
        "grey" | "gray" => Color::Grey,
        _ => Color::Grey,
    }
}

/// Leak a small glyph string to satisfy `Borders`' `&'static str`. The active
/// theme is built once per process, so this is a bounded, tiny leak.
fn leak_glyph(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn theme_from_dto(dto: &MosaicThemeDto) -> Theme {
    let c = &dto.colors;
    Theme {
        border_active: parse_color(&c.border_active),
        border_inactive: parse_color(&c.border_inactive),
        title_active: parse_color(&c.title_active),
        title_inactive: parse_color(&c.title_inactive),
        heading: parse_color(&c.heading),
        name: parse_color(&c.name),
        separator: parse_color(&c.separator),
        info: parse_color(&c.info),
        hint: parse_color(&c.hint),
        server_label: parse_color(&c.server_label),
        accent: parse_color(&c.accent),
        selected_fg: parse_color(&c.selected_fg),
        selected_bg: parse_color(&c.selected_bg),
        warning: parse_color(&c.warning),
        danger: parse_color(&c.danger),
        status_running: parse_color(&c.status_running),
        status_idle: parse_color(&c.status_idle),
        status_closed: parse_color(&c.status_closed),
        status_unknown: parse_color(&c.status_unknown),
        borders: Borders {
            tl: leak_glyph(&dto.borders.tl),
            tr: leak_glyph(&dto.borders.tr),
            bl: leak_glyph(&dto.borders.bl),
            br: leak_glyph(&dto.borders.br),
            h: leak_glyph(&dto.borders.h),
            v: leak_glyph(&dto.borders.v),
        },
    }
}

async fn fetch_theme_catalog(cfg: &DashboardCliConfig) -> Result<ThemeCatalogDto> {
    get_json::<ThemeCatalogDto>(cfg, "/api/cli/themes").await
}

/// Resolve the active mosaic theme. Prefer the server catalog (so web-created
/// customs and the web-chosen active apply); fall back to the compiled-in
/// presets + local config when the dashboard is unreachable.
async fn resolve_active_theme(
    cfg: &DashboardCliConfig,
    override_name: Option<&str>,
) -> Result<Theme> {
    match fetch_theme_catalog(cfg).await {
        Ok(cat) => {
            let want = override_name
                .map(|s| s.to_string())
                .unwrap_or_else(|| cat.active.clone());
            let dto = cat
                .themes
                .iter()
                .find(|t| t.name == want)
                .ok_or_else(|| {
                    anyhow!(
                        "unknown theme '{want}'; available: {}",
                        cat.themes
                            .iter()
                            .map(|t| t.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
            Ok(theme_from_dto(dto))
        }
        Err(_) => resolve_theme(cfg, override_name),
    }
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct LoginData {
    token: String,
    user: LoginUser,
}

#[derive(Debug, Deserialize)]
struct LoginUser {
    username: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Group {
    id: String,
    name: String,
    members: Vec<GroupSession>,
}

/// Shape returned by `GET /api/cli/groups`. Bundles the server
/// directory and the caller's "server label" preference into the same
/// response so `managet ls` can render the same labels as the dashboard
/// without a second round-trip.
#[derive(Debug, Clone, Deserialize)]
struct GroupListPayload {
    groups: Vec<Group>,
    #[serde(default)]
    servers: Vec<CliServer>,
    /// Every live session the dashboard knows about, across all servers.
    /// `managet ls` uses this to list standalone terminals on *other*
    /// hosts; the local agent only reports its own. Older dashboards omit
    /// it (hence `default`).
    #[serde(default)]
    sessions: Vec<GroupSession>,
    #[serde(default)]
    preferences: GroupListPreferences,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupListPreferences {
    /// "host" or "name". Matches the dashboard's group-mosaic title-bar
    /// setting. Defaults to "host" when the server can't supply it (e.g.
    /// older builds).
    #[serde(default = "default_label_preference")]
    group_view_server_label: String,
}

impl Default for GroupListPreferences {
    fn default() -> Self {
        Self {
            group_view_server_label: default_label_preference(),
        }
    }
}

fn default_label_preference() -> String {
    "host".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupSession {
    id: String,
    server_id: String,
    session_name: String,
    status: String,
    #[serde(default)]
    group_order_index: Option<usize>,
    /// Set when this session belongs to a group. Used by `managet ls` to
    /// keep grouped sessions out of the "individual sessions" sections
    /// (they're shown under "Group sessions" instead). Absent on payloads
    /// that don't carry it (e.g. group members), hence `default`.
    #[serde(default)]
    group_id: Option<String>,
    /// Live count of clients (browser + CLI) currently attached to this
    /// session, as reported by its agent. `None` when the dashboard
    /// couldn't reach the agent (unknown) or on payloads that don't carry
    /// it. Drives the attached/detached indicator in `managet ls`.
    #[serde(default)]
    attached_clients: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct CliGroupDetail {
    group: Group,
    layout: Option<GroupLayout>,
    servers: Vec<CliServer>,
    /// Free standalone sessions eligible to join this group (not in a
    /// stack, not in another group, still alive). Drives the "existing
    /// terminals" section of the Ctrl-A N picker. Older dashboards omit it.
    /// The API sends this as `freeSessions` (camelCase).
    #[serde(default, rename = "freeSessions")]
    free_sessions: Vec<GroupSession>,
}

#[derive(Debug, Clone, Deserialize)]
struct AddMemberResponse {
    session: AddedSession,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddedSession {
    #[serde(rename = "sessionName")]
    session_name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CliServer {
    id: String,
    name: String,
    host: String,
    username: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct GroupLayout {
    #[serde(rename = "rowHeights")]
    row_heights: Vec<f64>,
    #[serde(rename = "colWidthsByRow")]
    col_widths_by_row: Vec<Vec<f64>>,
    #[serde(rename = "rowPartition", skip_serializing_if = "Option::is_none")]
    row_partition: Option<Vec<usize>>,
    #[serde(rename = "fontSizeBySession", skip_serializing_if = "Option::is_none")]
    font_size_by_session: Option<HashMap<String, u16>>,
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
}

struct Pane {
    /// `None` marks a placeholder pane — a stack service that isn't
    /// running yet. Group panes are always `Some` (a group only ever
    /// holds live sessions). When `None`, the pane renders a "not
    /// running" body and is never attached/resized over the WS.
    session: Option<GroupSession>,
    /// Stable slot identity used for reconcile matching and titles. For
    /// group panes this mirrors `session.id`; for stack panes it's the
    /// service id (which survives even when the service isn't running).
    slot_key: String,
    /// Display title: a group session's name, or a stack service's name.
    title: String,
    server_label: String,
    rect: Rect,
    parser: vt100::Parser,
    lost: Option<String>,
    /// Live resource readout for stack panes (CPU/mem from the session,
    /// host temp from the server's latest metric snapshot). `None` for
    /// group panes, which don't surface per-pane stats.
    stats: Option<PaneStats>,
}

/// Compact per-pane resource readout shown on the bottom border of a stack
/// pane. All fields optional — an older agent or a host with no sensor
/// leaves the corresponding slot blank.
#[derive(Debug, Clone, Default)]
struct PaneStats {
    cpu_percent: Option<f64>,
    memory_mb: Option<u64>,
    cpu_temp_c: Option<f64>,
}

impl PaneStats {
    /// True when there's at least one value worth drawing.
    fn any(&self) -> bool {
        self.cpu_percent.is_some() || self.memory_mb.is_some() || self.cpu_temp_c.is_some()
    }
    /// `12.3% · 256MB · 54°C`, skipping absent fields.
    fn label(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(c) = self.cpu_percent {
            parts.push(format!("{c:.1}%"));
        }
        if let Some(m) = self.memory_mb {
            parts.push(format!("{m}MB"));
        }
        if let Some(t) = self.cpu_temp_c {
            parts.push(format!("{t:.0}°C"));
        }
        parts.join(" · ")
    }
}

/// One selectable entry in the Ctrl-A N picker: attach an EXISTING free
/// session, or launch a NEW session on a server.
#[derive(Clone)]
enum PickerChoice {
    Existing { session_id: String, label: String },
    NewOnServer { server_id: String, label: String },
}

impl PickerChoice {
    fn label(&self) -> &str {
        match self {
            PickerChoice::Existing { label, .. } => label,
            PickerChoice::NewOnServer { label, .. } => label,
        }
    }
}

/// Build the picker's combined choice list: existing free sessions first
/// (so they're the quick default), then "launch new" per server.
fn build_picker_choices(
    free_sessions: &[GroupSession],
    servers: &[CliServer],
) -> Vec<PickerChoice> {
    let mut out = Vec::new();
    for s in free_sessions {
        let server = servers
            .iter()
            .find(|sv| sv.id == s.server_id)
            .map(|sv| if sv.name.is_empty() { sv.host.clone() } else { sv.name.clone() })
            .unwrap_or_else(|| short_id(&s.server_id));
        out.push(PickerChoice::Existing {
            session_id: s.id.clone(),
            label: format!("{}  ({})", s.session_name, server),
        });
    }
    for sv in servers {
        let label = if sv.name.is_empty() {
            format!("{}@{}", sv.username, sv.host)
        } else {
            format!("{}  ({}@{})", sv.name, sv.username, sv.host)
        };
        out.push(PickerChoice::NewOnServer {
            server_id: sv.id.clone(),
            label,
        });
    }
    out
}

/// Inline picker state when the user hits Ctrl-A N. The view previews a
/// layout one slot larger (existing panes shrink), and the new slot lists
/// the available choices (existing free sessions + launch-new servers).
/// Confirm attaches/creates; cancel restores the prior layout.
struct PickerState {
    /// Rect of the empty new slot — picker is drawn here.
    target_rect: Rect,
    /// Highlighted index into `choices`.
    selected: usize,
    /// The combined existing-sessions + launch-new-servers list.
    choices: Vec<PickerChoice>,
    /// Layout/partition to restore if the user cancels or the API call
    /// fails. Saved at entry so a poll that fires mid-pick can't
    /// clobber the user's prior view.
    saved_layout: GroupLayout,
    saved_partition: Vec<usize>,
}

enum PickerKeyResult {
    Idle,
    Confirm,
    Cancel,
}

/// Y/n confirmation overlay anchored over the focused pane. Used for
/// destructive shortcuts (currently just Ctrl-A K → kill session) so a
/// stray keystroke can't accidentally tear down a shell.
struct ConfirmState {
    target_session_id: String,
    target_session_name: String,
    target_rect: Rect,
    action: ConfirmAction,
}

#[derive(Clone, Copy)]
enum ConfirmAction {
    KillSession,
}

enum ConfirmKeyResult {
    Confirm,
    Cancel,
    Idle,
}

pub async fn run_login(
    api_url: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<()> {
    let api_url = normalize_api_url(
        api_url
            .or_else(|| std::env::var("MANAGET_API_URL").ok())
            .ok_or_else(|| anyhow!("missing --api-url (or MANAGET_API_URL)"))?,
    )?;
    let username = match username {
        Some(v) => v,
        None => Text::new("Dashboard username")
            .prompt()
            .context("reading username")?,
    };
    let password = match password {
        Some(v) => v,
        None => Password::new("Dashboard password")
            .without_confirmation()
            .prompt()
            .context("reading password")?,
    };

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{api_url}/api/cli/login"))
        .json(&serde_json::json!({
            "username": username,
            "password": password,
            "name": hostname_label(),
        }))
        .send()
        .await
        .context("calling dashboard login")?;
    if !res.status().is_success() {
        bail!("dashboard login failed: HTTP {}", res.status());
    }
    let envelope: ApiEnvelope<LoginData> = res.json().await.context("parsing login response")?;
    // Preserve any theme already chosen on this host across re-logins.
    let theme = load_config().ok().and_then(|c| c.theme);
    let cfg = DashboardCliConfig {
        api_url,
        token: envelope.data.token,
        theme,
    };
    save_config(&cfg)?;
    println!(
        "Logged in to {} as {}",
        cfg.api_url, envelope.data.user.username
    );
    Ok(())
}

/// List the mosaic theme presets with an inline color swatch, marking the
/// one currently selected (config `theme`, or `default`). Doesn't require
/// being logged in — themes are a local rendering preference.
/// Render one row of `managet theme list`: marker + name (+ `*` for customs),
/// a swatch of key role colors, and a line-style preview in the border color.
fn print_theme_row(name: &str, th: &Theme, active: bool, builtin: bool) -> Result<()> {
    let marker = if active { "●" } else { "○" };
    let swatch_colors = [
        th.border_active,
        th.accent,
        th.heading,
        th.server_label,
        th.status_running,
        th.status_idle,
        th.status_closed,
    ];
    let mut stdout = std::io::stdout();
    let tag = if builtin { "" } else { " *" };
    let name_label = format!("{marker} {name}{tag}");
    queue!(
        stdout,
        Print("  "),
        SetForegroundColor(if active { Color::White } else { Color::Grey }),
        SetAttribute(if active { Attribute::Bold } else { Attribute::Reset }),
        Print(format!("{:<24}", name_label)),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;
    for c in swatch_colors {
        queue!(stdout, SetForegroundColor(c), Print("██"))?;
    }
    queue!(
        stdout,
        Print(" "),
        SetForegroundColor(th.border_active),
        Print(format!("{}{}{}", th.borders.tl, th.borders.h, th.borders.tr)),
        ResetColor,
        Print("\n"),
    )?;
    stdout.flush()?;
    Ok(())
}

pub async fn run_theme_list() -> Result<()> {
    println!("{}", "Mosaic themes".magenta().bold());

    // Prefer the server catalog (built-ins + web-designed customs + the synced
    // active selection); fall back to the compiled-in presets when offline.
    let rows: Vec<(String, Theme, bool)>;
    let active: String;
    let offline;
    match load_config() {
        Ok(cfg) => match fetch_theme_catalog(&cfg).await {
            Ok(cat) => {
                offline = false;
                active = cat.active.clone();
                rows = cat
                    .themes
                    .iter()
                    .map(|t| (t.name.clone(), theme_from_dto(t), t.builtin))
                    .collect();
            }
            Err(_) => {
                offline = true;
                active = cfg.theme.clone().unwrap_or_else(|| "default".to_string());
                rows = preset_names()
                    .iter()
                    .filter_map(|n| theme_by_name(n).map(|t| (n.to_string(), t, true)))
                    .collect();
            }
        },
        Err(_) => {
            offline = true;
            active = "default".to_string();
            rows = preset_names()
                .iter()
                .filter_map(|n| theme_by_name(n).map(|t| (n.to_string(), t, true)))
                .collect();
        }
    }

    for (name, th, builtin) in &rows {
        print_theme_row(name, th, name == &active, *builtin)?;
    }
    println!();
    if offline {
        println!(
            "  {}",
            "(offline — built-in presets only; log in to sync custom themes)".dark_grey()
        );
    }
    println!(
        "  {} {}",
        "Set with:".dark_grey(),
        "managet theme set <name>".white(),
    );
    println!(
        "  {} {}",
        "Design more:".dark_grey(),
        "dashboard → Settings → Mosaic Themes".white(),
    );
    Ok(())
}

/// Set the active mosaic theme on the server (so it syncs to the dashboard
/// and other devices) and cache it locally for offline `--theme` fallback.
/// Requires `managet login`. Built-in names AND custom theme names are valid.
pub async fn run_theme_set(name: String) -> Result<()> {
    let mut cfg = load_config()?;
    // The server validates the name against built-ins ∪ the user's customs.
    put_json(
        &cfg,
        "/api/cli/themes/active",
        &serde_json::json!({ "name": name }),
    )
    .await?;
    cfg.theme = Some(name.clone());
    save_config(&cfg)?;
    println!("{} {}", "Theme set to".green(), name.white().bold());
    Ok(())
}

/// Best-effort lookup of sessionId → groupName for every member of every
/// group on the dashboard. Returns an empty map (silently) when the
/// CLI isn't logged in or the dashboard is unreachable — `managet ls`
/// should still print the local section in that case, just without the
/// `[groupName]` annotations.
pub async fn fetch_session_group_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(cfg) = load_config() else { return map; };
    let Ok(payload) = fetch_group_list_payload(&cfg).await else { return map; };
    for g in &payload.groups {
        for m in &g.members {
            map.insert(m.id.clone(), g.name.clone());
        }
    }
    map
}

/// What the Ctrl-A G prompt resolved to.
enum GroupChoice {
    /// Create a brand-new group with this (trimmed, non-empty) name.
    CreateNew(String),
    /// Add the session to this existing group id.
    Existing(String),
}

/// Interactive prompt fired from a solo `managet attach` via Ctrl-A G:
/// add the attached session to a group. A purpose-built picker (not
/// `inquire`) so the primary action — "create a new group" — has an inline
/// editable name field with the cursor already in it: type a name, press
/// Enter, and you're dropped into the new group's mosaic. Arrow down to
/// pick an existing group instead. Best-effort: missing login / unreachable
/// dashboard / API errors print a line and return None.
///
/// Returns `Some(group_id)` of the group the session was added to / created,
/// so the caller can immediately open that group's mosaic; `None` on cancel
/// or error.
pub async fn run_attach_group_prompt(session_id: String) -> Result<Option<String>> {
    let cfg = match load_config() {
        Ok(c) => c,
        Err(_) => {
            println!("\r\nNot logged in — run `managet login` first.");
            return Ok(None);
        }
    };
    let payload = match fetch_group_list_payload(&cfg).await {
        Ok(p) => p,
        Err(e) => {
            println!("\r\nCould not reach the dashboard: {e}");
            return Ok(None);
        }
    };

    let groups: Vec<(String, String)> = payload
        .groups
        .iter()
        .map(|g| (g.id.clone(), g.name.clone()))
        .collect();

    let choice = match prompt_group_choice(&groups) {
        Some(c) => c,
        None => return Ok(None), // cancelled
    };

    match choice {
        GroupChoice::CreateNew(name) => {
            let body = serde_json::json!({ "name": name, "sessionId": session_id });
            match post_json::<_, serde_json::Value>(&cfg, "/api/cli/groups", &body).await {
                Ok(group) => {
                    println!(
                        "{} created group {} — opening…",
                        "✓".green(),
                        name.white().bold()
                    );
                    Ok(group
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()))
                }
                Err(e) => {
                    println!("{} {e}", "✗".red());
                    Ok(None)
                }
            }
        }
        GroupChoice::Existing(group_id) => {
            let name = groups
                .iter()
                .find(|(id, _)| *id == group_id)
                .map(|(_, n)| n.clone())
                .unwrap_or_default();
            let body = serde_json::json!({ "sessionId": session_id });
            match post_json::<_, serde_json::Value>(
                &cfg,
                &format!("/api/cli/groups/{group_id}/members"),
                &body,
            )
            .await
            {
                Ok(_) => {
                    println!("{} added to {} — opening…", "✓".green(), name.white().bold());
                    Ok(Some(group_id))
                }
                Err(e) => {
                    println!("{} {e}", "✗".red());
                    Ok(None)
                }
            }
        }
    }
}

/// Render + drive the Ctrl-A G group picker. Row 0 is the "create a new
/// group" action with an inline name field; rows 1.. are existing groups
/// (id, name). Returns the user's choice, or None on Esc / Ctrl-C / empty.
///
/// Draws inline (no alt-screen) in raw mode, repainting in place each key.
fn prompt_group_choice(groups: &[(String, String)]) -> Option<GroupChoice> {
    let mut stdout = std::io::stdout();
    if enable_raw_mode().is_err() {
        return None;
    }

    let mut selected: usize = 0; // 0 = create row, 1..=len = existing group
    let mut name = String::new();
    let mut prev_lines: u16 = 0;

    let draw = |stdout: &mut Stdout, selected: usize, name: &str, prev: u16| -> u16 {
        let _ = if prev > 0 {
            queue!(
                stdout,
                MoveUp(prev),
                MoveToColumn(0),
                Clear(ClearType::FromCursorDown)
            )
        } else {
            queue!(stdout, MoveToColumn(0), Clear(ClearType::FromCursorDown))
        };

        let mut lines = 0u16;
        let _ = queue!(
            stdout,
            Print("Add this terminal to a group:".white().bold()),
            Print(
                "   ↑/↓ move · type a name · Enter confirm · Esc cancel"
                    .dark_grey()
            ),
            Print("\r\n")
        );
        lines += 1;

        // Create row.
        let marker = if selected == 0 { "›".green() } else { " ".stylize() };
        let label = "➕ Create a new group: ".stylize();
        let typed = if name.is_empty() {
            "(type a name)".to_string().dark_grey()
        } else {
            name.to_string().white().bold()
        };
        let cursor = if selected == 0 { "▌".grey() } else { "".stylize() };
        let _ = queue!(
            stdout,
            Print(" "),
            Print(marker),
            Print(" "),
            Print(label),
            Print(typed),
            Print(cursor),
            Print("\r\n")
        );
        lines += 1;

        // Existing groups.
        for (i, (_, gname)) in groups.iter().enumerate() {
            let row = i + 1;
            let marker = if selected == row {
                "›".green()
            } else {
                " ".stylize()
            };
            let name_styled = if selected == row {
                gname.clone().white().bold()
            } else {
                gname.clone().stylize()
            };
            let _ = queue!(
                stdout,
                Print(" "),
                Print(marker),
                Print("   "),
                Print(name_styled),
                Print("\r\n")
            );
            lines += 1;
        }
        let _ = stdout.flush();
        lines
    };

    let result = loop {
        prev_lines = draw(&mut stdout, selected, &name, prev_lines);
        let ev = match event::read() {
            Ok(ev) => ev,
            Err(_) => break None,
        };
        let Event::Key(key) = ev else { continue };
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => break None,
            KeyCode::Char('c') if ctrl => break None,
            KeyCode::Up => {
                if selected > 0 {
                    selected -= 1;
                }
            }
            KeyCode::Down => {
                if selected < groups.len() {
                    selected += 1;
                }
            }
            KeyCode::Enter => {
                if selected == 0 {
                    let trimmed = name.trim();
                    if !trimmed.is_empty() {
                        break Some(GroupChoice::CreateNew(trimmed.to_string()));
                    }
                    // Empty name — ignore Enter, keep prompting.
                } else {
                    break Some(GroupChoice::Existing(groups[selected - 1].0.clone()));
                }
            }
            KeyCode::Backspace if selected == 0 => {
                name.pop();
            }
            KeyCode::Char(c) if selected == 0 && !ctrl => {
                name.push(c);
            }
            _ => {}
        }
    };

    let _ = disable_raw_mode();
    // Land the cursor on a fresh line below the picker so subsequent
    // messages (and the mosaic) start clean.
    println!("\r");
    result
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl-A P in attach)
// ---------------------------------------------------------------------------

/// One saved palette command. Wire-compatible with /api/cli/palette
/// (which shares storage with the web overlay's /api/palette).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PaletteEntryDto {
    slot: u8,
    #[serde(default)]
    label: Option<String>,
    command: String,
}

#[derive(Debug, Deserialize)]
struct PalettePayload {
    commands: Vec<PaletteEntryDto>,
}

enum PaletteAction {
    Paste(String),
    Save(PaletteEntryDto),
    Delete(u8),
    Move(u8, i8),
    Quit,
}

/// Ctrl-A P entry point, called from the attach loop with raw mode
/// suspended. Shows the user's saved commands (slots 1-9), lets them
/// add/edit/delete/reorder, and returns `Some(command)` when one is
/// picked so the caller can write it into the PTY. Mutations are
/// persisted to the dashboard immediately, so the web overlay sees the
/// same list.
pub async fn run_attach_palette() -> Result<Option<String>> {
    let cfg = match load_config() {
        Ok(c) => c,
        Err(_) => {
            println!("\r\nNot logged in — run `managet login` first.");
            return Ok(None);
        }
    };
    let mut entries = match get_json::<PalettePayload>(&cfg, "/api/cli/palette").await {
        Ok(p) => p.commands,
        Err(e) => {
            println!("\r\nCould not reach the dashboard: {e}");
            return Ok(None);
        }
    };
    entries.sort_by_key(|e| e.slot);

    let mut selected: u8 = entries.first().map(|e| e.slot).unwrap_or(1);
    loop {
        let action = prompt_palette(&entries, selected);
        match action {
            PaletteAction::Paste(cmd) => return Ok(Some(cmd)),
            PaletteAction::Quit => return Ok(None),
            PaletteAction::Save(entry) => {
                selected = entry.slot;
                entries.retain(|e| e.slot != entry.slot);
                entries.push(entry);
                entries.sort_by_key(|e| e.slot);
            }
            PaletteAction::Delete(slot) => {
                selected = slot;
                entries.retain(|e| e.slot != slot);
            }
            PaletteAction::Move(slot, delta) => {
                let target = slot as i16 + delta as i16;
                if !(1..=9).contains(&target) {
                    continue;
                }
                let target = target as u8;
                for e in entries.iter_mut() {
                    if e.slot == slot {
                        e.slot = target;
                    } else if e.slot == target {
                        e.slot = slot;
                    }
                }
                entries.sort_by_key(|e| e.slot);
                selected = target;
            }
        }
        // Everything except Paste/Quit mutated the list — persist it.
        let body = serde_json::json!({ "commands": entries });
        if let Err(e) = put_json(&cfg, "/api/cli/palette", &body).await {
            println!("\r\n{} saving palette: {e}", "✗".red());
            // Re-sync so the next draw shows what's actually stored.
            if let Ok(p) = get_json::<PalettePayload>(&cfg, "/api/cli/palette").await {
                entries = p.commands;
                entries.sort_by_key(|e| e.slot);
            }
        }
    }
}

enum PaletteMode {
    Browse,
    Edit {
        slot: u8,
        label: String,
        command: String,
        /// 0 = label field, 1 = command field.
        field: usize,
    },
}

/// Render + drive one round of the palette overlay. Inline (no
/// alt-screen) raw-mode repaint-in-place, same approach as
/// `prompt_group_choice`. Returns on any action that ends the round —
/// paste/quit end the overlay; save/delete/move are applied + persisted
/// by `run_attach_palette`, which then re-enters with the fresh list.
fn prompt_palette(entries: &[PaletteEntryDto], initial: u8) -> PaletteAction {
    let mut stdout = std::io::stdout();
    if enable_raw_mode().is_err() {
        return PaletteAction::Quit;
    }

    let mut selected: u8 = initial.clamp(1, 9);
    let mut mode = PaletteMode::Browse;
    let mut prev_lines: u16 = 0;
    let width = terminal::size().map(|(c, _)| c as usize).unwrap_or(80);

    let result = loop {
        prev_lines = draw_palette(&mut stdout, entries, selected, &mode, prev_lines, width);
        let ev = match event::read() {
            Ok(ev) => ev,
            Err(_) => break PaletteAction::Quit,
        };
        let Event::Key(key) = ev else { continue };
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);

        match &mut mode {
            PaletteMode::Browse => {
                let entry_at = |slot: u8| entries.iter().find(|e| e.slot == slot);
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') => break PaletteAction::Quit,
                    KeyCode::Char('c') if ctrl => break PaletteAction::Quit,
                    KeyCode::Up if shift => {
                        if entry_at(selected).is_some() && selected > 1 {
                            break PaletteAction::Move(selected, -1);
                        }
                    }
                    KeyCode::Down if shift => {
                        if entry_at(selected).is_some() && selected < 9 {
                            break PaletteAction::Move(selected, 1);
                        }
                    }
                    KeyCode::Up => {
                        if selected > 1 {
                            selected -= 1;
                        }
                    }
                    KeyCode::Down => {
                        if selected < 9 {
                            selected += 1;
                        }
                    }
                    KeyCode::Char(c @ '1'..='9') => {
                        let slot = c as u8 - b'0';
                        if let Some(e) = entry_at(slot) {
                            break PaletteAction::Paste(e.command.clone());
                        }
                        selected = slot;
                    }
                    KeyCode::Enter => match entry_at(selected) {
                        Some(e) => break PaletteAction::Paste(e.command.clone()),
                        None => {
                            mode = PaletteMode::Edit {
                                slot: selected,
                                label: String::new(),
                                command: String::new(),
                                field: 0,
                            };
                        }
                    },
                    KeyCode::Char('a') | KeyCode::Char('A') => {
                        // Add at the selected slot if free, else the first
                        // free slot; ignore when all 9 are taken.
                        let free = if entry_at(selected).is_none() {
                            Some(selected)
                        } else {
                            (1..=9u8).find(|s| entry_at(*s).is_none())
                        };
                        if let Some(slot) = free {
                            selected = slot;
                            mode = PaletteMode::Edit {
                                slot,
                                label: String::new(),
                                command: String::new(),
                                field: 0,
                            };
                        }
                    }
                    KeyCode::Char('e') | KeyCode::Char('E') => {
                        if let Some(e) = entry_at(selected) {
                            mode = PaletteMode::Edit {
                                slot: e.slot,
                                label: e.label.clone().unwrap_or_default(),
                                command: e.command.clone(),
                                field: 1,
                            };
                        }
                    }
                    KeyCode::Char('d') | KeyCode::Char('D') | KeyCode::Delete => {
                        if entry_at(selected).is_some() {
                            break PaletteAction::Delete(selected);
                        }
                    }
                    KeyCode::Char('[') => {
                        if entry_at(selected).is_some() && selected > 1 {
                            break PaletteAction::Move(selected, -1);
                        }
                    }
                    KeyCode::Char(']') => {
                        if entry_at(selected).is_some() && selected < 9 {
                            break PaletteAction::Move(selected, 1);
                        }
                    }
                    _ => {}
                }
            }
            PaletteMode::Edit {
                slot,
                label,
                command,
                field,
            } => match key.code {
                KeyCode::Esc => mode = PaletteMode::Browse,
                KeyCode::Char('c') if ctrl => mode = PaletteMode::Browse,
                KeyCode::Tab | KeyCode::Up | KeyCode::Down => *field = (*field + 1) % 2,
                KeyCode::Enter => {
                    let cmd = command.trim();
                    if !cmd.is_empty() {
                        let lbl = label.trim();
                        break PaletteAction::Save(PaletteEntryDto {
                            slot: *slot,
                            label: if lbl.is_empty() {
                                None
                            } else {
                                Some(lbl.to_string())
                            },
                            command: cmd.to_string(),
                        });
                    }
                    // Empty command — jump to the command field instead.
                    *field = 1;
                }
                KeyCode::Backspace => {
                    if *field == 0 {
                        label.pop();
                    } else {
                        command.pop();
                    }
                }
                KeyCode::Char(c) if !ctrl => {
                    if *field == 0 {
                        if label.chars().count() < 60 {
                            label.push(c);
                        }
                    } else if command.chars().count() < 4000 {
                        command.push(c);
                    }
                }
                _ => {}
            },
        }
    };

    let _ = disable_raw_mode();
    println!("\r");
    result
}

/// Truncate to `max` visible chars with a trailing ellipsis.
fn palette_truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

fn draw_palette(
    stdout: &mut Stdout,
    entries: &[PaletteEntryDto],
    selected: u8,
    mode: &PaletteMode,
    prev: u16,
    width: usize,
) -> u16 {
    let _ = if prev > 0 {
        queue!(
            stdout,
            MoveUp(prev),
            MoveToColumn(0),
            Clear(ClearType::FromCursorDown)
        )
    } else {
        queue!(stdout, MoveToColumn(0), Clear(ClearType::FromCursorDown))
    };

    let mut lines = 0u16;
    let _ = queue!(
        stdout,
        Print("Command palette".white().bold()),
        Print(
            "   ↑/↓ · Enter/1-9 paste · a add · e edit · d delete · [ ] move · Esc close"
                .dark_grey()
        ),
        Print("\r\n")
    );
    lines += 1;

    let editing_slot = match mode {
        PaletteMode::Edit { slot, .. } => Some(*slot),
        PaletteMode::Browse => None,
    };
    // Width available for the command preview after " › [n] " and label.
    let preview_max = width.saturating_sub(12).max(20);

    for slot in 1..=9u8 {
        let entry = entries.iter().find(|e| e.slot == slot);
        let is_sel = slot == selected;
        let marker = if is_sel { "›".green() } else { " ".stylize() };
        let num = if entry.is_some() {
            format!("[{slot}]").white().bold()
        } else {
            format!("[{slot}]").dark_grey()
        };
        let _ = queue!(stdout, Print(" "), Print(marker), Print(" "), Print(num), Print(" "));
        match entry {
            None => {
                let hint = if editing_slot == Some(slot) {
                    "(adding…)".to_string().green()
                } else {
                    "(empty)".to_string().dark_grey()
                };
                let _ = queue!(stdout, Print(hint));
            }
            Some(e) => {
                let mut budget = preview_max;
                if let Some(lbl) = e.label.as_deref().filter(|l| !l.is_empty()) {
                    let shown = palette_truncate(lbl, 30);
                    budget = budget.saturating_sub(shown.chars().count() + 3);
                    let styled = if is_sel {
                        shown.white().bold()
                    } else {
                        shown.stylize()
                    };
                    let _ = queue!(stdout, Print(styled), Print(" — ".dark_grey()));
                }
                let cmd = palette_truncate(&e.command, budget.max(10));
                let _ = queue!(stdout, Print(cmd.dark_grey()));
            }
        }
        let _ = queue!(stdout, Print("\r\n"));
        lines += 1;
    }

    if let PaletteMode::Edit {
        slot,
        label,
        command,
        field,
    } = mode
    {
        let _ = queue!(
            stdout,
            Print(format!(" Edit [{slot}]").white().bold()),
            Print("   Tab next field · Enter save · Esc cancel".dark_grey()),
            Print("\r\n")
        );
        lines += 1;
        let cursor0 = if *field == 0 { "▌".grey() } else { "".stylize() };
        let cursor1 = if *field == 1 { "▌".grey() } else { "".stylize() };
        let label_shown = palette_truncate(label, width.saturating_sub(14).max(10));
        let _ = queue!(
            stdout,
            Print("   Label:   ".dark_grey()),
            Print(label_shown.as_str().stylize()),
            Print(cursor0),
            Print("\r\n")
        );
        lines += 1;
        // Show the tail of long commands so the caret area is always
        // what the user is editing.
        let cmd_budget = width.saturating_sub(14).max(10);
        let cmd_shown: String = if command.chars().count() > cmd_budget {
            let tail: String = command
                .chars()
                .skip(command.chars().count() - (cmd_budget - 1))
                .collect();
            format!("…{tail}")
        } else {
            command.clone()
        };
        let _ = queue!(
            stdout,
            Print("   Command: ".dark_grey()),
            Print(cmd_shown.as_str().stylize()),
            Print(cursor1),
            Print("\r\n")
        );
        lines += 1;
    }

    let _ = stdout.flush();
    lines
}

pub async fn run_group_list() -> Result<()> {
    let cfg = load_config()?;
    let payload = fetch_group_list_payload(&cfg).await?;
    if payload.groups.is_empty() {
        println!("{}", "Group sessions".magenta().bold());
        println!("  {}", "(no groups yet)".dark_grey());
        return Ok(());
    }
    print_group_rows(&payload);
    Ok(())
}

/// The dashboard-derived sections appended to `managet ls`:
/// "Individual sessions from other servers" and "Group sessions". Silent
/// (one dim hint line) when the user hasn't run `managet login` yet, since
/// a fresh host should still get a useful local listing.
///
/// `local_ids` are the session ids already printed under "from this
/// server" so we don't list them again as "other servers".
pub async fn print_dashboard_ls_sections(
    local_ids: &HashSet<String>,
    show_sessions: bool,
    show_groups: bool,
    show_stacks: bool,
) -> Result<()> {
    println!();
    // Print only the requested section headers with a one-line reason
    // (offline / unreachable), so a filtered `managet ls -g` doesn't emit
    // noise about sections the user didn't ask for.
    let placeholder = |reason: &str| {
        if show_sessions {
            println!("{}", "Individual sessions from other servers".cyan().bold());
            println!("  {}", reason.dark_grey());
            println!();
        }
        if show_groups {
            println!("{}", "Group sessions".magenta().bold());
            println!("  {}", reason.dark_grey());
            println!();
        }
        if show_stacks {
            println!("{}", "Stacks".magenta().bold());
            println!("  {}", reason.dark_grey());
        }
    };
    let cfg = match load_config() {
        Ok(cfg) => cfg,
        Err(_) => {
            placeholder("(run `managet login` to list dashboard items)");
            return Ok(());
        }
    };

    if show_sessions || show_groups {
        match fetch_group_list_payload(&cfg).await {
            Ok(payload) => {
                if show_sessions {
                    // Include grouped sessions (annotated) when the Groups
                    // section isn't shown, so a sessions-only view is complete.
                    print_other_servers_section(&payload, local_ids, !show_groups);
                    println!();
                }
                if show_groups {
                    if payload.groups.is_empty() {
                        println!("{}", "Group sessions".magenta().bold());
                        println!("  {}", "(no groups yet)".dark_grey());
                    } else {
                        print_group_rows(&payload);
                    }
                    println!();
                }
            }
            Err(e) => {
                let reason = format!("(dashboard unreachable: {e})");
                if show_sessions {
                    println!("{}", "Individual sessions from other servers".cyan().bold());
                    println!("  {}", reason.as_str().dark_grey());
                    println!();
                }
                if show_groups {
                    println!("{}", "Group sessions".magenta().bold());
                    println!("  {}", reason.as_str().dark_grey());
                    println!();
                }
            }
        }
    }

    if show_stacks {
        match fetch_stack_list_payload(&cfg).await {
            Ok(sp) if !sp.stacks.is_empty() => print_stack_rows(&sp),
            Ok(_) => {
                println!("{}", "Stacks".magenta().bold());
                println!("  {}", "(no stacks yet)".dark_grey());
            }
            Err(e) => {
                println!("{}", "Stacks".magenta().bold());
                println!("  {}", format!("(dashboard unreachable: {e})").dark_grey());
            }
        }
        println!();
    }

    if show_sessions || show_groups {
        println!(
            "  {} {} {} {}",
            "Attach:".dark_grey(),
            "managet attach <name>".white(),
            "•".dark_grey(),
            "managet group attach <name>".white(),
        );
    }
    Ok(())
}

/// Attached/detached state derived from a session's live client count.
/// `Unknown` carries the liveness status string as a fallback for when
/// the dashboard couldn't reach the agent to count clients.
enum Liveness {
    Attached(u32),
    Detached,
    Unknown(String),
}

fn liveness_of(attached_clients: Option<u32>, status: &str) -> Liveness {
    match attached_clients {
        Some(n) if n > 0 => Liveness::Attached(n),
        Some(_) => Liveness::Detached,
        None => Liveness::Unknown(status.to_string()),
    }
}

impl Liveness {
    fn bullet(&self) -> StyledContent<&'static str> {
        match self {
            Liveness::Attached(_) => "●".green(),
            Liveness::Detached => "○".yellow(),
            Liveness::Unknown(_) => "•".dark_grey(),
        }
    }
    /// Plain (un-styled) label, so callers can pad to a column width
    /// before applying color.
    fn label(&self) -> String {
        match self {
            Liveness::Attached(n) => format!("attached×{n}"),
            Liveness::Detached => "detached".to_string(),
            Liveness::Unknown(s) => s.clone(),
        }
    }
    fn paint(&self, s: String) -> StyledContent<String> {
        match self {
            Liveness::Attached(_) => s.green(),
            Liveness::Detached => s.yellow(),
            Liveness::Unknown(_) => s.dark_grey(),
        }
    }
}

/// "Individual sessions from other servers": standalone (un-grouped) live
/// sessions the dashboard knows about on hosts *other* than this one.
/// Grouped sessions are skipped (they appear under "Group sessions"), as
/// are ids the local agent already listed under "from this server".
fn print_other_servers_section(
    payload: &GroupListPayload,
    local_ids: &HashSet<String>,
    include_grouped: bool,
) {
    println!("{}", "Individual sessions from other servers".cyan().bold());
    // group_id -> group name, for tagging in-group sessions when the
    // Groups section isn't separately shown.
    let group_name_for = |group_id: &str| -> Option<&str> {
        payload
            .groups
            .iter()
            .find(|g| g.id == group_id)
            .map(|g| g.name.as_str())
    };
    let use_friendly_name = payload.preferences.group_view_server_label == "name";
    let server_label_for = |server_id: &str| -> String {
        if let Some(s) = payload.servers.iter().find(|s| s.id == server_id) {
            if use_friendly_name && !s.name.is_empty() {
                s.name.clone()
            } else {
                s.host.clone()
            }
        } else {
            short_id(server_id)
        }
    };

    let mut others: Vec<&GroupSession> = payload
        .sessions
        .iter()
        .filter(|s| (include_grouped || s.group_id.is_none()) && !local_ids.contains(&s.id))
        .collect();
    if others.is_empty() {
        println!("  {}", "(none)".dark_grey());
        return;
    }
    // Group visually by server, then by name, so same-host terminals sit
    // together.
    others.sort_by(|a, b| {
        server_label_for(&a.server_id)
            .cmp(&server_label_for(&b.server_id))
            .then_with(|| a.session_name.cmp(&b.session_name))
    });

    let name_width = others
        .iter()
        .map(|s| s.session_name.chars().count().min(28))
        .max()
        .unwrap_or(20)
        .max(20);

    for s in &others {
        let name_col = pad_visible(&truncate(&s.session_name, name_width), name_width);
        let live = liveness_of(s.attached_clients, &s.status);
        let status_styled = live.paint(pad_visible(&live.label(), 12));
        let group_tag = match s.group_id.as_deref().and_then(group_name_for) {
            Some(name) => format!("  {}", format!("[{name}]").blue()),
            None => String::new(),
        };
        println!(
            "  {} {}  {}  {}  {}{}",
            live.bullet(),
            name_col.white().bold(),
            status_styled,
            format!("[{}]", short_id(&s.id)).dark_grey(),
            server_label_for(&s.server_id).blue(),
            group_tag,
        );
    }
}

/// Shared renderer for `managet groups` and the group section of
/// `managet ls`. Pads visible columns first, *then* colors, so ANSI
/// escapes don't disrupt alignment.
fn print_group_rows(payload: &GroupListPayload) {
    println!("{}", "Group sessions".magenta().bold());
    let use_friendly_name = payload.preferences.group_view_server_label == "name";
    let server_label_for = |server_id: &str| -> String {
        if let Some(s) = payload.servers.iter().find(|s| s.id == server_id) {
            if use_friendly_name && !s.name.is_empty() {
                s.name.clone()
            } else {
                s.host.clone()
            }
        } else {
            short_id(server_id)
        }
    };

    let name_width = payload
        .groups
        .iter()
        .map(|g| g.name.chars().count().min(28))
        .max()
        .unwrap_or(20)
        .max(16);

    let max_members_digits = payload
        .groups
        .iter()
        .map(|g| g.members.len().to_string().len())
        .max()
        .unwrap_or(1);
    // " 4 windows" / "12 windows" — pad the number so the "windows"
    // word and the divider after it line up across rows.
    let windows_col_width = max_members_digits + " windows".len();

    let member_name_width = payload
        .groups
        .iter()
        .flat_map(|g| g.members.iter())
        .map(|m| m.session_name.chars().count().min(28))
        .max()
        .unwrap_or(20)
        .max(20);

    for g in &payload.groups {
        let mut ordered = g.members.clone();
        ordered.sort_by_key(|m| m.group_order_index.unwrap_or(usize::MAX));
        let mut seen = Vec::new();
        for m in &ordered {
            if !seen.iter().any(|sid: &String| sid == &m.server_id) {
                seen.push(m.server_id.clone());
            }
        }
        let server_labels = seen
            .iter()
            .map(|sid| server_label_for(sid))
            .collect::<Vec<_>>()
            .join(", ");
        let pluralized = if g.members.len() == 1 { "window " } else { "windows" };
        let windows_text = format!("{} {}", g.members.len(), pluralized);
        let name_col = pad_visible(&truncate(&g.name, name_width), name_width);
        let windows_col = pad_visible(&windows_text, windows_col_width);
        println!(
            "  {bullet} {name} {sep} {windows} {sep} {servers}",
            bullet = "▣".magenta(),
            name = name_col.white().bold(),
            sep = "│".dark_grey(),
            windows = windows_col.cyan(),
            servers = server_labels.blue(),
        );
        // Tree sub-list: one indented row per terminal in slot order so
        // `managet ls` matches the visual order of the panes you'd see
        // in `managet group attach` or in the browser mosaic.
        let last_idx = ordered.len().saturating_sub(1);
        for (i, m) in ordered.iter().enumerate() {
            let branch = if i == last_idx { "└" } else { "├" };
            let name_cell = pad_visible(
                &truncate(&m.session_name, member_name_width),
                member_name_width,
            );
            let server = server_label_for(&m.server_id);
            let live = liveness_of(m.attached_clients, &m.status);
            println!(
                "      {branch} {name} {sep} {bullet} {state} {sep} {server}",
                branch = branch.dark_grey(),
                name = name_cell.white(),
                sep = "·".dark_grey(),
                bullet = live.bullet(),
                state = live.paint(pad_visible(&live.label(), 11)),
                server = server.blue(),
            );
        }
    }
}

pub async fn run_group_layout(selector: String, arrangement: String) -> Result<()> {
    let cfg = load_config()?;
    let group_id = resolve_group_id(&cfg, &selector).await?;
    let detail = fetch_group_detail(&cfg, &group_id).await?;
    let partition = parse_partition(&arrangement)?;
    ensure_allowed_partition(detail.group.members.len(), &partition)?;

    let mut layout = layout_for_partition(&partition);
    layout.font_size_by_session = detail
        .layout
        .and_then(|existing| existing.font_size_by_session);
    save_group_layout(&cfg, &group_id, &layout).await?;
    println!(
        "Saved layout {} for group {}",
        partition
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("+"),
        detail.group.name
    );
    Ok(())
}

pub async fn run_group_swap(selector: String, from: usize, to: usize) -> Result<()> {
    let cfg = load_config()?;
    let group_id = resolve_group_id(&cfg, &selector).await?;
    let detail = fetch_group_detail(&cfg, &group_id).await?;
    let len = detail.group.members.len();
    if from == 0 || to == 0 || from > len || to > len {
        bail!("slot numbers must be between 1 and {len}");
    }
    let mut ids = detail
        .group
        .members
        .iter()
        .map(|m| m.id.clone())
        .collect::<Vec<_>>();
    ids.swap(from - 1, to - 1);
    save_group_order(&cfg, &group_id, &ids).await?;
    println!(
        "Swapped slots {} and {} in group {}",
        from, to, detail.group.name
    );
    Ok(())
}

pub async fn run_group_add(
    selector: String,
    server_selector: Option<String>,
    name: Option<String>,
    command: Option<String>,
) -> Result<()> {
    let cfg = load_config()?;
    let group_id = resolve_group_id(&cfg, &selector).await?;
    let detail = fetch_group_detail(&cfg, &group_id).await?;

    let server_id = match server_selector {
        Some(sel) => resolve_server(&detail.servers, &sel)?,
        None => pick_server_interactive(&detail)?,
    };

    let body = serde_json::json!({
        "serverId": server_id,
        "name": name,
        "command": command,
    });
    let created: AddMemberResponse =
        post_json(&cfg, &format!("/api/cli/groups/{group_id}/members"), &body).await?;

    let server_label = detail
        .servers
        .iter()
        .find(|s| s.id == server_id)
        .map(|s| {
            if s.name.is_empty() {
                s.host.clone()
            } else {
                format!("{} ({})", s.name, s.host)
            }
        })
        .unwrap_or_else(|| short_id(&server_id));
    println!(
        "{} {} on {} (group {})",
        "Created".green().bold(),
        created.session.session_name.white().bold(),
        server_label.blue(),
        detail.group.name.magenta(),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Stacks
//
// A stack is a named bundle of services (command + server pairs) that launch
// together. Unlike groups — which gather already-running sessions — a stack
// defines what to launch, so a service may have no live session yet. The CLI
// mirrors the dashboard: `managet stacks` lists them, `managet stack launch`
// starts (all or a subset of) them, and `managet stack open` shows a mosaic
// with a placeholder pane for each not-yet-running service.
// ---------------------------------------------------------------------------

/// Shape returned by `GET /api/cli/stacks`.
#[derive(Debug, Clone, Deserialize)]
struct StackListPayload {
    stacks: Vec<StackSummary>,
    #[serde(default)]
    servers: Vec<CliServer>,
    #[serde(default)]
    runtimes: Vec<StackRuntimeDto>,
    #[serde(default)]
    preferences: GroupListPreferences,
}

#[derive(Debug, Clone, Deserialize)]
struct StackSummary {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    services: Vec<StackServiceDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackServiceDto {
    id: String,
    name: String,
    server_id: String,
    #[serde(default)]
    order_index: usize,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackRuntimeDto {
    stack_id: String,
    #[serde(default)]
    active_count: usize,
    #[serde(default)]
    total_count: usize,
    #[serde(default)]
    services: Vec<StackServiceRuntimeDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackServiceRuntimeDto {
    service_id: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    cpu_percent: Option<f64>,
    #[serde(default)]
    memory_mb: Option<u64>,
    #[serde(default)]
    cpu_temp_c: Option<f64>,
}

/// Shape returned by `GET /api/cli/stacks/[id]` — the multipane workhorse.
#[derive(Debug, Clone, Deserialize)]
struct CliStackDetail {
    stack: StackSummary,
    runtime: StackRuntimeDto,
    #[serde(default)]
    servers: Vec<CliServer>,
    /// Per-user persisted mosaic layout (Ctrl-A R). `None` until the user
    /// first resizes this stack, then the default equal-split is used.
    #[serde(default)]
    layout: Option<GroupLayout>,
    #[serde(default)]
    preferences: GroupListPreferences,
}

/// Shape of the `POST /api/cli/stacks/[id]/launch` reply (LaunchStackResponse).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchStackResult {
    #[serde(default)]
    launched: Vec<LaunchedService>,
    #[serde(default)]
    failed: Vec<FailedService>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchedService {
    server_id: String,
    session_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailedService {
    server_id: String,
    error: String,
}

async fn fetch_stack_list_payload(cfg: &DashboardCliConfig) -> Result<StackListPayload> {
    get_json::<StackListPayload>(cfg, "/api/cli/stacks").await
}

async fn fetch_stack_detail(cfg: &DashboardCliConfig, id: &str) -> Result<CliStackDetail> {
    get_json::<CliStackDetail>(cfg, &format!("/api/cli/stacks/{id}")).await
}

async fn resolve_stack_id(cfg: &DashboardCliConfig, selector: &str) -> Result<String> {
    let payload = fetch_stack_list_payload(cfg).await?;
    let hits = payload
        .stacks
        .iter()
        .filter(|s| s.id == selector || s.id.starts_with(selector) || s.name == selector)
        .collect::<Vec<_>>();
    match hits.len() {
        0 => bail!("no stack matches '{selector}'"),
        1 => Ok(hits[0].id.clone()),
        n => bail!("'{selector}' is ambiguous ({n} stacks match)"),
    }
}

/// Short server label for stack output. Honors the dashboard's
/// `groupViewServerLabel` preference: when `friendly` (the setting is
/// "name") it prefers the friendly server name, otherwise the host. Falls
/// back to the other field, then a truncated id.
fn stack_server_label(servers: &[CliServer], server_id: &str, friendly: bool) -> String {
    match servers.iter().find(|s| s.id == server_id) {
        Some(s) => {
            let (first, second) = if friendly {
                (&s.name, &s.host)
            } else {
                (&s.host, &s.name)
            };
            if !first.is_empty() {
                first.clone()
            } else if !second.is_empty() {
                second.clone()
            } else {
                short_id(server_id)
            }
        }
        None => short_id(server_id),
    }
}

/// True when the dashboard prefers friendly server names over hosts.
fn prefers_friendly_name(prefs: &GroupListPreferences) -> bool {
    prefs.group_view_server_label == "name"
}

/// Human label for a stack's rolled-up state: `active` when every service
/// is running, `partial [n/m]` when some are, `inactive` when none.
fn stack_status_label(active: usize, total: usize) -> String {
    if total == 0 {
        "empty".to_string()
    } else if active == 0 {
        "inactive".to_string()
    } else if active >= total {
        "active".to_string()
    } else {
        format!("partial [{active}/{total}]")
    }
}

pub async fn run_stack_list() -> Result<()> {
    let cfg = load_config()?;
    let payload = fetch_stack_list_payload(&cfg).await?;
    if payload.stacks.is_empty() {
        println!("{}", "Stacks".magenta().bold());
        println!("  {}", "(no stacks yet)".dark_grey());
        return Ok(());
    }
    print_stack_rows(&payload);
    Ok(())
}

/// Renderer for `managet stacks`: one row per stack with a running count
/// and the servers involved, then an indented service tree with a
/// running/idle dot. Pads visible columns before coloring so ANSI escapes
/// don't disrupt alignment — same convention as `print_group_rows`.
fn print_stack_rows(payload: &StackListPayload) {
    println!("{}", "Stacks".magenta().bold());

    let friendly = prefers_friendly_name(&payload.preferences);
    let runtime_for = |stack_id: &str| payload.runtimes.iter().find(|r| r.stack_id == stack_id);

    let name_width = payload
        .stacks
        .iter()
        .map(|s| s.name.chars().count().min(28))
        .max()
        .unwrap_or(20)
        .max(16);

    let run_texts: Vec<String> = payload
        .stacks
        .iter()
        .map(|s| {
            let rt = runtime_for(&s.id);
            let active = rt.map(|r| r.active_count).unwrap_or(0);
            let total = rt.map(|r| r.total_count).unwrap_or(s.services.len());
            stack_status_label(active, total)
        })
        .collect();
    let run_col_width = run_texts
        .iter()
        .map(|t| t.chars().count())
        .max()
        .unwrap_or(0);

    let svc_name_width = payload
        .stacks
        .iter()
        .flat_map(|s| s.services.iter())
        .map(|sv| sv.name.chars().count().min(28))
        .max()
        .unwrap_or(20)
        .max(20);

    for (stack_idx, st) in payload.stacks.iter().enumerate() {
        let rt = runtime_for(&st.id);
        let mut ordered = st.services.clone();
        ordered.sort_by_key(|s| s.order_index);

        let mut seen: Vec<String> = Vec::new();
        for sv in &ordered {
            if !seen.iter().any(|sid| sid == &sv.server_id) {
                seen.push(sv.server_id.clone());
            }
        }
        let server_labels = seen
            .iter()
            .map(|sid| stack_server_label(&payload.servers, sid, friendly))
            .collect::<Vec<_>>()
            .join(", ");

        let active = rt.map(|r| r.active_count).unwrap_or(0);
        let total = rt.map(|r| r.total_count).unwrap_or(st.services.len());
        let name_col = pad_visible(&truncate(&st.name, name_width), name_width);
        let run_col = pad_visible(&run_texts[stack_idx], run_col_width);
        // Green when fully active, yellow when partial, grey when idle.
        let run_styled = if total == 0 || active == 0 {
            run_col.dark_grey()
        } else if active >= total {
            run_col.green()
        } else {
            run_col.yellow()
        };
        println!(
            "  {bullet} {name} {sep} {run} {sep} {servers}",
            bullet = "▤".magenta(),
            name = name_col.white().bold(),
            sep = "│".dark_grey(),
            run = run_styled,
            servers = server_labels.blue(),
        );

        let svc_runtime_for = |service_id: &str| {
            rt.and_then(|r| r.services.iter().find(|s| s.service_id == service_id))
        };
        let last_idx = ordered.len().saturating_sub(1);
        for (i, sv) in ordered.iter().enumerate() {
            let branch = if i == last_idx { "└" } else { "├" };
            let running = svc_runtime_for(&sv.id)
                .map(|r| r.status == "active")
                .unwrap_or(false);
            let dot = if running {
                "●".green()
            } else {
                "○".dark_grey()
            };
            let name_cell = pad_visible(&truncate(&sv.name, svc_name_width), svc_name_width);
            let server = stack_server_label(&payload.servers, &sv.server_id, friendly);
            println!(
                "      {branch} {dot} {name} {sep} {server}",
                branch = branch.dark_grey(),
                dot = dot,
                name = name_cell.white(),
                sep = "·".dark_grey(),
                server = server.blue(),
            );
        }
    }
}

pub async fn run_stack_launch(
    selector: String,
    server_selector: Option<String>,
    service_selector: Option<String>,
    force: bool,
) -> Result<()> {
    let cfg = load_config()?;
    let stack_id = resolve_stack_id(&cfg, &selector).await?;
    let detail = fetch_stack_detail(&cfg, &stack_id).await?;

    let server_id = match &server_selector {
        Some(sel) => Some(resolve_server(&detail.servers, sel)?),
        None => None,
    };

    let service_id = match &service_selector {
        Some(sel) => {
            let hits = detail
                .stack
                .services
                .iter()
                .filter(|s| s.name == *sel || s.id == *sel || s.id.starts_with(sel.as_str()))
                .collect::<Vec<_>>();
            match hits.len() {
                0 => bail!("no service matches '{sel}' in stack '{}'", detail.stack.name),
                1 => Some(hits[0].id.clone()),
                n => bail!("'{sel}' is ambiguous ({n} services match)"),
            }
        }
        None => None,
    };

    let whole = server_id.is_none() && service_id.is_none();
    let subset: Vec<String> = detail
        .stack
        .services
        .iter()
        .filter(|s| {
            let server_ok = server_id.as_ref().map(|sid| &s.server_id == sid).unwrap_or(true);
            let service_ok = service_id.as_ref().map(|sid| &s.id == sid).unwrap_or(true);
            server_ok && service_ok
        })
        .map(|s| s.id.clone())
        .collect();
    if subset.is_empty() {
        bail!("no services match the given --server/--service filter");
    }

    let body = if whole {
        serde_json::json!({ "force": force })
    } else {
        serde_json::json!({ "force": force, "serviceIds": subset })
    };
    let result: LaunchStackResult =
        post_json(&cfg, &format!("/api/cli/stacks/{stack_id}/launch"), &body).await?;

    if result.launched.is_empty() && result.failed.is_empty() {
        println!("{}", "Nothing to launch.".dark_grey());
        return Ok(());
    }
    if !result.launched.is_empty() {
        println!(
            "{} {} service(s) in {}:",
            "Launched".green().bold(),
            result.launched.len(),
            detail.stack.name.magenta(),
        );
        let friendly = prefers_friendly_name(&detail.preferences);
        for it in &result.launched {
            let server = stack_server_label(&detail.servers, &it.server_id, friendly);
            println!(
                "  {} {} {} {}",
                "✓".green(),
                it.session_name.clone().white(),
                "on".dark_grey(),
                server.blue(),
            );
        }
    }
    if !result.failed.is_empty() {
        println!("{} {} service(s):", "Failed".red().bold(), result.failed.len());
        let friendly = prefers_friendly_name(&detail.preferences);
        for it in &result.failed {
            let server = stack_server_label(&detail.servers, &it.server_id, friendly);
            println!(
                "  {} {} {}",
                "✗".red(),
                format!("{}:", server).blue(),
                it.error.clone().red(),
            );
        }
    }
    Ok(())
}

/// `managet stack <name> start` — launch the stack (idempotently reusing
/// any already-active sessions), then drop straight into the live mosaic.
/// `launch` + `open` in one step.
pub async fn run_stack_start(
    selector: String,
    server_selector: Option<String>,
    theme_override: Option<String>,
) -> Result<()> {
    run_stack_launch(selector.clone(), server_selector.clone(), None, false).await?;
    run_stack_open(selector, server_selector, theme_override).await
}

// ---------------------------------------------------------------------------
// Stack editor — a full-screen form (navigate fields with ↑/↓, type to edit
// inline, ←/→ cycles a service's server, Enter activates an action row, Esc
// cancels). Mirrors the dashboard's create/edit form. Used by
// `managet stack edit <name>` and `managet stack new`.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ServiceForm {
    name: String,
    server_id: String,
    command: String,
    cwd: String,
}

#[derive(Clone)]
struct StackEditForm {
    name: String,
    description: String,
    services: Vec<ServiceForm>,
}

/// What the editor returns to its caller.
enum EditorOutcome {
    Save(StackEditForm),
    Delete,
    Cancel,
}

/// One navigable field in the editor, in top-to-bottom order.
#[derive(Clone, Copy, PartialEq)]
enum EditRow {
    Name,
    Description,
    SvcName(usize),
    SvcServer(usize),
    SvcCommand(usize),
    SvcCwd(usize),
    SvcRemove(usize),
    AddService,
    Save,
    Cancel,
    Delete,
}

/// Build the ordered list of navigable rows for the current form. `allow_delete`
/// adds the "Delete stack" row (edit mode only, not when creating).
fn build_edit_rows(form: &StackEditForm, allow_delete: bool) -> Vec<EditRow> {
    let mut rows = vec![EditRow::Name, EditRow::Description];
    for i in 0..form.services.len() {
        rows.push(EditRow::SvcName(i));
        rows.push(EditRow::SvcServer(i));
        rows.push(EditRow::SvcCommand(i));
        rows.push(EditRow::SvcCwd(i));
        rows.push(EditRow::SvcRemove(i));
    }
    rows.push(EditRow::AddService);
    rows.push(EditRow::Save);
    rows.push(EditRow::Cancel);
    if allow_delete {
        rows.push(EditRow::Delete);
    }
    rows
}

/// Borrow the text field a row points at, when it's a text-editable row.
fn edit_row_text<'a>(form: &'a mut StackEditForm, row: EditRow) -> Option<&'a mut String> {
    match row {
        EditRow::Name => Some(&mut form.name),
        EditRow::Description => Some(&mut form.description),
        EditRow::SvcName(i) => form.services.get_mut(i).map(|s| &mut s.name),
        EditRow::SvcCommand(i) => form.services.get_mut(i).map(|s| &mut s.command),
        EditRow::SvcCwd(i) => form.services.get_mut(i).map(|s| &mut s.cwd),
        _ => None,
    }
}

fn insert_char_at(s: &mut String, caret: &mut usize, c: char) {
    let mut chars: Vec<char> = s.chars().collect();
    let idx = (*caret).min(chars.len());
    chars.insert(idx, c);
    *s = chars.into_iter().collect();
    *caret = idx + 1;
}

fn backspace_at(s: &mut String, caret: &mut usize) {
    if *caret == 0 {
        return;
    }
    let mut chars: Vec<char> = s.chars().collect();
    let idx = *caret - 1;
    if idx < chars.len() {
        chars.remove(idx);
    }
    *s = chars.into_iter().collect();
    *caret = idx;
}

/// Cycle a service's server id to the previous/next server in the list.
fn cycle_server(servers: &[CliServer], current: &str, dir: i32) -> String {
    if servers.is_empty() {
        return current.to_string();
    }
    let pos = servers.iter().position(|s| s.id == current).unwrap_or(0);
    let len = servers.len();
    let next = if dir < 0 {
        (pos + len - 1) % len
    } else {
        (pos + 1) % len
    };
    servers[next].id.clone()
}

/// Render the editor and run its key loop. Returns the outcome. Owns the
/// terminal (raw mode + alt screen) for its lifetime; the terminal is fully
/// restored before this returns, so the caller can prompt normally after.
fn run_stack_editor(
    title: &str,
    mut form: StackEditForm,
    servers: &[CliServer],
    allow_delete: bool,
    friendly: bool,
) -> Result<EditorOutcome> {
    if !std::io::stdout().is_terminal() {
        bail!("the stack editor requires a TTY");
    }
    let mut stdout = std::io::stdout();
    let _guard = TerminalGuard::enter(&mut stdout)?;

    let mut cursor = 0usize; // index into the rows vec
    let mut caret = form.name.chars().count(); // text caret for the focused field
    let mut error: Option<String> = None;

    loop {
        let rows = build_edit_rows(&form, allow_delete);
        if cursor >= rows.len() {
            cursor = rows.len() - 1;
        }
        draw_stack_editor(&mut stdout, title, &form, servers, &rows, cursor, caret, error.as_deref(), friendly)?;

        let ev = event::read()?;
        let key = match ev {
            Event::Key(k) => k,
            Event::Resize(..) => continue, // redraw at loop top
            _ => continue,
        };
        let row = rows[cursor];
        let is_text = matches!(
            row,
            EditRow::Name | EditRow::Description | EditRow::SvcName(_) | EditRow::SvcCommand(_) | EditRow::SvcCwd(_)
        );

        match key.code {
            KeyCode::Esc => {
                return Ok(EditorOutcome::Cancel);
            }
            KeyCode::Up => {
                cursor = cursor.saturating_sub(1);
                caret = focused_text_len(&mut form, rows[cursor]);
                error = None;
            }
            KeyCode::Down => {
                if cursor + 1 < rows.len() {
                    cursor += 1;
                }
                caret = focused_text_len(&mut form, rows[cursor]);
                error = None;
            }
            KeyCode::Enter => {
                match row {
                    EditRow::Save => match validate_form(&form) {
                        Ok(()) => return Ok(EditorOutcome::Save(form)),
                        Err(msg) => error = Some(msg),
                    },
                    EditRow::Cancel => return Ok(EditorOutcome::Cancel),
                    EditRow::Delete => return Ok(EditorOutcome::Delete),
                    EditRow::AddService => {
                        let server_id = servers.first().map(|s| s.id.clone()).unwrap_or_default();
                        form.services.push(ServiceForm {
                            name: String::new(),
                            server_id,
                            command: String::new(),
                            cwd: String::new(),
                        });
                        // Jump to the new service's name field.
                        let new_rows = build_edit_rows(&form, allow_delete);
                        if let Some(pos) = new_rows
                            .iter()
                            .position(|r| *r == EditRow::SvcName(form.services.len() - 1))
                        {
                            cursor = pos;
                            caret = 0;
                        }
                    }
                    EditRow::SvcRemove(i) => {
                        if form.services.len() > 1 {
                            form.services.remove(i);
                            cursor = cursor.min(build_edit_rows(&form, allow_delete).len() - 1);
                        } else {
                            error = Some("a stack needs at least one service".to_string());
                        }
                    }
                    // Enter on an editable/server row just advances downward.
                    _ => {
                        if cursor + 1 < rows.len() {
                            cursor += 1;
                            caret = focused_text_len(&mut form, rows[cursor]);
                        }
                    }
                }
            }
            KeyCode::Left if matches!(row, EditRow::SvcServer(_)) => {
                if let EditRow::SvcServer(i) = row {
                    if let Some(s) = form.services.get_mut(i) {
                        s.server_id = cycle_server(servers, &s.server_id, -1);
                    }
                }
            }
            KeyCode::Right if matches!(row, EditRow::SvcServer(_)) => {
                if let EditRow::SvcServer(i) = row {
                    if let Some(s) = form.services.get_mut(i) {
                        s.server_id = cycle_server(servers, &s.server_id, 1);
                    }
                }
            }
            KeyCode::Left if is_text => {
                caret = caret.saturating_sub(1);
            }
            KeyCode::Right if is_text => {
                let len = edit_row_text(&mut form, row).map(|s| s.chars().count()).unwrap_or(0);
                caret = (caret + 1).min(len);
            }
            KeyCode::Home if is_text => caret = 0,
            KeyCode::End if is_text => {
                caret = edit_row_text(&mut form, row).map(|s| s.chars().count()).unwrap_or(0);
            }
            KeyCode::Backspace if is_text => {
                if let Some(s) = edit_row_text(&mut form, row) {
                    backspace_at(s, &mut caret);
                }
            }
            KeyCode::Delete if is_text => {
                if let Some(s) = edit_row_text(&mut form, row) {
                    let len = s.chars().count();
                    if caret < len {
                        let mut tmp = caret + 1;
                        backspace_at(s, &mut tmp);
                        // backspace_at moved caret back to `caret`; keep it.
                        caret = caret.min(s.chars().count());
                    }
                }
            }
            // Printable input (including spaces) goes into the focused text
            // field. Control modifiers are ignored so they can't corrupt names.
            KeyCode::Char(c) if is_text && !key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(s) = edit_row_text(&mut form, row) {
                    insert_char_at(s, &mut caret, c);
                }
                error = None;
            }
            _ => {}
        }
    }
}

/// Length (in chars) of the text a row edits, or 0 for non-text rows. Used to
/// park the caret at the end when navigating onto a field.
fn focused_text_len(form: &mut StackEditForm, row: EditRow) -> usize {
    edit_row_text(form, row).map(|s| s.chars().count()).unwrap_or(0)
}

fn validate_form(form: &StackEditForm) -> std::result::Result<(), String> {
    if form.name.trim().is_empty() {
        return Err("stack name can't be empty".to_string());
    }
    if form.services.is_empty() {
        return Err("a stack needs at least one service".to_string());
    }
    for (i, s) in form.services.iter().enumerate() {
        if s.name.trim().is_empty() {
            return Err(format!("service {} needs a name", i + 1));
        }
        if s.server_id.trim().is_empty() {
            return Err(format!("service {} needs a server", i + 1));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn draw_stack_editor(
    stdout: &mut Stdout,
    title: &str,
    form: &StackEditForm,
    servers: &[CliServer],
    rows: &[EditRow],
    cursor: usize,
    caret: usize,
    error: Option<&str>,
    friendly: bool,
) -> Result<()> {
    let t = theme();
    let b = t.borders;
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    let modal_w = cols.saturating_sub(4).min(82).max(46);
    let x0 = cols.saturating_sub(modal_w) / 2;
    let inner_w = modal_w.saturating_sub(2) as usize;
    const LABEL_W: usize = 12;

    queue!(stdout, Hide, MoveTo(0, 0), Clear(ClearType::All))?;

    // Build the display lines together with the row index each one maps to,
    // so the focused row can be highlighted and the caret positioned.
    enum Disp<'a> {
        Header(String),
        Blank,
        Field {
            row_idx: usize,
            indent: usize,
            label: &'a str,
            value: String,
            action: bool,
            text: bool,
        },
    }
    let mut lines: Vec<Disp> = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        match *row {
            EditRow::Name => lines.push(Disp::Field { row_idx: idx, indent: 0, label: "Name", value: form.name.clone(), action: false, text: true }),
            EditRow::Description => lines.push(Disp::Field { row_idx: idx, indent: 0, label: "Description", value: form.description.clone(), action: false, text: true }),
            EditRow::SvcName(i) => {
                lines.push(Disp::Blank);
                lines.push(Disp::Header(format!("Service {}", i + 1)));
                lines.push(Disp::Field { row_idx: idx, indent: 2, label: "Name", value: form.services[i].name.clone(), action: false, text: true });
            }
            EditRow::SvcServer(i) => {
                let label = stack_server_label(servers, &form.services[i].server_id, friendly);
                lines.push(Disp::Field { row_idx: idx, indent: 2, label: "Server", value: format!("‹ {label} ›   (←/→ change)"), action: false, text: false });
            }
            EditRow::SvcCommand(i) => lines.push(Disp::Field { row_idx: idx, indent: 2, label: "Command", value: form.services[i].command.clone(), action: false, text: true }),
            EditRow::SvcCwd(i) => lines.push(Disp::Field { row_idx: idx, indent: 2, label: "Cwd", value: form.services[i].cwd.clone(), action: false, text: true }),
            EditRow::SvcRemove(_) => lines.push(Disp::Field { row_idx: idx, indent: 2, label: "", value: "[− Remove service]".to_string(), action: true, text: false }),
            EditRow::AddService => {
                lines.push(Disp::Blank);
                lines.push(Disp::Field { row_idx: idx, indent: 0, label: "", value: "[+ Add service]".to_string(), action: true, text: false });
            }
            EditRow::Save => {
                lines.push(Disp::Blank);
                lines.push(Disp::Field { row_idx: idx, indent: 0, label: "", value: "[✓ Save]".to_string(), action: true, text: false });
            }
            EditRow::Cancel => lines.push(Disp::Field { row_idx: idx, indent: 0, label: "", value: "[✗ Cancel]".to_string(), action: true, text: false }),
            EditRow::Delete => lines.push(Disp::Field { row_idx: idx, indent: 0, label: "", value: "[🗑 Delete stack]".to_string(), action: true, text: false }),
        }
    }

    // Top border with the title embedded.
    let title_badge = format!(" {title} ");
    let lead = 1usize;
    let fill = inner_w.saturating_sub(title_badge.chars().count() + lead);
    let top = format!("{}{}{}{}{}", b.tl, b.h.repeat(lead), title_badge, b.h.repeat(fill), b.tr);
    let mut y = 1u16;
    queue!(stdout, MoveTo(x0, y), SetForegroundColor(t.accent), Print(top), ResetColor)?;
    y += 1;

    let mut caret_pos: Option<(u16, u16)> = None;
    let blank_inner = " ".repeat(inner_w);
    for line in &lines {
        queue!(stdout, MoveTo(x0, y), SetForegroundColor(t.accent), Print(b.v), ResetColor, Print(&blank_inner), SetForegroundColor(t.accent), MoveTo(x0 + modal_w - 1, y), Print(b.v), ResetColor)?;
        match line {
            Disp::Blank => {}
            Disp::Header(text) => {
                queue!(stdout, MoveTo(x0 + 2, y), SetForegroundColor(t.heading), SetAttribute(Attribute::Bold), Print(fit_text(text, inner_w - 2)), SetAttribute(Attribute::Reset), ResetColor)?;
            }
            Disp::Field { row_idx, indent, label, value, action, text } => {
                let focused = *row_idx == cursor;
                let lx = x0 + 2 + *indent as u16;
                if !label.is_empty() {
                    let lab = pad_visible(label, LABEL_W);
                    queue!(stdout, MoveTo(lx, y), SetForegroundColor(t.hint), Print(lab), ResetColor)?;
                }
                let vx = if label.is_empty() { lx } else { lx + LABEL_W as u16 + 1 };
                let avail = (x0 + modal_w - 1).saturating_sub(vx + 1) as usize;
                let shown = fit_text(value, avail);
                if focused {
                    if *action {
                        queue!(stdout, MoveTo(vx, y), SetForegroundColor(t.selected_fg), SetBackgroundColor(t.selected_bg), SetAttribute(Attribute::Bold), Print(&shown), SetAttribute(Attribute::Reset), ResetColor)?;
                    } else {
                        queue!(stdout, MoveTo(vx, y), SetForegroundColor(t.title_active), Print(&shown), ResetColor)?;
                        // Park the hardware caret on text fields only.
                        if *text {
                            let cx = vx + (caret.min(value.chars().count())) as u16;
                            caret_pos = Some((cx.min(x0 + modal_w - 2), y));
                        }
                    }
                } else {
                    let color = if *action { t.hint } else { t.name };
                    queue!(stdout, MoveTo(vx, y), SetForegroundColor(color), Print(&shown), ResetColor)?;
                }
            }
        }
        y += 1;
    }

    // Error line (if any) then the bottom border + hint.
    if let Some(err) = error {
        queue!(stdout, MoveTo(x0, y), SetForegroundColor(t.accent), Print(b.v), ResetColor, Print(&blank_inner), SetForegroundColor(t.accent), MoveTo(x0 + modal_w - 1, y), Print(b.v), ResetColor)?;
        queue!(stdout, MoveTo(x0 + 2, y), SetForegroundColor(t.danger), Print(fit_text(&format!("! {err}"), inner_w - 2)), ResetColor)?;
        y += 1;
    }
    let hint = " ↑/↓ move · type to edit · Enter: act · Esc cancel ";
    let hfill = inner_w.saturating_sub(hint.chars().count());
    let bottom = format!("{}{}{}{}", b.bl, hint, b.h.repeat(hfill), b.br);
    queue!(stdout, MoveTo(x0, y), SetForegroundColor(t.accent), Print(fit_text(&bottom, modal_w as usize)), ResetColor)?;

    // Show the caret on text fields; hide it otherwise.
    if let Some((cx, cy)) = caret_pos {
        queue!(stdout, MoveTo(cx, cy), Show)?;
    } else {
        queue!(stdout, Hide)?;
    }
    stdout.flush()?;
    Ok(())
}

/// Body shared by create/update: the service array, omitting empty
/// command/cwd (the API schema treats them as optional, not nullable).
fn stack_services_json(form: &StackEditForm) -> Vec<serde_json::Value> {
    form.services
        .iter()
        .map(|s| {
            let mut m = serde_json::Map::new();
            m.insert("name".into(), serde_json::json!(s.name.trim()));
            m.insert("serverId".into(), serde_json::json!(s.server_id));
            let cmd = s.command.trim();
            if !cmd.is_empty() {
                m.insert("command".into(), serde_json::json!(cmd));
            }
            let cwd = s.cwd.trim();
            if !cwd.is_empty() {
                m.insert("cwd".into(), serde_json::json!(cwd));
            }
            serde_json::Value::Object(m)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct CreatedStack {
    id: String,
}

pub async fn run_stack_new() -> Result<()> {
    let cfg = load_config()?;
    let payload = fetch_stack_list_payload(&cfg).await?;
    if payload.servers.is_empty() {
        bail!("no servers available — add a server in the dashboard first");
    }
    let form = StackEditForm {
        name: String::new(),
        description: String::new(),
        services: vec![ServiceForm {
            name: String::new(),
            server_id: payload.servers[0].id.clone(),
            command: String::new(),
            cwd: String::new(),
        }],
    };
    let friendly = prefers_friendly_name(&payload.preferences);
    match run_stack_editor("New stack", form, &payload.servers, false, friendly)? {
        EditorOutcome::Save(f) => {
            let mut body = serde_json::Map::new();
            body.insert("name".into(), serde_json::json!(f.name.trim()));
            let desc = f.description.trim();
            if !desc.is_empty() {
                body.insert("description".into(), serde_json::json!(desc));
            }
            body.insert("services".into(), serde_json::json!(stack_services_json(&f)));
            let created: CreatedStack =
                post_json(&cfg, "/api/cli/stacks", &serde_json::Value::Object(body)).await?;
            println!(
                "{} stack {} {}",
                "Created".green().bold(),
                f.name.trim().magenta(),
                format!("({})", short_id(&created.id)).dark_grey(),
            );
            println!(
                "  {} {}",
                "Open it:".dark_grey(),
                format!("managet stack start \"{}\"", f.name.trim()).white(),
            );
        }
        EditorOutcome::Cancel | EditorOutcome::Delete => {
            println!("{}", "Cancelled — nothing created.".dark_grey());
        }
    }
    Ok(())
}

pub async fn run_stack_edit(selector: String) -> Result<()> {
    let cfg = load_config()?;
    let stack_id = resolve_stack_id(&cfg, &selector).await?;
    let detail = fetch_stack_detail(&cfg, &stack_id).await?;
    if detail.servers.is_empty() {
        bail!("no servers available — add a server in the dashboard first");
    }
    let mut ordered = detail.stack.services.clone();
    ordered.sort_by_key(|s| s.order_index);
    let form = StackEditForm {
        name: detail.stack.name.clone(),
        description: detail.stack.description.clone().unwrap_or_default(),
        services: ordered
            .iter()
            .map(|s| ServiceForm {
                name: s.name.clone(),
                server_id: s.server_id.clone(),
                command: s.command.clone().unwrap_or_default(),
                cwd: s.cwd.clone().unwrap_or_default(),
            })
            .collect(),
    };
    let stack_name = detail.stack.name.clone();

    let friendly = prefers_friendly_name(&detail.preferences);
    match run_stack_editor("Edit stack", form, &detail.servers, true, friendly)? {
        EditorOutcome::Save(f) => {
            let mut body = serde_json::Map::new();
            body.insert("name".into(), serde_json::json!(f.name.trim()));
            let desc = f.description.trim();
            // Send null to clear, a string to set — update accepts both.
            body.insert(
                "description".into(),
                if desc.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(desc)
                },
            );
            body.insert("services".into(), serde_json::json!(stack_services_json(&f)));
            put_json(
                &cfg,
                &format!("/api/cli/stacks/{stack_id}"),
                &serde_json::Value::Object(body),
            )
            .await?;
            println!("{} stack {}", "Saved".green().bold(), f.name.trim().magenta());
        }
        EditorOutcome::Delete => {
            let confirmed = inquire::Confirm::new(&format!(
                "Delete stack \"{stack_name}\"? (moves it to Trash)"
            ))
            .with_default(false)
            .prompt()
            .unwrap_or(false);
            if confirmed {
                let _ = delete_request(&cfg, &format!("/api/cli/stacks/{stack_id}")).await?;
                println!("{} stack {}", "Deleted".red().bold(), stack_name.magenta());
            } else {
                println!("{}", "Delete cancelled.".dark_grey());
            }
        }
        EditorOutcome::Cancel => {
            println!("{}", "Cancelled — no changes saved.".dark_grey());
        }
    }
    Ok(())
}

/// Services that should become panes, in slot order: filtered to one
/// server when `filter_id` is set, sorted by the stack's order index.
fn stack_visible_services<'a>(
    detail: &'a CliStackDetail,
    filter_id: Option<&str>,
) -> Vec<&'a StackServiceDto> {
    let mut svcs: Vec<&StackServiceDto> = detail
        .stack
        .services
        .iter()
        .filter(|s| filter_id.map(|f| s.server_id == f).unwrap_or(true))
        .collect();
    svcs.sort_by_key(|s| s.order_index);
    svcs
}

fn build_stack_panes(
    detail: &CliStackDetail,
    server_labels: &HashMap<String, String>,
    filter_id: Option<&str>,
    layout: &GroupLayout,
    partition: &[usize],
    cols: u16,
    rows: u16,
) -> Vec<Pane> {
    let rects = compute_rects(layout, partition, cols, rows);
    stack_visible_services(detail, filter_id)
        .into_iter()
        .enumerate()
        .map(|(idx, svc)| {
            let rect = rects.get(idx).copied().unwrap_or(Rect {
                x: 0,
                y: 1,
                w: cols,
                h: rows.saturating_sub(1),
            });
            let (inner_rows, inner_cols) = pane_inner_size(rect);
            // A service is "live" when its runtime row has an active
            // session id; otherwise the pane is a placeholder.
            let session = detail
                .runtime
                .services
                .iter()
                .find(|r| r.service_id == svc.id && r.status == "active")
                .and_then(|r| r.session_id.as_ref())
                .map(|sid| GroupSession {
                    id: sid.clone(),
                    server_id: svc.server_id.clone(),
                    session_name: svc.name.clone(),
                    status: "active".to_string(),
                    group_order_index: Some(svc.order_index),
                    group_id: None,
                    attached_clients: None,
                });
            let server_label = server_labels
                .get(&svc.server_id)
                .cloned()
                .unwrap_or_else(|| svc.server_id.clone());
            Pane {
                session,
                slot_key: svc.id.clone(),
                title: svc.name.clone(),
                server_label,
                rect,
                parser: vt100::Parser::new(inner_rows, inner_cols, 0),
                lost: None,
                stats: service_stats(detail, &svc.id),
            }
        })
        .collect()
}

/// Pull the live resource readout for a service from the stack runtime.
/// Returns `None` when nothing is worth drawing (no CPU/mem/temp yet).
fn service_stats(detail: &CliStackDetail, service_id: &str) -> Option<PaneStats> {
    detail
        .runtime
        .services
        .iter()
        .find(|r| r.service_id == service_id)
        .map(|r| PaneStats {
            cpu_percent: r.cpu_percent,
            memory_mb: r.memory_mb,
            cpu_temp_c: r.cpu_temp_c,
        })
        .filter(|s| s.any())
}

/// Refresh just the per-pane stat readouts from a fresh stack detail,
/// matched by slot_key (service id). Called on every runtime poll so
/// CPU/mem/temp stay live even when no placeholder↔live flip happened.
fn update_stack_pane_stats(panes: &mut [Pane], detail: &CliStackDetail) {
    for pane in panes.iter_mut() {
        pane.stats = service_stats(detail, &pane.slot_key);
    }
}

/// True when the dashboard's runtime no longer matches what the panes
/// show: a service appeared/disappeared, slot order changed, or a
/// service's live session id flipped (placeholder↔live, or respawned).
fn stack_state_changed(panes: &[Pane], latest: &CliStackDetail, filter_id: Option<&str>) -> bool {
    let svcs = stack_visible_services(latest, filter_id);
    if svcs.len() != panes.len() {
        return true;
    }
    for (pane, svc) in panes.iter().zip(svcs.iter()) {
        if pane.slot_key != svc.id {
            return true;
        }
        let latest_sid = latest
            .runtime
            .services
            .iter()
            .find(|r| r.service_id == svc.id && r.status == "active")
            .and_then(|r| r.session_id.clone());
        let current_sid = pane.session.as_ref().map(|s| s.id.clone());
        if latest_sid != current_sid {
            return true;
        }
    }
    false
}

/// Rebuild the panes from a fresh stack detail, preserving vt100
/// scrollback for any slot whose live session id is unchanged. Attaches
/// (with scrollback replay) when a placeholder slot gains a session, and
/// resizes every live pane. Stack counterpart to `reconcile_after_fetch`.
#[allow(clippy::too_many_arguments)]
async fn reconcile_stack_after_fetch(
    latest: CliStackDetail,
    filter_id: Option<&str>,
    current_detail: &mut CliStackDetail,
    server_labels: &mut HashMap<String, String>,
    current_layout: &mut GroupLayout,
    current_partition: &mut Vec<usize>,
    panes: &mut Vec<Pane>,
    focused: &mut usize,
    send_tx: &mpsc::Sender<String>,
) -> Result<()> {
    // Remember each slot's prior session id so we only re-attach slots
    // that genuinely changed.
    let prior_session: HashMap<String, Option<String>> = panes
        .iter()
        .map(|p| (p.slot_key.clone(), p.session.as_ref().map(|s| s.id.clone())))
        .collect();

    *current_detail = latest;
    *server_labels = build_server_labels(&current_detail.servers);
    let visible = stack_visible_services(current_detail, filter_id).len();
    // Keep the user's resized layout across reconciles when the pane count
    // is unchanged (a placeholder flipping live doesn't add/remove panes).
    // Only fall back to a fresh default when services were added/removed.
    if current_partition.iter().sum::<usize>() != visible
        || current_layout.col_widths_by_row.len() != current_partition.len()
    {
        *current_partition = default_partition(visible);
        *current_layout = layout_for_partition(current_partition);
    }

    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let fresh = build_stack_panes(
        current_detail,
        server_labels,
        filter_id,
        current_layout,
        current_partition,
        cols,
        rows,
    );

    let mut preserved: HashMap<String, (Option<String>, vt100::Parser)> = HashMap::new();
    for old in panes.drain(..) {
        let sid = old.session.as_ref().map(|s| s.id.clone());
        preserved.insert(old.slot_key.clone(), (sid, old.parser));
    }
    let mut rebuilt = Vec::with_capacity(fresh.len());
    for mut p in fresh {
        if let Some((old_sid, parser)) = preserved.remove(&p.slot_key) {
            let new_sid = p.session.as_ref().map(|s| s.id.clone());
            // Only reuse scrollback when the slot still points at the same
            // session (or is still a placeholder). A respawned session
            // gets a clean screen.
            if old_sid == new_sid {
                let (h, w) = pane_inner_size(p.rect);
                let mut reused = parser;
                reused.set_size(h, w);
                p.parser = reused;
            }
        }
        rebuilt.push(p);
    }
    *panes = rebuilt;
    *focused = (*focused).min(panes.len().saturating_sub(1));

    for pane in panes.iter() {
        let Some(session) = &pane.session else { continue };
        let prior_sid = prior_session.get(&pane.slot_key).cloned().flatten();
        let (h, w) = pane_inner_size(pane.rect);
        // Attach when this slot wasn't already attached to this session.
        if prior_sid.as_deref() != Some(session.id.as_str()) {
            send_ws(send_tx, client_attach_msg(session)).await?;
        }
        send_ws(send_tx, client_resize_msg(session, h, w)).await?;
    }
    Ok(())
}

pub async fn run_stack_open(
    selector: String,
    server_selector: Option<String>,
    theme_override: Option<String>,
) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        bail!("stack open requires a TTY");
    }

    let cfg = load_config()?;
    // Lock the theme before raw mode so an unknown `--theme` errors cleanly.
    // Resolves from the server catalog (customs + synced active); falls back
    // to the compiled-in presets when offline.
    set_active_theme(resolve_active_theme(&cfg, theme_override.as_deref()).await?);
    let stack_id = resolve_stack_id(&cfg, &selector).await?;
    let mut current_detail = fetch_stack_detail(&cfg, &stack_id).await?;

    let filter_id: Option<String> = match &server_selector {
        Some(sel) => Some(resolve_server(&current_detail.servers, sel)?),
        None => None,
    };

    let visible_count = stack_visible_services(&current_detail, filter_id.as_deref()).len();
    if visible_count == 0 {
        match &server_selector {
            Some(sel) => bail!(
                "stack '{}' has no services on '{}'",
                current_detail.stack.name,
                sel
            ),
            None => bail!("stack '{}' has no services", current_detail.stack.name),
        }
    }

    let stack_title = current_detail.stack.name.clone();
    let mut server_labels = build_server_labels(&current_detail.servers);
    // Start from the user's persisted layout (Ctrl-A R resize) when its
    // shape still matches the visible service count; otherwise the default
    // equal-split for this many panes.
    let mut current_layout =
        valid_layout_or_default(current_detail.layout.clone(), visible_count);
    let mut current_partition = active_partition(&current_layout, visible_count);

    let mut stdout = std::io::stdout();
    let _guard = TerminalGuard::enter(&mut stdout)?;

    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let mut panes = build_stack_panes(
        &current_detail,
        &server_labels,
        filter_id.as_deref(),
        &current_layout,
        &current_partition,
        cols,
        rows,
    );
    let mut focused = 0usize;
    draw_stack(&mut stdout, &stack_title, &panes, focused)?;

    let ws_url = ws_url_for(&cfg.api_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .context("building websocket request")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", cfg.token))
            .context("building Authorization header")?,
    );

    let (ws, _) = connect_async(request)
        .await
        .with_context(|| format!("connecting to dashboard websocket at {ws_url}"))?;
    let (mut ws_write, mut ws_read) = ws.split();
    let (send_tx, mut send_rx) = mpsc::channel::<String>(128);
    let writer = tokio::spawn(async move {
        while let Some(msg) = send_rx.recv().await {
            if ws_write.send(Message::text(msg)).await.is_err() {
                break;
            }
        }
    });

    for pane in &panes {
        if let Some(session) = &pane.session {
            send_ws(&send_tx, client_attach_msg(session)).await?;
            let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
            send_ws(&send_tx, client_resize_msg(session, inner_rows, inner_cols)).await?;
        }
    }

    let (event_tx, mut event_rx) = mpsc::channel::<Event>(64);
    std::thread::spawn(move || loop {
        match event::poll(Duration::from_millis(100)) {
            Ok(true) => match event::read() {
                Ok(ev) => {
                    if event_tx.blocking_send(ev).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            Ok(false) => continue,
            Err(_) => break,
        }
    });

    // Poll the stack runtime so placeholders flip to live panes when a
    // service starts (and back when it stops). Same 3 s cadence the group
    // view uses for membership; the dashboard doesn't push this.
    let mut runtime_poll = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(3),
        Duration::from_secs(3),
    );
    runtime_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut escape = false;
    let mut resize: Option<ResizeState> = None;
    loop {
        tokio::select! {
            maybe_event = event_rx.recv() => {
                let Some(ev) = maybe_event else { break; };
                match ev {
                    Event::Key(key) => {
                        // Resize mode (Ctrl-A R): same controls as the group
                        // view. Arrows preview locally, Enter persists the
                        // stack layout, Esc reverts to the layout on entry.
                        if resize.is_some() {
                            let pane_count = panes.len();
                            let mut commit = false;
                            let mut cancel = false;
                            let mut changed = false;
                            {
                                let rs = resize.as_mut().unwrap();
                                rs.pane = rs.pane.min(pane_count.saturating_sub(1));
                                match key.code {
                                    KeyCode::Esc => cancel = true,
                                    KeyCode::Enter => commit = true,
                                    KeyCode::Left | KeyCode::Char('h') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, -1, 0);
                                    }
                                    KeyCode::Right | KeyCode::Char('l') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 1, 0);
                                    }
                                    KeyCode::Up | KeyCode::Char('k') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 0, -1);
                                    }
                                    KeyCode::Down | KeyCode::Char('j') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 0, 1);
                                    }
                                    KeyCode::Char('[') => {
                                        if pane_count > 0 {
                                            rs.pane = (rs.pane + pane_count - 1) % pane_count;
                                            focused = rs.pane;
                                        }
                                    }
                                    KeyCode::Char(']') => {
                                        if pane_count > 0 {
                                            rs.pane = (rs.pane + 1) % pane_count;
                                            focused = rs.pane;
                                        }
                                    }
                                    KeyCode::Char(c) if c.is_ascii_digit() => {
                                        let slot = c.to_digit(10).unwrap_or(0) as usize;
                                        if slot >= 1 && slot <= pane_count {
                                            rs.pane = slot - 1;
                                            focused = rs.pane;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            if cancel {
                                current_layout = resize.take().unwrap().original;
                            } else if commit {
                                resize = None;
                            }
                            if changed || cancel || commit {
                                let (c, r) = terminal::size().unwrap_or((120, 36));
                                apply_resize(&mut panes, &current_layout, &current_partition, c, r);
                                for pane in &panes {
                                    if let Some(session) = &pane.session {
                                        let (h, w) = pane_inner_size(pane.rect);
                                        send_ws(&send_tx, client_resize_msg(session, h, w)).await?;
                                    }
                                }
                            }
                            if commit {
                                let _ = save_stack_layout(&cfg, &stack_id, &current_layout).await;
                            }
                            draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                            if let Some(rs) = resize.as_ref() {
                                draw_resize_overlay(&mut stdout, &panes, rs)?;
                            }
                            continue;
                        }

                        // Ctrl-A R enters resize mode (needs >1 pane to have
                        // something to trade space with).
                        if escape && matches!(key.code, KeyCode::Char('r') | KeyCode::Char('R')) {
                            escape = false;
                            if panes.len() >= 2 {
                                resize = Some(ResizeState {
                                    pane: focused.min(panes.len() - 1),
                                    original: current_layout.clone(),
                                });
                                draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                                if let Some(rs) = resize.as_ref() {
                                    draw_resize_overlay(&mut stdout, &panes, rs)?;
                                }
                            }
                            continue;
                        }

                        let focused_session = panes
                            .get(focused.min(panes.len().saturating_sub(1)))
                            .and_then(|p| p.session.clone());
                        if handle_key(
                            key,
                            &mut escape,
                            &mut focused,
                            panes.len(),
                            &send_tx,
                            focused_session.as_ref(),
                        ).await? {
                            break;
                        }
                        draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                    }
                    Event::Resize(cols, rows) => {
                        apply_resize(&mut panes, &current_layout, &current_partition, cols, rows);
                        for pane in &panes {
                            if let Some(session) = &pane.session {
                                let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
                                send_ws(
                                    &send_tx,
                                    client_resize_msg(session, inner_rows, inner_cols),
                                ).await?;
                            }
                        }
                        draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                        if let Some(rs) = resize.as_ref() {
                            draw_resize_overlay(&mut stdout, &panes, rs)?;
                        }
                    }
                    _ => {}
                }
            }
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_msg(&mut panes, text.as_str(), &send_tx).await;
                        draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            handle_server_msg(&mut panes, text, &send_tx).await;
                            draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(anyhow!("websocket error: {e}")),
                }
                if let Some(rs) = resize.as_ref() {
                    draw_resize_overlay(&mut stdout, &panes, rs)?;
                }
            }
            _ = runtime_poll.tick() => {
                let Ok(latest) = fetch_stack_detail(&cfg, &stack_id).await else {
                    continue;
                };
                // Don't disturb the panes mid-resize; refresh once it's done.
                if resize.is_some() {
                    continue;
                }
                if stack_state_changed(&panes, &latest, filter_id.as_deref()) {
                    reconcile_stack_after_fetch(
                        latest,
                        filter_id.as_deref(),
                        &mut current_detail,
                        &mut server_labels,
                        &mut current_layout,
                        &mut current_partition,
                        &mut panes,
                        &mut focused,
                        &send_tx,
                    )
                    .await?;
                } else {
                    // No structural change — just refresh the live CPU/mem/
                    // temp readouts so the per-pane stats stay current.
                    current_detail = latest;
                    update_stack_pane_stats(&mut panes, &current_detail);
                }
                draw_stack(&mut stdout, &stack_title, &panes, focused)?;
            }
        }
    }

    drop(send_tx);
    writer.abort();
    Ok(())
}

fn draw_stack(stdout: &mut Stdout, stack_name: &str, panes: &[Pane], focused: usize) -> Result<()> {
    queue!(stdout, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    draw_stack_status_bar(stdout, stack_name, panes, focused, cols)?;
    for (i, pane) in panes.iter().enumerate() {
        draw_pane(stdout, pane, focused == i, i + 1)?;
    }
    stdout.flush()?;
    Ok(())
}

fn draw_stack_status_bar(
    stdout: &mut Stdout,
    stack_name: &str,
    panes: &[Pane],
    focused: usize,
    cols: u16,
) -> Result<()> {
    let active_slot = focused + 1;
    let active_name = panes.get(focused).map(|p| p.title.as_str()).unwrap_or("?");
    let running = panes.iter().filter(|p| p.session.is_some()).count();
    let total = panes.len();
    let active_text = format!("{running}/{total} running · focus {active_slot}:{active_name}");
    let hints = "Ctrl-A D detach · 1-6 focus · [/] cycle · R resize";

    let t = theme();
    let segments: [(&str, Color, bool); 7] = [
        ("managet stack:", t.heading, true),
        (" ", t.name, false),
        (stack_name, t.name, true),
        ("  │  ", t.separator, false),
        (active_text.as_str(), t.info, false),
        ("  │  ", t.separator, false),
        (hints, t.hint, false),
    ];
    render_status_segments(stdout, &segments, cols)
}

/// Resolve a user-supplied server selector (name, host, or id) to the
/// authoritative server id from the dashboard's directory. Errors when
/// the selector matches nothing or is ambiguous.
fn resolve_server(servers: &[CliServer], selector: &str) -> Result<String> {
    let hits: Vec<&CliServer> = servers
        .iter()
        .filter(|s| {
            s.id == selector
                || s.id.starts_with(selector)
                || s.name == selector
                || s.host == selector
        })
        .collect();
    match hits.len() {
        0 => bail!("no server matches '{selector}'"),
        1 => Ok(hits[0].id.clone()),
        n => bail!("'{selector}' is ambiguous ({n} servers match)"),
    }
}

/// Interactive picker (arrow keys + enter) listing every server on the
/// dashboard account. Friendly name is shown first when set, then the
/// host in dim parens — same convention as the dashboard's "+ New
/// terminal" dropdown.
fn pick_server_interactive(detail: &CliGroupDetail) -> Result<String> {
    if detail.servers.is_empty() {
        bail!("no servers registered on this dashboard");
    }
    if !std::io::stdout().is_terminal() {
        bail!("server picker requires a TTY; pass --server <name>");
    }

    #[derive(Clone)]
    struct PickerItem {
        id: String,
        label: String,
    }
    impl std::fmt::Display for PickerItem {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.label)
        }
    }

    let items: Vec<PickerItem> = detail
        .servers
        .iter()
        .map(|s| {
            let label = if s.name.is_empty() {
                format!("{}@{}", s.username, s.host)
            } else {
                format!("{}  ({}@{})", s.name, s.username, s.host)
            };
            PickerItem {
                id: s.id.clone(),
                label,
            }
        })
        .collect();

    let chosen = Select::new(
        &format!("Add terminal to group '{}' on which server?", detail.group.name),
        items,
    )
    .with_help_message("↑/↓ to navigate · Enter to confirm · Esc to cancel")
    .prompt()
    .context("server selection cancelled")?;
    Ok(chosen.id)
}

pub async fn run_group_open(selector: String, theme_override: Option<String>) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        bail!("group open requires a TTY");
    }

    let cfg = load_config()?;
    // Resolve + lock the theme before any raw-mode/alt-screen switch, so an
    // unknown `--theme` errors on a normal screen. Resolves from the server
    // catalog (customs + synced active); falls back to presets when offline.
    set_active_theme(resolve_active_theme(&cfg, theme_override.as_deref()).await?);
    let group_id = resolve_group_id(&cfg, &selector).await?;
    let CliGroupDetail {
        group,
        layout,
        servers,
        ..
    } = fetch_group_detail(&cfg, &group_id).await?;
    if group.members.is_empty() {
        bail!("group has no terminals");
    }

    // All four pieces are mutable because the membership-poll branch
    // below replaces them when the dashboard reports a different set of
    // sessions for this group.
    let mut current_group = group;
    let mut current_servers = servers;
    let mut current_layout = valid_layout_or_default(layout, current_group.members.len());
    let mut current_partition =
        active_partition(&current_layout, current_group.members.len());
    let mut server_labels = build_server_labels(&current_servers);

    let mut stdout = std::io::stdout();
    let _guard = TerminalGuard::enter(&mut stdout)?;

    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let mut panes = build_panes(
        &current_group,
        &server_labels,
        &current_layout,
        &current_partition,
        cols,
        rows,
    );
    let mut focused = 0usize;
    draw_group(
        &mut stdout,
        &current_group,
        &panes,
        focused,
        None,
        None,
        &current_servers,
    )?;

    let ws_url = ws_url_for(&cfg.api_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .context("building websocket request")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", cfg.token))
            .context("building Authorization header")?,
    );

    let (ws, _) = connect_async(request)
        .await
        .with_context(|| format!("connecting to dashboard websocket at {ws_url}"))?;
    let (mut ws_write, mut ws_read) = ws.split();
    let (send_tx, mut send_rx) = mpsc::channel::<String>(128);
    let writer = tokio::spawn(async move {
        while let Some(msg) = send_rx.recv().await {
            if ws_write.send(Message::text(msg)).await.is_err() {
                break;
            }
        }
    });

    for pane in &panes {
        if let Some(session) = &pane.session {
            send_ws(&send_tx, client_attach_msg(session)).await?;
            let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
            send_ws(
                &send_tx,
                client_resize_msg(session, inner_rows, inner_cols),
            )
            .await?;
        }
    }

    let (event_tx, mut event_rx) = mpsc::channel::<Event>(64);
    std::thread::spawn(move || loop {
        match event::poll(Duration::from_millis(100)) {
            Ok(true) => match event::read() {
                Ok(ev) => {
                    if event_tx.blocking_send(ev).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            Ok(false) => continue,
            Err(_) => break,
        }
    });

    // Periodic poll for membership changes. The browser changes a
    // group's roster via REST and refetches; there's no server push
    // event for it. 3 s is the same cadence the dashboard uses for
    // server status polls — fast enough that adding a terminal in the
    // browser shows up in the CLI within a beat, slow enough that idle
    // groups don't generate constant HTTP traffic.
    let mut membership_poll = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(3),
        Duration::from_secs(3),
    );
    membership_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut escape = false;
    let mut picker: Option<PickerState> = None;
    let mut confirm: Option<ConfirmState> = None;
    let mut layout_picker: Option<LayoutPickerState> = None;
    let mut swap: Option<SwapState> = None;
    let mut resize: Option<ResizeState> = None;
    let mut palette_ov: Option<MosaicPaletteState> = None;
    // Set when the loop exits because the group is gone (all sessions
    // ended / removed); printed once on the normal screen after we tear
    // down the alt-screen so the user knows why the mosaic closed.
    let mut ended_msg: Option<&'static str> = None;
    loop {
        tokio::select! {
            maybe_event = event_rx.recv() => {
                let Some(ev) = maybe_event else { break; };
                match ev {
                    Event::Key(key) => {
                        // Confirm overlay short-circuits everything:
                        // Y/y commits the destructive action, any other
                        // key cancels. We swallow the keystroke either
                        // way so a fat-fingered Enter on a kill prompt
                        // doesn't fall through to the live session.
                        if confirm.is_some() {
                            let result = handle_confirm_key(key);
                            match result {
                                ConfirmKeyResult::Idle => {}
                                ConfirmKeyResult::Cancel => {
                                    confirm = None;
                                }
                                ConfirmKeyResult::Confirm => {
                                    let c = confirm.take().unwrap();
                                    match c.action {
                                        ConfirmAction::KillSession => {
                                            let url = format!(
                                                "/api/cli/sessions/{}",
                                                c.target_session_id
                                            );
                                            let _ = delete_request(&cfg, &url).await;
                                            if let Ok(latest) =
                                                fetch_group_detail(&cfg, &group_id).await
                                            {
                                                if latest.group.members.is_empty() {
                                                    break;
                                                }
                                                reconcile_after_fetch(
                                                    latest,
                                                    &mut current_group,
                                                    &mut current_servers,
                                                    &mut current_layout,
                                                    &mut current_partition,
                                                    &mut server_labels,
                                                    &mut panes,
                                                    &mut focused,
                                                    &send_tx,
                                                )
                                                .await?;
                                            }
                                        }
                                    }
                                }
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                            continue;
                        }

                        // Picker mode short-circuits ordinary key
                        // handling: Up/Down navigate, Enter confirms,
                        // Esc cancels. Any other key is dropped so it
                        // doesn't leak into the focused session (which
                        // is still attached and could otherwise eat the
                        // input we typed into the picker).
                        if picker.is_some() {
                            match handle_picker_key(key, picker.as_mut().unwrap()) {
                                PickerKeyResult::Idle => {}
                                PickerKeyResult::Cancel => {
                                    let p = picker.take().unwrap();
                                    restore_after_picker(
                                        p,
                                        &mut panes,
                                        &mut current_layout,
                                        &mut current_partition,
                                        &send_tx,
                                    ).await?;
                                    focused = focused.min(panes.len().saturating_sub(1));
                                }
                                PickerKeyResult::Confirm => {
                                    let p = picker.take().unwrap();
                                    let body = p.choices.get(p.selected).map(|c| match c {
                                        PickerChoice::Existing { session_id, .. } => {
                                            serde_json::json!({ "sessionId": session_id })
                                        }
                                        PickerChoice::NewOnServer { server_id, .. } => {
                                            serde_json::json!({ "serverId": server_id })
                                        }
                                    });
                                    if let Some(body) = body {
                                        let res = post_json::<_, AddMemberResponse>(
                                            &cfg,
                                            &format!("/api/cli/groups/{group_id}/members"),
                                            &body,
                                        )
                                        .await;
                                        match res {
                                            Ok(_) => {
                                                if let Ok(latest) =
                                                    fetch_group_detail(&cfg, &group_id).await
                                                {
                                                    reconcile_after_fetch(
                                                        latest,
                                                        &mut current_group,
                                                        &mut current_servers,
                                                        &mut current_layout,
                                                        &mut current_partition,
                                                        &mut server_labels,
                                                        &mut panes,
                                                        &mut focused,
                                                        &send_tx,
                                                    )
                                                    .await?;
                                                    focused =
                                                        panes.len().saturating_sub(1);
                                                } else {
                                                    restore_after_picker(
                                                        p,
                                                        &mut panes,
                                                        &mut current_layout,
                                                        &mut current_partition,
                                                        &send_tx,
                                                    )
                                                    .await?;
                                                    focused =
                                                        focused.min(panes.len().saturating_sub(1));
                                                }
                                            }
                                            Err(_) => {
                                                restore_after_picker(
                                                    p,
                                                    &mut panes,
                                                    &mut current_layout,
                                                    &mut current_partition,
                                                    &send_tx,
                                                )
                                                .await?;
                                                focused =
                                                    focused.min(panes.len().saturating_sub(1));
                                            }
                                        }
                                    } else {
                                        restore_after_picker(
                                            p,
                                            &mut panes,
                                            &mut current_layout,
                                            &mut current_partition,
                                            &send_tx,
                                        )
                                        .await?;
                                    }
                                }
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                            continue;
                        }

                        // Layout overlay short-circuit: arrows move the
                        // Swap mode (Ctrl-A S): arrows move the highlight,
                        // Enter picks the source then the destination, Esc
                        // cancels. Short-circuits the normal key path so
                        // nothing leaks to the focused session mid-swap.
                        if let Some(mut sw) = swap {
                            let mut close = false;
                            let mut do_swap: Option<(usize, usize)> = None;
                            match key.code {
                                KeyCode::Esc => close = true,
                                KeyCode::Left | KeyCode::Char('h') => {
                                    sw.cursor = swap_nav(&panes, sw.cursor, SwapDir::Left);
                                }
                                KeyCode::Right | KeyCode::Char('l') => {
                                    sw.cursor = swap_nav(&panes, sw.cursor, SwapDir::Right);
                                }
                                KeyCode::Up | KeyCode::Char('k') => {
                                    sw.cursor = swap_nav(&panes, sw.cursor, SwapDir::Up);
                                }
                                KeyCode::Down | KeyCode::Char('j') => {
                                    sw.cursor = swap_nav(&panes, sw.cursor, SwapDir::Down);
                                }
                                KeyCode::Char(c) if c.is_ascii_digit() => {
                                    let slot = c.to_digit(10).unwrap_or(0) as usize;
                                    if slot >= 1 && slot <= panes.len() {
                                        sw.cursor = slot - 1;
                                    }
                                }
                                KeyCode::Enter => match sw.source {
                                    None => sw.source = Some(sw.cursor),
                                    Some(src) => {
                                        do_swap = Some((src, sw.cursor));
                                        close = true;
                                    }
                                },
                                _ => {}
                            }
                            swap = if close { None } else { Some(sw) };
                            if let Some((src, dst)) = do_swap {
                                perform_swap(
                                    src,
                                    dst,
                                    &mut panes,
                                    &send_tx,
                                    &cfg,
                                    &group_id,
                                    &mut current_group,
                                )
                                .await?;
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                None,
                                None,
                                &current_servers,
                            )?;
                            if let Some(sw) = swap.as_ref() {
                                draw_swap_overlay(&mut stdout, &panes, sw)?;
                            }
                            continue;
                        }

                        // selection, Enter applies + persists, Esc cancels.
                        if layout_picker.is_some() {
                            let lp = layout_picker.as_mut().unwrap();
                            match key.code {
                                KeyCode::Left | KeyCode::Up | KeyCode::Char('h') | KeyCode::Char('k') => {
                                    if lp.selected > 0 { lp.selected -= 1; }
                                }
                                KeyCode::Right | KeyCode::Down | KeyCode::Char('l') | KeyCode::Char('j') => {
                                    if lp.selected + 1 < lp.options.len() { lp.selected += 1; }
                                }
                                KeyCode::Home => lp.selected = 0,
                                KeyCode::End => lp.selected = lp.options.len().saturating_sub(1),
                                KeyCode::Enter => {
                                    let lp = layout_picker.take().unwrap();
                                    if let Some(partition) = lp.options.get(lp.selected).cloned() {
                                        let new_layout = layout_for_partition(&partition);
                                        current_layout = new_layout.clone();
                                        current_partition = partition;
                                        let (c, r) = terminal::size().unwrap_or((120, 36));
                                        apply_resize(&mut panes, &current_layout, &current_partition, c, r);
                                        for pane in &panes {
                                            if let Some(session) = &pane.session {
                                                let (h, w) = pane_inner_size(pane.rect);
                                                send_ws(&send_tx, client_resize_msg(session, h, w)).await?;
                                            }
                                        }
                                        // Persist for the browser too (best-effort).
                                        let _ = save_group_layout(&cfg, &group_id, &current_layout).await;
                                    }
                                }
                                KeyCode::Esc => { layout_picker = None; }
                                _ => {}
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                None,
                                None,
                                &current_servers,
                            )?;
                            if let Some(lp) = layout_picker.as_ref() {
                                draw_layout_overlay(&mut stdout, lp)?;
                            }
                            continue;
                        }

                        // Command-palette overlay (Ctrl-A P): same data and
                        // keys as the solo-attach palette, drawn as a modal
                        // over the mosaic. Pastes into the focused pane.
                        if palette_ov.is_some() {
                            let mut close = false;
                            let mut paste: Option<String> = None;
                            let mut dirty = false;
                            {
                                let pv = palette_ov.as_mut().unwrap();
                                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                                let shift = key.modifiers.contains(KeyModifiers::SHIFT);
                                let entry_slot =
                                    |entries: &[PaletteEntryDto], slot: u8| -> Option<usize> {
                                        entries.iter().position(|e| e.slot == slot)
                                    };
                                match &mut pv.mode {
                                    PaletteMode::Browse => match key.code {
                                        KeyCode::Esc | KeyCode::Char('q') => close = true,
                                        KeyCode::Char('c') if ctrl => close = true,
                                        KeyCode::Up if shift => {
                                            if entry_slot(&pv.entries, pv.selected).is_some()
                                                && pv.selected > 1
                                            {
                                                let (a, b) = (pv.selected, pv.selected - 1);
                                                for e in pv.entries.iter_mut() {
                                                    if e.slot == a {
                                                        e.slot = b;
                                                    } else if e.slot == b {
                                                        e.slot = a;
                                                    }
                                                }
                                                pv.entries.sort_by_key(|e| e.slot);
                                                pv.selected = b;
                                                dirty = true;
                                            }
                                        }
                                        KeyCode::Down if shift => {
                                            if entry_slot(&pv.entries, pv.selected).is_some()
                                                && pv.selected < 9
                                            {
                                                let (a, b) = (pv.selected, pv.selected + 1);
                                                for e in pv.entries.iter_mut() {
                                                    if e.slot == a {
                                                        e.slot = b;
                                                    } else if e.slot == b {
                                                        e.slot = a;
                                                    }
                                                }
                                                pv.entries.sort_by_key(|e| e.slot);
                                                pv.selected = b;
                                                dirty = true;
                                            }
                                        }
                                        KeyCode::Up => {
                                            if pv.selected > 1 {
                                                pv.selected -= 1;
                                            }
                                        }
                                        KeyCode::Down => {
                                            if pv.selected < 9 {
                                                pv.selected += 1;
                                            }
                                        }
                                        KeyCode::Char(c @ '1'..='9') => {
                                            let slot = c as u8 - b'0';
                                            match entry_slot(&pv.entries, slot) {
                                                Some(i) => {
                                                    paste =
                                                        Some(pv.entries[i].command.clone());
                                                    close = true;
                                                }
                                                None => pv.selected = slot,
                                            }
                                        }
                                        KeyCode::Enter => {
                                            match entry_slot(&pv.entries, pv.selected) {
                                                Some(i) => {
                                                    paste =
                                                        Some(pv.entries[i].command.clone());
                                                    close = true;
                                                }
                                                None => {
                                                    pv.mode = PaletteMode::Edit {
                                                        slot: pv.selected,
                                                        label: String::new(),
                                                        command: String::new(),
                                                        field: 0,
                                                    };
                                                }
                                            }
                                        }
                                        KeyCode::Char('a') | KeyCode::Char('A') => {
                                            let free = if entry_slot(&pv.entries, pv.selected)
                                                .is_none()
                                            {
                                                Some(pv.selected)
                                            } else {
                                                (1..=9u8).find(|s| {
                                                    entry_slot(&pv.entries, *s).is_none()
                                                })
                                            };
                                            if let Some(slot) = free {
                                                pv.selected = slot;
                                                pv.mode = PaletteMode::Edit {
                                                    slot,
                                                    label: String::new(),
                                                    command: String::new(),
                                                    field: 0,
                                                };
                                            }
                                        }
                                        KeyCode::Char('e') | KeyCode::Char('E') => {
                                            if let Some(i) =
                                                entry_slot(&pv.entries, pv.selected)
                                            {
                                                pv.mode = PaletteMode::Edit {
                                                    slot: pv.entries[i].slot,
                                                    label: pv.entries[i]
                                                        .label
                                                        .clone()
                                                        .unwrap_or_default(),
                                                    command: pv.entries[i].command.clone(),
                                                    field: 1,
                                                };
                                            }
                                        }
                                        KeyCode::Char('d')
                                        | KeyCode::Char('D')
                                        | KeyCode::Delete => {
                                            let sel = pv.selected;
                                            if entry_slot(&pv.entries, sel).is_some() {
                                                pv.entries.retain(|e| e.slot != sel);
                                                dirty = true;
                                            }
                                        }
                                        _ => {}
                                    },
                                    PaletteMode::Edit {
                                        slot,
                                        label,
                                        command,
                                        field,
                                    } => match key.code {
                                        KeyCode::Esc => pv.mode = PaletteMode::Browse,
                                        KeyCode::Char('c') if ctrl => {
                                            pv.mode = PaletteMode::Browse
                                        }
                                        KeyCode::Tab | KeyCode::Up | KeyCode::Down => {
                                            *field = (*field + 1) % 2
                                        }
                                        KeyCode::Enter => {
                                            let cmd = command.trim().to_string();
                                            if cmd.is_empty() {
                                                *field = 1;
                                            } else {
                                                let lbl = label.trim().to_string();
                                                let slot = *slot;
                                                pv.entries.retain(|e| e.slot != slot);
                                                pv.entries.push(PaletteEntryDto {
                                                    slot,
                                                    label: if lbl.is_empty() {
                                                        None
                                                    } else {
                                                        Some(lbl)
                                                    },
                                                    command: cmd,
                                                });
                                                pv.entries.sort_by_key(|e| e.slot);
                                                pv.mode = PaletteMode::Browse;
                                                dirty = true;
                                            }
                                        }
                                        KeyCode::Backspace => {
                                            if *field == 0 {
                                                label.pop();
                                            } else {
                                                command.pop();
                                            }
                                        }
                                        KeyCode::Char(c) if !ctrl => {
                                            if *field == 0 {
                                                if label.chars().count() < 60 {
                                                    label.push(c);
                                                }
                                            } else if command.chars().count() < 4000 {
                                                command.push(c);
                                            }
                                        }
                                        _ => {}
                                    },
                                }
                            }
                            if dirty {
                                let entries = &palette_ov.as_ref().unwrap().entries;
                                let body = serde_json::json!({ "commands": entries });
                                let _ = put_json(&cfg, "/api/cli/palette", &body).await;
                            }
                            if close {
                                palette_ov = None;
                            }
                            if let Some(cmd) = paste {
                                if let Some(pane) = panes.get(focused) {
                                    if let Some(session) = &pane.session {
                                        // Honour the inner app's bracketed-paste
                                        // mode (vt100 tracks DECSET 2004) so a
                                        // multi-line command lands as one paste.
                                        let text = if pane.parser.screen().bracketed_paste()
                                        {
                                            format!("\x1b[200~{cmd}\x1b[201~")
                                        } else {
                                            cmd
                                        };
                                        send_ws(&send_tx, client_input_msg(session, &text))
                                            .await?;
                                    }
                                }
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                None,
                                None,
                                &current_servers,
                            )?;
                            if let Some(pv) = palette_ov.as_ref() {
                                draw_mosaic_palette(&mut stdout, pv)?;
                            }
                            continue;
                        }

                        // Resize mode (Ctrl-A R): arrows grow/shrink the
                        // targeted pane (live, local-only preview), [ ] and
                        // digits move the target, Enter persists to the
                        // dashboard, Esc reverts to the layout on entry.
                        if resize.is_some() {
                            let pane_count = panes.len();
                            let mut commit = false;
                            let mut cancel = false;
                            let mut changed = false;
                            {
                                let rs = resize.as_mut().unwrap();
                                rs.pane = rs.pane.min(pane_count.saturating_sub(1));
                                match key.code {
                                    KeyCode::Esc => cancel = true,
                                    KeyCode::Enter => commit = true,
                                    KeyCode::Left | KeyCode::Char('h') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, -1, 0);
                                    }
                                    KeyCode::Right | KeyCode::Char('l') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 1, 0);
                                    }
                                    KeyCode::Up | KeyCode::Char('k') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 0, -1);
                                    }
                                    KeyCode::Down | KeyCode::Char('j') => {
                                        changed = resize_focused(&mut current_layout, &current_partition, rs.pane, 0, 1);
                                    }
                                    KeyCode::Char('[') => {
                                        if pane_count > 0 {
                                            rs.pane = (rs.pane + pane_count - 1) % pane_count;
                                            focused = rs.pane;
                                        }
                                    }
                                    KeyCode::Char(']') => {
                                        if pane_count > 0 {
                                            rs.pane = (rs.pane + 1) % pane_count;
                                            focused = rs.pane;
                                        }
                                    }
                                    KeyCode::Char(c) if c.is_ascii_digit() => {
                                        let slot = c.to_digit(10).unwrap_or(0) as usize;
                                        if slot >= 1 && slot <= pane_count {
                                            rs.pane = slot - 1;
                                            focused = rs.pane;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            if cancel {
                                current_layout = resize.take().unwrap().original;
                            } else if commit {
                                resize = None;
                            }
                            // Re-lay the panes (preview on change, restore on
                            // cancel) and tell live sessions their new size.
                            if changed || cancel || commit {
                                let (c, r) = terminal::size().unwrap_or((120, 36));
                                apply_resize(&mut panes, &current_layout, &current_partition, c, r);
                                for pane in &panes {
                                    if let Some(session) = &pane.session {
                                        let (h, w) = pane_inner_size(pane.rect);
                                        send_ws(&send_tx, client_resize_msg(session, h, w)).await?;
                                    }
                                }
                            }
                            if commit {
                                // Persist so the browser mosaic matches.
                                let _ = save_group_layout(&cfg, &group_id, &current_layout).await;
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                None,
                                None,
                                &current_servers,
                            )?;
                            if let Some(rs) = resize.as_ref() {
                                draw_resize_overlay(&mut stdout, &panes, rs)?;
                            }
                            continue;
                        }

                        // Ctrl-A S opens the swap-windows overlay (needs at
                        // least two panes to have something to swap).
                        if escape && matches!(key.code, KeyCode::Char('s') | KeyCode::Char('S')) {
                            escape = false;
                            if panes.len() >= 2 {
                                swap = Some(SwapState {
                                    source: None,
                                    cursor: focused.min(panes.len() - 1),
                                });
                                draw_group(
                                    &mut stdout,
                                    &current_group,
                                    &panes,
                                    focused,
                                    None,
                                    None,
                                    &current_servers,
                                )?;
                                if let Some(sw) = swap.as_ref() {
                                    draw_swap_overlay(&mut stdout, &panes, sw)?;
                                }
                            }
                            continue;
                        }

                        // Ctrl-A V opens the layout-arrangement overlay.
                        if escape && matches!(key.code, KeyCode::Char('v') | KeyCode::Char('V')) {
                            escape = false;
                            let options = allowed_partitions(panes.len());
                            if !options.is_empty() {
                                let selected = options
                                    .iter()
                                    .position(|p| p == &current_partition)
                                    .unwrap_or(0);
                                layout_picker = Some(LayoutPickerState { options, selected });
                                draw_group(
                                    &mut stdout,
                                    &current_group,
                                    &panes,
                                    focused,
                                    None,
                                    None,
                                    &current_servers,
                                )?;
                                if let Some(lp) = layout_picker.as_ref() {
                                    draw_layout_overlay(&mut stdout, lp)?;
                                }
                            }
                            continue;
                        }

                        // Ctrl-A P opens the command-palette overlay; the
                        // picked command pastes into the focused pane.
                        if escape && matches!(key.code, KeyCode::Char('p') | KeyCode::Char('P')) {
                            escape = false;
                            match get_json::<PalettePayload>(&cfg, "/api/cli/palette").await {
                                Ok(mut p) => {
                                    p.commands.sort_by_key(|e| e.slot);
                                    let selected =
                                        p.commands.first().map(|e| e.slot).unwrap_or(1);
                                    palette_ov = Some(MosaicPaletteState {
                                        entries: p.commands,
                                        selected,
                                        mode: PaletteMode::Browse,
                                    });
                                }
                                Err(_) => {
                                    // Dashboard unreachable / not logged in —
                                    // nothing to show; stay in the mosaic.
                                }
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                None,
                                None,
                                &current_servers,
                            )?;
                            if let Some(pv) = palette_ov.as_ref() {
                                draw_mosaic_palette(&mut stdout, pv)?;
                            }
                            continue;
                        }

                        // Ctrl-A R enters resize mode for the focused pane.
                        // Only useful when there's something to trade space
                        // with (>1 column in a row, or >1 row).
                        if escape && matches!(key.code, KeyCode::Char('r') | KeyCode::Char('R')) {
                            escape = false;
                            if panes.len() >= 2 {
                                resize = Some(ResizeState {
                                    pane: focused.min(panes.len() - 1),
                                    original: current_layout.clone(),
                                });
                                draw_group(
                                    &mut stdout,
                                    &current_group,
                                    &panes,
                                    focused,
                                    None,
                                    None,
                                    &current_servers,
                                )?;
                                if let Some(rs) = resize.as_ref() {
                                    draw_resize_overlay(&mut stdout, &panes, rs)?;
                                }
                            }
                            continue;
                        }

                        // Ctrl-A N opens the inline picker — pre-allocate a
                        // slot, drop the user's input mode, render the
                        // server list inside the new pane.
                        if escape
                            && matches!(key.code, KeyCode::Char('n') | KeyCode::Char('N'))
                        {
                            escape = false;
                            // Pull a fresh detail so the picker lists the
                            // currently-free standalone sessions plus the
                            // servers; fall back to servers-only if the
                            // fetch fails.
                            let choices = match fetch_group_detail(&cfg, &group_id).await {
                                Ok(d) => build_picker_choices(&d.free_sessions, &d.servers),
                                Err(_) => build_picker_choices(&[], &current_servers),
                            };
                            if let Some(p) = enter_picker_mode(
                                &mut panes,
                                &mut current_layout,
                                &mut current_partition,
                                &send_tx,
                                choices,
                            )
                            .await?
                            {
                                focused = panes.len(); // points "past" panes;
                                                       // picker draws there
                                picker = Some(p);
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                            continue;
                        }

                        // Ctrl-A X: detach the focused pane's session
                        // from the group. The shell keeps running on
                        // the host — this is the reversible counterpart
                        // to Ctrl-A K. No confirm overlay because
                        // there's nothing destructive to undo.
                        if escape
                            && matches!(key.code, KeyCode::Char('x') | KeyCode::Char('X'))
                        {
                            escape = false;
                            let session_id = panes
                                .get(focused.min(panes.len().saturating_sub(1)))
                                .and_then(|p| p.session.as_ref().map(|s| s.id.clone()));
                            if let Some(session_id) = session_id {
                                let url = format!(
                                    "/api/cli/groups/{group_id}/members/{session_id}"
                                );
                                match delete_request(&cfg, &url).await {
                                    Ok(resp) => {
                                        let group_deleted = resp
                                            .get("groupDeleted")
                                            .and_then(|v| v.as_bool())
                                            == Some(true);
                                        if group_deleted {
                                            break;
                                        }
                                        if let Ok(latest) =
                                            fetch_group_detail(&cfg, &group_id).await
                                        {
                                            if latest.group.members.is_empty() {
                                                break;
                                            }
                                            reconcile_after_fetch(
                                                latest,
                                                &mut current_group,
                                                &mut current_servers,
                                                &mut current_layout,
                                                &mut current_partition,
                                                &mut server_labels,
                                                &mut panes,
                                                &mut focused,
                                                &send_tx,
                                            )
                                            .await?;
                                        }
                                    }
                                    Err(_) => {
                                        // Best-effort: swallow the error
                                        // so a transient API failure
                                        // doesn't drop the user out of
                                        // the group view.
                                    }
                                }
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                            continue;
                        }

                        // Ctrl-A K: open the kill-session Y/n overlay
                        // anchored over the focused pane. Doesn't kill
                        // anything until the user types Y.
                        if escape
                            && matches!(key.code, KeyCode::Char('k') | KeyCode::Char('K'))
                        {
                            escape = false;
                            if let Some(session) = panes
                                .get(focused.min(panes.len().saturating_sub(1)))
                                .and_then(|p| p.session.as_ref().map(|s| (s, p.rect)))
                            {
                                let (session, rect) = session;
                                confirm = Some(ConfirmState {
                                    target_session_id: session.id.clone(),
                                    target_session_name: session.session_name.clone(),
                                    target_rect: rect,
                                    action: ConfirmAction::KillSession,
                                });
                            }
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                            continue;
                        }

                        let focused_session = panes
                            .get(focused.min(panes.len().saturating_sub(1)))
                            .and_then(|p| p.session.clone());
                        if handle_key(
                            key,
                            &mut escape,
                            &mut focused,
                            panes.len(),
                            &send_tx,
                            focused_session.as_ref(),
                        ).await? {
                            break;
                        }
                        draw_group(
                            &mut stdout,
                            &current_group,
                            &panes,
                            focused,
                            picker.as_ref(),
                            confirm.as_ref(),
                            &current_servers,
                        )?;
                    }
                    Event::Resize(cols, rows) => {
                        apply_resize(&mut panes, &current_layout, &current_partition, cols, rows);
                        for pane in &panes {
                            if let Some(session) = &pane.session {
                                let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
                                send_ws(
                                    &send_tx,
                                    client_resize_msg(session, inner_rows, inner_cols),
                                ).await?;
                            }
                        }
                        // The picker lives in a rect computed off the
                        // larger preview partition, so recompute it
                        // against the new terminal size too.
                        if let Some(p) = picker.as_mut() {
                            let preview_count = panes.len() + 1;
                            let rects = compute_rects(
                                &current_layout,
                                &current_partition,
                                cols,
                                rows,
                            );
                            if let Some(target) = rects.get(preview_count - 1) {
                                p.target_rect = *target;
                            }
                        }
                        draw_group(
                            &mut stdout,
                            &current_group,
                            &panes,
                            focused,
                            picker.as_ref(),
                            confirm.as_ref(),
                            &current_servers,
                        )?;
                        if let Some(lp) = layout_picker.as_ref() {
                            draw_layout_overlay(&mut stdout, lp)?;
                        }
                        if let Some(sw) = swap.as_ref() {
                            draw_swap_overlay(&mut stdout, &panes, sw)?;
                        }
                        if let Some(rs) = resize.as_ref() {
                            draw_resize_overlay(&mut stdout, &panes, rs)?;
                        }
                    }
                    _ => {}
                }
            }
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_msg(&mut panes, text.as_str(), &send_tx).await;
                        // Skip the repaint while the layout overlay is up so
                        // it isn't erased; output is still parsed above and
                        // shows once the overlay closes.
                        if layout_picker.is_none() {
                            draw_group(
                                &mut stdout,
                                &current_group,
                                &panes,
                                focused,
                                picker.as_ref(),
                                confirm.as_ref(),
                                &current_servers,
                            )?;
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            handle_server_msg(&mut panes, text, &send_tx).await;
                            if layout_picker.is_none() {
                                draw_group(
                                    &mut stdout,
                                    &current_group,
                                    &panes,
                                    focused,
                                    picker.as_ref(),
                                    confirm.as_ref(),
                                    &current_servers,
                                )?;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(anyhow!("websocket error: {e}")),
                }
                // Live output just repainted the panes — restore the swap
                // chrome on top so its badges/banner aren't erased.
                if let Some(sw) = swap.as_ref() {
                    draw_swap_overlay(&mut stdout, &panes, sw)?;
                }
                if let Some(rs) = resize.as_ref() {
                    draw_resize_overlay(&mut stdout, &panes, rs)?;
                }
                // Every live session reported `session:lost` — the shells
                // all exited (or were killed) out from under us. There's
                // nothing left to attach to or forward keystrokes into, so
                // exit instead of freezing on a mosaic of dead panes that
                // swallows Ctrl-C. The membership poll would eventually
                // catch this too, but only after the server reconciles
                // (up to 60 s) — and once it deletes the empty group the
                // poll's fetch starts 404ing forever.
                if all_sessions_lost(&panes) {
                    ended_msg = Some("All sessions in this group have ended.");
                    break;
                }
            }
            _ = membership_poll.tick() => {
                // Don't fight the user mid-overlay — once they've opened
                // the inline picker or a Y/n confirm modal we freeze
                // the periodic refresh until they finish.
                if picker.is_some()
                    || confirm.is_some()
                    || layout_picker.is_some()
                    || swap.is_some()
                    || resize.is_some()
                {
                    continue;
                }
                let latest = match fetch_group_detail_status(&cfg, &group_id).await {
                    // The server auto-deletes a group once its last live
                    // session dies, so the endpoint 404s. Exit rather than
                    // retry the now-missing group forever.
                    Ok(GroupFetch::Gone) => {
                        ended_msg = Some("All sessions in this group have ended.");
                        break;
                    }
                    Ok(GroupFetch::Found(latest)) => latest,
                    // Best-effort: a transient HTTP failure shouldn't drop
                    // the user out of the group view.
                    Err(_) => continue,
                };
                if latest.group.members.is_empty() {
                    // Last terminal removed → exit, otherwise we'd keep
                    // an empty mosaic on screen forever.
                    ended_msg = Some("All sessions in this group have ended.");
                    break;
                }
                // Detect membership/order changes (Vec<String> equality
                // is order-sensitive) *and* layout edits made in the
                // browser (column widths, row partition, etc.). Either
                // alone is enough to rebuild — the dashboard doesn't
                // push these so the poll is our only signal.
                let current_ids: Vec<String> =
                    panes.iter().map(|p| p.slot_key.clone()).collect();
                let latest_ids: Vec<String> =
                    latest.group.members.iter().map(|m| m.id.clone()).collect();
                let latest_layout_norm =
                    valid_layout_or_default(latest.layout.clone(), latest.group.members.len());
                let latest_partition =
                    active_partition(&latest_layout_norm, latest.group.members.len());
                let unchanged = latest_ids == current_ids
                    && latest_partition == current_partition
                    && latest_layout_norm == current_layout;
                if unchanged {
                    continue;
                }
                reconcile_after_fetch(
                    latest,
                    &mut current_group,
                    &mut current_servers,
                    &mut current_layout,
                    &mut current_partition,
                    &mut server_labels,
                    &mut panes,
                    &mut focused,
                    &send_tx,
                )
                .await?;
                draw_group(
                    &mut stdout,
                    &current_group,
                    &panes,
                    focused,
                    picker.as_ref(),
                    confirm.as_ref(),
                    &current_servers,
                )?;
            }
        }
    }

    drop(send_tx);
    writer.abort();
    // Restore the normal screen before printing so the message lands in
    // the user's scrollback rather than being wiped by the alt-screen exit.
    drop(_guard);
    if let Some(msg) = ended_msg {
        println!("{msg}");
    }
    Ok(())
}

/// True once the group has at least one session pane and *every* session
/// pane has reported `session:lost`. Group panes always carry a session
/// (unlike stack placeholders), so this is the signal that the whole
/// mosaic has gone dead and there's nothing left to drive.
fn all_sessions_lost(panes: &[Pane]) -> bool {
    let mut any_session = false;
    for pane in panes {
        if pane.session.is_some() {
            any_session = true;
            if pane.lost.is_none() {
                return false;
            }
        }
    }
    any_session
}

fn build_server_labels(servers: &[CliServer]) -> HashMap<String, String> {
    servers
        .iter()
        .map(|s| {
            (
                s.id.clone(),
                format!("{}@{} ({})", s.username, s.host, s.name),
            )
        })
        .collect()
}

/// Replace the in-memory group state with the dashboard's view, then
/// rebuild the pane vector preserving vt100 scrollback for any session
/// that survived. Sends WS attach for brand-new panes and a resize for
/// every pane whose rect changed. Shared between the periodic poll and
/// the post-confirm path of the inline picker so the two stay in sync.
#[allow(clippy::too_many_arguments)]
async fn reconcile_after_fetch(
    latest: CliGroupDetail,
    current_group: &mut Group,
    current_servers: &mut Vec<CliServer>,
    current_layout: &mut GroupLayout,
    current_partition: &mut Vec<usize>,
    server_labels: &mut HashMap<String, String>,
    panes: &mut Vec<Pane>,
    focused: &mut usize,
    send_tx: &mpsc::Sender<String>,
) -> Result<()> {
    let prior_ids: std::collections::HashSet<String> =
        panes.iter().map(|p| p.slot_key.clone()).collect();

    let CliGroupDetail {
        group: new_group,
        layout: new_layout,
        servers: new_servers,
        ..
    } = latest;
    *current_group = new_group;
    *current_servers = new_servers;
    *current_layout = valid_layout_or_default(new_layout, current_group.members.len());
    *current_partition = active_partition(current_layout, current_group.members.len());
    *server_labels = build_server_labels(current_servers);

    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let fresh = build_panes(
        current_group,
        server_labels,
        current_layout,
        current_partition,
        cols,
        rows,
    );

    let mut preserved: HashMap<String, vt100::Parser> = HashMap::new();
    for old in panes.drain(..) {
        preserved.insert(old.slot_key.clone(), old.parser);
    }
    let mut rebuilt = Vec::with_capacity(fresh.len());
    for mut p in fresh {
        if let Some(parser) = preserved.remove(&p.slot_key) {
            let (h, w) = pane_inner_size(p.rect);
            let mut reused = parser;
            reused.set_size(h, w);
            p.parser = reused;
        }
        rebuilt.push(p);
    }
    *panes = rebuilt;
    *focused = (*focused).min(panes.len().saturating_sub(1));

    for pane in panes.iter() {
        let Some(session) = &pane.session else { continue };
        let is_new = !prior_ids.contains(&pane.slot_key);
        let (h, w) = pane_inner_size(pane.rect);
        if is_new {
            send_ws(send_tx, client_attach_msg(session)).await?;
        }
        send_ws(send_tx, client_resize_msg(session, h, w)).await?;
    }
    Ok(())
}


/// Ctrl-A V layout overlay: pick a row arrangement (the same options the
/// web dashboard offers) from a horizontal strip of mini-grid previews.
struct LayoutPickerState {
    options: Vec<Vec<usize>>,
    selected: usize,
}

/// "2 + 2" style label for a partition.
fn partition_label(p: &[usize]) -> String {
    p.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(" + ")
}

/// A small 3-line × 11-col block-grid preview of a partition (rows of
/// cells). Width 11 is deliberate: with single-space gaps it divides
/// evenly for 1–4 columns (11, 10/2, 9/3, 8/4), so every cell in a row is
/// the same width — no lopsided "█ █ ██" rows. Multi-row partitions get a
/// blank gap line between bands, mirroring the single-space gaps between
/// columns, so e.g. "2 + 2" reads as two stacked rows rather than one.
fn partition_preview(p: &[usize]) -> [String; 3] {
    const W: usize = 11;
    const H: usize = 3;
    let blank = " ".repeat(W);
    let rows = p.len().max(1);
    // Render each band's block string (columns split by single-space gaps).
    let bands: Vec<String> = (0..rows)
        .map(|band| {
            let count = (*p.get(band).unwrap_or(&1)).max(1);
            let gap = count.saturating_sub(1);
            let fill = W.saturating_sub(gap);
            let base = fill / count;
            let extra = fill % count;
            let mut s = String::with_capacity(W);
            for c in 0..count {
                if c > 0 {
                    s.push(' ');
                }
                let cw = base + if c < extra { 1 } else { 0 };
                for _ in 0..cw.max(1) {
                    s.push('█');
                }
            }
            while s.chars().count() < W {
                s.push(' ');
            }
            s
        })
        .collect();
    // Stack bands top-to-bottom with a blank gap line between them, then
    // distribute any remaining height by growing each band evenly.
    let gaps = rows.saturating_sub(1);
    let content = H.saturating_sub(gaps).max(rows);
    let per = content / rows;
    let extra = content % rows;
    let mut lines: Vec<String> = Vec::with_capacity(H);
    for (band, s) in bands.iter().enumerate() {
        let bh = (per + if band < extra { 1 } else { 0 }).max(1);
        for _ in 0..bh {
            lines.push(s.clone());
        }
        if band + 1 < rows {
            lines.push(blank.clone());
        }
    }
    // Guarantee exactly H lines (truncate overflow, pad shortfall).
    lines.resize(H, blank.clone());
    [lines[0].clone(), lines[1].clone(), lines[2].clone()]
}

fn handle_picker_key(key: KeyEvent, picker: &mut PickerState) -> PickerKeyResult {
    let count = picker.choices.len();
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            if picker.selected > 0 {
                picker.selected -= 1;
            }
            PickerKeyResult::Idle
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if picker.selected + 1 < count {
                picker.selected += 1;
            }
            PickerKeyResult::Idle
        }
        KeyCode::Home => {
            picker.selected = 0;
            PickerKeyResult::Idle
        }
        KeyCode::End => {
            picker.selected = count.saturating_sub(1);
            PickerKeyResult::Idle
        }
        KeyCode::Enter => PickerKeyResult::Confirm,
        KeyCode::Esc => PickerKeyResult::Cancel,
        _ => PickerKeyResult::Idle,
    }
}

/// Enter inline-picker mode: shrink the existing panes to fit a preview
/// layout one slot larger, send a WS resize so the remote PTYs reflow,
/// and return a `PickerState` pointing at the freshly-opened slot.
/// Returns `Ok(None)` (a no-op) when the group is already at the
/// 6-member cap or there's nothing to pick (no free sessions and no
/// servers), so the caller can leave the view as-is.
async fn enter_picker_mode(
    panes: &mut [Pane],
    current_layout: &mut GroupLayout,
    current_partition: &mut Vec<usize>,
    send_tx: &mpsc::Sender<String>,
    choices: Vec<PickerChoice>,
) -> Result<Option<PickerState>> {
    if panes.len() >= 6 || choices.is_empty() {
        return Ok(None);
    }
    let new_count = panes.len() + 1;
    let new_partition = default_partition(new_count);
    let new_layout = layout_for_partition(&new_partition);
    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let rects = compute_rects(&new_layout, &new_partition, cols, rows);
    if rects.len() < new_count {
        return Ok(None);
    }

    let saved_layout = current_layout.clone();
    let saved_partition = current_partition.clone();

    for (i, pane) in panes.iter_mut().enumerate() {
        if let Some(rect) = rects.get(i) {
            pane.rect = *rect;
            let (h, w) = pane_inner_size(*rect);
            pane.parser.set_size(h, w);
        }
    }
    for pane in panes.iter() {
        if let Some(session) = &pane.session {
            let (h, w) = pane_inner_size(pane.rect);
            send_ws(send_tx, client_resize_msg(session, h, w)).await?;
        }
    }

    *current_layout = new_layout;
    *current_partition = new_partition;

    Ok(Some(PickerState {
        target_rect: rects[new_count - 1],
        selected: 0,
        choices,
        saved_layout,
        saved_partition,
    }))
}

/// Undo what `enter_picker_mode` did: restore the prior layout/partition
/// and reflow the remaining panes back to their original rects.
async fn restore_after_picker(
    picker: PickerState,
    panes: &mut [Pane],
    current_layout: &mut GroupLayout,
    current_partition: &mut Vec<usize>,
    send_tx: &mpsc::Sender<String>,
) -> Result<()> {
    *current_layout = picker.saved_layout;
    *current_partition = picker.saved_partition;
    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    apply_resize(panes, current_layout, current_partition, cols, rows);
    for pane in panes.iter() {
        if let Some(session) = &pane.session {
            let (h, w) = pane_inner_size(pane.rect);
            send_ws(send_tx, client_resize_msg(session, h, w)).await?;
        }
    }
    Ok(())
}

/// `focused_session` is `None` when the focused pane is a stack
/// placeholder (service not running): focus-switching and detach still
/// work, but keystrokes have nowhere to go, so input forwarding is a
/// no-op. Group panes always pass `Some`.
async fn handle_key(
    key: KeyEvent,
    escape: &mut bool,
    focused: &mut usize,
    pane_count: usize,
    send_tx: &mpsc::Sender<String>,
    focused_session: Option<&GroupSession>,
) -> Result<bool> {
    const CTRL_A: char = 'a';
    if *escape {
        *escape = false;
        match key.code {
            KeyCode::Char('d') | KeyCode::Char('D') => return Ok(true),
            KeyCode::Char(c) if c.is_ascii_digit() => {
                let slot = c.to_digit(10).unwrap_or(0) as usize;
                if slot >= 1 && slot <= pane_count {
                    *focused = slot - 1;
                }
                return Ok(false);
            }
            KeyCode::Char('[') => {
                if pane_count > 0 {
                    *focused = (*focused + pane_count - 1) % pane_count;
                }
                return Ok(false);
            }
            KeyCode::Char(']') => {
                if pane_count > 0 {
                    *focused = (*focused + 1) % pane_count;
                }
                return Ok(false);
            }
            KeyCode::Char(CTRL_A) => {
                if let Some(session) = focused_session {
                    send_ws(send_tx, client_input_msg(session, "\x01")).await?;
                }
                return Ok(false);
            }
            _ => {
                if let Some(session) = focused_session {
                    send_ws(send_tx, client_input_msg(session, "\x01")).await?;
                }
            }
        }
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char(CTRL_A) {
        *escape = true;
        return Ok(false);
    }

    if let Some(input) = key_to_terminal_input(key) {
        if let Some(session) = focused_session {
            send_ws(send_tx, client_input_msg(session, &input)).await?;
        }
    }
    Ok(false)
}

async fn handle_server_msg(panes: &mut [Pane], text: &str, send_tx: &mpsc::Sender<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("terminal:output") => {
            let Some(session_id) = value.get("sessionId").and_then(|v| v.as_str()) else {
                return;
            };
            let Some(data) = value.get("data").and_then(|v| v.as_str()) else {
                return;
            };
            if let Some(pane) = panes
                .iter_mut()
                .find(|p| p.session.as_ref().map(|s| s.id.as_str()) == Some(session_id))
            {
                pane.parser.process(data.as_bytes());
            }
        }
        Some("session:lost") => {
            let Some(session_id) = value.get("sessionId").and_then(|v| v.as_str()) else {
                return;
            };
            let reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("lost")
                .to_string();
            if let Some(pane) = panes
                .iter_mut()
                .find(|p| p.session.as_ref().map(|s| s.id.as_str()) == Some(session_id))
            {
                pane.lost = Some(reason);
            }
        }
        Some("session:state") => {
            // The dashboard has confirmed the attach and the live output
            // pipe is now up. Nudge a resize — a one-column "wiggle" back to
            // the pane size — so the remote shell repaints its prompt now
            // that we're subscribed. Without this, a slow cross-server
            // attach can race ahead of its subscription and miss the
            // initial resize's redraw, leaving the pane blank until the user
            // presses Enter. The two distinct sizes guarantee a SIGWINCH
            // regardless of the session's prior size.
            let Some(session_id) = value
                .get("session")
                .and_then(|s| s.get("sessionId"))
                .and_then(|v| v.as_str())
            else {
                return;
            };
            let target = panes.iter().find_map(|p| {
                let s = p.session.as_ref()?;
                if s.id == session_id {
                    Some((s.clone(), pane_inner_size(p.rect)))
                } else {
                    None
                }
            });
            if let Some((session, (h, w))) = target {
                let w0 = w.saturating_sub(1).max(8);
                if w0 != w {
                    let _ = send_ws(send_tx, client_resize_msg(&session, h, w0)).await;
                }
                let _ = send_ws(send_tx, client_resize_msg(&session, h, w)).await;
            }
        }
        _ => {}
    }
}

fn key_to_terminal_input(key: KeyEvent) -> Option<String> {
    let mut out = match key.code {
        KeyCode::Backspace => "\x7f".to_string(),
        KeyCode::Enter => "\r".to_string(),
        KeyCode::Left => "\x1b[D".to_string(),
        KeyCode::Right => "\x1b[C".to_string(),
        KeyCode::Up => "\x1b[A".to_string(),
        KeyCode::Down => "\x1b[B".to_string(),
        KeyCode::Home => "\x1b[H".to_string(),
        KeyCode::End => "\x1b[F".to_string(),
        KeyCode::PageUp => "\x1b[5~".to_string(),
        KeyCode::PageDown => "\x1b[6~".to_string(),
        KeyCode::Tab => "\t".to_string(),
        KeyCode::BackTab => "\x1b[Z".to_string(),
        KeyCode::Delete => "\x1b[3~".to_string(),
        KeyCode::Insert => "\x1b[2~".to_string(),
        KeyCode::Esc => "\x1b".to_string(),
        KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::CONTROL) => ctrl_char(c)?,
        KeyCode::Char(c) => c.to_string(),
        _ => return None,
    };
    if key.modifiers.contains(KeyModifiers::ALT) {
        out.insert(0, '\x1b');
    }
    Some(out)
}

fn ctrl_char(c: char) -> Option<String> {
    let c = c.to_ascii_lowercase();
    if c.is_ascii_lowercase() {
        let byte = (c as u8) - b'a' + 1;
        return Some((byte as char).to_string());
    }
    match c {
        '[' => Some("\x1b".to_string()),
        ']' => Some("\x1d".to_string()),
        '^' => Some("\x1e".to_string()),
        '_' => Some("\x1f".to_string()),
        ' ' => Some("\0".to_string()),
        _ => None,
    }
}

fn draw_group(
    stdout: &mut Stdout,
    group: &Group,
    panes: &[Pane],
    focused: usize,
    picker: Option<&PickerState>,
    confirm: Option<&ConfirmState>,
    _servers: &[CliServer],
) -> Result<()> {
    queue!(stdout, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    draw_status_bar(
        stdout,
        group,
        panes,
        focused,
        cols,
        picker.is_some(),
        confirm,
    )?;
    // When an overlay (picker or confirm) is active, the focused
    // indicator belongs on the overlay, not on any real pane — every
    // existing pane renders in its dim "inactive" state.
    let pane_focused = (picker.is_none() && confirm.is_none()).then_some(focused);
    for (i, pane) in panes.iter().enumerate() {
        let active = pane_focused.map(|f| f == i).unwrap_or(false);
        draw_pane(stdout, pane, active, i + 1)?;
    }
    if let Some(p) = picker {
        draw_picker(stdout, p, panes.len() + 1)?;
    }
    if let Some(c) = confirm {
        draw_confirm(stdout, c)?;
    }
    stdout.flush()?;
    Ok(())
}

/// Status bar at the very top of the screen. Renders the segments with
/// individual colors and tracks the visible width so we can pad-clear the
/// rest of the row without ANSI escapes counting toward the column
/// budget. Keeping the segment list and width tracking in one pass keeps
/// the colors and the padding in sync.
fn draw_status_bar(
    stdout: &mut Stdout,
    group: &Group,
    panes: &[Pane],
    focused: usize,
    cols: u16,
    picker_active: bool,
    confirm: Option<&ConfirmState>,
) -> Result<()> {
    let active_slot = focused + 1;
    let active_name = panes
        .get(focused)
        .map(|p| p.title.as_str())
        .unwrap_or("?");
    let confirm_text = confirm.map(|c| match c.action {
        ConfirmAction::KillSession => format!("kill {}?", c.target_session_name),
    });
    let active_text = if let Some(text) = confirm_text.as_ref() {
        text.clone()
    } else if picker_active {
        format!("adding terminal to slot {}", panes.len() + 1)
    } else {
        format!("active {}:{}", active_slot, active_name)
    };
    let hints = if confirm.is_some() {
        "Y to confirm · any other key cancels"
    } else if picker_active {
        "↑/↓ pick · Enter confirm · Esc cancel"
    } else {
        "Ctrl-A D detach · 1-6 focus · [/] cycle · N add · S swap · V layout · R resize · X detach · K kill"
    };

    let t = theme();
    let active_color = if confirm.is_some() {
        t.danger
    } else if picker_active {
        t.warning
    } else {
        t.info
    };
    let segments: [(&str, Color, bool); 7] = [
        ("managet group:", t.heading, true),
        (" ", t.name, false),
        (group.name.as_str(), t.name, true),
        ("  │  ", t.separator, false),
        (active_text.as_str(), active_color, false),
        ("  │  ", t.separator, false),
        (hints, t.hint, false),
    ];

    render_status_segments(stdout, &segments, cols)
}

/// Render a top status bar: print each colored segment left-to-right,
/// clipping to the column budget, then pad-clear the rest of the row.
/// ANSI escapes don't count toward the visible width because we track it
/// from the plain text. Shared by the group and stack status bars.
fn render_status_segments(
    stdout: &mut Stdout,
    segments: &[(&str, Color, bool)],
    cols: u16,
) -> Result<()> {
    queue!(stdout, MoveTo(0, 0))?;
    let mut written: usize = 0;
    let budget = cols as usize;
    for (text, color, bold) in segments {
        if written >= budget {
            break;
        }
        let remaining = budget - written;
        let visible_len = text.chars().count();
        let to_print: String = if visible_len <= remaining {
            text.to_string()
        } else {
            text.chars().take(remaining).collect()
        };
        let printed_len = to_print.chars().count();
        queue!(stdout, SetForegroundColor(*color))?;
        if *bold {
            queue!(stdout, SetAttribute(Attribute::Bold))?;
        }
        queue!(stdout, Print(&to_print))?;
        if *bold {
            queue!(stdout, SetAttribute(Attribute::Reset))?;
        }
        written += printed_len;
    }
    queue!(stdout, ResetColor)?;
    if written < budget {
        queue!(stdout, Print(" ".repeat(budget - written)))?;
    }
    Ok(())
}

fn draw_pane(stdout: &mut Stdout, pane: &Pane, active: bool, slot: usize) -> Result<()> {
    let r = pane.rect;
    if r.w < 4 || r.h < 3 {
        return Ok(());
    }

    // The active pane gets the theme's accent border and bold title;
    // inactive panes use the dim border color so the focused window is the
    // one that catches the eye even in a 6-up mosaic.
    let t = theme();
    let b = t.borders;
    let border_color = if active { t.border_active } else { t.border_inactive };
    let title_color = if active { t.title_active } else { t.title_inactive };

    let horizontal = b.h.repeat(r.w.saturating_sub(2) as usize);
    queue!(
        stdout,
        SetForegroundColor(border_color),
        MoveTo(r.x, r.y),
        Print(b.tl),
        Print(&horizontal),
        Print(b.tr),
    )?;
    for y in r.y + 1..r.y + r.h.saturating_sub(1) {
        queue!(stdout, MoveTo(r.x, y), Print(b.v))?;
        queue!(stdout, MoveTo(r.x + r.w.saturating_sub(1), y), Print(b.v))?;
    }
    queue!(
        stdout,
        MoveTo(r.x, r.y + r.h.saturating_sub(1)),
        Print(b.bl),
        Print(&horizontal),
        Print(b.br),
        ResetColor,
    )?;

    // Build a plain version of the title to compute visible width, then
    // emit colored segments fit to the available width.
    let max_title = r.w.saturating_sub(4) as usize;
    let bullet = if active { "●" } else { "○" };
    // Placeholder panes (stack service not running) report "not running"
    // in grey; live panes use the session's own status color.
    let status_text = pane
        .session
        .as_ref()
        .map(|s| s.status.clone())
        .unwrap_or_else(|| "not running".to_string());
    let status_color = status_to_color(&status_text);
    let segments: [(String, Color, bool); 8] = [
        (format!("{bullet} "), border_color, false),
        (format!("{slot} "), title_color, true),
        (pane.title.clone(), title_color, true),
        (" [".to_string(), t.separator, false),
        (status_text, status_color, false),
        ("] ".to_string(), t.separator, false),
        ("@ ".to_string(), t.separator, false),
        (pane.server_label.clone(), t.server_label, false),
    ];
    queue!(stdout, MoveTo(r.x + 2, r.y))?;
    let mut written = 0usize;
    for (text, color, bold) in &segments {
        if written >= max_title {
            break;
        }
        let remaining = max_title - written;
        let visible = text.chars().count();
        let cut: String = if visible <= remaining {
            text.clone()
        } else {
            text.chars().take(remaining).collect()
        };
        let len = cut.chars().count();
        queue!(stdout, SetForegroundColor(*color))?;
        if *bold {
            queue!(stdout, SetAttribute(Attribute::Bold))?;
        }
        queue!(stdout, Print(&cut))?;
        if *bold {
            queue!(stdout, SetAttribute(Attribute::Reset))?;
        }
        written += len;
    }
    queue!(stdout, ResetColor)?;

    // Stack panes carry a live resource readout (CPU/mem/temp). Paint it
    // right-aligned on the bottom border so it never collides with the
    // title or the inner terminal. Group panes leave `stats` None.
    if let Some(stats) = pane.stats.as_ref().filter(|s| s.any()) {
        let badge = format!(" {} ", stats.label());
        let badge_w = badge.chars().count();
        if (r.w as usize) > badge_w + 3 {
            let bx = r.x + r.w.saturating_sub(1) - badge_w as u16;
            let stat_color = if active { t.info } else { t.hint };
            queue!(
                stdout,
                MoveTo(bx, r.y + r.h.saturating_sub(1)),
                SetForegroundColor(stat_color),
                Print(badge),
                SetForegroundColor(border_color),
                ResetColor,
            )?;
        }
    }

    let inner_w = r.w.saturating_sub(2);
    let inner_h = r.h.saturating_sub(2);

    // Placeholder pane: a stack service that isn't running yet. Mirror the
    // web's "Service not running" cell with a centered dim message; the
    // pane flips to a live terminal once the runtime poll sees a session.
    if pane.session.is_none() {
        let msg = "service not running";
        let mid_y = r.y + 1 + inner_h / 2;
        let pad = (inner_w as usize).saturating_sub(msg.chars().count()) / 2;
        let line = format!("{}{}", " ".repeat(pad), msg);
        queue!(
            stdout,
            MoveTo(r.x + 1, mid_y),
            SetForegroundColor(t.hint),
            Print(fit_text(&line, inner_w as usize)),
            ResetColor,
        )?;
        return Ok(());
    }

    if let Some(reason) = &pane.lost {
        queue!(
            stdout,
            MoveTo(r.x + 1, r.y + 1),
            SetForegroundColor(t.danger),
            Print(fit_text(
                &format!("session lost: {reason}"),
                inner_w as usize
            )),
            ResetColor,
        )?;
        return Ok(());
    }

    // Use `rows_formatted` (not `rows`) so the inner shell's ANSI
    // colors/attributes survive. vt100 yields each row as a byte stream
    // with the right SGR escapes embedded; we bracket every row with a
    // ResetColor so leftover attributes from one cell don't bleed into
    // the next pane's border (which we draw separately with its own
    // colors).
    for (row_idx, formatted) in pane
        .parser
        .screen()
        .rows_formatted(0, inner_w)
        .take(inner_h as usize)
        .enumerate()
    {
        queue!(
            stdout,
            MoveTo(r.x + 1, r.y + 1 + row_idx as u16),
            ResetColor,
        )?;
        stdout.write_all(&formatted)?;
        queue!(stdout, ResetColor)?;
    }
    Ok(())
}

/// Render the inline server picker inside the pre-allocated empty
/// slot. Uses the same Unicode border treatment as `draw_pane` so the
/// new slot visually belongs to the mosaic, with a cyan-bold title
/// announcing the picker mode.
fn draw_picker(stdout: &mut Stdout, picker: &PickerState, slot: usize) -> Result<()> {
    let r = picker.target_rect;
    if r.w < 4 || r.h < 3 {
        return Ok(());
    }
    let t = theme();
    let b = t.borders;
    let horizontal = b.h.repeat(r.w.saturating_sub(2) as usize);
    queue!(
        stdout,
        SetForegroundColor(t.accent),
        MoveTo(r.x, r.y),
        Print(b.tl),
        Print(&horizontal),
        Print(b.tr),
    )?;
    for y in r.y + 1..r.y + r.h.saturating_sub(1) {
        queue!(stdout, MoveTo(r.x, y), Print(b.v))?;
        queue!(stdout, MoveTo(r.x + r.w.saturating_sub(1), y), Print(b.v))?;
    }
    queue!(
        stdout,
        MoveTo(r.x, r.y + r.h.saturating_sub(1)),
        Print(b.bl),
        Print(&horizontal),
        Print(b.br),
        ResetColor,
    )?;

    let title = format!("● {slot} add terminal");
    let max_title = r.w.saturating_sub(4) as usize;
    queue!(
        stdout,
        MoveTo(r.x + 2, r.y),
        SetForegroundColor(t.accent),
        SetAttribute(Attribute::Bold),
        Print(truncate(&title, max_title)),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;

    let inner_w = r.w.saturating_sub(2) as usize;
    let inner_h = r.h.saturating_sub(2) as usize;

    if picker.choices.is_empty() {
        queue!(
            stdout,
            MoveTo(r.x + 1, r.y + 1),
            SetForegroundColor(t.warning),
            Print(pad_visible("(nothing to add)", inner_w)),
            ResetColor,
        )?;
        return Ok(());
    }

    // Render a "rows" list with section labels inserted before the first
    // existing-session row and the first launch-new row. Each rendered
    // row is either a header (dim, non-selectable) or a choice.
    enum Disp<'a> {
        Header(&'a str),
        Choice(usize), // index into picker.choices
    }
    let mut rows: Vec<Disp> = Vec::new();
    let has_existing = picker
        .choices
        .iter()
        .any(|c| matches!(c, PickerChoice::Existing { .. }));
    let mut emitted_existing_header = false;
    let mut emitted_new_header = false;
    for (i, c) in picker.choices.iter().enumerate() {
        match c {
            PickerChoice::Existing { .. } => {
                if !emitted_existing_header {
                    rows.push(Disp::Header("Existing terminals"));
                    emitted_existing_header = true;
                }
            }
            PickerChoice::NewOnServer { .. } => {
                if !emitted_new_header {
                    rows.push(Disp::Header(if has_existing {
                        "Launch new on…"
                    } else {
                        "Launch new on which server?"
                    }));
                    emitted_new_header = true;
                }
            }
        }
        rows.push(Disp::Choice(i));
    }

    // Scroll window keyed on the selected choice's display row.
    let sel_row = rows
        .iter()
        .position(|d| matches!(d, Disp::Choice(i) if *i == picker.selected))
        .unwrap_or(0);
    let max_visible = inner_h.max(1);
    let scroll = sel_row.saturating_sub(max_visible.saturating_sub(1));

    for (row_idx, disp) in rows.iter().enumerate().skip(scroll).take(max_visible).enumerate() {
        let (_, disp) = disp;
        let y = r.y + 1 + row_idx as u16;
        queue!(stdout, MoveTo(r.x + 1, y))?;
        match disp {
            Disp::Header(h) => {
                let line = pad_visible(&truncate(h, inner_w), inner_w);
                queue!(stdout, SetForegroundColor(t.hint), Print(line), ResetColor)?;
            }
            Disp::Choice(i) => {
                let selected = *i == picker.selected;
                let marker = if selected { "▸ " } else { "  " };
                let line = pad_visible(
                    &truncate(&format!("{marker}{}", picker.choices[*i].label()), inner_w),
                    inner_w,
                );
                if selected {
                    queue!(
                        stdout,
                        SetForegroundColor(t.selected_fg),
                        SetBackgroundColor(t.selected_bg),
                        SetAttribute(Attribute::Bold),
                        Print(line),
                        SetAttribute(Attribute::Reset),
                        ResetColor,
                    )?;
                } else {
                    queue!(stdout, SetForegroundColor(t.name), Print(line), ResetColor)?;
                }
            }
        }
    }
    Ok(())
}

/// Centered overlay listing the available row arrangements as a horizontal
/// strip of mini-grid previews; the selected one is boxed in the accent
/// color. Navigate with arrows, Enter applies, Esc cancels.
/// Ctrl-A P state for the group mosaic — same data and key model as the
/// solo-attach palette (`prompt_palette`), drawn as a centered modal.
struct MosaicPaletteState {
    entries: Vec<PaletteEntryDto>,
    selected: u8,
    mode: PaletteMode,
}

fn draw_mosaic_palette(stdout: &mut Stdout, pv: &MosaicPaletteState) -> Result<()> {
    let t = theme();
    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    let editing = matches!(pv.mode, PaletteMode::Edit { .. });
    let modal_w = 72u16.min(cols.saturating_sub(4)).max(40);
    let modal_h: u16 = 2 + 9 + if editing { 3 } else { 0 }; // borders + slots (+ edit rows)
    let modal_x = cols.saturating_sub(modal_w) / 2;
    let modal_y = rows.saturating_sub(modal_h) / 2;
    let b = t.borders;
    let inner_w = modal_w.saturating_sub(2) as usize;

    // Frame + interior clear.
    let horizontal = b.h.repeat(inner_w);
    queue!(
        stdout,
        SetForegroundColor(t.accent),
        MoveTo(modal_x, modal_y),
        Print(b.tl),
        Print(&horizontal),
        Print(b.tr),
    )?;
    for y in modal_y + 1..modal_y + modal_h.saturating_sub(1) {
        queue!(
            stdout,
            MoveTo(modal_x, y),
            Print(b.v),
            ResetColor,
            Print(" ".repeat(inner_w)),
            SetForegroundColor(t.accent),
            Print(b.v),
        )?;
    }
    queue!(
        stdout,
        MoveTo(modal_x, modal_y + modal_h.saturating_sub(1)),
        Print(b.bl),
        Print(&horizontal),
        Print(b.br),
        ResetColor,
    )?;
    let title = if editing {
        " Command palette  (Tab field · Enter save · Esc cancel) "
    } else {
        " Command palette  (1-9/Enter paste · a/e/d edit · ⇧↑↓ move · Esc) "
    };
    queue!(
        stdout,
        MoveTo(modal_x + 2, modal_y),
        SetForegroundColor(t.heading),
        SetAttribute(Attribute::Bold),
        Print(palette_truncate(title, inner_w.saturating_sub(2))),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;

    let editing_slot = match &pv.mode {
        PaletteMode::Edit { slot, .. } => Some(*slot),
        PaletteMode::Browse => None,
    };
    for slot in 1..=9u8 {
        let y = modal_y + 1 + (slot as u16 - 1);
        let entry = pv.entries.iter().find(|e| e.slot == slot);
        let is_sel = slot == pv.selected;
        queue!(stdout, MoveTo(modal_x + 2, y))?;
        if is_sel {
            queue!(
                stdout,
                SetForegroundColor(t.selected_fg),
                SetBackgroundColor(t.selected_bg),
            )?;
        }
        let budget = inner_w.saturating_sub(8);
        let body = match entry {
            None if editing_slot == Some(slot) => "(adding…)".to_string(),
            None => "(empty)".to_string(),
            Some(e) => match e.label.as_deref().filter(|l| !l.is_empty()) {
                Some(lbl) => palette_truncate(
                    &format!("{lbl} — {}", e.command),
                    budget,
                ),
                None => palette_truncate(&e.command, budget),
            },
        };
        let marker = if is_sel { "›" } else { " " };
        let line = format!("{marker} [{slot}] {body}");
        let padded = format!("{line:<width$}", width = inner_w.saturating_sub(2));
        if entry.is_none() && !is_sel {
            queue!(stdout, SetForegroundColor(t.hint))?;
        }
        queue!(
            stdout,
            Print(palette_truncate(&padded, inner_w.saturating_sub(2))),
            ResetColor,
        )?;
    }

    if let PaletteMode::Edit {
        label,
        command,
        field,
        ..
    } = &pv.mode
    {
        let budget = inner_w.saturating_sub(14);
        let label_line = format!(
            "Label:   {}{}",
            palette_truncate(label, budget),
            if *field == 0 { "▌" } else { "" }
        );
        // Show the tail of long commands — the caret end is what's edited.
        let cmd_shown: String = if command.chars().count() > budget {
            let tail: String = command
                .chars()
                .skip(command.chars().count() - budget.saturating_sub(1))
                .collect();
            format!("…{tail}")
        } else {
            command.clone()
        };
        let cmd_line = format!(
            "Command: {}{}",
            cmd_shown,
            if *field == 1 { "▌" } else { "" }
        );
        queue!(
            stdout,
            MoveTo(modal_x + 2, modal_y + 10),
            SetForegroundColor(t.hint),
            Print(b.h.repeat(inner_w.saturating_sub(2))),
            ResetColor,
            MoveTo(modal_x + 2, modal_y + 11),
            Print(palette_truncate(&label_line, inner_w.saturating_sub(2))),
            MoveTo(modal_x + 2, modal_y + 12),
            Print(palette_truncate(&cmd_line, inner_w.saturating_sub(2))),
        )?;
    }

    stdout.flush()?;
    Ok(())
}

fn draw_layout_overlay(stdout: &mut Stdout, lp: &LayoutPickerState) -> Result<()> {
    let t = theme();
    let (cols, rows) = terminal::size().unwrap_or((120, 36));
    const CARD_W: u16 = 13; // 11-wide preview + 1 padding each side
    const CARD_H: u16 = 6; // 1 top label gap + 3 preview + 1 label + 1
    const GAP: u16 = 2;
    let n = lp.options.len().max(1) as u16;
    let strip_w = n * CARD_W + (n.saturating_sub(1)) * GAP;
    let modal_w = (strip_w + 6).min(cols);
    let modal_h: u16 = CARD_H + 4;
    let modal_x = cols.saturating_sub(modal_w) / 2;
    let modal_y = rows.saturating_sub(modal_h) / 2;
    let b = t.borders;

    let horizontal = b.h.repeat(modal_w.saturating_sub(2) as usize);
    queue!(
        stdout,
        SetForegroundColor(t.accent),
        MoveTo(modal_x, modal_y),
        Print(b.tl),
        Print(&horizontal),
        Print(b.tr),
    )?;
    for y in modal_y + 1..modal_y + modal_h.saturating_sub(1) {
        queue!(stdout, MoveTo(modal_x, y), Print(b.v))?;
        queue!(stdout, MoveTo(modal_x + modal_w.saturating_sub(1), y), Print(b.v))?;
        // Clear interior so panes underneath don't show through.
        let interior = " ".repeat(modal_w.saturating_sub(2) as usize);
        queue!(stdout, MoveTo(modal_x + 1, y), ResetColor, Print(interior), SetForegroundColor(t.accent), MoveTo(modal_x + modal_w.saturating_sub(1), y), Print(b.v))?;
    }
    queue!(
        stdout,
        MoveTo(modal_x, modal_y + modal_h.saturating_sub(1)),
        Print(b.bl),
        Print(&horizontal),
        Print(b.br),
        ResetColor,
    )?;
    queue!(
        stdout,
        MoveTo(modal_x + 2, modal_y),
        SetForegroundColor(t.heading),
        SetAttribute(Attribute::Bold),
        Print(" Layout  (←/→ choose · Enter apply · Esc cancel) "),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;

    let strip_x = modal_x + (modal_w.saturating_sub(strip_w)) / 2;
    let card_y = modal_y + 2;
    for (i, opt) in lp.options.iter().enumerate() {
        let cx = strip_x + i as u16 * (CARD_W + GAP);
        let selected = i == lp.selected;
        let color = if selected { t.accent } else { t.border_inactive };
        let preview = partition_preview(opt);
        for (row, line) in preview.iter().enumerate() {
            queue!(
                stdout,
                MoveTo(cx + 1, card_y + row as u16),
                SetForegroundColor(color),
                Print(line),
                ResetColor,
            )?;
        }
        let label = partition_label(opt);
        let label_x = cx + (CARD_W.saturating_sub(label.chars().count() as u16)) / 2;
        queue!(stdout, MoveTo(label_x, card_y + 3))?;
        if selected {
            queue!(
                stdout,
                SetForegroundColor(t.selected_fg),
                SetBackgroundColor(t.selected_bg),
                SetAttribute(Attribute::Bold),
                Print(format!(" {label} ")),
                SetAttribute(Attribute::Reset),
                ResetColor,
            )?;
        } else {
            queue!(stdout, SetForegroundColor(t.hint), Print(label), ResetColor)?;
        }
    }
    stdout.flush()?;
    Ok(())
}

/// Ctrl-A S "swap windows" overlay state. Two phases: pick the source
/// window (`source == None`), then pick where to move it (`source` set).
#[derive(Clone, Copy)]
struct SwapState {
    source: Option<usize>,
    cursor: usize,
}

#[derive(Clone, Copy)]
enum SwapDir {
    Left,
    Right,
    Up,
    Down,
}

/// Spatial pane navigation: from `cur`, the nearest pane whose center lies
/// in `dir`. Returns `cur` unchanged when there's nothing that way, so the
/// highlight never jumps off into empty space.
fn swap_nav(panes: &[Pane], cur: usize, dir: SwapDir) -> usize {
    let Some(c) = panes.get(cur).map(|p| p.rect) else {
        return cur;
    };
    let ccx = c.x as i32 + c.w as i32 / 2;
    let ccy = c.y as i32 + c.h as i32 / 2;
    let mut best = cur;
    let mut best_score = i32::MAX;
    for (i, p) in panes.iter().enumerate() {
        if i == cur {
            continue;
        }
        let pcx = p.rect.x as i32 + p.rect.w as i32 / 2;
        let pcy = p.rect.y as i32 + p.rect.h as i32 / 2;
        let (along, ok, cross) = match dir {
            SwapDir::Left => (ccx - pcx, pcx < ccx, (pcy - ccy).abs()),
            SwapDir::Right => (pcx - ccx, pcx > ccx, (pcy - ccy).abs()),
            SwapDir::Up => (ccy - pcy, pcy < ccy, (pcx - ccx).abs()),
            SwapDir::Down => (pcy - ccy, pcy > ccy, (pcx - ccx).abs()),
        };
        if !ok {
            continue;
        }
        // Prefer panes closely aligned on the cross axis, then nearest.
        let score = along + cross * 3;
        if score < best_score {
            best_score = score;
            best = i;
        }
    }
    best
}

/// Swap the windows in slots `i` and `j`: the session content moves but the
/// slot rectangles stay put, so it reads as the two panes trading places.
/// Resizes both moved sessions to their new slot and persists the new order
/// so the browser and the membership poll agree.
async fn perform_swap(
    i: usize,
    j: usize,
    panes: &mut [Pane],
    send_tx: &mpsc::Sender<String>,
    cfg: &DashboardCliConfig,
    group_id: &str,
    current_group: &mut Group,
) -> Result<()> {
    if i == j || i >= panes.len() || j >= panes.len() {
        return Ok(());
    }
    let ri = panes[i].rect;
    let rj = panes[j].rect;
    panes.swap(i, j);
    panes[i].rect = ri;
    panes[j].rect = rj;
    for k in [i, j] {
        if let Some(s) = panes[k].session.clone() {
            let (h, w) = pane_inner_size(panes[k].rect);
            send_ws(send_tx, client_resize_msg(&s, h, w)).await?;
        }
    }
    let ids: Vec<String> = panes
        .iter()
        .filter_map(|p| p.session.as_ref().map(|s| s.id.clone()))
        .collect();
    let _ = save_group_order(cfg, group_id, &ids).await;
    // Keep the in-memory roster ordered like the panes so the membership
    // poll doesn't see a phantom reorder and rebuild everything.
    current_group
        .members
        .sort_by_key(|m| ids.iter().position(|id| id == &m.id).unwrap_or(usize::MAX));
    Ok(())
}

/// Redraw the swap-mode chrome on top of the freshly-drawn panes: a banner
/// across the status row, the source pane outlined as "swapping", and the
/// cursor pane outlined as the pick / destination.
fn draw_swap_overlay(stdout: &mut Stdout, panes: &[Pane], swap: &SwapState) -> Result<()> {
    let t = theme();
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    let banner = match swap.source {
        None => {
            "  SWAP  pick a window — ←/↑/→/↓ move · 1-6 jump · Enter select · Esc cancel"
                .to_string()
        }
        Some(src) => format!(
            "  SWAP  placing window {} — ←/↑/→/↓ move · Enter confirm · Esc cancel",
            src + 1
        ),
    };
    queue!(
        stdout,
        MoveTo(0, 0),
        SetBackgroundColor(t.accent),
        SetForegroundColor(t.selected_fg),
        SetAttribute(Attribute::Bold),
        Print(fit_text(&banner, cols as usize)),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;
    if let Some(src) = swap.source {
        if let Some(p) = panes.get(src) {
            outline_pane(stdout, p.rect, t.selected_bg, "✦ swapping")?;
        }
    }
    if let Some(p) = panes.get(swap.cursor) {
        let label = if swap.source.is_none() {
            "▶ pick"
        } else {
            "▶ place here"
        };
        outline_pane(stdout, p.rect, t.accent, label)?;
    }
    stdout.flush()?;
    Ok(())
}

/// Redraw a pane's border in `color`, with `badge` embedded in the top edge
/// (e.g. `╭─ ▶ pick ─────╮`). Overwrites the existing border in place.
fn outline_pane(stdout: &mut Stdout, r: Rect, color: Color, badge: &str) -> Result<()> {
    let b = theme().borders;
    let w = r.w as usize;
    if w < 4 || r.h < 2 {
        return Ok(());
    }
    let inner = w - 2; // columns between the corner glyphs
    let label = fit_text(&format!(" {badge} "), (badge.chars().count() + 2).min(inner));
    let label_w = label.chars().count();
    let lead = if inner > label_w { 1 } else { 0 };
    let fill = inner.saturating_sub(label_w + lead);
    let mut top = String::from(b.tl);
    for _ in 0..lead {
        top.push_str(b.h);
    }
    top.push_str(&label);
    for _ in 0..fill {
        top.push_str(b.h);
    }
    top.push_str(b.tr);

    queue!(
        stdout,
        SetForegroundColor(color),
        SetAttribute(Attribute::Bold),
        MoveTo(r.x, r.y),
        Print(top),
    )?;
    for y in r.y + 1..r.y + r.h.saturating_sub(1) {
        queue!(
            stdout,
            MoveTo(r.x, y),
            Print(b.v),
            MoveTo(r.x + r.w.saturating_sub(1), y),
            Print(b.v),
        )?;
    }
    let bottom = format!("{}{}{}", b.bl, b.h.repeat(inner), b.br);
    queue!(
        stdout,
        MoveTo(r.x, r.y + r.h.saturating_sub(1)),
        Print(bottom),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;
    Ok(())
}

/// Ctrl-A R "resize windows" overlay state. `pane` is the window the
/// arrows currently grow/shrink ([ ] / digits move it); `original` is the
/// layout captured on entry so Esc can restore it without a round-trip.
#[derive(Clone)]
struct ResizeState {
    pane: usize,
    original: GroupLayout,
}

/// Smallest share any row/column may shrink to, as a ratio of its track.
/// Keeps a pane from collapsing to nothing (and below the per-pane min the
/// allocator enforces anyway).
const RESIZE_MIN_RATIO: f64 = 0.12;
/// How much ratio one arrow press moves between a pane and its neighbour.
const RESIZE_STEP: f64 = 0.04;

/// (row, col-within-row) of the `pane`-th window for a given partition.
fn pane_grid_pos(partition: &[usize], pane: usize) -> Option<(usize, usize)> {
    let mut base = 0usize;
    for (row, &count) in partition.iter().enumerate() {
        if pane < base + count {
            return Some((row, pane - base));
        }
        base += count;
    }
    None
}

/// Move the divider adjacent to track cell `i` in the screen direction
/// `dir` (+1 = right/down, −1 = left/up) — so the boundary line always
/// travels the way the arrow points, no matter which pane is focused. Uses
/// the divider *after* `i`, or the one *before* it when `i` is the last
/// cell. Moving a divider toward `dir` grows the cell behind it and shrinks
/// the cell ahead of it. No-op (false) when there's no divider or the move
/// would push either cell below `RESIZE_MIN_RATIO`.
fn move_divider(ratios: &mut [f64], i: usize, dir: f64) -> bool {
    if ratios.len() < 2 || i >= ratios.len() {
        return false;
    }
    // The two cells the chosen divider separates: (left/up, right/down).
    let (lo, hi) = if i + 1 < ratios.len() {
        (i, i + 1) // divider just after the focused cell
    } else {
        (i - 1, i) // focused cell is last → use the divider before it
    };
    // dir > 0 (right/down) moves the line that way: `lo` grows, `hi` shrinks.
    let step = RESIZE_STEP * dir;
    let new_lo = ratios[lo] + step;
    let new_hi = ratios[hi] - step;
    if new_lo < RESIZE_MIN_RATIO || new_hi < RESIZE_MIN_RATIO {
        return false;
    }
    ratios[lo] = new_lo;
    ratios[hi] = new_hi;
    true
}

/// Move the divider next to the focused pane in the pressed arrow's
/// direction. `dx`/`dy` are −1, 0, or +1 (right/down positive). Returns
/// true when the layout actually changed.
fn resize_focused(layout: &mut GroupLayout, partition: &[usize], pane: usize, dx: i32, dy: i32) -> bool {
    let Some((row, col)) = pane_grid_pos(partition, pane) else {
        return false;
    };
    let mut changed = false;
    if dx != 0 {
        if let Some(widths) = layout.col_widths_by_row.get_mut(row) {
            changed |= move_divider(widths, col, dx as f64);
        }
    }
    if dy != 0 {
        changed |= move_divider(&mut layout.row_heights, row, dy as f64);
    }
    changed
}

/// Redraw the resize-mode chrome: a banner across the status row and the
/// targeted pane outlined with grow/shrink hints.
fn draw_resize_overlay(stdout: &mut Stdout, panes: &[Pane], rs: &ResizeState) -> Result<()> {
    let t = theme();
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    let banner = format!(
        "  RESIZE  window {} — ←/→ width · ↑/↓ height · [ ] next · Enter apply · Esc cancel",
        rs.pane + 1
    );
    queue!(
        stdout,
        MoveTo(0, 0),
        SetBackgroundColor(t.accent),
        SetForegroundColor(t.selected_fg),
        SetAttribute(Attribute::Bold),
        Print(fit_text(&banner, cols as usize)),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;
    if let Some(p) = panes.get(rs.pane) {
        outline_pane(stdout, p.rect, t.accent, "⤡ resizing")?;
    }
    stdout.flush()?;
    Ok(())
}

/// Small Y/n confirm modal anchored over the focused pane. Drawn after
/// the panes so it overlays whatever they were rendering. Red border to
/// make the destructive intent visually loud — picker uses cyan, this
/// one uses red, the eye picks up the difference immediately.
fn draw_confirm(stdout: &mut Stdout, confirm: &ConfirmState) -> Result<()> {
    let target = confirm.target_rect;
    // 4 rows × the smaller of (target width - 4, 50 cols), centered in
    // the target pane. Big enough for the prompt + the two-line body,
    // small enough to leave the original pane content visible at the
    // edges so it's clear *which* pane the action will hit.
    let modal_w = target.w.saturating_sub(4).min(50).max(20);
    let modal_h: u16 = 4;
    let modal_x = target.x + target.w.saturating_sub(modal_w) / 2;
    let modal_y = target.y + target.h.saturating_sub(modal_h) / 2;

    let prompt = match confirm.action {
        ConfirmAction::KillSession => {
            format!("Kill {}?", confirm.target_session_name)
        }
    };
    let hint = "[Y] confirm   [any other key] cancel";

    let t = theme();
    let b = t.borders;
    let horizontal = b.h.repeat(modal_w.saturating_sub(2) as usize);
    queue!(
        stdout,
        SetForegroundColor(t.danger),
        MoveTo(modal_x, modal_y),
        Print(b.tl),
        Print(&horizontal),
        Print(b.tr),
    )?;
    for y in modal_y + 1..modal_y + modal_h.saturating_sub(1) {
        queue!(
            stdout,
            MoveTo(modal_x, y),
            Print(b.v),
            MoveTo(modal_x + modal_w.saturating_sub(1), y),
            Print(b.v),
        )?;
    }
    queue!(
        stdout,
        MoveTo(modal_x, modal_y + modal_h.saturating_sub(1)),
        Print(b.bl),
        Print(&horizontal),
        Print(b.br),
        ResetColor,
    )?;

    let inner_w = modal_w.saturating_sub(2) as usize;
    let prompt_line = pad_visible(&truncate(&prompt, inner_w), inner_w);
    let hint_line = pad_visible(&truncate(hint, inner_w), inner_w);
    queue!(
        stdout,
        MoveTo(modal_x + 1, modal_y + 1),
        SetForegroundColor(t.name),
        SetAttribute(Attribute::Bold),
        Print(prompt_line),
        SetAttribute(Attribute::Reset),
        ResetColor,
    )?;
    queue!(
        stdout,
        MoveTo(modal_x + 1, modal_y + 2),
        SetForegroundColor(t.hint),
        Print(hint_line),
        ResetColor,
    )?;
    Ok(())
}

fn handle_confirm_key(key: KeyEvent) -> ConfirmKeyResult {
    match key.code {
        KeyCode::Char('y') | KeyCode::Char('Y') => ConfirmKeyResult::Confirm,
        // Soak up modifiers-only events (e.g. Shift, AltGr) so a key
        // release between two intentional presses doesn't accidentally
        // cancel the prompt. Anything else — including 'n', 'N', Esc,
        // arrows, Enter — counts as cancel; that's the safer default
        // for a destructive prompt.
        KeyCode::Null => ConfirmKeyResult::Idle,
        _ => ConfirmKeyResult::Cancel,
    }
}

fn status_to_color(status: &str) -> Color {
    let t = theme();
    match status {
        "running" | "attached" | "active" => t.status_running,
        "detached" | "idle" => t.status_idle,
        "closed" | "exited" | "stopped" | "lost" => t.status_closed,
        _ => t.status_unknown,
    }
}

fn fit_text(s: &str, width: usize) -> String {
    let mut out = String::new();
    for ch in s.chars().take(width) {
        out.push(ch);
    }
    let len = out.chars().count();
    if len < width {
        out.push_str(&" ".repeat(width - len));
    }
    out
}

fn build_panes(
    group: &Group,
    server_labels: &HashMap<String, String>,
    layout: &GroupLayout,
    partition: &[usize],
    cols: u16,
    rows: u16,
) -> Vec<Pane> {
    let rects = compute_rects(layout, partition, cols, rows);
    group
        .members
        .iter()
        .enumerate()
        .map(|(idx, session)| {
            let rect = rects.get(idx).copied().unwrap_or(Rect {
                x: 0,
                y: 1,
                w: cols,
                h: rows.saturating_sub(1),
            });
            let (inner_rows, inner_cols) = pane_inner_size(rect);
            Pane {
                slot_key: session.id.clone(),
                title: session.session_name.clone(),
                server_label: server_labels
                    .get(&session.server_id)
                    .cloned()
                    .unwrap_or_else(|| session.server_id.clone()),
                session: Some(session.clone()),
                rect,
                parser: vt100::Parser::new(inner_rows, inner_cols, 0),
                lost: None,
                stats: None,
            }
        })
        .collect()
}

fn apply_resize(
    panes: &mut [Pane],
    layout: &GroupLayout,
    partition: &[usize],
    cols: u16,
    rows: u16,
) {
    let rects = compute_rects(layout, partition, cols, rows);
    for (pane, rect) in panes.iter_mut().zip(rects.into_iter()) {
        pane.rect = rect;
        let (inner_rows, inner_cols) = pane_inner_size(rect);
        pane.parser.set_size(inner_rows, inner_cols);
    }
}

fn compute_rects(layout: &GroupLayout, partition: &[usize], cols: u16, rows: u16) -> Vec<Rect> {
    let pane_rows_total = rows.saturating_sub(1);
    let row_sizes = allocate(pane_rows_total, &layout.row_heights, partition.len(), 3);
    let mut rects = Vec::new();
    let mut y = 1u16;
    for (row_idx, &count) in partition.iter().enumerate() {
        let h = row_sizes.get(row_idx).copied().unwrap_or(3);
        let ratios = layout
            .col_widths_by_row
            .get(row_idx)
            .cloned()
            .unwrap_or_else(|| vec![1.0 / count as f64; count]);
        let col_sizes = allocate(cols, &ratios, count, 8);
        let mut x = 0u16;
        for w in col_sizes {
            rects.push(Rect { x, y, w, h });
            x = x.saturating_add(w);
        }
        y = y.saturating_add(h);
    }
    rects
}

fn allocate(total: u16, ratios: &[f64], count: usize, preferred_min: u16) -> Vec<u16> {
    if count == 0 {
        return Vec::new();
    }
    let min = if total < preferred_min.saturating_mul(count as u16) {
        1
    } else {
        preferred_min
    };
    let mut sizes = (0..count)
        .map(|i| {
            let ratio = ratios.get(i).copied().unwrap_or(1.0 / count as f64);
            ((total as f64 * ratio).round() as u16).max(min)
        })
        .collect::<Vec<_>>();
    let mut sum: i32 = sizes.iter().map(|v| *v as i32).sum();
    let target = total as i32;
    while sum > target {
        if let Some(slot) = sizes.iter_mut().rev().find(|v| **v > min) {
            *slot -= 1;
            sum -= 1;
        } else {
            break;
        }
    }
    while sum < target {
        if let Some(last) = sizes.last_mut() {
            *last += 1;
        }
        sum += 1;
    }
    sizes
}

fn pane_inner_size(rect: Rect) -> (u16, u16) {
    (
        rect.h.saturating_sub(2).max(1),
        rect.w.saturating_sub(2).max(1),
    )
}

fn valid_layout_or_default(layout: Option<GroupLayout>, member_count: usize) -> GroupLayout {
    let Some(layout) = layout else {
        return layout_for_partition(&default_partition(member_count));
    };
    let partition = active_partition(&layout, member_count);
    if partition.iter().sum::<usize>() == member_count
        && layout.row_heights.len() == partition.len()
        && layout.col_widths_by_row.len() == partition.len()
        && layout
            .col_widths_by_row
            .iter()
            .zip(partition.iter())
            .all(|(row, count)| row.len() == *count)
    {
        layout
    } else {
        let mut fresh = layout_for_partition(&default_partition(member_count));
        fresh.font_size_by_session = layout.font_size_by_session;
        fresh
    }
}

fn active_partition(layout: &GroupLayout, member_count: usize) -> Vec<usize> {
    layout
        .row_partition
        .clone()
        .filter(|p| p.iter().sum::<usize>() == member_count)
        .unwrap_or_else(|| default_partition(member_count))
}

fn default_partition(n: usize) -> Vec<usize> {
    if n <= 3 {
        vec![n]
    } else {
        vec![3, n - 3]
    }
}

fn layout_for_partition(partition: &[usize]) -> GroupLayout {
    let row_heights = vec![1.0 / partition.len() as f64; partition.len()];
    let col_widths_by_row = partition
        .iter()
        .map(|count| vec![1.0 / *count as f64; *count])
        .collect();
    GroupLayout {
        row_heights,
        col_widths_by_row,
        row_partition: Some(partition.to_vec()),
        font_size_by_session: None,
    }
}

fn parse_partition(raw: &str) -> Result<Vec<usize>> {
    let parts = raw
        .split(|c| matches!(c, '+' | ',' | 'x' | 'X' | ' '))
        .filter(|p| !p.is_empty())
        .map(|p| {
            p.parse::<usize>()
                .with_context(|| format!("bad partition value '{p}'"))
        })
        .collect::<Result<Vec<_>>>()?;
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|v| *v == 0) {
        bail!("arrangement must be one or two positive row sizes, e.g. 2+2");
    }
    Ok(parts)
}

fn ensure_allowed_partition(member_count: usize, partition: &[usize]) -> Result<()> {
    if partition.iter().sum::<usize>() != member_count {
        bail!(
            "arrangement sums to {}, but group has {} terminal(s)",
            partition.iter().sum::<usize>(),
            member_count
        );
    }
    if !allowed_partitions(member_count)
        .iter()
        .any(|p| p.as_slice() == partition)
    {
        bail!(
            "arrangement is not available for {} terminal(s); allowed: {}",
            member_count,
            allowed_partitions(member_count)
                .iter()
                .map(|p| p
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join("+"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

fn allowed_partitions(n: usize) -> Vec<Vec<usize>> {
    match n {
        1 => vec![vec![1]],
        2 => vec![vec![2], vec![1, 1]],
        3 => vec![vec![3], vec![1, 2], vec![2, 1]],
        4 => vec![vec![3, 1], vec![4], vec![2, 2], vec![1, 3]],
        5 => vec![vec![3, 2], vec![5], vec![2, 3]],
        6 => vec![vec![3, 3], vec![6]],
        _ => Vec::new(),
    }
}

async fn fetch_groups(cfg: &DashboardCliConfig) -> Result<Vec<Group>> {
    Ok(fetch_group_list_payload(cfg).await?.groups)
}

async fn fetch_group_list_payload(cfg: &DashboardCliConfig) -> Result<GroupListPayload> {
    get_json::<GroupListPayload>(cfg, "/api/cli/groups").await
}

async fn fetch_group_detail(cfg: &DashboardCliConfig, id: &str) -> Result<CliGroupDetail> {
    get_json::<CliGroupDetail>(cfg, &format!("/api/cli/groups/{id}")).await
}

/// Outcome of polling a group's detail. `Gone` distinguishes a 404 (the
/// group was deleted server-side once its last live session died) from a
/// transient HTTP error — the former means "stop polling", the latter
/// "retry later".
enum GroupFetch {
    Found(CliGroupDetail),
    Gone,
}

async fn fetch_group_detail_status(
    cfg: &DashboardCliConfig,
    id: &str,
) -> Result<GroupFetch> {
    let path = format!("/api/cli/groups/{id}");
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}{}", cfg.api_url, path))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .with_context(|| format!("GET {path}"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(GroupFetch::Gone);
    }
    if !res.status().is_success() {
        bail!("dashboard returned HTTP {} for GET {path}", res.status());
    }
    let envelope: ApiEnvelope<CliGroupDetail> =
        res.json().await.context("parsing dashboard response")?;
    Ok(GroupFetch::Found(envelope.data))
}

async fn resolve_group_id(cfg: &DashboardCliConfig, selector: &str) -> Result<String> {
    let groups = fetch_groups(cfg).await?;
    let hits = groups
        .into_iter()
        .filter(|g| g.id == selector || g.id.starts_with(selector) || g.name == selector)
        .collect::<Vec<_>>();
    match hits.len() {
        0 => bail!("no group matches '{selector}'"),
        1 => Ok(hits[0].id.clone()),
        n => bail!("'{selector}' is ambiguous ({n} groups match)"),
    }
}

async fn get_json<T: for<'de> Deserialize<'de>>(cfg: &DashboardCliConfig, path: &str) -> Result<T> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}{}", cfg.api_url, path))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .with_context(|| format!("GET {path}"))?;
    if !res.status().is_success() {
        bail!("dashboard returned HTTP {} for GET {path}", res.status());
    }
    let envelope: ApiEnvelope<T> = res.json().await.context("parsing dashboard response")?;
    Ok(envelope.data)
}

async fn save_group_layout(
    cfg: &DashboardCliConfig,
    group_id: &str,
    layout: &GroupLayout,
) -> Result<()> {
    put_json(cfg, &format!("/api/cli/groups/{group_id}/layout"), layout).await
}

async fn save_stack_layout(
    cfg: &DashboardCliConfig,
    stack_id: &str,
    layout: &GroupLayout,
) -> Result<()> {
    put_json(cfg, &format!("/api/cli/stacks/{stack_id}/layout"), layout).await
}

async fn save_group_order(
    cfg: &DashboardCliConfig,
    group_id: &str,
    session_ids: &[String],
) -> Result<()> {
    put_json(
        cfg,
        &format!("/api/cli/groups/{group_id}/order"),
        &serde_json::json!({ "sessionIds": session_ids }),
    )
    .await
}

async fn put_json<T: Serialize + ?Sized>(
    cfg: &DashboardCliConfig,
    path: &str,
    body: &T,
) -> Result<()> {
    let client = reqwest::Client::new();
    let res = client
        .put(format!("{}{}", cfg.api_url, path))
        .bearer_auth(&cfg.token)
        .json(body)
        .send()
        .await
        .with_context(|| format!("PUT {path}"))?;
    if !res.status().is_success() {
        bail!("dashboard returned HTTP {} for PUT {path}", res.status());
    }
    Ok(())
}

/// DELETE that returns the parsed JSON body verbatim (no envelope
/// unwrapping). The CLI's destructive endpoints answer with
/// `{ok:true}` or `{data: ..., groupDeleted: ...}` — we want to peek
/// at the optional `groupDeleted` field, so the caller deals with the
/// raw shape.
async fn delete_request(cfg: &DashboardCliConfig, path: &str) -> Result<serde_json::Value> {
    let client = reqwest::Client::new();
    let res = client
        .delete(format!("{}{}", cfg.api_url, path))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .with_context(|| format!("DELETE {path}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body_text = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or(body_text);
        bail!("dashboard returned HTTP {status} for DELETE {path}: {msg}");
    }
    let body_text = res.text().await.context("reading dashboard response")?;
    if body_text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&body_text).context("parsing dashboard response")
}

async fn post_json<T: Serialize + ?Sized, R: for<'de> Deserialize<'de>>(
    cfg: &DashboardCliConfig,
    path: &str,
    body: &T,
) -> Result<R> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}{}", cfg.api_url, path))
        .bearer_auth(&cfg.token)
        .json(body)
        .send()
        .await
        .with_context(|| format!("POST {path}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body_text = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or(body_text);
        bail!("dashboard returned HTTP {status} for POST {path}: {msg}");
    }
    let envelope: ApiEnvelope<R> = res.json().await.context("parsing dashboard response")?;
    Ok(envelope.data)
}

async fn send_ws(send_tx: &mpsc::Sender<String>, msg: String) -> Result<()> {
    send_tx
        .send(msg)
        .await
        .map_err(|_| anyhow!("websocket writer stopped"))
}

fn client_attach_msg(session: &GroupSession) -> String {
    serde_json::json!({
        "type": "session:attach",
        "sessionId": session.id,
        "serverId": session.server_id,
    })
    .to_string()
}

fn client_resize_msg(session: &GroupSession, rows: u16, cols: u16) -> String {
    serde_json::json!({
        "type": "terminal:resize",
        "sessionId": session.id,
        "serverId": session.server_id,
        "rows": rows,
        "cols": cols,
    })
    .to_string()
}

fn client_input_msg(session: &GroupSession, data: &str) -> String {
    serde_json::json!({
        "type": "terminal:input",
        "sessionId": session.id,
        "data": data,
    })
    .to_string()
}

fn normalize_api_url(raw: String) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        bail!("api url must start with http:// or https://");
    }
    Ok(trimmed)
}

fn ws_url_for(api_url: &str) -> Result<String> {
    if let Some(rest) = api_url.strip_prefix("https://") {
        return Ok(format!("wss://{rest}/api/ws"));
    }
    if let Some(rest) = api_url.strip_prefix("http://") {
        return Ok(format!("ws://{rest}/api/ws"));
    }
    bail!("api url must start with http:// or https://")
}

fn config_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("MANAGET_CLI_CONFIG_PATH") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    let base = if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else {
        let home = std::env::var("HOME").context("HOME is not set")?;
        PathBuf::from(home).join(".config")
    };
    Ok(base.join("managet").join("config.toml"))
}

fn load_config() -> Result<DashboardCliConfig> {
    let path = config_path()?;
    let raw = fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} (run `managet login --api-url <url>` first)",
            path.display()
        )
    })?;
    let cfg: DashboardCliConfig = toml::from_str(&raw).context("parsing CLI config")?;
    Ok(cfg)
}

fn save_config(cfg: &DashboardCliConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    fs::write(&path, toml::to_string_pretty(cfg)?)
        .with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms)?;
    }
    Ok(())
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out = s.chars().take(max.saturating_sub(1)).collect::<String>();
        out.push('~');
        out
    }
}

/// Right-pad a string with spaces so its visible (character) width is
/// at least `width`. Coloring happens after padding, so ANSI escapes
/// don't blow up the visible column widths.
fn pad_visible(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        let mut out = String::with_capacity(s.len() + (width - len));
        out.push_str(s);
        out.push_str(&" ".repeat(width - len));
        out
    }
}

fn hostname_label() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .map(|h| format!("managet CLI on {h}"))
        .unwrap_or_else(|| "managet CLI".to_string())
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter(stdout: &mut Stdout) -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        execute!(stdout, EnterAlternateScreen, Hide)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let mut stdout = std::io::stdout();
        let _ = execute!(stdout, Show, LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}
