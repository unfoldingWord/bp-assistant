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

/**
 * Detect abstract nouns in alignment data.
 */
function detectAbstractNouns({ alignmentJson, text, format }) {
  const fmt = format || 'json';

  // Hardcoded abstract noun list (common suffixes)
  const ABSTRACT_SUFFIXES = ['ness', 'tion', 'sion', 'ment', 'ity', 'ance', 'ence', 'dom', 'ship', 'hood', 'ure', 'ism'];

  function isAbstract(word) {
    const w = word.toLowerCase();
    return ABSTRACT_SUFFIXES.some(s => w.endsWith(s) && w.length > s.length + 2);
  }

  function isSrcNoun(morph) {
    if (!morph) return false;
    return morph.startsWith('He,N') || morph.startsWith('Gr,N') || morph.split(',')[1] === 'N';
  }
  function isSrcAdj(morph) {
    if (!morph) return false;
    return morph.startsWith('He,A') || morph.startsWith('Gr,A') || morph.split(',')[1] === 'A';
  }

  let data;
  if (alignmentJson) {
    const fpath = path.resolve(CSKILLBP_DIR, alignmentJson);
    data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } else if (text) {
    // Simple word-level check
    const words = text.split(/\s+/);
    const found = words.filter(isAbstract);
    return JSON.stringify(found.map(w => ({ english_word: w, issue_type: 'figs-abstractnouns', confidence: 'medium', reason: 'word has abstract noun suffix' })));
  } else {
    return 'Provide alignmentJson or text parameter';
  }

  const results = [];
  const alignments = data.alignments || [];
  for (const a of alignments) {
    const engWords = a.englishWords || (a.english ? a.english.split(/\s+/) : []);
    for (const word of engWords) {
      if (!isAbstract(word)) continue;
      const morph = a.source ? a.source.morph : '';
      let confidence = 'medium';
      let reason = 'word has abstract noun suffix';
      if (isSrcNoun(morph)) { confidence = 'high'; reason += '; source is noun'; }
      if (isSrcAdj(morph)) { confidence = 'high'; reason += '; source adjective translated as noun'; }

      results.push({
        ref: a.ref, english_word: word, source_word: a.source ? a.source.word : '',
        morph, issue_type: 'figs-abstractnouns', confidence, reason,
      });
    }
  }

  if (fmt === 'json') return JSON.stringify(results, null, 2);
  const header = 'Ref\tEnglish\tSource\tMorph\tConfidence\tReason';
  const rows = results.map(r => `${r.ref}\t${r.english_word}\t${r.source_word}\t${r.morph}\t${r.confidence}\t${r.reason}`);
  return [header, ...rows].join('\n');
}

module.exports = { checkTwHeadwords, compareUltUst, detectAbstractNouns };
