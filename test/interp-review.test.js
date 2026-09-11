'use strict';

// Guards for the interpretive review stage (issue #382). The load-bearing
// invariant is that the stage only ever rewrites the explanation column (and
// the sref column for `retype`) — the quote column is matched mechanically
// downstream, so a single altered byte there breaks note generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule(workspaceDir) {
  const prev = process.env.CSKILLBP_DIR;
  if (workspaceDir) process.env.CSKILLBP_DIR = workspaceDir;
  delete require.cache[require.resolve('../src/pipeline-utils')];
  delete require.cache[require.resolve('../src/interp-review')];
  const mod = require('../src/interp-review');
  return { mod, restore: () => { if (prev === undefined) delete process.env.CSKILLBP_DIR; else process.env.CSKILLBP_DIR = prev; } };
}

const {
  parseIssuesTsv,
  serializeIssuesTsv,
  selectRows,
  chunkRows,
  parseVerdicts,
  applyVerdicts,
  resolveInterpReviewSettings,
  extractChapter,
  MAX_ROWS_PER_CALL,
} = require('../src/interp-review');

// Canonical headerless issues TSV: Book Ref SRef GLQuote NeedsAT AT Explanation
const SAMPLE = [
  'EZK\t1:1\tfigs-idiom\tthe heavens were opened\tfalse\t\tIdiom for a vision beginning',
  'EZK\t1:3\tfigs-metonymy\tthe hand of Yahweh\tfalse\t\tThe hand stands for power',
  'EZK\t1:4\ttranslate-names\tChebar\tfalse\t\tName of a canal',
  'EZK\t1:5\tfigs-simile\tlikeness of four living creatures\tfalse\t\tTCM either creatures or beings',
  'EZK\t1:6\tgrammar-connect\tand\tfalse\t\tSimple connector',
  'EZK\t1:7\ttranslate-unknown\tburnished bronze\tfalse\t\tThis could mean polished metal',
].join('\n');

test('selector picks interpretive srefs, TCM explanations, and hedged explanations', () => {
  const { rows } = parseIssuesTsv(SAMPLE);
  const selected = selectRows(rows);
  const picked = selected.map((r) => r.index).sort((a, b) => a - b);
  // 0 figs-idiom (sref), 1 figs-metonymy (sref), 3 TCM prefix, 5 "could" hedge.
  assert.deepEqual(picked, [0, 1, 3, 5]);
});

test('selector skips non-interpretive rows and malformed short rows', () => {
  const { rows } = parseIssuesTsv(`${SAMPLE}\nEZK\t1:8\tfigs-idiom\ttoo few columns`);
  const selected = selectRows(rows);
  assert.ok(!selected.some((r) => r.index === 2), 'translate-names row must not be selected');
  assert.ok(!selected.some((r) => r.index === 4), 'grammar-connect row must not be selected');
  assert.ok(!selected.some((r) => r.index === 6), 'short row must not be selected');
});

test('rows are chunked at the per-call cap', () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ index: i }));
  const chunks = chunkRows(many, MAX_ROWS_PER_CALL);
  assert.equal(MAX_ROWS_PER_CALL, 40);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 40);
  assert.equal(chunks[1].length, 1);
});

test('verdict JSON parses bare, fenced, prose-wrapped, and bare-array forms', () => {
  const bare = parseVerdicts('{"verdicts":[{"index":0,"action":"agree"}]}');
  assert.equal(bare.length, 1);
  const fenced = parseVerdicts('```json\n{"verdicts":[{"index":1,"action":"drop"}]}\n```');
  assert.equal(fenced[0].action, 'drop');
  const prosey = parseVerdicts('Here you go:\n{"verdicts":[{"index":2,"action":"agree"}]}\nDone.');
  assert.equal(prosey[0].index, 2);
  const arr = parseVerdicts('[{"index":3,"action":"agree"}]');
  assert.equal(arr[0].index, 3);
});

test('malformed or empty verdict payloads parse to null', () => {
  assert.equal(parseVerdicts('not json at all'), null);
  assert.equal(parseVerdicts('{"verdicts": "nope"}'), null);
  assert.equal(parseVerdicts(''), null);
  assert.equal(parseVerdicts(null), null);
});

test('apply rewrites only the explanation column and leaves quote bytes identical', () => {
  const { rows } = parseIssuesTsv(SAMPLE);
  const allowed = new Set(selectRows(rows).map((r) => r.index));
  const before = parseIssuesTsv(SAMPLE).rows;
  const result = applyVerdicts(rows, [
    { index: 0, action: 'revise', explanation: 'Explicit: the vision began', reason: 'editor ruling' },
  ], allowed);

  const changed = result.rows.find((r) => r.index === 0);
  assert.equal(changed.cols[6], 'Explicit: the vision began');
  // Every other column of the touched row is byte-identical.
  for (const col of [0, 1, 2, 3, 4, 5]) {
    assert.equal(changed.cols[col], before[0].cols[col], `column ${col} must be untouched`);
  }
  // And every untouched row is byte-identical.
  for (const row of result.rows.filter((r) => r.index !== 0)) {
    assert.equal(row.cols.join('\t'), before[row.index].raw);
  }
  assert.equal(result.counts.revise, 1);
});

