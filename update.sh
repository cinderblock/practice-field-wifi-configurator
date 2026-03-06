#!/bin/bash -e

UI_ONLY=false

if [ "$1" == "clean" ]; then
  shift
  rm -rf node_modules
fi

if [ "$1" == "ui" ]; then
  UI_ONLY=true
  shift
fi

# Run the latest version of this script after updating
if [ "$1" != "continue" ]; then
  git pull
  exec "$(realpath "$0")" $([ "$UI_ONLY" == "true" ] && echo "ui") continue
fi

if [ -d node_modules ]; then
  npm i
else
  npm ci
fi

if [ "$UI_ONLY" == "true" ]; then
  npm run build --workspaces
else
  npm run build
fi

# Auto-detect deployment based on working directory name
case "$(basename "$PWD")" in
  practice-field-management-system)
    DEPLOY_BASE=/opt/practice-field-management-system
    SERVICE=practice-field-management-system.service
    ;;
  *)
    DEPLOY_BASE=/opt/practice-field-wifi
    SERVICE=practice-field-wifi-configurator.service
    ;;
esac

echo "Deploying to $DEPLOY_BASE"

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

if [ "$UI_ONLY" == "true" ]; then
  echo "UI updated — backend not restarted."
else
  echo "Restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
fi
