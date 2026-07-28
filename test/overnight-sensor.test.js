const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareCompareTn } = require('../src/workspace-tools/tsv-tools');
const stateLib = require('../src/overnight-review-state');
const watcher = require('../src/overnight-watcher');

const TN_HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';

// --- prepareCompareTn --------------------------------------------------------
test('prepareCompareTn classifies reworded / dropped / added and ignores the ID column', () => {
  const oldTsv = [
    TN_HEADER,
    '1:1\tabc1\t\tfigs-metaphor\tthe LORD\t1\tOld note text',
    '1:2\tabc2\t\tfigs-explicit\tcovenant\t1\tDrop me',
  ].join('\n');
  const newTsv = [
    TN_HEADER,
    '1:1\tZZZ9\t\tfigs-metaphor\tthe LORD\t1\tNew reworded note', // ID changed (ignored), note changed
    '1:3\tabc3\t\ttranslate-names\tBob\t1\tAdded note',
  ].join('\n');
  const r = prepareCompareTn({ oldTsv, newTsv, book: 'PSA' });
  const byType = {};
  for (const c of r.changes) (byType[c.changeType] ||= []).push(c);
  assert.equal(r.summary.reworded, 1);
  assert.equal(r.summary.dropped, 1);
  assert.equal(r.summary.added, 1);
  assert.equal(byType.reworded[0].reference, '1:1');
  assert.equal(byType.dropped[0].reference, '1:2');
  assert.equal(byType.added[0].reference, '1:3');
});

test('prepareCompareTn detects quote-changed when only the Quote moves on a (ref, support) pair', () => {
  const oldTsv = [TN_HEADER, '2:5\ta\t\tfigs-idiom\told quote\t1\tSame note'].join('\n');
  const newTsv = [TN_HEADER, '2:5\tb\t\tfigs-idiom\tnew quote\t1\tSame note'].join('\n');
  const r = prepareCompareTn({ oldTsv, newTsv });
  assert.equal(r.summary['quote-changed'], 1);
  assert.equal(r.changes[0].before.quote, 'old quote');
  assert.equal(r.changes[0].after.quote, 'new quote');
});

test('prepareCompareTn ignores cosmetic (whitespace-only) Note edits', () => {
  const oldTsv = [TN_HEADER, '1:1\ta\t\tfigs-metaphor\tx\t1\tthe  note'].join('\n');
  const newTsv = [TN_HEADER, '1:1\ta\t\tfigs-metaphor\tx\t1\tthe note'].join('\n');
  const r = prepareCompareTn({ oldTsv, newTsv });
  assert.equal(r.summary.total, 0);
});

test('prepareCompareTn restricts to a chapter when asked', () => {
  const oldTsv = [TN_HEADER, '1:1\ta\t\ts\tq\t1\tn1', '2:1\tb\t\ts\tq\t1\tn2'].join('\n');
  const newTsv = [TN_HEADER, '1:1\ta\t\ts\tq\t1\tn1-changed', '2:1\tb\t\ts\tq\t1\tn2-changed'].join('\n');
  const r = prepareCompareTn({ oldTsv, newTsv, chapter: 1 });
  assert.equal(r.summary.total, 1);
  assert.equal(r.changes[0].reference, '1:1');
});

// --- overnight-review-state --------------------------------------------------
test('state cold-start primes all current HEADs and reviews nothing', () => {
  const st = stateLib.defaultState();
  assert.equal(stateLib.isColdStart(st), true);
  const keys = ['en_tn#5@abc', 'en_ult#6@def'];
  stateLib.primeColdStart(st, keys, new Date('2026-06-24T00:00:00Z'));
  assert.equal(st.initialized, true);
  assert.ok(keys.every((k) => stateLib.isReviewed(st, k)));
});

test('state is idempotent on PR id + headSha', () => {
  const st = stateLib.defaultState();
  st.initialized = true;
  const k = stateLib.prUnitKey('en_tn', 5, 'abcdef1234567890');
  assert.equal(stateLib.isReviewed(st, k), false);
  stateLib.markReviewed(st, k);
  assert.equal(stateLib.isReviewed(st, k), true);
  // A new head sha for the same PR is a new unit.
  assert.equal(stateLib.isReviewed(st, stateLib.prUnitKey('en_tn', 5, 'differentsha999')), false);
});

