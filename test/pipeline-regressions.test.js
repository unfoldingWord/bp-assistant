const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const { buildSyntheticRoute, buildGenerateConfirmText } = require('../src/router');
const {
  parseGenerateCommand,
  buildParsedGenerateRequest,
  hasRequiredGeneratedOutputs,
  shouldUseFileResponseMode,
} = require('../src/generate-pipeline');
const {
  parseWriteNotesCommand,
  buildParsedNotesRequest,
  shouldRunIntro,
  buildChapterIntroPrompt,
  _runMechanicalQualityPrep,
  _analyzeIssuesTsvShape,
  _isMalformedIssuesShape,
  _buildAtGenerationCheckpoint,
} = require('../src/notes-pipeline');
const { buildParallelismIntroHintArgs } = require('../src/issue-normalizer');

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

test('generate parser recognizes text-only mode', () => {
  const parsed = parseGenerateCommand('generate zech 5 --text-only');
  assert.equal(parsed.book, 'ZEC');
  assert.equal(parsed.start, 5);
  assert.equal(parsed.end, 5);
  assert.equal(parsed.textOnly, true);
});

test('text-only mode uses file-response delivery even for non-file users', () => {
  assert.equal(shouldUseFileResponseMode({ isFileResponse: false, noAlign: false, textOnly: true }), true);
  assert.equal(shouldUseFileResponseMode({ isFileResponse: false, noAlign: false, textOnly: false }), false);
  assert.equal(shouldUseFileResponseMode({ isFileResponse: true, noAlign: false, textOnly: false }), true);
  assert.equal(shouldUseFileResponseMode({ isFileResponse: false, noAlign: true, textOnly: false }), true);
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

test('generate confirmation reflects text-only mode', () => {
  const confirm = buildGenerateConfirmText(
    "I'll generate the initial content (ULT & UST, issues draft) for **ZECH 5**. Sound right? (yes/no)",
    'generate zech 5 --text-only'
  );
  assert.equal(
    confirm,
    "I'll generate the ULT & UST files only for **ZECH 5**. Sound right? (yes/no)"
  );
});

test('write notes defaults to running chapter intro unless explicitly disabled', () => {
  const defaultParsed = parseWriteNotesCommand('write notes for isa 51');
  assert.equal(defaultParsed.withIntro, true);

  const disabledParsed = parseWriteNotesCommand('write notes for isa 51 --no-intro');
  assert.equal(disabledParsed.withIntro, false);
});

test('write notes pause-before-ats flag is parsed and checkpoints resume at AT generation', () => {
  const parsed = parseWriteNotesCommand('write notes for isa 41 --pause-before-ats');
  assert.equal(parsed.pauseBeforeATs, true);

  const checkpoint = _buildAtGenerationCheckpoint({
    totalSuccess: 1,
    totalFail: 0,
    skillOutputs: { 41: { 'tn-writer': 'output/notes/ISA/ISA-041.tsv' } },
    chapter: 41,
  });

  assert.equal(checkpoint.state, 'failed');
  assert.equal(checkpoint.current.status, 'paused_before_at_generation');
  assert.equal(checkpoint.current.skill, 'tn-quality-check');
  assert.equal(checkpoint.resume.skill, 'tn-quality-check');
});

test('chapter intro is auto-skipped for Psalms', () => {
  assert.equal(shouldRunIntro('PSA', 35, true), false);
  assert.equal(shouldRunIntro('PSA', 119, true), false);
  assert.equal(shouldRunIntro('ISA', 51, true), true);
});

test('chapter intro prompt includes high parallelism hint when signal is high', () => {
  const hint = buildParallelismIntroHintArgs({
    parallelism_signal: 'high',
    parallelism_synonymous_count: 7,
  });
  const prompt = buildChapterIntroPrompt('ISA 51', 'output/issues/ISA/ISA-051.tsv', ' --context tmp/pipeline/x/context.json', hint);
  assert.match(prompt, /--parallelism-signal high/);
  assert.match(prompt, /--parallelism-count 7/);
});

test('chapter intro prompt has no hint when signal is absent', () => {
  const hint = buildParallelismIntroHintArgs({
    parallelism_signal: null,
    parallelism_synonymous_count: 2,
  });
  const prompt = buildChapterIntroPrompt('ISA 51', 'output/issues/ISA/ISA-051.tsv', '', hint);
  assert.equal(prompt.includes('--parallelism-signal'), false);
});

test('output discovery falls back to flat notes files when expected path includes a book subdirectory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-utils-'));
  const oldBaseDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = tempDir;

  const modulePath = require.resolve('../src/pipeline-utils');
  delete require.cache[modulePath];
  const { resolveOutputFile, discoverFreshOutput } = require('../src/pipeline-utils');

  try {
    const flatDir = path.join(tempDir, 'output', 'notes');
    fs.mkdirSync(flatDir, { recursive: true });
    const flatFile = path.join(flatDir, 'PSA-039.tsv');
    fs.writeFileSync(flatFile, 'Reference\tID\nPSA 39:1\ta1b2\n');

    const afterMs = Date.now() - 1000;
    const discovered = discoverFreshOutput('output/notes/PSA', 'PSA', /^PSA-0*39(-.*)?\.tsv$/, afterMs);
    const resolved = resolveOutputFile('output/notes/PSA/PSA-039.tsv', 'PSA');

    assert.equal(discovered, 'output/notes/PSA-039.tsv');
    assert.equal(resolved, 'output/notes/PSA-039.tsv');
  } finally {
    if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
    else process.env.CSKILLBP_DIR = oldBaseDir;
    delete require.cache[modulePath];
  }
});

