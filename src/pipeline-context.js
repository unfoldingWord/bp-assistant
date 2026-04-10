// pipeline-context.js — Per-chapter working directory and context manifest
//
// Eliminates stale file bugs by making the pipeline runner the single owner
// of all source data. Each chapter gets a working directory with a context.json
// manifest that skills read for their inputs.

const fs = require('fs');
const path = require('path');
const { fetchDoor43, getDoor43FileInfo } = require('./workspace-tools/fetch-tools');
const { readUsfmChapter } = require('./workspace-tools/usfm-tools');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || path.resolve(__dirname, '../../workspace');

/**
 * Strip alignment markers from USFM text, producing plain readable USFM.
 * Removes \zaln-s/e milestones and extracts bare words from \w markers.
 */
function stripAlignmentMarkers(text) {
  let result = text;
  // Remove \zaln-s milestone with attributes
  result = result.replace(/\\zaln-s\s*\|[^*]*\*/g, '');
  // Remove \zaln-e milestones
  result = result.replace(/\\zaln-e\\\*/g, '');
  // Extract words from \w word|attrs\w*
  result = result.replace(/\\w\s+([^|]+)\|[^*]*\\w\*/g, '$1');
  result = result.replace(/\\w\s+([^\\]+)\\w\*/g, '$1');
  // Normalize whitespace
  result = result.replace(/ {2,}/g, ' ');
  result = result.replace(/ +([.,;:!?'")}])/g, '$1');
  result = result.replace(/([{('"]) +/g, '$1');
  result = result.replace(/ +\n/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// --- Book number map (for hebrew bible path) ---

const BOOK_NUMBERS = {
  GEN: '01', EXO: '02', LEV: '03', NUM: '04', DEU: '05',
  JOS: '06', JDG: '07', RUT: '08', '1SA': '09', '2SA': '10',
  '1KI': '11', '2KI': '12', '1CH': '13', '2CH': '14', EZR: '15',
  NEH: '16', EST: '17', JOB: '18', PSA: '19', PRO: '20',
  ECC: '21', SNG: '22', ISA: '23', JER: '24', LAM: '25',
  EZK: '26', DAN: '27', HOS: '28', JOL: '29', AMO: '30',
  OBA: '31', JON: '32', MIC: '33', NAM: '34', HAB: '35',
  ZEP: '36', HAG: '37', ZEC: '38', MAL: '39',
  MAT: '41', MRK: '42', LUK: '43', JHN: '44', ACT: '45',
  ROM: '46', '1CO': '47', '2CO': '48', GAL: '49', EPH: '50',
  PHP: '51', COL: '52', '1TH': '53', '2TH': '54', '1TI': '55',
  '2TI': '56', TIT: '57', PHM: '58', HEB: '59', JAS: '60',
  '1PE': '61', '2PE': '62', '1JN': '63', '2JN': '64', '3JN': '65',
  JUD: '66', REV: '67',
};

/**
 * Build the pipeline directory name for a chapter.
 * PSA uses 3-digit padding, all others use 2-digit.
 */
function buildPipeDirName(book, chapter, verseStart, verseEnd) {
  const width = book.toUpperCase() === 'PSA' ? 3 : 2;
  const ch = String(chapter).padStart(width, '0');
  const base = `${book.toUpperCase()}-${ch}`;
  if (verseStart != null && verseEnd != null) {
    return `${base}-v${verseStart}-${verseEnd}`;
  }
  return base;
}

/**
 * Archive a pipeline directory by renaming it with a timestamp suffix.
 * e.g. tmp/pipeline/HAB-01 → tmp/pipeline/HAB-01-20260410-153045
 */
function archivePipelineDir(absPath, dirName) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:T]/g, '');
  const formattedTs = `${ts.slice(0, 8)}-${ts.slice(8, 14)}`;
  const archivePath = path.join(path.dirname(absPath), `${dirName}-${formattedTs}`);
  try {
    fs.renameSync(absPath, archivePath);
  } catch (_) {
    // If rename fails (e.g. cross-device), fall back to deletion
    fs.rmSync(absPath, { recursive: true, force: true });
  }
}

/**
 * Create a per-chapter pipeline working directory.
 * Returns the path relative to CSKILLBP_DIR.
 * When reset=true and the directory already exists, it is archived with a
 * timestamp suffix so previous run data is preserved for debugging.
 */
function createPipelineDir({ book, chapter, verseStart, verseEnd, reset = true }) {
  const dirName = buildPipeDirName(book, chapter, verseStart, verseEnd);
  const relPath = `tmp/pipeline/${dirName}`;
  const absPath = path.resolve(CSKILLBP_DIR, relPath);
  // Archive any stale directory from a previous run instead of deleting it.
  if (reset && fs.existsSync(absPath)) {
    archivePipelineDir(absPath, dirName);
  }
  fs.mkdirSync(absPath, { recursive: true });
  return relPath;
}

function buildRuntimePaths(dirPath) {
  return {
    preparedNotes: `${dirPath}/prepared_notes.json`,
    generatedNotes: `${dirPath}/generated_notes.json`,
    alignmentData: `${dirPath}/alignment_data.json`,
    tnQualityFindings: `${dirPath}/tn_quality_findings.json`,
  };
}

/**
 * Pre-create empty stub files for all runtime paths.
 * The Claude SDK requires Read before Write — creating stubs up front
 * saves ~15 tool calls per skill invocation.
 */
function preCreateStubs(dirPath) {
  const runtime = buildRuntimePaths(dirPath);
  for (const relPath of Object.values(runtime)) {
    const absPath = path.resolve(CSKILLBP_DIR, relPath);
    if (!fs.existsSync(absPath)) {
      // Use '{}' for JSON stubs so Read/JSON.parse don't choke on empty files
      const isJson = relPath.endsWith('.json');
      fs.writeFileSync(absPath, isJson ? '{}' : '');
    }
  }
}

/**
 * Write context.json to the pipeline directory.
 */
function writeContext(dirPath, contextObj) {
  const absPath = path.resolve(CSKILLBP_DIR, dirPath, 'context.json');
  fs.writeFileSync(absPath, JSON.stringify(contextObj, null, 2));
}

/**
 * Read and parse context.json from a pipeline directory.
 */
function readContext(dirPath) {
  const absPath = path.resolve(CSKILLBP_DIR, dirPath, 'context.json');
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/**
 * Update the artifacts section in context.json after a skill completes.
 */
function updateContextArtifacts(dirPath, skillName, resolvedPath) {
  const ctx = readContext(dirPath);
  if (!ctx.artifacts) ctx.artifacts = {};
  ctx.artifacts[skillName] = resolvedPath;
  writeContext(dirPath, ctx);
}

/**
 * Fetch a USFM file from Door43 into the pipeline directory.
 * Returns the relative path to the fetched file.
 */
async function fetchSourceToDir(dirPath, { book, repo, targetFilename }) {
  const relOutput = `${dirPath}/${targetFilename}`;
  await fetchDoor43({ book, repo, output: relOutput });
  return relOutput;
}

/**
 * Extract a single chapter from a book-level USFM file and write to the pipeline dir.
 * Returns the relative path to the extracted file.
 */
function extractChapterToDir(dirPath, { sourceFile, chapter, targetFilename }) {
  const chapterContent = readUsfmChapter({ file: sourceFile, chapter });
  if (typeof chapterContent === 'string' && chapterContent.startsWith('Error:')) {
    throw new Error(chapterContent);
  }
  const relPath = `${dirPath}/${targetFilename}`;
  const absPath = path.resolve(CSKILLBP_DIR, relPath);
  fs.writeFileSync(absPath, chapterContent);
  return relPath;
}

/**
 * Archive a pipeline working directory by renaming it with a timestamp suffix.
 * Guarded to only touch directories under tmp/pipeline/.
 * Pipeline files are preserved for 30 days to aid debugging.
 */
function cleanupPipelineDir(dirPath) {
  if (!dirPath || !dirPath.startsWith('tmp/pipeline/')) {
    console.warn(`[pipeline-context] Refusing to clean non-pipeline dir: ${dirPath}`);
    return;
  }
  const absPath = path.resolve(CSKILLBP_DIR, dirPath);
  if (fs.existsSync(absPath)) {
    const dirName = path.basename(absPath);
    archivePipelineDir(absPath, dirName);
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Clean up stale pipeline directories older than maxAgeMs (default: 30 days).
 * Call on bot startup and weekly to prevent disk buildup.
 * Scans all dirs in tmp/pipeline/ — both active run dirs and timestamped archives.
 */
function cleanupStalePipelineDirs(maxAgeMs = THIRTY_DAYS_MS) {
  const pipelineRoot = path.resolve(CSKILLBP_DIR, 'tmp/pipeline');
  if (!fs.existsSync(pipelineRoot)) return;
  const now = Date.now();
  let cleaned = 0;
  for (const entry of fs.readdirSync(pipelineRoot)) {
    const entryPath = path.join(pipelineRoot, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory() && (now - stat.mtimeMs) > maxAgeMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch (_) { /* skip if stat fails */ }
  }
  if (cleaned > 0) {
    console.log(`[pipeline-context] Cleaned ${cleaned} stale pipeline dir(s) (>${Math.round(maxAgeMs / 86400000)}d old)`);
  }
}

/**
 * Build a full pipeline context for the notes pipeline.
 * Fetches current ULT/UST from Door43 master, extracts the chapter,
 * and writes context.json with all source paths.
 *
 * @param {object} opts
 * @param {string} opts.book - 3-letter book code
 * @param {number} opts.chapter - chapter number
 * @param {number} [opts.verseStart] - start verse for range
 * @param {number} [opts.verseEnd] - end verse for range
 * @param {string} [opts.issuesPath] - resolved issues TSV path
 * @param {string} [opts.alignedUltPath] - path to aligned ULT if it exists
 * @returns {Promise<{dirPath: string, contextPath: string}>}
 */
async function buildNotesContext({ book, chapter, verseStart, verseEnd, issuesPath, alignedUltPath, reuseExisting = false }) {
  const dirPath = createPipelineDir({ book, chapter, verseStart, verseEnd, reset: !reuseExisting });
  const now = new Date().toISOString();

  // Fetch current ULT and UST from Door43 master
  const [ultPath, ustPath] = await Promise.all([
    fetchSourceToDir(dirPath, { book, repo: 'en_ult', targetFilename: 'ult.usfm' }),
    fetchSourceToDir(dirPath, { book, repo: 'en_ust', targetFilename: 'ust.usfm' }),
  ]);

  // Extract the chapter as plain text for skills that need it
  const ultChapterPath = extractChapterToDir(dirPath, {
    sourceFile: ultPath,
    chapter,
    targetFilename: 'ult_chapter.usfm',
  });
  const ustChapterPath = extractChapterToDir(dirPath, {
    sourceFile: ustPath,
    chapter,
    targetFilename: 'ust_chapter.usfm',
  });

  // Write plain (alignment-stripped) versions for model readability
  const ultChapterPlainPath = `${dirPath}/ult_chapter_plain.usfm`;
  const ustChapterPlainPath = `${dirPath}/ust_chapter_plain.usfm`;
  const ultChapterAbs = path.resolve(CSKILLBP_DIR, ultChapterPath);
  const ustChapterAbs = path.resolve(CSKILLBP_DIR, ustChapterPath);
  fs.writeFileSync(
    path.resolve(CSKILLBP_DIR, ultChapterPlainPath),
    stripAlignmentMarkers(fs.readFileSync(ultChapterAbs, 'utf8'))
  );
  fs.writeFileSync(
    path.resolve(CSKILLBP_DIR, ustChapterPlainPath),
    stripAlignmentMarkers(fs.readFileSync(ustChapterAbs, 'utf8'))
  );

  // Build hebrew path
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  const hebrewPath = num ? `data/hebrew_bible/${num}-${bookUpper}.usfm` : null;

  const context = {
    version: 1,
    pipeline: 'notes',
    book: bookUpper,
    chapter,
    verseStart: verseStart || null,
    verseEnd: verseEnd || null,
    startedAt: now,
    sources: {
      ult: ultChapterPath,
      ust: ustChapterPath,
      ultPlain: ultChapterPlainPath,
      ustPlain: ustChapterPlainPath,
      ultFull: ultPath,
      ustFull: ustPath,
      hebrew: hebrewPath,
      ultAligned: ultChapterPath,
      issues: issuesPath || null,
    },
    sourceOrigin: {
      ult: { from: 'door43', repo: 'en_ult', branch: 'master', fetchedAt: now },
      ust: { from: 'door43', repo: 'en_ust', branch: 'master', fetchedAt: now },
    },
    runtime: buildRuntimePaths(dirPath),
    artifacts: {},
  };

  writeContext(dirPath, context);
  preCreateStubs(dirPath);
  return { dirPath, contextPath: `${dirPath}/context.json` };
}

/**
 * Build a pipeline context for the generate pipeline (alignment step).
 * Points ULT/UST to the just-generated files in output/.
 *
 * @param {object} opts
 * @param {string} opts.book - 3-letter book code
 * @param {number} opts.chapter - chapter number
 * @param {string} opts.ultPath - path to generated ULT (relative to workspace)
 * @param {string} [opts.ustPath] - path to generated UST
 * @param {number} [opts.verseStart]
 * @param {number} [opts.verseEnd]
 * @returns {{dirPath: string, contextPath: string}}
 */
function buildGenerateContext({ book, chapter, ultPath, ustPath, verseStart, verseEnd, dirPath: existingDirPath = null }) {
  const dirPath = existingDirPath || createPipelineDir({ book, chapter, verseStart, verseEnd, reset: true });
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  const hebrewPath = num ? `data/hebrew_bible/${num}-${bookUpper}.usfm` : null;

  const context = {
    version: 1,
    pipeline: 'generate',
    book: bookUpper,
    chapter,
    verseStart: verseStart || null,
    verseEnd: verseEnd || null,
    startedAt: new Date().toISOString(),
    sources: {
      ult: ultPath,
      ust: ustPath || null,
      hebrew: hebrewPath,
    },
    sourceOrigin: {
      ult: { from: 'pipeline', skill: 'initial-pipeline' },
      ust: ustPath ? { from: 'pipeline', skill: 'initial-pipeline' } : null,
    },
    runtime: buildRuntimePaths(dirPath),
    artifacts: {},
  };

  writeContext(dirPath, context);
  return { dirPath, contextPath: `${dirPath}/context.json` };
}

async function buildUstContext({ book, chapter, verseStart, verseEnd, localUltPath }) {
  const dirPath = createPipelineDir({ book, chapter, verseStart, verseEnd, reset: true });
  const now = new Date().toISOString();
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  const hebrewPath = num ? `data/hebrew_bible/${num}-${bookUpper}.usfm` : null;

  const [door43UltInfo, masterUltFull] = await Promise.all([
    getDoor43FileInfo({ book, repo: 'en_ult', branch: 'master' }),
    fetchSourceToDir(dirPath, { book, repo: 'en_ult', targetFilename: 'ult_master.usfm' }),
  ]);
  const masterUltPath = extractChapterToDir(dirPath, {
    sourceFile: masterUltFull,
    chapter,
    targetFilename: 'ult_master_chapter.usfm',
  });

  let selectedUltPath = masterUltPath;
  let selectedOrigin = {
    from: 'door43',
    repo: 'en_ult',
    branch: 'master',
    fetchedAt: now,
    lastModified: door43UltInfo.lastModified,
  };

  if (localUltPath) {
    const localAbsPath = path.resolve(CSKILLBP_DIR, localUltPath);
    if (fs.existsSync(localAbsPath)) {
      const localStat = fs.statSync(localAbsPath);
      const localModifiedAt = new Date(localStat.mtimeMs).toISOString();
      const remoteModifiedMs = door43UltInfo.lastModifiedMs;
      if (!remoteModifiedMs || localStat.mtimeMs >= remoteModifiedMs) {
        selectedUltPath = localUltPath;
        selectedOrigin = {
          from: 'pipeline',
          skill: 'ULT-gen',
          selectedBecause: remoteModifiedMs ? 'local_generated_newer_or_equal' : 'remote_timestamp_unavailable',
          modifiedAt: localModifiedAt,
          comparedToDoor43LastModified: door43UltInfo.lastModified,
        };
      }
    }
  }

  const context = {
    version: 1,
    pipeline: 'generate',
    mode: 'ust-only',
    book: bookUpper,
    chapter,
    verseStart: verseStart || null,
    verseEnd: verseEnd || null,
    startedAt: now,
    sources: {
      ult: selectedUltPath,
      ultFull: selectedUltPath === localUltPath ? null : masterUltFull,
      ust: null,
      hebrew: hebrewPath,
      issues: null,
    },
    sourceOrigin: {
      ult: selectedOrigin,
      door43UltMaster: {
        from: 'door43',
        repo: 'en_ult',
        branch: 'master',
        fetchedAt: now,
        lastModified: door43UltInfo.lastModified,
        chapterPath: masterUltPath,
      },
    },
    runtime: buildRuntimePaths(dirPath),
    artifacts: {},
  };

  writeContext(dirPath, context);
  return {
    dirPath,
    contextPath: `${dirPath}/context.json`,
    selectedUltPath,
  };
}

module.exports = {
  createPipelineDir,
  writeContext,
  readContext,
  updateContextArtifacts,
  fetchSourceToDir,
  extractChapterToDir,
  cleanupPipelineDir,
  cleanupStalePipelineDirs,
  buildNotesContext,
  buildGenerateContext,
  buildUstContext,
  stripAlignmentMarkers,
};
