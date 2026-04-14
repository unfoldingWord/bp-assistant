#!/usr/bin/env bash
# Log triage — runs at noon and 5pm Eastern via system cron
set -euo pipefail

LOG="/srv/bot/app/logs/cron-log-triage.log"
PROMPT_FILE="/srv/bot/.claude/cron-prompts/log-triage.md"
TMPOUT=$(mktemp)

export HOME="/home/ubuntu"
export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Load Zulip credentials
set -a
# shellcheck source=/dev/null
source /srv/bot/app/.env
set +a

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "=== Log triage starting ==="

claude \
  --print "$(cat "$PROMPT_FILE")" \
  --cwd /srv/bot \
  --allowedTools "Bash Read Grep Glob" \
  2>&1 | tee -a "$LOG" "$TMPOUT"

EXIT_CODE=${PIPESTATUS[0]}
log "=== Log triage complete (exit: $EXIT_CODE) ==="

# Summarize the run output with Claude (no tools — pure text digest)
RUN_OUTPUT=$(cat "$TMPOUT")
SUMMARY=$(claude --print "Summarize this automated log triage run in 3-5 bullet points for a Zulip DM. Cover: what was checked, any bugs or errors found, any GitHub issues filed, and whether the run succeeded or failed. Be concise.

---
$RUN_OUTPUT
---" \
  --allowedTools "" 2>/dev/null) \
  || SUMMARY=$(tail -30 "$TMPOUT")  # fallback to raw tail if Claude fails

# DM Benjamin on Zulip
curl -s -X POST "${ZULIP_REALM}/api/v1/messages" \
  -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
  --data-urlencode "type=direct" \
  --data-urlencode "to=[249849]" \
  --data-urlencode "content=**[Log Triage]** $(date '+%Y-%m-%d %H:%M CT')

${SUMMARY}

Full log: \`${LOG}\`" \
  >> "$LOG" 2>&1

rm -f "$TMPOUT"
