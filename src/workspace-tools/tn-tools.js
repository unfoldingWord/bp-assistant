// tn-tools.js — Node.js ports of TN writer pipeline scripts
//
// Replaces: extract_alignment_data.py, fix_hebrew_quotes.py, flag_narrow_quotes.py,
//           generate_ids.py, resolve_gl_quotes.py, verify_at_fit.py,
//           assemble_notes.py, prepare_notes.py

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  return lines.map((line) => {
    const row = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        row.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    return row;
  });
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeVisibleUnicodeEscapes(text) {
  let value = String(text || '');
  let previous;
  do {
    previous = value;
    value = value.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } while (value !== previous && /\\u[0-9a-fA-F]{4}/.test(value));
  return value;
}

function normalizeTemplateType(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function stripAlternateTranslation(templateText) {
  return normalizeWhitespace(String(templateText || '').replace(/\s*Alternate translation:\s*\[[\s\S]*$/i, ''));
}

function templateHasAlternateTranslation(templateText) {
  return /Alternate translation:/i.test(String(templateText || ''));
}

function parseExplanationDirectives(explanation) {
  const raw = String(explanation || '').trim();
  if (!raw) return { clean_explanation: '', must_include: [], template_hints: [] };

  const parts = raw.split(/\s+(?=[it]:)/);
  const mustInclude = [];
  const templateHints = [];
  const remaining = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('i:')) {
      const value = normalizeWhitespace(trimmed.slice(2));
      if (value) mustInclude.push(value);
      continue;
    }
    if (trimmed.startsWith('t:')) {
      const value = normalizeWhitespace(trimmed.slice(2));
      if (value) templateHints.push(value);
      continue;
    }
    remaining.push(trimmed);
  }

  return {
    clean_explanation: normalizeWhitespace(remaining.join(' ')),
    must_include: mustInclude,
    template_hints: templateHints,
  };
}

let _templateCache = null;
function loadTemplateMap() {
  if (_templateCache) return _templateCache;
  const templatesPath = path.join(CSKILLBP_DIR, 'data/templates.csv');
  if (!fs.existsSync(templatesPath)) {
    _templateCache = new Map();
    return _templateCache;
  }
  const rows = parseCSV(fs.readFileSync(templatesPath, 'utf8'));
  const map = new Map();
  for (const row of rows.slice(1)) {
    if (!row[0] || !row[2]) continue;
    const issueType = normalizeWhitespace(row[0]);
    const type = normalizeWhitespace(row[1] || '');
    const template = normalizeWhitespace(row[2]);
    if (!issueType || !template) continue;
    if (!map.has(issueType)) map.set(issueType, []);
    map.get(issueType).push({ issue_type: issueType, type, template });
  }
  _templateCache = map;
  return _templateCache;
}

function templatePriority(template) {
  const type = normalizeTemplateType(template?.type || '');
  if (!type || type === 'generic') return 0;
  return 1;
}

const ISSUE_SCOPE_MODE_BY_SLUG = {
  'figs-parallelism': 'full_parallelism',
};

const ISSUE_SCOPE_MODE_BY_PREFIX = [
  ['grammar-connect-logic-', 'full_restructure_region'],
  ['grammar-connect-time-', 'full_restructure_region'],
];

function detectIssueScopeMode(sref, glQuote = '') {
  const normalizedSref = normalizeWhitespace(sref);
  const normalizedQuote = normalizeWhitespace(glQuote);
  if (/\s&\s/.test(normalizedQuote) || normalizedQuote.includes('\u2026') || normalizedQuote.includes('...')) {
    return 'discontinuous_span';
  }
  if (ISSUE_SCOPE_MODE_BY_SLUG[normalizedSref]) return ISSUE_SCOPE_MODE_BY_SLUG[normalizedSref];
  for (const [prefix, mode] of ISSUE_SCOPE_MODE_BY_PREFIX) {
    if (normalizedSref.startsWith(prefix)) return mode;
  }
  return 'focused_span';
}

function applyScopeModeToSpan({ scopeMode, glQuote = '', ultVerse = '' }) {
  const normalizedQuote = normalizeWhitespace(glQuote);
  if ((scopeMode === 'full_parallelism' || scopeMode === 'full_restructure_region') && normalizeWhitespace(ultVerse)) {
    return normalizeWhitespace(ultVerse);
  }
  return normalizedQuote;
}

function resolveQuoteScopeSelection({ sref, glQuote = '', ultVerse = '' }) {
  const scopeMode = detectIssueScopeMode(sref, glQuote);
  const selectedSpan = applyScopeModeToSpan({ scopeMode, glQuote, ultVerse });
  return {
    scope_mode: scopeMode,
    selected_span: selectedSpan || normalizeWhitespace(glQuote),
    selector_status: 'fallback_deterministic',
    selector_fallback_reason: 'quote_scope_selector_not_configured',
  };
}

function buildTemplateId(sref, templateType, index) {
  const slug = normalizeWhitespace(sref) || 'unknown';
  const type = normalizeTemplateType(templateType || '') || 'generic';
  return `${slug}::${type}::${index}`;
}

function toTemplateCandidate(template, sref, index) {
  return {
    template_id: buildTemplateId(sref, template?.type, index),
    type: normalizeWhitespace(template?.type || '') || 'generic',
    template_text: stripAlternateTranslation(template?.template || ''),
    has_alternate_translation: templateHasAlternateTranslation(template?.template || ''),
    _template: template,
  };
}

function resolveTemplateSelection({
  sref,
  templateHints = [],
  noAtOnly = false,
  templateMap = loadTemplateMap(),
  selectorChoice = null,
}) {
  const templates = Array.isArray(templateMap?.get?.(sref)) ? templateMap.get(sref) : [];
  const candidates = templates.map((template, index) => toTemplateCandidate(template, sref, index));
  const normalizedHints = templateHints.map(normalizeTemplateType).filter(Boolean);
  let filtered = candidates.slice();
  const fallbackReasons = [];

  if (normalizedHints.length) {
    const hinted = filtered.filter((candidate) => normalizedHints.includes(normalizeTemplateType(candidate.type)));
    if (hinted.length) filtered = hinted;
    else fallbackReasons.push('hint_filter_empty');
  }

  if (noAtOnly) {
    const noAt = filtered.filter((candidate) => !candidate.has_alternate_translation);
    if (noAt.length) filtered = noAt;
    else fallbackReasons.push('no_at_filter_empty');
  }

  let selected = null;
  let templateLocked = false;
  let selectionReason = 'missing';
  let selectorStatus = 'fallback_deterministic';
  let selectorFallbackReason = fallbackReasons.length ? fallbackReasons.join(',') : 'none';

  if (selectorChoice && selectorChoice.template_id) {
    const aiPick = filtered.find((candidate) => candidate.template_id === selectorChoice.template_id);
    if (aiPick) {
      selected = aiPick;
      selectionReason = 'selector_choice';
      selectorStatus = 'selected';
      selectorFallbackReason = 'none';
    } else {
      fallbackReasons.push('invalid_selector_template');
      selectorFallbackReason = fallbackReasons.join(',');
    }
  }

  if (!selected && normalizedHints.length) {
    const exact = filtered.filter((candidate) => normalizedHints.includes(normalizeTemplateType(candidate.type)));
    if (exact.length === 1) {
      selected = exact[0];
      templateLocked = true;
      selectionReason = 'hint_exact';
    } else if (exact.length > 1) {
      exact.sort((a, b) => templatePriority(a) - templatePriority(b) || normalizeTemplateType(a.type).localeCompare(normalizeTemplateType(b.type)));
      selected = exact[0];
      selectionReason = 'hint_multi';
    }
  }

  if (!selected && filtered.length === 1) {
    selected = filtered[0];
    templateLocked = true;
    selectionReason = 'single_template';
  }

  if (!selected && filtered.length > 1) {
    const sorted = filtered.slice().sort((a, b) => templatePriority(a) - templatePriority(b) || normalizeTemplateType(a.type).localeCompare(normalizeTemplateType(b.type)));
    selected = sorted[0];
    selectionReason = 'deterministic_default';
  }

  const selectedTemplate = selected?._template || null;
  return {
    selected_template: selectedTemplate,
    selected_template_id: selected?.template_id || '',
    selected_template_has_at_slot: !!selected?.has_alternate_translation,
    template_locked: templateLocked,
    selection_reason: selectionReason,
    selector_status: selectorStatus,
    selector_fallback_reason: selectorFallbackReason,
    candidate_templates: filtered.map((candidate) => ({
      template_id: candidate.template_id,
      type: candidate.type,
      template_text: candidate.template_text,
      has_alternate_translation: candidate.has_alternate_translation,
    })),
  };
}

const ISSUE_STYLE_RULES = {
  'writing-background': ['no_at', 'no_narrative_elaboration'],
  'writing-newevent': ['no_at', 'no_narrative_elaboration'],
  'figs-imperative': ['no_extra_imperative_explanation'],
  'grammar-connect-logic-result': ['keep_to_template', 'do_not_identify_specific_phrases'],
  'figs-quotesinquotes': ['keep_to_template', 'do_not_quote_embedded_text'],
};

function hasAtOverride(mustInclude) {
  const joined = (mustInclude || []).join(' ');
  return /\balternate translation\b|\bAT\b/i.test(joined);
}

