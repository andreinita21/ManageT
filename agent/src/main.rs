//! ManageT monitoring agent — the `managet-agent` binary.
//!
//! Long-running service entrypoint and install/uninstall driver. Also
//! still exposes the session subcommands for backwards compatibility,
//! but the dedicated `managet` binary is now the recommended way to
//! drive sessions interactively.

use anyhow::Result;
use clap::Parser;
use managet_agent::cli::{Cli, Command};
use managet_agent::{collector, config, installer, reporter, service, sessions};

fn init_tracing() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .compact()
        .init();
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();

    match cli.command {
        Command::Install(args) => installer::run_install(args).await,
        Command::Run => reporter::run_loop().await,
        Command::Uninstall => installer::run_uninstall().await,
        Command::Status => collector::print_status_snapshot(),
        Command::Ls => sessions::client::run_ls(None).await,
        Command::New { name, name_flag, command, no_attach } => {
            // Positional name wins if both are given (defensible default
            // when an old script with `-n foo` is invoked alongside a
            // new positional). Falls back to the flag if only that's set.
            let resolved = name.or(name_flag);
            sessions::client::run_new(resolved, command, no_attach).await
        }
        Command::Attach { id } => sessions::client::run_attach(id).await,
        Command::Kill { id } => sessions::client::run_kill(id).await,
        Command::Reconfigure(args) => config::reconfigure(args),
        Command::Service { action } => {
            // service::control uses the blocking reqwest client (so it
            // doesn't need a tokio runtime to POST the lifecycle
            // signal — keeps the path independent of the long-running
            // service binary's runtime). Defer to spawn_blocking so we
            // don't park the multi-thread runtime's worker.
            tokio::task::spawn_blocking(move || service::control::run(action))
                .await
                .map_err(|e| anyhow::anyhow!("service control task panicked: {e}"))?
        }
    }
}
