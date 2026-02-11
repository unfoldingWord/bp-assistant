#!/usr/bin/env bash
# zulip-helpers.sh — Shared helpers for posting to Zulip from pipeline scripts
#
# Source this file: source "$(dirname "$0")/zulip-helpers.sh"
#
# Requires env vars: ZULIP_EMAIL, ZULIP_API_KEY, ZULIP_REALM
# Stream replies also need: ZULIP_MSG_STREAM, ZULIP_MSG_TOPIC

# Post a message to the stream+topic from the triggering message
zulip_reply() {
  local content="$1"
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo -e "[zulip_reply → ${ZULIP_MSG_STREAM} > ${ZULIP_MSG_TOPIC}]\n${content}\n" >&2
    return 0
  fi
  curl -sSf -X POST "${ZULIP_REALM}/api/v1/messages" \
    -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
    --data-urlencode "type=stream" \
    --data-urlencode "to=${ZULIP_MSG_STREAM}" \
    --data-urlencode "topic=${ZULIP_MSG_TOPIC}" \
    --data-urlencode "content=${content}" \
    > /dev/null
}

# Add an emoji reaction to the triggering message
zulip_react() {
  local emoji="${1:-working_on_it}"
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "[zulip_react → :${emoji}: on msg ${ZULIP_MSG_ID}]" >&2
    return 0
  fi
  curl -sSf -X POST "${ZULIP_REALM}/api/v1/messages/${ZULIP_MSG_ID}/reactions" \
    -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
    --data-urlencode "emoji_name=${emoji}" \
    > /dev/null
}

# Remove an emoji reaction from the triggering message
zulip_unreact() {
  local emoji="${1:-working_on_it}"
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "[zulip_unreact → :${emoji}: on msg ${ZULIP_MSG_ID}]" >&2
    return 0
  fi
  curl -sSf -X DELETE "${ZULIP_REALM}/api/v1/messages/${ZULIP_MSG_ID}/reactions" \
    -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
    --data-urlencode "emoji_name=${emoji}" \
    > /dev/null
}

# Post a direct message to a specific user
zulip_dm() {
  local user_id="$1"
  local content="$2"
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo -e "[zulip_dm → ${user_id}]\n${content}\n" >&2
    return 0
  fi
  curl -sSf -X POST "${ZULIP_REALM}/api/v1/messages" \
    -u "${ZULIP_EMAIL}:${ZULIP_API_KEY}" \
    --data-urlencode "type=direct" \
    --data-urlencode "to=[${user_id}]" \
    --data-urlencode "content=${content}" \
    > /dev/null
}
