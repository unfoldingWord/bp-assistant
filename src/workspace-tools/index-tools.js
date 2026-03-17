// index-tools.js — Node.js ports of index building scripts
//
// Replaces: build_strongs_index.py, build_tn_index.py, build_ust_index.py

const fs = require('fs');
const path = require('path');
const https = require('https');

const CSKILLBP_DIR = process.env.CSKILLBP_DIR || '/srv/bot/workspace';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function normalizeStrong(raw) {
  let s = raw.replace(/^(?:[a-z]:)+/, '');
  return /^[HG]\d/.test(s) ? s : null;
}

function parseAlignedUsfm(content) {
  const alignments = [];
  let book = '', chapter = 0, verse = 0;
  const stack = [];
  const idMatch = content.match(/\\id\s+(\S+)/);
  if (idMatch) book = idMatch[1].substring(0, 3);
  const COMBINED_RE = /\\zaln-s\s+\|([^\\]*?)\\?\*|\\zaln-e\\?\*|\\w\s+([^|]*?)\|[^\\]*?\\w\*/g;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^\\c\s+(\d+)/);
    if (cm) { chapter = parseInt(cm[1], 10); verse = 0; continue; }
    const vm = trimmed.match(/^\\v\s+(\d+)/);
    if (vm) { verse = parseInt(vm[1], 10); continue; }
    let m;
    COMBINED_RE.lastIndex = 0;
    while ((m = COMBINED_RE.exec(trimmed)) !== null) {
      if (m[1] !== undefined) {
        const attrs = m[1];
        const strongM = attrs.match(/x-strong="([^"]*)"/);
        const lemmaM = attrs.match(/x-lemma="([^"]*)"/);
        const contentM = attrs.match(/x-content="([^"]*)"/);
        stack.push({ strong: strongM ? strongM[1] : '', lemma: lemmaM ? lemmaM[1] : '', content: contentM ? contentM[1] : '', ref: `${book} ${chapter}:${verse}` });
      } else if (m[0].startsWith('\\zaln-e')) {
        stack.pop();
      } else if (m[2] !== undefined) {
        const word = m[2].trim();
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          alignments.push({ word, ...top });
        }
      }
    }
  }
  return alignments;
}

function buildAlignmentIndex(sourceDir, cacheFile, label) {
  const today = todayStr();
  if (!fs.existsSync(sourceDir)) return `Source directory not found: ${sourceDir}`;
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.usfm'));
  if (!files.length) return 'No USFM files found';

  const index = {};
  let totalAlignments = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    const alignments = parseAlignedUsfm(content);
    for (const a of alignments) {
      const strong = normalizeStrong(a.strong);
      if (!strong) continue;
      totalAlignments++;
      if (!index[strong]) index[strong] = { lemma: a.lemma || '', total: 0, renderings: {} };
      const entry = index[strong];
      entry.total++;
      if (!entry.lemma && a.lemma) entry.lemma = a.lemma;
      const word = a.word.toLowerCase();
      if (!entry.renderings[word]) entry.renderings[word] = { text: a.word, count: 0, refs: [] };
      const r = entry.renderings[word];
      r.count++;
      if (r.refs.length < 5) r.refs.push(a.ref);
    }
  }

  const output = { _meta: { built: today, source_dir: path.relative(CSKILLBP_DIR, sourceDir) + '/', file_count: files.length, total_alignments: totalAlignments, unique_strongs: Object.keys(index).length } };
  for (const [strong, entry] of Object.entries(index)) {
    output[strong] = { lemma: entry.lemma, total: entry.total, renderings: Object.values(entry.renderings).sort((a, b) => b.count - a.count) };
  }

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(output));
  return `Built ${label} index: ${Object.keys(index).length} entries, ${totalAlignments} alignments from ${files.length} files`;
}

function doLookup(idx, strong) {
  const s = strong.toUpperCase();
  const entry = idx[s];
  if (entry) {
    const lines = [`${s} — ${entry.lemma} (${entry.total} occurrences)`];
    for (const r of entry.renderings.slice(0, 10)) {
      const pct = ((r.count / entry.total) * 100).toFixed(1);
      lines.push(`  "${r.text}" — ${r.count} (${pct}%) e.g. ${r.refs.slice(0, 3).join(', ')}`);
    }
    return lines.join('\n');
  }
  const base = s.replace(/[A-F]+$/, '');
  const matches = Object.keys(idx).filter(k => k !== '_meta' && k.startsWith(base));
  if (matches.length) return `No exact match for ${s}. Similar: ${matches.slice(0, 5).join(', ')}`;
  return `No match found for ${s}`;
}

async function buildStrongsIndex({ force, lookup, stats }) {
  const sourceDir = path.join(CSKILLBP_DIR, 'data/published_ult');
  const cacheFile = path.join(CSKILLBP_DIR, 'data/cache/strongs_index.json');
  const today = todayStr();

  if ((lookup || stats) && fs.existsSync(cacheFile)) {
    const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (stats) { const m = idx._meta; return `Built: ${m.built}\nFiles: ${m.file_count}\nAlignments: ${m.total_alignments}\nStrong's: ${m.unique_strongs}`; }
    return doLookup(idx, lookup);
  }

  if (!force && fs.existsSync(cacheFile)) {
    try {
      const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (idx._meta && idx._meta.built === today) return `Strong's index is current (built ${today}, ${idx._meta.unique_strongs} entries)`;
    } catch { /* rebuild */ }
  }

  return buildAlignmentIndex(sourceDir, cacheFile, "Strong's");
}

