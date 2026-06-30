//! In-process PTY session manager.
//!
//! Each session is a child process (default `$SHELL`) attached to a PTY
//! whose master we own. The manager maintains a `HashMap<id, Session>`
//! and three background tasks per session:
//!
//!   * **reader**: blocking, reads from PTY master → fans out to every
//!     attached client via a `tokio::sync::broadcast` and appends to a
//!     bounded scrollback buffer (so a fresh `attach` can replay the
//!     last N bytes the user already saw).
//!   * **writer**: blocking, drains a `tokio::sync::mpsc` of input
//!     chunks → writes to PTY master. Multiple attached clients use a
//!     `Sender` clone to interleave keystrokes.
//!   * **waiter**: blocking, calls `child.wait()` so we notice when the
//!     shell exits and flip `running` to false. List output then shows
//!     the session as dead until something culls it.
//!
//! Session lifetime: tied to the agent process. systemd restarting the
//! agent kills the children. The full "tmux-style detach across daemon
//! restart" model would need separate session daemons that survive
//! agent restart; that's a follow-up.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use bytes::Bytes;
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

use super::protocol::{LogLine, SessionInfo};

/// Hold the most recent N bytes of output for replay on attach.
const SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
/// Hold the most recent N timestamped log lines for the debugger-view
/// `Tail` replay. Independent of the byte scrollback above: that one
/// feeds xterm/vt100 (raw bytes, partial lines, escape sequences); this
/// one feeds the time-aligned table (clean text, one entry per line).
const LOG_RING_LINES: usize = 5000;
/// A line with no terminating `\n`/`\r` (e.g. a shell prompt) is flushed
/// into the log ring once it's been idle this long, so it still appears
/// in the debugger view instead of waiting forever for a newline.
const LINE_IDLE_FLUSH_MS: u64 = 200;
/// Hard cap on an un-terminated line's length before we flush it anyway,
/// so a newline-less stream (rare) can't grow the pending buffer without
/// bound between idle ticks.
const LINE_MAX_BYTES: usize = 8192;
/// Backpressure on the live broadcast channel before we start dropping.
const OUTPUT_CHAN_CAP: usize = 256;
/// Backpressure on the per-session input channel.
const INPUT_CHAN_CAP: usize = 64;

/// Magic OSC byte sequence the wrapper script emits between shell respawns.
///
/// When the user types `exit` inside an attached session, the wrapper
/// shell prints this and immediately spawns a fresh shell. The PTY
/// reader detects the sequence, strips it from the output stream (so
/// neither the CLI nor xterm.js ever sees the raw escape), and pulses
/// `detach_pulse_tx` to signal every attached client that the user
/// asked to detach. The session itself stays alive — the wrapper keeps
/// the PTY pinned and serves up a fresh shell on next attach.
///
/// OSC 7777 is unallocated in xterm/iTerm2's directory; the long ASCII
/// payload makes accidental collision with real terminal output
/// effectively impossible. BEL (`\x07`) terminates the OSC string — the
/// agent never lets it through, so the choice between BEL and ST is
/// internal-only.
const DETACH_MARKER: &[u8] = b"\x1b]7777;MANAGET_DETACH\x07";
/// `printf`-safe rendering of `DETACH_MARKER` used inside the wrapper
/// `sh -c "…"` snippet. Kept literal (single-quoted in shell) so the
/// payload can't be re-interpreted by the user's `$IFS`/`$PS1`/etc.
const DETACH_MARKER_PRINTF: &str = r"\033]7777;MANAGET_DETACH\007";

/// The not-yet-terminated tail of the output stream, awaiting a newline
/// (or an idle flush). `started_ms` is when its first byte arrived — that
/// becomes the line's timestamp, so a line is dated by when it *began*
/// printing rather than when it happened to end.
#[derive(Default)]
struct LinePending {
    buf: Vec<u8>,
    started_ms: u64,
}

pub struct Session {
    pub id: String,
    /// Display name shown by `managet list` / `managet attach <name>` and
    /// by the dashboard. Wrapped in a Mutex so the dashboard's rename
    /// flow can update it in place without tearing down the PTY.
    pub name: Mutex<String>,
    pub command: String,
    pub created_at_ms: u64,

    /// Bounded ring of recent output bytes for replay on attach.
    scrollback: Mutex<VecDeque<u8>>,

    /// Bounded ring of recent timestamped log lines for the debugger
    /// view's `Tail` replay. Populated alongside `scrollback` from the
    /// PTY reader, but line-split and control-stripped.
    log_ring: Mutex<VecDeque<LogLine>>,

    /// Live log-line broadcast — every `Tail` client subscribes here and
    /// receives each line as it's completed.
    log_tx: broadcast::Sender<LogLine>,

    /// The in-progress output line not yet terminated by `\n`/`\r`. The
    /// PTY reader appends bytes here; a completed line moves to `log_ring`
    /// + `log_tx`. The idle flusher empties it when output goes quiet so a
    /// trailing prompt still shows up in the debugger view.
    log_pending: Mutex<LinePending>,

    /// Live output broadcast — every attached client gets a `subscribe()`
    /// receiver and reads new bytes from there.
    output_tx: broadcast::Sender<Bytes>,

    /// Pulse channel for "user asked to detach (typed `exit`)" events.
    /// The PTY reader sends a single `()` every time it strips the
    /// `DETACH_MARKER` out of the byte stream; every attached client
    /// receives it and closes its connection cleanly. The session
    /// itself stays alive because the wrapper script respawns the
    /// shell — reattaching gives the user a fresh prompt.
    detach_pulse_tx: broadcast::Sender<()>,

