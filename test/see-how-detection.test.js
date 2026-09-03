const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CSKILLBP_DIR is captured when pipeline-utils loads, so it must be set before
// notes-pipeline is required.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'see-how-'));
process.env.CSKILLBP_DIR = WORKSPACE;
process.env.DOOR43_REPOS_PATH = path.join(WORKSPACE, 'door43-repos');

const {
  _runSeeHowDetection: runSeeHowDetection,
  _buildRecurrenceIndexFile: buildRecurrenceIndexFile,
  _SEE_HOW_ZERO_SUMMARY: SEE_HOW_ZERO_SUMMARY,
} = require('../src/notes-pipeline');
const { assembleNotes } = require('../src/workspace-tools/tn-tools');

const WORD_OF_YAHWEH = 'דְּבַר־יְהוָ֖ה';

function alignedWord(strong, content, words) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="l" x-occurrence="1" x-content="${content}"\\*` +
    words.map((w) => `\\w ${w}|x-occurrence="1"\\w*`).join(' ') +
    '\\zaln-e\\*';
}

function wordOfYahwehSpan() {
  return `${alignedWord('H1697', 'דְּבַר', ['the', 'word'])} ${alignedWord('H3068', 'יְהוָ֖ה', ['of', 'Yahweh'])}`;
}

const ALIGNED_BOOK = [
  '\\id ZEC',
  '\\c 1',
  '\\p',
  `\\v 1 ${wordOfYahwehSpan()}`,
  '\\c 2',
  '\\p',
  `\\v 4 ${wordOfYahwehSpan()}`,
  '\\c 3',
  '\\p',
  `\\v 2 ${wordOfYahwehSpan()}`,
  `\\v 5 ${wordOfYahwehSpan()}`,
  `\\v 7 ${wordOfYahwehSpan()}`,
  `\\v 8 ${alignedWord('H3027', 'יָ֣ד', ['hand'])}`,
  `\\v 9 ${alignedWord('H4325', 'מַ֫יִם', ['water'])}`,
  `\\v 12 ${alignedWord('H3027', 'יָ֣ד', ['hand'])}`,
  '',
].join('\n');

// UHB fixture: the only source carrying the literal maqaf between the two words.
const HEBREW_BOOK = [
  '\\id ZEC',
  '\\c 3',
  '\\v 2 \\w דְּבַר|lemma="דָּבָר" strong="H1697"\\w*־\\w יְהוָ֖ה|lemma="יְהֹוָה" strong="H3068"\\w*',
  '\\v 5 \\w דְּבַר|lemma="דָּבָר" strong="H1697"\\w*־\\w יְהוָ֖ה|lemma="יְהֹוָה" strong="H3068"\\w*',
  '\\v 7 \\w דְּבַר|lemma="דָּבָר" strong="H1697"\\w*־\\w יְהוָ֖ה|lemma="יְהֹוָה" strong="H3068"\\w*',
  '',
].join('\n');

const TN_BOOK_TSV = [
  'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
  'front:intro\tyx6e\t\t\t\t0\t# Introduction',
  `1:1\tabcd\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tThe possessive form **the word of Yahweh** describes a message from Yahweh.`,
  `2:4\tefgh\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tSee how you translated the similar expression in [1:1](../01/01.md).`,
  '',
].join('\n');

const ALIGNMENT_DATA = {
  '3:2': [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }],
  '3:5': [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }],
  '3:7': [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }],
};

let dirCounter = 0;

/**
 * Lay out a pipeline directory in the fake workspace and return its relative path.
 */
function setupPipeDir({
  book = 'ZEC',
  chapter = '3',
  items = [],
  tnBookTsv = TN_BOOK_TSV,
  alignedBook = ALIGNED_BOOK,
  alignmentData = ALIGNMENT_DATA,
  hebrewBook = '',
  verseStart = null,
  verseEnd = null,
  preparedName = 'prepared_notes.json',
} = {}) {
  const dirPath = `tmp/pipeline/${book}-${String(chapter).padStart(2, '0')}-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });

  fs.writeFileSync(path.join(abs, 'ult.usfm'), alignedBook);
  if (hebrewBook) fs.writeFileSync(path.join(abs, 'hebrew.usfm'), hebrewBook);
  fs.writeFileSync(path.join(abs, preparedName), JSON.stringify({
    book, chapter, item_count: items.length, items,
  }, null, 2));
  fs.writeFileSync(path.join(abs, 'alignment_data.json'), JSON.stringify(alignmentData));
  fs.writeFileSync(path.join(abs, 'generated_notes.json'), '{}');

  const clone = path.join(WORKSPACE, 'door43-repos', 'en_tn');
  fs.mkdirSync(clone, { recursive: true });
  const tnPath = path.join(clone, `tn_${book}.tsv`);
  if (tnBookTsv) fs.writeFileSync(tnPath, tnBookTsv);
  else if (fs.existsSync(tnPath)) fs.unlinkSync(tnPath);

  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({
    version: 1,
    pipeline: 'notes',
    book,
    chapter: Number(chapter),
    verseStart,
    verseEnd,
    sources: {
      ultFull: `${dirPath}/ult.usfm`,
      hebrew: hebrewBook ? `${dirPath}/hebrew.usfm` : null,
    },
    runtime: {
      preparedNotes: `${dirPath}/${preparedName}`,
      generatedNotes: `${dirPath}/generated_notes.json`,
      alignmentData: `${dirPath}/alignment_data.json`,
      recurrenceIndex: `${dirPath}/recurrence_index.json`,
      tnQualityFindings: `${dirPath}/tn_quality_findings.json`,
    },
    artifacts: {},
  }, null, 2));

  return dirPath;
}

