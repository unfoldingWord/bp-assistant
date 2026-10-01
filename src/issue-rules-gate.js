// issue-rules-gate.js — one model pass over an issues TSV, per chapter, that
// reviews every row against the current issue-identification rules and applies
// keep / drop / relabel / rescope (and, behind a flag, add) verdicts in code.
//
// Issue lists are often produced weeks before the notes run, under older rules.
// The model only returns verdicts; everything that touches the file is
// deterministic here: only columns 3 (sref) and 4 (GLQuote) of existing rows
// change, untouched rows keep their exact bytes, a chunk is applied only when
// the model answered every row in it, drops are capped, and a row-count check
// restores the original bytes on any mismatch. Never throws.
//
// Plumbing (TSV round trip, chunking, tolerant JSON, report) is ported from the
// closed interp-review stage (branch claude/fable-review-difficult-notes-897804).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CSKILLBP_DIR, isUsageLimitError } = require('./pipeline-utils');

const MAX_DROP_SHARE = 0.25;
const MAX_ROWS_PER_CHUNK = 40;
const MAX_ADDS_PER_CHAPTER = 10;
const PR_BODY_MAX = 3500;
const PR_BODY_MAX_LINES = 25;
const DUPLICATE_OVERLAP = 0.5;

const SREF_RE = /^[a-z]+(-[a-z0-9]+)+$/;
const ACTIONS = new Set(['keep', 'drop', 'relabel', 'rescope']);
const VALID_MODES = new Set(['off', 'apply']);
const DEFAULT_SETTINGS = {
  mode: 'apply',
  books: 'all',
  allowAdd: false,
  effort: 'high',
  protectSrefs: ['figs-parallelism', 'figs-activepassive'],
  // Benchmark 2026-09-30 (EZK 1-5): drops citing issue_decisions.csv rows (LAM/HAB
  // deletion statistics and broad 'drop when' add-ons) removed 39 notes editors kept
  // for 7 they deleted. The gate therefore applies only curated G-rules by default.
  useDecisionRows: false,
  requireGRule: true,
};

// --- Settings ----------------------------------------------------------------------

function resolveSettings({ config, env, book }) {
  const cfg = (config && config.rulesGate) || {};
  const merged = { ...DEFAULT_SETTINGS, ...cfg };
  const e = env || {};
  let { mode, books, allowAdd, effort } = merged;
  let model = merged.model || undefined;

  if (e.BP_RULES_GATE_MODE) mode = String(e.BP_RULES_GATE_MODE).trim().toLowerCase();
  if (e.BP_RULES_GATE_BOOKS) {
    const raw = String(e.BP_RULES_GATE_BOOKS).trim();
    books = raw.toLowerCase() === 'all' ? 'all' : raw.split(',').map((b) => b.trim()).filter(Boolean);
  }
  if (e.BP_RULES_GATE_ALLOW_ADD != null && e.BP_RULES_GATE_ALLOW_ADD !== '') {
    allowAdd = /^(1|true|yes|on)$/i.test(String(e.BP_RULES_GATE_ALLOW_ADD).trim());
  }
  if (e.BP_RULES_GATE_MODEL) model = String(e.BP_RULES_GATE_MODEL).trim();
  if (e.BP_RULES_GATE_EFFORT) effort = String(e.BP_RULES_GATE_EFFORT).trim();

  if (!VALID_MODES.has(mode)) {
    console.warn(`[issue-rules-gate] Invalid mode "${mode}", defaulting to off`);
    mode = 'off';
  }
  const bookUpper = String(book || '').toUpperCase();
  // books: "all", "JER,EZK" (comma-separated string) or an array; "all" anywhere enables every book.
  const bookNames = (Array.isArray(books) ? books : (typeof books === 'string' ? books.split(',') : []))
    .map((b) => String(b).trim().toUpperCase()).filter(Boolean);
  const bookEnabled = bookNames.includes('ALL') || bookNames.includes(bookUpper);

  const protectSrefs = new Set((Array.isArray(merged.protectSrefs) ? merged.protectSrefs : [])
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean));

  const useDecisionRows = merged.useDecisionRows === true
    || /^(1|true|yes|on)$/i.test(String(e.BP_RULES_GATE_DECISION_ROWS || '').trim());
  const requireGRule = merged.requireGRule !== false
    && !/^(0|false|no|off)$/i.test(String(e.BP_RULES_GATE_REQUIRE_G_RULE || '').trim());
  return { mode, bookEnabled, allowAdd: allowAdd === true, effort: effort || 'high', model, protectSrefs, useDecisionRows, requireGRule };
}

// --- TSV parsing / serialization ---------------------------------------------------

function verseOfRef(ref) {
  const m = String(ref || '').trim().match(/^(\d+):(\d+)/);
  return m ? { chapter: Number(m[1]), verse: Number(m[2]) } : null;
}

/**
 * Parse an issues TSV into rows. Header lines, blank lines, `:intro` rows and
 * rows with fewer than 4 columns are passthrough: they round-trip unchanged
 * and are never sent to the model. Rows whose reference is not C:V are
 * passthrough as well, since there is no verse to judge them against.
 */
function parseIssuesTsv(text) {
  const lineEnding = String(text).includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = String(text).endsWith(lineEnding);
  let body = String(text);
  if (trailingNewline) body = body.slice(0, -lineEnding.length);
  const lines = body.length ? body.split(lineEnding) : [];

  const rows = lines.map((line, i) => {
    const cols = line.split('\t');
    if (cols.length < 4) return { index: i, raw: line, passthrough: true };
    const ref = String(cols[1] || '').trim();
    if (ref.toLowerCase().endsWith(':intro')) return { index: i, raw: line, passthrough: true };
    if (/^book$/i.test(String(cols[0]).trim()) && /^ref/i.test(ref)) return { index: i, raw: line, passthrough: true };
    const cv = verseOfRef(ref);
    if (!cv) return { index: i, raw: line, passthrough: true };
    return {
      index: i,
      cols,
      book: cols[0],
      ref,
      chapter: cv.chapter,
      verse: cv.verse,
      sref: cols[2],
      quote: cols[3],
      explanation: cols.slice(6).join('\t'),
      raw: line,
    };
  });
  Object.defineProperty(rows, '__meta', { value: { lineEnding, trailingNewline }, enumerable: false, writable: true });
  return rows;
}

