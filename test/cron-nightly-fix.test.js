const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_REPO_SLUG,
  SKILLS_REPO_SLUG,
  buildIssueDirective,
  shouldDispatchDeploy,
} = require('../src/cron-nightly-fix');

test('buildIssueDirective requires skills issues to merge and close after PR creation', () => {
  const directive = buildIssueDirective({
    repo: SKILLS_REPO_SLUG,
    repoKey: 'workspace',
    issueNumber: 9,
  });

  assert.match(directive, /override any conflicting base prompt text/i);
  assert.match(directive, /create a normal PR/i);
  assert.match(directive, /merge it to main/i);
  assert.match(directive, /close the issue with the PR reference/i);
  assert.match(directive, /conflict checker/i);
  assert.match(directive, /serialized single-writer lane/i);
});

test('buildIssueDirective keeps app issues unmerged and flags app-side follow-up', () => {
  const directive = buildIssueDirective({
    repo: APP_REPO_SLUG,
    repoKey: 'app',
    issueNumber: 11,
  });

  assert.match(directive, /do not auto-merge/i);
  assert.match(directive, /summary that app-side work is needed/i);
  assert.doesNotMatch(directive, /merge it to main/i);
});

test('shouldDispatchDeploy skips dry runs and empty runs', () => {
  assert.equal(shouldDispatchDeploy({ dryRun: '1', processedCount: 3 }), false);
  assert.equal(shouldDispatchDeploy({ dryRun: '0', processedCount: 0 }), false);
  assert.equal(shouldDispatchDeploy({ dryRun: '0', processedCount: 2 }), true);
});
