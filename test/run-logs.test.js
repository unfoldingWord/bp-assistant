// run-logs.test.js — durable run logs (src/run-logs.js).
//
// Covers the two things a triager depends on: that a run log lands on disk with
// the events that matter (including a `denied` flag on auto-denials), and that
// the SDK transcript path is derived correctly from cwd + session id — that
// pointer is what turns a pipeline failure into a readable transcript.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-run-logs-'));
process.env.BP_RUN_LOG_DIR = path.join(tmpRoot, 'run-logs');

const {
  createRunLog,
  pruneRunLogs,
  recordAssistantMessage,
  recordUserMessage,
  recordResult,
  transcriptPathFor,
  subagentDirFor,
  escapeProjectDir,
  truncate,
} = require('../src/run-logs');

function readEvents(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Give the append stream a tick to flush before reading it back.
const flush = () => new Promise((r) => setTimeout(r, 50));

test('escapeProjectDir matches the CLI transcript directory naming', () => {
  // Verified against the live machine: /data/workspace -> -data-workspace
  assert.equal(escapeProjectDir('/data/workspace'), '-data-workspace');
  assert.equal(escapeProjectDir('/app'), '-app');
  assert.equal(escapeProjectDir('/tmp/repro-ws10'), '-tmp-repro-ws10');
});

test('transcriptPathFor builds the parent and sub-agent transcript paths', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/data/claude-config';
  try {
    const p = transcriptPathFor('/data/workspace', 'abc-123');
    assert.equal(p.replace(/\\/g, '/'), '/data/claude-config/projects/-data-workspace/abc-123.jsonl');
    const d = subagentDirFor('/data/workspace', 'abc-123');
    assert.equal(d.replace(/\\/g, '/'), '/data/claude-config/projects/-data-workspace/abc-123/subagents');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('transcriptPathFor returns null without a session id or config dir', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/data/claude-config';
  try {
    assert.equal(transcriptPathFor('/data/workspace', null), null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(transcriptPathFor('/data/workspace', 'abc'), null);
});

test('createRunLog writes a start event and records the session pointer', async () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/data/claude-config';
  try {
    const log = createRunLog({
      queryId: 'q1', label: 'AMO 8 align-all-parallel', skill: 'align-all-parallel',
      cwd: '/data/workspace', model: 'medium', timeoutMs: 1000,
    });
    assert.ok(log.enabled, 'log opened');
    log.setSession('sess-1');
    log.close({ subtype: 'success' });
    await flush();

    const events = readEvents(log.file);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].skill, 'align-all-parallel');

    const session = events.find((e) => e.type === 'session');
    assert.equal(session.sessionId, 'sess-1');
    assert.match(session.transcript.replace(/\\/g, '/'), /-data-workspace\/sess-1\.jsonl$/);

    assert.equal(events[events.length - 1].type, 'end');
    assert.equal(log.paths().transcript, session.transcript);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('setSession is idempotent — a second init does not overwrite the pointer', async () => {
  const log = createRunLog({ queryId: 'q-idem', label: 'x', cwd: '/data/workspace' });
  log.setSession('first');
  log.setSession('second');
  log.close();
  await flush();
  assert.equal(log.sessionId, 'first');
  assert.equal(readEvents(log.file).filter((e) => e.type === 'session').length, 1);
});

test('assistant text and tool_use are recorded with their inputs intact', async () => {
  const log = createRunLog({ queryId: 'q2', label: 'x', cwd: '/data/workspace' });
  recordAssistantMessage(log, {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Spawning both alignment agents.' },
        { type: 'tool_use', name: 'Agent', id: 'tu1', input: { description: 'Align ULT for AMO 8', model: 'opus' } },
      ],
    },
  });
  log.close();
  await flush();

  const events = readEvents(log.file);
  const text = events.find((e) => e.type === 'assistant_text');
  assert.equal(text.text, 'Spawning both alignment agents.');
  const tool = events.find((e) => e.type === 'tool_use');
  assert.equal(tool.tool, 'Agent');
  // The old console line truncated tool input at 150 chars; the full input is
  // what identifies which sub-agent spawn failed.
  assert.match(tool.input, /Align ULT for AMO 8/);
});

test('auto-denials are flagged so a lockout is greppable', async () => {
  const log = createRunLog({ queryId: 'q3', label: 'x', cwd: '/data/workspace' });
  recordUserMessage(log, "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.");
  recordUserMessage(log, 'ordinary tool result');
  log.close();
  await flush();

  const results = readEvents(log.file).filter((e) => e.type === 'tool_result');
  assert.equal(results[0].denied, true);
  assert.equal(results[1].denied, false);
});

test('recordResult captures subtype, turns and cost', async () => {
  const log = createRunLog({ queryId: 'q4', label: 'x', cwd: '/data/workspace' });
  recordResult(log, { subtype: 'success', num_turns: 12, total_cost_usd: 1.5, duration_ms: 900, result: 'done' });
  log.close();
  await flush();

  const r = readEvents(log.file).find((e) => e.type === 'result');
  assert.equal(r.subtype, 'success');
  assert.equal(r.numTurns, 12);
  assert.equal(r.costUsd, 1.5);
});

test('truncate bounds long values and reports how much was dropped', () => {
  const long = 'x'.repeat(100);
  const out = truncate(long, 10);
  assert.ok(out.startsWith('xxxxxxxxxx'));
  assert.match(out, /\+90 chars/);
  assert.equal(truncate('short', 100), 'short');
});

test('recording helpers are inert on a disabled handle', () => {
  const off = { enabled: false, event() { throw new Error('should not be called'); } };
  assert.doesNotThrow(() => {
    recordAssistantMessage(off, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    recordUserMessage(off, 'x');
    recordResult(off, { subtype: 'success' });
  });
});

test('pruneRunLogs drops day directories past the age bound and keeps recent ones', () => {
  const dir = path.join(tmpRoot, 'prune-age');
  const old = '2020-01-01';
  const recent = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dir, old), { recursive: true });
  fs.mkdirSync(path.join(dir, recent), { recursive: true });
  fs.writeFileSync(path.join(dir, old, 'a.jsonl'), 'x\n');
  fs.writeFileSync(path.join(dir, recent, 'b.jsonl'), 'y\n');

  const { removed } = pruneRunLogs({ dir, maxAgeDays: 30 });
  assert.deepEqual(removed, [old]);
  assert.ok(fs.existsSync(path.join(dir, recent)), 'recent day kept');
  assert.ok(!fs.existsSync(path.join(dir, old)), 'old day removed');
});

test('pruneRunLogs enforces the byte backstop oldest-first', () => {
  const dir = path.join(tmpRoot, 'prune-size');
  const today = new Date();
  const days = [0, 1, 2].map((back) => {
    const d = new Date(today.getTime() - back * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }).sort();
  for (const day of days) {
    fs.mkdirSync(path.join(dir, day), { recursive: true });
    fs.writeFileSync(path.join(dir, day, 'run.jsonl'), 'z'.repeat(1000));
  }

  // Bound below two days' worth so the oldest gets dropped first.
  const { removed } = pruneRunLogs({ dir, maxAgeDays: 3650, maxTotalBytes: 2500 });
  assert.equal(removed.length, 1);
  assert.equal(removed[0], days[0], 'oldest day removed first');
  assert.ok(fs.existsSync(path.join(dir, days[2])), 'newest day kept');
});

test('pruneRunLogs is a no-op on a missing directory', () => {
  assert.doesNotThrow(() => pruneRunLogs({ dir: path.join(tmpRoot, 'does-not-exist') }));
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
