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
  // Resolve via the package's public subpath, not a hardcoded ../node_modules
  // path: the latter only works when node_modules is a sibling of test/ (fails
  // in git worktrees) and reaches past the SDK's public API into its dist
  // layout. The subpath export resolves through normal module resolution.
  const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
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

// Reads the findings written by checkTnQuality for a given output path.
function readFindings(findingsRel) {
  return JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', findingsRel), 'utf8')).findings || [];
}

test('checkTnQuality exempts :intro rows from the empty_quote check', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-intro-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:intro\ti0b2\t\t\t\t\tGeneral notes about chapter 1.',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\t\t\tHere the writer uses a figure.',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const emptyQuoteIds = readFindings(findingsRel)
    .filter((f) => f.category === 'empty_quote').map((f) => f.id);
  assert.deepEqual(emptyQuoteIds, ['a1b2']);
});

test('checkTnQuality exempts "see how you translated" notes from missing_at', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const ustRel = path.join(relRoot, 'ust.usfm');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tSee how you translated this word in 1:1.',
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the writer uses a figure.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      { id: 'a1b2', reference: '1:1', at_required: true, gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king spoke.', ust_verse: 'The ruler spoke.' },
      { id: 'a2b3', reference: '1:2', at_required: true, gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king answered.', ust_verse: 'The ruler answered.' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke.\n\\v 2 The king answered.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 The ruler spoke.\n\\v 2 The ruler answered.\n');

  await checkTnQuality({ tsvPath: tsvRel, preparedJson: prepRel, ultUsfm: ultRel, ustUsfm: ustRel, output: findingsRel });

  const missingAtIds = readFindings(findingsRel)
    .filter((f) => f.category === 'missing_at').map((f) => f.id);
  assert.deepEqual(missingAtIds, ['a2b3']);
});

test('checkTnQuality template_deviation compares only the resolved template, not a sub-type example', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tpl-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // No resolved template for this note: must NOT fall back to a templates.csv
    // sub-type example (e.g. figs-metaphor "heart") and flag a false positive.
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the author uses a vivid comparison.',
    // Resolved template present but the note omits its fixed phrase: still flagged.
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the king is powerful.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      { id: 'a1b2', reference: '1:1', sref: 'figs-metaphor', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king is a lion.' },
      { id: 'a2b3', reference: '1:2', sref: 'figs-metaphor', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king is powerful.', template_text: 'Here the **X** represents a specific important idea in this passage.' },
    ],
  }, null, 2));

  await checkTnQuality({ tsvPath: tsvRel, preparedJson: prepRel, output: findingsRel });

  const deviationIds = readFindings(findingsRel)
    .filter((f) => f.category === 'template_deviation').map((f) => f.id);
  assert.deepEqual(deviationIds, ['a2b3']);
});

test('checkTnQuality missing_at exemption requires a genuine see-how note, not a mid-text mention', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-mid-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const ustRel = path.join(relRoot, 'ust.usfm');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Mentions the phrase mid-note but is an ordinary explanatory note: still needs its AT.
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the figure recurs; see how you translated it earlier, but this occurrence differs.',
    // Typed see_how item without the leading phrase: exempt via note_type.
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tTranslate this the same way as before.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      { id: 'a1b2', reference: '1:1', at_required: true, gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king spoke.', ust_verse: 'The ruler spoke.' },
      { id: 'a2b3', reference: '1:2', at_required: true, note_type: 'see_how', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king answered.', ust_verse: 'The ruler answered.' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke.\n\\v 2 The king answered.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 The ruler spoke.\n\\v 2 The ruler answered.\n');

  await checkTnQuality({ tsvPath: tsvRel, preparedJson: prepRel, ultUsfm: ultRel, ustUsfm: ustRel, output: findingsRel });

  const missingAtIds = readFindings(findingsRel)
    .filter((f) => f.category === 'missing_at').map((f) => f.id);
  assert.deepEqual(missingAtIds, ['a1b2']);
});

test('checkTnQuality bold check tolerates curled quotes introduced by post-processing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-bold-curl-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const ustRel = path.join(relRoot, 'ust.usfm');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // curly_quotes has curled the note's apostrophe; the parsed ULT keeps the straight form.
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere ‘’ aside, the phrase **the king’s word** is a figure.',
    // A genuinely absent bold span must still be flagged.
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere **the queen’s word** is a figure.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      { id: 'a1b2', reference: '1:1', gl_quote: "the king's word", issue_span_gl_quote: "the king's word", ult_verse: "The king's word stood firm.", ust_verse: 'What the king said stood firm.' },
      { id: 'a2b3', reference: '1:2', gl_quote: "the king's word", issue_span_gl_quote: "the king's word", ult_verse: "The king's word stood firm.", ust_verse: 'What the king said stood firm.' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), "\\c 1\n\\v 1 The king's word stood firm.\n\\v 2 The king's word stood firm.\n");
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 What the king said stood firm.\n\\v 2 What the king said stood firm.\n');

  await checkTnQuality({ tsvPath: tsvRel, preparedJson: prepRel, ultUsfm: ultRel, ustUsfm: ustRel, output: findingsRel });

  const boldIds = readFindings(findingsRel)
    .filter((f) => f.category === 'bold_not_in_ult').map((f) => f.id);
  assert.deepEqual(boldIds, ['a2b3']);
});

