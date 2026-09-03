const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBookRecurrenceIndex,
  parseAlignedUsfmSpans,
  normalizeStrong,
  deriveRecurrenceKey,
  deriveRecurrenceKeys,
  formatTnLink,
  buildSeeHowSentence,
  formatAlsoOccurs,
  isSeeHowEligible,
  hebTokens,
  SEE_HOW_SINGLE_WORD_SREFS,
  SEE_HOW_STOPLIST,
} = require('../src/workspace-tools/recurrence-index');

// Aligned ULT fixture: "the word of Yahweh" (H1697 H3068) in 1:1, 2:4 and 2:9.
const ALIGNED = [
  '\\id ZEC',
  '\\c 1',
  '\\p',
  '\\v 1 \\zaln-s |x-strong="H1697" x-lemma="דָּבָר" x-occurrence="1" x-content="דְּבַר"\\*\\w the|x-occurrence="1"\\w* \\w word|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w of|x-occurrence="1"\\w* \\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\c 2',
  '\\p',
  '\\v 4 \\zaln-s |x-strong="H1697" x-lemma="דָּבָר" x-occurrence="1" x-content="דְּבַר"\\*\\w the|x-occurrence="1"\\w* \\w word|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w of|x-occurrence="1"\\w* \\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\v 9 \\zaln-s |x-strong="H1697" x-lemma="דָּבָר" x-occurrence="1" x-content="דְּבַר"\\*\\w the|x-occurrence="1"\\w* \\w word|x-occurrence="1"\\w*\\zaln-e\\*',
  '\\zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w of|x-occurrence="1"\\w* \\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
  '',
].join('\n');

const TN_TSV = [
  'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
  'front:intro\tyx6e\t\t\t\t0\t# Introduction',
  '1:intro\tqki3\t\t\t\t0\t# Chapter notes',
  '1:1\tabcd\t\trc://*/ta/man/translate/figs-possession\tדְּבַר־יְהוָ֖ה\t1\tThis is **the word of Yahweh** explained.',
  '2:4\tefgh\t\trc://*/ta/man/translate/figs-possession\tדְּבַר־יְהוָ֖ה\t1\tSee how you translated the similar expression in [1:1](../01/01.md).',
  '',
].join('\n');

test('hebTokens normalizes NFC, strips cantillation, and splits on maqaf', () => {
  // Same consonants, different combining-mark order / accents.
  const a = hebTokens('דְּבַר־יְהוָ֖ה');
  assert.deepEqual(a, ['דבר', 'יהוה']);
  // Word joiner keeps a prefixed form as one token.
  assert.deepEqual(hebTokens('וָ⁠אֶשָּׂ֨א'), ['ואשא']);
});

test('parseAlignedUsfmSpans emits one ordered record per source word', () => {
  const spans = parseAlignedUsfmSpans(ALIGNED);
  assert.equal(spans.length, 6);
  assert.equal(spans[0].ref, '1:1');
  assert.equal(spans[0].strong, 'H1697');
  assert.equal(spans[1].strong, 'H3068');
  assert.deepEqual(spans.map((s) => s.ref), ['1:1', '1:1', '2:4', '2:4', '2:9', '2:9']);
});

test('deriveRecurrenceKey prefers the Strong sequence and falls back to text', () => {
  const alignmentEntries = [
    { eng: 'word', heb: 'דְּבַר', strong: 'H1697', heb_pos: 0, occurrence: 1 },
    { eng: 'Yahweh', heb: 'יְהוָ֖ה', strong: 'H3068', heb_pos: 1, occurrence: 1 },
  ];
  assert.equal(
    deriveRecurrenceKey({ origQuote: 'דְּבַר־יְהוָ֖ה', alignmentEntries }),
    'H1697+H3068'
  );
  // No alignment data → consonantal text key.
  assert.equal(deriveRecurrenceKey({ origQuote: 'דְּבַר־יְהוָ֖ה', alignmentEntries: [] }), 'דבר+יהוה');
});

test('deriveRecurrenceKeys splits discontinuous & quotes and joins segments with +', () => {
  const alignmentEntries = [
    { heb: 'דְּבַר', strong: 'H1697' },
    { heb: 'יְהוָ֖ה', strong: 'H3068' },
  ];
  const { strongKey } = deriveRecurrenceKeys({
    origQuote: 'דְּבַר & יְהוָ֖ה',
    alignmentEntries,
  });
  assert.equal(strongKey, 'H1697+H3068');
});

