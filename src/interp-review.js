// interp-review.js — interpretive review stage for the notes pipeline.
//
// Runs between the issue producer and mechanical prep (before tn-writer). One
// Claude call per chapter, no tools, JSON out. Evidence (issue #382) showed 77%
// of genuine interpretation errors already exist in the issue TSV before
// tn-writer runs, so correcting the explanation column there propagates to the
// note, the AT, and quality-check.
//
// The stage is strictly non-fatal: any parse failure, refusal, empty result, or
// missing credential leaves the issues TSV untouched and logs a warning.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { CSKILLBP_DIR } = require('./pipeline-utils');
const { getAnthropicApiKey } = require('./anthropic-env');
const { resolveProviderModel, isConfiguredModel } = require('./api-runner/provider-config');

// Support references whose rows carry an interpretive judgement worth reviewing.
const INTERP_SREFS = new Set([
  'figs-metaphor',
  'figs-metonymy',
  'figs-synecdoche',
  'figs-idiom',
  'figs-explicit',
  'figs-extrainfo',
  'figs-personification',
  'writing-pronouns',
  'writing-symlanguage',
  'translate-textvariants',
  'translate-alternativereadings',
  'figs-possession',
  'figs-rquestion',
  'figs-irony',
]);

// A hedge in the explanation means the issue producer was already unsure.
const HEDGE_RE = /\b(could|either|possibly|unclear|or)\b/i;

const MAX_ROWS_PER_CALL = 40;
const DEFAULT_MODEL = 'claude-fable-5-1';
const DEFAULT_BOOKS = ['ISA', 'JER', 'EZK'];
const VALID_ACTIONS = new Set(['agree', 'revise', 'tcm', 'retype', 'drop']);

// Canonical headerless issues TSV column order, post-normalization:
//   0 Book  1 Reference  2 SRef  3 GLQuote  4 NeedsAT  5 AT  6 Explanation
const COL_SREF = 2;
const COL_QUOTE = 3;
const COL_EXPLANATION = 6;
const MIN_COLS = 7;

function isTcmExplanation(explanation) {
  return /^TCM\b/i.test(String(explanation || '').trim());
}

// --- selection -------------------------------------------------------------

// Parse into raw lines so untouched columns keep their exact bytes on write.
function parseIssuesTsv(content) {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hadTrailingNewline) lines.pop();
  const rows = lines.map((raw, index) => ({ index, raw, cols: raw.split('\t') }));
  return { rows, hadTrailingNewline };
}

function serializeIssuesTsv(rows, hadTrailingNewline) {
  const body = rows.map((r) => r.cols.join('\t')).join('\n');
  return hadTrailingNewline ? `${body}\n` : body;
}

// Deterministic, no LLM: pick the rows whose interpretation is worth a look.
function selectRows(rows) {
  const selected = [];
  for (const row of rows) {
    if (!row.raw.trim()) continue;
    if (row.cols.length < MIN_COLS) continue;
    const sref = (row.cols[COL_SREF] || '').trim();
    const explanation = (row.cols[COL_EXPLANATION] || '').trim();
    const interesting =
      INTERP_SREFS.has(sref) || isTcmExplanation(explanation) || HEDGE_RE.test(explanation);
    if (!interesting) continue;
    selected.push({
      index: row.index,
      verse: (row.cols[1] || '').trim(),
      sref,
      quote: (row.cols[COL_QUOTE] || '').trim(),
      explanation,
    });
  }
  return selected;
}

function chunkRows(selected, size = MAX_ROWS_PER_CALL) {
  const chunks = [];
  for (let i = 0; i < selected.length; i += size) chunks.push(selected.slice(i, i + size));
  return chunks;
}

// --- prompt ----------------------------------------------------------------

