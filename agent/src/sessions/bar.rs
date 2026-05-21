//! "Am I in managet?" indicators for `managet attach`.
//!
//! Earlier versions of this module drew a full-row, pinned status bar at
//! the bottom of the terminal using DECSTBM + DECOM. That worked
//! visually on paper but had two killer downsides in practice:
//!
//! * Restricting the scroll region disables the host terminal's native
//!   scrollback for content rendered inside the region. Once you've
//!   scrolled, you can't get back to earlier output without an in-CLI
//!   scrollback buffer — a tmux-class engineering effort.
//! * Edge cases in DECOM / DECSC across terminal emulators kept
//!   producing visual glitches (typing overwriting the bar, partial
//!   redraws, etc.) that were unfixable without rebuilding the whole
//!   virtual-terminal pipeline.
//!
//! Trade-off chosen: drop the in-screen bar entirely. Native scrollback
//! works again. To still answer "am I attached to managet, and to
//! which session?" we use two passive indicators that don't compete
//! with the PTY for screen space:
//!
//!   1. **Window / tab title** via OSC 0 — set to
//!      `managet: <session>@<host>` while attached, cleared on detach.
//!      Visible in every terminal emulator's tab bar / titlebar; never
//!      moves, never flickers.
//!   2. **A one-line coloured banner** printed once on attach, naming
//!      the session, host, user, and the Ctrl+A D detach shortcut. It
//!      scrolls away as the session continues — that's fine, the title
//!      is the persistent reminder.
//!
//! Configuration (colour, which fields go into the banner) is still
//! read from `/etc/managet-agent/bar.toml` so the dashboard's existing
//! push flow keeps working without changes.

use std::io::{self, Write};
use std::path::PathBuf;

/// Branding sigil rendered in front of the banner.
const SIGIL: &str = "❯ managet";
const RESET: &str = "\x1b[0m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarColor {
    Green,
    Cyan,
    Magenta,
    Yellow,
    Blue,
    Red,
    White,
    Gray,
}

impl BarColor {
    /// SGR for the one-shot banner. Bold + bright foreground reads as
    /// "important" on every theme without taking over the row with a
    /// background colour.
    fn sgr(self) -> &'static str {
        match self {
            BarColor::Green => "\x1b[1;92m",
            BarColor::Cyan => "\x1b[1;96m",
            BarColor::Magenta => "\x1b[1;95m",
            BarColor::Yellow => "\x1b[1;93m",
            BarColor::Blue => "\x1b[1;94m",
            BarColor::Red => "\x1b[1;91m",
            BarColor::White => "\x1b[1;97m",
            BarColor::Gray => "\x1b[1;90m",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s.to_ascii_lowercase().as_str() {
            "green" => BarColor::Green,
            "cyan" => BarColor::Cyan,
            "magenta" | "purple" => BarColor::Magenta,
            "yellow" => BarColor::Yellow,
            "blue" => BarColor::Blue,
            "red" => BarColor::Red,
            "white" => BarColor::White,
            "gray" | "grey" | "dim" => BarColor::Gray,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            BarColor::Green => "green",
            BarColor::Cyan => "cyan",
            BarColor::Magenta => "magenta",
            BarColor::Yellow => "yellow",
            BarColor::Blue => "blue",
            BarColor::Red => "red",
            BarColor::White => "white",
            BarColor::Gray => "gray",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarField {
    Session,
    UserHost,
    Duration,
    Detach,
}

impl BarField {
    fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "session" | "session_name" | "name" => BarField::Session,
            "user_host" | "userhost" | "user" | "host" => BarField::UserHost,
            "duration" | "time" | "attached" => BarField::Duration,
            "detach" | "shortcut" => BarField::Detach,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            BarField::Session => "session",
            BarField::UserHost => "user_host",
            BarField::Duration => "duration",
            BarField::Detach => "detach",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BarConfig {
    pub color: BarColor,
    pub fields: Vec<BarField>,
}

impl Default for BarConfig {
    fn default() -> Self {
        Self {
            color: BarColor::Green,
            fields: vec![
                BarField::Session,
                BarField::UserHost,
                BarField::Detach,
            ],
        }
    }
}

impl BarConfig {
    pub fn load_or_default() -> Self {
        let path = config_path();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return Self::default(),
        };
        match parse_bar_toml(&raw) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!("[managet] warning: ignoring malformed {}: {e}", path.display());
                Self::default()
            }
        }
    }
}

fn config_path() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/etc/managet-agent/bar.toml")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/usr/local/etc/managet-agent/bar.toml")
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        PathBuf::from("/etc/managet-agent/bar.toml")
    }
}

fn parse_bar_toml(raw: &str) -> Result<BarConfig, String> {
    let value: toml::Value = toml::from_str(raw).map_err(|e| e.to_string())?;
    let mut cfg = BarConfig::default();
    if let Some(color_str) = value.get("color").and_then(|v| v.as_str()) {
        if let Some(c) = BarColor::parse(color_str) {
            cfg.color = c;
        }
    }
    if let Some(arr) = value.get("fields").and_then(|v| v.as_array()) {
        let mut fields: Vec<BarField> = Vec::new();
        for v in arr {
            if let Some(s) = v.as_str() {
                if let Some(f) = BarField::parse(s) {
                    fields.push(f);
                }
            }
        }
        if !fields.is_empty() {
            cfg.fields = fields;
        }
    }
    Ok(cfg)
}