function readPrepared(dirPath, preparedName = 'prepared_notes.json') {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE, dirPath, preparedName), 'utf8'));
}

const stubIds = ({ count }) => Array.from({ length: count }, (_, i) => `z${String(i).padStart(3, '0')}`).join('\n');

function item(overrides) {
  return Object.assign({
    index: 0,
    reference: '3:2',
    id: 'aaaa',
    sref: 'figs-possession',
    gl_quote: 'the word of Yahweh',
    issue_span_gl_quote: 'the word of Yahweh',
    orig_quote: WORD_OF_YAHWEH,
    at_provided: '',
    explanation: 'The possessive describes a message.',
    note_type: 'given_at',
  }, overrides);
}

test('rule 1: later same-chapter items fold into the first item\'s also-occurs list', async () => {
  const dirPath = setupPipeDir({
    items: [
      item({ reference: '3:2', id: 'aaaa', index: 0 }),
      item({ reference: '3:5', id: 'bbbb', index: 1 }),
      item({ reference: '3:7', id: 'cccc', index: 2 }),
    ],
    tnBookTsv: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa'], 'later occurrences are removed');
  assert.deepEqual(prepared.items[0].also_occurs_verses, ['5', '7']);
  assert.equal(prepared.item_count, 1);
  assert.match(summary, /2 folded/);
});

test('rule 2: the chapter\'s first occurrence points at the FIRST noted occurrence in the book, not the nearest', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' }), item({ reference: '3:5', id: 'bbbb', index: 1 })],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.note_type, 'see_how');
  assert.equal(
    first.programmatic_note,
    'See how you translated **the word of Yahweh** in [1:1](../01/01.md).',
    'target is 1:1 (book-first noted), not 2:4 (nearest)'
  );
  assert.equal(first.tags, '');
  assert.equal(first.support_reference, 'figs-possession', 'SupportReference inherited from the target row');
  assert.deepEqual(first.also_occurs_verses, ['5', '7']);
});

test('no pointer is emitted when no earlier chapter has a note for the key', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' })],
    tnBookTsv: [
      'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
      '1:1\tabcd\t\trc://*/ta/man/translate/figs-metaphor\tמַ֫יִם\t1\tSomething else entirely.',
      '',
    ].join('\n'),
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.programmatic_note, undefined);
  assert.equal(first.note_type, 'given_at');
  assert.match(summary, /^0 see-how back-refs/);
});

