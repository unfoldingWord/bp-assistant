// Regression test for parseAlignedUsfm dropping alignments that share a line
// with their verse marker.
//
// The parser used to `continue` as soon as a line began with \c or \v, which
// discarded the rest of that line. The ULT routinely puts alignment data there:
// measured across real GEN/1KI/JOB/PSA/OBA/HAG, 2507 of 69210 zaln-s milestones
// (3.6%) sit on a verse-marker line, and in Genesis all 1492 of them do. Once
// curate-data's buildAllIndexes was changed to delegate here, this became the
// only parser behind strongs_index.json and ust_index.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'strongs-parse-'));
process.env.CSKILLBP_DIR = WS;

const { buildStrongsIndex } = require('../src/workspace-tools/index-tools');

const ULT_DIR = path.join(WS, 'data', 'published_ult');

function zaln(strong, hebrew, english) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="${hebrew}" x-content="${hebrew}"\\*` +
    `\\w ${english}|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`;
}

function seed(lines) {
  fs.rmSync(ULT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ULT_DIR, { recursive: true });
  fs.rmSync(path.join(WS, 'data', 'cache'), { recursive: true, force: true });
  fs.writeFileSync(path.join(ULT_DIR, '08-RUT.usfm'), ['# Fetched: 2026-08-19', ...lines, ''].join('\n'));
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(WS, 'data', 'cache', 'strongs_index.json'), 'utf-8'));
}

test('an alignment sharing a line with its verse marker is indexed', async () => {
  seed([
    '\\id RUT',
    '\\c 1',
    '\\p',
    // The marker and the alignment on ONE line — the shape the ULT actually uses.
    `\\v 1 ${zaln('H0001', 'אָב', 'father')}`,
  ]);

  await buildStrongsIndex({ force: true });
  const idx = readIndex();

  assert.ok(idx.H0001, 'H0001 must be indexed even though it shares the \\v line');
  assert.equal(idx._meta.total_alignments, 1);
  const refs = idx.H0001.renderings.flatMap((r) => r.refs || []);
  assert.ok(refs.some((r) => /1:1$/.test(r)), `expected a 1:1 reference, got ${JSON.stringify(refs)}`);
});

test('the verse number from a shared line still attributes later alignments correctly', async () => {
  seed([
    '\\id RUT',
    '\\c 1',
    '\\p',
    `\\v 1 ${zaln('H0001', 'אָב', 'father')}`,
    zaln('H0002', 'אֵם', 'mother'),
    `\\v 2 ${zaln('H0003', 'בֵּן', 'son')}`,
  ]);

  await buildStrongsIndex({ force: true });
  const idx = readIndex();

  assert.equal(idx._meta.total_alignments, 3);
  const refOf = (s) => idx[s].renderings.flatMap((r) => r.refs || []).join(',');
  assert.match(refOf('H0001'), /1:1/, 'H0001 is in verse 1');
  assert.match(refOf('H0002'), /1:1/, 'H0002 follows on its own line, still verse 1');
  assert.match(refOf('H0003'), /1:2/, 'H0003 is in verse 2');
});

test('a chapter marker sharing a line with an alignment resets the verse and still indexes', async () => {
  seed([
    '\\id RUT',
    '\\p',
    `\\c 2 ${zaln('H0004', 'יוֹם', 'day')}`,
  ]);

  await buildStrongsIndex({ force: true });
  const idx = readIndex();

  assert.ok(idx.H0004, 'an alignment on a \\c line must be indexed');
  const refs = idx.H0004.renderings.flatMap((r) => r.refs || []).join(',');
  assert.match(refs, /2:0/, `chapter 2, verse not yet set: got ${refs}`);
});

test('a bare verse marker line still parses and adds nothing', async () => {
  seed(['\\id RUT', '\\c 1', '\\p', '\\v 1', zaln('H0005', 'אוֹר', 'light')]);

  await buildStrongsIndex({ force: true });
  const idx = readIndex();

  assert.equal(idx._meta.total_alignments, 1);
  assert.match(idx.H0005.renderings.flatMap((r) => r.refs || []).join(','), /1:1/);
});
