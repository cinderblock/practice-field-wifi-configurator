#!/bin/bash -e

if [ "$1" == "clean" ]; then
  shift
  rm -rf node_modules
fi

# Run the latest version of this script after updating
if [ "$1" != "continue" ]; then
  git pull
  exec "$(realpath "$0")" continue
fi

if [ -d node_modules ]; then
  npm i
else
  npm ci
fi

npm run build

DEPLOY_BASE=/opt/practice-field-management-system
SERVICE=practice-field-management-system.service

echo "Deploying to $DEPLOY_BASE"

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

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
