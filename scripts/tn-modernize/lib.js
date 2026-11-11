// lib.js — shared helpers for the tn-modernize scripts (survey, extract,
// rewrite, apply, publish). Everything here is deterministic.
//
// CSKILLBP_DIR is captured at module load by tn-tools.js, so this module sets
// it from TN_MODERNIZE_DIR (default ~/.local/state/tn-modernize) BEFORE the
// first require of anything under src/. Require this file first.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK_DIR = process.env.TN_MODERNIZE_DIR || path.join(os.homedir(), '.local/state/tn-modernize');
if (!process.env.CSKILLBP_DIR) process.env.CSKILLBP_DIR = WORK_DIR;

const SRC = path.join(__dirname, '../../src');
const { loadTemplateMap, parseCSV } = require(path.join(SRC, 'workspace-tools/tn-tools'));
const { templateFirstPhrase } = require(path.join(SRC, 'workspace-tools/quality-tools'));
const { parseTnTsv, serializeTnTsv } = require(path.join(SRC, 'lib/tn-tsv'));
const { extractChapterVerse } = require(path.join(SRC, 'api-runner/verse-data'));

const TEMPLATES_PATH = path.join(process.env.CSKILLBP_DIR, 'data/templates.csv');

/** The "# Fetched: YYYY-MM-DD" date of the frozen templates.csv snapshot. */
function templatesSnapshotDate() {
  if (!fs.existsSync(TEMPLATES_PATH)) throw new Error(`no templates snapshot at ${TEMPLATES_PATH}`);
  const first = fs.readFileSync(TEMPLATES_PATH, 'utf8').split('\n')[0];
  const m = first.match(/^# Fetched:\s*(\S+)/);
  if (!m) throw new Error(`templates snapshot has no "# Fetched:" line: ${TEMPLATES_PATH}`);
  return m[1];
}

function isIntroReference(ref) {
  return /(?:^|:)(?:intro|front)$/i.test(String(ref || '').trim());
}

/** Same slug rule as check #25: the tA article name after "translate/". */
function srefSlug(sref) {
  return (String(sref || '').match(/translate\/([^\s;,]+)/) || [])[1] || '';
}

// loadTemplateMap drops the sheet's id column (figs-metaphor-06); the rewrite
// names its chosen variant by that id, so map it back from the same file.
let _ids = null;
function templateId(slug, template) {
  if (!_ids) {
    _ids = new Map();
    const ws = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    for (const row of parseCSV(fs.readFileSync(TEMPLATES_PATH, 'utf8'))) {
      if (row[3]) _ids.set(`${ws(row[0])}\u0000${ws(row[2])}`, ws(row[3]));
    }
  }
  return _ids.get(`${slug}\u0000${template}`) || null;
}

/** Sheet templates for a slug, each with its sheet id (hint_only built-ins are never a default). */
function templatesFor(slug) {
  return (loadTemplateMap().get(slug) || []).filter((t) => !t.hint_only)
    .map((t) => ({ ...t, id: templateId(slug, t.template) }));
}

/** Fold curly quotes and apostrophes to straight ones. */
function foldQuotes(s) {
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** Lowercased note prose with bold spans and [brackets] blanked, as check #25 compares it. */
function strippedNote(note) {
  return foldQuotes(note)
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')   // markdown links ([1:54](../01/54.md))
    .replace(/\*\*[^*]+\*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A template first phrase as matchers over strippedNote() text, one per
 * sentence of the phrase. Check #25 compares the whole phrase literally; here
 * the template conventions the style guide itself asks writers to apply are
 * honoured, so a correctly filled template is not reported as old:
 *   "(man, people group, city)" or "thoughts/feelings/motives" -> one or more
 *     of the choices, joined by commas, "and" or "or"
 *   the fixed sentences must all appear, in order, but the old note's extra
 *     sentences may sit between them (the rewrite prompt puts them there)
 *   leading and trailing punctuation left over from a placeholder is dropped
 *   curly and straight quotes compare equal
 */
// Example content a template carries where a placeholder belongs (#480): a
// filled note replaces it, so it matches anything. Capitalized words are found
// by rule (exampleMarked); these lowercase spans are listed per template.
const TEMPLATE_EXAMPLES = {
  'figs-metonymy-04': ['a person'],
};
// Fixed words that still bend to the subject: "is speaking of himself" fits Ruth as "herself".
const AGREEMENT = {
  is: 'is|are', was: 'was|were', himself: 'himself|herself|themselves|itself',
  his: 'his|her|their|its', he: 'he|she|they|it', him: 'him|her|them|it',
  word: 'word|phrase', // "the phrase translated as **Now it happened**" (RUT-sb2j)
};
const EXAMPLE = '\x01';
const WILD = '[^.]{1,80}?';
const KEEP_CAPS = /^(God|Yahweh|Lord|I|Alternate|Christ|Jesus)$/;
// One qualifier the old note carried may sit inside the fixed wording: "a strong
// contrast", "was probably a symbolic action" (Benjamin, 2026-10-19: RUT-ln1m, RUT-hilu).
const QUALIFIER = ' (?:(?:probably|likely|possibly|perhaps|strong|sharp|very) )?';

/** The phrase with example content replaced by EXAMPLE markers (case kept). */
function exampleMarked(phrase, examples = []) {
  let p = foldQuotes(phrase);
  for (const e of examples) p = p.split(e).join(EXAMPLE);
  return p
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, EXAMPLE)          // ACTION_DESCRIPTION_NOT_QUOTE
    .replace(/\b[XY]\b/g, EXAMPLE)                               // "the information about X ... Y"
    .replace(/(?<=[a-z,] )[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g, (w) => (KEEP_CAPS.test(w) ? w : EXAMPLE)) // "bless Person", "the Messiah"
    // A name opening the sentence as its subject: "John is using", "David is speaking".
    .replace(/(^|[.!?]"? )([A-Z][a-z]+)(?= (?:is|are|was|were) )/g, (m, pre, w) =>
      (KEEP_CAPS.test(w) || /^(Here|This|These|That|The|If|It|In|You|Your|A|An|There)$/.test(w) ? m : pre + EXAMPLE))
    .replace(/\b(?:the|a|an) \x01/gi, EXAMPLE);                  // the marker absorbs its own article
}

function phraseMatchers(phrase, examples) {
  const p = exampleMarked(phrase, examples).toLowerCase()
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  // "is a passive verbal form" covers two words as "are passive verbal forms" (ROM-pyb6).
  const literal = (s) => escapeRe(s).replace(/\bis a ((?:[a-z]+ ){0,3}(?:form|word|expression|term|phrase))\b/g, (m, n) => `(?:is a ${n}|are ${n}s)`)
    .replace(/\b(is|was|himself|his|he|him|word)\b(?![|)])/g, (w) => `(?:${AGREEMENT[w]})`)
    .split(' ').join(QUALIFIER).split(EXAMPLE).join(`(?:(?:the|a|an) )?${WILD}`);
  // Measurement templates open with a worked example ("22 liters or nearly two
  // thirds of a bushel"): a sentence with a number is example content, not fixed
  // wording (Benjamin, 2026-10-19: RUT-mq6b), unless nothing testable would be left.
  const sentences = p.split(/(?<=[.!?]"?)\s+/);
  const fixed = sentences.filter((x) => !/\d/.test(x));
  return (fixed.some((x) => x.split(' ').length >= 4) ? fixed : sentences).map((sentence) => {
    const t = sentence.replace(/^[^a-z0-9(\x01]+/, '').replace(/[.,;:!?"' ]+$/, '');
    const parts = [];
    let last = 0;
    const altRe = /\(([^()]*,[^()]*)\)|([a-z]+(?:\/[a-z]+)+)/g;
    let m;
    while ((m = altRe.exec(t))) {
      parts.push(literal(t.slice(last, m.index)));
      const choices = (m[1] ? m[1].split(',') : m[2].split('/')).map((c) => escapeRe(c.trim()));
      const one = `(?:${choices.join('|')})`;
      parts.push(`${one}(?:(?:\\s*,\\s*|\\s+)(?:(?:and|or)\\s+)?${one})*`);
      last = m.index + m[0].length;
    }
    parts.push(literal(t.slice(last)));
    return new RegExp(parts.join(''), 'g');
  }).filter((re) => re.source.length > 0);
}

/** Example words of a template phrase (for the placeholder_left gate): the capitalized ones, as written. */
function templateExamples(phrase, templateId) {
  const listed = TEMPLATE_EXAMPLES[templateId] || [];
  const marked = exampleMarked(phrase, []);
  const orig = foldQuotes(phrase);
  // Recover what each marker replaced by aligning the text between markers.
  const pieces = marked.split(EXAMPLE);
  const found = [];
  let at = 0;
  for (let i = 0; i < pieces.length - 1; i++) {
    at = orig.indexOf(pieces[i], at) + pieces[i].length;
    const end = pieces[i + 1] ? orig.indexOf(pieces[i + 1], at) : orig.length;
    found.push(orig.slice(at, end).replace(/^(?:the|a|an) /i, '').trim());
    at = end;
  }
  return [...new Set([...found.filter((w) => w.length > 1), ...listed])];
}

/** True when every sentence of the phrase appears in the stripped note, in order. */
function phraseMatches(phrase, stripped, examples) {
  let from = 0;
  for (const re of phraseMatchers(phrase, examples)) {
    re.lastIndex = from;
    const m = re.exec(stripped);
    if (!m) return false;
    from = m.index + m[0].length;
  }
  return true;
}

/**
 * Classify one row against the template snapshot.
 *   intro       — intro/front row (never rewritten)
 *   no_sref     — no translate/ SupportReference
 *   no_template — the sref has no template in the snapshot
 *   no_phrase   — templates exist but none yields a testable first phrase
 *   conforms    — the note contains the first phrase of ANY variant
 *   old         — it contains none of them: a rewrite candidate
 * Check #25 itself tests only the resolved (or single) template; with no
 * resolved template here, "any variant" is the fair generalization.
 */
function classifyRow(row) {
  if (isIntroReference(row.Reference)) return { status: 'intro' };
  const slug = srefSlug(row.SupportReference);
  if (!slug) return { status: 'no_sref' };
  const tpls = templatesFor(slug);
  if (!tpls.length) return { status: 'no_template', slug };
  const phrases = tpls.map((t) => ({ p: templateFirstPhrase(t.template), ex: TEMPLATE_EXAMPLES[t.id] })).filter((x) => x.p);
  if (!phrases.length) return { status: 'no_phrase', slug };
  const note = strippedNote(row.Note);
  const hit = phrases.find((x) => phraseMatches(x.p, note, x.ex));
  return hit ? { status: 'conforms', slug, phrase: hit.p } : { status: 'old', slug };
}

/** True when this note follows the given template's first fixed phrase (check #25 rule). */
function followsTemplate(note, templateText, templateId) {
  const phrase = templateFirstPhrase(templateText);
  if (!phrase) return { ok: true, phrase: null };
  return { ok: phraseMatches(phrase, strippedNote(note), TEMPLATE_EXAMPLES[templateId]), phrase };
}

/** Tags column values for rows a person must look at (Benjamin's wording, 2026-10-19). */
const REVIEW_TAGS = { human: 'human review', at: 'needs alternate translation' };

/** Old notes that only send the reader to an earlier note: never rewritten (Benjamin, 2026-10-19). */
const SEE_HOW_RE = /\bSee how you\b/;

// ---------------------------------------------------------------------------
// ULT verse text
// ---------------------------------------------------------------------------

/** Plain English text of one verse from aligned ULT USFM (keeps punctuation and curly quotes). */
function ultVerseText(usfm, chapter, verse) {
  const raw = extractChapterVerse(usfm, chapter, verse);
  if (raw == null) return null;
  return raw
    .replace(/\\f\s[\s\S]*?\\f\*/g, ' ')           // footnotes
    .replace(/\\zaln-s\s*\|[^*]*\*/g, '')
    .replace(/\\zaln-e\\\*/g, '')
    .replace(/\\w\s+([^|\\]+)\|[^\\]*?\\w\*/g, '$1')
    .replace(/\\w\s+([^\\]+)\\w\*/g, '$1')
    .replace(/\\[a-z]+\d?\*/g, '')
    .replace(/\\[a-z]+\d?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ +([.,;:!?’”)\]}])/g, '$1')
    .replace(/([“‘(\[{]) +/g, '$1')
    .trim();
}

/** Verse numbers a Reference covers ("3:4", "3:4-6", "3:4,7"); [] for intro or other chapters. */
function referenceVerses(ref) {
  const m = String(ref || '').match(/^(\d+):([\d,\-–]+)$/);
  if (!m) return [];
  const out = [];
  for (const seg of m[2].split(',')) {
    const [a, b] = seg.split(/[-–]/).map((x) => parseInt(x, 10));
    if (!Number.isFinite(a)) continue;
    const end = Number.isFinite(b) && b >= a && b - a < 30 ? b : a;
    for (let v = a; v <= end; v++) out.push({ chapter: parseInt(m[1], 10), verse: v });
  }
  return out;
}

/** ULT text for every verse the row's Reference covers, joined with spaces. */
function ultTextForRow(usfm, ref) {
  return referenceVerses(ref)
    .map(({ chapter, verse }) => ultVerseText(usfm, chapter, verse))
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  WORK_DIR, TEMPLATES_PATH, templatesSnapshotDate,
  parseTnTsv, serializeTnTsv,
  isIntroReference, srefSlug, templatesFor, foldQuotes, strippedNote, phraseMatches, classifyRow, followsTemplate,
  templateExamples, SEE_HOW_RE, REVIEW_TAGS,
  templateFirstPhrase,
  ultVerseText, referenceVerses, ultTextForRow,
};