test('checkTnQuality flags markdown inside AT brackets and leaves prose bold to check 8', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-at-markdown-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const ustRel = path.join(relRoot, 'ust.usfm');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Bold inside the AT whose wording IS in the ULT: check 8 stays silent by
    // design (an AT keeps ULT wording), so only at_markdown can catch this.
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the writer uses a figure. Alternate translation: [the **king** spoke]',
    // Bold inside the AT whose wording is NOT in the ULT: previously reported
    // as bold_not_in_ult, which mislabels a formatting violation.
    '1:2\ta2b3\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere the writer uses a figure. Alternate translation: [the **chieftain** spoke]',
    // Bold in explanatory prose, outside the brackets: still check 8's job.
    '1:3\ta3b4\t\trc://*/ta/man/translate/figs-metaphor\tמֶלֶךְ\t1\tHere **the emperor** is the figure. Alternate translation: [the king spoke]',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      { id: 'a1b2', reference: '1:1', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king spoke.', ust_verse: 'The ruler addressed them.' },
      { id: 'a2b3', reference: '1:2', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king spoke.', ust_verse: 'The ruler addressed them.' },
      { id: 'a3b4', reference: '1:3', gl_quote: 'king', issue_span_gl_quote: 'king', ult_verse: 'The king spoke.', ust_verse: 'The ruler addressed them.' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke.\n\\v 2 The king spoke.\n\\v 3 The king spoke.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 1\n\\v 1 The ruler addressed them.\n\\v 2 The ruler addressed them.\n\\v 3 The ruler addressed them.\n');

  await checkTnQuality({ tsvPath: tsvRel, preparedJson: prepRel, ultUsfm: ultRel, ustUsfm: ustRel, output: findingsRel });

  const findings = readFindings(findingsRel);

  const atMarkdown = findings.filter((f) => f.category === 'at_markdown');
  assert.deepEqual(atMarkdown.map((f) => f.id), ['a1b2', 'a2b3']);
  // Formatting violations are errors, matching the sibling at_brackets check.
  assert.deepEqual([...new Set(atMarkdown.map((f) => f.severity))], ['error']);

  // The AT-bracket spans are not double-reported under the bold label, and
  // prose bold outside the brackets is still caught.
  const boldIds = findings
    .filter((f) => f.category === 'bold_not_in_ult').map((f) => f.id);
  assert.deepEqual(boldIds, ['a3b4']);
});

// --- Phase 4 guardrails: see-how link checks (docs/plan.md) ---

test('checkTnQuality seehow_target_missing: no match in output TSV or merged book TSV', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-missing-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Points at 2:9 — no row for 2:9 exists in this TSV, and no merged book
    // TSV is supplied, so this must resolve as "unverified", not "missing".
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:9](../02/09.md).',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const findings = readFindings(findingsRel);
  assert.ok(findings.some((f) => f.id === 'a1b2' && f.category === 'seehow_target_unverified'));
  assert.ok(!findings.some((f) => f.category === 'seehow_target_missing'));
});

test('checkTnQuality seehow_target_missing: merged book TSV available but target absent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-missing2-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:9](../02/09.md).',
  ].join('\n'));

  await checkTnQuality({
    tsvPath: tsvRel,
    output: findingsRel,
    // Merged book TSV is present (so the check has an authoritative answer)
    // but has no row covering 2:9 — this is a real error, not "unverified".
    bookTsvRows: ['2:5', '2:7'],
  });

  const findings = readFindings(findingsRel);
  assert.ok(findings.some((f) => f.id === 'a1b2' && f.category === 'seehow_target_missing' && f.severity === 'error'));
  assert.ok(!findings.some((f) => f.category === 'seehow_target_unverified'));
});

