// tn-modernize: each mechanical gate catches a seeded loss.
//
// A rewrite ships only when every gate passes. Each test starts from a good
// rewrite of a real Obadiah 1:1 note (which must pass) and seeds one loss.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { checkRewrite } = require('../scripts/tn-modernize/gates');

const candidate = {
  ID: 'jdr3',
  Reference: '1:1',
  prose: 'People are being described here by the name of something closely associated with them, **Edom**, the land that they live in. If this is not clear in your language, you could say clearly that this message is about the people. See [1:8](../01/08.md). Alternate translation: [concerning the people of Edom.]',
  ult: 'The vision of Obadiah: thus says my Lord Yahweh concerning Edom. We have heard a message from Yahweh, and a messenger has been sent off among the nations: Get up! And let us rise up against her for battle!',
  links: [],
  templates: [{
    id: 'figs-metonymy-01',
    type: 'generic',
    template: 'Here, **text** represents “WORD.” If it would be helpful in your language, you could use an equivalent expression or plain language. Alternate translation: [text]',
  }],
};
const GOOD = 'Here, **Edom** represents the people who live in the land of Edom. This message is about the people, not the land. See [1:8](../01/08.md). If it would be helpful in your language, you could use an equivalent expression or plain language. Alternate translation: [concerning the people of Edom.]';
const run = (note, template_id = 'figs-metonymy-01') => checkRewrite(candidate, { template_id, note });

test('the good rewrite passes every gate', () => {
  assert.deepEqual(run(GOOD), { failures: [], warnings: [], detail: {} });
});

test('G1: a bold span that is not ULT text fails', () => {
  const r = run(GOOD.replace('**Edom**', '**the Edomites**'));
  assert.ok(r.failures.includes('bold_not_in_ult'));
  assert.deepEqual(r.detail.bold_not_in_ult, ['the Edomites']);
});

test('G1: dropping the ULT words the old note pointed at is flagged', () => {
  const r = run(GOOD.replace('Here, **Edom** represents the people who live in the land of Edom.', 'Here, **concerning** introduces the people who live there.'));
  assert.ok(r.warnings.includes('old_span_dropped'));
});

test('G2: an alternate translation that is lost, reworded or invented fails', () => {
  assert.ok(run(GOOD.replace(' Alternate translation: [concerning the people of Edom.]', '')).failures.includes('at_lost_or_changed'));
  assert.ok(run(GOOD.replace('[concerning the people of Edom.]', '[about the people of Edom]')).failures.includes('at_lost_or_changed'));
  assert.ok(run(GOOD + ' or [about the Edomites]').failures.includes('at_invented'));
  assert.ok(run(GOOD.replace('[concerning the people of Edom.]', '“concerning the people of Edom.”')).failures.includes('at_not_bracketed'));
});

test('G3: an rc link left in the note fails', () => {
  assert.ok(run(GOOD + ' (See also: [[rc://*/ta/man/translate/figs-synecdoche]])').failures.includes('link_in_note'));
});

test('G4: a dropped name or scripture reference fails', () => {
  const r = run(GOOD.replace('the land of Edom', 'that land'));
  assert.deepEqual(r.failures, []); // Edom survives in the bold span and the AT
  const noName = checkRewrite({ ...candidate, prose: candidate.prose.replace('the land that they live in', 'the land where Esau’s descendants live') },
    { template_id: 'figs-metonymy-01', note: GOOD });
  assert.ok(noName.failures.includes('proper_noun_dropped'));
  assert.deepEqual(noName.detail.proper_noun_dropped, ['Esau']);
  assert.ok(run(GOOD.replace(' See [1:8](../01/08.md).', '')).failures.includes('reference_dropped'));
});

test('G6: a note that does not follow its template, or leaves a placeholder, fails', () => {
  const r = run(GOOD.replace('you could use an equivalent expression or plain language', 'you could say it another way'));
  assert.ok(r.failures.includes('template_phrase_missing'));
  assert.ok(run(GOOD.replace('the people who live in the land of Edom', '“WORD”')).failures.includes('placeholder_left'));
  assert.ok(run(GOOD, 'figs-metaphor-01').failures.includes('unknown_template'));
});

test('self-talk and raw newlines fail', () => {
  assert.ok(run('Wait, actually ' + GOOD).failures.includes('self_talk'));
  assert.ok(run(GOOD.replace(' If it', '\nIf it')).failures.includes('raw_newline_or_tab'));
});

test('a template with an AT the old note lacks is flagged, not filled', () => {
  const noAt = { ...candidate, prose: candidate.prose.replace(' Alternate translation: [concerning the people of Edom.]', '') };
  const r = checkRewrite(noAt, { template_id: 'figs-metonymy-01', note: GOOD.replace(' Alternate translation: [concerning the people of Edom.]', '') });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, ['template_at_omitted']);
});

