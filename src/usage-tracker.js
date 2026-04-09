// usage-tracker.js -- Persist per-skill run metrics, estimate costs, gate expensive operations
// Combines ccusage library data with bot JSONL log for full 5-hour window picture.

const fs = require('fs');
const path = require('path');
const { getVerseCount, getTotalVerses } = require('./verse-counts');

// ccusage is ESM-only — lazy-load via dynamic import() from CommonJS
let _loadSessionBlockData = null;
async function loadCcusageBlocks() {
  if (!_loadSessionBlockData) {
    try {
      const mod = await import('ccusage/data-loader');
      _loadSessionBlockData = mod.loadSessionBlockData;
    } catch (err) {
      console.warn(`[usage-tracker] ccusage library not available: ${err.message}`);
      return [];
    }
  }
  return _loadSessionBlockData({
    offline: true,
    claudePath: process.env.CLAUDE_CONFIG_DIR || undefined,
  });
}

const METRICS_DIR = path.resolve(__dirname, '../data/metrics');
const METRICS_FILE = path.join(METRICS_DIR, 'usage.jsonl');
const CALIBRATION_FILE = path.join(METRICS_DIR, 'calibration.json');

// Safety margin: use 95% of observed limit to avoid re-hitting the edge
const CALIBRATION_SAFETY = 0.95;

// Load config once -- fallback to defaults if usageTracking section missing
let _config = null;
function getConfig() {
  if (_config) return _config;
  try {
    const cfg = require('./config');
    _config = cfg.usageTracking || {};
  } catch {
    _config = {};
  }
  return _config;
}

// ---------------------------------------------------------------------------
// Calibration -- auto-tune windowBudget from observed rate limit hits
// ---------------------------------------------------------------------------

/**
 * Load calibration data from disk.
 * Returns { observations: [{ ts, windowUsed, source }], calibratedBudget: number|null }
 */
function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_FILE)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { observations: [], calibratedBudget: null };
}

/**
 * Record a rate limit event. windowUsed is the combined token count at the moment of failure.
 * Updates calibratedBudget to the minimum observed, with a safety margin.
 */
function recordRateLimit({ windowUsed, source }) {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    const cal = loadCalibration();
    cal.observations = cal.observations || [];
    cal.observations.push({ ts: new Date().toISOString(), windowUsed, source: source || 'unknown' });

    // Calibrated budget = min(observed hits) * safety margin
    const minObserved = Math.min(...cal.observations.map(o => o.windowUsed));
    const newBudget = Math.round(minObserved * CALIBRATION_SAFETY);
    const oldBudget = cal.calibratedBudget;

    cal.calibratedBudget = newBudget;

    if (oldBudget !== null) {
      const pctChange = ((newBudget - oldBudget) / oldBudget * 100).toFixed(1);
      console.log(`[usage-tracker] Calibrated budget updated: ${formatTokens(oldBudget)} -> ${formatTokens(newBudget)} (${pctChange > 0 ? '+' : ''}${pctChange}%)`);
    } else {
      console.log(`[usage-tracker] Calibrated budget set: ${formatTokens(newBudget)} (from observed limit ${formatTokens(minObserved)})`);
    }

    fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2));
  } catch (err) {
    console.error(`[usage-tracker] Failed to record rate limit calibration: ${err.message}`);
  }
}

/**
 * Get the effective window budget: calibrated value if available, else config default.
 */
function getEffectiveBudget() {
  const cal = loadCalibration();
  if (cal.calibratedBudget && cal.calibratedBudget > 0) {
    return cal.calibratedBudget;
  }
  return getConfig().windowBudgetTokens || 220000;
}

function windowBudget() { return getConfig().windowBudgetTokens || 220000; }
function windowHours() { return getConfig().windowHours || 5; }
function warnThreshold() { return getConfig().warnThreshold || 0.7; }

