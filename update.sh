#!/bin/bash -e

git pull

npm ci
npm run build

# Synchronize the internal directory with the frontend build output
rsync -av --delete frontend/dist/ ../practice-field-wifi/internal/

# Copy the public.html to the public directory
cp frontend/src/public.html ../practice-field-wifi/public/index.html

sudo systemctl restart --user practice-field-wifi.service