test('pointers never run forward: a note only in a later chapter is not a target', async () => {
  const dirPath = setupPipeDir({
    chapter: '1',
    items: [item({ reference: '1:1', id: 'aaaa' })],
    alignmentData: { '1:1': ALIGNMENT_DATA['3:2'] },
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.programmatic_note, undefined, 'chapter 1 has nothing earlier to point at');
});

test('phase 3: a pointer is injected when the chapter flagged nothing for an already-noted phrase', async () => {
  const dirPath = setupPipeDir({ items: [] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 1, 'exactly one injected item per key per chapter');
  const injected = prepared.items[0];
  assert.equal(injected.reference, '3:2', 'injected on the chapter\'s first occurrence');
  assert.equal(injected.note_type, 'see_how');
  assert.equal(injected.injected_see_how, true);
  assert.equal(injected.at_policy, 'not_needed');
  assert.equal(injected.id, 'z000');
  assert.match(injected.programmatic_note, /\[1:1\]\(\.\.\/01\/01\.md\)/);
  assert.deepEqual(injected.also_occurs_verses, ['5', '7']);
  assert.match(summary, /1 injected/);
});

test('at_provided is appended to the pointer note', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa', at_provided: 'the message from Yahweh' })],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.match(first.programmatic_note, /Alternate translation: \[the message from Yahweh\]$/);
});

test('fromHint items are left alone', async () => {
  const dirPath = setupPipeDir({
    items: [
      item({ reference: '3:2', id: 'aaaa', fromHint: true, programmatic_note: 'Seed prose.' }),
      item({ reference: '3:5', id: 'bbbb', index: 1, fromHint: true, programmatic_note: 'Other seed prose.' }),
    ],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 2, 'hint-driven items are neither folded nor duplicated by injection');
  assert.equal(prepared.items[0].programmatic_note, 'Seed prose.');
  assert.match(summary, /0 injected/);
});

test('same-verse duplicates keep the _combine_with behaviour', async () => {
  const dirPath = setupPipeDir({
    items: [
      item({ reference: '3:2', id: 'aaaa' }),
      item({ reference: '3:2', id: 'bbbb', index: 1 }),
    ],
    tnBookTsv: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 2, 'same-verse duplicates are combined, not removed');
  assert.equal(prepared.items[1]._combine_with, 'aaaa');
  assert.match(summary, /1 same-verse combinations/);
});

test('a missing TN clone and a missing aligned book degrade gracefully; folding still works', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' }), item({ reference: '3:5', id: 'bbbb', index: 1 })],
    tnBookTsv: '',
    alignedBook: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 1);
  assert.deepEqual(prepared.items[0].also_occurs_verses, ['5']);
  assert.match(summary, /0 see-how back-refs/);
});

test('detection is a no-op on an empty chapter with no index', async () => {
  const dirPath = setupPipeDir({ items: [], tnBookTsv: '', alignedBook: '' });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });
  assert.equal(summary, SEE_HOW_ZERO_SUMMARY);
});

test('PSA pointers pad chapter and verse to three digits', async () => {
  const psaAligned = [
    '\\id PSA', '\\c 78', '\\p', `\\v 1 ${wordOfYahwehSpan()}`,
    '\\c 79', '\\p', `\\v 3 ${wordOfYahwehSpan()}`, '',
  ].join('\n');
  const psaTsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    `78:1\tabcd\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tExplanatory note.`,
    '',
  ].join('\n');
  const dirPath = setupPipeDir({
    book: 'PSA',
    chapter: '79',
    items: [item({ reference: '79:3', id: 'aaaa' })],
    tnBookTsv: psaTsv,
    alignedBook: psaAligned,
    alignmentData: { '79:3': ALIGNMENT_DATA['3:2'] },
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.match(first.programmatic_note, /\[78:1\]\(\.\.\/078\/001\.md\)/);
});

test('the also-occurs sentence lands before the Alternate translation clause at TSV assembly', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' }), item({ reference: '3:5', id: 'bbbb', index: 1 })],
    tnBookTsv: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  fs.writeFileSync(
    path.join(WORKSPACE, dirPath, 'generated_notes.json'),
    JSON.stringify({ aaaa: 'The possessive form describes a message. Alternate translation: [a message from Yahweh]' })
  );
  assembleNotes({
    preparedJson: `${dirPath}/prepared_notes.json`,
    generatedJson: `${dirPath}/generated_notes.json`,
    output: `${dirPath}/out.tsv`,
  });
  const tsv = fs.readFileSync(path.join(WORKSPACE, dirPath, 'out.tsv'), 'utf8');
  const noteCol = tsv.split('\n')[1].split('\t')[6];
  assert.equal(
    noteCol,
    'The possessive form describes a message. This also occurs in verses 5 and 7. Alternate translation: [a message from Yahweh]'
  );
});

