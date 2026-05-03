//! Platform-abstracted service-manager interface.
//!
//! Picks systemd on Linux and launchd on macOS. Other platforms return
//! an error from `platform_manager()`.

pub mod launchd;
pub mod systemd;

use anyhow::Result;

/// Common operations the installer needs from a service manager.
pub trait ServiceManager {
    /// Write the unit file / plist to disk and reload the service manager.
    fn install_unit(&self) -> Result<()>;
    /// Remove the unit file and reload.
    fn remove_unit(&self) -> Result<()>;
    /// Enable the service to start on boot.
    fn enable(&self) -> Result<()>;
    /// Disable on-boot autostart.
    fn disable(&self) -> Result<()>;
    /// Start the service now.
    fn start(&self) -> Result<()>;
    /// Stop the service.
    fn stop(&self) -> Result<()>;
    /// Human-readable command the user can run to inspect the service.
    fn status_command_hint(&self) -> &'static str;
}

/// Return the platform-appropriate service manager.
pub fn platform_manager() -> Result<Box<dyn ServiceManager>> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(systemd::SystemdManager))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(launchd::LaunchdManager))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        anyhow::bail!("unsupported platform: managet-agent only runs on Linux (systemd) or macOS (launchd)")
    }
}
