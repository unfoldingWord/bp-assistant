// usage-tracker.js -- Persist per-skill run metrics, estimate costs, gate expensive operations
// Combines bot JSONL log with ccusage CLI data for full 5-hour window picture.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getVerseCount, getTotalVerses } = require('./verse-counts');

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
function ccusagePath() { return getConfig().ccusagePath || 'npx ccusage@latest'; }

// Bootstrap defaults: tokens/verse for each skill
// Measured 2026-02-20 on PSA 129 (8 verses, 17 notes, 8.2M total tokens).
// Will be replaced by median-based estimates once >=3 data points exist per skill.
const BOOTSTRAP_DEFAULTS = {
  'generate|initial-pipeline --lite': 250000,
  'generate|align-all-parallel':     100000,
  'notes|post-edit-review':          145000,  // observed: 1.16M / 8v
  'notes|tn-writer':                 725000,  // observed: 5.80M / 8v
  'notes|tn-quality-check':           87000,  // observed: 695K / 8v
  'notes|chapter-intro':              50000,  // not yet measured
  'notes|deep-issue-id --lite':      200000,  // not yet measured
  '*|repo-insert':                    74000,  // observed: 589K / 8v
};

// Skill chains: which skills run for each pipeline type
const SKILL_CHAINS = {
  generate: ['initial-pipeline --lite', 'align-all-parallel', 'repo-insert'],
  notes: ['post-edit-review', 'tn-writer', 'tn-quality-check', 'repo-insert'],
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

  // For each skill, compute median tokens/verse from history
  const skillMedians = {};
  let anyBootstrapped = false;

  for (const skill of chain) {
    const matching = allEntries.filter(e =>
      e.pipeline === pipeline && e.skill === skill && e.verses > 0 && e.total_tokens > 0
    );
    const perVerseValues = matching.map(e => e.total_tokens / e.verses);

    const bootstrap = getBootstrapDefault(pipeline, skill);
    let tokensPerVerse;

    if (perVerseValues.length < 3) {
      tokensPerVerse = bootstrap;
      anyBootstrapped = true;
    } else if (perVerseValues.length <= 10) {
      // Blend 50% historical + 50% bootstrap
      const sorted = perVerseValues.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      tokensPerVerse = (median + bootstrap) / 2;
      anyBootstrapped = true;
    } else {
      const sorted = perVerseValues.sort((a, b) => a - b);
      tokensPerVerse = sorted[Math.floor(sorted.length / 2)];
    }

    skillMedians[skill] = tokensPerVerse;
  }

  // Calculate per-chapter estimates
  const perChapter = [];
  let totalTokens = 0;

  for (let ch = startCh; ch <= endCh; ch++) {
    let verses;
    try { verses = getVerseCount(book, ch); } catch { verses = 20; }

    let chapterTokens = 0;
    for (const skill of chain) {
      chapterTokens += skillMedians[skill] * verses;
    }

    perChapter.push({ chapter: ch, verses, tokens: Math.round(chapterTokens) });
    totalTokens += chapterTokens;
  }

  totalTokens = Math.round(totalTokens);

  // Rough time estimate: ~1M tokens per 10 minutes (from observed bot throughput)
  const estimatedMinutes = Math.round(totalTokens / 100000);

  return { totalTokens, perChapter, estimatedMinutes, bootstrapped: anyBootstrapped };
}

// ---------------------------------------------------------------------------
// getHeadroom -- combine ccusage + bot log for full 5h window picture
// ---------------------------------------------------------------------------
function getHeadroom() {
  const budget = getEffectiveBudget();
  const configBudget = windowBudget();
  const hours = windowHours();

  // Source 1: ccusage (CLI/desktop usage)
  let ccusageTokens = 0;
  let ccusageOk = false;
  try {
    const cmd = `${ccusagePath()} blocks --json --offline 2>/dev/null`;
    const raw = execSync(cmd, { timeout: 10000, encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    const blocks = parsed.blocks || parsed;

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
function preflightCheck({ pipeline, book, startCh, endCh }) {
  const estimate = estimateTokens({ pipeline, book, startCh, endCh });
  const room = getHeadroom();
  const threshold = warnThreshold();

  const budget = room.budget;
  const headroom = room.headroom;

  // Never reject based on estimates alone — only warn.
  // Rejection should only happen when we actually hit rate limits (handled by calibration).
  // Warn if estimated usage is high relative to remaining headroom
  if (headroom > 0 && estimate.totalTokens > headroom * threshold) {
    return {
      decision: 'warn',
      reason: `Heads up: est ~${formatTokens(estimate.totalTokens)}, ~${formatTokens(headroom)} headroom remaining (${Math.round(estimate.totalTokens / headroom * 100)}%).`,
      estimate,
      headroom: room,
      retryAt: null,
    };
  }

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
function getUsageSummary() {
  const room = getHeadroom();
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

module.exports = {
  recordMetrics,
  recordRateLimit,
  estimateTokens,
  preflightCheck,
  getHeadroom,
  getUsageSummary,
  getCumulativeTokens,
  recordRunSummary,
};
