//! Dashboard-backed features for the user-facing `managet` CLI.
//!
//! Local `managet attach` still talks directly to the agent socket on
//! the current host. Group views are different: a browser group can
//! contain sessions from several managed servers, so the CLI has to use
//! the dashboard as the cross-server router. This module owns that path:
//! user-scoped dashboard login, group metadata/layout REST calls, and a
//! small managet-owned multi-pane terminal view over the dashboard WS.

use std::collections::HashMap;
use std::fs;
use std::io::{IsTerminal, Stdout, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{
    Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor,
    Stylize,
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
    group_order_index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct CliGroupDetail {
    group: Group,
    layout: Option<GroupLayout>,
    servers: Vec<CliServer>,
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
}

/// Inline server-picker state when the user hits Ctrl-A N. The view
/// previews a layout one slot larger (existing panes shrink), and the
/// new slot is occupied by a list of available servers. Confirm
/// creates+links the session; cancel restores the prior layout.
struct PickerState {
    /// Rect of the empty new slot — picker is drawn here.
    target_rect: Rect,
    /// Highlighted server index in `current_servers`.
    selected: usize,
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

/// Optional second section appended to `managet ls`. Silent (one dim
/// hint line) when the user hasn't run `managet login` yet, since a
/// fresh host should still get a useful local listing.
pub async fn print_groups_section() -> Result<()> {
    println!();
    let cfg = match load_config() {
        Ok(cfg) => cfg,
        Err(_) => {
            println!("{}", "Group sessions".magenta().bold());
            println!(
                "  {}",
                "(run `managet login` to list dashboard groups)".dark_grey()
            );
            return Ok(());
        }
    };
    let payload = match fetch_group_list_payload(&cfg).await {
        Ok(p) => p,
        Err(e) => {
            println!("{}", "Group sessions".magenta().bold());
            println!(
                "  {}",
                format!("(dashboard unreachable: {e})").dark_grey()
            );
            return Ok(());
        }
    };
    if payload.groups.is_empty() {
        println!("{}", "Group sessions".magenta().bold());
        println!("  {}", "(no groups yet)".dark_grey());
        return Ok(());
    }
    print_group_rows(&payload);
    println!();
    println!(
        "  {} {} {} {}",
        "Attach:".dark_grey(),
        "managet attach <name>".white(),
        "•".dark_grey(),
        "managet group attach <name>".white(),
    );
    Ok(())
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
            println!(
                "      {branch} {name} {sep} {server}",
                branch = branch.dark_grey(),
                name = name_cell.white(),
                sep = "·".dark_grey(),
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
}

#[derive(Debug, Clone, Deserialize)]
struct StackSummary {
    id: String,
    name: String,
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
}

/// Shape returned by `GET /api/cli/stacks/[id]` — the multipane workhorse.
#[derive(Debug, Clone, Deserialize)]
struct CliStackDetail {
    stack: StackSummary,
    runtime: StackRuntimeDto,
    #[serde(default)]
    servers: Vec<CliServer>,
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

/// Short server label for stack output: friendly host first, then name,
/// then a truncated id. (Stacks don't carry the per-user host/name
/// preference that groups do, so we just prefer the host.)
fn stack_server_label(servers: &[CliServer], server_id: &str) -> String {
    match servers.iter().find(|s| s.id == server_id) {
        Some(s) if !s.host.is_empty() => s.host.clone(),
        Some(s) if !s.name.is_empty() => s.name.clone(),
        _ => short_id(server_id),
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
            format!("{active}/{total} running")
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
            .map(|sid| stack_server_label(&payload.servers, sid))
            .collect::<Vec<_>>()
            .join(", ");

        let name_col = pad_visible(&truncate(&st.name, name_width), name_width);
        let run_col = pad_visible(&run_texts[stack_idx], run_col_width);
        println!(
            "  {bullet} {name} {sep} {run} {sep} {servers}",
            bullet = "▤".magenta(),
            name = name_col.white().bold(),
            sep = "│".dark_grey(),
            run = run_col.cyan(),
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
            let server = stack_server_label(&payload.servers, &sv.server_id);
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
        for it in &result.launched {
            let server = stack_server_label(&detail.servers, &it.server_id);
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
        for it in &result.failed {
            let server = stack_server_label(&detail.servers, &it.server_id);
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
            }
        })
        .collect()
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
    *current_partition = default_partition(visible);
    *current_layout = layout_for_partition(current_partition);

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
    let mut current_partition = default_partition(visible_count);
    let mut current_layout = layout_for_partition(&current_partition);

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
    loop {
        tokio::select! {
            maybe_event = event_rx.recv() => {
                let Some(ev) = maybe_event else { break; };
                match ev {
                    Event::Key(key) => {
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
                    }
                    _ => {}
                }
            }
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_msg(&mut panes, text.as_str());
                        draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            handle_server_msg(&mut panes, text);
                            draw_stack(&mut stdout, &stack_title, &panes, focused)?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(anyhow!("websocket error: {e}")),
                }
            }
            _ = runtime_poll.tick() => {
                let Ok(latest) = fetch_stack_detail(&cfg, &stack_id).await else {
                    continue;
                };
                if !stack_state_changed(&panes, &latest, filter_id.as_deref()) {
                    continue;
                }
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
    let hints = "Ctrl-A D detach · 1-6 focus · [/] cycle";

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
                            match handle_picker_key(key, picker.as_mut().unwrap(), current_servers.len()) {
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
                                    let server_id = current_servers
                                        .get(p.selected)
                                        .map(|s| s.id.clone());
                                    if let Some(server_id) = server_id {
                                        let body = serde_json::json!({ "serverId": server_id });
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

                        // Ctrl-A N opens the inline picker — pre-allocate a
                        // slot, drop the user's input mode, render the
                        // server list inside the new pane.
                        if escape
                            && matches!(key.code, KeyCode::Char('n') | KeyCode::Char('N'))
                        {
                            escape = false;
                            if let Some(p) = enter_picker_mode(
                                &mut panes,
                                &mut current_layout,
                                &mut current_partition,
                                &send_tx,
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
                    }
                    _ => {}
                }
            }
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_msg(&mut panes, text.as_str());
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
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            handle_server_msg(&mut panes, text);
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
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(anyhow!("websocket error: {e}")),
                }
            }
            _ = membership_poll.tick() => {
                // Don't fight the user mid-overlay — once they've opened
                // the inline picker or a Y/n confirm modal we freeze
                // the periodic refresh until they finish.
                if picker.is_some() || confirm.is_some() {
                    continue;
                }
                // Best-effort: a transient HTTP failure shouldn't drop
                // the user out of the group view.
                let Ok(latest) = fetch_group_detail(&cfg, &group_id).await else {
                    continue;
                };
                if latest.group.members.is_empty() {
                    // Last terminal removed → exit, otherwise we'd keep
                    // an empty mosaic on screen forever.
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
    Ok(())
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


fn handle_picker_key(
    key: KeyEvent,
    picker: &mut PickerState,
    server_count: usize,
) -> PickerKeyResult {
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            if picker.selected > 0 {
                picker.selected -= 1;
            }
            PickerKeyResult::Idle
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if picker.selected + 1 < server_count {
                picker.selected += 1;
            }
            PickerKeyResult::Idle
        }
        KeyCode::Home => {
            picker.selected = 0;
            PickerKeyResult::Idle
        }
        KeyCode::End => {
            picker.selected = server_count.saturating_sub(1);
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
/// 6-member cap or the user has no servers registered yet, so the
/// caller can leave the view as-is.
async fn enter_picker_mode(
    panes: &mut [Pane],
    current_layout: &mut GroupLayout,
    current_partition: &mut Vec<usize>,
    send_tx: &mpsc::Sender<String>,
) -> Result<Option<PickerState>> {
    if panes.len() >= 6 {
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

fn handle_server_msg(panes: &mut [Pane], text: &str) {
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
    servers: &[CliServer],
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
        draw_picker(stdout, p, servers, panes.len() + 1)?;
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
        "Ctrl-A D detach · 1-6 focus · [/] cycle · N add · X detach pane · K kill"
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
fn draw_picker(
    stdout: &mut Stdout,
    picker: &PickerState,
    servers: &[CliServer],
    slot: usize,
) -> Result<()> {
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

    let title = format!("● {slot} pick server");
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

    if servers.is_empty() {
        queue!(
            stdout,
            MoveTo(r.x + 1, r.y + 1),
            SetForegroundColor(t.warning),
            Print(pad_visible("(no servers on this account)", inner_w)),
            ResetColor,
        )?;
        return Ok(());
    }

    // Keep the highlighted row on screen even when the server list is
    // longer than the slot height — same scroll-window trick the
    // dashboard's picker uses.
    let max_visible = inner_h.saturating_sub(1).max(1);
    let scroll = picker
        .selected
        .saturating_sub(max_visible.saturating_sub(1));
    let header = pad_visible("Press Enter to attach this slot to:", inner_w);
    queue!(
        stdout,
        MoveTo(r.x + 1, r.y + 1),
        SetForegroundColor(t.hint),
        Print(header),
        ResetColor,
    )?;

    for (row_idx, (i, server)) in servers
        .iter()
        .enumerate()
        .skip(scroll)
        .take(max_visible)
        .enumerate()
    {
        let label = if server.name.is_empty() {
            format!("{}@{}", server.username, server.host)
        } else {
            format!("{}  ({}@{})", server.name, server.username, server.host)
        };
        let marker = if i == picker.selected { "▸ " } else { "  " };
        let line = pad_visible(&truncate(&format!("{marker}{label}"), inner_w), inner_w);
        let y = r.y + 2 + row_idx as u16;
        queue!(stdout, MoveTo(r.x + 1, y))?;
        if i == picker.selected {
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
