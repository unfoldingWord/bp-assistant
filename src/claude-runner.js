// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

const { ensureFreshToken } = require('./auth-refresh');
const { recordRateLimit, getHeadroom } = require('./usage-tracker');
const { createWorkspaceTools, createTnWriterTools, createQualityTools, createIssueIdTools } = require('./workspace-tools');
const { publishAdminStatus } = require('./admin-status');
const { resolveDifficultyModel, resolveDifficultyEffort } = require('./api-runner/provider-config');
const {
  createRunLog,
  recordAssistantMessage,
  recordUserMessage,
  recordResult,
} = require('./run-logs');

let _query = null;
let _sdkCreateSdkMcpServer = null;
let _sdkTool = null;
let _z = null;

async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

// Returns a NEW server instance every call — never cached.
// The SDK connects a transport to each instance; reusing one across parallel
// runClaude() calls causes "Already connected to a transport" crashes.
async function createFreshWorkspaceToolsServer(toolSet) {
  if (!_sdkCreateSdkMcpServer) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _sdkCreateSdkMcpServer = sdk.createSdkMcpServer;
    _sdkTool = sdk.tool;
    _z = require('zod').z;
  }
  const factories = {
    'tn-writer': createTnWriterTools,
    quality: createQualityTools,
    'issue-id': createIssueIdTools,
    // Empty server for pure-text calls (per-note/AT generation) that pass
    // tools:[] — avoids attaching the full ~52-tool workspace set they never use.
    none: (createServer) => createServer({ name: 'workspace-tools', version: '1.0.0', tools: [] }),
  };
  const factory = factories[toolSet] || createWorkspaceTools;
  return factory(_sdkCreateSdkMcpServer, _sdkTool, _z);
}

// Default: 10 minutes per invocation, 200 turns max
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;

// Reasoning controls for the Claude Agent SDK. Opus 4.6+ and Sonnet 4.6 use
// adaptive thinking plus an `effort` level instead of a fixed token budget;
// `thinking: {type:'enabled', budget_tokens}` is removed on Opus 4.7/4.8 and
// returns a 400. We translate the runner's `thinking` arg into {thinking, effort}.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Map the runner's `thinking` arg to Agent SDK reasoning options.
// Returns { thinking?: ThinkingConfig, effort?: EffortLevel }.
// Effort + adaptive thinking apply only to effort-capable models (Opus, Sonnet,
// Fable); Haiku and others get no thinking option (effort would 400 there).
function resolveReasoning(thinking, resolvedModel) {
  const supportsEffort = typeof resolvedModel === 'string' && /opus|sonnet|fable/i.test(resolvedModel);
  // Explicit off — disable extended thinking. Only effort-capable models accept
  // a `thinking` param; others must omit it entirely (matches prior behavior of
  // returning null/setting nothing) to avoid a 400.
  if (thinking === false || thinking === 'off' || thinking === 'none') {
    return supportsEffort ? { thinking: { type: 'disabled' } } : {};
  }
  // Explicit effort level (e.g. 'high', 'xhigh').
  if (typeof thinking === 'string') {
    if (!EFFORT_LEVELS.includes(thinking)) {
      throw new Error(`Unrecognized thinking level: '${thinking}' (expected one of: ${EFFORT_LEVELS.join(', ')}, 'off')`);
    }
    return supportsEffort ? { thinking: { type: 'adaptive' }, effort: thinking } : {};
  }
  // Legacy numeric budget: adaptive thinking has no fixed token budget. Map by
  // magnitude to an effort level (preserving "max"-sized hints) and warn, so
  // callers migrate to an explicit effort string ('low'..'max').
  if (typeof thinking === 'number') {
    if (!supportsEffort) return {};
    const effort = thinking >= 31999 ? 'max'
      : thinking >= 20000 ? 'high'
      : thinking >= 10000 ? 'medium'
      : 'low';
    console.warn(`[claude-runner] Numeric thinking budget (${thinking}) is deprecated; mapping to effort '${effort}'. Pass an effort level ('low'|'medium'|'high'|'xhigh'|'max') instead.`);
    return { thinking: { type: 'adaptive' }, effort };
  }
  // Auto-default (null/undefined): floor of `high` effort for effort-capable
  // models; Haiku/others let the model default (no extended thinking).
  return supportsEffort ? { thinking: { type: 'adaptive' }, effort: 'high' } : {};
}

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'Skill', 'SendMessage',
  'Agent', 'TeamCreate', 'TeamDelete',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'WebFetch', 'WebSearch',
];

// Restricted profile for shell-less runs (distroless-compatible).
const DEFAULT_RESTRICTED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'TaskOutput', 'Skill', 'SendMessage',
  'Agent', 'TeamCreate', 'TeamDelete',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'WebFetch', 'WebSearch',
];

// Restricted profile + Bash. Used by pipeline runs that opt in via
// enableBash so agents run workspace tools through the CLI wrapper
// (node /app/src/workspace-tools-cli.js) instead of the in-process MCP
// transport that tears down mid-run (JER 32/33, AMO 5, ZEC 10). The MCP
// server stays registered as the Option-B fallback.
const DEFAULT_BASH_TOOLS = [...DEFAULT_RESTRICTED_TOOLS, 'Bash'];

// Scoped Bash permission rules that auto-approve deterministically under
// permissionMode:'auto' (zero prompt latency). Anything outside these prefixes
// falls to the model classifier — which approves/denies but never hangs an
// unattended run. Phase 5 will harvest real usage from logs and flip to
// 'dontAsk'. Rule syntax: Bash(<prefix>:*) — see SDK sdk.d.ts permissions.allow.
const BASH_ALLOW_RULES = [
  'Bash(node /app/src/workspace-tools-cli.js:*)',
  'Bash(node /app/src/door43-push-cli.js:*)',
  'Bash(node .claude/skills/utilities/scripts/:*)', // live validation .mjs; cwd=/data/workspace
  'Bash(grep:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(ls:*)', 'Bash(cat:*)',
];

// Kill switch: `fly secrets set BP_DISABLE_BASH=1` reverts the fleet to
// MCP-only on the next machine restart without touching either repo (skills
// keep their Option-B MCP fallback). enableBash is a no-op when set.
function bashEnabled(enableBash) {
  return Boolean(enableBash) && process.env.BP_DISABLE_BASH !== '1';
}

// Deterministic permission policy for tool calls the CLI's rule layer does not
// resolve on its own — which in practice is EVERY sub-agent tool call: the
// top-level `allowedTools` auto-approval does not extend into Task/Agent
// children, so their calls fall to the 'auto'-mode model classifier. That
// classifier degrades under parallel load (an 8-way opus batch fan-out) and
// then denies allowlisted tools nondeterministically — the same child that just
// Read a skill file gets its next Read denied with "The user doesn't want to
// take this action right now. STOP..." and align batches produce nothing
// (issues #195/#235/#238/#242; isolated 2026-07-21 via live repros: identical
// parallel Read-only children pass under light load and mass-deny under the
// production fan-out). Registered as the SDK `canUseTool` callback, this
// replaces the classifier with a pure allowlist so child permissions are
// deterministic. Deny messages carry redirect guidance and never the CLI's
// canned "STOP and wait" text that halts agents.
const SUBAGENT_TOOL_ALLOWLIST = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'TaskOutput', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Agent', 'Skill', 'SendMessage', 'TeamCreate', 'TeamDelete',
  'NotebookEdit', 'WebFetch', 'WebSearch',
]);