test('loadState falls back to default on missing/garbage', () => {
  assert.equal(stateLib.loadState('/x', () => { throw new Error('enoent'); }).initialized, false);
  assert.equal(stateLib.loadState('/x', () => 'not json').initialized, false);
});

// --- watcher pure helpers ----------------------------------------------------
test('parseBeRef extracts book + editor (incl. numeric-prefixed books) and rejects non-be refs', () => {
  assert.deepEqual(watcher.parseBeRef('PSA-be-pjoakes'), { book: 'PSA', editor: 'pjoakes' });
  assert.deepEqual(watcher.parseBeRef('1KI-be-Grant_Ailie'), { book: '1KI', editor: 'Grant_Ailie' });
  assert.equal(watcher.parseBeRef('main'), null);
  assert.equal(watcher.parseBeRef('ZZZ-be-x'), null); // not a real book
});

test('isBotAuthor filters bot logins, keeps humans', () => {
  assert.equal(watcher.isBotAuthor('deferredreward-bot'), true);
  assert.equal(watcher.isBotAuthor('github-actions[bot]'), true);
  assert.equal(watcher.isBotAuthor(''), true);
  assert.equal(watcher.isBotAuthor('pjoakes'), false);
});

test('file naming helpers', () => {
  assert.equal(watcher.tnFileForBook('psa'), 'tn_PSA.tsv');
  assert.equal(watcher.usfmFileForBook('PSA'), '19-PSA.usfm');
  assert.equal(watcher.usfmFileForBook('1KI'), '11-1KI.usfm');
});

test('changedChaptersFromUsfm reports only chapters whose stripped text differs', () => {
  const oldU = '\\c 1\n\\v 1 the word\n\\c 2\n\\v 1 same\n';
  const newU = '\\c 1\n\\v 1 the changed word\n\\c 2\n\\v 1 same\n';
  assert.deepEqual(watcher.changedChaptersFromUsfm(oldU, newU), [1]);
});

test('rawUrl builds a Gitea raw-by-commit URL', () => {
  assert.equal(
    watcher.rawUrl('en_tn', 'commit/abc123', 'tn_PSA.tsv'),
    'https://git.door43.org/unfoldingWord/en_tn/raw/commit/abc123/tn_PSA.tsv',
  );
});

// --- runOvernightReview (injected HTTP) -------------------------------------
function fakeApiGet(prsByRepo, branchesByRepo) {
  return async (p) => {
    const mPulls = p.match(/\/repos\/unfoldingWord\/([^/]+)\/pulls/);
    if (mPulls) {
      if (/page=1/.test(p)) return { status: 200, data: prsByRepo[mPulls[1]] || [] };
      return { status: 200, data: [] };
    }
    const mBr = p.match(/\/repos\/unfoldingWord\/([^/]+)\/branches/);
    if (mBr) return { status: 200, data: branchesByRepo[mBr[1]] || [] };
    return { status: 404, data: [] };
  };
}

test('runOvernightReview cold-start reviews nothing and writes state', async () => {
  const writes = [];
  const prs = { en_tn: [{ number: 5, merged: true, merged_at: '2026-06-23T10:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'head5' }, base: { sha: 'base5' }, user: { login: 'pjoakes' } }] };
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => { throw new Error('no state'); },
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async () => '',
      log: () => {},
    },
  });
  assert.equal(res.coldStart, true);
  assert.equal(res.reviewed, 0);
  const stateWrite = writes.find((w) => /state\.json$/.test(w.pth));
  assert.ok(stateWrite);
  assert.ok(JSON.parse(stateWrite.content).initialized);
});

test('prepareCompareTn detects an occurrence retarget (Occurrence column not ignored)', () => {
  const oldTsv = ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote', '3:2\ta\t\tfigs-x\tword\t1\tsame note'].join('\n');
  const newTsv = ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote', '3:2\tb\t\tfigs-x\tword\t2\tsame note'].join('\n');
  const r = prepareCompareTn({ oldTsv, newTsv });
  assert.equal(r.summary.total, 1); // occurrence 1 -> 2 is a real change, not "unchanged"
});

