// Cross-book "see how you translated" pointers (issue #367).
//
// Rule: only the FIRST occurrence in a book of a phrase already explained in
// another book earns a cross-book pointer. Later occurrences fall back to the
// same-book rules, which by then have a same-book target to point at.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'see-how-xbook-'));
process.env.CSKILLBP_DIR = WORKSPACE;
process.env.DOOR43_REPOS_PATH = path.join(WORKSPACE, 'door43-repos');

const {
  _runSeeHowDetection: runSeeHowDetection,
  _buildRecurrenceIndexFile: buildRecurrenceIndexFile,
} = require('../src/notes-pipeline');
const { buildCrossBookIndex } = require('../src/workspace-tools/recurrence-index');

// A single-word translate-names key: eligible for a pointer (translate-names is
// on the consistency-bearing sref list) and not on the ultra-frequent stoplist.
const SAUL = 'שָׁא֑וּל';
const SAUL_STRONG = 'H7586';
const SAUL_KEY = 'H7586';

function alignedWord(strong, content, words) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="l" x-occurrence="1" x-content="${content}"\\*` +
    words.map((w) => `\\w ${w}|x-occurrence="1"\\w*`).join(' ') +
    '\\zaln-e\\*';
}
const saulSpan = () => alignedWord(SAUL_STRONG, SAUL, ['Saul']);

// EXO: the phrase's first occurrence in the book is 3:4; it recurs at 3:9 and 5:2.
const ALIGNED_EXO = [
  '\\id EXO',
  '\\c 3', '\\p',
  '\\v 2 ' + alignedWord('H4325', 'מַ֫יִם', ['water']),
  '\\v 4 ' + saulSpan(),
  '\\v 9 ' + saulSpan(),
  '\\c 5', '\\p',
  '\\v 2 ' + saulSpan(),
  '',
].join('\n');

// The UHB is the only source carrying the literal separators needed to slice a
// span back out byte-for-byte, which an injected row's Quote requires.
const uhbWord = `\\w ${SAUL}|lemma="שָׁאוּל" strong="${SAUL_STRONG}"\\w*`;
const UHB_EXO = [
  '\\id EXO',
  '\\c 3',
  `\\v 4 ${uhbWord}`,
  `\\v 9 ${uhbWord}`,
  '\\c 5',
  `\\v 2 ${uhbWord}`,
  '',
].join('\n');

const ALIGNMENT_DATA = {
  '3:4': [{ heb: SAUL, strong: SAUL_STRONG }],
  '3:9': [{ heb: SAUL, strong: SAUL_STRONG }],
  '5:2': [{ heb: SAUL, strong: SAUL_STRONG }],
};

// The corpus already explains the name in Genesis 10:2.
function crossBookCache(byKey) {
  const dir = path.join(WORKSPACE, 'data', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crossbook_seehow_index.json'), JSON.stringify({
    _meta: { built: 'test' },
    byKey,
  }));
}
function clearCrossBookCache() {
  const f = path.join(WORKSPACE, 'data', 'cache', 'crossbook_seehow_index.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
const GEN_ENTRY = (over = {}) => ({
  first: {
    book: 'GEN', ref: '10:2', chapter: 10, verse: '2',
    sref: 'translate-names', quote: SAUL, id: 'gen1',
  },
  bookCount: 2,
  notedBookCount: 1,
  ...over,
});

let dirCounter = 0;
function setupPipeDir({ book = 'EXO', chapter = '3', items = [], tnBookTsv = '' } = {}) {
  const dirPath = `tmp/pipeline/${book}-${String(chapter).padStart(2, '0')}-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });

  fs.writeFileSync(path.join(abs, 'ult.usfm'), ALIGNED_EXO);
  fs.writeFileSync(path.join(abs, 'hebrew.usfm'), UHB_EXO);
  fs.writeFileSync(path.join(abs, 'prepared_notes.json'), JSON.stringify({
    book, chapter, item_count: items.length, items,
  }, null, 2));
  fs.writeFileSync(path.join(abs, 'alignment_data.json'), JSON.stringify(ALIGNMENT_DATA));
  fs.writeFileSync(path.join(abs, 'generated_notes.json'), '{}');

  const clone = path.join(WORKSPACE, 'door43-repos', 'en_tn');
  fs.mkdirSync(clone, { recursive: true });
  const tnPath = path.join(clone, `tn_${book}.tsv`);
  if (tnBookTsv) fs.writeFileSync(tnPath, tnBookTsv);
  else if (fs.existsSync(tnPath)) fs.unlinkSync(tnPath);

  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({
    version: 1, pipeline: 'notes', book, chapter: Number(chapter),
    verseStart: null, verseEnd: null,
    sources: { ultFull: `${dirPath}/ult.usfm`, hebrew: `${dirPath}/hebrew.usfm` },
    runtime: {
      preparedNotes: `${dirPath}/prepared_notes.json`,
      generatedNotes: `${dirPath}/generated_notes.json`,
      alignmentData: `${dirPath}/alignment_data.json`,
      recurrenceIndex: `${dirPath}/recurrence_index.json`,
    },
    artifacts: {},
  }, null, 2));
  return dirPath;
}
const readPrepared = (d) =>
  JSON.parse(fs.readFileSync(path.join(WORKSPACE, d, 'prepared_notes.json'), 'utf8'));
