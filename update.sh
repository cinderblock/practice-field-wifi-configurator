#!/bin/bash -e

git pull

npm ci
npm run build

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ ../practice-field-wifi/internal/

# Copy the public.html to the external directory
cp frontend/src/public.html ../practice-field-wifi/external/index.html

sudo systemctl restart practice-field-wifi.service
