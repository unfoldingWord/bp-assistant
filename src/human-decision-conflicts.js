'use strict';

const fs = require('fs');
const path = require('path');

const QUICK_REF_FILES = [
  ['ult_decisions', 'data/quick-ref/ult_decisions.csv'],
  ['ust_decisions', 'data/quick-ref/ust_decisions.csv'],
];

const BOOK_ALIASES = {
  GEN: ['gen', 'genesis'],
  EXO: ['exo', 'exodus'],
  LEV: ['lev', 'leviticus'],
  NUM: ['num', 'numbers'],
  DEU: ['deu', 'deut', 'deuteronomy'],
  JOS: ['jos', 'joshua'],
  JDG: ['jdg', 'judges'],
  RUT: ['rut', 'ruth'],
  '1SA': ['1sa', '1 samuel', '1samuel'],
  '2SA': ['2sa', '2 samuel', '2samuel'],
  '1KI': ['1ki', '1 kings', '1kings'],
  '2KI': ['2ki', '2 kings', '2kings'],
  PSA: ['psa', 'psalm', 'psalms'],
  ISA: ['isa', 'isaiah'],
  JER: ['jer', 'jeremiah'],
  LAM: ['lam', 'lamentations'],
  EZK: ['ezk', 'ezekiel'],
  DAN: ['dan', 'daniel'],
  HOS: ['hos', 'hosea'],
  JOL: ['jol', 'joel'],
  AMO: ['amo', 'amos'],
  OBA: ['oba', 'obadiah'],
  JON: ['jon', 'jonah'],
  MIC: ['mic', 'micah'],
  NAM: ['nam', 'nahum'],
  HAB: ['hab', 'habakkuk'],
  ZEP: ['zep', 'zephaniah'],
  HAG: ['hag', 'haggai'],
  ZEC: ['zec', 'zechariah'],
  MAL: ['mal', 'malachi'],
};

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSkillsRoot(explicitRoot) {
  if (explicitRoot) return explicitRoot;
  const candidates = [
    process.env.CSKILLBP_DIR,
    path.resolve(__dirname, '../../bp-assistant-skills'),
    path.resolve(__dirname, '../../cSkillBP'),
    '/srv/bot/workspace',
    '/workspace',
  ].filter(Boolean);

  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'data', 'quick-ref'))
  ) || candidates[0];
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < String(content || '').length; index++) {
    const ch = content[index];
    const next = content[index + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows.filter((items) => items.some((item) => String(item || '').trim()));
}

function rowToObject(headers, row) {
  const obj = {};
  for (let index = 0; index < headers.length; index++) {
    obj[headers[index]] = row[index] || '';
  }
  return obj;
}

function extractAttribution(notes) {
  const text = String(notes || '');
  const match = text.match(/\b(?:Editor|Reported|Reporter|Submitted by):\s*([^.;()]+?)(?:\s*\(|[.;]|$)/i);
  return match ? match[1].trim() : null;
}

function loadQuickRefDecisions(skillsRoot) {
  const decisions = [];
  for (const [resource, relPath] of QUICK_REF_FILES) {
    const absPath = path.join(skillsRoot, relPath);
    if (!fs.existsSync(absPath)) continue;
    const rows = parseCsv(fs.readFileSync(absPath, 'utf8'));
    if (rows.length < 2) continue;
    const headers = rows[0].map((header) => header.trim());
    for (const row of rows.slice(1)) {
      const obj = rowToObject(headers, row);
      if (normalizeText(obj.Source) !== 'human') continue;
      decisions.push({
        type: 'quick-ref',
        resource,
        sourcePath: relPath,
        strong: String(obj.Strong || '').trim(),
        hebrew: String(obj.Hebrew || '').trim(),
        rendering: String(obj.Rendering || '').trim(),
        book: String(obj.Book || '').trim().toUpperCase() || 'ALL',
        context: String(obj.Context || '').trim(),
        notes: String(obj.Notes || '').trim(),
        date: String(obj.Date || '').trim() || null,
        source: String(obj.Source || '').trim(),
        submittedBy: extractAttribution(obj.Notes),
        rawText: row.join(','),
      });
    }
  }
  return decisions;
}

function splitMarkdownRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells;
}

function loadGlossaryDecisions(skillsRoot) {
  const relPath = 'data/glossary/project_glossary.md';
  const absPath = path.join(skillsRoot, relPath);
  if (!fs.existsSync(absPath)) return [];

  const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
  let headers = null;
  const decisions = [];
  for (const line of lines) {
    const cells = splitMarkdownRow(line);
    if (!cells) continue;
    if (!headers) {
      headers = cells.map((cell) => normalizeText(cell));
      continue;
    }
    if (cells.length < 3) continue;
    const get = (names) => {
      const index = headers.findIndex((header) => names.includes(header));
      return index >= 0 ? cells[index] || '' : '';
    };
    const hebrew = get(['hebrew', 'term']);
    const strong = get(['strong', "strong's", 'strongs']);
    const ult = get(['ult', 'ult rendering']);
    const ust = get(['ust', 'ust rendering']);
    const notes = get(['notes', 'note']);
    if (!hebrew && !strong && !ult && !ust && !notes) continue;
    decisions.push({
      type: 'glossary',
      resource: 'project_glossary',
      sourcePath: relPath,
      strong: strong.trim(),
      hebrew: hebrew.trim(),
      rendering: ult.trim() || ust.trim(),
      book: 'ALL',
      context: '',
      notes: notes.trim(),
      date: null,
      source: 'human',
      submittedBy: extractAttribution(notes),
      rawText: cells.join(' | '),
    });
  }
  return decisions;
}

function loadHumanDecisions(skillsRoot) {
  const root = resolveSkillsRoot(skillsRoot);
  return [
    ...loadQuickRefDecisions(root),
    ...loadGlossaryDecisions(root),
  ];
}

function collectReportText({ message, feedbackText, classified }) {
  const verbatimParts = [
    feedbackText,
    message?.subject,
    message?.display_recipient,
  ];
  const paraphrasedParts = [];
  for (const complaint of classified?.complaints || []) {
    paraphrasedParts.push(complaint.summary, ...(complaint.evidence || []));
  }
  for (const issue of classified?.issues || []) {
    paraphrasedParts.push(issue.title, issue.body);
  }
  const verbatim = verbatimParts.filter(Boolean).join('\n');
  const paraphrased = paraphrasedParts.filter(Boolean).join('\n');
  return {
    verbatim,
    paraphrased,
    combined: [verbatim, paraphrased].filter(Boolean).join('\n'),
  };
}

function detectBooks(text) {
  const normalized = normalizeText(text);
  const found = new Set();
  for (const [book, aliases] of Object.entries(BOOK_ALIASES)) {
    if (aliases.some((alias) => new RegExp(`\\b${alias.replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalized))) {
      found.add(book);
    }
  }
  return found;
}

function bookApplies(decision, reportBooks) {
  if (!decision.book || decision.book === 'ALL') return true;
  if (reportBooks.size === 0) return true;
  return reportBooks.has(decision.book);
}

const REJECTED_PHRASE_STOPWORDS = new Set([
  'not', 'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'it',
  'that', 'this', 'as', 'in', 'on', 'for', 'with', 'by',
]);

function extractRejectedPhrases(notes) {
  const phrases = [];
  const text = String(notes || '');
  // Lookbehind skips keywords sitting inside quoted renderings (e.g. 'avoid'
  // in "use 'avoid' not 'stay away from'") — those are the desired rendering,
  // not a rejection clause.
  const pattern = /(?<!['"“”‘’])\b(?:never|not|do not|don't|avoid)\b[^."'“”']{0,80}(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)/gi;
  let m;
  while ((m = pattern.exec(text))) {
    const phrase = (m[1] || m[2] || m[3] || m[4] || '').trim();
    if (!phrase) continue;
    if (REJECTED_PHRASE_STOPWORDS.has(phrase.toLowerCase())) continue;
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function phraseAppearsDesired(text, phrase) {
  const normalized = normalizeText(text);
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;

  let index = normalized.indexOf(normalizedPhrase);
  while (index >= 0) {
    const before = normalized.slice(Math.max(0, index - 100), index);
    const after = normalized.slice(index + normalizedPhrase.length, index + normalizedPhrase.length + 80);
    const window = `${before} ${normalizedPhrase} ${after}`;
    const desired = /\b(?:should|please|prefer|expected|expect|needs?|must|correct|change(?:d)?\s+to|use|uses|using|render(?:ed|ing)?\s+(?:as|with|to)?)\b/i.test(window);
    const negated = /\b(?:actual behavior|wrong|incorrect|bad|avoid|not|never|instead of|should not|do not|don't)\b/i.test(before.slice(-45));
    if (desired && !negated) return true;
    index = normalized.indexOf(normalizedPhrase, index + normalizedPhrase.length);
  }
  return false;
}

function scoreDecision(decision, reportText, reportBooks) {
  if (!bookApplies(decision, reportBooks)) return null;

  const verbatim = reportText?.verbatim || '';
  const paraphrased = reportText?.paraphrased || '';
  const combined = reportText?.combined || `${verbatim}\n${paraphrased}`;
  const verbatimNormalized = normalizeText(verbatim);
  const combinedNormalized = normalizeText(combined);

  const reasons = [];
  let score = 0;
  let hasVerbatimRejectedHit = false;

  for (const phrase of extractRejectedPhrases(decision.notes)) {
    const normalizedPhrase = normalizeText(phrase);
    const inVerbatim = verbatimNormalized.includes(normalizedPhrase);
    const inCombined = combinedNormalized.includes(normalizedPhrase);

    if (phraseAppearsDesired(verbatim, phrase)) {
      score += 12;
      hasVerbatimRejectedHit = true;
      reasons.push(`requested rejected phrase "${phrase}"`);
    } else if (phraseAppearsDesired(paraphrased, phrase)) {
      score += 4;
      reasons.push(`requested rejected phrase "${phrase}" (paraphrased)`);
    } else if (inCombined) {
      score += 3;
      reasons.push(`mentioned rejected phrase "${phrase}"`);
    }

    if (inVerbatim) hasVerbatimRejectedHit = true;
  }

  for (const [label, value, points] of [
    ['Strong', decision.strong, 5],
    ['Hebrew', decision.hebrew, 5],
    ['rendering', decision.rendering, 2],
  ]) {
    const term = normalizeText(value);
    if (term && combinedNormalized.includes(term)) {
      score += points;
      reasons.push(`matched ${label} ${value}`);
    }
  }

  if (decision.book && decision.book !== 'ALL' && reportBooks.has(decision.book)) {
    score += 1;
    reasons.push(`matched book ${decision.book}`);
  }

  if (score < 8) return null;

  // Anchor requirement: a decision with no Strong number and no Hebrew term is
  // just a free-text rule. Without a literal hit on a rejected phrase in the
  // user's verbatim feedback, we have no real evidence the topic matches —
  // only the LLM-paraphrased issue body, which can introduce incidental words.
  const hasAnchor = Boolean(normalizeText(decision.strong) || normalizeText(decision.hebrew));
  if (!hasAnchor && !hasVerbatimRejectedHit) return null;

  return { decision, score, reasons };
}

function defaultAdjudicateConflict({ candidates }) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted.find((candidate) =>
    candidate.reasons.some((reason) => reason.startsWith('requested rejected phrase'))
  ) || sorted[0];
  if (!best) return null;
  return {
    decision: best.decision,
    candidates: sorted,
    reasons: best.reasons,
  };
}

function truncateSummary(text, maxLength = 220) {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function capitalizeFirst(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

function summarizeHumanFeedback({ feedbackText, classified } = {}) {
  const complaintSummary = classified?.complaints
    ?.map((complaint) => complaint?.summary)
    .find((summary) => String(summary || '').trim());
  if (complaintSummary) return truncateSummary(capitalizeFirst(complaintSummary));

  const issueTitle = classified?.issues
    ?.map((issue) => issue?.title)
    .find((title) => String(title || '').trim());
  if (issueTitle) return truncateSummary(capitalizeFirst(issueTitle));

  return truncateSummary(capitalizeFirst(feedbackText));
}

async function findHumanDecisionConflict({
  message,
  feedbackText,
  classified,
  skillsRoot,
  adjudicateConflict = defaultAdjudicateConflict,
} = {}) {
  if (!classified?.issues?.some((issue) => issue.repo === 'bp-assistant-skills')) return null;

  const reportText = collectReportText({ message, feedbackText, classified });
  const reportBooks = detectBooks(reportText.combined);
  const candidates = loadHumanDecisions(skillsRoot)
    .map((decision) => scoreDecision(decision, reportText, reportBooks))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (candidates.length === 0) return null;
  const conflict = adjudicateConflict({ message, feedbackText, classified, candidates, reportText }) || null;
  if (!conflict) return null;
  return {
    ...conflict,
    feedbackSummary: summarizeHumanFeedback({ feedbackText, classified }),
  };
}

function formatHumanDate(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date || 'an earlier date';
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function summarizeDecision(decision) {
  const parts = [];
  if (decision.strong) parts.push(decision.strong);
  if (decision.hebrew) parts.push(decision.hebrew);
  if (decision.rendering) parts.push(`"${decision.rendering}"`);
  return parts.join(' / ') || decision.rawText || 'human decision';
}

function summarizePriorDecision(decision) {
  if (!decision) return '';
  const subjectParts = [];
  if (decision.strong) subjectParts.push(decision.strong);
  if (decision.hebrew) subjectParts.push(decision.hebrew);

  const subject = subjectParts.join(' / ');
  const scope = decision.book && decision.book !== 'ALL' ? ` for ${decision.book}` : '';
  const rendering = decision.rendering ? `use "${decision.rendering}"${scope}` : `follow the recorded decision${scope}`;
  const notes = truncateSummary(decision.notes, 180);

  const prefix = subject ? `${subject}: ` : '';
  return notes
    ? `${prefix}${rendering}. ${notes}`
    : `${prefix}${rendering}.`;
}

function formatDecisionConflictPrompt(conflict) {
  const decision = conflict?.decision || {};
  const date = formatHumanDate(decision.date);
  const lines = [];
  if (decision.submittedBy) {
    lines.push(`This conflicts with human decision submitted by ${decision.submittedBy} on ${date}.`);
  } else if (decision.date) {
    lines.push(`This conflicts with a human decision recorded on ${date}.`);
  } else {
    lines.push('This conflicts with an earlier human decision.');
  }

  if (conflict?.feedbackSummary) {
    lines.push('', `Feedback summary: ${conflict.feedbackSummary}`);
  }

  const priorDecisionSummary = summarizePriorDecision(decision);
  if (priorDecisionSummary) {
    lines.push(`Prior decision: ${priorDecisionSummary}`);
  }

  lines.push('', 'Do you still wish to file this feedback (yes/no)?');
  return lines.join('\n');
}

function formatConflictIssueSection(conflict) {
  if (!conflict?.decision) return '';
  const decision = conflict.decision;
  const source = summarizeDecision(decision);
  const attribution = decision.submittedBy
    ? `${decision.submittedBy} on ${formatHumanDate(decision.date)}`
    : decision.date
      ? `human decision recorded on ${formatHumanDate(decision.date)}`
      : 'earlier human decision';
  return [
    '## Conflicts with prior human decision',
    '',
    `This feedback was confirmed for filing even though it appears to conflict with ${attribution}.`,
    '',
    `Decision: ${source}`,
    decision.notes ? `Notes: ${decision.notes}` : '',
  ].filter((line) => line !== '').join('\n');
}

module.exports = {
  findHumanDecisionConflict,
  formatDecisionConflictPrompt,
  formatConflictIssueSection,
  loadHumanDecisions,
  parseCsv,
  resolveSkillsRoot,
  summarizePriorDecision,
  summarizeHumanFeedback,
  _extractRejectedPhrases: extractRejectedPhrases,
  _phraseAppearsDesired: phraseAppearsDesired,
};
