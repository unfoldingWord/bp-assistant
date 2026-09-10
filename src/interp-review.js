// interp-review.js — Fable review pass over interpretive rows of an issue TSV
//
// Editors correcting AI translation notes on ISA/JER/EZK mostly fix
// interpretation errors that already exist in the issue TSV (wrong issue
// type, wrong primary "This could mean" reading, single reading where two
// are warranted). This module runs one Claude call over just the
// interpretive rows before the note writer runs, so a fix propagates
// downstream instead of getting re-made note by note. Default off;
// report-only and apply modes. Never throws into the pipeline.

const fs = require('fs');
const path = require('path');

const INTERP_SREFS = new Set([
  'figs-metaphor', 'figs-metonymy', 'figs-synecdoche', 'figs-idiom',
  'figs-explicit', 'figs-extrainfo', 'figs-personification',
  'writing-pronouns', 'writing-symlanguage', 'translate-textvariants',
  'translate-alternativereadings', 'figs-possession', 'figs-rquestion',
  'figs-irony',
]);
// Hedges that signal a contested reading. Deliberately NOT a bare "could" or
// "or": the issue-id analysts write "abstract noun - could be verb" on nearly
// every figs-abstractnouns row, and on the 20 ISA/JER/EZK chapters sampled the
// bare form pulled 5–10 such non-interpretive rows per chapter into the review
// call; this form adds 0–2.
const HEDGE_RE = /\b(could (mean|refer|be either)|either|possibly|unclear|perhaps|ambiguous|uncertain)\b/i;

// Never let one review call thin a chapter's issue list this much. Above this
// share of dropped rows the drops are treated as a bad response and nothing is
// written (revisions from the same call are kept).
const MAX_DROP_SHARE = 0.25;

const ALLOWED_VERDICTS = new Set(['agree', 'revise', 'tcm', 'retype', 'drop']);
const SREF_RE = /^[a-z]+(-[a-z0-9]+)+$/;

// --- TSV parsing / serialization -------------------------------------------------

function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Parse an issue TSV's text into row objects. Data rows have the exact
 * 7-column layout (book, ref, sref, quote, col5, col6, explanation);
 * anything with fewer than 4 columns, or whose ref ends with ":intro", is
 * kept as a passthrough row so it round-trips unchanged.
 */
function parseIssuesTsv(text) {
  const lineEnding = detectLineEnding(text);
  const trailingNewline = text.endsWith(lineEnding);
  let body = text;
  if (trailingNewline) body = body.slice(0, -lineEnding.length);
  const lines = body.length ? body.split(lineEnding) : [];

  const rows = [];
  lines.forEach((line, i) => {
    const cols = line.split('\t');
    if (cols.length < 4) {
      rows.push({ index: i, raw: line, passthrough: true });
      return;
    }
    const ref = cols[1];
    if (String(ref || '').trim().toLowerCase().endsWith(':intro')) {
      rows.push({ index: i, raw: line, passthrough: true });
      return;
    }
    const explanation = cols.slice(6).join('\t');
    rows.push({
      index: i,
      book: cols[0],
      ref: cols[1],
      sref: cols[2],
      quote: cols[3],
      col5: cols[4] ?? '',
      col6: cols[5] ?? '',
      explanation,
      raw: line,
    });
  });

  Object.defineProperty(rows, '__meta', {
    value: { lineEnding, trailingNewline },
    enumerable: false,
    writable: true,
  });
  return rows;
}

function rowToLine(row) {
  // Untouched rows (passthrough or never edited) emit their original bytes, so a
  // 4- or 6-column row the analysts left short round-trips as-is. applyVerdicts
  // clears `raw` on the rows it changes, and only those are rebuilt.
  if (row.passthrough || row.raw != null) return row.raw;
  return [row.book, row.ref, row.sref, row.quote, row.col5, row.col6, row.explanation].join('\t');
}

/**
 * Serialize rows back to TSV text. Byte-identical to the parsed input when
 * nothing changed.
 */
function serializeIssuesTsv(rows) {
  const meta = (rows && rows.__meta) || { lineEnding: '\n', trailingNewline: true };
  const text = rows.map(rowToLine).join(meta.lineEnding);
  return meta.trailingNewline ? text + meta.lineEnding : text;
}

