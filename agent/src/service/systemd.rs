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
/// config directory. The hardening flags match the plan.
const UNIT_TEMPLATE: &str = r#"[Unit]
Description=ManageT monitoring agent
Documentation=https://github.com/andrei/managet
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/managet-agent run
Restart=on-failure
RestartSec=5s
User=root
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/managet-agent
# RuntimeDirectory creates /run/managet at service start (owned by User,
# mode 0755) and removes it at stop. Without this, ProtectSystem=strict
# blocks the agent from binding the local control socket at
# /var/run/managet/agent.sock.
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

    fn status_command_hint(&self) -> &'static str {
        "systemctl status managet-agent"
    }
}
