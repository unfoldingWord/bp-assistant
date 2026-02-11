#!/usr/bin/env bash
# example.sh — Starter pipeline template
#
# Available environment variables:
#   ZULIP_MSG_ID         — Message ID
#   ZULIP_MSG_CONTENT    — Raw message text
#   ZULIP_MSG_SENDER     — Sender's email
#   ZULIP_MSG_SENDER_NAME — Sender's full name
#   ZULIP_MSG_STREAM     — Stream name (or "dm" for DMs)
#   ZULIP_MSG_TOPIC      — Topic name (empty for DMs)
#   ZULIP_MSG_TIMESTAMP  — Message timestamp
#   ZULIP_ROUTE_NAME     — Which route was matched
#
# stdout is captured — if the route has "reply": true, stdout is posted back
# stderr is logged for debugging

echo "Hello from the example pipeline! Message from ${ZULIP_MSG_SENDER_NAME} in ${ZULIP_MSG_STREAM} > ${ZULIP_MSG_TOPIC}"
