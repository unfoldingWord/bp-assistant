#!/usr/bin/env bash
# generate.sh — Run cSkillBP /initial-pipeline for each chapter, posting results to Zulip
#
# Expects ZULIP_MSG_CONTENT like "generate psa 79-89" or "generate psa 79"

set -euo pipefail

# DRY_RUN=1 skips claude and creates stub output files; prints Zulip messages to stderr
# TEST_FAST=1 uses haiku model for quick/cheap testing
export DRY_RUN="${DRY_RUN:-0}"
export TEST_FAST="${TEST_FAST:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/zulip-helpers.sh"

# Status messages go to admin via DM; results go to the channel
zulip_status() {
  zulip_dm "$ZULIP_ADMIN_USER_ID" "$1"
}

CSKILLBP_DIR="$(cd "${SCRIPT_DIR}/../../cSkillBP" && pwd)"
LOG_FILE="${SCRIPT_DIR}/../logs/generate.log"
mkdir -p "$(dirname "$LOG_FILE")"

# ---------------------------------------------------------------------------
# Parse input
# ---------------------------------------------------------------------------
INPUT=$(echo "$ZULIP_MSG_CONTENT" | tr '[:upper:]' '[:lower:]')

if [[ "$INPUT" =~ generate[[:space:]]+([a-z0-9]+)[[:space:]]+([0-9]+)[[:space:]]*[-–—to]+[[:space:]]*([0-9]+) ]]; then
  BOOK="${BASH_REMATCH[1]^^}"
  START="${BASH_REMATCH[2]}"
  END="${BASH_REMATCH[3]}"
elif [[ "$INPUT" =~ generate[[:space:]]+([a-z0-9]+)[[:space:]]+([0-9]+) ]]; then
  BOOK="${BASH_REMATCH[1]^^}"
  START="${BASH_REMATCH[2]}"
  END="$START"
else
  zulip_react "cross_mark"
  zulip_status "Could not parse command. Expected format: \`generate <book> <chapter>\` or \`generate <book> <start>-<end>\`"
  exit 1
fi

CHAPTER_COUNT=$(( END - START + 1 ))
if (( CHAPTER_COUNT < 1 )); then
  zulip_react "cross_mark"
  zulip_status "Invalid chapter range: ${START}-${END}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Token estimate
# ---------------------------------------------------------------------------
PER_CHAPTER=5000000
SESSION_BUDGET=45000000
ESTIMATED_TOTAL=$(( CHAPTER_COUNT * PER_CHAPTER ))

if (( ESTIMATED_TOTAL > SESSION_BUDGET )); then
  zulip_react "cross_mark"
  zulip_status "Estimated token usage (~${ESTIMATED_TOTAL}) exceeds session budget (~${SESSION_BUDGET}). Try a smaller range (max ~$(( SESSION_BUDGET / PER_CHAPTER )) chapters)."
  exit 1
fi

# Signal we're working on it
zulip_react "working_on_it"
zulip_status "Starting generation for **${BOOK}** chapters ${START}–${END} (${CHAPTER_COUNT} chapter(s), ~${ESTIMATED_TOTAL} tokens estimated)"

# ---------------------------------------------------------------------------
# Allowed tools for --allowedTools workaround
# ---------------------------------------------------------------------------
ALLOWED_TOOLS="Read,Write,Edit,Glob,Grep,Bash,Task,SendMessage"

# ---------------------------------------------------------------------------
# Loop through chapters
# ---------------------------------------------------------------------------
SUCCESS=0
FAIL=0

for (( CH=START; CH<=END; CH++ )); do
  echo "[generate] Processing ${BOOK} chapter ${CH}..." >&2
  zulip_status "Processing **${BOOK} ${CH}**..."

  CLAUDE_EXIT=0
  CLAUDE_START=$(date +%s)

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] Would run: claude -p \"/initial-pipeline ${BOOK} ${CH}\" --allowedTools \"${ALLOWED_TOOLS}\" (in ${CSKILLBP_DIR})" >&2
    # Create stub output files so the post-claude file-reading logic runs
    mkdir -p "${CSKILLBP_DIR}/output/AI-ULT" "${CSKILLBP_DIR}/output/AI-UST"
    echo "\\id ${BOOK}
\\c ${CH}
\\v 1 [Stub ULT verse 1]
\\v 2 [Stub ULT verse 2]" > "${CSKILLBP_DIR}/output/AI-ULT/${BOOK}-${CH}.usfm"
    echo "\\id ${BOOK}
\\c ${CH}
\\v 1 [Stub UST verse 1]
\\v 2 [Stub UST verse 2]" > "${CSKILLBP_DIR}/output/AI-UST/${BOOK}-${CH}.usfm"
    sleep 0.2  # simulate a brief delay
  else
    CLAUDE_ARGS=(-p "/initial-pipeline --lite ${BOOK} ${CH}" --allowedTools "${ALLOWED_TOOLS}")
    if [[ "$TEST_FAST" == "1" ]]; then
      CLAUDE_ARGS+=(--model haiku)
    fi
    ( cd "$CSKILLBP_DIR" && claude "${CLAUDE_ARGS[@]}" ) \
      2> >(tee -a "$LOG_FILE" >&2) \
      || CLAUDE_EXIT=$?
  fi

  CLAUDE_END=$(date +%s)
  CLAUDE_DURATION=$(( CLAUDE_END - CLAUDE_START ))

  # Log timing and exit code
  echo "$(date -Iseconds) | ${BOOK} ${CH} | exit=${CLAUDE_EXIT} | duration=${CLAUDE_DURATION}s" >> "$LOG_FILE"

  if (( CLAUDE_EXIT != 0 )); then
    zulip_status "Failed to generate **${BOOK} ${CH}** (exit code ${CLAUDE_EXIT}). Check logs for details."
    FAIL=$(( FAIL + 1 ))
    continue
  fi

  # Read output files
  ULT_FILE="${CSKILLBP_DIR}/output/AI-ULT/${BOOK}-${CH}.usfm"
  UST_FILE="${CSKILLBP_DIR}/output/AI-UST/${BOOK}-${CH}.usfm"

  REPLY=""

  if [[ -f "$ULT_FILE" ]]; then
    ULT_CONTENT=$(cat "$ULT_FILE")
    REPLY+="**ULT — ${BOOK} ${CH}**
\`\`\`
${ULT_CONTENT}
\`\`\`
"
  else
    REPLY+="ULT file not found: \`${ULT_FILE}\`
"
  fi

  if [[ -f "$UST_FILE" ]]; then
    UST_CONTENT=$(cat "$UST_FILE")
    REPLY+="**UST — ${BOOK} ${CH}**
\`\`\`
${UST_CONTENT}
\`\`\`"
  else
    REPLY+="UST file not found: \`${UST_FILE}\`"
  fi

  zulip_reply "$REPLY"
  SUCCESS=$(( SUCCESS + 1 ))
done

# ---------------------------------------------------------------------------
# Summary — swap emoji and DM final status
# ---------------------------------------------------------------------------
zulip_unreact "working_on_it"
if (( FAIL == 0 )); then
  zulip_react "check"
else
  zulip_react "warning"
fi
zulip_status "Generation complete for **${BOOK} ${START}–${END}**: ${SUCCESS} succeeded, ${FAIL} failed."
