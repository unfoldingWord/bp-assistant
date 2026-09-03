// recurrence-index.js — book-scoped recurrence index for "see how you translated" notes.
//
// Pure helpers only: nothing here reads context.json or the pipeline directory.
// The notes pipeline supplies file contents and writes the result to
// recurrence_index.json; these functions are unit-testable in isolation.
//
// Key idea: a phrase is identified by its original-language Strong's sequence
// (falling back to its consonantal Hebrew text) so that the same phrase is
// recognised across chapters even when the English wording drifts.

// Cantillation / word-joiner / maqaf class. Deliberately identical to the
// CANT_RE defined inside quality-tools.js — duplicated rather than shared so
// that module keeps its own copy.
const CANT_RE = /[֑-֯⁠־]/g;

// Single-word keys only earn a see-how pointer when the earlier note's tA
// article is a consistency-bearing type. Without this guard every repeat of a
// noted common word would collect a pointer.
const SEE_HOW_SINGLE_WORD_SREFS = new Set([
  'translate-names',
  'translate-unknown',
  'translate-transliterate',
  'translate-hebrewmonths',
  'figs-idiom',
  'figs-euphemism',
  'translate-symaction',
  'writing-symlanguage',
  'translate-kinship',
]);

// tA articles whose notes are wanted at EVERY occurrence, so they are never
// folded into an "also occurs" list, never rewritten as a pointer, never used
// as a pointer target, and never injected. issue-identification/SKILL.md:28
// requires hinneh foregrounding to be noted every time it appears.
const SEE_HOW_NEVER_FOLD_SREFS = new Set(['writing-foreground']);

// Ultra-frequent lemmas that never earn a single-word pointer. Stored both as
// Strong's numbers and as consonant-only Hebrew so either key form matches.
const SEE_HOW_STOPLIST = new Set([
  // Strong's
  'H3068', 'H430', 'H559', 'H1961', 'H3605', 'H834', 'H853', 'H413', 'H5921',
  'H3808', 'H1121', 'H776', 'H5971', 'H4428', 'H1697', 'H3027', 'H3117',
  'H3478', 'H6440', 'H3651', 'H1004', 'H3588',
  // consonant-only Hebrew
  'יהוה', 'אלהים', 'אמר', 'היה', 'כל', 'אשר', 'את', 'אל', 'על', 'לא',
  'בן', 'ארץ', 'עם', 'מלך', 'דבר', 'יד', 'יום', 'ישראל', 'פנים', 'כן',
  'בית', 'כי',
]);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalizeStrong(raw) {
  const s = String(raw || '').replace(/^(?:[a-z]:)+/, '');
  return /^[HG]\d/.test(s) ? s : null;
}

/**
 * Consonant-only tokens for a Hebrew string. NFC first (this repo's recurring
 * bug class), word-joiner removed so prefixed forms stay one token, maqaf
 * treated as a word break, then every point/accent stripped.
 */
