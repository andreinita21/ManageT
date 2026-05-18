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
//! Permissions: we chmod the socket to 0666 so any local user on the
//! box can list/attach. Sessions inherit the agent's UID (root, in our
//! deployment), which means `managet attach` puts the user in a root
//! shell. For the single-admin Pi/Mini setup this is acceptable; per-
//! user session isolation is a follow-up.

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
pub fn socket_path() -> PathBuf {
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

async fn handle_client(stream: UnixStream, manager: Arc<SessionManager>) -> Result<()> {
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
        } => {
            let r = rows.unwrap_or(24);
            let c = cols.unwrap_or(80);
            match manager.create(name, command, r, c, user) {
                Ok(sess) => {
                    send_resp(
                        &mut wr,
                        &Response::Created {
                            id: sess.id.clone(),
                            name: sess.name.clone(),
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
            match manager.resolve(&id) {
                Ok(sess) => {
                    sess.resize(rows, cols).await;
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
            // Apply the caller's terminal size up front so vim/tmux/htop
            // render at the right shape from the very first repaint.
            if let (Some(r), Some(c)) = (rows, cols) {
                sess.resize(r, c).await;
            }
            send_resp(
                &mut wr,
                &Response::Attached {
                    id: sess.id.clone(),
                    name: sess.name.clone(),
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

    // Output task: forward broadcast messages to the client. Exits when
    // the client side closes (write fails) or when the broadcast channel
    // closes (session gone).
    let mut output_handle = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
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
        // Return wr so the parent can close it on shutdown.
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