test('retype rewrites the sref column but never the quote column', () => {
  const { rows } = parseIssuesTsv(SAMPLE);
  const allowed = new Set(selectRows(rows).map((r) => r.index));
  const result = applyVerdicts(rows, [{ index: 0, action: 'retype', sref: 'figs-explicit' }], allowed);
  const row = result.rows.find((r) => r.index === 0);
  assert.equal(row.cols[2], 'figs-explicit');
  assert.equal(row.cols[3], 'the heavens were opened');
  assert.equal(result.counts.retype, 1);
});

test('tcm verdict forces a leading TCM marker; drop removes the row', () => {
  const { rows } = parseIssuesTsv(SAMPLE);
  const allowed = new Set(selectRows(rows).map((r) => r.index));
  const result = applyVerdicts(rows, [
    { index: 0, action: 'tcm', explanation: 'a vision opened, or the sky split' },
    { index: 1, action: 'drop' },
  ], allowed);
  assert.match(result.rows.find((r) => r.index === 0).cols[6], /^TCM /);
  assert.equal(result.rows.find((r) => r.index === 1), undefined);
  assert.equal(result.counts.drop, 1);
});

test('verdicts for unselected, duplicate, or invalid rows are rejected, not applied', () => {
  const { rows } = parseIssuesTsv(SAMPLE);
  const allowed = new Set(selectRows(rows).map((r) => r.index));
  const result = applyVerdicts(rows, [
    { index: 2, action: 'revise', explanation: 'should be ignored' },   // not selected
    { index: 99, action: 'revise', explanation: 'hallucinated index' }, // out of range
    { index: 0, action: 'retype', sref: 'figs-notreal' },               // sref off-catalog
    { index: 1, action: 'revise' },                                     // missing explanation
    { index: 3, action: 'sideways' },                                   // unknown action
  ], allowed);
  assert.equal(result.counts.invalid, 5);
  assert.equal(result.changed, false);
  assert.equal(result.rows.find((r) => r.index === 2).cols[6], 'Name of a canal');
  assert.equal(result.rows.find((r) => r.index === 0).cols[2], 'figs-idiom');
});

test('serialize round-trips an untouched file byte-for-byte', () => {
  for (const text of [SAMPLE, `${SAMPLE}\n`]) {
    const { rows, hadTrailingNewline } = parseIssuesTsv(text);
    assert.equal(serializeIssuesTsv(rows, hadTrailingNewline), text);
  }
});