// Bootstrap defaults: tokens/verse for each skill
// Updated 2026-03-03 from 101 actual skill runs (medians).
// Will be replaced by median-based estimates once >=2 data points exist per skill.
const BOOTSTRAP_DEFAULTS = {
  'generate|initial-pipeline': 118000,  // 17 runs, median 117,987
  'generate|align-all-parallel':      12000,   // 7 runs, median 12,342
  'notes|post-edit-review':          124000,   // 15 runs, median 123,921
  'notes|tn-writer':                 467000,   // 15 runs, median 466,667
  'notes|tn-quality-check':           95000,   // 15 runs, median 94,570
  'notes|chapter-intro':             124000,   // 2 runs, median 123,795
  'notes|deep-issue-id':       36000,   // 1 run, 36,438
  '*|repo-insert':                    47000,   // 23 runs, blended gen+notes median
};

// Bootstrap defaults: seconds/verse for each skill (for time estimates)
// Updated 2026-03-19 — post-MCP migration actuals (skills use MCP tools instead of Bash).
const TIME_BOOTSTRAP_DEFAULTS = {
  'generate|initial-pipeline': 73,   // not yet MCP-migrated
  'generate|align-all-parallel':      56,   // not yet MCP-migrated
  'notes|post-edit-review':           50,   // was 40 pre-MCP
  'notes|tn-writer':                 100,   // was 73 pre-MCP
  'notes|tn-quality-check':           30,   // was 23 pre-MCP
  'notes|chapter-intro':              35,   // was 25 pre-MCP
  'notes|deep-issue-id':              55,   // was 14 pre-MCP — biggest jump (Task polling overhead)
  '*|repo-insert':                    15,   // was 12 pre-MCP
};

// Skill chains: which skills run for each pipeline type
// notes uses deep-issue-id (no AI artifacts available for new chapters)
const SKILL_CHAINS = {
  generate: ['initial-pipeline', 'align-all-parallel', 'repo-insert'],
  notes: ['deep-issue-id', 'tn-writer', 'tn-quality-check', 'repo-insert'],
};

