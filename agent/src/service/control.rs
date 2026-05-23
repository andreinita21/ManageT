//! Operator-driven lifecycle control: `managet service {start,stop,
//! restart,status}` and the shorthand `managet stop` / `managet start`.
//!
//! The interesting bit is `stop`: before we ask the platform service
//! manager to bring the agent down, we POST a `manually_stopped`
//! lifecycle signal to the dashboard. That's what lets the dashboard
//! show "stopped via managet stop, run managet start to resume"
//! instead of the generic "unreachable" message after the next
//! heartbeat sweep notices the missing pings.
//!
//! If the signal fails for any reason (network down, dashboard
//! unreachable, token rejected, …) we still proceed with the stop —
//! the operator's stop intent shouldn't be vetoed by a dashboard
//! that's itself down. The status sweep will eventually flip the
//! row to `unreachable`, which is the right fallback.
//!
//! `restart` uses the same signal as stop so that if the agent
//! crashes during its own restart for some reason, the dashboard
//! reflects "intentional" rather than "outage". The signal is
//! cleared automatically on the next heartbeat once the agent is
//! back up, so the row only stays in `manually_stopped` while it
//! genuinely is.
//!
//! Auth uses the same bearer-token mechanism as heartbeats. The
//! token lives in the agent's config file, which is 0600 root-only —
//! so this command path always runs with root privileges (matching
//! the systemctl invocation it wraps).

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use serde_json::json;
use std::time::Duration;
use tracing::{info, warn};

use crate::cli::ServiceAction;
use crate::config::AgentConfig;

/// HTTP timeout for the lifecycle POST. Short on purpose — if the
/// dashboard is unresponsive we'd rather move on with the stop than
/// block the operator's CLI for a long time.
const LIFECYCLE_HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// Top-level dispatcher invoked from `main.rs` for `managet-agent
/// service <action>` and from the user-facing `managet` binary for
/// `managet service <action>` / `managet stop` / `managet start`.
pub fn run(action: ServiceAction) -> Result<()> {
    let mgr = crate::service::platform_manager()?;

    match action {
        ServiceAction::Start => {
            info!("starting managet-agent");
            mgr.start()
                .context("starting service via the platform manager")?;
            println!("managet-agent: start signal sent.");
            println!(
                "Once the next heartbeat lands the dashboard will flip back to 'healthy'."
            );
            Ok(())
        }
        ServiceAction::Stop => {
            // Try the dashboard signal first. Best-effort — never
            // block the local stop on a remote outcome.
            signal_dashboard_stop("Operator ran `managet stop` on the host.");
            info!("stopping managet-agent");
            mgr.stop()
                .context("stopping service via the platform manager")?;
            println!("managet-agent: stop signal sent.");
            println!(
                "Dashboard has been notified — server is shown as 'Stopped'. \
                 Run `managet start` to resume."
            );
            Ok(())
        }
        ServiceAction::Restart => {
            // Restart triggers the same dashboard signal as stop so
            // that if the agent fails to come back up the dashboard
            // doesn't flip to a misleading 'unreachable' before the
            // operator notices. A successful restart's first
            // heartbeat clears the state automatically.
            signal_dashboard_stop("Operator ran `managet restart` on the host.");
            info!("restarting managet-agent");
            mgr.restart()
                .context("restarting service via the platform manager")?;
            println!("managet-agent: restart signal sent.");
            Ok(())
        }
        ServiceAction::Status => mgr.print_status(),
    }
}

/// POST `{state: "manually_stopped", reason}` to
/// `<api_url>/api/agent/lifecycle`. Failures are logged at WARN and
/// swallowed — the local stop should not be vetoed by a dashboard
/// problem. The dashboard's `status-monitor` fallback (heartbeat
/// timeout → `unreachable`) takes over if our signal didn't land.
fn signal_dashboard_stop(reason: &str) {
    // Load config. Best-effort — if the file is missing or unreadable
    // we just skip the signal. This happens on a fresh box where the
    // agent was never installed; `managet stop` shouldn't error in
    // that case, the platform-manager call below will already
    // report there's nothing to stop.
    let cfg = match AgentConfig::load() {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "lifecycle signal skipped: could not load agent config");
            return;
        }
    };

    let url = format!("{}/api/agent/lifecycle", cfg.api_url_normalized());
    let body = json!({
        "state": "manually_stopped",
        "reason": reason,
    });

    let client = match Client::builder()
        .user_agent(format!("managet-agent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(LIFECYCLE_HTTP_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "lifecycle signal skipped: HTTP client build failed");
            return;
        }
    };

    match client
        .post(&url)
        .bearer_auth(&cfg.token)
        .json(&body)
        .send()
    {
        Ok(resp) if resp.status().is_success() => {
            info!("dashboard lifecycle signal sent: manually_stopped");
        }
        Ok(resp) => {
            warn!(
                status = %resp.status(),
                "dashboard rejected lifecycle signal (continuing with local stop)"
            );
        }
        Err(e) => {
            warn!(error = %e, "lifecycle signal failed (continuing with local stop)");
        }
    }
}
