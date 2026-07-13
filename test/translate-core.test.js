// Tests for the deterministic core of the translate pipeline: batching,
// context-pack loading/rendering, and whole-book chapter merge.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parseTnTsv, serializeTnTsv } = require('../src/lib/tn-tsv');
const core = require('../src/lib/translate-core');
const { loadContextPack } = require('../src/lib/context-pack');

const OBA_PATH = path.join(__dirname, 'fixtures', 'tn_OBA.tsv');
const rows = () => parseTnTsv(fs.readFileSync(OBA_PATH, 'utf8'));

test('buildBatches respects row and char caps and loses no rows', () => {
  const all = rows();
  const batches = core.buildBatches(all);
  assert.strictEqual(batches.flat().length, all.length);
  for (const b of batches) {
    assert.ok(b.length <= core.BATCH_MAX_ROWS);
    // Char cap holds unless a single oversized note forced a singleton batch.
    const chars = b.reduce((s, r) => s + (r.Note || '').length, 0);
    assert.ok(chars <= core.BATCH_MAX_NOTE_CHARS || b.length === 1,
      `batch of ${b.length} rows exceeds char cap (${chars})`);
  }
  // Order preserved end-to-end.
  assert.deepStrictEqual(batches.flat().map((r) => r.ID), all.map((r) => r.ID));
});

test('slugFromSupportReference extracts the tA slug', () => {
  assert.strictEqual(core.slugFromSupportReference('rc://*/ta/man/translate/figs-metaphor'), 'figs-metaphor');
  assert.strictEqual(core.slugFromSupportReference(''), null);
});

function writeFixturePack(dir) {
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'terminology'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'language: ar\ndirection: rtl\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Brief text.');
  fs.writeFileSync(path.join(dir, 'instructions.md'), 'Instruction text.');
  fs.writeFileSync(path.join(dir, 'standards.md'), 'Standard text.');
  fs.writeFileSync(path.join(dir, 'templates', 'templates.tsv'),
    'supportReference\ttarget_template\tstatus\tnotes\n'
    + 'figs-metaphor\tقالب الاستعارة\tapproved\t\n');
  fs.writeFileSync(path.join(dir, 'terminology', 'terms.csv'),
    'source_term,target_term,status,notes\nYahweh,يهوه,approved,divine name\ncovenant,عهد,candidate,\n');
  fs.writeFileSync(path.join(dir, 'examples', 'validated.jsonl'),
    JSON.stringify({ supportReference: 'rc://*/ta/man/translate/figs-metaphor', source: 'src A', target: 'tgt A' }) + '\n'
    + JSON.stringify({ supportReference: 'rc://*/ta/man/translate/figs-idiom', source: 'src B', target: 'tgt B' }) + '\n'
    + 'not json — must be skipped, not fatal\n');
}

test('loadContextPack loads a local fixture pack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pack-'));
  try {
    writeFixturePack(dir);
    const pack = await loadContextPack(dir);
    assert.strictEqual(pack.templates.get('figs-metaphor').template, 'قالب الاستعارة');
    assert.strictEqual(pack.terms.length, 2);
    assert.strictEqual(pack.terms[0].status, 'approved');
    assert.strictEqual(pack.examples.length, 2);
    assert.deepStrictEqual(pack.missing, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextPack throws on a pack with no files present (misconfig guard)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-empty-'));
  try {
    await assert.rejects(loadContextPack(dir), /no content files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextPack throws when only manifest.yaml is present (no content)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'language: xx\n');
    await assert.rejects(loadContextPack(dir), /no content files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextPack succeeds when at least one content file is present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-partial-'));
  try {
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'do the thing');
    const pack = await loadContextPack(dir);
    assert.strictEqual(pack.instructions, 'do the thing');
    assert.ok(pack.missing.includes('manifest.yaml'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderBatchPack injects matching templates, flags fallbacks, caps examples', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pack-'));
  try {
    writeFixturePack(dir);
    const pack = await loadContextPack(dir);
    const batchRows = rows().filter((r) => /figs-metaphor|figs-idiom/.test(r.SupportReference)).slice(0, 4);
    assert.ok(batchRows.length >= 2);
    const rendered = core.renderBatchPack({
      batchRows, pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
    });
    assert.match(rendered.markdown, /قالب الاستعارة/);           // template injected
    assert.match(rendered.markdown, /"Yahweh" → "يهوه"/);        // approved term as hard constraint
    assert.match(rendered.markdown, /HARD CONSTRAINTS/);
    assert.ok(rendered.slugs.includes('figs-metaphor'));
    // figs-idiom has no template in the fixture → fallback flagged
    assert.ok(rendered.templateFallbacks.includes('figs-idiom'));
    assert.match(rendered.markdown, /No Arabic template exists yet for/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeChapterIntoBook: fresh book equals serialized new rows', () => {
  const all = rows();
  const merged = core.mergeChapterIntoBook(null, all, { startChapter: 1, endChapter: 1 });
  assert.strictEqual(merged, serializeTnTsv(all));
});

test('mergeChapterIntoBook replaces only the range, preserving other chapters', () => {
  // Build a synthetic 2-chapter book from the OBA fixture (relabel some rows as ch2).
  const all = rows().slice(0, 20);
  const ch1 = all.slice(0, 10);
  const ch2 = all.slice(10).map((r, i) => ({ ...r, Reference: `2:${i + 1}` }));
  const bookText = serializeTnTsv([...ch1, ...ch2]);

  const newCh2 = ch2.map((r) => ({ ...r, Note: 'ترجمة جديدة' }));
  const merged = core.mergeChapterIntoBook(bookText, newCh2, { startChapter: 2, endChapter: 2 });
  const mergedRows = parseTnTsv(merged);
  // ch1 (incl. front rows) untouched, ch2 replaced, order canonical
  assert.deepStrictEqual(mergedRows.slice(0, 10), ch1);
  assert.deepStrictEqual(mergedRows.slice(10).map((r) => r.Note), newCh2.map(() => 'ترجمة جديدة'));

  // Replacing ch1 (range incl. front) keeps ch2 untouched and in place.
  const newCh1 = ch1.map((r) => ({ ...r, Note: 'الفصل الأول' }));
  const merged1 = core.mergeChapterIntoBook(bookText, newCh1, { startChapter: 1, endChapter: 1 });
  const merged1Rows = parseTnTsv(merged1);
  assert.deepStrictEqual(merged1Rows.slice(0, 10).map((r) => r.Note), newCh1.map(() => 'الفصل الأول'));
  assert.deepStrictEqual(merged1Rows.slice(10), ch2);
});

test('readBatchOutput surfaces check results and throws on missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-out-'));
  try {
    const batch = rows().slice(1, 4);
    const out = batch.map((r) => ({ ...r, Note: 'ترجمة' }));
    const outFile = path.join(dir, 'out.tsv');
    fs.writeFileSync(outFile, serializeTnTsv(out));
    const { rows: parsed, checks } = core.readBatchOutput(outFile, batch);
    assert.strictEqual(parsed.length, 3);
    assert.ok(checks); // rc-link violations expected for these notes — caller decides
    assert.throws(() => core.readBatchOutput(path.join(dir, 'nope.tsv'), batch), /no output file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