function readRel(rel) {
  if (!rel) return '';
  try {
    const abs = path.resolve(CSKILLBP_DIR, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  } catch {
    return '';
  }
}

// Slice one chapter out of a USFM book so a full-book Hebrew file does not
// blow the input budget.
function extractChapter(usfm, chapter) {
  if (!usfm) return '';
  const start = usfm.search(new RegExp(`\\\\c\\s+${chapter}\\s`));
  if (start === -1) return usfm;
  const rest = usfm.slice(start);
  const next = rest.search(new RegExp(`\\\\c\\s+${Number(chapter) + 1}\\s`));
  return next === -1 ? rest : rest.slice(0, next);
}

const SYSTEM_PROMPT = [
  'You are a Hebrew exegete reviewing draft translation-note issues for the unfoldingWord ULT.',
  'For each row you are given, judge whether its support reference (issue type) and its explanation',
  'state the correct interpretation of the Hebrew. Editors on ISA, JER and EZK most often correct:',
  'an over-applied figs-idiom where figs-explicit or figs-metaphor is right; a "This could mean" note',
  'whose primary reading is wrong; and a single committed reading where two readings are defensible.',
  '',
  'Return one verdict per row, choosing exactly one action:',
  '  agree  — the type and explanation are right; change nothing.',
  '  revise — the type is right but the explanation states the wrong reading; give a new explanation.',
  '  tcm    — two readings are genuinely defensible; give both, primary reading first.',
  '  retype — the explanation is right but the support reference is wrong; give a new one.',
  '  drop   — the row is not a real translation issue and should be removed.',
  '',
  `Valid support references for retype: ${[...INTERP_SREFS].join(', ')}.`,
  '',
  'Explanations are terse editorial instructions to a note writer, not prose for a reader.',
  'Match the voice of the input explanations. Prefer agree when the existing reading is defensible —',
  'only revise when the current reading is actually wrong.',
  '',
  'Respond with JSON only, no prose and no code fence:',
  '{"verdicts":[{"index":<row index>,"action":"agree|revise|tcm|retype|drop",',
  '"explanation":"<required for revise and tcm>","sref":"<required for retype>",',
  '"reason":"<one line>"}]}',
].join('\n');

function buildPrompt({ book, chapter, ult, ust, hebrew, rows }) {
  const sections = [`# Chapter under review: ${book} ${chapter}`];
  if (ult) sections.push(`## ULT\n${ult.trim()}`);
  if (ust) sections.push(`## UST\n${ust.trim()}`);
  if (hebrew) sections.push(`## Hebrew\n${hebrew.trim()}`);
  sections.push(
    `## Rows to review (${rows.length})\n${JSON.stringify(
      rows.map((r) => ({
        index: r.index,
        verse: r.verse,
        sref: r.sref,
        quote: r.quote,
        explanation: r.explanation,
      })),
      null,
      2
    )}`
  );
  sections.push('Return the JSON object described in the system prompt. One verdict per row above.');
  return sections.join('\n\n');
}

// --- verdict parsing -------------------------------------------------------

// Tolerant of a stray code fence or leading prose; returns null when the
// payload is unusable so the caller can leave the file untouched.
function parseVerdicts(text) {
  if (!text || !String(text).trim()) return null;
  const raw = String(text).trim();
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  // Fall back to slicing out the outermost array or object only if the whole
  // payload does not parse — slicing first would strip a bare array's wrapper.
  const bracket = raw.match(/\[[\s\S]*\]/);
  if (bracket) candidates.push(bracket[0]);
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.verdicts;
    if (Array.isArray(list)) return list;
  }
  return null;
}

// --- apply -----------------------------------------------------------------

// Rewrites only the explanation column (and the sref column for retype).
// The quote column is matched mechanically downstream and is never touched.
function applyVerdicts(rows, verdicts, allowedIndexes) {
  const counts = { agree: 0, revise: 0, tcm: 0, retype: 0, drop: 0, invalid: 0 };
  const applied = [];
  const dropped = new Set();
  const seen = new Set();
  const allowed = allowedIndexes instanceof Set ? allowedIndexes : new Set(allowedIndexes || []);
  const byIndex = new Map(rows.map((r) => [r.index, r]));

  for (const verdict of verdicts || []) {
    const index = Number(verdict && verdict.index);
    const action = String((verdict && verdict.action) || '').toLowerCase();
    // A hallucinated or duplicated index must never rewrite an unrelated row.
    if (!Number.isInteger(index) || !allowed.has(index) || seen.has(index)) {
      counts.invalid += 1;
      continue;
    }
    if (!VALID_ACTIONS.has(action)) {
      counts.invalid += 1;
      continue;
    }
    const row = byIndex.get(index);
    if (!row) {
      counts.invalid += 1;
      continue;
    }
    const before = { sref: row.cols[COL_SREF], explanation: row.cols[COL_EXPLANATION] };
    const newExplanation = String((verdict && verdict.explanation) || '').trim();
    const newSref = String((verdict && verdict.sref) || '').trim();

    if (action === 'agree') {
      counts.agree += 1;
      continue;
    }
    if (action === 'drop') {
      dropped.add(index);
      counts.drop += 1;
      applied.push({ index, action, before, after: null, reason: verdict.reason || '' });
      continue;
    }
    if (action === 'revise') {
      if (!newExplanation) {
        counts.invalid += 1;
        continue;
      }
      row.cols[COL_EXPLANATION] = newExplanation;
    } else if (action === 'tcm') {
      if (!newExplanation) {
        counts.invalid += 1;
        continue;
      }
      // A leading TCM marker is what switches the note into "This could mean" mode.
      row.cols[COL_EXPLANATION] = isTcmExplanation(newExplanation)
        ? newExplanation
        : `TCM ${newExplanation}`;
    } else if (action === 'retype') {
      if (!INTERP_SREFS.has(newSref)) {
        counts.invalid += 1;
        continue;
      }
      row.cols[COL_SREF] = newSref;
      if (newExplanation) row.cols[COL_EXPLANATION] = newExplanation;
    }
    counts[action] += 1;
    seen.add(index);
    applied.push({
      index,
      action,
      before,
      after: { sref: row.cols[COL_SREF], explanation: row.cols[COL_EXPLANATION] },
      reason: (verdict && verdict.reason) || '',
    });
  }

  const kept = rows.filter((r) => !dropped.has(r.index));
  return { rows: kept, counts, applied, changed: applied.length > 0 };
}

