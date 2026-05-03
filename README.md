# ManageT

A self-hosted dashboard for managing a fleet of SSH-accessible servers.
Terminals, session recovery, resource metrics, alerts, restart policies,
and a lightweight Rust monitoring agent that auto-installs on every
server you add.

## Architecture

- **Next.js app** (App Router, custom `server.ts`) serves the dashboard,
  REST API, and WebSocket upgrades for interactive terminals.
- **SQLite + Drizzle ORM** stores servers, sessions, metrics, alerts,
  and restart rules.
- **ssh2** handles interactive terminal sessions, command execution,
  and restart orchestration.
- **Rust agent (`agent/`)** runs as a background service (`systemd` on
  Linux, `launchd` on macOS) on every managed server and pushes
  resource snapshots + heartbeats to `POST /api/agent/heartbeat`. See
  [`agent/README.md`](./agent/README.md) for details.

### How status works

Server status is derived from the **agent's last heartbeat**, not from
whether the dashboard currently has an SSH session open. This means a
production box that nobody is actively watching still shows as
`healthy`, and a box that dies mid-session flips to `unreachable`
within ~30s regardless of whether a terminal is attached.

Transitions:

- `not_installed` → `installing` — when you add a server, the dashboard
  SSHes in, detects the OS/arch, and looks for a cached binary under
  `data/agent-binaries/<target>/`. If one exists it's SFTP-uploaded
  directly; if not, the dashboard bootstraps `rustup` on the target,
  ships the agent source, and runs `cargo build --release` on the
  remote host. Either way, it then runs `managet-agent install
  --non-interactive`.
- `installing` → `healthy` — first successful heartbeat.
- `installing` → `install_failed` — any step failed. The row stays and
  you can retry from the server detail page.
- `healthy` → `unreachable` — no heartbeat for ≥30s (the background
  status monitor sweeps every 15s).
- `healthy`/`unreachable` → `uninstalling` — you clicked Delete. The
  agent's next heartbeat receives `{"directive":"uninstall"}`, it
  self-cleans, and POSTs to `/api/agent/uninstalled` which hard-deletes
  the server row. If the agent hasn't phoned home recently, the
  dashboard falls back to running `managet-agent uninstall` over SSH.
  `?force=true` skips the agent signal and wipes the row immediately.

## Getting started

```bash
# 1. Install Node dependencies
npm install

# 2. Seed the DB (creates data/managet.db and the default admin)
npm run seed
# => admin@managet.local / admin

# 3. Start the dashboard
npm run dev
```

Default login: `admin@managet.local` / `admin`. Change this in
production (`scripts/seed.ts`).

You do **not** need to pre-build the Rust agent before adding servers.
When you add a server whose architecture isn't already cached in
`data/agent-binaries/`, the dashboard SSHes in, installs `rustup` if
needed, ships the source, and compiles the agent on the target itself
(~5-10 minutes on first install). The result is cached under
`data/agent-binaries/<target>/` so every subsequent server with the same
architecture installs in seconds.

Pre-building is still supported as an opt-in fast path — see
[Building the Rust agent](#building-the-rust-agent) below.

## Environment

- `MANAGET_DASHBOARD_URL` — absolute URL the agent should POST back to
  (e.g. `https://managet.example.com`). Defaults to
  `http://<hostname>:$PORT` in dev, which is rarely what you want in
  production.
- `PORT` — HTTP port the dashboard listens on. Defaults to `3000`.
- `NODE_ENV` — standard Next.js env var.

## Building the Rust agent

**This step is optional.** The dashboard will compile the agent on the
target host itself if no cached binary is available. Pre-building only
matters if you want installs to complete in seconds rather than minutes
on the first server of a given architecture.

Requires a Rust toolchain (`rustup` recommended so you can cross-compile
for all targets):

```bash
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
  aarch64-apple-darwin x86_64-apple-darwin

npm run build:agent
```

The script skips targets that rustup hasn't installed and is safe to
re-run; it only rebuilds what's changed. Built binaries land in
`data/agent-binaries/<target>/managet-agent` — the dashboard's SSH-push
installer reads from there. Binaries produced by the build-on-target
fallback land in the same directory and are reused identically.

## Manual agent install (outside the dashboard)

If you want to install the agent on a box without using the dashboard's
SSH-push flow (e.g. a machine that can't accept inbound SSH from the
dashboard host), download the binary directly from the dashboard and
run the interactive installer:

```bash
curl -fSL \
  -H "Authorization: Bearer <your-session-token-or-agent-bearer>" \
  "$DASHBOARD/api/agent/binary/x86_64-unknown-linux-musl" \
  -o managet-agent
chmod +x managet-agent
sudo ./managet-agent install
```

The TUI will prompt for the dashboard URL, a server ID (which you'll
need to create in the UI first), and the bearer token.
