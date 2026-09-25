// Replay tests for the shared reviewer machine's claim/verify steps in
// .github/workflows/review-gate-automerge.yml and review-gate.yml (#408).
//
// Each test pulls a step's `run:` script straight out of the workflow YAML and
// runs it under bash against a stub `flyctl` that keeps the machine's state and
// env in a JSON file. The stub can apply a patch after its Nth call of a given
// command, which is how a racing writer (the other workflow) is simulated.
// `sleep` is stubbed to return at once so the retry loops run in milliseconds.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKFLOWS = path.resolve(__dirname, '../.github/workflows');
const AUTOMERGE = path.join(WORKFLOWS, 'review-gate-automerge.yml');
const GATE = path.join(WORKFLOWS, 'review-gate.yml');
const MACHINE = 'm-1';
const HEAD = 'a'.repeat(40);
const GATE_HEAD = 'b'.repeat(40);

// Returns the named step's `run: |` block with its indentation removed.
function extractStep(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" not found in ${file}`);
  let i = start + 1;
  while (!/^\s*run: \|\s*$/.test(lines[i])) {
    assert.ok(!/^\s*- (name|uses):/.test(lines[i]), `step "${name}" has no run block`);
    i += 1;
  }
  const runIndent = lines[i].search(/\S/);
  const body = [];
  for (i += 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= runIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const script = body.map((l) => l.slice(indent)).join('\n');
  assert.ok(!script.includes('${{'), 'run block uses an expression the harness cannot expand');
  return script;
}

// Stub flyctl. State file: { state, env, calls: {list, update, start}, events, log }.
// An event { on, n, patch } merges patch.env into env and sets patch.state
// after the nth call of `on`. After `start` the machine reads as `started`
// for two list calls, then `stopped`; a patch to `started` lasts until a
// later patch changes it.
const FLYCTL_STUB = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.STUB_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const cmd = args[0] === 'machines' && args[1] === 'list' ? 'list'
  : args[0] === 'machine' && args[1] === 'update' ? 'update'
  : args[0] === 'machine' && args[1] === 'start' ? 'start' : 'other';
s.calls[cmd] = (s.calls[cmd] || 0) + 1;
if (s.calls.list > 500) { fs.writeFileSync(file, JSON.stringify(s)); process.exit(3); }
let out = '';
if (cmd === 'list') {
  if (s.state === 'started' && typeof s.runLeft === 'number') { s.runLeft -= 1; if (s.runLeft < 0) { s.state = 'stopped'; delete s.runLeft; } }
  out = JSON.stringify([{ id: '${MACHINE}', state: s.state, config: { env: s.env } }]);
} else if (cmd === 'update') {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') { const [k, ...v] = args[i + 1].split('='); s.env[k] = v.join('='); }
  }
} else if (cmd === 'start') {
  s.state = 'started';
  s.runLeft = 2;
}
s.log.push(cmd + ' ' + JSON.stringify(s.env));
for (const e of s.events) {
  if (!e.done && e.on === cmd && e.n === s.calls[cmd]) {
    Object.assign(s.env, e.patch.env || {});
    if (e.patch.state) s.state = e.patch.state;
    e.done = true;
  }
}
fs.writeFileSync(file, JSON.stringify(s));
if (out) process.stdout.write(out);
`;

function runStep(file, name, { state = 'stopped', env = {}, events = [], stepEnv = {}, timeout = 20000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-claim-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flyctl'), FLYCTL_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The automerge Start step's drift guard reads the PR head via `gh api`.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho ${HEAD}\n`, { mode: 0o755 });
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ state, env, calls: {}, events, log: [] }));
  const outputFile = path.join(dir, 'output');
  fs.writeFileSync(outputFile, '');
  const scriptFile = path.join(dir, 'step.sh');
  fs.writeFileSync(scriptFile, extractStep(file, name));
  const res = spawnSync('bash', [scriptFile], {
    encoding: 'utf8',
    timeout,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      STUB_STATE: stateFile,
      GITHUB_OUTPUT: outputFile,
      FLY_API_TOKEN: 'x',
      FLY_APP_NAME: 'app',
      FLY_MACHINE_ID: MACHINE,
      ...stepEnv,
    },
  });
  const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const output = fs.readFileSync(outputFile, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr, final, output };
}

const AM_ACQUIRE = 'Acquire reviewer machine (configure + verify)';
const AM_START = 'Start machine and wait for completion';
const AM_ENV = { PR_REF: 'unfoldingWord/bp-assistant#7', HEAD_SHA: HEAD, PR_NUMBER: '7', REPO: 'unfoldingWord/bp-assistant' };
const OURS = { RUN_MODE: 'pr-reviewer', BP_REVIEWER_ONLY_PR: AM_ENV.PR_REF, BP_REVIEWER_ONLY_SHA: HEAD, PR_REVIEW_HEAD_SHA: '' };
const GATE_CLAIM = { RUN_MODE: 'pr-review', PR_REVIEW_HEAD_SHA: GATE_HEAD, BP_REVIEWER_ONLY_SHA: '', BP_REVIEWER_ONLY_PR: '' };
const GATE_RESTORE = { RUN_MODE: 'hourly', PR_REVIEW_HEAD_SHA: '' };

