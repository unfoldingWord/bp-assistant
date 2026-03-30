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
  templates: { sheetId: '1ot6A7RxcsxM_Wv94sauoTAaRPO5Q-gynFqMHeldnM64', gid: 0 },
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
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && res.headers.location) {
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

async function fetchGoogleData(force, log) {
  log('Fetching Google Sheets/Docs...');
  var glossaryDir = path.join(DATA_DIR, 'glossary');
  ensureDir(glossaryDir);

  var tabEntries = Object.entries(GOOGLE.glossary.tabs);
  for (var gi = 0; gi < tabEntries.length; gi++) {
    var name = tabEntries[gi][0], gid = tabEntries[gi][1];
    var dest = path.join(glossaryDir, name + '.csv');
    if (!force && fs.existsSync(dest) && !shouldRefreshWeekly(getCachedDate(dest))) continue;
    try {
      var url = 'https://docs.google.com/spreadsheets/d/' + GOOGLE.glossary.sheetId + '/export?format=csv&gid=' + gid;
      fs.writeFileSync(dest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(url)));
      log('  ' + name + '.csv');
    } catch (err) { log('Warning: ' + name + '.csv: ' + err.message); }
  }

  var templatesDest = path.join(DATA_DIR, 'templates.csv');
  if (force || !fs.existsSync(templatesDest) || shouldRefreshWeekly(getCachedDate(templatesDest))) {
    try {
      var tUrl = 'https://docs.google.com/spreadsheets/d/' + GOOGLE.templates.sheetId + '/export?format=csv&gid=' + GOOGLE.templates.gid;
      fs.writeFileSync(templatesDest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(tUrl)));
      log('  templates.csv');
    } catch (err) { log('Warning: templates.csv: ' + err.message); }
  }

  var issuesDest = path.join(DATA_DIR, 'issues_resolved.txt');
  if (force || !fs.existsSync(issuesDest) || shouldRefreshWeekly(getCachedDate(issuesDest))) {
    try {
      var iUrl = 'https://docs.google.com/document/d/' + GOOGLE.issuesResolved.docId + '/export?format=txt';
      fs.writeFileSync(issuesDest, '# Fetched: ' + today() + '\n' + stripBom(await httpFetch(iUrl)));
      log('  issues_resolved.txt');
    } catch (err) { log('Warning: issues_resolved.txt: ' + err.message); }
  }
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
    var lines = fs.readFileSync(filepath, 'utf-8').split('\n');
    if (lines.length < 2) continue;

    var header = lines[0].split('\t');
    var glIdx = header.indexOf('GLQuote'), qIdx = header.indexOf('Quote'), refIdx = header.indexOf('Reference');
    if (glIdx === -1 || qIdx === -1 || refIdx === -1) continue;

    var changed = false, fileResolved = 0;
    for (var li = 1; li < lines.length; li++) {
      var fields = lines[li].split('\t');
      if (fields.length <= glIdx || (fields[glIdx] && fields[glIdx].trim())) continue;
      var hq = fields[qIdx];
      if (!hq || !hq.trim()) continue;
      var ref = fields[refIdx];
      if (!ref || ref.includes('intro')) continue;
      var rm = ref.match(/(\d+):(\d+)/);
      if (!rm) continue;
      totalEmpty++;

      var vAligns = byVerse.get(parseInt(rm[1]) + ':' + parseInt(rm[2]));
      if (!vAligns) continue;

      var tokens = hq.split(/\s*\u2026\s*|\s+/).filter(Boolean);
      var matched = [];
      for (var ti = 0; ti < tokens.length; ti++) {
        var tok = tokens[ti];
        var stripped = stripCantillation(tok);
        var hit = null;
        for (var vi = 0; vi < vAligns.length; vi++) {
          if (vAligns[vi].source.word === tok || stripCantillation(vAligns[vi].source.word) === stripped) {
            hit = vAligns[vi]; break;
          }
        }
        if (hit && hit.english) matched.push(hit.english);
      }
      if (matched.length) {
        fields[glIdx] = matched.join(' ... ');
        lines[li] = fields.join('\t');
        changed = true;
        fileResolved++;
        totalResolved++;
      }
    }
    if (changed) {
      fs.writeFileSync(filepath, lines.join('\n'));
      log('  ' + filename + ': ' + fileResolved + ' resolved');
    }
  }
  log('  Resolved ' + totalResolved + '/' + totalEmpty + ' empty GL quotes');
}

