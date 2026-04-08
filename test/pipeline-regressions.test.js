const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSyntheticRoute } = require('../src/router');
const {
  parseGenerateCommand,
  buildParsedGenerateRequest,
  hasRequiredGeneratedOutputs,
} = require('../src/generate-pipeline');
const {
  parseWriteNotesCommand,
  buildParsedNotesRequest,
} = require('../src/notes-pipeline');

test('synthetic notes route preserves verse ranges from intent scopeText', () => {
  const route = buildSyntheticRoute({
    intent: 'notes',
    book: 'ISA',
    startChapter: 51,
    endChapter: 51,
    scopeText: '51:1-6',
  });

  assert.equal(route._startChapter, 51);
  assert.equal(route._endChapter, 51);
  assert.equal(route._verseStart, 1);
  assert.equal(route._verseEnd, 6);

  const parsed = buildParsedNotesRequest(route, 'write notes for isa 51:1-6');
  assert.equal(parsed.startChapter, 51);
  assert.equal(parsed.endChapter, 51);
  assert.equal(parsed.verseStart, 1);
  assert.equal(parsed.verseEnd, 6);
});

test('generate parser preserves verse ranges and ULT-only requirements', () => {
  const parsed = parseGenerateCommand('generate ULT isa 51:1-6');
  assert.deepEqual(
    {
      book: parsed.book,
      start: parsed.start,
      end: parsed.end,
      verseStart: parsed.verseStart,
      verseEnd: parsed.verseEnd,
      contentTypes: parsed.contentTypes,
    },
    {
      book: 'ISA',
      start: 51,
      end: 51,
      verseStart: 1,
      verseEnd: 6,
      contentTypes: ['ult'],
    }
  );

  assert.equal(hasRequiredGeneratedOutputs(['ult'], { hasUlt: true, hasUst: false }), true);
  assert.equal(hasRequiredGeneratedOutputs(['ult'], { hasUlt: false, hasUst: true }), false);
  assert.equal(hasRequiredGeneratedOutputs(['ust'], { hasUlt: false, hasUst: true }), true);
});

test('synthetic generate route preserves verse ranges from intent scopeText', () => {
  const route = buildSyntheticRoute({
    intent: 'generate',
    book: 'ISA',
    startChapter: 51,
    endChapter: 51,
    scopeText: '51:1-6',
  });

  assert.equal(route._verseStart, 1);
  assert.equal(route._verseEnd, 6);

  const parsed = buildParsedGenerateRequest(route, 'generate isa 51:1-6');
  assert.equal(parsed.verseStart, 1);
  assert.equal(parsed.verseEnd, 6);
});

test('write notes defaults to running chapter intro unless explicitly disabled', () => {
  const defaultParsed = parseWriteNotesCommand('write notes for isa 51');
  assert.equal(defaultParsed.withIntro, true);

  const disabledParsed = parseWriteNotesCommand('write notes for isa 51 --no-intro');
  assert.equal(disabledParsed.withIntro, false);
});
