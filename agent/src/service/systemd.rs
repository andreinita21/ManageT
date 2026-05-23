//! systemd service manager.
//!
//! Writes the unit file to /etc/systemd/system/managet-agent.service and
//! drives systemctl for lifecycle operations.

use anyhow::{Context, Result};
use std::fs;
use std::process::Command;
use tracing::info;

use super::ServiceManager;
use crate::installer::paths;

const UNIT_NAME: &str = "managet-agent.service";

/// systemd unit file body. References the installed binary path and the
/// config directory.
///
/// Note on hardening flags: a previous iteration of this template set
/// `ProtectHome=true` and `ProtectSystem=strict`. Those are inherited
/// by every PTY child the agent spawns — so when a user typed
/// `managet new -c "python3 /home/andrei/foo.py"` (or launched a stack
/// service whose script lived under `/home`), the child saw an empty
/// `/home` namespace and the script silently failed to open. Same for
/// scripts in `/opt`, `/srv`, `/usr/local/something`. Since the entire
/// point of the agent is to host root-equivalent user shells, locking
/// it down with these knobs broke its core function without adding
/// meaningful defense (anyone who can reach the agent socket can spawn
/// `bash` anyway). We keep `NoNewPrivileges` (suid won't help anyone
/// who's already running as root) and `RuntimeDirectory=managet` (so
/// `/var/run/managet` exists for the control socket) but drop the
/// path-protection flags.
const UNIT_TEMPLATE: &str = r#"[Unit]
Description=ManageT monitoring agent
Documentation=https://github.com/andrei/managet
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/managet-agent run
# KillSignal=SIGTERM gives our reporter loop a chance to broadcast
# the shutdown pulse to attached clients (so they see "[managet] agent
# is shutting down" instead of a frozen terminal). TimeoutStopSec=5
# bounds how long we wait before systemd escalates to SIGKILL — the
# pulse broadcaster only sleeps 200ms, so 5s is comfortable.
KillSignal=SIGTERM
TimeoutStopSec=5
Restart=on-failure
RestartSec=5s
User=root

# --- Sandboxing -----------------------------------------------------
# Anything stronger (ProtectHome, ProtectSystem=strict, …) is unsafe
# here because the agent hosts user PTYs that need to touch arbitrary
# paths under /home, /opt, /srv, etc. — locking those down silently
# breaks `managet new -c "python3 /home/u/x.py"`. See the comment in
# the previous unit-template iteration in git history.
#
# These flags are surgical: they harden the daemon's own runtime
# (block setuid escalation, kernel module loading, raw IPC families)
# without restricting what the PTY children can read or write. None
# of them affect the user's shell experience.
NoNewPrivileges=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectClock=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
# Allow only the address families we actually use: UNIX for the
# control socket, INET/INET6 for heartbeats. NETLINK is needed by
# sysinfo's load-average collection on some kernels — leaving it on
# the deny side broke metrics for Pi users in an earlier dogfooding
# pass.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# RuntimeDirectory creates /run/managet at service start (owned by User,
# mode 0755) and removes it at stop. The control socket lives there.
RuntimeDirectory=managet
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
"#;

pub struct SystemdManager;

impl SystemdManager {
    fn systemctl(&self, args: &[&str]) -> Result<()> {
        let status = Command::new("systemctl")
            .args(args)
            .status()
            .with_context(|| format!("spawning systemctl {args:?}"))?;
        if !status.success() {
            anyhow::bail!("systemctl {args:?} exited with {status}");
        }
        Ok(())
    }
}

impl ServiceManager for SystemdManager {
    fn install_unit(&self) -> Result<()> {
        let path = paths::service_file();
        fs::write(&path, UNIT_TEMPLATE)
            .with_context(|| format!("writing {}", path.display()))?;
        info!("wrote systemd unit to {}", path.display());
        self.systemctl(&["daemon-reload"])?;
        Ok(())
    }

    fn remove_unit(&self) -> Result<()> {
        let path = paths::service_file();
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("removing {}", path.display()))?;
            info!("removed {}", path.display());
        }
        // Best-effort reload; if systemctl isn't available the user is
        // probably uninstalling on a broken system and we just want out.
        let _ = self.systemctl(&["daemon-reload"]);
        Ok(())
    }

    fn enable(&self) -> Result<()> {
        self.systemctl(&["enable", UNIT_NAME])
    }

    fn disable(&self) -> Result<()> {
        // Ignore failure — unit might already be gone.
        let _ = self.systemctl(&["disable", UNIT_NAME]);
        Ok(())
    }

    fn start(&self) -> Result<()> {
        self.systemctl(&["start", UNIT_NAME])
    }

    fn stop(&self) -> Result<()> {
        let _ = self.systemctl(&["stop", UNIT_NAME]);
        Ok(())
    }

    fn restart(&self) -> Result<()> {
        // Use systemctl's native restart so the unit goes through its
        // proper ExecStop → ExecStart cycle. The default impl would
        // also work but leaves a tiny window where the service is
        // marked inactive that monitoring tools might flag.
        self.systemctl(&["restart", UNIT_NAME])
    }

    fn print_status(&self) -> Result<()> {
        // `--no-pager --full` shows the whole status block without
        // paging or truncation. We deliberately don't `bail!` on a
        // non-zero exit because systemctl exits 3 when the unit is
        // inactive — that's useful output, not an error.
        let _ = Command::new("systemctl")
            .args(["--no-pager", "--full", "status", UNIT_NAME])
            .status();
        Ok(())
    }

    fn status_command_hint(&self) -> &'static str {
        "systemctl status managet-agent"
    }
}
