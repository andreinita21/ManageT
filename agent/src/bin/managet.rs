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

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use managet_agent::cli::ServiceAction;
use managet_agent::{cli_dashboard, service, sessions};

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
    /// Authenticate this local CLI with the ManageT dashboard.
    Login {
        /// Dashboard base URL, e.g. https://managet.example.com.
        #[arg(long, env = "MANAGET_API_URL")]
        api_url: Option<String>,

        /// Dashboard username. Prompted when omitted.
        #[arg(short, long)]
        username: Option<String>,

        /// Dashboard password. Prefer the prompt; this exists for automation.
        #[arg(long, env = "MANAGET_PASSWORD", hide = true, hide_env_values = true)]
        password: Option<String>,
    },

    /// List terminal groups from the dashboard.
    Groups,

    /// Open or modify a dashboard terminal group from this CLI.
    Group {
        #[command(subcommand)]
        action: GroupAction,
    },

    /// List stacks from the dashboard.
    Stacks,

    /// Launch or open a dashboard stack from this CLI.
    Stack {
        #[command(subcommand)]
        action: StackAction,
    },

    /// List or set the color/line theme for the group & stack mosaics.
    /// With no subcommand, lists the presets (marking the active one).
    Theme {
        #[command(subcommand)]
        action: Option<ThemeAction>,
    },

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

#[derive(Debug, Subcommand)]
enum GroupAction {
    /// Attach to a group as a multi-pane terminal view (alias: open).
    /// Detach with Ctrl-A d, just like a single-session attach.
    #[command(alias = "open")]
    Attach {
        /// Group id, unique prefix, or exact group name.
        id: String,
        /// Mosaic theme for this run (see `managet theme list`). Overrides
        /// the saved default.
        #[arg(long)]
        theme: Option<String>,
    },

    /// Save a browser-compatible row arrangement such as 2+2 or 1+3.
    Layout {
        /// Group id, unique prefix, or exact group name.
        id: String,
        /// Row arrangement. Examples: 2+2, 1+3, 3+1, 4.
        arrangement: String,
    },

    /// Swap two pane slots and persist the new order for the browser too.
    Swap {
        /// Group id, unique prefix, or exact group name.
        id: String,
        /// First 1-based slot number.
        from: usize,
        /// Second 1-based slot number.
        to: usize,
    },

    /// Add a new terminal to a group. With no `--server`, opens an
    /// interactive picker listing every server on your dashboard
    /// account (friendly name + host).
    Add {
        /// Group id, unique prefix, or exact group name.
        id: String,
        /// Server name, host, or id. Skips the picker when given.
        #[arg(short, long)]
        server: Option<String>,
        /// Friendly name for the new session.
        #[arg(short, long)]
        name: Option<String>,
        /// Command to run in the session (default: server's $SHELL).
        #[arg(short, long)]
        command: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum StackAction {
    /// Launch a stack. With no flags, launches every service on every
    /// server (same as the dashboard's "Launch Stack"). Narrow the launch
    /// with --server and/or --service.
    Launch {
        /// Stack id, unique prefix, or exact stack name.
        id: String,
        /// Only launch services on this server (name, host, or id).
        #[arg(short, long)]
        server: Option<String>,
        /// Only launch this service (name, id, or unique id prefix).
        #[arg(long)]
        service: Option<String>,
        /// Kill any already-active sessions first, then respawn.
        #[arg(short, long)]
        force: bool,
    },

    /// Open a stack as a multi-pane terminal mosaic across every server
    /// involved. Services that aren't running yet show a placeholder pane
    /// that goes live once the service starts. Detach with Ctrl-A d.
    /// (alias: attach)
    #[command(alias = "attach")]
    Open {
        /// Stack id, unique prefix, or exact stack name.
        id: String,
        /// Only show this server's services from the stack (name, host, or id).
        #[arg(short, long)]
        server: Option<String>,
        /// Mosaic theme for this run (see `managet theme list`). Overrides
        /// the saved default.
        #[arg(long)]
        theme: Option<String>,
    },

    /// List stacks (same as `managet stacks`).
    List,
}

#[derive(Debug, Subcommand)]
enum ThemeAction {
    /// List the available themes, marking the active one.
    List,
    /// Set the default theme for the group & stack mosaics.
    Set {
        /// Theme name (e.g. default, ocean, solarized, mono, matrix, sunset).
        name: String,
    },
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

fn main() -> Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("building tokio runtime")?;
    let result = rt.block_on(run());
    // The interactive attach path uses `tokio::io::stdin()`, which parks an
    // uncancellable blocking thread in a tty read(). When a session ends from
    // the agent side (the user typed `exit`, the agent shut down, the socket
    // closed) `pipe_attach` returns on the socket half while that stdin read
    // is still parked. The default current-thread runtime drop would then
    // block forever trying to join the orphaned read thread — freezing the
    // terminal in canonical mode, where mashing keys rings IMAXBEL endlessly
    // and only a newline (which completes the parked read) frees it. All
    // terminal guards are already restored by the time `run()` returns, so
    // tear the runtime down without waiting on the orphaned read.
    rt.shutdown_background();
    result
}

async fn run() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::Login {
            api_url,
            username,
            password,
        } => cli_dashboard::run_login(api_url, username, password).await,
        Command::Groups => cli_dashboard::run_group_list().await,
        Command::Group { action } => match action {
            GroupAction::Attach { id, theme } => cli_dashboard::run_group_open(id, theme).await,
            GroupAction::Layout { id, arrangement } => {
                cli_dashboard::run_group_layout(id, arrangement).await
            }
            GroupAction::Swap { id, from, to } => cli_dashboard::run_group_swap(id, from, to).await,
            GroupAction::Add {
                id,
                server,
                name,
                command,
            } => cli_dashboard::run_group_add(id, server, name, command).await,
        },
        Command::Stacks => cli_dashboard::run_stack_list().await,
        Command::Stack { action } => match action {
            StackAction::Launch {
                id,
                server,
                service,
                force,
            } => cli_dashboard::run_stack_launch(id, server, service, force).await,
            StackAction::Open { id, server, theme } => {
                cli_dashboard::run_stack_open(id, server, theme).await
            }
            StackAction::List => cli_dashboard::run_stack_list().await,
        },
        Command::Theme { action } => match action {
            None | Some(ThemeAction::List) => cli_dashboard::run_theme_list().await,
            Some(ThemeAction::Set { name }) => cli_dashboard::run_theme_set(name).await,
        },
        Command::Ls => {
            // Pull the dashboard's group → member map up front (when
            // logged in) so individual session rows can be tagged with
            // `[groupName]`. Silent fall-through when offline keeps
            // `managet ls` useful on hosts that haven't logged into
            // the dashboard.
            let group_map = cli_dashboard::fetch_session_group_map().await;
            let group_ref = if group_map.is_empty() { None } else { Some(&group_map) };
            let local_ids = sessions::client::run_ls(group_ref).await?;
            let local_set: std::collections::HashSet<String> =
                local_ids.into_iter().collect();
            cli_dashboard::print_dashboard_ls_sections(&local_set).await
        }
        Command::New {
            name,
            name_flag,
            command,
            no_attach,
        } => {
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
