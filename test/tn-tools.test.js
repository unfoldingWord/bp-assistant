const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  prepareNotes,
  _parseExplanationDirectives,
  _resolveTemplateSelection,
  _deriveStyleProfile,
  _buildWriterPrompt,
  _maybeBuildProgrammaticNote,
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
  assert.equal(selected.candidate_templates.length, 2);
});

test('deriveStyleProfile enforces no-at rules unless i: explicitly overrides them', () => {
  const forbidden = _deriveStyleProfile({
    sref: 'writing-background',
    mustInclude: [],
    atProvided: '',
    needsAt: true,
    selectedTemplate: { template: 'Background template.' },
  });
  assert.equal(forbidden.at_policy, 'forbidden');
  assert.ok(forbidden.style_rules.includes('no_at'));

  const overridden = _deriveStyleProfile({
    sref: 'writing-background',
    mustInclude: ['Include an alternate translation if needed'],
    atProvided: '',
    needsAt: true,
    selectedTemplate: { template: 'Background template.' },
  });
  assert.equal(overridden.at_policy, 'required');
  assert.ok(overridden.rule_overrides.includes('at_policy_from_i'));
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
  assert.deepEqual(item.must_include, ['Keep the transition natural']);
  assert.equal(item.clean_explanation, '');
  assert.ok(item.template_text.startsWith('Here the author is providing background information'));
  assert.equal(item.writer_packet.prose_mode, 'template_plus_necessity');
  assert.equal(item.writer_packet.at_policy, 'forbidden');
  assert.match(item.prompt, /Selected template:/);
  assert.match(item.prompt, /Do not add an alternate translation/);
  assert.doesNotMatch(item.prompt, /discern which particular template/i);
});