// ---------------------------------------------------------------------------
// recordMetrics -- append one JSONL line after each runClaude() call
// ---------------------------------------------------------------------------
function recordMetrics({ pipeline, skill, book, chapter, result, success, userId }) {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });

    const u = result?.usage || {};
    const inputTokens = u.input_tokens ?? u.inputTokens ?? 0;
    const outputTokens = u.output_tokens ?? u.outputTokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0;
    const cacheCreate = u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreate;

    let verses = 0;
    try { verses = getVerseCount(book, chapter); } catch { /* ignore */ }

    const entry = {
      ts: new Date().toISOString(),
      pipeline,
      skill,
      book,
      chapter,
      verses,
      model: result?.model || 'unknown',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_create_tokens: cacheCreate,
      total_tokens: totalTokens,
      cost_usd: result?.total_cost_usd ?? null,
      duration_s: result?.duration_ms ? +(result.duration_ms / 1000).toFixed(1) : null,
      turns: result?.num_turns ?? null,
      success: !!success,
      user_id: userId ?? null,
    };

    fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n');
    console.log(`[usage-tracker] Recorded: ${pipeline}/${skill} ${book} ${chapter} -- ${totalTokens.toLocaleString()} tokens`);
  } catch (err) {
    console.error(`[usage-tracker] Failed to record metrics: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// readRecentEntries -- read JSONL entries within the last N hours
// ---------------------------------------------------------------------------
function readRecentEntries(hours) {
  if (!fs.existsSync(METRICS_FILE)) return [];
  const cutoff = Date.now() - hours * 3600 * 1000;
  const entries = [];
  try {
    const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'run_summary') continue; // skip summaries
        if (new Date(entry.ts).getTime() >= cutoff) {
          entries.push(entry);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    console.warn(`[usage-tracker] Error reading metrics: ${err.message}`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// getBootstrapDefault -- fallback tokens/verse for a pipeline+skill
// ---------------------------------------------------------------------------
function getBootstrapDefault(pipeline, skill) {
  return BOOTSTRAP_DEFAULTS[`${pipeline}|${skill}`]
    || BOOTSTRAP_DEFAULTS[`*|${skill}`]
    || 150000; // generic fallback
}

function getTimeBootstrapDefault(pipeline, skill) {
  return TIME_BOOTSTRAP_DEFAULTS[`${pipeline}|${skill}`]
    || TIME_BOOTSTRAP_DEFAULTS[`*|${skill}`]
    || 60; // generic fallback: 60 s/verse
}

// ---------------------------------------------------------------------------
// estimateTokens -- predict cost for a pipeline run
// ---------------------------------------------------------------------------
function estimateTokens({ pipeline, book, startCh, endCh }) {
  const chain = SKILL_CHAINS[pipeline];
  if (!chain) {
    return { totalTokens: 0, perChapter: [], estimatedMinutes: 0, bootstrapped: true };
  }

  // Read all historical entries for this pipeline
  const allEntries = [];
  if (fs.existsSync(METRICS_FILE)) {
    try {
      const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { allEntries.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // For each skill, compute median tokens/verse and seconds/verse from history
  const skillMedians = {};
  const skillTimeMedians = {};
  let anyBootstrapped = false;

  // Only use post-MCP migration data — pre-MCP timing data is from a different regime
  const MCP_CUTOFF = '2026-03-17';

  for (const skill of chain) {
    const matching = allEntries.filter(e =>
      e.pipeline === pipeline && e.skill === skill && e.verses > 0 && e.total_tokens > 0
      && e.ts >= MCP_CUTOFF
    );
    const perVerseValues = matching.map(e => e.total_tokens / e.verses);

    // Token estimation (for headroom checks)
    const bootstrap = getBootstrapDefault(pipeline, skill);
    let tokensPerVerse;

    if (perVerseValues.length < 2) {
      tokensPerVerse = bootstrap;
      anyBootstrapped = true;
    } else if (perVerseValues.length <= 5) {
      // Blend 50% historical + 50% bootstrap until we have enough data
      const sorted = perVerseValues.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      tokensPerVerse = (median + bootstrap) / 2;
      anyBootstrapped = true;
    } else {
      const sorted = perVerseValues.sort((a, b) => a - b);
      tokensPerVerse = sorted[Math.floor(sorted.length / 2)];
    }

    skillMedians[skill] = tokensPerVerse;

    // Time estimation from actual durations (seconds/verse)
    const timeMatching = matching.filter(e => e.duration_s > 0);
    const secsPerVerseValues = timeMatching.map(e => e.duration_s / e.verses);

    const timeBootstrap = getTimeBootstrapDefault(pipeline, skill);
    let secsPerVerse;

    if (secsPerVerseValues.length < 2) {
      secsPerVerse = timeBootstrap;
    } else if (secsPerVerseValues.length <= 5) {
      const sorted = secsPerVerseValues.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      secsPerVerse = (median + timeBootstrap) / 2;
    } else {
      const sorted = secsPerVerseValues.sort((a, b) => a - b);
      secsPerVerse = sorted[Math.floor(sorted.length / 2)];
    }

    skillTimeMedians[skill] = secsPerVerse;
  }

  // Calculate per-chapter estimates
  const perChapter = [];
  let totalTokens = 0;
  let totalSeconds = 0;

  for (let ch = startCh; ch <= endCh; ch++) {
    let verses;
    try { verses = getVerseCount(book, ch); } catch { verses = 20; }

    let chapterTokens = 0;
    let chapterSeconds = 0;
    for (const skill of chain) {
      chapterTokens += skillMedians[skill] * verses;
      chapterSeconds += skillTimeMedians[skill] * verses;
    }

    perChapter.push({ chapter: ch, verses, tokens: Math.round(chapterTokens) });
    totalTokens += chapterTokens;
    totalSeconds += chapterSeconds;
  }

  totalTokens = Math.round(totalTokens);

  // Time estimate from per-skill duration data (much more accurate than token-based)
  const estimatedMinutes = Math.round(totalSeconds / 60);

  return { totalTokens, perChapter, estimatedMinutes, bootstrapped: anyBootstrapped };
}

// ---------------------------------------------------------------------------
// getHeadroom -- combine ccusage + bot log for full 5h window picture
// ---------------------------------------------------------------------------
async function getHeadroom() {
  const budget = getEffectiveBudget();
  const configBudget = windowBudget();
  const hours = windowHours();

  // Source 1: ccusage library (CLI/desktop usage)
  let ccusageTokens = 0;
  let ccusageOk = false;
  try {
    const blocks = await loadCcusageBlocks();

    // Find the active block (isActive: true) or the most recent non-gap block
    let activeBlock = null;
    if (Array.isArray(blocks)) {
      activeBlock = blocks.find(b => b.isActive && !b.isGap);
      if (!activeBlock) {
        // Fall back to most recent non-gap block within the window
        const cutoff = Date.now() - hours * 3600 * 1000;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (!blocks[i].isGap && new Date(blocks[i].startTime).getTime() >= cutoff) {
            activeBlock = blocks[i];
            break;
          }
        }
      }
    }

    if (activeBlock) {
      ccusageTokens = activeBlock.totalTokens || 0;
      ccusageOk = true;
    }
  } catch (err) {
    console.warn(`[usage-tracker] ccusage failed (falling back to bot-log only): ${err.message}`);
  }

  // Source 2: Bot JSONL log (SDK usage not seen by ccusage)
  const botEntries = readRecentEntries(hours);
  const botLogTokens = botEntries.reduce((sum, e) => sum + (e.total_tokens || 0), 0);

  const totalUsed = ccusageTokens + botLogTokens;
  const headroom = Math.max(0, budget - totalUsed);

  // Estimate when the oldest entries in the window will age out
  let windowEnds = null;
  if (totalUsed > 0) {
    // The window resets 5h after the first usage in the current block
    const windowStart = new Date(Date.now() - hours * 3600 * 1000);
    windowEnds = new Date(windowStart.getTime() + hours * 2 * 3600 * 1000).toISOString();
  }

  const cal = loadCalibration();
  return {
    budget,
    configBudget,
    calibrated: cal.calibratedBudget != null,
    calibrationObservations: cal.observations?.length || 0,
    used: totalUsed,
    headroom,
    ccusageTokens,
    botLogTokens,
    ccusageOk,
    windowEnds,
    botSkillRuns: botEntries.length,
  };
}

// ---------------------------------------------------------------------------
// preflightCheck -- gate decision before running a pipeline
// ---------------------------------------------------------------------------
async function preflightCheck({ pipeline, book, startCh, endCh }) {
  const estimate = estimateTokens({ pipeline, book, startCh, endCh });
  const room = await getHeadroom();
  const threshold = warnThreshold();

  const budget = room.budget;
  const headroom = room.headroom;

  return {
    decision: 'proceed',
    reason: null,
    estimate,
    headroom: room,
    retryAt: null,
  };
}

// ---------------------------------------------------------------------------
// getUsageSummary -- human-readable string for admin DMs
// ---------------------------------------------------------------------------
async function getUsageSummary() {
  const room = await getHeadroom();
  const pct = room.budget > 0 ? Math.round(room.used / room.budget * 100) : 0;

  let budgetLabel = formatTokens(room.budget);
  if (room.calibrated) {
    const pctOfConfig = Math.round(room.budget / room.configBudget * 100);
    budgetLabel += ` (calibrated, ${pctOfConfig}% of config ${formatTokens(room.configBudget)}, ${room.calibrationObservations} obs)`;
  } else {
    budgetLabel += ' (config default, not yet calibrated)';
  }

  return `5h window: ${formatTokens(room.used)} / ${budgetLabel} -- ${pct}% used, ${room.botSkillRuns} bot skill runs. Headroom: ~${formatTokens(room.headroom)}.${room.ccusageOk ? '' : ' (ccusage unavailable, bot-log only)'}`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// getCumulativeTokens -- sum of all total_tokens in the JSONL log
// ---------------------------------------------------------------------------
function getCumulativeTokens() {
  if (!fs.existsSync(METRICS_FILE)) return 0;
  try {
    const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
    let sum = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'run_summary') continue;
        sum += e.total_tokens || 0;
      } catch { /* skip */ }
    }
    return sum;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// recordRunSummary -- append a summary line after a full pipeline run
// ---------------------------------------------------------------------------
function recordRunSummary({ pipeline, book, startCh, endCh, tokensBefore, success, userId }) {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    const tokensAfter = getCumulativeTokens();
    const entry = {
      ts: new Date().toISOString(),
      type: 'run_summary',
      pipeline,
      book,
      start_ch: startCh,
      end_ch: endCh,
      chapters: endCh - startCh + 1,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      run_tokens: tokensAfter - tokensBefore,
      success,
      user_id: userId ?? null,
    };
    fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n');
    console.log(`[usage-tracker] Run summary: ${pipeline} ${book} ${startCh}-${endCh} -- ${formatTokens(tokensAfter - tokensBefore)} tokens this run (cumulative: ${formatTokens(tokensAfter)})`);
  } catch (err) {
    console.error(`[usage-tracker] Failed to record run summary: ${err.message}`);
  }
}

// Helpers
// ---------------------------------------------------------------------------
function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function verseBucket(verses) {
  const v = Number(verses || 0);
  if (v <= 20) return 'small';
  if (v <= 45) return 'medium';
  return 'large';
}

/**
 * Compute adaptive per-skill guardrails with warm-up defaults.
 * Warm-up behavior: when historical samples are sparse, keep multiplier at a
 * safe balanced default (never near-zero).
 */
function getAdaptiveSkillGuardrails({
  pipeline,
  skill,
  book,
  verses = 0,
  issueCount = 0,
  sourceWordCount = 0,
} = {}) {
  const cfg = getConfig().adaptiveGuards || {};
  const tokenBudgetEnabled = cfg.enableTokenBudget !== false;
  const minBudget = Number(cfg.minBudgetTokens || 120000);
  const maxBudget = Number(cfg.maxBudgetTokens || 1400000);
  const wordFactor = Number(cfg.wordFactor || 35);
  const issueFactor = Number(cfg.issueFactor || 12000);
  const warmupSamples = Number(cfg.warmupSamples || 3);
  const warmupMultiplier = Number(cfg.warmupMultiplier || 1.0);
  const minMultiplier = Number(cfg.minMultiplier || 0.7);
  const maxMultiplier = Number(cfg.maxMultiplier || 1.6);
  const hardMaxTurns = Number(cfg.hardMaxTurns || 1000);
  const hardMaxToolCalls = Number(cfg.hardMaxToolCalls || 1000);
  const maxConsecutiveToolErrors = Number(cfg.maxConsecutiveToolErrors || 25);
  const maxRepeatedToolErrorSignature = Number(cfg.maxRepeatedToolErrorSignature || 25);

  const fallbackBase = getBootstrapDefault(pipeline || 'notes', skill || 'tn-writer');
  const baseBudget = Number((cfg.baseBudgetBySkill && cfg.baseBudgetBySkill[`${pipeline}|${skill}`]) || fallbackBase);

  let history = [];
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const bucket = verseBucket(verses);
      const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
      history = lines
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .filter((e) =>
          e.pipeline === pipeline &&
          e.skill === skill &&
          e.book === book &&
          (e.total_tokens || 0) > 0 &&
          e.success === true &&
          verseBucket(e.verses || 0) === bucket
        )
        .slice(-40);
    }
  } catch {
    history = [];
  }

  const histMedian = median(history.map((e) => Number(e.total_tokens || 0)).filter((n) => n > 0));
  const rawMultiplier = histMedian && baseBudget > 0 ? (histMedian / baseBudget) : warmupMultiplier;
  const effectiveMultiplier = history.length >= warmupSamples
    ? Math.max(minMultiplier, Math.min(maxMultiplier, rawMultiplier))
    : warmupMultiplier;

  const variableBudget = baseBudget + (Number(sourceWordCount || 0) * wordFactor) + (Number(issueCount || 0) * issueFactor);
  const derivedBudget = Math.round(Math.max(minBudget, Math.min(maxBudget, variableBudget * effectiveMultiplier)));

  return {
    tokenBudget: tokenBudgetEnabled ? derivedBudget : null,
    maxTurns: Math.min(hardMaxTurns, Math.max(200, Math.round(derivedBudget / 25000))),
    maxToolCalls: Math.min(hardMaxToolCalls, Math.max(500, Math.round(derivedBudget / 7000))),
    maxConsecutiveToolErrors,
    maxRepeatedToolErrorSignature,
    warmupApplied: history.length < warmupSamples,
    historySamples: history.length,
    multiplier: +effectiveMultiplier.toFixed(3),
  };
}

module.exports = {
  recordMetrics,
  recordRateLimit,
  estimateTokens,
  preflightCheck,
  getHeadroom,
  getUsageSummary,
  getCumulativeTokens,
  recordRunSummary,
  getAdaptiveSkillGuardrails,
};
