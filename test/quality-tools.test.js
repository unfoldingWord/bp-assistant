const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');

const { createQualityTools } = require('../src/workspace-tools');
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

test('checkTnQuality flags scope overreach when prepared metadata proves a narrower exact span', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-scope-'));
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
    '39:1\tp123\t\trc://*/ta/man/translate/figs-metaphor\tאֶשְׁמְרָ֥ה לְ⁠פִ֥⁠י מַחְס֑וֹם\t1\tHere the psalmist is speaking as if his speech were restrained by a **muzzle**. Alternate translation: [I will keep myself from speaking]',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'p123',
        reference: '39:1',
        at_required: true,
        gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
        issue_span_gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
        exact_ult_span: 'Let me guard a muzzle for my mouth',
        ult_verse: 'I said, “Let me guard my ways from sinning with my tongue. Let me guard a muzzle for my mouth.”',
        ust_verse: 'I said that I would keep myself from speaking.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 39\n\\v 1 I said, “Let me guard my ways from sinning with my tongue. Let me guard a muzzle for my mouth.”\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 39\n\\v 1 I said that I would keep myself from speaking.\n');

  await checkTnQuality({
    tsvPath: tsvRel,
    preparedJson: prepRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: findingsRel,
  });

  const findings = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
  assert.ok(findings.some((f) => f.id === 'p123' && f.category === 'scope_overreach'));
});

test('checkTnQuality flags AT scope mismatch against the exact selected span', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-atfit-'));
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
    '39:10\ti8qv\t\trc://*/ta/man/translate/figs-metonymy\tמִ⁠תִּגְרַ֥ת יָ֝דְ⁠ךָ֗\t1\tHere, **your hand** represents Yahweh’s power. If it would be helpful in your language, you could use an equivalent expression or state the meaning plainly. Alternate translation: [of your might]',
    '39:12\tgyud\t\trc://*/ta/man/translate/figs-imperative\tהוֹדִ֘יעֵ֤⁠נִי\t1\tThis is an imperative, but it communicates a polite request rather than a command. Alternate translation: [please let me know my end, Yahweh]',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'i8qv',
        reference: '39:10',
        at_required: true,
        gl_quote: 'from the blow of your hand',
        issue_span_gl_quote: 'from the blow of your hand',
        exact_ult_span: 'your hand',
        ult_verse: 'I am finished from the blow of your hand.',
        ust_verse: 'I am finished because you struck me.',
      },
      {
        id: 'gyud',
        reference: '39:12',
        at_required: true,
        gl_quote: 'make me know my end',
        issue_span_gl_quote: 'make me know my end',
        exact_ult_span: 'make me know my end',
        ult_verse: 'Yahweh, make me know my end.',
        ust_verse: 'Yahweh, tell me when my life will end.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 39\n\\v 10 I am finished from the blow of your hand.\n\\v 12 Yahweh, make me know my end.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 39\n\\v 10 I am finished because you struck me.\n\\v 12 Yahweh, tell me when my life will end.\n');

  await checkTnQuality({
    tsvPath: tsvRel,
    preparedJson: prepRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: findingsRel,
  });

  const findings = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
  assert.ok(findings.some((f) => f.id === 'i8qv' && f.category === 'at_scope_mismatch'));
  assert.ok(findings.some((f) => f.id === 'gyud' && f.category === 'at_capitalization'));
});

test('check_tn_quality MCP handler always returns schema-valid text content', async () => {
  const { CallToolResultSchema } = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tools-mcp-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tTest note',
  ].join('\n'));

  const server = createQualityTools(sdk.createSdkMcpServer, sdk.tool, z);
  const handler = server.instance._registeredTools.check_tn_quality.handler;
  const result = await handler({ tsvPath: tsvRel });
  const parsed = CallToolResultSchema.safeParse(result);

  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  assert.equal(typeof parsed.data.content[0].text, 'string');
});