    /// Pulse channel for "agent is shutting down" events. Fired by
    /// `SessionManager::broadcast_shutdown()` from the SIGTERM
    /// handler in the reporter. Carries a different visual banner
    /// than the detach pulse so the user understands they were
    /// kicked off because the daemon is going down, not because they
    /// typed `exit`.
    shutdown_pulse_tx: broadcast::Sender<()>,

    /// Drainable input channel. Cloning the sender lets multiple attached
    /// clients fan keystrokes into the same PTY.
    input_tx: mpsc::Sender<Bytes>,

    /// PTY size resize requests.
    resize_tx: mpsc::Sender<(u16, u16)>,

    /// Shared kill handle so external callers can SIGTERM the child
    /// without owning the `Child` directly.
    kill_handle: Mutex<Option<Box<dyn ChildKiller + Send>>>,

    /// Number of currently-streaming attach connections.
    pub attached: AtomicUsize,

    /// `false` once the shell has exited (`waitpid` returned).
    pub running: AtomicBool,

    /// PID of the shell process that backs this session's PTY, captured at
    /// spawn. `None` only if the platform's `Child::process_id()` returned
    /// `None` (rare). The collector walks descendants from this root each
    /// heartbeat to attribute CPU/RSS to the session.
    pub root_pid: Option<u32>,
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            name: self.name.lock().unwrap().clone(),
            command: self.command.clone(),
            created_at_ms: self.created_at_ms,
            attached_clients: self.attached.load(Ordering::SeqCst),
            running: self.running.load(Ordering::SeqCst),
        }
    }

    /// Update the display name. Cheap — just locks and replaces the
    /// stored String. Called by `SessionManager::rename`.
    pub fn set_name(&self, new_name: String) {
        *self.name.lock().unwrap() = new_name;
    }

    pub fn append_scrollback(&self, data: &[u8]) {
        let mut sb = self.scrollback.lock().unwrap();
        // Make room first, then push. This is O(n) when nearly full but
        // rare in practice — most writes are tens of bytes.
        for &b in data {
            if sb.len() >= SCROLLBACK_BYTES {
                sb.pop_front();
            }
            sb.push_back(b);
        }
    }

    pub fn snapshot_scrollback(&self) -> Vec<u8> {
        self.scrollback.lock().unwrap().iter().copied().collect()
    }

    /// Snapshot the whole log ring for replay when a `Tail` client
    /// connects, oldest line first.
    pub fn snapshot_log(&self) -> Vec<LogLine> {
        self.log_ring.lock().unwrap().iter().cloned().collect()
    }

    /// Subscribe to live log lines (used by `Tail` after the ring replay).
    pub fn log_receiver(&self) -> broadcast::Receiver<LogLine> {
        self.log_tx.subscribe()
    }

    /// Feed a chunk of already-DETACH_MARKER-stripped PTY output into the
    /// line log. Splits on `\n`/`\r`, control-strips each completed line,
    /// and pushes it to the ring + broadcast. Treating `\r` as a line
    /// break (as well as `\n`) means a carriage-return redraw — a
    /// progress bar, a `\r`-terminated status line — lands as its own
    /// timestamped row instead of accumulating forever in `pending`.
    /// Lines that strip down to nothing (pure escape sequences) are
    /// dropped so the debugger view has no blank rows.
    pub fn ingest_log_bytes(&self, data: &[u8]) {
        let now = now_ms();
        let mut completed: Vec<LogLine> = Vec::new();
        {
            let mut pending = self.log_pending.lock().unwrap();
            for &b in data {
                if b == b'\n' || b == b'\r' {
                    if !pending.buf.is_empty() {
                        let text = strip_ansi_to_string(&pending.buf);
                        let t = pending.started_ms;
                        pending.buf.clear();
                        if !text.is_empty() {
                            completed.push(LogLine { t, line: text });
                        }
                    }
                } else {
                    if pending.buf.is_empty() {
                        pending.started_ms = now;
                    }
                    pending.buf.push(b);
                }
            }
            if pending.buf.len() > LINE_MAX_BYTES {
                let text = strip_ansi_to_string(&pending.buf);
                let t = pending.started_ms;
                pending.buf.clear();
                if !text.is_empty() {
                    completed.push(LogLine { t, line: text });
                }
            }
        }
        for line in completed {
            self.push_log_line(line);
        }
    }

    /// Flush a pending (newline-less) line into the log once it's been
    /// idle for `idle_ms`. Called on a timer so a trailing prompt that
    /// never gets a newline still reaches the debugger view.
    pub fn flush_pending_log(&self, idle_ms: u64) {
        let now = now_ms();
        let line = {
            let mut pending = self.log_pending.lock().unwrap();
            if pending.buf.is_empty() || now.saturating_sub(pending.started_ms) < idle_ms {
                return;
            }
            let text = strip_ansi_to_string(&pending.buf);
            let t = pending.started_ms;
            pending.buf.clear();
            if text.is_empty() {
                return;
            }
            LogLine { t, line: text }
        };
        self.push_log_line(line);
    }

    fn push_log_line(&self, line: LogLine) {
        {
            let mut ring = self.log_ring.lock().unwrap();
            if ring.len() >= LOG_RING_LINES {
                ring.pop_front();
            }
            ring.push_back(line.clone());
        }
        // Err when no Tail clients are subscribed — harmless, the ring
        // still holds it for the next connection's replay.
        let _ = self.log_tx.send(line);
    }

    pub fn input_sender(&self) -> mpsc::Sender<Bytes> {
        self.input_tx.clone()
    }

    pub fn output_receiver(&self) -> broadcast::Receiver<Bytes> {
        self.output_tx.subscribe()
    }

    /// Subscribe to detach-pulse notifications. A `recv()` resolves
    /// every time the PTY reader observes the `DETACH_MARKER` (i.e.
    /// the wrapper printed it because the inner shell just exited).
    /// Attach handlers use this to disconnect their client without
    /// teardown of the session.
    pub fn detach_pulse_receiver(&self) -> broadcast::Receiver<()> {
        self.detach_pulse_tx.subscribe()
    }

    /// Subscribe to shutdown-pulse notifications. A `recv()` resolves
    /// when the manager broadcasts a daemon shutdown so attach
    /// handlers can write a goodbye banner and close cleanly.
    pub fn shutdown_pulse_receiver(&self) -> broadcast::Receiver<()> {
        self.shutdown_pulse_tx.subscribe()
    }

    pub async fn resize(&self, rows: u16, cols: u16) {
        let _ = self.resize_tx.send((rows, cols)).await;
    }

    /// Tear down the PTY for this session.
    ///
    /// Sequence:
    ///   1. SIGTERM the whole process group rooted at `root_pid` via
    ///      `killpg`. This is the critical bit — `portable-pty`'s
    ///      `ChildKiller::kill()` (held in `kill_handle`) signals only
    ///      the direct child, which is typically `su`. `su` exits
    ///      cleanly on SIGTERM without forwarding to its bash child,
    ///      so the bash gets reparented to init and the agent's
    ///      `wait()` never returns — the session stays "detached"
    ///      forever even though the dashboard thinks it killed it.
    ///      Signalling the whole PG hits every descendant at once.
    ///   2. Tell `portable-pty` to also fire its own kill (it's the
    ///      official handle that releases the underlying Child).
    ///   3. Spawn a background SIGKILL-after-2s escalation in case
    ///      anything in the PG ignores SIGTERM (long-running shells
    ///      with traps, sshd-managed sessions, etc.).
    pub fn request_kill(&self) {
        if let Some(pid) = self.root_pid {
            // killpg expects the *process group* id, not the leader's
            // PID — but for PTY-spawned children the two are equal
            // because the child became a session leader via setsid()
            // when its controlling tty was opened.
            if let Err(e) = killpg(Pid::from_raw(pid as i32), Signal::SIGTERM) {
                // ESRCH (no such process) is the harmless case — the
                // group is already gone. Anything else is worth a log.
                if e != nix::errno::Errno::ESRCH {
                    warn!(
                        "killpg(SIGTERM, pgid={}) failed: {} — relying on \
                         portable-pty fallback",
                        pid, e
                    );
                }
            }
        }
        if let Some(mut k) = self.kill_handle.lock().unwrap().take() {
            let _ = k.kill();
        }
        // Escalation: 2s after the polite SIGTERM, send SIGKILL to the
        // PG. SIGKILL can't be ignored or trapped, so anything still
        // alive in the group goes down. No-op if the PG is empty by
        // then (ESRCH).
        if let Some(pid) = self.root_pid {
            let pgid = Pid::from_raw(pid as i32);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let _ = killpg(pgid, Signal::SIGKILL);
            });
        }
    }
}

