const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _postProcessNotesTsv, _finalCanonicalHebrewQuoteSync } = require('../src/notes-pipeline');
const { syncCanonicalHebrewQuotes } = require('../src/workspace-tools/tn-tools');

test('postProcessNotesTsv applies curly quote normalization to final TSV after AT assembly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-postprocess-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const notesRel = path.join(relRoot, 'notes.tsv');
  fs.writeFileSync(path.join('/srv/bot/workspace', notesRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/writing-pronouns\tאָב\t1\tThe pronoun refers to that person\'s "way." Alternate translation: [that person\'s "way"]',
  ].join('\n'));

  const summary = _postProcessNotesTsv({ notesPath: notesRel });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', notesRel), 'utf8');

  assert.match(summary, /curly/i);
  assert.match(content, /person’s/);
  assert.match(content, /“way\.”/);
  assert.doesNotMatch(content, /person's/);
  assert.doesNotMatch(content, /"way/);
});

test('postProcessNotesTsv performs safe ZEC-style opening bold repair when prepared metadata is available', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-postprocess-zec-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const notesRel = path.join(relRoot, 'notes.tsv');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const prepRel = path.join(relRoot, 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', notesRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:1\ta1b2\t\trc://*/ta/man/translate/figs-metonymy\tלִפְנֵי\t1\tHere, the angel of Yahweh represents being in the presence of Yahweh. Alternate translation: [the high priest standing in the presence of the angel of Yahweh]',
    '3:1\ta2b3\t\trc://*/ta/man/translate/writing-newevent\tויראני\t1\tZechariah is using the word translated as made me see to introduce a new event in the story.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 3\n\\v 1 Joshua the high priest was standing before the angel of Yahweh, and the adversary was standing on his right.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'a1b2',
        reference: '3:1',
        sref: 'figs-metonymy',
        issue_span_gl_quote: 'the angel of Yahweh',
        gl_quote: 'the angel of Yahweh',
        ult_verse: 'Joshua the high priest was standing before the angel of Yahweh, and the adversary was standing on his right.',
        template_text: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language.',
      },
      {
        id: 'a2b3',
        reference: '3:1',
        sref: 'writing-newevent',
        issue_span_gl_quote: 'made me see',
        gl_quote: 'made me see',
        ult_verse: 'Joshua the high priest was standing before the angel of Yahweh, and the adversary was standing on his right.',
        template_text: 'SPEAKER is using the word translated as **text** to introduce a new event in the story. Use a word, phrase, or other method in your language that is natural for introducing a new event.',
      },
    ],
  }, null, 2));

  const summary = _postProcessNotesTsv({
    notesPath: notesRel,
    ultUsfm: path.join('/srv/bot/workspace', ultRel),
    preparedJson: path.join('/srv/bot/workspace', prepRel),
  });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', notesRel), 'utf8');

  assert.match(summary, /restored 1 missing bold/);
  assert.match(content, /Here, \*\*the angel of Yahweh\*\* represents being in the presence of Yahweh/);
  assert.doesNotMatch(content, /Alternate translation:.*\*\*made me see\*\*/);
});

test('syncCanonicalHebrewQuotes restores exact source substring with combining marks and spacing from prepared orig_quote', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-canonical-sync-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const notesRel = path.join(relRoot, 'notes.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const hebRel = path.join(relRoot, 'heb.usfm');

  const canonicalQuote = 'יְהוָ֣ה צְבָא֗וֹת';

  fs.writeFileSync(path.join('/srv/bot/workspace', notesRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:7\tab12\t\trc://*/ta/man/translate/writing-quotations\tYahweh of Armies\t1\tTest note',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'ab12',
        reference: '3:7',
        orig_quote: canonicalQuote,
      },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 7 \\w כֹּה־אָמַ֞ר|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֗וֹת|x\\w* \\w אִם־בִּדְרָכַ֤י|x\\w*',
  ].join('\n'));

  const summary = syncCanonicalHebrewQuotes({
    tsvFile: notesRel,
    preparedJson: prepRel,
    hebrewUsfm: hebRel,
  });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', notesRel), 'utf8');

  assert.match(summary, /Synced 1 canonical Hebrew quote/);
  assert.match(content, new RegExp(`\\t${canonicalQuote}\\t1\\t`));
  assert.doesNotMatch(content, /\tYahweh of Armies\t1\t/);
});

