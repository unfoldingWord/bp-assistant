// See-how pointers skip names that have a tW article (issue #457).
//
// The tW names check (tw-article-gate.js) drops translate-names rows for names with
// a tW names article. Pointer injection reads the published notes instead, so it
// must apply the same test: no "See how you translated this name" back to a
// translate-names note on such a name. A name without an article keeps its pointer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'see-how-tw-names-'));
process.env.CSKILLBP_DIR = WORKSPACE;
process.env.DOOR43_REPOS_PATH = path.join(WORKSPACE, 'door43-repos');

const {
  _runSeeHowDetection: runSeeHowDetection,
  _buildRecurrenceIndexFile: buildRecurrenceIndexFile,
} = require('../src/notes-pipeline');

// Ahaz has a tW names article; Rezin does not.
const AHAZ = 'אָחָ֖ז';
const AHAZ_STRONG = 'H0271';
const REZIN = 'רְצִ֥ין';
const REZIN_STRONG = 'H7526';

const HEADWORDS_FILE = path.join(WORKSPACE, 'data', 'tw_headwords.json');
function writeHeadwords() {
  fs.mkdirSync(path.dirname(HEADWORDS_FILE), { recursive: true });
  fs.writeFileSync(HEADWORDS_FILE, JSON.stringify([
    { twarticle: 'ahaz', category: 'names', headwords: ['Ahaz'] },
    { twarticle: 'sin', category: 'kt', headwords: ['sin'] },
  ]));
}

const aligned = (strong, content, word) =>
  `\\zaln-s |x-strong="${strong}" x-lemma="l" x-occurrence="1" x-content="${content}"\\*` +
  `\\w ${word}|x-occurrence="1"\\w*\\zaln-e\\*`;
const verseBoth = () => `${aligned(AHAZ_STRONG, AHAZ, 'Ahaz')} ${aligned(REZIN_STRONG, REZIN, 'Rezin')}`;

// Both names are noted in ISA 7:1 and recur in ISA 9:4.
const ALIGNED_ISA = [
  '\\id ISA',
  '\\c 7', '\\p', `\\v 1 ${verseBoth()}`,
  '\\c 9', '\\p', `\\v 4 ${verseBoth()}`,
  '',
].join('\n');
const uhbWord = (w, s) => `\\w ${w}|lemma="l" strong="${s}"\\w*`;
const UHB_ISA = [
  '\\id ISA',
  '\\c 7', `\\v 1 ${uhbWord(AHAZ, AHAZ_STRONG)} ${uhbWord(REZIN, REZIN_STRONG)}`,
  '\\c 9', `\\v 4 ${uhbWord(AHAZ, AHAZ_STRONG)} ${uhbWord(REZIN, REZIN_STRONG)}`,
  '',
].join('\n');
const ALIGNMENT_DATA = {
  '7:1': [{ heb: AHAZ, strong: AHAZ_STRONG }, { heb: REZIN, strong: REZIN_STRONG }],
  '9:4': [{ heb: AHAZ, strong: AHAZ_STRONG }, { heb: REZIN, strong: REZIN_STRONG }],
};

const TN_ISA = [
  'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
  `7:1\taaa1\t\trc://*/ta/man/translate/translate-names\t${AHAZ}\t1\tThe word **Ahaz** is the name of a man. He was king of Judah.`,
  `7:1\taaa2\t\trc://*/ta/man/translate/translate-names\t${REZIN}\t1\tThe word **Rezin** is the name of a man. He was the king of Aram.`,
  '',
].join('\n');

