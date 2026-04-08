const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdaptiveSkillGuardrails } = require('../src/usage-tracker');

test('adaptive guardrails use warm-up default when no history exists', () => {
  const g = getAdaptiveSkillGuardrails({
    pipeline: 'notes',
    skill: 'tn-writer',
    book: 'ZZZ',
    verses: 28,
    issueCount: 12,
    sourceWordCount: 520,
  });
  assert.equal(g.warmupApplied, true);
  assert.ok(g.tokenBudget > 0);
  assert.ok(g.maxTurns >= 12);
});
