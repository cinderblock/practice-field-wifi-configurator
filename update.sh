#!/bin/bash -e

git pull

if [ -d node_modules ]; then
  npm i
else
  npm ci
fi

npm run build

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ ../practice-field-wifi/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html ../practice-field-wifi/public/index.html

sudo systemctl restart practice-field-wifi.service
