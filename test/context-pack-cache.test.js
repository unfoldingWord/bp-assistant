// context-pack-cache — getContextPackCached's sha-pinned caching, coalescing,
// branch→sha memoization, and local-dir bypass.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getContextPackCached, loadQuickPack, _resetForTests, BRANCH_SHA_TTL_MS, MAX_ENTRIES, _cacheSizesForTests,
} = require('../src/lib/quick-context');
const { MAX_PACK_FILE_BYTES } = require('../src/lib/context-pack');

function writeFixturePack(dir) {
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'terminology'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'format: 1\nlanguage: ar\ndirection: rtl\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Brief text.');
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quick-context-'));
}

function fakeFetch(hits, { branchSha } = {}) {
  return async (url) => {
    hits.push(url);
    if (/\/api\/v1\/repos\/.+\/branches\//.test(url)) {
      if (!branchSha) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({ commit: { id: branchSha } }) };
    }
    if (/manifest\.yaml$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'format: 1\nlanguage: ar\ndirection: rtl\n' };
    }
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'Brief text.' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('sha-pinned ref: second call for the same sha makes zero fetches', async () => {
  _resetForTests();
  const sha = 'a'.repeat(40);
  const hits = [];
  const fetchImpl = fakeFetch(hits);
  const ref = `BSOJ/translation-context@${sha}`;

  const first = await getContextPackCached(ref, { fetchImpl });
  assert.equal(first.hasContent, true);
  const hitsAfterFirst = hits.length;
  assert.ok(hitsAfterFirst > 0);

  const second = await getContextPackCached(ref, { fetchImpl });
  assert.equal(second, first, 'second call should return the same cached pack');
  assert.equal(hits.length, hitsAfterFirst, 'no new fetches for the cached sha');
});

