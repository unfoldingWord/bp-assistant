'use strict';

// node-cron is required lazily inside startWeeklyRefresh: only the scheduling
// wiring needs it, so runWeeklyRefresh (and its test) can load this module
// without pulling in the scheduler.
const { curatePublishedData } = require('./curate-data');

// Runs every Thursday at 05:00 UTC.
//
// This is a FULL forced curation run, not the Google-only one it used to be.
// It refreshes the Door43 sources (hbo_uhb + en_ult + en_ust + en_tn + t4t)
// and the Google sources (glossary + issues_resolved), then rebuilds
// strongs_index, ust_index and tn_index from the data it just fetched.
//
// Nothing else on Fly refreshed the data directories: entrypoint.sh refreshes
// the skills checkout via scripts/refresh-workspace.sh, but the data dirs are
// gitignored in bp-assistant-skills so that script deliberately leaves them
// alone. This cron was the only scheduled refresh in the repo and it covered
// only the Google sources, so UHB/ULT/UST/TN went 1-6 months stale (#335).
//
// The four Door43 repos change together -- a coordinated Ketiv/Qere swap
// landed across all four on 2026-08-14 -- so refreshing one without the others
// leaves the UHB main text disagreeing with the ULT/UST alignment x-content
// values, which is exactly the mismatch that breaks alignment and orig_quote
// work. Fetching the whole set and rebuilding the indexes in one pass keeps
// the volume internally consistent.
//
// `curate` is injectable so the test can assert what gets requested without
// hitting the network.
async function runWeeklyRefresh(curate) {
  const run = curate || curatePublishedData;
  console.log('[weekly-refresh] Starting full Door43 + Google refresh...');
  try {
    // No `step` -> every step in CURATE_STEPS runs: fetch-door43, fetch-google,
    // extract-english, resolve-quotes, build-indexes. `force` ignores the
    // per-file cache so the coordinated repo set is refetched as a unit.
    const result = await run({ force: true });
    console.log('[weekly-refresh] Done:', (result.messages || []).join(' | '));
    const errors = result.fetchErrors || [];
    if (errors.length) {
      const summary = errors.map(e => `${e.file}: ${e.message}`).join('; ');
      console.error(`[weekly-refresh] FAILED: ${errors.length} file(s) — ${summary}`);
    } else {
      console.log('[weekly-refresh] OK: all sources refreshed, indexes rebuilt');
    }
    return result;
  } catch (err) {
    console.error('[weekly-refresh] Failed:', err.message);
    return null;
  }
}

function startWeeklyRefresh() {
  const cron = require('node-cron');
  cron.schedule('0 5 * * 4', () => runWeeklyRefresh(), { timezone: 'UTC' });
  console.log('[weekly-refresh] Scheduled: Thursdays at 05:00 UTC (Door43 + Google + indexes)');
}

module.exports = { startWeeklyRefresh, runWeeklyRefresh };
