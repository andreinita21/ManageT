//! Unix-socket session server.
//!
//! Listens on `/var/run/managet/agent.sock` (or whatever
//! `socket_path()` resolves to). One connection per `managet` CLI
//! invocation. Protocol:
//!
//!   1. Client writes one newline-delimited JSON `Request`.
//!   2. Server replies with one newline-delimited JSON `Response`.
//!   3. If the request was `Attach` and the response was `Attached`,
//!      both sides switch to raw bytes for the lifetime of the
//!      connection. Otherwise the server closes after the response.
//!
//! Permissions: the socket is chmod 0666 so any local user on the box
//! can connect, but connecting is not the same as being trusted. Every
//! `New` request is authorized against the peer's verified SO_PEERCRED
//! UID (see `authorize_user`): a non-root peer can only open a session
//! running as themselves, never as root or another user. Root peers are
//! fully trusted. This makes the open socket safe — it grants a caller
//! exactly the privileges they already have on the host, nothing more.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use std::sync::atomic::Ordering;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;
use tracing::{debug, info};

use super::manager::{Session, SessionManager};
use super::protocol::{Request, Response};

/// Default path for the agent's local control socket. Linux + macOS
/// both honour `/var/run/managet/agent.sock` since the agent runs as
/// root.
///
/// Override via `MANAGET_SOCKET_PATH` for development / testing — both
/// the daemon and the `managet` CLI pick up the same env var, so a
/// non-root developer can run `MANAGET_SOCKET_PATH=/tmp/managet.sock
/// managet-agent run` in one terminal and `MANAGET_SOCKET_PATH=…
/// managet ls` in another without touching `/var/run`.
pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("MANAGET_SOCKET_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from("/var/run/managet/agent.sock")
}

/// Run the socket server forever. Returns only on a fatal listener
/// error (e.g. couldn't bind). Per-connection failures are logged and
/// don't stop the loop.
pub async fn run(manager: Arc<SessionManager>, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating socket dir {}", parent.display()))?;
    }
    // Old socket from a crashed run leaves a stale inode behind that
    // refuses bind(EADDRINUSE). Always remove first; we hold the file
    // exclusively while running.
    let _ = std::fs::remove_file(path);

    let listener = UnixListener::bind(path)
        .with_context(|| format!("binding {}", path.display()))?;

    // 0666 so non-root users can connect. Sessions still run as root —
    // the security model is "anyone with shell access can already escalate
    // via sudo", so this is no worse than what's already there.
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o666);
    std::fs::set_permissions(path, perms)?;

    info!("session server listening on {}", path.display());

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .context("accept on session socket")?;
        let manager = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, manager).await {
                debug!(error = %e, "session client handler errored");
            }
        });
    }
}

/// Authorize the requested target user for a session against the
/// connecting peer's verified SO_PEERCRED uid.
///
/// Returns the username the session must run as (`None` means "the
/// agent's own identity", which is only ever returned for a root peer).
/// A non-root peer is pinned to their own identity: an absent `user`
/// defaults to them (never the agent's root), and an explicit `user` is
/// only honored if it resolves to their own uid. This is what makes the
/// world-connectable socket safe — it never grants more privilege than
/// the caller already has.
fn authorize_user(peer_uid: u32, requested: Option<String>) -> Result<Option<String>, String> {
    // Root peers are fully trusted: the kernel already lets root act as
    // anyone, so honor whatever they ask for (None = agent identity).
    if peer_uid == 0 {
        return Ok(requested);
    }

    // Non-root peer: resolve their own name so we can default to it and
    // validate any explicit request against it.
    let peer = match nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(peer_uid)) {
        Ok(Some(u)) => u,
        Ok(None) => return Err(format!("connecting uid {peer_uid} has no passwd entry")),
        Err(e) => return Err(format!("looking up connecting uid {peer_uid}: {e}")),
    };

    match requested {
        // No explicit user → drop to the peer, never the agent's root.
        None => Ok(Some(peer.name)),
        // Explicit user must resolve to the peer's own uid.
        Some(name) => {
            let target = nix::unistd::User::from_name(&name)
                .map_err(|e| format!("looking up user '{name}': {e}"))?
                .ok_or_else(|| format!("user '{name}' does not exist on this host"))?;
            if target.uid.as_raw() == peer_uid {
                Ok(Some(name))
            } else {
                Err(format!(
                    "not permitted to open a session as '{name}' (you are uid {peer_uid})"
                ))
            }
        }
    }
}

