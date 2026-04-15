const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getProviderConfig,
  resolveProviderModel,
} = require('../src/api-runner/provider-config');
const geminiProvider = require('../src/api-runner/providers/gemini');
const {
  getHarnessModels,
  validateRequiredArtifacts,
} = require('../scripts/test-providers-zec3');
const { resolveAgentProvider } = require('../src/api-runner/team-manager');
const { getProviderSystemAppend } = require('../src/api-runner/provider-nudges');
const { readPreparedNotes } = require('../src/workspace-tools/tn-tools');

test('openai aliases resolve to current runner defaults', () => {
  assert.equal(resolveProviderModel('openai', 'opus'), 'gpt-5.4');
  assert.equal(resolveProviderModel('openai', 'sonnet'), 'gpt-5.4-mini');
  assert.equal(resolveProviderModel('openai', 'haiku'), 'gpt-5.4-nano');
  assert.equal(resolveProviderModel('xai', 'opus'), 'grok-4.20-reasoning');
  assert.equal(resolveProviderModel('xai', 'sonnet'), 'grok-4.20-reasoning');
});

test('gemini provider config exposes fallback models for transient overloads', () => {
  const cfg = getProviderConfig('gemini');
  assert.deepEqual(cfg.fallbackModels['gemini-3.1-pro-preview'], [
    'gemini-3-pro-preview',
    'gemini-2.5-pro',
  ]);
  assert.deepEqual(cfg.fallbackModels['gemini-3-flash-preview'], [
    'gemini-2.5-flash',
  ]);
});

test('gemini ZEC harness defaults follow provider-config aliases', () => {
  const models = getHarnessModels('gemini');
  assert.equal(models.opus, resolveProviderModel('gemini', 'opus'));
  assert.equal(models.sonnet, resolveProviderModel('gemini', 'sonnet'));
  assert.equal(models.opus, 'gemini-3.1-pro-preview');
  assert.equal(models.sonnet, 'gemini-2.5-pro');
});

test('gemini tool results preserve upstream tool call ids', () => {
  const result = geminiProvider.formatToolResult('call-123', 'ping', { ok: true }, false);
  assert.deepEqual(result, {
    role: 'tool',
    results: [{
      toolCallId: 'call-123',
      name: 'ping',
      content: JSON.stringify({ ok: true }),
      isError: false,
    }],
  });
});

test('gemini 2.5 low thinking keeps a positive budget', () => {
  assert.equal(typeof geminiProvider.getThinkingConfig, 'function');
  assert.deepEqual(geminiProvider.getThinkingConfig('gemini-2.5-pro', 'low'), {
    thinkingConfig: { thinkingBudget: 1024 },
  });
  assert.deepEqual(geminiProvider.getThinkingConfig('gemini-3.1-pro-preview', 'low'), {
    thinkingConfig: { thinkingLevel: 'low' },
  });
});

test('gemini tool response contents include matching function response ids', () => {
  assert.equal(typeof geminiProvider.toGeminiContents, 'function');

  const contents = geminiProvider.toGeminiContents([
    geminiProvider.formatAssistantMessage('', [{
      id: 'call-123',
      name: 'ping',
      arguments: { text: 'hello' },
    }], [
      { functionCall: { id: 'call-123', name: 'ping', args: { text: 'hello' } } },
    ]),
    geminiProvider.formatToolResult('call-123', 'ping', 'OK', false),
  ]);

  assert.deepEqual(contents[1], {
    role: 'user',
    parts: [{
      functionResponse: {
        id: 'call-123',
        name: 'ping',
        response: { content: 'OK' },
      },
    }],
  });
});

test('locked provider runs keep sub-agents on the parent provider', () => {
  assert.equal(
    resolveAgentProvider({ provider: 'claude' }, { provider: 'openai', lockProvider: true }),
    'openai'
  );
  assert.equal(
    resolveAgentProvider({}, { provider: 'gemini', lockProvider: true }),
    'gemini'
  );
});

test('provider-specific runner nudges stay attached to openai and xai', () => {
  const openaiNudge = getProviderSystemAppend('openai', 'initial-pipeline', { book: 'ZEC', chapter: 3 });
  assert.match(openaiNudge, /output\/AI-ULT\/ZEC\/ZEC-03\.usfm/);
  assert.match(openaiNudge, /Verify they exist with a Glob or Read/);
  assert.match(openaiNudge, /zero-padded chapter tag "ZEC-03"/);

  const xaiNudge = getProviderSystemAppend('xai', 'initial-pipeline', { book: 'ZEC', chapter: 3 });
  assert.match(xaiNudge, /header-only file/);
  assert.match(xaiNudge, /at least one data row/);
  assert.match(xaiNudge, /Do NOT invent unpadded variants such as "ZEC-3\.usfm"/);

  const xaiAlignNudge = getProviderSystemAppend('xai', 'align-all-parallel', { book: 'ZEC', chapter: 3 });
  assert.match(xaiAlignNudge, /output\/AI-ULT\/ZEC\/ZEC-03-aligned\.usfm/);
  assert.match(xaiAlignNudge, /create_aligned_usfm/);
  assert.match(xaiAlignNudge, /Do not accept a representative sample/);

  assert.equal(getProviderSystemAppend('gemini', 'initial-pipeline'), '');
  assert.equal(getProviderSystemAppend('openai', 'align-all-parallel', { book: 'ZEC', chapter: 3 }), '');
  assert.equal(getProviderSystemAppend('xai', 'tn-writer'), '');
});

test('zec harness artifact gate rejects missing or empty required outputs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zec3-artifacts-'));
  const paths = {
    ult: path.join(tempDir, 'ZEC-03.usfm'),
    ultAligned: path.join(tempDir, 'ZEC-03-aligned.usfm'),
    ust: path.join(tempDir, 'ZEC-03-UST.usfm'),
    ustAligned: path.join(tempDir, 'ZEC-03-UST-aligned.usfm'),
    issues: path.join(tempDir, 'ZEC-03-issues.tsv'),
    notes: path.join(tempDir, 'ZEC-03-notes.tsv'),
  };

  fs.writeFileSync(paths.ult, '\\id ZEC');
  fs.writeFileSync(paths.ultAligned, '\\id ZEC');
  fs.writeFileSync(paths.ust, '');
  fs.writeFileSync(paths.ustAligned, '\\id ZEC');
  fs.writeFileSync(paths.issues, 'Reference\tID\n3:1\ta1b2\n');

  const result = validateRequiredArtifacts(paths);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map((entry) => entry.key), ['notes']);
  assert.deepEqual(result.empty.map((entry) => entry.key), ['ust']);
});

test('readPreparedNotes accepts object-backed prepared_notes packets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-notes-'));
  const relRoot = path.join('tmp', path.basename(tempDir));
  const absRoot = path.join('/srv/bot/workspace', relRoot);
  fs.mkdirSync(absRoot, { recursive: true });

  const preparedRel = path.join(relRoot, 'prepared_notes.json');
  fs.writeFileSync(path.join('/srv/bot/workspace', preparedRel), JSON.stringify({
    book: 'ZEC',
    chapter: '03',
    item_count: 2,
    items: [
      { id: 'a1b2', reference: '3:1' },
      { id: 'c3d4', reference: '3:2' },
    ],
  }, null, 2));

  const summary = JSON.parse(readPreparedNotes({ preparedJson: preparedRel, summaryOnly: true }));
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.ids, ['a1b2', 'c3d4']);
});
