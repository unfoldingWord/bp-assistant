// issue-tools.js — Node.js ports of issue identification scripts
//
// Replaces: check_tw_headwords.py, compare_ult_ust.py, detect_abstract_nouns.py

const fs = require('fs');
const path = require('path');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

/**
 * Check terms against Translation Words headwords index.
 */
function checkTwHeadwords({ terms }) {
  const hwFile = path.join(CSKILLBP_DIR, 'data', 'tw_headwords.json');
  if (!fs.existsSync(hwFile)) return JSON.stringify({ error: 'tw_headwords.json not found' });

  const data = JSON.parse(fs.readFileSync(hwFile, 'utf8'));
  const index = {};
  for (const entry of data) {
    for (const hw of entry.headwords || []) {
      index[hw.toLowerCase()] = { original: hw, entry };
    }
  }

  const matches = [];
  const noMatch = [];

  for (const term of terms) {
    const lower = term.trim().toLowerCase();
    // Try exact, then plural variants
    const variants = [lower];
    if (lower.endsWith('ites')) variants.push(lower.slice(0, -1), lower.slice(0, -4));
    else if (lower.endsWith('ies')) variants.push(lower.slice(0, -3) + 'y');
    else if (lower.endsWith('es')) variants.push(lower.slice(0, -2), lower.slice(0, -1));
    else if (lower.endsWith('s') && !lower.endsWith('ss')) variants.push(lower.slice(0, -1));

    let found = false;
    for (const v of variants) {
      if (index[v]) {
        const { original, entry } = index[v];
        matches.push({
          term, twarticle: entry.twarticle, category: entry.category,
          headwords: entry.headwords, matched_headword: original,
          ...(v !== lower ? { normalized_from: lower } : {}),
        });
        found = true;
        break;
      }
    }
    if (!found) noMatch.push(term);
  }

  return JSON.stringify({ matches, no_match: noMatch }, null, 2);
}

/**
 * Compare ULT and UST verse-by-verse to identify translation differences.
 */
