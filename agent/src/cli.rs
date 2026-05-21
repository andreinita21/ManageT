//! Command-line interface definitions using clap derive.

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "managet-agent",
    version,
    about = "ManageT monitoring agent",
    long_about = "Reports CPU, memory, disk, and load to a ManageT dashboard. \
                  Runs as a systemd (Linux) or launchd (macOS) service."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Install the agent as a system service.
    ///
    /// With flags → non-interactive (used by dashboard SSH-push).
    /// Without flags → interactive TUI (used for manual installs).
    Install(InstallArgs),

    /// Service entrypoint. Starts the heartbeat loop and never exits
    /// until it receives an "uninstall" directive from the dashboard.
    Run,

    /// Stop the service, remove the service file, config, and binary.
    Uninstall,

    /// Print the loaded config and one metric snapshot, then exit.
    Status,

    /// List active terminal sessions managed by this host's agent.
    Ls,

    /// Spawn a new persistent terminal session.
    New {
        /// Friendly name for the session (default: `session-<short-id>`).
        #[arg(short, long)]
        name: Option<String>,
        /// Command to run (default: `$SHELL`).
        #[arg(short, long)]
        command: Option<String>,
    },

    /// Attach to an existing session by id (or unique prefix / name).
    /// Detach with Ctrl-A d.
    Attach {
        id: String,
    },

    /// Send SIGTERM to a session's child process.
    Kill {
        id: String,
    },

    /// Update fields in the on-disk config file in-place and exit. Used
    /// by the dashboard to push a new dashboard URL or heartbeat
    /// interval without re-running the full installer. The caller is
    /// responsible for restarting the service afterwards (e.g.
    /// `systemctl restart managet-agent`) so the running process picks
    /// up the new values.
    Reconfigure(ReconfigureArgs),
}

#[derive(Debug, Args)]
pub struct ReconfigureArgs {
    /// New dashboard API base URL (e.g. https://managet.example.com).
    /// Validated the same way as during install — must start with
    /// http:// or https:// and not be empty.
    #[arg(long)]
    pub api_url: Option<String>,

    /// New heartbeat interval in seconds (5–600). Optional.
    #[arg(long)]
    pub interval_secs: Option<u64>,

    /// New colour for the `managet attach` status bar.
    /// One of: green, cyan, magenta, yellow, blue, red, white, gray.
    /// Persisted to /etc/managet-agent/bar.toml — the running agent
    /// doesn't need to be restarted, the bar reloads on next attach.
    #[arg(long)]
    pub bar_color: Option<String>,

    /// Comma-separated list of fields to render in the status bar,
    /// in order. Recognised: session, user_host, duration, detach.
    /// Unknown entries are dropped silently. Persisted to
    /// /etc/managet-agent/bar.toml.
    #[arg(long)]
    pub bar_fields: Option<String>,
}

#[derive(Debug, Args)]
pub struct InstallArgs {
    /// Dashboard API base URL (e.g. https://dashboard.example.com).
    #[arg(long)]
    pub api_url: Option<String>,

    /// Server ID (UUID) issued by the dashboard when this server was added.
    #[arg(long)]
    pub server_id: Option<String>,

    /// Bearer token for authenticating this agent.
    ///
    /// Prefer passing via the MANAGET_AGENT_TOKEN env var instead of this flag,
    /// so the plaintext token does not appear in the process argument list.
    #[arg(long, env = "MANAGET_AGENT_TOKEN", hide_env_values = true)]
    pub token: Option<String>,

    /// Heartbeat interval in seconds. Defaults to 10.
    #[arg(long, default_value_t = 10)]
    pub interval_secs: u64,

    /// Skip all prompts. All required values must be supplied via flags/env.
    /// This is the mode used by the dashboard's automated installer.
    #[arg(long)]
    pub non_interactive: bool,
}
