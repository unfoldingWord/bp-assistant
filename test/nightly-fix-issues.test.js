const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectSkipReasons,
  DEFAULT_BP_BOT_HOME,
  DEFAULT_WORKTREE_ROOT,
  getIssueRepos,
  selectNightlyFixIssues,
} = require('../src/nightly-fix-issues');

function issue({
  number,
  title = `Issue ${number}`,
  body = '',
  labels = [],
  commentsData = [],
  user = 'deferredreward',
  html_url,
}) {
  return {
    number,
    title,
    body,
    user: { login: user },
    labels: labels.map((name) => ({ name })),
    commentsData: commentsData.map((comment) => ({
      user: { login: comment.user },
      body: comment.body,
    })),
    html_url: html_url || `https://example.test/issues/${number}`,
  };
}

test('collectSkipReasons treats Benjamin defer comments as authoritative', () => {
  const reasons = collectSkipReasons(issue({
    number: 4,
    title: 'WIP: Split snippets persist and AT uses ellipsis instead of full phrase',
    labels: ['QA/retest', 'bug', 'invalid'],
    commentsData: [
      {
        user: 'deferredreward',
        body: "I'm not sure this is actually true. We need more feedback before fixing. We do use & and ... in appropriate cases.",
      },
    ],
  }));

  assert.ok(reasons.includes('label:QA/retest'));
  assert.ok(reasons.includes('label:invalid'));
  assert.ok(reasons.includes('comment:deferredreward:authoritative-defer'));
});

test('collectSkipReasons rejects issues not opened by deferredreward', () => {
  const reasons = collectSkipReasons(issue({
    number: 5,
    user: 'someone-else',
    title: 'Eligible looking issue',
  }));

  assert.ok(reasons.includes('author:someone-else:not-authoritative-opener'));
});

test('selectNightlyFixIssues filters skipped issues and keeps deterministic order', () => {
  const selection = selectNightlyFixIssues({
    'unfoldingWord/bp-assistant': [
      issue({ number: 11, title: 'Eligible app issue' }),
      issue({ number: 7, title: 'Hold this', body: 'Please hold off until next week.' }),
    ],
    'unfoldingWord/bp-assistant-skills': [
      issue({ number: 4, title: 'Regression', labels: ['QA/retest'] }),
      issue({ number: 9, title: 'Eligible skills issue' }),
      issue({ number: 2, title: 'Blocked skills issue', labels: ['needs design'] }),
    ],
  }, { limit: 3 });

  assert.deepEqual(
    selection.selected.map((item) => `${item.repo}#${item.issueNumber}`),
    [
      'unfoldingWord/bp-assistant#11',
      'unfoldingWord/bp-assistant-skills#9',
    ],
  );

  assert.deepEqual(
    selection.skipped.map((item) => `${item.repo}#${item.issueNumber}`),
    [
      'unfoldingWord/bp-assistant#7',
      'unfoldingWord/bp-assistant-skills#2',
      'unfoldingWord/bp-assistant-skills#4',
    ],
  );
});

test('selectNightlyFixIssues only keeps issues opened by deferredreward', () => {
  const selection = selectNightlyFixIssues({
    'unfoldingWord/bp-assistant': [
      issue({ number: 3, title: 'Deferredreward issue' }),
      issue({ number: 4, title: 'Other opener issue', user: 'someone-else' }),
    ],
  });

  assert.deepEqual(
    selection.selected.map((item) => `${item.repo}#${item.issueNumber}`),
    ['unfoldingWord/bp-assistant#3'],
  );
  assert.deepEqual(
    selection.skipped.map((item) => `${item.repo}#${item.issueNumber}`),
    ['unfoldingWord/bp-assistant#4'],
  );
});

test('selectNightlyFixIssues returns all eligible issues when no positive limit is provided', () => {
  const selection = selectNightlyFixIssues({
    'unfoldingWord/bp-assistant': [
      issue({ number: 11, title: 'Eligible app issue' }),
      issue({ number: 12, title: 'Second eligible app issue' }),
    ],
    'unfoldingWord/bp-assistant-skills': [
      issue({ number: 9, title: 'Eligible skills issue' }),
    ],
  }, {});

  assert.deepEqual(
    selection.selected.map((item) => `${item.repo}#${item.issueNumber}`),
    [
      'unfoldingWord/bp-assistant#11',
      'unfoldingWord/bp-assistant#12',
      'unfoldingWord/bp-assistant-skills#9',
    ],
  );
});

test('getIssueRepos defaults to the staged bp-bot layout', () => {
  const repos = getIssueRepos({});

  assert.deepEqual(
    repos.map((repo) => ({ slug: repo.slug, localPath: repo.localPath, worktreePrefix: repo.worktreePrefix })),
    [
      {
        slug: 'unfoldingWord/bp-assistant',
        localPath: `${DEFAULT_BP_BOT_HOME}/bp-assistant`,
        worktreePrefix: 'fix-app',
      },
      {
        slug: 'unfoldingWord/bp-assistant-skills',
        localPath: `${DEFAULT_BP_BOT_HOME}/bp-assistant-skills`,
        worktreePrefix: 'fix-ws',
      },
    ],
  );
});

test('selectNightlyFixIssues uses configured host repo and worktree paths', () => {
  const env = {
    BP_APP_REPO: '/srv/bot/app',
    BP_SKILLS_REPO: '/srv/bot/workspace',
    BP_WORKTREE_ROOT: '/tmp/bp-bot-worktrees-test',
  };

  const selection = selectNightlyFixIssues({
    'unfoldingWord/bp-assistant': [issue({ number: 12, title: 'Eligible app issue' })],
    'unfoldingWord/bp-assistant-skills': [issue({ number: 8, title: 'Eligible skills issue' })],
  }, { limit: 2, env });

  assert.equal(selection.selected[0].localPath, '/srv/bot/app');
  assert.equal(selection.selected[0].worktreePath, '/tmp/bp-bot-worktrees-test/fix-app-12');
  assert.equal(selection.selected[1].localPath, '/srv/bot/workspace');
  assert.equal(selection.selected[1].worktreePath, '/tmp/bp-bot-worktrees-test/fix-ws-8');
  assert.equal(DEFAULT_WORKTREE_ROOT, '/tmp/bp-bot-worktrees');
});