function compareUltUst({ ultFile, ustFile, chapter, format }) {
  const ultPath = path.resolve(CSKILLBP_DIR, ultFile);
  const ustPath = path.resolve(CSKILLBP_DIR, ustFile);
  const fmt = format || 'tsv';

  function parseVerses(content) {
    const verses = {};
    let ch = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const cm = trimmed.match(/^\\c\s+(\d+)/);
      if (cm) { ch = parseInt(cm[1], 10); continue; }
      const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
      if (vm) {
        const v = parseInt(vm[1].split('-')[0], 10);
        const ref = `${ch}:${v}`;
        let text = vm[2] || '';
        // Clean USFM markers
        text = text.replace(/\\[pqsm]\d?\s*/g, ' ').replace(/\\d\s*/g, ' ')
          .replace(/\\b\s*/g, ' ').replace(/\\f[^\\]*\\f\*/g, '')
          .replace(/\\x[^\\]*\\x\*/g, '').replace(/\\[a-z]+\d?\*/g, '')
          .replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
          .replace(/\s+/g, ' ').trim();
        verses[ref] = (verses[ref] || '') + ' ' + text;
      }
    }
    // Clean up
    for (const k of Object.keys(verses)) verses[k] = verses[k].trim();
    return verses;
  }

  function wordSet(text) { return new Set(text.toLowerCase().split(/\s+/).filter(Boolean)); }
  function similarity(a, b) {
    const setA = wordSet(a);
    const setB = wordSet(b);
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union ? intersection / union : 0;
  }

  const ultContent = fs.readFileSync(ultPath, 'utf8');
  const ustContent = fs.readFileSync(ustPath, 'utf8');
  const ultVerses = parseVerses(ultContent);
  const ustVerses = parseVerses(ustContent);

  const PASSIVE_WORDS = new Set(['was', 'were', 'been', 'being', 'is', 'are']);
  const COMPARISON_WORDS = new Set(['like', 'as']);
  const ABSTRACT_SUFFIXES = ['ness', 'tion', 'ment', 'ity', 'ance', 'ence'];

  const results = [];
  const refs = [...new Set([...Object.keys(ultVerses), ...Object.keys(ustVerses)])].sort((a, b) => {
    const [ac, av] = a.split(':').map(Number);
    const [bc, bv] = b.split(':').map(Number);
    return ac !== bc ? ac - bc : av - bv;
  });

  for (const ref of refs) {
    if (chapter && !ref.startsWith(chapter + ':')) continue;
    const ult = ultVerses[ref] || '';
    const ust = ustVerses[ref] || '';
    if (!ult || !ust) continue;

    const sim = similarity(ult, ust);
    if (sim > 0.85) continue;

    const ultWords = ult.toLowerCase().split(/\s+/);
    const ustWords = ust.toLowerCase().split(/\s+/);
    let diffType = 'divergent';
    let suggestedIssue = '';
    let confidence = 'low';

    if (ustWords.length > ultWords.length * 1.3) {
      diffType = 'added_words'; suggestedIssue = 'figs-explicit'; confidence = 'medium';
    } else if (ustWords.length < ultWords.length * 0.7) {
      diffType = 'condensed'; suggestedIssue = 'figs-parallelism'; confidence = 'medium';
    }
    // Voice change
    const ultPassive = ultWords.filter(w => PASSIVE_WORDS.has(w)).length;
    const ustPassive = ustWords.filter(w => PASSIVE_WORDS.has(w)).length;
    if (ultPassive > ustPassive + 1) {
      diffType = 'voice_change'; suggestedIssue = 'figs-activepassive'; confidence = 'high';
    }
    // Comparison
    const ultComp = ultWords.filter(w => COMPARISON_WORDS.has(w)).length;
    const ustComp = ustWords.filter(w => COMPARISON_WORDS.has(w)).length;
    if (ultComp > ustComp) { diffType = 'removed_comparison'; suggestedIssue = 'figs-metaphor'; confidence = 'medium'; }
    if (ustComp > ultComp) { diffType = 'added_comparison'; suggestedIssue = 'figs-simile'; confidence = 'medium'; }
    // Abstract nouns
    const ultAbstract = ultWords.filter(w => ABSTRACT_SUFFIXES.some(s => w.endsWith(s))).length;
    if (ultAbstract > 0 && ustWords.length > ultWords.length) {
      diffType = 'unpacked_abstract'; suggestedIssue = 'figs-abstractnouns'; confidence = 'medium';
    }
    // Idiom
    if (ultWords.length <= 5 && ustWords.length > ultWords.length * 2) {
      diffType = 'expanded_phrase'; suggestedIssue = 'figs-idiom'; confidence = 'low';
    }
    if (sim >= 0.5 && sim < 0.6) {
      diffType = 'restructured'; suggestedIssue = 'figs-infostructure'; confidence = 'low';
    }

    results.push({ verse: ref, ult_text: ult, ust_text: ust, diff_type: diffType, suggested_issue: suggestedIssue, confidence });
  }

  if (fmt === 'json') return JSON.stringify(results, null, 2);
  // TSV
  const header = 'Verse\tDiff Type\tSuggested Issue\tConfidence\tULT\tUST';
  const rows = results.map(r => `${r.verse}\t${r.diff_type}\t${r.suggested_issue}\t${r.confidence}\t${r.ult_text}\t${r.ust_text}`);
  return [header, ...rows].join('\n');
}

// --- Abstract-noun lexicon -------------------------------------------------
//
// The team's word list lives in the skills checkout:
//   data/abstract_nouns.txt          one word/phrase per line (CRLF)
//   data/abstract_nouns_review.csv   per-word team rulings (team_decision column)
//   .claude/skills/issue-identification/figs-abstractnouns.md
//                                    "NOT figs-abstractnouns" communication words
// Suffix matching is only a low-confidence fallback for words not on the list.

const ABSTRACT_WORDLIST_REL = path.join('data', 'abstract_nouns.txt');
const ABSTRACT_REVIEW_REL = path.join('data', 'abstract_nouns_review.csv');
const ABSTRACT_DOC_REL = path.join('.claude', 'skills', 'issue-identification', 'figs-abstractnouns.md');

