// Tests for workspace-tools-cli.js and workspace-tools/registry.js — the Bash
// CLI surface over the workspace tools.
//
// Two guarantees:
//   1. Parity: every tool name registered on any MCP server factory in
//      workspace-tools/index.js exists in the registry (the surfaces cannot
//      drift), and every registry handler is a function.
//   2. CLI behavior: stdout matches a direct handler call byte-for-byte,
//      stdin (`-`) arg passing works, and usage errors exit 2.
//
// All CLI invocations use absolute paths inside a temp dir, so the suite is
// hermetic (no skills checkout or network needed).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.resolve(__dirname, '../src/workspace-tools-cli.js');
const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, '../src/workspace-tools/index.js'), 'utf8');
const { TOOLS, cliToolNames } = require('../src/workspace-tools/registry');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CSKILLBP_DIR: opts.cwd || os.tmpdir() },
    input: opts.input,
  });
}

test('registry covers every tool name registered in index.js', () => {
  // Tool registrations look like: tool('name', 'desc', {...}, handler)
  const registered = new Set();
  for (const m of INDEX_SRC.matchAll(/tool\(\s*'([a-z0-9_]+)'/g)) registered.add(m[1]);
  assert.ok(registered.size >= 50, `expected 50+ registrations, parsed ${registered.size}`);
  const missing = [...registered].filter((name) => !TOOLS[name]);
  assert.deepEqual(missing, [], `index.js tools missing from registry: ${missing.join(', ')}`);
});

test('every registry handler is a function', () => {
  for (const [name, entry] of Object.entries(TOOLS)) {
    assert.equal(typeof entry.handler, 'function', `${name} handler is not a function`);
  }
});

test('cliToolNames excludes exactly the cli:false tools', () => {
  const names = cliToolNames();
  for (const excluded of ['gitea_pr', 'fetch_issues_resolved', 'read_prepared_notes']) {
    assert.ok(TOOLS[excluded], `${excluded} should exist in registry`);
    assert.equal(TOOLS[excluded].cli, false, `${excluded} should be cli:false`);
    assert.ok(!names.includes(excluded), `${excluded} should not be CLI-exposed`);
  }
  assert.equal(names.length, Object.keys(TOOLS).length - 3);
});

test('--list prints the CLI-exposed tool names', () => {
  const res = runCli(['--list']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.trim().split('\n'), cliToolNames());
});

test('usage errors exit 2', () => {
  assert.equal(runCli([]).status, 2, 'no tool name');
  assert.equal(runCli(['no_such_tool', '{}']).status, 2, 'unknown tool');
  assert.equal(runCli(['gitea_pr', '{}']).status, 2, 'cli:false tool');
  assert.equal(runCli(['fix_trailing_newlines', '{not json']).status, 2, 'malformed JSON');
  assert.equal(runCli(['fix_trailing_newlines', '[1,2]']).status, 2, 'non-object JSON');
});

test('CLI stdout matches direct handler call (fix_trailing_newlines)', () => {
  // Same basename in two temp dirs — the result string embeds the basename.
  const tsv = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n'
    + '1:1\tab1c\t\t\tfoo\t1\tA note with trailing\\n\n'
    + '1:2\tab2c\t\t\tbar\t1\tClean note\n';
  const cliFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wtcli-')), 'notes.tsv');
  const directFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wtcli-')), 'notes.tsv');
  fs.writeFileSync(cliFile, tsv);
  fs.writeFileSync(directFile, tsv);

  const res = runCli(['fix_trailing_newlines', JSON.stringify({ file: cliFile })]);
  const direct = require('../src/workspace-tools/tsv-tools').fixTrailingNewlines({ file: directFile });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${direct}\n`);
  assert.equal(fs.readFileSync(cliFile, 'utf8'), fs.readFileSync(directFile, 'utf8'));
});

test('stdin arg form (`-`) matches inline JSON form (read_usfm_chapter)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtcli-'));
  const usfm = '\\id GEN test\n\\c 1\n\\p\n\\v 1 In the beginning\n\\c 2\n\\p\n\\v 1 Thus the heavens\n';
  const file = path.join(dir, 'book.usfm');
  fs.writeFileSync(file, usfm);
  const args = JSON.stringify({ file, chapter: 2 });

  const inline = runCli(['read_usfm_chapter', args], { cwd: dir });
  const stdin = runCli(['read_usfm_chapter', '-'], { cwd: dir, input: args });

  assert.equal(inline.status, 0, inline.stderr);
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(stdin.stdout, inline.stdout);
  assert.match(inline.stdout, /Thus the heavens/);
  assert.doesNotMatch(inline.stdout, /In the beginning/);
});

test('tool-level "Error:" results keep exit 0 (MCP semantics)', () => {
  const res = runCli(['read_usfm_chapter', JSON.stringify({ file: '/nonexistent/x.usfm', chapter: 1 })]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Error: file not found/);
});