// ── Step 7: Build indexes ──────────────────────────────────────────────────

function normalizeStrong(raw) {
  var result = raw.replace(/^(?:[a-z]:)+/, '');
  return /^[HG]\d/.test(result) ? result : null;
}

function buildStrongsIndex(sourceDir, label, releaseTag, log) {
  log('Building ' + label + " Strong's index...");
  if (!fs.existsSync(sourceDir)) { log('  Source not found'); return null; }
  var files = fs.readdirSync(sourceDir).filter(function (f) { return f.endsWith('.usfm'); }).sort();
  if (!files.length) { log('  No USFM files'); return null; }

  var agg = new Map();
  var totalAlignments = 0;
  var markerRe = /\\zaln-s\s+\|([^\\]*?)\\\*|\\zaln-e\\\*|\\w\s+([^|]*?)\|[^\\]*?\\w\*/g;

  for (var fi = 0; fi < files.length; fi++) {
    var content = fs.readFileSync(path.join(sourceDir, files[fi]), 'utf-8');
    if (content.startsWith('# Fetched:')) content = content.split('\n').slice(1).join('\n');

    var lines = content.split('\n');
    var bookId = '', chapter = 0, verse = 0;
    var stack = [];

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var m;
      if ((m = line.match(/\\id\s+(\w+)/))) bookId = m[1];
      if ((m = line.match(/\\c\s+(\d+)/))) chapter = parseInt(m[1]);
      if ((m = line.match(/\\v\s+(\d+)/))) verse = parseInt(m[1]);

      markerRe.lastIndex = 0;
      var match;
      while ((match = markerRe.exec(line)) !== null) {
        if (match[0].startsWith('\\zaln-s')) {
          var attrStr = match[1];
          var attrs = {};
          var am;
          if ((am = attrStr.match(/x-strong="([^"]+)"/))) attrs.strong = am[1];
          if ((am = attrStr.match(/x-content="([^"]+)"/))) attrs.content = am[1];
          if ((am = attrStr.match(/x-lemma="([^"]+)"/))) attrs.lemma = am[1];
          stack.push({ attrs: attrs, words: [] });
        } else if (match[0].startsWith('\\zaln-e')) {
          if (stack.length) {
            var closed = stack.pop();
            var english = closed.words.join(' ');
            if (stack.length) Array.prototype.push.apply(stack[stack.length - 1].words, closed.words);
            var sn = closed.attrs.strong ? normalizeStrong(closed.attrs.strong) : null;
            if (sn && english) {
              totalAlignments++;
              if (!agg.has(sn)) agg.set(sn, { lemma: '', content: '', renderings: new Map() });
              var entry = agg.get(sn);
              if (!entry.lemma && closed.attrs.lemma) entry.lemma = closed.attrs.lemma;
              if (!entry.content && closed.attrs.content) entry.content = closed.attrs.content;
              if (!entry.renderings.has(english)) entry.renderings.set(english, { count: 0, refs: [] });
              var r = entry.renderings.get(english);
              r.count++;
              if (r.refs.length < MAX_SAMPLE_REFS) r.refs.push(bookId + ' ' + chapter + ':' + verse);
            }
          }
        } else if (match[2] !== undefined) {
          var word = match[2].trim();
          if (word && stack.length) stack[stack.length - 1].words.push(word);
        }
      }
    }
  }

  var index = {
    _meta: { built: today(), source_dir: sourceDir.replace(WORKSPACE + '/', ''), file_count: files.length, total_alignments: totalAlignments, unique_strongs: agg.size, release: releaseTag || 'unknown' },
  };
  var sorted = Array.from(agg.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); });
  for (var si = 0; si < sorted.length; si++) {
    var strong = sorted[si][0], data = sorted[si][1];
    var renderings = Array.from(data.renderings.entries()).map(function (e) { return { text: e[0], count: e[1].count, refs: e[1].refs }; }).sort(function (a, b) { return b.count - a.count; });
    index[strong] = { lemma: data.lemma, total: renderings.reduce(function (s, r) { return s + r.count; }, 0), renderings: renderings };
  }

  log('  ' + label + ': ' + files.length + ' files, ' + totalAlignments + ' alignments, ' + agg.size + " Strong's");
  return index;
}

