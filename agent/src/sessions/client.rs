//! Client side of the local session protocol — i.e. what
//! `managet ls`, `managet new`, `managet attach`, `managet kill`
//! actually do.
//!
//! `attach` is the interesting one: after the JSON handshake, we put
//! the local terminal into raw mode and pipe stdin↔socket↔stdout in
//! both directions until the user types the detach sequence
//! (Ctrl-A then `d`, à la tmux). SIGWINCH on the local terminal is
//! forwarded to the remote PTY via a Resize message multiplexed into
//! the socket between bytes — in practice we open a *separate*
//! short-lived control connection for that, since the main attach
//! connection is in raw-byte mode after the handshake.

use std::io::{IsTerminal, Write};
use std::os::fd::AsRawFd;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::signal::unix::{signal, SignalKind};

use super::bar::StatusBar;
use super::protocol::{Request, Response};
use super::server::socket_path;

/// `managet ls` — print the active sessions in a small table.
pub async fn run_ls() -> Result<()> {
    let resp = round_trip(&Request::List).await?;
    let sessions = match resp {
        Response::SessionList { sessions } => sessions,
        Response::Error { message } => return Err(anyhow!(message)),
        other => return Err(anyhow!("unexpected response: {other:?}")),
    };
    if sessions.is_empty() {
        println!("(no sessions — start one with `managet new`)");
        return Ok(());
    }
    println!("{:<10}  {:<20}  {:<24}  {}", "ID", "NAME", "AGE", "STATUS");
    let now = chrono_now_ms();
    for s in &sessions {
        let age = format_age(now.saturating_sub(s.created_at_ms));
        let status = if !s.running {
            "exited".to_string()
        } else if s.attached_clients > 0 {
            format!("attached×{}", s.attached_clients)
        } else {
            "detached".to_string()
        };
        println!(
            "{:<10}  {:<20}  {:<24}  {}",
            short_id(&s.id),
            truncate(&s.name, 20),
            age,
            status
        );
    }
    Ok(())
}

/// `managet new [-c CMD] [-n NAME]` — spawn a fresh session and print its id.
pub async fn run_new(name: Option<String>, command: Option<String>) -> Result<()> {
    let (rows, cols) = local_term_size().unwrap_or((24, 80));
    // SECURITY: spawn the new session as the invoking user, NOT as
    // whatever uid the agent process runs as (root on installed hosts).
    // Previously this passed `user: None`, which silently dropped users
    // into a root shell — a real footgun. We look up the calling user
    // by euid via getpwuid(); if that fails for some reason fall back
    // to `$USER` / `$LOGNAME`. As a last resort we still pass None,
    // which keeps the agent's behaviour (root) — that's only correct
    // when the agent IS the user, e.g. someone invoked `managet new` as
    // root themselves.
    let invoking_user = invoking_user_name();
    // Pass through the user's current working directory so the new
    // session starts where they typed `managet new`, not in $HOME.
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let resp = round_trip(&Request::New {
        name,
        command,
        rows: Some(rows),
        cols: Some(cols),
        user: invoking_user,
        cwd,
    })
    .await?;
    match resp {
        Response::Created { id, name } => {
            println!("Created session {} ({})", short_id(&id), name);
            println!("Attach with: managet attach {}", short_id(&id));
            Ok(())
        }
        Response::Error { message } => Err(anyhow!(message)),
        other => Err(anyhow!("unexpected response: {other:?}")),
    }
}

/// `managet kill <id>` — SIGTERM the session's child.
pub async fn run_kill(id: String) -> Result<()> {
    let resp = round_trip(&Request::Kill { id }).await?;
    match resp {
        Response::Ok => {
            println!("session terminated");
            Ok(())
        }
        Response::Error { message } => Err(anyhow!(message)),
        other => Err(anyhow!("unexpected response: {other:?}")),
    }
}

