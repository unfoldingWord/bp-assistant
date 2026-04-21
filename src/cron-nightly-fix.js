'use strict';

const APP_REPO_SLUG = 'unfoldingWord/bp-assistant';
const SKILLS_REPO_SLUG = 'unfoldingWord/bp-assistant-skills';
const DEPLOY_WORKFLOW_FILE = 'deploy-fly.yml';

function toFlag(value) {
  return String(value || '').trim().toLowerCase();
}

function getIssueLane(issue = {}) {
  const repo = String(issue.repo || '').trim();
  const repoKey = String(issue.repoKey || '').trim();

  if (repo === APP_REPO_SLUG || repoKey === 'app') return 'app';
  if (repo === SKILLS_REPO_SLUG || repoKey === 'workspace') return 'skills';
  return 'unknown';
}

function buildIssueDirective(issue = {}) {
  const lane = getIssueLane(issue);
  const sharedLines = [
    '## Cron lane guardrails (override any conflicting base prompt text)',
    'These run-specific instructions override any earlier generic instruction that conflicts.',
    'Treat bp-assistant and bp-assistant-skills as separate lanes.',
    'Print every created PR URL immediately so it lands in the cron log.',
    'Before any merge, run the conflict checker against the cron run log: `node /srv/bot/app/scripts/cron-check-pr-conflicts.js "$RUN_LOG"`.',
    'If the conflict checker flags your PR on a shared hotspot file, stop and report the conflict instead of merging.',
    'Shared hotspot files are a serialized single-writer lane. Do not act like concurrent writers are safe.',
    'After each merge, the next issue must refresh from the updated origin/main rather than a stale branch tip.',
  ];

  if (lane === 'skills') {
    return [
      ...sharedLines,
      'This selected issue is in the bp-assistant-skills lane.',
      'Create a normal PR, not a draft PR, so it can be merged in this cron run.',
      'After the PR exists and the conflict checker is clean, merge it to main.',
      'After merge, close the issue with the PR reference if GitHub did not already close it from the PR body.',
      'Your final summary should state that the skills lane was merged during cron.',
    ].join('\n');
  }

  if (lane === 'app') {
    return [
      ...sharedLines,
      'This selected issue is in the bp-assistant lane.',
      'Create the PR, but do not auto-merge bp-assistant work by default.',
      'Leave the app PR open for human review unless the user explicitly overrides that policy.',
      'Your final summary must include a clear summary that app-side work is needed and was not auto-merged.',
    ].join('\n');
  }

  return [
    ...sharedLines,
    'Repo lane could not be determined from the selected issue payload. Do not auto-merge.',
  ].join('\n');
}

function shouldDispatchDeploy({ dryRun, processedCount } = {}) {
  if (toFlag(dryRun) === '1' || toFlag(dryRun) === 'true') return false;
  return Number(processedCount) > 0;
}

module.exports = {
  APP_REPO_SLUG,
  DEPLOY_WORKFLOW_FILE,
  SKILLS_REPO_SLUG,
  buildIssueDirective,
  getIssueLane,
  shouldDispatchDeploy,
};
