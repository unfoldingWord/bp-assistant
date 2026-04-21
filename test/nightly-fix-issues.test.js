const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectSkipReasons,
  selectNightlyFixIssues,
} = require('../src/nightly-fix-issues');

function issue({
  number,
  title = `Issue ${number}`,
  body = '',
  labels = [],
  commentsData = [],
  html_url,
}) {
  return {
    number,
    title,
    body,
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
