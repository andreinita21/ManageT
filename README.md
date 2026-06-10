<div align="center">

# ManageT

**A self-hosted control plane for a fleet of SSH-accessible servers — persistent terminals, terminal groups, service stacks, live metrics, a synced command palette, and a Rust agent that installs itself.**

[![Made with Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Rust agent](https://img.shields.io/badge/agent-Rust-orange?logo=rust)](./agent)
[![SQLite + Drizzle](https://img.shields.io/badge/db-SQLite-blue?logo=sqlite)](https://orm.drizzle.team)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#license)

[Quick reference](#quick-reference) · [Features](#features) · [Architecture](#architecture) · [Quick start](#quick-start) · [Terminals](#terminals) · [Groups](#terminal-groups) · [Stacks](#stacks) · [Command palette](#command-palette) · [Images into terminals](#sending-images-into-terminals) · [CLI](#the-managet-cli) · [Themes](#theming) · [Security](#security)

</div>

---

## Quick reference

Everything you'd come back to this page to look up. The "what is what and how" follows below.

### Commands

```bash
# Sessions (local agent — works offline from the dashboard)
managet new [NAME] [-c CMD] [--no-attach]   # create a persistent session + attach
managet ls [sessions|groups|stacks]          # list everything (-s / -g / -st filters)
managet attach <id|name>                     # attach (prefix match works)
managet kill <id|name>                       # SIGTERM the session's root process

# Dashboard-backed (run `managet login` once per host/user)
managet login                                # get a bearer token → ~/.config/managet/config.toml
managet groups                               # list terminal groups
managet group attach <name>                  # open a group as a CLI mosaic
managet stacks                               # list stacks + runtime state
managet stack open <name>                    # open a stack as a CLI mosaic
managet stack launch <name>                  # launch a stack's services
managet stack new | edit <name>              # interactive stack editor
managet theme list | set <name>              # mosaic color/line themes

# Agent admin (usually driven by the dashboard)
managet-agent install | run | status | uninstall
managet-agent reconfigure [--api-url URL] [--interval-secs N] [--bar-color C] [--bar-fields LIST]

# Dashboard host
npm run dev | build | start                  # dev / production bundle / serve
bash scripts/build-and-deploy-cli.sh         # rebuild + push the CLI to all hosts (no agent restart)
```

### Keybindings — `managet attach` (single session)

| Keys | Action |
|---|---|
| `Ctrl-A d` | Detach (session keeps running) |
| `Ctrl-A p` | Command palette — `1-9`/`Enter` paste, `a` add, `e` edit, `d` delete, `Shift-↑↓` move, `Esc` close |
| `Ctrl-A g` | Add this session to a group / create one, then jump into its mosaic |
| `Ctrl-A Ctrl-A` | Send a literal Ctrl-A through to the shell |

### Keybindings — mosaics (`managet group attach` / `managet stack open`)

| Keys | Action | Group | Stack |
|---|---|:-:|:-:|
| `Ctrl-A d` | Detach from the mosaic | ✅ | ✅ |
| `Ctrl-A 1-6` | Focus pane N | ✅ | ✅ |
| `Ctrl-A [` / `]` | Cycle focus | ✅ | ✅ |
| `Ctrl-A s` | **Swap** two panes (persisted order) | ✅ | ✅ |
| `Ctrl-A v` | **Layout** arrangement picker (persisted) | ✅ | ✅ |
| `Ctrl-A r` | Resize mode — arrows grow/shrink, Enter persists, Esc reverts | ✅ | ✅ |
| `Ctrl-A p` | Command palette → pastes into the **focused** pane | ✅ | ✅ |
| `Ctrl-A n` | Add a terminal to the group (inline picker) | ✅ | — |
| `Ctrl-A x` | Remove focused pane from the group (shell keeps running) | ✅ | — |
| `Ctrl-A k` | Kill the focused session (with confirm) | ✅ | — |

### Web UI quick map

| Where | Control | Action |
|---|---|---|
| Any terminal pane | `Ctrl+V` / drag-drop / 📷 | Send an image — uploads to the host, pastes its path (Claude Code attaches it as `[Image #N]`) |
| Terminal tab bar / mosaic pane bar | `>_` | Command palette — `1-9` pastes into that pane, `↑↓`+`Enter`, per-row edit/delete/move |
| `/groups/<id>` header | arrangement picker | Choose the row split (e.g. `3+1`, `2+2`) |
| `/groups/<id>` / `/stacks/<id>/terminals` | drag a pane's title bar | Swap two panes (persisted) |
| Pane dividers | drag | Resize rows/columns (persisted per user) |
| `/terminal` | `+` | New session on a server, or re-attach a saved one |

---

## What it is

ManageT is the dashboard you keep open on the second monitor to run a homelab, a hobby cluster, or a small production fleet. You add a server by host + SSH credentials, and the dashboard:

1. SSHes in, detects the OS/architecture, and installs a small Rust **agent** as a system service (`systemd` on Linux, `launchd` on macOS).
2. The agent pushes resource snapshots back every 10s; the dashboard derives `healthy`/`unreachable` from heartbeat freshness rather than from whether a terminal is open.
3. PTY sessions live inside the agent, **not** in the browser. Close the tab, refresh the page, restart the dashboard — `npm run dev`, `vim`, `htop`, a half-finished migration, a running Claude Code session — they all keep running. Reopening the tab reattaches and **replays the agent's scrollback** so you walk back in to context.
4. Arrange terminals into **Groups** (a resizable browser mosaic that also opens in the CLI) and **Stacks** (named services launched as a unit).
5. A per-user **command palette** (9 saved commands) and **image paste** bridge the gap between your laptop and the remote terminal — both designed around driving TUI tools like Claude Code on headless boxes.
6. Every UI surface and the terminal itself are **themable** — Catppuccin, Solarized, Dracula, Nord, Gruvbox, Tokyo Night, classic xterm, plus a custom-palette builder.

It is **monitoring + remote control**, not orchestration. There is no Docker Swarm, no Kubernetes: the dashboard does its own SSH work for terminals and lifecycle, and the agent owns the PTYs and telemetry.

## Features

### Terminals
- Persistent PTYs in the agent — survive browser close, dashboard restart, network blips.
- Scrollback replay on attach (4 MiB ring per session) so reopening a tab puts you where you left off.
- **Size that follows you**: every attach carries the client's rows/cols, the agent resizes the PTY (SIGWINCH) before you see a frame, and when you re-attach at a *different* shape (laptop → monitor) the client clears the stale old-width replay and forces a full repaint — no more zoom-in/zoom-out dance to fix garbled TUIs.
- Multi-client: a browser tab and a `managet attach` in SSH share the same live PTY.
- Paste images and saved commands straight into any pane (see below).
- Stable across React StrictMode double-mounts, the xterm renderer-init race, and UTF-8 chunk boundaries (each of those was a real bug we hit and fixed).

### Terminal groups
- Put up to 6 sessions (from any mix of servers) into a named group and view them as a **resizable mosaic** in the browser.
- **Arrangement picker** — choose the row split (e.g. `3+1`, `2+2`, single row); drag dividers to fine-tune row heights / column widths.
- **Drag a pane's title bar onto another pane to swap** their positions.
- Per-pane font-size bump (+/−) and inline rename; hovering a server's resource tile highlights every pane on that host.
- Order, arrangement, and sizes persist per user — and the same group opens as a mosaic **in the CLI** (`managet group attach <name>`) with the same layout.

### Stacks
- Define a stack as a list of `(server, service name, command)` tuples.
- **Launch** is idempotent by default — services already running are reused; `?force=1` kills + respawns.
- `/stacks/<id>/terminals` shows every service's PTY in a mosaic with the same **arrangement picker** and **drag-to-swap** as groups; per-pane CPU/RAM readouts come from the runtime poll.
- Layout and service order persist per user and are **shared with the CLI** mosaic (`managet stack open`) — change it in one place, the other follows.
- **Trash** workflow with restore/force-delete so accidentally-trashed stacks aren't gone forever.

### Command palette
- Up to **9 saved commands** (slot = hotkey), each with an optional label, synced to your profile across all servers and both UIs.
- Web: a `>_` button on the terminal tab bar and on every group-mosaic pane; **press 1–9** to paste into that pane.
- CLI: **Ctrl-A P** inside `managet attach`, `managet group attach`, and `managet stack open`.
- Full add / edit / delete / reorder from every surface. Pastes use bracketed paste with no Enter appended — multi-line prompts land in Claude Code as a single paste, and shell commands wait for you to confirm.

### Sending images into terminals
- **Ctrl+V a screenshot into the web terminal** (or drag-drop an image file, or use the 📷 button) — the dashboard uploads it over the existing SSH connection to `/tmp/managet-img-*.png` on the session's host and pastes the path into the PTY.
- That is byte-for-byte what drag-dropping an image onto a local terminal does, so **Claude Code attaches it as `[Image #N]`** immediately.
- Works no matter how you're attached: the path lands in the shared PTY, so an SSH `managet attach` view sees it too. (A literal remote Ctrl+V can't exist — headless servers have no clipboard; the path is the transport.)
- Server-side the upload is validated by magic bytes (png/jpeg/gif/webp, 10 MB cap) and requires the operator role.

### Monitoring
- Per-host CPU / memory / disk / load / active-connection metrics with bucket-aggregated graphs (1h / 6h / 24h windows).
- Per-session CPU/RAM attribution: the collector walks each PTY's process tree from the shell root.
- Alerts engine subscribed to a snapshot event bus published by the heartbeat route.
- Background metric pruner keeps the SQLite DB from growing unbounded.

### Theming (full UI + terminals)
- 11 curated presets: **Catppuccin** Mocha / Macchiato / Frappé / Latte, xterm default, Solarized Dark + Light, Dracula, Nord, Gruvbox, Tokyo Night.
- One choice drives the dashboard chrome *and* the xterm terminal palette; custom themes get per-colour native pickers + hex inputs for every UI tone and every ANSI slot.
- The CLI group/stack mosaics have their own theme catalog (`managet theme list|set`, or Settings → Mosaic themes), including user-defined themes.
- Terminal font family + size are configurable per user and applied live to every running terminal.

### Security & auth
- **Role-based authorization** on every API route: `viewer` (read-only) < `operator` (sessions, stacks, groups, palette, image upload) < `admin` (host exec, agent installs, fan control).
- **CLI bearer tokens** (`managet login`) with expiry, revocation, and login rate limiting; browser routes use NextAuth cookies, `/api/cli/*` accepts only tokens.
- SSH **host-key verification** (trust-on-first-use pinning), encrypted-at-rest SSH credentials, and **checksum-verified agent binaries** before any fleet push.

### Operability
- Auto-reconciliation: every 60s the dashboard re-imports any agent session it didn't know about and marks DB-only sessions `closed`.
- One-shot cleanup script (`scripts/cleanup-orphan-sessions.ts`) diffs each agent against the DB and surgically terminates orphans.
- `scripts/deploy-cli.ts` / `scripts/build-and-deploy-cli.sh` push a rebuilt `managet` CLI to every host (Linux: prebuilt upload; macOS: compiled on-host) **without restarting agents**, so live sessions survive CLI rollouts.
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
│   • REST (auth, sessions, stacks, groups, palette, metrics)      │
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
│   │ • /var/run/managet.sock  │    │   claude / services        │   │
│   └────────────┬─────────────┘    └────────────────────────────┘   │
│                │ HTTP POST                                         │
│                ▼                                                   │
└──────────────────────────────────────────────────────────────────┘
   POST /api/agent/heartbeat ─┐
                              │
                              ▼
                       Dashboard (back to top)
```

The PTY byte stream and the control protocol both ride a **forwarded Unix socket** over the already-open SSH connection — no extra ports on managed hosts. The `managet` CLI on a host talks to the same socket locally, which is why a browser tab and an SSH attach see the same session.

### How status works

Server status is derived from the **agent's last heartbeat**, not from whether the dashboard currently has an SSH session open. A production box that nobody is watching still shows as `healthy`; a box that dies mid-session flips to `unreachable` within ~30s regardless of whether a terminal is attached.

Transitions:

- `not_installed` → `installing` — when you add a server, the dashboard SSHes in, detects the OS/arch, and looks for a cached binary under `data/agent-binaries/<target>/`. If one exists it's SFTP-uploaded directly (after a checksum integrity gate); if not, the dashboard bootstraps `rustup` on the target, ships the agent source, and runs `cargo build --release` on the remote host. Either way, it then runs `managet-agent install --non-interactive`.
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

Default login: `admin@managet.local` / `admin`. **Change this for any deployment that's not strictly local.**

You do **not** need to pre-build the Rust agent before adding servers. When you add a server whose architecture isn't already cached in `data/agent-binaries/`, the dashboard SSHes in, installs `rustup` if needed, ships the source, and compiles the agent on the target itself (~5–10 minutes on first install). The compiled binary is cached so every subsequent server with the same architecture installs in seconds.

## Production deployment

The repo ships a systemd unit + installer for running the dashboard on the same kind of Linux host it manages.

```bash
npm run build                       # build the production bundle
sudo bash deploy/install-systemd.sh # install + enable the unit

sudo systemctl status   managet     # current state
sudo systemctl restart  managet     # apply a code update
journalctl -u managet -f            # tail live logs
```

The installer is idempotent — re-running it after a `git pull && npm ci && npm run build` safely restarts the service in place. There's also `deploy/managet.user.service` for hosts where you don't have root.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MANAGET_DASHBOARD_URL` | `http://<hostname>:$PORT` | Absolute URL the agent POSTs its heartbeats to. Set this in production. |
| `PORT` | `3000` | HTTP port the dashboard binds to. |
| `NODE_ENV` | `development` | Standard Next.js env. `npm start` sets it to `production`. |
| `DATABASE_URL` | `file:./data/managet.db` | SQLite database path. |
| `MANAGET_ENCRYPTION_KEY` | *(required in `.env.local`)* | 32-byte hex key used to encrypt stored SSH credentials. |

## Terminals

The browser terminal lives in two main places:

- **`/terminal`** — a tabbed full-screen view. `?server=<id>` opens a brand-new session on that server; `?session=<id>` re-attaches to an existing one. The **`+`** button picks a server or re-attaches a saved session; closing a tab kills its session (browser/tab *crash* does not — the PTY survives and shows up on `/sessions`).
- **Group / stack mosaics** — multiple panes on one screen (below).

Every pane's top-bar buttons:

| Button | What it does |
|---|---|
| `>_` | Open the **command palette** for this pane (press 1–9 to paste). |
| 📷 | Pick an image to send to this pane (Ctrl+V / drag-drop on the terminal do the same). |

Attach/re-attach behavior worth knowing:

- The PTY is resized to **your** window on every attach, so moving between a laptop and a monitor just works. When the shape changed, the stale replay (rendered for the old width) is cleared and the running app is nudged into a full repaint — you get a clean screen ~1s after attach instead of interleaved garbage.
- If two views of the same session are open *simultaneously* at different sizes, the last one to attach wins (same trade-off as tmux without aggregate-size).
- History painted at a previous width can't be reflowed (the agent stores rendered bytes); on a shape change you get a clean live screen instead of mangled history.

## Terminal groups

Create a group from any session (the **⊞ group button** on `/terminal`, or `Ctrl-A G` inside a CLI attach), then open it:

- **Browser** `/groups/<id>` — the mosaic. Drag title bars to swap panes, drag dividers to resize, pick the row arrangement from the header (e.g. `3+1` vs `2+2`), bump per-pane font sizes, rename sessions inline. The header shows per-server resource tiles; hovering one highlights its panes.
- **CLI** `managet group attach <name>` (or `managet group open <id>`) — the same group as a multi-pane terminal mosaic over the dashboard's WebSocket, with the same persisted layout.

Everything you arrange (order, row split, sizes, fonts) is stored per user, so your layout follows you between browsers and into the CLI.

## Stacks

Define services once, launch them as a unit, watch them as a mosaic:

- `/stacks` — create/edit stacks, launch/stop, per-service runtime (CPU/RAM, running state), trash/restore.
- `/stacks/<id>/terminals` — every service's terminal in a mosaic with the arrangement picker and drag-to-swap; service order and layout persist per user and sync with the CLI.
- CLI: `managet stacks` (list), `managet stack launch <name>`, `managet stack open <name>` (mosaic), `managet stack new` / `edit` (interactive editor in the terminal).

## Command palette

Up to 9 commands, each bound to a slot (its hotkey), with an optional label. One list per user, shared everywhere:

| Surface | Open it with | Keys inside |
|---|---|---|
| Web — `/terminal` tab bar | `>_` button | `1-9` paste · `↑↓`+`Enter` · click · per-row edit/delete/move |
| Web — group mosaic pane bar | `>_` button | same |
| CLI — `managet attach` | `Ctrl-A P` | `1-9`/`Enter` paste · `a` add · `e` edit · `d` delete · `Shift-↑↓`/`[` `]` move · `Esc` |
| CLI — `managet group attach` | `Ctrl-A P` | same (pastes into the **focused** pane) |
| CLI — `managet stack open` | `Ctrl-A P` | same |

Storage is the `palette_commands` table, exposed at `/api/palette` (browser) and `/api/cli/palette` (bearer token). Saves replace the whole ordered list, so reorder is atomic; both UIs re-fetch on open, so edits made anywhere show up everywhere.

Paste semantics: the command is pasted **without a trailing Enter**, wrapped in bracketed-paste markers when the target app has the mode enabled (the CLI watches the PTY output for DECSET 2004; the web uses xterm's native paste). That means multi-line prompts arrive in Claude Code as one paste block, and shell one-liners sit at the prompt until you confirm.

## Sending images into terminals

The flow (built for "screenshot → Claude Code on a headless box"):

1. Copy a screenshot, focus the web terminal, **Ctrl+V** (or drag an image file onto it, or click 📷 and pick a file).
2. The dashboard validates it (magic bytes, ≤10 MB), SFTPs it to `/tmp/managet-img-<id>.<ext>` (world-readable — the PTY user and the SSH user often differ) on the host that owns the session.
3. The remote path is pasted into the PTY via bracketed paste. Claude Code resolves pasted image paths exactly like a local drag-drop and shows `[Image #N]`.

Because the paste goes into the shared PTY, this also works while you're attached from a plain SSH terminal: keep a browser tab on the same session as the courier, Ctrl+V the image there, and the path appears at the prompt in your SSH view. Files are cleaned up by the OS's normal `/tmp` reaping.

## The `managet` CLI

The agent installs two binaries on every managed host:

- **`managet`** — the day-to-day verbs. Designed to feel like `tmux` if `tmux` knew about your dashboard.
- **`managet-agent`** — the service binary and low-level admin verbs (install, run, uninstall, reconfigure, status). The dashboard drives it for you.

### Sessions (local agent)

```bash
managet new [NAME] [-c CMD] [--no-attach]   # create + attach in one step
managet ls [sessions|groups|stacks]          # everything the agent + dashboard know about
managet attach <id|name>                     # attach by name, id, or unambiguous prefix
managet kill <id|name>                       # SIGTERM the session's root process
```

`managet new` details that matter:

| Situation | Behaviour |
|---|---|
| stdout is a TTY | Auto-attach — banner + fresh shell. |
| stdout is NOT a TTY (`ssh host "managet new …"`, CI) | Prints `Created session <id>` + attach hint, exits. |
| `-c "<cmd>"` | Runs `<cmd>` inside the session, then drops to your login shell so the session outlives the command. |
| Working directory | The directory you ran it from, not `$HOME`. |
| User identity | The session runs as **you** (via `su -l`), even though the agent runs as root — PAM env, login shell, and job control included. |

`managet ls` shows `attached×N` (N live clients across CLI + browser) vs `detached`; closing a browser tab only decrements the count, it never kills the session. While attached you get a one-line banner, the terminal tab title set to `managet: <session>@<host>`, and native scrollback (mouse wheel, find, Shift+PgUp) over the full history.

### Dashboard-backed verbs (need `managet login` once per host/user)

```bash
managet login                # exchange dashboard credentials for a bearer token (~/.config/managet/config.toml)
managet groups               # list terminal groups
managet group attach <name>  # open a group as a CLI mosaic
managet stacks               # list stacks with runtime state
managet stack open <name>    # open a stack as a CLI mosaic
managet stack launch <name>  # launch services
managet stack new|edit       # interactive stack editor
managet theme list|set       # mosaic color/line themes
```

### Keybindings

All multiplexer keys are behind the **Ctrl-A** prefix (press `Ctrl-A`, release, then the key — `Ctrl-A Ctrl-A` sends a literal Ctrl-A through). The full tables live in the [Quick reference](#quick-reference) at the top of this page; the hint bar at the bottom of each mosaic also lists exactly what's available there.

### Agent admin (`managet-agent`)

```bash
managet-agent install [--non-interactive --api-url … --server-id … --token …]
managet-agent run | status | uninstall
managet-agent reconfigure [--api-url URL] [--interval-secs N] [--bar-color C] [--bar-fields LIST]
```

`reconfigure` mutates `/etc/managet-agent/config.toml` (daemon: dashboard URL, heartbeat interval — restart required) and `bar.toml` (the attach banner color/fields — picked up on next attach). The dashboard's **Settings → Servers → Agent** modal drives the same flags and restarts the service when needed.

### Where things live on disk

| Path | Purpose |
|---|---|
| `/usr/local/bin/managet-agent` | Service binary (run by systemd / launchd). |
| `/usr/local/bin/managet` | User-facing CLI. |
| `/etc/managet-agent/config.toml` (Linux) / `/usr/local/etc/managet-agent/config.toml` (macOS) | Dashboard URL, server id, token, heartbeat interval. `0600` root-only. |
| `/etc/managet-agent/bar.toml` | Attach banner colour + field order. |
| `/var/run/managet/agent.sock` | Unix socket the CLI + dashboard speak the agent protocol over. |
| `~/.config/managet/config.toml` | Per-user CLI login (dashboard URL + bearer token, `0600`). |
| `/etc/systemd/system/managet-agent.service` / `/Library/LaunchDaemons/com.managet.agent.plist` | Service unit. |

See [`agent/README.md`](./agent/README.md) for the agent's internal protocol and the full subcommand reference.

## Theming

Themes live under **Settings → Appearance**. Picking a preset re-skins the whole dashboard *and* every open terminal in the same render — the dashboard mutates `--color-mg-*` CSS variables on `documentElement`, and the terminal palette is fed into xterm's runtime options.

| Family | Variants |
|---|---|
| ManageT | Purple (default) |
| Catppuccin | Mocha, Macchiato, Frappé, Latte |
| Classic | xterm default |
| Solarized | Dark, Light |
| Community | Dracula, Nord, Gruvbox, Tokyo Night |
| Custom | per-colour native picker + hex input for every UI tone and every xterm ANSI slot |

Terminal font family + size are independent from the colour theme. The CLI mosaics (group/stack views) have their own theme catalog under **Settings → Mosaic themes** — built-in presets plus user-defined ones, applied via `managet theme set` or the settings UI. Everything is stored per user in `user_preferences` and applied live.

## Project layout

```
.
├── agent/                  # Rust agent + managet CLI (see agent/README.md)
├── data/                   # runtime data — SQLite DB + cached binaries
├── deploy/                 # systemd unit + installer + macos plist
├── drizzle/                # migrations + journal
├── scripts/                # one-shot ops + dev tools
├── src/
│   ├── app/                # Next.js app router pages + /api routes
│   ├── components/         # UI + terminal panes + settings tabs
│   ├── lib/
│   │   ├── agent/          # agent install + status sweeper
│   │   ├── auth/           # NextAuth + role guards
│   │   ├── cli-auth/       # CLI bearer tokens
│   │   ├── db/             # Drizzle schema + transforms
│   │   ├── monitor/        # alerts, pruner, session reconciler, metrics buckets
│   │   ├── ssh/            # connection pool, session manager, agent socket, sftp
│   │   ├── stacks/         # stack runtime + launch/stop + layout/order
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

## Useful one-shot scripts

| Script | What it does |
|---|---|
| `bash scripts/build-and-deploy-cli.sh` | Rebuild the `managet` CLI and push it to every managed host **without restarting agents** (live sessions survive). |
| `npx tsx scripts/deploy-cli.ts <binary>` | The underlying pusher — SFTP + `sudo install` on Linux, compile-on-host for macOS. |
| `npx tsx scripts/cleanup-orphan-sessions.ts` | Reports agent sessions with no DB row. `--apply` exits each through the attach stream. |
| `python3 scripts/benchmark-memory-storage.py` | Measures agent/dashboard RSS + disk across the fleet, emits a `.docx` report with charts. |
| `npx tsx scripts/diagnose-agent.ts <serverId>` | Dumps service state, config, recent logs, and connectivity from a target host. |
| `npx tsx scripts/seed.ts` | Idempotent DB seeder; migrations + default admin. |

## Roadmap

- **Agent kill path** — `su -l` shells can survive a single SIGTERM; the reconciler + cleanup script work around it until the agent-side `killpg` fix lands.
- **Sessions surviving agent restart** — restarting the agent daemon drops its in-memory PTY map; a tmux-style per-session helper is sketched but not built.
- **Simultaneous multi-view sizing** — two clients on one session at different sizes follow last-attach-wins; tmux-style smallest-client aggregation would need per-connection resize in the agent protocol.
- **Backups** — no automated DB backup yet; SQLite + a daily `cp` is fine for a homelab.

## Security

- **Roles enforced end-to-end**: `viewer` reads, `operator` mutates sessions/stacks/groups (and uploads images, edits the palette), `admin` touches hosts (exec, agent install, fan control).
- SSH credentials are encrypted at rest with `MANAGET_ENCRYPTION_KEY` (AES-GCM). Only ciphertext lands in SQLite.
- SSH **host keys are pinned** on first connect (TOFU) and verified on every reconnect.
- The agent token is a 32-byte random value; only its SHA-256 is stored dashboard-side. CLI bearer tokens expire, can be revoked, and the login endpoint is rate-limited.
- Cached agent binaries are **checksum-gated** before being pushed to the fleet.
- Image uploads are validated by content (magic bytes), not by client-declared MIME type, and capped at 10 MB.
- The systemd units enable `NoNewPrivileges`; the agent additionally uses `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and a narrow `ReadWritePaths` whitelist.

If you find a security issue, please open an issue marked **security** — or, for sensitive reports, email the address in `package.json`.

## License

MIT — see [`LICENSE`](./LICENSE) if present, otherwise treat this repository as MIT-licensed.

## Acknowledgements

Built on the shoulders of: [Next.js](https://nextjs.org), [Drizzle ORM](https://orm.drizzle.team), [ssh2](https://github.com/mscdex/ssh2), [xterm.js](https://xtermjs.org), [portable-pty](https://github.com/wez/wezterm/tree/main/pty), [vt100](https://crates.io/crates/vt100), [sysinfo](https://github.com/GuillaumeGomez/sysinfo), [Tailwind CSS](https://tailwindcss.com), and the [Catppuccin](https://github.com/catppuccin/catppuccin) / [Tokyo Night](https://github.com/folke/tokyonight.nvim) / [Nord](https://www.nordtheme.com) / [Dracula](https://draculatheme.com) / [Gruvbox](https://github.com/morhetz/gruvbox) / [Solarized](https://ethanschoonover.com/solarized) palettes.
