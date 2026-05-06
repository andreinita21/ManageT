#!/usr/bin/env bash
#
# build-release.sh — build managet-agent release binaries for the supported
# targets and drop them into data/agent-binaries/<target>/managet-agent.
#
# By default, builds every target for which the current Rust toolchain has
# the right standard library installed. Override via TARGETS env var:
#
#   TARGETS="aarch64-apple-darwin" bash agent/scripts/build-release.sh
#
# If you want the full Linux cross-build set, you need rustup (not Homebrew's
# Rust) because Homebrew ships only the host target. Install rustup, then:
#
#   rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
#
# Cross-compiling *to Linux from macOS* additionally requires a musl-cross
# toolchain in PATH — e.g. `brew install FiloSottile/musl-cross/musl-cross`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$AGENT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/data/agent-binaries"

DEFAULT_TARGETS=(
    "x86_64-unknown-linux-musl"
    "aarch64-unknown-linux-musl"
    "aarch64-apple-darwin"
    "x86_64-apple-darwin"
)

# Allow caller to override the target set.
if [[ -n "${TARGETS:-}" ]]; then
    # shellcheck disable=SC2206
    REQUESTED=($TARGETS)
else
    REQUESTED=("${DEFAULT_TARGETS[@]}")
fi

# Detect what's actually buildable.
have_rustup=0
if command -v rustup >/dev/null 2>&1; then
    have_rustup=1
fi

host_target=$(rustc -vV 2>/dev/null | awk '/host:/ {print $2}')

installed_targets=""
if [[ $have_rustup -eq 1 ]]; then
    installed_targets=$(rustup target list --installed 2>/dev/null || true)
fi

is_target_available() {
    local t="$1"
    if [[ "$t" == "$host_target" ]]; then
        return 0
    fi
    if [[ $have_rustup -eq 1 ]] && echo "$installed_targets" | grep -qx "$t"; then
        return 0
    fi
    return 1
}

echo "==> managet-agent release build"
echo "    host target:    $host_target"
echo "    rustup present: $([[ $have_rustup -eq 1 ]] && echo yes || echo no)"
echo "    output dir:     $OUT_DIR"
echo

mkdir -p "$OUT_DIR"

built_any=0
skipped_any=0

for target in "${REQUESTED[@]}"; do
    if ! is_target_available "$target"; then
        echo "--  skipping $target (toolchain not installed)"
        skipped_any=1
        continue
    fi

    echo "==> building $target"
    (cd "$AGENT_DIR" && cargo build --release --target "$target")

    bin_src="$AGENT_DIR/target/$target/release/managet-agent"
    cli_src="$AGENT_DIR/target/$target/release/managet"
    if [[ ! -f "$bin_src" ]]; then
        echo "!!  expected $bin_src but it doesn't exist" >&2
        exit 1
    fi
    if [[ ! -f "$cli_src" ]]; then
        echo "!!  expected $cli_src but it doesn't exist" >&2
        exit 1
    fi

    bin_dst_dir="$OUT_DIR/$target"
    mkdir -p "$bin_dst_dir"
    cp "$bin_src" "$bin_dst_dir/managet-agent"
    chmod 755 "$bin_dst_dir/managet-agent"
    cp "$cli_src" "$bin_dst_dir/managet"
    chmod 755 "$bin_dst_dir/managet"

    # SHA256 — both macOS (shasum) and Linux (sha256sum) supported.
    if command -v sha256sum >/dev/null 2>&1; then
        (cd "$bin_dst_dir" && sha256sum managet-agent managet > checksums.sha256)
    elif command -v shasum >/dev/null 2>&1; then
        (cd "$bin_dst_dir" && shasum -a 256 managet-agent managet > checksums.sha256)
    fi

    agent_size=$(wc -c < "$bin_dst_dir/managet-agent" | tr -d ' ')
    cli_size=$(wc -c < "$bin_dst_dir/managet" | tr -d ' ')
    echo "    ok: $bin_dst_dir/managet-agent ($agent_size bytes) + managet ($cli_size bytes)"
    built_any=1
done

echo
if [[ $built_any -eq 0 ]]; then
    echo "!!  no targets were buildable with the current toolchain" >&2
    echo "    install rustup and add the missing targets, then re-run." >&2
    exit 2
fi

if [[ $skipped_any -eq 1 ]]; then
    echo "==> done (some targets skipped — see hints above)"
else
    echo "==> done"
fi
