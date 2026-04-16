const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  prepareNotes,
  prepareATContext,
  verifyBoldMatches,
  _parseExplanationDirectives,
  _resolveTemplateSelection,
  _deriveStyleProfile,
  _deriveAtRequirement,
  _resolveQuoteScopeSelection,
  _buildWriterPrompt,
  _maybeBuildProgrammaticNote,
  _normalizeAssembledNoteText,
} = require('../src/workspace-tools/tn-tools');

test('parseExplanationDirectives separates t: and i: instructions deterministically', () => {
  const parsed = _parseExplanationDirectives('This imperative is soft t: request i: Keep the request polite');

  assert.deepEqual(parsed.template_hints, ['request']);
  assert.deepEqual(parsed.must_include, ['Keep the request polite']);
  assert.equal(parsed.clean_explanation, 'This imperative is soft');
});

test('resolveTemplateSelection locks a single exact template hint match', () => {
  const templateMap = new Map([
    ['figs-imperative', [
      { issue_type: 'figs-imperative', type: 'request', template: 'Request template. Alternate translation: [text]' },
      { issue_type: 'figs-imperative', type: 'condition', template: 'Condition template. Alternate translation: [text]' },
    ]],
  ]);

  const selected = _resolveTemplateSelection({
    sref: 'figs-imperative',
    templateHints: ['request'],
    templateMap,
  });

  assert.equal(selected.template_locked, true);
  assert.equal(selected.selected_template.type, 'request');
  assert.equal(selected.candidate_templates.length, 1);
});

test('deriveStyleProfile keeps no-at style rule metadata without suppressing template AT requirements', () => {
  const templateStrict = _deriveStyleProfile({
    sref: 'writing-background',
    mustInclude: [],
    atProvided: '',
    needsAt: true,
    selectedTemplate: { template: 'Background template. Alternate translation: [ALT]' },
  });
  assert.equal(templateStrict.at_policy, 'required');
  assert.equal(templateStrict.at_required, true);
  assert.ok(templateStrict.style_rules.includes('no_at'));

  const overridden = _deriveStyleProfile({
    sref: 'writing-background',
    mustInclude: ['Include an alternate translation if needed'],
    atProvided: '',
    needsAt: true,
    selectedTemplate: { template: 'Background template.' },
  });
  assert.equal(overridden.at_policy, 'not_needed');
  assert.equal(overridden.at_required, false);
  assert.ok(overridden.rule_overrides.includes('at_policy_from_i'));
});

test('deriveAtRequirement requires AT when the selected template has an AT slot', () => {
  const decision = _deriveAtRequirement({
    atProvided: '',
    needsAt: false,
    selectedTemplate: { template: 'Use this. Alternate translation: [ALT]' },
    styleRules: [],
    hasAtPolicyOverride: false,
  });
  assert.equal(decision.at_policy, 'required');
  assert.equal(decision.at_required, true);
});

test('buildWriterPrompt uses the selected template and forbids exploratory template choice', () => {
  const prompt = _buildWriterPrompt({
    reference: '35:2',
    id: 'abcd',
    sref: 'grammar-connect-logic-result',
    note_type: 'given_at',
    at_policy: 'forbidden',
    template_type: 'reverse',
    template_locked: true,
    template_text: 'If it would be more natural in your language, you could reverse the order of these phrases.',
    must_include: [],
    clean_explanation: 'Use the short stock wording.',
    style_rules: ['keep_to_template', 'do_not_identify_specific_phrases'],
    rule_overrides: [],
    gl_quote: 'For this reason',
    orig_quote: '',
    ult_verse: 'For this reason the king spoke.',
    ust_verse: 'That is why the king spoke.',
    at_provided: '',
  });

  assert.match(prompt, /Selected template:/);
  assert.match(prompt, /Do not choose a different template/);
  assert.doesNotMatch(prompt, /discern which particular template/i);
  assert.doesNotMatch(prompt, /consider whether the text indicates/i);
  assert.match(prompt, /Do not add an alternate translation/);
});

test('maybeBuildProgrammaticNote restores safe see how notes with provided AT', () => {
  const note = _maybeBuildProgrammaticNote({
    book: 'PSA',
    reference: '35:2',
    explanation: 'see how 5',
    at_provided: 'an improved rendering',
  });

  assert.match(note, /See how you translated the similar expression/);
  assert.match(note, /Alternate translation: \[an improved rendering\]/);
});

