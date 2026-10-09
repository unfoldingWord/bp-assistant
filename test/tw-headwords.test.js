'use strict';

// #456: data/en_tw and data/tw_headwords.json had no refresh job. These pin the
// fetch-tw step: the archive is unpacked into data/en_tw/<category>/*.md, the
// headwords index is rebuilt from article titles, and any failure keeps the
// previous files instead of emptying the index check_tw_headwords reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  refreshTranslationWords, parseTar, headwordsFromTitle, TW_ARCHIVE_URL, FETCHED_MARKER,
} = require('../src/tw-headwords');
const { CURATE_STEPS, nextFetchStatus } = require('../src/curate-data');

function tarEntry(name, body, type) {
  const data = Buffer.from(body || '');
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type || '0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

function archive(files) {
  const parts = [tarEntry('pax_global_header', paxRecord('comment', 'abc123'), 'g')];
  for (const [name, body] of Object.entries(files)) parts.push(tarEntry(name, body));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const ARTICLES = {
  'en_tw/README.md': '# Translation Words\n',
  'en_tw/bible/kt/god.md': '# God\n\n## Definition:\n',
  'en_tw/bible/names/saul.md': '# Saul (OT)\n\n## Facts:\n',
  'en_tw/bible/names/nebuchadnezzar.md': '# Nebuchadnezzar\n',
  'en_tw/bible/other/horn.md': '# horn, horned, shofar\n',
};

function tmpData() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hw-')); }

test('headwords come from the comma-separated title, plus the bare form of a disambiguated one', () => {
  assert.deepEqual(headwordsFromTitle('horn, horned, shofar'), ['horn', 'horned', 'shofar']);
  assert.deepEqual(headwordsFromTitle('Saul (OT)'), ['Saul (OT)', 'Saul']);
  assert.deepEqual(headwordsFromTitle('James (son of Zebedee)'), ['James (son of Zebedee)', 'James']);
});

test('parseTar reads ustar entries and honors a pax path override', () => {
  const buf = Buffer.concat([
    tarEntry('x', paxRecord('path', 'en_tw/bible/names/a-very-long-name.md'), 'x'),
    tarEntry('short', '# Long\n'),
    Buffer.alloc(1024),
  ]);
  const files = parseTar(buf);
  assert.deepEqual(files.map((f) => f.name), ['en_tw/bible/names/a-very-long-name.md']);
  assert.equal(files[0].data.toString(), '# Long\n');
});

test('fetch-tw writes en_tw/<category>/*.md and a tw_headwords.json in the existing entry shape', async () => {
  const dataDir = tmpData();
  fs.mkdirSync(path.join(dataDir, 'en_tw', 'names'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'en_tw', 'names', 'stale.md'), '# Stale\n');
  const urls = [];
  const res = await refreshTranslationWords({
    dataDir, force: true,
    fetchBuffer: async (url) => { urls.push(url); return archive(ARTICLES); },
  });
  assert.deepEqual(urls, [TW_ARCHIVE_URL]);
  assert.equal(res.entries, 4);

  const hw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tw_headwords.json'), 'utf8'));
  assert.deepEqual(hw.find((e) => e.twarticle === 'horn'),
    { twarticle: 'horn', file: 'other/horn.md', category: 'other', headwords: ['horn', 'horned', 'shofar'] });
  assert.deepEqual(hw.map((e) => e.category), ['kt', 'names', 'names', 'other']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'en_tw', 'names', 'saul.md'), 'utf8'), '# Saul (OT)\n\n## Facts:\n');
  assert.ok(!fs.existsSync(path.join(dataDir, 'en_tw', 'names', 'stale.md')), 'old tree is replaced, not merged');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['en_tw', 'tw_headwords.json'], 'no scratch files left');
});

test('a failed or implausible fetch keeps the previous en_tw and tw_headwords.json', async () => {
  const dataDir = tmpData();
  const prev = Array.from({ length: 20 }, (_, i) => ({ twarticle: `a${i}`, file: `names/a${i}.md`, category: 'names', headwords: [`A${i}`] }));
  const hwPath = path.join(dataDir, 'tw_headwords.json');
  fs.writeFileSync(hwPath, JSON.stringify(prev));
  fs.mkdirSync(path.join(dataDir, 'en_tw', 'names'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'en_tw', 'names', 'a0.md'), '# A0\n');

  const attempts = [
    async () => { throw new Error('HTTP 502'); },
    async () => zlib.gzipSync(Buffer.from('not a tar archive at all'.repeat(40))),
    async () => archive(ARTICLES), // 4 articles vs 20 indexed: refuses to shrink
    async () => archive({ 'en_tw/bible/names/x.md': '# X\n' }), // missing kt/other
  ];
  for (const fetchBuffer of attempts) {
    await assert.rejects(refreshTranslationWords({ dataDir, force: true, fetchBuffer }));
    assert.deepEqual(JSON.parse(fs.readFileSync(hwPath, 'utf8')), prev);
    assert.equal(fs.readFileSync(path.join(dataDir, 'en_tw', 'names', 'a0.md'), 'utf8'), '# A0\n');
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ['en_tw', 'tw_headwords.json']);
  }
});

