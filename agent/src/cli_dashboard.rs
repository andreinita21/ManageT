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
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{
    Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor, Stylize,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    session: GroupSession,
    server_label: String,
    rect: Rect,
    parser: vt100::Parser,
    lost: Option<String>,
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
    let cfg = DashboardCliConfig {
        api_url,
        token: envelope.data.token,
    };
    save_config(&cfg)?;
    println!(
        "Logged in to {} as {}",
        cfg.api_url, envelope.data.user.username
    );
    Ok(())
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

pub async fn run_group_open(selector: String) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        bail!("group open requires a TTY");
    }

    let cfg = load_config()?;
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
    draw_group(&mut stdout, &current_group, &panes, focused)?;

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
        send_ws(&send_tx, client_attach_msg(&pane.session)).await?;
        let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
        send_ws(
            &send_tx,
            client_resize_msg(&pane.session, inner_rows, inner_cols),
        )
        .await?;
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
    loop {
        tokio::select! {
            maybe_event = event_rx.recv() => {
                let Some(ev) = maybe_event else { break; };
                match ev {
                    Event::Key(key) => {
                        let focused_session = panes[focused].session.clone();
                        if handle_key(
                            key,
                            &mut escape,
                            &mut focused,
                            panes.len(),
                            &send_tx,
                            &focused_session,
                        ).await? {
                            break;
                        }
                        draw_group(&mut stdout, &current_group, &panes, focused)?;
                    }
                    Event::Resize(cols, rows) => {
                        apply_resize(&mut panes, &current_layout, &current_partition, cols, rows);
                        for pane in &panes {
                            let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
                            send_ws(
                                &send_tx,
                                client_resize_msg(&pane.session, inner_rows, inner_cols),
                            ).await?;
                        }
                        draw_group(&mut stdout, &current_group, &panes, focused)?;
                    }
                    _ => {}
                }
            }
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_msg(&mut panes, text.as_str());
                        draw_group(&mut stdout, &current_group, &panes, focused)?;
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            handle_server_msg(&mut panes, text);
                            draw_group(&mut stdout, &current_group, &panes, focused)?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(anyhow!("websocket error: {e}")),
                }
            }
            _ = membership_poll.tick() => {
                // Best-effort: a transient HTTP failure shouldn't drop
                // the user out of the group view. We just skip this tick
                // and try again on the next one.
                let Ok(latest) = fetch_group_detail(&cfg, &group_id).await else {
                    continue;
                };
                let current_ids: Vec<String> = panes.iter().map(|p| p.session.id.clone()).collect();
                let latest_ids: Vec<String> =
                    latest.group.members.iter().map(|m| m.id.clone()).collect();
                if latest_ids == current_ids {
                    continue;
                }
                if latest.group.members.is_empty() {
                    // Last terminal removed → exit, otherwise we'd keep
                    // an empty mosaic on screen forever.
                    break;
                }
                let CliGroupDetail {
                    group: new_group,
                    layout: new_layout,
                    servers: new_servers,
                } = latest;
                current_group = new_group;
                current_servers = new_servers;
                current_layout = valid_layout_or_default(new_layout, current_group.members.len());
                current_partition = active_partition(&current_layout, current_group.members.len());
                server_labels = build_server_labels(&current_servers);

                let (cols, rows) = terminal::size().unwrap_or((120, 36));
                let fresh_panes = build_panes(
                    &current_group,
                    &server_labels,
                    &current_layout,
                    &current_partition,
                    cols,
                    rows,
                );
                // Preserve vt100 scroll/state for sessions that survived
                // the membership change — otherwise a new pane appearing
                // would blank everyone's scrollback.
                let mut preserved: std::collections::HashMap<String, vt100::Parser> =
                    std::collections::HashMap::new();
                for old in panes.drain(..) {
                    preserved.insert(old.session.id.clone(), old.parser);
                }
                let kept: std::collections::HashSet<String> =
                    current_ids.into_iter().collect();
                let mut rebuilt = Vec::with_capacity(fresh_panes.len());
                for mut p in fresh_panes {
                    if let Some(parser) = preserved.remove(&p.session.id) {
                        let (h, w) = pane_inner_size(p.rect);
                        let mut reused = parser;
                        reused.set_size(h, w);
                        p.parser = reused;
                    }
                    rebuilt.push(p);
                }
                panes = rebuilt;
                focused = focused.min(panes.len().saturating_sub(1));

                // Attach + size only the brand-new panes; the survivors
                // are already attached on the WS server's side.
                for pane in &panes {
                    let is_new = !kept.contains(&pane.session.id);
                    let (inner_rows, inner_cols) = pane_inner_size(pane.rect);
                    if is_new {
                        send_ws(&send_tx, client_attach_msg(&pane.session)).await?;
                    }
                    send_ws(
                        &send_tx,
                        client_resize_msg(&pane.session, inner_rows, inner_cols),
                    )
                    .await?;
                }
                draw_group(&mut stdout, &current_group, &panes, focused)?;
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

async fn handle_key(
    key: KeyEvent,
    escape: &mut bool,
    focused: &mut usize,
    pane_count: usize,
    send_tx: &mpsc::Sender<String>,
    focused_session: &GroupSession,
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
                send_ws(send_tx, client_input_msg(focused_session, "\x01")).await?;
                return Ok(false);
            }
            _ => {
                send_ws(send_tx, client_input_msg(focused_session, "\x01")).await?;
            }
        }
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char(CTRL_A) {
        *escape = true;
        return Ok(false);
    }

    if let Some(input) = key_to_terminal_input(key) {
        send_ws(send_tx, client_input_msg(focused_session, &input)).await?;
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
            if let Some(pane) = panes.iter_mut().find(|p| p.session.id == session_id) {
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
            if let Some(pane) = panes.iter_mut().find(|p| p.session.id == session_id) {
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

fn draw_group(stdout: &mut Stdout, group: &Group, panes: &[Pane], focused: usize) -> Result<()> {
    queue!(stdout, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    let (cols, _) = terminal::size().unwrap_or((120, 36));
    draw_status_bar(stdout, group, panes, focused, cols)?;
    for (i, pane) in panes.iter().enumerate() {
        draw_pane(stdout, pane, i == focused, i + 1)?;
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
) -> Result<()> {
    let active_slot = focused + 1;
    let active_name = panes
        .get(focused)
        .map(|p| p.session.session_name.as_str())
        .unwrap_or("?");
    let active_text = format!("active {}:{}", active_slot, active_name);

    let segments: [(&str, Color, bool); 7] = [
        ("managet group:", Color::Magenta, true),
        (" ", Color::White, false),
        (group.name.as_str(), Color::White, true),
        ("  │  ", Color::DarkGrey, false),
        (active_text.as_str(), Color::Cyan, false),
        ("  │  ", Color::DarkGrey, false),
        ("Ctrl-A D detach · Ctrl-A 1-6 focus · Ctrl-A [/] cycle", Color::DarkGrey, false),
    ];

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
        queue!(stdout, SetForegroundColor(color))?;
        if bold {
            queue!(stdout, SetAttribute(Attribute::Bold))?;
        }
        queue!(stdout, Print(&to_print))?;
        if bold {
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

    // Active panes get a bright cyan border and bold title; inactive
    // panes use a dim grey so the focused window is the one that catches
    // the eye even in a 6-up mosaic.
    let border_color = if active { Color::Cyan } else { Color::DarkGrey };
    let title_color = if active { Color::Cyan } else { Color::Grey };

    let horizontal = "─".repeat(r.w.saturating_sub(2) as usize);
    queue!(
        stdout,
        SetForegroundColor(border_color),
        MoveTo(r.x, r.y),
        Print("┌"),
        Print(&horizontal),
        Print("┐"),
    )?;
    for y in r.y + 1..r.y + r.h.saturating_sub(1) {
        queue!(stdout, MoveTo(r.x, y), Print("│"))?;
        queue!(stdout, MoveTo(r.x + r.w.saturating_sub(1), y), Print("│"))?;
    }
    queue!(
        stdout,
        MoveTo(r.x, r.y + r.h.saturating_sub(1)),
        Print("└"),
        Print(&horizontal),
        Print("┘"),
        ResetColor,
    )?;

    // Build a plain version of the title to compute visible width, then
    // emit colored segments fit to the available width.
    let max_title = r.w.saturating_sub(4) as usize;
    let bullet = if active { "●" } else { "○" };
    let status_color = status_to_color(&pane.session.status);
    let segments: [(String, Color, bool); 8] = [
        (format!("{bullet} "), border_color, false),
        (format!("{slot} "), title_color, true),
        (pane.session.session_name.clone(), title_color, true),
        (" [".to_string(), Color::DarkGrey, false),
        (pane.session.status.clone(), status_color, false),
        ("] ".to_string(), Color::DarkGrey, false),
        ("@ ".to_string(), Color::DarkGrey, false),
        (pane.server_label.clone(), Color::Blue, false),
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
    if let Some(reason) = &pane.lost {
        queue!(
            stdout,
            MoveTo(r.x + 1, r.y + 1),
            SetForegroundColor(Color::Red),
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

fn status_to_color(status: &str) -> Color {
    match status {
        "running" | "attached" | "active" => Color::Green,
        "detached" | "idle" => Color::Yellow,
        "closed" | "exited" | "stopped" | "lost" => Color::Red,
        _ => Color::Grey,
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
                session: session.clone(),
                server_label: server_labels
                    .get(&session.server_id)
                    .cloned()
                    .unwrap_or_else(|| session.server_id.clone()),
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