function rowToLine(row) {
  if (row.passthrough || row.raw != null) return row.raw;
  return row.cols.join('\t');
}

function serializeIssuesTsv(rows) {
  const meta = (rows && rows.__meta) || { lineEnding: '\n', trailingNewline: true };
  const text = rows.map(rowToLine).join(meta.lineEnding);
  return meta.trailingNewline && rows.length ? text + meta.lineEnding : text;
}

function copyMeta(from, to) {
  const meta = (from && from.__meta) || { lineEnding: '\n', trailingNewline: true };
  Object.defineProperty(to, '__meta', { value: meta, enumerable: false, writable: true });
  return to;
}

const dataRows = (rows) => rows.filter((r) => !r.passthrough);

/** Rows outside the chapter (or verse range) become passthrough: never judged, never counted. */
function markOutOfScope(rows, chapter, range) {
  for (const r of rows) {
    if (r.passthrough) continue;
    if (r.chapter !== Number(chapter) || (range && (r.verse < range.start || r.verse > range.end))) r.passthrough = true;
  }
  return rows;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function hashNonIntroRows(rows) {
  return sha256(dataRows(rows).map((r) => rowToLine(r)).join('\n'));
}

// --- Cell sanitizing ---------------------------------------------------------------

function sanitizeCell(text) {
  return String(text == null ? '' : text).replace(/[\t\r\n]+/g, ' ').trim();
}

// --- Decision rules / catalog ------------------------------------------------------

function getParseCsv() {
  return require('./human-decision-conflicts').parseCsv;
}

function slugFromIssueType(issueType, phrase) {
  const it = String(issueType || '').trim();
  const tail = it.split('/').filter(Boolean).pop() || '';
  if (SREF_RE.test(tail.toLowerCase())) return tail.toLowerCase();
  const ph = String(phrase || '').trim().toLowerCase();
  if (SREF_RE.test(ph)) return ph;
  return it;
}

/**
 * Rows of issue_decisions.csv that apply to `book` (Book is the book code or
 * ALL, case-insensitive). The id is D<1-based data-row number> over the whole
 * file, so ids stay stable when the file is filtered.
 */
function loadDecisionRules({ csvText, book }) {
  const rows = getParseCsv()(csvText || '');
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (name, fallback) => { const i = header.indexOf(name); return i >= 0 ? i : fallback; };
  const iPhrase = col('phrase', 0);
  const iType = col('issuetype', 1);
  const iBook = col('book', 2);
  const iContext = col('context', 3);
  const iNotes = col('notes', 4);
  const bookUpper = String(book || '').trim().toUpperCase();
  const out = [];
  rows.slice(1).forEach((r, i) => {
    const rowBook = String(r[iBook] || '').trim().toUpperCase();
    if (rowBook !== 'ALL' && rowBook !== bookUpper) return;
    const phrase = String(r[iPhrase] || '').trim();
    out.push({
      id: `D${i + 1}`,
      phrase,
      slug: slugFromIssueType(r[iType], phrase),
      book: String(r[iBook] || '').trim(),
      context: String(r[iContext] || '').trim(),
      notes: String(r[iNotes] || '').trim(),
    });
  });
  return out;
}

function activeGRuleIds(rulesText) {
  const ids = new Set();
  for (const line of String(rulesText || '').split(/\r?\n/)) {
    const heading = line.match(/^\s*-\s+\*\*(G\d+)\b.*\*\*/i);
    if (heading && !/\(on hold\)/i.test(line)) ids.add(heading[1].toUpperCase());
  }
  return ids;
}

function loadCatalog(csvText) {
  const rows = getParseCsv()(csvText || '');
  const set = new Set();
  rows.slice(1).forEach((r) => {
    const s = String(r[0] || '').trim().toLowerCase();
    if (SREF_RE.test(s)) set.add(s);
  });
  return set;
}

// --- Source text -------------------------------------------------------------------

function sliceChapter(usfm, chapter) {
  if (!usfm) return '';
  const re = /\\c\s+(\d+)\b/g;
  let start = -1;
  let end = usfm.length;
  let m;
  while ((m = re.exec(usfm)) !== null) {
    const n = Number(m[1]);
    if (start === -1 && n === Number(chapter)) { start = m.index; continue; }
    if (start !== -1 && n !== Number(chapter)) { end = m.index; break; }
  }
  if (start === -1) return usfm;
  return usfm.slice(start, end);
}

function stripWordMarkup(usfm) {
  return String(usfm || '')
    .replace(/\\zaln-s\s*\|[^*]*\*/g, '')
    .replace(/\\zaln-e\\\*/g, '')
    .replace(/\\k-s\s*\|[^*]*\*/g, '')
    .replace(/\\k-e\\\*/g, '')
    .replace(/\\w ([^|\\]*)\|[^\\]*\\w\*/g, '$1')
    .replace(/\\w ([^\\]*)\\w\*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ');
}

/** Chapter USFM -> Map(verse number -> plain text). Bridged verses key on the first number. */
function splitVerses(usfm) {
  const text = stripWordMarkup(usfm).replace(/\\f\s[\s\S]*?\\f\*/g, ' ');
  const map = new Map();
  const re = /\\v\s+(\d+)(?:-\d+)?\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ n: Number(m[1]), start: m.index, bodyStart: re.lastIndex });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(mk.bodyStart, end)
      .replace(/\\[a-z]+\d*\*?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!map.has(mk.n)) map.set(mk.n, body);
  });
  return map;
}

