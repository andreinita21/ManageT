//! TOML configuration file load/save.
//!
//! Config lives at a platform-dependent path (see `installer::paths`) and is
//! written with 0600 permissions. The token is stored in plaintext because
//! it is a bearer credential the agent needs at every heartbeat — it's
//! effectively a password, and hashing it server-side is enough.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// On-disk configuration for the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Dashboard API base URL, no trailing slash.
    pub api_url: String,
    /// Server ID (UUID) issued by the dashboard.
    pub server_id: String,
    /// Bearer token for authenticating this agent.
    pub token: String,
    /// How often to send heartbeats (seconds).
    #[serde(default = "default_interval")]
    pub heartbeat_interval_secs: u64,
}

fn default_interval() -> u64 {
    10
}

impl AgentConfig {
    /// Load config from the standard location. Errors if missing or malformed.
    ///
    /// Honours `MANAGET_CONFIG_PATH` if set in the environment. That's a
    /// dev / test escape hatch — production installs always read from
    /// the platform-specific path under `/etc` (or `/usr/local/etc` on
    /// macOS). Lets a non-root developer run the agent with
    /// `MANAGET_CONFIG_PATH=/tmp/managet.toml
    /// MANAGET_SOCKET_PATH=/tmp/managet.sock managet-agent run`
    /// without touching system directories.
    pub fn load() -> Result<Self> {
        if let Ok(p) = std::env::var("MANAGET_CONFIG_PATH") {
            if !p.is_empty() {
                return Self::load_from(Path::new(&p));
            }
        }
        let path = crate::installer::paths::config_file();
        Self::load_from(&path)
    }

    /// Load config from an arbitrary path. Useful for tests.
    pub fn load_from(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("reading config at {}", path.display()))?;
        let cfg: AgentConfig = toml::from_str(&raw)
            .with_context(|| format!("parsing config at {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Save config to the standard location, creating parent dirs as needed.
    /// Sets 0600 permissions on unix.
    pub fn save(&self) -> Result<()> {
        let path = crate::installer::paths::config_file();
        self.save_to(&path)
    }

    /// Save config to an arbitrary path. Useful for tests.
    pub fn save_to(&self, path: &Path) -> Result<()> {
        self.validate()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating config dir {}", parent.display()))?;
        }
        let raw = toml::to_string_pretty(self).context("serializing config")?;
        fs::write(path, raw)
            .with_context(|| format!("writing config to {}", path.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(path, perms)?;
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        if self.api_url.is_empty() {
            anyhow::bail!("api_url is empty");
        }
        if !(self.api_url.starts_with("http://") || self.api_url.starts_with("https://")) {
            anyhow::bail!("api_url must start with http:// or https://");
        }
        if self.server_id.is_empty() {
            anyhow::bail!("server_id is empty");
        }
        if self.token.is_empty() {
            anyhow::bail!("token is empty");
        }
        if self.heartbeat_interval_secs == 0 {
            anyhow::bail!("heartbeat_interval_secs must be > 0");
        }
        Ok(())
    }

    /// Trim trailing slash from api_url so URL building is predictable.
    pub fn api_url_normalized(&self) -> &str {
        self.api_url.trim_end_matches('/')
    }
}

/// `managet-agent reconfigure --api-url <…> [--interval-secs <…>]`.
/// Loads the on-disk config, mutates the requested fields, validates,
/// and writes it back. Does not restart the service — the caller is
/// expected to do that. Used by the dashboard's "Dashboard URL" push so
/// agents can be repointed at a new tunnel URL without a full reinstall.
pub fn reconfigure(args: crate::cli::ReconfigureArgs) -> anyhow::Result<()> {
    let touched_main = args.api_url.is_some() || args.interval_secs.is_some();
    let touched_bar = args.bar_color.is_some() || args.bar_fields.is_some();

    if touched_main {
        let mut cfg = AgentConfig::load().context("loading config to reconfigure")?;
        if let Some(url) = &args.api_url {
            let trimmed = url.trim().trim_end_matches('/').to_string();
            if trimmed.is_empty() {
                anyhow::bail!("--api-url cannot be empty");
            }
            if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
                anyhow::bail!("--api-url must start with http:// or https://");
            }
            cfg.api_url = trimmed;
        }
        if let Some(interval) = args.interval_secs {
            if interval == 0 {
                anyhow::bail!("--interval-secs must be > 0");
            }
            cfg.heartbeat_interval_secs = interval;
        }
        cfg.save().context("writing updated config")?;
        println!(
            "reconfigured: api_url={} interval_secs={}",
            cfg.api_url, cfg.heartbeat_interval_secs
        );
    }

    if touched_bar {
        crate::sessions::bar::save_partial(
            args.bar_color.as_deref(),
            args.bar_fields.as_deref(),
        )
        .context("updating bar.toml")?;
        println!("reconfigured: bar settings saved");
    }

    if !touched_main && !touched_bar {
        eprintln!("reconfigure: nothing to do (no flags supplied)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn roundtrip() {
        let tmp = env::temp_dir().join("managet-agent-test-config.toml");
        let _ = fs::remove_file(&tmp);
        let cfg = AgentConfig {
            api_url: "http://localhost:3000".into(),
            server_id: "11111111-2222-3333-4444-555555555555".into(),
            token: "deadbeef".into(),
            heartbeat_interval_secs: 5,
        };
        cfg.save_to(&tmp).unwrap();
        let loaded = AgentConfig::load_from(&tmp).unwrap();
        assert_eq!(loaded.api_url, cfg.api_url);
        assert_eq!(loaded.server_id, cfg.server_id);
        assert_eq!(loaded.token, cfg.token);
        assert_eq!(loaded.heartbeat_interval_secs, 5);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn rejects_bad_url() {
        let cfg = AgentConfig {
            api_url: "ftp://bad".into(),
            server_id: "x".into(),
            token: "y".into(),
            heartbeat_interval_secs: 1,
        };
        assert!(cfg.validate().is_err());
    }
}