test('shard prepared files carry note_type and also_occurs_verses through detection', async () => {
  // Parallel tn-writer shards get their own runtime paths and re-run mechanical
  // prep + detection; the see-how fields must survive into the shard file.
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' }), item({ reference: '3:5', id: 'bbbb', index: 1 })],
    preparedName: 'ZEC-03-v1-9.prepared_notes.json',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath, 'ZEC-03-v1-9.prepared_notes.json');
  assert.equal(prepared.items[0].note_type, 'see_how');
  assert.deepEqual(prepared.items[0].also_occurs_verses, ['5', '7']);
});

// --- F1: fold gating -------------------------------------------------------

const HAND = 'יָ֣ד';

function handItem(overrides) {
  return Object.assign({
    index: 0,
    reference: '3:2',
    id: 'aaaa',
    sref: 'figs-metonymy',
    gl_quote: 'hand',
    issue_span_gl_quote: 'hand',
    orig_quote: HAND,
    at_provided: '',
    explanation: 'The hand stands for power.',
    note_type: 'given_at',
  }, overrides);
}

test('F1: one single word carrying two different figurative notes is NOT folded', async () => {
  const dirPath = setupPipeDir({
    items: [
      handItem({ reference: '3:2', id: 'aaaa', sref: 'figs-metonymy' }),
      handItem({ reference: '3:8', id: 'bbbb', index: 1, sref: 'figs-metaphor' }),
    ],
    tnBookTsv: '',
    alignmentData: {},
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa', 'bbbb'], 'both notes survive');
  assert.equal(prepared.items[0].also_occurs_verses, undefined);
  assert.match(summary, /0 folded/);
});

test('F1: the same single word with the same sref still folds', async () => {
  const dirPath = setupPipeDir({
    items: [
      handItem({ reference: '3:2', id: 'aaaa' }),
      handItem({ reference: '3:8', id: 'bbbb', index: 1 }),
    ],
    tnBookTsv: '',
    alignmentData: {},
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa']);
  // F2: an ineligible key must not pull in corpus spans, so verse 12 (a literal
  // "hand" the issue finder never flagged) is absent.
  assert.deepEqual(prepared.items[0].also_occurs_verses, ['8']);
});

test('F1: a multi-word key folds across different srefs', async () => {
  const dirPath = setupPipeDir({
    items: [
      item({ reference: '3:2', id: 'aaaa', sref: 'figs-possession' }),
      item({ reference: '3:5', id: 'bbbb', index: 1, sref: 'figs-abstractnouns' }),
    ],
    tnBookTsv: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa']);
  assert.deepEqual(prepared.items[0].also_occurs_verses, ['5', '7']);
});

test('F1: writing-foreground is never folded, never pointed, never injected', async () => {
  const hinneh = 'הִנֵּ֥ה';
  const alignedBook = [
    '\\id ZEC', '\\c 1', '\\p',
    `\\v 1 ${alignedWord('H2009', hinneh, ['behold'])}`,
    '\\c 3', '\\p',
    `\\v 2 ${alignedWord('H2009', hinneh, ['behold'])}`,
    `\\v 5 ${alignedWord('H2009', hinneh, ['behold'])}`,
    `\\v 7 ${alignedWord('H2009', hinneh, ['behold'])}`,
    '',
  ].join('\n');
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    `1:1\tabcd\t\trc://*/ta/man/translate/writing-foreground\t${hinneh}\t1\tThe word **behold** draws attention to what follows.`,
    '',
  ].join('\n');
  const dirPath = setupPipeDir({
    items: [
      handItem({ reference: '3:2', id: 'aaaa', sref: 'writing-foreground', orig_quote: hinneh, gl_quote: 'behold' }),
      handItem({ reference: '3:5', id: 'bbbb', index: 1, sref: 'writing-foreground', orig_quote: hinneh, gl_quote: 'behold' }),
    ],
    tnBookTsv: tsv,
    alignedBook,
    alignmentData: {},
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa', 'bbbb'], 'every occurrence keeps its note');
  assert.equal(prepared.items[0].programmatic_note, undefined, 'never rewritten as a pointer');
  assert.equal(prepared.items[0].also_occurs_verses, undefined);
  assert.equal(summary, SEE_HOW_ZERO_SUMMARY, 'nothing folded, pointed or injected');
});

test('F1: a writing-foreground row in an earlier chapter is never a pointer target', async () => {
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    `1:1\tabcd\t\trc://*/ta/man/translate/writing-foreground\t${WORD_OF_YAHWEH}\t1\tAn earlier foregrounding note.`,
    '',
  ].join('\n');
  const dirPath = setupPipeDir({ items: [item({ reference: '3:2', id: 'aaaa' })], tnBookTsv: tsv });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  assert.equal(readPrepared(dirPath).items[0].programmatic_note, undefined);
  assert.match(summary, /^0 see-how back-refs/);
  assert.match(summary, /0 injected/);
});

// --- F2: corpus spans only for eligible keys --------------------------------

test('F2: corpus spans ARE appended for an eligible (multi-word) key', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' })],
    tnBookTsv: '',
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.deepEqual(first.also_occurs_verses, ['5', '7'], 'unflagged repeats the index found');
});

test('F2: corpus spans are NOT appended for an ineligible single-word key', async () => {
  const dirPath = setupPipeDir({
    items: [handItem({ reference: '3:2', id: 'aaaa' })],
    tnBookTsv: '',
    alignmentData: {},
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.also_occurs_verses, undefined, 'literal "hand" in 3:8 and 3:12 is not listed');
});

// --- F3: injected quotes are the exact source span --------------------------

test('F3: an injected orig_quote reproduces the maqaf-joined source span exactly', async () => {
  const dirPath = setupPipeDir({ items: [], hebrewBook: HEBREW_BOOK });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const injected = readPrepared(dirPath).items[0];
  assert.equal(injected.injected_see_how, true);
  assert.ok(injected.orig_quote.includes('־'), 'maqaf preserved');
  assert.equal(injected.orig_quote, WORD_OF_YAHWEH, 'byte-for-byte the source span');
});

test('F3: without a UHB source the injected quote falls back to a space-join', async () => {
  const dirPath = setupPipeDir({ items: [] });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const injected = readPrepared(dirPath).items[0];
  assert.equal(injected.orig_quote.includes('־'), false);
  assert.match(injected.orig_quote, / /);
});

// --- C1: anchor on the chapter's first occurrence ---------------------------

test('C1a: a cross-chapter pointer is injected at the chapter\'s first occurrence, not the flagged verse', async () => {
  // The phrase is in 3:2, 3:5 and 3:7; the model flagged only 3:5.
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:5', id: 'bbbb' })],
    alignmentData: { '3:5': ALIGNMENT_DATA['3:5'] },
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 1, 'the flagged 3:5 item is folded away');
  const anchor = prepared.items[0];
  assert.equal(anchor.reference, '3:2', 'pointer sits on the first occurrence');
  assert.equal(anchor.injected_see_how, true);
  assert.match(anchor.programmatic_note, /\[1:1\]\(\.\.\/01\/01\.md\)/);
  assert.deepEqual(anchor.also_occurs_verses, ['5', '7']);
  assert.match(summary, /1 injected/);
  assert.match(summary, /1 folded/);
});

test('C1a: a prepared item already sitting on the first occurrence is converted in place', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:2', id: 'aaaa' }), item({ reference: '3:5', id: 'bbbb', index: 1 })],
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.deepEqual(prepared.items.map((it) => it.id), ['aaaa'], 'no injection, no relocation');
  assert.equal(prepared.items[0].note_type, 'see_how');
  assert.match(summary, /0 injected/);
});

test('C1b: a book-first explanatory note stays where the model wrote it and lists the others', async () => {
  // No earlier-chapter note, so the 3:5 item IS the explanatory note.
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:5', id: 'bbbb' })],
    tnBookTsv: '',
    alignmentData: { '3:5': ALIGNMENT_DATA['3:5'] },
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 1);
  const kept = prepared.items[0];
  assert.equal(kept.reference, '3:5', 'not relocated');
  assert.equal(kept.programmatic_note, undefined, 'still the explanatory note');
  assert.deepEqual(kept.also_occurs_verses, ['2', '7'], 'earlier AND later occurrences are listed');
  assert.match(summary, /0 injected/);
});

// --- C2: a pointer row is never a pointer target ----------------------------

test('C2: the earliest row being itself a pointer is skipped for the next explanatory row', async () => {
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    `1:1\tabcd\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tSee how you translated the similar expression in [1:1](../01/01.md).`,
    `2:4\tefgh\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tThe possessive form describes a message from Yahweh.`,
    '',
  ].join('\n');
  const dirPath = setupPipeDir({ items: [item({ reference: '3:2', id: 'aaaa' })], tnBookTsv: tsv });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.match(first.programmatic_note, /\[2:4\]\(\.\.\/02\/04\.md\)/, 'targets the explanatory row, not the pointer');
  assert.doesNotMatch(first.programmatic_note, /\[1:1\]/);
});

test('C2: when every earlier row is a pointer, nothing is emitted', async () => {
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    `1:1\tabcd\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tSee how you translated the similar expression in [1:1](../01/01.md).`,
    `2:4\tefgh\t\trc://*/ta/man/translate/figs-possession\t${WORD_OF_YAHWEH}\t1\tSee how you translated the similar expression in [1:1](../01/01.md).`,
    '',
  ].join('\n');
  const dirPath = setupPipeDir({ items: [item({ reference: '3:2', id: 'aaaa' })], tnBookTsv: tsv });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  assert.equal(readPrepared(dirPath).items[0].programmatic_note, undefined);
  assert.match(summary, /^0 see-how back-refs/);
  assert.match(summary, /0 injected/);
});

// --- C3: partial-chapter bounds ---------------------------------------------

const RANGED_BOOK = [
  '\\id ZEC',
  '\\c 1',
  '\\p',
  `\\v 1 ${wordOfYahwehSpan()}`,
  '\\c 3',
  '\\p',
  `\\v 2 ${wordOfYahwehSpan()}`,
  `\\v 11 ${wordOfYahwehSpan()}`,
  '',
].join('\n');

test('C3: a verse-range run anchors inside the range and never synthesizes outside it', async () => {
  const dirPath = setupPipeDir({
    items: [],
    alignedBook: RANGED_BOOK,
    alignmentData: {},
    verseStart: 10,
    verseEnd: 12,
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const prepared = readPrepared(dirPath);
  assert.equal(prepared.items.length, 1);
  assert.equal(prepared.items[0].reference, '3:11', 'v2 is out of range; v11 is the in-range first occurrence');
  assert.equal(prepared.items[0].also_occurs_verses, undefined);
});

test('C3: also-occurs lists never reach outside the verse range', async () => {
  const dirPath = setupPipeDir({
    items: [item({ reference: '3:11', id: 'aaaa' })],
    alignedBook: RANGED_BOOK,
    tnBookTsv: '',
    alignmentData: { '3:11': ALIGNMENT_DATA['3:2'] },
    verseStart: 10,
    verseEnd: 12,
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const first = readPrepared(dirPath).items[0];
  assert.equal(first.reference, '3:11');
  assert.equal(first.also_occurs_verses, undefined, 'the out-of-range v2 occurrence is not listed');
});

// --- C4: overlapping formula and its sub-phrases ----------------------------

// Published ZEC 8 shape: "thus says Yahweh of hosts" and its two sub-phrases
// all match the same verses, so each used to print its own near-identical
// "This also occurs in verses …" sentence.
const KOH = 'כֹּ֤ה';
const AMAR = 'אָמַר֙';
const YHWH = 'יְהוָ֣ה';
const TSEVAOT = 'צְבָא֔וֹת';

const fullFormula = () =>
  [alignedWord('H3541', KOH, ['thus']),
    alignedWord('H0559', AMAR, ['says']),
    alignedWord('H3068', YHWH, ['Yahweh']),
    alignedWord('H6635b', TSEVAOT, ['of', 'hosts'])].join(' ');
const kohAmarYhwh = () =>
  [alignedWord('H3541', KOH, ['thus']),
    alignedWord('H0559', AMAR, ['says']),
    alignedWord('H3068', YHWH, ['Yahweh'])].join(' ');
const amarYhwhTsevaot = () =>
  [alignedWord('H0559', AMAR, ['says']),
    alignedWord('H3068', YHWH, ['Yahweh']),
    alignedWord('H6635b', TSEVAOT, ['of', 'hosts'])].join(' ');

const ZEC8_BOOK = [
  '\\id ZEC',
  '\\c 8',
  '\\p',
  `\\v 2 ${fullFormula()}`,
  `\\v 3 ${kohAmarYhwh()}`,
  `\\v 4 ${fullFormula()}`,
  `\\v 6 ${fullFormula()}`,
  `\\v 14 ${amarYhwhTsevaot()}`,
  '',
].join('\n');

const ZEC8_ALIGNMENT = {
  '8:2': [
    { heb: KOH, strong: 'H3541' }, { heb: AMAR, strong: 'H0559' },
    { heb: YHWH, strong: 'H3068' }, { heb: TSEVAOT, strong: 'H6635b' },
  ],
  '8:3': [
    { heb: KOH, strong: 'H3541' }, { heb: AMAR, strong: 'H0559' },
    { heb: YHWH, strong: 'H3068' },
  ],
  '8:14': [
    { heb: AMAR, strong: 'H0559' }, { heb: YHWH, strong: 'H3068' },
    { heb: TSEVAOT, strong: 'H6635b' },
  ],
};

function formulaItem(reference, id, origQuote, glQuote) {
  return {
    index: 0,
    reference,
    id,
    sref: 'writing-quotations',
    gl_quote: glQuote,
    issue_span_gl_quote: glQuote,
    orig_quote: origQuote,
    at_provided: '',
    explanation: 'The quotation formula introduces direct speech.',
    note_type: 'given_at',
  };
}

test('C4: a formula and its sub-phrases produce ONE corpus-derived also-occurs list', async () => {
  const dirPath = setupPipeDir({
    chapter: '8',
    items: [
      formulaItem('8:2', 'aaaa', `${KOH} ${AMAR} ${YHWH} ${TSEVAOT}`, 'thus says Yahweh of hosts'),
      formulaItem('8:3', 'bbbb', `${KOH} ${AMAR} ${YHWH}`, 'thus says Yahweh'),
      formulaItem('8:14', 'cccc', `${AMAR} ${YHWH} ${TSEVAOT}`, 'says Yahweh of hosts'),
    ],
    tnBookTsv: '',
    alignedBook: ZEC8_BOOK,
    alignmentData: ZEC8_ALIGNMENT,
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const byId = new Map(readPrepared(dirPath).items.map((it) => [it.id, it]));
  assert.equal(byId.size, 3, 'distinct keys, so nothing folds');
  // Longest key wins: only 8:2 lists the other occurrences.
  assert.deepEqual(byId.get('aaaa').also_occurs_verses, ['4', '6']);
  assert.equal(byId.get('bbbb').also_occurs_verses, undefined, 'sub-phrase carries no corpus list');
  assert.equal(byId.get('cccc').also_occurs_verses, undefined, 'sub-phrase carries no corpus list');
});

test('C4: a suppressed sub-phrase still lists the verses of its own folded siblings', async () => {
  const dirPath = setupPipeDir({
    chapter: '8',
    items: [
      formulaItem('8:2', 'aaaa', `${KOH} ${AMAR} ${YHWH} ${TSEVAOT}`, 'thus says Yahweh of hosts'),
      formulaItem('8:3', 'bbbb', `${KOH} ${AMAR} ${YHWH}`, 'thus says Yahweh'),
      formulaItem('8:13', 'dddd', `${KOH} ${AMAR} ${YHWH}`, 'thus says Yahweh'),
    ],
    tnBookTsv: '',
    alignedBook: ZEC8_BOOK,
    alignmentData: Object.assign({}, ZEC8_ALIGNMENT, { '8:13': ZEC8_ALIGNMENT['8:3'] }),
  });
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });

  const byId = new Map(readPrepared(dirPath).items.map((it) => [it.id, it]));
  assert.equal(byId.has('dddd'), false, '8:13 folds into 8:3');
  assert.deepEqual(byId.get('bbbb').also_occurs_verses, ['13'], 'own folded sibling only');
  assert.deepEqual(byId.get('aaaa').also_occurs_verses, ['4', '6']);
});