/// `managet attach <id>` — pipe stdin/stdout to a remote session.
pub async fn run_attach(id: String) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        anyhow::bail!("attach requires a TTY (run from an interactive shell)");
    }

    // 1. Open the long-lived data connection. Send Attach, read response.
    //    The PTY is told the full local size so the shell uses every row;
    //    we no longer reserve a row for an in-screen bar, so native host
    //    terminal scrollback keeps working.
    let stream = UnixStream::connect(&socket_path())
        .await
        .with_context(|| {
            format!("connecting to {} — is the agent running?", socket_path().display())
        })?;
    let (rd, mut wr) = stream.into_split();

    let (rows, cols) = local_term_size().unwrap_or((24, 80));
    let line = serde_json::to_string(&Request::Attach {
        id: id.clone(),
        rows: Some(rows),
        cols: Some(cols),
    })?;
    wr.write_all(line.as_bytes()).await?;
    wr.write_all(b"\n").await?;
    wr.flush().await?;

    let mut reader = BufReader::new(rd);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).await?;
    let resp: Response = serde_json::from_str(response_line.trim_end())
        .context("parsing attach response")?;
    let (resolved_id, session_name) = match resp {
        Response::Attached { id, name } => {
            // No "[managet] attached" eprintln — the bar replaces that
            // banner. The user sees branding immediately on the status
            // bar instead of having a one-line message scroll past.
            (id, name)
        }
        Response::Error { message } => return Err(anyhow!(message)),
        other => return Err(anyhow!("unexpected response: {other:?}")),
    };

    // 2. Switch local terminal into raw mode so keystrokes go straight
    //    through and the PTY on the other side does its own line
    //    discipline. The `RawMode` guard restores the original termios
    //    on drop, including on panic.
    let _raw = RawMode::enable().context("enable raw mode")?;

    // 3. Set the window title and emit the one-shot banner. No
    //    scrolling region, no in-screen overlay — the persistent
    //    indicator is the terminal title bar.
    let mut bar = StatusBar::new(session_name, rows, cols);
    {
        let mut out = std::io::stdout();
        let _ = bar.enter(&mut out);
    }

    // 4. SIGWINCH handler: forward the new local size to the agent so
    //    the PTY child can re-flow. Nothing screen-side to do — the
    //    bar isn't in-screen anymore.
    let resize_id = resolved_id.clone();
    let mut winch = signal(SignalKind::window_change()).context("install SIGWINCH handler")?;
    let resize_task = tokio::spawn(async move {
        loop {
            if winch.recv().await.is_none() {
                break;
            }
            if let Ok((rows, cols)) = local_term_size_result() {
                let _ = send_resize(&resize_id, rows, cols).await;
            }
        }
    });

    // 5. Pipe stdin → socket and socket → stdout. The detach state
    //    machine watches stdin for `Ctrl-A d`.
    let pipe_result = pipe_attach(reader, wr).await;

    resize_task.abort();
    // Restore the terminal title before RawMode drops so the user's
    // shell tab name comes back the moment they detach.
    {
        let mut out = std::io::stdout();
        let _ = bar.leave(&mut out);
    }
    pipe_result
}

/// Heart of `attach`: copies bytes both ways, watches for the detach
/// escape, exits cleanly when either side closes.
async fn pipe_attach(
    mut socket_reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    mut socket_writer: tokio::net::unix::OwnedWriteHalf,
) -> Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    // Detach escape state machine. NORMAL → ESCAPE on Ctrl-A. From
    // ESCAPE: 'd' = detach, Ctrl-A = pass through (escape escape), any
    // other byte = re-emit Ctrl-A then that byte.
    #[derive(Copy, Clone, PartialEq)]
    enum EscState {
        Normal,
        Escape,
    }
    const CTRL_A: u8 = 0x01;
    const DETACH_KEY: u8 = b'd';
    let mut state = EscState::Normal;

    let mut sock_buf = [0u8; 4096];
    let mut stdin_buf = [0u8; 4096];

    loop {
        tokio::select! {
            // Bytes from the agent → write to user's stdout.
            r = socket_reader.read(&mut sock_buf) => {
                match r {
                    Ok(0) => return Ok(()),
                    Err(e) => return Err(anyhow!("socket read: {e}")),
                    Ok(n) => {
                        stdout.write_all(&sock_buf[..n]).await?;
                        stdout.flush().await?;
                    }
                }
            }
            // Bytes from local stdin → through the detach machine →
            // forward to agent.
            r = stdin.read(&mut stdin_buf) => {
                match r {
                    Ok(0) => return Ok(()), // local EOF, detach
                    Err(e) => return Err(anyhow!("stdin read: {e}")),
                    Ok(n) => {
                        let mut out: Vec<u8> = Vec::with_capacity(n);
                        for &b in &stdin_buf[..n] {
                            match state {
                                EscState::Normal => {
                                    if b == CTRL_A {
                                        state = EscState::Escape;
                                    } else {
                                        out.push(b);
                                    }
                                }
                                EscState::Escape => {
                                    if b == DETACH_KEY {
                                        // Detach! Flush whatever we
                                        // already collected, drop the
                                        // socket, return.
                                        if !out.is_empty() {
                                            socket_writer.write_all(&out).await?;
                                        }
                                        eprintln!("\r\n[managet] detached.");
                                        return Ok(());
                                    } else if b == CTRL_A {
                                        // Literal Ctrl-A — emit one and
                                        // stay in Escape so user can do
                                        // Ctrl-A Ctrl-A d to send Ctrl-A
                                        // and detach.
                                        out.push(CTRL_A);
                                        state = EscState::Normal;
                                    } else {
                                        // Cancel escape: re-emit Ctrl-A
                                        // and the new byte.
                                        out.push(CTRL_A);
                                        out.push(b);
                                        state = EscState::Normal;
                                    }
                                }
                            }
                        }
                        if !out.is_empty() {
                            socket_writer.write_all(&out).await?;
                            socket_writer.flush().await?;
                        }
                    }
                }
            }
        }
    }
}