function buildTnIndex(log) {
  log('Building TN index...');
  var sourceDir = path.join(DATA_DIR, 'published-tns');
  if (!fs.existsSync(sourceDir)) { log('  Source not found'); return null; }
  var files = fs.readdirSync(sourceDir).filter(function (f) { return f.startsWith('tn_') && f.endsWith('.tsv'); }).sort();
  if (!files.length) { log('  No TN files'); return null; }

  var issueAgg = new Map();
  var keywordAgg = new Map();
  var totalNotes = 0;

  for (var fi = 0; fi < files.length; fi++) {
    var filename = files[fi];
    var bookCode = filename.replace('tn_', '').replace('.tsv', '');
    var lines = fs.readFileSync(path.join(sourceDir, filename), 'utf-8').split('\n');
    if (lines.length < 2) continue;

    var headerFields = lines[0].split('\t');
    var fm = {};
    headerFields.forEach(function (h, i) { fm[h] = i; });

    for (var li = 1; li < lines.length; li++) {
      var row = lines[li].split('\t');
      if (row.length < 4) continue;

      var book, refStr, supportRef, glQuote, note;
      if (fm.Book !== undefined) {
        book = row[fm.Book] || bookCode;
        refStr = (row[fm.Chapter] || '') + ':' + (row[fm.Verse] || '');
        supportRef = row[fm.SupportReference] || '';
        glQuote = fm.GLQuote !== undefined ? (row[fm.GLQuote] || '') : '';
        note = row[fm.OccurrenceNote !== undefined ? fm.OccurrenceNote : fm.Note] || '';
      } else {
        book = bookCode;
        refStr = row[fm.Reference !== undefined ? fm.Reference : 0] || '';
        supportRef = row[fm.SupportReference !== undefined ? fm.SupportReference : 3] || '';
        glQuote = fm.GLQuote !== undefined ? (row[fm.GLQuote] || '') : '';
        note = fm.Note !== undefined ? (row[fm.Note] || '') : '';
      }

      if (refStr.includes('intro')) continue;
      var im = supportRef.match(/translate\/(.+)$/);
      var issueType = im ? im[1] : null;
      if (!issueType && /^(figs-|grammar-|writing-|translate-)/.test(supportRef)) issueType = supportRef;
      if (!issueType) continue;

      totalNotes++;
      var fullRef = book + ' ' + refStr;

      if (!issueAgg.has(issueType)) issueAgg.set(issueType, { count: 0, books: new Set(), samples: [] });
      var ie = issueAgg.get(issueType);
      ie.count++;
      ie.books.add(book);
      if (ie.samples.length < MAX_SAMPLES) {
        var np = (note || '').replace(/\\n/g, ' ').trim().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[rc:\/\/[^\]]*\]\]/g, '').slice(0, 120).trim();
        ie.samples.push({ ref: fullRef, quote: glQuote.slice(0, 80), note_preview: np });
      }

      var words = (glQuote || '').toLowerCase().match(/[a-z']+/g) || [];
      for (var wi = 0; wi < words.length; wi++) {
        var w = words[wi];
        if (STOP_WORDS.has(w) || w.length < MIN_KEYWORD_LEN) continue;
        if (!keywordAgg.has(w)) keywordAgg.set(w, new Map());
        var kwIssues = keywordAgg.get(w);
        if (!kwIssues.has(issueType)) kwIssues.set(issueType, { count: 0, sample_ref: '' });
        var ke = kwIssues.get(issueType);
        ke.count++;
        if (!ke.sample_ref) ke.sample_ref = fullRef;
      }
    }
  }

  var index = {
    _meta: { built: today(), source_dir: 'data/published-tns/', file_count: files.length, total_notes: totalNotes, unique_issues: issueAgg.size, unique_keywords: keywordAgg.size },
    by_issue: {},
    by_keyword: {},
  };

  var sortedIssues = Array.from(issueAgg.entries()).sort(function (a, b) { return b[1].count - a[1].count; });
  for (var ii = 0; ii < sortedIssues.length; ii++) {
    var issue = sortedIssues[ii][0], idata = sortedIssues[ii][1];
    index.by_issue[issue] = { count: idata.count, books: Array.from(idata.books).sort(), samples: idata.samples };
  }
  var kwKeys = Array.from(keywordAgg.keys()).sort();
  for (var ki = 0; ki < kwKeys.length; ki++) {
    var kw = kwKeys[ki];
    var issues = keywordAgg.get(kw);
    var top = Array.from(issues.entries()).sort(function (a, b) { return b[1].count - a[1].count; }).slice(0, MAX_KEYWORD_ISSUES);
    var total = top.reduce(function (s, e) { return s + e[1].count; }, 0);
    if (total < 2) continue;
    index.by_keyword[kw] = top.map(function (e) { return { issue: e[0], count: e[1].count, sample_ref: e[1].sample_ref }; });
  }

  log('  ' + files.length + ' files, ' + totalNotes + ' notes, ' + issueAgg.size + ' issues');
  return index;
}

