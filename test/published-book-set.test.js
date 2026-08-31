// published-book-set.test.js — regression coverage for #336.
//
// The published ULT/UST fetch tools used to resolve their book list from a
// hardcoded V89_PUBLISHED constant. When the release moved to v90 the constant
// aged out, so a forced refresh covered 27 books against directories holding 29
// files: ISA/HOS/ZEC were silently left at their old "# Fetched:" dates.
//
// These tests pin the two properties that fix it:
//   1. the published set is read from the release manifest, not the constant
//   2. a file already on disk is always in the refresh list, so nothing is
//      silently skipped

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// fetch-tools reads CSKILLBP_DIR at module load, so set it before requiring.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-published-set-'));
process.env.CSKILLBP_DIR = WORKSPACE;

const {
  getPublishedBooks,
  listBooksOnDisk,
  resolvePublishedBookList,
  FALLBACK_PUBLISHED,
} = require('../src/workspace-tools/fetch-tools');

const ULT_DIR = 'data/published_ult';

function writeManifest(release, books) {
  const dir = path.join(WORKSPACE, 'data/cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'published_manifest.json'),
    JSON.stringify({ release, books, lastRun: '2026-08-19' })
  );
}

function clearManifest() {
  const p = path.join(WORKSPACE, 'data/cache/published_manifest.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function writeBooks(dirRel, entries) {
  const dir = path.join(WORKSPACE, dirRel);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(path.join(dir, `${entry}.usfm`), '# Fetched: 2026-08-01\n\\id X\n');
  }
}

test('published set comes from the release manifest, not the hardcoded fallback', () => {
  // v90: the 27 v89 books plus ISA, HOS, ZEC — the exact drift from #336.
  writeManifest('v90', [
    '01-GEN', '02-EXO', '03-LEV', '05-DEU', '06-JOS', '07-JDG', '08-RUT',
    '09-1SA', '10-2SA', '11-1KI', '12-2KI', '15-EZR', '16-NEH', '17-EST',
    '18-JOB', '19-PSA', '20-PRO', '22-SNG', '23-ISA', '25-LAM', '28-HOS',
    '29-JOL', '31-OBA', '32-JON', '34-NAM', '35-HAB', '36-ZEP', '37-HAG',
    '38-ZEC', '39-MAL',
  ]);

  const { books, source } = getPublishedBooks();
  assert.ok(source.includes('v90'), `source should name the release, got: ${source}`);
  for (const code of ['ISA', 'HOS', 'ZEC']) {
    assert.ok(books.includes(code), `${code} should be published under v90`);
  }
  assert.ok(books.includes('HAB'), 'HAB should still be in the set');
  assert.ok(books.length > FALLBACK_PUBLISHED.length, 'manifest set should exceed the v89 fallback');
});

test('manifest entries with digits in the code (1SA/2KI) survive parsing', () => {
  writeManifest('v90', ['09-1SA', '10-2SA', '11-1KI', '12-2KI']);
  const { books } = getPublishedBooks();
  assert.deepStrictEqual(books, ['1SA', '2SA', '1KI', '2KI']);
});

test('falls back to the seed list when the manifest is missing', () => {
  clearManifest();
  const { books, source } = getPublishedBooks();
  assert.deepStrictEqual(books, FALLBACK_PUBLISHED);
  assert.ok(source.includes('fallback'), `source should flag the fallback, got: ${source}`);
});

test('falls back when the manifest is malformed rather than throwing', () => {
  const dir = path.join(WORKSPACE, 'data/cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'published_manifest.json'), '{ not json');
  const { books } = getPublishedBooks();
  assert.deepStrictEqual(books, FALLBACK_PUBLISHED);
  clearManifest();
});

test('listBooksOnDisk reads book codes from USFM filenames', () => {
  writeBooks(ULT_DIR, ['01-GEN', '23-ISA', '09-1SA']);
  const onDisk = listBooksOnDisk(ULT_DIR);
  assert.deepStrictEqual(onDisk.sort(), ['1SA', 'GEN', 'ISA']);
});

test('listBooksOnDisk returns empty for a directory that does not exist', () => {
  assert.deepStrictEqual(listBooksOnDisk('data/does_not_exist'), []);
});

test('a default refresh covers files on disk that are not in the published set', () => {
  // The #336 state: fallback set (no manifest) but ISA/HOS/ZEC sitting on disk.
  clearManifest();
  writeBooks(ULT_DIR, ['01-GEN', '23-ISA', '28-HOS', '38-ZEC']);

  const { bookList, extras } = resolvePublishedBookList({
    outputDir: ULT_DIR,
    masterTool: 'fetch_master_ult',
  });

  assert.deepStrictEqual(extras.sort(), ['HOS', 'ISA', 'ZEC']);
  for (const code of ['ISA', 'HOS', 'ZEC']) {
    assert.ok(bookList.includes(code), `${code} on disk must be refreshed, not skipped`);
  }
  // The canonical set is still covered in full — HAB was missing from disk.
  for (const code of FALLBACK_PUBLISHED) {
    assert.ok(bookList.includes(code), `${code} from the published set must still be fetched`);
  }
  assert.strictEqual(new Set(bookList).size, bookList.length, 'no duplicate fetches');
});

test('no extras reported when the directory matches the published set', () => {
  clearManifest();
  writeBooks(ULT_DIR, ['01-GEN', '02-EXO']);
  const { extras } = resolvePublishedBookList({
    outputDir: ULT_DIR,
    masterTool: 'fetch_master_ult',
  });
  assert.deepStrictEqual(extras, [], 'GEN/EXO are published, so neither is an extra');
});

test('an explicitly requested non-published book that is on disk is allowed', () => {
  clearManifest();
  writeBooks(ULT_DIR, ['23-ISA']);
  const resolved = resolvePublishedBookList({
    books: ['ISA'],
    outputDir: ULT_DIR,
    masterTool: 'fetch_master_ult',
  });
  assert.ok(!resolved.error, `ISA is on disk so it must stay refreshable: ${resolved.error}`);
  assert.deepStrictEqual(resolved.bookList, ['ISA']);
});

test('an explicitly requested book neither published nor on disk is rejected', () => {
  clearManifest();
  writeBooks(ULT_DIR, ['01-GEN']);
  const resolved = resolvePublishedBookList({
    books: ['JER'],
    outputDir: ULT_DIR,
    masterTool: 'fetch_master_ult',
  });
  assert.ok(resolved.error, 'JER is neither published nor on disk');
  assert.match(resolved.error, /JER/);
  assert.match(resolved.error, /fetch_master_ult/, 'error should point at the master tool');
});

test('book aliases are normalized before the published check', () => {
  clearManifest();
  writeBooks(ULT_DIR, []);
  const resolved = resolvePublishedBookList({
    books: ['Genesis'],
    outputDir: ULT_DIR,
    masterTool: 'fetch_master_ult',
  });
  assert.ok(!resolved.error, `alias should resolve: ${resolved.error}`);
  assert.deepStrictEqual(resolved.bookList, ['GEN']);
});

test.after(() => fs.rmSync(WORKSPACE, { recursive: true, force: true }));
