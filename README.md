# BP Assistant — Zulip Bot

[![GitHub](https://img.shields.io/badge/github-unfoldingWord%2Fbp--assistant-blue)](https://github.com/unfoldingWord/bp-assistant)

Zulip bot that orchestrates AI-assisted creation of unfoldingWord Book Packages. Monitors a Zulip channel and DMs, matches messages against routes via regex + NLU fallback, and dispatches to Claude SDK pipelines for Bible translation content generation.

**Companion repo:** [bp-assistant-skills](https://github.com/unfoldingWord/bp-assistant-skills) — Claude Code skills and reference data that power the translation pipelines.

## Prerequisites

- Docker and Docker Compose
- A Zulip organization with a bot account
- A [Door43/Gitea](https://git.door43.org) account with API token
- An Anthropic API key (for the Haiku NLU intent classifier)
- Claude Code CLI authentication (for the Agent SDK pipelines)

## Quick start

### Docker (recommended)

```bash
# 1. Clone both repos side by side:
#    /srv/bot/app/        (this repo)
#    /srv/bot/workspace/  (bp-assistant-skills)
#    /srv/bot/config/     (secrets + env, see below)

# 2. Create config directory and secrets
mkdir -p /srv/bot/config/secrets
cp .env.example /srv/bot/config/.env
# Edit .env and populate all values

# Create secret files (one value per file, no trailing newline):
echo -n "your-token" > /srv/bot/config/secrets/door43_token
echo -n "your-username" > /srv/bot/config/secrets/door43_username
echo -n "your-key" > /srv/bot/config/secrets/zulip_api_key
echo -n "your-email" > /srv/bot/config/secrets/zulip_email

# 3. Create external Docker resources
docker volume create bot_claude-config
docker network create work-net   # if not already present

# 4. Build and run
docker compose up -d
docker logs zulip-bot --tail 30 -f
```

### Local development

```bash
cp .env.example .env
# Fill in credentials
npm install
npm start
```

You should see:

```
[bot] Authenticated as user@org.org (id: ...)
[bot] Registered stream queue for "CONTENT - UR"
[bot] Registered DM queue
[bot] Watching topics: Psalms BP, AI Work, Workflow, ...
[bot] Listening for messages...
```

## What it watches

Configured in `config.json`:

- **Channel:** `CONTENT - UR`
- **Topics:** Psalms BP, AI Work, Workflow, BP Proofreading, Proofreading Queue, Jeremiah BP, Habakkuk BP, Bot testing
- **DMs:** Admin only (configured in `config.local.json`)

Messages in other channels/topics are ignored. Messages you send yourself are always ignored (no echo loops).

## Authorization

- `config.local.json` (gitignored) holds `adminUserId` and `authorizedUserIds`
- Stream @-mentions from unauthorized users get a canned reply
- Only admin can DM the bot
- All stream commands require an @-mention plus confirmation before running

## How routing works

When someone posts a message in a watched topic (or DMs you), the bot checks `config.json` routes top to bottom. The first regex match wins.

If no regex matches, the **Haiku NLU fallback** (`intent-classifier.js`) classifies the natural-language request into `generate / notes / editor-review / editor-note / unknown`. Unknown sends a help message.

### Current routes

| Route | Trigger | Pipeline | Description |
|---|---|---|---|
| `editor-note` | `note BOOK [CH] text` | `editor-note` | File an editor observation to `data/editor-notes/BOOK.md` |
| `generate-content` | `generate BOOK CH[-CH]` | `sdk` | Run initial-pipeline (ULT + issues + UST) + alignment + Door43 push |
| `write-notes` | `write notes [for] BOOK CH` | `notes` | Run post-edit-review/deep-issue-id, tn-writer, tn-quality-check + Door43 push |
| `editor-review` | `BOOK CH review/compare` | `interactive-dm` | Multi-turn session running editor-compare skill |
| DM default | any unmatched DM from admin | `interactive-dm` | Open-ended Claude conversation in /workspace context |

### Confirmation flow

All stream commands show a confirmation message with a token/time estimate before running:

> I'll generate the initial content (ULT & UST, issues draft) for **PSA 79**. Sound right? (yes/no)

The user must reply `yes` (or variants like `y`, `yep`, `go ahead`) to proceed. `no` cancels.

### Multi-turn interactive sessions

DMs to admin and `editor-review` channel commands maintain conversation state across messages using `session-store.js` (file-backed in `data/sessions/`).

- `/reset` or `reset conversation` clears the session
- `switch to sonnet/haiku/opus` changes the model mid-conversation
- Messages are prefixed with `O:`, `S:`, or `H:` to indicate which model replied
- Stream sessions auto-clear after `maxExchanges` (default 6 for editor-review)

## Pipeline types

### `sdk` (generate-content)
Uses the Claude Agent SDK `query()` to run skills in `/workspace`. The `generate-pipeline.js` module:
1. Runs `initial-pipeline --lite` for each chapter (ULT + issues + UST)
2. Runs `align-all-parallel` for ULT and UST alignment
3. Pushes to Door43 via deterministic JS code (`door43-push.js`)
4. Verifies each push via Gitea API (`repo-verify.js`)

### `notes` (write-notes)
The `notes-pipeline.js` module runs a skill chain per chapter:
1. `post-edit-review` or `deep-issue-id` (reconcile/find issues)
2. Issue normalization (parallelism capping, deduplication) via `issue-normalizer.js`
3. Mechanical prep in Node.js (prepare notes, fill Hebrew orig_quotes, resolve GL quotes, flag narrow quotes) — runs before `tn-writer` so Claude skips those MCP tool calls
4. `tn-writer` (generate notes from issues)
5. Quality mechanical prep in Node.js (fix trailing newlines, run all mechanical quality checks) — runs before `tn-quality-check` so Claude reads pre-run findings
6. `tn-quality-check` (semantic review + one fix pass)
7. Door43 push + verify

### `editor-note`
Appends an observation to `data/editor-notes/BOOK.md`. Simple file-append operation via `note-pipeline.js`.

### `interactive-dm`
Multi-turn Claude sessions via SDK `resume`. Used for editor-review and admin DMs. See "Multi-turn interactive sessions" above.

## Door43 integration

Content is pushed to Door43/Gitea repos via deterministic JS code -- no Claude involved in the push itself.

- `door43-push.js` / `door43-push-cli.js` -- Git operations + Gitea API PR creation
- `repo-verify.js` -- Confirms PR merged to master by querying Gitea API
- `door43-users.json` (gitignored) -- Maps email addresses to Door43 usernames
- Requires `DCS_TOKEN` env var for Gitea API access

## MCP server

The bot runs an MCP (Model Context Protocol) server on port 3001 that exposes Bible translation reference data and USFM processing tools to Claude during pipeline execution. Key tools include:

- **Reference data**: Strong's concordance, glossary, issue types, published translations
- **USFM processing**: `create_aligned_usfm` (mapping JSON → aligned USFM), `merge_aligned_usfm` (assemble N partial files into one chapter), `read_usfm_chapter`, `curly_quotes`, `check_ust_passives`
- **TN processing**: `prepare_notes`, `fill_orig_quotes`, `resolve_gl_quotes`, `flag_narrow_quotes`, `fill_tsv_ids`, `assemble_notes`, `fix_trailing_newlines`
- **Quality**: `validate_tn_tsv`, `check_tn_quality`
- **Index builders**: `build_strongs_index`, `build_tn_index`, `build_ust_index`

The server starts automatically with the bot. Tool implementations live in `src/workspace-tools/`.

## Usage tracking

Every SDK call writes to `data/metrics/usage.jsonl`. Pre-flight checks combine `ccusage` (CLI/desktop usage) with the bot's JSONL log to estimate headroom in the 5-hour token window.

- Auto-calibrates budget when rate limits are hit
- Verse-based timeout scaling: `verses x operations x 5min/op`, clamped 10-60 min
- Verse counts from `verse-counts.js`

Bootstrap cost estimates (from 101+ observed runs) are in `src/usage-tracker.js` (`BOOTSTRAP_DEFAULTS`). The `estimateTokens()` function blends bootstrap with observed medians as data accumulates.

## Environment variables & secrets

In Docker, credentials are loaded from Docker secrets (files mounted at `/run/secrets/`). The `.env` file provides non-secret configuration.

### `.env` (non-secret config)

| Variable | Description |
|---|---|
| `ZULIP_REALM` | Zulip server URL |
| `PORT` | (optional) HTTP port for MCP server (default: 3001) |
| `ANTHROPIC_API_KEY` | API key for Haiku NLU intent classifier |

### Docker secrets

| Secret | Description |
|---|---|
| `zulip_api_key` | Zulip bot API key |
| `zulip_email` | Zulip bot email |
| `door43_token` | Door43/Gitea API token for repo pushes |
| `door43_username` | Door43/Gitea username |
| `claude_oauth_token` | Claude Code OAuth token (for Agent SDK) |
| `bt_mcp_api_token` | Bible translation MCP API token |

For local development without Docker, set these in `.env` directly (see `.env.example`).

## File structure

```
.env.example                <- Template for local development
config.json                 <- Channel, topics, routes, usage tracking config
config.local.json           <- Admin/authorized user IDs (gitignored)
door43-users.json           <- Email-to-Door43 username map (gitignored)
Dockerfile                  <- Multi-stage: node:22-slim build → Chainguard distroless runtime
docker-compose.yml          <- Mounts workspace, config, data; uses Docker secrets
package.json                <- Dependencies: claude-agent-sdk, anthropic, zulip-js

src/
  index.js                  <- Event loop: auth, poll Zulip events, filter, call router
  router.js                 <- Route matching, confirmation flow, pending merges, Haiku fallback
  config.js                 <- Merges config.json + config.local.json
  secrets.js                <- Docker secrets loader (reads /run/secrets/* files)
  pipeline-runner.js        <- Dispatcher: sdk / notes / editor-note / interactive-dm
  pipeline-context.js       <- Shared pipeline context (book, chapter, config)
  pipeline-checkpoints.js   <- Checkpoint save/restore for pipeline resumption
  issue-normalizer.js       <- Parallelism capping and deduplication for issue TSVs
  check-ult-edits.js        <- Detect human ULT edits (for post-edit-review gating)
  claude-runner.js          <- SDK query() wrapper with timeout, abort, metrics hooks
  generate-pipeline.js      <- ULT+UST generation + alignment + Door43 push
  notes-pipeline.js         <- TN skill chain (issue-id -> tn-writer -> quality-check) + Door43 push
  note-pipeline.js          <- Editor note filing (appends to data/editor-notes/BOOK.md)
  interactive-dm-pipeline.js <- Multi-turn Claude sessions (admin DMs + stream sessions)
  insertion-resume.js       <- Resume interrupted repo-insert operations
  intent-classifier.js      <- Haiku NLU fallback for natural-language commands
  mcp-server.js             <- MCP server (port 3001) exposing Bible translation data
  usage-tracker.js          <- JSONL metrics, token estimates, preflight checks, ccusage
  door43-push.js            <- Deterministic Git+Gitea API push (isomorphic-git)
  door43-push-cli.js        <- CLI wrapper for door43-push
  repo-verify.js            <- Gitea API verification that PR merged to master
  session-store.js          <- File-backed Claude session persistence
  auth-refresh.js           <- Proactive OAuth token refresh (8h tokens, 30min margin)
  pending-merges.js         <- File-backed pending merge state
  zulip-client.js           <- Zulip API wrapper (send, DM, reactions, file upload)
  pipeline-utils.js         <- Book name normalization, output file resolution, timeouts
  verse-counts.js           <- Verse count lookup for timeout/estimate calculations

data/
  metrics/usage.jsonl       <- Token usage log (auto-created)
  sessions/                 <- Multi-turn session state (auto-created)
  editor-notes/             <- Filed editor observations (auto-created)
```

## Config reference

```jsonc
{
  "adminUserId": null,            // Set in config.local.json
  "authorizedUserIds": [],        // Set in config.local.json
  "channel": "CONTENT - UR",      // Stream to monitor
  "topics": ["Topic A", ...],     // Only these topics (exact match)
  "watchDMs": true,               // Monitor direct messages (admin only)
  "routes": [                     // Checked top-to-bottom, first match wins
    {
      "name": "route-name",       // Label for logging
      "match": "/regex/i",        // Trigger pattern
      "type": "sdk|notes|editor-note|interactive-dm",
      "reply": true,              // Post output back to Zulip?
      "confirmMessage": "...",    // Shown before running (supports $1, $2 captures)
      "operations": 3,            // For timeout calculation (verses x ops x 5min)
      "maxExchanges": 6,          // For interactive sessions
      "cwd": "/workspace"         // Working directory for Claude
    }
  ],
  "defaultPipeline": null,        // Script for unmatched stream messages (null = skip)
  "dmDefaultPipeline": {          // Pipeline for unmatched admin DMs
    "type": "interactive-dm",
    "cwd": "/workspace"
  },
  "usageTracking": {
    "windowBudgetTokens": 220000,
    "windowHours": 5,
    "warnThreshold": 0.7,
    "ccusagePath": "npx ccusage@latest"
  }
}
```
