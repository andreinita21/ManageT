<div align="center">

# ManageT

**A self-hosted control plane for a fleet of SSH-accessible servers — persistent terminals, live metrics, stacks of services, and a Rust monitoring agent that installs itself.**

[![Made with Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Rust agent](https://img.shields.io/badge/agent-Rust-orange?logo=rust)](./agent)
[![SQLite + Drizzle](https://img.shields.io/badge/db-SQLite-blue?logo=sqlite)](https://orm.drizzle.team)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#license)

[Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Production deployment](#production-deployment) · [CLI](#host-side-cli) · [Themes](#theming) · [Roadmap](#roadmap)

</div>

---

## What it is

ManageT is the dashboard you keep open on the second monitor to run a homelab, a hobby cluster, or a small production fleet. You add a server by host + SSH credentials, and the dashboard:

1. SSHes in, detects the OS/architecture, and installs a small Rust **monitoring agent** as a system service (`systemd` on Linux, `launchd` on macOS).
2. The agent pushes resource snapshots back every 10s; the dashboard derives `healthy`/`unreachable` from heartbeat freshness rather than from whether a terminal is open.
3. PTY sessions live inside the agent, **not** in the browser. Close the tab, refresh the page, restart the dashboard — `npm run dev`, `vim`, `htop`, a half-finished migration — they all keep running. Reopening the tab reattaches and **replays the agent's scrollback** so you walk back in to context.
4. Group services into **Stacks**, launch them as a unit, and watch each service's PTY tile update live.
5. Every UI surface and the terminal itself are **themable** — Catppuccin, Solarized, Dracula, Nord, Gruvbox, Tokyo Night, classic xterm, plus a custom-palette builder with native colour pickers.

It is **monitoring + remote control**, not orchestration. There is no Docker Swarm, no Kubernetes, no agent push-execution: the dashboard does its own SSH work for terminals and lifecycle, and the agent is read-only telemetry.

## Features

### Terminals
- Persistent PTYs in the agent — survive browser close, dashboard restart, network blips.
- Scrollback replay on attach (4 MiB ring per session) so reopening a tab puts you where you left off.
- Stable across React StrictMode double-mounts, the xterm renderer-init race, and UTF-8 chunk boundaries (each of those was a real bug we hit and fixed).
- "Sticky" tabs in the stack-terminals view: a transient `inactive` runtime poll won't unmount your terminal.

### Stacks
- Define a stack as a list of `(server, service name, command)` tuples.
- **Launch** is idempotent by default — services already running are reused; `?force=1` kills + respawns.
- **Trash** workflow with restore/force-delete so accidentally-trashed stacks aren't gone forever.

### Monitoring
- Per-host CPU / memory / disk / load / active-connection metrics with bucket-aggregated graphs (1h / 6h / 24h windows).
- Per-session CPU/RAM attribution: the collector walks each PTY's process tree from the shell root.
- Alerts engine subscribed to a snapshot event bus published by the heartbeat route.
- Background metric pruner keeps the SQLite DB from growing unbounded.

### Theming (full UI + terminals)
- 11 curated presets: **Catppuccin** Mocha / Macchiato / Frappé / Latte, xterm default, Solarized Dark + Light, Dracula, Nord, Gruvbox, Tokyo Night.
- One choice drives the dashboard chrome *and* the xterm terminal palette.
- **Custom theme** with per-colour native pickers + hex inputs for every UI tone and every xterm ANSI slot.
- Live preview while editing; nothing persists until you press Save.
- Terminal font family + size are configurable per user; applied live to every running terminal.
- Per-user preferences stored in the DB (`user_preferences` table) so they follow the user across browsers.

### Operability
- Auto-reconciliation: every 60s the dashboard re-imports any agent session it didn't know about and marks DB-only sessions `closed`.
- One-shot cleanup script (`scripts/cleanup-orphan-sessions.ts`) diffs each agent against the DB and surgically terminates orphans by writing `exit\n` through the attach stream.
- Benchmark script (`scripts/benchmark-memory-storage.py`) walks every managed host + the dashboard and produces a Word `.docx` with comparison charts.
- Self-contained `deploy/` directory with a systemd unit + installer script for the dashboard.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────────┐  │
│  │ Next.js UI │  │ xterm.js   │  │ React (App Router)         │  │
│  └─────┬──────┘  └──────┬─────┘  └────────────┬───────────────┘  │
└────────┼────────────────┼─────────────────────┼──────────────────┘
         │ HTTP/REST      │ WebSocket           │
┌────────▼────────────────▼─────────────────────▼──────────────────┐
│  Dashboard (Node 22 + Next.js 16 + custom server.ts)             │
│   • REST (auth, sessions, stacks, metrics, preferences)          │
│   • WebSocket bridge: browser xterm ↔ agent PTY                  │
│   • ssh2 connection pool — one persistent client per server      │
│   • SQLite + Drizzle ORM (data/managet.db)                       │
└─────────┬────────────────────────────────────────────────────────┘
          │ SSH connection (port 22), forwarded Unix socket
┌─────────▼──────────────────────────────────────────────────────────┐
│  Managed host (Linux / macOS, ARM64 / x86_64)                      │
│   ┌──────────────────────────┐    ┌────────────────────────────┐   │
│   │ managet-agent (Rust)     │    │ user shells in PTYs        │   │
│   │ • heartbeats every 10s   │◄───┤ • bash / zsh / fish        │   │
│   │ • PTY session manager    │    │ • npm run dev / vim /      │   │
│   │ • /var/run/managet.sock  │    │   long-running services    │   │
│   └────────────┬─────────────┘    └────────────────────────────┘   │
│                │ HTTP POST                                         │
│                ▼                                                   │
└──────────────────────────────────────────────────────────────────┘
   POST /api/agent/heartbeat ─┐
                              │
                              ▼
                       Dashboard (back to top)
```

### How status works

Server status is derived from the **agent's last heartbeat**, not from whether the dashboard currently has an SSH session open. A production box that nobody is watching still shows as `healthy`; a box that dies mid-session flips to `unreachable` within ~30s regardless of whether a terminal is attached.

Transitions:

- `not_installed` → `installing` — when you add a server, the dashboard SSHes in, detects the OS/arch, and looks for a cached binary under `data/agent-binaries/<target>/`. If one exists it's SFTP-uploaded directly; if not, the dashboard bootstraps `rustup` on the target, ships the agent source, and runs `cargo build --release` on the remote host. Either way, it then runs `managet-agent install --non-interactive`.
- `installing` → `healthy` — first successful heartbeat lands.
- `installing` → `install_failed` — any step failed. Row stays put so you can retry from the server detail page.
- `healthy` → `unreachable` — no heartbeat for ≥30s (background sweeper runs every 15s).
- `healthy` / `unreachable` → `uninstalling` — Delete clicked. The agent's next heartbeat receives `{"directive":"uninstall"}`, it self-cleans, and POSTs `/api/agent/uninstalled` which hard-deletes the row. If the agent hasn't phoned home, the dashboard falls back to running `managet-agent uninstall` over SSH. `?force=true` skips the agent signal and wipes the row immediately.

## Quick start

```bash
# 1. Install Node dependencies (Node 22+ required)
npm install

# 2. Seed the DB (creates data/managet.db and the default admin)
npm run seed
# => admin@managet.local / admin

# 3. Start the dashboard in dev mode
npm run dev
# → http://localhost:3000
```

Default login: `admin@managet.local` / `admin`. **Change this for any deployment that's not strictly local.** The seed user lives in `scripts/seed.ts`; update the password there or via the admin UI.

You do **not** need to pre-build the Rust agent before adding servers. When you add a server whose architecture isn't already cached in `data/agent-binaries/`, the dashboard SSHes in, installs `rustup` if needed, ships the source, and compiles the agent on the target itself (~5–10 minutes on first install). The compiled binary is cached under `data/agent-binaries/<target>/` so every subsequent server with the same architecture installs in seconds.

## Production deployment

The repo ships a systemd unit + installer for running the dashboard on the same kind of Linux host it manages.

```bash
# Build the production bundle
npm run build

# Install + enable the systemd unit (system-wide; needs sudo)
sudo bash deploy/install-systemd.sh

# Useful follow-ups
sudo systemctl status   managet     # current state
sudo systemctl restart  managet     # apply a code update
journalctl -u managet -f            # tail live logs
```

The installer is idempotent — re-running it after a `git pull && npm ci && npm run build` safely restarts the service in place. There's also `deploy/managet.user.service` for hosts where you don't have root; install with `systemctl --user enable --now managet`, plus a one-time `sudo loginctl enable-linger andrei` if you need it to run when no user is logged in.

To deploy a code change:

```bash
cd /home/andrei/managet
git pull && npm ci && npm run build && sudo systemctl restart managet
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MANAGET_DASHBOARD_URL` | `http://<hostname>:$PORT` | Absolute URL the agent POSTs its heartbeats to. Set this in production. |
| `PORT` | `3000` | HTTP port the dashboard binds to. |
| `NODE_ENV` | `development` | Standard Next.js env. `npm start` sets it to `production`. |
| `DATABASE_URL` | `file:./data/managet.db` | SQLite database path. |
| `MANAGET_ENCRYPTION_KEY` | *(required in `.env.local`)* | 32-byte hex key used to encrypt stored SSH credentials. |

`.env.local` is the Next.js convention; `scripts/seed.ts` will write a key on first run if one isn't already present.

## Host-side CLI

The Rust agent installs as `managet-agent` on the host. It also installs a friendlier alias, `managet`, for the day-to-day verbs:

```bash
managet ls            # list sessions on this host
managet attach <id>   # attach to a session by id or unambiguous prefix
managet new -c "npm run dev" --name api    # spawn a new PTY session
managet kill <id>     # terminate a session (see "Roadmap" caveat)
managet status        # heartbeat config + one-shot snapshot

# Same agent, lower-level subcommands
managet-agent install [--api-url URL --server-id ID --non-interactive]
managet-agent run                 # service entrypoint, never exits
managet-agent uninstall           # stop + remove service + binary + config
```

See [`agent/README.md`](./agent/README.md) for the full agent reference.

## Theming

Themes live under **Settings → Appearance** (the first tab; default). Picking a preset re-skins the whole dashboard *and* every open terminal in the same render — the dashboard mutates `--color-mg-*` CSS variables on `documentElement`, and the terminal palette is fed into xterm's runtime options.

Preset families:

| Family | Variants |
|---|---|
| ManageT | Purple (default) |
| Catppuccin | Mocha, Macchiato, Frappé, Latte |
| Classic | xterm default |
| Solarized | Dark, Light |
| Community | Dracula, Nord, Gruvbox, Tokyo Night |
| Custom | per-colour native picker + hex input for every UI tone and every xterm ANSI slot |

Terminal font family + size are independent from the colour theme. Both are stored per user in the `user_preferences` table and applied live; the picker pushes a preview through React context, and **Save** persists.

## Project layout

```
.
├── agent/                  # Rust monitoring agent (see agent/README.md)
├── data/                   # runtime data — SQLite DB + cached binaries
├── deploy/                 # systemd unit + installer + macos plist
├── drizzle/                # migrations + journal
├── public/                 # Next.js static assets
├── reports/                # benchmark .docx output (gitignored)
├── scripts/                # one-shot ops + dev tools
├── src/
│   ├── app/                # Next.js app router pages + /api routes
│   ├── components/         # UI + terminal panes + settings tabs
│   ├── lib/
│   │   ├── agent/          # agent install + status sweeper
│   │   ├── db/             # Drizzle schema + transforms
│   │   ├── monitor/        # alerts, pruner, session reconciler, metrics buckets
│   │   ├── ssh/            # connection pool, session manager, agent socket
│   │   ├── stacks/         # stack runtime + launch/stop
│   │   └── themes/         # presets + provider context
│   └── types/              # shared TypeScript types
├── tests-e2e/              # playwright smoke tests
├── server.ts               # custom Next.js server with WebSocket upgrade
└── package.json
```

## Development

```bash
npm run dev          # custom server with HMR (terminals work in dev)
npm run dev:next     # plain `next dev` — no terminals (no WS handler)
npm run lint         # eslint
npm run build        # next build
npm start            # NODE_ENV=production via custom server (= what systemd runs)
npm run build:agent  # cross-compile the agent for all targets
```

Cross-compiling the agent (optional fast path; the dashboard builds on-target if missing):

```bash
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
                  aarch64-apple-darwin x86_64-apple-darwin
npm run build:agent
```

## Useful one-shot scripts

| Script | What it does |
|---|---|
| `npx tsx scripts/cleanup-orphan-sessions.ts` | Reports agent sessions with no DB row. `--apply` exits each by writing `Ctrl-C + exit` through the attach stream. |
| `python3 scripts/benchmark-memory-storage.py` | SSHes to every managed host, measures agent RSS/VSZ/disk + dashboard RSS/repo size, emits a Word `.docx` report under `reports/` with comparison charts. |
| `npx tsx scripts/diagnose-agent.ts <serverId>` | Dumps systemd/launchd state, `config.toml`, recent logs, and outbound connectivity from the target host. |
| `npx tsx scripts/seed.ts` | Idempotent DB seeder; runs `drizzle-kit migrate` then upserts the default admin. |

The full list lives in [`scripts/`](./scripts/).

## Roadmap

Known issues worth tracking, with rough priority:

- **Agent kill path** — `Session::request_kill` is one-shot (a failed kill consumes the only handle), and `portable-pty` 0.8 sends `SIGHUP` rather than `SIGKILL`. `su -l` does not always propagate the signal to its child shell, so an interactive bash spawned via `su` can survive the kill request. Today the cleanup script + auto-reconciler work around this through the existing protocol; the proper fix is in the agent (rebuild + redeploy) and should `killpg(root_pid, SIGKILL)` while keeping the handle for retries.
- **Session-daemon-survives-agent-restart** — `cleanup_dead` currently keeps live sessions across browser disconnects, but restarting the agent itself drops the in-memory map. A "tmux-style detach" model with a per-session helper that survives the daemon is sketched but not built.
- **macOS auto-cross-compile** — the dashboard's "compile on target" fallback assumes a rustup-friendly host. Macs without a developer environment fall back gracefully but slowly (rustup install ~3 min before any work).
- **Auth** — single-admin only today. The `users` table has a `role` column (`admin` / `operator` / `viewer`) but the UI doesn't yet expose role-aware controls.
- **Backups** — there's no automated DB backup. SQLite + a daily `cp` is fine for a homelab; production should add a proper rotation strategy.

## Security

- SSH credentials are encrypted at rest with `MANAGET_ENCRYPTION_KEY` (AES-GCM). Only ciphertext lands in SQLite.
- The agent token is a 32-byte random value; only its SHA-256 is stored dashboard-side. During install the plaintext is passed via the `MANAGET_AGENT_TOKEN` env var so it never appears in `ps`.
- The agent is **monitoring-only** — no command execution, no file reads, no arbitrary shell. Terminal access is via the dashboard's existing SSH-over-WS bridge.
- The systemd units (`agent` and `dashboard`) enable `NoNewPrivileges`. The agent additionally uses `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and a narrow `ReadWritePaths` whitelist.

If you find a security issue, please open an issue marked **security** — or, for sensitive reports, email the address in `package.json`.

## License

MIT — see [`LICENSE`](./LICENSE) if present, otherwise treat this repository as MIT-licensed.

## Acknowledgements

Built on the shoulders of: [Next.js](https://nextjs.org), [Drizzle ORM](https://orm.drizzle.team), [ssh2](https://github.com/mscdex/ssh2), [xterm.js](https://xtermjs.org), [portable-pty](https://github.com/wez/wezterm/tree/main/pty), [sysinfo](https://github.com/GuillaumeGomez/sysinfo), [Tailwind CSS](https://tailwindcss.com), and the [Catppuccin](https://github.com/catppuccin/catppuccin) / [Tokyo Night](https://github.com/folke/tokyonight.nvim) / [Nord](https://www.nordtheme.com) / [Dracula](https://draculatheme.com) / [Gruvbox](https://github.com/morhetz/gruvbox) / [Solarized](https://ethanschoonover.com/solarized) palettes.
