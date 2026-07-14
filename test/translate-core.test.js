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
const {
  loadContextPack, parseTermsCsv, parseExamplesJsonl, parseTemplatesTsv,
} = require('../src/lib/context-pack');
const {
  buildSuggestionInbox, shouldWriteContextBack, MAX_SUGGESTIONS,
} = require('../src/lib/translate-suggestions');

const OBA_PATH = path.join(__dirname, 'fixtures', 'tn_OBA.tsv');
const rows = () => parseTnTsv(fs.readFileSync(OBA_PATH, 'utf8'));

test('buildBatches respects row and char caps and loses no rows', () => {
  const all = rows();
  const batches = core.buildBatches(all);
  assert.strictEqual(batches.flat().length, all.length);
  for (const b of batches) {
    assert.ok(b.length <= core.BATCH_MAX_ROWS);
    const chars = b.reduce((s, r) => s + (r.Note || '').length, 0);
    assert.ok(chars <= core.BATCH_MAX_NOTE_CHARS || b.length === 1,
      `batch of ${b.length} rows exceeds char cap (${chars})`);
  }
  assert.deepStrictEqual(batches.flat().map((r) => r.ID), all.map((r) => r.ID));
});

test('slugFromSupportReference extracts the tA slug', () => {
  assert.strictEqual(core.slugFromSupportReference('rc://*/ta/man/translate/figs-metaphor'), 'figs-metaphor');
  assert.strictEqual(core.slugFromSupportReference(''), null);
});

function writeFixturePack(dir, { templateStatus = 'active', format = 1 } = {}) {
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'terminology'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), `format: ${format}\nlanguage: ar\ndirection: rtl\n`);
  fs.writeFileSync(path.join(dir, 'brief.md'),
    '# Translation brief\n\n**Register:** formal\n\nBrief text.');
  fs.writeFileSync(path.join(dir, 'instructions.md'), 'Instruction text.');
  fs.writeFileSync(path.join(dir, 'templates', 'templates.tsv'),
    'support_reference\ttarget_template\tstatus\tcomment\n'
    + `figs-metaphor\tقالب الاستعارة\t${templateStatus}\t\n`
    + 'figs-idiom\ten-scaffold\tdraft\tignored\n');
  fs.writeFileSync(path.join(dir, 'terminology', 'terms.csv'),
    'concept_id,source_term,target_term,status,replacement,comment,tw_link\n'
    + 'names/yhwh,Yahweh,يهوه,preferred,,divine name,\n'
    + 'kt/lord,Lord,السيد,forbidden,الرب,use standard,\n'
    + 'names/tetragram,YHWH,,do_not_translate,,,\n'
    + 'kt/covenant,covenant,عهد,admitted,,,\n'
    + 'kt/grace,"grace, gift",نعمة,preferred,,quoted comma,\n');
  fs.writeFileSync(path.join(dir, 'examples', 'validated.jsonl'),
    JSON.stringify({
      resource: 'tn', rowId: 'a1', supportReference: 'rc://*/ta/man/translate/figs-metaphor',
      source: 'src A', target: 'tgt A', validated_at: 100,
    }) + '\n'
    + JSON.stringify({
      resource: 'tn', rowId: 'b1', supportReference: 'rc://*/ta/man/translate/figs-idiom',
      source: 'src B', target: 'tgt B', validated_at: 200,
    }) + '\n'
    + JSON.stringify({ resource: 'tn', rowId: 'a1', tombstone: true, validated_at: 300 }) + '\n'
    + JSON.stringify({
      resource: 'tn', rowId: 'c1', supportReference: 'rc://*/ta/man/translate/figs-metaphor',
      source: 'src C', target: 'tgt C', validated_at: 400,
    }) + '\n'
    + 'not json — must be skipped, not fatal\n');
}