// --- settings --------------------------------------------------------------

function normalizeBooks(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BOOKS;
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'all') return 'all';
    return value
      .split(',')
      .map((b) => b.trim().toUpperCase())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.map((b) => String(b).trim().toUpperCase()).filter(Boolean);
  return DEFAULT_BOOKS;
}

function resolveInterpReviewSettings(config, book) {
  const raw = (config && config.interpReview) || {};
  const mode = String(process.env.BP_INTERP_REVIEW_MODE || raw.mode || 'off')
    .trim()
    .toLowerCase();
  const books = normalizeBooks(
    process.env.BP_INTERP_REVIEW_BOOKS !== undefined ? process.env.BP_INTERP_REVIEW_BOOKS : raw.books
  );
  const model = String(process.env.BP_INTERP_REVIEW_MODEL || raw.model || DEFAULT_MODEL).trim();
  const upperBook = String(book || '').toUpperCase();
  const bookAllowed = books === 'all' || books.includes(upperBook);
  const modeValid = mode === 'report' || mode === 'apply';
  return { mode, books, model, enabled: modeValid && bookAllowed };
}

// --- model call ------------------------------------------------------------

// Fable rejects `thinking: disabled` and forced tool choice; this call uses
// adaptive thinking at high effort and declares no tools, so neither applies.
async function callInterpModel({ model, prompt }) {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return { ok: false, reason: 'no_api_key' };

  let resolvedModel;
  try {
    resolvedModel = resolveProviderModel('claude', model);
  } catch {
    return { ok: false, reason: `unknown_model:${model}` };
  }
  if (!isConfiguredModel('claude', resolvedModel)) {
    return { ok: false, reason: `unknown_model:${model}` };
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: prompt }],
  });

  // A safety decline arrives as HTTP 200; treat it as "keep original".
  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: 'refusal', response };
  }
  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { ok: true, text, response, model: resolvedModel };
}

// --- report ----------------------------------------------------------------

