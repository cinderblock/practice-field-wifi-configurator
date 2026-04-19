#!/bin/bash -e

# Ensure bun is in PATH (installed at ~/.bun/bin by default)
export PATH="$HOME/.bun/bin:$PATH"

if [ "$1" == "clean" ]; then
  shift
  rm -rf node_modules
fi

# Run the latest version of this script after updating
if [ "$1" != "continue" ]; then
  git pull
  exec "$(realpath "$0")" continue
fi

bun install

bun run build

DEPLOY_BASE=/opt/practice-field-management-system
SERVICE=practice-field-management-system.service

echo "Deploying to $DEPLOY_BASE"

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

# Check if a match is in progress before reloading
MATCH_PHASE=$(curl -sf http://localhost:9005/health 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).phase' 2>/dev/null || echo "unknown")

if [ "$MATCH_PHASE" != "idle" ] && [ "$MATCH_PHASE" != "unknown" ]; then
  echo ""
  echo "⚠️  WARNING: A match is in progress! (phase: $MATCH_PHASE)"
  echo "   Reloading will kill the active match (match state is in-memory only)."
  echo ""
  read -p "   Deploy anyway? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "Reloading $SERVICE"
sudo systemctl reload-or-restart "$SERVICE"
echo "Watching startup logs (10s)..."
timeout 10 journalctl -u "$SERVICE" -f -n 0 --no-pager &
JOURNAL_PID=$!
# Wait a moment, then check if the service is still running
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "ERROR: $SERVICE failed to start!"
  echo "Last logs:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  kill $JOURNAL_PID 2>/dev/null || true
  exit 1
fi
wait $JOURNAL_PID 2>/dev/null || true
