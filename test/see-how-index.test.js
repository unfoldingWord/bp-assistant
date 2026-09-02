const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBookRecurrenceIndex,
  parseAlignedUsfmSpans,
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