test('prepareNotes writes a packetized item with deterministic template and policy fields', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-'));
  const workspaceTmp = path.join('/srv/bot/workspace', 'tmp', path.basename(tempDir));
  fs.mkdirSync(workspaceTmp, { recursive: true });

  const issuesRel = path.join('tmp', path.basename(tempDir), 'PSA-035.tsv');
  const ultRel = path.join('tmp', path.basename(tempDir), 'PSA-035.ult.usfm');
  const ustRel = path.join('tmp', path.basename(tempDir), 'PSA-035.ust.usfm');
  const outRel = path.join('tmp', path.basename(tempDir), 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', issuesRel), [
    'Book\tReference\tSupportReference\tQuote\tOccurrence\tAT\tNote',
    'PSA\t35:2\trc://*/ta/man/translate/writing-background\tThen\tYes\t\ti: Keep the transition natural',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 35\n\\v 2 Then the king spoke to the people.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 35\n\\v 2 Then the king spoke to the people.\n');

  const result = prepareNotes({
    inputTsv: issuesRel,
    ultUsfm: ultRel,
    ustUsfm: ustRel,
    output: outRel,
  });

  assert.match(result, /Prepared 1 items/);

  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', outRel), 'utf8'));
  const item = prepared.items[0];

  assert.equal(item.template_type, 'generic');
  assert.equal(item.template_locked, true);
  assert.equal(item.at_policy, 'forbidden');
  assert.equal(item.at_required, false);
  assert.equal(item.scope_mode, 'focused_span');
  assert.equal(item.issue_span_gl_quote, item.gl_quote);
  assert.deepEqual(item.must_include, ['Keep the transition natural']);
  assert.equal(item.clean_explanation, '');
  assert.ok(item.template_text.startsWith('Here the author is providing background information'));
  assert.equal(item.writer_packet.prose_mode, 'template_plus_necessity');
  assert.equal(item.writer_packet.at_policy, 'forbidden');
  assert.equal(item.writer_packet.at_required, false);
  assert.equal(item.writer_packet.issue_span_gl_quote, item.issue_span_gl_quote);
  assert.match(item.prompt, /Selected template:/);
  assert.match(item.prompt, /Quote scope mode:/);
  assert.match(item.prompt, /Do not add an alternate translation/);
  assert.doesNotMatch(item.prompt, /discern which particular template/i);
});

test('prepareNotes keeps at_required false when selected template has no AT slot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-at-'));
  const issuesRel = path.join('tmp', path.basename(tempDir), 'PSA-036.tsv');
  const ultRel = path.join('tmp', path.basename(tempDir), 'PSA-036.ult.usfm');
  const ustRel = path.join('tmp', path.basename(tempDir), 'PSA-036.ust.usfm');
  const outRel = path.join('tmp', path.basename(tempDir), 'prepared_notes.json');

  fs.mkdirSync(path.join('/srv/bot/workspace', 'tmp', path.basename(tempDir)), { recursive: true });
  fs.writeFileSync(path.join('/srv/bot/workspace', issuesRel), [
    'Book\tReference\tSRef\tGLQuote\tNeedsAT\tAT\tExplanation',
    'PSA\t36:1\twriting-background\tThen\tYes\t\t',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 36\n\\v 1 Then the king spoke.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', ustRel), '\\c 36\n\\v 1 Then the king spoke.\n');

  prepareNotes({ inputTsv: issuesRel, ultUsfm: ultRel, ustUsfm: ustRel, output: outRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', outRel), 'utf8'));
  const item = prepared.items[0];
  assert.equal(item.chosen_template_has_at_slot, false);
  assert.equal(item.at_required, false);
});

test('deriveAtRequirement treats template AT slots as authoritative over no-at style rules', () => {
  const decision = _deriveAtRequirement({
    atProvided: '',
    needsAt: false,
    selectedTemplate: { template: 'Here the author is providing background information. Alternate translation: [ALT]' },
    styleRules: ['no_at'],
    hasAtPolicyOverride: false,
  });

  assert.equal(decision.at_policy, 'required');
  assert.equal(decision.at_required, true);
  assert.equal(decision.reason, 'template_requires_at');
});

test('prepareATContext keys off canonical at_required', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-atctx-'));
  const root = path.join('/srv/bot/workspace', 'tmp', path.basename(tempDir));
  fs.mkdirSync(root, { recursive: true });

  const preparedRel = path.join('tmp', path.basename(tempDir), 'prepared_notes.json');
  const generatedRel = path.join('tmp', path.basename(tempDir), 'generated_notes.json');
  fs.writeFileSync(path.join('/srv/bot/workspace', preparedRel), JSON.stringify({
    book: 'PSA',
    chapter: '1',
    items: [
      { id: 'a111', reference: '1:1', sref: 'figs-metaphor', at_required: false, needs_at: true, gl_quote: 'old text', issue_span_gl_quote: 'old text', ult_verse: 'old text appears here', ust_verse: 'ust one' },
      { id: 'b222', reference: '1:2', sref: 'figs-metaphor', at_required: true, needs_at: false, gl_quote: 'new text', issue_span_gl_quote: 'new text', ult_verse: 'new text appears here', ust_verse: 'ust two', scope_mode: 'focused_span' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join('/srv/bot/workspace', generatedRel), JSON.stringify({ b222: 'note text' }, null, 2));

  const atCtx = JSON.parse(prepareATContext({ preparedJson: preparedRel, generatedJson: generatedRel }));
  assert.equal(atCtx.item_count, 1);
  assert.equal(atCtx.packets[0].id, 'b222');
  assert.equal(atCtx.packets[0].quote_scope_mode, 'focused_span');
  assert.equal(atCtx.packets[0].exact_ult_span, 'new text');
});

test('quote scope selector marks parallelism rows as full_parallelism', () => {
  const selection = _resolveQuoteScopeSelection({
    sref: 'figs-parallelism',
    glQuote: 'one side',
    ultVerse: 'one side and the matching side',
  });
  assert.equal(selection.scope_mode, 'full_parallelism');
  assert.equal(selection.selected_span, 'one side and the matching side');
});

test('normalizeAssembledNoteText decodes visible unicode escapes and brackets bare AT text', () => {
  const normalized = _normalizeAssembledNoteText(
    'The pronoun refers to the wicked. Alternate translation: the wicked person\\\\u2019s place'
  );

  assert.match(normalized, /Alternate translation: \[the wicked person’s place\]/);
  assert.doesNotMatch(normalized, /\\u2019/);
});

test('verifyBoldMatches restores missing bold when scoped opening quote matches ULT exactly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-bold-add-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'notes.tsv');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const prepRel = path.join(relRoot, 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metonymy\tמֶלֶךְ\t1\tHere, the king represents royal authority. If it would be helpful in your language, you could state the meaning plainly.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke to his people.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [{
      id: 'a1b2',
      reference: '1:1',
      sref: 'figs-metonymy',
      issue_span_gl_quote: 'the king',
      gl_quote: 'the king',
      ult_verse: 'The king spoke to his people.',
      template_text: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language.',
    }],
  }, null, 2));

  const summary = verifyBoldMatches({ tsvFile: tsvRel, ultUsfm: ultRel, preparedJson: prepRel });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', tsvRel), 'utf8');

  assert.match(summary, /restored 1 missing bold/);
  assert.match(content, /Here, \*\*the king\*\* represents royal authority/);
});