test('a non-forced run skips a fresh index and refetches a stale one', async () => {
  const dataDir = tmpData();
  let calls = 0;
  const fetchBuffer = async () => { calls++; return archive(ARTICLES); };
  await refreshTranslationWords({ dataDir, force: true, fetchBuffer });
  const fresh = await refreshTranslationWords({ dataDir, fetchBuffer, isStale: () => false });
  assert.deepEqual(fresh, { skipped: true });
  await refreshTranslationWords({ dataDir, fetchBuffer, isStale: () => true });
  assert.equal(calls, 2);
});

test('fetch-tw is a curation step, so the weekly full run includes it', () => {
  assert.ok(CURATE_STEPS.includes('fetch-tw'));
});

// #466 1(a): en_tw used to be swapped in, already carrying a fresh .fetched
// marker, before tw_headwords.json was. A crash between the two left new
// articles beside the old index, and the marker made the next weekly run skip.
test('the .fetched marker is written only after both en_tw and tw_headwords.json are swapped in', async () => {
  const dataDir = tmpData();
  const hwPath = path.join(dataDir, 'tw_headwords.json');
  const marker = path.join(dataDir, 'en_tw', FETCHED_MARKER);
  const seen = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === hwPath) seen.push(fs.existsSync(marker));
    return realRename(from, to);
  };
  try {
    await refreshTranslationWords({ dataDir, force: true, fetchBuffer: async () => archive(ARTICLES) });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(seen, [false], 'no marker exists while the index is still the old one');
  assert.match(fs.readFileSync(marker, 'utf8'), /^\d{4}-\d{2}-\d{2}\n$/);
});

test('a failed index swap puts the previous en_tw back beside the previous index', async () => {
  const dataDir = tmpData();
  const hwPath = path.join(dataDir, 'tw_headwords.json');
  const prev = [{ twarticle: 'old', file: 'names/old.md', category: 'names', headwords: ['Old'] }];
  fs.writeFileSync(hwPath, JSON.stringify(prev));
  fs.mkdirSync(path.join(dataDir, 'en_tw', 'names'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'en_tw', 'names', 'old.md'), '# Old\n');
  fs.writeFileSync(path.join(dataDir, 'en_tw', FETCHED_MARKER), '2026-01-01\n');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === hwPath) throw new Error('simulated crash at index swap');
    return realRename(from, to);
  };
  try {
    await assert.rejects(
      refreshTranslationWords({ dataDir, force: true, fetchBuffer: async () => archive(ARTICLES) }),
      /simulated crash/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(hwPath, 'utf8')), prev);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'en_tw', 'names')), ['old.md']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'en_tw', FETCHED_MARKER), 'utf8'), '2026-01-01\n');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['en_tw', 'tw_headwords.json'], 'no scratch files left');
});

test('an archive over the download or unpacked size cap is refused and the previous files kept', async () => {
  const dataDir = tmpData();
  const hwPath = path.join(dataDir, 'tw_headwords.json');
  fs.writeFileSync(hwPath, '[]');
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024)); // ~100 bytes gzipped, 64 KiB unpacked
  await assert.rejects(
    refreshTranslationWords({ dataDir, force: true, maxTarBytes: 32 * 1024, fetchBuffer: async () => bomb }),
    /unpacks to more than 32768 bytes/);
  await assert.rejects(
    refreshTranslationWords({ dataDir, force: true, maxArchiveBytes: 16, fetchBuffer: async () => bomb }),
    /over the 16-byte cap/);
  assert.equal(fs.readFileSync(hwPath, 'utf8'), '[]');
  assert.deepEqual(fs.readdirSync(dataDir), ['tw_headwords.json']);
});

// #466 1(b): only a run that included fetch-google wrote .fetch-status.json, so
// an operator `step=fetch-tw` failure never reached /health/data-freshness.
test('a fetch-tw-only run records or clears its own error without moving the Google timestamps', () => {
  const googleErr = { file: 'templates.csv', message: 'HTTP 500' };
  const twErr = { file: 'tw_headwords.json', message: 'HTTP 502' };
  const prev = { lastRun: '2026-10-01T00:00:00Z', lastSuccess: '2026-09-24T00:00:00Z', errors: [googleErr] };
  const now = '2026-10-09T00:00:00Z';

  const failed = nextFetchStatus(prev, [twErr], { google: false, tw: true }, now);
  assert.deepEqual(failed, { lastRun: prev.lastRun, lastSuccess: prev.lastSuccess, errors: [googleErr, twErr] });

  const cleared = nextFetchStatus(failed, [], { google: false, tw: true }, now);
  assert.deepEqual(cleared, prev, 'a later tW success clears only the tW error');

  const googleOnly = nextFetchStatus(failed, [], { google: true, tw: false }, now);
  assert.deepEqual(googleOnly, { lastRun: now, lastSuccess: now, errors: [twErr] },
    'a Google-only run keeps the unresolved tW error');

  const full = nextFetchStatus(failed, [], { google: true, tw: true }, now);
  assert.deepEqual(full, { lastRun: now, lastSuccess: now, errors: [] });
});