// Fallback suffixes. -ure and -ment are left out: they mostly hit concrete
// nouns (treasure, pasture, creature, garment, ornament); the abstract ones
// (judgment, punishment, pleasure, measure...) are on the word list.
const ABSTRACT_FALLBACK_SUFFIXES = ['ness', 'tion', 'sion', 'ity', 'ance', 'ence', 'dom', 'ship', 'hood', 'ism'];

// Used only if figs-abstractnouns.md is missing or its list can't be parsed.
const COMMUNICATION_WORDS_FALLBACK = [
  'commandment', 'statute', 'precept', 'ordinance', 'decree', 'testimony', 'law', 'rule',
  'regulation', 'word', 'saying', 'promise', 'declaration', 'instruction', 'charge', 'covenant', 'oath',
];

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Singular/base candidates for a lower-case word (simple plural fold). */
function nounCandidates(w) {
  const c = [w];
  if (w.endsWith('ies') && w.length > 4) c.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ves') && w.length > 4) c.push(w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe');
  if (w.endsWith('es') && w.length > 3) c.push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) c.push(w.slice(0, -1));
  return c;
}

/** Parse the communication-word bullets from figs-abstractnouns.md. */
function parseCommunicationWords(md) {
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex(l => /spoken or written communication/i.test(l));
  if (idx < 0) return null;
  const words = new Set();
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('-')) break;
    for (const m of l.matchAll(/"([^"]+)"/g)) {
      for (const part of m[1].split('/')) {
        const base = part.replace(/\(s\)$/i, '').trim().toLowerCase();
        if (base) words.add(base);
      }
    }
  }
  return words.size ? words : null;
}

function normalizeDecision(raw) {
  const d = String(raw || '').trim().toLowerCase();
  if (!d) return '';
  if (/^not[\s_-]*abstract$/.test(d) || d === 'no') return 'not abstract';
  if (d.startsWith('context')) return 'context';
  if (d === 'abstract' || d === 'yes') return 'abstract';
  return '';
}

const lexiconCache = { key: null, value: null };

function fileStamp(p) {
  try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch (_) { return 'missing'; }
}

/**
 * Load the abstract-noun lexicon from the skills checkout. Cached by mtime.
 * @returns {{ words: Set<string>, phrases: Map<string,string>, maxPhraseLen: number,
 *   decisions: Map<string,string>, pending: Set<string>, communication: Set<string>,
 *   hasWordList: boolean }}
 */
function loadAbstractNounLexicon(skillsDir = CSKILLBP_DIR) {
  const listPath = path.join(skillsDir, ABSTRACT_WORDLIST_REL);
  const reviewPath = path.join(skillsDir, ABSTRACT_REVIEW_REL);
  const docPath = path.join(skillsDir, ABSTRACT_DOC_REL);
  const key = [skillsDir, fileStamp(listPath), fileStamp(reviewPath), fileStamp(docPath)].join('|');
  if (lexiconCache.key === key) return lexiconCache.value;

  const words = new Set();
  const phrases = new Map();
  let maxPhraseLen = 1;
  let hasWordList = false;
  if (fs.existsSync(listPath)) {
    hasWordList = true;
    for (const raw of fs.readFileSync(listPath, 'utf8').split(/\r?\n/)) {
      const entry = raw.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!entry || entry.startsWith('#')) continue;
      if (entry.includes(' ')) {
        phrases.set(entry, entry);
        maxPhraseLen = Math.max(maxPhraseLen, entry.split(' ').length);
      } else {
        words.add(entry);
      }
    }
  } else {
    console.warn(`[detect_abstract_nouns] word list not found at ${listPath}; using suffix fallback only`);
  }

  // Team rulings. An explicit team_decision wins over the list and the doc.
  // A borderline/hold/conflict row with no decision yet is pending: not flagged.
  const decisions = new Map();
  const pending = new Set();
  if (fs.existsSync(reviewPath)) {
    const rows = fs.readFileSync(reviewPath, 'utf8').split(/\r?\n/).filter(l => l.trim());
    const header = rows.length ? parseCsvLine(rows[0]).map(h => h.trim().toLowerCase()) : [];
    const wordCol = header.indexOf('english_word');
    const statusCol = header.indexOf('status');
    const decisionCol = header.indexOf('team_decision');
    if (wordCol >= 0) {
      for (const row of rows.slice(1)) {
        const cols = parseCsvLine(row);
        const word = (cols[wordCol] || '').trim().toLowerCase();
        if (!word) continue;
        const decision = decisionCol >= 0 ? normalizeDecision(cols[decisionCol]) : '';
        const status = statusCol >= 0 ? (cols[statusCol] || '').trim().toLowerCase() : '';
        if (decision) decisions.set(word, decision);
        else if (/^(borderline|hold|conflict)\b/.test(status)) pending.add(word);
      }
    }
  }

  let communication = null;
  if (fs.existsSync(docPath)) communication = parseCommunicationWords(fs.readFileSync(docPath, 'utf8'));
  if (!communication) communication = new Set(COMMUNICATION_WORDS_FALLBACK);

  const value = { words, phrases, maxPhraseLen, decisions, pending, communication, hasWordList };
  lexiconCache.key = key;
  lexiconCache.value = value;
  return value;
}

