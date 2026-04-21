#!/usr/bin/env bash
# Automated issue-fix run — intended for hourly cron execution
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BP_BOOTSTRAP_LOG="${BP_BOOTSTRAP_LOG:-${HOME:-/home/ubuntu}/bp-bot/logs/cron-nightly-fix.log}"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/host-cron-bootstrap.sh"
bp_init_host_cron || exit 1
bp_require_zulip || exit 1
bp_require_command node || exit 1
bp_require_command codex || exit 1
bp_require_command curl || exit 1
bp_require_command flock || exit 1
bp_require_command gh || exit 1
bp_require_file "${BP_PROMPTS_DIR}/nightly-fix.md" 'nightly fix prompt' || exit 1
bp_require_file "${BP_APP_REPO}/scripts/select-nightly-fix-issues.js" 'nightly fix selector script' || exit 1
bp_require_file "${BP_APP_REPO}/scripts/cron-usage-check.js" 'usage check script' || exit 1
bp_require_file "${BP_APP_REPO}/scripts/cron-check-pr-conflicts.js" 'PR conflict check script' || exit 1

LOG="${BP_LOG_DIR}/cron-nightly-fix.log"
LOCK_FILE="${BP_LOG_DIR}/cron-nightly-fix.lock"
PROMPT_FILE="${BP_PROMPTS_DIR}/nightly-fix.md"
TMPOUT=$(mktemp)
SELECTED_JSON=$(mktemp)
SUMMARY_FILE=$(mktemp)
MAX_ISSUES="${NIGHTLY_FIX_MAX_ISSUES:-all}"
DRY_RUN="${NIGHTLY_FIX_DRY_RUN:-0}"
DEPLOY_WORKFLOW_FILE="$(node -e "process.stdout.write(require(process.argv[1]).DEPLOY_WORKFLOW_FILE)" "${BP_APP_REPO}/src/cron-nightly-fix.js")"

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

issue_directive() {
  node -e "const fs=require('fs'); const { buildIssueDirective } = require(process.argv[1]); const issue=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(buildIssueDirective(issue));" \
    "${BP_APP_REPO}/src/cron-nightly-fix.js"
}

should_dispatch_deploy() {
  node -e "const { shouldDispatchDeploy } = require(process.argv[1]); const processedCount=Number(process.argv[2]); const dryRun=process.argv[3]; process.stdout.write(shouldDispatchDeploy({ processedCount, dryRun }) ? '1' : '0');" \
    "${BP_APP_REPO}/src/cron-nightly-fix.js" \
    "$1" \
    "$2"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another automated issue-fix run is already in progress; skipping this invocation."
  exit 0
fi

# ---------------------------------------------------------------------------
# Usage check helpers
# ---------------------------------------------------------------------------

# Run the usage check script and set PROVIDER + MODEL globals.
# Returns 0; caller checks PROVIDER to decide whether to skip.
check_usage() {
  local usage_json
  usage_json=$(node "${BP_APP_REPO}/scripts/cron-usage-check.js" 2>>"$LOG")
  PROVIDER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).provider)" "$usage_json")
  MODEL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).model||'')" "$usage_json")
  USAGE_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).reason||'')" "$usage_json")
  log "Usage check: provider=${PROVIDER} model=${MODEL:-n/a}${USAGE_REASON:+ (${USAGE_REASON})}"
}

# Run one issue through the selected provider.
# Reads combined prompt from stdin; streams output to LOG and TMPOUT.
# Sets ISSUE_EXIT to the agent's exit code.
run_issue_with_provider() {
  if [ "$PROVIDER" = "openai" ]; then
    codex exec \
      -m "$MODEL" \
      --dangerously-bypass-approvals-and-sandbox \
      -C "$BP_CODEX_CWD" \
      - 2>&1 | tee -a "$LOG" "$TMPOUT"
    ISSUE_EXIT="${PIPESTATUS[0]}"
  else
    # Claude fallback — Anthropic SDK via query() with claude-sonnet-4-6
    BP_CODEX_CWD="$BP_CODEX_CWD" \
    CRON_CLAUDE_MODEL="$MODEL" \
    node "${BP_APP_REPO}/scripts/cron-sdk-run.js" 2>&1 | tee -a "$LOG" "$TMPOUT"
    ISSUE_EXIT="${PIPESTATUS[0]}"
  fi
}

# ---------------------------------------------------------------------------

log "=== Automated issue-fix run starting ==="
log "Repo roots: app=${BP_APP_REPO} skills=${BP_SKILLS_REPO} cwd=${BP_CODEX_CWD}"
EXIT_CODE=0
PROVIDER=""
MODEL=""
USAGE_REASON=""
PROCESSED_COUNT=0
APP_TOUCHED=0
DEPLOY_STATUS="not-run"

# Initial usage check before doing any work
check_usage
if [ "$PROVIDER" = "skip" ]; then
  log "Skipping run: ${USAGE_REASON:-both providers near rate limit}"
  curl -s -X POST "${ZULIP_REALM}/api/v1/messages" \
    -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
    --data-urlencode "type=direct" \
    --data-urlencode "to=[249849]" \
    --data-urlencode "content=**[Automated Fix Run]** $(date '+%Y-%m-%d CT') — skipped: ${USAGE_REASON:-both providers near rate limit}" \
    >> "$LOG" 2>&1
  rm -f "$TMPOUT" "$SELECTED_JSON" "$SUMMARY_FILE"
  exit 0
fi

SELECT_ARGS=()
if [ "$MAX_ISSUES" != "all" ]; then
  SELECT_ARGS+=(--limit "$MAX_ISSUES")
