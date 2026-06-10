#!/usr/bin/env bash
# Build the managet CLI release binary and push it to every managed host
# (scripts/deploy-cli.ts). Run from anywhere; paths are absolute.
set -euo pipefail

REPO=/home/andrei/managet

cd "$REPO/agent"
cargo build --release --bin managet 2>&1 | tail -1

cd "$REPO"
set -a
# shellcheck source=/dev/null
. "$REPO/.env.local"
set +a
npx tsx scripts/deploy-cli.ts agent/target/release/managet

echo "--- local checksum check ---"
if [ "$(sha256sum "$REPO/agent/target/release/managet" | cut -d' ' -f1)" = "$(sha256sum /usr/local/bin/managet | cut -d' ' -f1)" ]; then
  echo "checksums match"
else
  echo "MISMATCH"
  exit 1
fi