test('formatTnLink pads two digits, three for PSA, and links a bridge on its first verse', () => {
  assert.equal(formatTnLink('ZEC', 3, 9), '[3:9](../03/09.md)');
  assert.equal(formatTnLink('PSA', 78, 1), '[78:1](../078/001.md)');
  assert.equal(formatTnLink('ZEC', 1, '5-6'), '[1:5](../01/05.md)');
});

test('buildSeeHowSentence follows the corpus phrasing table', () => {
  assert.equal(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1' }),
    'See how you translated the similar expression in [1:1](../01/01.md).'
  );
  assert.equal(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1', sameSref: true, sameWording: true, glQuote: 'the word of Yahweh' }),
    'See how you translated **the word of Yahweh** in [1:1](../01/01.md).'
  );
  assert.match(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1', sameSref: true, glQuote: 'Yahweh', sref: 'figs-idiom' }),
    /this word/
  );
  assert.match(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1', sameSref: true, glQuote: 'Berekiah', sref: 'translate-names' }),
    /this name/
  );
  assert.match(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1', sameSref: true, glQuote: 'the word of Yahweh', sref: 'figs-possession' }),
    /this phrase/
  );
  assert.match(
    buildSeeHowSentence({ book: 'ZEC', targetRef: '1:1', sameSref: true, glQuote: 'a b c d e f g', sref: 'figs-possession' }),
    /this expression/
  );
});

test('formatAlsoOccurs uses the Oxford comma, collapses 3+ runs, and handles bridges', () => {
  assert.equal(formatAlsoOccurs(['5', '7', '8', '11']), 'This also occurs in verses 5, 7, 8, and 11.');
  assert.equal(formatAlsoOccurs(['5', '7']), 'This also occurs in verses 5 and 7.');
  assert.equal(formatAlsoOccurs(['5']), 'This also occurs in verse 5.');
  assert.equal(formatAlsoOccurs(['3', '4', '5', '9']), 'This also occurs in verses 3–5 and 9.');
  assert.equal(formatAlsoOccurs(['5-6', '9']), 'This also occurs in verses 5–6 and 9.');
  assert.equal(formatAlsoOccurs([]), '');
});

test('eligibility guard: multi-word always, single word needs a listed sref and a non-stoplisted lemma', () => {
  assert.equal(isSeeHowEligible('H1697+H3068', 'figs-possession'), true);
  assert.equal(isSeeHowEligible('H3068', 'figs-possession'), false, 'sref not consistency-bearing');
  assert.equal(isSeeHowEligible('H3068', 'translate-names'), false, 'Yahweh is stoplisted');
  assert.equal(isSeeHowEligible('H1234', 'translate-names'), true);
  assert.equal(isSeeHowEligible('', 'translate-names'), false);
  assert.ok(SEE_HOW_SINGLE_WORD_SREFS.has('translate-unknown'));
  assert.ok(SEE_HOW_STOPLIST.has('H3068'));
});

test('buildBookRecurrenceIndex groups occurrences ascending, uncapped, from notes and corpus', () => {
  const index = buildBookRecurrenceIndex({
    book: 'ZEC',
    chapter: 3,
    ultFullUsfm: ALIGNED,
    tnBookTsv: TN_TSV,
    preparedItems: [],
    alignmentData: {},
  });
  const key = 'H1697+H3068';
  const occs = index.byKey[key];
  assert.ok(occs, 'strong key present');
  assert.deepEqual(occs.map((o) => o.ref), ['1:1', '1:1', '2:4', '2:4', '2:9']);
  const noted = occs.filter((o) => o.source === 'tn');
  assert.equal(noted.length, 2);
  assert.equal(noted[0].ref, '1:1');
  assert.equal(noted[0].sref, 'figs-possession');
  assert.equal(noted[0].isPointer, false);
  assert.equal(noted[1].isPointer, true, 'pointer rows are marked');
});

test('buildBookRecurrenceIndex ignores the current chapter and later note rows', () => {
  const tsv = TN_TSV + '3:1\tzzzz\t\trc://*/ta/man/translate/figs-possession\tדְּבַר־יְהוָ֖ה\t1\tStale note in the chapter being rerun.\n';
  const index = buildBookRecurrenceIndex({
    book: 'ZEC',
    chapter: 3,
    ultFullUsfm: ALIGNED,
    tnBookTsv: tsv,
  });
  const refs = (index.byKey['H1697+H3068'] || []).filter((o) => o.source === 'tn').map((o) => o.ref);
  assert.deepEqual(refs, ['1:1', '2:4'], 'chapter 3 note rows are not index targets');
});

