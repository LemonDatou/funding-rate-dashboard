#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

exec "${PYTHON:-python3}" -m http.server "${DASHBOARD_PORT:-8000}" \
  --bind "${DASHBOARD_HOST:-127.0.0.1}" \
  --directory "$SCRIPT_DIR/web"
