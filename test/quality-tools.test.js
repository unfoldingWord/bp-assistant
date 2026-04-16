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

test('checkTnQuality flags literal unicode escapes and ATs identical to brace-stripped ULT quote', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-at-'));
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
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-ellipsis\tמְעַט\t1\tThis note leaked an escape: the wicked person\\u2019s place. Alternate translation: [Better is the little of the righteous]',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'a1b2',
        reference: '1:1',
        at_required: true,
        gl_quote: 'Better {is} the little of the righteous',
        issue_span_gl_quote: 'Better {is} the little of the righteous',
        ult_verse: 'Better is the little of the righteous than great abundance.',
        ust_verse: 'It is better for the righteous person to have a little.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 Better is the little of the righteous than great abundance.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 It is better for the righteous person to have a little.\n');

  await checkTnQuality({
    tsvPath: tsvRel,
    preparedJson: prepRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: findingsRel,
  });

  const findings = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
  const categories = findings.map((f) => f.category);

  assert.ok(categories.includes('unicode_escape_literal'));
  assert.ok(categories.includes('at_equals_ult_after_brace_strip'));
});

test('checkTnQuality distinguishes invalid bold, missing expected bold, and ambiguous openings', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-bold-'));
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
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metonymy\tמֶלֶךְ\t1\tHere, **royal authority** represents the kingly office.',
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metonymy\tמֶלֶךְ הַגָּדוֹל\t1\tHere, king speaks of royal authority.',
    '1:3\ta3b4\t\trc://*/ta/man/translate/writing-pronouns\tהוּא\t1\tThe pronoun he refers to Yahweh.',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'a1b2',
        reference: '1:1',
        sref: 'figs-metonymy',
        template_text: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language.',
        gl_quote: 'king',
        issue_span_gl_quote: 'king',
        ult_verse: 'The king spoke.',
        ust_verse: 'The ruler spoke.',
      },
      {
        id: 'a2b3',
        reference: '1:2',
        sref: 'figs-metonymy',
        template_text: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language.',
        gl_quote: 'great king',
        issue_span_gl_quote: 'great king',
        ult_verse: 'The great king spoke.',
        ust_verse: 'The ruler spoke.',
      },
      {
        id: 'a3b4',
        reference: '1:3',
        sref: 'writing-pronouns',
        template_text: 'The pronoun **pronoun** refers to PERSON. It may be helpful to clarify this for your readers.',
        gl_quote: 'he',
        issue_span_gl_quote: 'he',
        ult_verse: 'He spoke.',
        ust_verse: 'Yahweh spoke.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke.\n\\v 2 The great king spoke.\n\\v 3 He spoke.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 The ruler spoke.\n\\v 2 The ruler spoke.\n\\v 3 Yahweh spoke.\n');

  await checkTnQuality({
    tsvPath: tsvRel,
    preparedJson: prepRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: findingsRel,
  });

  const findings = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
  const categoriesById = new Map();
  for (const finding of findings) {
    if (!categoriesById.has(finding.id)) categoriesById.set(finding.id, []);
    categoriesById.get(finding.id).push(finding.category);
  }

  assert.ok(categoriesById.get('a1b2').includes('invalid_opening_bold'));
  assert.ok(categoriesById.get('a2b3').includes('missing_opening_bold'));
  assert.ok(categoriesById.get('a3b4').includes('ambiguous_opening_bold'));
});