test('settings default to off and honour config, book list, and env overrides', () => {
  const envKeys = ['BP_INTERP_REVIEW_MODE', 'BP_INTERP_REVIEW_BOOKS', 'BP_INTERP_REVIEW_MODEL'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  try {
    assert.equal(resolveInterpReviewSettings({}, 'EZK').enabled, false, 'off by default');

    const report = resolveInterpReviewSettings({ interpReview: { mode: 'report' } }, 'EZK');
    assert.equal(report.enabled, true);
    assert.equal(report.model, 'claude-fable-5-1');

    // Default book list is ISA/JER/EZK only.
    assert.equal(resolveInterpReviewSettings({ interpReview: { mode: 'apply' } }, 'ZEC').enabled, false);
    assert.equal(
      resolveInterpReviewSettings({ interpReview: { mode: 'apply', books: 'all' } }, 'ZEC').enabled,
      true
    );

    process.env.BP_INTERP_REVIEW_MODE = 'report';
    process.env.BP_INTERP_REVIEW_BOOKS = 'EZK';
    process.env.BP_INTERP_REVIEW_MODEL = 'claude-opus-5';
    const env = resolveInterpReviewSettings({}, 'EZK');
    assert.equal(env.mode, 'report');
    assert.equal(env.model, 'claude-opus-5');
    assert.equal(env.enabled, true);
    assert.equal(resolveInterpReviewSettings({}, 'ISA').enabled, false, 'env book list wins');
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('extractChapter slices a single chapter out of a USFM book', () => {
  const usfm = '\\id EZK\n\\c 1 \n\\v 1 first\n\\c 2 \n\\v 1 second\n';
  const one = extractChapter(usfm, 1);
  assert.match(one, /first/);
  assert.ok(!one.includes('second'), 'chapter 2 must not leak in');
});

// --- orchestrator: filesystem effects ---------------------------------------

async function withWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-review-'));
  const issuesRel = 'output/issues/EZK/EZK-01.tsv';
  const abs = path.join(dir, issuesRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${SAMPLE}\n`);
  const { mod, restore } = freshModule(dir);
  try {
    // Must await before the finally tears the workspace down.
    return await fn({ dir, issuesRel, abs, mod });
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BASE_ARGS = {
  book: 'EZK',
  chapter: 1,
  tag: 'EZK-01',
  ctx: { sources: {} },
  config: { interpReview: { mode: 'apply', books: ['EZK'] } },
};

test('malformed model output leaves the issues TSV untouched', () => withWorkspace(({ issuesRel, abs, mod }) => {
  const original = fs.readFileSync(abs, 'utf8');
  return mod.runInterpretiveReview({
    ...BASE_ARGS,
    issuesPath: issuesRel,
    callModel: async () => ({ ok: true, text: 'I cannot produce JSON for this.' }),
  }).then((result) => {
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'parse_failed');
    assert.equal(fs.readFileSync(abs, 'utf8'), original, 'file must be byte-identical');
  });
}));

test('a model refusal leaves the issues TSV untouched', () => withWorkspace(({ issuesRel, abs, mod }) => {
  const original = fs.readFileSync(abs, 'utf8');
  return mod.runInterpretiveReview({
    ...BASE_ARGS,
    issuesPath: issuesRel,
    callModel: async () => ({ ok: false, reason: 'refusal' }),
  }).then((result) => {
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'refusal');
    assert.equal(fs.readFileSync(abs, 'utf8'), original);
  });
}));

test('a thrown model error is non-fatal and leaves the file untouched', () => withWorkspace(({ issuesRel, abs, mod }) => {
  const original = fs.readFileSync(abs, 'utf8');
  return mod.runInterpretiveReview({
    ...BASE_ARGS,
    issuesPath: issuesRel,
    callModel: async () => { throw new Error('network down'); },
  }).then((result) => {
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'call_failed');
    assert.equal(fs.readFileSync(abs, 'utf8'), original);
  });
}));

test('report mode writes a review file but never edits the issues TSV', () => withWorkspace(({ dir, issuesRel, abs, mod }) => {
  const original = fs.readFileSync(abs, 'utf8');
  return mod.runInterpretiveReview({
    ...BASE_ARGS,
    config: { interpReview: { mode: 'report', books: ['EZK'] } },
    issuesPath: issuesRel,
    callModel: async () => ({
      ok: true,
      text: '{"verdicts":[{"index":0,"action":"retype","sref":"figs-explicit","reason":"editor wants explicit"}]}',
    }),
  }).then((result) => {
    assert.equal(result.ran, true);
    assert.equal(result.mode, 'report');
    assert.equal(result.counts.retype, 1);
    assert.equal(fs.readFileSync(abs, 'utf8'), original, 'report mode must not edit the TSV');
    const review = fs.readFileSync(path.join(dir, result.reviewPath), 'utf8');
    assert.match(review, /Changes proposed \(not applied\)/);
  });
}));

test('apply mode rewrites the explanation while every quote column survives intact', () => withWorkspace(({ dir, issuesRel, abs, mod }) => {
  const beforeQuotes = fs.readFileSync(abs, 'utf8').trim().split('\n').map((l) => l.split('\t')[3]);
  return mod.runInterpretiveReview({
    ...BASE_ARGS,
    issuesPath: issuesRel,
    callModel: async () => ({
      ok: true,
      response: { usage: { input_tokens: 1200, output_tokens: 300 } },
      model: 'claude-fable-5-1',
      text: '{"verdicts":[{"index":0,"action":"revise","explanation":"Explicit: the vision began","reason":"r"},{"index":1,"action":"agree"}]}',
    }),
  }).then((result) => {
    assert.equal(result.ran, true);
    assert.equal(result.counts.revise, 1);
    assert.equal(result.counts.agree, 1);
    assert.equal(result.usage.input_tokens, 1200);

    const after = fs.readFileSync(abs, 'utf8');
    assert.equal(after.endsWith('\n'), true, 'trailing newline preserved');
    const lines = after.trim().split('\n');
    assert.deepEqual(lines.map((l) => l.split('\t')[3]), beforeQuotes, 'quote column must be identical');
    assert.equal(lines[0].split('\t')[6], 'Explicit: the vision began');
    assert.ok(fs.existsSync(path.join(dir, result.reviewPath)));
  });
}));

test('the stage is inert when mode is off or the book is not selected', () => withWorkspace(({ issuesRel, abs, mod }) => {
  const original = fs.readFileSync(abs, 'utf8');
  const boom = async () => { throw new Error('model must not be called'); };
  return mod.runInterpretiveReview({ ...BASE_ARGS, config: {}, issuesPath: issuesRel, callModel: boom })
    .then((off) => {
      assert.equal(off.ran, false);
      assert.equal(off.reason, 'mode_off');
      return mod.runInterpretiveReview({
        ...BASE_ARGS,
        book: 'ZEC',
        config: { interpReview: { mode: 'apply', books: ['EZK'] } },
        issuesPath: issuesRel,
        callModel: boom,
      });
    })
    .then((skipped) => {
      assert.equal(skipped.reason, 'book_not_selected');
      assert.equal(fs.readFileSync(abs, 'utf8'), original);
    });
}));
