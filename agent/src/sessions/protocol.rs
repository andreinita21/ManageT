//! Wire protocol for the local Unix-socket session API.
//!
//! Each request is a single newline-terminated JSON object. The server
//! responds with one or more newline-terminated JSON objects. After an
//! `Attach` request succeeds, the connection switches to a raw byte
//! stream in both directions: bytes from the client are forwarded into
//! the PTY's stdin, bytes from the PTY are forwarded back to the client.
//! That mirrors how a tmux client/server talks once attached.
//!
//! The protocol is intentionally minimal — nothing here mentions the
//! dashboard. The same socket can later be driven by the dashboard via
//! a tunnel without the agent caring who's on the other side.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// List every session currently managed by the agent.
    List,
    /// Spawn a new session running `command` (default: $SHELL).
    New {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        command: Option<String>,
        /// Initial PTY rows. Defaults to 24 if omitted.
        #[serde(default)]
        rows: Option<u16>,
        /// Initial PTY cols. Defaults to 80 if omitted.
        #[serde(default)]
        cols: Option<u16>,
        /// Optional Unix user name to run the shell as. When `Some(name)`,
        /// the agent (which runs as root) drops to that user via `su -l`
        /// so the PTY inherits a normal login environment ($HOME, $USER,
        /// .bash_profile, etc.). When `None`, the shell inherits the
        /// agent's identity (root, in our deployment) — preserved for
        /// backwards compatibility with older clients that don't know
        /// about this field.
        #[serde(default)]
        user: Option<String>,
        /// Optional working directory to start the new session in. When
        /// `Some(path)`, the agent tries to `cd` to it before exec'ing
        /// the shell; if the target user doesn't have access we fall
        /// back to their `$HOME`. Lets `managet new` typed in
        /// `~/projects/foo` start the session in `~/projects/foo`
        /// instead of `$HOME`.
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Begin streaming a session's input/output over this connection.
    /// After the agent replies with `Response::Attached`, both sides
    /// switch to raw bytes for the duration of the connection.
    Attach {
        id: String,
        /// Caller's terminal size, applied to the PTY before streaming.
        #[serde(default)]
        rows: Option<u16>,
        #[serde(default)]
        cols: Option<u16>,
    },
    /// Send SIGTERM to a session's child process (and clean up its row).
    Kill { id: String },
    /// Resize an attached session's PTY. Used after the initial Attach
    /// when the user resizes their terminal window.
    Resize { id: String, rows: u16, cols: u16 },
    /// Change a session's display name in-place. The PTY child is
    /// untouched; this is purely a label update so that
    /// `managet attach <name>` and `managet list` show the same name
    /// the dashboard does after a rename. Added in agent v1.x —
    /// older agents reply with `Response::Error` for an unknown op,
    /// which the dashboard treats as "name updated locally only".
    Rename { id: String, name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Response {
    /// Reply to `List`.
    SessionList { sessions: Vec<SessionInfo> },
    /// Reply to `New`.
    Created { id: String, name: String },
    /// Reply to `Attach`. After this single line, the connection is in raw mode.
    Attached { id: String, name: String },
    /// Reply to `Kill` / `Resize` / generic acks.
    Ok,
    /// Anything that went wrong.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub created_at_ms: u64,
    pub attached_clients: usize,
    pub running: bool,
}