test('syncCanonicalHebrewQuotes preserves discontinuous segment order and separator policy', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-canonical-discontinuous-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const notesRel = path.join(relRoot, 'notes.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const hebRel = path.join(relRoot, 'heb.usfm');

  const canonicalQuote = 'אֶת־יְהוֹשֻׁ֨עַ֙ & וְהַשָּׂטָ֛ן';

  fs.writeFileSync(path.join('/srv/bot/workspace', notesRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:1\tcd34\t\trc://*/ta/man/translate/figs-explicit\tbad quote\t1\tTest note',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'cd34',
        reference: '3:1',
        orig_quote: canonicalQuote,
      },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 1 \\w וַיַּרְאֵ֗נִי|x\\w* \\w אֶת־יְהוֹשֻׁ֨עַ֙|x\\w* \\w הַכֹּהֵ֣ן|x\\w* \\w וְהַשָּׂטָ֛ן|x\\w* \\w עֹמֵ֥ד|x\\w*',
  ].join('\n'));

  syncCanonicalHebrewQuotes({
    tsvFile: notesRel,
    preparedJson: prepRel,
    hebrewUsfm: hebRel,
  });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', notesRel), 'utf8');

  assert.match(content, /\tאֶת־יְהוֹשֻׁ֨עַ֙ & וְהַשָּׂטָ֛ן\t1\t/);
});

test('syncCanonicalHebrewQuotes tags unresolved rows and continues', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-canonical-unresolved-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const notesRel = path.join(relRoot, 'notes.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const hebRel = path.join(relRoot, 'heb.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', notesRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:7\tef56\t\trc://*/ta/man/translate/writing-quotations\tcurrent quote\t1\tTest note',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'ef56',
        reference: '3:7',
        orig_quote: 'לֹא קַיָּם',
      },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 7 \\w כֹּה־אָמַ֞ר|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֗וֹת|x\\w*',
  ].join('\n'));

  const summary = syncCanonicalHebrewQuotes({
    tsvFile: notesRel,
    preparedJson: prepRel,
    hebrewUsfm: hebRel,
    mismatchPolicy: 'tag',
  });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', notesRel), 'utf8');

  assert.match(summary, /Unresolved 1/);
  assert.match(content, /^3:7\tef56\tISSUE:MATCH_FAIL\t/m);
  assert.match(content, /\tcurrent quote\t1\t/);
});

// Regression guard for issue #38:
// The write-notes pipeline crashed with "ctx is not defined" when triggered
// for Zechariah 5.  The root cause was a bare `ctx` reference in the
// notesPipeline body at the finalCanonicalHebrewQuoteSync call site; `ctx`
// was never declared in that scope.  The fix introduced:
//
//   const ctxForSync = pipeDir ? readContext(pipeDir) : null;
//   finalCanonicalHebrewQuoteSync({
//     preparedJson: ctxForSync?.runtime?.preparedNotes,
//     hebrewUsfm:   ctxForSync?.sources?.hebrew,
//   });
//
// When buildNotesContext() fails (pipeDir stays null), ctxForSync is null
// and optional chaining returns undefined for both args.  The function must
// return its skip message rather than throw.
test('finalCanonicalHebrewQuoteSync skips gracefully when pipeDir is unavailable (ctx null-guard regression #38)', () => {
  // Simulates ctxForSync = null  →  ctxForSync?.runtime?.preparedNotes === undefined
  //                               →  ctxForSync?.sources?.hebrew        === undefined
  const result = _finalCanonicalHebrewQuoteSync({
    notesPath: 'output/notes/ZEC/ZEC-05.tsv',
    preparedJson: undefined,
    hebrewUsfm: undefined,
  });
  assert.match(result, /skipped/i, 'should return skip message, not crash with ctx-not-defined');

  // Also confirm fully-null call (e.g. notesPath not yet resolved)
  const result2 = _finalCanonicalHebrewQuoteSync({
    notesPath: null,
    preparedJson: null,
    hebrewUsfm: null,
  });
  assert.match(result2, /skipped/i);
});