test('checkUltEdits finds flat aligned ULT outputs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ult-edits-'));
  const alignedDir = path.join(tempDir, 'output', 'AI-ULT');
  fs.mkdirSync(alignedDir, { recursive: true });
  fs.writeFileSync(path.join(alignedDir, 'PSA-039-aligned.usfm'), '\\id PSA\n\\c 39\n\\v 1 changed text\n');
  const oldBaseDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = tempDir;

  const pipelineUtilsPath = require.resolve('../src/pipeline-utils');
  const checkUltEditsPath = require.resolve('../src/check-ult-edits');
  delete require.cache[pipelineUtilsPath];
  delete require.cache[checkUltEditsPath];

  const originalGet = https.get;
  https.get = (url, callback) => {
    const { EventEmitter } = require('events');
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    response.setEncoding = () => {};
    response.resume = () => {};
    process.nextTick(() => {
      callback(response);
      response.emit('data', '\\id PSA\n\\c 39\n\\v 1 original text\n');
      response.emit('end');
    });
    return { on() { return this; } };
  };

  try {
    const { checkUltEdits } = require('../src/check-ult-edits');
    const result = await checkUltEdits({
      book: 'PSA',
      chapter: 39,
      workspaceDir: tempDir,
      pipeDir: 'tmp/pipeline/PSA-039',
    });

    assert.equal(result.hasEdits, true);
    assert.equal(result.masterPath, 'tmp/pipeline/PSA-039/ult_master_plain.usfm');
    assert.equal(fs.existsSync(path.join(tempDir, result.masterPath)), true);
  } finally {
    https.get = originalGet;
    if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
    else process.env.CSKILLBP_DIR = oldBaseDir;
    delete require.cache[pipelineUtilsPath];
    delete require.cache[checkUltEditsPath];
  }
});

