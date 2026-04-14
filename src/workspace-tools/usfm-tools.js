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
    if (output) {
      return `Aligned USFM written to ${output}`;
    }
    return result;
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

module.exports = { extractUltEnglish, filterPsalms, curlyQuotes, checkUstPassives, createAlignedUsfm, readUsfmChapter, mergeAlignedUsfm, validateAlignmentJson, validateUltBrackets, checkUltVoiceMismatch };
