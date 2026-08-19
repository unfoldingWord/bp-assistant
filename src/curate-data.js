// curate-data.js — Workspace data curation (MCP tool + admin DM handler)
//
// Discovers published books from Door43 releases, fetches ULT/UST/TN/Hebrew/T4T,
// Google Sheets/Docs, extracts unaligned English via usfm-js, resolves GL quotes,
// and builds search indexes. Replaces 6+ Python fetch/build scripts.
//
// Used by: mcp-server.js (tool), router.js (admin DM command)

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Workspace root — /workspace in Docker, or ../workspace relative to app/
const WORKSPACE = process.env.CSKILLBP_DIR || path.resolve(__dirname, '..', '..', 'workspace');
const DATA_DIR = path.join(WORKSPACE, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const MANIFEST_PATH = path.join(CACHE_DIR, 'published_manifest.json');
const FETCH_STATUS_PATH = path.join(DATA_DIR, '.fetch-status.json');

// usfm-js is an app dependency (installed via npm, baked into Docker image)
let usfm;
function getUsfm() {
  if (!usfm) usfm = require('usfm-js');
  return usfm;
}

// ── Configuration ──────────────────────────────────────────────────────────

const DOOR43_API = 'https://git.door43.org/api/v1';
const DOOR43_RAW = 'https://git.door43.org/unfoldingWord';

const REPOS = { ult: 'en_ult', ust: 'en_ust', tn: 'en_tn', uhb: 'hbo_uhb', t4t: 'en_t4t' };

const GOOGLE = {
  glossary: {
    sheetId: '1pop2F61kRCRBgUvf8zHVwx9s-CBE8x3PyXojrTjJ3Lc',
    tabs: {
      hebrew_ot_glossary: 1711192506,
      biblical_measurements: 1835633752,
      psalms_reference: 1739562476,
      sacrifice_terminology: 243454428,
      biblical_phrases: 1459152614,
    },
  },
  templates: { sheetId: '1ot6A7RxcsxM_Wv94sauoTAaRPO5Q-gynFqMHeldnM64', gid: 1419396008 },
  issuesResolved: { docId: '1C0C7Qsm78fM0tuLyVZEAs-IWtClNo9nqbsAZkAFeFio' },
};

const MAX_OT_NUMBER = 39;
const MAX_SAMPLE_REFS = 5;
const MAX_SAMPLES = 5;
const MAX_KEYWORD_ISSUES = 10;
const MIN_KEYWORD_LEN = 3;

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could',
  'not','no','nor','so','if','then','than','that','this','these','those','it',
  'its','he','him','his','she','her','hers','they','them','their','theirs','we',
  'us','our','ours','you','your','yours','i','me','my','mine','who','whom',
  'whose','which','what','when','where','how','why','all','each','every','both',
  'few','more','most','other','some','such','only','own','same','also','very',
  'just','about','up','out','into','over','after','before','between','under',
  'again','there','here','once','during','while','through','because','until',
  'against','above','below','down','off','any','too','now','even','still','yet',
  'already','always','never','often','sometimes','much','many','well','back',
  'away','upon','among','along','across','around','within','without','toward',
  'towards','whether','though','although','however','therefore','thus','hence',
  'else','instead','rather','quite','perhaps','certainly','indeed','especially',
  'merely','simply','actually','apparently','anyway',
]);

// ── HTTP ───────────────────────────────────────────────────────────────────