/// Where to POST an instant "session created" notification, so the dashboard
/// shows a freshly-spawned session within a beat instead of waiting for its
/// ~60s reconcile sweep. Populated from the agent config when available.
#[derive(Clone)]
struct DashboardNotify {
    /// Normalized base URL (no trailing slash).
    api_url: String,
    /// Per-server agent bearer token.
    token: String,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Shared shutdown broadcaster. Each session gets a clone in its
    /// `shutdown_pulse_tx` field; calling `broadcast_shutdown()` on
    /// the manager pulses every attached handler at once.
    shutdown_pulse_tx: broadcast::Sender<()>,
    /// Optional dashboard push target (set via `set_dashboard`). `None` when
    /// the agent isn't linked to a dashboard — sessions still surface via the
    /// reconciler.
    dashboard: Option<DashboardNotify>,
}

impl SessionManager {
    pub fn new() -> Self {
        let (shutdown_pulse_tx, _) = broadcast::channel::<()>(8);
        Self {
            sessions: Mutex::new(HashMap::new()),
            shutdown_pulse_tx,
            dashboard: None,
        }
    }

    /// Point the manager at a dashboard so `create()` fires an instant
    /// "session created" POST. Call once at startup before wrapping in Arc.
    pub fn set_dashboard(&mut self, api_url: String, token: String) {
        self.dashboard = Some(DashboardNotify { api_url, token });
    }