function loadVerseMap(sources, keys, chapter, range) {
  const rel = (sources && keys.map((k) => sources[k]).find(Boolean)) || null;
  if (!rel) return new Map();
  let text = '';
  try { text = fs.readFileSync(path.resolve(CSKILLBP_DIR, rel), 'utf8'); } catch (err) {
    console.warn(`[issue-rules-gate] Failed to read source ${rel}: ${err.message}`);
    return new Map();
  }
  const map = splitVerses(sliceChapter(text, chapter));
  if (range && range.start != null && range.end != null) {
    for (const k of [...map.keys()]) if (k < range.start - 1 || k > range.end + 1) map.delete(k);
  }
  return map;
}

// --- Chunking ----------------------------------------------------------------------

/**
 * Split `rows` (gateable and protected, in file order) into chunks of at most
 * `max` gateable rows, breaking between verses. A single verse with more than
 * `max` gateable rows is split inside the verse as a last resort.
 */
function chunkRows(rows, max = MAX_ROWS_PER_CHUNK) {
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.verse === r.verse) last.rows.push(r);
    else groups.push({ verse: r.verse, rows: [r] });
  }
  const chunks = [];
  let cur = [];
  let curCount = 0;
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; curCount = 0; };
  for (const g of groups) {
    const n = g.rows.filter((r) => !r.protected).length;
    if (curCount > 0 && curCount + n > max) flush();
    if (n > max) {
      for (const r of g.rows) {
        if (!r.protected && curCount >= max) flush();
        cur.push(r);
        if (!r.protected) curCount++;
      }
      continue;
    }
    cur.push(...g.rows);
    curCount += n;
  }
  flush();
  return chunks.filter((c) => c.some((r) => !r.protected));
}

// --- Prompt ------------------------------------------------------------------------

function buildPrompt({ book, chapter, rules, verseText, rows, catalog, requireGRule = false, allowAdd = false }) {
  const ruleLines = (rules || []).map((r) => {
    const phrase = r.phrase && r.phrase.toLowerCase() !== r.slug ? ` "${r.phrase}":` : '';
    return `${r.id} [${r.slug}] (${r.book}; ${r.context})${phrase} ${r.notes}`;
  });
  const verses = [...(verseText?.verses || [])].sort((a, b) => a - b);
  const sourceLines = [];
  for (const v of verses) {
    sourceLines.push(`Verse ${chapter}:${v}`);
    sourceLines.push(`  HEB: ${verseText.hebrew.get(v) || '(none)'}`);
    sourceLines.push(`  ULT: ${verseText.ult.get(v) || '(none)'}`);
    sourceLines.push(`  UST: ${verseText.ust.get(v) || '(none)'}`);
  }
  const rowLines = rows.map((r) => `#${r.index} ${r.protected ? '[protected] ' : ''}${r.ref} | ${r.sref} | ${r.quote} | ${r.explanation}`);
  const catalogList = catalog && catalog.size ? [...catalog].sort().join(', ') : '';

  return [
    `Review the issue rows below for ${String(book).toUpperCase()} ${chapter} against the current rules.`,
    '',
    ...(ruleLines.length ? ['DECISION RULES (recorded editor decisions; cite the id in "rule"):', ruleLines.join('\n'), ''] : []),
    requireGRule ? 'Change a row only when a G-rule in your instructions requires it, and put that G-rule id in "rule". A drop, relabel or rescope without a G-rule id is ignored and the row is kept.' : '',
    '',
    'SOURCE TEXT:',
    sourceLines.join('\n') || '(none provided)',
    '',
    'ISSUE ROWS (format: #row ref | sref | GLQuote | explanation). Rows marked [protected] are context only; give no verdict for them:',
    rowLines.join('\n'),
    '',
    catalogList ? `Allowed sref slugs: ${catalogList}` : '',
    '',
    'Return JSON only, no prose and no code fence, exactly in this shape. Give exactly one verdict for every row that is not [protected]:',
    `{"verdicts":[{"row":<number>,"action":"keep|drop|relabel|rescope","sref":"<slug, relabel only>","quote":"<GLQuote, rescope only>","reason":"<short>","rule":"${requireGRule ? '<G-rule id; null for keep>' : '<D-id|type-file|null>'}"}],"adds":[{"ref":"C:V","sref":"<slug>","quote":"<GLQuote verbatim from ULT>","explanation":"<1-10 words>","reason":"<short>","rule":"<id|null>"}]}`,
    '"adds" may be an empty array.',
    allowAdd
      ? 'Additions are enabled: you may list commonly missed issues in adds, each citing a G-rule.'
      : 'Additions are disabled: leave adds empty.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// --- Verdict parsing ---------------------------------------------------------------

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function tolerantJsonParse(text) {
  const t = stripJsonFence(text);
  try { return JSON.parse(t); } catch (firstErr) {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* fall through */ }
    }
    throw firstErr;
  }
}

/**
 * Parse one chunk's response. `rows` are the chunk's rows (protected ones are
 * recognised and their verdicts ignored). `complete` is true only when every
 * non-protected row has exactly one valid verdict and no entry was malformed.
 * Whether a relabel slug or a rescope quote is acceptable is decided in
 * applyVerdicts, so such a verdict still counts as an answer here.
 */
