// See-how pointers must join occurrences that mean the same thing (#452).
// Editors deleted pointers that shared a spelling or a root with their target
// but not its meaning; these tests pin the JER cases they reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CSKILLBP_DIR is captured when pipeline-utils loads, so it must be set before
// notes-pipeline is required.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'see-how-meaning-'));
process.env.CSKILLBP_DIR = WORKSPACE;
process.env.DOOR43_REPOS_PATH = path.join(WORKSPACE, 'door43-repos');

const {
  _runSeeHowDetection: runSeeHowDetection,
  _buildRecurrenceIndexFile: buildRecurrenceIndexFile,
} = require('../src/notes-pipeline');
const { deriveRecurrenceKeys, buildBookRecurrenceIndex } = require('../src/workspace-tools/recurrence-index');

const PARTRIDGE = 'קֹרֵ֤א'; // H7124, JER 17:11
const CALLED = 'קָרָ֤א'; // H7121, JER 20:3 -- same consonants
const ALL_THE_DAY = ['כָּל', 'הַ⁠יּ֔וֹם']; // H3605 H3117 "all day long", JER 20:7
const ALL_THE_DAYS = ['כָּל', 'הַ⁠יָּמִֽים']; // H3605 H3117 "always", JER 31:36
const ALL_YOUR_DAYS = ['כָּל', 'יְמֵי⁠כֶ֔ם']; // H3605 H3117 "all your life", JER 35:7
const SAID_TO_ME = ['וַ⁠יֹּ֣אמֶר', 'אֵלַ֔⁠י']; // H0559 H0413

function zaln(strong, content, eng) {
  return `\\zaln-s |x-strong="${strong}" x-lemma="l" x-occurrence="1" x-content="${content}"\\*` +
    `\\w ${eng}|x-occurrence="1"\\w*\\zaln-e\\*`;
}
function uhbWord(strong, content) {
  return `\\w ${content}|lemma="x" strong="${strong}"\\w*`;
}

/** One verse spec: { ref: '20:3', words: [[strong, hebrew], ...] }. */
function books(verses) {
  const byChapter = new Map();
  for (const v of verses) {
    const [c] = v.ref.split(':');
    if (!byChapter.has(c)) byChapter.set(c, []);
    byChapter.get(c).push(v);
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b);
  const ult = ['\\id JER'];
  const uhb = ['\\id JER'];
  for (const c of chapters) {
    ult.push(`\\c ${c}`, '\\p');
    uhb.push(`\\c ${c}`, '\\p');
    for (const v of byChapter.get(c)) {
      const vs = v.ref.split(':')[1];
      ult.push(`\\v ${vs} ${v.words.map(([s, h]) => zaln(s, h, 'x')).join(' ')}`);
      uhb.push(`\\v ${vs} ${v.words.map(([s, h]) => uhbWord(s, h)).join(' ')}`);
    }
  }
  return { ult: ult.join('\n') + '\n', uhb: uhb.join('\n') + '\n' };
}

function alignmentFor(verses, chapter) {
  const out = {};
  for (const v of verses) {
    const [c, vs] = v.ref.split(':');
    if (Number(c) !== Number(chapter)) continue;
    out[`${c}:${vs}`] = v.words.map(([strong, heb]) => ({ heb, strong }));
  }
  return out;
}

function tsv(rows) {
  return ['Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
    ...rows.map(([ref, id, sref, quote, note]) => `${ref}\t${id}\t\trc://*/ta/man/translate/${sref}\t${quote}\t1\t${note}`),
    ''].join('\n');
}

let dirCounter = 0;
function setup({ chapter, verses, tnRows, items = [] }) {
  const dirPath = `tmp/pipeline/JER-${chapter}-${dirCounter++}`;
  const abs = path.join(WORKSPACE, dirPath);
  fs.mkdirSync(abs, { recursive: true });
  const { ult, uhb } = books(verses);
  fs.writeFileSync(path.join(abs, 'ult.usfm'), ult);
  fs.writeFileSync(path.join(abs, 'hebrew.usfm'), uhb);
  fs.writeFileSync(path.join(abs, 'prepared_notes.json'), JSON.stringify({ book: 'JER', chapter, item_count: items.length, items }));
  fs.writeFileSync(path.join(abs, 'alignment_data.json'), JSON.stringify(alignmentFor(verses, chapter)));
  fs.writeFileSync(path.join(abs, 'generated_notes.json'), '{}');
  const clone = path.join(WORKSPACE, 'door43-repos', 'en_tn');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'tn_JER.tsv'), tsv(tnRows));
  fs.writeFileSync(path.join(abs, 'context.json'), JSON.stringify({
    version: 1, pipeline: 'notes', book: 'JER', chapter: Number(chapter),
    sources: { ultFull: `${dirPath}/ult.usfm`, hebrew: `${dirPath}/hebrew.usfm` },
    runtime: {
      preparedNotes: `${dirPath}/prepared_notes.json`,
      generatedNotes: `${dirPath}/generated_notes.json`,
      alignmentData: `${dirPath}/alignment_data.json`,
      recurrenceIndex: `${dirPath}/recurrence_index.json`,
      tnQualityFindings: `${dirPath}/tn_quality_findings.json`,
    },
    artifacts: {},
  }));
  return dirPath;
}

