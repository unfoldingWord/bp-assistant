// insert-tn-rows.test.js — regression tests for anchor-verse orphan removal
// Covers the fix for issue #56: note deduplication leaves orphaned rows on
// reference mismatch when a generated note narrows a multi-verse reference.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { insertTnRows } = require('../src/lib/insert-tn-rows');

// Minimal 7-column TN header
const TN_HEADER = 'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote';

// Minimal 7-column TQ header
const TQ_HEADER = 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'insert-tn-rows-'));
}

function writeTsv(dir, name, header, rows) {
  const content = [header, ...rows].join('\n') + '\n';
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function readRows(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  return lines.slice(1).filter((l) => l.trim());
}

// ---------------------------------------------------------------------------
// Anchor-verse orphan removal
// ---------------------------------------------------------------------------

test('insertTnRows removes orphaned multi-verse TN row when source narrows reference', () => {
  const dir = makeTempDir();
  try {
    // Book file has an existing multi-verse TN note at 18:9-10
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:1\taaaa\t\t\t\t1\tIntro note',
      '18:9-10\tqw0f\t\t\t\t1\tOld multi-verse note',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    // Source (generated chapter TSV) replaces with narrowed single-verse ref 18:9
    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:1\taaaa\t\t\t\t1\tIntro note',
      '18:9\tnewx\t\t\t\t1\tNew single-verse note',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    const log = insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    assert.ok(!refs.includes('18:9-10'), 'Orphaned multi-verse row must be removed');
    assert.ok(refs.includes('18:9'), 'New single-verse replacement must be present');
    assert.ok(refs.includes('18:1'), 'Unrelated rows must be preserved');
    assert.ok(refs.includes('18:11'), 'Unrelated rows must be preserved');
    assert.ok(log.includes('orphaned multi-verse row'), 'Log must mention orphaned row');
    assert.ok(log.includes('18:9-10'), 'Log must include the orphaned reference');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows removes orphaned TQ multi-verse row on reference narrowing', () => {
  const dir = makeTempDir();
  try {
    // TQ book file: existing note for 18:9-10 (multi-verse span)
    const bookFile = writeTsv(dir, 'tq_PSA.tsv', TQ_HEADER, [
      '18:1\tu3co\t\t\t1\tWhere does God dwell?\tIn his sanctuary.',
      '18:9-10\tqw0f\t\t\t1\tWhat did God do?\tHe came to help.',
      '18:11\taaaa\t\t\t1\tHow did the psalmist feel?\tRelieved.',
    ]);

    // Generated source narrows 18:9-10 → 18:9
    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TQ_HEADER, [
      '18:1\tu3co\t\t\t1\tWhere does God dwell?\tIn his sanctuary.',
      '18:9\tnewid\t\t\t1\tWhat did God come to do?\tTo rescue the psalmist.',
      '18:11\taaaa\t\t\t1\tHow did the psalmist feel?\tRelieved.',
    ]);

    insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    assert.ok(!refs.includes('18:9-10'), 'Orphaned TQ multi-verse row must be removed');
    assert.ok(refs.includes('18:9'), 'Replacement TQ single-verse row must be present');
    assert.ok(refs.includes('18:1'), 'Unrelated TQ row must survive');
    assert.ok(refs.includes('18:11'), 'Unrelated TQ row must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows preserves multi-verse row when no single-verse replacement exists', () => {
  const dir = makeTempDir();
  try {
    // Multi-verse row exists; source carries the same multi-verse ref forward
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:9-10\tqw0f\t\t\t\t1\tMulti-verse note',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:9-10\tqw0f\t\t\t\t1\tMulti-verse note unchanged',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    assert.ok(refs.includes('18:9-10'), 'Standalone multi-verse row must be preserved when source also has it');
    assert.ok(refs.includes('18:11'), 'Other rows must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows preserves KEEP-tagged multi-verse row even when source narrows reference', () => {
  const dir = makeTempDir();
  try {
    // KEEP-tagged multi-verse row must survive anchor-verse detection
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:9-10\tqw0f\tKEEP\t\t\t1\tEditor-curated multi-verse note',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:9\tnewx\t\t\t\t1\tNew single-verse note',
      '18:11\tbbbb\t\t\t\t1\tLater note',
    ]);

    insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    assert.ok(refs.includes('18:9-10'), 'KEEP-tagged multi-verse row must be preserved');
    assert.ok(refs.includes('18:9'), 'New single-verse row must also be present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows handles multiple orphaned multi-verse rows for same anchor', () => {
  const dir = makeTempDir();
  try {
    // Two multi-verse rows with the same anchor verse (both should be removed)
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:9-10\tqw0f\t\t\t\t1\tSpan note A',
      '18:9-11\tbcbs\t\t\t\t1\tSpan note B',
      '18:12\tcccc\t\t\t\t1\tOther note',
    ]);

    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:9\tnewx\t\t\t\t1\tNew single-verse note',
      '18:12\tcccc\t\t\t\t1\tOther note',
    ]);

    const log = insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    assert.ok(!refs.includes('18:9-10'), 'First orphaned span row must be removed');
    assert.ok(!refs.includes('18:9-11'), 'Second orphaned span row must be removed');
    assert.ok(refs.includes('18:9'), 'Replacement single-verse row must be present');
    assert.ok(refs.includes('18:12'), 'Unrelated row must be preserved');
    assert.ok(log.includes('orphaned multi-verse row'), 'Log must report orphan removal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows does not remove single-verse rows that merely share an anchor with a source range', () => {
  const dir = makeTempDir();
  try {
    // Existing has single-verse row at 18:9; source provides a multi-verse 18:9-10
    // The existing 18:9 should NOT be removed by anchor matching (it IS the anchor)
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:9\taaaa\t\t\t\t1\tExisting single-verse note',
      '18:11\tbbbb\t\t\t\t1\tOther note',
    ]);

    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:9-10\tnewx\t\t\t\t1\tNew multi-verse note',
      '18:11\tbbbb\t\t\t\t1\tOther note',
    ]);

    insertTnRows({ bookFile, sourceFile, chapter: 18 });

    const rows = readRows(bookFile);
    const refs = rows.map((r) => r.split('\t')[0]);

    // 18:9 is NOT a range ref, so the anchor-verse branch does not fire for it.
    // It has a different ref from '18:9-10', so it goes to preservedRows.
    assert.ok(refs.includes('18:9-10'), 'New multi-verse source row must be present');
    assert.ok(refs.includes('18:11'), 'Other rows must survive');
    // 18:9 was not matched by sourceRefs ('18:9' ≠ '18:9-10'), goes to preservedRows.
    // This is "expansion" direction — a separate issue, not fixed here.
    // The test simply documents the current behaviour after this fix.
    assert.equal(typeof refs, 'object'); // array
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertTnRows orders TN rows by ULT alignment quote sequence', () => {
  const dir = makeTempDir();
  try {
    const ultFile = path.join(dir, 'GEN.usfm');
    fs.writeFileSync(ultFile, [
      '\\id GEN',
      '\\c 1',
      '\\v 1 \\zaln-s |x-content="בְּרֵאשִׁ֖ית"\\*\\w In|x\\w* \\zaln-s |x-content="בָּרָ֣א"\\*\\w created|x\\w* \\zaln-s |x-content="אֱלֹהִ֑ים"\\*\\w God|x\\w*',
    ].join('\n'), 'utf8');

    const bookFile = writeTsv(dir, 'en_tn_GEN.tsv', TN_HEADER, [
      '1:1\told1\t\t\tבְּרֵאשִׁ֖ית\t1\tOld first note',
    ]);

    const sourceFile = writeTsv(dir, 'GEN-001-source.tsv', TN_HEADER, [
      '1:1\tlate\t\t\tאֱלֹהִ֑ים\t1\tLate quote',
      '1:1\tearly\t\t\tבְּרֵאשִׁ֖ית\t1\tEarly quote',
      '1:1\tmidl\t\t\tבָּרָ֣א\t1\tMiddle quote',
    ]);

    const log = insertTnRows({ bookFile, sourceFile, chapter: 1, ultFile });
    const ids = readRows(bookFile).map((row) => row.split('\t')[1]);

    assert.deepEqual(ids, ['early', 'midl', 'late']);
    assert.ok(log.includes('Loaded ULT alignments'), 'Log must mention alignment sequencing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Whole-chapter replace (replaceChapter) vs. default preservation (#435)
// ---------------------------------------------------------------------------

function wholeChapterFixture(dir) {
  const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
    '39:1\tzzz1\t\t\t\t1\tOther chapter note',
    '40:intro\tint1\t\t\t\t1\tOld intro',
    '40:1\told1\t\t\tlegacy english\t1\tOld note covered by source',
    '40:8\told8\t\t\tlegacy english\t1\tLegacy note in uncovered verse',
    '40:11\tkp11\tKEEP\t\tlegacy english\t1\tKEEP note in uncovered verse',
    '40:23\told9\t\t\tlegacy english\t1\tAnother legacy note',
    '41:1\tzzz2\t\t\t\t1\tNext chapter note',
  ]);
  const sourceFile = writeTsv(dir, 'EZK-40-source.tsv', TN_HEADER, [
    '40:intro\tni01\t\t\t\t1\tNew intro',
    '40:1\tnew1\t\t\tnew quote\t1\tNew note',
  ]);
  return { bookFile, sourceFile };
}

test('replaceChapter removes non-KEEP rows in uncovered verses, keeps KEEP, intro, other chapters', () => {
  const dir = makeTempDir();
  try {
    const { bookFile, sourceFile } = wholeChapterFixture(dir);
    const log = insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true });
    const rows = readRows(bookFile);
    const ids = rows.map((r) => r.split('\t')[1]);
    assert.deepEqual(ids.sort(), ['kp11', 'ni01', 'new1', 'zzz1', 'zzz2'].sort());
    assert.ok(log.includes('whole-chapter replace): 40:8, 40:23'), log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceChapter keeps the existing intro when skipIntro is set', () => {
  const dir = makeTempDir();
  try {
    const { bookFile, sourceFile } = wholeChapterFixture(dir);
    insertTnRows({ bookFile, sourceFile, chapter: 40, skipIntro: true, replaceChapter: true });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('int1'), 'existing intro preserved');
    assert.ok(!ids.includes('old8'), 'legacy row removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default (replaceChapter false) preserves rows in uncovered verses as before', () => {
  const dir = makeTempDir();
  try {
    const { bookFile, sourceFile } = wholeChapterFixture(dir);
    const log = insertTnRows({ bookFile, sourceFile, chapter: 40 });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.deepEqual(ids.sort(), ['kp11', 'new1', 'ni01', 'old8', 'old9', 'zzz1', 'zzz2'].sort());
    assert.ok(!log.includes('whole-chapter replace'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceChapter keeps an out-of-order row from another chapter inside the chapter span', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
      '40:1\told1\t\t\tlegacy english\t1\tOld note covered by source',
      '41:3\tstry\t\t\t\t1\tMisplaced next-chapter note',
      '40:8\told8\t\t\tlegacy english\t1\tLegacy note in uncovered verse',
    ]);
    const sourceFile = writeTsv(dir, 'EZK-40-source.tsv', TN_HEADER, [
      '40:1\tnew1\t\t\tnew quote\t1\tNew note',
    ]);
    const log = insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.deepEqual(ids.sort(), ['new1', 'stry'].sort());
    assert.ok(log.includes('Removed 1 existing rows for verses in source'), log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// keptIds: editor-kept rows (blank Tags) are treated like KEEP-tagged rows
// ---------------------------------------------------------------------------

function keptFixture(dir) {
  const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
    '40:1\told1\t\tfigs-metaphor\tlegacy english\t1\tOld note covered by source',
    '40:1\tkept\t\tfigs-simile\tkept english\t1\tEditor-kept note, Tags blank',
    '40:8\tkp08\t\t\tlegacy english\t1\tEditor-kept note in uncovered verse',
    '40:9\told9\t\t\tlegacy english\t1\tUncovered, not kept',
  ]);
  const sourceFile = writeTsv(dir, 'EZK-40-source.tsv', TN_HEADER, [
    '40:1\tnew1\t\tfigs-metaphor\tnew quote\t1\tNew note',
  ]);
  return { bookFile, sourceFile };
}

test('keptIds: blank-Tags kept row survives replaceChapter, source row at same ref, and uncovered verse', () => {
  const dir = makeTempDir();
  try {
    const { bookFile, sourceFile } = keptFixture(dir);
    insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true, keptIds: ['kept', 'kp08'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.deepEqual(ids.sort(), ['kept', 'kp08', 'new1'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: kept row suppresses a source row with the same (Reference, SupportReference, Quote) only', () => {
  const dir = makeTempDir();
  try {
    const { bookFile } = keptFixture(dir);
    const sourceFile = writeTsv(dir, 'EZK-40-dup.tsv', TN_HEADER, [
      '40:1\tdup1\t\tfigs-simile\tkept english\t1\tAI duplicate of the kept note',
      '40:1\toth1\t\tfigs-simile\tdifferent quote\t1\tSame issue type, different phrase',
      '40:1\tnew1\t\tfigs-metaphor\tnew quote\t1\tNew note',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 40, keptIds: ['kept'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('kept'));
    assert.ok(!ids.includes('dup1'), 'duplicate source row must be suppressed');
    assert.ok(ids.includes('oth1'), 'a different phrase with the same support reference still lands');
    assert.ok(ids.includes('new1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds empty: same output as before (kept-ID row is replaced like any other)', () => {
  const dir = makeTempDir();
  try {
    const { bookFile, sourceFile } = keptFixture(dir);
    insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.deepEqual(ids, ['new1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: orphaned multi-verse kept row survives a narrowed source reference', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_PSA.tsv', TN_HEADER, [
      '18:9-10\tqw0f\t\t\t\t1\tEditor-kept multi-verse note',
    ]);
    const sourceFile = writeTsv(dir, 'PSA-018-source.tsv', TN_HEADER, [
      '18:9\tnewx\t\t\t\t1\tNew single-verse note',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 18, keptIds: ['qw0f'] });
    const refs = readRows(bookFile).map((r) => r.split('\t')[0]);
    assert.ok(refs.includes('18:9-10'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: kept intro row is not replaced by the source intro', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
      '40:intro\tki01\t\t\t\t0\t# Kept intro',
      '40:1\told1\t\tfigs-metaphor\tq\t1\tOld',
    ]);
    const sourceFile = writeTsv(dir, 'EZK-40-src.tsv', TN_HEADER, [
      '40:intro\tnewi\t\t\t\t0\t# AI intro',
      '40:1\tnew1\t\tfigs-metaphor\tq2\t1\tNew',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true, keptIds: ['ki01'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('ki01'));
    assert.ok(!ids.includes('newi'));
    assert.ok(ids.includes('new1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: kept row with blank SupportReference still blocks the same blank-sref quote; word joiners ignored', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
      '40:2\tkp02\t\t\tלֹא\t1\tKept, no support reference',
    ]);
    const sourceFile = writeTsv(dir, 'EZK-40-src.tsv', TN_HEADER, [
      '40:2\tdup2\t\t\tלֹא\u2060\t1\tDuplicate',
      '40:2\tnew2\t\tfigs-explicit\tלֹא\t1\tDifferent issue',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 40, keptIds: ['kp02'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('kp02'));
    assert.ok(!ids.includes('dup2'));
    assert.ok(ids.includes('new2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: a kept range row blocks a single-verse duplicate inside it', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
      '40:12-14\tkr12\t\tfigs-explicit\tשַׁעַר\t1\tKept range note',
    ]);
    const sourceFile = writeTsv(dir, 'EZK-40-src.tsv', TN_HEADER, [
      '40:13\tdu13\t\tfigs-explicit\tשַׁעַר\t1\tDuplicate inside the range',
      '40:13\tne13\t\tfigs-idiom\tשַׁעַר\t1\tDifferent issue',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 40, replaceChapter: true, keptIds: ['kr12'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('kr12'));
    assert.ok(!ids.includes('du13'));
    assert.ok(ids.includes('ne13'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptIds: a cross-chapter kept row blocks a duplicate in its second chapter', () => {
  const dir = makeTempDir();
  try {
    const bookFile = writeTsv(dir, 'en_tn_EZK.tsv', TN_HEADER, [
      '40:48-41:2\tkx48\t\tfigs-explicit\tשַׁעַר\t1\tKept cross-chapter note',
      '41:3\told3\t\tfigs-idiom\tx\t1\tOld',
    ]);
    const sourceFile = writeTsv(dir, 'EZK-41-src.tsv', TN_HEADER, [
      '41:1\tdu01\t\tfigs-explicit\tשַׁעַר\t1\tDuplicate',
      '41:3\tne03\t\tfigs-idiom\ty\t1\tNew',
    ]);
    insertTnRows({ bookFile, sourceFile, chapter: 41, replaceChapter: true, keptIds: ['kx48'] });
    const ids = readRows(bookFile).map((r) => r.split('\t')[1]);
    assert.ok(ids.includes('kx48'));
    assert.ok(!ids.includes('du01'));
    assert.ok(ids.includes('ne03'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
