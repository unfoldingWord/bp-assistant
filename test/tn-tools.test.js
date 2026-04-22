const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  prepareNotes,
  prepareATContext,
  verifyBoldMatches,
  fillOrigQuotes,
  _resolveGlQuotes,
  _parseExplanationDirectives,
  _resolveTemplateSelection,
  _deriveStyleProfile,
  _deriveAtRequirement,
  _resolveQuoteScopeSelection,
  _buildWriterPrompt,
  _maybeBuildProgrammaticNote,
  _normalizeAssembledNoteText,
  substituteAT,
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

test('resolveGlQuotes preserves contiguous aligned spans instead of unioning repeated Hebrew tokens', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-resolvegl-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'fbp0',
        reference: '3:2',
        sref: 'figs-metaphor',
        gl_quote: 'a firebrand rescued from the fire',
        issue_span_gl_quote: 'a firebrand rescued from the fire',
        orig_quote: 'הַ⁠שָּׂטָ֗ן יִגְעַ֨ר יְהוָ֤ה בְּ⁠ךָ֙ הַ⁠שָּׂטָ֔ן וְ⁠יִגְעַ֤ר יְהוָה֙ בְּ⁠ךָ֔ הַ⁠בֹּחֵ֖ר בִּ⁠ירֽוּשָׁלִָ֑ם הֲ⁠ל֧וֹא זֶ֦ה א֖וּד מֻצָּ֥ל מֵ⁠אֵֽשׁ',
        writer_packet: {
          issue_span_gl_quote: 'a firebrand rescued from the fire',
          gl_quote: 'a firebrand rescued from the fire',
        },
        prompt: 'Reference: 3:2\nQuote (scoped): a firebrand rescued from the fire\nULT verse: ...',
      },
      {
        id: 'uhvf',
        reference: '3:3',
        sref: 'figs-metaphor',
        gl_quote: 'filthy garments',
        issue_span_gl_quote: 'filthy garments',
        orig_quote: 'בְּגָדִ֣ים צוֹאִ֑ים',
        writer_packet: {
          issue_span_gl_quote: 'filthy garments',
          gl_quote: 'filthy garments',
        },
        prompt: 'Reference: 3:3\nQuote (scoped): filthy garments\nULT verse: ...',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:2': [
      { eng: 'Yahweh', heb: 'יְהוָ֤ה' },
      { eng: 'rebuke', heb: 'יִגְעַ֨ר' },
      { eng: 'Yahweh', heb: 'יְהוָה֙' },
      { eng: 'rebuke', heb: 'יִגְעַ֤ר' },
      { eng: 'Is', heb: 'הֲ⁠ל֧וֹא' },
      { eng: 'this', heb: 'זֶ֦ה' },
      { eng: 'a', heb: 'א֖וּד' },
      { eng: 'firebrand', heb: 'א֖וּד' },
      { eng: 'rescued', heb: 'מֻצָּ֥ל' },
      { eng: 'from', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'the', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'fire', heb: 'מֵ⁠אֵֽשׁ' },
    ],
    '3:3': [
      { eng: 'in', heb: 'בְּ' },
      { eng: 'filthy', heb: 'צוֹאִ֑ים' },
      { eng: 'garments', heb: 'בְּגָדִ֣ים' },
    ],
  }, null, 2));

  const summary = _resolveGlQuotes({ preparedJson: prepRel, alignmentJson: alignRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));
  const fbp0 = prepared.items.find((item) => item.id === 'fbp0');
  const uhvf = prepared.items.find((item) => item.id === 'uhvf');

  assert.match(summary, /Updated 0 gl_quotes/);
  assert.equal(fbp0.issue_span_gl_quote, 'a firebrand rescued from the fire');
  assert.equal(fbp0.writer_packet.issue_span_gl_quote, 'a firebrand rescued from the fire');
  assert.match(fbp0.prompt, /Quote \(scoped\): a firebrand rescued from the fire/);
  assert.equal(uhvf.issue_span_gl_quote, 'filthy garments');
  assert.equal(uhvf.writer_packet.issue_span_gl_quote, 'filthy garments');
  assert.match(uhvf.prompt, /Quote \(scoped\): filthy garments/);
});