    /// Pulse the shutdown broadcaster so every attach handler can
    /// flush a "service stopping" banner and close cleanly. Idempotent
    /// and cheap — safe to call from a signal handler context. The
    /// caller is expected to sleep briefly afterwards to give the
    /// pulse time to reach attach tasks before the process exits.
    pub fn broadcast_shutdown(&self) {
        let _ = self.shutdown_pulse_tx.send(());
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let s = self.sessions.lock().unwrap();
        let mut v: Vec<_> = s.values().map(|sess| sess.info()).collect();
        v.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms));
        v
    }

    /// `(session_id, root_pid)` for every session whose shell is still
    /// running and whose PID is known. Used by the collector to attribute
    /// per-session CPU/RAM. Excludes dead sessions so we don't waste the
    /// process-tree walk on sessions that have already exited.
    pub fn live_root_pids(&self) -> Vec<(String, u32)> {
        let s = self.sessions.lock().unwrap();
        s.values()
            .filter(|sess| sess.running.load(Ordering::SeqCst))
            .filter_map(|sess| sess.root_pid.map(|pid| (sess.id.clone(), pid)))
            .collect()
    }

    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Match an id by exact uuid or unambiguous prefix (so callers can
    /// type the first 8 chars of a uuid). Returns Err if zero or more
    /// than one session matches.
    pub fn resolve(&self, id_or_prefix: &str) -> Result<Arc<Session>> {
        let s = self.sessions.lock().unwrap();
        if let Some(exact) = s.get(id_or_prefix) {
            return Ok(exact.clone());
        }
        let mut hits: Vec<_> = s
            .values()
            .filter(|sess| {
                sess.id.starts_with(id_or_prefix)
                    || *sess.name.lock().unwrap() == id_or_prefix
            })
            .cloned()
            .collect();
        match hits.len() {
            0 => anyhow::bail!("no session matches '{id_or_prefix}'"),
            1 => Ok(hits.pop().unwrap()),
            n => anyhow::bail!("'{id_or_prefix}' is ambiguous ({n} matches)"),
        }
    }

    pub fn kill(&self, id_or_prefix: &str) -> Result<()> {
        let session = self.resolve(id_or_prefix)?;
        session.request_kill();
        // The waiter task will flip `running` and we'll cull on next list.
        Ok(())
    }

    /// Rename a session in place. Resolves by id-or-prefix (same rule as
    /// kill/resize) so the dashboard can pass a uuid prefix if it wants.
    /// No-ops if `new_name` equals the current name; never spawns or
    /// kills anything.
    pub fn rename(&self, id_or_prefix: &str, new_name: String) -> Result<()> {
        let session = self.resolve(id_or_prefix)?;
        session.set_name(new_name);
        Ok(())
    }

    pub fn cleanup_dead(&self) {
        let mut s = self.sessions.lock().unwrap();
        s.retain(|_, sess| {
            let running = sess.running.load(Ordering::SeqCst);
            let attached = sess.attached.load(Ordering::SeqCst);
            // Keep alive while either still running OR still being
            // attached to (so the user has a chance to see the final
            // output before we drop it).
            running || attached > 0
        });
    }

    pub fn create(
        &self,
        name: Option<String>,
        command: Option<String>,
        rows: u16,
        cols: u16,
        user: Option<String>,
        cwd: Option<String>,
    ) -> Result<Arc<Session>> {
        let id = uuid::Uuid::new_v4().to_string();
        let name = name.unwrap_or_else(|| format!("session-{}", &id[..8]));

        // Captured before `command`/`cwd` get consumed below, for the
        // best-effort dashboard push at the end.
        let notify_command = command.clone();
        let notify_cwd = cwd.clone();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        // If a target user was requested, validate it exists on the host
        // *before* spawning anything. `nix::unistd::User::from_name`
        // wraps getpwnam(3); `Ok(None)` means "no such user". Returning
        // an error here gives the dashboard a clean failure message
        // instead of silently falling back to a root shell.
        let resolved_user: Option<nix::unistd::User> = match user.as_deref() {
            Some(name) => {
                let entry = nix::unistd::User::from_name(name)
                    .with_context(|| format!("looking up user '{name}'"))?;
                let entry = entry.ok_or_else(|| {
                    anyhow::anyhow!("user '{name}' does not exist on this host")
                })?;
                Some(entry)
            }
            None => None,
        };

        // Build the command. Three cases we need to support cleanly:
        //   - No `command` given → just spawn a login shell. Browser
        //     terminals + `managet new` with no `-c` land here.
        //   - `command` given that is a single binary path / argv-able
        //     string → run it directly. Not what most users type, but
        //     supported.
        //   - `command` given that contains shell syntax (`&&`, `|`, env
        //     references, glob, etc.) → must be run via $SHELL -c '...'
        //     or the kernel exec() will reject it. This is the common
        //     case from `managet new -c "npm run dev"` and from stack
        //     launches that wrap commands like `cd /srv && cargo run`.
        //
        // Heuristic: we *always* wrap user-supplied commands in `$SHELL
        // -c` when present. Even simple commands work fine wrapped, and
        // we get aliases/$PATH/builtins for free. Costs one extra fork
        // per session, which is negligible.
        //
        // User switching: portable-pty's `CommandBuilder` doesn't expose
        // any `pre_exec`/uid hook, so we can't `setuid()` ourselves
        // between fork and exec. Instead we exec `su -l <user> ...`,
        // which (when invoked as root) does the UID/GID drop + login
        // environment setup for us. `-l` makes it a login shell that
        // sources .bash_profile/.profile, sets HOME/USER/LOGNAME/SHELL,
        // and starts in $HOME. This avoids the previous behaviour where
        // every Mac PTY came up as `sh-3.2#` because root had no
        // configured login shell.
        let shell = default_shell();
        let command_label = command.clone().unwrap_or_else(|| shell.clone());
        // `cd_prefix` is the shell snippet we prepend to land in the
        // user's invocation cwd. `2>/dev/null || true` makes it a no-op
        // if the cwd is inaccessible to the target user (or has been
        // deleted between `managet new` and exec) — they keep their
        // default starting directory instead of getting a hard failure.
        //
        // macOS TCC caveat: `chdir` into a privacy-protected folder
        // (~/Desktop, ~/Documents, ~/Downloads, iCloud Drive…) is NOT
        // gated, so the `cd` *succeeds* — but the first `readdir` the
        // interactive shell does there (prompt vcs info, a glob, plain
        // `ls`) then blocks forever on a TCC decision that never arrives
        // for a headless root daemon without Full Disk Access. The result
        // is a dead session: bar shows, no prompt, keystrokes echo but
        // nothing runs. Detect that hang with a short, killable probe and
        // fall back to $HOME plus a one-line notice instead of shipping a
        // wedged shell. `cwd_read_hangs` is a no-op (always false) off
        // macOS, so other platforms keep the exact old behaviour.
        let mut cwd_banner = String::new();
        let cd_prefix = match cwd.as_deref() {
            Some(p) if !p.is_empty() => {
                if cwd_read_hangs(p) {
                    cwd_banner = unreadable_cwd_banner(p);
                    String::new()
                } else {
                    format!("cd {} 2>/dev/null || true; ", shell_single_quote(p))
                }
            }
            _ => String::new(),
        };

        // We build a single sh -c "<session_body>" expression that becomes
        // the long-lived child of the PTY. The body is then wrapped in
        // a respawn loop so the user typing `exit` (or hitting Ctrl-D)
        // doesn't tear down the session — instead the inner shell
        // exits, the wrapper prints DETACH_MARKER (which the agent
        // reader strips + uses to signal attached clients to detach),
        // and the loop spawns a fresh shell ready for the next attach.
        //
        // The wrapper itself only dies if it's signalled externally
        // (e.g. via `managet kill <id>`, agent shutdown, kill -9). In
        // those cases `running` flips false and cleanup_dead() culls
        // the row on the next sweep.
        //
        // We use `exec` for the inner shell where possible so the
        // shell becomes the wrapper's only child — keeps the process
        // tree shallow and gives `request_kill()`'s SIGTERM-the-PG a
        // clean target. The chained-command case can't use exec for
        // the user command (it has to run inside `sh -c '…'`) but does
        // exec the follow-up shell.
        let session_body = match (resolved_user.as_ref(), command.as_deref()) {
            (Some(u), Some(cmd_str)) => {
                // Run the user-supplied command as the target user, then
                // drop into their login shell so the session stays alive
                // after the command exits.
                //
                let user_shell = if u.shell.as_os_str().is_empty() {
                    "/bin/sh".to_string()
                } else {
                    u.shell.to_string_lossy().into_owned()
                };
                let chained = format!(
                    "{cd_prefix}{cmd_str}; exec {user_shell} -l",
                    user_shell = shell_single_quote(&user_shell),
                );
                su_login_command(&u.name, &chained)
            }
            (Some(u), None) => {
                // Interactive shell as the target user. Same `su -l ...`
                // plumbing as above so the cwd takes effect.
                let user_shell = if u.shell.as_os_str().is_empty() {
                    "/bin/sh".to_string()
                } else {
                    u.shell.to_string_lossy().into_owned()
                };
                let chained = if cd_prefix.is_empty() {
                    format!(
                        "exec {user_shell} -l",
                        user_shell = shell_single_quote(&user_shell),
                    )
                } else {
                    format!(
                        "{cd_prefix}exec {user_shell} -l",
                        user_shell = shell_single_quote(&user_shell),
                    )
                };
                su_login_command(&u.name, &chained)
            }
            (None, Some(cmd_str)) => {
                // `<shell> -c "<cmd_str>; exec <shell>"` — run the command,
                // then drop into an interactive shell so the user can keep
                // working after the process exits (or debug a crash).
                let chained = format!("{cd_prefix}{cmd_str}; exec {shell}");
                format!(
                    "{shell} -c {payload}",
                    shell = shell_single_quote(&shell),
                    payload = shell_single_quote(&chained),
                )
            }
            (None, None) => {
                // No user override: spawn the agent's $SHELL as a login
                // shell so .bash_profile etc. get sourced even when the
                // agent itself wasn't started from a login context.
                //
                // Critically: NO outer `exec` here. `exec` would replace
                // the wrapper-sh process with bash, and the while-loop
                // would silently never iterate — typing `exit` would
                // close the session instead of detaching. The bash
                // process forks the normal way and `while` collects its
                // exit cleanly.
                if cd_prefix.is_empty() {
                    format!("{shell} -l", shell = shell_single_quote(&shell))
                } else {
                    let chained = format!("{cd_prefix}exec {shell} -l");
                    format!(
                        "{shell} -c {payload}",
                        shell = shell_single_quote(&shell),
                        payload = shell_single_quote(&chained),
                    )
                }
            }
        };

        // Wrap so the session survives `exit` / Ctrl-D. After each
        // inner shell exits, emit DETACH_MARKER (single-quoted so the
        // outer sh can't expand it) and loop back. `printf` is a
        // POSIX shell builtin in every shell we'd reach for, so this
        // stays free of an extra exec per detach.
        //
        // The body runs inside a `( … )` subshell so any stray `exec`
        // in user-supplied commands or in `su`'s chained string can
        // only replace the subshell, not the wrapper. That keeps the
        // loop intact regardless of what the inner command does.
        //
        // Bounded backoff prevents a runaway respawn if the body
        // immediately fails (e.g. su denied, /tmp full, missing
        // shell). After 200 instant failures we surface a clear
        // message and exit; the session is then cleaned up normally.
        let wrapped = format!(
            "{banner}i=0; while :; do ({body}); printf '{marker}'; \
             i=$((i+1)); \
             if [ $i -gt 200 ]; then \
                 printf '\\n[managet] inner shell respawned 200 times in a row — giving up\\n'; \
                 exit 1; \
             fi; \
             done",
            banner = cwd_banner,
            body = session_body,
            marker = DETACH_MARKER_PRINTF,
        );

        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(wrapped);

        // Working directory + base env. When switching to a target user,
        // `su -l` overwrites HOME/USER/LOGNAME/SHELL itself; but we set
        // them here anyway so they're sane during the brief window before
        // exec(), and so the cwd is the target user's $HOME rather than
        // root's. When there's no user override, fall back to the agent's
        // own $HOME.
        if let Some(u) = resolved_user.as_ref() {
            let home = u.dir.to_string_lossy().into_owned();
            let user_shell = if u.shell.as_os_str().is_empty() {
                "/bin/sh".to_string()
            } else {
                u.shell.to_string_lossy().into_owned()
            };
            cmd.cwd(&home);
            cmd.env("HOME", &home);
            cmd.env("USER", &u.name);
            cmd.env("LOGNAME", &u.name);
            cmd.env("SHELL", &user_shell);
        } else if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }
        // TERM matters — without one, programs like vim/htop misbehave.
        cmd.env(
            "TERM",
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".into()),
        );

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn shell on pty slave")?;

        // Force an initial WINSZ on the master. Without this some shells
        // (notably bash with PROMPT_COMMAND/PS1 that queries the terminal
        // shape) won't print their first prompt until SIGWINCH arrives,
        // which used to require the user to press Enter manually after
        // attach. We set it to the requested size so the first repaint
        // is already at the right shape; subsequent attaches will resize
        // again as their own terminal dimensions arrive.
        let _ = pair.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        // Drop the parent's copy of the slave fd so EOF on the master
        // properly propagates after the child exits.
        drop(pair.slave);

        let kill_handle: Box<dyn ChildKiller + Send> = child.clone_killer();
        // Capture the shell's PID before `child` gets moved into the waiter
        // task below — once moved we lose the handle. The collector uses
        // this as the root of the per-session process tree.
        let root_pid = child.process_id();

        let (output_tx, _) = broadcast::channel::<Bytes>(OUTPUT_CHAN_CAP);
        // Log-line broadcast for the debugger view. Sized like the byte
        // output channel — Tail clients that lag past it just miss live
        // lines (the ring still has them on the next replay).
        let (log_tx, _) = broadcast::channel::<LogLine>(OUTPUT_CHAN_CAP);
        let (input_tx, mut input_rx) = mpsc::channel::<Bytes>(INPUT_CHAN_CAP);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(8);
        // Small capacity is fine — pulses are fired once per event,
        // attach handlers consume them immediately.
        let (detach_pulse_tx, _) = broadcast::channel::<()>(8);
        // Shared shutdown sender from the manager, so a single
        // `broadcast_shutdown()` call reaches every session.
        let shutdown_pulse_tx = self.shutdown_pulse_tx.clone();

        let session = Arc::new(Session {
            id: id.clone(),
            name: Mutex::new(name.clone()),
            command: command_label.clone(),
            created_at_ms: now_ms(),
            scrollback: Mutex::new(VecDeque::new()),
            log_ring: Mutex::new(VecDeque::new()),
            log_tx: log_tx.clone(),
            log_pending: Mutex::new(LinePending::default()),
            output_tx: output_tx.clone(),
            detach_pulse_tx: detach_pulse_tx.clone(),
            shutdown_pulse_tx,
            input_tx,
            resize_tx,
            kill_handle: Mutex::new(Some(kill_handle)),
            attached: AtomicUsize::new(0),
            running: AtomicBool::new(true),
            root_pid,
        });

        // Reader: blocking read on master, fan out to subscribers +
        // scrollback. As bytes flow we also scan for DETACH_MARKER
        // (emitted by the wrapper between shell respawns). Any
        // occurrence is stripped from the stream and triggers a
        // detach pulse; everything before and after is forwarded
        // normally. The marker can straddle two read() calls, so we
        // keep up to MARKER.len()-1 trailing bytes as carry-over and
        // prepend them to the next chunk before scanning.
        let reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader")?;
        {
            let session = session.clone();
            tokio::task::spawn_blocking(move || {
                let mut reader = reader;
                let mut buf = [0u8; 4096];
                let mut carry: Vec<u8> = Vec::with_capacity(DETACH_MARKER.len());
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            // Flush any buffered prefix as-is — at EOF
                            // it can't be a real marker, just trailing
                            // bytes the wrapper hadn't finished
                            // emitting. Forwarding them keeps final
                            // output of the inner command visible.
                            if !carry.is_empty() {
                                let data: Bytes = Bytes::copy_from_slice(&carry);
                                session.append_scrollback(&data);
                                let _ = session.output_tx.send(data);
                            }
                            debug!(id = %session.id, "pty reader EOF");
                            break;
                        }
                        Err(e) => {
                            debug!(id = %session.id, error = %e, "pty reader error");
                            break;
                        }
                        Ok(n) => {
                            // Combine carry + new bytes for matching.
                            let mut combined: Vec<u8> =
                                Vec::with_capacity(carry.len() + n);
                            combined.extend_from_slice(&carry);
                            combined.extend_from_slice(&buf[..n]);
                            carry.clear();

                            // Find all marker occurrences in order.
                            // Forward the pre-marker slice, swallow
                            // the marker, pulse detach, repeat.
                            let mut cursor = 0usize;
                            while let Some(rel) =
                                find_subslice(&combined[cursor..], DETACH_MARKER)
                            {
                                let abs = cursor + rel;
                                if abs > cursor {
                                    emit_bytes(&session, &combined[cursor..abs]);
                                }
                                // Pulse — receivers may not exist (no
                                // current attach), that's fine.
                                let _ = session.detach_pulse_tx.send(());
                                cursor = abs + DETACH_MARKER.len();
                            }

                            // Forward the remainder, holding back ONLY
                            // bytes that could actually be the start of
                            // a marker continuing into the next chunk
                            // (i.e. the longest suffix of `remaining`
                            // that's also a prefix of DETACH_MARKER).
                            //
                            // The earlier "hold the trailing 23 bytes
                            // unconditionally" version caused a nasty
                            // input-lag bug: each character the user
                            // typed echoed back as a single byte, which
                            // landed in `carry` and never reached the
                            // attached client until 24 bytes had
                            // accumulated. The user had to type a full
                            // sentence before *anything* showed up.
                            let remaining = &combined[cursor..];
                            let keep = longest_marker_prefix_at_end(remaining);
                            let emit_end = remaining.len() - keep;
                            emit_bytes(&session, &remaining[..emit_end]);
                            carry.extend_from_slice(&remaining[emit_end..]);
                        }
                    }
                }
            });
        }

        // Writer: own master writer, drain input_rx into PTY.
        let writer = pair.master.take_writer().context("take pty writer")?;
        tokio::task::spawn_blocking(move || {
            let mut writer = writer;
            while let Some(data) = input_rx.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        // Resize: own master to call .resize(). The writer was already
        // taken out of master via take_writer(); resize is a separate
        // operation that goes through ioctl(TIOCSWINSZ) under the hood
        // and works fine on the same MasterPty handle.
        let master_for_resize: Box<dyn MasterPty + Send> = pair.master;
        tokio::task::spawn_blocking(move || {
            let master = master_for_resize;
            while let Some((rows, cols)) = resize_rx.blocking_recv() {
                let _ = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        });

        // Waiter: notice when the shell exits.
        {
            let session = session.clone();
            tokio::task::spawn_blocking(move || {
                let mut child = child;
                let exit = child.wait();
                debug!(id = %session.id, ?exit, "child exited");
                session.running.store(false, Ordering::SeqCst);
            });
        }

        // Idle flusher: a newline-less trailing line (a shell prompt, a
        // `read -p` question) would otherwise sit in `log_pending` forever
        // and never reach the debugger view. Tick a few times a second and
        // flush it once it's gone quiet. Exits once the shell is dead and
        // nothing's left pending, so it doesn't outlive the session.
        {
            let session = session.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(
                    std::time::Duration::from_millis(LINE_IDLE_FLUSH_MS),
                );
                loop {
                    tick.tick().await;
                    session.flush_pending_log(LINE_IDLE_FLUSH_MS);
                    if !session.running.load(Ordering::SeqCst)
                        && session.log_pending.lock().unwrap().buf.is_empty()
                    {
                        break;
                    }
                }
            });
        }

        info!(id = %id, name = %name, command = %command_label, "session created");

        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());

        // Best-effort instant push so the dashboard shows the session right
        // away instead of waiting for its ~60s reconcile. Fire-and-forget;
        // any failure is harmless (the reconciler still backstops).
        if let Some(d) = &self.dashboard {
            let url = format!("{}/api/agent/session-created", d.api_url);
            let token = d.token.clone();
            let sid = id.clone();
            let sname = name.clone();
            tokio::spawn(async move {
                let body = serde_json::json!({
                    "sessionId": sid,
                    "name": sname,
                    "command": notify_command,
                    "cwd": notify_cwd,
                    "status": "active",
                });
                let client = reqwest::Client::new();
                let _ = client
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await;
            });
        }

        Ok(session)
    }
}