function renderReviewMarkdown({ book, chapter, mode, model, selectedCount, counts, applied }) {
  const lines = [
    `# Interpretive review — ${book} ${chapter}`,
    '',
    `- Mode: \`${mode}\``,
    `- Model: \`${model}\``,
    `- Rows selected: ${selectedCount}`,
    `- Verdicts: agree ${counts.agree}, revise ${counts.revise}, TCM ${counts.tcm}, retype ${counts.retype}, drop ${counts.drop}, invalid ${counts.invalid}`,
    '',
  ];
  if (!applied.length) {
    lines.push('No changes proposed.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(mode === 'apply' ? '## Changes applied' : '## Changes proposed (not applied)', '');
  for (const item of applied) {
    lines.push(`### Row ${item.index} — ${item.action}`);
    if (item.reason) lines.push(`_${item.reason}_`);
    lines.push('');
    lines.push(`- Before: \`${item.before.sref}\` — ${item.before.explanation}`);
    if (item.after) lines.push(`- After: \`${item.after.sref}\` — ${item.after.explanation}`);
    else lines.push('- After: _(row dropped)_');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function summarizeCounts(counts, mode) {
  const verb = mode === 'apply' ? ['revised', 'converted', 'retyped', 'dropped'] : ['would revise', 'would convert', 'would retype', 'would drop'];
  const parts = [];
  if (counts.revise) parts.push(`${verb[0]} ${counts.revise}`);
  if (counts.tcm) parts.push(`${verb[1]} ${counts.tcm} to TCM`);
  if (counts.retype) parts.push(`${verb[2]} ${counts.retype}`);
  if (counts.drop) parts.push(`${verb[3]} ${counts.drop}`);
  if (!parts.length) return 'no changes';
  return parts.join(', ');
}


// --- orchestrator ----------------------------------------------------------

// Non-fatal by contract: every failure path returns without throwing and
// leaves the issues TSV byte-identical.
async function runInterpretiveReview({
  issuesPath,
  book,
  chapter,
  tag,
  ctx,
  status,
  reply,
  config,
  callModel = callInterpModel,
}) {
  const settings = resolveInterpReviewSettings(config, book);
  if (!settings.enabled) {
    return { ran: false, reason: settings.mode === 'off' ? 'mode_off' : 'book_not_selected', settings };
  }

  const absPath = path.resolve(CSKILLBP_DIR, issuesPath);
  if (!fs.existsSync(absPath)) return { ran: false, reason: 'missing_issues_tsv', settings };

  const original = fs.readFileSync(absPath, 'utf8');
  const { rows, hadTrailingNewline } = parseIssuesTsv(original);
  const selected = selectRows(rows);
  if (!selected.length) return { ran: false, reason: 'no_rows_selected', settings };

  const sources = (ctx && ctx.sources) || {};
  const ult = readRel(sources.ultPlain || sources.ult);
  const ust = readRel(sources.ustPlain || sources.ust);
  const hebrew = extractChapter(readRel(sources.hebrew), chapter);

  const chunks = chunkRows(selected);
  const verdicts = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let usedModel = settings.model;

  for (const chunk of chunks) {
    const prompt = buildPrompt({ book, chapter, ult, ust, hebrew, rows: chunk });
    let outcome;
    try {
      outcome = await callModel({ model: settings.model, prompt });
    } catch (err) {
      console.warn(`[interp-review] ${book} ${chapter}: model call failed (${err.message}); leaving issues TSV untouched`);
      return { ran: false, reason: 'call_failed', error: err.message, settings };
    }
    if (!outcome || !outcome.ok) {
      const reason = (outcome && outcome.reason) || 'call_failed';
      console.warn(`[interp-review] ${book} ${chapter}: ${reason}; leaving issues TSV untouched`);
      return { ran: false, reason, settings };
    }
    const parsed = parseVerdicts(outcome.text);
    if (!parsed) {
      console.warn(`[interp-review] ${book} ${chapter}: unparseable verdict JSON; leaving issues TSV untouched`);
      return { ran: false, reason: 'parse_failed', settings };
    }
    verdicts.push(...parsed);
    if (outcome.model) usedModel = outcome.model;
    const u = (outcome.response && outcome.response.usage) || {};
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
  }

  const allowed = new Set(selected.map((r) => r.index));
  const result = applyVerdicts(rows, verdicts, allowed);

  if (settings.mode === 'apply' && result.changed) {
    fs.writeFileSync(absPath, serializeIssuesTsv(result.rows, hadTrailingNewline));
  }

  const reviewRel = `output/review/${book}/${tag || `${book}-${chapter}`}-interp-fable.md`;
  try {
    const reviewAbs = path.resolve(CSKILLBP_DIR, reviewRel);
    fs.mkdirSync(path.dirname(reviewAbs), { recursive: true });
    fs.writeFileSync(
      reviewAbs,
      renderReviewMarkdown({
        book,
        chapter,
        mode: settings.mode,
        model: usedModel,
        selectedCount: selected.length,
        counts: result.counts,
        applied: result.applied,
      })
    );
  } catch (err) {
    console.warn(`[interp-review] failed to write review markdown: ${err.message}`);
  }

  const summary = summarizeCounts(result.counts, settings.mode);
  const line = `**${book} ${chapter}** interpretive review (${settings.mode}, ${usedModel}): reviewed ${selected.length} rows — ${summary}.`;
  if (status) await status(line);
  if (reply && result.applied.length) await reply(`${line}\n\nDetails: \`${reviewRel}\``);

  return {
    ran: true,
    mode: settings.mode,
    model: usedModel,
    selectedCount: selected.length,
    counts: result.counts,
    applied: result.applied,
    reviewPath: reviewRel,
    summary,
    usage,
    settings,
  };
}

module.exports = {
  INTERP_SREFS,
  HEDGE_RE,
  MAX_ROWS_PER_CALL,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  parseIssuesTsv,
  serializeIssuesTsv,
  selectRows,
  chunkRows,
  buildPrompt,
  extractChapter,
  parseVerdicts,
  applyVerdicts,
  resolveInterpReviewSettings,
  callInterpModel,
  renderReviewMarkdown,
  summarizeCounts,
  readRel,
  isTcmExplanation,
  runInterpretiveReview,
};
