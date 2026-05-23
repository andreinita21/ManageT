//! `managet` — the user-facing CLI for persistent terminal sessions.
//!
//! Speaks to the locally-running `managet-agent` over its Unix socket
//! (`/var/run/managet/agent.sock`). Sessions live in the agent process
//! and survive any browser/dashboard activity — same model as tmux,
//! same UX:
//!
//!   managet new [NAME] [-c CMD]      # spawn AND attach
//!   managet new [NAME] --no-attach   # spawn without attaching
//!   managet ls                       # list sessions on this host
//!   managet attach <id|name>         # attach (Ctrl-A d to detach)
//!   managet kill <id|name>           # SIGTERM the child
//!
//! The dashboard speaks the same protocol over an SSH-tunnelled socket,
//! so a session created here shows up there and vice-versa.

use anyhow::Result;
use clap::{Parser, Subcommand};
use managet_agent::cli::ServiceAction;
use managet_agent::{service, sessions};

#[derive(Debug, Parser)]
#[command(
    name = "managet",
    version,
    about = "Persistent terminal sessions managed by the ManageT agent",
    long_about = "Talks to the locally-running managet-agent. Sessions live in \
                  the agent process and outlive your shell, your SSH session, \
                  and the dashboard."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// List active terminal sessions managed by this host's agent.
    Ls,

    /// Spawn a new persistent terminal session and attach to it.
    ///
    /// `managet new devproject` creates a session named `devproject`
    /// and attaches in one step. With no name argument a random
    /// `session-<id>` is used. Pass `--no-attach` to spawn without
    /// entering; ssh-driven scripts (no TTY) get that behaviour
    /// automatically.
    New {
        /// Friendly name (default: `session-<short-id>`). Positional.
        name: Option<String>,

        /// Backwards-compatible alias for the positional name.
        #[arg(short = 'n', long = "name", hide = true)]
        name_flag: Option<String>,

        /// Command to run in the new session (default: `$SHELL`).
        #[arg(short, long)]
        command: Option<String>,

        /// Don't auto-attach after creating.
        #[arg(long)]
        no_attach: bool,
    },

    /// Attach to an existing session by id, name, or unique prefix.
    /// Detach with Ctrl-A d.
    Attach { id: String },

    /// Send SIGTERM to a session's child process.
    Kill { id: String },

    /// Lifecycle control for the local managet-agent service.
    /// `managet service stop` POSTs a `manually_stopped` signal to the
    /// dashboard before bringing the systemd / launchd unit down, so
    /// the dashboard shows the server as "Stopped" instead of
    /// "Unreachable". `managet service start` brings it back up and
    /// the next heartbeat clears the state.
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },

    /// Shorthand for `managet service stop`. Common enough that we
    /// give it a top-level verb.
    Stop,

    /// Shorthand for `managet service start`.
    Start,

    /// Shorthand for `managet service restart`.
    Restart,
}

fn init_tracing() {
    // Quieter than the agent's default — `managet` is interactive, the
    // user doesn't want INFO logs by default. Only honour RUST_LOG if
    // the caller explicitly sets it.
    if std::env::var_os("RUST_LOG").is_some() {
        let env_filter = tracing_subscriber::EnvFilter::from_default_env();
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(false)
            .compact()
            .init();
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::Ls => sessions::client::run_ls().await,
        Command::New { name, name_flag, command, no_attach } => {
            let resolved = name.or(name_flag);
            sessions::client::run_new(resolved, command, no_attach).await
        }
        Command::Attach { id } => sessions::client::run_attach(id).await,
        Command::Kill { id } => sessions::client::run_kill(id).await,
        Command::Service { action } => service::control::run(action),
        Command::Stop => service::control::run(ServiceAction::Stop),
        Command::Start => service::control::run(ServiceAction::Start),
        Command::Restart => service::control::run(ServiceAction::Restart),
    }
}
