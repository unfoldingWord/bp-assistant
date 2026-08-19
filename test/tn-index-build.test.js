const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// buildTnIndex reads CSKILLBP_DIR at require time, so set it up before loading.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-index-'));
fs.mkdirSync(path.join(TMP, 'data/published-tns'), { recursive: true });
process.env.CSKILLBP_DIR = TMP;

const { buildTnIndex } = require('../src/workspace-tools/index-tools.js');

const CURRENT_HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';
const H = 'rc://*/ta/man/translate/';

function currentRow(ref, id, sref, hebrew, note) {
  return [ref, id, '', sref, hebrew, '1', note].join('\t');
}

function writeTn(name, lines) {
  fs.writeFileSync(path.join(TMP, 'data/published-tns', name), lines.join('\n') + '\n');
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'data/cache/tn_index.json'), 'utf8'));
}

function reset() {
  const dir = path.join(TMP, 'data/published-tns');
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const cache = path.join(TMP, 'data/cache/tn_index.json');
  if (fs.existsSync(cache)) fs.unlinkSync(cache);
}

test('current 7-column format produces a non-empty by_keyword', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    '# Fetched: 2026-08-19',
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-metaphor', 'חֲזוֹן', 'Here **vision** is a message from Yahweh.'),
    currentRow('1:2', 'a2', H + 'figs-metaphor', 'קָטֹן', 'The word **vision** here refers to prophecy.'),
    currentRow('1:3', 'a3', H + 'figs-idiom', 'לֵב', 'The phrase **your heart** refers to the inner person.'),
  ]);

  const msg = await buildTnIndex({ force: true });
  const idx = readIndex();

  // Regression: this was 0 because cols[4] holds original-language Hebrew.
  assert.ok(Object.keys(idx.by_keyword).length > 0, `by_keyword empty: ${msg}`);
  assert.ok(idx.by_keyword.vision, 'expected "vision" from bold spans in the Note column');
  assert.strictEqual(idx.by_keyword.vision[0].issue, 'figs-metaphor');
  assert.strictEqual(idx.by_keyword.vision[0].count, 2);
});

test('Hebrew from the Quote column never becomes a keyword', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    '# Fetched: 2026-08-19',
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-metaphor', 'חֲזוֹן', 'A note with **mountain** in it.'),
    currentRow('1:2', 'a2', H + 'figs-metaphor', 'חֲזוֹן', 'Another **mountain** note.'),
  ]);

  await buildTnIndex({ force: true });
  const idx = readIndex();

  for (const kw of Object.keys(idx.by_keyword)) {
    assert.ok(!/[֐-׿]/.test(kw), `Hebrew leaked into by_keyword: ${kw}`);
  }
  assert.ok(idx.by_keyword.mountain, 'expected the GL bold span to be indexed');
});

test('note boilerplate outside bold spans is not indexed', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    '# Fetched: 2026-08-19',
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-idiom', 'לֵב', 'Alternate translation: if it would be helpful in your language, use **brother**.'),
    currentRow('1:2', 'a2', H + 'figs-idiom', 'לֵב', 'Alternate translation: in your language you may use **brother**.'),
  ]);

  await buildTnIndex({ force: true });
  const idx = readIndex();

  assert.ok(idx.by_keyword.brother, 'expected the bold GL term');
  // "alternate"/"translation"/"language" each appear twice, so a >=2 prose index would keep them.
  for (const noise of ['alternate', 'translation', 'language', 'helpful']) {
    assert.ok(!idx.by_keyword[noise], `note boilerplate "${noise}" should not be a keyword`);
  }
});

test('# Fetched line and header row are not counted as notes', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    '# Fetched: 2026-08-19',
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-metaphor', 'ח', 'A **vision** note.'),
    currentRow('1:2', 'a2', H + 'figs-idiom', 'ל', 'An **idiom** note.'),
  ]);

  await buildTnIndex({ force: true });
  assert.strictEqual(readIndex()._meta.total_notes, 2);
});

test('files without a # Fetched line still parse correctly', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-metaphor', 'ח', 'A **vision** note.'),
    currentRow('1:2', 'a2', H + 'figs-metaphor', 'ח', 'Another **vision** note.'),
  ]);

  await buildTnIndex({ force: true });
  const idx = readIndex();
  assert.strictEqual(idx._meta.total_notes, 2);
  assert.ok(idx.by_keyword.vision);
});

test('legacy 9-column format A still indexes its GL quote column', async () => {
  reset();
  const legacyHeader = 'Book\tChapter\tVerse\tID\tSupportReference\tOrigQuote\tOccurrence\tGLQuote\tOccurrenceNote';
  const row = (v, id, sref, gl, note) => ['OBA', '1', v, id, sref, 'ח', '1', gl, note].join('\t');
  writeTn('tn_OBA.tsv', [
    legacyHeader,
    row('1', 'a1', H + 'figs-metaphor', 'the vision of Obadiah', 'A note.'),
    row('2', 'a2', H + 'figs-metaphor', 'the vision again', 'Another note.'),
  ]);

  await buildTnIndex({ force: true });
  const idx = readIndex();
  assert.strictEqual(idx._meta.total_notes, 2);
  assert.ok(idx.by_keyword.vision, 'format A must keep indexing GLQuote at cols[7]');
  assert.strictEqual(idx.by_keyword.vision[0].count, 2);
});

test('lookup returns issue-type hits instead of "not found"', async () => {
  reset();
  writeTn('tn_OBA.tsv', [
    '# Fetched: 2026-08-19',
    CURRENT_HEADER,
    currentRow('1:1', 'a1', H + 'figs-metonymy', 'יָד', 'Here **hand** represents power.'),
    currentRow('1:2', 'a2', H + 'figs-metonymy', 'יָד', 'The word **hand** means control.'),
  ]);

  await buildTnIndex({ force: true });
  const out = await buildTnIndex({ lookup: 'hand' });

  assert.ok(!out.includes('not found'), `lookup regressed: ${out}`);
  assert.match(out, /figs-metonymy/);
});