test('enumerateUnits derives book+editor from PR files when head.ref is stripped (deleted branch)', async () => {
  const get = async (p) => {
    const repo = (p.match(/repos\/unfoldingWord\/([^/]+)\//) || [])[1];
    if (/\/pulls\/12\/files/.test(p)) return { status: 200, data: [{ filename: 'tn_PSA.tsv' }] };
    if (/\/pulls\?/.test(p)) {
      const data = (repo === 'en_tn' && /page=1/.test(p))
        ? [
            { number: 12, merged: true, merged_at: '2026-06-23T10:00:00Z', head: {}, base: { sha: 'b' }, user: { login: 'pjoakes' } },
            { number: 13, merged: true, merged_at: '2026-06-23T11:00:00Z', head: {}, base: { sha: 'b' }, user: { login: 'randouser' } },
          ]
        : [];
      return { status: 200, data };
    }
    return { status: 200, data: [] };
  };
  const units = await watcher.enumerateUnits({ apiGetImpl: get, sinceIso: '2026-06-20T00:00:00Z', editorMap: { pjoakes: 'pjoakes' } });
  const merged = units.filter((u) => u.kind === 'merged-pr');
  assert.equal(merged.length, 1); // PR 13 by unknown author is skipped
  assert.equal(merged[0].book, 'PSA');
  assert.equal(merged[0].editor, 'pjoakes');
});

test('runOvernightReview throws on a non-200 pulls response (does not silently advance state)', async () => {
  const badGet = async (p) => (/\/pulls\?/.test(p) ? { status: 403, data: { message: 'forbidden' } } : { status: 200, data: [] });
  await assert.rejects(
    () => watcher.runOvernightReview({
      skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
      deps: {
        readFileSync: () => JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} }),
        writeFileSync: () => { throw new Error('should not write on enumeration failure'); },
        mkdirSync: () => {}, editorMap: {}, apiGetImpl: badGet, fetchTextImpl: async () => '', log: () => {},
      },
    }),
    /pulls query failed/,
  );
});

test('runOvernightReview defers a unit on transient fetch failure (not marked reviewed, lastRun held)', async () => {
  const writes = [];
  const initState = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} });
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => initState,
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {}, editorMap: { pjoakes: 'pjoakes' },
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async () => { throw new Error('HTTP 500 for x'); }, // transient (not 404)
      log: () => {},
    },
  });
  assert.equal(res.reviewed, 0);
  assert.equal(res.failed, 1);
  const stateWrite = writes.find((w) => /state\.json$/.test(w.pth));
  const saved = JSON.parse(stateWrite.content);
  assert.equal(Object.keys(saved.reviewed).length, 0); // failed unit NOT recorded
  assert.equal(saved.lastRun, '2026-06-20T00:00:00Z'); // watermark held (not advanced)
});