/**
 * Classify one entry (single word or space-joined phrase).
 * @returns {null | { match: string, source: 'team'|'list'|'suffix', confidence: string, reason: string }}
 */
function classifyAbstract(entry, lex, { allowSuffix = true } = {}) {
  const w = entry.toLowerCase();
  const cands = nounCandidates(w);
  for (const c of cands) {
    const d = lex.decisions.get(c);
    if (!d) continue;
    if (d === 'not abstract') return null;
    if (d === 'abstract') return { match: c, source: 'team', confidence: 'medium', reason: 'team ruled abstract (abstract_nouns_review.csv)' };
    if (d === 'context') return { match: c, source: 'team', confidence: 'low', reason: 'team ruled context-dependent (abstract_nouns_review.csv)' };
  }
  if (cands.some(c => lex.communication.has(c))) return null;
  if (cands.some(c => lex.pending.has(c))) return null;
  const dict = w.includes(' ') ? lex.phrases : lex.words;
  for (const c of cands) {
    if (dict.has(c)) return { match: c, source: 'list', confidence: 'medium', reason: 'on abstract_nouns.txt' };
  }
  if (allowSuffix && !w.includes(' ')) {
    const suf = ABSTRACT_FALLBACK_SUFFIXES.find(s => w.endsWith(s) && w.length > s.length + 2);
    if (suf) return { match: w, source: 'suffix', confidence: 'low', reason: `abstract noun suffix -${suf} (not on word list)` };
  }
  return null;
}

