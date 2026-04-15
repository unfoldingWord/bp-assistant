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
