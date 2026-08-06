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

// --- state file location (#OVERNIGHT-STATE-LOCATION, issue #305) -------------
// The watermark must NOT live inside the bp-assistant-skills checkout. Dry-run
// mode writes it on the volume's checkout (untracked); PR mode runs in a
// worktree and commits its output. If both wrote the in-repo path, the first
// commit of state.json to main would make the volume's untracked copy block
// `git pull --ff-only` on EVERY hourly wake, for every run mode.
const BOT_HOME = '/data/bp-bot';
const VOLUME_STATE = require('node:path').join(BOT_HOME, 'overnight-review-state.json');
const LEGACY_STATE = require('node:path').join('/skills', 'data/overnight-review/state.json');

test('resolveStateFile puts state on the volume in BOTH modes, never inside the skills checkout', () => {
  const dry = stateLib.resolveStateFile({ skillsRepo: '/skills', env: { BP_BOT_HOME: BOT_HOME } });
  const pr = stateLib.resolveStateFile({ skillsRepo: '/skills/../worktrees/overnight-1', env: { BP_BOT_HOME: BOT_HOME } });
  assert.equal(dry.stateFile, VOLUME_STATE);
  assert.equal(pr.stateFile, VOLUME_STATE); // mode-independent: same file, no collision possible
  assert.equal(dry.legacyStateFile, LEGACY_STATE);
});

test('resolveStateFile honours an explicit OVERNIGHT_STATE_FILE override, and falls back in-repo with no env', () => {
  assert.equal(
    stateLib.resolveStateFile({ skillsRepo: '/skills', env: { OVERNIGHT_STATE_FILE: '/tmp/x.json', BP_BOT_HOME: BOT_HOME } }).stateFile,
    '/tmp/x.json',
  );
  const bare = stateLib.resolveStateFile({ skillsRepo: '/skills', env: {} });
  assert.equal(bare.stateFile, LEGACY_STATE);
  assert.equal(bare.legacyStateFile, null); // nothing to migrate from when it IS the legacy path
});

test('a dry run writes state to the volume path, not into the skills checkout', async () => {
  const writes = [];
  const initState = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} });
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };

  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      env: { BP_BOT_HOME: BOT_HOME },
      readFileSync: (p) => { if (p === VOLUME_STATE) return initState; throw new Error('ENOENT'); },
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {}, unlinkSync: (p) => { throw new Error(`unexpected unlink of ${p}`); },
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(res.reviewed, 1);
  const stateWrites = writes.filter((w) => /state\.json$/.test(w.pth));
  assert.equal(stateWrites.length, 1);
  assert.equal(stateWrites[0].pth, VOLUME_STATE);
  assert.ok(!writes.some((w) => w.pth === LEGACY_STATE), 'must never write the in-repo state path');
  // The feed still belongs to the checkout — only the watermark moved.
  const feedWrite = writes.find((w) => /proposals\.jsonl$/.test(w.pth));
  assert.ok(feedWrite && feedWrite.pth.startsWith(require('node:path').join('/skills', 'data/overnight-review')));
});

test('an existing in-repo state file is migrated to the volume (watermark kept, no cold start) and the legacy file removed', async () => {
  const legacyContent = JSON.stringify({
    version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z',
    reviewed: { 'en_tn#9@newhead': '2026-06-20T00:00:00Z' }, branchTips: {},
  });
  const disk = { [LEGACY_STATE]: legacyContent };
  const unlinked = [];
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };

  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      env: { BP_BOT_HOME: BOT_HOME },
      readFileSync: (p) => { if (disk[p] != null) return disk[p]; throw new Error('ENOENT'); },
      writeFileSync: (p, content) => { disk[p] = content; },
      mkdirSync: () => {},
      renameSync: (from, to) => { disk[to] = disk[from]; delete disk[from]; },
      unlinkSync: (p) => { unlinked.push(p); delete disk[p]; },
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });

  assert.equal(res.coldStart, false, 'the migrated watermark must prevent a cold start');
  assert.equal(res.reviewed, 0, 'the already-reviewed unit stays reviewed after migration');
  assert.deepEqual(unlinked, [LEGACY_STATE]); // deliberate: an untracked file left there is the #305 hazard
  assert.equal(disk[LEGACY_STATE], undefined);
  const migrated = JSON.parse(disk[VOLUME_STATE]);
  assert.ok(migrated.reviewed['en_tn#9@newhead'], 'reviewed-set survived the move');
});