function httpFetch(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function (resolve, reject) {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, { headers: { 'User-Agent': 'curate-data/1.0' } }, function (res) {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(httpFetch(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

// ── Utility ────────────────────────────────────────────────────────────────

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function today() { return new Date().toISOString().slice(0, 10); }
function stripBom(t) { return t.replace(/^\uFEFF/, ''); }

// Every fetched file starts with a "# Fetched: <date>" line (written by
// fetchDoor43Data / fetchGoogleData). TSV readers must step over it so that
// lines[0] is the real header row -- reading the comment as the header
// silently loses every named column. extractUnalignedEnglish already does
// this for USFM. Returns the comment (or null) plus the remaining lines, so
// a caller that rewrites the file can put the comment back.
function splitFetchedHeader(text) {
  var lines = text.split('\n');
  var comment = (lines.length && lines[0].startsWith('# Fetched:')) ? lines.shift() : null;
  return { comment: comment, lines: lines };
}

function joinFetchedHeader(comment, lines) {
  return (comment ? comment + '\n' : '') + lines.join('\n');
}

function getCachedDate(filepath) {
  if (!fs.existsSync(filepath)) return null;
  var first = fs.readFileSync(filepath, 'utf-8').split('\n')[0];
  return first.startsWith('# Fetched: ') ? first.slice(11) : null;
}

function shouldRefreshWeekly(dateStr) {
  if (!dateStr) return true;
  var cached = new Date(dateStr);
  if (isNaN(cached.getTime())) return true;
  var now = new Date();
  var daysSinceThursday = (now.getDay() - 4 + 7) % 7;
  var lastThursday = new Date(now);
  lastThursday.setDate(now.getDate() - daysSinceThursday);
  lastThursday.setHours(0, 0, 0, 0);
  return cached < lastThursday;
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { release: null, books: [], lastRun: null };
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')); } catch (e) { return { release: null, books: [], lastRun: null }; }
}

function writeManifest(m) { ensureDir(CACHE_DIR); fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }

// ── Step 1: Discover published books ───────────────────────────────────────

async function discoverPublishedBooks(log) {
  log('Checking Door43 releases...');
  var releases = JSON.parse(await httpFetch(DOOR43_API + '/repos/unfoldingWord/' + REPOS.ult + '/releases?limit=1'));
  if (!releases.length) throw new Error('No releases found for en_ult');

  var release = releases[0];
  var tag = release.tag_name;
  log('Latest release: ' + tag);

  var bookSet = new Set();
  for (var i = 0; i < (release.assets || []).length; i++) {
    var asset = release.assets[i];
    var m = asset.name.match(/en_ult_(\d+)-(\w+)_v\d+/);
    if (m && parseInt(m[1], 10) <= MAX_OT_NUMBER) {
      bookSet.add(m[1] + '-' + m[2]);
    }
  }
  // PSA is published but not always in release assets
  bookSet.add('19-PSA');

  var books = Array.from(bookSet).sort();
  log('Published OT books: ' + books.length);
  return { tag: tag, books: books };
}

// ── Step 2-3: Fetch Door43 data ────────────────────────────────────────────

async function fetchDoor43Data(books, force, manifest, log) {
  var dirs = {
    ult: path.join(DATA_DIR, 'published_ult'),
    ust: path.join(DATA_DIR, 'published_ust'),
    tn:  path.join(DATA_DIR, 'published-tns'),
    hebrew: path.join(DATA_DIR, 'hebrew_bible'),
    t4t: path.join(DATA_DIR, 't4t'),
  };
  Object.values(dirs).forEach(function (d) { ensureDir(d); });

  var previousBooks = new Set(manifest.books || []);
  var newBooks = books.filter(function (b) { return !previousBooks.has(b); });
  if (newBooks.length) log('New books: ' + newBooks.map(function (b) { return b.split('-')[1]; }).join(', '));

  var fetched = 0;
  for (var bi = 0; bi < books.length; bi++) {
    var parts = books[bi].split('-');
    var num = parts[0], code = parts[1];
    var filename = num + '-' + code + '.usfm';
    var tnFilename = 'tn_' + code + '.tsv';

    var targets = [
      { url: DOOR43_RAW + '/' + REPOS.ult + '/raw/branch/master/' + filename, dest: path.join(dirs.ult, filename) },
      { url: DOOR43_RAW + '/' + REPOS.ust + '/raw/branch/master/' + filename, dest: path.join(dirs.ust, filename) },
      { url: DOOR43_RAW + '/' + REPOS.tn + '/raw/branch/master/' + tnFilename, dest: path.join(dirs.tn, tnFilename) },
      { url: DOOR43_RAW + '/' + REPOS.uhb + '/raw/branch/master/' + filename, dest: path.join(dirs.hebrew, filename) },
      { url: DOOR43_RAW + '/' + REPOS.t4t + '/raw/branch/master/' + filename, dest: path.join(dirs.t4t, filename) },
    ];

    for (var ti = 0; ti < targets.length; ti++) {
      var target = targets[ti];
      if (!force && fs.existsSync(target.dest)) {
        var first = fs.readFileSync(target.dest, 'utf-8').split('\n')[0];
        if (first.startsWith('# Fetched:') && !newBooks.includes(books[bi])) continue;
      }
      try {
        var content = await httpFetch(target.url);
        fs.writeFileSync(target.dest, '# Fetched: ' + today() + '\n' + content);
        fetched++;
      } catch (err) {
        if (!target.dest.includes('/t4t/')) {
          log('Warning: ' + path.basename(target.dest) + ': ' + err.message);
        }
      }
    }
  }
  log('Fetched ' + fetched + ' files from Door43');
  return newBooks;
}

// ── Step 4: Fetch Google Sheets/Docs ───────────────────────────────────────

async function fetchGoogleData(force, log, fetchErrors) {
  log('Fetching Google Sheets/Docs...');
  var glossaryDir = path.join(DATA_DIR, 'glossary');
  ensureDir(glossaryDir);

  function recordFailure(file, err) {
    fetchErrors.push({ file: file, message: err.message, attemptedAt: new Date().toISOString() });
    log('Warning: ' + file + ': ' + err.message);
  }

  var tabEntries = Object.entries(GOOGLE.glossary.tabs);
  for (var gi = 0; gi < tabEntries.length; gi++) {
    var name = tabEntries[gi][0], gid = tabEntries[gi][1];
    var dest = path.join(glossaryDir, name + '.csv');
    if (!force && fs.existsSync(dest) && !shouldRefreshWeekly(getCachedDate(dest))) continue;
    try {
      var url = 'https://docs.google.com/spreadsheets/d/' + GOOGLE.glossary.sheetId + '/export?format=csv&gid=' + gid;
      fs.writeFileSync(dest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(url)));
      log('  ' + name + '.csv');
    } catch (err) { recordFailure(name + '.csv', err); }
  }

  var templatesDest = path.join(DATA_DIR, 'templates.csv');
  if (force || !fs.existsSync(templatesDest) || shouldRefreshWeekly(getCachedDate(templatesDest))) {
    try {
      var tUrl = 'https://docs.google.com/spreadsheets/d/' + GOOGLE.templates.sheetId + '/export?format=csv&gid=' + GOOGLE.templates.gid;
      fs.writeFileSync(templatesDest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(tUrl)));
      log('  templates.csv');
    } catch (err) { recordFailure('templates.csv', err); }
  }

  var issuesDest = path.join(DATA_DIR, 'issues_resolved.txt');
  if (force || !fs.existsSync(issuesDest) || shouldRefreshWeekly(getCachedDate(issuesDest))) {
    try {
      var iUrl = 'https://docs.google.com/document/d/' + GOOGLE.issuesResolved.docId + '/export?format=txt';
      fs.writeFileSync(issuesDest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(iUrl)));
      log('  issues_resolved.txt');
    } catch (err) { recordFailure('issues_resolved.txt', err); }
  }
}

function readFetchStatus() {
  if (!fs.existsSync(FETCH_STATUS_PATH)) return { lastRun: null, lastSuccess: null, errors: [] };
  try { return JSON.parse(fs.readFileSync(FETCH_STATUS_PATH, 'utf-8')); }
  catch (e) { return { lastRun: null, lastSuccess: null, errors: [] }; }
}

function writeFetchStatus(fetchErrors) {
  ensureDir(DATA_DIR);
  var prev = readFetchStatus();
  var now = new Date().toISOString();
  var status = {
    lastRun: now,
    lastSuccess: fetchErrors.length === 0 ? now : (prev.lastSuccess || null),
    errors: fetchErrors,
  };
  fs.writeFileSync(FETCH_STATUS_PATH, JSON.stringify(status, null, 2));
}

// ── Step 5: Extract unaligned English via usfm-js ──────────────────────────

function extractPlainText(parsed) {
  var lines = [];
  var headers = parsed.headers || [];
  for (var hi = 0; hi < headers.length; hi++) {
    if (headers[hi].tag && headers[hi].content) lines.push('\\' + headers[hi].tag + ' ' + headers[hi].content);
  }
  var chapters = Object.entries(parsed.chapters || {});
  for (var ci = 0; ci < chapters.length; ci++) {
    var ch = chapters[ci][0], chData = chapters[ci][1];
    lines.push('\\c ' + ch);
    lines.push('\\p');
    var verses = Object.entries(chData);
    for (var vi = 0; vi < verses.length; vi++) {
      lines.push('\\v ' + verses[vi][0] + ' ' + buildVerseText(verses[vi][1].verseObjects || []));
    }
  }
  return lines.join('\n');
}

function buildVerseText(objects) {
  var parts = [];
  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    if (obj.type === 'quote' && obj.tag && obj.text) parts.push('\n\\' + obj.tag + ' ' + obj.text.replace(/\n$/, ''));
    else if (obj.type === 'text' && obj.text) parts.push(obj.text);
    else if (obj.tag === 'w' && obj.type === 'word' && obj.text) parts.push(obj.text);
    else if (obj.children) parts.push(buildVerseText(obj.children));
  }
  return parts.join('');
}

function collectAlignments(objects, bookId, chapter, verse, out) {
  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    if (obj.tag === 'zaln' && obj.type === 'milestone') {
      var words = gatherWords(obj.children || []);
      out.push({
        ref: bookId + ' ' + chapter + ':' + verse, chapter: chapter, verse: verse,
        source: { word: obj.content || '', lemma: obj.lemma || '', strong: obj.strong || '' },
        english: words.join(' '),
      });
      if (obj.children) collectAlignments(obj.children, bookId, chapter, verse, out);
    } else if (obj.children) collectAlignments(obj.children, bookId, chapter, verse, out);
  }
}

