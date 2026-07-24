// usfm-tools.js — Node.js ports of USFM processing scripts
//
// Replaces: extract_ult_english.py, filter_psalms.py, curly_quotes.py, check_ust_passives.py

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

/**
 * Extract clean English text from aligned ULT USFM files.
 */
function extractUltEnglish({ books, force, inputDir, outputDir }) {
  const inDir = path.join(CSKILLBP_DIR, inputDir || 'data/published_ult');
  const outDir = path.join(CSKILLBP_DIR, outputDir || 'data/published_ult_english');
  fs.mkdirSync(outDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(inDir).filter(f => f.endsWith('.usfm'));
  let processed = 0;
  let cached = 0;

  for (const file of files) {
    if (books && books.length) {
      const bookCode = file.replace(/^\d+-/, '').replace('.usfm', '');
      if (!books.map(b => b.toUpperCase()).includes(bookCode)) continue;
    }

    const outPath = path.join(outDir, file);
    if (!force && fs.existsSync(outPath)) {
      const first = fs.readFileSync(outPath, 'utf8').split('\n')[0];
      if (first.includes(`Extracted: ${today}`)) { cached++; continue; }
    }

    const content = fs.readFileSync(path.join(inDir, file), 'utf8');
    let text = content;

    // Strip alignment markers
    text = text.replace(/\\zaln-s\s*\|[^*]*\*/g, '');
    text = text.replace(/\\zaln-e\\\*/g, '');
    // Extract words from \w word|attrs\w*
    text = text.replace(/\\w\s+([^|]+)\|[^*]*\\w\*/g, '$1');
    text = text.replace(/\\w\s+([^\\]+)\\w\*/g, '$1');

    // Normalize whitespace
    text = text.replace(/ {2,}/g, ' ');
    text = text.replace(/ +([.,;:!?'")}])/g, '$1');
    text = text.replace(/([{('"]) +/g, '$1');
    text = text.replace(/ +\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');

    fs.writeFileSync(outPath, `# Extracted: ${today}\n${text}`);
    processed++;
  }

  return `Processed ${processed}, cached ${cached}, total ${files.length} files`;
}

/**
 * Filter Psalms to keep only specific chapter ranges.
 */
function filterPsalms() {
  const keepRanges = [[1, 29], [42, 57], [90, 118]];
  const files = [
    'data/published_ult/19-PSA.usfm',
    'data/published_ult_english/19-PSA.usfm',
    'data/published_ust/19-PSA.usfm',
  ];
  const results = [];

  for (const relPath of files) {
    const filePath = path.join(CSKILLBP_DIR, relPath);
    if (!fs.existsSync(filePath)) { results.push(`${relPath}: not found`); continue; }

    const content = fs.readFileSync(filePath, 'utf8');
    const origSize = Buffer.byteLength(content);

    // Split by \c markers preserving them
    const parts = content.split(/(\\c\s+\d+)/);
    let result = parts[0]; // header before first \c

    for (let i = 1; i < parts.length; i += 2) {
      const marker = parts[i];
      const body = parts[i + 1] || '';
      const m = marker.match(/\\c\s+(\d+)/);
      if (!m) { result += marker + body; continue; }
      const ch = parseInt(m[1], 10);
      const keep = keepRanges.some(([s, e]) => ch >= s && ch <= e);
      if (keep) result += marker + body;
    }

    const newSize = Buffer.byteLength(result);
    fs.writeFileSync(filePath, result);
    const pct = ((1 - newSize / origSize) * 100).toFixed(1);
    results.push(`${relPath}: ${origSize} -> ${newSize} bytes (${pct}% removed)`);
  }

  return results.join('\n');
}

/**
 * Convert straight quotes to curly quotes in text/USFM.
 */
function curlyQuotes({ input, output, inPlace }) {
  const inputPath = path.resolve(CSKILLBP_DIR, input);
  if (inputPath.endsWith('.json')) {
    throw new Error(`curly_quotes must not be called on JSON files — it will corrupt property name delimiters. Received: ${inputPath}`);
  }
  let text = fs.readFileSync(inputPath, 'utf8');

  // Process line by line to handle context
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const prev = i > 0 ? line[i - 1] : '\n';
      const next = i < line.length - 1 ? line[i + 1] : '\n';

      // Skip quotes inside USFM attribute values (="...")
      if (ch === '=' && next === '"') {
        out += ch;
        i++;
        out += line[i]; i++;
        while (i < line.length && line[i] !== '"') { out += line[i]; i++; }
        if (i < line.length) { out += line[i]; i++; }
        continue;
      }

      if (ch === '"') {
        const isOpening = i === 0 || /[\s(\[{—]/.test(prev) || /^\\[a-z]/.test(line.slice(Math.max(0, i - 3), i));
        out += isOpening ? '\u201C' : '\u201D';
      } else if (ch === "'") {
        // Apostrophe: between letters or possessive
        const prevIsLetter = /[a-zA-Z]/.test(prev);
        const nextIsLetter = /[a-zA-Z]/.test(next);
        if (prevIsLetter && nextIsLetter) {
          out += '\u2019'; // apostrophe
        } else if (prevIsLetter && next === 's') {
          out += '\u2019'; // possessive
        } else {
          const isOpening = i === 0 || /[\s(\[{—]/.test(prev);
          out += isOpening ? '\u2018' : '\u2019';
        }
      } else {
        out += ch;
      }
      i++;
    }
    result.push(out);
  }

  const converted = result.join('\n');

  if (inPlace) {
    fs.writeFileSync(inputPath, converted);
    return `Converted quotes in-place: ${path.basename(inputPath)}`;
  }
  if (output) {
    const outPath = path.resolve(CSKILLBP_DIR, output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, converted);
    return `Saved to ${outPath}`;
  }
  return converted;
}

/**
 * Detect passive voice constructions in UST USFM.
 */
function checkUstPassives({ file }) {
  const filePath = path.resolve(CSKILLBP_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');

  const PASSIVE_AUX = new Set(['be', 'is', 'are', 'am', 'was', 'were', 'been', 'being']);
  const PARTICIPLE_ENDINGS = ['ed', 'en', 'wn', 'ung', 'orn', 'oken', 'osen', 'otten', 'iven', 'aken', 'tten'];
  const STATIVE_ADJ = new Set([
    'ashamed', 'afraid', 'alone', 'alive', 'awake', 'aware', 'asleep', 'born',
    'blessed', 'clean', 'content', 'dead', 'drunk', 'due', 'empty', 'engaged',
    'evil', 'finished', 'free', 'full', 'glad', 'gone', 'good', 'guilty',
    'holy', 'hungry', 'hurt', 'ill', 'innocent', 'jealous', 'just', 'known',
    'lost', 'married', 'naked', 'open', 'pleased', 'pregnant', 'present',
    'proud', 'pure', 'ready', 'related', 'right', 'sacred', 'safe', 'satisfied',
    'sick', 'sorry', 'still', 'strong', 'sure', 'surprised', 'thirsty',
    'tired', 'troubled', 'true', 'unclean', 'wicked', 'willing', 'wise',
    'worried', 'worthy', 'wrong', 'young',
  ]);
  const NOT_PARTICIPLES = new Set([
    'not', 'that', 'light', 'right', 'night', 'men', 'women', 'heaven',
    'garden', 'listen', 'often', 'children', 'written', 'golden', 'molten',
    'hidden', 'forbidden', 'linen', 'maiden', 'burden', 'widen', 'sudden',
    'amen', 'token', 'open', 'even', 'seven', 'eleven', 'dozen', 'citizen',
    'then', 'when', 'again', 'certain', 'mountain', 'fountain', 'captain',
    'curtain', 'foreign', 'barren',
  ]);
  const IRREGULARS = new Set([
    'been', 'done', 'gone', 'made', 'said', 'taken', 'given', 'known',
    'shown', 'told', 'found', 'brought', 'thought', 'bought', 'caught',
    'taught', 'sought', 'sent', 'spent', 'built', 'left', 'felt', 'kept',
    'meant', 'met', 'paid', 'put', 'read', 'run', 'set', 'shot', 'shut',
    'spread', 'understood', 'written', 'driven', 'risen', 'fallen', 'chosen',
    'spoken', 'broken', 'frozen', 'stolen', 'woven', 'sworn', 'torn', 'worn',
    'born', 'borne', 'drawn', 'grown', 'known', 'thrown', 'blown', 'flown',
    'shaken', 'mistaken', 'forsaken', 'forgotten', 'gotten', 'hidden',
    'bitten', 'ridden', 'smitten', 'stricken', 'forbidden', 'forgiven',
    'eaten', 'beaten', 'seen', 'begun', 'sung', 'rung', 'hung', 'clung',
    'sprung', 'stung', 'swung', 'wrung', 'sunk', 'drunk', 'shrunk',
    'baptized', 'circumcised',
  ]);

  function isPastParticiple(word) {
    const w = word.toLowerCase();
    if (STATIVE_ADJ.has(w) || NOT_PARTICIPLES.has(w)) return false;
    if (IRREGULARS.has(w)) return true;
    return PARTICIPLE_ENDINGS.some(e => w.endsWith(e) && w.length > e.length + 2);
  }

  // Parse verses
  let currentRef = '';
  const findings = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { currentRef = cm[1] + ':'; continue; }
    const vm = trimmed.match(/^\\v\s+(\d+[-\d]*)\s*(.*)/);
    if (vm) { currentRef = currentRef.split(':')[0] + ':' + vm[1]; }

    // Clean USFM markers
    let text = trimmed.replace(/\\[a-z]+\d?\s*/g, ' ').replace(/\\[a-z]+\d?\*/g, '').replace(/\s+/g, ' ').trim();
    const words = text.split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      if (PASSIVE_AUX.has(words[i].toLowerCase())) {
        for (let j = i + 1; j <= Math.min(i + 3, words.length - 1); j++) {
          if (isPastParticiple(words[j])) {
            findings.push(`${currentRef}: "${words.slice(i, j + 1).join(' ')}"`);
            break;
          }
        }
      }
    }
  }

  if (!findings.length) return 'No passive constructions found';
  return `Found ${findings.length} passive construction(s):\n${findings.join('\n')}`;
}

/**
 * Deterministically plan the batch verse-ranges for align-all-parallel.
 *
 * Batch boundaries used to be computed by the LLM coordinator in the
 * align-all-parallel SKILL.md prompt. On long chapters that arithmetic went
 * wrong: EZK 16 (63 verses, 2026-07-21, issue #233) was split into
 * 1-16 / 16-30 / 31-45 / 46-60 — 15-verse, overlapping at v16, and dropping
 * the tail (61-63 were never batched, so no subagent produced mapping JSON for
 * them and the deterministic salvage had nothing to recover). This ports the
 * boundary computation into Node so every chapter is covered exactly once,
 * contiguously, with the final batch always reaching the last verse.
 *
 * Mirrors the documented algorithm (SKILL.md Step 2b): numBatches = ceil(N/max),
 * then distribute evenly with size = ceil(N / numBatches); the last batch gets
 * the remainder. Returns `[{ index, start, end }]` (1-based, inclusive).
 */
function planAlignmentBatches(verseCount, { maxBatchSize = 18 } = {}) {
  const n = parseInt(verseCount, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`planAlignmentBatches: verseCount must be a positive integer, got ${verseCount}`);
  }
  const max = parseInt(maxBatchSize, 10) > 0 ? parseInt(maxBatchSize, 10) : 18;
  const numBatches = Math.max(1, Math.ceil(n / max));
  const size = Math.ceil(n / numBatches);
  const batches = [];
  let start = 1;
  for (let i = 0; i < numBatches && start <= n; i += 1) {
    const end = Math.min(start + size - 1, n);
    batches.push({ index: batches.length + 1, start, end });
    start = end + 1;
  }
  // Defensive: the loop clamps each end to n, so the final batch already reaches
  // the last verse — force it regardless so no rounding path can drop the tail.
  if (batches.length) batches[batches.length - 1].end = n;
  return batches;
}

/**
 * Validate that a set of batch ranges covers verses 1..verseCount exactly once —
 * no gaps, no overlaps, and (the failure mode from #233) the last verse batched.
 * Returns `{ ok, missing, reachesLast, problems }`. This is the deterministic
 * guard: even if a coordinator computes its own boundaries, the pipeline/skill
 * can assert the plan reaches the chapter tail before spawning subagents.
 */
function assertBatchPlanCoversChapter(batches, verseCount) {
  const n = parseInt(verseCount, 10);
  const problems = [];
  const covered = new Set();
  const sorted = [...(batches || [])]
    .map((b) => ({ start: parseInt(b.start, 10), end: parseInt(b.end, 10) }))
    .sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const b of sorted) {
    if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start > b.end) {
      problems.push(`invalid range ${b.start}-${b.end}`);
      continue;
    }
    if (b.start <= prevEnd) problems.push(`overlap at verse ${b.start}`);
    else if (b.start > prevEnd + 1) problems.push(`gap before verse ${b.start}`);
    for (let v = b.start; v <= b.end; v += 1) covered.add(v);
    prevEnd = Math.max(prevEnd, b.end);
  }
  const missing = [];
  if (Number.isInteger(n) && n >= 1) {
    for (let v = 1; v <= n; v += 1) if (!covered.has(v)) missing.push(v);
  }
  const reachesLast = Number.isInteger(n) && covered.has(n);
  if (!reachesLast && Number.isInteger(n)) problems.push(`last verse ${n} not batched`);
  return { ok: problems.length === 0 && missing.length === 0, missing, reachesLast, problems };
}

/**
 * Tool wrapper for `plan_alignment_batches` — the align-all-parallel coordinator
 * calls this (via the CLI wrapper / MCP) instead of computing batch boundaries
 * itself. Accepts either an explicit `verseCount`, or a `file` + `chapter` to
 * count `\v` markers from the chapter (matching SKILL.md Step 1). Returns the
 * plan plus a `coversChapter` assertion so a mis-plan surfaces immediately.
 */
function planAlignmentBatchesTool({ verseCount, book, chapter, file, maxBatchSize } = {}) {
  let n = verseCount != null ? parseInt(verseCount, 10) : NaN;
  if ((!Number.isInteger(n) || n < 1) && file && chapter != null) {
    const content = readUsfmChapter({ file, chapter });
    if (typeof content === 'string' && content.startsWith('Error')) return content;
    n = (String(content).match(/\\v\s+\d+/g) || []).length;
  }
  if (!Number.isInteger(n) || n < 1) {
    return `Error: could not determine verse count — pass verseCount, or file+chapter (got verseCount=${verseCount}, file=${file}, chapter=${chapter})`;
  }
  const batches = planAlignmentBatches(n, { maxBatchSize });
  const check = assertBatchPlanCoversChapter(batches, n);
  return {
    book: book ? String(book).toUpperCase() : undefined,
    chapter: chapter != null ? parseInt(chapter, 10) : undefined,
    verseCount: n,
    numBatches: batches.length,
    singleBatch: batches.length <= 1,
    batches: batches.map((b) => ({ index: b.index, start: b.start, end: b.end, verses: `${b.start}-${b.end}` })),
    coversChapter: check.ok,
    problems: check.problems,
  };
}

/**
 * Convert alignment mapping JSON to aligned USFM3.
 * Wraps the existing create_aligned_usfm.js script via execFileSync (no shell needed).
 */
function createAlignedUsfm({ hebrew, mapping, source, output, chapter, verse, ust }) {
  const scriptPath = path.join(CSKILLBP_DIR, '.claude/skills/utilities/scripts/usfm/create_aligned_usfm.js');

  if (!fs.existsSync(scriptPath)) {
    return `Error: script not found at ${scriptPath}`;
  }

  const args = [scriptPath];
  args.push('--hebrew', path.resolve(CSKILLBP_DIR, hebrew));
  args.push('--mapping', path.resolve(CSKILLBP_DIR, mapping));
  args.push('--source', path.resolve(CSKILLBP_DIR, source));
  if (output) args.push('--output', path.resolve(CSKILLBP_DIR, output));
  if (chapter != null) args.push('--chapter', String(chapter));
  if (verse != null) args.push('--verse', String(verse));
  if (ust) args.push('--ust');

  try {
    const result = execFileSync(process.execPath, args, {
      cwd: CSKILLBP_DIR,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    if (!output) {
      return result;
    }

    console.log(`Aligned USFM written to ${output}`);

    let repairResult;
    try {
      repairResult = repairAlignmentXContent({
        alignedUsfm: output,
        hebrewUsfm: hebrew,
      });
    } catch (repairErr) {
      return `Aligned USFM written to ${output}.\nRepair step failed: ${repairErr.message}`;
    }

    // Normalize AFTER the repair — repairAlignmentXContent rewrites the file, so
    // normalizing first would be undone. This is the single-batch path's
    // equivalent of the normalization mergeAlignedUsfm applies on the multi-batch
    // path (#247); without it, chapters of <= 18 verses ship mid-line `\v`.
    const normalized = normalizeVerseLineStartsInFile(path.resolve(CSKILLBP_DIR, output));

    return `Aligned USFM written to ${output}.\nX-content and lemma byte repair completed:\n${repairResult}`
      + (normalized ? '\nVerse-line-start normalization applied (mid-line \\v markers moved to line start).' : '');

  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const msg = stderr || err.message;
    return `Error running create_aligned_usfm: ${msg}`;
  }
}

/**
 * Strip alignment markers from USFM text, producing plain readable USFM.
 * Removes \zaln-s/e milestones and extracts bare words from \w markers.
 */
function stripAlignmentMarkersUsfm(text) {
  let result = text;
  result = result.replace(/\\zaln-s\s*\|[^*]*\*/g, '');
  result = result.replace(/\\zaln-e\\\*/g, '');
  result = result.replace(/\\w\s+([^|]+)\|[^*]*\\w\*/g, '$1');
  result = result.replace(/\\w\s+([^\\]+)\\w\*/g, '$1');
  result = result.replace(/ {2,}/g, ' ');
  result = result.replace(/ +([.,;:!?'")}])/g, '$1');
  result = result.replace(/([{('"]) +/g, '$1');
  result = result.replace(/ +\n/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

/**
 * Extract a single chapter from a book-level USFM file.
 * Returns the file header (before first \c) plus the matching \c N block.
 *
 * @param {object} opts
 * @param {string} opts.file - USFM file path relative to workspace
 * @param {number} opts.chapter - Chapter number to extract
 * @param {number} [opts.verseStart] - Optional start verse for range filtering
 * @param {number} [opts.verseEnd] - Optional end verse for range filtering
 * @param {boolean} [opts.plain] - Strip alignment markers before returning
 */
function readUsfmChapter({ file, chapter, verseStart, verseEnd, plain }) {
  const filePath = path.resolve(CSKILLBP_DIR, file);
  if (!fs.existsSync(filePath)) return `Error: file not found: ${file}`;

  const content = fs.readFileSync(filePath, 'utf8');
  const ch = parseInt(chapter, 10);
  if (isNaN(ch)) return `Error: invalid chapter number: ${chapter}`;

  // Split by \c markers, preserving them (same pattern as filterPsalms)
  const parts = content.split(/(\\c\s+\d+)/);
  const header = parts[0]; // everything before first \c

  let chapterContent = null;
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    const body = parts[i + 1] || '';
    const m = marker.match(/\\c\s+(\d+)/);
    if (m && parseInt(m[1], 10) === ch) {
      chapterContent = header + marker + body;
      break;
    }
  }

  if (!chapterContent) return `Error: chapter ${ch} not found in ${file}`;

  // Verse-range filtering: keep header + \c line + only verses in range
  if (verseStart != null && verseEnd != null) {
    const vs = parseInt(verseStart, 10);
    const ve = parseInt(verseEnd, 10);
    if (!isNaN(vs) && !isNaN(ve)) {
      const lines = chapterContent.split('\n');
      const filtered = [];
      let inRange = true; // true until we see a \v marker outside range
      let pastFirstVerse = false;
      for (const line of lines) {
        const vm = line.match(/^\\v\s+(\d+)\b/);
        if (vm) {
          const v = parseInt(vm[1], 10);
          pastFirstVerse = true;
          inRange = v >= vs && v <= ve;
        }
        if (!pastFirstVerse || inRange) {
          filtered.push(line);
        }
      }
      chapterContent = filtered.join('\n');
    }
  }

  if (plain) {
    chapterContent = stripAlignmentMarkersUsfm(chapterContent);
  }

  return chapterContent;
}

/**
 * Merge N partial aligned USFM files (from verse-range batches) into one full-chapter file.
 * Takes the header + verses from part[0], then appends only the verse content from parts[1..N]
 * (stripping each subsequent file's header up to and including the \c line).
 */
// Ensure every `\v N` marker begins a line. Batch sub-agents occasionally emit
// a verse marker mid-line — appended to the previous verse's alignment text
// (e.g. `...\zaln-e\*, \v 2 "\zaln-s ...`) instead of at line start. The align
// coverage gate (validateAlignedUsfmCompleteness) matches `\v` anywhere and so
// reports full coverage, but the push guard (collectCoveredVerses in
// insert-usfm-verses.js) only detects line-start `\v` and would falsely reject
// the chapter as partial (EZK 16, #245: missing 2-5, 7-14, 16).
//
// The transform inserts newlines ONLY — it never adds or removes any
// non-newline byte — so the verse text is preserved exactly. (Proof: stripping
// every newline from the input and from the output yields identical bytes;
// asserted in the regression test.) A `\v` is left in place when it already
// begins its line, optionally after a single paragraph/poetry marker
// (`\p`/`\q`/`\m`/`\s`/`\d`), mirroring the prefix convention used by
// collectCoveredVerses and countVerseMarkers.
function normalizeVerseLineStarts(usfm) {
  const result = [];
  for (const line of usfm.split('\n')) {
    const idxs = [];
    const re = /\\v\s+\d+/g;
    let m;
    while ((m = re.exec(line)) !== null) idxs.push(m.index);
    if (idxs.length === 0) {
      result.push(line);
      continue;
    }
    // The first `\v` may stay on this line only if everything before it is a
    // valid line-start prefix (whitespace and/or one paragraph marker). Any
    // other content before it means it is a mid-line marker that must be split.
    const head = line.slice(0, idxs[0]);
    const headIsPrefix = /^\s*(?:\\[pqmsd]\d?\s+)?$/.test(head);
    let start = 0;
    for (let k = 0; k < idxs.length; k++) {
      if (k === 0 && headIsPrefix) continue; // leave a legitimate line-start \v attached
      result.push(line.slice(start, idxs[k]));
      start = idxs[k];
    }
    result.push(line.slice(start));
  }
  return result.join('\n');
}

// Apply normalizeVerseLineStarts to a file in place. Returns true when the file
// changed, false when it was already clean or unreadable.
//
// Why this exists: #247 wired normalizeVerseLineStarts into mergeAlignedUsfm,
// which was believed to cover the producer side. It does not. Merge runs only on
// the MULTI-batch path (chapters > 18 verses). A chapter of <= 18 verses takes
// the single-batch path, where the sub-agent writes the whole-chapter file
// directly via create_aligned_usfm and no merge ever happens — so short chapters
// kept shipping mid-line `\v` and were carried only by #246's push-side
// tolerance. Observed on AMO 8 (2026-07-24): 11 of 14 ULT verse markers landed
// mid-line on en_ult master, while the UST for the same chapter was clean.
//
// Writing back only on change keeps mtimes stable, which matters because the
// pipeline's staleness checks compare aligned-file mtimes against sources.
function normalizeVerseLineStartsInFile(absPath) {
  let before;
  try {
    before = fs.readFileSync(absPath, 'utf8');
  } catch {
    return false;
  }
  const after = normalizeVerseLineStarts(before);
  if (after === before) return false;
  try {
    fs.writeFileSync(absPath, after);
  } catch (err) {
    console.warn(`[usfm-tools] verse-line-start normalization could not write ${absPath}: ${err.message}`);
    return false;
  }
  return true;
}

function mergeAlignedUsfm({ parts, output }) {
  if (!parts || parts.length === 0) return 'Error: no parts provided';
  if (!output) return 'Error: no output path provided';

  const resolve = (p) => path.resolve(CSKILLBP_DIR, p);

  // Read and validate all parts
  const contents = [];
  for (const p of parts) {
    const full = resolve(p);
    if (!fs.existsSync(full)) return `Error: part not found: ${p}`;
    contents.push(fs.readFileSync(full, 'utf8'));
  }

  // Start with part[0] in full
  let merged = contents[0].trimEnd();

  // For subsequent parts, strip the header (everything up to and including the \c line)
  for (let i = 1; i < contents.length; i++) {
    const lines = contents[i].split('\n');
    let bodyStart = 0;
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].trim().startsWith('\\c ')) {
        bodyStart = j + 1;
        break;
      }
    }
    const body = lines.slice(bodyStart).join('\n').trimStart();
    if (body) merged += '\n' + body;
  }

  // Guarantee every \v marker starts a line so the on-disk artifact is always
  // clean for the downstream push guard (#245). Whitespace-only transform.
  merged = normalizeVerseLineStarts(merged);

  // Write output
  const outFull = resolve(output);
  fs.mkdirSync(path.dirname(outFull), { recursive: true });
  fs.writeFileSync(outFull, merged + '\n');

  // Count verses
  const verseCount = (merged.match(/\\v \d+/g) || []).length;
  const sizeKB = (Buffer.byteLength(merged, 'utf8') / 1024).toFixed(1);

  return `Merged ${parts.length} parts → ${output} (${verseCount} verses, ${sizeKB}KB)`;
}

/**
 * Deterministically recover aligned USFM from leftover mapping JSON.
 *
 * The align-all-parallel coordinator can return a nominal "success" while its
 * subagents left only per-verse mapping JSON in tmp/alignments and never ran
 * create_aligned_usfm / the merge (observed: AMO 5, 2026-07-01 — 27 ULT + 13
 * UST mapping JSON, zero aligned USFM). The pipeline's coverage gate correctly
 * flags missing_output, but a blind retry re-drives the same flaky coordinator.
 *
 * This converts whatever mapping JSON exists into a merged full-chapter aligned
 * file in Node — no LLM, no shell — so the coverage gate can bank the verses
 * that were genuinely produced and any retry only has to re-align the verses
 * whose JSON is still missing.
 *
 * Disambiguation is by CONTENT, not filename: ULT and UST mapping JSON have
 * historically landed in the shared tmp/alignments dir under inconsistent names
 * (AMO-05-NNN.json vs AMO-005-NNN.json), so we match each candidate's
 * english_text to the requested type's source verse text and convert with the
 * correct source. Robust to 1/2/3-digit chapter padding and to the new
 * `-ult`/`-ust` token (used only as a tiebreaker).
 *
 * @returns {{converted:number[], missing:number[], mergedOutput:string|null, note:string}}
 */
/** Verse numbers present (any `\v N`) in an aligned USFM string, ascending & deduped. */
function versesPresentInUsfm(usfm) {
  const out = new Set();
  const re = /\\v\s+(\d+)\b/g;
  let m;
  while ((m = re.exec(String(usfm || ''))) !== null) out.add(parseInt(m[1], 10));
  return [...out].sort((a, b) => a - b);
}

/**
 * Non-regression check for salvage's whole-chapter overwrite. Salvage rebuilds
 * the merged file from ONLY the verses it recovered, so overwriting a partial
 * that already covers some verses can DROP a verse whose mapping JSON is now
 * missing/stale. Returns the verses present in `existingUsfm` that `salvagedVerses`
 * does NOT cover (ascending); empty means the salvage set is a superset and the
 * overwrite is safe (can only add coverage, never remove it).
 */
function salvageDroppedVerses(existingUsfm, salvagedVerses) {
  const salvaged = new Set(salvagedVerses);
  return versesPresentInUsfm(existingUsfm).filter((v) => !salvaged.has(v));
}

function salvageAlignedFromMappingJson({ book, chapter, type, sourceRel, hebrewRel, alignmentsDir = 'tmp/alignments' }) {
  const result = { converted: [], missing: [], missingReasons: {}, mergedOutput: null, note: '' };
  const abs = (rel) => path.resolve(CSKILLBP_DIR, rel);
  // Record a per-verse reason alongside pushing onto result.missing so a
  // downstream failure summary can distinguish "coordinator never produced
  // mapping JSON for this verse" from "JSON exists but scored below the
  // similarity threshold (likely stale after source regeneration)". Operators
  // reading a templated pipeline-failure issue (see #222) can then act on the
  // right root cause without inspecting tmp/alignments by hand.
  const markMissing = (verse, reason) => {
    result.missing.push(verse);
    result.missingReasons[verse] = reason;
  };
  const isUst = String(type).toLowerCase() === 'ust';
  const typeTok = isUst ? 'ust' : 'ult';
  const bookU = String(book).toUpperCase();
  const ch = parseInt(chapter, 10);

  if (!sourceRel || !fs.existsSync(abs(sourceRel))) { result.note = `source missing: ${sourceRel}`; return result; }
  if (!hebrewRel || !fs.existsSync(abs(hebrewRel))) { result.note = `hebrew missing: ${hebrewRel}`; return result; }

  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\\[a-z]+\d*\*?/g, ' ')      // strip any usfm markers
    .replace(/[^a-z0-9 ]+/g, ' ')          // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();

  // --- 1) verse plain-text from the (unaligned) source chapter ---
  // \v markers are not line-anchored — they follow poetry/paragraph markers on
  // the same line (e.g. "\q1 \v 1 Hear this word"). Scan for \v N anywhere and
  // capture its text up to the next \v (or the chapter's end).
  const srcVerses = new Map(); // verseNum -> normalized text
  {
    let raw = fs.readFileSync(abs(sourceRel), 'utf8');
    // If the source spans multiple chapters, restrict to the requested one.
    const cIdx = raw.search(new RegExp(`\\\\c\\s+${ch}\\b`));
    if (cIdx >= 0) {
      raw = raw.slice(cIdx);
      const nextC = raw.slice(3).search(/\\c\s+\d+\b/);
      if (nextC >= 0) raw = raw.slice(0, nextC + 3);
    }
    const re = /\\v\s+(\d+)([\s\S]*?)(?=\\v\s+\d+|$)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const v = parseInt(m[1], 10);
      if (!srcVerses.has(v)) srcVerses.set(v, norm(m[2]));
    }
  }
  if (srcVerses.size === 0) { result.note = 'no verses parsed from source'; return result; }

  // --- 2) index candidate mapping JSON for this book+chapter (padding-agnostic) ---
  const candidates = new Map(); // verseNum -> [{path, english, tokenMatch}]
  const rejectedCandidates = new Map(); // verseNum -> unreadable/invalid mapping reason
  const recordRejectedCandidate = (filename, reason) => {
    // Mapping filenames historically use BOOK-CHAPTER-VERSE.json or
    // BOOK-CHAPTER-vVERSE-TYPE.json. Use that fallback only when the file
    // cannot supply a trustworthy JSON reference.
    const m = filename.match(/^([1-3]?[A-Z]{2,3})-(\d{1,3})-v?(\d{1,3})(?:-(?:ult|ust))?\.json$/i);
    if (!m || m[1].toUpperCase() !== bookU || parseInt(m[2], 10) !== ch) return;
    const verse = parseInt(m[3], 10);
    // Preserve the more actionable filesystem failure if multiple bad files
    // target the same verse.
    if (!rejectedCandidates.has(verse) || reason === 'unreadable_mapping_json') {
      rejectedCandidates.set(verse, reason);
    }
  };
  const walk = (dirRel) => {
    let entries;
    try { entries = fs.readdirSync(abs(dirRel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const childRel = `${dirRel}/${e.name}`;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.name.endsWith('.json')) continue;
      let raw;
      try { raw = fs.readFileSync(abs(childRel), 'utf8'); } catch (_) {
        recordRejectedCandidate(e.name, 'unreadable_mapping_json');
        continue;
      }
      let data;
      try { data = JSON.parse(raw); } catch (_) {
        recordRejectedCandidate(e.name, 'invalid_mapping_json');
        continue;
      }
      const ref = String(data.reference || '');
      const m = ref.match(/^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+)/);
      if (!m) {
        recordRejectedCandidate(e.name, 'invalid_mapping_json');
        continue;
      }
      if (m[1].toUpperCase() !== bookU || parseInt(m[2], 10) !== ch) continue;
      const verse = parseInt(m[3], 10);
      if (!candidates.has(verse)) candidates.set(verse, []);
      candidates.get(verse).push({
        path: childRel,
        english: norm(data.english_text),
        tokenMatch: /-(ult|ust)\.json$/i.test(e.name) ? e.name.toLowerCase().includes(`-${typeTok}.json`) : null,
      });
    }
  };
  walk(alignmentsDir);

  // token-overlap similarity (Jaccard on word sets)
  const sim = (a, b) => {
    if (!a || !b) return 0;
    const A = new Set(a.split(' ')), B = new Set(b.split(' '));
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
  };

  // --- 3) per-verse: pick the JSON matching THIS type's source, then convert ---
  const parts = [];
  const salvageDir = `tmp/aligned/salvage`;
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  for (const verse of [...srcVerses.keys()].sort((a, b) => a - b)) {
    const cands = candidates.get(verse) || [];
    if (cands.length === 0) { markMissing(verse, rejectedCandidates.get(verse) || 'no_mapping_json'); continue; }
    const srcPlain = srcVerses.get(verse);
    // best by content similarity to this type's source; break ties by explicit token
    let best = null, bestScore = -1;
    for (const c of cands) {
      let score = sim(c.english, srcPlain);
      if (c.tokenMatch === true) score += 0.001;      // nudge toward correctly-tokened file
      if (c.tokenMatch === false) score -= 0.001;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    // A correct mapping JSON's english_text essentially EQUALS its source verse
    // text (alignment is a 1:1 mapping of the source — see ULT/UST Step 7 "match
    // exactly"). A high bar rejects both cross-type contamination (a ULT JSON
    // standing in for a missing UST verse, or vice versa) and stale JSON that no
    // longer matches the current source — those verses are reported missing so a
    // retry re-aligns them properly rather than banking wrong text.
    if (!best || bestScore < 0.85) {
      markMissing(verse, `low_similarity(${bestScore < 0 ? 'n/a' : bestScore.toFixed(2)})`);
      continue;
    }
    const outRel = `${salvageDir}/${bookU}-${pad2(ch)}-${pad3(verse)}-${typeTok}-aligned.usfm`;
    try { fs.mkdirSync(path.dirname(abs(outRel)), { recursive: true }); } catch (_) { /* ok */ }
    const conv = createAlignedUsfm({ hebrew: hebrewRel, mapping: best.path, source: sourceRel, output: outRel, chapter: ch, verse, ust: isUst });
    if (typeof conv === 'string' && conv.startsWith('Error')) { markMissing(verse, 'conversion_error'); continue; }
    let produced;
    try { produced = fs.readFileSync(abs(outRel), 'utf8'); } catch (_) { markMissing(verse, 'unreadable_output'); continue; }
    if (!/\\zaln-s/.test(produced) || !new RegExp(`\\\\v\\s+${verse}\\b`).test(produced)) { markMissing(verse, 'invalid_output'); continue; }
    parts.push({ verse, rel: outRel });
    result.converted.push(verse);
  }

  if (parts.length === 0) { result.note = 'no verses converted'; return result; }

  // --- 4) merge per-verse parts (verse order) into the full-chapter aligned file ---
  parts.sort((a, b) => a.verse - b.verse);
  const chTok = bookU === 'PSA' ? String(ch).padStart(3, '0') : pad2(ch);
  const mergedRel = `output/AI-${isUst ? 'UST' : 'ULT'}/${bookU}/${bookU}-${chTok}-aligned.usfm`;

  // Non-regression guard. The merge below writes the whole-chapter file from ONLY
  // the salvaged per-verse parts, so it is safe when the file is absent
  // (reason 'missing'). When called on an 'incomplete' partial (a merged file
  // already covers some verses), overwriting with a salvage set that omits a
  // verse the existing file has would REGRESS coverage — e.g. a verse whose
  // mapping JSON is now stale/low-similarity is rejected here yet is present and
  // valid in the existing file. Only overwrite when the salvaged verse set is a
  // superset of what the existing file already covers; otherwise leave the
  // existing file untouched and report nothing salvaged (caller re-checks the
  // file and reports the unchanged, smaller gap).
  const existingAbs = abs(mergedRel);
  if (fs.existsSync(existingAbs)) {
    let existingUsfm = '';
    try { existingUsfm = fs.readFileSync(existingAbs, 'utf8'); } catch (_) { /* unreadable — treat as no coverage */ }
    const wouldDrop = salvageDroppedVerses(existingUsfm, parts.map((p) => p.verse));
    if (wouldDrop.length) {
      result.converted = [];
      const existingCovered = new Set(versesPresentInUsfm(existingUsfm));
      const priorReasons = result.missingReasons;
      result.missing = [...srcVerses.keys()].filter((v) => !existingCovered.has(v)).sort((a, b) => a - b);
      // Rebuild reasons for the new (post-guard) missing set. Verses that were
      // in the salvage loop keep their per-verse reason; verses that only
      // appear because the existing file already lacks them (i.e. never went
      // through the loop) are marked so operators can distinguish the two.
      result.missingReasons = {};
      for (const v of result.missing) {
        result.missingReasons[v] = priorReasons[v] || 'not_in_source_pass';
      }
      result.note = `skipped overwrite — salvage (${parts.length} verses) would drop verse(s) ${wouldDrop.join(', ')} present in existing ${mergedRel}`;
      return result;
    }
  }

  const mres = mergeAlignedUsfm({ parts: parts.map((p) => p.rel), output: mergedRel });
  if (typeof mres === 'string' && mres.startsWith('Error')) { result.note = mres; return result; }
  result.mergedOutput = mergedRel;
  result.note = mres;
  return result;
}

/**
 * Group `result.missingReasons` from `salvageAlignedFromMappingJson` into a
 * compact, human-readable summary: `"3 no-JSON (13,14,27); 1 low-similarity
 * 0.62 (18)"`. Empty input returns ''. This is what the align phase's status
 * message appends after "still missing 13-14" so the templated pipeline-failure
 * issue (see #222) carries actionable diagnosis without a workspace hand-inspection.
 */
function summarizeSalvageMissingReasons(missingReasons) {
  if (!missingReasons || typeof missingReasons !== 'object') return '';
  const buckets = new Map(); // reasonLabel -> verse[]
  for (const [verseStr, reason] of Object.entries(missingReasons)) {
    const verse = parseInt(verseStr, 10);
    if (!Number.isFinite(verse)) continue;
    // Collapse low_similarity(X.XX) into one bucket per distinct score so a
    // gap of many stale verses reads as one line, not one per verse. Keep the
    // score visible — it tells the operator whether the miss was borderline.
    const label = String(reason || 'unknown');
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(verse);
  }
  if (buckets.size === 0) return '';
  const parts = [];
  const order = ['no_mapping_json', 'unreadable_mapping_json', 'invalid_mapping_json', 'conversion_error', 'unreadable_output', 'invalid_output', 'not_in_source_pass'];
  const keys = [...buckets.keys()].sort((a, b) => {
    const ai = order.indexOf(a); const bi = order.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    const verses = buckets.get(key).sort((a, b) => a - b);
    const pretty = key === 'no_mapping_json' ? 'no JSON'
      : key === 'unreadable_mapping_json' ? 'unreadable mapping JSON'
      : key === 'invalid_mapping_json' ? 'invalid mapping JSON'
      : key === 'conversion_error' ? 'conversion error'
      : key === 'unreadable_output' ? 'unreadable output'
      : key === 'invalid_output' ? 'invalid output'
      : key === 'not_in_source_pass' ? 'gap in existing file'
      : key.startsWith('low_similarity(') ? `low similarity ${key.slice('low_similarity('.length, -1)}`
      : key;
    parts.push(`${verses.length} ${pretty} (${verses.join(',')})`);
  }
  return parts.join('; ');
}

/**
 * Validate alignment JSON files for the ULT/UST-alignment workflow.
 * Port of: validate_alignment_json.py
 */
function validateAlignmentJson({ files, ust }) {
  const ustMode = !!ust;
  const results = {};

  for (const relPath of files) {
    const filePath = path.resolve(CSKILLBP_DIR, relPath);
    const errors = [];

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      results[relPath] = { pass: false, errors: [e.code === 'ENOENT' ? 'File not found' : `Invalid JSON: ${e.message}`] };
      continue;
    }

    // Check required fields
    for (const field of ['reference', 'hebrew_words', 'english_text', 'alignments']) {
      if (!(field in data)) errors.push(`Missing required field: ${field}`);
    }
    if (errors.length) { results[relPath] = { pass: false, errors }; continue; }

    // Check Hebrew word indices are sequential 0..n-1
    const hebrewWords = data.hebrew_words;
    for (let i = 0; i < hebrewWords.length; i++) {
      if (hebrewWords[i].index !== i) {
        errors.push(`Hebrew word at position ${i} has index ${hebrewWords[i].index}, expected ${i}`);
      }
    }

    // Collect aligned indices
    const alignedIndices = new Set();
    for (const a of data.alignments) {
      for (const idx of (a.hebrew_indices || [])) {
        alignedIndices.add(idx);
      }
    }

    // Check out-of-range indices
    const expectedIndices = new Set([...Array(hebrewWords.length).keys()]);
    const extra = [...alignedIndices].filter(i => !expectedIndices.has(i));
    if (extra.length) errors.push(`Hebrew indices out of range: [${extra.sort((a, b) => a - b).join(', ')}]`);

    // ULT mode: every Hebrew index must be aligned
    if (!ustMode) {
      const missing = [...expectedIndices].filter(i => !alignedIndices.has(i));
      if (missing.length) errors.push(`Hebrew indices not aligned: [${missing.sort((a, b) => a - b).join(', ')}]`);
    }

    // UST mode: entries with hebrew_indices: [] must have all words bracketed
    if (ustMode) {
      for (let i = 0; i < data.alignments.length; i++) {
        const a = data.alignments[i];
        if (Array.isArray(a.hebrew_indices) && a.hebrew_indices.length === 0) {
          for (const word of (a.english || [])) {
            const stripped = word.replace(/[.,;:!?]+$/, '');
            if (!(stripped.startsWith('{') && stripped.endsWith('}'))) {
              errors.push(`Alignment ${i}: word "${word}" has hebrew_indices: [] but is not bracketed`);
            }
          }
        }
      }
    }

    // Check every English word appears exactly once across alignments
    const hasDText = 'd_text' in data;

    let engFromText, engFromAlignments;
    if (hasDText) {
      const dAlignments = data.alignments.filter(a => a.section === 'd');
      const bodyAlignments = data.alignments.filter(a => a.section !== 'd');

      // Validate d_text words
      const dFromText = data.d_text.split(/\s+/);
      const dFromAlignments = dAlignments.flatMap(a => a.english || []);
      const dTextCounts = countWords(dFromText);
      const dAlignCounts = countWords(dFromAlignments);
      for (const word of new Set([...Object.keys(dTextCounts), ...Object.keys(dAlignCounts)])) {
        const tc = dTextCounts[word] || 0;
        const ac = dAlignCounts[word] || 0;
        if (tc !== ac) {
          if (ac === 0) errors.push(`d_text: Word "${word}" in d_text but not in section:d alignments`);
          else if (tc === 0) errors.push(`d_text: Word "${word}" in section:d alignments but not in d_text`);
          else errors.push(`d_text: Word "${word}": ${ac} in section:d alignments, ${tc} in d_text`);
        }
      }

      engFromText = data.english_text.split(/\s+/);
      engFromAlignments = bodyAlignments.flatMap(a => a.english || []);
    } else {
      engFromText = data.english_text.split(/\s+/);
      engFromAlignments = data.alignments.flatMap(a => a.english || []);
    }

    const textCounts = countWords(engFromText);
    const alignCounts = countWords(engFromAlignments);
    for (const word of new Set([...Object.keys(textCounts), ...Object.keys(alignCounts)])) {
      const tc = textCounts[word] || 0;
      const ac = alignCounts[word] || 0;
      if (tc !== ac) {
        if (ac === 0) errors.push(`Word "${word}" in english_text but not in alignments`);
        else if (tc === 0) errors.push(`Word "${word}" in alignments but not in english_text`);
        else errors.push(`Word "${word}": ${ac} in alignments, ${tc} in english_text`);
      }
    }

    results[relPath] = { pass: errors.length === 0, errors };
  }

  // Format output
  const lines = [];
  let allPass = true;
  for (const [relPath, result] of Object.entries(results)) {
    const name = path.basename(relPath);
    if (result.pass) {
      lines.push(`OK    ${name}`);
    } else {
      allPass = false;
      lines.push(`FAIL  ${name}`);
      for (const e of result.errors) lines.push(`      ${e}`);
    }
  }
  const fileCount = Object.keys(results).length;
  if (allPass) {
    lines.push(`\nAll ${fileCount} file(s) passed.`);
  } else {
    lines.push(`\nValidation errors found.`);
  }
  return lines.join('\n');
}

function validateAlignedUsfmMarkup({ alignedUsfm, maxExamples = 10 }) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      findings: [{ ref: '?', token: '', line: 0, snippet: `file not found: ${alignedUsfm}` }],
      summary: `Aligned USFM missing: ${alignedUsfm}`,
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];
  let chapter = null;
  let verse = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const chMatch = line.match(/^\\c\s+(\d+)/);
    if (chMatch) chapter = chMatch[1];

    const verseMatches = [...line.matchAll(/\\v\s+(\d+)/g)];
    if (verseMatches.length > 0) {
      verse = verseMatches[verseMatches.length - 1][1];
    }

    const malformed = [...line.matchAll(/\\w\s+([^|\\\n]+?)(?=(?:\\zaln-e|\\q\d?\b|\\p\b|\\b\b|\\v\s+\d|\\c\s+\d|\\qs\b|$))/g)];
    for (const match of malformed) {
      const token = match[1].trim();
      if (!token) continue;
      const ref = chapter && verse ? `${chapter}:${verse}` : '?';
      findings.push({
        ref,
        token,
        line: i + 1,
        snippet: line.trim().slice(Math.max(0, match.index - 20), match.index + match[0].length + 40),
      });
    }
  }

  const examples = findings.slice(0, maxExamples);
  const summary = findings.length === 0
    ? `Aligned USFM markup OK: ${alignedUsfm}`
    : `Detected ${findings.length} malformed \\w token(s) in ${alignedUsfm}: ${examples.map((item) => `${item.ref} "${item.token}"`).join('; ')}`;

  return {
    ok: findings.length === 0,
    findings,
    summary,
  };
}

function summarizeAlignedUsfmMarkupFindings(findings, maxExamples = 5) {
  if (!Array.isArray(findings) || findings.length === 0) return 'no malformed \\w tokens';
  return findings
    .slice(0, maxExamples)
    .map((item) => `${item.ref} "${item.token}"`)
    .join('; ');
}

function validateAlignedUsfmCompleteness({
  alignedUsfm,
  minVerseCoverage = 0.6,
  minWordMarkers = 1,
  maxExamples = 5,
}) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      summary: `Aligned USFM missing: ${alignedUsfm}`,
      reasons: ['missing_file'],
      malformed: null,
      metrics: { verseCount: 0, alignedVerseCount: 0, verseCoverage: 0, wordMarkerCount: 0, zalnStartCount: 0 },
      examples: [],
    };
  }

  const malformed = validateAlignedUsfmMarkup({ alignedUsfm, maxExamples });
  const content = fs.readFileSync(filePath, 'utf8');
  const verses = [];
  const lines = content.split('\n');
  let chapter = null;

  for (const line of lines) {
    const chMatch = line.match(/^\\c\s+(\d+)/);
    if (chMatch) chapter = chMatch[1];
    const verseMatch = line.match(/\\v\s+(\d+)/);
    if (!verseMatch) continue;
    const verse = verseMatch[1];
    const ref = chapter ? `${chapter}:${verse}` : `?:${verse}`;
    const hasZaln = /\\zaln-s\b/.test(line);
    const wordCount = (line.match(/\\w\s+/g) || []).length;
    verses.push({ ref, hasZaln, wordCount });
  }

  const verseCount = verses.length;
  const alignedVerseCount = verses.filter((v) => v.hasZaln).length;
  const verseCoverage = verseCount > 0 ? alignedVerseCount / verseCount : 0;
  const wordMarkerCount = (content.match(/\\w\s+/g) || []).length;
  const zalnStartCount = (content.match(/\\zaln-s\b/g) || []).length;
  const missingVerseExamples = verses.filter((v) => !v.hasZaln).slice(0, maxExamples).map((v) => v.ref);

  const reasons = [];
  if (!malformed.ok) reasons.push('malformed_markup');
  if (verseCount > 0 && verseCoverage < minVerseCoverage) reasons.push('low_verse_coverage');
  if (wordMarkerCount < minWordMarkers || zalnStartCount === 0) reasons.push('low_marker_density');

  const summaryParts = [];
  summaryParts.push(
    `coverage=${alignedVerseCount}/${verseCount} verses (${(verseCoverage * 100).toFixed(1)}%), markers: \\zaln-s=${zalnStartCount}, \\w=${wordMarkerCount}`
  );
  if (!malformed.ok) summaryParts.push(`malformed: ${summarizeAlignedUsfmMarkupFindings(malformed.findings, maxExamples)}`);
  if (missingVerseExamples.length > 0) summaryParts.push(`no-alignment verses: ${missingVerseExamples.join(', ')}`);

  return {
    ok: reasons.length === 0,
    summary: `${reasons.length === 0 ? 'Alignment quality OK' : 'Alignment quality degraded'} for ${alignedUsfm} — ${summaryParts.join(' | ')}`,
    reasons,
    malformed,
    metrics: { verseCount, alignedVerseCount, verseCoverage, wordMarkerCount, zalnStartCount },
    examples: missingVerseExamples,
  };
}

function countWords(words) {
  const counts = {};
  for (const w of words) {
    if (w) counts[w] = (counts[w] || 0) + 1;
  }
  return counts;
}

/**
 * Validate bracketed words in aligned ULT against Hebrew prefix Strong's numbers.
 * Port of: validate_ult_brackets.py
 */
function validateUltBrackets({ alignedUsfm }) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  if (!fs.existsSync(filePath)) return `Error: file not found: ${alignedUsfm}`;

  const content = fs.readFileSync(filePath, 'utf8');

  // Hebrew prefix -> expected English translations
  const PREFIX_TRANSLATIONS = {
    b: ['in', 'by', 'with', 'at', 'among', 'on', 'against', 'through', 'when', 'while'],
    d: ['the'],
    c: ['and', 'but', 'or', 'then', 'so', 'now', 'yet'],
    k: ['like', 'as'],
    l: ['to', 'for', 'of', 'belonging'],
    m: ['from', 'out', 'than'],
  };

  let currentChapter = null;
  let currentVerse = null;
  const flagged = [];

  const lines = content.split('\n');
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    const chMatch = line.match(/^\\c\s+(\d+)/);
    if (chMatch) { currentChapter = chMatch[1]; currentVerse = null; continue; }

    const vMatch = line.match(/\\v\s+(\d+[-\d]*|front)/);
    if (vMatch && currentChapter) currentVerse = vMatch[1];

    if (currentVerse === null) continue;

    // Walk the line parsing zaln-s milestones and \w markers
    let pos = 0;
    let activeStrong = null;

    while (pos < line.length) {
      // zaln-s milestone
      const zalnMatch = line.slice(pos).match(/^\\zaln-s\s+\|([^\\]*?)\\?\*/);
      if (zalnMatch) {
        const attrs = zalnMatch[1];
        const sm = attrs.match(/x-strong="([^"]*)"/);
        if (sm) activeStrong = sm[1];
        pos += zalnMatch[0].length;
        continue;
      }

      // \w word marker
      const wMatch = line.slice(pos).match(/^\\w\s+([^|\\]+)\|[^\\]*\\w\*/);
      if (wMatch) {
        const word = wMatch[1].trim();
        if (word.startsWith('{') && word.endsWith('}') && activeStrong) {
          // Check if Strong's has a prefix
          const prefixMatch = activeStrong.match(/^([a-z]):(.+)/);
          if (prefixMatch) {
            const prefix = prefixMatch[1];
            const expectedWords = PREFIX_TRANSLATIONS[prefix] || [];
            const wordClean = word.replace(/^\{|\}$/g, '').toLowerCase();
            if (expectedWords.includes(wordClean)) {
              flagged.push({
                verse_ref: `${currentChapter}:${currentVerse}`,
                word,
                strong: activeStrong,
                prefix,
                fix: `Remove brackets: ${word} -> ${wordClean}`,
                line_num: lineNum + 1,
              });
            }
          }
        }
        pos += wMatch[0].length;
        continue;
      }

      // zaln-e milestone
      const zalnEMatch = line.slice(pos).match(/^\\zaln-e\\?\*/);
      if (zalnEMatch) {
        activeStrong = null;
        pos += zalnEMatch[0].length;
        continue;
      }

      pos++;
    }
  }

  if (!flagged.length) return `No bracket errors found in ${alignedUsfm}`;

  const lines2 = [`Found ${flagged.length} bracket error(s) in ${alignedUsfm}:\n`];
  for (const item of flagged) {
    lines2.push(`  ${item.verse_ref}  ${item.word}  Strong's: ${item.strong}  prefix: ${item.prefix}  -> ${item.fix}`);
  }
  return lines2.join('\n');
}

/**
 * Detect English passive voice aligned to active Hebrew verbs in aligned ULT USFM.
 * Port of: check_ult_voice_mismatch.py
 */
function checkUltVoiceMismatch({ alignedUsfm }) {
  const filePath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  if (!fs.existsSync(filePath)) return `Error: file not found: ${alignedUsfm}`;

  const content = fs.readFileSync(filePath, 'utf8');

  const PASSIVE_AUXILIARIES = new Set(['be', 'is', 'are', 'am', 'was', 'were', 'been', 'being']);

  const PARTICIPLE_ENDINGS = ['ed', 'en', 'wn', 'ung', 'orn', 'oken', 'osen', 'otten', 'iven', 'aken', 'tten'];

  const IRREGULAR_PARTICIPLES = new Set([
    'been', 'done', 'gone', 'seen', 'known', 'shown', 'given', 'taken',
    'made', 'said', 'told', 'found', 'thought', 'brought', 'bought',
    'caught', 'taught', 'sought', 'felt', 'left', 'held', 'kept', 'slept',
    'met', 'sent', 'spent', 'built', 'lent', 'lost', 'meant', 'heard',
    'born', 'borne', 'worn', 'torn', 'sworn', 'chosen', 'frozen', 'spoken',
    'broken', 'stolen', 'woken', 'written', 'hidden', 'ridden', 'driven',
    'risen', 'forgiven', 'forgotten', 'begotten', 'bitten', 'eaten', 'beaten',
    'shaken', 'forsaken', 'mistaken', 'undertaken', 'struck', 'stuck', 'stung',
    'swung', 'hung', 'sung', 'rung', 'sprung', 'begun', 'run', 'won', 'spun',
    'put', 'cut', 'shut', 'set', 'let', 'hit', 'hurt', 'cast', 'burst', 'cost',
    'spread', 'shed', 'split', 'spit', 'quit', 'rid', 'bid', 'read', 'led',
    'fed', 'bled', 'bred', 'sped', 'fled', 'paid', 'laid', 'called', 'filled',
    'killed', 'named', 'blessed', 'cursed', 'gathered', 'scattered', 'covered',
    'revealed', 'fulfilled', 'proclaimed', 'announced', 'established',
    'justified', 'sanctified', 'glorified', 'baptized', 'circumcised',
    'violated', 'humiliated', 'destroyed', 'consumed', 'exiled',
  ]);

  const NOT_PARTICIPLES = new Set([
    'not', 'that', 'what', 'but', 'just', 'about', 'out', 'without',
    'light', 'right', 'night', 'might', 'sight', 'fight', 'eight',
    'great', 'heart', 'part', 'start', 'apart', 'art',
    'in', 'then', 'when', 'often', 'even', 'open', 'seven', 'eleven',
    'own', 'down', 'town', 'brown', 'grown',
    'men', 'women', 'children', 'brethren',
    'heaven', 'garden', 'burden', 'sudden', 'golden', 'wooden',
    'listen', 'hasten', 'fasten', 'lessen', 'lesson',
    'and', 'hand', 'land', 'stand', 'understand', 'command', 'demand',
    'around', 'ground', 'sound', 'found', 'bound', 'round', 'wound',
    'hundred', 'kindred',
  ]);

  const STATIVE_ADJECTIVES = new Set([
    'ashamed', 'afraid', 'alone', 'afflicted', 'angry', 'anxious',
    'aware', 'alive', 'asleep', 'awake', 'absent', 'able',
    'blessed', 'blameless',
    'clean', 'certain', 'content',
    'dead', 'drunk',
    'empty', 'evil',
    'full', 'faithful', 'free',
    'glad', 'good', 'great', 'guilty', 'gracious',
    'holy', 'humble', 'hungry', 'happy',
    'innocent', 'ill',
    'jealous', 'just', 'joyful',
    'kind',
    'like', 'lost', 'low',
    'merciful', 'mighty',
    'naked', 'near',
    'obedient', 'old',
    'perfect', 'pleasant', 'poor', 'present', 'proud', 'pure',
    'quick', 'quiet',
    'ready', 'rich', 'righteous', 'right',
    'sad', 'safe', 'sick', 'silent', 'sinful', 'sorry', 'strong', 'sure', 'still',
    'true', 'troubled',
    'unclean', 'unworthy', 'upright',
    'weary', 'weak', 'well', 'whole', 'wicked', 'wise', 'worthy', 'wrong',
    'young',
  ]);

  function isActiveStem(morph) {
    const m = morph.match(/He,V([a-zA-Z])/);
    if (!m) return false;
    const stem = m[1];
    if (stem === 't') return false; // Hitpael — reflexive, passive rendering ok
    return stem === stem.toLowerCase();
  }

  function isPastParticiple(word) {
    const w = word.toLowerCase();
    if (STATIVE_ADJECTIVES.has(w) || NOT_PARTICIPLES.has(w)) return false;
    if (IRREGULAR_PARTICIPLES.has(w)) return true;
    return PARTICIPLE_ENDINGS.some(e => w.endsWith(e) && w.length > e.length + 2);
  }

  function findPassive(words) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i].toLowerCase().replace(/[.,;:!?\u201c\u201d\u2018\u2019"'{}[\]]+/g, '');
      if (PASSIVE_AUXILIARIES.has(w)) {
        for (let j = i + 1; j < Math.min(i + 4, words.length); j++) {
          const candidate = words[j].replace(/[.,;:!?\u201c\u201d\u2018\u2019"'{}[\]]+/g, '');
          if (isPastParticiple(candidate)) {
            return words.slice(i, j + 1).join(' ');
          }
        }
      }
    }
    return null;
  }

  const mismatches = [];
  let book = 'UNK';
  const idMatch = content.match(/\\id\s+(\S+)/);
  if (idMatch) book = idMatch[1];

  let chapter = '0';
  let verse = '0';
  let currentRef = `${book} ${chapter}:${verse}`;

  let inActiveZaln = false;
  let activeLemma = '';
  let activeContent = '';
  let activeEnglish = [];
  let zalnDepth = 0;

  for (const line of content.split('\n')) {
    const chMatch = line.match(/^\\c\s+(\d+)/);
    if (chMatch) { chapter = chMatch[1]; currentRef = `${book} ${chapter}:${verse}`; }

    const vMatch = line.match(/\\v\s+(\d+)/);
    if (vMatch) { verse = vMatch[1]; currentRef = `${book} ${chapter}:${verse}`; }

    if (inActiveZaln) {
      const opens = (line.match(/\\zaln-s\b/g) || []).length;
      const closes = (line.match(/\\zaln-e\\\*/g) || []).length;
      zalnDepth += opens - closes;

      const words = [...line.matchAll(/\\w\s+([^|{}\\\n]+?)\|/g)].map(m => m[1].trim());
      activeEnglish.push(...words);

      if (zalnDepth <= 0) {
        const phrase = findPassive(activeEnglish);
        if (phrase) {
          mismatches.push({
            ref: currentRef,
            lemma: activeLemma,
            hebrew: activeContent,
            english_phrase: phrase,
            english_context: activeEnglish.join(' '),
          });
        }
        inActiveZaln = false;
        activeEnglish = [];
      }
      continue;
    }

    // Look for a new zaln-s with an active Hebrew verb
    const zalnMatch = line.match(/\\zaln-s\s*\|([^*]*)\\\*/);
    if (zalnMatch) {
      const attrs = zalnMatch[1];
      const morphMatch = attrs.match(/x-morph="([^"]+)"/);
      if (morphMatch && isActiveStem(morphMatch[1])) {
        const lemmaMatch = attrs.match(/x-lemma="([^"]+)"/);
        const contentMatch = attrs.match(/x-content="([^"]+)"/);
        inActiveZaln = true;
        activeLemma = lemmaMatch ? lemmaMatch[1] : '';
        activeContent = contentMatch ? contentMatch[1] : '';
        activeEnglish = [];

        const opens = (line.match(/\\zaln-s\b/g) || []).length;
        const closes = (line.match(/\\zaln-e\\\*/g) || []).length;
        zalnDepth = opens - closes;

        const words = [...line.matchAll(/\\w\s+([^|{}\\\n]+?)\|/g)].map(m => m[1].trim());
        activeEnglish.push(...words);

        if (zalnDepth <= 0) {
          const phrase = findPassive(activeEnglish);
          if (phrase) {
            mismatches.push({
              ref: currentRef,
              lemma: activeLemma,
              hebrew: activeContent,
              english_phrase: phrase,
              english_context: activeEnglish.join(' '),
            });
          }
          inActiveZaln = false;
          activeEnglish = [];
        }
      }
    }
  }

  if (!mismatches.length) return `No voice mismatches found in ${alignedUsfm}`;

  const lines3 = [`Voice mismatches in ${alignedUsfm}:`];
  for (const m of mismatches) {
    lines3.push(`  ${m.ref}: Hebrew ${m.hebrew} (${m.lemma}) — active stem but English "${m.english_phrase}" [context: ${m.english_context}]`);
  }
  lines3.push(`\nFound ${mismatches.length} mismatch(es).`);
  return lines3.join('\n');
}

/**
 * Repair x-content byte order in aligned USFM to match UHB verbatim.
 *
 * The AI alignment pipeline may NFC-normalize Hebrew combining marks when writing
 * x-content (e.g. reordering DAGESH U+05BC before HIRIQ U+05B4 into HIRIQ-then-DAGESH),
 * while the UHB stores them in traditional Tanakh order (consonant → dagesh → vowel).
 * Same glyph, different bytes — downstream tools that compare x-content against UHB
 * \w tokens with strict equality silently miss the mismatch.
 *
 * This function reads UHB token texts verbatim (bypassing any library that might
 * normalize) and patches any x-content value that differs from its UHB source
 * only in combining-mark order (i.e. same NFC glyph, different bytes).
 *
 * @param {object} opts
 * @param {string} opts.alignedUsfm - Path to aligned USFM file (relative to workspace)
 * @param {string} opts.hebrewUsfm  - Path to Hebrew UHB source USFM (relative to workspace)
 * @returns {string} Summary of changes made
 */
function repairAlignmentXContent({ alignedUsfm, hebrewUsfm }) {
  const alignedPath = path.resolve(CSKILLBP_DIR, alignedUsfm);
  const hebrewPath = path.resolve(CSKILLBP_DIR, hebrewUsfm);

  if (!fs.existsSync(alignedPath)) return `Error: aligned USFM not found: ${alignedUsfm}`;
  if (!fs.existsSync(hebrewPath)) return `Error: Hebrew USFM not found: ${hebrewUsfm}`;

  // Build per-verse map of verbatim UHB word texts.
  // Use a plain regex — never pass through usfm-js or any library that might normalize.
  const hebrewContent = fs.readFileSync(hebrewPath, 'utf8');
  const uhbByVerse = {};  // "ch:vs" -> { NFC(word): [verbatim1, verbatim2, ...] }
  let uhbCh = 0, uhbVs = 0;
  const UHB_W_RE = /\\w\s+([^\\]*)\\*/g;

  for (const line of hebrewContent.split('\n')) {
    const cm = line.match(/^\\c\s+(\d+)/);
    if (cm) { uhbCh = parseInt(cm[1], 10); uhbVs = 0; continue; }
    const vm = line.match(/^\\v\s+(\d+)/);
    if (vm) { uhbVs = parseInt(vm[1], 10); continue; }
    if (!uhbCh || !uhbVs) continue;

    const key = `${uhbCh}:${uhbVs}`;
    if (!uhbByVerse[key]) uhbByVerse[key] = {};
    const map = uhbByVerse[key];

    UHB_W_RE.lastIndex = 0;
    let m;
    while ((m = UHB_W_RE.exec(line)) !== null) {
      const attrStr = m[1];

      const wordM = attrStr.match(/^([^|]+)/);
      const word = wordM ? wordM[1].trimEnd() : '';

      const lemmaM = attrStr.match(/lemma="([^"]*)"/);
      const lemma = lemmaM ? lemmaM[1] : null;

      const nfc = word.normalize('NFC');

      if (!map[nfc]) map[nfc] = [];

      map[nfc].push({
        word,
        lemma
      });
    }
  }

  // Patch x-content values in the aligned USFM.
  const alignedLines = fs.readFileSync(alignedPath, 'utf8').split('\n');
  let repaired = 0;
  let aCh = 0, aVs = 0;
  const ZALN_RE = /\\zaln-s\s*\|([^*]*?)\\\*/g;

  for (let i = 0; i < alignedLines.length; i++) {
    const line = alignedLines[i];

    // Always update chapter/verse state before the early-continue
    const cm = line.match(/^\\c\s+(\d+)/);
    if (cm) { aCh = parseInt(cm[1], 10); aVs = 0; }
    const vm2 = line.match(/\\v\s+(\d+)/);
    if (vm2) { aVs = parseInt(vm2[1], 10); }

    if (!line.includes('\\zaln-s')) continue;

    const verseKey = `${aCh}:${aVs}`;
    const verseTokens = uhbByVerse[verseKey];
    if (!verseTokens) continue;

    ZALN_RE.lastIndex = 0;
    let newLine = line;
    let offset = 0;
    let zm;

    while ((zm = ZALN_RE.exec(line)) !== null) {
      const attrStr = zm[1];
      const contentM = attrStr.match(/x-content="([^"]*)"/);
      if (!contentM) continue;

      const xContent = contentM[1];
      // Only process Hebrew-range text
      if (!xContent || !/[֐-׿]/.test(xContent)) continue;

      // Look up UHB verbatim words by NFC-normalized form
      const nfc = xContent.normalize('NFC');
      const candidates = verseTokens[nfc];
      if (!candidates || !candidates.length) continue;

      // Use x-occurrence (1-based) to select the right candidate
      const occM = attrStr.match(/x-occurrence="(\d+)"/);
      const occ = occM ? parseInt(occM[1], 10) : 1;
      const uhbEntry = candidates[Math.min(occ - 1, candidates.length - 1)];
      const uhbWord = uhbEntry?.word;
      const uhbLemma = uhbEntry?.lemma;

      if (!uhbWord || uhbWord === xContent) continue;

      // Same NFC glyph, different byte order — patch to UHB verbatim bytes
      const posInNewLine = zm.index + offset;

      // start from original matched token
      let newMatch = zm[0];

      // 1. Replace x-content
      newMatch = newMatch.replace(
        `x-content="${xContent}"`,
        `x-content="${uhbWord}"`
      );

      // 2. Replace x-lemma (if available)
      if (uhbLemma) {
        newMatch = newMatch.replace(
          /x-lemma="[^"]*"/,
          `x-lemma="${uhbLemma}"`
        );
      }

      // splice back into line
      newLine =
        newLine.slice(0, posInNewLine) +
        newMatch +
        newLine.slice(posInNewLine + zm[0].length);

      offset += newMatch.length - zm[0].length;
      repaired++;
    }

    if (newLine !== line) alignedLines[i] = newLine;
  }

  if (repaired > 0) {
    fs.writeFileSync(alignedPath, alignedLines.join('\n'));
    // Also normalize here, not only via createAlignedUsfm: this function is
    // exposed as the standalone `repair_alignment_x_content` tool, so a skill
    // can reach an aligned file through a path that never goes near
    // createAlignedUsfm or mergeAlignedUsfm. Normalization is newline-only and
    // idempotent, so applying it on both routes is harmless.
    normalizeVerseLineStartsInFile(alignedPath);
    return `Repaired ${repaired} x-content byte-order mismatch(es) in ${path.basename(alignedUsfm)} — x-content now byte-identical to UHB`;
  }
  return `No x-content byte-order mismatches found in ${path.basename(alignedUsfm)}`;
}

module.exports = {
  extractUltEnglish,
  filterPsalms,
  curlyQuotes,
  checkUstPassives,
  createAlignedUsfm,
  repairAlignmentXContent,
  readUsfmChapter,
  mergeAlignedUsfm,
  normalizeVerseLineStarts,
  normalizeVerseLineStartsInFile,
  planAlignmentBatches,
  assertBatchPlanCoversChapter,
  planAlignmentBatchesTool,
  salvageAlignedFromMappingJson,
  salvageDroppedVerses,
  summarizeSalvageMissingReasons,
  versesPresentInUsfm,
  validateAlignmentJson,
  validateAlignedUsfmMarkup,
  summarizeAlignedUsfmMarkupFindings,
  validateAlignedUsfmCompleteness,
  validateUltBrackets,
  checkUltVoiceMismatch,
};
