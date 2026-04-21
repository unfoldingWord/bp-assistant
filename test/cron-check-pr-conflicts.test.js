const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectConflictReport,
  extractPRUrls,
  formatConflictReport,
  parsePRUrl,
} = require('../scripts/cron-check-pr-conflicts');

test('extractPRUrls captures GitHub and Door43 PR URLs', () => {
  const text = [
    'https://github.com/unfoldingWord/bp-assistant/pull/15',
    'https://git.door43.org/unfoldingWord/bp-assistant/pulls/22',
    'https://github.com/unfoldingWord/bp-assistant/pull/15',
  ].join('\n');

  assert.deepEqual(extractPRUrls(text), [
    'https://github.com/unfoldingWord/bp-assistant/pull/15',
    'https://git.door43.org/unfoldingWord/bp-assistant/pulls/22',
  ]);
});

test('parsePRUrl recognizes GitHub PR URLs', () => {
  assert.deepEqual(
    parsePRUrl('https://github.com/unfoldingWord/bp-assistant-skills/pull/20'),
    {
      host: 'github.com',
      owner: 'unfoldingWord',
      repo: 'bp-assistant-skills',
      index: '20',
      apiBase: 'https://api.github.com',
    },
  );
});

test('collectConflictReport reports overlapping files for GitHub PRs', async () => {
  const report = await collectConflictReport(
    [
      'https://github.com/unfoldingWord/bp-assistant-skills/pull/16',
      'https://github.com/unfoldingWord/bp-assistant-skills/pull/20',
      'https://github.com/unfoldingWord/bp-assistant-skills/pull/17',
    ],
    {},
    async (prUrl) => {
      const map = {
        'https://github.com/unfoldingWord/bp-assistant-skills/pull/16': ['data/quick-ref/ult_decisions.csv'],
        'https://github.com/unfoldingWord/bp-assistant-skills/pull/20': [
          'data/quick-ref/ult_decisions.csv',
          'data/glossary/project_glossary.md',
        ],
        'https://github.com/unfoldingWord/bp-assistant-skills/pull/17': ['.claude/skills/ULT-gen/SKILL.md'],
      };
      return map[prUrl];
    },
  );

  assert.match(report, /1 file\(s\) touched by multiple PRs/);
  assert.match(report, /data\/quick-ref\/ult_decisions\.csv/);
  assert.match(report, /bp-assistant-skills#16/);
  assert.match(report, /bp-assistant-skills#20/);
});

test('formatConflictReport explains when no PRs are present', () => {
  assert.equal(formatConflictReport([], new Map(), 0), 'PR conflict check: no PRs found in run output.');
});
