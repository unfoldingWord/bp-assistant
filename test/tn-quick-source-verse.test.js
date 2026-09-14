// tn-quick source-verse loading — testament routing (UHB vs UGNT), verse word
// extraction, and source-quote normalization across both scripts. See #394.
//
// The fixtures are checked in outside any `data/` directory because .gitignore
// ignores `data/` at every level, so they are staged into a temp workspace that
// has the real `data/<dir>/` layout the lookup expects. CSKILLBP_DIR is read at
// module load by quality-tools, so both the staging and the assignment must
// happen before the requires below. node --test gives each test file its own
// process, so this does not leak into other suites.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'source-usfm');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-quick-source-'));
for (const dir of ['greek_nt', 'hebrew_bible']) {
  const dest = path.join(workspace, 'data', dir);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(path.join(FIXTURES, dir))) {
    fs.copyFileSync(path.join(FIXTURES, dir, name), path.join(dest, name));
  }
}
process.env.CSKILLBP_DIR = workspace;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getVerseWords,
  sourceUsfmPathForBook,
} = require('../src/api/tn-quick');
const {
  normalizeHebrewQuote,
  foldSourceToken,
  hasSourceScript,
} = require('../src/workspace-tools/quality-tools');

after(() => fs.rmSync(workspace, { recursive: true, force: true }));

// Fixtures carry only chapter 1 of each book, which is all these tests read.
const LUK_1_1 = [
  'ἐπειδήπερ', 'πολλοὶ', 'ἐπεχείρησαν', 'ἀνατάξασθαι', 'διήγησιν',
  'περὶ', 'τῶν', 'πεπληροφορημένων', 'ἐν', 'ἡμῖν', 'πραγμάτων',
];

describe('sourceUsfmPathForBook — testament routing', () => {
  test('routes Old Testament books to the Hebrew directory', () => {
    assert.equal(sourceUsfmPathForBook('ZEC'), 'data/hebrew_bible/38-ZEC.usfm');
    assert.equal(sourceUsfmPathForBook('GEN'), 'data/hebrew_bible/01-GEN.usfm');
    assert.equal(sourceUsfmPathForBook('MAL'), 'data/hebrew_bible/39-MAL.usfm');
  });

  test('routes New Testament books to the Greek directory', () => {
    assert.equal(sourceUsfmPathForBook('MAT'), 'data/greek_nt/41-MAT.usfm');
    assert.equal(sourceUsfmPathForBook('LUK'), 'data/greek_nt/43-LUK.usfm');
    assert.equal(sourceUsfmPathForBook('REV'), 'data/greek_nt/67-REV.usfm');
  });

  test('accepts lowercase book codes and rejects unknown ones', () => {
    assert.equal(sourceUsfmPathForBook('luk'), 'data/greek_nt/43-LUK.usfm');
    assert.equal(sourceUsfmPathForBook('XYZ'), null);
  });
});

describe('getVerseWords — Greek NT (the #394 regression)', () => {
  test('LUK 1:1 returns the UGNT verse words', () => {
    const r = getVerseWords('LUK', 1, 1);
    assert.equal(r.status, 'ok');
    assert.equal(r.source, 'data/greek_nt/43-LUK.usfm');
    assert.deepEqual(r.words, LUK_1_1);
  });

  test('a later verse in the same chapter also resolves', () => {
    const r = getVerseWords('LUK', 1, 5);
    assert.equal(r.status, 'ok');
    assert.ok(r.words.length > 5);
    assert.ok(r.words.every((w) => hasSourceScript(w)));
  });
});

describe('getVerseWords — Hebrew OT stays working', () => {
  test('ZEC 1:1 still returns UHB verse words', () => {
    const r = getVerseWords('ZEC', 1, 1);
    assert.equal(r.status, 'ok');
    assert.equal(r.source, 'data/hebrew_bible/38-ZEC.usfm');
    assert.ok(r.words.length >= 8);
    assert.ok(r.words.every((w) => hasSourceScript(w)));
  });
});