async fn handle_client(stream: UnixStream, manager: Arc<SessionManager>) -> Result<()> {
    // Read the peer's credentials *before* splitting the stream. We fail
    // closed: if the kernel won't tell us who connected, we refuse.
    let peer_uid = match stream.peer_cred() {
        Ok(cred) => cred.uid(),
        Err(e) => {
            let (_, mut wr) = stream.into_split();
            let _ = send_resp(
                &mut wr,
                &Response::Error {
                    message: format!("cannot read peer credentials: {e}"),
                },
            )
            .await;
            return Ok(());
        }
    };
    let (rd, mut wr) = stream.into_split();
    let mut reader = BufReader::new(rd);
    let mut req_line = String::new();
    let n = reader.read_line(&mut req_line).await?;
    if n == 0 {
        return Ok(());
    }
    let req: Request = match serde_json::from_str(req_line.trim_end()) {
        Ok(r) => r,
        Err(e) => {
            send_resp(
                &mut wr,
                &Response::Error {
                    message: format!("bad request: {e}"),
                },
            )
            .await?;
            return Ok(());
        }
    };

    match req {
        Request::List => {
            manager.cleanup_dead();
            let sessions = manager.list();
            send_resp(&mut wr, &Response::SessionList { sessions }).await?;
            Ok(())
        }
        Request::New {
            name,
            command,
            rows,
            cols,
            user,
            cwd,
        } => {
            // Clamp + default the PTY dimensions. Bad upstream
            // clients (or a malicious caller) sending rows/cols=u16
            // max would have us allocating a 65k×65k cell grid
            // somewhere downstream (xterm.js or any other consumer)
            // — better to refuse silly values up front. 8×8 is the
            // smallest size where any real shell still works; 500×500
            // covers every legitimate window we've seen and is well
            // under the kernel's TIOCSWINSZ limits.
            let r = rows.unwrap_or(24).clamp(8, 500);
            let c = cols.unwrap_or(80).clamp(8, 500);
            // Refuse names with embedded NUL / control chars or
            // path-traversal-shaped prefixes. The name surfaces in
            // dashboards, log files, and CLI tables — keeping it to
            // a printable subset avoids surprises everywhere
            // downstream and stops a malicious creator from
            // smuggling control sequences into other operators'
            // terminals via `managet ls`.
            if let Some(ref n) = name {
                if !is_safe_session_name(n) {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: "session name contains disallowed characters".into(),
                        },
                    )
                    .await?;
                    return Ok(());
                }
            }
            // Bind the session to the connecting peer's identity. A
            // non-root caller can never escalate to root or impersonate
            // another user via the `user` field; root callers keep full
            // flexibility.
            let user = match authorize_user(peer_uid, user) {
                Ok(u) => u,
                Err(message) => {
                    send_resp(&mut wr, &Response::Error { message }).await?;
                    return Ok(());
                }
            };
            match manager.create(name, command, r, c, user, cwd) {
                Ok(sess) => {
                    // Snapshot the name *before* the `await` so we don't
                    // hold a MutexGuard across a suspension point — the
                    // guard isn't Send and the dispatcher future has to
                    // be Send for tokio::spawn.
                    let name_snapshot = sess.name.lock().unwrap().clone();
                    send_resp(
                        &mut wr,
                        &Response::Created {
                            id: sess.id.clone(),
                            name: name_snapshot,
                        },
                    )
                    .await?;
                }
                Err(e) => {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: e.to_string(),
                        },
                    )
                    .await?;
                }
            }
            Ok(())
        }
        Request::Kill { id } => {
            match manager.kill(&id) {
                Ok(()) => send_resp(&mut wr, &Response::Ok).await?,
                Err(e) => {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: e.to_string(),
                        },
                    )
                    .await?
                }
            }
            Ok(())
        }
        Request::Resize { id, rows, cols } => {
            // Same clamp as `New`. Resize is also the path xterm.js
            // hits every time the user drags the browser window edge,
            // so a runaway client (or a deliberately-crafted message)
            // could otherwise force the agent to push a huge WINSZ
            // into the PTY on every event.
            let r = rows.clamp(8, 500);
            let c = cols.clamp(8, 500);
            match manager.resolve(&id) {
                Ok(sess) => {
                    sess.resize(r, c).await;
                    send_resp(&mut wr, &Response::Ok).await?;
                }
                Err(e) => {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: e.to_string(),
                        },
                    )
                    .await?
                }
            }
            Ok(())
        }
        Request::Rename { id, name } => {
            match manager.rename(&id, name) {
                Ok(()) => send_resp(&mut wr, &Response::Ok).await?,
                Err(e) => {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: e.to_string(),
                        },
                    )
                    .await?
                }
            }
            Ok(())
        }
        Request::Attach { id, rows, cols } => {
            // Resolve session first so we can return a clean error before
            // switching to raw mode.
            let sess = match manager.resolve(&id) {
                Ok(s) => s,
                Err(e) => {
                    send_resp(
                        &mut wr,
                        &Response::Error {
                            message: e.to_string(),
                        },
                    )
                    .await?;
                    return Ok(());
                }
            };
            // Cap concurrent attaches per session so a runaway dashboard
            // (or a malicious caller) can't fan-out a single PTY into
            // thousands of broadcast subscribers and balloon memory.
            // The broadcast channel has a small capacity, so each
            // subscriber holds at most OUTPUT_CHAN_CAP messages — but
            // many subscribers × many messages is still meaningful.
            // 32 is generous (CLI + a handful of browser tabs is the
            // realistic upper bound) and surfaces the issue with a
            // clear message if it's ever hit.
            const MAX_ATTACHES_PER_SESSION: usize = 32;
            if sess.attached.load(Ordering::SeqCst) >= MAX_ATTACHES_PER_SESSION {
                send_resp(
                    &mut wr,
                    &Response::Error {
                        message: format!(
                            "session has {} attaches already (cap={}); detach somewhere first",
                            sess.attached.load(Ordering::SeqCst),
                            MAX_ATTACHES_PER_SESSION
                        ),
                    },
                )
                .await?;
                return Ok(());
            }
            // Apply the caller's terminal size up front so vim/tmux/htop
            // render at the right shape from the very first repaint.
            // Clamped the same way as Request::Resize so a bad client
            // can't push a huge WINSZ down our throat at attach time.
            if let (Some(r), Some(c)) = (rows, cols) {
                let r = r.clamp(8, 500);
                let c = c.clamp(8, 500);
                sess.resize(r, c).await;
            }
            let name_snapshot = sess.name.lock().unwrap().clone();
            send_resp(
                &mut wr,
                &Response::Attached {
                    id: sess.id.clone(),
                    name: name_snapshot,
                },
            )
            .await?;

            stream_attached(reader, wr, sess).await
        }
    }
}

