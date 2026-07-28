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

# Persist stdout/stderr to the volume as well as to `fly logs`. Fly only keeps a
# short live-tail window, so without this every log older than that is gone.
# Process substitution (not a pipe) keeps node as the exec'd PID 1, so Fly's
# SIGINT/kill_timeout graceful-shutdown path is unchanged. log-tee.js never
# fails the process: on any file error it drops to plain pass-through. The
# `|| true` on mkdir matters under `set -e`: this script must never fail to
# boot the bot just because the log dir couldn't be created (e.g. a stray file
# blocking it, or a permissions issue) — log-tee.js retries the mkdir itself
# and degrades to pass-through internally if it also fails (issue #290).
BOT_LOG_DIR="${BOT_LOG_DIR:-/data/logs}"
mkdir -p "$BOT_LOG_DIR" || true
exec node src/index.js > >(node /app/scripts/log-tee.js "${BOT_LOG_DIR}/app.log") 2>&1
