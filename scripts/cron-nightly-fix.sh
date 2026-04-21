#!/usr/bin/env bash
# Nightly issue-fix run — runs at midnight Central via system cron
set -euo pipefail

LOG="/srv/bot/app/logs/cron-nightly-fix.log"
PROMPT_FILE="/srv/bot/.claude/cron-prompts/nightly-fix.md"
TMPOUT=$(mktemp)
SELECTED_JSON=$(mktemp)
SUMMARY_FILE=$(mktemp)
MAX_ISSUES="${NIGHTLY_FIX_MAX_ISSUES:-3}"
DRY_RUN="${NIGHTLY_FIX_DRY_RUN:-0}"

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
EXIT_CODE=0

node /srv/bot/app/scripts/select-nightly-fix-issues.js --limit "$MAX_ISSUES" >"$SELECTED_JSON"
log "Candidate selection written to $SELECTED_JSON"

SELECTED_COUNT=$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String((data.selected||[]).length));" "$SELECTED_JSON")

if [ "$SELECTED_COUNT" -eq 0 ]; then
  printf 'Nightly fix run: no actionable issues found.\n' | tee -a "$LOG" "$TMPOUT"
else
  mapfile -t SELECTED_ISSUES < <(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); for (const item of (data.selected||[])) process.stdout.write(JSON.stringify(item)+'\n');" "$SELECTED_JSON")

  for issue_json in "${SELECTED_ISSUES[@]}"; do
    [ -n "$issue_json" ] || continue
    ISSUE_REF=$(node -e "const item=JSON.parse(process.argv[1]); process.stdout.write(item.repo + '#' + item.issueNumber);" "$issue_json")
    log "Starting Codex run for ${ISSUE_REF}"
    {
      cat "$PROMPT_FILE"
      printf '\n\n## Selected issue for this run\n'
      printf '%s\n' "$issue_json"
      printf '\n## Runtime flags\n'
      printf 'DRY_RUN=%s\n' "$DRY_RUN"
      printf 'MAX_ISSUES=%s\n' "$MAX_ISSUES"
    } | codex exec \
      --dangerously-bypass-approvals-and-sandbox \
      -C /srv/bot \
      - 2>&1 | tee -a "$LOG" "$TMPOUT"

    ISSUE_EXIT=${PIPESTATUS[1]}
    log "Finished Codex run for ${ISSUE_REF} (exit: $ISSUE_EXIT)"
    if [ "$ISSUE_EXIT" -ne 0 ]; then
      EXIT_CODE="$ISSUE_EXIT"
      break
    fi
  done
fi

log "=== Nightly fix run complete (exit: ${EXIT_CODE:-0}) ==="

RUN_OUTPUT=$(cat "$TMPOUT")
if ! codex exec \
  --skip-git-repo-check \
  -C /srv/bot \
  -o "$SUMMARY_FILE" \
  - <<EOF >/dev/null 2>&1
Summarize this automated nightly issue-fix run in 3-5 bullet points for a Zulip DM. Cover:
- which issues were selected and why
- which issues were skipped and why
- what changed
- which PRs were created (include URLs if present)
- whether the run succeeded or failed

Be concise.

Selection JSON:
$(cat "$SELECTED_JSON")

Run output:
---
$RUN_OUTPUT
---
EOF
then
  SUMMARY=$(tail -40 "$TMPOUT")
else
  SUMMARY=$(cat "$SUMMARY_FILE")
fi

# DM Benjamin on Zulip
curl -s -X POST "${ZULIP_REALM}/api/v1/messages" \
  -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
  --data-urlencode "type=direct" \
  --data-urlencode "to=[249849]" \
  --data-urlencode "content=**[Nightly Fix Run]** $(date '+%Y-%m-%d CT')

${SUMMARY}

Full log: \`${LOG}\`" \
  >> "$LOG" 2>&1

rm -f "$TMPOUT" "$SELECTED_JSON" "$SUMMARY_FILE"