test('buildBookRecurrenceIndex keys prepared items through alignment data', () => {
  const index = buildBookRecurrenceIndex({
    book: 'ZEC',
    chapter: 2,
    ultFullUsfm: ALIGNED,
    tnBookTsv: TN_TSV,
    preparedItems: [{ id: 'aa11', reference: '2:4', sref: 'figs-possession', orig_quote: 'דְּבַר־יְהוָ֖ה' }],
    alignmentData: {
      '2:4': [
        { heb: 'דְּבַר', strong: 'H1697' },
        { heb: 'יְהוָ֖ה', strong: 'H3068' },
      ],
    },
  });
  assert.equal(index.keyById.aa11, 'H1697+H3068');
  assert.ok((index.byKey['H1697+H3068'] || []).some((o) => o.source === 'prepared' && o.id === 'aa11'));
});

test('buildBookRecurrenceIndex degrades to an empty index without sources', () => {
  const index = buildBookRecurrenceIndex({ book: 'ZEC', chapter: 3 });
  assert.deepEqual(index.byKey, {});
  assert.equal(index.counts.noteRows, 0);
});

const {
  parseHebrewUsfmWords,
  joinSourceSpan,
  findRunIndexByTokens,
  SEE_HOW_NEVER_FOLD_SREFS,
} = require('../src/workspace-tools/recurrence-index');

const UHB = [
  '\\id ZEC',
  '\\c 3',
  '\\v 2 \\w דְּבַר|lemma="דָּבָר" strong="H1697"\\w*־\\w יְהוָ֖ה|lemma="יְהֹוָה" strong="H3068"\\w* \\w אֲשֶׁ֥ר|lemma="אֲשֶׁר" strong="H834"\\w*',
  '',
].join('\n');

test('F1: never-fold srefs are exported and are never see-how eligible', () => {
  assert.ok(SEE_HOW_NEVER_FOLD_SREFS.has('writing-foreground'));
  assert.equal(isSeeHowEligible('H2009', 'writing-foreground'), false);
  // Even a multi-word key, which is otherwise always eligible.
  assert.equal(isSeeHowEligible('H2009+H3068', 'writing-foreground'), false);
});

test('F3: parseHebrewUsfmWords records the literal separator that follows each word', () => {
  const words = parseHebrewUsfmWords(UHB);
  assert.equal(words.length, 3);
  assert.equal(words[0].sepAfter, '־', 'maqaf between the first two words');
  assert.equal(words[1].sepAfter, ' ');
});

test('F3: joinSourceSpan rebuilds a maqaf-joined span byte-for-byte', () => {
  const words = parseHebrewUsfmWords(UHB);
  const range = findRunIndexByTokens(words, ['דבר', 'יהוה']);
  assert.deepEqual(range, { start: 0, end: 1 });
  assert.equal(joinSourceSpan(words, range.start, range.end), 'דְּבַר־יְהוָ֖ה');
});

test('F3: corpus occurrences carry the exact UHB span when the UHB is available', () => {
  const aligned = [
    '\\id ZEC',
    '\\c 1',
    '\\p',
    '\\v 1 \\zaln-s |x-strong="H1697" x-occurrence="1" x-content="דְּבַר"\\*\\w word|x-occurrence="1"\\w*\\zaln-e\\*' +
      '\\zaln-s |x-strong="H3068" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
    '\\c 3',
    '\\p',
    '\\v 2 \\zaln-s |x-strong="H1697" x-occurrence="1" x-content="דְּבַר"\\*\\w word|x-occurrence="1"\\w*\\zaln-e\\*' +
      '\\zaln-s |x-strong="H3068" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
    '',
  ].join('\n');
  const index = buildBookRecurrenceIndex({
    book: 'ZEC',
    chapter: 3,
    ultFullUsfm: aligned,
    hebrewUsfm: UHB,
    preparedItems: [{ id: 'aa11', reference: '3:2', sref: 'figs-possession', orig_quote: 'דְּבַר־יְהוָ֖ה' }],
    alignmentData: { '3:2': [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }] },
  });
  const corpus = (index.byKey['H1697+H3068'] || []).filter((o) => o.source === 'corpus');
  const atVerse2 = corpus.find((o) => o.ref === '3:2');
  assert.ok(atVerse2);
  assert.equal(atVerse2.quote, 'דְּבַר־יְהוָ֖ה');
  assert.equal(atVerse2.quote_exact, true);
  // 1:1 has no UHB coverage in this fixture, so it degrades to the space-join.
  const atVerse1 = corpus.find((o) => o.ref === '1:1');
  assert.equal(atVerse1.quote_exact, false);
  // Counted once per registered key form (Strong's and text), so >= 1.
  assert.ok(index.counts.inexactSpans >= 1);
});