test('resolveGlQuotes narrows to the later repeated occurrence when orig_quote points there', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-resolvegl-late-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'p123',
        reference: '39:1',
        sref: 'figs-metaphor',
        gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
        issue_span_gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
        orig_quote: 'אֶשְׁמְרָ֥ה לְ⁠פִ֥י מַחְס֑וֹם',
        writer_packet: {
          issue_span_gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
          gl_quote: 'Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth',
        },
        prompt: 'Reference: 39:1\nQuote (scoped): Let me guard my ways from sinning with my tongue Let me guard a muzzle for my mouth\nULT verse: ...',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '39:1': [
      { eng: 'Let', heb: 'אֶֽשְׁמְרָ֣ה' },
      { eng: 'me', heb: 'אֶֽשְׁמְרָ֣ה' },
      { eng: 'guard', heb: 'אֶֽשְׁמְרָ֣ה' },
      { eng: 'my', heb: 'דְרָכַ⁠י֮' },
      { eng: 'ways', heb: 'דְרָכַ⁠י֮' },
      { eng: 'from', heb: 'מֵ⁠חֲט֪וֹא' },
      { eng: 'sinning', heb: 'מֵ⁠חֲט֪וֹא' },
      { eng: 'with', heb: 'בִ⁠לְשׁ֫וֹנִ֥⁠י' },
      { eng: 'my', heb: 'בִ⁠לְשׁ֫וֹנִ֥⁠י' },
      { eng: 'tongue', heb: 'בִ⁠לְשׁ֫וֹנִ֥⁠י' },
      { eng: 'Let', heb: 'אֶשְׁמְרָ֥ה' },
      { eng: 'me', heb: 'אֶשְׁמְרָ֥ה' },
      { eng: 'guard', heb: 'אֶשְׁמְרָ֥ה' },
      { eng: 'a', heb: 'מַחְס֑וֹם' },
      { eng: 'muzzle', heb: 'מַחְס֑וֹם' },
      { eng: 'for', heb: 'לְ⁠פִ֥⁠י' },
      { eng: 'my', heb: 'לְ⁠פִ֥⁠י' },
      { eng: 'mouth', heb: 'לְ⁠פִ֥⁠י' },
    ],
  }, null, 2));

  const summary = _resolveGlQuotes({ preparedJson: prepRel, alignmentJson: alignRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));
  const item = prepared.items.find((row) => row.id === 'p123');

  assert.match(summary, /Updated 1 gl_quotes/);
  assert.equal(item.issue_span_gl_quote, 'Let me guard a muzzle for my mouth');
  assert.equal(item.exact_ult_span, 'Let me guard a muzzle for my mouth');
  assert.equal(item.writer_packet.issue_span_gl_quote, 'Let me guard a muzzle for my mouth');
  assert.match(item.prompt, /Quote \(scoped\): Let me guard a muzzle for my mouth/);
});

test('resolveGlQuotes keeps the current scope when repeated later occurrences are ambiguous', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-resolvegl-amb-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    items: [
      {
        id: 'a123',
        reference: '1:1',
        sref: 'figs-metaphor',
        gl_quote: 'word',
        issue_span_gl_quote: 'word',
        orig_quote: 'דָבָר',
        writer_packet: {
          issue_span_gl_quote: 'word',
          gl_quote: 'word',
        },
        prompt: 'Reference: 1:1\nQuote (scoped): word\nULT verse: ...',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '1:1': [
      { eng: 'word', heb: 'דָבָר' },
      { eng: 'and', heb: 'ו' },
      { eng: 'word', heb: 'דָבָר' },
    ],
  }, null, 2));

  const summary = _resolveGlQuotes({ preparedJson: prepRel, alignmentJson: alignRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));
  const item = prepared.items.find((row) => row.id === 'a123');

  assert.match(summary, /Updated 0 gl_quotes/);
  assert.equal(item.issue_span_gl_quote, 'word');
  assert.equal(item.exact_ult_span, 'word');
  assert.match(item.prompt, /Quote \(scoped\): word/);
});

