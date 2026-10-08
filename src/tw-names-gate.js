// tw-names-gate.js — drop translate-names issue rows for names that already have
// a translationWords (tW) article.
//
// issue-identification/SKILL.md tells the model to run check_tw_headwords and skip
// those names, but the model does not always do it (JER 35:11 "Nebuchadnezzar king
// of Babylon" reached the notes with both names in tW). This is the deterministic
// version: after the issues file is normalized, a translate-names row is removed
// when every name word in its quote matches a tW "names" headword.
//
// Conservative on purpose. Only the "names" category counts (the kt headwords "sin",
// "god", "lord" would wrongly drop the city Sin or the divine-title notes), a quote
// with any name word that has no article keeps its row, and a hint that says the
// name's meaning matters or that it is a different person keeps the row too, because
// a tW article cannot cover those. Never throws; untouched rows keep their exact bytes.

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

// Issue hints that mean the tW article does not cover the note: the name's meaning
// is the point (HOS 1:4 Jezreel "symbolic name - means God sows"; MAL 1:1 Malachi
// "could mean my messenger") or the person is not the one the article describes
// (ZEC 6:10 Josiah "different person from King Josiah"; JER 35:3 Jeremiah "this
// Jeremiah is not the prophet").
const KEEP_HINT_RE = /\b(mean|means|meaning|meaningful|symbolic|wordplay|pun|different|not|another|other|rather than|homonym|namesake|distinct|same|variant|also called|alternate)\b/i;

const SREF_COL = 2;
const QUOTE_COL = 3;
const HINT_COL = 6;

function isTranslateNames(sref) {
  return String(sref || '').trim().toLowerCase().replace(/^.*\//, '') === 'translate-names';
}

function nameWords(quote) {
  return String(quote || '')
    .replace(/[{}(),;&]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^["'“”‘’(\[]+|["'“”‘’)\].:!?…-]+$/g, '').replace(/['’]s$/i, '').trim())
    .filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()));
}

function coveredNameSet(words) {
  const unique = [...new Set(words.map((w) => w.toLowerCase()))];
  if (!unique.length) return new Set();
  const parsed = JSON.parse(checkTwHeadwords({ terms: unique }));
  if (parsed.error) throw new Error(parsed.error);
  return new Set((parsed.matches || [])
    .filter((m) => m.category === 'names')
    .map((m) => String(m.term).toLowerCase()));
}

/**
 * Remove translate-names rows whose name words all have a tW names article.
 * @param {{issuesPath: string}} args  issuesPath is relative to CSKILLBP_DIR.
 * @returns {{ran: boolean, reason?: string, dropped: Array<{ref: string, quote: string}>}}
 */
function dropTwCoveredNameRows({ issuesPath }) {
  const dropped = [];
  try {
    const absPath = path.resolve(CSKILLBP_DIR, issuesPath);
    const lines = fs.readFileSync(absPath, 'utf8').split('\n');

    const candidates = [];
    lines.forEach((line, i) => {
      const cols = line.split('\t');
      if (!isTranslateNames(cols[SREF_COL])) return;
      if (KEEP_HINT_RE.test(cols[HINT_COL] || '')) return;
      const words = nameWords(cols[QUOTE_COL]);
      if (words.length) candidates.push({ i, cols, words });
    });
    if (!candidates.length) return { ran: true, dropped };

    const covered = coveredNameSet(candidates.flatMap((c) => c.words));
    const dropIdx = new Set();
    for (const c of candidates) {
      if (c.words.every((w) => covered.has(w.toLowerCase()))) {
        dropIdx.add(c.i);
        dropped.push({ ref: c.cols[1], quote: c.cols[QUOTE_COL] });
      }
    }
    if (dropIdx.size) {
      const tmp = `${absPath}.tw-names.tmp`;
      fs.writeFileSync(tmp, lines.filter((_, i) => !dropIdx.has(i)).join('\n'));
      fs.renameSync(tmp, absPath);
    }
    return { ran: true, dropped };
  } catch (err) {
    console.warn(`[tw-names-gate] skipped: ${err.message}`);
    return { ran: false, reason: err.message, dropped: [] };
  }
}

module.exports = { dropTwCoveredNameRows, nameWords, isTranslateNames };