function deriveAtRequirement({
  atProvided = '',
  needsAt = false,
  selectedTemplate = null,
  selectedTemplateHasAtSlot = null,
  styleRules = [],
  hasAtPolicyOverride = false,
}) {
  const provided = normalizeWhitespace(atProvided);
  const templateHasAtSlot = typeof selectedTemplateHasAtSlot === 'boolean'
    ? selectedTemplateHasAtSlot
    : templateHasAlternateTranslation(selectedTemplate?.template || '');
  const noAtRestricted = styleRules.includes('no_at') && !hasAtPolicyOverride;

  if (provided) {
    return { at_policy: 'provided', at_required: false, selected_template_has_at_slot: templateHasAtSlot, reason: 'provided_at' };
  }
  if (noAtRestricted) {
    return { at_policy: 'forbidden', at_required: false, selected_template_has_at_slot: templateHasAtSlot, reason: 'no_at_rule' };
  }
  if (templateHasAtSlot) {
    return { at_policy: 'required', at_required: true, selected_template_has_at_slot: true, reason: 'template_requires_at' };
  }
  if (!selectedTemplate && needsAt) {
    return { at_policy: 'required', at_required: true, selected_template_has_at_slot: false, reason: 'needs_at_without_template' };
  }
  if (needsAt) {
    return { at_policy: 'not_needed', at_required: false, selected_template_has_at_slot: false, reason: 'template_without_at_slot' };
  }
  return { at_policy: 'not_needed', at_required: false, selected_template_has_at_slot: templateHasAtSlot, reason: 'not_required' };
}

function deriveStyleProfile({ sref, mustInclude = [], atProvided = '', needsAt = false, selectedTemplate = null }) {
  const styleRules = [...(ISSUE_STYLE_RULES[sref] || [])];
  const overrides = [];
  const hasPolicyOverride = hasAtOverride(mustInclude);

  if (styleRules.includes('no_at')) {
    if (hasPolicyOverride) {
      overrides.push('at_policy_from_i');
    }
  }

  const atDecision = deriveAtRequirement({
    atProvided,
    needsAt,
    selectedTemplate,
    styleRules,
    hasAtPolicyOverride: hasPolicyOverride,
  });

  return {
    at_policy: atDecision.at_policy,
    at_required: atDecision.at_required,
    selected_template_has_at_slot: atDecision.selected_template_has_at_slot,
    at_decision_reason: atDecision.reason,
    style_rules: styleRules,
    rule_overrides: overrides,
  };
}

function resolveAtRequirement(item = {}) {
  if (typeof item.at_required === 'boolean') {
    return { at_required: item.at_required, source: 'at_required' };
  }

  const policy = normalizeWhitespace(item.at_policy).toLowerCase();
  if (policy === 'required') return { at_required: true, source: 'at_policy_required' };
  if (policy === 'provided' || policy === 'forbidden' || policy === 'not_needed') {
    return { at_required: false, source: `at_policy_${policy}` };
  }

  if (item.tcm_mode) return { at_required: true, source: 'tcm_mode' };
  if (item.selected_template_has_at_slot === true) return { at_required: true, source: 'selected_template_has_at_slot' };
  if (item.needs_at) return { at_required: true, source: 'needs_at' };
  return { at_required: false, source: 'default' };
}

function formatAlternateTranslation(at) {
  const value = normalizeWhitespace(at);
  if (!value) return '';
  if (value.includes('/')) {
    const options = value.split('/').map(normalizeWhitespace).filter(Boolean).map((option) => `[${option}]`);
    return options.length ? ` Alternate translation: ${options.join(' or ')}` : '';
  }
  return ` Alternate translation: [${value}]`;
}

function buildSeeHowReference(refHint, item) {
  const hint = normalizeWhitespace(refHint).replace(/^see how\s+/i, '');
  if (!hint) return '';
  const currentBook = String(item.book || '').toLowerCase();
  const [currentChapter] = String(item.reference || '').split(':');
  const sameVerse = hint.match(/^(\d+)$/);
  if (sameVerse && currentBook && currentChapter) {
    const verse = sameVerse[1];
    return `See how you translated the similar expression in [verse ${verse}](../../${currentBook}/${currentChapter}/${verse}.md).`;
  }
  const sameBook = hint.match(/^(\d+):(\d+)$/);
  if (sameBook && currentBook) {
    const chapter = sameBook[1];
    const verse = sameBook[2];
    return `See how you translated the similar expression in [chapter ${chapter}:${verse}](../../${currentBook}/${chapter}/${verse}.md).`;
  }
  const otherBook = hint.match(/^([1-3]?[A-Za-z]{3})\s+(\d+):(\d+)$/);
  if (otherBook) {
    const book = otherBook[1].toLowerCase();
    const chapter = otherBook[2];
    const verse = otherBook[3];
    return `See how you translated the similar expression in [${otherBook[1].toUpperCase()} ${chapter}:${verse}](../../${book}/${chapter}/${verse}.md).`;
  }
  return '';
}

function maybeBuildProgrammaticNote(item) {
  const explanation = normalizeWhitespace(item.explanation || '');
  if (!/^see how\b/i.test(explanation)) return '';
  const referenceNote = buildSeeHowReference(explanation, item);
  if (!referenceNote) return '';
  return normalizeWhitespace(`${referenceNote}${formatAlternateTranslation(item.at_provided || '')}`);
}

function buildWriterPacket(item) {
  const scopedQuote = item.issue_span_gl_quote || item.gl_quote || '';
  return {
    reference: item.reference,
    id: item.id,
    sref: item.sref,
    note_type: item.note_type,
    at_policy: item.at_policy,
    at_required: !!item.at_required,
    template_type: item.template_type || 'generic',
    template_locked: !!item.template_locked,
    template_text: item.template_text || '',
    chosen_template_id: item.chosen_template_id || '',
    chosen_template_has_at_slot: !!item.chosen_template_has_at_slot,
    scope_mode: item.scope_mode || 'focused_span',
    must_include: item.must_include || [],
    clean_explanation: item.clean_explanation || '',
    style_rules: item.style_rules || [],
    rule_overrides: item.rule_overrides || [],
    issue_span_gl_quote: scopedQuote,
    gl_quote: scopedQuote,
    orig_quote: item.orig_quote || '',
    ult_verse: item.ult_verse || '',
    ust_verse: item.ust_verse || '',
    at_provided: item.at_provided || '',
    prose_mode: 'template_plus_necessity',
    programmatic_note: item.programmatic_note || '',
  };
}

function buildWriterPrompt(item) {
  if (item.programmatic_note) {
    return `Return only this note exactly as written:\n${item.programmatic_note}`;
  }

  const packet = buildWriterPacket(item);
  const lines = [
    'Return only the note text.',
    'Write the shortest faithful translation note that fully satisfies the selected template for this single item.',
    'Keep the fixed template wording intact. Only add explanation if needed to explain what the figure or construction is doing in this verse.',
    'Do not choose a different template or introduce broader contextual elaboration.',
    'Your note MUST begin by filling in the selected template below. Do not prepend extra sentences or substitute phrasings from Translation Academy definitions or other notes.',
    `Reference: ${packet.reference}`,
    `Issue type: ${packet.sref}`,
    `Quote (scoped): ${packet.issue_span_gl_quote || '(none)'}`,
    `Quote scope mode: ${packet.scope_mode}`,
    `AT policy: ${packet.at_policy}`,
    `Selected template type: ${packet.template_type}`,
    `Selected template ID: ${packet.chosen_template_id || '(none)'}`,
    `Selected template: ${packet.template_text || '(no template found)'}`,
  ];

  if (packet.clean_explanation) lines.push(`Explanation context: ${packet.clean_explanation}`);
  if (packet.must_include.length) lines.push(`Must include: ${packet.must_include.join(' | ')}`);
  if (packet.style_rules.length) lines.push(`Style rules: ${packet.style_rules.join(', ')}`);
  if (packet.rule_overrides.length) lines.push(`Overrides: ${packet.rule_overrides.join(', ')}`);
  if (packet.at_required) lines.push('Do NOT include an alternate translation. The AT will be generated separately by the pipeline. Write only the explanatory note text.');
  else lines.push('Do not add an alternate translation unless the provided note text already includes one programmatically.');
  if (packet.at_policy === 'provided' && packet.at_provided) lines.push(`Provided AT context: ${packet.at_provided}`);
  if (packet.ult_verse) lines.push(`ULT verse: ${packet.ult_verse}`);
  if (packet.ust_verse) lines.push(`UST verse: ${packet.ust_verse}`);
  return lines.join('\n');
}

function extractAlignmentData({ alignedUsfm, output }) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  let chapter = 0, verse = '0';
  const milestones = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { chapter = parseInt(cm[1], 10); verse = '0'; milestones.length = 0; continue; }

    // Skip file headers (\id, \usfm, \h, etc.) before any chapter marker
    if (chapter === 0) continue;

    // Verse marker can appear mid-line after a poetry marker (e.g. \q1 \v 1 \zaln-s...)
    // Update verse but do NOT continue — alignment data on the same line must still be processed
    const vm = trimmed.match(/\\v\s+(\d+[-\d]*|front)/);
    if (vm) { verse = vm[1].split('-')[0]; milestones.length = 0; }

    const ZALN_S = /\\zaln-s\s+\|([^\\]*?)\\?\*/g;
    const ZALN_E = /\\zaln-e\\?\*/g;
    const WORD = /\\w\s+([^|\\]+)\|[^\\]*\\w\*/g;
    const key = `${chapter}:${verse}`;
    if (!result[key]) result[key] = [];

    const tokens = [];
    let m;
    ZALN_S.lastIndex = 0;
    while ((m = ZALN_S.exec(trimmed)) !== null) tokens.push({ type: 's', idx: m.index, attrs: m[1] });
    ZALN_E.lastIndex = 0;
    while ((m = ZALN_E.exec(trimmed)) !== null) tokens.push({ type: 'e', idx: m.index });
    WORD.lastIndex = 0;
    while ((m = WORD.exec(trimmed)) !== null) tokens.push({ type: 'w', idx: m.index, word: m[1].trim() });
    tokens.sort((a, b) => a.idx - b.idx);

    for (const tok of tokens) {
      if (tok.type === 's') {
        const sM = tok.attrs.match(/x-strong="([^"]*)"/);
        const cM = tok.attrs.match(/x-content="([^"]*)"/);
        milestones.push({ heb: cM ? cM[1] : '', strong: sM ? sM[1] : '', heb_pos: milestones.length });
      } else if (tok.type === 'e') { milestones.pop(); }
      else if (tok.type === 'w' && milestones.length > 0) {
        const top = milestones[milestones.length - 1];
        result[key].push({ eng: tok.word, heb: top.heb, heb_pos: top.heb_pos, strong: top.strong });
      }
    }
  }

  const json = JSON.stringify(result, null, 2);
  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    return `Extracted alignment data to ${outPath}`;
  }
  return json;
}

