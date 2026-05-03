//! Per-OS filesystem paths for the agent.
//!
//! Centralised here so install and uninstall agree on where things live.

use std::path::PathBuf;

/// Full path to the installed agent binary.
pub fn binary_path() -> PathBuf {
    PathBuf::from("/usr/local/bin/managet-agent")
}

/// Directory holding the config file.
pub fn config_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        PathBuf::from("/etc/managet-agent")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/usr/local/etc/managet-agent")
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        PathBuf::from("/etc/managet-agent")
    }
}

/// Full path to the TOML config file.
pub fn config_file() -> PathBuf {
    config_dir().join("config.toml")
}

/// Path to the service unit / plist.
#[cfg(target_os = "linux")]
pub fn service_file() -> PathBuf {
    PathBuf::from("/etc/systemd/system/managet-agent.service")
}

#[cfg(target_os = "macos")]
pub fn service_file() -> PathBuf {
    PathBuf::from("/Library/LaunchDaemons/com.managet.agent.plist")
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn service_file() -> PathBuf {
    // Stub for other platforms — the agent won't actually install here,
    // but we need a path to satisfy the compiler.
    PathBuf::from("/tmp/managet-agent.service")
}
