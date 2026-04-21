#!/usr/bin/env bash
# Log triage — runs at noon and 5pm Eastern via system cron
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_BOOTSTRAP_LOG="${BP_BOOTSTRAP_LOG:-${HOME:-/home/ubuntu}/bp-bot/logs/cron-log-triage.log}"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/host-cron-bootstrap.sh"
bp_init_host_cron || exit 1
bp_require_zulip || exit 1
bp_require_command claude || exit 1
bp_require_command curl || exit 1
bp_require_file "${BP_PROMPTS_DIR}/log-triage.md" 'log triage prompt' || exit 1

LOG="${BP_LOG_DIR}/cron-log-triage.log"
PROMPT_FILE="${BP_PROMPTS_DIR}/log-triage.md"
TMPOUT=$(mktemp)

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "=== Log triage starting ==="

claude \
  --print "$(cat "$PROMPT_FILE")" \
  --cwd "$BP_CODEX_CWD" \
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