function gatherWords(children) {
  var words = [];
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c.tag === 'w' && c.type === 'word' && c.text) words.push(c.text);
    if (c.children && c.tag !== 'zaln') words.push.apply(words, gatherWords(c.children));
  }
  return words;
}

function extractUnalignedEnglish(log) {
  var usfmJs = getUsfm();
  log('Extracting unaligned English ULT & UST...');

  var sources = [
    { dir: path.join(DATA_DIR, 'published_ult'), outDir: path.join(DATA_DIR, 'published_ult_english'), label: 'ULT' },
    { dir: path.join(DATA_DIR, 'published_ust'), outDir: path.join(DATA_DIR, 'published_ust_english'), label: 'UST' },
  ];

  var ultAlignments = new Map();

  for (var si = 0; si < sources.length; si++) {
    var src = sources[si];
    ensureDir(src.outDir);
    var files = fs.existsSync(src.dir) ? fs.readdirSync(src.dir).filter(function (f) { return f.endsWith('.usfm'); }).sort() : [];
    var count = 0;

    for (var fi = 0; fi < files.length; fi++) {
      var filename = files[fi];
      var content = fs.readFileSync(path.join(src.dir, filename), 'utf-8');
      if (content.startsWith('# Fetched:')) content = content.split('\n').slice(1).join('\n');

      try {
        var parsed = usfmJs.toJSON(content);
        var bookId = '';
        var hdrs = parsed.headers || [];
        for (var h = 0; h < hdrs.length; h++) { if (hdrs[h].tag === 'id') { bookId = hdrs[h].content.split(' ')[0]; break; } }

        fs.writeFileSync(path.join(src.outDir, filename), '# Extracted: ' + today() + '\n' + extractPlainText(parsed));

        if (src.label === 'ULT' && bookId) {
          var aligns = [];
          var chapters = Object.entries(parsed.chapters || {});
          for (var ci = 0; ci < chapters.length; ci++) {
            var vEntries = Object.entries(chapters[ci][1]);
            for (var vi = 0; vi < vEntries.length; vi++) {
              if (vEntries[vi][1].verseObjects) collectAlignments(vEntries[vi][1].verseObjects, bookId, parseInt(chapters[ci][0]), parseInt(vEntries[vi][0]), aligns);
            }
          }
          ultAlignments.set(bookId, aligns);
        }
        count++;
      } catch (err) { log('Warning: parse ' + filename + ': ' + err.message); }
    }
    log('  ' + src.label + ': ' + count + ' files');
  }
  return ultAlignments;
}

// ── Step 6: Resolve GL quotes ──────────────────────────────────────────────

function resolveGlQuotes(ultAlignments, log) {
  log('Resolving GL quotes on TNs...');
  var tnDir = path.join(DATA_DIR, 'published-tns');
  if (!fs.existsSync(tnDir)) { log('  No TN directory'); return; }

  var files = fs.readdirSync(tnDir).filter(function (f) { return f.startsWith('tn_') && f.endsWith('.tsv'); }).sort();
  var totalResolved = 0, totalEmpty = 0;

  function stripCantillation(s) { return s.replace(/[\u0591-\u05C7]/g, ''); }

  for (var fi = 0; fi < files.length; fi++) {
    var filename = files[fi];
    var bookCode = filename.replace('tn_', '').replace('.tsv', '');
    var aligns = ultAlignments.get(bookCode);
    if (!aligns) continue;

    var byVerse = new Map();
    for (var ai = 0; ai < aligns.length; ai++) {
      var a = aligns[ai];
      var key = a.chapter + ':' + a.verse;
      if (!byVerse.has(key)) byVerse.set(key, []);
      byVerse.get(key).push(a);
    }

    var filepath = path.join(tnDir, filename);
    var split = splitFetchedHeader(fs.readFileSync(filepath, 'utf-8'));
    var lines = split.lines;
    if (lines.length < 2) continue;

    // Match header names loosely: a stray BOM or trailing space in the header
    // row used to make every lookup below miss, which skipped the whole book
    // silently while index-tools (which trims) read the same file happily.
    var header = lines[0].split('\t').map(function (h) { return h.replace(/^\uFEFF/, '').trim(); });
    var qIdx = header.indexOf('Quote'), refIdx = header.indexOf('Reference');
    var occIdx = header.indexOf('Occurrence');
    if (qIdx === -1 || refIdx === -1) {
      log('  ' + filename + ': skipped (no Quote/Reference column)');
      continue;
    }

    var changed = false, fileResolved = 0;

    // Upstream en_tn is 7-column (Reference..Note) and ships no GL quote at
    // all, so this step used to skip every file -- leaving the TN keyword
    // index with nothing English to index. Add the column ourselves, then fall
    // through to the fill loop below.
    var glIdx = header.indexOf('GLQuote');
    if (glIdx === -1) {
      glIdx = header.length;
      header.push('GLQuote');
      changed = true;
    }
    lines[0] = header.join('\t');

    // Pad short rows to the header width on every run, not only when the column
    // is created. A row shorter than glIdx would otherwise be skipped by the
    // fill loop forever, leaving the file permanently ragged.
    for (var pi = 1; pi < lines.length; pi++) {
      if (!lines[pi].trim()) continue;
      var prow = lines[pi].split('\t');
      if (prow.length > glIdx) continue;
      while (prow.length <= glIdx) prow.push('');
      lines[pi] = prow.join('\t');
      changed = true;
    }

    for (var li = 1; li < lines.length; li++) {
      var fields = lines[li].split('\t');
      if (fields.length <= glIdx || (fields[glIdx] && fields[glIdx].trim())) continue;
      var hq = fields[qIdx];
      if (!hq || !hq.trim()) continue;
      var ref = fields[refIdx];
      if (!ref || ref.includes('intro')) continue;
      // Accept a verse range (e.g. '2:1-2'): the quote can sit in any verse it
      // spans, so search the whole span in order instead of only the first
      // verse. Ranges that cross a chapter boundary keep the start chapter,
      // which is what the alignment map is keyed on.
      var rm = ref.match(/(\d+):(\d+)(?:\s*[-\u2013]\s*(?:(\d+):)?(\d+))?/);
      if (!rm) continue;
      totalEmpty++;

      var chapter = parseInt(rm[1], 10);
      var verseFrom = parseInt(rm[2], 10);
      var verseTo = rm[4] !== undefined ? parseInt(rm[4], 10) : verseFrom;
      if (!(verseTo >= verseFrom)) verseTo = verseFrom;

      var vAligns = [];
      for (var vnum = verseFrom; vnum <= verseTo; vnum++) {
        var slice = byVerse.get(chapter + ':' + vnum);
        if (slice) vAligns = vAligns.concat(slice);
      }
      if (!vAligns.length) continue;

      var tokens = hq.split(/\s*\u2026\s*|\s+/).filter(Boolean);
      // A Quote cell of only ellipsis/separator characters is non-empty but
      // yields no tokens; tokens[0] would then be undefined and the matcher threw
      // a TypeError that aborted the entire curation run part-way through the
      // books, leaving some TSVs rewritten and the rest untouched.
      if (!tokens.length) continue;

      // Honor the row's Occurrence. Taking the first alignment that matches gave
      // occurrence 1's English to every repeat of a word in the same verse.
      // Anchor on the Nth match of the FIRST token, then match the remaining
      // tokens forward from there so word order is respected too.
      var occ = 1;
      if (occIdx !== -1) {
        var parsedOcc = parseInt(fields[occIdx], 10);
        if (parsedOcc > 0) occ = parsedOcc;
      }

      function alignMatches(align, token) {
        return align.source.word === token
          || stripCantillation(align.source.word) === stripCantillation(token);
      }

      var starts = [];
      for (var si = 0; si < vAligns.length; si++) {
        if (alignMatches(vAligns[si], tokens[0])) starts.push(si);
      }
      if (!starts.length) continue;
      // Clamp rather than skip: an Occurrence past what the alignment exposes
      // (the ULT may render repeats as one span) should still resolve.
      var startAt = starts[Math.min(occ, starts.length) - 1];

      // Match forward from the anchor first, then fall back to any unused
      // alignment in the verse. The forward pass is what makes Occurrence and
      // word order mean something; the fallback is required because vAligns is in
      // ULT ENGLISH order while the Quote tokens are in HEBREW order, and the two
      // routinely differ -- without it a token whose span sits before the anchor
      // was silently dropped. `used` keeps one alignment from serving two tokens.
      // The fallback may only cross back before the anchor for a token that does
      // NOT repeat an earlier token of this quote. For a repeated token, crossing
      // back would pair the requested occurrence with an unrelated earlier one:
      // with vAligns [A(first), A(second)] and an Occurrence=2 quote of 'A A', the
      // second token would resolve to A(first). Repeats therefore stay at or after
      // startAt, which is the occurrence boundary.
      var matched = [];
      var used = {};
      var cursor = startAt;
      var droppedToken = false;
      for (var ti = 0; ti < tokens.length; ti++) {
        var isRepeat = false;
        for (var pi2 = 0; pi2 < ti; pi2++) {
          if (stripCantillation(tokens[pi2]) === stripCantillation(tokens[ti])) { isRepeat = true; break; }
        }
        var floorIdx = isRepeat ? startAt : 0;
        var hitIdx = -1;
        for (var vi = cursor; vi < vAligns.length; vi++) {
          if (!used[vi] && alignMatches(vAligns[vi], tokens[ti])) { hitIdx = vi; break; }
        }
        if (hitIdx === -1) {
          for (var vj = floorIdx; vj < vAligns.length; vj++) {
            if (!used[vj] && alignMatches(vAligns[vj], tokens[ti])) { hitIdx = vj; break; }
          }
        }
        if (hitIdx === -1) { droppedToken = true; continue; }
        used[hitIdx] = true;
        if (hitIdx >= cursor) cursor = hitIdx + 1;
        if (vAligns[hitIdx].english) matched.push(vAligns[hitIdx].english);
        else droppedToken = true;
      }

      // A partial resolution is KEPT even though it understates the phrase.
      // Withholding it was tried and measured worse: on the live corpus it cut
      // resolutions from 37158 to 22001 and keywords from 6333 to 5420, and it
      // buys nothing, because this column is never shown as a quote -- both
      // buildTnIndex lookup paths print note_preview / sample_ref and only mine
      // GLQuote for keywords. Partial therefore means fewer-but-correct
      // keywords, not a misleading quote. `droppedToken` is tracked so the
      // root cause stays visible: gatherWords skips nested zaln children, so an
      // outer milestone wrapping only a nested one has english: ''.
      void droppedToken;

      if (matched.length) {
        fields[glIdx] = matched.join(' \u2026 ');
        lines[li] = fields.join('\t');
        changed = true;
        fileResolved++;
        totalResolved++;
      }
    }
    if (changed) {
      fs.writeFileSync(filepath, joinFetchedHeader(split.comment, lines));
      log('  ' + filename + ': ' + fileResolved + ' resolved');
    }
  }
  log('  Resolved ' + totalResolved + '/' + totalEmpty + ' empty GL quotes');
}

