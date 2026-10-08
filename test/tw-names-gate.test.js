const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-names-gate-'));
process.env.CSKILLBP_DIR = ws;
fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
fs.mkdirSync(path.join(ws, 'issues'), { recursive: true });

const headwords = [
  { twarticle: 'nebuchadnezzar', category: 'names', headwords: ['Nebuchadnezzar'] },
  { twarticle: 'babylon', category: 'names', headwords: ['Babylon', 'Babylonian'] },
  { twarticle: 'ahaz', category: 'names', headwords: ['Ahaz'] },
  { twarticle: 'chaldeans', category: 'names', headwords: ['Chaldea', 'Chaldean'] },
  { twarticle: 'jezreel', category: 'names', headwords: ['Jezreel'] },
  { twarticle: 'josiah', category: 'names', headwords: ['Josiah'] },
  { twarticle: 'sin', category: 'kt', headwords: ['sin', 'sins'] },
  { twarticle: 'god', category: 'kt', headwords: ['God'] },
];

function setup(rows, { withHeadwords = true } = {}) {
  const hwFile = path.join(ws, 'data', 'tw_headwords.json');
  if (withHeadwords) fs.writeFileSync(hwFile, JSON.stringify(headwords));
  else fs.rmSync(hwFile, { force: true });
  const rel = `issues/JER-35-${Math.random().toString(36).slice(2)}.tsv`;
  const text = rows.map((r) => r.join('\t')).join('\n') + '\n';
  fs.writeFileSync(path.join(ws, rel), text);
  return { rel, text };
}

const row = (ref, sref, quote, hint = '') => ['JER', ref, sref, quote, '', '', hint];
const { dropTwCoveredNameRows, nameWords } = require('../src/tw-names-gate');

test('drops a translate-names row when every name word has a tW names article', () => {
  const keep = row('4:1', 'figs-idiom', 'a hard saying', 'idiom');
  const { rel } = setup([
    row('35:11', 'translate-names', 'Nebuchadnezzar king of Babylon', 'name of a man and his kingdom'),
    row('7:1', 'translate-names', 'Ahaz', 'name of a man'),
    keep,
  ]);
  const res = dropTwCoveredNameRows({ issuesPath: rel });
  assert.equal(res.ran, true);
  assert.deepEqual(res.dropped.map((d) => d.ref), ['35:11', '7:1']);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), keep.join('\t') + '\n');
});

test('never empties the issues file', () => {
  const { rel, text } = setup([row('7:1', 'translate-names', 'Ahaz', 'name of a man')]);
  const res = dropTwCoveredNameRows({ issuesPath: rel });
  assert.deepEqual(res.dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('keeps a row when any name word has no article', () => {
  const { rel, text } = setup([row('35:3', 'translate-names', 'Jaazaniah son of Josiah', 'names of men')]);
  const res = dropTwCoveredNameRows({ issuesPath: rel });
  assert.deepEqual(res.dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('only the names category counts: kt headwords do not drop a name row', () => {
  const { rel, text } = setup([
    row('30:15', 'translate-names', 'Sin', 'name of a city'),
    row('1:9', 'translate-names', 'God', 'El - a title/name for God'),
  ]);
  assert.deepEqual(dropTwCoveredNameRows({ issuesPath: rel }).dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('keeps a row whose hint says the meaning matters or the person differs', () => {
  const { rel, text } = setup([
    row('1:4', 'translate-names', 'Jezreel', 'symbolic name - means God sows/scatters'),
    row('6:10', 'translate-names', 'Josiah', 'different person from King Josiah'),
  ]);
  assert.deepEqual(dropTwCoveredNameRows({ issuesPath: rel }).dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('leaves other issue types on the same name alone', () => {
  const { rel, text } = setup([row('50:1', 'figs-metonymy', 'Babylon', 'Babylon stands for its people')]);
  assert.deepEqual(dropTwCoveredNameRows({ issuesPath: rel }).dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('matches the rc:// sref form and plural names, and keeps untouched rows byte-identical', () => {
  const keep = row('4:1', 'figs-idiom', 'a hard saying', 'idiom');
  const { rel } = setup([
    row('35:11', 'rc://*/ta/man/translate/translate-names', 'the Chaldeans', 'name of a people group'),
    keep,
  ]);
  const res = dropTwCoveredNameRows({ issuesPath: rel });
  assert.deepEqual(res.dropped.map((d) => d.quote), ['the Chaldeans']);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), keep.join('\t') + '\n');
});

test('a missing headwords file leaves the issues file untouched and does not throw', () => {
  const { rel, text } = setup([row('7:1', 'translate-names', 'Ahaz', 'name of a man')], { withHeadwords: false });
  const res = dropTwCoveredNameRows({ issuesPath: rel });
  assert.equal(res.ran, false);
  assert.deepEqual(res.dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('keeps rows whose hint says the person is not the one the article describes', () => {
  const { rel, text } = setup([
    row('6:10', 'translate-names', 'Josiah', 'This Josiah was not King Josiah'),
    row('6:11', 'translate-names', 'Josiah', 'another Josiah, son of Zephaniah'),
    row('6:12', 'translate-names', 'Josiah', 'homonym of the king'),
  ]);
  assert.deepEqual(dropTwCoveredNameRows({ issuesPath: rel }).dropped, []);
  assert.equal(fs.readFileSync(path.join(ws, rel), 'utf8'), text);
});

test('a quote with trailing punctuation or wrapping quotes still matches', () => {
  const { rel } = setup([
    row('7:1', 'translate-names', 'Ahaz.', 'name of a man'),
    row('7:2', 'translate-names', '\u201CBabylon\u201D', 'name of a city'),
    row('4:1', 'figs-idiom', 'a hard saying', 'idiom'),
  ]);
  assert.equal(dropTwCoveredNameRows({ issuesPath: rel }).dropped.length, 2);
});

test('nameWords strips connectors, titles and possessives', () => {
  assert.deepEqual(nameWords('the {land of} Babylon’s king Nebuchadnezzar, son of Josiah'), ['Babylon', 'Nebuchadnezzar', 'Josiah']);
});
