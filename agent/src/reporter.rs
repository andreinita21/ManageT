//! Heartbeat reporter — the `run` subcommand.
//!
//! Loops forever: every `heartbeat_interval_secs`, collect a metric snapshot
//! and POST it to `/api/agent/heartbeat` with a bearer token. The dashboard
//! responds with a directive — either `continue` (noop) or `uninstall`
//! (run self-uninstall, POST a final confirmation, then exit cleanly).

use anyhow::{Context, Result};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, error, info, warn};

use std::sync::Arc;

use crate::collector::{self, MetricSnapshot};
use crate::config::AgentConfig;
use crate::sessions::{run_server as run_session_server, socket_path as session_socket_path, SessionManager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "directive")]
enum Directive {
    Continue,
    Uninstall,
}

/// Entrypoint for `managet-agent run`. Loads config, then enters the
/// heartbeat loop. Never exits on transient network error — only on an
/// uninstall directive, a fatal config error, or SIGTERM.
pub async fn run_loop() -> Result<()> {
    let cfg = AgentConfig::load().context("loading agent config")?;
    info!(
        "managet-agent v{} starting — reporting to {} every {}s",
        env!("CARGO_PKG_VERSION"),
        cfg.api_url_normalized(),
        cfg.heartbeat_interval_secs
    );

    // Start the session server alongside the heartbeat loop. PTYs live in
    // this same process so any session created via `managet new` (or via
    // a future dashboard tunnel) survives browser/dashboard disconnects
    // for as long as this process keeps running. Failure to bind doesn't
    // abort the agent — heartbeats are independent and we'd rather still
    // report metrics than refuse to start over a missing /var/run.
    let session_manager = Arc::new(SessionManager::new());
    {
        let sm = session_manager.clone();
        let path = session_socket_path();
        tokio::spawn(async move {
            if let Err(e) = run_session_server(sm, &path).await {
                warn!(%e, "session server exited");
            }
        });
    }

    let client = Client::builder()
        .user_agent(format!("managet-agent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .context("building HTTP client")?;

    let heartbeat_url = format!("{}/api/agent/heartbeat", cfg.api_url_normalized());
    let mut shutdown = signal_stream();

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                info!("received shutdown signal, exiting");
                return Ok(());
            }
            _ = sleep(Duration::from_secs(cfg.heartbeat_interval_secs)) => {}
        }

        let snapshot = tokio::task::spawn_blocking(collector::collect)
            .await
            .context("collector task panicked")?;

        match post_heartbeat(&client, &heartbeat_url, &cfg.token, &snapshot).await {
            Ok(Directive::Continue) => {
                debug!("heartbeat ok");
            }
            Ok(Directive::Uninstall) => {
                info!("dashboard requested uninstall — beginning self-removal");
                // Best-effort: report uninstallation success before we tear
                // ourselves down. The API hard-deletes the server row when
                // it receives this, so it must happen before the row is
                // needed for authentication on the /uninstalled endpoint.
                if let Err(e) = notify_uninstalled(&client, &cfg).await {
                    warn!(%e, "failed to POST /api/agent/uninstalled (continuing)");
                }
                if let Err(e) = crate::installer::run_uninstall().await {
                    error!(%e, "self-uninstall failed");
                    return Err(e);
                }
                return Ok(());
            }
            Err(e) => {
                warn!(%e, "heartbeat failed, will retry next cycle");
            }
        }
    }
}

async fn post_heartbeat(
    client: &Client,
    url: &str,
    token: &str,
    snapshot: &MetricSnapshot,
) -> Result<Directive> {
    let resp = client
        .post(url)
        .bearer_auth(token)
        .json(snapshot)
        .send()
        .await
        .context("sending heartbeat")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED {
            anyhow::bail!("dashboard rejected token (401). Body: {body}");
        }
        anyhow::bail!("heartbeat returned {status}. Body: {body}");
    }

    let directive: Directive = resp.json().await.context("parsing heartbeat response")?;
    Ok(directive)
}

async fn notify_uninstalled(client: &Client, cfg: &AgentConfig) -> Result<()> {
    let url = format!("{}/api/agent/uninstalled", cfg.api_url_normalized());
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.token)
        .send()
        .await
        .context("sending uninstall confirmation")?;
    if !resp.status().is_success() {
        anyhow::bail!("/api/agent/uninstalled returned {}", resp.status());
    }
    Ok(())
}

/// Build a future that resolves on SIGTERM or Ctrl-C, so systemd can stop
/// the service cleanly.
fn signal_stream() -> tokio::sync::mpsc::Receiver<()> {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => return,
            };
            let mut int = match signal(SignalKind::interrupt()) {
                Ok(s) => s,
                Err(_) => return,
            };
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            let _ = tx.send(()).await;
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            let _ = tx.send(()).await;
        }
    });
    rx
}
