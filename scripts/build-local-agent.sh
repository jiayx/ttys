#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="$ROOT_DIR/apps/web/public/downloads/local"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH_VALUE="amd64" ;;
  arm64|aarch64) ARCH_VALUE="arm64" ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux)
    EXT=""
    OS_VALUE="$OS"
    ;;
  mingw*|msys*|cygwin*)
    EXT=".exe"
    OS_VALUE="windows"
    ;;
  *)
    echo "unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"

ASSET_NAME="ttys-agent-zig-$OS_VALUE-$ARCH_VALUE$EXT"

(
  cd "$ROOT_DIR/agent-zig"
  zig build
  cp "zig-out/bin/ttys-agent-zig$EXT" "$OUT_DIR/$ASSET_NAME"
)

if command -v shasum >/dev/null 2>&1; then
  (
    cd "$OUT_DIR"
    shasum -a 256 "$ASSET_NAME" | sed 's/ \*/  /' > checksums.txt
  )
elif command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$OUT_DIR"
    sha256sum "$ASSET_NAME" > checksums.txt
  )
else
  echo "warning: shasum or sha256sum not found; checksums.txt was not generated" >&2
fi

echo "built $OUT_DIR/$ASSET_NAME"