test('concurrent calls for the same sha coalesce onto one fetch', async () => {
  _resetForTests();
  const sha = 'b'.repeat(40);
  const hits = [];
  const fetchImpl = fakeFetch(hits);
  const ref = `BSOJ/translation-context@${sha}`;

  const [a, b, c] = await Promise.all([
    getContextPackCached(ref, { fetchImpl }),
    getContextPackCached(ref, { fetchImpl }),
    getContextPackCached(ref, { fetchImpl }),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  // manifest.yaml + brief.md + the rest of PACK_FILES = one fetch each, once.
  const manifestHits = hits.filter((u) => /manifest\.yaml$/.test(u));
  assert.equal(manifestHits.length, 1, 'manifest.yaml should be fetched exactly once');
});

test('branch ref resolves and caches under the resolved sha; TTL forces re-resolve', async () => {
  _resetForTests();
  const sha1 = 'c'.repeat(40);
  const sha2 = 'd'.repeat(40);
  const hits = [];
  let currentSha = sha1;
  const fetchImpl = async (url) => {
    hits.push(url);
    if (/\/api\/v1\/repos\/.+\/branches\//.test(url)) {
      return { ok: true, status: 200, json: async () => ({ commit: { id: currentSha } }) };
    }
    if (/manifest\.yaml$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'format: 1\nlanguage: ar\ndirection: rtl\n' };
    }
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'Brief text.' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  let now = 1_000_000;
  const ref = 'BSOJ/translation-context@master';

  const first = await getContextPackCached(ref, { fetchImpl, now: () => now });
  assert.equal(first.hasContent, true);
  const branchHitsAfterFirst = hits.filter((u) => /branches\//.test(u)).length;
  assert.equal(branchHitsAfterFirst, 1);

  // Well within the TTL: branch resolution is memoized, sha-pack is cached too.
  now += 1000;
  const second = await getContextPackCached(ref, { fetchImpl, now: () => now });
  assert.equal(second, first);
  assert.equal(hits.filter((u) => /branches\//.test(u)).length, 1, 'branch resolution reused within TTL');

  // Past the TTL: branch is re-resolved. Simulate the branch having moved.
  currentSha = sha2;
  now += BRANCH_SHA_TTL_MS + 1;
  const third = await getContextPackCached(ref, { fetchImpl, now: () => now });
  assert.equal(hits.filter((u) => /branches\//.test(u)).length, 2, 'branch re-resolved after TTL expiry');
  assert.notEqual(third, first, 'a moved branch resolves to a different (uncached) sha pack');
});

test('a rejected sha-pack load is not cached — the next call retries', async () => {
  _resetForTests();
  const sha = 'e'.repeat(40);
  const ref = `BSOJ/translation-context@${sha}`;
  let calls = 0;
  const fetchImpl = async (url) => {
    if (/manifest\.yaml$/.test(url)) {
      calls += 1;
      if (calls === 1) throw new Error('network blip');
      return { ok: true, status: 200, text: async () => 'format: 1\nlanguage: ar\ndirection: rtl\n' };
    }
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'Brief text.' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  await assert.rejects(() => getContextPackCached(ref, { fetchImpl }));
  const second = await getContextPackCached(ref, { fetchImpl });
  assert.equal(second.hasContent, true);
  assert.equal(calls, 2, 'the failed attempt was not cached, so the retry hit the network again');
});

test('a local directory ref bypasses the cache entirely', async () => {
  _resetForTests();
  const dir = mkTmpDir();
  writeFixturePack(dir);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 404, text: async () => '' }; };

  const first = await getContextPackCached(dir, { fetchImpl });
  const second = await getContextPackCached(dir, { fetchImpl });
  assert.equal(first.hasContent, true);
  assert.equal(second.hasContent, true);
  assert.notEqual(first, second, 'local dir loads are not cached/coalesced (fresh object each call)');
  assert.equal(calls, 0, 'fetchImpl is never invoked for a local directory');
});

test('branchShaCache stays bounded at MAX_ENTRIES across many distinct branch refs', async () => {
  _resetForTests();
  const sha = 'f'.repeat(40);
  const fetchImpl = async (url) => {
    if (/\/api\/v1\/repos\/.+\/branches\//.test(url)) {
      return { ok: true, status: 200, json: async () => ({ commit: { id: sha } }) };
    }
    if (/manifest\.yaml$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'format: 1\nlanguage: ar\ndirection: rtl\n' };
    }
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'Brief text.' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  for (let i = 0; i < 21; i++) {
    await getContextPackCached(`BSOJ/translation-context@branch-${i}`, { fetchImpl });
  }
  const { branchShaCacheSize } = _cacheSizesForTests();
  assert.ok(branchShaCacheSize <= MAX_ENTRIES, `branchShaCache should be bounded at ${MAX_ENTRIES}, got ${branchShaCacheSize}`);
});

test('fetchText rejects a file over the 2MB cap (Content-Length header)', async () => {
  _resetForTests();
  const ref = 'BSOJ/translation-context@notahex';
  const fetchImpl = async (url) => {
    if (/brief\.md$/.test(url)) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(MAX_PACK_FILE_BYTES + 1) : null) },
        text: async () => 'x'.repeat(MAX_PACK_FILE_BYTES + 1),
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const { pack, warning } = await loadQuickPack(ref, { fetchImpl });
  assert.equal(pack, null);
  assert.match(warning, /file too large/);
});

test('loadQuickPack degrades instead of hanging when the pack fetch stalls', async () => {
  _resetForTests();
  const ref = 'BSOJ/translation-context@stalledref';
  // Never resolves — stands in for a stuck DCS connection.
  const fetchImpl = () => new Promise(() => {});
  const started = Date.now();
  const { pack, warning } = await loadQuickPack(ref, { fetchImpl, timeoutMs: 40 });
  assert.equal(pack, null);
  assert.match(warning, /context_pack_unavailable: pack load timed out after 40ms/);
  assert.ok(Date.now() - started < 2000, 'returned promptly rather than hanging');
});

test('fetchText rejects a file over the 2MB cap (body length, no Content-Length header)', async () => {
  _resetForTests();
  const ref = 'BSOJ/translation-context@notahexeither';
  const fetchImpl = async (url) => {
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => 'x'.repeat(MAX_PACK_FILE_BYTES + 1) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const { pack, warning } = await loadQuickPack(ref, { fetchImpl });
  assert.equal(pack, null);
  assert.match(warning, /file too large/);
});

test('the size cap counts bytes, not characters (multibyte pack text)', async () => {
  _resetForTests();
  const ref = 'BSOJ/translation-context@multibyteref';
  // Under the cap as a character count, over it as UTF-8 bytes (2 bytes each).
  const arabic = 'ع'.repeat(Math.floor(MAX_PACK_FILE_BYTES * 0.75));
  const fetchImpl = async (url) => {
    if (/brief\.md$/.test(url)) {
      return { ok: true, status: 200, text: async () => arabic };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  assert.ok(arabic.length < MAX_PACK_FILE_BYTES, 'under the cap by character count');
  assert.ok(Buffer.byteLength(arabic, 'utf8') > MAX_PACK_FILE_BYTES, 'over the cap by byte count');
  const { pack, warning } = await loadQuickPack(ref, { fetchImpl });
  assert.equal(pack, null);
  assert.match(warning, /file too large/);
});
