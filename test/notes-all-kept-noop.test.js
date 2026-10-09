// #442: a chapter where every AI note duplicates an editor-kept note must end
// as a successful no-op (status line, no tn-writer, no door43Push) instead of
// failing on an empty notes file at push time.
//
// Decision (#442): the editor's kept notes win. When they cover everything the
// run would write, nothing is pushed and older non-kept AI rows in en_tn are left
// as they are; the chapter still counts as a success.
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

async function runHarness({ items, introRows = [], verseRange = { start: 9, end: 12 }, gateKeptDropped = null, seedCheckpoint = null, content = '' }) {
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
  // Snapshot the whole module cache: the real modules loaded below (and their
  // transitive requires) bind CSKILLBP_DIR to the temp dir at load time, so the
  // original entries are put back, and everything added is dropped, afterwards.
  const cacheBefore = new Map(Object.entries(require.cache));
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
  if (seedCheckpoint) store.set('k', seedCheckpoint);
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
    readGateSidecar: () => (gateKeptDropped ? { keptDropped: gateKeptDropped } : null),
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
      {
        _synthetic: true, _book: 'ISA', _startChapter: 38, _endChapter: 38,
        ...(verseRange ? { _verseStart: verseRange.start, _verseEnd: verseRange.end } : {}),
        _kept: KEPT,
      },
      { type: 'private', id: 1, sender_id: 7, sender_email: 'tester@example.org', sender_full_name: 'Tester', content },
    );
  } finally {
    for (const key of Object.keys(require.cache)) {
      if (!cacheBefore.has(key)) delete require.cache[key];
    }
    for (const [key, entry] of cacheBefore) require.cache[key] = entry;
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
    calls.statuses.some((s) => s.includes('left as is and nothing was pushed for this chapter')),
    `missing no-op status line in:\n${calls.statuses.join('\n')}`,
  );
  assert.equal(calls.door43Push, 0, 'door43Push must not be called');
  assert.equal(calls.runClaude, 0, 'tn-writer / quality check must not run');
  assert.ok(!calls.statuses.some((s) => /failed (at|for)\b/i.test(s)), `unexpected failure status:\n${calls.statuses.join('\n')}`);
  assert.ok(calls.statuses.some((s) => s.includes('1 ok, 0 failed')), `chapter not counted as success:\n${calls.statuses.join('\n')}`);
  assertNothingPushedReply(calls);
});

function assertNothingPushedReply(calls) {
  const done = calls.replies.find((r) => r.includes('Notes pipeline complete'));
  assert.ok(done, `no completion reply in:\n${calls.replies.join('\n')}`);
  assert.ok(done.includes('Nothing was pushed: the editor\'s kept notes were left as is.'), `final reply:\n${done}`);
  assert.ok(!done.includes('Content pushed'), `final reply claims a push:\n${done}`);
  assert.ok(!/already correct/i.test(done), `final reply claims en_tn is correct:\n${done}`);
}

const BOTH_ITEMS = () => [
  preparedItem('a111', '38:9', 'rc://*/ta/man/translate/figs-metaphor', 'אֶבֶן'),
  preparedItem('b222', '38:10', 'rc://*/ta/man/translate/figs-idiom', 'שַׁעַר'),
];

test('whole-chapter run (no verse range) with every note kept: no-op, no push', async () => {
  const calls = await runHarness({ items: BOTH_ITEMS(), verseRange: null, content: '--no-intro' });
  assert.ok(calls.statuses.some((s) => s.includes('left as is and nothing was pushed for this chapter')), calls.statuses.join('\n'));
  assert.equal(calls.door43Push, 0, 'a whole-chapter replace push must not run');
  assert.equal(calls.runClaude, 0);
  assert.ok(calls.statuses.some((s) => s.includes('1 ok, 0 failed')), calls.statuses.join('\n'));
  assertNothingPushedReply(calls);
  assert.ok(!calls.statuses.some((s) => /already correct/i.test(s)), 'status must not claim en_tn is already correct');
});

test('resume: allKeptChapters saved in the checkpoint keeps the final reply truthful', async () => {
  // A resumed run: the earlier part of the run already counted one no-op chapter
  // (totalSuccess 1, allKeptChapters 1) and the resume chapter now ends as a no-op too.
  const seed = { state: 'failed', totalSuccess: 1, totalFail: 1, allKeptChapters: 1, resume: { chapter: 38, skill: null } };
  const calls = await runHarness({ items: BOTH_ITEMS(), seedCheckpoint: seed });
  assert.equal(calls.door43Push, 0);
  assertNothingPushedReply(calls);
  const last = calls.checkpoints.find((c) => c.current && c.current.status === 'chapter_succeeded');
  assert.equal(last.allKeptChapters, 2, 'allKeptChapters is saved in the checkpoint');
});

test('resume: an earlier chapter that did push is not described as nothing pushed', async () => {
  const seed = { state: 'failed', totalSuccess: 1, totalFail: 1, allKeptChapters: 0, resume: { chapter: 38, skill: null } };
  const calls = await runHarness({ items: BOTH_ITEMS(), seedCheckpoint: seed });
  const done = calls.replies.find((r) => r.includes('Notes pipeline complete'));
  assert.ok(done, calls.replies.join('\n'));
  assert.ok(done.includes('Content pushed to master on en_tn'), done);
  assert.ok(done.includes('1 chapter(s) had nothing pushed'), done);
});

// Gate-only: the rules gate (not the kept drop on prepared notes) removed every
// issue row as a duplicate of a kept note, so prepared notes are empty from the start.
const GATE_DROP = (ref, kept = 'k1a2') => ({ line: `ISA\t${ref}\tfigs-metaphor\tx\t\t\tnote`, ref, sref: 'figs-metaphor', kept });

test('gate-only: every issue row dropped as a kept duplicate in this chapter is a no-op', async () => {
  const calls = await runHarness({ items: [], gateKeptDropped: [GATE_DROP('38:9')] });
  assert.ok(calls.statuses.some((s) => s.includes('left as is and nothing was pushed for this chapter')), calls.statuses.join('\n'));
  assert.equal(calls.door43Push, 0);
  assert.equal(calls.runClaude, 0);
  assertNothingPushedReply(calls);
});

test('gate-only, whole chapter: a gate drop anywhere in the chapter counts', async () => {
  const calls = await runHarness({ items: [], verseRange: null, content: '--no-intro', gateKeptDropped: [GATE_DROP('38:20')] });
  assert.ok(calls.statuses.some((s) => s.includes('left as is and nothing was pushed for this chapter')), calls.statuses.join('\n'));
  assert.equal(calls.door43Push, 0);
});

test('gate-only: a gate drop outside the run verse range does not turn the chapter into a no-op', async () => {
  const calls = await runHarness({ items: [], gateKeptDropped: [GATE_DROP('38:20')] });
  assert.ok(!calls.statuses.some((s) => s.includes('nothing was pushed for this chapter')), calls.statuses.join('\n'));
});

test('gate-only: a gate drop for a kept note that is no longer in the list does not count', async () => {
  const calls = await runHarness({ items: [], gateKeptDropped: [GATE_DROP('38:9', 'gone')] });
  assert.ok(!calls.statuses.some((s) => s.includes('nothing was pushed for this chapter')), calls.statuses.join('\n'));
});

test('module cache is restored after a harness run', async () => {
  const p = modPath('pipeline-utils');
  const before = require.cache[p];
  await runHarness({ items: BOTH_ITEMS() });
  assert.equal(require.cache[p], before);
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