/// Push `data` to scrollback + broadcast (the original reader's
/// inner loop, factored out for reuse by the marker-stripping path).
fn emit_bytes(session: &Arc<Session>, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let bytes: Bytes = Bytes::copy_from_slice(data);
    session.append_scrollback(&bytes);
    // Same bytes feed the debugger-view line log (split + timestamped +
    // control-stripped there). Done before the broadcast so a line's
    // timestamp reflects when it was read, not when a slow subscriber
    // drained it.
    session.ingest_log_bytes(data);
    // Broadcast send returns Err when no receivers are subscribed
    // (e.g. detached session). That's fine — scrollback still has it.
    let _ = session.output_tx.send(bytes);
}

/// Return `k` = the length of the longest suffix of `data` that is
/// also a prefix of `DETACH_MARKER`. The PTY reader uses this to
/// decide which trailing bytes MUST be held back across a read
/// boundary because they could be the start of a marker.
///
/// For the common case (no ESC byte anywhere in the tail) this
/// returns 0 immediately and the reader can flush the full chunk —
/// which is what fixes the "I have to type a sentence before
/// anything appears" bug the unconditional-hold version caused.
///
/// Worst case is O(MARKER.len()) per call. With marker length 24
/// and a 4 KiB chunk, that's still cheaper than the I/O itself.
fn longest_marker_prefix_at_end(data: &[u8]) -> usize {
    let max_check = data.len().min(DETACH_MARKER.len() - 1);
    // Walk from longest possible match downwards so we stop at the
    // first (= longest) hit.
    for k in (1..=max_check).rev() {
        if data[data.len() - k..] == DETACH_MARKER[..k] {
            return k;
        }
    }
    0
}

