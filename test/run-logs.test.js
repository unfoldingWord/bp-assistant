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

test('pruneRunLogs never evicts the current day, even over the byte bound', () => {
  const dir = path.join(tmpRoot, 'prune-today');
  const today = new Date().toISOString().slice(0, 10);
  const older = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const day of [older, today]) {
    fs.mkdirSync(path.join(dir, day), { recursive: true });
    fs.writeFileSync(path.join(dir, day, 'run.jsonl'), 'z'.repeat(1000));
  }
  // Bound below a single day's size: without the guard both days would go.
  const { removed } = pruneRunLogs({ dir, maxAgeDays: 3650, maxTotalBytes: 10 });
  assert.ok(!removed.includes(today), 'current day is never evicted');
  assert.ok(fs.existsSync(path.join(dir, today)), 'a live run keeps its log file');
  assert.deepEqual(removed, [older]);
});

// --- redaction --------------------------------------------------------------
// Run logs are durable and the self-diagnosis agent reads them while drafting a
// PUBLIC issue, so anything credential-shaped must never reach disk.

test('redacts exact values of secret-named env vars', () => {
  process.env.BP_TEST_FAKE_TOKEN = 'supersecretvalue12345';
  try {
    const out = truncate('pushing with token supersecretvalue12345 to door43', 10000);
    assert.ok(!out.includes('supersecretvalue12345'), 'raw secret is gone');
    assert.match(out, /\[redacted:BP_TEST_FAKE_TOKEN\]/);
  } finally {
    delete process.env.BP_TEST_FAKE_TOKEN;
  }
});

test('redacts credential shapes that never passed through our env', () => {
  const cases = [
    ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', /\[redacted:anthropic-key\]/],
    ['ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', /\[redacted:github-token\]/],
    ['github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAA', /\[redacted:github-pat\]/],
    ['xai-AAAAAAAAAAAAAAAAAAAA', /\[redacted:xai-key\]/],
    ['AIzaAAAAAAAAAAAAAAAAAAAAAAAAAA', /\[redacted:google-key\]/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', /\[redacted:auth-header\]/],
  ];
  for (const [raw, expected] of cases) {
    const out = truncate(`value is ${raw} end`, 10000);
    assert.match(out, expected, `redacted: ${raw.slice(0, 12)}`);
    assert.ok(!out.includes(raw), `raw value absent: ${raw.slice(0, 12)}`);
  }
});

test('redacts KEY=value assignments of credential-named fields', () => {
  const out = truncate('env dump: DOOR43_TOKEN=abcdef1234567890 PATH=/usr/bin', 10000);
  assert.ok(!out.includes('abcdef1234567890'), 'assigned secret is gone');
  assert.match(out, /DOOR43_TOKEN=\[redacted\]/);
  assert.match(out, /PATH=\/usr\/bin/, 'non-credential values are untouched');
});

test('redaction runs before truncation so a secret cannot survive at the boundary', () => {
  process.env.BP_TEST_FAKE_KEY = 'zzzzzzzzzzzzzzzzzzzz';
  try {
    const out = truncate(`${'a'.repeat(20)}zzzzzzzzzzzzzzzzzzzz${'b'.repeat(200)}`, 60);
    assert.ok(!out.includes('zzzzzzzzzzzzzzzzzzzz'), 'secret not left in the kept prefix');
  } finally {
    delete process.env.BP_TEST_FAKE_KEY;
  }
});

test('redaction applies to recorded tool inputs, not just free text', async () => {
  process.env.BP_TEST_FAKE_SECRET = 'hunter2hunter2hunter2';
  try {
    const log = createRunLog({ queryId: 'q-redact', label: 'x', cwd: '/data/workspace' });
    recordAssistantMessage(log, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'curl -H "x: hunter2hunter2hunter2"' } }],
      },
    });
    recordUserMessage(log, 'result contains hunter2hunter2hunter2 too');
    log.close();
    await flush();

    const raw = fs.readFileSync(log.file, 'utf8');
    assert.ok(!raw.includes('hunter2hunter2hunter2'), 'secret never reaches disk');
    assert.match(raw, /\[redacted:BP_TEST_FAKE_SECRET\]/);
  } finally {
    delete process.env.BP_TEST_FAKE_SECRET;
  }
});