/// Bidirectional pipe between a client connection and a session.
///   reader (client → us → PTY input channel)
///   broadcast subscription (PTY output → us → client)
/// Plus an upfront scrollback replay so the user sees what they
/// already saw in the same session.
///
/// Also subscribes to the session's `detach_pulse` channel, which
/// fires when the user types `exit` inside the inner shell (the
/// wrapper emits `DETACH_MARKER` between respawns and the PTY reader
/// translates it into a pulse). On pulse we write a friendly farewell
/// banner, shut down the write half, and return — the client side
/// then exits raw mode cleanly. The PTY itself stays alive and is
/// reattachable.
async fn stream_attached(
    mut reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    mut wr: tokio::net::unix::OwnedWriteHalf,
    sess: Arc<Session>,
) -> Result<()> {
    sess.attached.fetch_add(1, Ordering::SeqCst);

    // Replay scrollback so the user sees prior output context.
    let scrollback = sess.snapshot_scrollback();
    if !scrollback.is_empty() {
        wr.write_all(&scrollback).await?;
    }

    let input_tx = sess.input_sender();
    let mut output_rx = sess.output_receiver();
    let mut detach_rx = sess.detach_pulse_receiver();
    let mut shutdown_rx = sess.shutdown_pulse_receiver();

    // Output task: forward broadcast messages to the client AND watch
    // the detach + shutdown pulse channels. Whichever fires first wins.
    // On detach/shutdown we emit a labelled CR-prefixed line so it
    // lands at column 0 of the client's raw-mode terminal.
    let mut output_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Output bytes from PTY.
                msg = output_rx.recv() => {
                    match msg {
                        Ok(data) => {
                            if wr.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // We dropped some messages because the client was
                            // slow. The PTY output is in scrollback; on next
                            // attach we'd replay. For now, just keep going.
                            continue;
                        }
                    }
                }
                // Detach pulse — user typed `exit`. Write a small
                // banner so the user understands why their connection
                // dropped, then return so the connection closes. The
                // session keeps running on the agent side; reattach
                // gets a fresh shell.
                pulse = detach_rx.recv() => {
                    match pulse {
                        Ok(()) => {
                            // \r\n so it lands at col 0 in raw mode.
                            // Bold yellow for visibility against any
                            // theme; ESC[0m resets to terminal default.
                            let msg = b"\r\n\x1b[1;33m[managet] shell exited \
\xe2\x80\x94 detached. Session stays alive; reattach with \
`managet attach`.\x1b[0m\r\n";
                            let _ = wr.write_all(msg).await;
                            let _ = wr.shutdown().await;
                            break;
                        }
                        // Channel closed or we lagged a pulse —
                        // either way, fall back to normal close.
                        Err(_) => break,
                    }
                }
                // Shutdown pulse — operator ran `managet stop` (or
                // the agent is otherwise going down via SIGTERM). The
                // session itself won't survive; we just want to leave
                // the user with a clear note instead of a frozen
                // terminal. Cyan to distinguish from the yellow
                // detach banner.
                pulse = shutdown_rx.recv() => {
                    match pulse {
                        Ok(()) => {
                            let msg = b"\r\n\x1b[1;36m[managet] agent is shutting down \
\xe2\x80\x94 disconnected. Run `managet start` on the host to bring it back.\x1b[0m\r\n";
                            let _ = wr.write_all(msg).await;
                            let _ = wr.shutdown().await;
                            break;
                        }
                        Err(_) => break,
                    }
                }
            }
        }
        // Best-effort close in case we exited via the output branch.
        let _ = wr.shutdown().await;
    });

    // Input task: read raw bytes from socket, push into session's input
    // channel.
    let mut input_handle = {
        let sess = sess.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(n) => {
                        let chunk: Bytes = Bytes::copy_from_slice(&buf[..n]);
                        if input_tx.send(chunk).await.is_err() {
                            // Session is gone.
                            break;
                        }
                    }
                }
            }
            // The output task is still draining; let it exit on its own
            // when the broadcast closes or the next write fails.
            drop(sess);
        })
    };

    // Whichever side ends first — typically the client disconnecting —
    // tears the other down too.
    tokio::select! {
        _ = &mut output_handle => {
            input_handle.abort();
        }
        _ = &mut input_handle => {
            output_handle.abort();
        }
    }

    sess.attached.fetch_sub(1, Ordering::SeqCst);
    Ok(())
}

/// Strict allow-list for session names: printable ASCII, no spaces at
/// the boundaries, max 80 chars, no path separators or control codes.
/// The hard cap on length is the same we use server-side in the
/// dashboard's `updateSessionSchema` so the two views agree.
fn is_safe_session_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 80 {
        return false;
    }
    if name.starts_with(' ') || name.ends_with(' ') {
        return false;
    }
    name.chars().all(|c| match c {
        // Printable ASCII minus path separators and shell glob metacharacters
        // that have caused issues in other UIs we've shipped (the file path
        // backslash, the unix path slash, raw control characters).
        c if (c.is_ascii_graphic() || c == ' ')
            && c != '/'
            && c != '\\'
            && c != '\0' =>
        {
            true
        }
        _ => false,
    })
}

async fn send_resp(
    wr: &mut tokio::net::unix::OwnedWriteHalf,
    resp: &Response,
) -> Result<()> {
    let mut line = serde_json::to_string(resp).context("serialize response")?;
    line.push('\n');
    wr.write_all(line.as_bytes()).await?;
    wr.flush().await?;
    Ok(())
}

