#!/usr/bin/env bash

bp_bootstrap_timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

bp_bootstrap_error() {
  local message="$1"
  local fallback_log="${BP_BOOTSTRAP_LOG:-${HOME:-/home/ubuntu}/bp-bot/logs/cron-bootstrap.log}"
  mkdir -p "$(dirname "$fallback_log")"
  printf '[%s] ERROR: %s\n' "$(bp_bootstrap_timestamp)" "$message" | tee -a "$fallback_log" >&2
}

bp_read_secret_file() {
  local file_path="$1"
  [ -f "$file_path" ] || return 1
  tr -d '\r\n' < "$file_path"
}

bp_require_file() {
  local file_path="$1"
  local description="$2"
  if [ ! -f "$file_path" ]; then
    bp_bootstrap_error "Missing ${description}: ${file_path}"
    return 1
  fi
}

bp_require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    bp_bootstrap_error "Required command not found in PATH: ${cmd}"
    return 1
  fi
}

bp_init_host_cron() {
  export HOME="${HOME:-/home/ubuntu}"
  export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

  local nvm_bin
  for nvm_bin in /home/ubuntu/.nvm/versions/node/*/bin; do
    [ -d "$nvm_bin" ] || continue
    case ":$PATH:" in
      *":$nvm_bin:"*) ;;
      *) PATH="$nvm_bin:$PATH" ;;
    esac
  done
  export PATH

  : "${BP_BOT_HOME:=/home/ubuntu/bp-bot}"
  : "${BP_CRON_ENV_FILE:=${BP_BOT_HOME}/config/cron.env}"

  bp_require_file "$BP_CRON_ENV_FILE" 'host cron config' || return 1

  set -a
  # shellcheck source=/dev/null
  source "$BP_CRON_ENV_FILE"
  set +a

  : "${BP_CONFIG_DIR:=${BP_BOT_HOME}/config}"
  : "${BP_SECRETS_DIR:=${BP_CONFIG_DIR}/secrets}"
  : "${BP_LOG_DIR:=${BP_BOT_HOME}/logs}"
  : "${BP_WORKTREE_ROOT:=/tmp/bp-bot-worktrees}"
  : "${BP_APP_REPO:=${BP_BOT_HOME}/bp-assistant}"
  : "${BP_SKILLS_REPO:=${BP_BOT_HOME}/bp-assistant-skills}"
  : "${BP_CODEX_CWD:=$(dirname "$BP_APP_REPO")}"
  : "${BP_PROMPTS_DIR:=$(dirname "$BP_APP_REPO")/.claude/cron-prompts}"
  : "${BP_RUNTIME_CONTAINER:=zulip-bot}"

  export BOT_SECRETS_DIR="${BOT_SECRETS_DIR:-$BP_SECRETS_DIR}"
  export BP_BOT_HOME BP_CONFIG_DIR BP_SECRETS_DIR BP_LOG_DIR BP_WORKTREE_ROOT
  export BP_APP_REPO BP_SKILLS_REPO BP_CODEX_CWD BP_PROMPTS_DIR BP_RUNTIME_CONTAINER

  mkdir -p "$BP_LOG_DIR" "$BP_WORKTREE_ROOT"

  if [ -f "${BP_CONFIG_DIR}/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "${BP_CONFIG_DIR}/.env"
    set +a
  fi
}

bp_require_zulip() {
  local zulip_email_file="${BP_SECRETS_DIR}/zulip_email"
  local zulip_api_key_file="${BP_SECRETS_DIR}/zulip_api_key"

  bp_require_file "$zulip_email_file" 'Zulip email secret' || return 1
  bp_require_file "$zulip_api_key_file" 'Zulip API key secret' || return 1

  export ZULIP_EMAIL
  ZULIP_EMAIL="$(bp_read_secret_file "$zulip_email_file")" || return 1
  export ZULIP_API_KEY
  ZULIP_API_KEY="$(bp_read_secret_file "$zulip_api_key_file")" || return 1

  if [ -z "${ZULIP_REALM:-}" ]; then
    bp_bootstrap_error 'ZULIP_REALM is not configured in cron.env or config/.env'
    return 1
  fi
}
