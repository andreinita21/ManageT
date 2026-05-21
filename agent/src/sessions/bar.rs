//! Bottom-row status bar drawn locally during `managet attach`.
//!
//! Design notes
//! ------------
//! * The bar lives on the **last row** of the local terminal. We restrict
//!   the local scrolling region to rows 1..(rows-1) (DECSTBM) so the PTY
//!   stream's CR/LF can never disturb it.
//! * The remote PTY is told to use (rows-1) rows so well-behaved
//!   applications (anything reading `TIOCGWINSZ`) lay out as if the
//!   terminal were one row shorter.
//! * Rendering avoids any third-party TUI dep — pure ANSI sequences,
//!   keeping the agent binary tight.
//! * We don't try to track alt-screen entry/exit (vim, less, etc.).
//!   Those apps overwrite the bottom row temporarily; the next 5s tick
//!   redraws the bar once they exit alt screen.
//! * If the terminal is too narrow for the full bar, segments are
//!   dropped right-to-left so the detach hint always stays visible.

use std::io::{self, Write};
use std::time::Instant;

/// Sigil rendered at the left edge of the bar. Single high-contrast
/// glyph so the user can spot "I'm in managet" at a glance even when
/// dim mode washes the rest of the bar out.
const SIGIL: &str = "❯ managet";

/// SGR opener: reverse video + dim. Reverse keeps the bar legible on
/// every theme; dim takes the edge off the brightness so it doesn't
/// scream at the user.
const SGR_BAR: &str = "\x1b[7;2m";
const SGR_RESET: &str = "\x1b[0m";

/// Save / restore cursor. We do this on every redraw so the bar never
/// leaves the PTY's cursor stranded on the bar row.
const CSI_SAVE_CURSOR: &str = "\x1b[s";
const CSI_RESTORE_CURSOR: &str = "\x1b[u";

/// Set scrolling region to lines `top`..=`bottom` (DECSTBM). The
/// terminal honours newlines / index sequences only within the region,
/// so PTY output never overwrites the bar.
fn csi_set_scrolling_region(top: u16, bottom: u16) -> String {
    format!("\x1b[{};{}r", top, bottom)
}

/// Clear scrolling region back to the full screen.
const CSI_RESET_SCROLLING_REGION: &str = "\x1b[r";

/// Move cursor to (row, col), 1-indexed.
fn csi_move_to(row: u16, col: u16) -> String {
    format!("\x1b[{};{}H", row, col)
}

pub struct StatusBar {
    session_name: String,
    user: String,
    host: String,
    attached_at: Instant,
    rows: u16,
    cols: u16,
}

impl StatusBar {
    pub fn new(session_name: String, rows: u16, cols: u16) -> Self {
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
        }
    }

    /// Resize the bar in response to a SIGWINCH. The caller is
    /// responsible for sending the new (rows-1, cols) PTY size to the
    /// agent — this only updates the local rendering geometry.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
    }

    /// Enter status-bar mode: set the scrolling region so the PTY can't
    /// scroll over the bar, then paint the bar. Must be called after
    /// raw mode is enabled and before the byte pump starts.
    pub fn enter<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            // Too small to be worth reserving a row — the user will see
            // raw PTY output filling the screen, no bar. The caller
            // shouldn't have shrunk the PTY in this case either.
            return Ok(());
        }
        w.write_all(csi_set_scrolling_region(1, self.rows.saturating_sub(1)).as_bytes())?;
        self.redraw(w)
    }

    /// Redraw the bar in-place. Cheap to call — used on attach, on
    /// resize, and on the 5s duration tick.
    pub fn redraw<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        let line = self.compose(self.cols as usize);
        // Save the application cursor, jump to the bar row, paint, and
        // restore. The cursor sequence is bracketed by SGR_RESET so a
        // half-broken inner app can't leave the bar's attrs leaking
        // into the user's content row.
        write!(
            w,
            "{save}{move_}{sgr_on}{line}{sgr_off}{restore}",
            save = CSI_SAVE_CURSOR,
            move_ = csi_move_to(self.rows, 1),
            sgr_on = SGR_BAR,
            line = line,
            sgr_off = SGR_RESET,
            restore = CSI_RESTORE_CURSOR
        )?;
        w.flush()
    }

    /// Tear down: drop the scrolling region and clear the bar row so we
    /// don't leave a stripe at the bottom of the user's terminal after
    /// detach.
    pub fn leave<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.rows < 3 {
            return Ok(());
        }
        write!(
            w,
            "{reset_region}{move_}\x1b[2K",
            reset_region = CSI_RESET_SCROLLING_REGION,
            move_ = csi_move_to(self.rows, 1),
        )?;
        w.flush()
    }

    /// Build the bar content padded to exactly `cols` characters wide.
    /// Drops segments right-to-left when the terminal is too narrow,
    /// keeping the detach hint and the sigil as the two pinned ends.
    fn compose(&self, cols: usize) -> String {
        let detach_hint = "C-a d ← detach";
        // The duration counter ticks every 5s, written as e.g. "2m05s".
        let secs = self.attached_at.elapsed().as_secs();
        let duration = format_duration(secs);

        // Build candidate segments, longest-truncatable first to the
        // right. The compose pass below drops them in reverse order
        // until everything fits.
        let segments: Vec<String> = vec![
            SIGIL.to_string(),
            format!("session {}", truncate(&self.session_name, 24)),
            format!("{}@{}", truncate(&self.user, 16), truncate(&self.host, 24)),
            format!("attached {duration}"),
        ];

        let separator = " · ";
        let mut kept = segments.clone();
        loop {
            let left = kept.join(separator);
            let total = visible_len(&left) + separator.len() + visible_len(detach_hint);
            if total <= cols || kept.len() <= 1 {
                let pad = cols
                    .saturating_sub(visible_len(&left) + visible_len(detach_hint) + 1);
                return format!("{left}{}{detach_hint}", " ".repeat(pad + 1));
            }
            // Drop the last (rightmost) non-essential segment.
            kept.pop();
        }
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
    // Bar content is plain UTF-8 (no embedded escape sequences), so a
    // character count is the right approximation for cell width on
    // typical monospace terminals. East-Asian wide glyphs would be
    // off-by-one — acceptable for a status bar.
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
    // Avoid pulling in the `hostname` crate just for this — libc::gethostname
    // is already in the dep graph for the rest of this file.
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