/**
 * Copy round-trip metadata from one rows array to another (used after
 * building a fresh array, e.g. in applyVerdicts).
 */
function copyMeta(fromRows, toRows) {
  const meta = (fromRows && fromRows.__meta) || { lineEnding: '\n', trailingNewline: true };
  Object.defineProperty(toRows, '__meta', { value: meta, enumerable: false, writable: true });
  return toRows;
}

/**
 * Select the interpretive subset of data rows: issue-type in INTERP_SREFS,
 * or an explanation that opens with a TCM reading, or one with a hedging word.
 */
function selectInterpretiveRows(rows) {
  return rows.filter((row) => {
    if (row.passthrough) return false;
    const sref = String(row.sref || '').trim().toLowerCase();
    if (INTERP_SREFS.has(sref)) return true;
    const explanation = String(row.explanation || '');
    if (/^tcm\b/i.test(explanation.trim())) return true;
    if (HEDGE_RE.test(explanation)) return true;
    return false;
  });
}

function chunkRows(rows, max = 40) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += max) {
    chunks.push(rows.slice(i, i + max));
  }
  return chunks;
}

// --- Prompt building --------------------------------------------------------------

function buildReviewPrompt({ book, chapter, ultText, ustText, hebrewText, rows, issueTypes }) {
  const typeLine = (issueTypes && issueTypes.length)
    ? `Allowed issue-type slugs: ${issueTypes.join(', ')}`
    : 'Keep the existing type unless clearly wrong, use only slugs that already appear in the file.';

  const rowLines = rows.map((r) => `#${r.index} | ${r.ref} | ${r.sref} | "${r.quote}" | ${r.explanation}`);

  return [
    `You are a senior Bible translation consultant checking the interpretation recorded for each translation issue, for the unfoldingWord translationNotes (${book} ${chapter}).`,
    '',
    'ULT:',
    ultText || '(none provided)',
    '',
    'UST:',
    ustText || '(none provided)',
    '',
    'HEBREW:',
    hebrewText || '(none provided)',
    '',
    'Rows to review (format: #index | ref | sref | "quote" | explanation):',
    ...rowLines,
    '',
    typeLine,
    '',
    'STRICT output instructions: respond with ONLY a JSON array, no prose, no code fence, one object per input row:',
    '{"index": <n>, "verdict": "agree"|"revise"|"tcm"|"retype"|"drop", "explanation": "<new explanation or null>", "sref": "<new slug or null>", "reason": "<one line>"}',
    '',
    'Rules:',
    '- "tcm" explanations must be written in the file\'s existing TCM form `TCM i:(1) <primary reading> (2) <secondary reading>` with the primary reading first.',
    '- "retype" must include both sref and a fitting explanation.',
    '- Never change the quote.',
    '- Prefer "agree" when the reading is defensible.',
    '- "drop" only when the row is not a real translation issue.',
  ].join('\n');
}

