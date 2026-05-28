//! Install / uninstall orchestration.
//!
//! The actual filesystem and service-manager operations live in siblings
//! (`paths`, `tui`) and in the `service` module. This file glues them
//! together and provides `run_install` and `run_uninstall` for main.rs.

pub mod paths;
pub mod tui;

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
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

    // Remove the user-facing `managet` CLI before the service binary. On
    // Linux, fs::remove_file works even on a running executable (dentry
    // is unlinked, inode kept alive by the open fd). On macOS we'd hit
    // ETXTBSY only if it were the currently-running executable, which it
    // isn't here.
    let cli = paths::managet_cli_path();
    if cli.exists() {
        if let Err(e) = fs::remove_file(&cli) {
            warn!(%e, "removing managet CLI failed");
        } else {
            info!("removed {}", cli.display());
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

/// Install the user-facing `managet` CLI alongside the service binary.
///
/// Strategy:
///   1. If a `managet` binary sits next to the source we're installing from
///      (dashboard SSH-push uploads both files into the same staging dir;
///      `cargo build` produces both binaries side-by-side in
///      `target/release/`), copy that into `/usr/local/bin/managet`.
///   2. Otherwise (e.g. a manual install where the user only has the
///      service binary on disk), drop a symlink from
///      `/usr/local/bin/managet` to `managet-agent`. The service binary
///      already accepts the same subcommands, so the symlink works.
///
/// Atomic-rename trick mirrors `install_binary` for the same ETXTBSY reasons.
fn install_managet_cli(service_binary_source: &Path) -> Result<()> {
    use std::os::unix::fs::symlink;

    let target = paths::managet_cli_path();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    // Look for a `managet` binary next to the source service binary.
    let dir = service_binary_source
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let candidate = dir.join("managet");

    if candidate.exists() && candidate != target {
        // Stage + atomic-rename to handle ETXTBSY if a previous install
        // left a running `managet attach` process. Same trick as the
        // service binary install above.
        let staging = target.with_extension(format!("new-{}", std::process::id()));
        let _ = fs::remove_file(&staging);
        fs::copy(&candidate, &staging)
            .with_context(|| format!("staging {} -> {}", candidate.display(), staging.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&staging)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&staging, perms)?;
        }
        // If `target` is currently a symlink, fs::rename replaces it
        // atomically; if it's a regular file, same.
        fs::rename(&staging, &target)
            .with_context(|| format!("renaming {} -> {}", staging.display(), target.display()))?;
        info!("installed managet CLI at {}", target.display());
        return Ok(());
    }

    // Fallback: symlink. Remove anything already at the target path so
    // `symlink` doesn't fail with EEXIST.
    if target.exists() || target.is_symlink() {
        let _ = fs::remove_file(&target);
    }
    if let Err(e) = symlink(paths::binary_path(), &target) {
        warn!(%e, "could not symlink managet CLI (continuing without it)");
    } else {
        info!("symlinked managet -> managet-agent at {}", target.display());
    }
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
        // Probed by `do_install` after this struct is built. Default
        // false so the early-validate call doesn't choke on a partial
        // config.
        gpu_present: false,
    })
}

/// Best-effort detection of a usable GPU on the host. Persisted into the
/// config at install time so the runtime collector can skip GPU-temp work
/// entirely on systems without one (e.g. headless Pi, VMs).
///
/// Order:
///   1. `nvidia-smi -L` exits 0 → NVIDIA card present (covers both Linux
///      and macOS-with-eGPU edge cases).
///   2. On Linux: any `/sys/class/drm/card*/device/uevent` mentioning a
///      DRM-capable device, *excluding* the Pi's bcm2708-fb framebuffer
///      which counts as a "card" but isn't a real GPU for our purposes.
///   3. On macOS: every Apple Silicon Mac has an integrated GPU. Detect
///      via uname; we report true and let the SMC reader surface the temp.
fn probe_gpu_present() -> bool {
    // Try nvidia-smi first — fast exit on systems with NVIDIA drivers.
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .arg("-L")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    {
        if out.status.success() && !out.stdout.is_empty() {
            info!("GPU probe: detected NVIDIA card via nvidia-smi");
            return true;
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Iterate /sys/class/drm/card* and look at the uevent. A real GPU
        // (AMD radeon/amdgpu, Intel i915, Nouveau, etc.) carries a
        // DRIVER= line with a non-framebuffer driver name. The Pi 4/5
        // expose `card0` for the kms driver `vc4` — that's a real GPU.
        // The bcm2708-fb older framebuffer is NOT useful for thermals so
        // we filter it out by name.
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("card") || name.contains('-') {
                    // Skip "card0-HDMI-A-1" connector entries.
                    continue;
                }
                let uevent = entry.path().join("device").join("uevent");
                if let Ok(text) = std::fs::read_to_string(&uevent) {
                    for line in text.lines() {
                        if let Some(driver) = line.strip_prefix("DRIVER=") {
                            // Skip framebuffer-only entries; everything
                            // else (amdgpu, radeon, i915, nouveau, vc4,
                            // v3d, nvidia, etc.) means a real GPU.
                            if driver == "simple-framebuffer" || driver == "bcm2708-fb" {
                                continue;
                            }
                            info!(driver, card = %name, "GPU probe: detected via /sys/class/drm");
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    #[cfg(target_os = "macos")]
    {
        // Every Mac has a GPU. The SMC reader will figure out whether
        // there's a usable thermal sensor for it.
        true
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
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

    // 2b. Install the user-facing `managet` CLI alongside the service binary.
    //     We look for it in the same directory as the service binary we just
    //     installed from (typical layout: dashboard's SSH-push uploads both
    //     binaries to /tmp; manual installs run from a directory that has
    //     both). Falls back to a symlink onto the service binary so the
    //     subcommand interface still works.
    install_managet_cli(&current_exe)?;

    // 3. Probe for a GPU, then write config. The probe runs once, here,
    //    so the runtime collector doesn't pay for it on every heartbeat.
    let mut cfg = cfg.clone();
    cfg.gpu_present = probe_gpu_present();
    info!(gpu_present = cfg.gpu_present, "host GPU probe result");
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