// --- dry-run state persistence (#OVERNIGHT-STATE) ---------------------------
// A dry run must still persist state (watermark + reviewed keys): dry-run
// means "don't take actions" (don't write the proposal feed), NOT "don't
// remember anything". Gating state.saveState behind `!dryRun` meant every
// dry run cold-started forever — 34 consecutive nightly no-ops.
test('a dry-run cold start still persists state, so a second dry run does not cold-start again', async () => {
  // A path-agnostic single-slot fake "disk": mirrors the style of the other
  // tests in this file (which key off a regex on the path, not the literal
  // string), since path.join produces backslashes on Windows.
  let stateContent = null;
  const readFileSync = (p) => {
    if (/state\.json$/.test(p) && stateContent != null) return stateContent;
    throw new Error('ENOENT');
  };
  const writeFileSync = (p, content) => { if (/state\.json$/.test(p)) stateContent = content; };
  const prs = { en_tn: [{ number: 5, merged: true, merged_at: '2026-06-23T10:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'head5' }, base: { sha: 'base5' }, user: { login: 'pjoakes' } }] };

  const first = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(first.coldStart, true);
  assert.equal(first.genuineFirstRun, true); // no prior state file at all
  assert.equal(first.dryRun, true);
  assert.equal(first.proposalsPath, null); // dry-run still suppresses the proposal feed

  assert.ok(stateContent, 'dry run must still write state.json');
  assert.ok(JSON.parse(stateContent).initialized);

  // A second dry run, reading the now-persisted state, must NOT report a cold
  // start again — this is the exact bug: cold start hid behind "green" forever.
  const second = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-25T07:00:00Z'), dryRun: true,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {},
      apiGetImpl: fakeApiGet({}, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(second.coldStart, false);
});

// Rewritten for #OVERNIGHT-FEED: the previous version of this test asserted
// that a dry run advances the watermark WITHOUT writing the proposal feed.
// That is exactly the bug the finding caught — combined with the watermark
// now always advancing (the prior fix), suppressing the feed on a dry run
// meant proposals were computed, the units were marked reviewed, and then the
// proposals describing them were thrown away, permanently. The feed is a file
// for downstream automation to read (same category as state.json), not an
// action, so it is no longer gated on dryRun. This test now asserts the new
// contract: a dry run writes the feed exactly like a live run.
test('a dry run writes the proposal feed and advances the reviewed watermark, same as a live run', async () => {
  let stateContent = JSON.stringify({
    version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {},
  });
  const writes = [];
  const readFileSync = (p) => { if (/state\.json$/.test(p)) return stateContent; throw new Error('ENOENT'); };
  const writeFileSync = (p, content) => {
    if (/state\.json$/.test(p)) stateContent = content;
    writes.push({ pth: p, content });
  };
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };

  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(res.coldStart, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.reviewed, 1);
  assert.ok(res.proposalsPath, 'dry run must still write the proposal feed path'); // no longer suppressed
  assert.ok(res.tasksPath, 'dry run must still write the review-task feed path');

  const proposalsWrite = writes.find((w) => /proposals\.jsonl$/.test(w.pth));
  assert.ok(proposalsWrite, 'proposals.jsonl must actually be written on a dry run');
  const tasksWrite = writes.find((w) => /review-tasks\.jsonl$/.test(w.pth));
  assert.ok(tasksWrite, 'review-tasks.jsonl must actually be written on a dry run');

  const saved = JSON.parse(stateContent);
  assert.equal(saved.lastRun, '2026-06-24T07:00:00.000Z'); // watermark advanced
  assert.ok(Object.keys(saved.reviewed).some((k) => k.startsWith('en_tn#9@')));
});

// New: the invariant this finding introduced. If persisting the feed fails,
// the reviewed-set/watermark must NOT advance — otherwise the unit is marked
// seen while its proposal is lost, with no way to recover it.
test('if the proposal feed write throws, the reviewed-set/watermark is NOT advanced (unit stays fresh next run)', async () => {
  const initState = JSON.stringify({
    version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {},
  });
  let stateContent = initState;
  const readFileSync = (p) => { if (/state\.json$/.test(p)) return stateContent; throw new Error('ENOENT'); };
  const writeFileSync = (p, content) => {
    if (/proposals\.jsonl$/.test(p)) throw new Error('disk full');
    if (/state\.json$/.test(p)) stateContent = content;
  };
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };

  await assert.rejects(
    () => watcher.runOvernightReview({
      skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
      deps: {
        readFileSync, writeFileSync, mkdirSync: () => {},
        apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
      },
    }),
    /disk full/,
  );

  // state.json must be exactly as it was before the run — not advanced.
  assert.equal(stateContent, initState);
  const saved = JSON.parse(stateContent);
  assert.equal(saved.lastRun, '2026-06-20T00:00:00Z');
  assert.equal(Object.keys(saved.reviewed).length, 0);

  // A subsequent run (state genuinely unchanged) must still see the unit as fresh.
  const second = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-25T07:00:00Z'),
    deps: {
      readFileSync: () => stateContent,
      writeFileSync: (p, content) => { if (/state\.json$/.test(p)) stateContent = content; },
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(second.reviewed, 1); // still fresh, not silently skipped
});

test('a genuine first-ever run (no prior state at all) is reported distinctly from an anomalous cold start', async () => {
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => { throw new Error('ENOENT'); },
      writeFileSync: () => {},
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet({}, {}),
      fetchTextImpl: async () => '',
      log: () => {},
    },
  });
  assert.equal(res.coldStart, true);
  assert.equal(res.genuineFirstRun, true);
});

