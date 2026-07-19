#!/bin/bash -e

# Ensure bun is in PATH (installed at ~/.bun/bin by default)
export PATH="$HOME/.bun/bin:$PATH"

FORCE=false
CLEAN=false

for arg in "$@"; do
  case "$arg" in
    clean) CLEAN=true ;;
    force) FORCE=true ;;
    continue) ;; # handled below
  esac
done

if $CLEAN; then
  rm -rf node_modules
fi

# Run the latest version of this script after updating
if [[ ! " $* " =~ " continue " ]]; then
  git pull
  # Forward all original args plus 'continue'
  exec "$(realpath "$0")" continue "$@"
fi

bun install

bun run build

DEPLOY_BASE=/opt/practice-field-management-system
SERVICE=practice-field-management-system.service

echo "Deploying to $DEPLOY_BASE"

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Deploy sound files so the browser can play match audio
rsync -av sounds/ $DEPLOY_BASE/internal/sounds/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

# Helper: get the current match phase from the backend
get_match_phase() {
  curl -sf http://localhost:9005/health 2>/dev/null \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).phase' 2>/dev/null \
    || echo "unknown"
}

# Phases where robots are under field control or scores are still counting —
# reloading would interrupt a live match, so wait these out. Everything else
# ('idle', 'created' while teams set up, 'unknown' when the server is down)
# is safe to reload through: worst case, joined teams re-join after the
# deploy. 'created' must NOT block — it never expires on its own, so waiting
# on it hangs the deploy indefinitely.
is_active_phase() {
  case "$1" in
    countdown | auto | autoPause | paused | teleop | endgame | postMatch) return 0 ;;
    *) return 1 ;;
  esac
}

# Wait for any active match to finish before reloading
MATCH_PHASE=$(get_match_phase)

if is_active_phase "$MATCH_PHASE"; then
  if $FORCE; then
    echo "⚠️  Match in progress (phase: $MATCH_PHASE) — forcing reload (--force)"
  else
    echo ""
    echo "⏳ Match in progress (phase: $MATCH_PHASE) — waiting for it to finish..."
    echo "   (use './update.sh force' to skip this wait)"
    echo ""
    while true; do
      sleep 5
      MATCH_PHASE=$(get_match_phase)
      if ! is_active_phase "$MATCH_PHASE"; then
        echo "✅ Match finished (phase: $MATCH_PHASE) — proceeding with reload."
        break
      fi
      echo "   Still waiting... (phase: $MATCH_PHASE)"
    done
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
