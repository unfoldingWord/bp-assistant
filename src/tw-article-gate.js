// tw-article-gate.js — drop translate-names and translate-unknown issue rows for
// terms that already have a translationWords (tW) article.
//
// issue-identification/SKILL.md tells the model to run check_tw_headwords and skip
// those terms, but the model does not always do it (JER 35:11 "Nebuchadnezzar king
// of Babylon" reached the notes with both names in tW). This is the deterministic
// version, run after the issues file is normalized:
//   translate-names    removed when every name word in the quote matches a tW
//                      "names" headword.
//   translate-unknown  removed when the quote is one word that matches a tW headword
//                      of any category (a list or phrase of common words is kept:
//                      EZK 27:14 "horses and warhorses and mules" is a note about
//                      telling the animals apart, which tW does not cover).
//
// Conservative on purpose. Names only match the "names" category (the kt headwords
// "sin", "god", "lord" would wrongly drop the city Sin or the divine-title notes), a
// quote with any word that has no article keeps its row, and a hint saying it is a
// different person keeps the row too. Never throws; untouched rows keep their bytes.

const fs = require('fs');
const path = require('path');
const { CSKILLBP_DIR } = require('./pipeline-utils');
const { checkTwHeadwords } = require('./workspace-tools/issue-tools');

// Connectors and common nouns that sit beside a name in a quote ("Nebuchadnezzar king
// of Babylon", "Jehoiakim son of Josiah"). They are not names, so they neither need
// an article nor block the match.
const FILLER_WORDS = new Set([
  'a', 'the', 'of', 'and', 'son', 'sons', 'daughter', 'king', 'queen', 'prophet',
  'priest', 'land', 'city', 'river', 'valley', 'mount', 'mountain', 'sea',
]);

// Issue hints (names only) saying the person is not the one the tW article describes (ZEC 6:10
// Josiah "different person from King Josiah"; JER 35:3 Jeremiah "this Jeremiah is
// not the prophet"). A name's meaning is not a keep reason: Benjamin's call
// 2026-10-08 is that the tW article covers it.
const KEEP_HINT_RE = /\b(different|not|another|other|rather than|homonym|namesake|distinct|same|variant|also called|alternate)\b/i;

const SREF_COL = 2;
const QUOTE_COL = 3;
const HINT_COL = 6;

// 'names' | 'unknown' | null, from the sref column (plain or rc://.../translate-names).
function ruleFor(sref) {
  const id = String(sref || '').trim().toLowerCase().replace(/^.*\//, '');
  if (id === 'translate-names') return 'names';
  if (id === 'translate-unknown') return 'unknown';
  return null;
}

function quoteWords(quote) {
  return String(quote || '')
    .replace(/[{}(),;&]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^["'“”‘’(\[]+|["'“”‘’)\].:!?…-]+$/g, '').replace(/['’]s$/i, '').trim())
    .filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()));
}

// Lowercased term -> set of tW categories it matches.
function coveredTerms(words) {
  const unique = [...new Set(words.map((w) => w.toLowerCase()))];
  const covered = new Map();
  if (!unique.length) return covered;
  const parsed = JSON.parse(checkTwHeadwords({ terms: unique }));
  if (parsed.error) throw new Error(parsed.error);
  for (const m of parsed.matches || []) covered.set(String(m.term).toLowerCase(), m.category);
  return covered;
}

function isCovered(rule, words, covered) {
  if (rule === 'names') return words.every((w) => covered.get(w.toLowerCase()) === 'names');
  return words.length === 1 && covered.has(words[0].toLowerCase());
}

/**
 * Remove translate-names / translate-unknown rows whose quote has a tW article.
 * @param {{issuesPath: string}} args  issuesPath is relative to CSKILLBP_DIR.
 * @returns {{ran: boolean, reason?: string, dropped: Array<{ref: string, quote: string, rule: string}>}}
 */
function dropTwCoveredRows({ issuesPath }) {
  const dropped = [];
  try {
    const absPath = path.resolve(CSKILLBP_DIR, issuesPath);
    const lines = fs.readFileSync(absPath, 'utf8').split('\n');

    const candidates = [];
    lines.forEach((line, i) => {
      const cols = line.split('\t');
      const rule = ruleFor(cols[SREF_COL]);
      if (!rule) return;
      if (rule === 'names' && KEEP_HINT_RE.test(cols[HINT_COL] || '')) return;
      const words = quoteWords(cols[QUOTE_COL]);
      if (words.length) candidates.push({ i, cols, rule, words });
    });
    if (!candidates.length) return { ran: true, dropped };

    const covered = coveredTerms(candidates.flatMap((c) => c.words));
    const dropIdx = new Set();
    for (const c of candidates) {
      if (isCovered(c.rule, c.words, covered)) {
        dropIdx.add(c.i);
        dropped.push({ ref: c.cols[1], quote: c.cols[QUOTE_COL], rule: c.rule });
      }
    }
    // Never empty the file: downstream stages treat an issues file with no rows as
    // a chapter with nothing to write.
    if (dropIdx.size && lines.every((l, i) => !l.trim() || dropIdx.has(i))) {
      return { ran: true, reason: 'would_empty', dropped: [] };
    }
    if (dropIdx.size) {
      const tmp = `${absPath}.tw-article.tmp`;
      fs.writeFileSync(tmp, lines.filter((_, i) => !dropIdx.has(i)).join('\n'));
      fs.renameSync(tmp, absPath);
    }
    return { ran: true, dropped };
  } catch (err) {
    console.warn(`[tw-article-gate] skipped: ${err.message}`);
    return { ran: false, reason: err.message, dropped: [] };
  }
}

module.exports = { dropTwCoveredRows, quoteWords, ruleFor };
