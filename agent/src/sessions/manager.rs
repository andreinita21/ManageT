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

use super::protocol::SessionInfo;

/// Hold the most recent N bytes of output for replay on attach.
const SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
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

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Shared shutdown broadcaster. Each session gets a clone in its
    /// `shutdown_pulse_tx` field; calling `broadcast_shutdown()` on
    /// the manager pulses every attached handler at once.
    shutdown_pulse_tx: broadcast::Sender<()>,
}

impl SessionManager {
    pub fn new() -> Self {
        let (shutdown_pulse_tx, _) = broadcast::channel::<()>(8);
        Self {
            sessions: Mutex::new(HashMap::new()),
            shutdown_pulse_tx,
        }
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
        // between fork and exec. Instead we exec `su -l <user> [-c ...]`,
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
        let cd_prefix = match cwd.as_deref() {
            Some(p) if !p.is_empty() => {
                format!("cd {} 2>/dev/null || true; ", shell_single_quote(p))
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
                // `--session-command` (util-linux) keeps the existing
                // session — same as `-c` but does NOT call setsid().
                // Without this the inner bash loses its controlling
                // terminal across the su call ("cannot set terminal
                // process group: Inappropriate ioctl for device" /
                // "no job control in this shell"). Job control is
                // essential — without it Ctrl+C, suspend, fg/bg, etc.
                // all break.
                let user_shell = if u.shell.as_os_str().is_empty() {
                    "/bin/sh".to_string()
                } else {
                    u.shell.to_string_lossy().into_owned()
                };
                let chained = format!("{cd_prefix}{cmd_str}; exec {user_shell} -l");
                format!(
                    "su -l {user} --session-command {payload}",
                    user = shell_single_quote(&u.name),
                    payload = shell_single_quote(&chained),
                )
            }
            (Some(u), None) => {
                // Interactive shell as the target user. Same `su -l …
                // --session-command` plumbing as above so the cwd takes
                // effect and the controlling terminal is preserved.
                let user_shell = if u.shell.as_os_str().is_empty() {
                    "/bin/sh".to_string()
                } else {
                    u.shell.to_string_lossy().into_owned()
                };
                let chained = if cd_prefix.is_empty() {
                    format!("exec {user_shell} -l")
                } else {
                    format!("{cd_prefix}exec {user_shell} -l")
                };
                format!(
                    "su -l {user} --session-command {payload}",
                    user = shell_single_quote(&u.name),
                    payload = shell_single_quote(&chained),
                )
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
            "i=0; while :; do ({body}); printf '{marker}'; \
             i=$((i+1)); \
             if [ $i -gt 200 ]; then \
                 printf '\\n[managet] inner shell respawned 200 times in a row — giving up\\n'; \
                 exit 1; \
             fi; \
             done",
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

                            // Forward the remainder, except for a tail
                            // that *could* be the start of a marker
                            // spilling into the next chunk. The tail
                            // can be at most MARKER.len()-1 bytes long.
                            let remaining = &combined[cursor..];
                            let keep_tail = DETACH_MARKER.len().saturating_sub(1);
                            if remaining.len() > keep_tail {
                                let emit_end = remaining.len() - keep_tail;
                                emit_bytes(&session, &remaining[..emit_end]);
                                carry.extend_from_slice(&remaining[emit_end..]);
                            } else {
                                carry.extend_from_slice(remaining);
                            }
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

        info!(id = %id, name = %name, command = %command_label, "session created");

        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
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
    // Broadcast send returns Err when no receivers are subscribed
    // (e.g. detached session). That's fine — scrollback still has it.
    let _ = session.output_tx.send(bytes);
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

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
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
