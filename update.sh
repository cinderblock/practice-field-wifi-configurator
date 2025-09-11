#!/bin/bash -e

if [ "$1" == "clean" ]; then
  shift
  rm -rf node_modules
fi

# Run the latest version of this script after updating
if [ "$1" != "continue" ]; then
  git pull
  exec "$0" continue
fi

if [ -d node_modules ]; then
  npm i
else
  npm ci
fi

npm run build

DEPLOY_BASE=/opt/practice-field-wifi

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ $DEPLOY_BASE/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html $DEPLOY_BASE/public/index.html

sudo systemctl restart practice-field-wifi-configurator.service