let dirCounter = 0;
function setupPipeDir(items = [], tn = TN_ISA) {
  const dirPath = `tmp/pipeline/ISA-09-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'ult.usfm'), ALIGNED_ISA);
  fs.writeFileSync(path.join(abs, 'hebrew.usfm'), UHB_ISA);
  fs.writeFileSync(path.join(abs, 'prepared_notes.json'), JSON.stringify({
    book: 'ISA', chapter: '9', item_count: items.length, items,
  }, null, 2));
  fs.writeFileSync(path.join(abs, 'alignment_data.json'), JSON.stringify(ALIGNMENT_DATA));
  fs.writeFileSync(path.join(abs, 'generated_notes.json'), '{}');

  const clone = path.join(WORKSPACE, 'door43-repos', 'en_tn');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'tn_ISA.tsv'), tn);

  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({
    version: 1, pipeline: 'notes', book: 'ISA', chapter: 9,
    verseStart: null, verseEnd: null,
    sources: { ultFull: `${dirPath}/ult.usfm`, hebrew: `${dirPath}/hebrew.usfm` },
    runtime: {
      preparedNotes: `${dirPath}/prepared_notes.json`,
      generatedNotes: `${dirPath}/generated_notes.json`,
      alignmentData: `${dirPath}/alignment_data.json`,
      recurrenceIndex: `${dirPath}/recurrence_index.json`,
    },
    artifacts: {},
  }, null, 2));
  return dirPath;
}
const readPrepared = (d) =>
  JSON.parse(fs.readFileSync(path.join(WORKSPACE, d, 'prepared_notes.json'), 'utf8'));
const stubIds = ({ count }) =>
  Array.from({ length: count }, (_, i) => `z${String(i).padStart(3, '0')}`).join('\n');

async function run(items, tn) {
  const dirPath = setupPipeDir(items, tn);
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const summary = await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });
  return { items: readPrepared(dirPath).items, summary };
}

const nameItem = (over) => Object.assign({
  index: 0, reference: '9:4', id: 'bbbb', sref: 'translate-names',
  orig_quote: AHAZ, gl_quote: 'Ahaz', issue_span_gl_quote: 'Ahaz',
  at_provided: '', explanation: 'A name.', note_type: 'given_at',
}, over);

test('T1: no pointer is injected for a tW name; a name without an article still gets one', async () => {
  writeHeadwords();
  const { items, summary } = await run([]);

  const pointers = items.filter((it) => /See how you translated/.test(it.programmatic_note || ''));
  assert.equal(pointers.length, 1, 'only Rezin is injected');
  assert.equal(pointers[0].orig_quote || pointers[0].quote, REZIN);
  assert.equal(pointers[0].see_how_target, '7:1');
  assert.ok(!items.some((it) => (it.orig_quote || it.quote) === AHAZ), 'no Ahaz row synthesized');
  assert.match(summary, /1 injected/);
  assert.match(summary, /1 skipped \(tW name\)/);
});

test('T2: a prepared item on a tW name is not rewritten into a pointer', async () => {
  writeHeadwords();
  const { items } = await run([
    nameItem({ id: 'ahz1' }),
    nameItem({ id: 'rzn1', index: 1, orig_quote: REZIN, gl_quote: 'Rezin', issue_span_gl_quote: 'Rezin' }),
  ]);

  const ahaz = items.find((it) => it.id === 'ahz1');
  assert.equal(ahaz.note_type, 'given_at', 'left for the writer, not a see-how pointer');
  assert.equal(ahaz.programmatic_note, undefined);
  assert.equal(ahaz.see_how_target, undefined);

  const rezin = items.find((it) => it.id === 'rzn1');
  assert.equal(rezin.note_type, 'see_how');
  assert.equal(rezin.see_how_target, '7:1');
});

test('T3: without the tW headwords file, pointers are kept as before', async () => {
  fs.rmSync(HEADWORDS_FILE, { force: true });
  const { items, summary } = await run([]);

  const targets = items.filter((it) => it.see_how_target === '7:1');
  assert.equal(targets.length, 2, 'both names injected when the check cannot run');
  assert.match(summary, /0 skipped \(tW name\)/);
});

test('T4: a note that also names someone without an article keeps its pointer', async () => {
  writeHeadwords();
  const tn = TN_ISA.replace('He was king of Judah.', 'He made an alliance with **Rezin**.');
  const { items } = await run([], tn);

  const targets = items.filter((it) => it.see_how_target === '7:1');
  assert.equal(targets.length, 2, 'Ahaz is kept because its note also explains Rezin');
});