async function run(args) {
  const dirPath = setup(args);
  buildRecurrenceIndexFile({ pipeDir: dirPath });
  const stubIds = ({ count }) => Array.from({ length: count }, (_, i) => `z${String(i).padStart(3, '0')}`).join('\n');
  await runSeeHowDetection({ pipeDir: dirPath, generateIdsFn: stubIds });
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE, dirPath, 'prepared_notes.json'), 'utf8')).items;
}

function item(overrides) {
  return Object.assign({
    index: 0, id: 'aaaa', gl_quote: '', at_provided: '', explanation: 'x', note_type: 'given_at',
  }, overrides);
}

// --- partridge -------------------------------------------------------------

const PARTRIDGE_ROW = ['17:11', 'sg4t', 'translate-unknown', PARTRIDGE, 'A **partridge** is a kind of bird.'];
// A note on the verb, so the H7121 key is a query key in its own right.
const CALL_ROW = ['1:15', 'cl15', 'figs-idiom', CALLED, 'To **call** here means to summon.'];
const PARTRIDGE_VERSES = [
  { ref: '1:15', words: [['H7121', CALLED]] },
  { ref: '17:11', words: [['H7124', PARTRIDGE]] },
  { ref: '20:3', words: [['H7121', CALLED]] },
  { ref: '20:9', words: [['H7124', PARTRIDGE]] },
];

test('partridge: the verb קָרָא "call" never points at the note on קֹרֵא "partridge"', async () => {
  const items = await run({ chapter: 20, verses: PARTRIDGE_VERSES.slice(0, 3), tnRows: [PARTRIDGE_ROW] });
  const at17 = items.filter((it) => it.see_how_target === '17:11');
  assert.deepEqual(at17, [], 'no pointer to the partridge note is synthesized at 20:3');
});

