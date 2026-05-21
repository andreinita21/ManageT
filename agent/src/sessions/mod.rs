//! Persistent terminal sessions managed by the agent.
//!
//! The big picture:
//!   * `manager` — holds running PTY sessions in-process.
//!   * `server`  — Unix-socket protocol that lets clients (the local
//!                 CLI today, the dashboard later) drive the manager.
//!   * `client`  — what `managet ls`/`new`/`attach`/`kill` invoke.
//!   * `protocol`— shared wire types.

pub mod bar;
pub mod client;
pub mod manager;
pub mod protocol;
pub mod server;

pub use manager::SessionManager;
pub use server::{run as run_server, socket_path};
