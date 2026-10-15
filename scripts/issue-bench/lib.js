'use strict';
// Pure helpers for the issue-bench ledger. No I/O, no network.

const SLUG_PREFIX = 'rc://*/ta/man/translate/';
const BOT_EMAIL = 'bot@unfoldingword.org';
const OURS_PREFIX = /^bible-editor(?: export)?:\s/;
const AI_TRAILER = /^X-AI-Pipeline:/m;

function norm(s) {
  return String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
}

function slugOf(supportRef) {
  const s = norm(supportRef);
  return s.startsWith(SLUG_PREFIX) ? s.slice(SLUG_PREFIX.length) : s;
}

function isPointerNote(note) {
  return /^see how you translated/i.test(norm(note));
}

// Parse a TN TSV. Returns rows with: ref, id, tags, supportRef, slug, quote,
// occurrence, note, chapter (string; 'front' for front matter), verseStart,
// verseEnd (numbers or null), intro, pointer.
function parseTsv(text) {
  const rows = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split('\t');
    if (i === 0 && c[0] === 'Reference') continue;
    const ref = norm(c[0]);
    const m = ref.match(/^(\d+|front):(intro|\d+(?:-\d+)?)$/);
    if (!m) continue;
    const intro = m[2] === 'intro';
    let verseStart = null;
    let verseEnd = null;
    if (!intro) {
      const [a, b] = m[2].split('-');
      verseStart = Number(a);
      verseEnd = b ? Number(b) : verseStart;
    }
    const note = c.slice(6).join('\t');
    rows.push({
      ref,
      id: norm(c[1]),
      tags: norm(c[2]),
      supportRef: norm(c[3]),
      slug: slugOf(c[3]),
      quote: norm(c[4]),
      occurrence: norm(c[5]),
      note: norm(note),
      chapter: m[1],
      verseStart,
      verseEnd,
      intro,
      pointer: !intro && isPointerNote(note),
    });
  }
  return rows;
}

function subjectOf(message) {
  const m = String(message || '');
  const nl = m.indexOf('\n');
  return (nl === -1 ? m : m.slice(0, nl)).trim();
}

// Chapters named by an AI subject like `TN: JER 32 [x]`, `TN: PSA 119-120`,
// `TN: JER 23:1-7`. Verse-range shards map to their chapter. Returns [] when
// the subject has no parsable chapter.
function aiSubjectChapters(subject, book) {
  const re = new RegExp('^TN:\\s+' + book + '\\s+(\\d+)(?:\\s*-\\s*(\\d+)(?!:))?(?::\\d+(?:\\s*-\\s*\\d+)?)?', 'i');
  const m = subject.match(re);
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  const out = [];
  if (b >= a && b - a < 200) for (let n = a; n <= b; n++) out.push(String(n));
  else out.push(String(a));
  return out;
}

// Classification ported from bible-editor api/src/masterLineage.ts
// (classifyMasterCommit), simplified to the rules in the task spec.
function classifyCommit({ email, message }, book) {
  const subject = subjectOf(message);
  if (OURS_PREFIX.test(subject)) return 'ours';
  const e = String(email || '').trim().toLowerCase();
  if (e === BOT_EMAIL && aiSubjectChapters(subject, book).length) return 'ai';
  if (AI_TRAILER.test(String(message || ''))) return 'ai';
  return 'human';
}

function tokens(s) {
  const n = norm(s);
  return n ? n.split(' ') : [];
}

