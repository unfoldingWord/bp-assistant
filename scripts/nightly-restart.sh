#!/usr/bin/env bash
# Nightly restart + Claude update for the local zulip-bot container.
# This is runtime-only host maintenance and should be disabled after Fly cutover.
# Runs at midnight Eastern via cron
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_BOOTSTRAP_LOG="${BP_BOOTSTRAP_LOG:-${HOME:-/home/ubuntu}/bp-bot/logs/nightly-restart.log}"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/host-cron-bootstrap.sh"
bp_init_host_cron || exit 1
bp_require_command docker || exit 1

LOG="${BP_LOG_DIR}/nightly-restart.log"
CONTAINER="${BP_RUNTIME_CONTAINER}"

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "=== Nightly restart starting ==="

# 1. Check for active pipelines — abort if work is in progress
ACTIVE=$(docker logs "$CONTAINER" --tail 50 2>&1 | grep -cE '\[notes\] Running|\[generate\] Processing|\[claude-runner\] Starting' || true)
DONE=$(docker logs "$CONTAINER" --tail 50 2>&1 | grep -cE '\[notes\].*complete|\[generate\].*complete|\[claude-runner\] Finished' || true)
if [ "$ACTIVE" -gt "$DONE" ]; then
  log "ABORT: Active pipeline detected — skipping restart"
  exit 0
fi

# 2. Update Claude Code binary inside the container
log "Updating Claude Code binary..."
docker exec "$CONTAINER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >> "$LOG" 2>&1 || {
  log "WARNING: Claude binary update failed — continuing with restart"
}
NEW_VERSION=$(docker exec "$CONTAINER" /home/botuser/.local/bin/claude --version 2>&1 || echo "unknown")
log "Claude version after update: $NEW_VERSION"

# 3. Update npm SDK inside the container
log "Updating Claude Agent SDK..."
docker exec "$CONTAINER" npm update @anthropic-ai/claude-agent-sdk >> "$LOG" 2>&1 || {
  log "WARNING: SDK update failed — continuing with restart"
}

# 4. Restart (keeps container layer with updates intact)
log "Restarting container..."
docker restart "$CONTAINER" >> "$LOG" 2>&1

# 5. Wait for bot to come up
sleep 5
if docker logs "$CONTAINER" --tail 5 2>&1 | grep -q "Listening for messages"; then
  log "Bot is back up and listening"
else
  log "WARNING: Bot may not have started cleanly — check logs"
fi

log "=== Nightly restart complete ==="
