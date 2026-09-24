// Regression tests for #399: AI alignment writes U+2060 WORD JOINER in place of a
// cantillation accent in \zaln-s x-content, so the milestone stops byte-matching the
// UHB \w token and downstream highlighters cannot link the word.
//
// The three verses below are the ones a translator reported in prod (bible-editor D1,
// same bytes as Door43 master); they are spelled out as explicit escapes so the fixture
// cannot be silently normalized by an editor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xcontent-repair-'));
process.env.CSKILLBP_DIR = TMP;
const { repairAlignmentXContent } = require('../src/workspace-tools/usfm-tools');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// --- JER 28:12 ULT — U+05A0 TELISHA GEDOLA replaced by U+2060 ---
const UHB_AFTER   = 'אַ֠חֲרֵי';       // אַ֠חֲרֵי
const BAD_AFTER   = 'אַ⁠חֲרֵי';       // אַ⁠חֲרֵי

// --- JER 32:20 UST — U+05A0 TELISHA GEDOLA replaced by U+2060 ---
const UHB_SAMTA   = 'שַׂ֠מְתָּ'; // שַׂ֠מְתָּ
const BAD_SAMTA   = 'שַׂ⁠מְתָּ'; // שַׂ⁠מְתָּ

// --- JER 28:4 UST — U+059C GERESH dropped and a U+2060 inserted after the prefix ---
const UHB_YEHUDAH = 'יְהוּדָ֜ה'; // יְהוּדָ֜ה
const BAD_YEHUDAH = 'יְ⁠הוּדָה'; // יְ⁠הוּדָה

function writeRel(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return rel;
}

// UHB puts each \w token on its own line after the \v marker; the parser relies on that.
function uhbWord(word, strong) {
  return `\\w ${word}|lemma="${word}" strong="${strong}" x-morph="He,R"\\w*`;
}