test('redaction applies to free-text passed straight to event()', async () => {
  process.env.BP_TEST_FAKE_TOKEN2 = 'tokentokentoken12345';
  try {
    const log = createRunLog({ queryId: 'q-event-redact', label: 'x', cwd: '/data/workspace' });
    // claude-runner's closeRunLog puts `error: err.message` on the end event —
    // the one free-text field that never passes through the record* helpers.
    log.event('end', { error: 'request failed: tokentokentoken12345' });
    log.close();
    await flush();

    const raw = fs.readFileSync(log.file, 'utf8');
    assert.ok(!raw.includes('tokentokentoken12345'), 'secret never reaches disk');
    assert.match(raw, /\[redacted:BP_TEST_FAKE_TOKEN2\]/);
  } finally {
    delete process.env.BP_TEST_FAKE_TOKEN2;
  }
});

// Redaction runs on raw values, before JSON escaping. Both halves matter: a
// secret containing a quote or newline is unrecognizable in its escaped form,
// and scrubbing the escaped form can eat the backslash and leave a bare quote
// that makes the line unparseable.
test('event() redacts secrets containing JSON-escapable characters, and stays parseable', async () => {
  process.env.BP_TEST_FAKE_TOKEN3 = 'quo"tedsecret12345';
  process.env.BP_TEST_FAKE_KEY3 = 'lineone12345\nlinetwo12345';
  try {
    const log = createRunLog({ queryId: 'q-escape', label: 'x', cwd: '/data/workspace' });
    log.event('end', {
      error: 'failed with quo"tedsecret12345 and lineone12345\nlinetwo12345',
      note: 'MY_TOKEN=abcdefgh\\"more text" tail',
    });
    log.close();
    await flush();

    const raw = fs.readFileSync(log.file, 'utf8');
    assert.ok(!raw.includes('quo\\"tedsecret12345'), 'quote-bearing secret never reaches disk');
    assert.ok(!raw.includes('lineone12345'), 'newline-bearing secret never reaches disk');
    assert.match(raw, /\[redacted:BP_TEST_FAKE_TOKEN3\]/);
    assert.match(raw, /\[redacted:BP_TEST_FAKE_KEY3\]/);
    // readEvents JSON.parses every line — proves redaction did not corrupt them.
    assert.ok(readEvents(log.file).some((e) => e.type === 'end'), 'lines remain valid JSON');
  } finally {
    delete process.env.BP_TEST_FAKE_TOKEN3;
    delete process.env.BP_TEST_FAKE_KEY3;
  }
});

// tool_use.input is an object, so it is serialized before redaction — the same
// escaping trap as the run-log line, and the highest-risk field in the file.
test('object payloads are redacted field-wise, so escaping cannot hide a secret', async () => {
  process.env.BP_TEST_FAKE_TOKEN4 = 'quo"tedsecret54321';
  try {
    const log = createRunLog({ queryId: 'q-obj-escape', label: 'x', cwd: '/data/workspace' });
    recordAssistantMessage(log, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          id: 't1',
          input: { command: 'curl -H "Authorization: token quo"tedsecret54321"' },
        }],
      },
    });
    log.close();
    await flush();

    const raw = fs.readFileSync(log.file, 'utf8');
    assert.ok(!raw.includes('tedsecret54321'), 'secret never reaches disk in any escaped form');
    assert.match(raw, /\[redacted:BP_TEST_FAKE_TOKEN4\]/);
    const input = readEvents(log.file).find((e) => e.type === 'tool_use').input;
    // Consumers JSON.parse this field; it must survive redaction as valid JSON.
    assert.ok(!JSON.stringify(JSON.parse(input)).includes('tedsecret54321'));
  } finally {
    delete process.env.BP_TEST_FAKE_TOKEN4;
  }
});

test('redacts credential-named fields in JSON form, not just shell form', () => {
  const out = truncate('{"api_key": "abcdefgh12345678", "path": "/data/workspace"}', 10000);
  assert.ok(!out.includes('abcdefgh12345678'), 'JSON-shaped credential is redacted');
  assert.match(out, /api_key/);
  assert.match(out, /\/data\/workspace/, 'benign neighbouring fields untouched');
});

test('close is idempotent — a second close writes no second end event', async () => {
  const log = createRunLog({ queryId: 'q-close', label: 'x', cwd: '/data/workspace' });
  log.close({ subtype: 'success' });
  log.close({ subtype: 'threw' });
  await flush();
  assert.equal(readEvents(log.file).filter((e) => e.type === 'end').length, 1);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
