#!/usr/bin/env bash
# Nightly issue-fix run — runs at midnight Central via system cron
set -euo pipefail

LOG="/srv/bot/app/logs/cron-nightly-fix.log"
PROMPT_FILE="/srv/bot/.claude/cron-prompts/nightly-fix.md"
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

log "=== Nightly fix run starting ==="

claude \
  --print "$(cat "$PROMPT_FILE")" \
  --cwd /srv/bot \
  --allowedTools "Bash Read Edit Write Glob Grep Agent" \
  2>&1 | tee -a "$LOG" "$TMPOUT"

EXIT_CODE=${PIPESTATUS[0]}
log "=== Nightly fix run complete (exit: $EXIT_CODE) ==="

# Summarize the run output with Claude (no tools — pure text digest)
RUN_OUTPUT=$(cat "$TMPOUT")
SUMMARY=$(claude --print "Summarize this automated nightly issue-fix run in 3-5 bullet points for a Zulip DM. Cover: which issues were selected and why, what was changed, which PRs were created (include URLs), and whether the run succeeded or failed. Be concise — this is a review notification.

---
$RUN_OUTPUT
---" \
  --allowedTools "" 2>/dev/null) \
  || SUMMARY=$(tail -40 "$TMPOUT")  # fallback to raw tail if Claude fails

# DM Benjamin on Zulip
curl -s -X POST "${ZULIP_REALM}/api/v1/messages" \
  -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
  --data-urlencode "type=direct" \
  --data-urlencode "to=[249849]" \
  --data-urlencode "content=**[Nightly Fix Run]** $(date '+%Y-%m-%d CT')

${SUMMARY}

Full log: \`${LOG}\`" \
  >> "$LOG" 2>&1

rm -f "$TMPOUT"