function parseVerdicts(text, rows) {
  const errors = [];
  const verdicts = new Map();
  const adds = [];
  const byIndex = new Map(rows.map((r) => [r.index, r]));
  let parsed;
  try {
    parsed = tolerantJsonParse(text);
  } catch (err) {
    return { verdicts, adds, errors: [`JSON parse failure: ${err.message}`], parseFailed: true, complete: false };
  }
  let list;
  let addList = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.verdicts)) {
    list = parsed.verdicts;
    if (Array.isArray(parsed.adds)) addList = parsed.adds;
  } else {
    return { verdicts, adds, errors: ['response had no verdicts array'], parseFailed: true, complete: false };
  }

  const dup = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { errors.push('verdict entry is not an object'); continue; }
    // Accept a row number sent as a numeric string ("12"); anything else is invalid.
    const idx = typeof entry.row === 'number' ? entry.row
      : (/^\s*\d+\s*$/.test(String(entry.row == null ? '' : entry.row)) ? Number(entry.row) : NaN);
    const row = Number.isInteger(idx) ? byIndex.get(idx) : undefined;
    if (!row) { errors.push(`row ${idx} does not match a row in this chunk`); continue; }
    if (row.protected) continue;
    if (verdicts.has(idx) || dup.has(idx)) {
      dup.add(idx);
      verdicts.delete(idx);
      errors.push(`row ${idx}: duplicate verdict`);
      continue;
    }
    const action = String(entry.action || '').trim().toLowerCase();
    if (!ACTIONS.has(action)) { errors.push(`row ${idx}: unknown action "${entry.action}"`); continue; }
    const v = { row: idx, action, reason: sanitizeCell(entry.reason), rule: entry.rule == null || entry.rule === 'null' ? null : sanitizeCell(entry.rule) };
    if (action === 'relabel') {
      v.sref = sanitizeCell(entry.sref).toLowerCase();
      if (!v.sref) { errors.push(`row ${idx}: relabel requires sref`); continue; }
    }
    if (action === 'rescope') {
      v.quote = sanitizeCell(entry.quote);
      if (!v.quote) { errors.push(`row ${idx}: rescope requires quote`); continue; }
    }
    verdicts.set(idx, v);
  }

  for (const a of addList) {
    if (!a || typeof a !== 'object') { errors.push('add entry is not an object'); continue; }
    const add = {
      ref: sanitizeCell(a.ref),
      sref: sanitizeCell(a.sref).toLowerCase(),
      quote: sanitizeCell(a.quote),
      explanation: sanitizeCell(a.explanation),
      reason: sanitizeCell(a.reason),
      rule: a.rule == null || a.rule === 'null' ? null : sanitizeCell(a.rule),
    };
    if (!add.ref || !add.sref || !add.quote || !add.explanation) { errors.push('add entry missing a required field'); continue; }
    adds.push(add);
  }

  const expected = rows.filter((r) => !r.protected);
  const missing = expected.filter((r) => !verdicts.has(r.index)).length;
  if (missing > 0) errors.push(`${missing} row(s) received no valid verdict`);
  return { verdicts, adds, errors, parseFailed: false, complete: missing === 0 && dup.size === 0 && errors.filter((e) => !/^add entry/.test(e)).length === 0 };
}

// --- Apply -------------------------------------------------------------------------

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

function tokenOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

function defaultAnchors(quote, verseText) {
  const { glQuoteAnchorsInVerseText } = require('./workspace-tools/tn-tools');
  return glQuoteAnchorsInVerseText(quote, verseText);
}

/**
 * Apply verdicts to the whole row list. Pure: returns new rows and the change
 * list; the caller writes the file.
 *
 * opts: { catalog:Set, ultVerses:Map, anchors:(quote,text)=>bool, allowAdd,
 *         adds:[{...add, verses:[n]}], protectedVerses:Set, gateableTotal }
 * `verdicts` is a Map(row index -> verdict) from chunks that were complete.
 */
