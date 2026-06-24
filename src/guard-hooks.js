// guard-hooks.js — declarative guard + observability layer for the Claude Agent
// SDK, built on the SDK's `options.hooks` choke point (Phase 3).
//
// Folds scattered, imperative per-call tool gating into one place and adds two
// things the ad-hoc guards never did: (1) a hard PreToolUse block on writes to
// the protected canonical files (issues_resolved.txt, the 5 Drive-managed
// glossaries, any SKILL.md body) — defense-in-depth so even a buggy skill run
// can't clobber them; (2) observability — denied tool calls (and, opt-in, tool
// failures) are published to admin-status.js and surface at /admin.
//
// Additive + opt-in: a call site enables it by passing
// `hooks: createGuardHooks({...})` to runClaude. Callers that pass nothing are
// unaffected. The existing in-loop guardrails (claude-runner.js) stay intact.
'use strict';

const { publishAdminStatus } = require('./admin-status');

// Tools that write to the filesystem (subject to protected-path checks). Covers
// the core editor tools plus MCP append/write/insert tools (matched by name).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MCP_WRITE_RE = /^mcp__.*(append|write|insert|save|update)/i;

// The canonical files no automated run may write. Entries match by exact path,
// repo-relative suffix, basename, or RegExp against the normalized path.
const DEFAULT_PROTECTED = [
  'data/issues_resolved.txt',
  'data/glossary/hebrew_ot_glossary.csv',
  'data/glossary/psalms_reference.csv',
  'data/glossary/sacrifice_terminology.csv',
  'data/glossary/biblical_phrases.csv',
  'data/glossary/biblical_measurements.csv',
  /(^|\/)SKILL\.md$/i,
];

const ALLOW = Object.freeze({});

function denyDecision(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function isWriteTool(toolName) {
  return WRITE_TOOLS.has(toolName) || MCP_WRITE_RE.test(String(toolName || ''));
}

// Pull a filesystem path out of a tool's input, across the common shapes.
function extractPathFromToolInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  return toolInput.file_path || toolInput.path || toolInput.notebook_path
    || toolInput.filePath || toolInput.file || null;
}

function isProtectedPath(targetPath, protectedPaths = DEFAULT_PROTECTED) {
  if (!targetPath) return false;
  const norm = String(targetPath).replace(/\\/g, '/');
  const base = norm.split('/').pop();
  for (const p of protectedPaths) {
    if (p instanceof RegExp) { if (p.test(norm)) return true; continue; }
    if (norm === p || norm.endsWith('/' + p) || base === p) return true;
  }
  return false;
}

// Pure decision function (unit-tested). Returns ALLOW or a deny decision.
function decidePreToolUse(input, policy = {}) {
  const tool = input && input.tool_name;
  if (!tool) return ALLOW;
  if (policy.blockedTools && policy.blockedTools.has(tool)) {
    return denyDecision(`tool '${tool}' is not permitted in this run`);
  }
  if (policy.allowedTools && !policy.allowedTools.has(tool)) {
    return denyDecision(`tool '${tool}' is not on the allowlist for this run`);
  }
  if (isWriteTool(tool)) {
    const target = extractPathFromToolInput(tool, input.tool_input);
    if (isProtectedPath(target, policy.protectedPaths || DEFAULT_PROTECTED)) {
      return denyDecision(`write to protected canonical file is not allowed: ${target}`);
    }
  }
  return ALLOW;
}

// Build an SDK `options.hooks` object enforcing the policy.
//   allowedTools / blockedTools : optional Set sources (arrays)
//   protectedPaths              : override DEFAULT_PROTECTED
//   pipelineType, scope         : admin-status facets
//   publish                     : publish denials to admin-status (default true)
//   observeFailures             : also publish tool failures (default false — avoids flooding)
function createGuardHooks({
  allowedTools,
  blockedTools,
  protectedPaths = DEFAULT_PROTECTED,
  pipelineType = 'system',
  scope,
  publish = true,
  observeFailures = false,
} = {}) {
  const policy = {
    allowedTools: allowedTools ? new Set(allowedTools) : null,
    blockedTools: blockedTools ? new Set(blockedTools) : null,
    protectedPaths,
  };
  const pub = publish
    ? async (severity, message) => {
        try {
          await publishAdminStatus({ source: 'guard-hooks', pipelineType, phase: 'guard', severity, scope, message });
        } catch (err) {
          console.warn(`[guard-hooks] publish failed: ${err.message}`);
        }
      }
    : async () => {};

  const hooks = {
    PreToolUse: [{
      hooks: [async (input) => {
        let decision;
        try {
          decision = decidePreToolUse(input, policy);
        } catch (err) {
          // A guard must never crash the turn — fail open, but record it.
          console.warn(`[guard-hooks] PreToolUse error: ${err.message}`);
          return ALLOW;
        }
        if (decision !== ALLOW) {
          await pub('warn', `[guard] blocked ${input && input.tool_name}: ${decision.hookSpecificOutput.permissionDecisionReason}`);
        }
        return decision;
      }],
    }],
  };
  if (observeFailures) {
    hooks.PostToolUseFailure = [{
      hooks: [async (input) => {
        await pub('warn', `[guard] tool ${input && input.tool_name} failed: ${String((input && input.error) || '').slice(0, 200)}`);
        return {};
      }],
    }];
  }
  return hooks;
}

module.exports = {
  createGuardHooks,
  decidePreToolUse,
  extractPathFromToolInput,
  isProtectedPath,
  isWriteTool,
  WRITE_TOOLS,
  MCP_WRITE_RE,
  DEFAULT_PROTECTED,
};
