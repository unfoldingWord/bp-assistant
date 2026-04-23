const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config.json');
const { buildSyntheticRoute, buildWriteTqsConfirmText } = require('../src/router');
const { REPO_MAP, getRepoFilename } = require('../src/door43-push');

test('write-tqs config route matches book-only, range, and single chapter commands', () => {
  const route = config.routes.find((entry) => entry.name === 'write-tqs');
  assert.ok(route, 'write-tqs route should exist');

  const regexMatch = route.match.match(/^\/(.+)\/([gimsuy]*)$/);
  assert.ok(regexMatch, 'write-tqs route should use regex literal');
  const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');

  assert.deepEqual('write tqs for HAB'.match(regex).slice(1), ['HAB', undefined]);
  assert.deepEqual('write tqs for PSA 1-10'.match(regex).slice(1), ['PSA', '1-10']);
  assert.deepEqual('write tq psa 23'.match(regex).slice(1), ['psa', '23']);
});

test('synthetic tqs route expands book-only intents to a full-book scope', () => {
  const route = buildSyntheticRoute({
    intent: 'tqs',
    book: 'HAB',
    startChapter: null,
    endChapter: null,
    scopeText: null,
  });

  assert.equal(route.name, 'write-tqs');
  assert.equal(route._book, 'HAB');
  assert.equal(route._startChapter, 1);
  assert.equal(route._endChapter, 3);
  assert.equal(route._wholeBook, true);
  assert.equal(route.confirmMessage, "I'll write translation questions for **HAB**. Sound right? (yes/no)");
});

test('synthetic tqs route preserves single chapter and range scopes', () => {
  const single = buildSyntheticRoute({
    intent: 'tqs',
    book: 'PSA',
    startChapter: 23,
    endChapter: 23,
    scopeText: '23',
  });
  assert.equal(single._startChapter, 23);
  assert.equal(single._endChapter, 23);
  assert.equal(single._wholeBook, false);
  assert.equal(single.confirmMessage, "I'll write translation questions for **PSA 23**. Sound right? (yes/no)");

  const range = buildSyntheticRoute({
    intent: 'tqs',
    book: 'PSA',
    startChapter: 1,
    endChapter: 10,
    scopeText: '1-10',
  });
  assert.equal(range._startChapter, 1);
  assert.equal(range._endChapter, 10);
  assert.equal(range._wholeBook, false);
  assert.equal(range.confirmMessage, "I'll write translation questions for **PSA 1-10**. Sound right? (yes/no)");
});

test('buildWriteTqsConfirmText renders regex route captures correctly', () => {
  const route = { type: 'tqs', name: 'write-tqs' };

  assert.equal(
    buildWriteTqsConfirmText(route, ['HAB']),
    "I'll write translation questions for **HAB**. Sound right? (yes/no)"
  );
  assert.equal(
    buildWriteTqsConfirmText(route, ['PSA', '23']),
    "I'll write translation questions for **PSA 23**. Sound right? (yes/no)"
  );
  assert.equal(
    buildWriteTqsConfirmText(route, ['PSA', '1-10']),
    "I'll write translation questions for **PSA 1-10**. Sound right? (yes/no)"
  );
});

test('getChapterCount counts chapter markers in indexed USFM files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-counts-'));
  const oldHebrewDir = process.env.HEBREW_DIR;
  process.env.HEBREW_DIR = tempDir;

  const usfmPath = path.join(tempDir, '35-HAB.usfm');
  fs.writeFileSync(usfmPath, '\\id HAB\n\\c 1\n\\v 1 one\n\\c 2\n\\v 1 two\n\\c 3\n\\v 1 three\n');

  const modulePath = require.resolve('../src/verse-counts');
  delete require.cache[modulePath];

  try {
    const { getChapterCount } = require('../src/verse-counts');
    assert.equal(getChapterCount('HAB'), 3);
  } finally {
    if (oldHebrewDir == null) delete process.env.HEBREW_DIR;
    else process.env.HEBREW_DIR = oldHebrewDir;
    delete require.cache[modulePath];
  }
});

test('door43 push exposes tq repo mapping and filename convention', () => {
  assert.equal(REPO_MAP.tq, 'en_tq');
  assert.equal(getRepoFilename('tq', 'PSA'), 'tq_PSA.tsv');
});
