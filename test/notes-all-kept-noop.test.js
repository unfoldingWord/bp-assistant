// #442: a chapter where every AI note duplicates an editor-kept note must end
// as a successful no-op (status line, no tn-writer, no door43Push) instead of
// failing on an empty notes file at push time.
//
// Harness: runs the real notesPipeline with its I/O modules stubbed through
// require.cache. The real kept drop (applyKeptToPreparedNotes) runs against a
// prepared_notes.json written by a stubbed prepareNotes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const modPath = (rel) => require.resolve(path.join(SRC, rel));

const KEPT = [
  { rowId: 'k1a2', ref: '38:9', supportReference: 'rc://*/ta/man/translate/figs-metaphor', quote: 'אֶבֶן' },
  { rowId: 'k3b4', ref: '38:10', supportReference: 'rc://*/ta/man/translate/figs-idiom', quote: 'שַׁעַר' },
];

function preparedItem(id, reference, sref, quote) {
  return { id, reference, sref, orig_quote: quote, gl_quote: 'x' };
}

async function runHarness({ items, introRows = [] }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-all-kept-'));
  const oldEnv = { CSKILLBP_DIR: process.env.CSKILLBP_DIR, DRY_RUN: process.env.DRY_RUN };
  process.env.CSKILLBP_DIR = tempDir;
  delete process.env.DRY_RUN;

  // Unique name: fill_quotes.py reads a hardcoded /data/workspace/<pipeDir>
  // path, which must never match a real pipeline directory.
  const pipeDir = `tmp/pipeline/test-442-${path.basename(tempDir)}`;
  const prepRel = `${pipeDir}/prepared_notes.json`;
  const issuesRel = 'output/issues/ISA/ISA-38.tsv';
  fs.mkdirSync(path.join(tempDir, pipeDir), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'output/issues/ISA'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, issuesRel), 'ISA\t38:9\tfigs-metaphor\tx\t\t\tnote\n');

  const calls = { statuses: [], replies: [], door43Push: 0, runClaude: 0, checkpoints: [] };
  const saved = new Map();
  const stub = (rel, exportsObj) => {
    const p = modPath(rel);
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  };
  const fresh = (rel) => {
    const p = modPath(rel);
    if (!saved.has(p)) saved.set(p, require.cache[p]);
    delete require.cache[p];
    return require(p);
  };

  // Load-time CSKILLBP_DIR constants must bind to the temp dir.
  const realUtils = fresh('pipeline-utils');
  const realTnTools = fresh('workspace-tools/tn-tools');
  const realContext = fresh('pipeline-context');
  const realClaudeRunner = require(modPath('claude-runner'));

  stub('zulip-client', {
    sendMessage: async (_s, _t, text) => { calls.replies.push(text); },
    sendDM: async (_id, text) => { calls.replies.push(text); },
    addReaction: async () => {},
    removeReaction: async () => {},
  });
  stub('admin-status', {
    publishAdminStatus: async ({ message }) => { calls.statuses.push(message); return { severity: 'info' }; },
  });
  stub('self-diagnosis', { dispatchSelfDiagnosis: async () => {} });
  const store = new Map();
  stub('pipeline-checkpoints', {
    buildCheckpointKey: () => 'k',
    getCheckpoint: () => store.get('k') || null,
    setCheckpoint: (_ref, v) => { store.set('k', v); calls.checkpoints.push(v); },
    clearCheckpoint: () => { store.delete('k'); },
    listCheckpoints: () => [],
  });
  stub('claude-runner', {
    ...realClaudeRunner,
    runClaude: async () => { calls.runClaude++; return { subtype: 'error', error: 'stubbed runClaude' }; },
  });
  stub('pipeline-utils', {
    ...realUtils,
    getDoor43Username: () => 'tester',
    checkPrerequisites: () => ({ missing: [], resolved: { 'issues TSV': issuesRel } }),
  });
  stub('pipeline-context', {
    ...realContext,
    buildNotesContext: async () => {
      realContext.writeContext(pipeDir, {
        book: 'ISA',
        sources: {},
        runtime: {
          preparedNotes: prepRel,
          alignmentData: `${pipeDir}/alignment_data.json`,
          generatedNotes: `${pipeDir}/generated_notes.json`,
        },
      });
      return { dirPath: pipeDir, contextPath: `${pipeDir}/context.json` };
    },
  });
  stub('check-ult-edits', {
    checkUltEdits: async () => ({ hasEdits: false }),
    buildStaleQuotesHint: () => '',
    recordPostEditReviewContext: () => {},
    findRemainingStaleQuotes: () => null,
  });
  stub('issue-normalizer', {
    normalizeIssuesFile: () => ({
      introSignal: null,
      summary: { kept_parallelism_rows: 0, total_parallelism_rows: 0, kept_parallelism_exceptions: 0, dropped_parallelism_rows: 0 },
    }),
    buildParallelismIntroHintArgs: () => '',
  });
  stub('issue-rules-gate', {
    runIssueRulesGate: async () => ({ ran: false, reason: 'mode_off' }),
    gatePrBodyForPush: () => '',
    refreshGateSidecarOutputHash: () => {},
  });
  stub('workspace-tools/tn-tools', {
    ...realTnTools,
    prepareNotes: ({ output }) => {
      fs.writeFileSync(path.join(tempDir, output), JSON.stringify({
        book: 'ISA', chapter: '38', item_count: items.length, items, intro_rows: introRows,
      }));
      return `Prepared ${items.length} items`;
    },
    flagNarrowQuotes: () => 'flagged 0',
  });
  stub('door43-push', {
    door43Push: async () => { calls.door43Push++; return { success: true, details: 'stub' }; },
    checkConflictingBranches: async () => [],
    REPO_MAP: { tn: 'en_tn' },
    getRepoFilename: () => 'tn_ISA.tsv',
  });
  stub('repo-verify', {
    verifyRepoPush: async () => ({ success: true, details: 'stub' }),
    verifyDcsToken: async () => ({ valid: true }),
    verifyRemoteContent: async () => ({ success: true, details: 'stub' }),
  });
  stub('usage-tracker', {
    recordMetrics: () => {},
    getCumulativeTokens: () => 0,
    recordRunSummary: () => {},
    getAdaptiveSkillGuardrails: () => null,
  });
  stub('pending-merges', { setPendingMerge: () => {} });

  const notesPath = modPath('notes-pipeline');
  saved.set(notesPath, require.cache[notesPath]);
  delete require.cache[notesPath];
  const { notesPipeline } = require(notesPath);

  try {
    await notesPipeline(
      { _synthetic: true, _book: 'ISA', _startChapter: 38, _endChapter: 38, _verseStart: 9, _verseEnd: 12, _kept: KEPT },
      { type: 'private', id: 1, sender_id: 7, sender_email: 'tester@example.org', sender_full_name: 'Tester', content: '' },
    );
  } finally {
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return calls;
}

