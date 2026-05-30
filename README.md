<div align="center">

# ManageT

**A self-hosted control plane for a fleet of SSH-accessible servers — persistent terminals, live metrics, stacks of services, and a Rust monitoring agent that installs itself.**

[![Made with Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Rust agent](https://img.shields.io/badge/agent-Rust-orange?logo=rust)](./agent)
[![SQLite + Drizzle](https://img.shields.io/badge/db-SQLite-blue?logo=sqlite)](https://orm.drizzle.team)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#license)

[Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Production deployment](#production-deployment) · [Command palette](#host-side-command-palette) · [Themes](#theming) · [Roadmap](#roadmap)

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

## Host-side command palette

The Rust agent installs two binaries on every managed host:

- **`managet`** — the day-to-day verbs for working with terminal sessions. Designed to feel like `tmux` if `tmux` knew about your dashboard.
- **`managet-agent`** — the long-running service binary and low-level admin verbs (install, run, uninstall, reconfigure). You rarely invoke this directly; the dashboard drives it for you when you click Add Server / Delete / Save in the Agent settings modal.

Detach from any attached session with **Ctrl+A then D** (tmux-style). To send a literal Ctrl+A through to your shell (readline's beginning-of-line), press **Ctrl+A then Ctrl+A**.

---

### `managet new [NAME] [-c CMD] [--no-attach]`

Create a persistent session **and attach to it in one step**. The session lives inside the agent process, survives detach / SSH disconnects / dashboard restarts, and is reachable from both this CLI and the web UI.

```bash
managet new                                  # random name, auto-attach
managet new devproject                       # named, auto-attach
managet new logs -c "tail -F /var/log/syslog"   # run a command, auto-attach
managet new build -c "cargo watch -x test" --no-attach   # spawn, stay put
```

| Situation | Default behaviour |
|---|---|
| **stdout is a TTY** (interactive shell) | Auto-attach — green banner + fresh shell. |
| **stdout is NOT a TTY** (`ssh host "managet new …"`, CI, automation) | Skip the attach. Prints `Created session <id>` and the attach hint, exits. |
| **`--no-attach`** | Force the no-attach path even from a TTY. |
| **`-c "<cmd>"`** | Runs `<cmd>` inside the new session, then drops into your login shell so the session stays alive after `<cmd>` exits. |
| **No name argument** | Auto-generated `session-<short-id>`. |
| **Working directory** | The new session starts in **the directory you ran `managet new` from**, not in `$HOME`. |
| **User identity** | The session runs as **you** (the invoking user), not as root — even though the agent itself runs as root. The drop is via `su -l <you> ...` using the platform's supported command form, so PAM env + a real login shell + full job control all come along for the ride. |

The legacy `-n / --name` long flag is still accepted (e.g. `managet new -n foo`) so older scripts keep working, but new invocations don't need it.

---

### `managet ls`

List every session the agent is currently managing on this host. Detached sessions stay listed until they're explicitly killed or their child exits.

```bash
$ managet ls
ID          NAME            AGE                     STATUS
3b0e1f24    devproject      2m13s                   attached×1
9a44f5e1    logs            45s                     detached
e8c0a719    session-abc     0s                      detached
```

`attached×N` means **N clients** (any mix of CLI + browser tabs) are watching the session live; `detached` means nobody is. Closing your browser tab does **not** count as killing the session — it just decrements the attach count.

---

### `managet attach <id|name>`

Attach to an existing session by short id, full id, or session name. Detach with **Ctrl+A then D**.

```bash
managet attach devproject
managet attach 3b0e1f24
managet attach 3b           # any unambiguous prefix
```

While attached you get:

- A **one-line green banner** at the top so the entry is unmissable: `❯ managet · session devproject · andrei@markI · Ctrl+A D to detach`. Scrolls naturally with the rest of the session.
- The terminal's **window/tab title** is set to `managet: <session>@<host>` — a persistent reminder that you're inside managet, visible in your terminal emulator's tab bar / titlebar.
- **Native scrollback** works exactly like a normal SSH shell. Shift+PgUp, mouse wheel, and your terminal's "find" all do what you'd expect over the full session history.
- **Multi-client attach**: someone in the dashboard browser tab + you in `managet attach` see the same live PTY. Type in one, the other sees it too.

The banner's colour and which fields it shows are configurable per host — see [`managet-agent reconfigure`](#managet-agent-reconfigure--api-url-url---interval-secs-n---bar-color-color---bar-fields-list) below, or set them from the dashboard at **Settings → Servers → Agent**.

---

### `managet kill <id|name>`

Send SIGTERM to the session's root process. Once the child exits, the session row is cleared from `managet ls` and from the dashboard.

```bash
managet kill devproject
managet kill 3b0e1f24
```

There's a known edge case with shells started via `su -l` that survive a single SIGTERM (see [Roadmap](#roadmap)); the dashboard's reconciler + `scripts/cleanup-orphan-sessions.ts` work around this until the agent-side proper fix lands.

---

### `managet-agent install [--api-url URL --server-id ID --token TOKEN] [--non-interactive]`

The first-time installer. Normally **you don't run this by hand** — the dashboard SSHes in and runs it on your behalf when you add a server. The interactive TUI mode (`managet-agent install` with no flags) is useful for sneakernet installs onto an air-gapped host where you can't reach the dashboard.

---

### `managet-agent run`

The long-running service entrypoint. systemd / launchd invokes this — not you. If you find yourself running it directly, you probably want `managet-agent status` instead.

---

### `managet-agent uninstall`

Stop the service, remove the service unit / plist, delete the config and binary, and exit. Run by the dashboard automatically when you click Delete on a server; you can also run it locally to undo a manual install.

---

### `managet-agent status`

Print the loaded config + one resource snapshot, then exit. Useful for debugging when heartbeats aren't landing in the dashboard.

```bash
$ sudo managet-agent status
config:
  api_url:   https://managet.example.com
  server_id: 87b03f46-77eb-44a3-bed7-22c3c4d5e600
  interval:  10s
snapshot:
  cpu_percent:    14.2
  memory_used_mb: 1840 / 8192
  disk_used_pct:  43.7
  …
```

---

### `managet-agent reconfigure [--api-url URL] [--interval-secs N] [--bar-color COLOR] [--bar-fields LIST]`

Mutate the on-disk config files (`/etc/managet-agent/config.toml` for the daemon, `/etc/managet-agent/bar.toml` for the attach banner) **without** running the full installer again. The dashboard uses this for the per-server "Dashboard URL", heartbeat-interval, and bar-customisation flows; you can also run it directly.

```bash
# Re-point an agent at a new dashboard URL — e.g. swap a LAN IP for a Cloudflare tunnel
sudo managet-agent reconfigure --api-url https://managet.example.com

# Slow the heartbeat down to once every 30 seconds
sudo managet-agent reconfigure --interval-secs 30

# Customise the banner shown when you `managet attach`
sudo managet-agent reconfigure --bar-color cyan \
                               --bar-fields session,user_host,duration,detach
```

| Flag | What it touches | Restart needed? |
|---|---|---|
| `--api-url URL` | `config.toml: api_url` | **Yes** — restart `managet-agent`. |
| `--interval-secs N` | `config.toml: heartbeat_interval_secs` | **Yes** — restart `managet-agent`. |
| `--bar-color COLOR` | `bar.toml: color` — one of `green` (default), `cyan`, `magenta`, `yellow`, `blue`, `red`, `white`, `gray`. | No — re-read on next `managet attach`. |
| `--bar-fields LIST` | `bar.toml: fields` — comma-separated, in order. Recognised keys: `session`, `user_host`, `duration`, `detach`. | No — re-read on next `managet attach`. |

The dashboard's push flow restarts the service for you whenever it issues a restart-required flag, so if you're driving this from **Settings → Servers → Agent** you don't have to think about it.

---

### Where things live on disk

| Path | Purpose |
|---|---|
| `/usr/local/bin/managet-agent` | Service binary (run by systemd / launchd). |
| `/usr/local/bin/managet` | User-facing CLI (what you actually type). |
| `/etc/managet-agent/config.toml` (Linux) | Dashboard URL, server id, token, heartbeat interval. `0600` root-only. |
| `/usr/local/etc/managet-agent/config.toml` (macOS) | Same, macOS path. |
| `/etc/managet-agent/bar.toml` | Attach banner colour + field order. |
| `/var/run/managet/agent.sock` | Unix socket the CLI + dashboard speak the agent protocol over. |
| `/etc/systemd/system/managet-agent.service` (Linux) | systemd unit. |
| `/Library/LaunchDaemons/com.managet.agent.plist` (macOS) | launchd plist. |

See [`agent/README.md`](./agent/README.md) for the agent's internal protocol and the full subcommand reference if you're hacking on the binary itself.

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