test('verifyBoldMatches strips invalid bold when no safe replacement exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-bold-strip-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'notes.tsv');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const prepRel = path.join(relRoot, 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-metonymy\tמֶלֶךְ\t1\tHere, **royal authority** represents the reign of the king.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 The king spoke to his people.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [{
      id: 'a1b2',
      reference: '1:1',
      sref: 'figs-metonymy',
      issue_span_gl_quote: 'king',
      gl_quote: 'king',
      ult_verse: 'The king spoke to his people.',
      template_text: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language.',
    }],
  }, null, 2));

  const summary = verifyBoldMatches({ tsvFile: tsvRel, ultUsfm: ultRel, preparedJson: prepRel });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', tsvRel), 'utf8');

  assert.match(summary, /stripped 1 non-matching bold/);
  assert.doesNotMatch(content, /\*\*royal authority\*\*/);
  assert.doesNotMatch(content, /\*\*king\*\*/);
});

test('verifyBoldMatches does not auto-bold single-word openings for common matches', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-bold-single-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'notes.tsv');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const prepRel = path.join(relRoot, 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/writing-pronouns\tהוּא\t1\tThe pronoun he refers to Yahweh. It may be helpful to clarify this for your readers.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 He spoke to his people.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [{
      id: 'a1b2',
      reference: '1:1',
      sref: 'writing-pronouns',
      issue_span_gl_quote: 'he',
      gl_quote: 'he',
      ult_verse: 'He spoke to his people.',
      template_text: 'The pronoun **pronoun** refers to PERSON. It may be helpful to clarify this for your readers.',
    }],
  }, null, 2));

  const summary = verifyBoldMatches({ tsvFile: tsvRel, ultUsfm: ultRel, preparedJson: prepRel });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', tsvRel), 'utf8');

  assert.match(summary, /restored 0 missing bold/);
  assert.doesNotMatch(content, /\*\*he\*\*/i);
});

test('verifyBoldMatches does not scan beyond the opening to add bold', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-bold-body-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const tsvRel = path.join(relRoot, 'notes.tsv');
  const ultRel = path.join(relRoot, 'ult.usfm');
  const prepRel = path.join(relRoot, 'prepared_notes.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', tsvRel), [
    'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    '1:1\ta1b2\t\trc://*/ta/man/translate/figs-explicit\tעֹמֵד עַל־יְמִינוֹ\t1\tThe implication is that this scene resembles a courtroom. Later in the note, the accuser stands on his right in the position of an accuser.',
  ].join('\n'));
  fs.writeFileSync(path.join('/srv/bot/workspace', ultRel), '\\c 1\n\\v 1 Joshua stood before the angel, and the adversary stood on his right to accuse him.\n');
  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [{
      id: 'a1b2',
      reference: '1:1',
      sref: 'figs-explicit',
      issue_span_gl_quote: 'stood on his right',
      gl_quote: 'stood on his right',
      ult_verse: 'Joshua stood before the angel, and the adversary stood on his right to accuse him.',
      template_text: 'The implication is that IMPLIED. You could include this information if that would be helpful to your readers.',
    }],
  }, null, 2));

  const summary = verifyBoldMatches({ tsvFile: tsvRel, ultUsfm: ultRel, preparedJson: prepRel });
  const content = fs.readFileSync(path.join('/srv/bot/workspace', tsvRel), 'utf8');

  assert.match(summary, /restored 0 missing bold/);
  assert.doesNotMatch(content, /\*\*stood on his right\*\*/);
});