test('every AI note duplicates a kept note: chapter succeeds as a no-op without a push', async () => {
  const calls = await runHarness({
    items: [
      preparedItem('a111', '38:9', 'rc://*/ta/man/translate/figs-metaphor', 'אֶבֶן'),
      preparedItem('b222', '38:10', 'rc://*/ta/man/translate/figs-idiom', 'שַׁעַר'),
    ],
  });
  assert.ok(
    calls.statuses.some((s) => s.includes('every note in this chapter is already kept in the editor; nothing new to write')),
    `missing no-op status line in:\n${calls.statuses.join('\n')}`,
  );
  assert.equal(calls.door43Push, 0, 'door43Push must not be called');
  assert.equal(calls.runClaude, 0, 'tn-writer / quality check must not run');
  assert.ok(!calls.statuses.some((s) => /failed (at|for)\b/i.test(s)), `unexpected failure status:\n${calls.statuses.join('\n')}`);
  assert.ok(calls.statuses.some((s) => s.includes('1 ok, 0 failed')), `chapter not counted as success:\n${calls.statuses.join('\n')}`);
  assert.ok(calls.replies.some((r) => r.includes('Nothing new to push')), `final reply:\n${calls.replies.join('\n')}`);
});

test('an AI note that is not kept still goes to tn-writer', async () => {
  const calls = await runHarness({
    items: [
      preparedItem('a111', '38:9', 'rc://*/ta/man/translate/figs-metaphor', 'אֶבֶן'),
      preparedItem('c333', '38:11', 'rc://*/ta/man/translate/figs-simile', 'כְּסוּס'),
    ],
  });
  assert.ok(!calls.statuses.some((s) => s.includes('nothing new to write')));
  assert.equal(calls.runClaude, 1, 'tn-writer should run for the remaining note');
});

test('a chapter intro left after the kept drop is still written', async () => {
  const calls = await runHarness({
    items: [preparedItem('a111', '38:9', 'rc://*/ta/man/translate/figs-metaphor', 'אֶבֶן')],
    introRows: [['38:intro', 'i111', '', '', '', '', '# Isaiah 38']],
  });
  assert.ok(!calls.statuses.some((s) => s.includes('nothing new to write')));
  assert.equal(calls.runClaude, 1, 'tn-writer should run to write the intro');
});