async fn send_resize(id: &str, rows: u16, cols: u16) -> Result<()> {
    // Brand-new connection just for this resize. Keeping it separate
    // from the main attach connection avoids interleaving JSON with the
    // raw byte stream.
    let stream = UnixStream::connect(&socket_path()).await?;
    let (rd, mut wr) = stream.into_split();
    let line = serde_json::to_string(&Request::Resize {
        id: id.to_string(),
        rows,
        cols,
    })?;
    wr.write_all(line.as_bytes()).await?;
    wr.write_all(b"\n").await?;
    wr.flush().await?;
    let mut reader = BufReader::new(rd);
    let mut buf = String::new();
    reader.read_line(&mut buf).await?;
    Ok(())
}

async fn round_trip(req: &Request) -> Result<Response> {
    let stream = UnixStream::connect(&socket_path())
        .await
        .with_context(|| {
            format!(
                "connecting to {} — is the agent running? (`sudo systemctl status managet-agent`)",
                socket_path().display()
            )
        })?;
    let (rd, mut wr) = stream.into_split();
    let line = serde_json::to_string(req)?;
    wr.write_all(line.as_bytes()).await?;
    wr.write_all(b"\n").await?;
    wr.flush().await?;

    let mut reader = BufReader::new(rd);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).await?;
    let resp: Response = serde_json::from_str(response_line.trim_end())?;
    Ok(resp)
}

// -----------------------------------------------------------------------
// Terminal helpers
// -----------------------------------------------------------------------

/// Look up the username corresponding to the calling process's
/// effective UID. Returns `None` only when neither `getpwuid()` nor the
/// `$USER`/`$LOGNAME` environment variables produce a usable string —
/// which on a sane system never happens.
fn invoking_user_name() -> Option<String> {
    use nix::unistd::{Uid, User};
    let uid = Uid::effective();
    if let Ok(Some(u)) = User::from_uid(uid) {
        if !u.name.is_empty() {
            return Some(u.name);
        }
    }
    if let Ok(s) = std::env::var("USER") {
        if !s.is_empty() {
            return Some(s);
        }
    }
    if let Ok(s) = std::env::var("LOGNAME") {
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

fn local_term_size() -> Option<(u16, u16)> {
    local_term_size_result().ok()
}

fn local_term_size_result() -> Result<(u16, u16)> {
    use libc::{ioctl, winsize, TIOCGWINSZ};
    let stdout = std::io::stdout();
    let fd = stdout.as_raw_fd();
    let mut sz: winsize = unsafe { std::mem::zeroed() };
    // SAFETY: fd is a valid file descriptor for the duration of the
    // call. winsize is a POD struct; ioctl writes to it.
    let rc = unsafe { ioctl(fd, TIOCGWINSZ, &mut sz as *mut winsize) };
    if rc != 0 {
        return Err(anyhow!("TIOCGWINSZ failed"));
    }
    Ok((sz.ws_row, sz.ws_col))
}

/// RAII guard for terminal raw mode. Restores original termios on drop.
struct RawMode {
    fd: i32,
    original: libc::termios,
}

impl RawMode {
    fn enable() -> Result<Self> {
        use std::io::stdin;
        let fd = stdin().as_raw_fd();
        let mut original: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: fd valid, original is a sufficiently-sized POD.
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Err(anyhow!("tcgetattr failed"));
        }
        let mut raw = original;
        // SAFETY: same.
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(anyhow!("tcsetattr (raw) failed"));
        }
        Ok(Self { fd, original })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        // SAFETY: same lifetime guarantees.
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
        // Make sure the cursor isn't stuck on a half-painted line.
        let _ = std::io::stdout().write_all(b"\r\n");
    }
}

// -----------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
    }
}

fn chrono_now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn format_age(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m{}s", s / 60, s % 60)
    } else if s < 86400 {
        format!("{}h{}m", s / 3600, (s % 3600) / 60)
    } else {
        format!("{}d{}h", s / 86400, (s % 86400) / 3600)
    }
}

