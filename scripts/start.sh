#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVER_URL=${1:-http://127.0.0.1:5173}
SESSION_ID=${2:-}

cd "$ROOT_DIR/agent"

if [ -n "$SESSION_ID" ]; then
  exec go run ./cmd/ttys-agent -server "$SERVER_URL" -session "$SESSION_ID"
fi

exec go run ./cmd/ttys-agent -server "$SERVER_URL"