function applyVerdicts(rows, verdicts, opts = {}) {
  const catalog = opts.catalog || new Set();
  const ultVerses = opts.ultVerses || new Map();
  const anchors = opts.anchors || defaultAnchors;
  const protectedVerses = opts.protectedVerses || new Set();
  const notes = [];
  const changes = [];
  const counts = { kept: 0, dropped: 0, relabeled: 0, rescoped: 0, added: 0 };

  const anchorsOk = (quote, verse) => {
    // The normalizer rewrites an ellipsis to " & ", which would change the file after the gate.
    if (!quote || /…|\.\.\./.test(quote)) return false;
    const vt = ultVerses.get(verse);
    if (!vt) return false;
    try { return anchors(quote, vt) === true; } catch (_) { return false; }
  };

  // Drop cap: wanted drops are compared with every gateable row of the chapter (or of the
  // verse range, for a range run) across all chunks, not with one chunk's rows, so one
  // wild response cannot thin the list. Rows outside the chapter or range are not counted.
  const wantedDrops = [...verdicts.values()].filter((v) => v.action === 'drop').length;
  const gateableTotal = opts.gateableTotal != null ? opts.gateableTotal : dataRows(rows).filter((r) => !r.protected).length;
  let dropsAllowed = true;
  if (wantedDrops > 0 && gateableTotal > 0 && wantedDrops / gateableTotal > MAX_DROP_SHARE) {
    dropsAllowed = false;
    notes.push('drop_cap_exceeded');
  }

  // Relabel + rescope cap, same denominator: past 25% none of them is applied.
  const wantedEdits = [...verdicts.values()].filter((v) => v.action === 'relabel' || v.action === 'rescope').length;
  let editsAllowed = true;
  if (wantedEdits > 0 && gateableTotal > 0 && wantedEdits / gateableTotal > MAX_DROP_SHARE) {
    editsAllowed = false;
    notes.push('change_cap_exceeded');
  }
  const protectSrefs = opts.protectSrefs || new Set();

  const out = [];
  for (const row of rows) {
    const v = row.passthrough || row.protected ? null : verdicts.get(row.index);
    if (!v) { out.push(row); continue; }
    if (v.action === 'drop' && dropsAllowed) {
      counts.dropped++;
      changes.push({ index: row.index, ref: row.ref, action: 'drop', sref: row.sref, before: row.quote, after: '', reason: v.reason, rule: v.rule });
      continue;
    }
    if (v.action === 'relabel') {
      const slug = v.sref;
      if (!editsAllowed) {
        // cap hit: row is kept
      } else if (protectSrefs.has(slug)) {
        notes.push(`relabel_ignored:protected_target:${row.index}`);
      } else if (SREF_RE.test(slug) && catalog.has(slug) && slug !== String(row.sref).trim().toLowerCase()) {
        const cols = row.cols.slice();
        cols[2] = slug;
        out.push({ ...row, cols, sref: slug, raw: null });
        counts.relabeled++;
        changes.push({ index: row.index, ref: row.ref, action: 'relabel', sref: slug, fromSref: row.sref, before: row.sref, after: slug, quote: row.quote, reason: v.reason, rule: v.rule });
        continue;
      } else {
        notes.push(`relabel_ignored:${row.index}`);
      }
    } else if (v.action === 'rescope') {
      if (!editsAllowed) {
        // cap hit: row is kept
      } else if (v.quote !== row.quote && anchorsOk(v.quote, row.verse)) {
        const cols = row.cols.slice();
        cols[3] = v.quote;
        out.push({ ...row, cols, quote: v.quote, raw: null });
        counts.rescoped++;
        changes.push({ index: row.index, ref: row.ref, action: 'rescope', sref: row.sref, before: row.quote, after: v.quote, reason: v.reason, rule: v.rule });
        continue;
      } else {
        notes.push(`rescope_ignored:${row.index}`);
      }
    } else if (v.action === 'drop') {
      // cap hit: row is kept
    }
    counts.kept++;
    out.push(row);
  }

  // Adds: opt-in, validated, capped, inserted after the last row of the verse.
  let working = out;
  if (opts.allowAdd) {
    let added = 0;
    for (const a of opts.adds || []) {
      if (added >= MAX_ADDS_PER_CHAPTER) { notes.push('add_cap_reached'); break; }
      const cv = verseOfRef(a.ref);
      const verses = a.verses || [];
      if (!cv || String(a.ref).trim() !== `${cv.chapter}:${cv.verse}` || !verses.includes(cv.verse)) { notes.push(`add_rejected:ref:${a.ref}`); continue; }
      if (protectedVerses.has(cv.verse)) { notes.push(`add_rejected:protected_verse:${a.ref}`); continue; }
      if (!catalog.has(a.sref)) { notes.push(`add_rejected:sref:${a.sref}`); continue; }
      if (!anchorsOk(a.quote, cv.verse)) { notes.push(`add_rejected:quote:${a.ref}`); continue; }
      const dupe = working.some((r) => !r.passthrough && r.chapter === cv.chapter && r.verse === cv.verse
        && tokenOverlap(r.quote, a.quote) >= DUPLICATE_OVERLAP);
      if (dupe) { notes.push(`add_rejected:overlap:${a.ref}`); continue; }
      let at = -1;
      working.forEach((r, i) => { if (!r.passthrough && r.chapter === cv.chapter && r.verse === cv.verse) at = i; });
      if (at < 0) { notes.push(`add_rejected:no_neighbor:${a.ref}`); continue; }
      const neighbor = working[at];
      const cols = [neighbor.book, a.ref, a.sref, a.quote, '', '', a.explanation];
      const newRow = { index: -1 - added, cols, book: neighbor.book, ref: a.ref, chapter: cv.chapter, verse: cv.verse, sref: a.sref, quote: a.quote, explanation: a.explanation, raw: null, added: true };
      working = [...working.slice(0, at + 1), newRow, ...working.slice(at + 1)];
      added++;
      counts.added++;
      changes.push({ index: newRow.index, ref: a.ref, action: 'add', sref: a.sref, before: '', after: a.quote, explanation: a.explanation, reason: a.reason, rule: a.rule });
    }
  }

  copyMeta(rows, working);
  return { rows: working, changes, counts, notes };
}

// --- PR body / report --------------------------------------------------------------

