// tw-headwords.js — refresh data/en_tw and data/tw_headwords.json from Door43.
//
// check_tw_headwords (workspace-tools/issue-tools.js) and the tW names gate both
// read data/tw_headwords.json, and the issue-identification skill reads articles
// from data/en_tw/<category>/<article>.md. Both used to be a hand-copied bundle
// (MIGRATION.md) with no refresh job, so a tW article or headword added upstream
// after the copy was invisible to them (#456). curate-data.js calls this as its
// `fetch-tw` step, which the weekly refresh runs.
//
// The whole en_tw master branch comes down as one tarball. It is unpacked and
// indexed in a scratch directory, sanity-checked, and only then swapped into
// place, so a failed download, a truncated archive or an upstream layout change
// leaves the previous en_tw and tw_headwords.json untouched.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TW_ARCHIVE_URL = 'https://git.door43.org/unfoldingWord/en_tw/archive/master.tar.gz';
const CATEGORIES = ['kt', 'names', 'other'];
const FETCHED_MARKER = '.fetched';
// Refuse a rebuild that loses more than this share of the current entries. Upstream
// rarely deletes articles; a large drop means a bad archive, not an editorial change.
const MIN_KEEP_RATIO = 0.9;
// en_tw master is a few MB of markdown. These caps refuse a runaway download or a
// decompression bomb before it can exhaust the bot's memory.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;
// Scratch names carry a per-call sequence as well as the PID, so a full refresh
// and an operator fetch-tw that overlap in one process never share a path.
let scratchSeq = 0;

// ── tar ────────────────────────────────────────────────────────────────────

function readString(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end === -1 || end > start + len ? start + len : end);
}

function parsePaxPath(body) {
  // Records are "<len> <key>=<value>\n".
  let pos = 0;
  while (pos < body.length) {
    const sp = body.indexOf(0x20, pos);
    if (sp === -1) break;
    const len = parseInt(body.toString('utf8', pos, sp), 10);
    if (!(len > 0)) break;
    const rec = body.toString('utf8', sp + 1, pos + len - 1);
    if (rec.startsWith('path=')) return rec.slice(5);
    pos += len;
  }
  return null;
}

/**
 * Minimal ustar/pax/GNU reader: returns regular files as {name, data}.
 * Door43 (Gitea) serves `git archive` output, which is ustar plus a pax global
 * header. Long names via pax `x` or GNU `L` records are honored.
 */
function parseTar(buf) {
  const files = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(readString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    let name = readString(header, 0, 100);
    if (prefix) name = prefix + '/' + name;
    const bodyStart = offset + 512;
    const body = buf.subarray(bodyStart, bodyStart + size);
    if (body.length < size) throw new Error('truncated tar archive');
    offset = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'x') { longName = parsePaxPath(body) || longName; continue; }
    if (type === 'L') { longName = readString(body, 0, body.length); continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') files.push({ name, data: Buffer.from(body) });
  }
  return files;
}

// ── headwords ──────────────────────────────────────────────────────────────

/**
 * Headwords come from the article's "# " title line, comma-separated:
 * "# horn, horned, shofar" -> ["horn", "horned", "shofar"]. A disambiguated title
 * such as "Saul (OT)" or "James (son of Zebedee)" also yields its bare form
 * ("Saul", "James"), since that is what a quote contains.
 */
function headwordsFromTitle(title) {
  const out = [];
  const add = (h) => { if (h && !out.includes(h)) out.push(h); };
  for (const part of String(title || '').split(',')) {
    const hw = part.trim();
    add(hw);
    const bare = hw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (bare !== hw) add(bare);
  }
  return out;
}

function articleTitle(text) {
  const first = String(text).replace(/^﻿/, '').split('\n').find((l) => l.trim());
  const m = first && first.match(/^#\s+(.+?)\s*$/);
  return m ? m[1] : null;
}

/**
 * Pick bible/<category>/<article>.md files out of the archive listing.
 * @returns {Array<{category, twarticle, text}>}
 */
function extractArticles(files) {
  const articles = [];
  for (const f of files) {
    const m = f.name.match(/(?:^|\/)bible\/(kt|names|other)\/([^/]+)\.md$/);
    if (!m) continue;
    articles.push({ category: m[1], twarticle: m[2], text: f.data.toString('utf8') });
  }
  return articles;
}

function buildHeadwords(articles) {
  return articles
    .map((a) => ({
      twarticle: a.twarticle,
      file: `${a.category}/${a.twarticle}.md`,
      category: a.category,
      headwords: headwordsFromTitle(articleTitle(a.text)),
    }))
    .filter((e) => e.headwords.length)
    .sort((a, b) => (a.category === b.category
      ? a.twarticle.localeCompare(b.twarticle)
      : CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)));
}

function countExisting(hwPath) {
  try {
    const data = JSON.parse(fs.readFileSync(hwPath, 'utf8'));
    return Array.isArray(data) ? data.length : 0;
  } catch (_) { return 0; }
}

