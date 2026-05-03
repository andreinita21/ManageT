//! Install / uninstall orchestration.
//!
//! The actual filesystem and service-manager operations live in siblings
//! (`paths`, `tui`) and in the `service` module. This file glues them
//! together and provides `run_install` and `run_uninstall` for main.rs.

pub mod paths;
pub mod tui;

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::Path;
use tracing::{info, warn};

use crate::cli::InstallArgs;
use crate::config::AgentConfig;

/// Install entrypoint. Decides between TUI and non-interactive modes,
/// assembles a config, and runs the install steps.
pub async fn run_install(args: InstallArgs) -> Result<()> {
    ensure_root()?;

    let cfg = if args.non_interactive {
        non_interactive_config(&args)?
    } else {
        tui::interactive_config(&args)?
    };

    do_install(&cfg).await
}

/// Uninstall entrypoint.
///
/// The self-uninstall path (agent calling itself after receiving the
/// `uninstall` directive) is particularly delicate: we cannot delete the
/// currently running binary on Linux while it's being executed by systemd
/// *before* we stop the service, because systemd will immediately try to
/// restart it (Restart=on-failure). Order matters: stop service → remove
/// service file → remove config → remove binary.
pub async fn run_uninstall() -> Result<()> {
    ensure_root()?;
    info!("stopping and removing managet-agent service");

    let mgr = crate::service::platform_manager()?;

    if let Err(e) = mgr.stop() {
        warn!(%e, "service stop failed (continuing)");
    }
    if let Err(e) = mgr.disable() {
        warn!(%e, "service disable failed (continuing)");
    }
    if let Err(e) = mgr.remove_unit() {
        warn!(%e, "removing service file failed (continuing)");
    }

    // Remove config directory entirely.
    let config_dir = paths::config_dir();
    if config_dir.exists() {
        if let Err(e) = fs::remove_dir_all(&config_dir) {
            warn!(%e, "removing config dir failed");
        } else {
            info!("removed {}", config_dir.display());
        }
    }

    // Remove binary last. On Linux, self-deletion of /usr/local/bin/managet-agent
    // works because the kernel keeps the inode alive while the process holds
    // the file descriptor; the dentry is unlinked immediately.
    let bin = paths::binary_path();
    if bin.exists() {
        if let Err(e) = fs::remove_file(&bin) {
            warn!(%e, "removing binary failed");
        } else {
            info!("removed {}", bin.display());
        }
    }

    info!("uninstall complete");
    Ok(())
}

/// Turn the CLI flags into an `AgentConfig` without any prompting. Used by
/// the dashboard SSH-push installer.
fn non_interactive_config(args: &InstallArgs) -> Result<AgentConfig> {
    let api_url = args
        .api_url
        .clone()
        .ok_or_else(|| anyhow!("--api-url is required in non-interactive mode"))?;
    let server_id = args
        .server_id
        .clone()
        .ok_or_else(|| anyhow!("--server-id is required in non-interactive mode"))?;
    let token = args
        .token
        .clone()
        .ok_or_else(|| anyhow!("--token or MANAGET_AGENT_TOKEN is required in non-interactive mode"))?;

    Ok(AgentConfig {
        api_url,
        server_id,
        token,
        heartbeat_interval_secs: args.interval_secs,
    })
}

/// Perform the install steps shared between interactive and non-interactive.
pub(crate) async fn do_install(cfg: &AgentConfig) -> Result<()> {
    let mgr = crate::service::platform_manager()?;

    // 1. Stop any previously installed instance BEFORE overwriting the binary.
    //    Linux returns ETXTBSY ("Text file busy", errno 26) if you try to
    //    overwrite an executable that's currently being run by another
    //    process — exactly what happens on a re-install when the existing
    //    `managet-agent run` service is still active. `stop()` is best-effort
    //    because there might not be an existing service yet (fresh install).
    if let Err(e) = mgr.stop() {
        warn!(%e, "service stop failed (continuing — likely first install)");
    }

    // 2. Copy the currently-running binary into /usr/local/bin if it isn't
    //    already there. This matters for the manual-install case where the
    //    user runs `sudo ./managet-agent install` from wherever they
    //    downloaded it. In the SSH-push case, the dashboard drops the
    //    binary in /tmp, so we copy from there.
    let current_exe = std::env::current_exe().context("reading current executable path")?;
    let target = paths::binary_path();
    install_binary(&current_exe, &target)?;

    // 3. Write config.
    cfg.save().context("writing agent config")?;
    info!("wrote config to {}", paths::config_file().display());

    // 4. Install + start service.
    mgr.install_unit().context("installing service unit")?;
    mgr.enable().context("enabling service")?;
    mgr.start().context("starting service")?;

    info!("managet-agent installed and running");
    println!();
    println!("Installation complete.");
    println!("  Binary:  {}", target.display());
    println!("  Config:  {}", paths::config_file().display());
    println!("  Service: {}", paths::service_file().display());
    println!();
    println!("Check status with: {}", mgr.status_command_hint());
    Ok(())
}

/// Install the agent binary at `to`, atomically.
///
/// Strategy: write the new binary to a sibling staging path
/// (`<to>.new-<pid>`) and then `rename(2)` it over the destination.
/// `rename` only manipulates directory entries, so it succeeds even if a
/// process is still executing the *old* file at the target path — Linux
/// keeps the old inode alive via the open fd, and any new exec resolves to
/// the new inode. This sidesteps `ETXTBSY` ("Text file busy", errno 26),
/// which `fs::copy` would hit on re-installs because `cp` opens the
/// destination with `O_TRUNC` and the kernel refuses to truncate a
/// running executable.
fn install_binary(from: &Path, to: &Path) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    if from == to {
        return Ok(());
    }

    // Stage next to the destination so the final rename is on the same
    // filesystem (rename across filesystems fails with EXDEV).
    let staging = to.with_extension(format!("new-{}", std::process::id()));

    // If a stale staging file from a previous failed install exists, remove
    // it so `fs::copy` doesn't trip on it.
    let _ = fs::remove_file(&staging);

    fs::copy(from, &staging)
        .with_context(|| format!("staging {} -> {}", from.display(), staging.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&staging)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&staging, perms)?;
    }

    fs::rename(&staging, to).with_context(|| {
        format!(
            "atomic rename {} -> {}",
            staging.display(),
            to.display()
        )
    })?;

    info!("installed agent binary at {}", to.display());
    Ok(())
}

/// Refuse to install/uninstall as non-root. The config file lives in /etc
/// and the service file needs root to register with systemd/launchd.
fn ensure_root() -> Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: libc::geteuid is thread-safe and has no preconditions.
        let euid = unsafe { libc::geteuid() };
        if euid != 0 {
            anyhow::bail!(
                "managet-agent install/uninstall must be run as root (try: sudo managet-agent ...)"
            );
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Ok(())
    }
}
