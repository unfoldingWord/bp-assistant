const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdaptiveSkillGuardrails } = require('../src/usage-tracker');
const {
  _applySkillSpecificGuardrails,
  _getSkillToolConfig,
} = require('../src/notes-pipeline');

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
  assert.equal(g.tokenBudget, null);
  assert.ok(g.maxTurns >= 12);
  assert.ok(g.maxToolCalls >= 40);
});

test('tn-writer guardrails are clamped to bounded execution limits', () => {
  const bounded = _applySkillSpecificGuardrails('tn-writer', {
    maxTurns: 70,
    maxToolCalls: 220,
    tokenBudget: null,
  });

  assert.equal(bounded.maxTurns, 36);
  assert.equal(bounded.maxToolCalls, 90);
  assert.equal(bounded.tokenBudget, null);
});

test('tn-writer tool profile blocks wandering tools but keeps file tools', () => {
  const toolConfig = _getSkillToolConfig('tn-writer');

  assert.ok(toolConfig.tools.includes('Read'));
  assert.ok(toolConfig.tools.includes('Write'));
  assert.ok(toolConfig.tools.includes('Edit'));
  assert.ok(toolConfig.tools.includes('Grep'));
  assert.ok(toolConfig.tools.includes('Glob'));
  assert.ok(toolConfig.tools.includes('Skill'));
  assert.equal(toolConfig.tools.includes('Task'), false);
  assert.equal(toolConfig.tools.includes('Agent'), false);
  assert.equal(toolConfig.tools.includes('WebSearch'), false);
  assert.equal(toolConfig.tools.includes('WebFetch'), false);
  assert.ok(toolConfig.disallowedTools.includes('Bash'));
  assert.ok(toolConfig.disallowedTools.includes('Task'));
  assert.ok(toolConfig.disallowedTools.includes('Agent'));
  assert.ok(toolConfig.disallowedTools.includes('WebSearch'));
});