const { dedupeAlsoOccursVerses } = require('../src/workspace-tools/recurrence-index');

test('G3: also-occurs verses dedupe on the numeric first verse and keep the bridge form', () => {
  // A folded prepared item contributes "5"; the source span for the same bridge
  // contributes "5-6". Keyed by string those survive as two entries.
  assert.deepEqual(dedupeAlsoOccursVerses(['5', '5-6']), ['5-6']);
  assert.deepEqual(dedupeAlsoOccursVerses(['5-6', '5']), ['5-6']);
  assert.deepEqual(dedupeAlsoOccursVerses(['9', '5', '7']), ['5', '7', '9'], 'ascending');
  assert.deepEqual(dedupeAlsoOccursVerses(['5', '5']), ['5']);
  assert.deepEqual(dedupeAlsoOccursVerses(['', null, undefined]), []);
});

test('G3: formatAlsoOccurs renders a de-duplicated bridge once', () => {
  assert.equal(formatAlsoOccurs(['5', '5-6', '9']), 'This also occurs in verses 5–6 and 9.');
});

const { selectAlsoOccursCarriers, isKeySubsequence } = require('../src/workspace-tools/recurrence-index');

test('C4: isKeySubsequence matches only contiguous runs', () => {
  assert.equal(isKeySubsequence('H0559+H3068', 'H3541+H0559+H3068+H6635b'), true);
  assert.equal(isKeySubsequence('H3541+H0559', 'H3541+H0559+H3068'), true);
  // Present but not contiguous.
  assert.equal(isKeySubsequence('H3541+H3068', 'H3541+H0559+H3068'), false);
  assert.equal(isKeySubsequence('H9999', 'H3541+H0559'), false);
  assert.equal(isKeySubsequence('', 'H3541'), false);
});

test('C4: only the longest overlapping key carries the corpus list (published ZEC 8 shape)', () => {
  const carriers = selectAlsoOccursCarriers([
    { key: 'H3541+H0559+H3068+H6635b', anchorVerse: 2 },
    { key: 'H3541+H0559+H3068', anchorVerse: 3 },
    { key: 'H0559+H3068+H6635b', anchorVerse: 14 },
  ]);
  assert.deepEqual([...carriers], ['H3541+H0559+H3068+H6635b']);
});

test('C4: an unrelated key keeps its own corpus list', () => {
  const carriers = selectAlsoOccursCarriers([
    { key: 'H3541+H0559+H3068', anchorVerse: 3 },
    { key: 'H3541+H0559', anchorVerse: 5 },
    { key: 'H4325', anchorVerse: 9 },
  ]);
  assert.equal(carriers.has('H3541+H0559+H3068'), true);
  assert.equal(carriers.has('H3541+H0559'), false);
  assert.equal(carriers.has('H4325'), true, 'no containment relation, so it carries its own');
});

test('C4: a chain A subset B subset C leaves only C', () => {
  const carriers = selectAlsoOccursCarriers([
    { key: 'B', anchorVerse: 4 },
    { key: 'A+B', anchorVerse: 2 },
    { key: 'A+B+C', anchorVerse: 7 },
  ]);
  assert.deepEqual([...carriers], ['A+B+C']);
});

test('C4: a length tie is broken by the earlier anchor verse', () => {
  const carriers = selectAlsoOccursCarriers([
    { key: 'B', anchorVerse: 9 },
    { key: 'B+C', anchorVerse: 11 },
    { key: 'A+B', anchorVerse: 4 },
  ]);
  assert.deepEqual([...carriers], ['A+B'], 'same length, earlier anchor wins');
});

test('C4: an empty or single-key set is unchanged', () => {
  assert.deepEqual([...selectAlsoOccursCarriers([])], []);
  assert.deepEqual([...selectAlsoOccursCarriers([{ key: 'H3068', anchorVerse: 1 }])], ['H3068']);
});

// --- Round 3: S5 / S6 / N3 / S11 / B1 alias map -----------------------------

const {
  parseTnTsv,
  resolveWorkspacePath,
  resolveDoor43ReposPath,
} = require('../src/workspace-tools/recurrence-index');