/// Locate the first occurrence of `needle` inside `haystack` and
/// return its starting offset, or `None` if not found.
///
/// Naive O(n·m) scan; both inputs are short (chunks ≤ 4096+marker, marker
/// = 24 bytes) so the constant factor doesn't justify a smarter
/// algorithm.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let last = haystack.len() - needle.len();
    for i in 0..=last {
        if haystack[i..i + needle.len()] == *needle {
            return Some(i);
        }
    }
    None
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Strip terminal control sequences from one raw PTY line, returning
/// readable text for the debugger log. We deliberately discard colour and
/// cursor movement rather than translate it: the debugger view is a
/// time-aligned table, so a clean plain-text line is what aligns. Handles:
///   * CSI    — `ESC [` … final byte in `0x40..=0x7E` (colours, cursor,
///              erase),
///   * OSC    — `ESC ]` … terminated by BEL (`0x07`) or ST (`ESC \`)
///              (window titles, hyperlinks),
///   * other  — a two-byte `ESC <x>` escape (charset selects, etc.),
///   * stray control bytes (`< 0x20`, `0x7F`), keeping only `\t`.
/// Invalid UTF-8 is replaced lossily so a mid-character byte split across
/// PTY reads can't panic.
fn strip_ansi_to_string(data: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == 0x1b {
            match data.get(i + 1) {
                Some(b'[') => {
                    // CSI: consume params/intermediates up to the final byte.
                    i += 2;
                    while i < data.len() && !(0x40..=0x7e).contains(&data[i]) {
                        i += 1;
                    }
                    if i < data.len() {
                        i += 1; // the final byte itself
                    }
                }
                Some(b']') => {
                    // OSC: run until BEL or ST (`ESC \`).
                    i += 2;
                    while i < data.len() {
                        if data[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if data[i] == 0x1b && data.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                Some(_) => i += 2, // ESC + one byte (e.g. charset select)
                None => i += 1,    // lone trailing ESC
            }
        } else if b == b'\t' {
            out.push(b'\t');
            i += 1;
        } else if b < 0x20 || b == 0x7f {
            i += 1; // drop other control bytes
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

/// macOS only: does *reading* `dir` block past a short deadline?
///
/// That hang is the signature of a TCC-protected location (~/Desktop,
/// ~/Documents, ~/Downloads, iCloud Drive…) when the agent lacks Full Disk
/// Access — `chdir` succeeds but `readdir` wedges forever waiting on a
/// privacy decision no one can answer in a headless daemon. We probe with a
/// throwaway `/bin/ls` we can *kill*, so a directory that would hang the
/// session shell is detected without hanging the agent. A fast exit (dir
/// readable, missing, or plainly permission-denied) returns false — those
/// cases are already handled cleanly by `cd … 2>/dev/null || true`. We probe
/// as the agent's own uid; TCC keys on the responsible process (the daemon),
/// not the uid, so the result matches what the su'd session shell would hit.
#[cfg(target_os = "macos")]
fn cwd_read_hangs(dir: &str) -> bool {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = match Command::new("/bin/ls")
        .args(["-1A", "--", dir])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        // Couldn't even spawn the probe — don't withhold the cd on a guess.
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_millis(1200);
    loop {
        match child.try_wait() {
            // Exited before the deadline → not a TCC hang.
            Ok(Some(_)) => return false,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return false,
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn cwd_read_hangs(_dir: &str) -> bool {
    false
}

/// `printf` snippet shown once at session start when the requested cwd could
/// not be read and we fell back to $HOME. The directory is passed as a `%s`
/// *argument* (single-quoted), never spliced into the format string, so a
/// path containing `%` or `\` can't reinterpret the format. Plain ASCII only
/// so every shell's `printf` renders it identically.
fn unreadable_cwd_banner(dir: &str) -> String {
    let fmt = "\\r\\n\\033[1;33m[managet] could not read %s - starting in your \
               home directory.\\033[0m\\r\\n\\033[1;33m[managet] macOS: grant \
               Full Disk Access to /usr/local/bin/managet-agent, then run: \
               managet restart\\033[0m\\r\\n\\r\\n";
    format!("printf '{fmt}' {dir}; ", fmt = fmt, dir = shell_single_quote(dir))
}

fn su_login_command(user: &str, payload: &str) -> String {
    build_su_login_command(user, payload, cfg!(target_os = "linux"))
}

fn build_su_login_command(user: &str, payload: &str, use_session_command: bool) -> String {
    let user = shell_single_quote(user);
    let payload = shell_single_quote(payload);
    if use_session_command {
        // util-linux `su -c` calls setsid(), which can leave the inner shell
        // without job control on a PTY. `--session-command` keeps the current
        // session, but it is a GNU extension and must not be sent to BSD su.
        format!("su -l {user} --session-command {payload}")
    } else {
        // BSD/macOS `su` accepts arguments after the login name as arguments
        // for the user's shell. Passing GNU's long option there makes zsh try
        // to parse `--session-command` and fail with "no such option".
        format!("su -l {user} -c {payload}")
    }
}

/// Single-quote a value for safe interpolation into a `sh -c` snippet.
/// Wraps in `'…'`; any embedded single quotes are escaped via `'\''`.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str(r"'\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::{build_su_login_command, unreadable_cwd_banner};
    #[cfg(not(target_os = "macos"))]
    use super::cwd_read_hangs;

    #[test]
    fn builds_linux_su_command_with_session_command() {
        assert_eq!(
            build_su_login_command("andrei", "exec /bin/zsh -l", true),
            "su -l 'andrei' --session-command 'exec /bin/zsh -l'"
        );
    }

    #[test]
    fn builds_bsd_su_command_with_shell_c_argument() {
        assert_eq!(
            build_su_login_command("andrei", "exec /bin/zsh -l", false),
            "su -l 'andrei' -c 'exec /bin/zsh -l'"
        );
    }

    #[test]
    fn quotes_su_user_and_payload() {
        assert_eq!(
            build_su_login_command("o'brien", "echo 'hi'", false),
            "su -l 'o'\\''brien' -c 'echo '\\''hi'\\'''"
        );
    }

    #[test]
    fn cwd_banner_passes_dir_as_quoted_printf_arg() {
        let b = unreadable_cwd_banner("/Users/andrei/Desktop/biletly");
        // printf format up front, directory as a *single-quoted argument*
        // (never interpolated into the format string), trailing `; `.
        assert!(b.starts_with("printf '"));
        assert!(b.contains("'/Users/andrei/Desktop/biletly'"));
        assert!(b.contains("Full Disk Access"));
        assert!(b.contains("%s"));
        assert!(b.ends_with("; "));
    }

    #[test]
    fn cwd_banner_escapes_single_quotes_in_dir() {
        // A path with an apostrophe must stay safely quoted so it can't
        // break out of the printf argument.
        let b = unreadable_cwd_banner("/Users/o'brien/Desktop");
        assert!(b.contains(r"'/Users/o'\''brien/Desktop'"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn cwd_read_hangs_is_a_noop_off_macos() {
        // Off macOS there is no TCC, so we never withhold the cd — even for
        // a path that does not exist.
        assert!(!cwd_read_hangs("/no/such/dir/anywhere"));
    }
}
