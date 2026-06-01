//! Library crate for the ManageT agent.
//!
//! Both binaries (`managet-agent`, the long-running service, and
//! `managet`, the user-facing CLI for managing sessions) link against
//! this library so they can share the session protocol/client code,
//! config, paths, etc.
//!
//! `managet-agent` is "everything" — install/run/uninstall/status plus
//! the session subcommands kept for back-compat.
//! `managet` is just the four session commands (ls/new/attach/kill).

pub mod cli;
pub mod cli_dashboard;
pub mod collector;
pub mod config;
pub mod hwmon;
pub mod installer;
pub mod reporter;
pub mod service;
pub mod sessions;