// Bash policy mirroring BASH_ALLOW_RULES (kept in sync by the test suite):
// blessed executables by path prefix, plus bounded read-only inspection
// commands. Command chaining/substitution is refused outright — the same
// conservatism the CLI's own prefix rules apply — so a matching prefix can't
// smuggle a second command.
const BASH_EXEC_PREFIXES = [
  'node /app/src/workspace-tools-cli.js',
  'node /app/src/door43-push-cli.js',
  'node .claude/skills/utilities/scripts/',
];
const BASH_READONLY_CMDS = ['grep', 'head', 'tail', 'wc', 'ls', 'cat'];
const BASH_CHAIN_RE = /(\$\(|`|&&|\|\||;)/;
// Pipes, redirection, and newline-separated commands are chaining too: without
// this, "ls output | xargs rm -rf output" or "cat a > b" would ride a
// read-only prefix (review finding on #243).
const BASH_PIPE_REDIRECT_RE = /[|<>\n]/;
// The one sanctioned use of redirection: the CLI wrapper's documented stdin
// form (`node …-cli.js <tool> - <<'EOF' … EOF`). The heredoc must consume the
// remainder of the command — body content is literal text (JSON payloads may
// legitimately contain |, >, quotes), but nothing may follow the delimiter.
const BASH_HEREDOC_RE = /^<<-?\s*(['"]?)(\w+)\1\n[\s\S]*\n\2\s*$/;

function decideBashPermission(input) {
  const cmd = String((input && input.command) || '').trim();
  const heredocAt = cmd.indexOf('<<');
  const head = heredocAt >= 0 ? cmd.slice(0, heredocAt) : cmd;
  const headUnsafe = BASH_CHAIN_RE.test(head) || BASH_PIPE_REDIRECT_RE.test(head);
  if (!headUnsafe) {
    if (BASH_EXEC_PREFIXES.some((p) => cmd.startsWith(p))) {
      if (heredocAt < 0 || BASH_HEREDOC_RE.test(cmd.slice(heredocAt))) {
        return { behavior: 'allow', updatedInput: input };
      }
    } else if (heredocAt < 0 && BASH_READONLY_CMDS.some((c) => cmd === c || cmd.startsWith(`${c} `))) {
      return { behavior: 'allow', updatedInput: input };
    }
  }
  return {
    behavior: 'deny',
    message:
      'This Bash command is outside the headless allow-list (no pipes, redirection, or compound ' +
      "commands; only the workspace-tools CLI wrapper and simple read-only commands). Use " +
      "node /app/src/workspace-tools-cli.js <tool> '<json>' (heredoc stdin form is fine), or the " +
      'Read/Glob/Grep tools for file checks, and continue with the task.',
  };
}

function decideToolPermission(toolName, input) {
  const name = String(toolName || '');
  if (name.startsWith('mcp__workspace-tools__')) {
    return { behavior: 'allow', updatedInput: input };
  }
  if (name === 'Bash') {
    return decideBashPermission(input);
  }
  if (SUBAGENT_TOOL_ALLOWLIST.has(name)) {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message: `The ${name} tool is not available in this headless run. Switch to an allowed tool (Read, Write, Glob, Grep, or the workspace-tools CLI wrapper) and continue with the task.`,
  };
}

// Permission-denial stall detection (issues #235 / #238). Headless pipeline runs
// use permissionMode:'auto' with NO approval callback, so any tool call outside the
// narrow allow-rules is auto-denied with "The user doesn't want to take this action
// right now. STOP what you are doing and wait for the user...". A sub-agent that
// obeys that literally halts and the run burns silently to the timeout (#235). But
// denials are NOT inherently fatal: parallel batch sub-agents routinely burn a few
// improvised probes at startup and then carry on with allowed tools — a cumulative
// count of 3 aborted a healthy 8-agent run in its first seconds (#238). So the
// fail-safe is time-based, not count-based: abort only when a denial is followed by
// NO productive tool result for the whole stall window. A true stall goes silent
// (or loops on denials); a healthy run keeps producing results that clear the window.
const PERMISSION_STALL_WINDOW_MS = Number(process.env.BP_PERMISSION_STALL_WINDOW_MS) > 0
  ? Number(process.env.BP_PERMISSION_STALL_WINDOW_MS)
  : 5 * 60 * 1000;
const PERMISSION_STALL_POLL_MS = 30 * 1000;

// Permission WALL detection (EZK 19, 2026-07-24 — issue #271). Distinct from the
// stall above, and the stall's time-based fail-safe cannot catch it: a wall denies
// EVERY tool call in the session tree — parent and sub-agents alike — including
// calls that are unambiguously granted. EZK 19 took 16 straight denials of `Read`,
// `Glob`, `TaskOutput`, `Agent`, the mandated `node workspace-tools-cli.js` wrapper
// AND `mcp__workspace-tools__read_usfm_chapter`, then the coordinator returned a
// normal result at 88s — so the 300s stall window never elapsed, nothing was
// flagged, and the coverage gate misfiled it as `missing_output` ("re-run the
// coordinator"). The align run passes bypassPermissions:true, so the refusal comes
// from ABOVE the SDK's local permission config; nothing in our allowlists can fix
// it. It is transient, so the correct response is backoff-and-retry, not failure.
//
// The discriminator is QUALITATIVE, not a denial count. A count regresses #238,
// where a healthy 8-agent fan-out burned several improvised raw-shell probes at
// startup and recovered — a cumulative count of 3 false-aborted it. Instead: Bash
// is the only tool whose grant is argument-level (BASH_ALLOW_RULES gate individual
// commands), so a denied Bash call is genuinely ambiguous and is NOT wall evidence.
// Every other tool is granted (or not) for the whole session, so a denial of one
// cannot be an allowlist mismatch — it can only be an external refusal. #238's
// probes were all Bash and would score zero here; EZK 19 scored on its very first
// denial (a plain `Read` inside cwd).
const PERMISSION_WALL_DENIAL_LIMIT = Number(process.env.BP_PERMISSION_WALL_DENIALS) > 0
  ? Number(process.env.BP_PERMISSION_WALL_DENIALS)
  : 2;

// Wall recovery budget. The wall is transient but not brief: on EZK 19 it was still
// up 2min8s after it appeared (19:36:36 -> 19:38:44, both align attempts), and had
// cleared by the time the chapter was triaged. So retries must be patient and widely
// spaced — a tight loop just re-denies. Sized against the align timeout (150min), so
// spending up to 20min waiting out a wall is cheap next to losing the chapter and a
// human triage cycle. Separate from TRANSIENT_RETRY_WINDOW_MS because the SDK-outage
// window (10min, 5s base) is far too impatient for this failure mode.
const PERMISSION_WALL_RETRY_WINDOW_MS = Number(process.env.BP_PERMISSION_WALL_WINDOW_MS) > 0
  ? Number(process.env.BP_PERMISSION_WALL_WINDOW_MS)
  : 20 * 60 * 1000;
const PERMISSION_WALL_BASE_DELAY_MS = 60 * 1000;
const PERMISSION_WALL_MAX_DELAY_MS = 5 * 60 * 1000;

const TRANSIENT_RETRY_WINDOW_MS = 10 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 60000;

class ClaudeTransientOutageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudeTransientOutageError';
    this.details = details;
  }
}

function buildOptions({
  cwd,
  resume,
  model,
  betas,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  enableBash,
  bypassPermissions,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  abortController,
  mcpServers,
  thinking,
  hooks,
  compaction,
}) {
  const options = {
    cwd: cwd || process.cwd(),
    abortController: abortController || new AbortController(),
    maxTurns: maxTurns || DEFAULT_MAX_TURNS,
    allowedTools: allowedTools || DEFAULT_ALLOWED_TOOLS,
    permissionMode: 'auto',
    settingSources: disableLocalSettings ? ['user', 'project'] : ['user', 'project', 'local'],
    persistSession: true,
  };
  // Permission strategy. The 'auto' mode routes every non-read-only tool call
  // (Write, Bash, Skill, mutating MCP calls) through a live safety-classifier
  // model; when that model is unavailable or throttled — which is exactly what
  // happens while an 8-sub-agent align fan-out saturates the account — the call
  // is denied with "The user doesn't want to take this action right now.
  // STOP..." and batch agents produce nothing (#195/#235/#238/#242; the
  // verbose form of the denial names the mechanism outright: "claude-sonnet-5
  // is temporarily unavailable, so auto mode cannot determine the safety of
  // Bash right now"). Pipeline runs that opt in via `bypassPermissions` skip
  // that classifier entirely: the pipeline is a trusted headless system
  // driving its own bounded tools on its own machine, its tool universe stays
  // restricted via `tools:`, and the skills enforce CLI-wrapper Bash
  // discipline. Kill switch: `fly secrets set BP_NO_BYPASS=1` reverts opted-in
  // runs to classifier-mediated 'auto' on the next restart. Non-bypass runs
  // register decideToolPermission as canUseTool — a pure, never-prompting
  // fallback decider for calls the rule layer routes to a custom handler.
  // A permission callback is now registered in BOTH branches (issue #271, EZK 19) —
  // but a DIFFERENT one, because the two kinds of run want opposite things.
  //
  // Why any callback is needed on bypass runs: `permissionMode` is per-agent (see the
  // SDK's AgentDefinition.permissionMode), so setting it here bypasses the classifier
  // for the TOP-LEVEL query only. Spawned Task/Agent children carry their own mode and
  // fall back to the load-degraded 'auto' classifier documented above, which
  // mass-denies even allowlisted tools under an opus fan-out (#195/#235/#238/#242).
  // EZK 19 is the clean demonstration: the align coordinator's own calls succeeded for
  // 19s (parent honoured the bypass), then 6.3s after the second sub-agent spawn the
  // CHILDREN's calls began being denied with the CLI's canned "STOP and wait" text —
  // 16 in a row, Read/Glob/TaskOutput/Agent/mcp__workspace-tools__* and the CLI
  // wrapper alike — and the chapter banked nothing. `canUseTool` is a session-level
  // callback and is the mechanism #243 already relies on to make child permissions
  // deterministic; it was simply never installed on the runs that needed it most.
  //
  // Why bypass runs get ALLOW-ALL rather than decideToolPermission: a bypass run has
  // explicitly declared itself trusted (allowDangerouslySkipPermissions) and bounds
  // its own tool universe via `tools:`. Its goal is not to restrict anything — it is
  // to guarantee nothing is spuriously DENIED. Handing it the restrictive allowlist
  // would be a severe regression rather than a fix: replaying the 50 distinct Bash
  // commands from EZK 19's SUCCESSFUL initial-pipeline run through
  // decideToolPermission denies 45 of them (mkdir -p, awk, sed, cp, python3,
  // for/until polling loops, pipes, &&) — all of which are legitimate today and work
  // precisely because bypass runs carry no decider. So allow-all is the faithful
  // enforcement of what the caller already asked for, made deterministic so a
  // degraded classifier can no longer overrule it for children.
  //
  // Non-bypass runs keep the restrictive decider: they never opted into trust, so the
  // allowlist is what bounds them, and it never emits the canned "STOP and wait" text
  // that halts sub-agents.
  //
  // Kill switch: BP_NO_BYPASS=1 sends opted-in runs down the restrictive branch.
  if (bypassPermissions && process.env.BP_NO_BYPASS !== '1') {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
    options.canUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });
  } else {
    options.canUseTool = async (toolName, input) => decideToolPermission(toolName, input);
  }
  if (tools) {
    options.tools = tools;
  }
  if (disallowedTools) {
    options.disallowedTools = disallowedTools;
  }
  if (forceNoAutoBashSandbox) {
    options.settings = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
      },
    };
  }
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }
  if (resume) {
    options.resume = resume;
  }
  // Resolve difficulty tiers (low/medium/high) -> top model (Opus) + effort, and
  // apply per-run overrides (BP_FORCE_MODEL / BP_MODEL_*). Non-tier value => model
  // unchanged. When the caller didn't pass an explicit `thinking`, a difficulty
  // tier sets the reasoning effort (that's the cost/latency lever now).
  const requestedModel = model || 'opus';
  options.model = resolveDifficultyModel('claude', requestedModel);
  const tierEffort = resolveDifficultyEffort(requestedModel);
  const reasoning = resolveReasoning(thinking != null ? thinking : tierEffort, options.model);
  if (reasoning.thinking) options.thinking = reasoning.thinking;
  if (reasoning.effort) options.effort = reasoning.effort;
  if (betas) {
    options.betas = betas;
  }
  if (appendSystemPrompt) {
    options.systemPrompt = appendSystemPrompt;
  }
  // Phase 3: declarative guard/observability hooks (PreToolUse/PostToolUse/…).
  // Optional + additive — when no caller passes `hooks`, options are byte-identical.
  if (hooks) {
    options.hooks = hooks;
  }
  // Difficulty-based model control for sub-agents. Skills spawn Task/Agent workers
  // with a difficulty tier (low/medium/high) or alias; this hook resolves that to a
  // concrete model and applies any per-run override (BP_FORCE_MODEL / BP_MODEL_*)
  // before the sub-agent runs — the missing link that makes a run-level model force
  // reach orchestrator-spawned workers, not just the top-level query. It only mutates
  // input (no permissionDecision), so it composes with the guard hooks above; it is a
  // no-op when the spawn's model is already concrete and no override is set.
  // Sub-agent spawn pacing. Closure-scoped, so the gap is enforced per query
  // rather than globally — concurrent pipelines do not delay each other.
  //
  // Every observed align lockout began within seconds of the SECOND sub-agent
  // spawn, and only when the two spawns were close together: AMO 8 failed three
  // times at 2.4-3.0s apart (2026-07-23 21:40/21:44, 2026-07-24 01:40), while
  // initial-pipeline's healthy fan-out the same evening spawned 8s apart and made
  // 29 tool calls with zero denials. Once the wall goes up, every tool call in
  // the session tree is denied — parent and children alike — and the run banks
  // nothing. Pacing the spawns removes the race.
  //
  // Enforced here rather than in skill prose deliberately: align-all-parallel
  // already says "spawn in parallel (single message)" and the model already
  // ignores the frontmatter's `Task` in favour of `Agent`, so prose is not a
  // control surface. The hook is the only choke point before a spawn.
  //
  // Cost is bounded and small next to the work: a 14-verse chapter pays one gap,
  // an 8-way EZK-16-scale fan-out pays ~56s against a 30-minute alignment.
  // Tunable via BP_SUBAGENT_SPAWN_INTERVAL_MS; 0 disables.
  let lastSpawnAt = 0;
  const spawnGapMs = process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS != null
    ? Number(process.env.BP_SUBAGENT_SPAWN_INTERVAL_MS)
    : 8000;

  const modelResolverMatcher = {
    hooks: [async (input) => {
      try {
        const tool = input && input.tool_name;
        if (tool !== 'Task' && tool !== 'Agent') return {};

        // Pace before anything else, so the delay applies even when no model or
        // effort rewrite is needed and the hook would otherwise return early.
        if (Number.isFinite(spawnGapMs) && spawnGapMs > 0) {
          const since = Date.now() - lastSpawnAt;
          if (lastSpawnAt !== 0 && since < spawnGapMs) {
            const waitMs = spawnGapMs - since;
            console.log(`[spawn-pace] holding ${tool} spawn ${waitMs}ms (min gap ${spawnGapMs}ms since last spawn)`);
            await sleep(waitMs);
          }
          lastSpawnAt = Date.now();
        }

        const ti = input.tool_input;
        if (!ti || typeof ti !== 'object' || typeof ti.model !== 'string') return {};
        const resolved = resolveDifficultyModel('claude', ti.model);
        const tierEffort = resolveDifficultyEffort(ti.model); // set effort only when spawn used a tier and caller didn't specify one
        const modelChanged = resolved && resolved !== ti.model;
        const effortChanged = tierEffort && ti.effort == null && ti.effort !== tierEffort;
        if (!modelChanged && !effortChanged) return {};
        const updatedInput = { ...ti };
        if (modelChanged) updatedInput.model = resolved;
        if (effortChanged) updatedInput.effort = tierEffort;
        // Auditable: makes a per-run force/override + difficulty->effort observable in run logs.
        console.log(`[model-select] ${tool} sub-agent ${ti.model}${modelChanged ? ` model->${resolved}` : ''}${effortChanged ? ` effort->${tierEffort}` : ''}${process.env.BP_FORCE_MODEL ? ' (forced)' : ''}`);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
      } catch (err) {
        console.warn(`[claude-runner] model-resolver hook error: ${err.message}`);
        return {};
      }
    }],
  };
  const existingPreToolUse = (options.hooks && options.hooks.PreToolUse) || [];
  options.hooks = { ...(options.hooks || {}), PreToolUse: [...existingPreToolUse, modelResolverMatcher] };
  // Phase 3 (pilot): opt-in Agent-SDK auto-compaction, default OFF. This is the
  // Agent SDK's CLI auto-compact (settings.autoCompactEnabled), NOT the raw
  // Messages-API `compact-2026-01-12` beta. Spread-merge so we don't clobber the
  // sandbox `settings` set by forceNoAutoBashSandbox above.
  if (compaction && compaction.enabled) {
    options.settings = {
      ...(options.settings || {}),
      autoCompactEnabled: true,
      ...(compaction.window ? { autoCompactWindow: compaction.window } : {}),
    };
  }
  // Bash enablement (Phase 1). Runs last so it composes with the sandbox and
  // compaction settings above.
  if (enableBash) {
    if (bashEnabled(enableBash)) {
      // Ensure Bash is in the tool allowlist, add the scoped auto-approve
      // rules, and disable the (nonexistent on Fly) sandbox so Bash doesn't
      // prompt/hang unattended.
      if (Array.isArray(options.tools) && !options.tools.includes('Bash')) {
        options.tools = [...options.tools, 'Bash'];
      }
      if (Array.isArray(options.allowedTools) && !options.allowedTools.includes('Bash')) {
        options.allowedTools = [...options.allowedTools, 'Bash'];
      }
      const prevPerms = (options.settings && options.settings.permissions) || {};
      options.settings = {
        ...(options.settings || {}),
        sandbox: { enabled: false },
        permissions: {
          ...prevPerms,
          allow: [...(prevPerms.allow || []), ...BASH_ALLOW_RULES],
        },
      };
    } else {
      // Kill switch (BP_DISABLE_BASH=1): callers still pass DEFAULT_BASH_TOOLS
      // (which contains 'Bash'), so we must STRIP it from the allowlist to
      // truly revert the fleet to MCP-only — skipping the permission rules
      // alone would leave Bash usable via the 'auto' classifier.
      if (Array.isArray(options.tools)) options.tools = options.tools.filter((t) => t !== 'Bash');
      if (Array.isArray(options.allowedTools)) options.allowedTools = options.allowedTools.filter((t) => t !== 'Bash');
    }
  }
  return options;
}

// Pure classifier for an SDK `user` message body. Extracted (with the reducer
// below) so the runner's error-tracking state machine can be unit-tested without
// driving a live query() stream. `text` is the stringified message content.
function classifyRunnerUserMessage(text) {
  const lower = String(text || '').toLowerCase();
  // Transport-level teardown of the in-process workspace-tools MCP surfaces as an
  // is_error tool_result whose content is "Stream closed" (NOT a tool_use_error).
  const isTransportClosed = lower.includes('stream closed') && lower.includes('is_error');
  // Headless permissionMode:'auto' with no approval callback auto-denies out-of-
  // allowlist tool calls with this text; sub-agents obey it literally and stall.
  // Matches neither the transport nor tool_use_error signature (issue #235, EZK 16).
  // Require the is_error marker (like isTransportClosed above): the denial arrives
  // ONLY as an is_error tool_result. Without this guard a *successful* Read/Grep of
  // a log, issue, or test file that merely QUOTES the denial phrase would be
  // miscounted as a stall and could false-abort a healthy run after 3 such reads.
  const isPermissionDenied = lower.includes('is_error')
    && (lower.includes("doesn't want to take this action")
      || lower.includes('stop what you are doing and wait for the user'));
  const isToolError = lower.includes('tool_use_error');
  const isToolResult = lower.includes('tool_result');
  let toolErrorSig = null;
  if (isToolError) {
    toolErrorSig = lower.includes('string to replace not found')
      ? 'string_not_found'
      : lower.includes('no changes to make')
        ? 'no_op_edit'
        : lower.includes('file has been modified since read')
          ? 'stale_edit'
          : 'other_tool_error';
  }
  // The denial arrives as a tool_result carrying the id of the tool_use it refused.
  // The caller resolves that id back to a tool NAME (see pendingToolUses in the
  // stream loop) so the wall discriminator can tell "denied Bash" (ambiguous —
  // could be an allow-rule miss) from "denied Read/Glob/mcp__*" (external refusal).
  const idMatch = /"tool_use_id"\s*:\s*"([^"]+)"/.exec(String(text || ''));
  const toolUseId = idMatch ? idMatch[1] : null;
  return { isTransportClosed, isPermissionDenied, isToolError, isToolResult, toolErrorSig, toolUseId };
}

// True when a denial of `toolName` is evidence of an external permission wall
// rather than a local allowlist mismatch. Bash carries argument-level allow-rules,
// so a denied Bash command is ambiguous; every other tool is granted per-session,
// so its denial cannot come from our own config. An unresolved name (null) is
// treated as ambiguous — never as evidence.
function isPermissionWallEvidence(toolName) {
  return typeof toolName === 'string' && toolName.length > 0 && toolName !== 'Bash';
}

// Pure reducer: applies one classified message to the mutable `state` and returns
// an `action` telling the loop whether to bail. Precedence (top-down): transport-
// closed > permission-denial > tool_use_error > tool_result. `state` fields:
// consecutiveToolErrors, consecutiveTransportErrors, consecutivePermissionDenials,
// totalPermissionDenials, stallStartAt, toolErrorSigs (Map).
// `limits` = { transportLimit }.
function applyRunnerUserMessage(state, sig, limits, guardrails, now = Date.now()) {
  if (sig.isTransportClosed) {
    state.consecutiveTransportErrors += 1;
    return state.consecutiveTransportErrors >= limits.transportLimit
      ? { type: 'abort_transport' }
      : { type: 'transport_error' };
  }
  if (sig.isPermissionDenied) {
    // Denials never abort by count alone: benign improvised probes at sub-agent
    // startup arrive in bursts that scale with fan-out (8+ parallel batch agents),
    // and agents routinely recover by switching to an allowed tool (#238). Instead,
    // anchor a stall window at the FIRST denial after the last productive result;
    // assessPermissionStall() flags a stall only if nothing productive follows
    // within the window (#235). Later denials do NOT re-anchor the window — a
    // denial loop with no interleaved progress must still age out against the
    // first denial.
    state.totalPermissionDenials += 1;
    state.consecutivePermissionDenials += 1;
    if (state.stallStartAt == null) state.stallStartAt = now;
    // Wall evidence accumulates only from denials that CANNOT be an allowlist miss
    // (see isPermissionWallEvidence / PERMISSION_WALL_DENIAL_LIMIT). Like the stall
    // anchor, it clears on any productive tool result below, so the limit means
    // "N such denials with nothing working in between" — a sustained wall, not a
    // recoverable startup burst.
    if (isPermissionWallEvidence(sig.deniedToolName)) {
      state.wallDenials = (state.wallDenials || 0) + 1;
      if (limits.wallLimit > 0 && state.wallDenials >= limits.wallLimit) {
        return { type: 'abort_permission_wall', wallDenials: state.wallDenials, tool: sig.deniedToolName };
      }
    }
    return { type: 'permission_denied' };
  }
  if (sig.isToolError) {
    // A live tool-level error means the MCP transport is up again — and the agent
    // is still receiving real (non-denial) tool responses, so it is not
    // permission-stalled either.
    state.consecutiveTransportErrors = 0;
    state.consecutivePermissionDenials = 0;
    state.stallStartAt = null;
    // A tool_use_error is a REAL tool response, so tools are reachable — whatever
    // refused earlier is no longer refusing. Clears wall evidence for the same
    // reason it clears the stall anchor.
    state.wallDenials = 0;
    state.consecutiveToolErrors += 1;
    state.toolErrorSigs.set(sig.toolErrorSig, (state.toolErrorSigs.get(sig.toolErrorSig) || 0) + 1);
    if (guardrails) {
      const maxConsecutive = Number(guardrails.maxConsecutiveToolErrors || 0);
      const maxSigRepeats = Number(guardrails.maxRepeatedToolErrorSignature || 0);
      const sigRepeats = Number(state.toolErrorSigs.get(sig.toolErrorSig) || 0);
      const stopForConsecutive = maxConsecutive > 0 && state.consecutiveToolErrors >= maxConsecutive;
      const stopForRepeats = maxSigRepeats > 0 && sigRepeats >= maxSigRepeats && sig.toolErrorSig !== 'other_tool_error';
      if (stopForConsecutive || stopForRepeats) {
        return { type: 'guardrail_stop', sig: sig.toolErrorSig, consecutive: state.consecutiveToolErrors, repeats: sigRepeats };
      }
    }
    return { type: 'tool_error', sig: sig.toolErrorSig };
  }
  if (sig.isToolResult) {
    // Productive progress: clears the tool/transport counters AND the
    // permission-stall window. The denial count resets too — it is only for
    // logging; the abort decision is the time-based window below.
    state.consecutiveToolErrors = 0;
    state.consecutiveTransportErrors = 0;
    state.consecutivePermissionDenials = 0;
    state.stallStartAt = null;
    state.wallDenials = 0;
    return { type: 'tool_result_reset' };
  }
  return { type: 'none' };
}

// Time-based permission-stall assessment (issue #235 vs #238). `state.stallStartAt`
// anchors at the first auto-denial after the last productive tool result. The run is
// stalled only when that anchor has aged past windowMs with nothing productive since:
// a genuinely halted agent goes silent (or loops on denials), while a healthy run —
// even one that burned several denied probes at startup — keeps producing results
// that clear the anchor. Pure so the abort decision is unit-testable with fake clocks.
function assessPermissionStall(state, now, windowMs) {
  if (state.stallStartAt == null) return { stalled: false, idleMs: 0 };
  const idleMs = now - state.stallStartAt;
  return { stalled: idleMs >= windowMs, idleMs };
}

// True when a runner outcome indicates a permission-denial stall — either the runner
// bailed before any result message (subtype 'permission_stall'), or the stall fired
// after a result message had already been consumed (the SDK can emit the result while
// trailing sub-agent messages are still streaming — observed 2026-07-21, #238 — in
// which case the result is returned annotated with `permissionStallDetected`).
function resultIndicatesPermissionStall(result) {
  return !!result && (result.subtype === 'permission_stall' || result.permissionStallDetected === true);
}

// True when a runner outcome indicates an EXTERNAL permission wall (#271). Unlike a
// stall this is transient and not caused by anything in our config, so callers should
// back off and retry the same work rather than fail the unit.
function resultIndicatesPermissionWall(result) {
  return !!result
    && (result.subtype === 'permission_wall' || result.permissionWallDetected === true);
}

async function runClaudeOnce({
  prompt,
  label,
  cwd,
  resume,
  model,
  betas,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  enableBash,
  bypassPermissions,
  skill,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  mcpToolSet,
  onProgress,
  guardrails,
  thinking,
  hooks,
  compaction,
}) {
  await ensureFreshToken();
  const query = await getQuery();
  const wsTools = await createFreshWorkspaceToolsServer(mcpToolSet);

  const fullPrompt = skill ? `/${skill} ${prompt}` : prompt;

  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  let turnCount = 0;
  let lastTool = null;
  const queryStart = Date.now();
  const queryDeadline = queryStart + timeout;
  const queryId = Math.random().toString(36).slice(2, 8);
  // Human-readable job tag for the logs (e.g. "NUM 23 UST-gen", "HOS 6 tn-writer").
  // Threaded onto every line this query emits so concurrent pipeline runs stay
  // attributable in the interleaved fly.io log stream. Falls back to just the
  // query id when no label is supplied.
  const idTag = label ? `${label} q=${queryId}` : `q=${queryId}`;
  const runnerPrefix = `[claude-runner ${idTag}]`;
  const claudePrefix = `[claude ${idTag}]`;
  let localTimeoutFired = false;
  // Mutable error-tracking state, owned by the SDK user-message classifier
  // (classifyRunnerUserMessage / applyRunnerUserMessage). Kept as one object so the
  // reducer that decides when to bail is a pure, unit-testable function.
  const errorState = {
    consecutiveToolErrors: 0,
    consecutiveTransportErrors: 0,
    // Permission-denial tracking: counts are for logging/outcome reporting only;
    // stallStartAt anchors the time-based stall window (see assessPermissionStall).
    consecutivePermissionDenials: 0,
    totalPermissionDenials: 0,
    stallStartAt: null,
    wallDenials: 0,
    toolErrorSigs: new Map(),
  };
  // tool_use_id -> tool name, so a denial's tool_result can be resolved back to the
  // tool it refused (the wall discriminator needs the name, and the denial message
  // itself carries only the id). Bounded: entries are deleted as they resolve, and
  // the map is cleared wholesale if a run ever leaks past a sane ceiling.
  const pendingToolUses = new Map();
  // Repeated "Stream closed" tool_results mean the in-process workspace-tools MCP
  // transport has been torn down (typically an align sub-agent outliving the parent
  // query's message stream — JER 33, 2026-07-02). It is transport-level, not a tool
  // error, and never recovers within a session, so retrying is pure wasted wall-clock
  // (observed: 15+ min looping to the skill timeout). Bail after a few and return a
  // distinct outcome so the caller can salvage from banked mapping JSON / short-circuit.
  const MCP_TRANSPORT_ERROR_LIMIT = 3;
  let transportClosedFired = false;
  // Permission-denial stall detection is time-based (see PERMISSION_STALL_WINDOW_MS
  // and assessPermissionStall above): denials are benign unless followed by a whole
  // window with no productive tool result.
  let permissionStallFired = false;
  // An external permission wall was detected (see PERMISSION_WALL_DENIAL_LIMIT).
  // Bails immediately rather than waiting out the stall window, because the wall
  // denies everything and the run can bank nothing while it is up.
  let permissionWallFired = false;

  const timer = setTimeout(() => {
    localTimeoutFired = true;
    const elapsedMs = Date.now() - queryStart;
    // driftMs = how late the timeout callback fired relative to the scheduled deadline.
    // Positive = event loop was busy and couldn't service the timer on schedule.
    const driftMs = elapsedMs - timeout;
    console.warn(
      `${runnerPrefix} Timeout fired — ` +
      `configured=${timeout}ms elapsed=${elapsedMs}ms drift=${driftMs}ms ` +
      `turns=${turnCount} lastTool=${lastTool || 'none'} — aborting query`
    );
    if (onProgress) {
      try {
        const p = onProgress({ queryId, turnCount, lastTool, elapsedMs, timedOut: true, configuredTimeoutMs: timeout, driftMs });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
    abortController.abort();
  }, timeout);

  const HEARTBEAT_MS = 10 * 60 * 1000;
  const heartbeatTimer = onProgress ? setInterval(() => {
    try {
      const p = onProgress({ turnCount, lastTool, elapsedMs: Date.now() - queryStart, timedOut: false });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }, HEARTBEAT_MS) : null;

  // Permission-stall watchdog. A truly stalled run (agents obeying the "STOP and
  // wait" denial text) goes SILENT — no further stream messages — so a per-message
  // check alone would never fire. Poll the pure assessment on a timer and abort once
  // a denial has gone PERMISSION_STALL_WINDOW_MS with no productive tool result.
  const stallTimer = setInterval(() => {
    if (permissionStallFired) return;
    const stall = assessPermissionStall(errorState, Date.now(), PERMISSION_STALL_WINDOW_MS);
    if (!stall.stalled) return;
    permissionStallFired = true;
    console.error(
      `${runnerPrefix} Aborting query — permission-denial stall: ` +
      `${errorState.totalPermissionDenials} auto-denial(s) this run and no productive tool result for ` +
      `${Math.round(stall.idleMs / 1000)}s (window ${PERMISSION_STALL_WINDOW_MS / 1000}s). Headless ` +
      `permissionMode:'auto' auto-denies out-of-allowlist tool calls; the agent appears to have halted ` +
      `on the "STOP what you are doing and wait" text instead of switching to an allowed tool. ` +
      `Bailing to a clean failure instead of burning to the ${timeout / 1000}s timeout.`
    );
    abortController.abort();
  }, PERMISSION_STALL_POLL_MS);

  const options = buildOptions({
    cwd,
    resume,
    model,
    betas,
    allowedTools,
    tools,
    disallowedTools,
    disableLocalSettings,
    forceNoAutoBashSandbox,
    enableBash,
    bypassPermissions,
    maxTurns,
    appendSystemPrompt,
    abortController,
    mcpServers: { 'workspace-tools': wsTools },
    thinking,
    hooks,
    compaction,
  });

  // Durable run log on the volume. The fly.io stream is ephemeral and truncated,
  // so this (plus the SDK session id it records once init arrives) is what a
  // post-hoc triage actually reads. Never throws — degrades to a no-op handle.
  const runLog = createRunLog({
    queryId, label, skill, cwd, model, timeoutMs: timeout,
  });

  console.log(`${runnerPrefix} Starting query in ${cwd}${options.permissionMode === 'bypassPermissions' ? ' (permissions: bypass)' : ''}`);
  console.log(`${runnerPrefix} Prompt: ${fullPrompt.slice(0, 200)}`);
  console.log(`${runnerPrefix} maxTurns: ${options.maxTurns}, timeout: ${timeout / 1000}s, deadline: ${new Date(queryDeadline).toISOString()}`);

  const conversation = query({ prompt: fullPrompt, options });

  let result = null;

  // Close the run log exactly once, whatever the exit path. Defined before the
  // try because three paths LEAVE this function by throwing — the two guardrail
  // stops and the catch block's re-throw of a non-abort error — and a run log
  // abandoned mid-write leaks its file descriptor for the life of the process.
  // Those are also precisely the failures whose evidence is most worth keeping.
  let runLogClosed = false;
  const closeRunLog = (summary) => {
    if (runLogClosed) return;
    runLogClosed = true;
    try {
      runLog.close({
        turnCount,
        lastTool,
        elapsedMs: Date.now() - queryStart,
        totalPermissionDenials: errorState.totalPermissionDenials,
        ...summary,
      });
    } catch (_) { /* logging must never break a run */ }
  };

  try {
    for await (const message of conversation) {
      if (message.type === 'assistant' && message.message?.content) {
        recordAssistantMessage(runLog, message);
        for (const block of message.message.content) {
          if ('text' in block) {
            console.log(`${claudePrefix} ${block.text.slice(0, 200)}`);
          } else if ('name' in block) {
            turnCount++;
            lastTool = block.name;
            if (block.id) {
              // Guard against unbounded growth if ids never resolve (sub-agent
              // tool_uses whose results stream to a channel we don't see).
              if (pendingToolUses.size > 512) pendingToolUses.clear();
              pendingToolUses.set(block.id, block.name);
            }
            console.log(`${claudePrefix} Tool: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 150)})`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      } else if (message.type === 'user') {
        const text = typeof message.message?.content === 'string'
          ? message.message.content
          : JSON.stringify(message.message?.content || '');
        recordUserMessage(runLog, text);
        // Classify the SDK user-message and advance the error-tracking state machine.
        // Both are pure functions (exported for unit tests). Precedence, top-down:
        // transport-closed > permission-denial-stall > tool_use_error > tool_result.
        const sig = classifyRunnerUserMessage(text);
        // Resolve the refused tool_use back to its tool name before reducing, so the
        // permission-wall discriminator can distinguish an argument-level Bash denial
        // from the denial of a wholesale-granted tool. Consume the entry either way —
        // a tool_use resolves exactly once.
        if (sig.toolUseId) {
          sig.deniedToolName = pendingToolUses.get(sig.toolUseId) || null;
          pendingToolUses.delete(sig.toolUseId);
        }
        const action = applyRunnerUserMessage(
          errorState,
          sig,
          { transportLimit: MCP_TRANSPORT_ERROR_LIMIT, wallLimit: PERMISSION_WALL_DENIAL_LIMIT },
          guardrails
        );
        if (action.type === 'transport_error' || action.type === 'abort_transport') {
          console.warn(
            `${runnerPrefix} MCP transport error ("Stream closed") ` +
            `${errorState.consecutiveTransportErrors}/${MCP_TRANSPORT_ERROR_LIMIT} — ` +
            `workspace-tools stream is closed; retrying is futile within this session`
          );
          if (action.type === 'abort_transport') {
            transportClosedFired = true;
            console.error(
              `${runnerPrefix} Aborting query — workspace-tools MCP transport closed ` +
              `(${errorState.consecutiveTransportErrors} consecutive "Stream closed"). The in-process ` +
              `SDK MCP transport does not recover within a session; bailing to salvage / ` +
              `short-circuit instead of looping to the ${timeout / 1000}s timeout.`
            );
            abortController.abort();
            break;
          }
        } else if (action.type === 'abort_permission_wall') {
          permissionWallFired = true;
          console.error(
            `${runnerPrefix} Aborting query — external permission wall: ${action.wallDenials} denial(s) of ` +
            `wholesale-granted tool(s) (latest: ${action.tool}) with no productive tool result in between. ` +
            `These cannot be allowlist misses, so the refusal originates above this process's permission ` +
            `config and no local change can clear it (issue #271, EZK 19). Bailing in seconds instead of ` +
            `waiting out the ${PERMISSION_STALL_WINDOW_MS / 1000}s stall window, so the caller can back off ` +
            `and retry while the run has banked nothing.`
          );
          abortController.abort();
          break;
        } else if (action.type === 'permission_denied') {
          console.warn(
            `${runnerPrefix} Tool call auto-denied ("STOP and wait") in headless auto mode ` +
            `(${errorState.totalPermissionDenials} total this run, tool: ${sig.deniedToolName || 'unresolved'}) — ` +
            `benign if the agent switches to an allowed tool; aborts as a stall only after ` +
            `${PERMISSION_STALL_WINDOW_MS / 1000}s with no productive tool result`
          );
        } else if (action.type === 'guardrail_stop') {
          throw new Error(
            `Guardrail stop: repeated tool errors (${action.sig}, consecutive=${action.consecutive}, repeats=${action.repeats})`
          );
        }
        if (text.includes('command-stderr') || text.includes('Error')) {
          console.error(`${runnerPrefix} SDK user message (error): ${text.slice(0, 500)}`);
        } else {
          console.log(`${runnerPrefix} SDK user message: ${text.slice(0, 300)}`);
        }
      } else if (message.type === 'system') {
        console.log(`${runnerPrefix} SDK system: ${message.subtype || 'unknown'} ${JSON.stringify(message).slice(0, 200)}`);
        if (message.subtype === 'init') {
          // Capture the SDK session id the moment it exists. This is the pointer
          // from a pipeline failure to the full transcript (parent AND
          // sub-agents) the CLI persists under CLAUDE_CONFIG_DIR — the evidence
          // that was unreachable when #264/#265 were triaged.
          runLog.setSession(message.session_id);
          if (runLog.transcript) {
            console.log(`${runnerPrefix} Transcript: ${runLog.transcript}`);
          }
          if (Array.isArray(message.tools)) {
            console.log(`${runnerPrefix} SDK init tools: ${message.tools.join(', ')}`);
            runLog.event('init_tools', { tools: message.tools });
          }
        }
      } else {
        console.log(`${runnerPrefix} SDK event: ${message.type}${message.subtype ? '/' + message.subtype : ''}`);
      }
      if (guardrails && Number(guardrails.maxToolCalls || 0) > 0 && turnCount >= Number(guardrails.maxToolCalls)) {
        throw new Error(`Guardrail stop: max tool calls exceeded (${turnCount}/${guardrails.maxToolCalls})`);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) {
      const elapsedMs = Date.now() - queryStart;
      const driftMs = elapsedMs - timeout;
      console.warn(
        `${runnerPrefix} Query aborted — ` +
        `elapsed=${elapsedMs}ms${localTimeoutFired ? ` drift=${driftMs}ms` : ''} ` +
        `turns=${turnCount} lastTool=${lastTool || 'none'} ` +
        `reason=${localTimeoutFired ? 'timeout_local_abort' : 'external_abort'}`
      );
    } else {
      // Detect rate limit errors and calibrate the window budget
      const msg = (err.message || '').toLowerCase();
      const isRateLimit = msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');
      if (isRateLimit) {
        console.warn(`${runnerPrefix} Rate limit detected -- calibrating window budget`);
        try {
          const room = await getHeadroom();
          recordRateLimit({ windowUsed: room.used, source: 'claude-runner-error' });
        } catch { /* non-fatal */ }
      }
      closeRunLog({ subtype: 'threw', error: err && err.message });
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearInterval(stallTimer);
    try { conversation.close(); } catch (_) {}
  }

  // Close the run log and stamp the evidence pointers onto whatever outcome the
  // caller receives. Pipelines surface `runLogPath` / `transcriptPath` on
  // failure so triage starts from the transcript instead of guessing at timing.
  const finish = (outcome) => {
    const paths = runLog.paths();
    closeRunLog({ subtype: outcome && outcome.subtype });
    if (outcome && typeof outcome === 'object') {
      outcome.runLogPath = paths.runLog;
      outcome.transcriptPath = paths.transcript;
      outcome.subagentTranscriptDir = paths.subagents;
      outcome.sessionId = runLog.sessionId;
    }
    return outcome;
  };

  if (result) {
    if (permissionWallFired) {
      // The wall fired after a result message had already been consumed. Same stream
      // ordering the stall branch below handles (#238/#268: the SDK can emit the
      // result while trailing sub-agent messages are still streaming), and it must be
      // handled here too or the wall is silently dropped — the post-loop
      // permissionWallFired branch only runs when NO result was captured, so the
      // backoff in runClaude() would never engage and generate-pipeline would
      // misclassify a walled run as missing/degraded output and retry straight into it.
      //
      // Checked BEFORE the stall branches deliberately: a walled run also has an
      // active denial anchor, and annotating it as a stall would route it to a hard
      // failure instead of the retry-and-recover path. Mirrors the same
      // wall-outranks-stall precedence the align step applies.
      result.permissionWallDetected = true;
      console.warn(
        `${runnerPrefix} Result already received when the permission wall fired — returning result ` +
        `annotated permissionWallDetected=true (wallDenials=${errorState.wallDenials}, ` +
        `${errorState.totalPermissionDenials} denial(s) total)`
      );
    } else if (permissionStallFired) {
      // The stall fired after a result message had already been consumed (the SDK can
      // emit the result while trailing sub-agent messages are still streaming —
      // observed 2026-07-21, #238). Surface it on the result so callers classify the
      // failure as a permission stall instead of a generic coverage gap.
      result.permissionStallDetected = true;
      console.warn(`${runnerPrefix} Result already received when the permission stall fired — returning result annotated permissionStallDetected=true`);
    } else if (result.subtype !== 'success' && errorState.stallStartAt != null) {
      // A permission-denial anchor is still active — no productive tool result has
      // cleared it since the last denial — and the result arrived before the stall
      // watchdog window elapsed (DAN 1, 2026-07-24 — #268: orchestrator's own
      // SendMessage denied, orchestrator obeyed the canned STOP text literally, and
      // the SDK synthesized a terminal summary ~46s later that did not match the
      // orchestrator's actual last message). A run that ends non-success with an
      // unresolved denial anchor is almost certainly a permission stall short of
      // the full window, not a generic failure. Surface it distinctly so callers
      // classify it (and downstream diagnosis) as such.
      result.permissionStallDetected = true;
      const idleMs = Date.now() - errorState.stallStartAt;
      console.warn(
        `${runnerPrefix} Non-success result with active permission-denial anchor ` +
        `(${errorState.totalPermissionDenials} denial(s), ${Math.round(idleMs / 1000)}s ` +
        `since last, window ${PERMISSION_STALL_WINDOW_MS / 1000}s) — annotating result ` +
        `permissionStallDetected=true so callers route this as a permission stall.`
      );
    }
    console.log(`${runnerPrefix} Finished — subtype: ${result.subtype}, turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(4) || '?'}, duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    if (result.subtype !== 'success' && result.result) {
      console.error(`${runnerPrefix} Result text: ${result.result.slice(0, 500)}`);
    }
    // Detect rate limit in result subtype or error message
    const resultMsg = (result.subtype || '') + ' ' + (result.error || '');
    const isRateLimit = /rate.?limit|429|too.many.requests/i.test(resultMsg);
    if (isRateLimit) {
      console.warn(`${runnerPrefix} Rate limit in result subtype -- calibrating window budget`);
      try {
        const room = await getHeadroom();
        recordRateLimit({ windowUsed: room.used, source: 'claude-runner-result' });
      } catch { /* non-fatal */ }
    }
    recordResult(runLog, result);
    return finish(result);
  }

  // No result message was produced. Distinguish local-timeout from other causes
  // so callers can classify AT failures precisely instead of lumping everything
  // into "empty response".
  const elapsedMs = Date.now() - queryStart;
  // The in-process workspace-tools MCP transport was torn down mid-run — take
  // precedence over the abort→timeout classification below (we abort()ed to bail).
  if (transportClosedFired) {
    console.warn(
      `${runnerPrefix} Returning mcp_transport_closed outcome — ` +
      `reason=mcp_transport_closed consecutive=${errorState.consecutiveTransportErrors} elapsed=${elapsedMs}ms`
    );
    return finish({
      subtype: 'mcp_transport_closed',
      timedOut: false,
      reason: 'mcp_transport_closed',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      turnCount,
      lastTool,
      consecutiveTransportErrors: errorState.consecutiveTransportErrors,
    });
  }
  // An external permission wall was detected and we abort()ed to bail. Checked BEFORE
  // the stall (and the abort→timeout classification): a wall is the more specific
  // signal and, unlike a stall, it is transient and worth retrying after a backoff —
  // so it must not be flattened into permission_stall, which routes to a hard failure.
  if (permissionWallFired) {
    console.warn(
      `${runnerPrefix} Returning permission_wall outcome — ` +
      `reason=permission_wall wallDenials=${errorState.wallDenials} ` +
      `totalDenials=${errorState.totalPermissionDenials} elapsedMs=${elapsedMs}ms`
    );
    return finish({
      subtype: 'permission_wall',
      timedOut: false,
      reason: 'permission_wall',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      turnCount,
      lastTool,
      wallDenials: errorState.wallDenials,
      totalPermissionDenials: errorState.totalPermissionDenials,
    });
  }
  // A permission-denial stall was detected and we abort()ed to bail — take precedence
  // over the abort→timeout classification below, mirroring mcp_transport_closed. A
  // fresh query would likely hit the same auto-denial wall, so route to a clean failure.
  if (permissionStallFired) {
    console.warn(
      `${runnerPrefix} Returning permission_stall outcome — ` +
      `reason=permission_stall denials=${errorState.totalPermissionDenials} elapsedMs=${elapsedMs}ms`
    );
    return finish({
      subtype: 'permission_stall',
      timedOut: false,
      reason: 'permission_stall',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      turnCount,
      lastTool,
      totalPermissionDenials: errorState.totalPermissionDenials,
    });
  }
  if (localTimeoutFired || abortController.signal.aborted) {
    const driftMs = elapsedMs - timeout;
    console.warn(
      `${runnerPrefix} Returning timeout outcome — ` +
      `reason=timeout_local_abort elapsed=${elapsedMs}ms configured=${timeout}ms drift=${driftMs}ms`
    );
    return finish({
      subtype: 'timeout',
      timedOut: true,
      reason: 'timeout_local_abort',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      driftMs,
      turnCount,
      lastTool,
    });
  }
  console.warn(`${runnerPrefix} Query ended without a result message (elapsed=${elapsedMs}ms) — reason=no_result_message`);
  return finish({
    subtype: 'no_result',
    reason: 'no_result_message',
    queryId,
    elapsedMs,
    configuredTimeoutMs: timeout,
    turnCount,
    lastTool,
  });
}

function isUsageCapMessage(text) {
  return /hit your limit|resets?\s+\d{1,2}(?::\d{2})?\s*(am|pm)\s*\(utc\)/i.test(String(text || ''));
}

function isTransientSdkMessage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (isUsageCapMessage(t)) return false;
  return (
    t.includes('internal server error') ||
    t.includes('api error: 500') ||
    t.includes('api_error') ||
    t.includes('http 500') ||
    t.includes('http 502') ||
    t.includes('http 503') ||
    t.includes('http 504') ||
    t.includes('service unavailable') ||
    t.includes('temporarily unavailable') ||
    t.includes('gateway timeout') ||
    t.includes('bad gateway') ||
    t.includes('overloaded') ||
    t.includes('connection reset') ||
    t.includes('connection closed') ||
    t.includes('mid-response') ||
    t.includes('socket hang up') ||
    t.includes('econnreset') ||
    t.includes('etimedout')
  );
}

function isTransientOutageError(err) {
  if (!err) return false;
  if (err.name === 'ClaudeTransientOutageError') return true;
  return false;
}

// True for any guardrail-stop the runner throws/returns (repeated tool errors,
// max tool calls, or token budget). Callers use this to distinguish a "ran out
// of budget / looping" stop from a genuine crash or transient outage.
function isGuardrailStop(err) {
  const msg = typeof err === 'string' ? err : (err && err.message) || String(err || '');
  return /Guardrail stop:/i.test(msg);
}

function backoffDelayMs(attempt) {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 2000);
  return exp + jitter;
}

// Backoff for permission-wall retries. Starts an order of magnitude higher than
// backoffDelayMs and caps higher: the wall outlasts a 5s retry, and hammering it
// wastes attempts (EZK 19 burned its entire second attempt 88s after the first).
function wallBackoffDelayMs(attempt) {
  const exp = Math.min(
    PERMISSION_WALL_MAX_DELAY_MS,
    PERMISSION_WALL_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
  );
  const jitter = Math.floor(Math.random() * 5000);
  return exp + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyAdminDowntime(text) {
  try {
    await publishAdminStatus({
      source: 'claude-runner',
      pipelineType: 'system',
      severity: 'warn',
      message: text,
    });
  } catch (err) {
    console.warn(`[claude-runner] Failed to publish downtime status: ${err.message}`);
  }
}

async function runClaude(args) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastTransientMessage = '';
  let firstDowntimeNoticeSent = false;
  // Job tag for the wrapper's own retry/backoff lines. Each runClaudeOnce()
  // attempt mints its own q= id, so the wrapper carries only the label.
  const labelPrefix = args?.label ? `[claude-runner ${args.label}]` : '[claude-runner]';

  while (true) {
    attempt++;
    try {
      const result = await runClaudeOnce({ ...args });
      if (args?.guardrails?.tokenBudget && result?.usage) {
        const u = result.usage || {};
        const total = (u.input_tokens ?? u.inputTokens ?? 0)
          + (u.output_tokens ?? u.outputTokens ?? 0)
          + (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0)
          + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
        if (total > Number(args.guardrails.tokenBudget)) {
          return {
            ...result,
            subtype: 'error',
            error: `Guardrail stop: token budget exceeded (${total}/${args.guardrails.tokenBudget})`,
          };
        }
      }
      // A wall-annotated result must NOT take the success short-circuit. When the wall
      // fires we abort the query mid-flight, so any result already captured describes
      // an interrupted run — EZK 19's align coordinator returned a success-shaped
      // result having produced no aligned USFM at all. Falling through lets the
      // permission-wall backoff below re-run it.
      if (result?.subtype === 'success' && !resultIndicatesPermissionWall(result)) return result;

      const resultMsg = `${result?.subtype || ''} ${result?.error || ''} ${result?.result || ''}`.trim();
      const elapsed = Date.now() - startedAt;

      // External permission wall (#271): every tool call was refused from above this
      // process, so the query banked nothing and a fresh one costs nothing to lose.
      // Retry here rather than in each pipeline so generate/notes/tqs all inherit the
      // recovery. Walls clear on their own, so patient backoff usually turns what was
      // a failed chapter + hand triage into a slower but successful run. On exhaustion
      // return the wall result (do NOT raise ClaudeTransientOutageError): that maps to
      // `paused_for_outage`, which nothing auto-resumes, so it would just relocate the
      // manual step. Returning it lets the caller record a correctly-labelled failure.
      if (resultIndicatesPermissionWall(result)) {
        if (elapsed < PERMISSION_WALL_RETRY_WINDOW_MS) {
          const delay = wallBackoffDelayMs(attempt);
          if (!firstDowntimeNoticeSent) {
            firstDowntimeNoticeSent = true;
            await notifyAdminDowntime(
              `[claude-runner] External permission wall detected (attempt ${attempt}) — every tool call is ` +
              `being auto-denied from above this process's permission config. Backing off up to ` +
              `${Math.round(PERMISSION_WALL_RETRY_WINDOW_MS / 60000)}min and retrying; no action needed unless ` +
              `this exhausts. Denials this attempt: ${result.wallDenials ?? '?'} (of ${result.totalPermissionDenials ?? '?'} total).`
            );
          }
          console.warn(
            `${labelPrefix} Permission wall — retrying in ${Math.round(delay / 1000)}s ` +
            `(attempt ${attempt}, ${Math.round(elapsed / 1000)}s of ` +
            `${Math.round(PERMISSION_WALL_RETRY_WINDOW_MS / 1000)}s window used)`
          );
          await sleep(delay);
          continue;
        }
        await notifyAdminDowntime(
          `[claude-runner] Permission wall did NOT clear after ${Math.round(elapsed / 60000)}min and ` +
          `${attempt} attempts. Giving up so the caller can fail cleanly — this is an external permission ` +
          `refusal, not a pipeline bug; nothing in the allowlists can fix it.`
        );
        console.error(
          `${labelPrefix} Permission wall persisted past the ${Math.round(PERMISSION_WALL_RETRY_WINDOW_MS / 60000)}min ` +
          `window (${attempt} attempts) — returning permission_wall to the caller`
        );
        return result;
      }
      if (isTransientSdkMessage(resultMsg) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        lastTransientMessage = resultMsg;
        if (!firstDowntimeNoticeSent) {
          firstDowntimeNoticeSent = true;
          await notifyAdminDowntime(
            `[claude-runner] First transient Claude outage signal detected (attempt ${attempt}). ` +
            `Starting retry/backoff window up to 10 minutes. Last error: ${resultMsg.slice(0, 300)}`
          );
        }
        const delay = backoffDelayMs(attempt);
        console.warn(`${labelPrefix} Transient non-success result, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
        await sleep(delay);
        continue;
      }
      if (isTransientSdkMessage(resultMsg) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        await notifyAdminDowntime(
          `[claude-runner] Retry window exhausted after ${Math.round(elapsed / 1000)}s and ${attempt} attempts. ` +
          `Giving up for now. Last error: ${resultMsg.slice(0, 300)}`
        );
        throw new ClaudeTransientOutageError(
          'Claude is temporarily down after retry attempts',
          { elapsedMs: elapsed, attempts: attempt, lastMessage: resultMsg.slice(0, 500) || lastTransientMessage.slice(0, 500) }
        );
      }

      return result;
    } catch (err) {
      const msg = err?.message || String(err);
      const elapsed = Date.now() - startedAt;
      if (isTransientSdkMessage(msg) && elapsed < TRANSIENT_RETRY_WINDOW_MS) {
        lastTransientMessage = msg;
        if (!firstDowntimeNoticeSent) {
          firstDowntimeNoticeSent = true;
          await notifyAdminDowntime(
            `[claude-runner] First transient Claude outage signal detected (attempt ${attempt}). ` +
            `Starting retry/backoff window up to 10 minutes. Last error: ${msg.slice(0, 300)}`
          );
        }
        const delay = backoffDelayMs(attempt);
        console.warn(`${labelPrefix} Transient SDK error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}): ${msg.slice(0, 200)}`);
        await sleep(delay);
        continue;
      }
      if (isTransientSdkMessage(msg) && elapsed >= TRANSIENT_RETRY_WINDOW_MS) {
        await notifyAdminDowntime(
          `[claude-runner] Retry window exhausted after ${Math.round(elapsed / 1000)}s and ${attempt} attempts. ` +
          `Giving up for now. Last error: ${msg.slice(0, 300)}`
        );
        throw new ClaudeTransientOutageError(
          'Claude is temporarily down after retry attempts',
          { elapsedMs: elapsed, attempts: attempt, lastMessage: msg.slice(0, 500) || lastTransientMessage.slice(0, 500) }
        );
      }
      throw err;
    }
  }
}

/**
 * Start a resumable query and return the async generator so the caller can consume
 * events, capture session_id from the first message that has it, and collect assistant text.
 * Caller must call cleanup() in a finally block.
 *
 * @param {{ prompt: string, cwd?: string, resume?: string, model?: string, maxTurns?: number, timeoutMs?: number, appendSystemPrompt?: string }}
 * @returns {{ conversation: AsyncGenerator, abortController: AbortController, cleanup: () => void }}
 */
async function runClaudeStream({
  prompt,
  label,
  cwd,
  resume,
  model,
  betas,
  allowedTools,
  tools,
  disallowedTools,
  disableLocalSettings,
  forceNoAutoBashSandbox,
  enableBash,
  bypassPermissions,
  maxTurns,
  timeoutMs,
  appendSystemPrompt,
  thinking,
  hooks,
  compaction,
}) {
  await ensureFreshToken();
  const query = await getQuery();
  const wsTools = await createFreshWorkspaceToolsServer();
  const abortController = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const streamPrefix = label ? `[claude-runner ${label}]` : '[claude-runner]';
  const timer = setTimeout(() => {
    console.warn(`${streamPrefix} Timeout reached (${timeout / 1000}s) — aborting stream`);
    abortController.abort();
  }, timeout);

  const options = buildOptions({
    cwd,
    resume,
    model,
    betas,
    allowedTools,
    tools,
    disallowedTools,
    disableLocalSettings,
    forceNoAutoBashSandbox,
    enableBash,
    bypassPermissions,
    maxTurns,
    appendSystemPrompt,
    abortController,
    mcpServers: { 'workspace-tools': wsTools },
    thinking,
    hooks,
    compaction,
  });

  console.log(`${streamPrefix} Starting stream in ${cwd}${resume ? ` (resume: ${resume.slice(0, 8)}…)` : ''}`);
  const conversation = query({ prompt, options });

  function cleanup() {
    clearTimeout(timer);
    try { conversation.close(); } catch (_) {}
  }

  return { conversation, abortController, cleanup };
}

module.exports = {
  runClaude,
  runClaudeStream,
  buildOptions,
  createFreshWorkspaceToolsServer,
  DEFAULT_RESTRICTED_TOOLS,
  DEFAULT_BASH_TOOLS,
  BASH_ALLOW_RULES,
  ClaudeTransientOutageError,
  isTransientOutageError,
  isGuardrailStop,
  resolveReasoning,
  classifyRunnerUserMessage,
  applyRunnerUserMessage,
  assessPermissionStall,
  resultIndicatesPermissionStall,
  resultIndicatesPermissionWall,
  isPermissionWallEvidence,
  PERMISSION_STALL_WINDOW_MS,
  PERMISSION_WALL_DENIAL_LIMIT,
  PERMISSION_WALL_RETRY_WINDOW_MS,
  decideToolPermission,
  decideBashPermission,
  SUBAGENT_TOOL_ALLOWLIST,
  BASH_EXEC_PREFIXES,
  BASH_READONLY_CMDS,
};