function buildAllIndexes(releaseTag, log) {
  ensureDir(CACHE_DIR);

  var ultIdx = buildStrongsIndex(path.join(DATA_DIR, 'published_ult'), 'ULT', releaseTag, log);
  if (ultIdx) fs.writeFileSync(path.join(CACHE_DIR, 'strongs_index.json'), JSON.stringify(ultIdx));

  var ustIdx = buildStrongsIndex(path.join(DATA_DIR, 'published_ust'), 'UST', releaseTag, log);
  if (ustIdx) fs.writeFileSync(path.join(CACHE_DIR, 'ust_index.json'), JSON.stringify(ustIdx));

  var tnIdx = buildTnIndex(log);
  if (tnIdx) fs.writeFileSync(path.join(CACHE_DIR, 'tn_index.json'), JSON.stringify(tnIdx));
}

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
    console.log('[curate] ' + msg);
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

  if (runStep('fetch-google')) {
    await fetchGoogleData(force, log);
  }

  var ultAlignments = new Map();
  if (runStep('extract-english') || runStep('resolve-quotes')) {
    ultAlignments = extractUnalignedEnglish(log);
  }

  if (runStep('resolve-quotes')) {
    resolveGlQuotes(ultAlignments, log);
  }

  if (runStep('build-indexes')) {
    buildAllIndexes(releaseInfo.tag, log);
    if (newBooks.length) log('New books imported: ' + newBooks.map(function (b) { return b.split('-')[1]; }).join(', '));
  }

  writeManifest({
    release: releaseInfo.tag,
    books: releaseInfo.books,
    lastRun: today(),
    lastNewBooks: newBooks.length ? newBooks : (manifest.lastNewBooks || []),
  });

  log('Done.');
  return { success: true, messages: messages, release: releaseInfo.tag, books: releaseInfo.books, newBooks: newBooks };
}

module.exports = { curatePublishedData };
