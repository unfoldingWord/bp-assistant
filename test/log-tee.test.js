// log-tee.test.js — the durable rotating stdout/stderr copy (scripts/log-tee.js).
//
// Two things must hold, and the second matters more than the first:
//   1. The durable copy works: bytes land on disk, the file rolls at the cap,
//      old generations are pruned.
//   2. The writer can NEVER take the bot down. It sits on the far end of the
//      bot's stdout pipe, so a writer that dies turns the bot's next write into
//      EPIPE and kills a running pipeline. Every failure mode must degrade to
//      pass-through and keep draining. The `degrades` and `survives SIGINT`
//      cases below are the real regression guards.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TEE = path.join(__dirname, '..', 'scripts', 'log-tee.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-tee-'));

function caseDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Feed `chunks` through the writer and resolve once it has exited, so the file
// is guaranteed flushed and closed before any assertion reads it.
function runTee(env, chunks, { signal = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TEE], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code }));

    (async () => {
      for (const chunk of chunks) {
        child.stdin.write(chunk);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (signal) {
        // Wait until the writer has actually echoed something before signalling.
        // Node needs ~tens of ms to load the script and install its handlers;
        // a signal sent before that hits the default disposition and kills it,
        // which measures node's startup rather than the writer's behaviour.
        for (let i = 0; i < 200 && stdout === ''; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        child.kill(signal);
        await new Promise((r) => setTimeout(r, 100));
        // If the signal killed it, stdin.end() below resolves via the close
        // event anyway and the exit code assertion catches the difference.
        child.stdin.write('after-signal\n');
        await new Promise((r) => setTimeout(r, 20));
      }
      child.stdin.end();
    })();
  });
}

test('passes every byte through to stdout and copies it to the file', async () => {
  const dir = caseDir('passthrough');
  const file = path.join(dir, 'app.log');
  const { stdout } = await runTee(
    { BP_LOG_TEE_FILE: file },
    ['first line\n', 'second line\n'],
  );

  // Pass-through is what keeps `fly logs` working; the copy is the new part.
  assert.match(stdout, /first line/);
  assert.match(stdout, /second line/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first line\nsecond line\n');
});

test('appends to an existing log rather than truncating it on restart', async () => {
  const dir = caseDir('append');
  const file = path.join(dir, 'app.log');
  fs.writeFileSync(file, 'from a previous boot\n');

  await runTee({ BP_LOG_TEE_FILE: file }, ['after restart\n']);

  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /from a previous boot/, 'history from before the restart was lost');
  assert.match(body, /after restart/);
});

test('rotates at the size cap and prunes beyond the keep limit', async () => {
  const dir = caseDir('rotate');
  const file = path.join(dir, 'app.log');
  const line = `${'x'.repeat(99)}\n`; // 100 bytes

  await runTee(
    { BP_LOG_TEE_FILE: file, BP_LOG_TEE_MAX_BYTES: '250', BP_LOG_TEE_KEEP: '2' },
    Array.from({ length: 12 }, () => line),
  );

  assert.ok(fs.existsSync(file), 'live log missing after rotation');
  assert.ok(fs.existsSync(`${file}.1`), 'first rotated generation missing');
  assert.ok(fs.existsSync(`${file}.2`), 'second rotated generation missing');
  assert.ok(!fs.existsSync(`${file}.3`), 'keep limit not enforced — disk would grow unbounded');

  for (const f of [file, `${file}.1`, `${file}.2`]) {
    assert.ok(fs.statSync(f).size <= 250, `${path.basename(f)} exceeded the cap`);
  }
});

test('degrades to pass-through when the log file cannot be written', async () => {
  const dir = caseDir('unwritable');
  // A path whose parent is a regular file: mkdir/open both fail, like the
  // permission and disk-full failures this has to survive in the container.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory\n');
  const file = path.join(blocker, 'nested', 'app.log');

  const { stdout, code } = await runTee({ BP_LOG_TEE_FILE: file }, ['still flowing\n']);

  assert.strictEqual(code, 0, 'writer exited non-zero — the bot would have taken an EPIPE');
  assert.match(stdout, /still flowing/, 'pass-through stopped when file logging failed');
  assert.match(stdout, /file logging disabled/, 'degradation was silent');
});