function fixHebrewQuotes({ book, chapter, hebrewUsfm, output }) {
  let filePath;
  if (hebrewUsfm) filePath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    if (!fs.existsSync(dir)) return '[]';
    const files = fs.readdirSync(dir).filter(f => f.toUpperCase().includes(book.toUpperCase()) && f.endsWith('.usfm'));
    if (!files.length) return '[]';
    filePath = path.join(dir, files[0]);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const ch = parseInt(chapter, 10);
  let inChapter = false, inSuper = false;
  const words = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { if (inChapter) break; inChapter = parseInt(cm[1], 10) === ch; continue; }
    if (!inChapter) continue;
    if (trimmed.startsWith('\\d')) { inSuper = true; continue; }
    if ((trimmed.startsWith('\\v') || trimmed.startsWith('\\p')) && inSuper) break;
    if (inSuper) {
      const WRE = /\\w\s+([^|]+)\|([^\\]*?)\\w\*/g;
      let m;
      while ((m = WRE.exec(trimmed)) !== null) {
        const sM = m[2].match(/strong="([^"]*)"/);
        const lM = m[2].match(/lemma="([^"]*)"/);
        words.push({ word: m[1].trim(), strong: sM ? sM[1] : '', lemma: lM ? lM[1] : '' });
      }
    }
  }
  const json = JSON.stringify(words);
  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    return `Extracted ${words.length} Hebrew superscription words to ${outPath}`;
  }
  return json;
}

function flagNarrowQuotes({ preparedJson }) {
  const data = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const PRONOUNS = new Set(['he','she','they','it','we','you','him','her','them','us','my','his','her','their','our','your','its','mine','hers','theirs','ours','yours','i','me','myself','himself','herself','itself','themselves','ourselves','yourself','yourselves']);
  const NARROW = new Set(['figs-abstractnouns', 'figs-activepassive']);
  const flagged = [];
  for (const item of (data.items || [])) {
    const q = (item.gl_quote || '').trim();
    if (!q) continue;
    const words = q.split(/\s+/);
    let reason = null;
    if (words.length === 1) {
      if (PRONOUNS.has(words[0].toLowerCase())) reason = 'single pronoun';
      else if (NARROW.has(item.sref)) reason = `single word with ${item.sref}`;
      else reason = 'single non-pronoun word';
    } else if (words.length === 2 && PRONOUNS.has(words[0].toLowerCase())) reason = 'two-word quote starting with pronoun';
    if (reason) flagged.push(`${item.id}  ${item.reference}  [${item.sref}]\n  gl_quote: ${q}\n  reason: ${reason}`);
  }
  return flagged.length ? `${flagged.length} narrow quote(s) flagged:\n\n${flagged.join('\n\n')}` : 'No narrow quotes flagged';
}

async function generateIds({ book, count }) {
  const upstreamIds = new Set();
  try {
    const url = `https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_${book.toUpperCase()}.tsv`;
    const content = await httpsGet(url);
    for (const line of content.split('\n')) {
      const cols = line.split('\t');
      if (cols.length > 1 && /^[a-z][a-z0-9]{3}$/.test(cols[1])) upstreamIds.add(cols[1]);
    }
  } catch { /* proceed */ }
  const ids = [];
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < count; i++) {
    let id, attempts = 0;
    do {
      id = letters[Math.floor(Math.random() * 26)];
      for (let j = 0; j < 3; j++) id += chars[Math.floor(Math.random() * 36)];
      attempts++;
    } while ((upstreamIds.has(id) || ids.includes(id)) && attempts < 100);
    if (attempts >= 100) { const h = crypto.createHash('md5').update(Date.now().toString() + i).digest('hex'); id = 'x' + h.slice(0, 3); }
    ids.push(id);
  }
  return ids.join('\n');
}

function resolveGlQuotes({ preparedJson, alignmentJson, dryRun }) {
  const data = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const alignData = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, alignmentJson), 'utf8'));
  const CANT = /[\u0591-\u05AF\u2060\u05BE]/g;
  let updated = 0;
  const log = [];

  for (const item of (data.items || [])) {
    if (!item.orig_quote) continue;
    const alignRef = item.reference.replace(/:(?!\d).*$/, '');
    const entries = alignData[alignRef] || alignData[item.reference] || [];
    if (!entries.length) continue;

    // Build set of target Hebrew words (stripped of cantillation)
    const hebWords = item.orig_quote.split(/\s+/);
    const targetSet = new Set(hebWords.map(w => w.replace(CANT, '')));

    // Single pass through entries in ULT word order — collect all matches
    const matched = entries.filter(e => {
      const stripped = e.heb.replace(CANT, '');
      return targetSet.has(stripped) || targetSet.has(e.heb);
    });

    if (!matched.length) continue;

    const span = matched.map(e => e.eng).join(' ');
    const currentScoped = item.issue_span_gl_quote || item.gl_quote || '';
    if (span && span !== currentScoped) {
      log.push(`${item.reference}: "${currentScoped}" -> "${span}"`);
      if (!dryRun) {
        item.issue_span_gl_quote = span;
        item.gl_quote = span;
        if (item.writer_packet) {
          item.writer_packet.issue_span_gl_quote = span;
          item.writer_packet.gl_quote = span;
        }
      }
      updated++;
    }
  }

  if (!dryRun) fs.writeFileSync(path.resolve(CSKILLBP_DIR, preparedJson), JSON.stringify(data, null, 2));
  log.unshift(`${dryRun ? '[DRY RUN] ' : ''}Updated ${updated} gl_quotes`);
  return log.join('\n');
}

function verifyAtFit({ preparedJson, generatedJson }) {
  const prepared = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const generated = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, generatedJson), 'utf8'));
  const itemById = {};
  for (const item of (prepared.items || [])) itemById[item.id] = item;
  const results = [], errors = [];
  for (const [id, noteText] of Object.entries(generated)) {
    const item = itemById[id];
    if (!item) continue;
    const atMatches = noteText.match(/\[([^\]]+)\]/g) || [];
    for (const atRaw of atMatches) {
      const at = atRaw.slice(1, -1);
      const ult = item.ult_verse || '';
      const glq = (item.gl_quote || '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
      let idx = ult.indexOf(glq);
      if (idx < 0) idx = ult.toLowerCase().indexOf(glq.toLowerCase());
      if (idx >= 0) { results.push(`${item.reference} (${id}) [${item.sref}]\n  [${at}]\n  -> ${(ult.slice(0, idx) + at + ult.slice(idx + glq.length)).slice(0, 150)}`); }
      else errors.push(`${item.reference} (${id}): gl_quote "${glq}" not found in ULT`);
    }
  }
  const lines = [`AT check: ${results.length} OK, ${errors.length} errors`];
  if (errors.length) { lines.push('\nErrors:'); lines.push(...errors.slice(0, 10)); }
  return lines.join('\n');
}

