//! launchd service manager (macOS).
//!
//! Writes /Library/LaunchDaemons/com.managet.agent.plist and uses
//! `launchctl bootstrap`/`bootout` for lifecycle. These are the newer
//! replacements for `load`/`unload` on macOS 10.11+.

use anyhow::{Context, Result};
use std::fs;
use std::process::Command;
use tracing::{info, warn};

use super::ServiceManager;
use crate::installer::paths;

const LABEL: &str = "com.managet.agent";

/// launchd plist for the agent.
///
/// Notes on choices that look minor but aren't:
///
/// - **No `StandardOutPath`/`StandardErrorPath`.** We used to point these at
///   `/var/log/managet-agent.{log,err.log}`. On modern macOS `/var/log` is
///   SIP-protected and launchd's pre-bootstrap validation can return EIO if
///   it can't open the file for writing — which is the cause of the
///   `Bootstrap failed: 5: Input/output error` we hit on Sequoia. Letting
///   launchd route stdio into the unified log instead is both safer and
///   means `log show --predicate 'process == "managet-agent"'` Just Works.
/// - **`ProcessType=Background`.** Tells launchd this is a long-running
///   service so it doesn't get throttled like an interactive job.
/// - **`ThrottleInterval=10`.** Caps the restart rate at one every 10s if
///   the binary keeps crashing — same vibe as systemd's `RestartSec=5s`.
const PLIST_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.managet.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/managet-agent</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
"#;

pub struct LaunchdManager;

impl LaunchdManager {
    /// Run a launchctl command, capturing stdout+stderr so error messages
    /// from launchd actually surface in the install log instead of being
    /// discarded by `Command::status()`.
    fn launchctl(&self, args: &[&str]) -> Result<()> {
        let output = Command::new("launchctl")
            .args(args)
            .output()
            .with_context(|| format!("spawning launchctl {args:?}"))?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "launchctl {args:?} exited with {status}\nSTDOUT: {stdout}\nSTDERR: {stderr}",
                status = output.status,
                stdout = stdout.trim(),
                stderr = stderr.trim(),
            );
        }
        Ok(())
    }

    /// Same as `launchctl` but never returns an error. Used for best-effort
    /// teardown calls (e.g. `bootout` before `bootstrap`) where the previous
    /// state is unknown and any "not loaded" error is fine.
    fn launchctl_lenient(&self, args: &[&str]) {
        if let Err(e) = self.launchctl(args) {
            warn!(error = %e, "launchctl {:?} failed (ignoring)", args);
        }
    }
}

impl ServiceManager for LaunchdManager {
    fn install_unit(&self) -> Result<()> {
        let path = paths::service_file();
        fs::write(&path, PLIST_TEMPLATE)
            .with_context(|| format!("writing {}", path.display()))?;

        // launchd is strict about ownership/permissions on plists in
        // /Library/LaunchDaemons/. They must be:
        //   - mode 0644
        //   - owner: root (uid 0)
        //   - group: wheel (gid 0)
        // If any of these are off, `bootstrap` fails with the same opaque
        // `5: Input/output error` we're trying to avoid. We're already
        // running as root (ensured by ensure_root in installer/mod.rs) so
        // the chown call is straightforward.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path)?.permissions();
            perms.set_mode(0o644);
            fs::set_permissions(&path, perms)?;

            // Force ownership to root:wheel via libc::chown. We can't rely on
            // `fs::write` having created the file with the right group:
            // when launched via `sudo`, the egid may inherit the invoking
            // user's primary group depending on how sudoers is configured,
            // and a `root:staff` plist makes launchd refuse to bootstrap.
            let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
                .context("plist path contained an interior NUL byte")?;
            // SAFETY: c_path is a valid NUL-terminated path string. chown
            // is async-signal-safe and has no preconditions beyond a valid
            // pathname.
            let rc = unsafe { libc::chown(c_path.as_ptr(), 0, 0) };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                anyhow::bail!("chown root:wheel {}: {}", path.display(), err);
            }
        }

        info!("wrote launchd plist to {}", path.display());
        Ok(())
    }

    fn remove_unit(&self) -> Result<()> {
        let path = paths::service_file();
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("removing {}", path.display()))?;
            info!("removed {}", path.display());
        }
        Ok(())
    }

    fn enable(&self) -> Result<()> {
        // `bootstrap system` both registers the plist and starts it. We run
        // it here in enable() because systemd's enable+start split doesn't
        // map cleanly — on macOS the two are one step.
        //
        // Critically: `bootstrap` is NOT idempotent. If the label is already
        // registered with launchd (from a half-completed prior install or
        // a crashed retry), bootstrap fails with the cryptic
        // `Bootstrap failed: 5: Input/output error`. Always bootout first
        // and ignore any "not loaded" error so subsequent attempts succeed.
        let target = format!("system/{LABEL}");
        self.launchctl_lenient(&["bootout", &target]);

        // We've also seen `Bootstrap failed: 5: Input/output error` when
        // bootstrap is called immediately after writing the plist on a
        // re-install — racing launchd's own catalogue update. A short
        // back-off + a single retry has cleared every reproducer we've
        // tested without papering over a real config bug, because launchd
        // returns a different error for those (e.g. exit 119 for invalid
        // plist content).
        let path = paths::service_file();
        let plist_arg = path.to_str().context("plist path was not valid UTF-8")?;
        match self.launchctl(&["bootstrap", "system", plist_arg]) {
            Ok(()) => Ok(()),
            Err(first) => {
                warn!(error = %first, "first bootstrap failed, retrying after 1s");
                std::thread::sleep(std::time::Duration::from_secs(1));
                // Try one more bootout+bootstrap cycle.
                self.launchctl_lenient(&["bootout", &target]);
                self.launchctl(&["bootstrap", "system", plist_arg])
            }
        }
    }

    fn disable(&self) -> Result<()> {
        // `bootout` is the inverse of `bootstrap`.
        let target = format!("system/{LABEL}");
        self.launchctl_lenient(&["bootout", &target]);
        Ok(())
    }

    fn start(&self) -> Result<()> {
        // `bootstrap` already starts the job; this is a no-op unless we
        // explicitly want to kickstart after a stop.
        let target = format!("system/{LABEL}");
        self.launchctl_lenient(&["kickstart", "-k", &target]);
        Ok(())
    }

    fn stop(&self) -> Result<()> {
        let target = format!("system/{LABEL}");
        self.launchctl_lenient(&["bootout", &target]);
        Ok(())
    }

    fn restart(&self) -> Result<()> {
        // `kickstart -k` is launchd's native "stop the running job
        // and start it fresh" — the -k flag means SIGKILL the
        // currently running instance first. We use it here instead of
        // bootout+bootstrap because the latter has the EIO flake we
        // mitigate in `enable()` and isn't needed for a plain restart.
        let target = format!("system/{LABEL}");
        self.launchctl(&["kickstart", "-k", &target])
    }

    fn print_status(&self) -> Result<()> {
        let target = format!("system/{LABEL}");
        let _ = Command::new("launchctl").args(["print", &target]).status();
        Ok(())
    }

    fn status_command_hint(&self) -> &'static str {
        "sudo launchctl print system/com.managet.agent"
    }
}