test('checkTnQuality seehow target resolves against the current TSV or a bridged merged-TSV row', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-hit-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Target 2:5 exists as a row right here in the current output TSV.
    '2:5\tz9y8\t\t\t\t\tThe similar expression appears here.',
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md).',
    // Target 5:6 is only covered by a verse-bridge row (5:6-7) in the merged book TSV.
    '9:1\tc3d4\t\t\t\t\tSee how you translated the similar expression in [5:6](../05/06.md).',
  ].join('\n'));

  await checkTnQuality({
    tsvPath: tsvRel,
    output: findingsRel,
    bookTsvRows: ['5:6-7'],
  });

  const findings = readFindings(findingsRel);
  const seehowFindings = findings.filter((f) => ['seehow_target_missing', 'seehow_target_unverified'].includes(f.category));
  assert.deepEqual(seehowFindings, []);
});

test('checkTnQuality seehow_forward_pointer: target later than the note\'s own reference', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-forward-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '2:1\tz9y8\t\t\t\t\tThe similar expression appears here.',
    // 2:1 points forward to 2:5, in the same chapter — invalid.
    '2:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md).',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const findings = readFindings(findingsRel);
  assert.ok(findings.some((f) => f.id === 'a1b2' && f.category === 'seehow_forward_pointer' && f.severity === 'error'));
});

test('checkTnQuality seehow: same-verse link is ignored (not forward, not missing)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-same-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // Link target 2:5 is the same verse as the note's own reference.
    '2:5\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md).',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const findings = readFindings(findingsRel);
  const seehowFindings = findings.filter((f) => f.category.startsWith('seehow_'));
  assert.deepEqual(seehowFindings, []);
});

test('checkTnQuality seehow_noncanonical: "see how you rendered" and old-format link path', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-nc-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // "rendered" instead of "translated" — never valid, regardless of link shape.
    '3:1\ta1b2\t\t\t\t\tSee how you rendered the similar expression in [2:5](../02/05.md).',
    // "translated" with the old book-relative link format instead of ../CC/VV.md.
    '3:2\tb2c3\t\t\t\t\tSee how you translated the similar expression in [2:5](../../zec/02/05.md).',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const findings = readFindings(findingsRel);
  const ncById = new Map();
  for (const f of findings.filter((f) => f.category === 'seehow_noncanonical')) {
    if (!ncById.has(f.id)) ncById.set(f.id, []);
    ncById.get(f.id).push(f.severity);
  }
  assert.deepEqual(ncById.get('a1b2'), ['warning']);
  assert.deepEqual(ncById.get('b2c3'), ['warning']);
});

test('checkTnQuality seehow_noncanonical: PSA requires 3-digit padding, other books require 2-digit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-pad-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    // PSA note but 2-digit padding — should be flagged (needs 3-digit).
    '78:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [39:5](../39/05.md).',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel, book: 'PSA' });

  const psaFindings = readFindings(findingsRel).filter((f) => f.category === 'seehow_noncanonical');
  assert.ok(psaFindings.some((f) => f.id === 'a1b2'));

  // Same shape, non-PSA book with 3-digit padding — also flagged (needs 2-digit).
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-pad2-'));
  const relRoot2 = path.join('tmp', path.basename(tempDir2));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot2), { recursive: true });
  const tsvRel2 = path.join(relRoot2, 'tn.tsv');
  const findingsRel2 = path.join(relRoot2, 'findings.json');
  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel2), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '3:1\tc3d4\t\t\t\t\tSee how you translated the similar expression in [002:005](../002/005.md).',
  ].join('\n'));
  await checkTnQuality({ tsvPath: tsvRel2, output: findingsRel2, book: 'ZEC' });
  const zecFindings = readFindings(findingsRel2).filter((f) => f.category === 'seehow_noncanonical');
  assert.ok(zecFindings.some((f) => f.id === 'c3d4'));

  // Correctly-padded PSA link must NOT be flagged.
  const tempDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-pad3-'));
  const relRoot3 = path.join('tmp', path.basename(tempDir3));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot3), { recursive: true });
  const tsvRel3 = path.join(relRoot3, 'tn.tsv');
  const findingsRel3 = path.join(relRoot3, 'findings.json');
  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel3), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '39:6\td4e5\t\t\t\t\tThe similar expression appears here.',
    '78:1\td4e5b\t\t\t\t\tSee how you translated the similar expression in [039:006](../039/006.md).',
  ].join('\n'));
  await checkTnQuality({ tsvPath: tsvRel3, output: findingsRel3, book: 'PSA' });
  const psaOkFindings = readFindings(findingsRel3).filter((f) => f.category === 'seehow_noncanonical');
  assert.deepEqual(psaOkFindings, []);
});

test('multiverse_backref does not fire on canonical see-how sentences or the "also occurs" summary', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-backref-nonreg-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '2:5\tz9y8\t\t\t\t\tThe similar expression appears here.',
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md).',
    '3:5\tb2c3\t\t\t\t\tThe similar expression appears here. This also occurs in verses 5, 7, 8, and 11.',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const backrefFindings = readFindings(findingsRel).filter((f) => f.category === 'multiverse_backref');
  assert.deepEqual(backrefFindings, []);
});