test('fillOrigQuotes keeps repeated stopwords from widening Hebrew spans', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-fillquote-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'ZEC',
    items: [
      {
        id: 'wa9j',
        reference: '3:2',
        sref: 'figs-metaphor',
        gl_quote: 'a firebrand rescued from the fire',
        issue_span_gl_quote: 'a firebrand rescued from the fire',
        orig_quote: '',
        explanation: '',
      },
      {
        id: 'tequ',
        reference: '3:8',
        sref: 'figs-idiom',
        gl_quote: 'men of a sign',
        issue_span_gl_quote: 'men of a sign',
        orig_quote: '',
        explanation: '',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:2': [
      { eng: 'And', heb: 'וַ⁠יֹּ֨אמֶר' },
      { eng: 'Yahweh', heb: 'יְהוָ֜ה' },
      { eng: 'said', heb: 'וַ⁠יֹּ֨אמֶר' },
      { eng: 'to', heb: 'אֶל' },
      { eng: 'the', heb: 'הַ⁠שָּׂטָ֗ן' },
      { eng: 'adversary', heb: 'הַ⁠שָּׂטָ֗ן' },
      { eng: 'May', heb: 'יִגְעַ֨ר' },
      { eng: 'Yahweh', heb: 'יְהוָ֤ה' },
      { eng: 'rebuke', heb: 'יִגְעַ֨ר' },
      { eng: 'you', heb: 'בְּ⁠ךָ֙' },
      { eng: 'the', heb: 'הַ⁠שָּׂטָ֔ן' },
      { eng: 'adversary', heb: 'הַ⁠שָּׂטָ֔ן' },
      { eng: 'and', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'may', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'Yahweh', heb: 'יְהוָה֙' },
      { eng: 'who', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'is', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'choosing', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'Jerusalem', heb: 'בִּ⁠ירֽוּשָׁלִָ֑ם' },
      { eng: 'rebuke', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'you', heb: 'בְּ⁠ךָ֔' },
      { eng: 'Is', heb: 'הֲ⁠ל֧וֹא' },
      { eng: 'this', heb: 'זֶ֦ה' },
      { eng: 'not', heb: 'הֲ⁠ל֧וֹא' },
      { eng: 'a', heb: 'א֖וּד' },
      { eng: 'firebrand', heb: 'א֖וּד' },
      { eng: 'rescued', heb: 'מֻצָּ֥ל' },
      { eng: 'from', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'the', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'fire', heb: 'מֵ⁠אֵֽשׁ' },
    ],
    '3:8': [
      { eng: 'Hear', heb: 'שְֽׁמַֽע' },
      { eng: 'now', heb: 'נָ֞א' },
      { eng: 'Joshua', heb: 'יְהוֹשֻׁ֣עַ' },
      { eng: 'the', heb: 'הַ⁠גָּד֗וֹל' },
      { eng: 'high', heb: 'הַ⁠גָּד֗וֹל' },
      { eng: 'priest', heb: 'הַ⁠גָּד֗וֹל' },
      { eng: 'you', heb: 'אַתָּה֙' },
      { eng: 'and', heb: 'וְ⁠רֵעֶ֨י⁠ךָ֙' },
      { eng: 'your', heb: 'וְ⁠רֵעֶ֨י⁠ךָ֙' },
      { eng: 'companions', heb: 'וְ⁠רֵעֶ֨י⁠ךָ֙' },
      { eng: 'who', heb: 'הַ⁠יֹּשְׁבִ֣ים' },
      { eng: 'are', heb: 'הַ⁠יֹּשְׁבִ֣ים' },
      { eng: 'sitting', heb: 'הַ⁠יֹּשְׁבִ֣ים' },
      { eng: 'to', heb: 'לְ⁠פָנֶ֔י⁠ךָ' },
      { eng: 'the', heb: 'לְ⁠פָנֶ֔י⁠ךָ' },
      { eng: 'face', heb: 'לְ⁠פָנֶ֔י⁠ךָ' },
      { eng: 'of', heb: 'לְ⁠פָנֶ֔י⁠ךָ' },
      { eng: 'you', heb: 'לְ⁠פָנֶ֔י⁠ךָ' },
      { eng: 'for', heb: 'כִּֽי' },
      { eng: 'they', heb: 'הֵ֑מָּה' },
      { eng: 'are', heb: 'הֵ֑מָּה' },
      { eng: 'men', heb: 'אַנְשֵׁ֥י' },
      { eng: 'of', heb: 'אַנְשֵׁ֥י' },
      { eng: 'a', heb: 'מוֹפֵ֖ת' },
      { eng: 'sign', heb: 'מוֹפֵ֖ת' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 2 \\w וַ⁠יֹּ֨אמֶר|x\\w* \\w יְהוָ֜ה|x\\w* \\w אֶל|x\\w* \\w הַ⁠שָּׂטָ֗ן|x\\w* \\w יִגְעַ֨ר|x\\w* \\w יְהוָ֤ה|x\\w* \\w בְּ⁠ךָ֙|x\\w* \\w הַ⁠שָּׂטָ֔ן|x\\w* \\w וְ⁠יִגְעַ֤ר|x\\w* \\w יְהוָה֙|x\\w* \\w הַ⁠בֹּחֵ֖ר|x\\w* \\w בִּ⁠ירֽוּשָׁלִָ֑ם|x\\w* \\w הֲ⁠ל֧וֹא|x\\w* \\w זֶ֦ה|x\\w* \\w א֖וּד|x\\w* \\w מֻצָּ֥ל|x\\w* \\w מֵ⁠אֵֽשׁ|x\\w*',
    '\\v 8 \\w שְֽׁמַֽע|x\\w* \\w נָ֞א|x\\w* \\w יְהוֹשֻׁ֣עַ|x\\w* \\w הַ⁠גָּד֗וֹל|x\\w* \\w אַתָּה֙|x\\w* \\w וְ⁠רֵעֶ֨י⁠ךָ֙|x\\w* \\w הַ⁠יֹּשְׁבִ֣ים|x\\w* \\w לְ⁠פָנֶ֔י⁠ךָ|x\\w* \\w כִּֽי|x\\w* \\w הֵ֑מָּה|x\\w* \\w אַנְשֵׁ֥י|x\\w* \\w מוֹפֵ֖ת|x\\w*',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({ preparedJson: prepRel, alignmentJson: alignRel, hebrewUsfm: hebRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));
  const firebrand = prepared.items.find((item) => item.id === 'wa9j');
  const sign = prepared.items.find((item) => item.id === 'tequ');

  assert.match(summary, /Resolved: 2 of 2 items/);
  assert.equal(firebrand.orig_quote, 'א֖וּד מֻצָּ֥ל מֵ⁠אֵֽשׁ');
  assert.equal(sign.orig_quote, 'אַנְשֵׁ֥י מוֹפֵ֖ת');
});

test('fillOrigQuotes avoids anchoring rhetorical questions on earlier weak auxiliaries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-rquestion-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'ZEC',
    items: [
      {
        id: 'm3n0',
        reference: '3:2',
        sref: 'figs-rquestion',
        gl_quote: 'Is this not a firebrand rescued from the fire?',
        issue_span_gl_quote: 'Is this not a firebrand rescued from the fire?',
        orig_quote: '',
        explanation: 'rhetorical - asserts affirmative answer',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:2': [
      { eng: 'And', heb: 'וַ⁠יֹּאמֶר' },
      { eng: 'Yahweh', heb: 'יְהוָ֜ה' },
      { eng: 'said', heb: 'וַ⁠יֹּאמֶר' },
      { eng: 'to', heb: 'אֶל' },
      { eng: 'the', heb: 'הַ⁠שָּׂטָ֗ן' },
      { eng: 'adversary', heb: 'הַ⁠שָּׂטָ֗ן' },
      { eng: 'May', heb: 'יִגְעַ֨ר' },
      { eng: 'Yahweh', heb: 'יְהוָ֤ה' },
      { eng: 'rebuke', heb: 'יִגְעַ֨ר' },
      { eng: 'you', heb: 'בְּ⁠ךָ֙' },
      { eng: 'the', heb: 'הַ⁠שָּׂטָ֔ן' },
      { eng: 'adversary', heb: 'הַ⁠שָּׂטָ֔ן' },
      { eng: 'and', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'may', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'Yahweh', heb: 'יְהוָה֙' },
      { eng: 'who', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'is', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'choosing', heb: 'הַ⁠בֹּחֵ֖ר' },
      { eng: 'Jerusalem', heb: 'בִּ⁠ירֽוּשָׁלִָ֑ם' },
      { eng: 'rebuke', heb: 'וְ⁠יִגְעַ֤ר' },
      { eng: 'you', heb: 'בְּ⁠ךָ֔' },
      { eng: 'Is', heb: 'הֲ⁠ל֧וֹא' },
      { eng: 'this', heb: 'זֶ֦ה' },
      { eng: 'not', heb: 'הֲ⁠ל֧וֹא' },
      { eng: 'a', heb: 'א֖וּד' },
      { eng: 'firebrand', heb: 'א֖וּד' },
      { eng: 'rescued', heb: 'מֻצָּ֥ל' },
      { eng: 'from', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'the', heb: 'מֵ⁠אֵֽשׁ' },
      { eng: 'fire', heb: 'מֵ⁠אֵֽשׁ' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 2 \\w וַ⁠יֹּאמֶר|x\\w* \\w יְהוָ֜ה|x\\w* \\w אֶל|x\\w* \\w הַ⁠שָּׂטָ֗ן|x\\w* \\w יִגְעַ֨ר|x\\w* \\w יְהוָ֤ה|x\\w* \\w בְּ⁠ךָ֙|x\\w* \\w הַ⁠שָּׂטָ֔ן|x\\w* \\w וְ⁠יִגְעַ֤ר|x\\w* \\w יְהוָה֙|x\\w* \\w הַ⁠בֹּחֵ֖ר|x\\w* \\w בִּ⁠ירֽוּשָׁלִָ֑ם|x\\w* \\w הֲ⁠ל֧וֹא|x\\w* \\w זֶ֦ה|x\\w* \\w א֖וּד|x\\w* \\w מֻצָּ֥ל|x\\w* \\w מֵ⁠אֵֽשׁ|x\\w*',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({ preparedJson: prepRel, alignmentJson: alignRel, hebrewUsfm: hebRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));
  const question = prepared.items.find((item) => item.id === 'm3n0');

  assert.match(summary, /Resolved: 1 of 1 items/);
  assert.equal(question.orig_quote, 'הֲ⁠ל֧וֹא זֶ֦ה א֖וּד מֻצָּ֥ל מֵ⁠אֵֽשׁ');
});

test('fillOrigQuotes narrows Psalm 40:12 quotes instead of overexpanding repeated weak pronouns', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-psa40-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'PSA',
    items: [
      {
        id: 'c6b2',
        reference: '40:12',
        sref: 'figs-metaphor',
        gl_quote: 'Troubles that cannot be numbered surround me',
        issue_span_gl_quote: 'Troubles that cannot be numbered surround me',
        orig_quote: '',
        explanation: 'Here troubles are spoken of as if they were objects that surround and trap the speaker.',
      },
      {
        id: 'ra9w',
        reference: '40:12',
        sref: 'figs-litotes',
        gl_quote: 'that cannot be numbered',
        issue_span_gl_quote: 'that cannot be numbered',
        orig_quote: '',
        explanation: 'This is stated in negative form to intensify the number.',
      },
      {
        id: 'qng1',
        reference: '40:12',
        sref: 'figs-personification',
        gl_quote: 'have caught up with me',
        issue_span_gl_quote: 'have caught up with me',
        orig_quote: '',
        explanation: 'The writer’s iniquities are spoken of as if they were his enemies who were harming him.',
      },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '40:12': [
      { eng: 'Troubles', heb: 'רָע֡וֹת' },
      { eng: 'that', heb: 'כִּ֤י' },
      { eng: 'cannot', heb: 'אֵ֬ין' },
      { eng: 'be', heb: 'מִסְפָּ֗ר' },
      { eng: 'numbered', heb: 'מִסְפָּ֗ר' },
      { eng: 'surround', heb: 'אָפְפ֥וּ' },
      { eng: 'me', heb: 'עָצְמ֥וּ' },
      { eng: 'my', heb: 'עֲ֭וֺנֹתַ⁠י' },
      { eng: 'iniquities', heb: 'עֲ֭וֺנֹתַ⁠י' },
      { eng: 'have', heb: 'עַד' },
      { eng: 'caught', heb: 'עַד' },
      { eng: 'up', heb: 'עָלַ֨⁠י' },
      { eng: 'with', heb: 'הִשִּׂיג֣וּ⁠נִי' },
      { eng: 'me', heb: 'הִשִּׂיג֣וּ⁠נִי' },
      { eng: 'so', heb: 'הִשִּׂיג֣וּ⁠נִי' },
      { eng: 'that', heb: 'הִשִּׂיג֣וּ⁠נִי' },
      { eng: 'I', heb: 'וְ⁠לֹא' },
      { eng: 'am', heb: 'וְ⁠לֹא' },
      { eng: 'no', heb: 'וְ⁠לֹא' },
      { eng: 'longer', heb: 'וְ⁠לֹא' },
      { eng: 'able', heb: 'יָכֹ֣לְתִּי' },
      { eng: 'to', heb: 'לִ⁠רְא֑וֹת' },
      { eng: 'see', heb: 'לִ⁠רְא֑וֹת' },
      { eng: 'anything', heb: 'לִ⁠רְא֑וֹת' },
      { eng: 'they', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'are', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'more', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'than', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'the', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'hairs', heb: 'מִ⁠שַּֽׂעֲר֥וֹת' },
      { eng: 'on', heb: 'רֹ֝אשִׁ֗⁠י' },
      { eng: 'my', heb: 'רֹ֝אשִׁ֗⁠י' },
      { eng: 'head', heb: 'רֹ֝אשִׁ֗⁠י' },
      { eng: 'and', heb: 'וְ⁠לִבִּ֥⁠י' },
      { eng: 'my', heb: 'וְ⁠לִבִּ֥⁠י' },
      { eng: 'heart', heb: 'וְ⁠לִבִּ֥⁠י' },
      { eng: 'has', heb: 'עֲזָבָֽ⁠נִי' },
      { eng: 'failed', heb: 'עֲזָבָֽ⁠נִי' },
      { eng: 'me', heb: 'עֲזָבָֽ⁠נִי' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id PSA',
    '\\c 40',
    '\\v 12',
    '\\w כִּ֤י|x\\w*',
    '\\w אָפְפ֥וּ|x\\w*־\\w עָלַ֨⁠י|x\\w* ׀',
    '\\w רָע֡וֹת|x\\w*',
    '\\w עַד|x\\w*־\\w אֵ֬ין|x\\w*',
    '\\w מִסְפָּ֗ר|x\\w*',
    '\\w הִשִּׂיג֣וּ⁠נִי|x\\w*',
    '\\w עֲ֭וֺנֹתַ⁠י|x\\w*',
    '\\w וְ⁠לֹא|x\\w*־\\w יָכֹ֣לְתִּי|x\\w*',
    '\\w לִ⁠רְא֑וֹת|x\\w*',
    '\\w עָצְמ֥וּ|x\\w*',
    '\\w מִ⁠שַּֽׂעֲר֥וֹת|x\\w*',
    '\\w רֹ֝אשִׁ֗⁠י|x\\w*',
    '\\w וְ⁠לִבִּ֥⁠י|x\\w*',
    '\\w עֲזָבָֽ⁠נִי|x\\w*׃',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({ preparedJson: prepRel, alignmentJson: alignRel, hebrewUsfm: hebRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));

  assert.match(summary, /Resolved: 3 of 3 items/);
  assert.equal(prepared.items.find((item) => item.id === 'c6b2').orig_quote, 'כִּ֤י אָפְפ֥וּ & רָע֡וֹת & אֵ֬ין מִסְפָּ֗ר & עָצְמ֥וּ');
  assert.equal(prepared.items.find((item) => item.id === 'ra9w').orig_quote, 'כִּ֤י & אֵ֬ין מִסְפָּ֗ר');
  assert.equal(prepared.items.find((item) => item.id === 'qng1').orig_quote, 'עָלַ֨⁠י & עַד & הִשִּׂיג֣וּ⁠נִי');
});

test('fillOrigQuotes resolves Fly ZEC 3 reordered and punctuation-bound quotes to Hebrew', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-zec3-fly-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'ZEC',
    items: [
      { id: 'aaja', reference: '3:4', sref: 'writing-quotations', gl_quote: 'And he answered and said', issue_span_gl_quote: 'And he answered and said', orig_quote: '', explanation: '' },
      { id: 'xbnr', reference: '3:7', sref: 'figs-metaphor', gl_quote: 'walk in my ways', issue_span_gl_quote: 'walk in my ways', orig_quote: '', explanation: '' },
      { id: 'u4gr', reference: '3:7', sref: 'figs-idiom', gl_quote: 'keep my charge', issue_span_gl_quote: 'keep my charge', orig_quote: '', explanation: '' },
      { id: 'oje0', reference: '3:7', sref: 'figs-metaphor', gl_quote: 'judge my house', issue_span_gl_quote: 'judge my house', orig_quote: '', explanation: '' },
      { id: 'q56l', reference: '3:9', sref: 'figs-abstractnouns', gl_quote: 'the declaration of Yahweh of Armies', issue_span_gl_quote: 'the declaration of Yahweh of Armies', orig_quote: '', explanation: '' },
      { id: 'gkzo', reference: '3:9', sref: 'writing-quotations', gl_quote: 'the declaration of Yahweh of Armies', issue_span_gl_quote: 'the declaration of Yahweh of Armies', orig_quote: '', explanation: '' },
      { id: 'hjj2', reference: '3:10', sref: 'writing-quotations', gl_quote: 'the declaration of Yahweh of Armies', issue_span_gl_quote: 'the declaration of Yahweh of Armies', orig_quote: '', explanation: '' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:4': [
      { eng: 'And', heb: 'וַ⁠יַּ֣עַן' },
      { eng: 'he', heb: 'וַ⁠יַּ֣עַן' },
      { eng: 'answered', heb: 'וַ⁠יַּ֣עַן' },
      { eng: 'and', heb: 'וַ⁠יֹּ֗אמֶר' },
      { eng: 'said', heb: 'וַ⁠יֹּ֗אמֶר' },
    ],
    '3:7': [
      { eng: '“Thus', heb: 'כֹּה' },
      { eng: 'says', heb: 'אָמַ֞ר' },
      { eng: 'Yahweh', heb: 'יְהוָ֣ה' },
      { eng: 'of', heb: 'צְבָא֗וֹת' },
      { eng: 'Armies', heb: 'צְבָא֗וֹת' },
      { eng: '‘If', heb: 'אִם' },
      { eng: 'you', heb: 'תֵּלֵךְ֙' },
      { eng: 'will', heb: 'תֵּלֵךְ֙' },
      { eng: 'walk', heb: 'תֵּלֵךְ֙' },
      { eng: 'in', heb: 'בִּ⁠דְרָכַ֤⁠י' },
      { eng: 'my', heb: 'בִּ⁠דְרָכַ֤⁠י' },
      { eng: 'ways', heb: 'בִּ⁠דְרָכַ֤⁠י' },
      { eng: 'and', heb: 'וְ⁠אִ֣ם' },
      { eng: 'if', heb: 'וְ⁠אִ֣ם' },
      { eng: 'you', heb: 'תִשְׁמֹ֔ר' },
      { eng: 'will', heb: 'תִשְׁמֹ֔ר' },
      { eng: 'keep', heb: 'תִשְׁמֹ֔ר' },
      { eng: 'my', heb: 'מִשְׁמַרְתִּ֣⁠י' },
      { eng: 'charge', heb: 'מִשְׁמַרְתִּ֣⁠י' },
      { eng: 'then', heb: 'וְ⁠גַם' },
      { eng: 'you', heb: 'אַתָּה֙' },
      { eng: 'also', heb: 'וְ⁠גַם' },
      { eng: 'will', heb: 'תָּדִ֣ין' },
      { eng: 'judge', heb: 'תָּדִ֣ין' },
      { eng: 'my', heb: 'בֵּיתִ֔⁠י' },
      { eng: 'house', heb: 'בֵּיתִ֔⁠י' },
    ],
    '3:9': [
      { eng: 'For', heb: 'כִּ֣י' },
      { eng: 'behold', heb: 'הִנֵּ֣ה' },
      { eng: 'the', heb: 'הָ⁠אֶ֗בֶן' },
      { eng: 'stone', heb: 'הָ⁠אֶ֗בֶן' },
      { eng: 'that', heb: 'אֲשֶׁ֤ר' },
      { eng: 'I', heb: 'נָתַ֨תִּי֙' },
      { eng: 'have', heb: 'נָתַ֨תִּי֙' },
      { eng: 'set', heb: 'נָתַ֨תִּי֙' },
      { eng: 'to', heb: 'לִ⁠פְנֵ֣י' },
      { eng: 'the', heb: 'לִ⁠פְנֵ֣י' },
      { eng: 'face', heb: 'לִ⁠פְנֵ֣י' },
      { eng: 'of', heb: 'לִ⁠פְנֵ֣י' },
      { eng: 'Joshua', heb: 'יְהוֹשֻׁ֔עַ' },
      { eng: 'Behold', heb: 'הִנְ⁠נִ֧י' },
      { eng: 'I', heb: 'מְפַתֵּ֣חַ' },
      { eng: 'am', heb: 'מְפַתֵּ֣חַ' },
      { eng: 'engraving', heb: 'מְפַתֵּ֣חַ' },
      { eng: 'its', heb: 'פִּתֻּחָ֗⁠הּ' },
      { eng: 'engraving—the', heb: 'פִּתֻּחָ֗⁠הּ' },
      { eng: 'declaration', heb: 'נְאֻם֙' },
      { eng: 'of', heb: 'נְאֻם֙' },
      { eng: 'Yahweh', heb: 'יְהוָ֣ה' },
      { eng: 'of', heb: 'צְבָא֔וֹת' },
      { eng: 'Armies—and', heb: 'צְבָא֔וֹת' },
    ],
    '3:10': [
      { eng: 'In', heb: 'בַּ⁠יּ֣וֹם' },
      { eng: 'that', heb: 'הַ⁠ה֗וּא' },
      { eng: 'day—the', heb: 'בַּ⁠יּ֣וֹם' },
      { eng: 'declaration', heb: 'נְאֻם֙' },
      { eng: 'of', heb: 'נְאֻם֙' },
      { eng: 'Yahweh', heb: 'יְהוָ֣ה' },
      { eng: 'of', heb: 'צְבָא֔וֹת' },
      { eng: 'Armies—you', heb: 'צְבָא֔וֹת' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 4 \\w וַ⁠יַּ֣עַן|x\\w* \\w וַ⁠יֹּ֗אמֶר|x\\w*',
    '\\v 7 \\w כֹּה|x\\w*־\\w אָמַ֞ר|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֗וֹת|x\\w* \\w אִם|x\\w*־\\w בִּ⁠דְרָכַ֤⁠י|x\\w* \\w תֵּלֵךְ֙|x\\w* \\w וְ⁠אִ֣ם|x\\w* \\w מִשְׁמַרְתִּ֣⁠י|x\\w* \\w תִשְׁמֹ֔ר|x\\w* \\w וְ⁠גַם|x\\w*־\\w אַתָּה֙|x\\w* \\w תָּדִ֣ין|x\\w* \\w בֵּיתִ֔⁠י|x\\w*',
    '\\v 9 \\w כִּ֣י|x\\w* \\w הִנֵּ֣ה|x\\w* \\w הָ⁠אֶ֗בֶן|x\\w* \\w אֲשֶׁ֤ר|x\\w* \\w נָתַ֨תִּי֙|x\\w* \\w לִ⁠פְנֵ֣י|x\\w* \\w יְהוֹשֻׁ֔עַ|x\\w* \\w הִנְ⁠נִ֧י|x\\w* \\w מְפַתֵּ֣חַ|x\\w* \\w פִּתֻּחָ֗⁠הּ|x\\w* \\w נְאֻם֙|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֔וֹת|x\\w*',
    '\\v 10 \\w בַּ⁠יּ֣וֹם|x\\w* \\w הַ⁠ה֗וּא|x\\w* \\w נְאֻם֙|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֔וֹת|x\\w*',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({ preparedJson: prepRel, alignmentJson: alignRel, hebrewUsfm: hebRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));

  assert.match(summary, /Resolved: 7 of 7 items/);
  assert.equal(prepared.items.find((item) => item.id === 'aaja').orig_quote, 'וַ⁠יַּ֣עַן וַ⁠יֹּ֗אמֶר');
  assert.equal(prepared.items.find((item) => item.id === 'xbnr').orig_quote, 'בִּ⁠דְרָכַ֤⁠י תֵּלֵךְ֙');
  assert.equal(prepared.items.find((item) => item.id === 'u4gr').orig_quote, 'מִשְׁמַרְתִּ֣⁠י תִשְׁמֹ֔ר');
  assert.equal(prepared.items.find((item) => item.id === 'oje0').orig_quote, 'תָּדִ֣ין בֵּיתִ֔⁠י');
  assert.equal(prepared.items.find((item) => item.id === 'q56l').orig_quote, 'נְאֻם֙ יְהוָ֣ה צְבָא֔וֹת');
  assert.equal(prepared.items.find((item) => item.id === 'gkzo').orig_quote, 'נְאֻם֙ יְהוָ֣ה צְבָא֔וֹת');
  assert.equal(prepared.items.find((item) => item.id === 'hjj2').orig_quote, 'נְאֻם֙ יְהוָ֣ה צְבָא֔וֹת');
});

test('fillOrigQuotes falls back to alignment-derived Hebrew when exact-source extraction fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-zec3-fallback-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'ZEC',
    items: [
      { id: 'fallback1', reference: '3:7', sref: 'figs-metaphor', gl_quote: 'walk in my ways', issue_span_gl_quote: 'walk in my ways', orig_quote: '', explanation: '' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:7': [
      { eng: 'walk', heb: 'תֵּלֵךְ֙' },
      { eng: 'in', heb: 'בִּ⁠דְרָכַ֤⁠י' },
      { eng: 'my', heb: 'בִּ⁠דְרָכַ֤⁠י' },
      { eng: 'ways', heb: 'בִּ⁠דְרָכַ֤⁠י' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 7 \\w מילהאחרת|x\\w*',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({ preparedJson: prepRel, alignmentJson: alignRel, hebrewUsfm: hebRel });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));

  assert.match(summary, /via alignment-derived Hebrew fallback/);
  assert.equal(prepared.items[0].orig_quote, 'תֵּלֵךְ֙ בִּ⁠דְרָכַ֤⁠י');
});

test('fillOrigQuotes prefers master ULT alignment when primary alignment yields a suspicious discontinuous quote', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tools-zec3-master-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const prepRel = path.join(relRoot, 'prepared_notes.json');
  const alignRel = path.join(relRoot, 'alignment.json');
  const hebRel = path.join(relRoot, 'hebrew.usfm');
  const masterRel = path.join(relRoot, 'ult-aligned.usfm');

  fs.writeFileSync(path.join('/srv/bot/workspace', prepRel), JSON.stringify({
    book: 'ZEC',
    items: [
      { id: 'master1', reference: '3:10', sref: 'writing-quotations', gl_quote: 'the declaration of Yahweh of Armies', issue_span_gl_quote: 'the declaration of Yahweh of Armies', orig_quote: '', explanation: '' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', alignRel), JSON.stringify({
    '3:10': [
      { eng: 'day-the', heb: 'בַּ⁠יּ֣וֹם' },
      { eng: 'declaration', heb: 'נְאֻם֙' },
      { eng: 'of', heb: 'נְאֻם֙' },
      { eng: 'Yahweh', heb: 'יְהוָ֣ה' },
      { eng: 'of', heb: 'תִּקְרְא֖וּ' },
      { eng: 'Armies-you', heb: 'תִּקְרְא֖וּ' },
    ],
  }, null, 2));

  fs.writeFileSync(path.join('/srv/bot/workspace', hebRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 10 \\w בַּ⁠יּ֣וֹם|x\\w* \\w הַ⁠ה֗וּא|x\\w* \\w נְאֻם֙|x\\w* \\w יְהוָ֣ה|x\\w* \\w צְבָא֔וֹת|x\\w* \\w תִּקְרְא֖וּ|x\\w*',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join('/srv/bot/workspace', masterRel), [
    '\\id ZEC',
    '\\c 3',
    '\\v 10 In that day',
    '\\zaln-s |x-content="נְאֻם֙"\\* \\w declaration|x\\w* \\zaln-e\\*',
    '\\zaln-s |x-content="יְהוָ֣ה"\\* \\w Yahweh|x\\w* \\zaln-e\\*',
    '\\zaln-s |x-content="צְבָא֔וֹת"\\* \\w Armies|x\\w* \\zaln-e\\*',
    '',
  ].join('\n'));

  const summary = fillOrigQuotes({
    preparedJson: prepRel,
    alignmentJson: alignRel,
    hebrewUsfm: hebRel,
    masterUltUsfm: masterRel,
  });
  const prepared = JSON.parse(fs.readFileSync(path.join('/srv/bot/workspace', prepRel), 'utf8'));

  assert.match(summary, /via master ULT/);
  assert.equal(prepared.items[0].orig_quote, 'נְאֻם֙ יְהוָ֣ה צְבָא֔וֹת');
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

test('substituteAT matches normalized apostrophes and discontinuous ampersand spans', () => {
  const apostropheResult = substituteAT(
    'This is the wicked person’s place.',
    "the wicked person's place",
    'the place where the wicked person lives'
  );
  assert.equal(apostropheResult, 'This is the place where the wicked person lives.');

  const discontinuousResult = substituteAT(
    'The king spoke to the people and the city rejoiced.',
    'The king & the city',
    'The ruler … the capital'
  );
  assert.equal(discontinuousResult, 'The ruler spoke to the people and the capital rejoiced.');
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