test('migration is a one-shot: an existing volume state file is never overwritten by the legacy one', () => {
  const disk = { [VOLUME_STATE]: '{"version":1,"reviewed":{"newer":"x"}}', [LEGACY_STATE]: '{"version":1,"reviewed":{"older":"x"}}' };
  const unlinked = [];
  const moved = stateLib.migrateLegacyStateFile(VOLUME_STATE, LEGACY_STATE, {
    readImpl: (p) => { if (disk[p] != null) return disk[p]; throw new Error('ENOENT'); },
    writeImpl: (p, c) => { disk[p] = c; },
    mkdirImpl: () => {}, renameImpl: () => { throw new Error('rename must not be reached'); },
    unlinkImpl: (p) => unlinked.push(p),
  });
  assert.equal(moved, 'noop');
  assert.equal(disk[VOLUME_STATE], '{"version":1,"reviewed":{"newer":"x"}}'); // never overwritten by the older copy
  // …but the stale in-repo copy is still cleared out: leaving an untracked file
  // at that path is the #305 hazard, and the live watermark is the one at
  // VOLUME_STATE, so the legacy one is stale by definition.
  assert.deepEqual(unlinked, [LEGACY_STATE]);
});

test('feed-before-state ordering still holds with state on the volume: a failed feed write leaves the volume watermark untouched', async () => {
  const initState = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} });
  const disk = { [VOLUME_STATE]: initState };
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };

  await assert.rejects(
    () => watcher.runOvernightReview({
      skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
      deps: {
        env: { BP_BOT_HOME: BOT_HOME },
        readFileSync: (p) => { if (disk[p] != null) return disk[p]; throw new Error('ENOENT'); },
        writeFileSync: (p, content) => { if (/proposals\.jsonl$/.test(p)) throw new Error('disk full'); disk[p] = content; },
        mkdirSync: () => {}, unlinkSync: () => {},
        apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
      },
    }),
    /disk full/,
  );
  assert.equal(disk[VOLUME_STATE], initState); // watermark unadvanced → unit retried next run
});