// --- cold-start visibility / escape hatch (#OVERNIGHT-COLDSTART-VISIBILITY) -
// Priming on cold start is correct by design, but it discards the enumerated
// units silently. These tests cover: (1) the default (priming) path reports
// how many units it skipped and logs enough detail to identify them, and (2)
// the opt-in reviewColdStart flag reviews the units and writes the feed
// instead of priming, while (3) confirming the default remains priming.
test('a default cold start reports the skipped count/keys and logs them loudly', async () => {
  const logs = [];
  const prs = { en_tn: [{ number: 5, merged: true, merged_at: '2026-06-23T10:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'head5' }, base: { sha: 'base5' }, user: { login: 'pjoakes' } }] };
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => { throw new Error('no state'); },
      writeFileSync: () => {},
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async () => '',
      log: (m) => logs.push(m),
    },
  });
  assert.equal(res.coldStart, true);
  assert.equal(res.skipped, 1);
  assert.ok(Array.isArray(res.skippedSample) && res.skippedSample.length === 1);
  assert.ok(res.skippedSample[0].startsWith('en_tn#5@'));
  // The log line itself must carry the count and the identifying key(s) —
  // this is what makes the digest legible instead of a bare "cold start".
  const line = logs.find((l) => /COLD START/.test(l));
  assert.ok(line, 'expected a COLD START log line');
  assert.match(line, /SKIPPING 1 unit/);
  assert.match(line, /en_tn#5@/);
  assert.match(line, /OVERNIGHT_REVIEW_COLD_START/);
});

test('reviewColdStart=true on a cold start reviews the enumerated units and writes the feed instead of priming', async () => {
  const writes = [];
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };
  const oldTsv = [TN_HEADER, '1:1\ta\t\tfigs-metaphor\tx\t1\told note'].join('\n');
  const newTsv = [TN_HEADER, '1:1\tb\t\tfigs-metaphor\tx\t1\trewritten note'].join('\n');
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), reviewColdStart: true,
    deps: {
      readFileSync: () => { throw new Error('no state'); }, // genuine cold start
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async (url) => (/commit\/oldbase/.test(url) ? oldTsv : (/commit\/newhead/.test(url) ? newTsv : '')),
      log: () => {},
    },
  });
  // Not reported as a (priming) cold start — it was reviewed instead.
  assert.equal(res.coldStart, false);
  assert.equal(res.coldStartReviewed, true);
  assert.equal(res.reviewed, 1);
  assert.equal(res.proposals, 1);
  const proposalsWrite = writes.find((w) => /proposals\.jsonl$/.test(w.pth));
  assert.ok(proposalsWrite, 'the feed must be written, not skipped, when reviewColdStart is set');
  const row = JSON.parse(proposalsWrite.content.trim());
  assert.equal(row.category, 'reworded');

  const stateWrite = writes.find((w) => /state\.json$/.test(w.pth));
  const saved = JSON.parse(stateWrite.content);
  assert.equal(saved.initialized, true); // future runs won't cold-start again
  assert.ok(Object.keys(saved.reviewed).some((k) => k.startsWith('en_tn#9@')));
  assert.equal(saved.lastRun, '2026-06-24T07:00:00.000Z');
});

test('the default (reviewColdStart omitted) on a cold start still primes, not reviews', async () => {
  const writes = [];
  const prs = { en_tn: [{ number: 5, merged: true, merged_at: '2026-06-23T10:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'head5' }, base: { sha: 'base5' }, user: { login: 'pjoakes' } }] };
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => { throw new Error('no state'); },
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async () => '',
      log: () => {},
    },
  });
  assert.equal(res.coldStart, true);
  assert.equal(res.reviewed, 0);
  assert.equal(res.proposalsPath, null);
  const proposalsWrite = writes.find((w) => /proposals\.jsonl$/.test(w.pth));
  assert.equal(proposalsWrite, undefined, 'no feed should be written when priming (default)');
});

