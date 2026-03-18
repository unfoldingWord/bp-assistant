# API Runner (Parallel Path)

This module provides a multi-provider, tool-using runner that is parallel to the existing Claude SDK pipeline flow.

It is intentionally additive:
- Existing SDK routes and pipelines remain unchanged.
- API runner is used only when `route.type` is `api` or when directly invoking its CLI.

## Contents

- `agent-loop.js` - provider-agnostic tool loop (request -> tool calls -> execute -> repeat)
- `tools.js` - core file/search tools plus workspace tool bindings
- `runner.js` - high-level `runSkill()` and `runCustom()` APIs
- `provider-config.js` - central provider/model catalog, pricing, base URLs, and secret mapping
- `prompt-builder.js` - combines preamble + workspace `CLAUDE.md` + skill prompt
- `api-pipeline.js` - Zulip pipeline entry point for `type: "api"`
- `cli.js` - standalone local/ops entry point
- `providers/` - model provider integrations

## Route Usage

`config.json` includes an additive route:

- `api-generate`:
  - `match`: `/api generate\s+(.+)/i`
  - `type`: `api`
  - `skill`: `initial-pipeline --lite`

Example Zulip command:

`api generate LAM 2:4-5 --provider openai`

## CLI Usage

Run from `app/`:

```bash
node src/api-runner/cli.js --provider openai --skill ULT-gen --prompt "LAM 2:4-5"
node src/api-runner/cli.js --provider gemini --skill ULT-gen --prompt "LAM 2:4-5"
node src/api-runner/cli.js --provider claude --skill ULT-gen --prompt "LAM 2:4-5"
node src/api-runner/cli.js --provider openai --skill ULT-gen --prompt "LAM 2:4-5" --dry-run
```

Supported providers:
- `claude`
- `openai`
- `gemini`
- `xai`
- `groq`
- `deepseek`
- `mistral`

Provider model lists and defaults are now centralized in:

- `src/api-runner/provider-config.js`
- `/srv/bot/config/model-provider-config.json` (host file, preferred for post-deploy edits)

Edit this file to:
- add/remove models
- change default model per provider
- update per-model cost estimates
- update compatible provider base URLs

Claude API path also supports aliases through config:
- `modelAliases.opus`
- `modelAliases.sonnet`
- `modelAliases.haiku`

Cross-provider equivalents are handled with the same alias keys per provider:
- OpenAI example: `sonnet -> gpt-5.3`
- Gemini example: `sonnet -> gemini-2.5-pro`
- xAI example: `sonnet -> grok-4-1-fast-reasoning`

This alias resolution is API-runner-only and does not alter the existing Claude SDK path (`opus`/`sonnet`/`haiku`).

Load order:
- `MODEL_PROVIDER_CONFIG_FILE` (if set)
- `/config/model-provider-config.json` (inside container)
- `/srv/bot/config/model-provider-config.json` (local host path)
- built-in defaults from `provider-config.js`

## Secrets and Environment

`runner.js` resolves provider keys via `readSecret()` with env fallback:

- `claude` -> `anthropic_api_key` or `ANTHROPIC_API_KEY`
- `openai`/`groq`/`deepseek`/`mistral` -> `openai_api_key` or `OPENAI_API_KEY`
- `gemini` -> `google_api_key` or `GOOGLE_API_KEY`
- `xai` -> `xai_api_key` or `XAI_API_KEY`

`docker-compose.yml` mounts these secret files and corresponding `*_FILE` env vars.

## Tooling Notes

- `tools.js` is Chainguard-safe (pure JS, no shell execution).
- `Bash` tool is intentionally not available.
- `Glob` uses `fast-glob`.
- `Grep` is implemented with JS regex over UTF-8 file reads.
- Workspace tools are exposed with both aliases:
  - `<tool_name>`
  - `mcp__workspace-tools__<tool_name>`

## Testing

Quick checks:

```bash
node src/api-runner/cli.js --provider claude --skill ULT-gen --prompt "LAM 2:4-5" --dry-run
node src/api-runner/cli.js --provider openai --skill ULT-gen --prompt "LAM 2:4-5" --dry-run
node src/api-runner/cli.js --provider gemini --skill ULT-gen --prompt "LAM 2:4-5" --dry-run
node src/test-pipeline.js "api generate LAM 2:4-5" --provider openai --dry-run
```
