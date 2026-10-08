const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CSKILLBP_DIR is captured when pipeline-utils loads, so it must be set before
// notes-pipeline is required.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'common-phrases-'));
process.env.CSKILLBP_DIR = WORKSPACE;
process.env.DOOR43_REPOS_PATH = path.join(WORKSPACE, 'door43-repos');

const {
  _runSeeHowDetection: runSeeHowDetection,
  _buildRecurrenceIndexFile: buildRecurrenceIndexFile,
} = require('../src/notes-pipeline');
const {
  loadCommonPhrases,
  normalizeCommonPhraseEntries,
  buildIntroPointerSentence,
  phraseTextKey,
  COMMON_PHRASES_REL,
} = require('../src/workspace-tools/common-phrases');

// "declaration of Yahweh"
const NEUM = 'נְאֻ֣ם יְהוָ֑ה';
// An unlisted phrase: "the word of Yahweh"
const WORD = 'דְּבַר־יְהוָ֖ה';

function alignedWord(strong, content, words) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="l" x-occurrence="1" x-content="${content}"\\*` +
    words.map((w) => `\\w ${w}|x-occurrence="1"\\w*`).join(' ') +
    '\\zaln-e\\*';
}
const neumSpan = () => `${alignedWord('H5002', 'נְאֻ֣ם', ['declaration'])} ${alignedWord('H3068', 'יְהוָ֑ה', ['of', 'Yahweh'])}`;
const wordSpan = () => `${alignedWord('H1697', 'דְּבַר', ['the', 'word'])} ${alignedWord('H3068', 'יְהוָ֖ה', ['of', 'Yahweh'])}`;

const ALIGNED_BOOK = [
  '\\id JER',
  '\\c 1',
  '\\p',
  `\\v 1 ${neumSpan()} ${wordSpan()}`,
  '\\c 3',
  '\\p',
  `\\v 2 ${neumSpan()}`,
  `\\v 5 ${neumSpan()} ${wordSpan()}`,
  `\\v 7 ${neumSpan()} ${wordSpan()}`,
  '',
].join('\n');

const uhbNeum = '\\w נְאֻ֣ם|lemma="נְאֻם" strong="H5002"\\w* \\w יְהוָ֑ה|lemma="יְהֹוָה" strong="H3068"\\w*';
const uhbWord = '\\w דְּבַר|lemma="דָּבָר" strong="H1697"\\w*־\\w יְהוָ֖ה|lemma="יְהֹוָה" strong="H3068"\\w*';
const HEBREW_BOOK = [
  '\\id JER',
  '\\c 1',
  `\\v 1 ${uhbNeum} ${uhbWord}`,
  '\\c 3',
  `\\v 2 ${uhbNeum}`,
  `\\v 5 ${uhbNeum} ${uhbWord}`,
  `\\v 7 ${uhbNeum} ${uhbWord}`,
  '',
].join('\n');

// Both phrases are already explained at 1:1, so without the list rule 2 would
// point back to 1:1 and fold the rest into an "also occurs" list.
const TN_BOOK_TSV = [
  'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
  `1:1\tabcd\t\trc://*/ta/man/translate/writing-quotations\t${NEUM}\t1\tThe phrase **declaration of Yahweh** marks what Yahweh said.`,
  `1:1\tefgh\t\trc://*/ta/man/translate/figs-possession\t${WORD}\t1\tThe possessive form **the word of Yahweh** describes a message from Yahweh.`,
  '',
].join('\n');

const neumAlign = [{ heb: 'נְאֻ֣ם', strong: 'H5002' }, { heb: 'יְהוָ֑ה', strong: 'H3068' }];
const wordAlign = [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }];
const ALIGNMENT_DATA = {
  '3:2': neumAlign,
  '3:5': [...neumAlign, ...wordAlign],
  '3:7': [...neumAlign, ...wordAlign],
};

const JER_LIST = {
  _comment: 'test fixture',
  JER: [{ phrase: 'נְאֻם יְהוָה', gloss: 'declaration of Yahweh', sref: 'writing-quotations', scope: 'book' }],
};

let dirCounter = 0;

