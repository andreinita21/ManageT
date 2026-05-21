//! Bottom-row status bar drawn locally during `managet attach`.
//!
//! The bar is **coloured text on a cleared row**, not a full-row
//! reverse-video stripe — early users found the stripe layout busy and
//! easy to confuse with shell output. Everything is left-aligned in a
//! single line:
//!
//!     ❯ managet · session build · andrei@markI · Ctrl+A D to detach
//!
//! Layout rules:
//! * Single line, left-justified, no padding to the right edge.
//! * The row is cleared with `\x1b[2K` before each redraw so leftover
//!   shell output never shows through.
//! * The PTY is told it has `rows - 1` rows; the local scrolling
//!   region is restricted to lines 1..(rows-1) so normal PTY output
//!   can't scroll into the bar row.
//! * Cursor save / restore wraps every redraw.
//!
//! Configuration lives in `/etc/managet-agent/bar.toml`. Defaults are
//! baked in so the bar works out of the box. The format is:
//!
//!     color = "green"
//!     fields = ["session", "user_host", "duration", "detach"]
//!
//! Any unknown / missing fields fall back to the defaults. Reading is
//! best-effort — a malformed file is logged and ignored.

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Instant;

const SIGIL: &str = "❯ managet";
const RESET: &str = "\x1b[0m";
/// Clear current line (left of and right of cursor).
const CLEAR_LINE: &str = "\x1b[2K";
const SAVE_CURSOR: &str = "\x1b[s";
const RESTORE_CURSOR: &str = "\x1b[u";

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
    fn sgr(self) -> &'static str {
        // Bold + bright-foreground gives a strong but theme-friendly
        // colour on every terminal. Background stays the user's
        // default, so the bar reads as text rather than as a stripe.
        match self {
            BarColor::Green => "\x1b[1;92m",
            BarColor::Cyan => "\x1b[1;96m",
            BarColor::Magenta => "\x1b[1;95m",
            BarColor::Yellow => "\x1b[1;93m",
            BarColor::Blue => "\x1b[1;94m",
            BarColor::Red => "\x1b[1;91m",
            BarColor::White => "\x1b[1;97m",
            BarColor::Gray => "\x1b[2;37m",
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
    /// Load from the standard config path, falling back to defaults
    /// (and logging once on stderr) when the file is missing or
    /// malformed. The agent process can pre-load and pass this in;
    /// the CLI loads it lazily on attach.
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
    // Same directory as the agent's main config.toml — keeps everything
    // managet-related under one /etc/managet-agent tree.
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

pub struct StatusBar {
    session_name: String,
    user: String,
    host: String,
    attached_at: Instant,
    rows: u16,
    cols: u16,
    config: BarConfig,
}

impl StatusBar {
    pub fn new(session_name: String, rows: u16, cols: u16) -> Self {
        let config = BarConfig::load_or_default();
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "user".into());
        let host = hostname_string();
        Self {
            session_name,
            user,
            host,
            attached_at: Instant::now(),
            rows,
            cols,
            config,
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
    }

    /// Enter status-bar mode: set the scrolling region, paint the bar,
    /// and nudge the cursor to row 1 so it doesn't linger at the row we
    /// just took over. The nudge is what stops the shell prompt from
    /// "covering" the bar after attach — without it the cursor stays
    /// on the now-reserved bottom row.
    pub fn enter<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        // DECSTBM scrolling region.
        write!(w, "\x1b[1;{}r", self.rows.saturating_sub(1))?;
        // Move the cursor to the top of the new region so it can't
        // stay parked on the bar row.
        write!(w, "\x1b[1;1H")?;
        self.redraw(w)
    }

    /// Redraw the bar in-place. Clears the bar row before painting so
    /// stale shell content can't bleed through.
    pub fn redraw<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        let line = self.compose(self.cols as usize);
        write!(
            w,
            "{save}\x1b[{row};1H{clear}{color}{line}{reset}{restore}",
            save = SAVE_CURSOR,
            row = self.rows,
            clear = CLEAR_LINE,
            color = self.config.color.sgr(),
            line = line,
            reset = RESET,
            restore = RESTORE_CURSOR
        )?;
        w.flush()
    }

    pub fn leave<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        // Reset scrolling region, clear bar row, leave cursor on the
        // last content row so the post-detach `[managet] detached.`
        // doesn't appear on a half-painted line.
        write!(
            w,
            "\x1b[r\x1b[{row};1H{clear}",
            row = self.rows,
            clear = CLEAR_LINE,
        )?;
        w.flush()
    }

    /// Build the visible content for the bar. Always starts with the
    /// branding sigil, then appends each configured field if there's
    /// room. We never wrap or right-pad — bar is left-aligned, period.
    fn compose(&self, cols: usize) -> String {
        let mut out = String::from(SIGIL);
        for f in &self.config.fields {
            let segment = match f {
                BarField::Session => format!("session {}", truncate(&self.session_name, 32)),
                BarField::UserHost => format!(
                    "{}@{}",
                    truncate(&self.user, 16),
                    truncate(&self.host, 24)
                ),
                BarField::Duration => format!("attached {}", format_duration(self.attached_at.elapsed().as_secs())),
                BarField::Detach => "Ctrl+A D to detach".to_string(),
            };
            let candidate = format!("{out} · {segment}");
            if visible_len(&candidate) > cols {
                // Out of room. Stop appending — the most important
                // fields are listed earlier in the config.
                break;
            }
            out = candidate;
        }
        // Final safety clamp in case the sigil + first field already
        // exceeded `cols` on an unusably-narrow terminal.
        if visible_len(&out) > cols {
            return truncate(&out, cols.max(1));
        }
        out
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn visible_len(s: &str) -> usize {
    s.chars().count()
}

fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else if secs < 86_400 {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d{}h", secs / 86_400, (secs % 86_400) / 3600)
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

/// Persist a (partial) bar config to disk. Called from the reconfigure
/// subcommand so the dashboard can push new bar settings the same way
/// it pushes api_url / interval. Missing fields keep their existing
/// values. The agent process doesn't need to be restarted — the bar
/// reloads its config on every attach.
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
    let color_name = match cfg.color {
        BarColor::Green => "green",
        BarColor::Cyan => "cyan",
        BarColor::Magenta => "magenta",
        BarColor::Yellow => "yellow",
        BarColor::Blue => "blue",
        BarColor::Red => "red",
        BarColor::White => "white",
        BarColor::Gray => "gray",
    };
    let fields_str = cfg
        .fields
        .iter()
        .map(|f| match f {
            BarField::Session => "session",
            BarField::UserHost => "user_host",
            BarField::Duration => "duration",
            BarField::Detach => "detach",
        })
        .collect::<Vec<_>>()
        .join("\", \"");
    let raw = format!("color = \"{color_name}\"\nfields = [\"{fields_str}\"]\n");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, raw)?;
    Ok(())
}
