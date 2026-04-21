'use strict';

const cron = require('node-cron');
const { curatePublishedData } = require('./curate-data');

// Runs every Thursday at 05:00 UTC — refreshes Google Sheets/Docs (glossary + issues_resolved)
function startWeeklyRefresh() {
  cron.schedule('0 5 * * 4', async () => {
    console.log('[weekly-refresh] Starting Google data refresh...');
    try {
      const result = await curatePublishedData({ step: 'fetch-google', force: true });
      console.log('[weekly-refresh] Done:', result.messages.join(' | '));
    } catch (err) {
      console.error('[weekly-refresh] Failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[weekly-refresh] Scheduled: Thursdays at 05:00 UTC');
}

module.exports = { startWeeklyRefresh };
