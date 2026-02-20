#!/bin/bash
# Start the Athena LLM bridge with Cloudflare tunnel
# Usage: ./bridge/start.sh [project_dir]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${1:-/Users/fredericlumiere/demomaker.ai}"
PORT="${BRIDGE_PORT:-8013}"

# Load env vars
if [ -f "$SCRIPT_DIR/../.env.local" ]; then
  set -a
  source "$SCRIPT_DIR/../.env.local"
  set +a
fi

export ATHENA_CWD="$PROJECT_DIR"
export BRIDGE_PORT="$PORT"

echo "=== Athena LLM Bridge ==="
echo "Project: $PROJECT_DIR"
echo "Port: $PORT"
echo ""

# Start the bridge server in background
echo "[1/2] Starting bridge server..."
cd "$SCRIPT_DIR/.."
npx tsx bridge/server.ts &
BRIDGE_PID=$!
sleep 2

# Start cloudflare tunnel
echo "[2/2] Starting Cloudflare tunnel..."
echo ""
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL
sleep 5
echo ""
echo "=== Bridge is running ==="
echo "Local:  http://localhost:$PORT/v1/chat/completions"
echo "Health: http://localhost:$PORT/health"
echo ""
echo "Copy the Cloudflare tunnel URL above and configure it in ElevenLabs:"
echo "  Agent settings > LLM > Custom LLM > URL: <tunnel-url>/v1/chat/completions"
echo ""
echo "Press Ctrl+C to stop"

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $BRIDGE_PID 2>/dev/null
  kill $TUNNEL_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait
