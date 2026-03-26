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
 * Extract a single chapter from a book-level USFM file.
 * Returns the file header (before first \c) plus the matching \c N block.
 */
function readUsfmChapter({ file, chapter }) {
  const filePath = path.resolve(CSKILLBP_DIR, file);
  if (!fs.existsSync(filePath)) return `Error: file not found: ${file}`;

  const content = fs.readFileSync(filePath, 'utf8');
  const ch = parseInt(chapter, 10);
  if (isNaN(ch)) return `Error: invalid chapter number: ${chapter}`;

  // Split by \c markers, preserving them (same pattern as filterPsalms)
  const parts = content.split(/(\\c\s+\d+)/);
  const header = parts[0]; // everything before first \c

  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    const body = parts[i + 1] || '';
    const m = marker.match(/\\c\s+(\d+)/);
    if (m && parseInt(m[1], 10) === ch) {
      return header + marker + body;
    }
  }

  return `Error: chapter ${ch} not found in ${file}`;
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

module.exports = { extractUltEnglish, filterPsalms, curlyQuotes, checkUstPassives, createAlignedUsfm, readUsfmChapter, mergeAlignedUsfm };
