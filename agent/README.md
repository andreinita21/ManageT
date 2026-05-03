# managet-agent

Lightweight Rust monitoring agent for the [ManageT](../README.md) server
management dashboard.

## What it does

- Every `heartbeat_interval_secs` (default 10s), collects a resource
  snapshot with [sysinfo](https://crates.io/crates/sysinfo):
  - CPU usage %
  - Memory used / total (MB)
  - Disk used % (root filesystem)
  - Load averages (1m / 5m / 15m)
  - Uptime, hostname, agent version
- POSTs the snapshot to `POST /api/agent/heartbeat` on the dashboard,
  authenticated with a per-server bearer token.
- Parses the response directive. If the dashboard replies with
  `{"directive":"uninstall"}`, the agent self-uninstalls: stops its
  service, removes the unit/plist, deletes its config dir and binary,
  and POSTs `/api/agent/uninstalled` as a final acknowledgement.
- On network errors, logs and backs off — never exits.

The agent is **monitoring-only**. It does not execute arbitrary commands,
read file contents, or open shells. Terminal access and restart policies
are still handled by the dashboard's existing SSH infrastructure.

## Subcommands

```
managet-agent install [--api-url URL --server-id ID --non-interactive]
managet-agent run                 # service entrypoint, never exits
managet-agent uninstall           # stop + remove service + binary + config
managet-agent status              # prints config + a one-shot snapshot
```

`install` with no flags launches an interactive TUI. Pass
`--non-interactive` along with `--api-url`, `--server-id`, and the token
in the `MANAGET_AGENT_TOKEN` env var to skip the prompts (used by the
dashboard's SSH-push installer).

## File layout

| Platform | Binary                      | Config                                   | Service unit                                   |
|----------|-----------------------------|------------------------------------------|------------------------------------------------|
| Linux    | `/usr/local/bin/managet-agent` | `/etc/managet-agent/config.toml` (0600) | `/etc/systemd/system/managet-agent.service`    |
| macOS    | `/usr/local/bin/managet-agent` | `/usr/local/etc/managet-agent/config.toml` (0600) | `/Library/LaunchDaemons/com.managet.agent.plist` |

## Building

The dashboard compiles the agent on each target host automatically
when no cached binary is available, so you usually don't need to build
anything by hand. Pre-building is supported as an opt-in fast path.

```
cargo build --release --target <triple>
```

Or to build all supported targets at once and stage them where the
dashboard expects them (`data/agent-binaries/<triple>/managet-agent`):

```
bash agent/scripts/build-release.sh
# or, from the repo root:
npm run build:agent
```

Supported targets:

- `x86_64-unknown-linux-musl`
- `aarch64-unknown-linux-musl`
- `aarch64-apple-darwin`
- `x86_64-apple-darwin`

The build script skips targets that rustup hasn't installed. With a
Homebrew Rust install (no rustup), only the host target will be built;
install rustup to cross-compile the others.

## Development

```
cd agent
cargo test
cargo run -- status              # requires config at ~/.managet-agent...
```

## Security notes

- The token is a 32-byte random value. Only its sha256 is stored on the
  dashboard side — the plaintext never touches disk there.
- During install, the token is passed from the dashboard to the agent
  via the `MANAGET_AGENT_TOKEN` environment variable rather than a CLI
  flag, to keep it out of `ps` output on the remote host.
- The systemd unit enables hardening flags: `NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and a narrow
  `ReadWritePaths` whitelist.