function validate(entries, previousCount) {
  for (const c of CATEGORIES) {
    if (!entries.some((e) => e.category === c)) throw new Error(`no ${c} articles in en_tw archive`);
  }
  if (previousCount && entries.length < Math.floor(previousCount * MIN_KEEP_RATIO)) {
    throw new Error(`en_tw archive has ${entries.length} articles, current index has ${previousCount}; keeping current`);
  }
}

function lastFetched(twDir) {
  try { return fs.readFileSync(path.join(twDir, FETCHED_MARKER), 'utf8').trim() || null; } catch (_) { return null; }
}

/**
 * Download en_tw master, rewrite data/en_tw/<category>/*.md and
 * data/tw_headwords.json. Never leaves a half-written tree: on any error the
 * previous files are kept and the error is rethrown for the caller to record.
 *
 * @param {object} opts
 * @param {string} opts.dataDir          workspace data/ directory
 * @param {(url: string) => Promise<Buffer>} opts.fetchBuffer
 * @param {boolean} [opts.force]          ignore the weekly freshness check
 * @param {(date: string|null) => boolean} [opts.isStale]  freshness predicate
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.maxArchiveBytes] download size cap (tests lower it)
 * @param {number} [opts.maxTarBytes]     unpacked size cap (tests lower it)
 * @returns {Promise<{skipped?: boolean, entries?: number, previous?: number}>}
 */
async function refreshTranslationWords(opts) {
  const { dataDir, fetchBuffer } = opts;
  const log = opts.log || (() => {});
  const twDir = path.join(dataDir, 'en_tw');
  const hwPath = path.join(dataDir, 'tw_headwords.json');

  if (!opts.force && fs.existsSync(hwPath) && opts.isStale && !opts.isStale(lastFetched(twDir))) {
    return { skipped: true };
  }

  log('Fetching Translation Words (en_tw master)...');
  const maxArchive = opts.maxArchiveBytes || MAX_ARCHIVE_BYTES;
  const maxTar = opts.maxTarBytes || MAX_TAR_BYTES;
  const gz = await fetchBuffer(TW_ARCHIVE_URL);
  if (gz.length > maxArchive) {
    throw new Error(`en_tw archive is ${gz.length} bytes, over the ${maxArchive}-byte cap`);
  }
  let archive;
  try {
    archive = zlib.gunzipSync(gz, { maxOutputLength: maxTar });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`en_tw archive unpacks to more than ${maxTar} bytes`);
    }
    throw err;
  }
  const articles = extractArticles(parseTar(archive));
  const entries = buildHeadwords(articles);
  const previous = countExisting(hwPath);
  validate(entries, previous);

  const stamp = new Date().toISOString().slice(0, 10);
  const tag = `${process.pid}-${++scratchSeq}`;
  const tmpDir = path.join(dataDir, `.en_tw.tmp-${tag}`);
  const oldDir = path.join(dataDir, `.en_tw.old-${tag}`);
  const tmpHw = `${hwPath}.tmp-${tag}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    for (const c of CATEGORIES) fs.mkdirSync(path.join(tmpDir, c), { recursive: true });
    for (const a of articles) fs.writeFileSync(path.join(tmpDir, a.category, a.twarticle + '.md'), a.text);
    fs.writeFileSync(tmpHw, JSON.stringify(entries, null, 2) + '\n');

    fs.rmSync(oldDir, { recursive: true, force: true });
    const hadOld = fs.existsSync(twDir);
    if (hadOld) fs.renameSync(twDir, oldDir);
    try {
      fs.renameSync(tmpDir, twDir);
      fs.renameSync(tmpHw, hwPath);
    } catch (err) {
      // Put the previous articles back so they stay paired with the previous index.
      if (!fs.existsSync(tmpDir)) fs.rmSync(twDir, { recursive: true, force: true });
      if (hadOld) fs.renameSync(oldDir, twDir);
      throw err;
    }
    // The freshness marker goes in last. A crash anywhere before this line leaves
    // en_tw without a marker, so the next weekly run refetches instead of trusting
    // a tree whose index may be the old one.
    fs.writeFileSync(path.join(twDir, FETCHED_MARKER), stamp + '\n');
    fs.rmSync(oldDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHw, { force: true });
  }

  const byCat = CATEGORIES.map((c) => `${c} ${entries.filter((e) => e.category === c).length}`).join(', ');
  log(`  en_tw: ${articles.length} articles; tw_headwords.json: ${entries.length} entries (${byCat})` +
    (previous ? `, was ${previous}` : ''));
  return { entries: entries.length, previous };
}

module.exports = {
  refreshTranslationWords, parseTar, extractArticles, buildHeadwords, headwordsFromTitle,
  TW_ARCHIVE_URL, FETCHED_MARKER,
};