test('malformed issues TSV shape is detected when issue type and quote are blank across the chapter', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues-shape-'));
  const oldBaseDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = tempDir;

  const notesPipelinePath = require.resolve('../src/notes-pipeline');
  delete require.cache[notesPipelinePath];
  const { _analyzeIssuesTsvShape, _isMalformedIssuesShape } = require('../src/notes-pipeline');

  try {
    const issuesRel = 'output/issues/PSA/PSA-039.tsv';
    const issuesAbs = path.join(tempDir, issuesRel);
    fs.mkdirSync(path.dirname(issuesAbs), { recursive: true });
    fs.writeFileSync(
      issuesAbs,
      [
        "PSA\t39:1\t\t\t\t\tlong direct quotation of David's inner resolve",
        'PSA\t39:1\t\t\t\t\tmetaphor - behavior as path to walk',
        'PSA\t39:2\t\t\t\t\tsynonymous parallelism - both clauses express same idea',
        'PSA\t39:3\t\t\t\t\tquote margin introducing direct speech',
        'PSA\t39:4\t\t\t\t\tabstract noun - could be \"when I will die\"',
      ].join('\n')
    );

    const shape = _analyzeIssuesTsvShape(issuesRel);
    assert.equal(shape.rowCount, 5);
    assert.equal(shape.blankSrefRows, 5);
    assert.equal(shape.blankQuoteRows, 5);
    assert.equal(shape.blankBothRows, 5);
    assert.equal(_isMalformedIssuesShape(shape), true);
  } finally {
    if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
    else process.env.CSKILLBP_DIR = oldBaseDir;
    delete require.cache[notesPipelinePath];
  }
});

test('runMechanicalQualityPrep forwards Hebrew USFM into quality checks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-quality-prep-'));
  const oldBaseDir = process.env.CSKILLBP_DIR;
  process.env.CSKILLBP_DIR = tempDir;

  const notesPipelinePath = require.resolve('../src/notes-pipeline');
  const qualityToolsPath = require.resolve('../src/workspace-tools/quality-tools');
  delete require.cache[notesPipelinePath];
  delete require.cache[qualityToolsPath];
  const { _runMechanicalQualityPrep: runMechanicalQualityPrep } = require('../src/notes-pipeline');

  try {
    const pipeDir = path.join('tmp', 'pipeline', 'PSA-039');
    const pipeAbs = path.join(tempDir, pipeDir);
    fs.mkdirSync(pipeAbs, { recursive: true });

    const notesRel = path.join('output', 'notes', 'PSA', 'PSA-039.tsv');
    const prepRel = path.join(pipeDir, 'prepared_notes.json');
    const findingsRel = path.join(pipeDir, 'tn_quality_findings.json');
    const ultRel = path.join(pipeDir, 'ult.usfm');
    const ustRel = path.join(pipeDir, 'ust.usfm');
    const hebRel = path.join(pipeDir, 'hebrew.usfm');

    fs.mkdirSync(path.join(tempDir, 'output', 'notes', 'PSA'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, notesRel), [
      'Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote',
      '39:1\ta1b2\t\trc://*/ta/man/translate/figs-metaphor\tא ב\t1\tTest note. Alternate translation: [test]',
    ].join('\n'));

    fs.writeFileSync(path.join(tempDir, prepRel), JSON.stringify({
      book: 'PSA',
      items: [
        {
          id: 'a1b2',
          reference: '39:1',
          at_required: true,
          gl_quote: 'test quote',
          issue_span_gl_quote: 'test quote',
          ult_verse: 'test quote',
          ust_verse: 'test quote ust',
        },
      ],
    }, null, 2));

    fs.writeFileSync(path.join(tempDir, ultRel), '\\c 39\n\\v 1 test quote\n');
    fs.writeFileSync(path.join(tempDir, ustRel), '\\c 39\n\\v 1 test quote ust\n');
    fs.writeFileSync(path.join(tempDir, hebRel), '\\c 39\n\\v 1 \\w א|x\\w* \\w ג|x\\w* \\w ב|x\\w*\n');

    fs.writeFileSync(path.join(pipeAbs, 'context.json'), JSON.stringify({
      book: 'PSA',
      sources: {
        ult: ultRel,
        ust: ustRel,
        hebrew: hebRel,
      },
      runtime: {
        preparedNotes: prepRel,
        tnQualityFindings: findingsRel,
      },
    }, null, 2));

    const summary = await runMechanicalQualityPrep({ notesPath: notesRel, pipeDir });
    assert.match(summary, /^Quality check: 1 notes, 1 errors, 3 warnings/);
  } finally {
    if (oldBaseDir == null) delete process.env.CSKILLBP_DIR;
    else process.env.CSKILLBP_DIR = oldBaseDir;
    delete require.cache[notesPipelinePath];
    delete require.cache[qualityToolsPath];
  }
});