test('S5: Strong numbers canonicalise to four digits, so H559 and H0559 are one lemma', () => {
  assert.equal(normalizeStrong('H559'), 'H0559');
  assert.equal(normalizeStrong('H0559'), 'H0559');
  assert.equal(normalizeStrong('c:H1961'), 'H1961');
  assert.equal(normalizeStrong('H6635b'), 'H6635b');
  // Both spellings hit the stoplist, so neither earns a single-word pointer.
  assert.equal(isSeeHowEligible('H559', 'translate-names'), false);
  assert.equal(isSeeHowEligible('H0559', 'translate-names'), false);
  assert.equal(isSeeHowEligible('H430', 'figs-idiom'), false);
  assert.equal(isSeeHowEligible('H0430', 'figs-idiom'), false);
});

test('S6: several verses on one USFM line attribute words to the right verse', () => {
  const aw = (strong, content, word) =>
    `\\zaln-s |x-strong="${strong}" x-occurrence="1" x-content="${content}"\\*` +
    `\\w ${word}|x-occurrence="1"\\w*\\zaln-e\\*`;
  const aligned = [
    '\\id AMO',
    '\\c 1',
    `\\q1 \\v 1 ${aw('H0001', 'a', 'A')} \\v 2 ${aw('H0002', 'b', 'B')} \\v 3 ${aw('H0003', 'c', 'C')}`,
    '',
  ].join('\n');
  assert.deepEqual(
    parseAlignedUsfmSpans(aligned).map((r) => `${r.ref}=${r.strong}`),
    ['1:1=H0001', '1:2=H0002', '1:3=H0003']
  );

  const heb = [
    '\\id AMO',
    '\\c 1',
    '\\v 1 \\w aleph|strong="H0001"\\w* \\v 2 \\w bet|strong="H0002"\\w* \\v 3 \\w gimel|strong="H0003"\\w*',
    '',
  ].join('\n');
  assert.deepEqual(
    parseHebrewUsfmWords(heb).map((r) => `${r.ref}=${r.strong}`),
    ['1:1=H0001', '1:2=H0002', '1:3=H0003']
  );
});

test('N3: parseTnTsv strips an rc:// prefix in any language, not just *', () => {
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\taaaa\t\trc://*/ta/man/translate/figs-idiom\tq\t1\tA',
    '1:2\tbbbb\t\trc://en/ta/man/translate/figs-metaphor\tq\t1\tB',
    '',
  ].join('\n');
  assert.deepEqual(parseTnTsv(tsv).map((r) => r.sref), ['figs-idiom', 'figs-metaphor']);
});

test('S11: the shared resolver honours an absolute path and resolves a relative one', () => {
  const abs = process.platform === 'win32' ? 'C:\\srv\\repos' : '/srv/repos';
  assert.equal(resolveWorkspacePath(abs, '/base'), abs);
  assert.equal(
    resolveWorkspacePath('door43-repos', process.cwd()),
    require('path').resolve(process.cwd(), 'door43-repos')
  );
  const old = process.env.DOOR43_REPOS_PATH;
  try {
    process.env.DOOR43_REPOS_PATH = 'rel/repos';
    assert.equal(
      resolveDoor43ReposPath(process.cwd()),
      require('path').resolve(process.cwd(), 'rel/repos')
    );
  } finally {
    if (old == null) delete process.env.DOOR43_REPOS_PATH;
    else process.env.DOOR43_REPOS_PATH = old;
  }
});

test('B1: the index publishes an alias from the text key to the Strong key', () => {
  const aligned = [
    '\\id ZEC',
    '\\c 1',
    '\\p',
    '\\v 1 \\zaln-s |x-strong="H1697" x-occurrence="1" x-content="דְּבַר"\\*\\w word|x-occurrence="1"\\w*\\zaln-e\\*' +
      '\\zaln-s |x-strong="H3068" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
    '\\c 3',
    '\\p',
    '\\v 2 \\zaln-s |x-strong="H1697" x-occurrence="1" x-content="דְּבַר"\\*\\w word|x-occurrence="1"\\w*\\zaln-e\\*' +
      '\\zaln-s |x-strong="H3068" x-occurrence="1" x-content="יְהוָ֖ה"\\*\\w Yahweh|x-occurrence="1"\\w*\\zaln-e\\*',
    '',
  ].join('\n');
  const tsv = [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\tabcd\t\trc://*/ta/man/translate/figs-possession\tדְּבַר־יְהוָ֖ה\t1\tExplanatory note.',
    '',
  ].join('\n');
  const index = buildBookRecurrenceIndex({
    book: 'ZEC', chapter: 3, ultFullUsfm: aligned, tnBookTsv: tsv,
  });
  assert.equal(index.canonical['דבר+יהוה'], 'H1697+H3068');
  assert.equal(index.canonical['H1697+H3068'], 'H1697+H3068');
});