fi

env \
  BP_APP_REPO="$BP_APP_REPO" \
  BP_SKILLS_REPO="$BP_SKILLS_REPO" \
  BP_WORKTREE_ROOT="$BP_WORKTREE_ROOT" \
  node "${BP_APP_REPO}/scripts/select-nightly-fix-issues.js" "${SELECT_ARGS[@]}" >"$SELECTED_JSON"
log "Candidate selection written to $SELECTED_JSON"

SELECTED_COUNT=$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String((data.selected||[]).length));" "$SELECTED_JSON")

if [ "$SELECTED_COUNT" -eq 0 ]; then
  printf 'Automated issue-fix run: no actionable issues found.\n' | tee -a "$LOG" "$TMPOUT"
else
  mapfile -t SELECTED_ISSUES < <(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); for (const item of (data.selected||[])) process.stdout.write(JSON.stringify(item)+'\n');" "$SELECTED_JSON")

  for issue_json in "${SELECTED_ISSUES[@]}"; do
    [ -n "$issue_json" ] || continue
    ISSUE_REF=$(node -e "const item=JSON.parse(process.argv[1]); process.stdout.write(item.repo + '#' + item.issueNumber);" "$issue_json")
    ISSUE_REPO_KEY=$(node -e "const item=JSON.parse(process.argv[1]); process.stdout.write(item.repoKey || '');" "$issue_json")
    ISSUE_DIRECTIVE=$(printf '%s' "$issue_json" | issue_directive)
    if [ "$ISSUE_REPO_KEY" = "app" ]; then
      APP_TOUCHED=1
    fi

    # Re-check usage before each issue so we don't start work we can't finish
    check_usage
    if [ "$PROVIDER" = "skip" ]; then
      log "Stopping before ${ISSUE_REF}: ${USAGE_REASON:-both providers near rate limit}"
      printf 'Stopped before %s: %s\n' "$ISSUE_REF" "${USAGE_REASON:-both providers near rate limit}" | tee -a "$TMPOUT"
      break
    fi

    log "Starting run for ${ISSUE_REF} via ${PROVIDER}/${MODEL}"
    {
      cat "$PROMPT_FILE"
      printf '\n\n%s\n' "$ISSUE_DIRECTIVE"
      printf '\n\n## Selected issue for this run\n'
      printf '%s\n' "$issue_json"
      printf '\n## Runtime flags\n'
      printf 'DRY_RUN=%s\n' "$DRY_RUN"
      printf 'MAX_ISSUES=%s\n' "$MAX_ISSUES"
      printf 'RUN_LOG=%s\n' "$LOG"
    } | run_issue_with_provider

    log "Finished run for ${ISSUE_REF} via ${PROVIDER}/${MODEL} (exit: $ISSUE_EXIT)"
    if [ "$ISSUE_EXIT" -ne 0 ]; then
      EXIT_CODE="$ISSUE_EXIT"
      break
    fi
    PROCESSED_COUNT=$((PROCESSED_COUNT + 1))
  done
fi

log "=== Automated issue-fix run complete (exit: ${EXIT_CODE:-0}) ==="

if [ "$(should_dispatch_deploy "$PROCESSED_COUNT" "$DRY_RUN")" = "1" ]; then
  log "Dispatching Fly.io deploy workflow ${DEPLOY_WORKFLOW_FILE} with confirm=yes"
  if gh workflow run "$DEPLOY_WORKFLOW_FILE" --repo unfoldingWord/bp-assistant -f confirm=yes >>"$LOG" 2>&1; then
    DEPLOY_STATUS="dispatched (${DEPLOY_WORKFLOW_FILE}, confirm=yes)"
  else
    DEPLOY_STATUS="failed (${DEPLOY_WORKFLOW_FILE}, confirm=yes)"
    EXIT_CODE=1
    log "Failed to dispatch Fly.io deploy workflow ${DEPLOY_WORKFLOW_FILE}"
  fi
else
  DEPLOY_STATUS="not-run (dry run or no processed issues)"
fi

# ---------------------------------------------------------------------------
# PR conflict check
# ---------------------------------------------------------------------------
CONFLICT_REPORT=$(node "${BP_APP_REPO}/scripts/cron-check-pr-conflicts.js" "$TMPOUT" 2>>"$LOG")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
RUN_OUTPUT=$(cat "$TMPOUT")
if ! codex exec \
  -m "gpt-5.4-mini" \
  --skip-git-repo-check \
  -C "$BP_CODEX_CWD" \
  -o "$SUMMARY_FILE" \
  - <<EOF >/dev/null 2>&1
Summarize this automated nightly issue-fix run in 3-5 bullet points for a Zulip DM. Cover:
- which issues were selected and why
- which issues were skipped and why
- what changed
- which PRs were created (include URLs if present)
- whether the run succeeded or failed
- whether the Fly.io deploy workflow was dispatched with pipeline check confirmed as yes

If any bp-assistant issue was touched, explicitly say app-side work is still needed and was not auto-merged by cron.

Be concise.

App lane touched: ${APP_TOUCHED}
Deploy workflow status: ${DEPLOY_STATUS}

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
  --data-urlencode "content=**[Automated Fix Run]** $(date '+%Y-%m-%d CT')

${SUMMARY}

${CONFLICT_REPORT}

Full log: \`${LOG}\`" \
  >> "$LOG" 2>&1

rm -f "$TMPOUT" "$SELECTED_JSON" "$SUMMARY_FILE"
