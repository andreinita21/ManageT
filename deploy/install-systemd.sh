#!/usr/bin/env bash
#
# Install the ManageT dashboard as a systemd service so it boots with
# the host and restarts on crash. Run from the repo root with sudo:
#
#   sudo bash deploy/install-systemd.sh
#
# Idempotent — safe to re-run after pulling new code or editing the
# unit file in this directory; the new file is copied over and the
# service is reloaded + restarted.
#
# Prereqs:
#   - `npm run build` has been run at least once so .next/ is populated.
#   - node_modules/ are installed (npm ci or npm install).
#   - The companion agent service (managet-agent.service) is already
#     installed; this dashboard unit declares After= it but doesn't
#     require it (so the dashboard can still start if the agent is
#     temporarily disabled).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="${REPO_ROOT}/deploy/managet.service"
UNIT_DST="/etc/systemd/system/managet.service"

if [[ ${EUID} -ne 0 ]]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}/.next" ]]; then
  echo "error: ${REPO_ROOT}/.next is missing — run 'npm run build' first" >&2
  exit 1
fi

if [[ ! -x /usr/bin/node ]]; then
  echo "error: /usr/bin/node is missing — install Node 22+ system-wide" >&2
  exit 1
fi

echo "→ Installing ${UNIT_DST}"
install -m 0644 "${UNIT_SRC}" "${UNIT_DST}"

echo "→ Reloading systemd"
systemctl daemon-reload

echo "→ Enabling + starting managet.service"
systemctl enable --now managet.service

echo "→ Service status (Ctrl-C to exit)"
systemctl --no-pager --full status managet.service || true

cat <<EOF

Done. Useful commands:
  sudo systemctl status   managet     # current state
  sudo systemctl restart  managet     # restart after a deploy
  sudo systemctl stop     managet     # stop without disabling boot start
  sudo systemctl disable  managet     # remove from boot (keeps unit file)
  journalctl -u managet -f            # tail live logs

To deploy code changes:
  cd ${REPO_ROOT}
  git pull && npm ci && npm run build && sudo systemctl restart managet
EOF