test('runOvernightReview reviews a fresh merged TN PR and emits proposals', async () => {
  const writes = [];
  const initState = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} });
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };
  const oldTsv = [TN_HEADER, '1:1\ta\t\tfigs-metaphor\tx\t1\told note'].join('\n');
  const newTsv = [TN_HEADER, '1:1\tb\t\tfigs-metaphor\tx\t1\trewritten note'].join('\n');
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'),
    deps: {
      readFileSync: () => initState,
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}),
      fetchTextImpl: async (url) => (/commit\/oldbase/.test(url) ? oldTsv : (/commit\/newhead/.test(url) ? newTsv : '')),
      log: () => {},
    },
  });
  assert.equal(res.coldStart, false);
  assert.equal(res.reviewed, 1);
  assert.equal(res.proposals, 1);
  const proposalsWrite = writes.find((w) => /proposals\.jsonl$/.test(w.pth));
  assert.ok(proposalsWrite);
  const row = JSON.parse(proposalsWrite.content.trim());
  assert.equal(row.resource, 'tn');
  assert.equal(row.category, 'reworded');
  assert.equal(row.editor, 'pjoakes');
  assert.equal(row.book, 'PSA');
});

// --- #OVERNIGHT-BOUNDED: per-run work cap (#304) -----------------------------
// The cold-start escape hatch added in #303 OOMed (exit 134, V8 heap limit
// ~255 MB on the 512 MB Fly machine) the first time it was pointed at a real
// ~5-week backlog: it reviewed every enumerated unit in one process, fetching
// and diffing a full USFM/TSV body per unit. The fix bounds units per run and
// defers the rest, which is only safe if the watermark is HELD whenever
// anything was deferred — otherwise the deferred units fall outside the next
// run's window and are lost silently, which is the very bug #303 fixed.
function manyTnPrs(books) {
  return books.map((book, i) => ({
    number: 100 + i,
    merged: true,
    merged_at: `2026-06-2${(i % 3) + 1}T10:00:00Z`,
    head: { ref: `${book}-be-pjoakes`, sha: `head${i}` },
    base: { sha: `base${i}` },
    user: { login: 'pjoakes' },
  }));
}

const BOUNDED_BOOKS = ['PSA', 'GEN', 'EXO', 'LEV', 'NUM'];

test('the per-run cap bounds units reviewed and HOLDS the watermark for the deferred remainder', async () => {
  let stateContent = JSON.stringify({
    version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {},
  });
  const readFileSync = (p) => { if (/state\.json$/.test(p)) return stateContent; throw new Error('ENOENT'); };
  const writeFileSync = (p, content) => { if (/state\.json$/.test(p)) stateContent = content; };

  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), maxUnitsPerRun: 2,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {}, editorMap: { pjoakes: 'pjoakes' },
      apiGetImpl: fakeApiGet({ en_tn: manyTnPrs(BOUNDED_BOOKS) }, {}),
      fetchTextImpl: async () => '', log: () => {},
    },
  });

  assert.equal(res.fresh, 5);
  assert.equal(res.cap, 2);
  assert.equal(res.reviewed, 2);
  assert.equal(res.deferred, 3);

  const saved = JSON.parse(stateContent);
  assert.equal(Object.keys(saved.reviewed).length, 2, 'only the reviewed batch is recorded');
  // THE critical assertion: a capped run must not advance lastRun, or the 3
  // deferred units fall outside the next window and are never reviewed.
  assert.equal(saved.lastRun, '2026-06-20T00:00:00Z');
});