/** Find abstract nouns in a run of English text (phrases first, then words). */
function findAbstractInText(text, lex) {
  const tokens = (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [])
    .map(t => ({ raw: t, norm: t.toLowerCase().replace(/['’]s$/, '') }));
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    let matched = false;
    for (let n = Math.min(lex.maxPhraseLen, tokens.length - i); n >= 2; n--) {
      const slice = tokens.slice(i, i + n);
      const hit = classifyAbstract(slice.map(t => t.norm).join(' '), lex, { allowSuffix: false });
      if (hit) {
        hits.push({ word: slice.map(t => t.raw).join(' '), ...hit });
        i += n - 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const hit = classifyAbstract(tokens[i].norm, lex);
    if (hit) hits.push({ word: tokens[i].raw, ...hit });
  }
  return hits;
}

const USFM_HEADER_MARKERS = /^\\(id|ide|usfm|h|toc\d*|toca\d*|mt\d*|mte\d*|rem|sts)\b.*$/gm;

/** Split USFM (or plain text) into [{ ref, text }] segments keyed by \c / \v. */
function splitUsfmVerses(usfm) {
  const clean = String(usfm)
    .replace(USFM_HEADER_MARKERS, ' ')
    .replace(/\\f\s[\s\S]*?\\f\*/g, ' ')
    .replace(/\\x\s[\s\S]*?\\x\*/g, ' ')
    .replace(/\\\+?w\s+([^|\\]*?)(?:\|[^\\]*)?\\\+?w\*/g, '$1')
    .replace(/\\zaln-[se][^\\]*\\\*/g, '')
    .replace(/\\[a-z0-9-]+\*/gi, '');
  const segments = [];
  let chapter = '';
  let verse = '';
  const re = /\\([cv])\s+(\d+[a-z]?(?:-\d+[a-z]?)?)/g;
  let last = 0;
  const push = (txt) => {
    const t = txt.replace(/\\[a-z0-9-]+\s?/gi, ' ');
    if (!t.trim()) return;
    const ref = chapter ? `${chapter}:${verse || '0'}` : verse;
    segments.push({ ref, text: t });
  };
  let m;
  while ((m = re.exec(clean))) {
    push(clean.slice(last, m.index));
    if (m[1] === 'c') { chapter = m[2]; verse = ''; } else verse = m[2];
    last = re.lastIndex;
  }
  push(clean.slice(last));
  return segments;
}

/**
 * Detect abstract nouns in alignment data or ULT text.
 *
 * Matches the team's word list (data/abstract_nouns.txt) as whole words,
 * case-insensitive, with a simple plural fold; applies team rulings from
 * data/abstract_nouns_review.csv; skips the communication words that
 * figs-abstractnouns.md lists as not abstract; and falls back to English
 * suffixes at low confidence for words not on the list.
 */
function detectAbstractNouns({ alignmentJson, text, format }) {
  const fmt = format || 'json';
  const lex = loadAbstractNounLexicon();

  function isSrcNoun(morph) {
    if (!morph) return false;
    return morph.startsWith('He,N') || morph.startsWith('Gr,N') || morph.split(',')[1] === 'N';
  }
  function isSrcAdj(morph) {
    if (!morph) return false;
    return morph.startsWith('He,A') || morph.startsWith('Gr,A') || morph.split(',')[1] === 'A';
  }
  function bump(conf) { return conf === 'low' ? 'medium' : 'high'; }

  const results = [];
  if (alignmentJson) {
    const fpath = path.resolve(CSKILLBP_DIR, alignmentJson);
    const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    const alignments = data.alignments || [];
    for (const a of alignments) {
      const engText = a.englishWords ? a.englishWords.join(' ') : (a.english || '');
      const morph = a.source ? a.source.morph : '';
      for (const hit of findAbstractInText(engText, lex)) {
        let { confidence, reason } = hit;
        if (isSrcNoun(morph)) { confidence = bump(confidence); reason += '; source is noun'; }
        else if (isSrcAdj(morph)) { confidence = bump(confidence); reason += '; source adjective translated as noun'; }
        results.push({
          ref: a.ref, english_word: hit.word, source_word: a.source ? a.source.word : '',
          morph, issue_type: 'figs-abstractnouns', confidence, reason,
        });
      }
    }
  } else if (text) {
    for (const seg of splitUsfmVerses(text)) {
      for (const hit of findAbstractInText(seg.text, lex)) {
        results.push({
          ref: seg.ref, english_word: hit.word, source_word: '', morph: '',
          issue_type: 'figs-abstractnouns', confidence: hit.confidence, reason: hit.reason,
        });
      }
    }
  } else {
    return 'Provide alignmentJson or text parameter';
  }

  if (fmt === 'json') return JSON.stringify(results, null, 2);
  const header = 'Ref\tEnglish\tSource\tMorph\tConfidence\tReason';
  const rows = results.map(r => `${r.ref}\t${r.english_word}\t${r.source_word}\t${r.morph}\t${r.confidence}\t${r.reason}`);
  return [header, ...rows].join('\n');
}

module.exports = {
  checkTwHeadwords, compareUltUst, detectAbstractNouns,
  // exported for tests
  loadAbstractNounLexicon, splitUsfmVerses,
};