function jaccard(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function chapterRows(rows, chapter) {
  return rows.filter((r) => r.chapter === String(chapter));
}

function countable(r) {
  return !r.intro && !r.pointer;
}

// Rows the AI commit inserted: chapter rows at the ai commit whose ID is not
// present in that chapter at the parent. Pointer and intro rows are split out.
function isolateAiRows(aiCommitRows, parentRows, chapter) {
  const atAi = chapterRows(aiCommitRows, chapter);
  const parentIds = new Set(chapterRows(parentRows || [], chapter).map((r) => r.id));
  const inserted = atAi.filter((r) => !r.intro && !parentIds.has(r.id));
  return {
    aiRows: inserted.filter((r) => !r.pointer),
    pointerRowsAi: inserted.filter((r) => r.pointer),
    atAi,
  };
}

function classifyPair(ai, fin) {
  if (ai.slug !== fin.slug) return 'relabeled';
  if (ai.quote !== fin.quote) return 'rescoped';
  if (ai.note !== fin.note) return 'reworded';
  return 'kept';
}

// Pair AI rows to final rows (same chapter) by ID, then by the kept-reid
// fallback. Returns { pairs, humanAdded, legacyFinal } where pairs is
// [{ai, fin, kind, reid}] (fin null and kind 'deleted' when unpaired).
function pairRows(aiRows, finalChapterRows, atAiChapterRows) {
  const finalCountable = finalChapterRows.filter(countable);
  const finalById = new Map(finalChapterRows.filter((r) => !r.intro).map((r) => [r.id, r]));
  const aiCommitIds = new Set(atAiChapterRows.map((r) => r.id));
  const aiIds = new Set(aiRows.map((r) => r.id));
  const usedFinal = new Set();
  const pairs = aiRows.map((ai) => {
    const fin = finalById.get(ai.id);
    if (fin) {
      usedFinal.add(fin);
      return { ai, fin, kind: classifyPair(ai, fin), reid: false };
    }
    return { ai, fin: null, kind: 'deleted', reid: false };
  });
  // Fallback candidates: final rows that did not exist at the ai commit.
  const candidates = finalCountable.filter((r) => !aiCommitIds.has(r.id));
  for (const p of pairs) {
    if (p.fin) continue;
    let best = null;
    let bestScore = 0.5;
    for (const c of candidates) {
      if (usedFinal.has(c) || c.ref !== p.ai.ref || c.slug !== p.ai.slug) continue;
      const j = jaccard(p.ai.quote, c.quote);
      if (j >= bestScore) {
        best = c;
        bestScore = j;
      }
    }
    if (best) {
      usedFinal.add(best);
      p.fin = best;
      p.kind = 'kept-reid';
      p.reid = true;
    }
  }
  const humanAdded = candidates.filter((r) => !usedFinal.has(r));
  const legacyFinal = finalCountable.filter((r) => aiCommitIds.has(r.id) && !aiIds.has(r.id));
  return { pairs, humanAdded, legacyFinal };
}

// Chapters touched by the lines changed in `tn_<BOOK>.tsv` within a
// whole-commit unified diff. Returns a Set of chapter strings.
function diffChapters(diffText, book) {
  const file = `tn_${book}.tsv`;
  const out = new Set();
  let inFile = false;
  for (const line of String(diffText).replace(/\r/g, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      inFile = line.endsWith(` b/${file}`);
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line[0] !== '+' && line[0] !== '-') continue;
    const m = line.slice(1).match(/^(\d+|front):/);
    if (m && m[1] !== 'front') out.add(m[1]);
  }
  return out;
}

// ---- USFM / passive coverage ----

// Plain verse text keyed "C:V" (verse ranges key on the first verse). Verse
// markers can sit mid-line (`\q1 \v 2 ...`), so the whole text is cleaned and
// then split on \c / \v markers.
function usfmToVerses(usfm) {
  const text = String(usfm)
    .replace(/\r/g, '')
    .replace(/\\f\s[\s\S]*?\\f\*/g, '')
    .replace(/\\zaln-s\s[^\\]*\\\*/g, '')
    .replace(/\\zaln-e\\\*/g, '')
    .replace(/\\w\s+([^|\\]*?)\s*(?:\|[^\\]*)?\\w\*/g, '$1');
  const verses = {};
  const re = /\\c\s+(\d+)|\\v\s+(\d+)(?:-\d+)?/g;
  let chapter = null;
  let key = null;
  let last = 0;
  const flush = (end) => {
    if (!key) return;
    const seg = text.slice(last, end)
      .replace(/\\[a-z]+\d*(?:-[se])?\*?/gi, ' ')
      .replace(/\\\*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (seg) verses[key] = (verses[key] ? verses[key] + ' ' : '') + seg;
  };
  let m;
  while ((m = re.exec(text))) {
    flush(m.index);
    last = m.index + m[0].length;
    if (m[1]) { chapter = m[1]; key = null; } else if (chapter) { key = `${chapter}:${m[2]}`; verses[key] = verses[key] || ''; }
  }
  flush(text.length);
  return verses;
}

// APPROXIMATE passive detector: a form of "be", an optional adverb (-ly word),
// then a past participle (regular -ed or a list of common irregulars). It
// misses passives with intervening words and false-positives on adjectival
// participles ("was tired"); use only for relative coverage comparisons.
const IRREGULARS = 'been|begun|bent|bitten|blown|born|borne|bound|broken|brought|built|burned|burnt|bought|caught|chosen|clothed|cut|dealt|done|drawn|driven|eaten|fallen|fed|felt|fought|found|forgiven|forgotten|given|gone|grown|hanged|heard|held|hidden|hit|hung|kept|known|laid|led|left|lost|made|met|paid|put|read|ridden|risen|run|said|seen|sent|set|shaken|shown|shut|slain|sold|spoken|spread|stolen|struck|sworn|taken|taught|thrown|told|torn|understood|won|woven|written|wrung';
const PASSIVE_RE = new RegExp(
  '\\b(?:am|is|are|was|were|be|been|being)\\s+(?:\\w+ly\\s+)?(?:\\w+ed|' + IRREGULARS + ')\\b',
  'gi'
);

function passiveMatches(text) {
  return String(text).match(PASSIVE_RE) || [];
}

// ---- Reference summarization ----

function expandVerses(row) {
  const out = [];
  if (row.verseStart == null) return out;
  const end = Math.min(row.verseEnd, row.verseStart + 60);
  for (let v = row.verseStart; v <= end; v++) out.push(`${row.chapter}:${v}`);
  return out;
}

// Passive coverage: verses (map key -> text) vs TN rows (countable only).
function passiveCoverage(verses, rows, slug = 'figs-activepassive') {
  const apRows = rows.filter((r) => countable(r) && r.slug === slug);
  const apVerses = new Set();
  for (const r of apRows) for (const k of expandVerses(r)) apVerses.add(k);
  let passiveVerses = 0;
  let covered = 0;
  let matches = 0;
  for (const [k, t] of Object.entries(verses)) {
    const n = passiveMatches(t).length;
    matches += n;
    if (n) {
      passiveVerses++;
      if (apVerses.has(k)) covered++;
    }
  }
  return {
    verses: Object.keys(verses).length,
    passive_verses: passiveVerses,
    passive_verses_with_note: covered,
    passive_matches: matches,
    ap_rows: apRows.length,
  };
}

module.exports = {
  norm, slugOf, isPointerNote, parseTsv, subjectOf, aiSubjectChapters,
  classifyCommit, jaccard, chapterRows, countable, isolateAiRows, classifyPair,
  pairRows, diffChapters, usfmToVerses, passiveMatches, passiveCoverage, expandVerses,
};