test('template matching resolves choice lists and allows extra sentences between fixed ones, in order', () => {
  const { followsTemplate } = require('../scripts/tn-modernize/lib');
  const heart = 'Here the **heart** represents where a person\'s thoughts/feelings/motives/intentions/desires exist. You may have a comparable expression in your language, or you could state the meaning plainly. Alternate translation: [text]';
  assert.equal(followsTemplate('Here the **heart** represents where a person’s thoughts and feelings exist. You may have a comparable expression in your language, or you could state the meaning plainly.', heart).ok, true);
  const par = 'These two clauses mean basically the same thing. The second emphasizes the meaning of the first by repeating the same idea with different words. If it would be helpful to your readers, you could combine them and express the emphasis in another way. Alternate translation: [text]';
  assert.equal(followsTemplate('These two clauses mean basically the same thing. The second emphasizes the meaning of the first by repeating the same idea with different words. They stress that Edom will lose its status. If it would be helpful to your readers, you could combine them and express the emphasis in another way, as in the UST.', par).ok, true);
  assert.equal(followsTemplate('The second emphasizes the meaning of the first by repeating the same idea with different words. These two clauses mean basically the same thing. If it would be helpful to your readers, you could combine them and express the emphasis in another way.', par).ok, false);
  const names = '**text** is the name of a (man, people group, city, town, place, river).';
  assert.equal(followsTemplate('The word **Esau** is the name of a man who was the ancestor of the people of Edom.', names).ok, true);
});

test('review fixes: prose after an AT is still checked; unbracketed old ATs, no-op rewrites and untestable templates fail', () => {
  const tail = { ...candidate, prose: candidate.prose + ' This judgment came through Obadiah.' };
  const dropped = checkRewrite(tail, { template_id: 'figs-metonymy-01', note: GOOD + ' This judgment came through the prophet.' });
  assert.ok(dropped.failures.includes('proper_noun_dropped'), 'a name after the AT on the same line is checked');

  const quotedAt = { ...candidate, prose: candidate.prose.replace('[concerning the people of Edom.]', '“concerning the people of Edom.”') };
  assert.ok(checkRewrite(quotedAt, { template_id: 'figs-metonymy-01', note: GOOD }).failures.includes('old_at_unbracketed'));

  const same = { ...candidate, Note: GOOD };
  assert.deepEqual(checkRewrite(same, { template_id: 'figs-metonymy-01', note: GOOD }).failures, ['no_change']);

  const short = { ...candidate, templates: [{ id: 'x-01', type: '', template: 'SPEAKER says **text**. Alternate translation: [text]' }] };
  assert.ok(checkRewrite(short, { template_id: 'x-01', note: GOOD }).failures.includes('template_untestable'));
});

test('a dropped See link passes only when its information is carried elsewhere', () => {
  const linked = (covered) => ({ ...candidate, links: [{ kind: 'see-also-ta', targets: ['rc://*/ta/man/translate/figs-synecdoche'], covered }] });
  assert.deepEqual(checkRewrite(linked(true), { template_id: 'figs-metonymy-01', note: GOOD }).failures, []);
  assert.ok(checkRewrite(linked(false), { template_id: 'figs-metonymy-01', note: GOOD }).failures.includes('link_not_covered'));
  assert.ok(checkRewrite(linked(null), { template_id: 'figs-metonymy-01', note: GOOD }).failures.includes('link_not_covered'), 'no twl data means not covered');
});

test('a name the old note lacks fails unless the verse has it, which only flags the row', () => {
  const inferred = run(GOOD.replace('Here, **Edom** represents', 'Here Isaiah says **Edom** represents'));
  assert.ok(inferred.failures.includes('name_added'));
  assert.deepEqual(inferred.detail.name_added, ['Isaiah']);
  const fromVerse = run(GOOD.replace('This message is about', 'This message from Yahweh is about'));
  assert.deepEqual(fromVerse.failures, []);
  assert.ok(fromVerse.warnings.includes('name_from_verse'));
});

test('a book name that opens a sentence is caught as added', () => {
  const r = checkRewrite(candidate, { template_id: 'figs-metonymy-01', note: 'Obadiah says this. ' + GOOD }, { names: new Set(['Obadiah', 'Edom', 'Yahweh']) });
  assert.ok(r.warnings.includes('name_from_verse'), 'Obadiah is in this verse, so it is flagged, not failed');
  const r2 = checkRewrite(candidate, { template_id: 'figs-metonymy-01', note: 'Esau says this. ' + GOOD }, { names: new Set(['Esau']) });
  assert.ok(r2.failures.includes('name_added'));
});