test('automerge acquire: clears a stale gate lease and records configured before writing', () => {
  const r = runStep(AUTOMERGE, AM_ACQUIRE, {
    env: { RUN_MODE: 'hourly', PR_REVIEW_HEAD_SHA: 'stale', PR_REVIEW_NUMBER: '3' },
    stepEnv: AM_ENV,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.final.env.RUN_MODE, 'pr-reviewer');
  assert.equal(r.final.env.BP_REVIEWER_ONLY_SHA, HEAD);
  assert.equal(r.final.env.PR_REVIEW_HEAD_SHA, '');
  assert.equal(r.final.env.PR_REVIEW_NUMBER, '');
  assert.match(r.output, /^configured=true$/m);
  assert.equal(r.final.calls.update, 1);
});

test('automerge acquire: a gate claim landing after our write is detected and retried', () => {
  // The gate claims and starts the machine right after our write, then its
  // restore puts the machine back to hourly once it stops.
  const r = runStep(AUTOMERGE, AM_ACQUIRE, {
    env: { RUN_MODE: 'hourly' },
    events: [
      { on: 'update', n: 1, patch: { env: GATE_CLAIM, state: 'started' } },
      { on: 'list', n: 6, patch: { env: GATE_RESTORE, state: 'stopped' } },
    ],
    stepEnv: AM_ENV,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Lost the machine to another writer/);
  assert.equal(r.final.calls.update, 2, 'expected a second configure after losing the race');
  assert.equal(r.final.env.RUN_MODE, 'pr-reviewer');
  assert.equal(r.final.env.BP_REVIEWER_ONLY_SHA, HEAD);
  assert.equal(r.final.env.PR_REVIEW_HEAD_SHA, '');
});

test('automerge acquire: another automerge run winning the write is detected', () => {
  const r = runStep(AUTOMERGE, AM_ACQUIRE, {
    env: { RUN_MODE: 'hourly' },
    events: [
      { on: 'update', n: 1, patch: { env: { BP_REVIEWER_ONLY_SHA: 'c'.repeat(40) }, state: 'started' } },
      { on: 'list', n: 5, patch: { env: { RUN_MODE: 'hourly', BP_REVIEWER_ONLY_SHA: '' }, state: 'stopped' } },
    ],
    stepEnv: AM_ENV,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Lost the machine to another writer/);
  assert.equal(r.final.env.BP_REVIEWER_ONLY_SHA, HEAD);
});

test('automerge acquire: cancelled while waiting never records configured', () => {
  // The machine never stops, so the step waits until the harness kills it,
  // which stands in for a cancelled run.
  const r = runStep(AUTOMERGE, AM_ACQUIRE, { state: 'started', env: { RUN_MODE: 'pr-review' }, stepEnv: AM_ENV, timeout: 1500 });
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.output, '');
  assert.equal(r.final.calls.update || 0, 0);
});

test('automerge start: starts when the config is still ours', () => {
  const r = runStep(AUTOMERGE, AM_START, { env: { ...OURS }, stepEnv: AM_ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.final.calls.start, 1);
});

test('automerge start: a gate claim after acquire fails fast without starting', () => {
  const r = runStep(AUTOMERGE, AM_START, { env: { ...OURS, ...GATE_CLAIM }, stepEnv: AM_ENV });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config changed before start/);
  assert.equal(r.final.calls.start || 0, 0);
});

test('automerge start: a gate restore after acquire fails fast without starting', () => {
  const r = runStep(AUTOMERGE, AM_START, { env: { ...OURS, RUN_MODE: 'hourly' }, stepEnv: AM_ENV });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config changed before start/);
  assert.equal(r.final.calls.start || 0, 0);
});

test('automerge start: a write between the pre-start check and start fails fast', () => {
  const r = runStep(AUTOMERGE, AM_START, {
    env: { ...OURS },
    events: [{ on: 'start', n: 1, patch: { env: GATE_RESTORE } }],
    stepEnv: AM_ENV,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /between the pre-start check and start/);
});

test('gate acquire: clears BP_REVIEWER_ONLY_* and records claimed', () => {
  const r = runStep(GATE, 'Acquire reviewer machine (claim + verify)', {
    env: { RUN_MODE: 'hourly', BP_REVIEWER_ONLY_SHA: 'stale', BP_REVIEWER_ONLY_PR: 'x#1' },
    stepEnv: { REVIEW_REPO: 'unfoldingWord/bp-assistant', REVIEW_PR: '9', REVIEW_BASE: 'd'.repeat(40), REVIEW_HEAD: GATE_HEAD, REVIEW_PROVIDER: 'claude' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.final.env.RUN_MODE, 'pr-review');
  assert.equal(r.final.env.PR_REVIEW_HEAD_SHA, GATE_HEAD);
  assert.equal(r.final.env.BP_REVIEWER_ONLY_SHA, '');
  assert.equal(r.final.env.BP_REVIEWER_ONLY_PR, '');
  assert.match(r.output, /^claimed=true$/m);
});

test('both restore steps run only for a run that wrote the machine config', () => {
  const restoreIf = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.trim() === '- name: Restore machine to default mode');
    return lines.slice(i, i + 6).find((l) => /^\s*if:/.test(l));
  };
  assert.match(restoreIf(AUTOMERGE), /steps\.configure\.outputs\.configured == 'true'/);
  assert.match(restoreIf(GATE), /steps\.acquire\.outputs\.claimed == 'true'/);
});
