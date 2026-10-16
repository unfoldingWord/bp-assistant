// gates.js — the mechanical "no information lost" gates for one rewritten note.
//
// checkRewrite(candidate, proposal) -> { failures: [code...], warnings: [code...], detail: {} }
//   candidate: a rows.js Candidate (prose, ult, templates, links)
//   proposal:  { template_id, note } from the model
// Any failure means the row ships unchanged. Warnings ship the row but put it
// at the top of the review report. The claim check (claims.js) is the one gate
// that needs a model; it is applied separately and only to rows that pass here.

'use strict';

const path = require('path');
const { followsTemplate, templateExamples, exampleRe } = require('./lib.js');
const { detectSelfTalk } = require(path.join(__dirname, '../../src/workspace-tools/quality-tools'));

const ws = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// One "Alternate translation:" with its [bracket] options, each optionally
// labelled ("(1) [...]"), joined by "or". Only this span is AT text: prose after
// it on the same line stays visible to the bold, name and reference checks.
const AT_SPAN_RE = /Alternate translation:\s*(?:\([^)]*\)\s*)?\[[^\]]*\](?:\s*,?\s*or\s+(?:\([^)]*\)\s*)?\[[^\]]*\])*/g;

/** [text] contents of every alternate translation, in order. */
function ats(note) {
  const out = [];
  for (const m of String(note).matchAll(AT_SPAN_RE)) {
    for (const b of m[0].matchAll(/\[([^\]]*)\]/g)) out.push(b[1]);
  }
  return out;
}

/** "Alternate translation:" markers not followed by a [bracket] option. */
function unbracketedAts(note) {
  const markers = (String(note).match(/Alternate translation:/g) || []).length;
  return markers - (String(note).match(AT_SPAN_RE) || []).length;
}

/** The note with every AT span removed, so prose checks never see AT text. */
function proseOnly(note) {
  return String(note).replace(AT_SPAN_RE, ' ');
}

const bolds = (note) => [...proseOnly(note).matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
const curlyQuoted = (note) => [...proseOnly(note).matchAll(/“([^“”]+)”/g)].map((m) => m[1]);

// Words a rewrite may legitimately drop or swap: the style guide replaces
// "Hebrew"/"Greek"/"Aramaic" with "the original language", and these open or
// structure template sentences rather than carry content.
const CAP_EXEMPT = new Set(['I', 'Hebrew', 'Greek', 'Aramaic', 'ULT', 'UST', 'Alternate', 'If', 'Here', 'This', 'The', 'These',
  'It', 'In', 'You', 'Your', 'See', 'Use', 'A', 'An', 'So', 'Or', 'And', 'But', 'For', 'When', 'As', 'There', 'That', 'They',
  'He', 'She', 'We', 'His', 'Her', 'Their', 'Some', 'Many', 'Other', 'Translate', 'Consider',
  'Therefore', 'Now', 'Then', 'Will', 'On', 'Having', 'Behold', 'Look', 'Let', 'May', 'Do', 'Who', 'What', 'Why', 'How']);

const midSentenceCaps = (text) => [...text.matchAll(/(?<=[^.!?:\s]\s+|[,;(]\s*)([A-Z][a-z]+)\b/g)].map((m) => m[1]);

/**
 * Names and titles in the old prose (bold, AT and quoted text masked): words
 * capitalized mid-sentence, plus sentence-initial capitalized words the ULT
 * itself capitalizes mid-sentence (so "Obadiah is speaking..." counts).
 */
function properNouns(prose, ult = '') {
  const text = proseOnly(prose).replace(/\*\*[^*]+\*\*/g, ' . ').replace(/“[^“”]*”/g, ' . ').replace(/\\n/g, ' . ');
  const ultNames = new Set(midSentenceCaps(String(ult)));
  const out = new Set(midSentenceCaps(text));
  for (const w of text.match(/\b[A-Z][a-z]+\b/g) || []) if (ultNames.has(w)) out.add(w);
  return [...out].filter((w) => !CAP_EXEMPT.has(w));
}

/** Scripture links ([3:3](../03/03.md)), bare chapter:verse refs, and URLs. */
function references(note) {
  const s = String(note);
  const links = s.match(/\[[^\]]*\d+:\d+[^\]]*\]\([^)]*\)/g) || [];
  const bare = s.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').match(/\b\d+:\d+(?:[-–]\d+)?\b/g) || [];
  const urls = (s.match(/https?:\/\/[^\s)\]]+/g) || []).map((u) => u.replace(/[.,;:]+$/, ''));
  return [...links, ...bare, ...urls];
}