test('a name from the template wording is flagged, not failed', () => {
  const withGod = { ...candidate, templates: [{ ...candidate.templates[0], template: candidate.templates[0].template.replace('If it would', 'God is named here. If it would') }] };
  const r = checkRewrite(withGod, { template_id: 'figs-metonymy-01', note: GOOD.replace('If it would', 'God is named here. If it would') }, { names: new Set(['God']) });
  assert.ok(!r.failures.includes('name_added'));
  assert.ok(r.warnings.includes('name_from_template'));
});

test('template example text counts as a placeholder: a filled template passes, a kept example fails (#480)', () => {
  const { followsTemplate } = require('../scripts/tn-modernize/lib');
  const blessing = 'SPEAKER is asking God to bless Person. In your translation, use a form that people would recognize as a blessing in your language. You might express this as a prayer, if that would be more natural in your language. Alternate translation: [text]';
  const blessed = 'Boaz is asking God to bless the reapers when he says **Yahweh be with you**. This was a customary greeting. In your translation, use a form that people would recognize as a blessing in your language. You might express this as a prayer, if that would be more natural in your language.';
  assert.equal(followsTemplate(blessed, blessing).ok, false, 'without the sheet id the example word is literal, as in check #25');
  assert.equal(followsTemplate(blessed, blessing, 'translate-blessing-01').ok, true);

  const plural = 'The word **you** is plural here because Ehud is addressing the Israelites, so use the plural form in your translation if your language marks that distinction.';
  assert.equal(followsTemplate('The word **you** is plural here because Naomi is speaking to both of her daughters-in-law, so use the plural form.', plural, 'figs-yousingular-01').ok, true);
  const turn = 'SPEAKER is speaking as if the Israelites had been walking behind God but then **turned** away to walk in a different direction from him. He means that they stopped living in the manner in which God wants people to live. If it would be helpful in your language, you could state the meaning plainly. Alternate translation: [text]';
  assert.equal(followsTemplate('Naomi is speaking as if Orpah had been walking with her but then **turned back**.', turn, 'figs-metaphor-09').ok, true);
  const rock = 'David is speaking of Yahweh as if he were a high **rock** that he could climb up to reach safety from danger. If this image communicates well in your language, please use it. If not, you could express this as a comparison. Alternate translation: [Yahweh is like a rock to me]';
  assert.equal(followsTemplate('Boaz is speaking of Yahweh as if he were a bird that protects its young under its **wings**. If this image communicates well in your language, please use it. If not, you could express this as a comparison.', rock, 'figs-metaphor-02').ok, true);
  // Underscored ALL-CAPS placeholders need no sheet id.
  const symaction = 'ACTION_DESCRIPTION_NOT_QUOTE was a symbolic action by which PERSON showed SIGNIFICANCE. If it would be helpful to your readers, you could explain the significance of this action in the text of your translation or in a footnote. Alternate translation: [text]';
  assert.equal(followsTemplate('Taking off a sandal was a symbolic action by which a man showed that he gave up his right to redeem.', symaction).ok, true);

  const ruth = {
    ID: 'ab12', Reference: '2:4', links: [],
    prose: 'Boaz greets the reapers with the words **Yahweh be with you**. This was a customary greeting.',
    ult: 'And behold, Boaz came from Bethlehem, and he said to the reapers, “Yahweh be with you!” And they said to him, “May Yahweh bless you!”',
    templates: [
      { id: 'translate-blessing-01', type: '', template: blessing },
      { id: 'translate-symaction-01', type: '', template: symaction },
    ],
  };
  const good = checkRewrite(ruth, { template_id: 'translate-blessing-01', note: blessed });
  assert.ok(!good.failures.includes('template_phrase_missing') && !good.failures.includes('placeholder_left'), JSON.stringify(good));
  const kept = checkRewrite(ruth, { template_id: 'translate-blessing-01', note: blessed.replace('the reapers when', 'Person when') });
  assert.ok(kept.failures.includes('placeholder_left'));
  assert.deepEqual(kept.detail.placeholder_left, ['Person']);
  const keptCaps = checkRewrite(ruth, { template_id: 'translate-symaction-01', note: 'ACTION_DESCRIPTION_NOT_QUOTE was a symbolic action by which Boaz greeted **the reapers**.' });
  assert.ok(keptCaps.failures.includes('placeholder_left'));
  assert.deepEqual(keptCaps.detail.placeholder_left, ['ACTION_DESCRIPTION_NOT_QUOTE']);
});