function hebTokens(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/⁠/g, '')
    .replace(/־/g, ' ')
    .replace(/[֑-ׇ]/g, '')
    .split(/[\s׀׃.,;:!?"'’“”()\[\]]+/)
    .filter(Boolean);
}

/** Cantillation-stripped NFC form, used for whole-string comparisons. */
function stripCant(text) {
  return String(text || '').normalize('NFC').replace(CANT_RE, '');
}

// ---------------------------------------------------------------------------
// Aligned USFM → ordered original-language words per verse
// ---------------------------------------------------------------------------

/**
 * Walk aligned ULT USFM and emit one record per `\zaln-s` milestone, in verse
 * order. Milestone open order is original-language word order, so the result is
 * the verse's Hebrew/Greek word sequence with its Strong's numbers.
 *
 * A milestone repeated for a discontiguous English rendering is collapsed, so
 * each source word appears once per verse.
 *
 * This is a copy of the milestone-stack walk in index-tools.js
 * (`parseAlignedUsfm`); that function is left alone because curate-data depends
 * on its exact output shape.
 *
 * @param {string} content aligned USFM
 * @returns {Array<{book:string,chapter:number,verse:string,ref:string,strong:string,heb:string,occurrence:(number|null)}>}
 */
function parseAlignedUsfmSpans(content) {
  const out = [];
  let book = '', chapter = 0, verse = '0';
  const idMatch = String(content || '').match(/\\id\s+(\S+)/);
  if (idMatch) book = idMatch[1].substring(0, 3).toUpperCase();

  const ZALN_S = /\\zaln-s\s+\|([^\\]*?)\\?\*/g;
  const ZALN_E = /\\zaln-e\\?\*/g;

  const seenPerVerse = new Map(); // ref -> Set of dedupe keys
  const stackDepthByRef = new Map();

  for (const rawLine of String(content || '').split('\n')) {
    let trimmed = rawLine.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { chapter = parseInt(cm[1], 10); verse = '0'; trimmed = trimmed.slice(cm[0].length).trim(); }
    const vm = trimmed.match(/\\v\s+(\d+[-\d]*|front)/);
    if (vm) { verse = String(vm[1]).split('-')[0]; }
    if (!trimmed || !chapter) continue;

    const ref = `${chapter}:${verse}`;
    if (!seenPerVerse.has(ref)) seenPerVerse.set(ref, new Set());
    const seen = seenPerVerse.get(ref);

    const tokens = [];
    let m;
    ZALN_S.lastIndex = 0;
    while ((m = ZALN_S.exec(trimmed)) !== null) tokens.push({ idx: m.index, attrs: m[1] });
    ZALN_E.lastIndex = 0;
    while ((m = ZALN_E.exec(trimmed)) !== null) tokens.push({ idx: m.index, close: true });
    tokens.sort((a, b) => a.idx - b.idx);

    for (const tok of tokens) {
      if (tok.close) {
        stackDepthByRef.set(ref, Math.max(0, (stackDepthByRef.get(ref) || 0) - 1));
        continue;
      }
      stackDepthByRef.set(ref, (stackDepthByRef.get(ref) || 0) + 1);
      const sM = tok.attrs.match(/x-strong="([^"]*)"/);
      const cM = tok.attrs.match(/x-content="([^"]*)"/);
      const oM = tok.attrs.match(/x-occurrence="(\d+)"/);
      const strong = sM ? sM[1] : '';
      const heb = cM ? cM[1] : '';
      const occurrence = oM ? parseInt(oM[1], 10) : null;
      const dedupe = `${strong}|${heb}|${occurrence == null ? '' : occurrence}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ book, chapter, verse, ref, strong, heb, occurrence });
    }
  }
  return out;
}

/**
 * Word list from unaligned UHB USFM (`\w form|...strong="c:H1961"...\w*`).
 *
 * Fills verses the aligned ULT does not cover, and — via `sepAfter`, the literal
 * separator that follows each word in the source (a maqaf `־` or a space) —
 * lets a multi-word span be sliced back out byte-for-byte. That exactness
 * matters: syncCanonicalHebrewQuotes compares a row's Quote against the source
 * literally, and a rebuilt-with-spaces quote is tagged ISSUE:MATCH_FAIL.
 */
function parseHebrewUsfmWords(content) {
  const out = [];
  let book = '', chapter = 0, verse = '0';
  const idMatch = String(content || '').match(/\\id\s+(\S+)/);
  if (idMatch) book = idMatch[1].substring(0, 3).toUpperCase();
  const WORD = /\\w\s+([^|\\]+)\|([^\\]*?)\\w\*/g;

  for (const rawLine of String(content || '').split('\n')) {
    let trimmed = rawLine.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { chapter = parseInt(cm[1], 10); verse = '0'; trimmed = trimmed.slice(cm[0].length).trim(); }
    const vm = trimmed.match(/\\v\s+(\d+[-\d]*|front)/);
    if (vm) { verse = String(vm[1]).split('-')[0]; }
    if (!trimmed || !chapter) continue;
    let m;
    WORD.lastIndex = 0;
    const lineWords = [];
    while ((m = WORD.exec(trimmed)) !== null) {
      const attrs = m[2] || '';
      const sM = attrs.match(/strong="([^"]*)"/);
      lineWords.push({
        book,
        chapter,
        verse,
        ref: `${chapter}:${verse}`,
        strong: sM ? sM[1] : '',
        heb: m[1].trim(),
        occurrence: null,
        sepAfter: ' ',
        _start: m.index,
        _end: m.index + m[0].length,
      });
    }
    // The literal text between two words is the separator that must be
    // reproduced when a span is sliced back out — usually a maqaf or a space.
    for (let i = 0; i < lineWords.length; i++) {
      const next = lineWords[i + 1];
      const between = next ? trimmed.slice(lineWords[i]._end, next._start) : '';
      lineWords[i].sepAfter = between.includes('־') ? '־' : ' ';
      delete lineWords[i]._start;
      delete lineWords[i]._end;
      out.push(lineWords[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function keysFromWordRun(run) {
  const strongs = run.map((w) => normalizeStrong(w.strong));
  const textTokens = run.flatMap((w) => hebTokens(w.heb));
  return {
    strongKey: strongs.every(Boolean) && strongs.length ? strongs.join('+') : '',
    textKey: textTokens.length ? textTokens.join('+') : '',
  };
}

/**
 * Derive both key forms for a prepared item's original-language quote.
 * `alignmentEntries` is the alignment_data.json array for the item's verse:
 * `[{ eng, heb, heb_pos, strong, occurrence }]`.
 */
function deriveRecurrenceKeys({ origQuote = '', alignmentEntries = [] } = {}) {
  const segments = String(origQuote || '').split('&');
  const allTokens = [];
  const strongs = [];
  let allResolved = true;

  const byToken = new Map();
  for (const entry of alignmentEntries || []) {
    for (const tok of hebTokens(entry && entry.heb)) {
      if (!byToken.has(tok)) byToken.set(tok, entry);
    }
  }

  for (const segment of segments) {
    for (const tok of hebTokens(segment)) {
      allTokens.push(tok);
      const entry = byToken.get(tok);
      const strong = entry ? normalizeStrong(entry.strong) : null;
      if (strong) strongs.push(strong); else allResolved = false;
    }
  }

  return {
    strongKey: allResolved && strongs.length ? strongs.join('+') : '',
    textKey: allTokens.length ? allTokens.join('+') : '',
  };
}

/**
 * The single key used to group occurrences: the Strong's sequence when every
 * quote word resolves through alignment data, otherwise the consonantal text.
 */
function deriveRecurrenceKey(args) {
  const { strongKey, textKey } = deriveRecurrenceKeys(args);
  return strongKey || textKey;
}

function keyWordCount(key) {
  return String(key || '').split('+').filter(Boolean).length;
}

/**
 * Eligibility guard: multi-word keys always qualify; single-word keys need a
 * consistency-bearing tA article and a lemma that is not ultra-frequent.
 */
function isSeeHowEligible(key, sref) {
  if (!key) return false;
  if (SEE_HOW_NEVER_FOLD_SREFS.has(String(sref || ''))) return false;
  const parts = String(key).split('+').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length > 1) return true;
  if (!SEE_HOW_SINGLE_WORD_SREFS.has(String(sref || ''))) return false;
  if (SEE_HOW_STOPLIST.has(parts[0])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Canonical TN link: `[C:V](../CC/VV.md)`. Both chapter and verse pad to three
 * digits for PSA, two otherwise. Verse bridges link on their first verse.
 */
function formatTnLink(book, chapter, verse) {
  const pad = String(book || '').toUpperCase() === 'PSA' ? 3 : 2;
  const ch = String(chapter == null ? '' : chapter).trim();
  const vs = String(verse == null ? '' : verse).trim().split(/[-–]/)[0];
  if (!ch || !vs) return '';
  return `[${ch}:${vs}](../${ch.padStart(pad, '0')}/${vs.padStart(pad, '0')}.md)`;
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The pointer sentence. Wording follows the published corpus:
 *   same tA article + identical GL wording → bolded quote
 *   same tA article, different wording     → this name / word / phrase / expression
 *   different tA article                   → the similar expression
 */
function buildSeeHowSentence({
  book = '',
  targetRef = '',
  glQuote = '',
  sameSref = false,
  sameWording = false,
  sref = '',
} = {}) {
  const [ch, vs] = String(targetRef || '').split(':');
  const link = formatTnLink(book, ch, vs);
  if (!link) return '';

  let subject;
  if (sameSref && sameWording && String(glQuote || '').trim()) {
    subject = `**${String(glQuote).trim()}**`;
  } else if (sameSref) {
    const words = countWords(glQuote);
    if (String(sref || '') === 'translate-names') subject = 'this name';
    // No GL wording to characterise (e.g. a deterministically injected pointer)
    // — fall back to the corpus's most common frame.
    else if (words === 0) subject = 'the similar expression';
    else if (words === 1) subject = 'this word';
    else if (words >= 2 && words <= 5) subject = 'this phrase';
    else subject = 'this expression';
  } else {
    subject = 'the similar expression';
  }
  return `See how you translated ${subject} in ${link}.`;
}

/** Token sequence of a recurrence key (Strong's numbers, or text tokens). */
function keyTokens(key) {
  return String(key || '').split('+').filter(Boolean);
}

/** True when `a`'s token sequence appears contiguously inside `b`'s. */
function isKeySubsequence(a, b) {
  const ta = keyTokens(a);
  const tb = keyTokens(b);
  if (!ta.length || ta.length > tb.length) return false;
  for (let i = 0; i + ta.length <= tb.length; i++) {
    let ok = true;
    for (let k = 0; k < ta.length; k++) {
      if (ta[k] !== tb[i + k]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Decide which keys may carry a corpus-derived "also occurs" list.
 *
 * A fixed formula and its sub-phrases all match the same verses. On published
 * ZEC 8, "thus says Yahweh of hosts" (H3541+H0559+H3068+H6635b) plus its two
 * sub-phrases each produced a near-identical "This also occurs in verses …"
 * sentence. When one key's token sequence sits contiguously inside another's,
 * only the longest of the related keys carries the corpus list; the shorter
 * ones keep just the verses of their own folded prepared siblings.
 *
 * Keys related by containment form one cluster (so a chain A ⊂ B ⊂ C leaves
 * only C). Ties on length are broken by the earlier anchor verse, then by key
 * so the result is deterministic.
 *
 * @param {Array<{key: string, anchorVerse: (number|string)}>} groups
 *   One entry per key that has an anchor item in the current chapter.
 * @returns {Set<string>} the keys allowed to carry corpus-derived verses
 */
function selectAlsoOccursCarriers(groups) {
  const list = [];
  const seenKeys = new Set();
  for (const g of groups || []) {
    if (!g || !g.key || seenKeys.has(g.key)) continue;
    seenKeys.add(g.key);
    const n = parseInt(g.anchorVerse, 10);
    list.push({
      key: String(g.key),
      tokens: keyTokens(g.key),
      anchorVerse: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER,
    });
  }
  const carriers = new Set();
  if (!list.length) return carriers;

  // Union keys related by containment into clusters.
  const parent = list.map((_, i) => i);
  const find = (x) => { let r = x; while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; } return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      if (list[i].tokens.length >= list[j].tokens.length) continue;
      if (isKeySubsequence(list[i].key, list[j].key)) union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(list[i]);
  }
  for (const members of clusters.values()) {
    members.sort((a, b) =>
      (b.tokens.length - a.tokens.length) ||
      (a.anchorVerse - b.anchorVerse) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    carriers.add(members[0].key);
  }
  return carriers;
}

/**
 * Collapse an "also occurs" verse list on the NUMERIC first verse, not on the
 * string. A folded prepared item contributes "5" while a source span for the
 * same bridge contributes "5-6"; keyed by string those survive as two entries
 * and render as "verses 5 and 5-6". The bridge form wins, because it says more.
 * Returns the surviving verse strings in ascending order.
 */
function dedupeAlsoOccursVerses(verses) {
  const isBridge = (s) => /[-–]/.test(s);
  const byNumber = new Map();
  for (const raw of verses || []) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) continue;
    const n = verseNumber(v);
    const existing = byNumber.get(n);
    if (existing === undefined) { byNumber.set(n, v); continue; }
    if (!isBridge(existing) && isBridge(v)) byNumber.set(n, v);
  }
  return [...byNumber.keys()].sort((a, b) => a - b).map((n) => byNumber.get(n));
}

/**
 * `This also occurs in verses 5, 7, 8, and 11.` — plain text, Oxford comma.
 * Runs of three or more consecutive verses collapse to `5–7` (en dash); a verse
 * bridge keeps its own span, rendered with an en dash.
 */
function formatAlsoOccurs(verses) {
  const parts = dedupeAlsoOccursVerses(verses);
  if (parts.length === 0) return '';

  // Collapse runs of 3+ consecutive plain verse numbers.
  const rendered = [];
  let i = 0;
  while (i < parts.length) {
    const isPlain = (s) => /^\d+$/.test(s);
    if (!isPlain(parts[i])) {
      rendered.push(parts[i].replace(/-/g, '–'));
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < parts.length &&
      isPlain(parts[j + 1]) &&
      parseInt(parts[j + 1], 10) === parseInt(parts[j], 10) + 1
    ) j++;
    if (j - i >= 2) {
      rendered.push(`${parts[i]}–${parts[j]}`);
      i = j + 1;
    } else {
      rendered.push(parts[i]);
      i++;
    }
  }

  const noun = rendered.length === 1 && /^\d+$/.test(rendered[0]) ? 'verse' : 'verses';
  let list;
  if (rendered.length === 1) list = rendered[0];
  else if (rendered.length === 2) list = `${rendered[0]} and ${rendered[1]}`;
  else list = `${rendered.slice(0, -1).join(', ')}, and ${rendered[rendered.length - 1]}`;
  return `This also occurs in ${noun} ${list}.`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function refParts(ref) {
  const [c, v] = String(ref || '').split(':');
  return { chapter: parseInt(c, 10) || 0, verse: String(v || '').trim() };
}

function verseNumber(verse) {
  return parseInt(String(verse || '').split(/[-–]/)[0], 10) || 0;
}

function parseTnTsv(tsv) {
  const rows = [];
  const lines = String(tsv || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (i === 0 && /^reference$/i.test((cols[0] || '').trim())) continue;
    const ref = (cols[0] || '').trim();
    if (!/^\d+:\d/.test(ref)) continue;
    rows.push({
      ref,
      id: (cols[1] || '').trim(),
      sref: (cols[3] || '').trim().replace(/^rc:\/\/\*\/ta\/man\/translate\//, ''),
      quote: (cols[4] || '').trim(),
      note: (cols[6] || '').trim(),
    });
  }
  return rows;
}

/** Index range of a consecutive run of source words matching `tokens`, or null. */
function findRunIndexByTokens(words, tokens) {
  if (!tokens.length) return null;
  const wordTokens = words.map((w) => hebTokens(w.heb));
  for (let i = 0; i < words.length; i++) {
    let ti = 0;
    let j = i;
    while (j < words.length && ti < tokens.length) {
      const wt = wordTokens[j];
      if (wt.length === 0) break;
      let k = 0;
      while (k < wt.length && ti < tokens.length && wt[k] === tokens[ti]) { k++; ti++; }
      if (k !== wt.length) break;
      j++;
    }
    if (ti === tokens.length) return { start: i, end: j - 1 };
  }
  return null;
}

/** Find a consecutive run of source words in `words` matching `tokens`. */
function findRunByTokens(words, tokens) {
  const range = findRunIndexByTokens(words, tokens);
  return range ? words.slice(range.start, range.end + 1) : null;
}

/**
 * Slice `words[start..end]` back out as the source wrote it, reproducing each
 * word's own separator so a maqaf-joined pair comes back as `דְּבַר־יְהוָ֖ה`
 * rather than a space-join.
 */
function joinSourceSpan(words, start, end) {
  let out = words[start].heb;
  for (let i = start; i < end; i++) {
    out += (words[i].sepAfter || ' ') + words[i + 1].heb;
  }
  return out;
}

/** Find a consecutive run of source words whose Strong's sequence equals `strongs`. */
function findRunByStrongs(words, strongs) {
  if (!strongs.length) return null;
  for (let i = 0; i + strongs.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < strongs.length; k++) {
      if (normalizeStrong(words[i + k].strong) !== strongs[k]) { ok = false; break; }
    }
    if (ok) return words.slice(i, i + strongs.length);
  }
  return null;
}

/**
 * Build the book-scoped recurrence index.
 *
 * Occurrences are uncapped (unlike buildAlignmentIndex's 5-ref cap) and sorted
 * ascending by chapter then verse. Note rows are restricted to chapters before
 * the current one so a chapter's own stale notes can never become a pointer
 * target; source-text spans cover chapters up to and including the current one
 * so same-chapter repeats are visible.
 *
 * @returns {{book:string, chapter:number, byKey:Object, keyById:Object, counts:Object}}
 */
function buildBookRecurrenceIndex({
  book = '',
  chapter = 0,
  ultFullUsfm = '',
  hebrewUsfm = '',
  tnBookTsv = '',
  preparedItems = [],
  alignmentData = {},
} = {}) {
  const bookUpper = String(book || '').toUpperCase();
  const curChapter = parseInt(chapter, 10) || 0;

  // 1. Source-text words per verse (aligned ULT preferred, UHB fills gaps).
  const byVerse = new Map();
  const addWords = (records) => {
    for (const rec of records) {
      if (!rec.chapter) continue;
      if (curChapter && rec.chapter > curChapter) continue;
      if (!byVerse.has(rec.ref)) byVerse.set(rec.ref, []);
      byVerse.get(rec.ref).push(rec);
    }
  };
  let alignedRecords = [];
  try { alignedRecords = parseAlignedUsfmSpans(ultFullUsfm || ''); } catch { alignedRecords = []; }
  addWords(alignedRecords);
  // The UHB is kept separately as well as used to fill gaps: it is the only
  // source that carries the literal maqaf/space separators needed to slice a
  // span back out byte-for-byte (see joinSourceSpan).
  const uhbByVerse = new Map();
  if (hebrewUsfm) {
    const existing = new Set(byVerse.keys());
    let hebRecords = [];
    try { hebRecords = parseHebrewUsfmWords(hebrewUsfm); } catch { hebRecords = []; }
    for (const rec of hebRecords) {
      if (!rec.chapter || (curChapter && rec.chapter > curChapter)) continue;
      if (!uhbByVerse.has(rec.ref)) uhbByVerse.set(rec.ref, []);
      uhbByVerse.get(rec.ref).push(rec);
      if (existing.has(rec.ref)) continue;
      if (!byVerse.has(rec.ref)) byVerse.set(rec.ref, []);
      byVerse.get(rec.ref).push(rec);
    }
  }
  let inexactSpans = 0;
  const exactSourceSpan = (ref, tokens) => {
    const words = uhbByVerse.get(ref);
    if (!words || !words.length) return '';
    const range = findRunIndexByTokens(words, tokens);
    if (!range) return '';
    return joinSourceSpan(words, range.start, range.end);
  };

  // 2. Query keys: every note row from an earlier chapter, plus this run's items.
  const byKey = {};
  const pushOcc = (keys, occ) => {
    for (const key of keys) {
      if (!key) continue;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push({ ...occ });
    }
  };

  const queryKeys = new Map(); // key -> { strongs: string[]|null, tokens: string[] }

  const registerQuery = (strongKey, textKey) => {
    if (strongKey && !queryKeys.has(strongKey)) {
      queryKeys.set(strongKey, { strongs: strongKey.split('+'), tokens: null });
    }
    if (textKey && !queryKeys.has(textKey)) {
      queryKeys.set(textKey, { strongs: null, tokens: textKey.split('+') });
    }
  };

  let noteRowCount = 0;
  for (const row of parseTnTsv(tnBookTsv)) {
    const { chapter: rowCh, verse: rowVs } = refParts(row.ref);
    if (!rowCh || (curChapter && rowCh >= curChapter)) continue;
    const words = byVerse.get(`${rowCh}:${verseNumber(rowVs)}`) || [];
    const tokens = String(row.quote || '').split('&').flatMap((seg) => hebTokens(seg));
    if (!tokens.length) continue;
    const run = findRunByTokens(words, tokens);
    const strongKey = run ? keysFromWordRun(run).strongKey : '';
    const textKey = tokens.join('+');
    registerQuery(strongKey, textKey);
    noteRowCount++;
    pushOcc([strongKey, textKey].filter(Boolean), {
      ref: row.ref,
      chapter: rowCh,
      verse: rowVs,
      sref: row.sref,
      quote: row.quote,
      note: row.note,
      isPointer: /^\s*See how you translated/i.test(row.note),
      source: 'tn',
      id: row.id,
    });
  }

  let preparedCount = 0;
  const keyById = {};
  for (const item of preparedItems || []) {
    const { chapter: itemCh, verse: itemVs } = refParts(item.reference);
    const alignmentEntries = (alignmentData && alignmentData[`${itemCh}:${verseNumber(itemVs)}`]) || [];
    const { strongKey, textKey } = deriveRecurrenceKeys({
      origQuote: item.orig_quote || '',
      alignmentEntries,
    });
    const key = strongKey || textKey;
    if (item.id) keyById[item.id] = key;
    if (!key) continue;
    registerQuery(strongKey, textKey);
    preparedCount++;
    pushOcc([strongKey, textKey].filter(Boolean), {
      ref: item.reference,
      chapter: itemCh,
      verse: itemVs,
      sref: item.sref || '',
      quote: item.orig_quote || '',
      note: '',
      isPointer: false,
      source: 'prepared',
      id: item.id || '',
    });
  }

  // 3. Corpus occurrences: scan every verse for each query key.
  let corpusCount = 0;
  // Candidate verses by first element, so a book-wide scan stays linear-ish.
  const byFirstStrong = new Map();
  const byFirstToken = new Map();
  for (const [ref, words] of byVerse.entries()) {
    for (const w of words) {
      const st = normalizeStrong(w.strong);
      if (st) {
        if (!byFirstStrong.has(st)) byFirstStrong.set(st, new Set());
        byFirstStrong.get(st).add(ref);
      }
      const toks = hebTokens(w.heb);
      if (toks.length) {
        if (!byFirstToken.has(toks[0])) byFirstToken.set(toks[0], new Set());
        byFirstToken.get(toks[0]).add(ref);
      }
    }
  }
  for (const [key, spec] of queryKeys.entries()) {
    const candidates = spec.strongs
      ? (byFirstStrong.get(spec.strongs[0]) || new Set())
      : (byFirstToken.get(spec.tokens[0]) || new Set());
    for (const ref of candidates) {
      const words = byVerse.get(ref) || [];
      const run = spec.strongs
        ? findRunByStrongs(words, spec.strongs)
        : findRunByTokens(words, spec.tokens);
      if (!run || !run.length) continue;
      const { chapter: ch, verse: vs } = refParts(ref);
      corpusCount++;
      // Prefer the literal UHB slice; a space-join is only a fallback, because
      // an injected row's Quote is later matched against the source verbatim.
      const runTokens = run.flatMap((w) => hebTokens(w.heb));
      const exact = exactSourceSpan(ref, runTokens);
      if (!exact) inexactSpans++;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push({
        ref,
        chapter: ch,
        verse: vs,
        sref: '',
        quote: exact || run.map((w) => w.heb).join(' '),
        quote_exact: !!exact,
        note: '',
        isPointer: false,
        source: 'corpus',
        id: '',
      });
    }
  }

  // 4. Sort ascending and drop duplicate (ref, source) pairs.
  for (const key of Object.keys(byKey)) {
    const seen = new Set();
    const list = [];
    for (const occ of byKey[key]) {
      const dedupe = `${occ.ref}|${occ.source}|${occ.id || ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      list.push(occ);
    }
    list.sort((a, b) => (a.chapter - b.chapter) || (verseNumber(a.verse) - verseNumber(b.verse)));
    byKey[key] = list;
  }

  if (inexactSpans > 0) {
    console.warn(
      `[recurrence-index] ${inexactSpans} source span(s) could not be located in the UHB; ` +
      'their quotes fall back to a space-join and may not match the source byte-for-byte'
    );
  }

  return {
    book: bookUpper,
    chapter: curChapter,
    byKey,
    keyById,
    counts: {
      keys: Object.keys(byKey).length,
      noteRows: noteRowCount,
      preparedItems: preparedCount,
      corpusSpans: corpusCount,
      inexactSpans,
      verses: byVerse.size,
    },
  };
}

module.exports = {
  buildBookRecurrenceIndex,
  parseAlignedUsfmSpans,
  parseHebrewUsfmWords,
  joinSourceSpan,
  findRunIndexByTokens,
  deriveRecurrenceKey,
  deriveRecurrenceKeys,
  formatTnLink,
  buildSeeHowSentence,
  formatAlsoOccurs,
  dedupeAlsoOccursVerses,
  selectAlsoOccursCarriers,
  isKeySubsequence,
  keyTokens,
  isSeeHowEligible,
  keyWordCount,
  hebTokens,
  stripCant,
  normalizeStrong,
  parseTnTsv,
  verseNumber,
  CANT_RE,
  SEE_HOW_SINGLE_WORD_SREFS,
  SEE_HOW_STOPLIST,
  SEE_HOW_NEVER_FOLD_SREFS,
};
