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

test('#480: template example words match any filling, and copying one unreplaced fails', () => {
  const { followsTemplate } = require('../scripts/tn-modernize/lib');
  const blessing = 'SPEAKER is asking God to bless Person. In your translation, use a form that people would recognize as a blessing in your language. You might express this as a prayer, if that would be more natural in your language. Alternate translation: [text]';
  assert.equal(followsTemplate('Naomi is asking God to bless Orpah and Ruth. In your translation, use a form that people would recognize as a blessing in your language. You might express this as a prayer, if that would be more natural in your language.', blessing).ok, true);
  const pronoun = 'John is using the pronoun **himself** to emphasize THING. Use a way that is natural in your language to indicate this emphasis. Alternate translation: [text]';
  assert.equal(followsTemplate('Boaz is using the pronoun **myself** to emphasize that he was committed. Use a way that is natural in your language to indicate this emphasis.', pronoun).ok, true);
  const order = 'If it would be more natural in your language, you may want to put the information about X with/before the information about Y. Alternate translation: [text]';
  assert.equal(followsTemplate('If it would be more natural in your language, you may want to put the information about dipping the bread before the information about eating it.', order).ok, true);
  const third = 'SPEAKER is speaking of himself in the third person as **text**. If it would be helpful, you could use the first person.';
  assert.equal(followsTemplate('Ruth is speaking of herself in the third person as **your female servant**. If it would be helpful, you could use the first person.', third).ok, true);
  const sym = 'ACTION_DESCRIPTION_NOT_QUOTE was a symbolic action by which SPEAKER showed MEANING. If it would be helpful to your readers, you could explain the significance of this action.';
  assert.equal(followsTemplate('Falling **on her face** was a symbolic action by which she showed respect. If it would be helpful to your readers, you could explain the significance of this action.', sym).ok, true);
  // Fixed wording around an example still has to be there: "to convince" is not "for".
  const rq = 'SPEAKER is using the question form for PURPOSE. If a speaker of your language would not use the question form for that purpose, you could translate this as a statement.';
  assert.equal(followsTemplate('Naomi is using the question form to convince them. If a speaker of your language would not use the question form for that purpose, you could translate this as a statement.', rq).ok, false);

  const tpl = { id: 'translate-blessing-01', type: '', template: blessing };
  const c = { ...candidate, prose: 'Naomi is asking God to bless Orpah and Ruth. Use a natural form for a blessing.', ult: 'May Yahweh do covenant faithfulness with you', links: [], templates: [tpl] };
  const left = checkRewrite(c, { template_id: tpl.id, note: 'Naomi is asking God to bless Person. In your translation, use a form that people would recognize as a blessing in your language. You might express this as a prayer, if that would be more natural in your language.' });
  assert.ok(left.failures.includes('placeholder_left'), left.failures.join(','));
});

test('Benjamin 2026-10-19: a qualifier inside the fixed wording, "phrase" for "word", and measurement figures pass', () => {
  const lib = require('../scripts/tn-modernize/lib.js');
  const follows = (id, note) => {
    const t = lib.templatesFor(id.replace(/-\d+$/, '')).find((x) => x.id === id);
    return lib.followsTemplate(note, t.template, id).ok;
  };
  assert.ok(follows('grammar-connect-logic-contrast-01', 'The author uses the word **But** here to indicate a strong contrast between what Naomi said and what they say.'));
  assert.ok(follows('translate-symaction-01', 'To **uncover his feet** means x. This action by a woman was probably a symbolic action by which she proposed marriage.'));
  assert.ok(!follows('grammar-connect-logic-contrast-01', 'The author uses the word **But** here to indicate a very strong and sharp contrast between them.'));
  assert.ok(follows('writing-newevent-01', 'The author is using the phrase translated as **Now it happened** to introduce a new event in the story. Use a word, phrase, or other method in your language that is natural for introducing a new event.'));
  assert.ok(follows('translate-bvolume-01', 'An **ephah** is about 22 liters. If it would be helpful to your readers, you could express this in terms of modern measurements, either in the text or in a footnote.'));
  assert.ok(!follows('translate-bvolume-01', 'An **ephah** is about 22 liters. Use the normal measurement for grain in your language.'));
  assert.ok(follows('figs-activepassive-01', 'The expressions **be conformed** and **be transformed** are passive verbal forms. If it would be unnatural to use that form, you could express the idea in active form or in another way that is natural in your language.'));
});

test('a claim only one judge doubts ships for review; one both doubt is held', () => {
  const { claimVerdict } = require('../scripts/tn-modernize/claims.js');
  const claims = ['a', 'b'];
  assert.deepStrictEqual(claimVerdict(claims, [0.9, 0.5], 0.8, [0.9, 0.85]), { pass: true, missing: [], split: ['b'] });
  assert.deepStrictEqual(claimVerdict(claims, [0.9, 0.5], 0.8, [0.9, 0.6]), { pass: false, missing: ['b'], split: [] });
  assert.strictEqual(claimVerdict(claims, [0.9, 0.5], 0.8).pass, false);
});