test('partridge: an item flagged on the verb gets no partridge pointer', async () => {
  const items = await run({
    chapter: 20,
    verses: PARTRIDGE_VERSES.slice(0, 3),
    tnRows: [PARTRIDGE_ROW],
    items: [item({ reference: '20:3', sref: 'translate-unknown', orig_quote: CALLED })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].see_how_target, undefined);
  assert.equal(items[0].programmatic_note, undefined);
});

test('partridge: a real later partridge still points back to 17:11', async () => {
  const items = await run({ chapter: 20, verses: PARTRIDGE_VERSES, tnRows: [PARTRIDGE_ROW, CALL_ROW] });
  const at9 = items.find((it) => it.reference === '20:9');
  assert.ok(at9, 'a pointer is injected at the partridge in 20:9');
  assert.equal(at9.see_how_target, '17:11');
  assert.ok(!items.some((it) => it.reference === '20:3' && it.see_how_target === '17:11'));
});

test('partridge: the text key shared by two lemmas is not aliased to either', () => {
  const { ult } = books(PARTRIDGE_VERSES);
  const index = buildBookRecurrenceIndex({ book: 'JER', chapter: 20, ultFullUsfm: ult, tnBookTsv: tsv([PARTRIDGE_ROW, CALL_ROW]) });
  assert.equal(index.canonical['קרא'], 'קרא');
  const corpus = (index.byKey['קרא'] || []).filter((o) => o.source === 'corpus');
  assert.deepEqual(corpus.map((o) => `${o.ref}=${o.strongKey}`).sort(),
    ['17:11=H7124', '1:15=H7121', '20:3=H7121', '20:9=H7124']);
});

// --- yom phrases -----------------------------------------------------------

const yomWords = (pair) => [['H3605', pair[0]], ['H3117', pair[1]]];
const ALL_DAY_ROW = ['20:7', 'ad07', 'figs-idiom', `${ALL_THE_DAY[0]}־${ALL_THE_DAY[1]}`,
  'Jeremiah is using **all the day** to mean "all day long."'];

test('yom: כָּל + יוֹם phrases key on their wording, not on H3605+H3117', () => {
  const k = (pair) => deriveRecurrenceKeys({
    origQuote: pair.join(' '),
    alignmentEntries: yomWords(pair).map(([strong, heb]) => ({ heb, strong })),
  });
  assert.equal(k(ALL_THE_DAY).strongKey, '');
  assert.equal(k(ALL_THE_DAY).textKey, 'כל+היום');
  assert.notEqual(k(ALL_THE_DAYS).textKey, k(ALL_THE_DAY).textKey);
  assert.notEqual(k(ALL_YOUR_DAYS).textKey, k(ALL_THE_DAY).textKey);
  // A content word still keys by lemma: "days are coming" is one idiom.
  const coming = deriveRecurrenceKeys({
    origQuote: 'יָמִ֥ים בָּאִ֖ים',
    alignmentEntries: [{ heb: 'יָמִ֥ים', strong: 'H3117' }, { heb: 'בָּאִ֖ים', strong: 'H0935' }],
  });
  assert.equal(coming.strongKey, 'H3117+H0935');
  // Other stoplist-only formulas keep their Strong's key.
  const word = deriveRecurrenceKeys({
    origQuote: 'דְּבַר־יְהוָ֖ה',
    alignmentEntries: [{ heb: 'דְּבַר', strong: 'H1697' }, { heb: 'יְהוָ֖ה', strong: 'H3068' }],
  });
  assert.equal(word.strongKey, 'H1697+H3068');
});

test('yom: "all the days" and "all your days" do not point at "all the day"', async () => {
  const verses = [
    { ref: '20:7', words: yomWords(ALL_THE_DAY) },
    { ref: '31:36', words: yomWords(ALL_THE_DAYS) },
    { ref: '31:38', words: yomWords(ALL_YOUR_DAYS) },
  ];
  const items = await run({
    chapter: 31,
    verses,
    tnRows: [ALL_DAY_ROW],
    items: [
      item({ id: 'd036', reference: '31:36', sref: 'figs-idiom', orig_quote: ALL_THE_DAYS.join('־') }),
      item({ id: 'd038', reference: '31:38', sref: 'figs-idiom', orig_quote: ALL_YOUR_DAYS.join(' '), index: 1 }),
    ],
  });
  assert.deepEqual(items.map((it) => it.see_how_target).filter(Boolean), []);
  assert.deepEqual(items.map((it) => it.id).sort(), ['d036', 'd038'], 'each keeps its own note');
});

test('yom: the same "all the day" wording still points back', async () => {
  const verses = [
    { ref: '20:7', words: yomWords(ALL_THE_DAY) },
    { ref: '31:20', words: yomWords(ALL_THE_DAY) },
  ];
  const items = await run({
    chapter: 31,
    verses,
    tnRows: [ALL_DAY_ROW],
    items: [item({ reference: '31:20', sref: 'figs-idiom', orig_quote: ALL_THE_DAY.join('־') })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].see_how_target, '20:7');
});

// --- pronouns --------------------------------------------------------------

test('pronouns: a writing-pronouns note is never pointed at; each verse names its own referent', async () => {
  const verses = [
    { ref: '2:1', words: SAID_TO_ME.map((h, i) => [['H0559', 'H0413'][i], h]) },
    { ref: '3:1', words: SAID_TO_ME.map((h, i) => [['H0559', 'H0413'][i], h]) },
    { ref: '3:4', words: SAID_TO_ME.map((h, i) => [['H0559', 'H0413'][i], h]) },
  ];
  const pronounRow = ['2:1', 'pr21', 'writing-pronouns', SAID_TO_ME.join(' '), 'The pronoun **he** refers to Yahweh.'];
  const flagged = await run({
    chapter: 3,
    verses,
    tnRows: [pronounRow],
    items: [item({ reference: '3:1', sref: 'writing-pronouns', orig_quote: SAID_TO_ME.join(' ') })],
  });
  assert.equal(flagged.length, 1, 'nothing injected at 3:4');
  assert.equal(flagged[0].see_how_target, undefined);
  assert.equal(flagged[0].also_occurs_verses, undefined);

  const bare = await run({ chapter: 3, verses, tnRows: [pronounRow] });
  assert.deepEqual(bare, [], 'no pointer is synthesized where nothing was flagged');
});
