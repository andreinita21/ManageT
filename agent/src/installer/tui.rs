//! Interactive installer TUI.
//!
//! Uses `inquire` to prompt the user for the API URL, server ID, and token,
//! then hands off to `do_install`. Run when the user invokes
//! `sudo managet-agent install` with no flags.

use anyhow::{anyhow, Context, Result};
use inquire::{validator::Validation, Confirm, Password, PasswordDisplayMode, Text};

use crate::cli::InstallArgs;
use crate::config::AgentConfig;

const BANNER: &str = r#"
 _ __ ___   __ _ _ __ ___   __ _  __ _  ___  | |_
| '_ ` _ \ / _` | '_ ` _ \ / _` |/ _` |/ _ \ | __|
| | | | | | (_| | | | | | | (_| | (_| |  __/ | |_
|_| |_| |_|\__,_|_| |_| |_|\__,_|\__, |\___|  \__|
                                 |___/
         ManageT monitoring agent installer
"#;

const ABOUT: &str = "\
This installer will set up a small monitoring service on this machine.

What the agent does:
  • Every ~10 seconds, reads CPU, memory, disk, and load from this host
  • Posts those metrics and a heartbeat to your ManageT dashboard
  • Identifies itself with a bearer token unique to this server

What it does NOT do:
  • No remote command execution
  • No reading of file contents, logs, or user data
  • No telemetry to anyone except the dashboard URL you configure

After install:
  • The binary lives at /usr/local/bin/managet-agent
  • A systemd (Linux) or launchd (macOS) service keeps it running
  • You can uninstall it any time with: sudo managet-agent uninstall
";

/// Run the interactive prompt flow and return a fully-populated
/// `AgentConfig`. Prefills any values that were passed on the command line.
pub fn interactive_config(args: &InstallArgs) -> Result<AgentConfig> {
    println!("{BANNER}");
    println!("{ABOUT}");

    let api_url = prompt_api_url(args.api_url.as_deref())?;
    let server_id = prompt_server_id(args.server_id.as_deref())?;
    let token = prompt_token(args.token.as_deref())?;
    let interval_secs = args.interval_secs.max(1);

    println!();
    println!("Ready to install:");
    println!("  API URL:  {api_url}");
    println!("  Server:   {server_id}");
    println!("  Interval: every {interval_secs}s");
    println!();

    let confirm = Confirm::new("Proceed with installation?")
        .with_default(true)
        .prompt()
        .context("reading confirmation")?;
    if !confirm {
        return Err(anyhow!("installation cancelled by user"));
    }

    Ok(AgentConfig {
        api_url,
        server_id,
        token,
        heartbeat_interval_secs: interval_secs,
        // Filled in by `do_install` after probing the host. Default to
        // false here so a partial config (no probe yet) still validates.
        gpu_present: false,
    })
}

fn prompt_api_url(default: Option<&str>) -> Result<String> {
    let validator = |input: &str| {
        if input.starts_with("http://") || input.starts_with("https://") {
            Ok(Validation::Valid)
        } else {
            Ok(Validation::Invalid(
                "must start with http:// or https://".into(),
            ))
        }
    };
    let mut q = Text::new("Dashboard API URL:")
        .with_help_message("e.g. https://managet.example.com")
        .with_validator(validator);
    if let Some(d) = default {
        q = q.with_initial_value(d);
    }
    Ok(q.prompt().context("reading API URL")?)
}

fn prompt_server_id(default: Option<&str>) -> Result<String> {
    let validator = |input: &str| {
        let trimmed = input.trim();
        if trimmed.len() < 8 {
            Ok(Validation::Invalid("server ID looks too short".into()))
        } else {
            Ok(Validation::Valid)
        }
    };
    let mut q = Text::new("Server ID (UUID from dashboard):")
        .with_help_message("Copy this from the Add Server flow in the dashboard")
        .with_validator(validator);
    if let Some(d) = default {
        q = q.with_initial_value(d);
    }
    Ok(q.prompt().context("reading server ID")?.trim().to_string())
}

fn prompt_token(default: Option<&str>) -> Result<String> {
    if let Some(d) = default {
        return Ok(d.to_string());
    }
    let token = Password::new("Agent token:")
        .with_display_mode(PasswordDisplayMode::Masked)
        .with_help_message("Paste the token shown in the dashboard")
        .without_confirmation()
        .prompt()
        .context("reading token")?;
    if token.trim().is_empty() {
        return Err(anyhow!("token cannot be empty"));
    }
    Ok(token)
}
