# Migration to Distroless Chainguard Node Image

## Context

The bot runs on `node:22-slim` (Debian) and depends on Python 3, git CLI, bash, and curl at runtime. The goal is to reach `cgr.dev/chainguard/node:latest` — truly distroless (no shell, no package manager) — without losing any functionality. This requires eliminating every system-level dependency from both the bot app and the workspace skills.

## Branching & Testing Strategy

All migration work happens on a long-lived feature branch. Production stays on `main` throughout. Each phase merges to `main` only after testing confirms no regressions.

### Branch structure

```
main (live production)
  └── feat/chainguard-migration (long-lived feature branch)
        ├── phase-0/dead-code-removal
        ├── phase-1/isomorphic-git
        ├── phase-2/bot-python-to-node
        ├── phase-3a/fetch-scripts
        ├── phase-3b/index-builders
        │   ... (one branch per batch)
        ├── phase-4/sdk-mcp-tools
        └── phase-5/distroless-image
```

### Per-phase workflow

1. **Branch off** `feat/chainguard-migration` (or `main` for Phase 0)
2. **Implement** the phase changes
3. **Test on branch** — build the Docker image from the branch, run locally or in a test container
4. **PR to `feat/chainguard-migration`** — review, merge
5. **For phases that don't touch the Dockerfile** (0-4): merge `feat/chainguard-migration` back to `main` once verified. These are backward-compatible — they still run on `node:22-slim`.
6. **For Phase 5** (the image swap): this is the big cutover — see below.

### Parallel Docker testing

The current production container is `zulip-bot`. During testing, run the Chainguard build as a **separate container** alongside production:

```yaml
# docker-compose.test.yml (separate file, doesn't touch production)
services:
  zulip-bot-test:
    build:
      context: .
      dockerfile: Dockerfile.chainguard   # or Dockerfile with build args
    container_name: zulip-bot-test
    env_file:
      - ../config/.env.test              # same keys, different bot identity or test channel
    environment:
      - CSKILLBP_DIR=/workspace
    volumes:
      - ../workspace:/workspace:ro        # read-only to avoid conflicts
      - ../config:/config:ro
      - ./data-test:/app/data             # separate data dir
      - claude-config:/claude-config:ro
    ports:
      - "127.0.0.1:3002:3001"            # different host port
    networks:
      - work-net
    deploy:
      resources:
        limits:
          memory: 4g
```