function normalizeAssembledNoteText(noteText) {
  return decodeVisibleUnicodeEscapes(String(noteText || ''))
    .replace(/\.\.\./g, '\u2026')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/Alternate translation:\s*["\u201C]([^"\u201D]*)["\u201D]/g, 'Alternate translation: [$1]')
    // Catch bare AT text (no quotes or brackets) — e.g. "Alternate translation: some text"
    .replace(/Alternate translation:\s+(?![\["\u201C])(.+?)$/gm, 'Alternate translation: [$1]')
    .trim();
}

function assembleNotes({ preparedJson, generatedJson, output }) {
  const prepared = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, preparedJson), 'utf8'));
  const generated = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, generatedJson), 'utf8'));
  const outPath = path.resolve(CSKILLBP_DIR, output);
  function refKey(ref) {
    const p = ref.split(':', 2);
    if (p.length < 2) return [999999, 999999];
    const ch = p[0] === 'front' ? -1 : parseInt(p[0], 10) || 999999;
    const vs = p[1] === 'intro' ? -2 : p[1] === 'front' ? -1 : parseInt(p[1].split('-')[0], 10) || 999999;
    return [ch, vs];
  }
  function intraKey(item) {
    const ult = (item.ult_verse || '').toLowerCase();
    const glq = (item.gl_quote || '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!ult || !glq) return [9998, 0];
    let pos = ult.indexOf(glq);
    if (pos < 0) pos = 9999;
    return [pos, -glq.length];
  }
  const rows = [];
  const missing = [];
  for (const item of (prepared.items || [])) {
    // Match by ID if available, fall back to array index, then reference-based keys
    let noteText = item.id ? generated[item.id] : generated[String(item.index)];
    if (!noteText && item.reference) noteText = generated[item.reference];
    if (!noteText && item.reference && item.sref) noteText = generated[`${item.reference}:${item.sref}`] || generated[`${item.reference}_${item.sref}`];
    if (!noteText) { missing.push(item.id || `index:${item.index}`); continue; }
    const quote = item.orig_quote || '';
    const note = normalizeAssembledNoteText(noteText);
    const sref = item.sref ? `rc://*/ta/man/translate/${item.sref}` : '';
    rows.push({ ref: item.reference, id: item.id, tags: '', sref, quote, occurrence: quote ? '1' : '', note, _rk: refKey(item.reference), _ik: intraKey(item) });
  }
  rows.sort((a, b) => { const r = a._rk[0] - b._rk[0] || a._rk[1] - b._rk[1]; return r !== 0 ? r : a._ik[0] - b._ik[0] || a._ik[1] - b._ik[1]; });
  const lines = ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote'];
  for (const intro of (prepared.intro_rows || [])) lines.push(intro.replace(/\r\n|\r|\n/g, '\\n'));
  for (const row of rows) lines.push(`${row.ref}\t${row.id}\t${row.tags}\t${row.sref}\t${row.quote}\t${row.occurrence}\t${row.note}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  const res = [`Assembled ${rows.length} notes to ${outPath}`];
  if (missing.length) res.push(`Missing: ${missing.length}`);
  res.push(outPath);
  return res.join('\n');
}

function prepareNotes({ inputTsv, ultUsfm, ustUsfm, output, alignedUsfm, alignmentJson }) {
  const inputPath = path.resolve(CSKILLBP_DIR, inputTsv);
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const items = [];
  const introRows = [];
  const templateMap = loadTemplateMap();

  // --- Detect TSV column format ---
  // Canonical (old): Book  Reference  SRef  GLQuote  NeedsAT  AT  Explanation
  // Various new formats have headers and different column orders.
  // Detect format from first line, then map columns to canonical positions.
  const fnM0 = path.basename(inputPath).match(/([A-Z0-9]+)-(\d+)/i);
  const fileBook = fnM0 ? fnM0[1].toUpperCase() : '';

  let colMap = null; // null = canonical positional mapping
  let skipFirstLine = false;

  if (lines.length > 0) {
    const firstCols = lines[0].split('\t');
    const firstLower = firstCols.map(c => (c || '').trim().toLowerCase());

    // Check for header row: contains known header words (case-insensitive)
    const headerKeywords = ['reference', 'issue', 'hebrew', 'ult_quote', 'hint', 'quote', 'note', 'occurrence', 'supportreference'];
    const hasHeader = firstLower.some(h => headerKeywords.includes(h));

    if (hasHeader) {
      // Build column mapping from header names
      skipFirstLine = true;
      const hMap = {};
      firstLower.forEach((h, i) => { hMap[h] = i; });
      colMap = {
        reference: hMap['reference'] ?? hMap['ref'] ?? hMap['chapter:verse'] ?? hMap['chapter'] ?? -1,
        sref: hMap['issue'] ?? hMap['supportreference'] ?? hMap['sref'] ?? -1,
        gl_quote: hMap['ult_quote'] ?? hMap['glquote'] ?? hMap['gl_quote'] ?? hMap['ult text'] ?? hMap['ult_text'] ?? -1,
        needs_at: hMap['needs_at'] ?? hMap['go?'] ?? -1,
        at_provided: hMap['at'] ?? hMap['at_provided'] ?? -1,
        explanation: hMap['explanation'] ?? hMap['hint'] ?? hMap['note'] ?? -1,
        book_col: hMap['book'] ?? -1,
      };
    } else if (firstCols[0] && /^\d+:\d+/.test(firstCols[0].trim())) {
      // No header, col[0] is a verse reference (new format without book code)
      // Heuristic: Reference, Issue/SRef, ...rest varies
      colMap = { reference: 0, sref: 1, gl_quote: 3, needs_at: -1, at_provided: -1, explanation: 4, book_col: -1 };
      // If col[2] looks like Hebrew (contains Hebrew Unicode range), gl_quote is col[3]
      // If col[2] looks like English, gl_quote is col[2] and explanation is col[3]
      if (firstCols.length > 2 && !/[\u0590-\u05FF]/.test(firstCols[2] || '')) {
        colMap.gl_quote = 2;
        colMap.explanation = firstCols.length > 3 ? 3 : -1;
      }
    }
    // else: canonical old format (Book, Ref, SRef, GLQuote, NeedsAT, AT, Explanation) — colMap stays null
  }

  function extractRow(cols) {
    if (!colMap) {
      // Canonical old format: Book  Ref  SRef  GLQuote  NeedsAT  AT  Explanation
      const rawRef = cols[1] || cols[0];
      return {
        book: (cols[0] || '').trim(),
        reference: rawRef.includes(':') ? rawRef : `${cols[0]}:${cols[1]}`,
        sref: cols[2] || '',
        gl_quote: cols[3] || '',
        needs_at: cols[4] || '',
        at_provided: cols[5] || '',
        explanation: cols[6] || '',
      };
    }
    const get = (key) => (colMap[key] >= 0 && colMap[key] < cols.length) ? (cols[colMap[key]] || '').trim() : '';
    let ref = get('reference');
    // Strip book prefix from reference if present (e.g., "ZEC 2:1" → "2:1")
    ref = ref.replace(/^[A-Z0-9]{2,3}\s+/i, '');
    return {
      book: get('book_col') || fileBook,
      reference: ref,
      sref: get('sref'),
      gl_quote: get('gl_quote'),
      needs_at: get('needs_at'),
      at_provided: get('at_provided'),
      explanation: get('explanation'),
    };
  }

  for (let li = skipFirstLine ? 1 : 0; li < lines.length; li++) {
    const line = lines[li];
    const cols = line.split('\t');
    // Skip old-format header if present
    if (!colMap && cols[0].toLowerCase() === 'book') continue;
    while (cols.length < 7) cols.push('');

    const row = extractRow(cols);
    if (row.reference.includes(':intro') || row.reference === 'intro') { introRows.push(line); continue; }
    // Validate reference looks like chapter:verse
    if (!/^\d+:\d+/.test(row.reference)) continue;

    items.push({
      index: items.length,
      reference: row.reference,
      sref: row.sref.replace(/^rc:\/\/\*\/ta\/man\/translate\//, ''),
      gl_quote: row.gl_quote, issue_span_gl_quote: normalizeWhitespace(row.gl_quote), scope_mode: 'focused_span',
      needs_at: row.needs_at.toLowerCase() === 'yes' || row.needs_at === '1',
      at_provided: row.at_provided, explanation: row.explanation,
      id: '', orig_quote: '', ult_verse: '', ust_verse: '',
      note_type: '', hebrew_front_words: [], tcm_mode: false,
      chosen_template_id: '', chosen_template_has_at_slot: false,
      template_text: '', template_type: '', template_locked: false, must_include: [],
      clean_explanation: '', at_policy: 'not_needed', at_required: false, at_decision_reason: '',
      template_selector_status: 'fallback_deterministic', template_selector_fallback_reason: 'not_run',
      quote_scope_selector_status: 'fallback_deterministic', quote_scope_selector_fallback_reason: 'not_run',
      selector_status: 'fallback_deterministic', selector_fallback_reason: 'not_run',
      style_rules: [], rule_overrides: [],
      writer_packet: null, prompt: '', system_prompt_key: 'given_at_agent', programmatic_note: '',
      candidate_templates: [],
    });
  }
  function parseVerses(fp) {
    if (!fp) return {};
    const full = path.resolve(CSKILLBP_DIR, fp);
    if (!fs.existsSync(full)) return {};
    const raw = fs.readFileSync(full, 'utf8');
    // Join all lines into one string first so \v matching works on multi-line USFM
    const text = raw.replace(/\n/g, ' ');
    const verses = {};
    let ch = 0;
    // Split on USFM markers, process sequentially
    const tokens = text.split(/(\\c\s+\d+|\\v\s+\d+[-\d]*)/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const cm = t.match(/^\\c\s+(\d+)$/);
      if (cm) { ch = parseInt(cm[1], 10); continue; }
      const vm = t.match(/^\\v\s+(\d+[-\d]*)$/);
      if (vm && i + 1 < tokens.length) {
        let txt = tokens[i + 1] || '';
        txt = txt.replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
          .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
        verses[`${ch}:${vm[1].split('-')[0]}`] = txt;
      }
    }
    return verses;
  }
  const ultV = parseVerses(ultUsfm);
  const ustV = parseVerses(ustUsfm);
  const fnM = path.basename(inputPath).match(/([A-Z0-9]+)-(\d+)/i);
  const bookCode = fnM ? fnM[1].toUpperCase() : '';
  for (const item of items) {
    item.ult_verse = ultV[item.reference] || '';
    item.ust_verse = ustV[item.reference] || '';
    item.book = bookCode;

    // Strip [heb:...] hint from explanation before parsing directives (it's for fillOrigQuotes, not note text)
    const explanationForDirectives = item.explanation.replace(/\s*\[heb:[^\]]*\]/g, '').trim();
    const directives = parseExplanationDirectives(explanationForDirectives);
    const noAtOnly = (ISSUE_STYLE_RULES[item.sref] || []).includes('no_at') && !hasAtOverride(directives.must_include);
    const templateSelection = resolveTemplateSelection({
      sref: item.sref,
      templateHints: directives.template_hints,
      noAtOnly,
      templateMap,
    });
    const styleProfile = deriveStyleProfile({
      sref: item.sref,
      mustInclude: directives.must_include,
      atProvided: item.at_provided,
      needsAt: item.needs_at,
      selectedTemplate: templateSelection.selected_template,
    });
    const quoteScopeSelection = resolveQuoteScopeSelection({
      sref: item.sref,
      glQuote: item.gl_quote,
      ultVerse: item.ult_verse,
    });

    item.clean_explanation = directives.clean_explanation;
    item.must_include = directives.must_include;
    item.template_locked = templateSelection.template_locked;
    item.chosen_template_id = templateSelection.selected_template_id || '';
    item.chosen_template_has_at_slot = !!templateSelection.selected_template_has_at_slot;
    item.template_type = normalizeWhitespace(templateSelection.selected_template?.type || '') || 'generic';
    item.template_text = stripAlternateTranslation(templateSelection.selected_template?.template || '');
    item.candidate_templates = templateSelection.candidate_templates;
    item.at_policy = styleProfile.at_policy;
    item.at_required = !!styleProfile.at_required;
    item.at_decision_reason = styleProfile.at_decision_reason || '';
    item.style_rules = styleProfile.style_rules;
    item.rule_overrides = styleProfile.rule_overrides;
    item.template_selector_status = templateSelection.selector_status || 'fallback_deterministic';
    item.template_selector_fallback_reason = templateSelection.selector_fallback_reason || '';
    item.scope_mode = quoteScopeSelection.scope_mode || 'focused_span';
    item.issue_span_gl_quote = quoteScopeSelection.selected_span || normalizeWhitespace(item.gl_quote);
    item.gl_quote = item.issue_span_gl_quote;
    item.quote_scope_selector_status = quoteScopeSelection.selector_status || 'fallback_deterministic';
    item.quote_scope_selector_fallback_reason = quoteScopeSelection.selector_fallback_reason || '';
    item.selector_status = item.template_selector_status === 'selected' && item.quote_scope_selector_status === 'selected'
      ? 'selected'
      : 'fallback_deterministic';
    item.selector_fallback_reason = [
      item.template_selector_status !== 'selected' ? `template:${item.template_selector_fallback_reason}` : '',
      item.quote_scope_selector_status !== 'selected' ? `quote_scope:${item.quote_scope_selector_fallback_reason}` : '',
    ].filter(Boolean).join(';');

    const explanation = normalizeWhitespace(item.explanation);
    if (/^see how\b/i.test(explanation)) {
      item.note_type = item.at_provided ? 'see_how' : 'see_how_at';
    } else {
      item.note_type = item.at_required ? 'writes_at' : 'given_at';
    }
    item.system_prompt_key = item.at_required ? 'ai_writes_at_agent' : 'given_at_agent';
    item.programmatic_note = maybeBuildProgrammaticNote(item);
    item.writer_packet = buildWriterPacket(item);
    item.prompt = buildWriterPrompt(item);
  }
  const result = { book: fnM ? fnM[1].toUpperCase() : '', chapter: fnM ? fnM[2] : '', source_file: inputTsv, item_count: items.length, items, intro_rows: introRows, alignment_data_path: alignmentJson || '' };
  const outPath = path.resolve(CSKILLBP_DIR, output || '/tmp/claude/prepared_notes.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  // Phase 3a: filter alignment data to target verses + 1-verse margin
  let filterNote = '';
  if (alignmentJson) {
    const alignPath = path.resolve(CSKILLBP_DIR, alignmentJson);
    if (fs.existsSync(alignPath)) {
      const alignData = JSON.parse(fs.readFileSync(alignPath, 'utf8'));
      const targetVerses = new Set(items.map(i => i.reference));
      const expanded = new Set();
      for (const ref of targetVerses) {
        const parts = ref.split(':');
        if (parts.length === 2) {
          const ch = parts[0], vsNum = parseInt(parts[1], 10);
          expanded.add(ref);
          if (vsNum > 1) expanded.add(`${ch}:${vsNum - 1}`);
          expanded.add(`${ch}:${vsNum + 1}`);
        } else {
          expanded.add(ref);
        }
      }
      const before = Object.keys(alignData).length;
      const filtered = {};
      for (const [key, val] of Object.entries(alignData)) {
        if (expanded.has(key)) filtered[key] = val;
      }
      const after = Object.keys(filtered).length;
      fs.writeFileSync(alignPath, JSON.stringify(filtered, null, 2));
      filterNote = `, alignment filtered ${before}→${after} verses`;
    }
  }

  return `Prepared ${items.length} items${filterNote}\n${outPath}`;
}

/**
 * Fix Hebrew quote Unicode to exactly match UHB source byte order.
 *
 * The TN pipeline can reorder combining marks (via NFKD normalization in
 * tsv-quote-converters or LLM tokenization). This tool re-extracts each
 * Hebrew quote from the UHB source so the bytes match exactly.
 */
function fixUnicodeQuotes({ tsvFile, hebrewUsfm, output }) {
  // --- Resolve Hebrew USFM path ---
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const tsvContent = fs.readFileSync(tsvPath, 'utf8');
  const bookMatch = path.basename(tsvFile).match(/([A-Z0-9]{3})/i);
  const bookCode = bookMatch ? bookMatch[1].toUpperCase() : '';

  let hebrewPath;
  if (hebrewUsfm) {
    hebrewPath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  } else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toUpperCase().includes(bookCode) && f.endsWith('.usfm')) : [];
    if (!files.length) return `ERROR: No Hebrew USFM found for ${bookCode}`;
    hebrewPath = path.join(dir, files[0]);
  }
  const hebrewContent = fs.readFileSync(hebrewPath, 'utf8');

  // Marks to strip from source to build "reduced source" (matching what TN quotes contain)
  const STRIP_RE = /[\u0591-\u05AF\u2060\u05BD\u05C3]/g;

  // --- Build verse map from Hebrew USFM ---
  // Verse text may span multiple lines: \v on its own line, \w tokens on following lines.
  // Preserves inter-word connectors like maqqeph.
  const verseMap = {};  // { "ch:vs": rawText }
  let ch = 0, curVerse = null, curLines = [];

  function extractVerseText(lines) {
    const text = lines.join(' ');
    const parts = [];
    let lastEnd = 0;
    const WRE = /\\w\s+([^|]+)\|[^\\]*?\\w\*/g;
    let m;
    while ((m = WRE.exec(text)) !== null) {
      const between = text.slice(lastEnd, m.index);
      if (parts.length && between.includes('\u05BE')) parts.push('\u05BE');
      else if (parts.length) parts.push(' ');
      parts.push(m[1].trim());
      lastEnd = m.index + m[0].length;
    }
    return parts.join('');
  }

  for (const line of hebrewContent.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      ch = parseInt(cm[1], 10); curVerse = null; curLines = [];
      continue;
    }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)/);
    if (vm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      const vs = vm[1].split('-')[0];
      curVerse = `${ch}:${vs}`; curLines = [];
    }
    if (curVerse && trimmed) curLines.push(trimmed);
  }
  if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);

  // --- Build stripped version + offset map back to raw ---
  // We strip marks from BOTH the quote and the raw verse for fuzzy matching,
  // then map the match back to the FULL raw verse (preserving all marks).
  function buildStripped(raw) {
    const stripped = [];
    const offsetMap = [];  // offsetMap[i] = index in raw for stripped[i]
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!STRIP_RE.test(c)) {
        stripped.push(c);
        offsetMap.push(i);
      }
      STRIP_RE.lastIndex = 0;  // reset stateful regex
    }
    return { text: stripped.join(''), offsetMap };
  }

  // Given a match span [rStart, rEnd] in stripped text, return the
  // corresponding full span from raw (including all marks).
  function rawSpan(raw, offsetMap, rStart, rEnd, strippedLen) {
    const rawStart = offsetMap[rStart];
    // For the end: find the start of the NEXT stripped char, or end of raw
    const rawEndExcl = (rEnd + 1 < strippedLen) ? offsetMap[rEnd + 1] : raw.length;
    // Trim trailing spaces/sof-pasuq from the span
    let end = rawEndExcl;
    while (end > rawStart && (raw[end - 1] === ' ' || raw[end - 1] === '\u05C3')) end--;
    return raw.slice(rawStart, end);
  }

  // --- Fix each TSV row ---
  const lines = tsvContent.split('\n');
  const header = lines[0];
  const cols0 = header.split('\t');
  const quoteIdx = cols0.indexOf('Quote');
  const refIdx = cols0.indexOf('Reference');
  if (quoteIdx === -1 || refIdx === -1) return 'ERROR: TSV missing Quote or Reference column';

  let fixed = 0, skipped = 0, notFound = 0;
  const warnings = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split('\t');
    if (cols.length <= quoteIdx) continue;
    const quote = cols[quoteIdx];
    if (!quote || !/[\u0590-\u05FF]/.test(quote)) continue;  // skip non-Hebrew

    const ref = cols[refIdx];
    const chVs = ref.includes(':') ? ref : null;
    if (!chVs) continue;

    const rawVerse = verseMap[chVs];
    if (!rawVerse) { skipped++; continue; }

    // Handle discontinuous quotes (separated by &)
    const segments = quote.split(/\s*&\s*/);
    const fixedSegments = [];
    let allMatched = true;

    for (const seg of segments) {
      const { text: strippedVerse, offsetMap } = buildStripped(rawVerse);
      // Strip the quote too (it may or may not have marks)
      const strippedQuote = seg.replace(STRIP_RE, () => { STRIP_RE.lastIndex = 0; return ''; });
      STRIP_RE.lastIndex = 0;

      // Normalize both for matching (handles combining mark reordering)
      const normQuote = strippedQuote.normalize('NFKD');
      const normStripped = strippedVerse.normalize('NFKD');

      // Build map: normStripped index -> strippedVerse index
      const nrMap = [];
      let si = 0;
      for (let ni = 0; ni < normStripped.length; ni++) {
        if (si < strippedVerse.length) {
          nrMap.push(si);
          const charNorm = strippedVerse[si].normalize('NFKD');
          if (charNorm.length > 1) {
            for (let k = 1; k < charNorm.length && ni + k < normStripped.length; k++) {
              nrMap.push(si);
            }
            ni += charNorm.length - 1;
          }
          si++;
        }
      }

      const pos = normStripped.indexOf(normQuote);
      if (pos === -1) {
        allMatched = false;
        warnings.push(`${ref}: quote segment not found: "${seg.slice(0, 30)}..."`);
        fixedSegments.push(seg);  // keep original
        continue;
      }

      // Map: normStripped pos -> strippedVerse pos -> raw pos
      const sStart = (pos < nrMap.length) ? nrMap[pos] : 0;
      const endNorm = pos + normQuote.length - 1;
      const sEnd = (endNorm < nrMap.length) ? nrMap[endNorm] : strippedVerse.length - 1;

      // Extract the FULL raw span (with all marks) from the original verse
      const fixedSeg = rawSpan(rawVerse, offsetMap, sStart, sEnd, strippedVerse.length);
      fixedSegments.push(fixedSeg);
    }

    const fixedQuote = fixedSegments.join(' & ');
    if (fixedQuote !== quote) {
      cols[quoteIdx] = fixedQuote;
      lines[i] = cols.join('\t');
      fixed++;
    }
    if (!allMatched) notFound++;
  }

  // --- Write output ---
  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : tsvPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  const result = [`Fixed ${fixed} Hebrew quotes in ${path.basename(tsvFile)}`];
  if (skipped) result.push(`Skipped ${skipped} (verse not in Hebrew source)`);
  if (notFound) result.push(`${notFound} quotes had unmatched segments`);
  if (warnings.length) result.push('Warnings:\n  ' + warnings.slice(0, 10).join('\n  '));
  result.push(outPath);
  return result.join('\n');
}

/**
 * Verify bold text in notes matches ULT verse exactly.
 * Strips bold markers from any **word** that doesn't appear as-is in the ULT.
 * Operates on assembled TSV (post-assembly, alongside curly_quotes / fix_unicode).
 */
function verifyBoldMatches({ tsvFile, ultUsfm, output }) {
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const tsvContent = fs.readFileSync(tsvPath, 'utf8');

  // Parse ULT verses
  const ultVerses = {};
  if (ultUsfm) {
    const ultPath = path.resolve(CSKILLBP_DIR, ultUsfm);
    if (fs.existsSync(ultPath)) {
      const text = fs.readFileSync(ultPath, 'utf8');
      let ch = 0;
      for (const l of text.split('\n')) {
        const cm = l.trim().match(/^\\c\s+(\d+)/);
        if (cm) { ch = parseInt(cm[1], 10); continue; }
        const vm = l.trim().match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
        if (vm) {
          let txt = vm[2] || '';
          txt = txt.replace(/\\zaln-[se][^*]*\*/g, '').replace(/\\w\s+([^|]*?)\|[^\\]*?\\w\*/g, '$1')
            .replace(/\\[a-z]+\d?\s+/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
          ultVerses[`${ch}:${vm[1].split('-')[0]}`] = txt;
        }
      }
    }
  }

  const lines = tsvContent.split('\n');
  const header = lines[0];
  const cols0 = header.split('\t');
  const noteIdx = cols0.indexOf('Note');
  const refIdx = cols0.indexOf('Reference');
  if (noteIdx === -1 || refIdx === -1) return 'ERROR: TSV missing Note or Reference column';

  let stripped = 0;
  const log = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split('\t');
    if (cols.length <= noteIdx) continue;

    const ref = cols[refIdx];
    const ult = ultVerses[ref] || '';
    if (!ult) continue;

    let note = cols[noteIdx];
    let changed = false;

    note = note.replace(/\*\*([^*]+)\*\*/g, (match, boldText) => {
      if (ult.includes(boldText)) return match; // exact match, keep bold
      stripped++;
      changed = true;
      log.push(`${ref}: stripped bold from "${boldText}"`);
      return boldText; // remove ** markers
    });

    if (changed) {
      cols[noteIdx] = note;
      lines[i] = cols.join('\t');
    }
  }

  const outPath = output ? path.resolve(CSKILLBP_DIR, output) : tsvPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  const result = [`Bold check: stripped ${stripped} non-matching bold(s) in ${path.basename(tsvFile)}`];
  if (log.length) result.push(log.join('\n'));
  result.push(outPath);
  return result.join('\n');
}

/**
 * Fill empty orig_quote fields in prepared_notes.json using alignment data.
 * Deterministically matches English gl_quote words to Hebrew via alignment,
 * then extracts the exact Hebrew span from UHB source (character-for-character).
 * Falls back gracefully for items that can't be resolved.
 */
function fillOrigQuotes({ preparedJson, alignmentJson, hebrewUsfm, masterUltUsfm }) {
  const prepPath = path.resolve(CSKILLBP_DIR, preparedJson);
  const data = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  const alignData = JSON.parse(fs.readFileSync(path.resolve(CSKILLBP_DIR, alignmentJson), 'utf8'));

  const bookCode = (data.book || '').toUpperCase();
  let hebrewPath;
  if (hebrewUsfm) {
    hebrewPath = path.resolve(CSKILLBP_DIR, hebrewUsfm);
  } else {
    const dir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toUpperCase().includes(bookCode) && f.endsWith('.usfm')) : [];
    if (!files.length) return `ERROR: No Hebrew USFM found for ${bookCode}`;
    hebrewPath = path.join(dir, files[0]);
  }
  const hebrewContent = fs.readFileSync(hebrewPath, 'utf8');

  const STRIP_RE = /[\u0591-\u05AF\u2060\u05BD\u05C3]/g;
  const PUNC = /[{},;:.!?'""\u2018\u2019\u201C\u201D\u2014\u2013()]/g;
  const STOP_WORDS = new Set(['a','an','the','of','in','on','at','to','for','by','as','and','or','but','not','with','from']);

  function stripForSearch(s) {
    return s.replace(/[\u0591-\u05AF\u2060\u05BD\u05C3]/g, '');
  }

  // Build verse map (same logic as fixUnicodeQuotes)
  const verseMap = {};
  let hebCh = 0, curVerse = null, curLines = [];

  function extractVerseText(lines) {
    const text = lines.join(' ');
    const parts = [];
    let lastEnd = 0;
    const WRE = /\\w\s+([^|]+)\|[^\\]*?\\w\*/g;
    let m;
    while ((m = WRE.exec(text)) !== null) {
      const between = text.slice(lastEnd, m.index);
      if (parts.length && between.includes('\u05BE')) parts.push('\u05BE');
      else if (parts.length) parts.push(' ');
      parts.push(m[1].trim());
      lastEnd = m.index + m[0].length;
    }
    return parts.join('');
  }

  for (const line of hebrewContent.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      hebCh = parseInt(cm[1], 10); curVerse = null; curLines = [];
      continue;
    }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)/);
    if (vm) {
      if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);
      curVerse = `${hebCh}:${vm[1].split('-')[0]}`; curLines = [];
    }
    if (curVerse && trimmed) curLines.push(trimmed);
  }
  if (curVerse && curLines.length) verseMap[curVerse] = extractVerseText(curLines);

  function buildStripped(raw) {
    const stripped = [];
    const offsetMap = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!STRIP_RE.test(c)) { stripped.push(c); offsetMap.push(i); }
      STRIP_RE.lastIndex = 0;
    }
    return { text: stripped.join(''), offsetMap };
  }

  function rawSpan(raw, offsetMap, rStart, rEnd, strippedLen) {
    const rawStart = offsetMap[rStart];
    const rawEndExcl = (rEnd + 1 < strippedLen) ? offsetMap[rEnd + 1] : raw.length;
    let end = rawEndExcl;
    while (end > rawStart && (raw[end - 1] === ' ' || raw[end - 1] === '\u05C3')) end--;
    return raw.slice(rawStart, end);
  }

  function extractHebrewSpan(ref, hebWords) {
    const rawVerse = verseMap[ref];
    if (!rawVerse) return null;
    const { text: strippedVerse, offsetMap } = buildStripped(rawVerse);
    const normVerse = strippedVerse.normalize('NFKD');

    const positions = [];
    for (const hw of hebWords) {
      const strippedHw = stripForSearch(hw);
      const normHw = strippedHw.normalize('NFKD');
      if (!normHw) continue;
      const normPos = normVerse.indexOf(normHw);
      if (normPos < 0) continue; // skip unlocatable words rather than failing entirely
      // Map norm position back to strippedVerse position
      let si = 0, ni = 0;
      while (ni < normPos && si < strippedVerse.length) {
        ni += strippedVerse[si].normalize('NFKD').length;
        si++;
      }
      positions.push({ start: si, end: si + strippedHw.length - 1 });
    }

    if (!positions.length) return null;
    const minStart = Math.min(...positions.map(p => p.start));
    const maxEnd = Math.max(...positions.map(p => p.end));
    return rawSpan(rawVerse, offsetMap, minStart, maxEnd, strippedVerse.length);
  }

  // Extract [heb:...] hint from explanation and try direct UHB match
  function extractHebrewHint(explanation) {
    const m = String(explanation || '').match(/\[heb:([^\]]+)\]/);
    return m ? m[1].trim() : null;
  }

  function tryHebrewHintMatch(ref, hint) {
    const rawVerse = verseMap[ref];
    if (!rawVerse || !hint) return null;
    const { text: strippedVerse, offsetMap } = buildStripped(rawVerse);
    // Strip cantillation from the hint too
    const strippedHint = hint.replace(STRIP_RE, () => { STRIP_RE.lastIndex = 0; return ''; });
    STRIP_RE.lastIndex = 0;
    const normHint = strippedHint.normalize('NFKD');
    const normVerse = strippedVerse.normalize('NFKD');
    const pos = normVerse.indexOf(normHint);
    if (pos < 0) return null;
    // Map norm position back to strippedVerse position
    let si = 0, ni = 0;
    while (ni < pos && si < strippedVerse.length) {
      ni += strippedVerse[si].normalize('NFKD').length;
      si++;
    }
    const startPos = si;
    const endPos = startPos + strippedHint.length - 1;
    if (endPos >= strippedVerse.length) return null;
    return rawSpan(rawVerse, offsetMap, startPos, endPos, strippedVerse.length);
  }

  // --- Shared resolution: &-split + two-pass (exact then content-word) ---
  function resolveWithAlignment(glQuote, entries) {
    const cleanGlq = glQuote.replace(/\{[^}]*\}/g, '').trim();
    if (!cleanGlq) return null;
    const segments = cleanGlq.split(/\s*&\s*/);

    const usedIndices = new Set();
    const allHeb = [];

    for (const seg of segments) {
      const words = seg.trim().split(/\s+/).filter(Boolean)
        .map(t => t.replace(PUNC, '').toLowerCase()).filter(Boolean);
      if (!words.length) continue;

      // Pass 1: exact match (all words)
      const pass1Used = new Set();
      const pass1Heb = [];
      let pass1All = true;
      for (const w of words) {
        let found = false;
        for (let i = 0; i < entries.length; i++) {
          if (usedIndices.has(i) || pass1Used.has(i)) continue;
          const engNorm = (entries[i].eng || '').replace(PUNC, '').toLowerCase();
          if (engNorm === w) {
            pass1Used.add(i);
            if (entries[i].heb) pass1Heb.push(entries[i].heb);
            found = true;
            break;
          }
        }
        if (!found) { pass1All = false; }
      }

      if (pass1All && pass1Heb.length) {
        for (const idx of pass1Used) usedIndices.add(idx);
        allHeb.push(...pass1Heb);
        continue;
      }

      // Pass 2: content-words-only (skip stop words), require >= 50% match
      const contentWords = words.filter(w => !STOP_WORDS.has(w));
      const wordsToTry = contentWords.length ? contentWords : words;
      const pass2Used = new Set();
      const pass2Heb = [];
      let matched = 0;
      for (const w of wordsToTry) {
        for (let i = 0; i < entries.length; i++) {
          if (usedIndices.has(i) || pass2Used.has(i)) continue;
          const engNorm = (entries[i].eng || '').replace(PUNC, '').toLowerCase();
          if (engNorm === w) {
            pass2Used.add(i);
            if (entries[i].heb) pass2Heb.push(entries[i].heb);
            matched++;
            break;
          }
        }
      }
      if (matched < Math.ceil(wordsToTry.length / 2) || !pass2Heb.length) return null;
      for (const idx of pass2Used) usedIndices.add(idx);
      allHeb.push(...pass2Heb);
    }

    return allHeb.length ? allHeb : null;
  }

  // --- Parse master ULT \zaln-s alignment markers into per-verse entries ---
  function parseMasterUltAlignments(usfmContent) {
    const alignByVerse = {};
    let chapter = 0, verse = 0;
    const stack = [];
    const COMBINED_RE = /\\zaln-s\s+\|([^\\]*?)\\?\*|\\zaln-e\\?\*|\\w\s+([^|]*?)\|[^\\]*?\\w\*/g;

    for (const line of usfmContent.split('\n')) {
      const trimmed = line.trim();
      const cm = trimmed.match(/\\c\s+(\d+)/);
      if (cm) { chapter = parseInt(cm[1], 10); verse = 0; }
      const vm = trimmed.match(/\\v\s+(\d+)/);
      if (vm) { verse = parseInt(vm[1], 10); }
      if (!verse) continue;
      let m;
      COMBINED_RE.lastIndex = 0;
      while ((m = COMBINED_RE.exec(trimmed)) !== null) {
        if (m[1] !== undefined) {
          const attrs = m[1];
          const contentM = attrs.match(/x-content="([^"]*)"/);
          stack.push({ heb: contentM ? contentM[1] : '' });
        } else if (m[0].startsWith('\\zaln-e')) {
          stack.pop();
        } else if (m[2] !== undefined) {
          const word = m[2].trim();
          if (stack.length > 0 && stack[stack.length - 1].heb) {
            const key = `${chapter}:${verse}`;
            if (!alignByVerse[key]) alignByVerse[key] = [];
            alignByVerse[key].push({ eng: word, heb: stack[stack.length - 1].heb });
          }
        }
      }
    }
    return alignByVerse;
  }

  // Lazy-load master ULT alignments (from Door43 human-edited ULT with \zaln-s markers)
  let masterAlignData = null; // loaded on first need
  function loadMasterUltAlignments(book, explicitPath) {
    if (explicitPath) {
      const p = path.resolve(CSKILLBP_DIR, explicitPath);
      if (fs.existsSync(p)) return parseMasterUltAlignments(fs.readFileSync(p, 'utf8'));
    }
    // Auto-detect from door43-repos/en_ult/
    const d43Dir = path.join(CSKILLBP_DIR, 'door43-repos/en_ult');
    if (fs.existsSync(d43Dir)) {
      const files = fs.readdirSync(d43Dir).filter(f => f.toUpperCase().includes(book) && f.endsWith('.usfm'));
      if (files.length) return parseMasterUltAlignments(fs.readFileSync(path.join(d43Dir, files[0]), 'utf8'));
    }
    return null;
  }

  let resolved = 0;
  let resolvedViaHint = 0;
  let resolvedViaMaster = 0;
  const unresolved = [];

  for (const item of (data.items || [])) {
    if (item.orig_quote) continue;
    const scopedGlQuote = item.issue_span_gl_quote || item.gl_quote || '';
    if (!scopedGlQuote) continue;
    if (item.reference && item.reference.endsWith(':front')) continue;

    // Strip any non-verse suffix from reference (e.g., "36:1:writing-oracleformula" → "36:1")
    const alignRef = item.reference.replace(/:(?!\d).*$/, '');

    // Try Hebrew hint path first (more reliable when available)
    const hebrewHint = extractHebrewHint(item.explanation);
    if (hebrewHint) {
      const hintSpan = tryHebrewHintMatch(alignRef, hebrewHint);
      if (hintSpan) {
        item.orig_quote = hintSpan;
        resolved++;
        resolvedViaHint++;
        continue;
      }
      // Hint didn't match — fall through to alignment path
    }

    const entries = alignData[alignRef] || alignData[item.reference] || [];

    // Step 2: AI alignment + &-split + content-word fallback
    let hebWords = entries.length ? resolveWithAlignment(scopedGlQuote, entries) : null;
    let span = hebWords ? extractHebrewSpan(alignRef, hebWords) : null;

    if (span) {
      item.orig_quote = span;
      resolved++;
      continue;
    }

    // Step 3: Master ULT alignment fallback
    if (!masterAlignData) {
      masterAlignData = loadMasterUltAlignments(bookCode, masterUltUsfm);
    }
    if (masterAlignData) {
      const masterEntries = masterAlignData[alignRef] || [];
      if (masterEntries.length) {
        hebWords = resolveWithAlignment(scopedGlQuote, masterEntries);
        span = hebWords ? extractHebrewSpan(alignRef, hebWords) : null;
        if (span) {
          item.orig_quote = span;
          resolved++;
          resolvedViaMaster++;
          continue;
        }
      }
    }

    // Step 4: Unresolved
    const cleanGlq = scopedGlQuote.replace(/\{[^}]*\}/g, '').trim();
    unresolved.push(`${item.id} ${alignRef}: "${cleanGlq.slice(0, 40)}" — no alignment match`);
  }

  fs.writeFileSync(prepPath, JSON.stringify(data, null, 2));

  const hintNote = resolvedViaHint ? `, ${resolvedViaHint} via Hebrew hint` : '';
  const masterNote = resolvedViaMaster ? `, ${resolvedViaMaster} via master ULT` : '';
  const lines = [`Resolved: ${resolved} of ${resolved + unresolved.length} items (${resolved - resolvedViaHint - resolvedViaMaster} via AI alignment${hintNote}${masterNote}). Unresolved: ${unresolved.length} items:`];
  for (const u of unresolved) lines.push(`  ${u}`);
  return lines.join('\n');
}

/**
 * Fill empty ID columns in an assembled TN TSV with unique generated IDs.
 * Used after merging parallel shard TSVs that were assembled without IDs.
 */
async function fillTsvIds({ tsvFile, book }) {
  const tsvPath = path.resolve(CSKILLBP_DIR, tsvFile);
  const content = fs.readFileSync(tsvPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length < 2) return 'No data rows to fill';

  // Count rows needing IDs (non-header, non-empty, empty ID column)
  const header = lines[0];
  const dataLines = [];
  const needsId = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    dataLines.push(i);
    const cols = lines[i].split('\t');
    if (cols.length >= 2 && !cols[1].trim()) needsId.push(i);
  }

  if (needsId.length === 0) return `All ${dataLines.length} rows already have IDs`;

  // Generate unique IDs
  const bookCode = (book || '').toUpperCase() || path.basename(tsvFile).match(/([A-Z]{3})/i)?.[1] || 'UNK';
  const idStr = await generateIds({ book: bookCode, count: needsId.length });
  const ids = idStr.split('\n').filter(Boolean);

  // Fill IDs into the lines
  for (let j = 0; j < needsId.length; j++) {
    const lineIdx = needsId[j];
    const cols = lines[lineIdx].split('\t');
    cols[1] = ids[j] || cols[1];
    lines[lineIdx] = cols.join('\t');
  }

  // Write atomically
  const tmpFile = tsvPath + '.tmp';
  fs.writeFileSync(tmpFile, lines.join('\n'));
  fs.renameSync(tmpFile, tsvPath);
  return `Filled ${needsId.length} IDs in ${tsvFile}`;
}

/**
 * Combo tool: runs prepare → extract alignment → resolve gl_quotes → flag narrow → verify AT fit
 * in a single call. Returns a summary string instead of 5 separate tool results.
 */
function prepareAndValidate({ inputTsv, ultUsfm, ustUsfm, alignedUsfm, output }) {
  const prepOutput = output || '/tmp/claude/prepared_notes.json';
  const alignOutput = '/tmp/claude/alignment_data.json';
  const lines = [];

  // 1. Prepare notes
  const prepResult = prepareNotes({ inputTsv, ultUsfm, ustUsfm, output: prepOutput, alignedUsfm, alignmentJson: alignOutput });
  lines.push(prepResult);

  // 2. Extract alignment data (only if aligned USFM exists)
  if (alignedUsfm) {
    const alignPath = path.resolve(CSKILLBP_DIR, alignedUsfm);
    if (fs.existsSync(alignPath)) {
      const alignResult = extractAlignmentData({ alignedUsfm, output: alignOutput });
      lines.push(alignResult);

      // 3. Resolve gl_quotes
      const resolveResult = resolveGlQuotes({ preparedJson: prepOutput, alignmentJson: alignOutput });
      lines.push(resolveResult);
    } else {
      lines.push(`Aligned USFM not found: ${alignedUsfm} — skipping alignment/gl_quote resolution`);
    }
  } else {
    lines.push('No aligned USFM provided — skipping alignment/gl_quote resolution');
  }

  // 4. Flag narrow quotes
  const flagResult = flagNarrowQuotes({ preparedJson: prepOutput });
  lines.push(flagResult);

  // 5. Verify AT fit (needs generated JSON — skip if not yet available)
  const genJsonPath = '/tmp/claude/generated_notes.json';
  if (fs.existsSync(path.resolve(CSKILLBP_DIR, genJsonPath))) {
    const verifyResult = verifyAtFit({ preparedJson: prepOutput, generatedJson: genJsonPath });
    lines.push(verifyResult);
  } else {
    lines.push('Generated notes not yet available — skipping AT fit verification (run after note generation)');
  }

  return lines.join('\n\n');
}

// --- AT Generation Support ---

/**
 * Substitute an AT into a verse by replacing the gl_quote span.
 * Returns the modified verse string, or null if gl_quote not found.
 *
 * Handles discontinuous quotes (contains \u2026 or "...").
 */
function substituteAT(verse, glQuote, atText) {
  if (!verse || !glQuote || !atText) return null;

  // Handle discontinuous quotes: "first part … second part"
  const ellipsis = '\u2026';
  if (glQuote.includes(ellipsis) || glQuote.includes('...')) {
    const separator = glQuote.includes(ellipsis) ? ellipsis : '...';
    const parts = glQuote.split(separator).map(p => p.trim());
    const atParts = atText.includes(ellipsis)
      ? atText.split(ellipsis).map(p => p.trim())
      : atText.includes('...')
        ? atText.split('...').map(p => p.trim())
        : [atText]; // AT has no separator — replace first part only

    let result = verse;
    for (let i = 0; i < parts.length; i++) {
      const replacement = atParts[i] || atParts[atParts.length - 1] || '';
      const idx = result.indexOf(parts[i]);
      if (idx === -1) return null; // part not found
      result = result.slice(0, idx) + replacement + result.slice(idx + parts[i].length);
    }
    return result;
  }

  // Simple contiguous quote
  const idx = verse.indexOf(glQuote);
  if (idx === -1) {
    // Try case-insensitive match
    const lowerIdx = verse.toLowerCase().indexOf(glQuote.toLowerCase());
    if (lowerIdx === -1) return null;
    return verse.slice(0, lowerIdx) + atText + verse.slice(lowerIdx + glQuote.length);
  }
  return verse.slice(0, idx) + atText + verse.slice(idx + glQuote.length);
}

/**
 * Build AT writer context packets for items that need AT generation.
 * Reads prepared_notes.json, returns an array of context packets per item.
 *
 * @param {object} args
 * @param {string} args.preparedJson - Path to prepared_notes.json (relative to workspace)
 * @param {string} [args.generatedJson] - Path to generated_notes.json (relative to workspace)
 * @param {string} [args.output] - Output path for AT context JSON (relative to workspace)
 * @returns {string} Summary or JSON content
 */
function prepareATContext({ preparedJson, generatedJson, output }) {
  const prepPath = path.resolve(CSKILLBP_DIR, preparedJson);
  const prepared = JSON.parse(fs.readFileSync(prepPath, 'utf8'));

  let generatedNotes = {};
  if (generatedJson) {
    const genPath = path.resolve(CSKILLBP_DIR, generatedJson);
    if (fs.existsSync(genPath)) {
      generatedNotes = JSON.parse(fs.readFileSync(genPath, 'utf8'));
    }
  }

  // Build verse lookup for context window (prev + current + next)
  const ultVerses = {};
  const ustVerses = {};
  for (const item of (prepared.items || [])) {
    if (item.ult_verse) ultVerses[item.reference] = item.ult_verse;
    if (item.ust_verse) ustVerses[item.reference] = item.ust_verse;
  }

  // Helper to get adjacent verse text
  function getVerseContext(ref) {
    const [ch, vs] = ref.split(':').map(Number);
    if (isNaN(ch) || isNaN(vs)) return { prev: '', current: ultVerses[ref] || '', next: '' };
    return {
      prev: ultVerses[`${ch}:${vs - 1}`] || '',
      current: ultVerses[ref] || '',
      next: ultVerses[`${ch}:${vs + 1}`] || '',
    };
  }

  const packets = [];
  for (const item of (prepared.items || [])) {
    if (!resolveAtRequirement(item).at_required) continue;
    if (item.programmatic_note) continue; // "see how" notes already have ATs

    const noteText = generatedNotes[item.id] || '';
    const verseCtx = getVerseContext(item.reference);
    const scopedQuote = item.issue_span_gl_quote || item.gl_quote || '';

    packets.push({
      id: item.id,
      reference: item.reference,
      issue_type: item.sref,
      quote_scope_mode: item.scope_mode || 'focused_span',
      exact_ult_span: scopedQuote,
      full_verse: verseCtx.current,
      verse_context: {
        prev: verseCtx.prev,
        current: verseCtx.current,
        next: verseCtx.next,
      },
      note_text: noteText,
      ust_verse: item.ust_verse || '',
      is_discontinuous: scopedQuote.includes('\u2026') || scopedQuote.includes('...') || scopedQuote.includes(' & '),
      template_type: item.template_type || '',
    });
  }

  const result = { book: prepared.book, chapter: prepared.chapter, item_count: packets.length, packets };
  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    return `Prepared ${packets.length} AT context packets to ${outPath}`;
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Read a slice of prepared_notes.json items without hitting the SDK's 10K-token
 * Read-tool limit. Always use this instead of reading the raw file directly.
 *
 * @param {object} args
 * @param {string} args.preparedJson  - path relative to workspace
 * @param {number} [args.start=0]     - first item index (0-based, inclusive)
 * @param {number} [args.end]         - last item index (inclusive). Default: start+19
 * @param {boolean} [args.summaryOnly] - return only counts + IDs, no item bodies
 */
function readPreparedNotes({ preparedJson, start = 0, end, summaryOnly = false }) {
  const fullPath = path.resolve(CSKILLBP_DIR, preparedJson);
  const items = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const total = items.length;

  if (summaryOnly) {
    const ids = items.map((it) => it.id || it.reference || '(no-id)');
    return JSON.stringify({ total, ids });
  }

  const resolvedEnd = end !== undefined ? Math.min(end, total - 1) : Math.min(start + 19, total - 1);
  const slice = items.slice(start, resolvedEnd + 1);
  return JSON.stringify({
    total,
    start,
    end: resolvedEnd,
    hasMore: resolvedEnd < total - 1,
    items: slice,
  });
}

module.exports = {
  extractAlignmentData,
  fixHebrewQuotes,
  flagNarrowQuotes,
  generateIds,
  resolveGlQuotes,
  verifyAtFit,
  assembleNotes,
  prepareNotes,
  prepareAndValidate,
  fixUnicodeQuotes,
  verifyBoldMatches,
  fillTsvIds,
  fillOrigQuotes,
  loadTemplateMap,
  prepareATContext,
  readPreparedNotes,
  substituteAT,
  resolveAtRequirement,
  _parseExplanationDirectives: parseExplanationDirectives,
  _resolveTemplateSelection: resolveTemplateSelection,
  _deriveStyleProfile: deriveStyleProfile,
  _deriveAtRequirement: deriveAtRequirement,
  _resolveQuoteScopeSelection: resolveQuoteScopeSelection,
  _detectIssueScopeMode: detectIssueScopeMode,
  _buildWriterPacket: buildWriterPacket,
  _buildWriterPrompt: buildWriterPrompt,
  _maybeBuildProgrammaticNote: maybeBuildProgrammaticNote,
  _normalizeAssembledNoteText: normalizeAssembledNoteText,
  _stripAlternateTranslation: stripAlternateTranslation,
};
