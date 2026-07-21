// claude-runner.js — SDK wrapper for Claude Agent SDK query()
// Replaces `claude -p` subprocess calls with programmatic SDK usage

const { ensureFreshToken } = require('./auth-refresh');
const { recordRateLimit, getHeadroom } = require('./usage-tracker');
const { createWorkspaceTools, createTnWriterTools, createQualityTools, createIssueIdTools } = require('./workspace-tools');
const { publishAdminStatus } = require('./admin-status');
const { resolveDifficultyModel, resolveDifficultyEffort } = require('./api-runner/provider-config');

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
  const modelResolverMatcher = {
    hooks: [async (input) => {
      try {
        const tool = input && input.tool_name;
        if (tool !== 'Task' && tool !== 'Agent') return {};
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
  return { isTransportClosed, isPermissionDenied, isToolError, isToolResult, toolErrorSig };
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
    return { type: 'permission_denied' };
  }
  if (sig.isToolError) {
    // A live tool-level error means the MCP transport is up again — and the agent
    // is still receiving real (non-denial) tool responses, so it is not
    // permission-stalled either.
    state.consecutiveTransportErrors = 0;
    state.consecutivePermissionDenials = 0;
    state.stallStartAt = null;
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
    toolErrorSigs: new Map(),
  };
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
    maxTurns,
    appendSystemPrompt,
    abortController,
    mcpServers: { 'workspace-tools': wsTools },
    thinking,
    hooks,
    compaction,
  });

  console.log(`${runnerPrefix} Starting query in ${cwd}`);
  console.log(`${runnerPrefix} Prompt: ${fullPrompt.slice(0, 200)}`);
  console.log(`${runnerPrefix} maxTurns: ${options.maxTurns}, timeout: ${timeout / 1000}s, deadline: ${new Date(queryDeadline).toISOString()}`);

  const conversation = query({ prompt: fullPrompt, options });

  let result = null;

  try {
    for await (const message of conversation) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            console.log(`${claudePrefix} ${block.text.slice(0, 200)}`);
          } else if ('name' in block) {
            turnCount++;
            lastTool = block.name;
            console.log(`${claudePrefix} Tool: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 150)})`);
          }
        }
      } else if (message.type === 'result') {
        result = message;
      } else if (message.type === 'user') {
        const text = typeof message.message?.content === 'string'
          ? message.message.content
          : JSON.stringify(message.message?.content || '');
        // Classify the SDK user-message and advance the error-tracking state machine.
        // Both are pure functions (exported for unit tests). Precedence, top-down:
        // transport-closed > permission-denial-stall > tool_use_error > tool_result.
        const sig = classifyRunnerUserMessage(text);
        const action = applyRunnerUserMessage(
          errorState,
          sig,
          { transportLimit: MCP_TRANSPORT_ERROR_LIMIT },
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
        } else if (action.type === 'permission_denied') {
          console.warn(
            `${runnerPrefix} Tool call auto-denied ("STOP and wait") in headless auto mode ` +
            `(${errorState.totalPermissionDenials} total this run) — benign if the agent switches to ` +
            `an allowed tool; aborts as a stall only after ${PERMISSION_STALL_WINDOW_MS / 1000}s ` +
            `with no productive tool result`
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
        if (message.subtype === 'init' && Array.isArray(message.tools)) {
          console.log(`${runnerPrefix} SDK init tools: ${message.tools.join(', ')}`);
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
      throw err;
    }
  } finally {
    clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearInterval(stallTimer);
    try { conversation.close(); } catch (_) {}
  }

  if (result) {
    if (permissionStallFired) {
      // The stall fired after a result message had already been consumed (the SDK can
      // emit the result while trailing sub-agent messages are still streaming —
      // observed 2026-07-21, #238). Surface it on the result so callers classify the
      // failure as a permission stall instead of a generic coverage gap.
      result.permissionStallDetected = true;
      console.warn(`${runnerPrefix} Result already received when the permission stall fired — returning result annotated permissionStallDetected=true`);
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
    return result;
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
    return {
      subtype: 'mcp_transport_closed',
      timedOut: false,
      reason: 'mcp_transport_closed',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      turnCount,
      lastTool,
      consecutiveTransportErrors: errorState.consecutiveTransportErrors,
    };
  }
  // A permission-denial stall was detected and we abort()ed to bail — take precedence
  // over the abort→timeout classification below, mirroring mcp_transport_closed. A
  // fresh query would likely hit the same auto-denial wall, so route to a clean failure.
  if (permissionStallFired) {
    console.warn(
      `${runnerPrefix} Returning permission_stall outcome — ` +
      `reason=permission_stall denials=${errorState.totalPermissionDenials} elapsedMs=${elapsedMs}ms`
    );
    return {
      subtype: 'permission_stall',
      timedOut: false,
      reason: 'permission_stall',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      turnCount,
      lastTool,
      totalPermissionDenials: errorState.totalPermissionDenials,
    };
  }
  if (localTimeoutFired || abortController.signal.aborted) {
    const driftMs = elapsedMs - timeout;
    console.warn(
      `${runnerPrefix} Returning timeout outcome — ` +
      `reason=timeout_local_abort elapsed=${elapsedMs}ms configured=${timeout}ms drift=${driftMs}ms`
    );
    return {
      subtype: 'timeout',
      timedOut: true,
      reason: 'timeout_local_abort',
      queryId,
      elapsedMs,
      configuredTimeoutMs: timeout,
      driftMs,
      turnCount,
      lastTool,
    };
  }
  console.warn(`${runnerPrefix} Query ended without a result message (elapsed=${elapsedMs}ms) — reason=no_result_message`);
  return {
    subtype: 'no_result',
    reason: 'no_result_message',
    queryId,
    elapsedMs,
    configuredTimeoutMs: timeout,
    turnCount,
    lastTool,
  };
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
      if (result?.subtype === 'success') return result;

      const resultMsg = `${result?.subtype || ''} ${result?.error || ''} ${result?.result || ''}`.trim();
      const elapsed = Date.now() - startedAt;
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
  PERMISSION_STALL_WINDOW_MS,
};