// --- Verdict parsing / application -------------------------------------------------

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseVerdicts(text, rows) {
  const errors = [];
  const verdicts = new Map();
  const validIndexes = new Set(rows.map((r) => r.index));

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch (err) {
    return { verdicts, errors: [`JSON parse failure: ${err.message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { verdicts, errors: ['response was not a JSON array'] };
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      errors.push('entry is not an object');
      continue;
    }
    const { index, verdict, explanation, sref, reason } = entry;
    if (typeof index !== 'number' || !validIndexes.has(index)) {
      errors.push(`index ${index} does not match a selected row`);
      continue;
    }
    if (!ALLOWED_VERDICTS.has(verdict)) {
      errors.push(`row ${index}: unknown verdict "${verdict}"`);
      continue;
    }
    if ((verdict === 'revise' || verdict === 'tcm') && (typeof explanation !== 'string' || !explanation.trim())) {
      errors.push(`row ${index}: "${verdict}" requires a non-empty explanation`);
      continue;
    }
    if (verdict === 'retype') {
      if (typeof sref !== 'string' || !SREF_RE.test(sref.trim())) {
        errors.push(`row ${index}: "retype" requires a valid sref`);
        continue;
      }
      if (typeof explanation !== 'string' || !explanation.trim()) {
        errors.push(`row ${index}: "retype" requires a non-empty explanation`);
        continue;
      }
    }
    verdicts.set(index, { index, verdict, explanation: explanation ?? null, sref: sref ?? null, reason: reason ?? '' });
  }

  return { verdicts, errors };
}

function applyVerdicts(rows, verdicts) {
  const changed = [];
  const newRows = [];

  for (const row of rows) {
    if (row.passthrough || !verdicts.has(row.index)) {
      newRows.push(row);
      continue;
    }
    const v = verdicts.get(row.index);
    if (v.verdict === 'agree') {
      newRows.push(row);
      continue;
    }
    if (v.verdict === 'drop') {
      changed.push({ index: row.index, ref: row.ref, sref: row.sref, verdict: v.verdict, before: row.explanation, after: null, reason: v.reason });
      continue; // omitted from newRows
    }
    if (v.verdict === 'revise' || v.verdict === 'tcm') {
      const before = row.explanation;
      const updated = { ...row, explanation: v.explanation, raw: null };
      newRows.push(updated);
      changed.push({ index: row.index, ref: row.ref, sref: row.sref, verdict: v.verdict, before, after: v.explanation, reason: v.reason });
      continue;
    }
    if (v.verdict === 'retype') {
      const before = row.explanation;
      const updated = { ...row, sref: v.sref, explanation: v.explanation, raw: null };
      newRows.push(updated);
      changed.push({ index: row.index, ref: row.ref, sref: v.sref, fromSref: row.sref, verdict: v.verdict, before, after: v.explanation, reason: v.reason });
      continue;
    }
    // Unknown verdict shouldn't reach here (filtered in parseVerdicts), keep as-is.
    newRows.push(row);
  }

  copyMeta(rows, newRows);
  return { rows: newRows, changed };
}

// --- Reporting ---------------------------------------------------------------------

function escapeMd(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderReviewMarkdown({ book, chapter, mode, model, selected, total, changed, errors, usage }) {
  const lines = [];
  lines.push(`# Interpretive review — ${String(book).toUpperCase()} ${chapter} (${mode})`);
  lines.push('');
  lines.push(`${selected} of ${total} rows reviewed on ${model}`);
  lines.push('');
  lines.push('| Ref | Type | Verdict | Before | After | Reason |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of (changed || [])) {
    lines.push(`| ${escapeMd(c.ref)} | ${escapeMd(c.sref)} | ${escapeMd(c.verdict)} | ${escapeMd(c.before)} | ${escapeMd(c.after)} | ${escapeMd(c.reason || '')} |`);
  }
  if (errors && errors.length) {
    lines.push('');
    lines.push('## Errors');
    for (const e of errors) lines.push(`- ${e}`);
  }
  if (usage) {
    lines.push('');
    const inTok = usage.input_tokens ?? usage.inputTokens ?? 0;
    const outTok = usage.output_tokens ?? usage.outputTokens ?? 0;
    lines.push(`Token usage: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out`);
  }
  return lines.join('\n');
}

// `total` (rows reviewed, including untouched "agree" rows) is not always
// knowable from `changed` alone — the wiring in notes-pipeline.js calls this
// with just (changed, mode), so it defaults to changed.length there;
// runInterpretiveReview passes the real reviewed count explicitly.
function summarizeChanges(changed, mode, total) {
  const list = changed || [];
  const revised = list.filter((c) => c.verdict === 'revise').length;
  const tcm = list.filter((c) => c.verdict === 'tcm').length;
  const retyped = list.filter((c) => c.verdict === 'retype').length;
  const dropped = list.filter((c) => c.verdict === 'drop').length;
  const reviewedCount = total != null ? total : list.length;

  const verbPhrase = mode === 'apply'
    ? `Interpretive review: revised ${revised}, converted ${tcm} to TCM, retyped ${retyped}, dropped ${dropped} of ${reviewedCount} rows.`
    : `Interpretive review (report only): would revise ${revised}, convert ${tcm} to TCM, retype ${retyped}, drop ${dropped} of ${reviewedCount} rows reviewed.`;

  const bullets = list.slice(0, 15).map((c) => {
    const type = c.fromSref && c.fromSref !== c.sref ? `${c.fromSref} → ${c.sref}` : (c.sref || '');
    return `- ${c.ref} ${type} (${c.verdict}): ${c.reason || ''}`.trim();
  });
  const extra = list.length > 15 ? [`… and ${list.length - 15} more`] : [];

  return [verbPhrase, ...bullets, ...extra].join('\n');
}

// --- Settings resolution ------------------------------------------------------------

const VALID_MODES = new Set(['off', 'report', 'apply']);

function resolveInterpReviewSettings({ config, env, book }) {
  const cfg = (config && config.interpReview) || {};
  const defaults = { mode: 'off', books: [], model: 'claude-fable-5-1', maxRowsPerCall: 40 };
  const merged = { ...defaults, ...cfg };

  let mode = merged.mode;
  let books = merged.books;
  let model = merged.model;
  const maxRows = merged.maxRowsPerCall;

  if (env && env.BP_INTERP_REVIEW_MODE != null && env.BP_INTERP_REVIEW_MODE !== '') {
    mode = env.BP_INTERP_REVIEW_MODE;
  }
  if (env && env.BP_INTERP_REVIEW_BOOKS != null && env.BP_INTERP_REVIEW_BOOKS !== '') {
    const raw = String(env.BP_INTERP_REVIEW_BOOKS).trim();
    books = raw.toLowerCase() === 'all' ? 'all' : raw.split(',').map((b) => b.trim()).filter(Boolean);
  }
  if (env && env.BP_INTERP_REVIEW_MODEL != null && env.BP_INTERP_REVIEW_MODEL !== '') {
    model = env.BP_INTERP_REVIEW_MODEL;
  }

  if (!VALID_MODES.has(mode)) {
    console.warn(`[interp-review] Invalid mode "${mode}", defaulting to off`);
    mode = 'off';
  }

  const bookUpper = String(book || '').toUpperCase();
  let enabledForBook = false;
  if (mode !== 'off') {
    if (books === 'all') {
      enabledForBook = true;
    } else if (Array.isArray(books)) {
      enabledForBook = books.some((b) => String(b).toUpperCase() === bookUpper);
    }
  }

  return { mode, model, maxRows, enabledForBook };
}

// --- Orchestration -------------------------------------------------------------------

function chapterDirName(book, chapter) {
  const width = String(book).toUpperCase() === 'PSA' ? 3 : 2;
  return String(chapter).padStart(width, '0');
}

function loadIssueTypes(workspaceDir) {
  try {
    const csvPath = path.resolve(workspaceDir, 'data/translation-issues.csv');
    if (!fs.existsSync(csvPath)) return [];
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length);
    if (!lines.length) return [];
    const dataLines = lines.slice(1); // skip header
    const types = dataLines
      .map((l) => l.split(',')[0])
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    return Array.from(new Set(types));
  } catch (err) {
    console.warn(`[interp-review] Failed to load issue types: ${err.message}`);
    return [];
  }
}

function readSourceFile(workspaceDir, relPath, label) {
  if (!relPath) return '';
  try {
    return fs.readFileSync(path.resolve(workspaceDir, relPath), 'utf8');
  } catch (err) {
    console.warn(`[interp-review] Failed to read ${label} source (${relPath}): ${err.message}`);
    return '';
  }
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

async function runInterpretiveReview({ issuesPath, pipeDir, book, chapter, workspaceDir, runClaudeImpl, status, settings }) {
  try {
    const { readContext } = require('./pipeline-context');

    const absIssuesPath = path.resolve(workspaceDir, issuesPath);
    const text = fs.readFileSync(absIssuesPath, 'utf8');
    const rows = parseIssuesTsv(text);
    const selected = selectInterpretiveRows(rows);
    const total = rows.filter((r) => !r.passthrough).length;

    if (!selected.length) {
      return { ran: false, mode: settings.mode, selected: 0, total, changed: [], errors: [] };
    }

    if (status) {
      await status(`Interpretive review (${settings.mode}): reviewing ${selected.length} of ${total} issue rows on ${settings.model}...`);
    }

    let ctx = null;
    try {
      ctx = readContext(pipeDir);
    } catch (err) {
      console.warn(`[interp-review] Failed to read context.json: ${err.message}`);
    }

    const ultText = readSourceFile(workspaceDir, ctx?.sources?.ult, 'ULT');
    const ustText = readSourceFile(workspaceDir, ctx?.sources?.ust, 'UST');
    const hebrewText = readSourceFile(workspaceDir, ctx?.sources?.hebrew, 'Hebrew');
    const issueTypes = loadIssueTypes(workspaceDir);

    const chunks = chunkRows(selected, settings.maxRows || 40);
    const allErrors = [];
    const allVerdicts = new Map();
    let usage = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunkRowsForCall = chunks[i];
      const prompt = buildReviewPrompt({ book, chapter, ultText, ustText, hebrewText, rows: chunkRowsForCall, issueTypes });

      let result;
      try {
        result = await runClaudeImpl({
          prompt,
          label: `${book} ${chapter} interp-review`,
          cwd: workspaceDir,
          model: settings.model,
          thinking: 'high',
          maxTurns: 2,
          timeoutMs: 8 * 60 * 1000,
          appendSystemPrompt: 'You review translation-issue interpretations. Output ONLY the JSON array. Do not use any tools.',
          mcpToolSet: 'none',
          tools: [],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill'],
        });
      } catch (err) {
        allErrors.push(`chunk ${i}: ${err.message}`);
        continue;
      }

      if (result?.usage) usage = accumulateUsage(usage, result.usage);

      if (result?.subtype !== 'success') {
        allErrors.push(`chunk ${i}: ${result?.subtype || 'empty'}`);
        continue;
      }
      const responseText = extractResultText(result);
      if (!responseText) {
        allErrors.push(`chunk ${i}: empty`);
        continue;
      }

      const { verdicts, errors } = parseVerdicts(responseText, chunkRowsForCall);
      for (const [k, v] of verdicts) allVerdicts.set(k, v);
      for (const e of errors) allErrors.push(`chunk ${i}: ${e}`);
    }

    // Drop guard: a response that wants to remove a large share of the chapter is
    // far more likely a bad response than a bad chapter. Keep its revisions,
    // discard its drops, and say so.
    const dropCount = [...allVerdicts.values()].filter((v) => v.verdict === 'drop').length;
    if (total > 0 && dropCount / total > MAX_DROP_SHARE) {
      allErrors.push(`drop guard: ${dropCount} of ${total} rows marked drop (> ${Math.round(MAX_DROP_SHARE * 100)}%); drops ignored`);
      for (const [k, v] of allVerdicts) {
        if (v.verdict === 'drop') allVerdicts.set(k, { ...v, verdict: 'agree' });
      }
    }

    const applied = applyVerdicts(rows, allVerdicts);

    if (settings.mode === 'apply' && applied.changed.length > 0) {
      fs.writeFileSync(absIssuesPath, serializeIssuesTsv(applied.rows));
    }

    const ch = chapterDirName(book, chapter);
    const reviewDir = path.resolve(workspaceDir, 'output/review', String(book).toUpperCase());
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewPath = path.join('output/review', String(book).toUpperCase(), `${String(book).toUpperCase()}-${ch}-interp-fable.md`);
    const markdown = renderReviewMarkdown({
      book, chapter, mode: settings.mode, model: settings.model,
      selected: selected.length, total, changed: applied.changed, errors: allErrors, usage,
    });
    fs.writeFileSync(path.resolve(workspaceDir, reviewPath), markdown);

    const summary = summarizeChanges(applied.changed, settings.mode, selected.length);

    return {
      ran: true,
      mode: settings.mode,
      selected: selected.length,
      total,
      changed: applied.changed,
      errors: allErrors,
      reviewPath,
      summary,
      usage,
    };
  } catch (err) {
    return { ran: false, errors: [err.message] };
  }
}

module.exports = {
  INTERP_SREFS,
  HEDGE_RE,
  parseIssuesTsv,
  serializeIssuesTsv,
  selectInterpretiveRows,
  chunkRows,
  buildReviewPrompt,
  parseVerdicts,
  applyVerdicts,
  renderReviewMarkdown,
  summarizeChanges,
  resolveInterpReviewSettings,
  runInterpretiveReview,
};