**Testing options:**
- **Silent mode:** Point test container at a test Zulip channel (e.g., "Bot testing" topic). Run generate/notes pipelines there. Compare output to production.
- **Cutover test:** Announce to users ("going down for 30 min"), stop production container, start test container on same port/config, test real workflows, stop test container, restart production.
- **Shadow mode:** Both containers read the same Zulip stream, but test container only logs (doesn't reply). Compare what it *would* have done.

### Cutover procedure (Phase 5)

```bash
# 1. Announce maintenance window
# 2. Verify no active pipelines
sudo docker logs zulip-bot --tail 30  # check for running pipelines

# 3. Stop production
cd /srv/bot/app && sudo docker compose down

# 4. Switch to Chainguard branch
git checkout main  # should already have phases 0-4 merged
git merge feat/chainguard-migration  # brings in Phase 5 Dockerfile changes

# 5. Build and start
sudo docker compose build && sudo docker compose up -d

# 6. Smoke test (trigger a small generate, check DMs work, check notes)

# 7. If problems — rollback:
git revert HEAD  # revert the Phase 5 merge
sudo docker compose down && sudo docker compose build && sudo docker compose up -d
```

### Rollback safety

- Phases 0-4 are all backward-compatible (still run on `node:22-slim`)
- Phase 5 is the only breaking change (Dockerfile swap)
- Keep the old Dockerfile as `Dockerfile.debian` for fast rollback
- The `feat/chainguard-migration` branch preserves the full history

---

## Current Runtime Dependency Map

### Bot App (Node.js shelling out)

| Dependency | Where | What it does |
|---|---|---|
| **bash** | `pipeline-runner.js:24` | `spawn('bash', [script])` — runs shell pipelines. **Already dead code** — all routes use `sdk`, `notes`, `editor-note`, or `interactive-dm` types. |
| **git** (14 ops) | `door43-push.js` | clone, fetch, checkout, branch, add, commit, push to Door43 |
| **git** (1 op) | `pipeline-utils.js:37` | `git ls-remote --heads` to check branch existence |
| **python3** (2 scripts) | `door43-push.js` | `insert_tn_rows.py`, `insert_usfm_verses.py` (Note: `validate_tn_files.py` lives in cloned Door43 repo `.gitea/workflows/`, not our codebase — does not need porting) |
| **python3** (2 scripts) | `parallel-batch.js` | `split_tsv.py`, `merge_tsvs.py` |
| **ccusage CLI** | `usage-tracker.js:324` | `npx ccusage@latest blocks --json --offline` — optional, already has graceful fallback |
| ~~**shell** (various)~~ | ~~`api-runner/tools.js`~~ | ~~Generic Bash/Glob/Grep tool executors~~ — **Removed** (commit `080562f`) |

> **`/cSkillBP` symlink:** `pipeline-utils.js:8` resolves `CSKILLBP_DIR` via `path.resolve(__dirname, '../../cSkillBP')`. Seven live modules depend on this. The Dockerfile symlink (`ln -s /workspace /cSkillBP`) must remain until `pipeline-utils.js` is updated to use `process.env.CSKILLBP_DIR` (fits naturally into Phase 1 or 2).

### Workspace Skills (Claude invokes via Bash tool at runtime)

**~43 Python scripts** across skills (includes 2 archived `.old/` files). Claude's Bash tool calls `python3 script.py` during agentic execution. The Bash tool itself requires `/bin/sh` to function (uses Node child_process under the hood).

Key script groups:
- **Fetch scripts** (8): HTTP downloads from Door43 — trivial to port
- **Index builders** (3): Parse USFM/TSV, build JSON — moderate
- **TN writer** (8): Alignment extraction, note assembly — complex (largest: `prepare_notes.py` at 902 lines)
- **Repo insert** (3): TSV/USFM insertion — complex (`insert_tn_rows.py` 449 lines, `insert_usfm_verses.py` 313 lines)
- **Quality checks** (3): Validation rules — complex (`check_tn_quality.py` 1,161 lines)
- **Other** (16): Misc utilities, validation, formatting

All use Python stdlib only (no pip packages except optional `requests` in 4 scripts).

## The Core Challenge: Claude SDK's Bash Tool

Even after rewriting all Python to Node.js, Claude's Bash tool needs `/bin/sh` to run `node script.js`. In a truly distroless container, no shell exists, so Bash tool calls fail.

**Solution: `createSdkMcpServer()`.** The Claude Agent SDK (confirmed in v0.2.77 installed in this project) has a first-class API for defining custom tools that run **in the same Node.js process** — no shell, no subprocess. Claude calls them as MCP tools; the handler is just an async function.

---

## Migration Phases

### Phase 0: Dead Code Removal (1-2 days)

Delete shell pipeline path — confirmed dead (no routes use it):
- Delete `pipelines/generate.sh`, `pipelines/zulip-helpers.sh`, `pipelines/example.sh`
- Delete `runShellPipeline()` from `pipeline-runner.js` (lines 5-63) and the else branch (line 83-84)
- Remove vestigial `"pipeline": "./pipelines/generate.sh"` from `config.json:29`

**Files:** `pipeline-runner.js`, `config.json`, `pipelines/`
**Branch:** Can merge directly to `main` — zero risk, just removing dead code.

---

### Phase 1: Replace git CLI with isomorphic-git (1-2 weeks)

Add `isomorphic-git` npm package. Rewrite `door43-push.js` to use pure-JS git:
- `syncRepo()`: clone, fetch, checkout, branch ops via isomorphic-git
- `commitAndPush()`: add, diff, commit, push via isomorphic-git with `onAuth` callback for token
- `git config user.*` via isomorphic-git config API
- `git remote` ops via isomorphic-git config API

Replace `git ls-remote` in `pipeline-utils.js` with Gitea API call (`GET /repos/{owner}/{repo}/branches/{branch}` — returns 200 or 404).

**Risk:** Moderate. isomorphic-git is mature but has behavioral differences (shallow clone handling, performance on large repos). Must test end-to-end with real Door43 repos.

**Verification:** Run full generate pipeline through Door43 push for a test chapter. Compare PR result and timing against git CLI baseline.

**Files:** `door43-push.js`, `pipeline-utils.js`, `package.json`
**Branch:** `phase-1/isomorphic-git` -> PR to `feat/chainguard-migration` -> merge to `main` after testing.

---

### Phase 2: Port Bot-App Python Scripts to Node.js (1-2 weeks)

Rewrite 4 Python scripts called directly by Node.js code:

| Script | Lines | Difficulty | Called from |
|---|---|---|---|
| `split_tsv.py` | 241 | Easy | `parallel-batch.js` |
| `merge_tsvs.py` | 132 | Easy | `parallel-batch.js` |
| `insert_tn_rows.py` | 449 | Hard | `door43-push.js` |
| `insert_usfm_verses.py` | 313 | Hard | `door43-push.js` |

> **Note:** `validate_tn_files.py` lives in the cloned Door43 repo's `.gitea/workflows/` directory, not our codebase. It does not need porting.

All are pure string/file operations. The Node.js ports replace `execFileSync('python3', ...)` calls with direct function calls.

**Verification:** Dual-run testing — run both Python and Node.js on identical inputs, diff outputs for 10+ chapters across different books.

**Files:** `door43-push.js`, `parallel-batch.js`, new files in `src/lib/`
**Branch:** `phase-2/bot-python-to-node` -> PR to `feat/chainguard-migration` -> merge to `main`.

---

### Phase 3: Port Workspace Python Scripts to Node.js (8-12 weeks, incremental)

Port all ~43 workspace Python scripts. Each batch is independently shippable — update the SKILL.md to reference `node script.js` instead of `python3 script.py`.

| Batch | Scripts | Est. | Notes |
|---|---|---|---|
| 3a: Fetch scripts | 8 scripts (~1,200 lines) | 1 week | Trivial HTTP to file, use Node https module |
| 3b: Index builders | 5 scripts (~1,650 lines) | 1.5 weeks | USFM parsing + JSON aggregation |
| 3c: Validators | 4 scripts (~700 lines) | 1 week | String pattern matching |
| 3d: Issue identification | 4 scripts (~800 lines) | 1 week | Diff/comparison logic |
| 3e: TN writer | 8 scripts (~2,770 lines) | 2-3 weeks | Hardest batch — `prepare_notes.py` (902 lines) |
| 3f: TN quality check | 3 scripts (~1,620 lines) | 1.5 weeks | `check_tn_quality.py` (1,161 lines) |
| 3g: Other skills | 5 scripts (~1,400 lines) | 1 week | Misc utilities |

**At the end of Phase 3:** No Python exists anywhere. Container needs only Node.js + shell (for Bash tool).

**Branch:** One branch per batch (`phase-3a/fetch-scripts`, etc.) -> PR to `feat/chainguard-migration`. Merge each batch to `main` individually as it's verified — these are backward-compatible since Node.js scripts work fine on `node:22-slim`.

**Note:** Phase 3 changes span both `/srv/bot/app` and `/srv/bot/workspace` repos. The workspace SKILL.md updates need to land alongside the Node.js script ports.

---

### Phase 4: Convert Scripts to In-Process SDK MCP Tools (2-3 weeks)

This is what makes distroless possible. The Claude Agent SDK `createSdkMcpServer()` API lets you define custom tools that run **in the same Node.js process** — no shell, no subprocess, no MCP server process to spawn.

**API (from `sdk.d.ts`):**

```js
const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');

const workspaceTools = createSdkMcpServer({
  name: 'workspace-tools',
  version: '1.0.0',
  tools: [
    tool(
      'build_strongs_index',
      'Build Strong\'s numbers index from Hebrew USFM source files',
      { bookFilter: z.string().optional() },
      async (args) => {
        const result = await require('./workspace-tools/build-strongs-index')(args);
        return { content: [{ type: 'text', text: result }] };
      }
    ),
    // ... one entry per ported script
  ],
});
```

Then in `claude-runner.js`, add to the SDK options:

```js
options.mcpServers = { 'workspace-tools': workspaceTools };
```

Claude sees these as MCP tools (e.g., `mcp__workspace-tools__build_strongs_index`) and calls them directly — the handler runs in-process as a Node.js function. **No shell needed.**

**Key types (confirmed in SDK v0.2.39):**
- `SdkMcpToolDefinition<Schema>` — `{ name, description, inputSchema, handler, annotations? }`
- `handler: (args, extra) => Promise<CallToolResult>` — returns `{ content: [{ type: 'text', text }] }`
- `createSdkMcpServer({ name, version?, tools? })` -> `McpSdkServerConfigWithInstance`
- `tool(name, description, inputSchema, handler)` — helper to construct tool definitions
- Works with both Zod 3 and Zod 4 schemas (project already uses Zod 4)

**What changes:**
1. Create `src/workspace-tools/index.js` — registers all ported Node.js scripts as SDK MCP tools
2. Update `claude-runner.js` `buildOptions()` to inject the MCP server into every SDK session
3. Update all SKILL.md files — replace `python3 .claude/skills/.../script.py` instructions with `mcp__workspace-tools__tool_name` tool references
4. Remove `Bash` from `DEFAULT_ALLOWED_TOOLS` in `claude-runner.js:22`

**Files:** `claude-runner.js`, new `src/workspace-tools/`, all `SKILL.md` files
**Branch:** `phase-4/sdk-mcp-tools` -> PR to `feat/chainguard-migration`. This phase does NOT merge to `main` independently — it's coupled with Phase 5 (removing Bash tool only makes sense when the image has no shell).

---

### Phase 5: Switch to Distroless Image (3-5 days)

Multi-stage Dockerfile:

```dockerfile
# Build stage
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

# Runtime stage — truly distroless
FROM cgr.dev/chainguard/node:latest
WORKDIR /app
COPY --from=build /app /app
# Chainguard runs as nonroot (uid 65532) by default
CMD ["src/index.js"]
```

**Volume permissions:** Chainguard default user is `nonroot` (UID 65532). Either:
- Override with `user: "1001"` in docker-compose.yml
- Or adjust host volume ownership

**Claude Code CLI:** No longer needed in container — the bot uses the SDK npm package, not the CLI binary. Remove the CLI install entirely.

**ccusage CLI:** Already has graceful fallback when unavailable. Remove the `ccusagePath` config.

**No shell, no Python, no git, no curl.** Pure Node.js runtime.

**Files:** `Dockerfile` (renamed current to `Dockerfile.debian` as rollback), `docker-compose.yml`
**Branch:** `phase-5/distroless-image` -> PR to `feat/chainguard-migration`. Phases 4+5 merge to `main` together as the cutover.

**Testing:** Use the parallel Docker testing strategy described above. Run `docker-compose.test.yml` with the Chainguard image alongside production for at least a full day of real usage before cutting over.

---

## Timeline Summary

| Phase | Duration | Image State | What's Eliminated | Merge to main? |
|---|---|---|---|---|
| 0: Dead code | 1-2 days | node:22-slim | Unused shell scripts | Yes (safe) |
| 1: isomorphic-git | 1-2 weeks | node:22-slim | git binary | Yes (backward-compat) |
| 2: Bot Python to Node | 1-2 weeks | node:22-slim | Python (bot-side) | Yes (backward-compat) |
| 3: Workspace Python to Node | 8-12 weeks | node:22-slim | Python entirely | Yes (per batch) |
| 4: Scripts to SDK tools | 2-3 weeks | node:22-slim | Bash tool dependency | No (coupled with 5) |
| 5: Distroless image | 3-5 days | **chainguard/node:latest** | Shell, apt, everything | Yes (cutover) |

**Total: ~14-20 weeks.** Each phase (except 4) is independently shippable and valuable.

## Key Risks

| Risk | Phase | Mitigation |
|---|---|---|
| isomorphic-git perf/compat | 1 | Parallel test against git CLI; benchmark on large repos |
| USFM/TSV port correctness | 2-3 | Dual-run testing harness, diff outputs |
| Claude SDK custom tool registration | 4 | Confirmed viable via `createSdkMcpServer()` in SDK v0.2.39 |
| api-runner shell dependency | 4 | May need `-dev` variant or sidecar if api-runner cannot go shell-free |
| Volume permissions with Chainguard UID | 5 | Test `user: "1001"` override in compose |
| Cutover downtime | 5 | Keep `Dockerfile.debian` for instant rollback; test in parallel first |

## Sources

- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Getting Started with Node Chainguard Container](https://edu.chainguard.dev/chainguard/chainguard-images/getting-started/node/)
- [How to Port Apps to Chainguard](https://edu.chainguard.dev/chainguard/migration/porting-apps-to-chainguard/)
- [Chainguard Node Image Directory](https://images.chainguard.dev/directory/image/node/overview)
- [isomorphic-git](https://isomorphic-git.org/)
- SDK type definitions: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