/// Owns the in-attach session indicator: window title + one-shot
/// banner. The previous in-screen bar API (enter/redraw/leave) is
/// preserved as no-ops where the caller doesn't need to change shape;
/// the call sites that DID rely on per-IO redraws will simply hit a
/// no-op and the terminal stays untouched.
pub struct StatusBar {
    session_name: String,
    user: String,
    host: String,
    config: BarConfig,
}

impl StatusBar {
    pub fn new(session_name: String, _rows: u16, _cols: u16) -> Self {
        let config = BarConfig::load_or_default();
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "user".into());
        let host = hostname_string();
        Self {
            session_name,
            user,
            host,
            config,
        }
    }

    /// Window resize doesn't change anything for us — the indicator is
    /// the title (no geometry) plus a one-shot banner that's already
    /// scrolled into history. Kept for API compatibility.
    pub fn resize(&mut self, _rows: u16, _cols: u16) {}

    /// Print the one-shot banner and set the terminal title. Call once
    /// when entering attach.
    pub fn enter<W: Write>(&mut self, w: &mut W) -> io::Result<()> {
        // OSC 0 — set both window title and icon name. BEL terminator
        // is widely supported (the ST `\x1b\\` form trips up some old
        // emulators; BEL is the safer default).
        let title = format!("managet: {}@{}", self.session_name, self.host);
        write!(w, "\x1b]0;{}\x07", title)?;

        // The banner. CR+LF up front so it always lands on a fresh
        // line (raw mode means the kernel won't help with that).
        // The banner is intentionally one line so it occupies minimal
        // scrollback space.
        let mut parts: Vec<String> = vec![SIGIL.to_string()];
        for f in &self.config.fields {
            parts.push(match f {
                BarField::Session => format!("session {}", self.session_name),
                BarField::UserHost => format!("{}@{}", self.user, self.host),
                BarField::Duration => "just now".to_string(),
                BarField::Detach => "Ctrl+A D to detach".to_string(),
            });
        }
        let body = parts.join(" · ");
        write!(
            w,
            "\r\n{color}{body}{reset}\r\n",
            color = self.config.color.sgr(),
            body = body,
            reset = RESET,
        )?;
        w.flush()
    }

    /// No-op. Kept so existing call sites in client.rs compile without
    /// having to be torn out — the per-IO redraw path is intentionally
    /// dead now.
    pub fn redraw<W: Write>(&mut self, _w: &mut W) -> io::Result<()> {
        Ok(())
    }

    /// No-op. See `redraw`.
    pub fn redraw_after_io<W: Write>(&mut self, _w: &mut W) -> io::Result<()> {
        Ok(())
    }

    /// Restore the terminal title and emit a single CR+LF so the
    /// post-detach `[managet] detached.` message starts on its own
    /// line. Kept as `&self` so existing call sites work.
    pub fn leave<W: Write>(&self, w: &mut W) -> io::Result<()> {
        // OSC 0 with empty payload tells the terminal to fall back to
        // whatever title it had before us. Most modern emulators
        // restore the parent shell's title.
        write!(w, "\x1b]0;\x07")?;
        w.flush()
    }
}

fn hostname_string() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: buf is at least 1 byte, gethostname writes a NUL-terminated
    // string into a buffer of the given size.
    let rc =
        unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return "host".into();
    }
    let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..nul]).into_owned()
}

// ----------------------------------------------------------------------
// `managet-agent reconfigure --bar-color … --bar-fields …`
// ----------------------------------------------------------------------

/// Persist a (partial) bar config to disk. Kept so the dashboard's
/// existing `managet-agent reconfigure --bar-color …` push flow works
/// unchanged; the values control the colour of the attach banner and
/// which fields it includes.
pub fn save_partial(color: Option<&str>, fields: Option<&str>) -> anyhow::Result<()> {
    let path = config_path();
    let mut cfg = BarConfig::load_or_default();
    if let Some(c) = color {
        cfg.color = BarColor::parse(c)
            .ok_or_else(|| anyhow::anyhow!("unknown bar color '{c}' — supported: green, cyan, magenta, yellow, blue, red, white, gray"))?;
    }
    if let Some(fs) = fields {
        let parsed: Vec<BarField> = fs
            .split(',')
            .filter_map(|s| BarField::parse(s))
            .collect();
        if parsed.is_empty() {
            anyhow::bail!("--bar-fields produced no recognised entries (got '{fs}')");
        }
        cfg.fields = parsed;
    }
    let fields_str = cfg
        .fields
        .iter()
        .map(|f| f.name())
        .collect::<Vec<_>>()
        .join("\", \"");
    let raw = format!(
        "color = \"{color}\"\nfields = [\"{fields}\"]\n",
        color = cfg.color.name(),
        fields = fields_str,
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, raw)?;
    Ok(())
}
