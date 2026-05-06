//! `managet` — the user-facing CLI for persistent terminal sessions.
//!
//! Speaks to the locally-running `managet-agent` over its Unix socket
//! (`/var/run/managet/agent.sock`). Sessions live in the agent process
//! and survive any browser/dashboard activity — same model as tmux,
//! same UX:
//!
//!   managet new [-n NAME] [-c CMD]   # spawn a session
//!   managet ls                       # list sessions on this host
//!   managet attach <id|name>         # attach (Ctrl-A d to detach)
//!   managet kill <id|name>           # SIGTERM the child
//!
//! The dashboard speaks the same protocol over an SSH-tunnelled socket,
//! so a session created here shows up there and vice-versa.

use anyhow::Result;
use clap::{Parser, Subcommand};
use managet_agent::sessions;

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

    /// Spawn a new persistent terminal session.
    New {
        /// Friendly name (default: `session-<short-id>`).
        #[arg(short, long)]
        name: Option<String>,
        /// Command to run in the new session (default: `$SHELL`).
        #[arg(short, long)]
        command: Option<String>,
    },

    /// Attach to an existing session by id, name, or unique prefix.
    /// Detach with Ctrl-A d.
    Attach { id: String },

    /// Send SIGTERM to a session's child process.
    Kill { id: String },
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
        Command::New { name, command } => sessions::client::run_new(name, command).await,
        Command::Attach { id } => sessions::client::run_attach(id).await,
        Command::Kill { id } => sessions::client::run_kill(id).await,
    }
}