// ── Step 7: Build indexes ──────────────────────────────────────────────────

// Index building is delegated to workspace-tools/index-tools.js, which owns the
// three data/cache/*_index.json files. curate-data.js used to carry its own
// near-copies of these builders; both wrote the SAME cache paths with different
// content (differing total_notes, sample_ref with vs without a book prefix, and
// a unique_keywords count taken before the keep-if-seen-twice filter), so an
// agent's lookup result depended on which builder happened to run last.
async function buildAllIndexes(log) {
  ensureDir(CACHE_DIR);
  var idx = require('./workspace-tools/index-tools');
  log('  ' + await idx.buildStrongsIndex({ force: true }));
  log('  ' + await idx.buildUstIndex({ force: true }));
  log('  ' + await idx.buildTnIndex({ force: true }));
}


// The valid `step` values, shared by every surface that exposes curation so a
// typo is rejected rather than silently running nothing.
const CURATE_STEPS = [
  'check', 'setup', 'fetch-door43', 'fetch-google',
  'extract-english', 'resolve-quotes', 'build-indexes',
];

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run curation pipeline. Returns { success, messages, release, books, newBooks }.
 * @param {Object} opts
 * @param {string} [opts.step] - null for full run, or: check, fetch-door43, fetch-google, extract-english, resolve-quotes, build-indexes, setup
 * @param {boolean} [opts.force] - ignore cache, refetch everything
 * @param {Function} [opts.onProgress] - called with progress messages
 */
