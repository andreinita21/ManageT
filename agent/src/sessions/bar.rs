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
    /// Full-row SGR: bold + contrasting foreground + coloured background.
    /// The bar fills the whole bottom row with this background so it
    /// reads as a proper tmux-style status bar, not a single coloured
    /// word floating on the user's default background.
    fn sgr(self) -> &'static str {
        match self {
            BarColor::Green => "\x1b[1;30;42m",   // black on green
            BarColor::Cyan => "\x1b[1;30;46m",    // black on cyan
            BarColor::Magenta => "\x1b[1;97;45m", // white on magenta
            BarColor::Yellow => "\x1b[1;30;43m",  // black on yellow
            BarColor::Blue => "\x1b[1;97;44m",    // white on blue
            BarColor::Red => "\x1b[1;97;41m",     // white on red
            BarColor::White => "\x1b[1;30;47m",   // black on white
            BarColor::Gray => "\x1b[1;97;100m",   // white on bright-black
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
    /// Throttling state for `redraw_after_io`.
    last_redraw: Option<Instant>,
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
            last_redraw: None,
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
    }

    /// Enter status-bar mode. Three defences keep the bar safe:
    ///   1. DECSTBM restricts scrolling to rows 1..(rows-1).
    ///   2. DECOM (origin mode) clamps cursor *positioning* to the
    ///      same region — without this, a shell that thinks it has
    ///      `rows` rows can still address row `rows` directly and
    ///      walk all over the bar. This is what fixed the "typing
    ///      overwrites the bar, backspace eats it" bug.
    ///   3. Cursor is nudged to (1,1) so the inner app doesn't linger
    ///      at the now-reserved bottom row on attach.
    /// The caller is responsible for calling `redraw_after_io()` after
    /// every chunk of PTY bytes — that's the cheap belt-and-braces
    /// against alt-screen escapes or `clear` sequences that bypass
    /// the scrolling region entirely.
    pub fn enter<W: Write>(&mut self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        // DECSTBM + DECOM + cursor home + paint.
        write!(w, "\x1b[1;{}r", self.rows.saturating_sub(1))?;
        write!(w, "\x1b[?6h")?;
        write!(w, "\x1b[1;1H")?;
        self.last_redraw = None;
        self.redraw(w)
    }

    /// Redraw the bar in-place. Always re-asserts DECOM in case the
    /// inner app turned it off (vim toggles modes during init, etc.).
    pub fn redraw<W: Write>(&mut self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        let line = self.compose(self.cols as usize);
        // SGR before SAVE_CURSOR so we don't accidentally paint the
        // bar's attributes into wherever the user's cursor was sitting
        // when we save it. After RESTORE_CURSOR we explicitly reset to
        // RESET to keep the inner app's attributes clean.
        // DECOM (`\x1b[?6h`) is re-asserted at the END so even if the
        // PTY stream just turned it off, the next move is clamped.
        // We also use \x1b[?7l (autowrap off) while painting so the
        // trailing cell never causes a wrap-and-scroll.
        write!(
            w,
            "{save}\x1b[?7l\x1b[{row};1H{color}{line}{reset}\x1b[?7h{restore}\x1b[?6h",
            save = SAVE_CURSOR,
            row = self.rows,
            color = self.config.color.sgr(),
            line = line,
            reset = RESET,
            restore = RESTORE_CURSOR
        )?;
        w.flush()?;
        self.last_redraw = Some(Instant::now());
        Ok(())
    }

    /// Throttled redraw — call this after every chunk of PTY output.
    /// Repaints only if more than `MIN_REDRAW_INTERVAL` has elapsed
    /// since the last paint, so a tight `tail -f` loop doesn't pay
    /// the cost of writing the bar bytes thousands of times per
    /// second.
    pub fn redraw_after_io<W: Write>(&mut self, w: &mut W) -> io::Result<()> {
        const MIN_REDRAW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
        if let Some(last) = self.last_redraw {
            if last.elapsed() < MIN_REDRAW_INTERVAL {
                return Ok(());
            }
        }
        self.redraw(w)
    }

    pub fn leave<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        // Turn off DECOM, reset scrolling region, clear the bar row.
        write!(
            w,
            "\x1b[?6l\x1b[r\x1b[{row};1H{clear}",
            row = self.rows,
            clear = CLEAR_LINE,
        )?;
        w.flush()
    }

    /// Build a row-wide line of bar content. Always starts with the
    /// branding sigil, then appends each configured field if there's
    /// room. The line is **padded with spaces to `cols`** so the
    /// background colour fills the full row — that's what makes it
    /// look like a tmux status bar rather than a coloured word.
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
                break;
            }
            out = candidate;
        }
        // Clamp width if even the sigil + first segment overflowed.
        if visible_len(&out) > cols {
            out = truncate(&out, cols.max(1));
        }
        // Pad with spaces to the full row so the SGR background fills
        // every cell. One trailing-space buffer is left when the
        // terminal is exactly `cols` wide so the final cell doesn't
        // get autowrap-clobbered on terminals that fail to honour
        // \x1b[?7l.
        let len = visible_len(&out);
        if len < cols.saturating_sub(1) {
            out.push_str(&" ".repeat(cols.saturating_sub(1) - len));
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
