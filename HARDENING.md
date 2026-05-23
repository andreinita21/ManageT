# ManageT — Hardening notes and deferred follow-ups

This file tracks security / robustness items that were surfaced during
the v0.3.0 lifecycle pass but deliberately deferred. Each entry has a
**risk**, the **why-deferred** rationale, and a **fix sketch** so the
follow-up doesn't have to start from scratch.

Items already shipped in v0.3.0 are recorded at the bottom for
context.

## Deferred — known limitations

### 1. PTY socket is world-accessible (`0666` on `/var/run/managet/agent.sock`)

**Risk.** Any local user on a managed host can connect to the agent
socket and create / attach / kill sessions. Sessions run with the
agent's UID (root on installed hosts), so a non-admin local account
can use this to escalate to a root shell.

**Why deferred.** The intended deployment is single-admin Pi /
Mini hosts where everyone with shell access has sudo anyway, so the
socket permissions don't widen the attack surface meaningfully. The
proper fix touches the spawn path, the wrapper script, and the
on-host install flow.

**Fix sketch.**
- Restrict the socket to `0660` and chown to a new `managet` group;
  add the operator's UNIX user to it at install time.
- For multi-user isolation: route each request through a per-user
  socket (`/run/managet/sock.<uid>`) created lazily on first use,
  owned by the calling UID, with the agent dropping privileges via
  the existing `su -l <user>` path.
- Reject `New { user: Some(u) }` for any `u` other than the calling
  UID's username so a connected user can't request a shell as
  another user.

### 2. `DETACH_MARKER` is forgeable from inside a session

**Risk.** A program running inside the inner shell can `printf` the
exact OSC-7777 byte sequence and force every attached client to
disconnect. Because the session itself stays alive, the impact is
limited to "annoy other co-attached operators." Real exploits are
indistinguishable from the user typing `exit` (they can already
do that).

**Why deferred.** Low impact in a single-admin world. A proper
mitigation requires per-session randomness in the marker, which the
wrapper would have to receive as an env var (`ps`-visible to local
users) or via a side channel.

**Fix sketch.**
- Generate a random 16-byte token at session creation, pass via
  `MANAGET_DETACH_NONCE` (env, not argv, so it doesn't show in
  `ps -ef`). The wrapper interpolates the nonce into the marker;
  the agent reader matches the per-session pattern. Local users
  reading `/proc/<pid>/environ` could still spoof it (the file is
  mode 0600 on Linux, so only root or the owning UID can read it
  — see item 1 for the related fix).

### 3. Reader marker matcher is O(n·m) per chunk

**Risk.** Naive `find_subslice` runs `O(chunk_size · marker_len)` =
`O(4096 · 25)` per PTY read. Not a DoS vector — single-digit
microseconds per chunk — but worth a note if a future change
extends the marker dramatically.

**Why deferred.** Numerically negligible at current marker size.

**Fix sketch.** Boyer-Moore or KMP if it ever matters. Or just
hard-cap the marker length in the constant.

### 4. Heartbeat reaches the dashboard over plain HTTP on LAN deploys

**Risk.** Bearer-token credentials on the wire are visible to anyone
sniffing the LAN segment between an agent and a dashboard on
`http://192.168.x.y`.

**Why deferred.** Out of scope for this pass; covered by the existing
deployment guidance that recommends Cloudflare tunnel / Tailscale /
similar so even LAN traffic terminates TLS at the proxy.

**Fix sketch.** Either (a) require `https://` in `api_url` and
refuse plaintext during `install`, or (b) ship a mode where the
agent uses mTLS with a pinned dashboard CA. (a) is the smaller
change and probably enough for v0.4.

### 5. No CSRF token on top-level dashboard mutations

**Risk.** Cookie-based session means `<form>` posts from a malicious
origin could trigger state changes if the user is logged in. The
new WebSocket layer now has an Origin check (v0.3.0); REST routes
do not.

**Why deferred.** App is small and uses fetch with custom headers;
non-trivial to exploit but worth a defensive layer.

**Fix sketch.** Set `SameSite=Strict` on the session cookie (NextAuth
default is `Lax`); add a double-submit token to mutating routes.

### 6. PTY scrollback is unbounded per-session-count

**Risk.** Each session caps scrollback at 4 MB. With per-server
`maxSessions` enforced, this is bounded — but the dev-mode default
(no cap) lets a runaway operator spin up unlimited sessions and
consume RAM.

**Why deferred.** `maxSessions` already exists; default should
probably be set to a non-null value (e.g. 50) in fresh installs.

**Fix sketch.** Change the default in the schema migration / form
default to `50`, document in README.

### 7. No log injection guard on session names in agent logs

**Risk.** A session name containing escape sequences could be
emitted into the agent's structured log (`tracing::info!`),
manipulating any operator who tails it with a colour-rendering
viewer.

**Why deferred.** v0.3.0 added `is_safe_session_name` in the
protocol handler (server.rs), which already filters out non-graphic
ASCII and path separators. The remaining concern is purely
cosmetic.

## Shipped in v0.3.0

- WebSocket upgrade: validates the NextAuth JWT cookie via
  `getToken`; rejects on missing / bad / expired session. Drops
  the `?token=…` query-param escape hatch entirely.
- WebSocket upgrade: rejects requests whose `Origin` header doesn't
  match the host (or `NEXTAUTH_URL`) — CSRF defence.
- Per-session attach cap (32 simultaneous) so a runaway client
  can't fan out a single PTY into thousands of subscribers.
- PTY dimensions clamped to `[8, 500]` on every `New` / `Attach` /
  `Resize` to refuse adversarial WINSZ values.
- Session-name allow-list (printable ASCII, no path separators or
  control codes, ≤80 chars) to keep dashboards and CLI tables safe.
- systemd unit gains `NoNewPrivileges`, `ProtectKernelModules`,
  `ProtectKernelTunables`, `ProtectClock`, `RestrictSUIDSGID`,
  `RestrictRealtime`, `RestrictNamespaces`, `LockPersonality`,
  and `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
  AF_NETLINK`. (Path-protection flags deliberately omitted because
  they'd block legitimate PTY shells touching `/home`, `/opt`,
  `/srv`, etc.)
- Agent SIGTERM handler broadcasts a shutdown pulse so attached
  clients see a labelled banner ("[managet] agent is shutting
  down…") instead of a frozen terminal.
- `KillSignal=SIGTERM` + `TimeoutStopSec=5` in the unit so the
  agent gets a real chance to broadcast that pulse before systemd
  escalates to SIGKILL.