function zaln(xContent, english, strong, occurrence = 1) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="x" x-morph="He,R" `
    + `x-occurrence="${occurrence}" x-occurrences="1" x-content="${xContent}"\\`
    + `*\\w ${english}|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`;
}

/** Success check from the issue: every x-content must byte-match some UHB \w token. */
function unmatchedMilestones(alignedText, uhbText) {
  const uhbTokens = new Set();
  let m;
  const wRe = /\\w\s+([^|]+)\|/g;
  while ((m = wRe.exec(uhbText)) !== null) uhbTokens.add(m[1].trimEnd());
  const bad = [];
  const xRe = /x-content="([^"]*)"/g;
  while ((m = xRe.exec(alignedText)) !== null) {
    if (!uhbTokens.has(m[1])) bad.push(m[1]);
  }
  return bad;
}

test('#399 rewrites x-content that swapped a cantillation accent for U+2060 to UHB bytes', () => {
  const hebrew = writeRel('h1/uhb.usfm', [
    '\\id JER',
    '\\c 28',
    '\\v 4',
    uhbWord(UHB_YEHUDAH, 'H3063'),
    '\\v 12',
    uhbWord(UHB_AFTER, 'H0310'),
    '\\c 32',
    '\\v 20',
    uhbWord(UHB_SAMTA, 'H7760'),
    '',
  ].join('\n'));

  const aligned = writeRel('h1/aligned.usfm', [
    '\\id JER EN_ULT - Aligned',
    '\\c 28',
    '\\p',
    `\\v 4 ${zaln(BAD_YEHUDAH, 'Judah', 'H3063')}`,
    `\\v 12 ${zaln(BAD_AFTER, 'after', 'H0310')}`,
    '\\c 32',
    '\\p',
    `\\v 20 ${zaln(BAD_SAMTA, 'you set', 'H7760')}`,
    '',
  ].join('\n'));

  const summary = repairAlignmentXContent({ alignedUsfm: aligned, hebrewUsfm: hebrew });
  const out = fs.readFileSync(path.join(TMP, aligned), 'utf8');

  assert.match(summary, /Repaired 3 x-content mismatch/);
  assert.match(summary, /accent\/word-joiner substitution/);
  assert.doesNotMatch(summary, /WARNING/);

  // Byte-exact, not merely visually equal.
  assert.ok(out.includes(`x-content="${UHB_AFTER}"`), 'JER 28:12 not repaired to UHB bytes');
  assert.ok(out.includes(`x-content="${UHB_SAMTA}"`), 'JER 32:20 not repaired to UHB bytes');
  assert.ok(out.includes(`x-content="${UHB_YEHUDAH}"`), 'JER 28:4 not repaired to UHB bytes');

  // No stray U+2060 survived where an accent belongs.
  assert.ok(!out.includes(BAD_AFTER) && !out.includes(BAD_SAMTA) && !out.includes(BAD_YEHUDAH));

  const hebrewText = fs.readFileSync(path.join(TMP, hebrew), 'utf8');
  assert.deepEqual(unmatchedMilestones(out, hebrewText), [],
    'chapter still has milestones whose content does not byte-match a UHB \\w token');
});

test('#399 leaves x-content untouched, and reports it, when the relaxed key is ambiguous', () => {
  // Two UHB tokens in one verse differing only by accent: stripping accents collapses
  // them, so we cannot know which one the milestone meant. Guessing would silently
  // mis-link a word, which is worse than leaving it broken and visible.
  const A = 'דָבָר֑';  // דָבָר + etnahta
  const B = 'דָבָר֒';  // דָבָר + segolta
  const BAD = 'דָ⁠בָר'; // joiner, no accent

  const hebrew = writeRel('h2/uhb.usfm', [
    '\\id JER', '\\c 1', '\\v 1', uhbWord(A, 'H1697'), uhbWord(B, 'H1697'), '',
  ].join('\n'));
  const aligned = writeRel('h2/aligned.usfm', [
    '\\id JER EN_ULT - Aligned', '\\c 1', '\\p', `\\v 1 ${zaln(BAD, 'word', 'H1697')}`, '',
  ].join('\n'));

  const before = fs.readFileSync(path.join(TMP, aligned), 'utf8');
  const summary = repairAlignmentXContent({ alignedUsfm: aligned, hebrewUsfm: hebrew });
  const after = fs.readFileSync(path.join(TMP, aligned), 'utf8');

  assert.equal(after, before, 'ambiguous milestone must not be rewritten');
  assert.match(summary, /WARNING: 1 x-content value\(s\) matched more than one UHB token/);
  assert.match(summary, /1:1/);
});

test('#399 reports x-content that matches no UHB token in the verse', () => {
  const hebrew = writeRel('h3/uhb.usfm', [
    '\\id JER', '\\c 1', '\\v 1', uhbWord(UHB_AFTER, 'H0310'), '',
  ].join('\n'));
  const aligned = writeRel('h3/aligned.usfm', [
    '\\id JER EN_ULT - Aligned', '\\c 1', '\\p',
    `\\v 1 ${zaln('שָלוֹם', 'peace', 'H7965')}`, '',
  ].join('\n'));

  const summary = repairAlignmentXContent({ alignedUsfm: aligned, hebrewUsfm: hebrew });
  assert.match(summary, /WARNING: 1 x-content value\(s\) matched no UHB/);
});

test('#399 is a no-op and stays silent when x-content is already byte-exact', () => {
  const hebrew = writeRel('h4/uhb.usfm', [
    '\\id JER', '\\c 28', '\\v 12', uhbWord(UHB_AFTER, 'H0310'), '',
  ].join('\n'));
  const aligned = writeRel('h4/aligned.usfm', [
    '\\id JER EN_ULT - Aligned', '\\c 28', '\\p',
    `\\v 12 ${zaln(UHB_AFTER, 'after', 'H0310')}`, '',
  ].join('\n'));

  const before = fs.readFileSync(path.join(TMP, aligned), 'utf8');
  const summary = repairAlignmentXContent({ alignedUsfm: aligned, hebrewUsfm: hebrew });

  assert.equal(fs.readFileSync(path.join(TMP, aligned), 'utf8'), before);
  assert.match(summary, /No x-content mismatches found/);
  assert.doesNotMatch(summary, /WARNING/);
});

test('#399 still repairs the original combining-mark reorder case', () => {
  // Traditional UHB order is consonant -> dagesh -> vowel; NFC reorders by combining
  // class, giving the same glyph with different bytes. Tier 1 must keep catching this.
  const UHB = 'בִּ';        // ב + dagesh + hiriq
  const REORDERED = 'בִּ';  // ב + hiriq + dagesh (NFC form)
  assert.notEqual(UHB, REORDERED);
  assert.equal(UHB.normalize('NFC'), REORDERED.normalize('NFC'));

  const hebrew = writeRel('h5/uhb.usfm', [
    '\\id JER', '\\c 1', '\\v 1', uhbWord(UHB, 'H0001'), '',
  ].join('\n'));
  const aligned = writeRel('h5/aligned.usfm', [
    '\\id JER EN_ULT - Aligned', '\\c 1', '\\p', `\\v 1 ${zaln(REORDERED, 'in', 'H0001')}`, '',
  ].join('\n'));

  const summary = repairAlignmentXContent({ alignedUsfm: aligned, hebrewUsfm: hebrew });
  const out = fs.readFileSync(path.join(TMP, aligned), 'utf8');
  assert.match(summary, /Repaired 1 x-content mismatch/);
  assert.doesNotMatch(summary, /accent\/word-joiner/);
  assert.ok(out.includes(`x-content="${UHB}"`));
});
