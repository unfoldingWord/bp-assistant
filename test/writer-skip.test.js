'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// tn-tools resolves paths against CSKILLBP_DIR, read at module load.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-skip-'));
process.env.CSKILLBP_DIR = WORK;

const {
  parseWriterSkip,
  applyWriterSkips,
  readWriterSkipped,
  assembleNotes,
  _buildWriterPacket,
  _buildWriterPrompt,
  _resolveTemplateSelection,
  _addBuiltinTemplates,
  _parseExplanationDirectives,
} = require('../src/workspace-tools/tn-tools');

function writeJson(rel, obj) {
  const p = path.join(WORK, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return rel;
}
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(WORK, rel), 'utf8')); }

test('parseWriterSkip recognises the marker and returns its reason; ordinary notes are not skips', () => {
  assert.equal(parseWriterSkip('SKIP_NOTE: antithetical, the second line contrasts'), 'antithetical, the second line contrasts');
  assert.equal(parseWriterSkip('  SKIP_NOTE - climactic\n'), 'climactic');
  assert.equal(parseWriterSkip('SKIP_NOTE'), '');
  assert.equal(parseWriterSkip('See how your translation team has decided to represent pairs of clauses'), null);
  assert.equal(parseWriterSkip('The note says SKIP_NOTE: later in the text'), null);
  assert.equal(parseWriterSkip(''), null);
  assert.equal(parseWriterSkip(undefined), null);
});

test('only parallelism-repeat items get the skip instruction in packet and prompt', () => {
  const base = { reference: '35:4', id: 'aaaa', gl_quote: 'x', template_text: 'T', clean_explanation: '', must_include: [], style_rules: [], rule_overrides: [] };
  const repeat = { ...base, sref: 'figs-parallelism', template_type: 'parallelism-repeat', skip_allowed: true };
  const packet = _buildWriterPacket(repeat);
  assert.equal(packet.skip_allowed, true);
  assert.equal(packet.skip_marker, 'SKIP_NOTE');
  assert.match(packet.skip_instruction, /really do mean basically the same thing/);
  assert.match(packet.skip_instruction, /synthetic, antithetical, climactic, chiasm, emblematic/);
  assert.match(packet.skip_instruction, /SKIP_NOTE: </);
  assert.match(_buildWriterPrompt(repeat), /SKIP RULE/);

  const other = _buildWriterPacket({ ...base, sref: 'figs-metaphor', template_type: 'generic' });
  assert.equal(other.skip_allowed, false);
  assert.equal(other.skip_instruction, '');
  assert.doesNotMatch(_buildWriterPrompt({ ...base, sref: 'figs-metaphor', template_type: 'generic' }), /SKIP RULE/);
});

test('a t: parallelism-repeat hint selects the built-in template that prepareNotes marks skippable', () => {
  const templateMap = _addBuiltinTemplates(new Map([['figs-parallelism', []]]));
  const sel = _resolveTemplateSelection({
    sref: 'figs-parallelism',
    templateHints: _parseExplanationDirectives('synonymous parallelism t: parallelism-repeat').template_hints,
    templateMap,
  });
  assert.equal(sel.selected_template.type, 'parallelism-repeat');
});

test('applyWriterSkips drops the marked note from generated + prepared and records it', () => {
  const prep = writeJson('a/prepared_notes.json', {
    book: 'PSA', chapter: '35', item_count: 3,
    items: [
      { id: 'i1', reference: '35:1', sref: 'figs-parallelism', gl_quote: 'A; B', skip_allowed: false },
      { id: 'i2', reference: '35:4', sref: 'figs-parallelism', gl_quote: 'C; D', skip_allowed: true },
      { id: 'i3', reference: '35:7', sref: 'figs-parallelism', gl_quote: 'E; F', skip_allowed: true },
    ],
  });
  const gen = writeJson('a/generated_notes.json', {
    i1: 'Full first-instance note.',
    i2: 'SKIP_NOTE: synthetic, the second line adds a result',
    i3: 'See how your translation team has decided to represent pairs of clauses in Hebrew poetry that mean basically the same thing.',
  });
  const skipped = applyWriterSkips({ preparedJson: prep, generatedJson: gen });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'i2');
  assert.equal(skipped[0].reference, '35:4');
  assert.equal(skipped[0].reason, 'synthetic, the second line adds a result');
  assert.deepEqual(Object.keys(readJson(gen)), ['i1', 'i3']);
  const after = readJson(prep);
  assert.deepEqual(after.items.map((i) => i.id), ['i1', 'i3']);
  assert.equal(after.item_count, 2);
  assert.deepEqual(readWriterSkipped(prep).map((r) => r.id), ['i2']);
  // Idempotent: a second run finds nothing and keeps the record.
  assert.deepEqual(applyWriterSkips({ preparedJson: prep, generatedJson: gen }), []);
  assert.deepEqual(readWriterSkipped(prep).map((r) => r.id), ['i2']);
});

test('assembleNotes leaves no row for a skipped note and says so in its result', () => {
  const prep = writeJson('b/prepared_notes.json', {
    book: 'PSA', chapter: '35',
    items: [
      { id: 'k1', reference: '35:1', sref: 'figs-parallelism', orig_quote: 'q1', gl_quote: 'A; B', ult_verse: 'A; B' },
      { id: 'k2', reference: '35:4', sref: 'figs-parallelism', orig_quote: 'q2', gl_quote: 'C; D', ult_verse: 'C; D', skip_allowed: true },
    ],
  });
  const gen = writeJson('b/generated_notes.json', { k1: 'Real note.', k2: 'SKIP_NOTE: antithetical' });
  const out = 'b/out.tsv';
  const result = assembleNotes({ preparedJson: prep, generatedJson: gen, output: out });
  const rows = fs.readFileSync(path.join(WORK, out), 'utf8').trim().split('\n').slice(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split('\t')[1], 'k1');
  assert.doesNotMatch(fs.readFileSync(path.join(WORK, out), 'utf8'), /SKIP_NOTE/);
  assert.match(result, /Assembled 1 notes/);
  assert.match(result, /Writer skipped: 1 \(k2 35:4\)/);
  assert.doesNotMatch(result, /Missing/);
});
