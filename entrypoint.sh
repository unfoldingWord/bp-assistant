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

# Crash-loop backoff + circuit breaker (failure mode B). Runs BEFORE the workspace
# refresh and the app launch so a tight restart loop backs off (or holds idle)
# instead of re-refreshing and re-crashing at full speed. Invoked without exec so
# its optional sleep applies to this boot; `|| true` keeps a guard bug from ever
# aborting an otherwise-healthy boot (the circuit-break path never returns).
bash /app/scripts/boot-guard.sh || true

# Refresh the /data/workspace skills checkout to origin/main on every boot.
# This MUST run here, not as a fly.toml release_command: release commands run in
# an ephemeral machine that does NOT mount the /data volume, so the refresh only
# ever saw a missing dir and skipped — leaving the bot on stale skills for weeks
# (see scripts/refresh-workspace.sh header and the 2026-07 AMO 5 stale-skills
# incident). entrypoint.sh runs on the live, volume-bearing machine, and an
# immediate-strategy deploy restarts it, so this fires on every deploy — at boot,
# before any pipeline starts. Bounded by `timeout` and `|| true`-equivalent so a
# slow/failed refresh can never hang or abort boot (the script already exits 0).
timeout 300 bash /app/scripts/refresh-workspace.sh \
  || echo "[entrypoint] workspace refresh skipped (timeout or error) — continuing boot on existing checkout"

exec node src/index.js