test('keeps draining after a mid-write failure instead of dying', async () => {
  const dir = caseDir('midwrite');
  const file = path.join(dir, 'app.log');

  const child = spawn(process.execPath, [TEE], {
    env: { ...process.env, BP_LOG_TEE_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((r) => child.on('close', r));

  child.stdin.write('before\n');
  await new Promise((r) => setTimeout(r, 80));
  // Yank the directory out from under the open fd, then keep sending output.
  fs.rmSync(dir, { recursive: true, force: true });
  child.stdin.write('after\n');
  await new Promise((r) => setTimeout(r, 80));
  child.stdin.end();

  const code = await done;
  assert.strictEqual(code, 0, 'writer died after a file error');
  assert.match(stdout, /before/);
  assert.match(stdout, /after/, 'output after the file error was dropped');
});

test('ignores SIGINT so the graceful-shutdown output still reaches disk', async () => {
  const dir = caseDir('sigint');
  const file = path.join(dir, 'app.log');

  // fly.toml sends SIGINT. If that lands on the process group, the writer must
  // survive it — the shutdown path is precisely the output we want durable.
  const { stdout, code } = await runTee(
    { BP_LOG_TEE_FILE: file },
    ['before signal\n'],
    { signal: 'SIGINT' },
  );

  assert.strictEqual(code, 0, 'writer was killed by SIGINT');
  assert.match(stdout, /after-signal/, 'writer stopped draining after SIGINT');
  assert.match(fs.readFileSync(file, 'utf8'), /after-signal/,
    'shutdown-window output never made it to the durable copy');
});

test('selftest reports writable and unwritable targets correctly', () => {
  const dir = caseDir('selftest');
  const ok = spawnSync(process.execPath, [TEE, '--selftest'], {
    env: { ...process.env, BP_LOG_TEE_FILE: path.join(dir, 'nested', 'app.log') },
  });
  assert.strictEqual(ok.status, 0, 'selftest failed on a writable target');
  assert.ok(fs.existsSync(path.join(dir, 'nested')), 'selftest did not create the log dir');
  // The probe files it uses to verify rename/unlink must not be left behind.
  assert.deepStrictEqual(
    fs.readdirSync(path.join(dir, 'nested')).filter((f) => f.includes('probe')), [],
    'selftest left probe files behind',
  );

  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory\n');
  const bad = spawnSync(process.execPath, [TEE, '--selftest'], {
    env: { ...process.env, BP_LOG_TEE_FILE: path.join(blocker, 'app.log') },
  });
  assert.notStrictEqual(bad.status, 0, 'selftest passed on an unwritable target');
});

test('SIGKILLing the writer does not take the app down', async () => {
  const dir = caseDir('writer-killed');
  const file = path.join(dir, 'app.log');

  // The "done" criterion from #290: killing or blocking the writer must not
  // disturb the running bot. With stdout wired to the writer, its death turns
  // the app's next write into EPIPE — which exits node unless the guard from
  // src/stdout-guard.js is installed. This runs the real wiring and the real
  // guard, kills the writer mid-run, and asserts the app runs to completion.
  const appFile = path.join(dir, 'app.js');
  fs.writeFileSync(appFile, `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'stdout-guard.js'))})
      .installStdoutEpipeGuard();
    let n = 0;
    const t = setInterval(() => {
      console.log('tick ' + (++n));
      if (n >= 40) { clearInterval(t); require('fs').writeFileSync(
        ${JSON.stringify(path.join(dir, 'survived'))}, 'app finished normally'); }
    }, 25);
  `);

  // A unique argv tag so we can find this exact writer. log-tee.js ignores
  // arguments other than --selftest.
  const tag = '--tag=writer-kill-case';
  const script = `exec node "${appFile}" `
    + `> >(exec env BP_LOG_TEE_FILE="${file}" node "${TEE}" ${tag}) 2>&1`;

  const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((r) => child.on('close', r));

  // Let it get going, then kill the writer out from under the live app.
  // Matching on the exact argv vector rather than `pkill -f` on the log path:
  // the wrapper shells' command lines embed the whole script text, so a
  // substring match kills the harness instead of the writer.
  await new Promise((r) => setTimeout(r, 300));
  const writers = fs.readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .filter((pid) => {
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        return argv[1] === TEE && argv[2] === tag;
      } catch { return false; }
    });
  assert.strictEqual(writers.length, 1, `expected exactly one writer, found ${writers.length}`);
  process.kill(Number(writers[0]), 'SIGKILL');

  const code = await done;
  assert.ok(fs.existsSync(path.join(dir, 'survived')),
    'app did not finish its work after the writer was killed');
  assert.strictEqual(code, 0, `app exited ${code} after the writer was SIGKILLed`);
});

test('entrypoint wiring keeps the app as PID 1 and captures stdout and stderr', async () => {
  const dir = caseDir('procsub');
  const file = path.join(dir, 'app.log');

  // The exact shape entrypoint.sh uses. `exec` means the payload replaces bash,
  // so $$ inside it is the shell's own PID — proof the app process, not a shell,
  // is what Fly would signal.
  const app = 'process.stdout.write(`pid=${process.pid}\\n`);'
    + 'process.stderr.write("to stderr\\n");';
  const script = `exec node -e '${app}' > >(exec env BP_LOG_TEE_FILE="${file}" `
    + `node "${TEE}") 2>&1`;

  const res = await new Promise((resolve) => {
    const child = spawn('bash', ['-c', `echo "shell=$$"; ${script}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => setTimeout(() => resolve({ stdout, code }), 150));
  });

  const shellPid = /shell=(\d+)/.exec(res.stdout);
  const appPid = /pid=(\d+)/.exec(res.stdout);
  assert.ok(shellPid && appPid, `missing pids in output: ${res.stdout}`);
  assert.strictEqual(appPid[1], shellPid[1],
    'app did not replace the shell — Fly\'s SIGINT would hit bash, not the bot');

  assert.match(res.stdout, /to stderr/, 'stderr was not merged into the tee');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /pid=/, 'stdout missing from the durable copy');
  assert.match(body, /to stderr/, 'stderr missing from the durable copy');
});