function truncate(text, n) {
  const t = String(text == null ? '' : text);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function changeLine(c) {
  const q = c.action === 'relabel' ? c.quote : (c.action === 'rescope' ? c.after : (c.action === 'add' ? c.after : c.before));
  const sref = c.action === 'relabel' ? `${c.fromSref}→${c.sref}` : c.sref;
  const why = c.rule ? `${c.rule}: ${c.reason || ''}` : (c.reason || '');
  return `- ${c.ref} ${c.action} ${sref} "${truncate(q, 40)}" (${why.trim()})`;
}

function buildPrBody({ counts, changes }) {
  const head = `Issue rules check: kept ${counts.kept}, dropped ${counts.dropped}, relabeled ${counts.relabeled}, rescoped ${counts.rescoped}, added ${counts.added}`;
  const list = (changes || []).slice(0, PR_BODY_MAX_LINES).map(changeLine);
  const extra = (changes || []).length > PR_BODY_MAX_LINES ? [`- … and ${changes.length - PR_BODY_MAX_LINES} more`] : [];
  const body = [head, '', ...list, ...extra].join('\n');
  return body.length > PR_BODY_MAX ? `${body.slice(0, PR_BODY_MAX - 1)}…` : body;
}

function escapeMd(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderReport({ book, chapter, mode, model, counts, changes, notes, rulesHash }) {
  const lines = [];
  lines.push(`# Issue rules gate: ${String(book).toUpperCase()} ${chapter} (${mode})`);
  lines.push('');
  lines.push(`Kept ${counts.kept}, dropped ${counts.dropped}, relabeled ${counts.relabeled}, rescoped ${counts.rescoped}, added ${counts.added}`);
  lines.push('');
  lines.push(`Model: ${model || '(default)'}`);
  lines.push(`Rules hash: ${rulesHash}`);
  lines.push('');
  lines.push('| Ref | Action | Before | After | Reason | Rule |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of changes) {
    lines.push(`| ${escapeMd(c.ref)} | ${escapeMd(c.action)} | ${escapeMd(c.before)} | ${escapeMd(c.after)} | ${escapeMd(c.reason)} | ${escapeMd(c.rule || '')} |`);
  }
  if (notes && notes.length) {
    lines.push('');
    lines.push('## Notes');
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join('\n') + '\n';
}

// --- Orchestration -----------------------------------------------------------------

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function extractResultText(result) {
  if (result?.result?.text) return String(result.result.text).trim();
  if (typeof result?.result === 'string') return result.result.trim();
  return '';
}

function accumulateUsage(total, usage) {
  if (!usage) return total;
  const acc = total || { input_tokens: 0, output_tokens: 0 };
  acc.input_tokens += usage.input_tokens ?? usage.inputTokens ?? 0;
  acc.output_tokens += usage.output_tokens ?? usage.outputTokens ?? 0;
  return acc;
}

function isOutage(err) {
  try { return require('./claude-runner').isTransientOutageError(err); } catch (_) {
    return !!err && err.name === 'ClaudeTransientOutageError';
  }
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.rules-gate.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * rowsAfter === rowsBefore - dropped + added over non-intro rows, and every
 * passthrough line (header, blank, intro, short) is byte-identical.
 */
function accountingHolds(beforeRows, afterRows, counts) {
  if (dataRows(afterRows).length !== dataRows(beforeRows).length - counts.dropped + counts.added) return false;
  const pb = beforeRows.filter((r) => r.passthrough).map((r) => r.raw);
  const pa = afterRows.filter((r) => r.passthrough).map((r) => r.raw);
  return pb.length === pa.length && pb.every((l, i) => l === pa[i]);
}

const emptyCounts = () => ({ kept: 0, dropped: 0, relabeled: 0, rescoped: 0, added: 0 });

async function runIssueRulesGate({ issuesPath, book, chapter, verseStart, verseEnd, ctx, hints, config, env, dryRun, model, status, runClaudeImpl } = {}) {
  const result = {
    ran: false, reason: null, mode: null, counts: emptyCounts(), changed: false,
    rowsBefore: 0, rowsAfter: 0, reportPath: null, sidecarPath: null, prBody: '', pause: false, error: null,
  };
  const say = async (text) => { try { if (status) await status(text); } catch (_) { /* never throw */ } };
  const skip = (reason) => { result.reason = reason; return result; };

  try {
    const settings = resolveSettings({ config, env: env || process.env, book });
    result.mode = settings.mode;
    if (settings.mode === 'off') return skip('mode_off');
    if (!settings.bookEnabled) return skip('book_not_enabled');
    if (dryRun) return skip('dry_run');

    const bookUpper = String(book || '').toUpperCase();
    const absIssues = path.resolve(CSKILLBP_DIR, issuesPath);
    const originalText = fs.readFileSync(absIssues, 'utf8');
    const range = verseStart != null && verseEnd != null ? { start: Number(verseStart), end: Number(verseEnd) } : null;

    // Hinted verses: editor-marked rows live there, so the whole verse is off limits.
    const hintedVerses = new Set();
    if (Array.isArray(hints)) {
      for (const h of hints) {
        if (!h) continue;
        if (h.chapter != null && Number(h.chapter) !== Number(chapter)) continue;
        const v = Number(h.verse);
        if (Number.isFinite(v)) hintedVerses.add(v);
      }
    }

    const rows = markOutOfScope(parseIssuesTsv(originalText), chapter, range);
    for (const r of rows) {
      if (r.passthrough) continue;
      r.protected = settings.protectSrefs.has(String(r.sref || '').trim().toLowerCase()) || hintedVerses.has(r.verse);
    }
    const gateable = rows.filter((r) => !r.passthrough && !r.protected);
    if (!gateable.length) return skip('no_gateable_rows');

    const rulesText = readIfExists(path.join(CSKILLBP_DIR, '.claude/skills/issue-identification/rules-gate.md'));
    if (rulesText == null || !rulesText.trim()) {
      await say(`Issue rules gate skipped for ${bookUpper} ${chapter}: rules-gate.md is missing, issue list left unchecked.`);
      return skip('no_rules_file');
    }
    const decisionRules = settings.useDecisionRows
      ? loadDecisionRules({ csvText: readIfExists(path.join(CSKILLBP_DIR, 'data/quick-ref/issue_decisions.csv')) || '', book })
      : [];
    const catalog = loadCatalog(readIfExists(path.join(CSKILLBP_DIR, 'data/translation-issues.csv')) || '');
    // Everything that changes what the gate may do is part of the hash, so a new
    // allowAdd value, protect list or catalog re-runs the gate instead of
    // reporting already_applied.
    const settingsKey = JSON.stringify({ allowAdd: !!settings.allowAdd, protectSrefs: [...settings.protectSrefs].sort(), catalog: [...catalog].sort(), useDecisionRows: settings.useDecisionRows, requireGRule: settings.requireGRule });
    const rulesHash = sha256(rulesText + '\n' + decisionRules.map((r) => [r.id, r.phrase, r.slug, r.book, r.context, r.notes].join('|')).join('\n') + '\n' + settingsKey);

    const base = path.basename(issuesPath, '.tsv');
    const reviewRel = path.join('output/review', bookUpper);
    const reviewDir = path.resolve(CSKILLBP_DIR, reviewRel);
    const preRel = path.join(reviewRel, `${base}-pre-rules-gate.tsv`);
    const reportRel = path.join(reviewRel, `${base}-rules-gate.md`);
    const sidecarRel = path.join(reviewRel, `${base}-rules-gate.json`);

    const prior = readIfExists(path.resolve(CSKILLBP_DIR, sidecarRel));
    if (prior) {
      try {
        const sc = JSON.parse(prior);
        if (sc && sc.mode === settings.mode && sc.rulesHash === rulesHash && sc.outputHash === hashNonIntroRows(rows)) {
          result.reason = 'already_applied';
          result.prBody = sc.prBody || '';
          result.sidecarPath = sidecarRel;
          result.reportPath = reportRel;
          return result;
        }
      } catch (_) { /* unreadable sidecar: run the gate */ }
    }

    // Source text for the prompt and for anchoring.
    const sources = (ctx && ctx.sources) || {};
    const ultVerses = loadVerseMap(sources, ['ultPlain', 'ult'], chapter, range);
    const ustVerses = loadVerseMap(sources, ['ustPlain', 'ust'], chapter, range);
    const hebrewVerses = loadVerseMap(sources, ['hebrewPlain', 'hebrew'], chapter, range);

    // No ULT text for any gateable verse: the model would judge rows blind.
    const gateableVerses = new Set(gateable.map((r) => r.verse));
    if (![...gateableVerses].some((v) => ultVerses.get(v))) {
      await say(`Issue rules gate skipped for ${bookUpper} ${chapter}: no ULT verse text available, issue list left unchecked.`);
      return skip('no_source_text');
    }

    const runner = runClaudeImpl || require('./claude-runner').runClaude;
    const modelName = (env && env.BP_RULES_GATE_MODEL) || model || settings.model || undefined;
    const rowsForChunks = rows.filter((r) => !r.passthrough);
    const chunks = chunkRows(rowsForChunks, MAX_ROWS_PER_CHUNK);

    const allVerdicts = new Map();
    const allAdds = [];
    const notes = [];
    let usage = null;
    let incomplete = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkVersesList = [...new Set(chunk.map((r) => r.verse))];
      const lo = Math.min(...chunkVersesList);
      const hi = Math.max(...chunkVersesList);
      const verseSet = [];
      for (let v = lo - 1; v <= hi + 1; v++) if (v >= 1) verseSet.push(v);
      const prompt = buildPrompt({
        book: bookUpper, chapter, rules: decisionRules, catalog, requireGRule: settings.requireGRule, allowAdd: settings.allowAdd,
        verseText: { verses: verseSet, hebrew: hebrewVerses, ult: ultVerses, ust: ustVerses },
        rows: chunk,
      });
      const label = `issue-rules-gate:${bookUpper}-${chapter}${chunks.length > 1 ? `#${i + 1}` : ''}`;

      let res;
      try {
        res = await runner({
          prompt,
          label,
          cwd: CSKILLBP_DIR,
          model: modelName,
          thinking: settings.effort,
          maxTurns: 2,
          timeoutMs: 10 * 60 * 1000,
          appendSystemPrompt: rulesText,
          mcpToolSet: 'none',
          tools: [],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch'],
        });
      } catch (err) {
        return failure(result, err, err && err.message);
      }
      if (res?.usage) usage = accumulateUsage(usage, res.usage);
      if (res?.is_error === true || res?.subtype !== 'success') {
        const text = res?.error || (typeof res?.result === 'string' ? res.result : '') || extractResultText(res) || res?.subtype || 'empty result';
        return failure(result, null, text);
      }
      const responseText = extractResultText(res);
      if (!responseText) return failure(result, null, 'empty response');

      const parsed = parseVerdicts(responseText, chunk);
      if (!parsed.complete) {
        incomplete++;
        notes.push(`chunk ${i + 1}: incomplete (${parsed.errors.slice(0, 3).join('; ')}); not applied`);
        console.warn(`[issue-rules-gate] ${label} incomplete: ${parsed.errors.join('; ')}`);
        continue;
      }
      for (const [k, v] of parsed.verdicts) allVerdicts.set(k, v);
      for (const a of parsed.adds) allAdds.push({ ...a, verses: chunkVersesList });
    }

    const protectedVerses = hintedVerses;
    // All or nothing: if any chunk went unanswered, change nothing. Applying the
    // answered chunks alone would leave no sidecar, so a rerun could drop
    // another 25% of an already-thinned list.
    if (incomplete > 0) {
      allVerdicts.clear();
      allAdds.length = 0;
      notes.push(`${incomplete} chunk(s) incomplete: no changes applied; the next run retries the whole chapter`);
    }
    // Only active curated G-rules may change a row (see DEFAULT_SETTINGS).
    if (settings.requireGRule) {
      const activeRules = activeGRuleIds(rulesText);
      const isG = (rule) => activeRules.has(String(rule || '').trim().toUpperCase());
      for (const [k, v] of allVerdicts) {
        if (v.action !== 'keep' && !isG(v.rule)) {
          allVerdicts.set(k, { ...v, action: 'keep' });
          notes.push(`uncited_ignored:${k}:${v.action}:${v.rule || 'none'}`);
        }
      }
      for (let i = allAdds.length - 1; i >= 0; i--) {
        if (!isG(allAdds[i].rule)) {
          notes.push(`uncited_ignored:${allAdds[i].ref}:add:${allAdds[i].rule || 'none'}`);
          allAdds.splice(i, 1);
        }
      }
    }
    const applied = applyVerdicts(rows, allVerdicts, {
      catalog, ultVerses, allowAdd: settings.allowAdd, adds: allAdds, protectedVerses, gateableTotal: gateable.length,
      protectSrefs: settings.protectSrefs,
    });
    notes.push(...applied.notes);
    // Rows that were never reviewed (incomplete chunk) are not "kept".
    const reviewedKept = applied.counts.kept;
    const counts = { ...applied.counts, kept: reviewedKept };
    result.counts = counts;
    result.rowsBefore = dataRows(rows).length;
    const changed = applied.changes.length > 0;

    let outputRows = rows;
    let reason = 'no_changes';
    if (changed) {
      const newText = serializeIssuesTsv(applied.rows);
      const reparsed = markOutOfScope(parseIssuesTsv(newText), chapter, range);
      const afterCount = dataRows(reparsed).length;
      if (!accountingHolds(rows, reparsed, counts)) {
        // Checked before anything is written, so the original bytes are intact.
        result.ran = true;
        result.reason = 'accounting_violation';
        result.rowsAfter = result.rowsBefore;
        result.counts = emptyCounts();
        result.prBody = '';
        console.error(`[issue-rules-gate] ${bookUpper} ${chapter}: accounting violation (before=${result.rowsBefore}, after=${afterCount}, dropped=${counts.dropped}, added=${counts.added}); file left as it was`);
        return result;
      }
      fs.mkdirSync(reviewDir, { recursive: true });
      // Write-once: a later run under new rules must not replace the original list.
      const preAbs = path.resolve(CSKILLBP_DIR, preRel);
      if (!fs.existsSync(preAbs)) fs.writeFileSync(preAbs, originalText);
      writeFileAtomic(absIssues, newText);
      outputRows = reparsed;
      result.rowsAfter = afterCount;
      reason = 'applied';
    } else {
      result.rowsAfter = result.rowsBefore;
    }

    result.ran = true;
    result.changed = changed;
    result.reason = incomplete > 0 ? 'incomplete' : reason;
    result.prBody = incomplete > 0 ? '' : buildPrBody({ counts, changes: applied.changes });

    try {
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.writeFileSync(path.resolve(CSKILLBP_DIR, reportRel), renderReport({
        book: bookUpper, chapter, mode: settings.mode, model: modelName, counts, changes: applied.changes, notes, rulesHash,
      }));
      result.reportPath = reportRel;
      // Seal the run only when every chunk was answered, so a partly reviewed
      // chapter is retried instead of reported as already applied.
      if (incomplete === 0) {
        fs.writeFileSync(path.resolve(CSKILLBP_DIR, sidecarRel), JSON.stringify({
          version: 1,
          mode: settings.mode,
          model: modelName || null,
          rulesHash,
          chapter: Number(chapter),
          verseStart: range ? range.start : null,
          verseEnd: range ? range.end : null,
          inputHash: hashNonIntroRows(rows),
          outputHash: hashNonIntroRows(outputRows),
          counts,
          changes: applied.changes,
          prBody: result.prBody,
          at: new Date().toISOString(),
        }, null, 2));
        result.sidecarPath = sidecarRel;
      }
    } catch (err) {
      console.warn(`[issue-rules-gate] Failed to write report/sidecar: ${err.message}`);
    }

    try {
      require('./usage-tracker').recordMetrics({
        pipeline: 'notes', skill: 'issue-rules-gate', book: bookUpper, chapter,
        result: { usage, model: modelName }, success: incomplete === 0,
      });
    } catch (_) { /* metrics are best effort */ }

    return result;
  } catch (err) {
    result.ran = false;
    result.reason = 'error';
    result.error = (err && err.message) || String(err);
    return result;
  }
}

// A failed call leaves the file untouched. Usage limits and outages pause the
// chapter so it can resume; anything else is reported as an error.
function failure(result, err, text) {
  const msg = String(text || (err && err.message) || 'unknown error');
  result.ran = false;
  result.error = msg;
  if (isUsageLimitError(msg) || isOutage(err)) {
    result.reason = 'paused';
    result.pause = true;
  } else {
    result.reason = 'error';
  }
  return result;
}

function sidecarAbsPath({ issuesPath, book }) {
  const base = path.basename(issuesPath, '.tsv');
  return path.resolve(CSKILLBP_DIR, 'output/review', String(book || '').toUpperCase(), `${base}-rules-gate.json`);
}

/** Parsed sidecar for an issues file, or null when absent or unreadable. Never throws. */
function readGateSidecar({ issuesPath, book } = {}) {
  try {
    const text = readIfExists(sidecarAbsPath({ issuesPath, book }));
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Re-seal the sidecar after something else (normalizer pass 2) rewrote the issues
 * file: outputHash becomes the hash of the file's current non-intro rows. No-op
 * when there is no sidecar. Never throws.
 */
function refreshGateSidecarOutputHash({ issuesPath, book } = {}) {
  try {
    const sc = readGateSidecar({ issuesPath, book });
    if (!sc) return false;
    const text = fs.readFileSync(path.resolve(CSKILLBP_DIR, issuesPath), 'utf8');
    const range = sc.verseStart != null && sc.verseEnd != null ? { start: sc.verseStart, end: sc.verseEnd } : null;
    const rows = sc.chapter != null ? markOutOfScope(parseIssuesTsv(text), sc.chapter, range) : parseIssuesTsv(text);
    sc.outputHash = hashNonIntroRows(rows);
    fs.writeFileSync(sidecarAbsPath({ issuesPath, book }), JSON.stringify(sc, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  runIssueRulesGate,
  readGateSidecar,
  refreshGateSidecarOutputHash,
  parseIssuesTsv,
  serializeIssuesTsv,
  loadDecisionRules,
  activeGRuleIds,
  buildPrompt,
  parseVerdicts,
  applyVerdicts,
  buildPrBody,
  accountingHolds,
  chunkRows,
  resolveSettings,
  splitVerses,
};
