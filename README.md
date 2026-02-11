# Zulip Bot — Message Monitor + Pipeline Router

Monitors specific topics in a Zulip channel (and your DMs), matches incoming messages against keyword rules, and runs shell scripts in response. Runs as **you** using your personal API key.

## Quick start

```bash
# Make sure .env has your credentials (see .env.example)
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
- **Topics:** Psalms BP, AI Work, Workflow, BP Proofreading, Proofreading Queue, Jeremiah BP
- **DMs:** yes (any direct message to you)

Messages in other channels/topics are ignored. Messages you send yourself are always ignored (no echo loops).

## How routing works

When someone posts a message in a watched topic (or DMs you), the bot checks `config.json` routes **top to bottom**. The first match wins.

### Current routes

| Route | Trigger | Script | Replies? |
|---|---|---|---|
| `generate-content` | `/generate\s+(\w+)\s+(\d+)(?:\s*[-–—to]+\s*(\d+))?/i` | `./pipelines/generate.sh` | No — script posts its own replies incrementally via Zulip API |
| `proofread-complete` | Message contains "proofed and up to master" | `./pipelines/next-step.sh` | No — runs silently |

If nothing matches, the message is logged and skipped (no `defaultPipeline` is set).

### generate-content route

Triggered by messages like `generate psa 79` or `generate psa 79-89`. The script:

1. Parses the book code and chapter range from the message
2. Estimates token usage (chapters × 5M tokens) and checks it against the session budget (45M)
3. Loops through each chapter, running `claude -p "/initial-pipeline BOOK CH"` in the `../cSkillBP` directory
4. After each chapter, reads the output USFM files and posts ULT + UST back to the Zulip thread
5. Posts a summary when done

Token estimates and durations are logged to `logs/generate.log` for calibration.

### Testing with example.sh

To test the basic round-trip, point a route at the included example script:

```json
{
  "name": "test",
  "match": "hello bot",
  "pipeline": "./pipelines/example.sh",
  "reply": true
}
```

Then send "hello bot" in a watched topic. The bot will run `example.sh` and post its stdout back:

> Hello from the example pipeline! Message from Some User in CONTENT - UR > AI Work

## Testing scenarios

| You send... | Where | What happens |
|---|---|---|
| "generate psa 79" | `CONTENT - UR` > `AI Work` | Matches `generate-content`, runs generate pipeline for PSA chapter 79 |
| "generate psa 79-82" | `CONTENT - UR` > `Psalms BP` | Matches `generate-content`, loops through chapters 79–82 |
| "generate blah" | `CONTENT - UR` > `AI Work` | Matches route regex but fails parse — bot replies with a usage hint |
| "proofed and up to master" | `CONTENT - UR` > `Psalms BP` | Matches `proofread-complete` route, runs `next-step.sh`, no reply |
| "just a normal message" | `CONTENT - UR` > `Workflow` | No route matches, logs `[router] No match for message ..., skipping` |
| anything | `CONTENT - UR` > `Some Other Topic` | Ignored entirely (topic not in watch list) |
| anything | A different channel | Ignored entirely (not subscribed to that channel's events) |
| anything | DM to you | Checked against routes like a stream message |
| you send a message yourself | anywhere | Skipped (self-message filtering) |

## Dry-run mode (testing without Claude)

You can test `generate.sh` without actually running `claude` or posting to Zulip by setting `DRY_RUN=1`. This prints all Zulip messages to stderr and creates stub USFM files instead of invoking the pipeline.

```bash
# Single chapter
DRY_RUN=1 ZULIP_MSG_CONTENT="generate psa 79" \
  ZULIP_MSG_STREAM="test" ZULIP_MSG_TOPIC="test" \
  ZULIP_EMAIL=x ZULIP_API_KEY=x ZULIP_REALM=x \
  bash pipelines/generate.sh

# Range
DRY_RUN=1 ZULIP_MSG_CONTENT="generate psa 79-81" \
  ZULIP_MSG_STREAM="test" ZULIP_MSG_TOPIC="test" \
  ZULIP_EMAIL=x ZULIP_API_KEY=x ZULIP_REALM=x \
  bash pipelines/generate.sh

# Bad input (should print parse error)
DRY_RUN=1 ZULIP_MSG_CONTENT="generate blah" \
  ZULIP_MSG_STREAM="test" ZULIP_MSG_TOPIC="test" \
  ZULIP_EMAIL=x ZULIP_API_KEY=x ZULIP_REALM=x \
  bash pipelines/generate.sh
```

You'll see each Zulip message that *would* be posted, the stub file contents, and the final summary — all on stderr.

## Writing a pipeline script

Pipeline scripts are shell scripts in the `pipelines/` directory. They receive message context as environment variables:

| Variable | Description |
|---|---|
| `ZULIP_MSG_ID` | Message ID |
| `ZULIP_MSG_CONTENT` | Raw message text |
| `ZULIP_MSG_SENDER` | Sender's email |
| `ZULIP_MSG_SENDER_NAME` | Sender's full name |
| `ZULIP_MSG_STREAM` | Stream name, or `dm` for direct messages |
| `ZULIP_MSG_TOPIC` | Topic name (empty for DMs) |
| `ZULIP_MSG_TIMESTAMP` | Message timestamp |
| `ZULIP_ROUTE_NAME` | Which route was matched |

- **stdout** is captured. If the route has `"reply": true`, stdout gets posted back to the same Zulip thread (or DM).
- **stderr** is logged to the bot's console for debugging.
- If the script exits non-zero, the error is logged but the bot keeps running.

See `pipelines/example.sh` for a working template.

## Adding a new route

1. Write your script in `pipelines/` and make it executable (`chmod +x`)
2. Add a route entry to the `routes` array in `config.json`:

```json
{
  "name": "my-route",
  "match": "trigger phrase",
  "pipeline": "./pipelines/my-script.sh",
  "reply": true
}
```

3. Restart the bot (`Ctrl+C`, then `npm start`) — config is loaded at startup

### Match patterns

- **Substring:** `"match": "please generate"` — case-insensitive substring match
- **Regex:** `"match": "/^generate\\s+\\w+/i"` — wrap in `/slashes/` with optional flags

## Config reference

```jsonc
{
  "channel": "CONTENT - UR",       // Stream to monitor
  "topics": ["Topic A", "Topic B"], // Only these topics (exact match)
  "watchDMs": true,                 // Also monitor direct messages
  "routes": [                       // Checked top-to-bottom, first match wins
    {
      "name": "route-name",         // Label for logging
      "match": "keyword or /regex/",// Trigger pattern
      "pipeline": "./pipelines/x.sh", // Script to run
      "reply": true                 // Post stdout back to Zulip?
    }
  ],
  "defaultPipeline": null           // Script for unmatched messages (null = skip)
}
```

## File structure

```
.env                    ← Zulip credentials (not committed)
config.json             ← What to watch, routing rules
src/
  index.js              ← Event loop: connect, poll, filter
  router.js             ← Match messages to routes
  zulip-client.js       ← Zulip API wrapper
  pipeline-runner.js    ← Run scripts, capture output, reply
pipelines/
  example.sh            ← Working template for testing
  zulip-helpers.sh      ← Shared curl helpers (zulip_reply, zulip_dm)
  generate.sh           ← Generation pipeline (cSkillBP /initial-pipeline)
logs/
  generate.log          ← Timing + exit codes per chapter (auto-created)
```