test('parseTermsCsv handles 7-col schema, quoting, and status vocab', () => {
  const terms = parseTermsCsv(
    'concept_id,source_term,target_term,status,replacement,comment,tw_link\n'
    + 'kt/grace,"grace, gift",نعمة,preferred,,,\n'
    + 'kt/lord,Lord,السيد,forbidden,الرب,no,\n'
    + 'n/x,YHWH,,do_not_translate,,,\n');
  assert.strictEqual(terms.length, 3);
  assert.strictEqual(terms[0].source, 'grace, gift');
  assert.strictEqual(terms[0].status, 'preferred');
  assert.strictEqual(terms[1].status, 'forbidden');
  assert.strictEqual(terms[1].replacement, 'الرب');
  assert.strictEqual(terms[2].status, 'do_not_translate');
  assert.strictEqual(terms[2].target, '');
});

test('parseTemplatesTsv keeps only active rows', () => {
  const map = parseTemplatesTsv(
    'support_reference\ttarget_template\tstatus\tcomment\n'
    + 'figs-metaphor\tok\tactive\t\n'
    + 'figs-idiom\tno\tdraft\t\n');
  assert.strictEqual(map.size, 1);
  assert.ok(map.has('figs-metaphor'));
  assert.ok(!map.has('figs-idiom'));
});

test('parseExamplesJsonl applies tombstones last-line-wins', () => {
  const examples = parseExamplesJsonl(
    JSON.stringify({ resource: 'tn', rowId: 'x', source: 'a', target: 'b', validated_at: 1 }) + '\n'
    + JSON.stringify({ resource: 'tn', rowId: 'x', tombstone: true, validated_at: 2 }) + '\n'
    + JSON.stringify({ resource: 'tn', rowId: 'y', source: 'c', target: 'd', validated_at: 3 }) + '\n');
  assert.strictEqual(examples.length, 1);
  assert.strictEqual(examples[0].rowId, 'y');
});