test('successive runs drain a cold-start backlog incrementally and only advance the watermark once complete', async () => {
  let stateContent = null;
  const readFileSync = (p) => {
    if (/state\.json$/.test(p) && stateContent != null) return stateContent;
    throw new Error('ENOENT');
  };
  const writeFileSync = (p, content) => { if (/state\.json$/.test(p)) stateContent = content; };
  const prs = { en_tn: manyTnPrs(BOUNDED_BOOKS) };

  const runOnce = (day, opts = {}) => watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date(`2026-06-2${day}T07:00:00Z`), maxUnitsPerRun: 2, ...opts,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {}, editorMap: { pjoakes: 'pjoakes' },
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });

  // Run 1: the operator's opt-in cold-start review. Bounded, not primed.
  const first = await runOnce(4, { reviewColdStart: true });
  assert.equal(first.coldStartReviewed, true);
  assert.equal(first.reviewed, 2);
  assert.equal(first.deferred, 3);
  assert.equal(JSON.parse(stateContent).lastRun, null, 'watermark held while the backlog drains');

  // Runs 2 and 3 need NO flag: state is initialized but lastRun is still null,
  // so enumeration is unwindowed and the unreviewed remainder is still fresh.
  const second = await runOnce(5);
  assert.equal(second.coldStart, false);
  assert.equal(second.reviewed, 2);
  assert.equal(second.deferred, 1);
  assert.equal(JSON.parse(stateContent).lastRun, null);

  const third = await runOnce(6);
  assert.equal(third.reviewed, 1);
  assert.equal(third.deferred, 0, 'backlog drained');

  const saved = JSON.parse(stateContent);
  assert.equal(Object.keys(saved.reviewed).length, 5, 'every backlog unit was eventually reviewed, none lost');
  // Only now, with nothing deferred, may the watermark advance.
  assert.equal(saved.lastRun, new Date('2026-06-26T07:00:00Z').toISOString());
});

test('maxUnitsPerRun=0 disables the cap (opt-out for a host with memory to spare)', async () => {
  let stateContent = JSON.stringify({
    version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {},
  });
  const readFileSync = (p) => { if (/state\.json$/.test(p)) return stateContent; throw new Error('ENOENT'); };
  const writeFileSync = (p, content) => { if (/state\.json$/.test(p)) stateContent = content; };

  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), maxUnitsPerRun: 0,
    deps: {
      readFileSync, writeFileSync, mkdirSync: () => {}, editorMap: { pjoakes: 'pjoakes' },
      apiGetImpl: fakeApiGet({ en_tn: manyTnPrs(BOUNDED_BOOKS) }, {}),
      fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(res.reviewed, 5);
  assert.equal(res.deferred, 0);
  assert.equal(JSON.parse(stateContent).lastRun, new Date('2026-06-24T07:00:00Z').toISOString());
});

test('the default per-run cap is a sane positive bound (the unbounded default is what OOMed)', () => {
  assert.ok(Number.isFinite(watcher.DEFAULT_MAX_UNITS_PER_RUN));
  assert.ok(watcher.DEFAULT_MAX_UNITS_PER_RUN > 0);
});

// #OVERNIGHT-BOUNDED-MEM: detaching note/quote from the parent TSV buffer must
// not change the emitted proposal content — capping units is useless if each
// retained row still pins the whole decoded response body, but the fix is only
// acceptable if the feed the Dreamer reads is byte-identical.
test('detaching retained strings preserves proposal content exactly', () => {
  const compare = prepareCompareTn({
    oldTsv: [TN_HEADER, '3:2\ta\t\tfigs-metaphor\tthe LORD\t1\told note text'].join('\n'),
    newTsv: [TN_HEADER, '3:2\ta\t\tfigs-metaphor\tthe LORD\t1\tnew note text'].join('\n'),
  });
  const rows = watcher.tnChangesToProposals(compare, {
    repo: 'en_tn', book: 'PSA', editor: 'pjoakes', prId: 7, headSha: 'abc',
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.reference, '3:2');
  assert.equal(r.chapter, '3');
  assert.equal(r.verse, '2');
  assert.equal(r.supportReference, 'figs-metaphor');
  assert.equal(r.key, 'figs-metaphor');
  assert.equal(r.before.note, 'old note text');
  assert.equal(r.after.note, 'new note text');
  assert.equal(r.before.quote, 'the LORD');
  assert.equal(r.text, 'editor pjoakes reworded TN note at 3:2 (figs-metaphor)');
});
