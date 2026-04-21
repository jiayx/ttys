#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="$ROOT_DIR/apps/web/public/downloads/local"
CACHE_DIR="$ROOT_DIR/agent/.cache/go-build"
MOD_CACHE_DIR="$ROOT_DIR/agent/.cache/go-mod"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) GOARCH_VALUE="amd64" ;;
  arm64|aarch64) GOARCH_VALUE="arm64" ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux)
    EXT=""
    GOOS_VALUE="$OS"
    ;;
  mingw*|msys*|cygwin*)
    EXT=".exe"
    GOOS_VALUE="windows"
    ;;
  *)
    echo "unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"
mkdir -p "$CACHE_DIR"
mkdir -p "$MOD_CACHE_DIR"

ASSET_NAME="ttys-agent-$GOOS_VALUE-$GOARCH_VALUE$EXT"

(
  cd "$ROOT_DIR/agent"
  GOCACHE="$CACHE_DIR" GOMODCACHE="$MOD_CACHE_DIR" \
    GOOS="$GOOS_VALUE" GOARCH="$GOARCH_VALUE" CGO_ENABLED=0 \
    go build -o "$OUT_DIR/$ASSET_NAME" ./cmd/ttys-agent
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