const stubIds = ({ count }) =>
  Array.from({ length: count }, (_, i) => `z${String(i).padStart(3, '0')}`).join('\n');

function item(over) {
  return Object.assign({
    index: 0, reference: '3:4', id: 'aaaa',
    sref: 'translate-names', gl_quote: 'Saul', issue_span_gl_quote: 'Saul',
    orig_quote: SAUL, at_provided: '', explanation: 'A name.', note_type: 'given_at',
  }, over);
}

// ---------------------------------------------------------------------------
// Success check from issue #367
// ---------------------------------------------------------------------------

test('X1: a key first noted in GEN yields one cross-book pointer at its first occurrence in EXO 3', async () => {
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY() });
  const dirPath = setupPipeDir({ chapter: '3', items: [item({ reference: '3:4' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.note_type, 'see_how');
  assert.equal(
    first.programmatic_note,
    'See how you translated this name in Genesis 10:2.',
    'prose form naming the book, not a markdown link'
  );
  assert.equal(first.see_how_target, 'GEN 10:2');
  assert.equal(first.see_how_cross_book, true);
  assert.equal(first.support_reference, 'translate-names');
  assert.match(summary, /1 cross-book/);
  clearCrossBookCache();
});

test('X2: no cross-book pointer at EXO 5, where the phrase already occurred in EXO 3', async () => {
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY() });
  const dirPath = setupPipeDir({ chapter: '5', items: [item({ reference: '5:2' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.see_how_cross_book, undefined, 'EXO 3 was the book-first occurrence');
  assert.ok(!/Genesis/.test(first.programmatic_note || ''));
  assert.match(summary, /0 cross-book/);
  clearCrossBookCache();
});

test('X3: the pointer anchors on the chapter\'s FIRST occurrence, and later ones fold into its list', async () => {
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY() });
  // Only 3:9 is flagged, but 3:4 is the book-first occurrence, so the pointer
  // is injected there and 3:9 folds into its "also occurs" list.
  const dirPath = setupPipeDir({ chapter: '3', items: [item({ reference: '3:9', id: 'bbbb' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const items = readPrepared(dirPath).items;
  const pointer = items.find((it) => it.see_how_cross_book);
  assert.ok(pointer, 'a cross-book pointer was emitted');
  assert.equal(pointer.reference, '3:4', 'anchored on the book-first occurrence, not the flagged verse');
  // The injected row has no gl_quote of its own, but translate-names still
  // names the subject rather than falling back to "the similar expression".
  assert.equal(pointer.programmatic_note, 'See how you translated this name in Genesis 10:2.');
  assert.deepEqual(pointer.also_occurs_verses, ['9']);
  clearCrossBookCache();
});

test('X4: the frequency filter drops a phrase occurring in more than N books', async () => {
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY({ bookCount: 9 }) });
  const dirPath = setupPipeDir({ chapter: '3', items: [item({ reference: '3:4' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  assert.equal(readPrepared(dirPath).items[0].see_how_cross_book, undefined);
  assert.match(summary, /0 cross-book/);
  clearCrossBookCache();
});

test('X5: an ineligible sref earns no cross-book pointer even at the book-first occurrence', async () => {
  // figs-metaphor is not a consistency-bearing article, so a single-word key
  // under it is not pointer-eligible.
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY({ first: { ...GEN_ENTRY().first, sref: 'figs-metaphor' } }) });
  const dirPath = setupPipeDir({ chapter: '3', items: [item({ reference: '3:4', sref: 'figs-metaphor' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  assert.equal(readPrepared(dirPath).items[0].see_how_cross_book, undefined);
  assert.match(summary, /0 cross-book/);
  clearCrossBookCache();
});

test('X6: a same-book target always wins over a cross-book one', async () => {
  crossBookCache({ [SAUL_KEY]: GEN_ENTRY() });
  const dirPath = setupPipeDir({
    chapter: '5',
    items: [item({ reference: '5:2' })],
    tnBookTsv: [
      'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
      `3:4\tabcd\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul** means "asked for".`,
      '',
    ].join('\n'),
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.see_how_cross_book, undefined);
  assert.equal(first.programmatic_note, 'See how you translated **Saul** in [3:4](../03/04.md).',
    'the same-book markdown link, not the Genesis prose pointer');
  clearCrossBookCache();
});

test('X7: with no cross-book cache, behaviour is exactly the pre-existing same-book behaviour', async () => {
  clearCrossBookCache();
  const dirPath = setupPipeDir({ chapter: '3', items: [item({ reference: '3:4' })] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  assert.equal(readPrepared(dirPath).items[0].see_how_cross_book, undefined);
  assert.match(summary, /0 cross-book/);
});

// ---------------------------------------------------------------------------
// buildCrossBookIndex
// ---------------------------------------------------------------------------

const tsv = (rows) => ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote', ...rows, ''].join('\n');
const genUsfm = ['\\id GEN', '\\c 10', '\\p', '\\v 2 ' + saulSpan(), ''].join('\n');
const exoUsfm = ALIGNED_EXO;

test('X8: the corpus index records the first explanatory note under both key forms', () => {
  const index = buildCrossBookIndex({
    bookCodes: ['GEN', 'EXO'],
    readBook: (code) => (code === 'GEN'
      ? { ultUsfm: genUsfm, tnTsv: tsv([`10:2\tgen1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul**.`]) }
      : { ultUsfm: exoUsfm, tnTsv: tsv([`3:4\texo1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul** again.`]) }),
  });

  const entry = index.byKey[SAUL_KEY];
  assert.ok(entry, 'filed under the Strong key');
  assert.equal(entry.first.book, 'GEN', 'canonical order decides which note is first');
  assert.equal(entry.first.ref, '10:2');
  assert.equal(entry.first.sref, 'translate-names');
  assert.equal(entry.bookCount, 2, 'source text occurs in both books');
  // Also reachable by the consonantal text key.
  const textKey = Object.keys(index.byKey).find((k) => k !== SAUL_KEY);
  assert.ok(textKey, 'filed under the text key too');
  assert.equal(index.byKey[textKey].first.book, 'GEN');
});

test('X9: a row that is itself a pointer is never a target', () => {
  const index = buildCrossBookIndex({
    bookCodes: ['GEN', 'EXO'],
    readBook: (code) => (code === 'GEN'
      ? { ultUsfm: genUsfm, tnTsv: tsv([`10:2\tgen1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tSee how you translated this name in Exodus 3:4.`]) }
      : { ultUsfm: exoUsfm, tnTsv: tsv([`3:4\texo1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul**.`]) }),
  });
  assert.equal(index.byKey[SAUL_KEY].first.book, 'EXO', 'GEN 10:2 is a pointer, so EXO 3:4 is the target');
});

test('X10: a phrase with no explanatory note anywhere is absent from the index', () => {
  const index = buildCrossBookIndex({
    bookCodes: ['GEN'],
    readBook: () => ({ ultUsfm: genUsfm, tnTsv: tsv([]) }),
  });
  assert.equal(Object.keys(index.byKey).length, 0);
});

// ---------------------------------------------------------------------------
// Quality check 26b, cross-book arm
// ---------------------------------------------------------------------------

const { _crossBookTargetsIn: crossBookTargetsIn } = require('../src/workspace-tools/quality-tools');

test('X11: cross-book targets are recognised in prose and in the rarer markdown form', () => {
  assert.deepEqual(
    crossBookTargetsIn('See how you translated this name in Isaiah 36:3.')
      .map((t) => `${t.code} ${t.chapter}:${t.verse}`),
    ['ISA 36:3']
  );
  // A multi-word book name must not be shadowed by a shorter one.
  assert.deepEqual(
    crossBookTargetsIn('See how you translated this phrase in Song of Songs 2:1.')
      .map((t) => t.code),
    ['SNG']
  );
  assert.deepEqual(
    crossBookTargetsIn('See how you translated this in [36:3](../../isa/36/03.md).')
      .map((t) => `${t.code} ${t.chapter}:${t.verse}`),
    ['ISA 36:3']
  );
  // A same-book pointer is not a cross-book target.
  assert.deepEqual(crossBookTargetsIn('See how you translated this in [3:5](../03/05.md).'), []);
  // Prose that merely mentions a book without a verse ref is not a target.
  assert.deepEqual(crossBookTargetsIn('This expression also appears in Isaiah.'), []);
});

// ---------------------------------------------------------------------------
// The cached corpus builder, over real directory layouts
// ---------------------------------------------------------------------------

const { buildCrossBookSeeHowIndex } = require('../src/workspace-tools/index-tools');

test('X12: the cache builder reads NN-CODE.usfm and tn_CODE.tsv and files the GEN note', async () => {
  // The two published directories genuinely disagree on naming: published_ult
  // is NN-CODE.usfm, published-tns is tn_CODE.tsv. Pin both.
  const ultDir = path.join(WORKSPACE, 'data', 'published_ult');
  const tnDir = path.join(WORKSPACE, 'data', 'published-tns');
  fs.mkdirSync(ultDir, { recursive: true });
  fs.mkdirSync(tnDir, { recursive: true });
  fs.writeFileSync(path.join(ultDir, '01-GEN.usfm'), genUsfm);
  fs.writeFileSync(path.join(ultDir, '02-EXO.usfm'), exoUsfm);
  // A leading "# Fetched:" comment is present on fetched TN files.
  fs.writeFileSync(path.join(tnDir, 'tn_GEN.tsv'),
    '# Fetched: 2026-01-01\n' + tsv([`10:2\tgen1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul**.`]));
  fs.writeFileSync(path.join(tnDir, 'tn_EXO.tsv'), tsv([]));

  const msg = await buildCrossBookSeeHowIndex({ force: true });
  assert.match(msg, /Built cross-book see-how index/, msg);

  const cached = JSON.parse(fs.readFileSync(
    path.join(WORKSPACE, 'data', 'cache', 'crossbook_seehow_index.json'), 'utf8'));
  assert.equal(cached.byKey[SAUL_KEY].first.book, 'GEN');
  assert.equal(cached.byKey[SAUL_KEY].first.ref, '10:2');
  assert.equal(cached.byKey[SAUL_KEY].bookCount, 2, 'source text found in both published books');
  assert.equal(cached._meta.books, 2);

  fs.rmSync(ultDir, { recursive: true, force: true });
  fs.rmSync(tnDir, { recursive: true, force: true });
  clearCrossBookCache();
});

test('X13: quality check 26b resolves a cross-book target against data/published-tns/', async () => {
  const { checkTnQuality } = require('../src/workspace-tools/quality-tools');
  const tnDir = path.join(WORKSPACE, 'data', 'published-tns');
  fs.mkdirSync(tnDir, { recursive: true });
  fs.writeFileSync(path.join(tnDir, 'tn_GEN.tsv'), tsv([
    `10:2\tgen1\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tThe name **Saul**.`,
  ]));

  const dirPath = `tmp/quality-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });
  const write = (name, body) => {
    fs.writeFileSync(path.join(abs, name), body);
    return `${dirPath}/${name}`;
  };
  const tsvRel = write('tn.tsv', [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Present in published GEN -> no finding.
    `3:4\taaaa\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tSee how you translated this name in Genesis 10:2.`,
    // Absent from published GEN -> seehow_target_missing.
    `3:9\tbbbb\t\trc://*/ta/man/translate/translate-names\t${SAUL}\t1\tSee how you translated this name in Genesis 49:31.`,
    '',
  ].join('\n'));

  const outRel = write('findings.json', '{}');
  await checkTnQuality({
    tsvPath: tsvRel,
    ultUsfm: write('ult.usfm', ALIGNED_EXO),
    book: 'EXO',
    output: outRel,
  });
  // checkTnQuality returns a summary line; the findings land in the output file.
  const report = JSON.parse(fs.readFileSync(path.join(WORKSPACE, outRel), 'utf8'));
  const all = report.findings || report;
  const missing = all.filter((f) => f.category === 'seehow_target_missing');

  assert.equal(missing.length, 1, `exactly one missing target: ${JSON.stringify(all)}`);
  assert.match(missing[0].message, /Genesis 49:31/);
  assert.equal(missing[0].id, 'bbbb');
  assert.ok(
    !all.some((f) => /Genesis 10:2/.test(f.message || '')),
    `Genesis 10:2 exists and must not be flagged: ${JSON.stringify(all)}`
  );

  fs.rmSync(tnDir, { recursive: true, force: true });
});
