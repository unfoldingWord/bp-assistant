#!/bin/bash
set -e

BOTUSER=botuser
DOOR43_REPOS="${DOOR43_REPOS_PATH:-/data/workspace/door43-repos}"

# Create volume subdirectories on first run
mkdir -p /data/workspace /data/appdata /data/claude-config "$DOOR43_REPOS"

# Self-heal volume ownership at boot. Prior privileged ops (fly ssh as root,
# container restart mid-write) can leave root-owned paths under door43-repos;
# the unprivileged bot process then gets EACCES on door43-push (issues #207,
# #352). pipeline-runner's ownership-sweep only warns when not root. On a
# fresh volume, mkdir above creates these dirs as root — chown all of them.
if [ "$(id -u)" = "0" ]; then
  chown -R "$BOTUSER:$BOTUSER" /data/workspace /data/appdata /data/claude-config "$DOOR43_REPOS" 2>/dev/null || true
fi

# Symlink /app/data into the volume so session/checkpoint files persist
if [ ! -L /app/data ]; then
  rm -rf /app/data
  ln -s /data/appdata /app/data
fi

if [ -n "$CONFIG_LOCAL_JSON" ]; then
  mkdir -p /app/data
  printf '%s' "$CONFIG_LOCAL_JSON" > /app/data/config.local.json
  if [ "$(id -u)" = "0" ]; then
    chown "$BOTUSER:$BOTUSER" /app/data/config.local.json 2>/dev/null || true
  fi
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
# Run as botuser so git objects in the skills checkout stay app-owned.
if [ "$(id -u)" = "0" ]; then
  timeout 300 gosu "$BOTUSER" bash /app/scripts/refresh-workspace.sh \
    || echo "[entrypoint] workspace refresh skipped (timeout or error) — continuing boot on existing checkout"
else
  timeout 300 bash /app/scripts/refresh-workspace.sh \
    || echo "[entrypoint] workspace refresh skipped (timeout or error) — continuing boot on existing checkout"
fi

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
if [ "$(id -u)" = "0" ]; then
  chown "$BOTUSER:$BOTUSER" "$BOT_LOG_DIR" 2>/dev/null || true
  exec gosu "$BOTUSER" node src/index.js > >(node /app/scripts/log-tee.js "${BOT_LOG_DIR}/app.log") 2>&1
fi
exec node src/index.js > >(node /app/scripts/log-tee.js "${BOT_LOG_DIR}/app.log") 2>&1
