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
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
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

        let mut cmd = match (resolved_user.as_ref(), command.as_deref()) {
            (Some(u), Some(cmd_str)) => {
                // Run the user-supplied command as the target user, then
                // drop into their login shell so the session stays alive
                // after the command exits.
                let user_shell = if u.shell.as_os_str().is_empty() {
                    "/bin/sh".to_string()
                } else {
                    u.shell.to_string_lossy().into_owned()
                };
                let chained = format!("{cd_prefix}{cmd_str}; exec {user_shell} -l");
                let mut c = CommandBuilder::new("su");
                c.arg("-l");
                c.arg(&u.name);
                c.arg("-c");
                c.arg(chained);
                c
            }
            (Some(u), None) => {
                // Interactive shell as the target user. We still go through
                // `su -l … -c "cd …; exec <shell> -l"` rather than plain
                // `su -l` so the cwd takes effect. Costs one extra exec
                // (negligible) and lets every code path share the same
                // cd-then-shell template.
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
                let mut c = CommandBuilder::new("su");
                c.arg("-l");
                c.arg(&u.name);
                c.arg("-c");
                c.arg(chained);
                c
            }
            (None, Some(cmd_str)) => {
                // `<shell> -c "<cmd_str>; exec <shell>"` — run the command,
                // then drop into an interactive shell so the user can keep
                // working after the process exits (or debug a crash). For
                // stack services where the user wants the session to follow
                // the process, they can use `managet kill <name>` to end it.
                let chained = format!("{cd_prefix}{cmd_str}; exec {shell}");
                let mut c = CommandBuilder::new(&shell);
                c.arg("-c");
                c.arg(chained);
                c
            }
            (None, None) => {
                // No user override: spawn the agent's $SHELL as a login
                // shell so .bash_profile etc. get sourced even when the
                // agent itself wasn't started from a login context.
                if cd_prefix.is_empty() {
                    let mut c = CommandBuilder::new(&shell);
                    c.arg("-l");
                    c
                } else {
                    // Same-flavour cd-then-shell when a cwd was supplied.
                    let mut c = CommandBuilder::new(&shell);
                    c.arg("-c");
                    c.arg(format!("{cd_prefix}exec {shell} -l"));
                    c
                }
            }
        };

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

        let session = Arc::new(Session {
            id: id.clone(),
            name: Mutex::new(name.clone()),
            command: command_label.clone(),
            created_at_ms: now_ms(),
            scrollback: Mutex::new(VecDeque::new()),
            output_tx: output_tx.clone(),
            input_tx,
            resize_tx,
            kill_handle: Mutex::new(Some(kill_handle)),
            attached: AtomicUsize::new(0),
            running: AtomicBool::new(true),
            root_pid,
        });

        // Reader: blocking read on master, fan out to subscribers + scrollback.
        let reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader")?;
        {
            let session = session.clone();
            tokio::task::spawn_blocking(move || {
                let mut reader = reader;
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            debug!(id = %session.id, "pty reader EOF");
                            break;
                        }
                        Err(e) => {
                            // EIO when slave is closed is normal at shutdown.
                            debug!(id = %session.id, error = %e, "pty reader error");
                            break;
                        }
                        Ok(n) => {
                            let data: Bytes = Bytes::copy_from_slice(&buf[..n]);
                            session.append_scrollback(&data);
                            // Best-effort broadcast — if no one is listening
                            // (no attach yet), the send returns Err which we
                            // ignore. The scrollback still captures it.
                            let _ = session.output_tx.send(data);
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
