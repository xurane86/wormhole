#!/usr/bin/env bash
# wormhole agent launcher (Linux/macOS)
# Usage: ./start-agent.sh [ui-port]
set -e

cd "$(dirname "$0")"

UI_PORT="${1:-7810}"
CONFIG="$(pwd)/agent-config.json"

echo "================================================"
echo " wormhole agent"
echo " UI:     http://127.0.0.1:${UI_PORT}"
echo " Config: ${CONFIG}"
echo "================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node not found in PATH. Install Node.js 18+ first."
  exit 1
fi

if [ ! -d "../node_modules" ]; then
  echo "[INFO] Installing dependencies..."
  (cd .. && npm install --no-audit --no-fund)
fi

exec node "$(pwd)/index.js" --ui-port "$UI_PORT" --config "$CONFIG"