async function curatePublishedData(opts) {
  if (!opts) opts = {};
  var step = opts.step || null;
  var force = !!opts.force;
  var onProgress = opts.onProgress;

  var messages = [];
  function log(msg) {
    messages.push(msg);
    if (onProgress) onProgress(msg);
    // `quiet` is for callers that surface `messages` themselves (the CLI, whose
    // documented stdout is exactly the tool's return value). Printing here as
    // well would emit the whole run twice.
    if (!opts.quiet) console.log('[curate] ' + msg);
  }

  var manifest = readManifest();

  // Step 1: Discover
  var releaseInfo;
  try {
    releaseInfo = await discoverPublishedBooks(log);
  } catch (err) {
    log('Failed to check releases: ' + err.message);
    releaseInfo = { tag: manifest.release, books: manifest.books || [] };
  }

  // "setup" is an alias for full --force
  if (step === 'setup') { step = null; force = true; }

  if (step === 'check') {
    var prevBooks = new Set(manifest.books || []);
    var newBooks = releaseInfo.books.filter(function (b) { return !prevBooks.has(b); });
    var tagChanged = releaseInfo.tag !== manifest.release;
    log('Release: ' + (manifest.release || 'none') + ' -> ' + releaseInfo.tag + (tagChanged ? ' (CHANGED)' : ''));
    log('Books: ' + releaseInfo.books.length + ' published, ' + newBooks.length + ' new');
    if (newBooks.length) log('New: ' + newBooks.map(function (b) { return b.split('-')[1]; }).join(', '));
    return { success: true, messages: messages, release: releaseInfo.tag, books: releaseInfo.books, newBooks: newBooks };
  }

  function runStep(name) { return !step || step === name; }

  var newBooks = [];
  if (runStep('fetch-door43')) {
    newBooks = await fetchDoor43Data(releaseInfo.books, force, manifest, log);
  }

  var fetchErrors = [];
  if (runStep('fetch-google')) {
    await fetchGoogleData(force, log, fetchErrors);
    writeFetchStatus(fetchErrors);
  }

  var ultAlignments = new Map();
  if (runStep('extract-english') || runStep('resolve-quotes')) {
    ultAlignments = extractUnalignedEnglish(log);
  }

  if (runStep('resolve-quotes')) {
    resolveGlQuotes(ultAlignments, log);
  }

  if (runStep('build-indexes')) {
    await buildAllIndexes(log);
    if (newBooks.length) log('New books imported: ' + newBooks.map(function (b) { return b.split('-')[1]; }).join(', '));
  }

  writeManifest({
    release: releaseInfo.tag,
    books: releaseInfo.books,
    lastRun: today(),
    lastNewBooks: newBooks.length ? newBooks : (manifest.lastNewBooks || []),
  });

  log('Done.');
  return { success: true, messages: messages, release: releaseInfo.tag, books: releaseInfo.books, newBooks: newBooks, fetchErrors: fetchErrors };
}

// extractUnalignedEnglish and resolveGlQuotes are exported for the
// test/tn-gl-quotes.test.js unit tests; production callers go through
// curatePublishedData, which sequences them.
module.exports = {
  curatePublishedData, readFetchStatus, FETCH_STATUS_PATH, CURATE_STEPS,
  extractUnalignedEnglish, resolveGlQuotes,
};
