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
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info};

use super::protocol::SessionInfo;

/// Hold the most recent N bytes of output for replay on attach.
const SCROLLBACK_BYTES: usize = 64 * 1024;
/// Backpressure on the live broadcast channel before we start dropping.
const OUTPUT_CHAN_CAP: usize = 256;
/// Backpressure on the per-session input channel.
const INPUT_CHAN_CAP: usize = 64;

pub struct Session {
    pub id: String,
    pub name: String,
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
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            command: self.command.clone(),
            created_at_ms: self.created_at_ms,
            attached_clients: self.attached.load(Ordering::SeqCst),
            running: self.running.load(Ordering::SeqCst),
        }
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

    pub fn request_kill(&self) {
        if let Some(mut k) = self.kill_handle.lock().unwrap().take() {
            let _ = k.kill();
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
            .filter(|sess| sess.id.starts_with(id_or_prefix) || sess.name == id_or_prefix)
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
        let shell = default_shell();
        let command_label = command.clone().unwrap_or_else(|| shell.clone());
        let mut cmd = if let Some(cmd_str) = command {
            // `<shell> -c "<cmd_str>; exec <shell>"` — run the command,
            // then drop into an interactive shell so the user can keep
            // working after the process exits (or debug a crash). For
            // stack services where the user wants the session to follow
            // the process, they can use `managet kill <name>` to end it.
            let chained = format!("{}; exec {}", cmd_str, shell);
            let mut c = CommandBuilder::new(&shell);
            c.arg("-c");
            c.arg(chained);
            c
        } else {
            CommandBuilder::new(&shell)
        };
        if let Ok(home) = std::env::var("HOME") {
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
        // Drop the parent's copy of the slave fd so EOF on the master
        // properly propagates after the child exits.
        drop(pair.slave);

        let kill_handle: Box<dyn ChildKiller + Send> = child.clone_killer();

        let (output_tx, _) = broadcast::channel::<Bytes>(OUTPUT_CHAN_CAP);
        let (input_tx, mut input_rx) = mpsc::channel::<Bytes>(INPUT_CHAN_CAP);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(8);

        let session = Arc::new(Session {
            id: id.clone(),
            name: name.clone(),
            command: command_label.clone(),
            created_at_ms: now_ms(),
            scrollback: Mutex::new(VecDeque::new()),
            output_tx: output_tx.clone(),
            input_tx,
            resize_tx,
            kill_handle: Mutex::new(Some(kill_handle)),
            attached: AtomicUsize::new(0),
            running: AtomicBool::new(true),
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
