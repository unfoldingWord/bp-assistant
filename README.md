# Zulip Bot -- Pipeline Router & Claude SDK Runner

Monitors a Zulip channel and DMs, matches messages against routes via regex + NLU fallback, and dispatches to Claude SDK pipelines for book package generation. Runs inside Docker on an OCI ARM64 server.

## Quick start

```bash
# Copy .env.example to .env and fill in credentials
cp .env.example .env
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
2. `tn-writer` (generate notes from issues)
3. `tn-quality-check` (validate notes)
4. Door43 push + verify

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

## Usage tracking

Every SDK call writes to `data/metrics/usage.jsonl`. Pre-flight checks combine `ccusage` (CLI/desktop usage) with the bot's JSONL log to estimate headroom in the 5-hour token window.

- Auto-calibrates budget when rate limits are hit
- Verse-based timeout scaling: `verses x operations x 5min/op`, clamped 10-60 min
- Verse counts from `verse-counts.js`

Bootstrap cost estimates (from 101+ observed runs) are in `src/usage-tracker.js` (`BOOTSTRAP_DEFAULTS`). The `estimateTokens()` function blends bootstrap with observed medians as data accumulates.

## Environment variables

See `.env.example`:

| Variable | Description |
|---|---|
| `ZULIP_API_KEY` | Your Zulip API key |
| `ZULIP_EMAIL` | Your Zulip email |
| `ZULIP_REALM` | Zulip server URL |
| `PORT` | (optional) HTTP port |
| `DCS_TOKEN` | Door43/Gitea API token for repo pushes |
| `ANTHROPIC_API_KEY` | API key for Haiku NLU classifier |

## File structure

```
.env                        <- Credentials (not committed)
.env.example                <- Template
config.json                 <- Channel, topics, routes, usage tracking config
config.local.json           <- Admin/authorized user IDs (gitignored)
door43-users.json           <- Email-to-Door43 username map (gitignored)
Dockerfile                  <- node:22-slim + Python + Claude CLI, runs as botuser
docker-compose.yml          <- Mounts workspace, config, data, claude-config
package.json                <- Dependencies: claude-agent-sdk, anthropic, zulip-js

src/
  index.js                  <- Event loop: auth, poll Zulip events, filter, call router
  router.js                 <- Route matching, confirmation flow, pending merges, Haiku fallback
  config.js                 <- Merges config.json + config.local.json
  pipeline-runner.js        <- Dispatcher: sdk / notes / editor-note / interactive-dm
  claude-runner.js          <- SDK query() wrapper with timeout, abort, metrics hooks
  generate-pipeline.js      <- ULT+UST generation + alignment + Door43 push
  notes-pipeline.js         <- TN skill chain (issue-id -> tn-writer -> quality-check) + Door43 push
  note-pipeline.js          <- Editor note filing (appends to data/editor-notes/BOOK.md)
  interactive-dm-pipeline.js <- Multi-turn Claude sessions (admin DMs + stream sessions)
  intent-classifier.js      <- Haiku NLU fallback for natural-language commands
  usage-tracker.js          <- JSONL metrics, token estimates, preflight checks, ccusage
  door43-push.js            <- Deterministic Git+Gitea API push
  door43-push-cli.js        <- CLI wrapper for door43-push
  repo-verify.js            <- Gitea API verification that PR merged to master
  session-store.js          <- File-backed Claude session persistence
  auth-refresh.js           <- Proactive OAuth token refresh (8h tokens, 30min margin)
  pending-merges.js         <- File-backed pending merge state
  zulip-client.js           <- Zulip API wrapper (send, DM, reactions, file upload)
  pipeline-utils.js         <- Book name normalization, output file resolution, timeouts
  verse-counts.js           <- Verse count lookup for timeout/estimate calculations

pipelines/
  example.sh                <- Legacy shell pipeline template
  generate.sh               <- Legacy shell generator (superseded by generate-pipeline.js)
  zulip-helpers.sh          <- curl helpers for shell pipelines

data/
  metrics/usage.jsonl       <- Token usage log (auto-created)
  sessions/                 <- Multi-turn session state (auto-created)
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