function writeList(list) {
  const abs = path.join(WORKSPACE, COMMON_PHRASES_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (list) fs.writeFileSync(abs, JSON.stringify(list));
  else if (fs.existsSync(abs)) fs.unlinkSync(abs);
}

function setupPipeDir({ items = [], verseStart = null, verseEnd = null, list = JER_LIST } = {}) {
  writeList(list);
  const dirPath = `tmp/pipeline/JER-03-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'ult.usfm'), ALIGNED_BOOK);
  fs.writeFileSync(path.join(abs, 'hebrew.usfm'), HEBREW_BOOK);
  fs.writeFileSync(path.join(abs, 'prepared_notes.json'), JSON.stringify({
    book: 'JER', chapter: '3', item_count: items.length, items,
  }, null, 2));
  fs.writeFileSync(path.join(abs, 'alignment_data.json'), JSON.stringify(ALIGNMENT_DATA));
  fs.writeFileSync(path.join(abs, 'generated_notes.json'), '{}');

  const clone = path.join(WORKSPACE, 'door43-repos', 'en_tn');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'tn_JER.tsv'), TN_BOOK_TSV);

  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({
    version: 1,
    pipeline: 'notes',
    book: 'JER',
    chapter: 3,
    verseStart,
    verseEnd,
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

const isNeum = (it) => phraseTextKey(it.orig_quote) === phraseTextKey(NEUM);
const readPrepared = (dirPath) => JSON.parse(fs.readFileSync(path.join(WORKSPACE, dirPath, 'prepared_notes.json'), 'utf8'));
const stubIds = ({ count }) => Array.from({ length: count }, (_, i) => `z${String(i).padStart(3, '0')}`).join('\n');

function neumItem(overrides) {
  return Object.assign({
    index: 0,
    reference: '3:2',
    id: 'aaaa',
    sref: 'writing-quotations',
    gl_quote: 'declaration of Yahweh',
    issue_span_gl_quote: 'declaration of Yahweh',
    orig_quote: NEUM,
    at_provided: '',
    explanation: 'Marks a quotation.',
    note_type: 'given_at',
  }, overrides);
}

function wordItem(overrides) {
  return Object.assign(neumItem({
    sref: 'figs-possession',
    gl_quote: 'the word of Yahweh',
    issue_span_gl_quote: 'the word of Yahweh',
    orig_quote: WORD,
  }), overrides);
}

async function run(dirPath) {
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  return runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });
}

test('listed phrase: one note per chapter at the first occurrence, pointing to the book intro; the rest dropped', async () => {
  const dirPath = setupPipeDir({
    items: [
      neumItem({ reference: '3:2', id: 'aaaa' }),
      // A different SupportReference on the same phrase is still dropped.
      neumItem({ reference: '3:5', id: 'bbbb', index: 1, sref: 'figs-metonymy' }),
      neumItem({ reference: '3:7', id: 'cccc', index: 2 }),
    ],
  });
  const summary = await run(dirPath);

  const prepared = readPrepared(dirPath);
  const neum = prepared.items.filter(isNeum);
  assert.deepEqual(neum.map((it) => it.id), ['aaaa']);
  const note = neum[0];
  assert.equal(note.programmatic_note, 'See the discussion of **declaration of Yahweh** in the Introduction to Jeremiah.');
  assert.equal(note.note_type, 'see_how');
  assert.equal(note.support_reference, 'writing-quotations', 'the tA link goes on the first-occurrence note');
  assert.equal(note.also_occurs_verses, undefined, 'no "also occurs" list for an intro-explained phrase');
  assert.equal(prepared.item_count, prepared.items.length);
  assert.match(summary, /1 common-phrase intro pointers \(2 dropped\)/);
});

test('listed phrase: an unflagged first occurrence gets a synthesized intro pointer and flagged later ones are dropped', async () => {
  const dirPath = setupPipeDir({
    items: [
      neumItem({ reference: '3:5', id: 'bbbb', index: 0 }),
      neumItem({ reference: '3:7', id: 'cccc', index: 1 }),
    ],
  });
  await run(dirPath);

  const neum = readPrepared(dirPath).items.filter(isNeum);
  assert.equal(neum.length, 1);
  const injected = neum[0];
  assert.equal(injected.reference, '3:2');
  assert.equal(injected.injected_see_how, true);
  assert.equal(injected.support_reference, 'writing-quotations');
  assert.equal(injected.programmatic_note, 'See the discussion of this expression in the Introduction to Jeremiah.');
  assert.equal(injected.orig_quote, 'נְאֻ֣ם יְהוָ֑ה');
});

test('if no id can be generated for the synthesized pointer, the earliest flagged row carries it', async () => {
  const dirPath = setupPipeDir({
    items: [
      neumItem({ reference: '3:5', id: 'bbbb', index: 0 }),
      neumItem({ reference: '3:7', id: 'cccc', index: 1 }),
    ],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: async () => { throw new Error('offline'); } });
  const neum = readPrepared(dirPath).items.filter(isNeum);
  assert.deepEqual(neum.map((it) => it.id), ['bbbb']);
  assert.match(neum[0].programmatic_note, /Introduction to Jeremiah/);
});

test('listed phrase with nothing flagged in the chapter still gets its one intro pointer', async () => {
  const dirPath = setupPipeDir({ items: [] });
  await run(dirPath);
  const neum = readPrepared(dirPath).items.filter(isNeum);
  assert.equal(neum.length, 1, 'exactly one note for the listed phrase');
  assert.equal(neum[0].reference, '3:2');
  assert.match(neum[0].programmatic_note, /Introduction to Jeremiah/);
});

test('unlisted phrases keep the existing see-how behaviour', async () => {
  const dirPath = setupPipeDir({
    items: [
      wordItem({ reference: '3:5', id: 'dddd', index: 0 }),
      wordItem({ reference: '3:7', id: 'eeee', index: 1 }),
    ],
  });
  await run(dirPath);
  const word = readPrepared(dirPath).items.find((it) => it.id === 'dddd');
  assert.equal(word.programmatic_note, 'See how you translated **the word of Yahweh** in [1:1](../01/01.md).');
  assert.deepEqual(word.also_occurs_verses, ['7']);
});

test('no list file, or a disabled entry, means no change', async () => {
  for (const list of [null, { JER: [{ ...JER_LIST.JER[0], enabled: false }] }]) {
    const dirPath = setupPipeDir({
      list,
      items: [neumItem({ reference: '3:2', id: 'aaaa' }), neumItem({ reference: '3:5', id: 'bbbb', index: 1 })],
    });
    const summary = await run(dirPath);
    const first = readPrepared(dirPath).items[0];
    assert.equal(first.programmatic_note, 'See how you translated **declaration of Yahweh** in [1:1](../01/01.md).');
    assert.doesNotMatch(summary, /common-phrase/);
  }
});

test('a partial run that does not hold the chapter\'s first occurrence writes nothing for the phrase', async () => {
  const dirPath = setupPipeDir({
    verseStart: 4,
    verseEnd: 8,
    items: [
      neumItem({ reference: '3:5', id: 'bbbb', index: 0 }),
      neumItem({ reference: '3:7', id: 'cccc', index: 1 }),
    ],
  });
  await run(dirPath);
  assert.equal(readPrepared(dirPath).items.filter(isNeum).length, 0);
});

test('an editor-kept note on the phrase in this chapter covers it: AI rows dropped, nothing injected', async () => {
  const dirPath = setupPipeDir({
    items: [neumItem({ reference: '3:2', id: 'aaaa' }), neumItem({ reference: '3:5', id: 'bbbb', index: 1 })],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({
    pipeDir: dirPath,
    generateIdsFn: stubIds,
    kept: [{ ref: '3:2', quote: NEUM, id: 'kept' }],
  });
  assert.equal(readPrepared(dirPath).items.filter(isNeum).length, 0);
});

test('chapter-scoped entry points to the chapter intro, and only in its chapters', async () => {
  const chapterList = (chapters) => ({ JER: [{ phrase: 'נְאֻם יְהוָה', sref: 'writing-quotations', scope: 'chapter', chapters }] });

  let dirPath = setupPipeDir({ list: chapterList([3]), items: [neumItem({}), neumItem({ reference: '3:5', id: 'bbbb', index: 1 })] });
  await run(dirPath);
  let neum = readPrepared(dirPath).items.filter(isNeum);
  assert.deepEqual(neum.map((it) => it.id), ['aaaa']);
  assert.equal(neum[0].programmatic_note, 'See the discussion of **declaration of Yahweh** in the Introduction to this chapter.');

  dirPath = setupPipeDir({ list: chapterList([4]), items: [neumItem({}), neumItem({ reference: '3:5', id: 'bbbb', index: 1 })] });
  await run(dirPath);
  neum = readPrepared(dirPath).items.filter(isNeum);
  assert.match(neum[0].programmatic_note, /^See how you translated/, 'ordinary see-how outside the listed chapters');
});

test('a longer quote that merely contains the listed phrase is not matched', async () => {
  const longer = `${NEUM} צְבָאוֹת`;
  const dirPath = setupPipeDir({
    items: [neumItem({ reference: '3:5', id: 'ffff', orig_quote: longer, sref: 'figs-explicit' })],
  });
  await run(dirPath);
  const kept = readPrepared(dirPath).items.find((it) => it.id === 'ffff');
  assert.ok(kept, 'the longer-span row survives');
  assert.equal(kept.common_phrase, undefined);
});

test('normalizeCommonPhraseEntries / loadCommonPhrases', () => {
  const entries = normalizeCommonPhraseEntries([
    { phrase: 'בֶּן־אָדָם', sref: 'rc://*/ta/man/translate/figs-idiom' },
    { phrase: 'וִידַעְתֶּם כִּי אֲנִי יְהוָה', enabled: false },
    { phrase: 'כֹּה אָמַר יְהוָה', scope: 'chapter' },
    { gloss: 'no phrase' },
  ], { chapter: 2 });
  assert.equal(entries.length, 1, 'disabled, chapter-scoped without chapters, and phrase-less entries are dropped');
  assert.deepEqual(entries[0].keys, ['בן+אדם']);
  assert.equal(entries[0].sref, 'figs-idiom');
  assert.equal(entries[0].scope, 'book');

  writeList(null);
  assert.deepEqual(loadCommonPhrases('JER', { baseDir: WORKSPACE }), []);
  fs.writeFileSync(path.join(WORKSPACE, COMMON_PHRASES_REL), '{ not json');
  assert.deepEqual(loadCommonPhrases('JER', { baseDir: WORKSPACE }), [], 'a broken file never throws');
  writeList(null);

  assert.equal(buildIntroPointerSentence({ book: 'EZK', glQuote: 'Son of man' }), 'See the discussion of **Son of man** in the Introduction to Ezekiel.');
});
