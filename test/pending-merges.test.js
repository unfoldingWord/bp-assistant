const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Hermetic on-disk store — point the module at a temp dir before requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-merges-test-'));
process.env.PENDING_MERGES_DIR = TMP;

const {
  setPendingMerge,
  getPendingMerge,
  clearPendingMerge,
  getAllPendingMerges,
  getPendingMergesForSession,
} = require('../src/pending-merges');

// All API-triggered runs share one Zulip control thread, so they share one
// sessionKey. The store must key per-RUN (sessionKey + scope) so concurrent
// different-scope runs don't overwrite each other's deferred-insert record.
const SHARED_SESSION = 'stream-81 English Book Packages-Bot testing';

function record(key, book, startChapter, endChapter, pipelineType = 'notes') {
  return { key, sessionKey: SHARED_SESSION, pipelineType, username: 'u', book, startChapter, endChapter };
}

test('two runs sharing one session key persist independently (no clobber)', () => {
  const kGen = `${SHARED_SESSION}__notes__GEN_1_1_na_na`;
  const kZec = `${SHARED_SESSION}__notes__ZEC_7_7_na_na`;

  setPendingMerge(kGen, record(kGen, 'GEN', 1, 1));
  setPendingMerge(kZec, record(kZec, 'ZEC', 7, 7));

  assert.ok(getPendingMerge(kGen), 'GEN record survived the second write');
  assert.ok(getPendingMerge(kZec), 'ZEC record survived');
  assert.equal(getPendingMerge(kGen).book, 'GEN');
  assert.equal(getPendingMerge(kZec).book, 'ZEC');

  const forSession = getPendingMergesForSession(SHARED_SESSION);
  assert.equal(forSession.length, 2, 'both runs are visible under the shared session');

  // Resolving one (e.g. via "merge ZEC 7") must not touch the other.
  clearPendingMerge(kZec);
  assert.equal(getPendingMerge(kZec), null);
  assert.ok(getPendingMerge(kGen), 'clearing ZEC left GEN intact');
  assert.equal(getPendingMergesForSession(SHARED_SESSION).length, 1);

  clearPendingMerge(kGen);
  assert.equal(getPendingMergesForSession(SHARED_SESSION).length, 0);
});

test('getPendingMergesForSession isolates by session key', () => {
  const kA = 'stream-A-topic__notes__GEN_1_1_na_na';
  const kB = 'stream-B-topic__notes__GEN_1_1_na_na';
  setPendingMerge(kA, { key: kA, sessionKey: 'stream-A-topic', pipelineType: 'notes', book: 'GEN', startChapter: 1, endChapter: 1 });
  setPendingMerge(kB, { key: kB, sessionKey: 'stream-B-topic', pipelineType: 'notes', book: 'GEN', startChapter: 1, endChapter: 1 });

  assert.equal(getPendingMergesForSession('stream-A-topic').length, 1);
  assert.equal(getPendingMergesForSession('stream-B-topic').length, 1);
  assert.equal(getPendingMergesForSession('stream-A-topic')[0].key, kA);

  clearPendingMerge(kA);
  clearPendingMerge(kB);
});

test('getAllPendingMerges round-trips stored fields', () => {
  const k = `${SHARED_SESSION}__generate__PSA_79_80_na_na`;
  setPendingMerge(k, record(k, 'PSA', 79, 80, 'generate'));
  const all = getAllPendingMerges();
  const found = all.find((pm) => pm.key === k);
  assert.ok(found, 'record present in getAllPendingMerges');
  assert.equal(found.pipelineType, 'generate');
  assert.equal(found.endChapter, 80);
  clearPendingMerge(k);
});
