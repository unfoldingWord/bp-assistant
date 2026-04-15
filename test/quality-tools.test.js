const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkTnQuality } = require('../src/workspace-tools/quality-tools');

test('checkTnQuality uses at_required as the missing_at contract', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const ustRel = path.join(relRoot, 'ust.usfm');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the writer uses **king** as a figure.',
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the writer uses **king** as a figure.',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'a1b2',
        reference: '1:1',
        at_required: true,
        needs_at: false,
        gl_quote: 'king',
        issue_span_gl_quote: 'king',
        ult_verse: 'The king spoke to his people.',
        ust_verse: 'The ruler spoke to his people.',
      },
      {
        id: 'a2b3',
        reference: '1:2',
        at_required: false,
        needs_at: true,
        gl_quote: 'king',
        issue_span_gl_quote: 'king',
        ult_verse: 'The king answered.',
        ust_verse: 'The ruler answered.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke to his people.\n\\v 2 The king answered.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 The ruler spoke to his people.\n\\v 2 The ruler answered.\n');

  await checkTnQuality({
    tsvPath: tsvRel,
    preparedJson: prepRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: findingsRel,
  });

  const findings = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
  const missingAtIds = findings.filter((f) => f.category === 'missing_at').map((f) => f.id);
  assert.deepEqual(missingAtIds, ['a1b2']);
});
