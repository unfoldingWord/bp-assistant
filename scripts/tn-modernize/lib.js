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
 * A template first phrase as a matcher over strippedNote() text. Check #25
 * compares literally; here a few template conventions are honoured so a
 * correctly filled template is not reported as old:
 *   "(man, people group, city)" -> any one of the choices
 *   "thoughts/feelings/motives" -> any one of the words
 *   leading punctuation left over from a placeholder (". You could") is dropped
 *   curly and straight quotes compare equal
 */
function phraseRegex(phrase) {
  const p = foldQuotes(phrase).toLowerCase()
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9(]+/, '').trim();
  const parts = [];
  let last = 0;
  const altRe = /\(([^()]*,[^()]*)\)|([a-z]+(?:\/[a-z]+)+)/g;
  let m;
  while ((m = altRe.exec(p))) {
    parts.push(escapeRe(p.slice(last, m.index)));
    const choices = m[1] ? m[1].split(',').map((c) => c.trim()) : m[2].split('/');
    parts.push(`(?:${choices.map(escapeRe).join('|')})`);
    last = m.index + m[0].length;
  }
  parts.push(escapeRe(p.slice(last)));
  return new RegExp(parts.join(''));
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
  const phrases = tpls.map((t) => templateFirstPhrase(t.template)).filter(Boolean);
  if (!phrases.length) return { status: 'no_phrase', slug };
  const note = strippedNote(row.Note);
  const hit = phrases.find((p) => phraseRegex(p).test(note));
  return hit ? { status: 'conforms', slug, phrase: hit } : { status: 'old', slug };
}

/** True when this note follows the given template's first fixed phrase (check #25 rule). */
function followsTemplate(note, templateText) {
  const phrase = templateFirstPhrase(templateText);
  if (!phrase) return { ok: true, phrase: null };
  return { ok: phraseRegex(phrase).test(strippedNote(note)), phrase };
}

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
  isIntroReference, srefSlug, templatesFor, foldQuotes, strippedNote, phraseRegex, classifyRow, followsTemplate,
  templateFirstPhrase,
  ultVerseText, referenceVerses, ultTextForRow,
};