/**
 * Template placeholders left unfilled: ALL-CAPS ones (SPEAKER, POINT OF
 * COMPARISON, ACTION_DESCRIPTION_NOT_QUOTE), "_______" blanks, bracket stubs,
 * and the template's example text (lib.js TEMPLATE_EXAMPLES) that neither the
 * old note nor the verse carries.
 */
function leftoverPlaceholders(note, tpl, candidate) {
  const caps = /\b[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;
  const known = new Set((tpl.template.match(caps) || []));
  const context = `${candidate.prose} ${candidate.ult}`;
  const prose = proseOnly(note);
  const left = (prose.match(caps) || []).filter((w) => known.has(w) && !context.includes(w));
  if (/_{2,}/.test(tpl.template) && /_{2,}/.test(prose)) left.push('_____');
  for (const span of templateExamples(tpl.id)) {
    if (exampleRe(span).test(prose) && !exampleRe(span).test(context)) left.push(span);
  }
  if (/\[(text|other_metaphor|non-metaphor|ALT|AT)\]/i.test(note)) left.push('[stub]');
  return left;
}

function quotePairProblem(atText, boldText) {
  // The AT carries only the part of the quote it replaces, so one mark alone is
  // normal. Flag only when the quoted ULT words hold both marks of a pair and
  // the AT holds exactly one of them.
  const both = (s, o, c) => s.includes(o) && s.includes(c);
  const one = (s, o, c) => s.includes(o) !== s.includes(c);
  return both(boldText, '“', '”') && one(atText, '“', '”');
}

/**
 * checkRewrite(candidate, proposal, { names }) — names: the book's proper nouns
 * (bookNames over the whole-book ULT), so a name opening a sentence is caught.
 */
function checkRewrite(candidate, proposal, { names = new Set() } = {}) {
  const failures = [];
  const warnings = [];
  const detail = {};
  const note = String(proposal && proposal.note || '');
  const tpl = candidate.templates.find((t) => t.id === (proposal && proposal.template_id));

  if (!note.trim()) return { failures: ['empty_note'], warnings, detail };
  if (note === candidate.Note) return { failures: ['no_change'], warnings, detail };
  if (/[\t\r\n]/.test(note)) failures.push('raw_newline_or_tab');
  if (!tpl) failures.push('unknown_template');

  // G1 bold spans are ULT text for this verse.
  const ult = ws(candidate.ult);
  const badBold = bolds(note).filter((b) => !ult.includes(ws(b)));
  if (badBold.length) { failures.push('bold_not_in_ult'); detail.bold_not_in_ult = badBold; }
  // ...and ULT words the old note pointed at are still mentioned.
  const oldSpans = [...bolds(candidate.prose), ...curlyQuoted(candidate.prose)].filter((s) => ult.includes(ws(s)));
  const lc = proseOnly(note).toLowerCase();
  const droppedSpans = oldSpans.filter((s) => !lc.includes(ws(s).toLowerCase()));
  if (droppedSpans.length) { warnings.push('old_span_dropped'); detail.old_span_dropped = droppedSpans; }

  // G2 alternate translations keep their wording; none are invented.
  const oldAts = ats(candidate.prose);
  const newAts = ats(note);
  const lostAts = oldAts.filter((a) => !newAts.includes(a));
  const inventedAts = newAts.filter((a) => !oldAts.includes(a));
  if (lostAts.length) { failures.push('at_lost_or_changed'); detail.at_lost_or_changed = lostAts; }
  if (inventedAts.length) { failures.push('at_invented'); detail.at_invented = inventedAts; }
  // Each AT opens with "[", optionally after a label such as "(1)" or "(adding a period after “spirit”)".
  if (unbracketedAts(note)) failures.push('at_not_bracketed');
  // An old AT the bracket parser cannot see could be dropped unnoticed.
  if (unbracketedAts(candidate.prose)) failures.push('old_at_unbracketed');
  if (tpl && /Alternate translation:/.test(tpl.template) && !oldAts.length) warnings.push('template_at_omitted');
  const boldText = bolds(note).join(' ');
  if (newAts.some((a) => quotePairProblem(a, boldText))) warnings.push('at_quote_pair');

  // G3 links: none in the new note. D5 is still open, so a dropped link is only
  // allowed when its information verifiably lives elsewhere (extract sets
  // covered: a sibling note with that SupportReference, or a twl entry);
  // otherwise the row keeps its current text and the report lists the link.
  if (/rc:\/\/|\[\[/.test(note)) failures.push('link_in_note');
  const uncovered = (candidate.links || []).filter((l) => l.covered !== true);
  if (uncovered.length) { failures.push('link_not_covered'); detail.link_not_covered = uncovered.flatMap((l) => l.targets); }

  // G4 names and references survive.
  const lostNames = properNouns(candidate.prose, candidate.ult).filter((w) => !new RegExp(`\\b${w}\\b`).test(note));
  if (lostNames.length) { failures.push('proper_noun_dropped'); detail.proper_noun_dropped = lostNames; }
  // ...and none is added. A name in neither the old note nor the verse was
  // worked out by the model (a speaker it inferred), so the row keeps its text;
  // one taken from the verse ships flagged for a human look.
  const has = (text, w) => new RegExp(`\\b${w}\\b`).test(text);
  const atAnyPosition = (proseOnly(note).match(/\b[A-Z][a-z]+\b/g) || []).filter((w) => names.has(w) && !CAP_EXEMPT.has(w));
  const added = [...new Set([...properNouns(note, candidate.ult), ...atAnyPosition])].filter((w) => !has(candidate.prose, w));
  // A name in the template's own wording ("asking God to bless") is not the
  // model's inference, but it may be example text left unreplaced: flag it.
  const fromTemplate = added.filter((w) => !has(candidate.ult, w) && tpl && has(tpl.template, w));
  if (fromTemplate.length) { warnings.push('name_from_template'); detail.name_from_template = fromTemplate; }
  const invented = added.filter((w) => !has(candidate.ult, w) && !fromTemplate.includes(w));
  if (invented.length) { failures.push('name_added'); detail.name_added = invented; }
  if (added.length > invented.length) { warnings.push('name_from_verse'); detail.name_from_verse = added.filter((w) => !invented.includes(w)); }
  const lostRefs = references(candidate.prose).filter((r) => !note.includes(r));
  if (lostRefs.length) { failures.push('reference_dropped'); detail.reference_dropped = lostRefs; }

  // G6 the note now follows the template it names.
  if (tpl) {
    const f = followsTemplate(note, tpl.template, tpl.id);
    if (!f.phrase) failures.push('template_untestable'); // no fixed phrase to prove the note follows it
    else if (!f.ok) { failures.push('template_phrase_missing'); detail.template_phrase = f.phrase; }
    const left = leftoverPlaceholders(note, tpl, candidate);
    if (left.length) { failures.push('placeholder_left'); detail.placeholder_left = left; }
  }
  const selfTalk = detectSelfTalk(note);
  if (selfTalk) { failures.push('self_talk'); detail.self_talk = selfTalk; }

  return { failures, warnings, detail };
}

/** Words the ULT capitalizes mid-sentence anywhere in the book: its names. */
function bookNames(ultText) {
  const text = String(ultText);
  const lower = new Set(text.match(/\b[a-z]+\b/g) || []);
  return [...new Set(midSentenceCaps(text))].filter((w) => !CAP_EXEMPT.has(w) && !lower.has(w.toLowerCase())).sort();
}

module.exports = { checkRewrite, ats, bolds, properNouns, references, bookNames };