// Migration hardening: the failure modes that lose a watermark. A run killed
// mid-write leaves a truncated destination; if "a file exists there" counted as
// "already migrated", the real watermark would be stranded at the legacy path
// forever and the whole backlog primed away on the next cold start.
test('a truncated/corrupt file at the new path does not count as migrated — the legacy watermark is recovered', () => {
  const disk = { [VOLUME_STATE]: '{"version":1,"initial', [LEGACY_STATE]: '{"version":1,"initialized":true,"lastRun":"2026-06-20T00:00:00Z","reviewed":{},"branchTips":{}}' };
  const unlinked = [];
  const moved = stateLib.migrateLegacyStateFile(VOLUME_STATE, LEGACY_STATE, {
    readImpl: (p) => { if (disk[p] != null) return disk[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeImpl: (p, c) => { disk[p] = c; },
    mkdirImpl: () => {},
    renameImpl: (from, to) => { disk[to] = disk[from]; delete disk[from]; },
    unlinkImpl: (p) => { unlinked.push(p); delete disk[p]; },
  });
  assert.equal(moved, 'migrated');
  assert.equal(JSON.parse(disk[VOLUME_STATE]).lastRun, '2026-06-20T00:00:00Z');
  assert.deepEqual(unlinked, [LEGACY_STATE]);
  assert.equal(disk[`${VOLUME_STATE}.tmp`], undefined, 'the tmp sibling must not be left behind');
});

test('a corrupt legacy state file is left alone rather than migrated and deleted', () => {
  const disk = { [LEGACY_STATE]: '{"version":1,"revi' };
  const unlinked = [];
  const logs = [];
  const moved = stateLib.migrateLegacyStateFile(VOLUME_STATE, LEGACY_STATE, {
    readImpl: (p) => { if (disk[p] != null) return disk[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeImpl: (p, c) => { disk[p] = c; },
    mkdirImpl: () => {}, renameImpl: () => {},
    unlinkImpl: (p) => unlinked.push(p),
    log: (m) => logs.push(m),
  });
  assert.equal(moved, 'blocked');
  assert.deepEqual(unlinked, []); // the only copy of a damaged watermark survives for inspection
  assert.ok(disk[LEGACY_STATE]);
  assert.ok(logs.some((m) => /does not parse as state/.test(m)));
});

test('a non-ENOENT read failure on the legacy path is logged, not swallowed into a silent cold start', () => {
  const logs = [];
  const moved = stateLib.migrateLegacyStateFile(VOLUME_STATE, LEGACY_STATE, {
    readImpl: (p) => { const e = new Error('permission denied'); e.code = p === LEGACY_STATE ? 'EACCES' : 'ENOENT'; throw e; },
    writeImpl: () => { throw new Error('should not write'); },
    mkdirImpl: () => {}, renameImpl: () => {}, unlinkImpl: () => { throw new Error('should not unlink'); },
    log: (m) => logs.push(m),
  });
  assert.equal(moved, 'blocked');
  assert.ok(logs.some((m) => /EACCES/.test(m) && /NOT migrating/.test(m)));
});

test('resolveStateFile warns when it falls back to the in-repo path (the #305 hazard, silently reintroduced)', () => {
  const logs = [];
  stateLib.resolveStateFile({ skillsRepo: '/skills', env: {}, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /falling back to the legacy in-repo state path/.test(m)));
});

// The tests above all inject fake filesystems, which cannot represent a partial
// write or a real errno. This one drives the migration against real fs in a
// tmpdir, end to end.
test('migration works against a real filesystem: file moves, contents match, legacy path is gone', () => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'overnight-state-'));
  try {
    const skills = nodePath.join(root, 'skills');
    const home = nodePath.join(root, 'bot-home');
    const legacy = nodePath.join(skills, 'data/overnight-review/state.json');
    nodeFs.mkdirSync(nodePath.dirname(legacy), { recursive: true });
    const content = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: { 'en_tn#1@abc': 'x' }, branchTips: {} });
    nodeFs.writeFileSync(legacy, content);

    const resolved = stateLib.resolveStateFile({ skillsRepo: skills, env: { BP_BOT_HOME: home } });
    assert.equal(resolved.stateFile, nodePath.join(home, 'overnight-review-state.json'));
    assert.equal(stateLib.migrateLegacyStateFile(resolved.stateFile, resolved.legacyStateFile), 'migrated');

    assert.equal(nodeFs.existsSync(legacy), false, 'legacy file must be gone — leaving it is the #305 hazard');
    assert.equal(nodeFs.readFileSync(resolved.stateFile, 'utf8'), content);
    assert.equal(nodeFs.existsSync(`${resolved.stateFile}.tmp`), false);
    // Idempotent: a second call is a no-op, and loadState reads the watermark.
    assert.equal(stateLib.migrateLegacyStateFile(resolved.stateFile, resolved.legacyStateFile), 'noop');
    assert.equal(stateLib.loadState(resolved.stateFile).lastRun, '2026-06-20T00:00:00Z');
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

// The composition the cold review caught: migration declines (legacy file
// unreadable/corrupt), so nothing lands at the new path, so the run would
// cold-start, prime the whole enumerated backlog as already-seen —
// irreversibly — and report it as a confident "genuine first run". Fail the
// run instead: nothing is persisted and the next run retries.
test('a blocked migration aborts the run instead of cold-starting and priming the backlog away', async () => {
  const writes = [];
  const prs = { en_tn: [{ number: 9, merged: true, merged_at: '2026-06-23T22:00:00Z', head: { ref: 'PSA-be-pjoakes', sha: 'newhead' }, base: { sha: 'oldbase' }, user: { login: 'pjoakes' } }] };
  const run = (legacyRead) => watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      env: { BP_BOT_HOME: BOT_HOME },
      readFileSync: (p) => { if (p === LEGACY_STATE) return legacyRead(); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {}, renameSync: () => {}, unlinkSync: () => {},
      apiGetImpl: fakeApiGet(prs, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });

  // (a) legacy unreadable for a reason that is not "absent"
  await assert.rejects(
    () => run(() => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; }),
    /refusing to run/,
  );
  // (b) legacy present but corrupt
  await assert.rejects(() => run(() => '{"version":1,"revi'), /refusing to run/);

  assert.deepEqual(writes, [], 'a blocked run must persist nothing at all — no state, no primed watermark');
});

test('a missing legacy file is NOT blocked — a genuine first run still cold-starts normally', async () => {
  const writes = [];
  const res = await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      env: { BP_BOT_HOME: BOT_HOME },
      readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      writeFileSync: (pth, content) => writes.push({ pth, content }),
      mkdirSync: () => {}, renameSync: () => {}, unlinkSync: () => {},
      apiGetImpl: fakeApiGet({}, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.equal(res.coldStart, true);
  assert.equal(res.genuineFirstRun, true);
  assert.equal(writes.find((w) => /state\.json$/.test(w.pth)).pth, VOLUME_STATE);
});

test('a stale legacy file left in the checkout is cleaned up even when the volume state is already good', async () => {
  const goodState = JSON.stringify({ version: 1, initialized: true, lastRun: '2026-06-20T00:00:00Z', reviewed: {}, branchTips: {} });
  const disk = { [VOLUME_STATE]: goodState, [LEGACY_STATE]: '{"version":1,"stale":true}' };
  const unlinked = [];
  await watcher.runOvernightReview({
    skillsRepo: '/skills', now: new Date('2026-06-24T07:00:00Z'), dryRun: true,
    deps: {
      env: { BP_BOT_HOME: BOT_HOME },
      readFileSync: (p) => { if (disk[p] != null) return disk[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      writeFileSync: (p, c) => { disk[p] = c; },
      mkdirSync: () => {}, renameSync: () => {},
      unlinkSync: (p) => { unlinked.push(p); delete disk[p]; },
      apiGetImpl: fakeApiGet({}, {}), fetchTextImpl: async () => '', log: () => {},
    },
  });
  assert.deepEqual(unlinked, [LEGACY_STATE]);
  assert.equal(JSON.parse(disk[VOLUME_STATE]).lastRun, '2026-06-24T07:00:00.000Z'); // live watermark untouched by the cleanup
});