test('checkTnQuality seehow_noncanonical: absolute links in a see-how note are not pointers', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-seehow-abs-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });

  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '2:5\tz0z0\t\t\t\t\tThe earlier note this one points back to.',
    // Canonical pointer plus a trailing tA article link. The rc:// link is not
    // a pointer path and must not be scanned for the ../CC/VV.md shape.
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md). (See: [Metaphor](rc://*/ta/man/translate/figs-metaphor))',
  ].join('\n'));

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const nc = readFindings(findingsRel).filter((f) => f.category === 'seehow_noncanonical' && f.id === 'a1b2');
  assert.deepEqual(nc, [], 'the rc:// link is left alone');
});

// --- Round 3: S2 / S3 / S4 / S10 -------------------------------------------

function writeQualityTsv(prefix, rows) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const relRoot = path.join('tmp', path.basename(tempDir));
  fs.mkdirSync(path.join('/srv/bot/workspace', relRoot), { recursive: true });
  const tsvRel = path.join(relRoot, 'tn.tsv');
  const findingsRel = path.join(relRoot, 'findings.json');
  fs.writeFileSync(
    path.join('/srv/bot/workspace', tsvRel),
    ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote'].concat(rows).join('\n')
  );
  return { tsvRel, findingsRel };
}

test('S2: the deterministic also-occurs sentence is not multiverse language', async () => {
  const shapes = [
    'This also occurs in verses 5, 7, 8, and 11.',
    'This also occurs in verses 5 and 7.',
    'This also occurs in verse 5.',
    'This also occurs in verses 3–5 and 9.',
  ];
  const rows = shapes.map((sentence, i) =>
    `3:${i + 1}\tq${i}q${i}\t\t\t\t\tThe possessive form describes a message. ${sentence}`);
  const { tsvRel, findingsRel } = writeQualityTsv('quality-alsooccurs-', rows);

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const noisy = readFindings(findingsRel)
    .filter((f) => f.category === 'multiverse_language' || f.category === 'multiverse_backref');
  assert.deepEqual(noisy, [], 'no multiverse findings for any also-occurs shape');
});

test('S3: an ordinary note that links forward is not a see-how pointer', async () => {
  // Golden JOS 1 row w48w: "through [verse 9](../01/09.md)" in a plain note.
  const { tsvRel, findingsRel } = writeQualityTsv('quality-forwardlink-', [
    '1:5\tw48w\t\t\t\t\tThis command runs through [verse 9](../01/09.md) and shapes the paragraph.',
  ]);

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const seeHow = readFindings(findingsRel).filter((f) => String(f.category).startsWith('seehow_'));
  assert.deepEqual(seeHow, [], 'no see-how findings on a note without a pointer sentence');
});

test('S4: chapter intro rows are never treated as see-how pointers', async () => {
  const { tsvRel, findingsRel } = writeQualityTsv('quality-intro-', [
    '1:intro\tqki3\t\t\t\t0\t# Notes\\n\\nSee how you translated this in [1:7](../01/07.md) and [9:1](../09/01.md).',
  ]);

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const seeHow = readFindings(findingsRel).filter((f) => String(f.category).startsWith('seehow_'));
  assert.deepEqual(seeHow, [], 'intro rows are exempt');
});

test('S3: a forward link INSIDE a see-how sentence is still an error', async () => {
  const { tsvRel, findingsRel } = writeQualityTsv('quality-forwardptr-', [
    '2:1\tz9y8\t\t\t\t\tThe similar expression appears here.',
    '2:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md).',
  ]);

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  assert.ok(readFindings(findingsRel).some(
    (f) => f.id === 'a1b2' && f.category === 'seehow_forward_pointer' && f.severity === 'error'
  ));
});

test('S10: tW and tA relative links in a see-how note are not flagged non-canonical', async () => {
  const { tsvRel, findingsRel } = writeQualityTsv('quality-twlinks-', [
    '2:5\tz0z0\t\t\t\t\tThe earlier note.',
    '3:1\ta1b2\t\t\t\t\tSee how you translated the similar expression in [2:5](../02/05.md). ' +
      '(See: [Yahweh](../../bible/kt/yahweh.md) and [Idiom](../../translate/figs-idiom/01.md))',
  ]);

  await checkTnQuality({ tsvPath: tsvRel, output: findingsRel });

  const nc = readFindings(findingsRel).filter(
    (f) => f.category === 'seehow_noncanonical' && f.id === 'a1b2'
  );
  assert.deepEqual(nc, [], 'only verse links are inspected');
});