describe('getVerseWords — failure modes are distinguishable', () => {
  test('unknown book code reports unknown_book, not a missing source', () => {
    const r = getVerseWords('XYZ', 1, 1);
    assert.equal(r.status, 'unknown_book');
    assert.deepEqual(r.words, []);
  });

  test('a verse past the end of a loaded book reports verse_not_found', () => {
    const r = getVerseWords('LUK', 1, 199);
    assert.equal(r.status, 'verse_not_found');
    assert.equal(r.source, 'data/greek_nt/43-LUK.usfm');
  });

  test('a known book with no file on disk reports source_missing', () => {
    // ROM is a real NT book that the fixture directory deliberately omits.
    const r = getVerseWords('ROM', 1, 1);
    assert.equal(r.status, 'source_missing');
    assert.equal(r.source, 'data/greek_nt/46-ROM.usfm');
  });
});

describe('normalizeHebrewQuote — Greek quotes', () => {
  test('a Greek quote matching a verse word normalizes to ok', () => {
    const r = normalizeHebrewQuote('ἐπεχείρησαν', LUK_1_1);
    assert.equal(r.status, 'ok');
    assert.equal(r.quote, 'ἐπεχείρησαν');
    assert.deepEqual(r.warnings, []);
  });

  test('adjacent Greek words join with a space, gapped words with " & "', () => {
    assert.equal(normalizeHebrewQuote('πολλοὶ ἐπεχείρησαν', LUK_1_1).quote,
      'πολλοὶ ἐπεχείρησαν');
    const gapped = normalizeHebrewQuote('πολλοὶ ἀνατάξασθαι', LUK_1_1);
    assert.equal(gapped.status, 'ok');
    assert.equal(gapped.quote, 'πολλοὶ & ἀνατάξασθαι');
  });

  test('accent variance (grave vs acute) still matches', () => {
    const r = normalizeHebrewQuote('πολλοί', LUK_1_1);
    assert.equal(r.status, 'ok');
  });

  test('a decomposed (NFD) Greek quote matches the precomposed source', () => {
    const r = normalizeHebrewQuote('ἐπεχείρησαν'.normalize('NFD'), LUK_1_1);
    assert.equal(r.status, 'ok');
  });

  test('a Greek word absent from the verse reports no_words_match', () => {
    const r = normalizeHebrewQuote('θεός', LUK_1_1);
    assert.equal(r.status, 'no_words_match');
    assert.equal(r.warnings[0].code, 'source_word_not_in_verse');
  });

  test('a Latin-script quote is rejected as no_source_script', () => {
    assert.equal(normalizeHebrewQuote('have undertaken', LUK_1_1).status, 'no_source_script');
    assert.equal(normalizeHebrewQuote('', LUK_1_1).status, 'no_source_script');
  });
});

describe('normalizeHebrewQuote — Hebrew behaviour is unchanged', () => {
  test('a Hebrew quote from ZEC 1:1 still normalizes to ok', () => {
    const words = getVerseWords('ZEC', 1, 1).words;
    const r = normalizeHebrewQuote(words[0], words);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.warnings, []);
  });

  test('matching stays cantillation-insensitive', () => {
    const words = getVerseWords('ZEC', 1, 1).words;
    // Strip cantillation (U+0591-U+05AF) but keep vowel points, as a model
    // quoting from a pointed text would.
    const stripped = words[0].replace(/[֑-֯]/g, '');
    assert.notEqual(stripped, words[0]);
    assert.equal(normalizeHebrewQuote(stripped, words).status, 'ok');
  });

  test('Hebrew and Greek fold independently of one another', () => {
    assert.equal(foldSourceToken('πολλοὶ'), foldSourceToken('πολλοί'));
    assert.notEqual(foldSourceToken('πολλοὶ'), foldSourceToken('ἐπεχείρησαν'));
  });
});
