#!/bin/bash
set -e

# Create volume subdirectories on first run
mkdir -p /data/workspace /data/appdata /data/claude-config

# Symlink /app/data into the volume so session/checkpoint files persist
if [ ! -L /app/data ]; then
  rm -rf /app/data
  ln -s /data/appdata /app/data
fi

if [ -n "$CONFIG_LOCAL_JSON" ]; then
  mkdir -p /app/data
  printf '%s' "$CONFIG_LOCAL_JSON" > /app/data/config.local.json
fi

exec node src/index.js