test('loadContextPack loads a local fixture pack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pack-'));
  try {
    writeFixturePack(dir);
    const pack = await loadContextPack(dir);
    assert.strictEqual(pack.templates.get('figs-metaphor').template, 'قالب الاستعارة');
    assert.ok(!pack.templates.has('figs-idiom')); // draft inactive
    assert.ok(pack.terms.some((t) => t.status === 'preferred' && t.source === 'Yahweh'));
    assert.ok(pack.terms.some((t) => t.status === 'forbidden'));
    assert.ok(pack.terms.some((t) => t.source === 'grace, gift'));
    assert.strictEqual(pack.register, 'formal');
    // a1 tombstoned; metaphor examples = c1 only (+ idiom b1)
    assert.strictEqual(pack.examples.length, 2);
    assert.ok(pack.examples.every((e) => e.rowId !== 'a1'));
    assert.deepStrictEqual(pack.missing, ['standards.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextPack refuses unsupported manifest format', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-fmt-'));
  try {
    writeFixturePack(dir, { format: 99 });
    await assert.rejects(loadContextPack(dir), /format 99 is not supported/);
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
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'format: 1\nlanguage: xx\n');
    await assert.rejects(loadContextPack(dir), /no content files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextPack with allowEmpty returns hasContent:false instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-allowempty-'));
  try {
    const pack = await loadContextPack(dir, { allowEmpty: true });
    assert.strictEqual(pack.hasContent, false);
    assert.strictEqual(pack.templates.size, 0);
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

test('renderBatchPack injects preferred/forbidden terms, register, active templates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pack-'));
  try {
    writeFixturePack(dir);
    const pack = await loadContextPack(dir);
    const batchRows = rows().filter((r) => /figs-metaphor|figs-idiom/.test(r.SupportReference)).slice(0, 4);
    assert.ok(batchRows.length >= 2);
    const rendered = core.renderBatchPack({
      batchRows, pack, targetLang: 'ar', targetLangName: 'Arabic', direction: 'rtl',
    });
    assert.match(rendered.markdown, /قالب الاستعارة/);
    assert.match(rendered.markdown, /"Yahweh" → "يهوه"/);
    assert.match(rendered.markdown, /HARD CONSTRAINTS \(preferred/);
    assert.match(rendered.markdown, /FORBIDDEN/);
    assert.match(rendered.markdown, /do not translate/);
    assert.match(rendered.markdown, /\*\*formal\*\* register/);
    assert.ok(!/candidates \(prefer these/.test(rendered.markdown));
    assert.ok(rendered.slugs.includes('figs-metaphor'));
    assert.ok(rendered.templateFallbacks.includes('figs-idiom'));
    assert.match(rendered.markdown, /No Arabic template exists yet for/);
    // tombstoned a1 gone; c1 metaphor example present
    assert.match(rendered.markdown, /src C/);
    assert.ok(!/src A/.test(rendered.markdown));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldWriteContextBack requires explicit assisted pack or flag', () => {
  assert.strictEqual(shouldWriteContextBack({ contextRefExplicit: false }, { hasContent: true }), false);
  assert.strictEqual(shouldWriteContextBack({ contextRefExplicit: true }, { hasContent: false }), false);
  assert.strictEqual(shouldWriteContextBack({ contextRefExplicit: true }, { hasContent: true }), true);
  assert.strictEqual(shouldWriteContextBack({ writeContextBack: true }, { hasContent: false }), true);
  assert.strictEqual(shouldWriteContextBack({ writeContextBack: false, contextRefExplicit: true }, { hasContent: true }), false);
});

test('buildSuggestionInbox caps at MAX_SUGGESTIONS and prioritizes templates', () => {
  const pack = { templates: new Map(), terms: [] };
  const sourceRows = [];
  for (let i = 0; i < 10; i++) {
    sourceRows.push({
      ID: `r${i}`,
      SupportReference: `rc://*/ta/man/translate/figs-slot-${i}`,
      Note: `About **Term${i}** here.`,
    });
  }
  const targetRows = sourceRows.map((r, i) => ({
    ID: r.ID,
    Note: `عن **كلمة${i}** هنا.`,
  }));
  const inbox = buildSuggestionInbox({
    runId: 'run-1',
    contextRef: 'BSOJ/translation-context@abc',
    pack,
    sourceRows,
    targetRows,
  });
  assert.ok(inbox.suggestions.length <= MAX_SUGGESTIONS);
  assert.strictEqual(inbox.suggestions.length, MAX_SUGGESTIONS);
  assert.ok(inbox.suggestions.every((s) => s.kind === 'template_needed'));
  assert.strictEqual(inbox.runId, 'run-1');
});

test('mergeChapterIntoBook: fresh book equals serialized new rows', () => {
  const all = rows();
  const merged = core.mergeChapterIntoBook(null, all, { startChapter: 1, endChapter: 1 });
  assert.strictEqual(merged, serializeTnTsv(all));
});

test('mergeChapterIntoBook replaces only the range, preserving other chapters', () => {
  const all = rows().slice(0, 20);
  const ch1 = all.slice(0, 10);
  const ch2 = all.slice(10).map((r, i) => ({ ...r, Reference: `2:${i + 1}` }));
  const bookText = serializeTnTsv([...ch1, ...ch2]);

  const newCh2 = ch2.map((r) => ({ ...r, Note: 'ترجمة جديدة' }));
  const merged = core.mergeChapterIntoBook(bookText, newCh2, { startChapter: 2, endChapter: 2 });
  const mergedRows = parseTnTsv(merged);
  assert.deepStrictEqual(mergedRows.slice(0, 10), ch1);
  assert.deepStrictEqual(mergedRows.slice(10).map((r) => r.Note), newCh2.map(() => 'ترجمة جديدة'));

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
    assert.ok(checks);
    assert.throws(() => core.readBatchOutput(path.join(dir, 'nope.tsv'), batch), /no output file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBatchOutput byte-preserves pass-through columns from source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-out-'));
  try {
    const batch = rows().slice(1, 4);
    // Simulate the skill round-trip mangling the Quote: Note localized, and the
    // Hebrew Quote returned byte-different from source (a normalization drift or
    // any other re-emission). Healing must restore the source bytes verbatim.
    const out = batch.map((r) => ({ ...r, Note: 'ترجمة', Quote: r.Quote + 'ּ' }));
    const outFile = path.join(dir, 'out.tsv');
    fs.writeFileSync(outFile, serializeTnTsv(out));
    const { rows: parsed } = core.readBatchOutput(outFile, batch);
    // Healed: each output Quote is byte-identical to its source row again.
    for (const p of parsed) {
      const src = batch.find((r) => r.ID === p.ID);
      assert.strictEqual(p.Quote, src.Quote, `Quote must be restored verbatim for ${p.ID}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