async function buildTnIndex({ force, lookup, issue, stats }) {
  const sourceDir = path.join(CSKILLBP_DIR, 'data/published-tns');
  const cacheFile = path.join(CSKILLBP_DIR, 'data/cache/tn_index.json');
  const today = todayStr();

  if ((lookup || issue || stats) && fs.existsSync(cacheFile)) {
    const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (stats) { const m = idx._meta; return `Built: ${m.built}\nFiles: ${m.file_count}\nNotes: ${m.total_notes}\nIssues: ${m.unique_issues}\nKeywords: ${m.unique_keywords}`; }
    if (issue) {
      const entry = idx.by_issue[issue];
      if (!entry) return `Issue type "${issue}" not found`;
      return [`${issue}: ${entry.count} across ${entry.books.length} books`, ...entry.samples.slice(0, 5).map(s => `  ${s.ref}: ${s.note_preview}`)].join('\n');
    }
    if (lookup) {
      const entries = idx.by_keyword[lookup.toLowerCase()];
      if (!entries) return `Keyword "${lookup}" not found`;
      return entries.map(e => `${e.issue}: ${e.count} (e.g. ${e.sample_ref})`).join('\n');
    }
  }

  if (!force && fs.existsSync(cacheFile)) {
    try {
      const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (idx._meta && idx._meta.built === today) return `TN index is current (built ${today})`;
    } catch { /* rebuild */ }
  }

  if (!fs.existsSync(sourceDir)) return `Source directory not found: ${sourceDir}`;
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.tsv'));
  if (!files.length) return 'No TSV files found';

  const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'were', 'are', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'not', 'no', 'if', 'than', 'that', 'this', 'these', 'those', 'he', 'she', 'they', 'we', 'you', 'his', 'her', 'its', 'our', 'your', 'their']);

  const byIssue = {};
  const byKeyword = {};
  let totalNotes = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    const lines = content.split('\n');
    const firstLine = lines[0] ? lines[0].toLowerCase() : '';
    const isFormatA = firstLine.includes('book');
    const startIdx = (firstLine.includes('reference') || firstLine.includes('book')) ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split('\t');
      totalNotes++;

      let sref, glQuote, note;
      if (isFormatA && cols.length >= 9) { sref = cols[4]; glQuote = cols[7]; note = cols[8]; }
      else if (cols.length >= 7) { sref = cols[3]; glQuote = cols[4]; note = cols[6]; }
      else continue;

      const issueMatch = sref ? sref.match(/translate\/(.+)$/) : null;
      const issueType = issueMatch ? issueMatch[1] : '';
      if (!issueType) continue;

      const bookCode = file.replace(/^tn_/, '').replace('.tsv', '');
      const ref = cols[0];

      if (!byIssue[issueType]) byIssue[issueType] = { count: 0, books: new Set(), samples: [] };
      byIssue[issueType].count++;
      byIssue[issueType].books.add(bookCode);
      if (byIssue[issueType].samples.length < 5) {
        let preview = (note || '').replace(/\\n/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[rc:\/\/[^\]]*\]\]/g, '');
        byIssue[issueType].samples.push({ ref, quote: glQuote || '', note_preview: preview.slice(0, 120) });
      }

      if (glQuote) {
        const words = glQuote.match(/[a-zA-Z']+/g) || [];
        for (const w of words) {
          const kw = w.toLowerCase();
          if (kw.length < 3 || STOP_WORDS.has(kw)) continue;
          if (!byKeyword[kw]) byKeyword[kw] = {};
          if (!byKeyword[kw][issueType]) byKeyword[kw][issueType] = { count: 0, sample_ref: ref };
          byKeyword[kw][issueType].count++;
        }
      }
    }
  }

  const issueOutput = {};
  for (const [k, v] of Object.entries(byIssue)) issueOutput[k] = { count: v.count, books: [...v.books], samples: v.samples };
  const keywordOutput = {};
  for (const [kw, issues] of Object.entries(byKeyword)) {
    const total = Object.values(issues).reduce((s, v) => s + v.count, 0);
    if (total < 2) continue;
    keywordOutput[kw] = Object.entries(issues).map(([iss, v]) => ({ issue: iss, count: v.count, sample_ref: v.sample_ref })).sort((a, b) => b.count - a.count).slice(0, 10);
  }

  const output = { _meta: { built: today, source_dir: 'data/published-tns/', file_count: files.length, total_notes: totalNotes, unique_issues: Object.keys(issueOutput).length, unique_keywords: Object.keys(keywordOutput).length }, by_issue: issueOutput, by_keyword: keywordOutput };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(output));
  return `Built TN index: ${totalNotes} notes, ${Object.keys(issueOutput).length} issues, ${Object.keys(keywordOutput).length} keywords from ${files.length} files`;
}

async function buildUstIndex({ force, lookup, stats }) {
  const sourceDir = path.join(CSKILLBP_DIR, 'data/published_ust');
  const cacheFile = path.join(CSKILLBP_DIR, 'data/cache/ust_index.json');
  const today = todayStr();

  if ((lookup || stats) && fs.existsSync(cacheFile)) {
    const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (stats) { const m = idx._meta; return `Built: ${m.built}\nFiles: ${m.file_count}\nAlignments: ${m.total_alignments}\nStrong's: ${m.unique_strongs}`; }
    return doLookup(idx, lookup);
  }
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const idx = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (idx._meta && idx._meta.built === today) return `UST index is current (built ${today})`;
    } catch { /* rebuild */ }
  }
  if (!fs.existsSync(sourceDir)) return `Source not found: ${sourceDir}. Run fetch_ust first.`;
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.usfm'));
  if (files.length < 5) return `Only ${files.length} UST files. Run fetch_ust first.`;
  return buildAlignmentIndex(sourceDir, cacheFile, 'UST');
}

module.exports = { buildStrongsIndex, buildTnIndex, buildUstIndex };
