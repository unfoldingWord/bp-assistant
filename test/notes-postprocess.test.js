const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _postProcessNotesTsv } = require('../src/notes-pipeline');

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
