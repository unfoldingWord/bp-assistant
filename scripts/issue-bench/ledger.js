#!/usr/bin/env node
'use strict';
// Issue-level ledger of what editors did to AI translation notes (en_tn), plus
// a 2024-2025 human-selected reference profile. Read-only HTTP GETs to Door43.
//
//   node scripts/issue-bench/ledger.js --books JER,EZK --cache <dir> --out <dir>
//   node scripts/issue-bench/ledger.js --reference NAM,ZEP --ref-date 2025-12-31 --cache <dir> --out <dir>
//   node scripts/issue-bench/ledger.js --stats-only --cache <dir> --out <dir>
//
// stats.json / stats.md are recomputed from every ledger/reference file in
// --out at the end of every run.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const API = 'https://git.door43.org/api/v1/repos/unfoldingWord';
const DELAY_MS = 100;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[k] = true;
    else { a[k] = next; i++; }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFetch = 0;

async function http(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = DELAY_MS - (Date.now() - lastFetch);
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: '*/*' } });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} for ${url}`);
        e.fatal = true;
        throw e;
      }
      const body = await res.text();
      console.log(`[fetch] ${url.replace(API, '')} -> ${res.status} ${body.length}B`);
      return { body, headers: res.headers };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      console.warn(`[retry] ${url.replace(API, '')} attempt ${attempt + 1}: ${e.message}`);
      if (attempt < 3) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`giving up on ${url}: ${lastErr && lastErr.message}`);
}

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }

async function cached(file, fetcher) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const text = await fetcher();
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text);
  return text;
}

function mapCommit(c) {
  return {
    sha: c.sha,
    email: (c.commit.author.email || '').toLowerCase(),
    date: c.commit.author.date,
    message: c.commit.message || '',
  };
}

// All commits for a path, newest first. Uses X-HasMore, never short pages.
async function listCommits(repo, filePath, extra = '', firstPageOnly = false) {
  const out = [];
  let total = null;
  for (let page = 1; page < 200; page++) {
    const url = `${API}/${repo}/commits?path=${encodeURIComponent(filePath)}&page=${page}&stat=false&files=false&verification=false${extra}`;
    const { body, headers } = await http(url);
    out.push(...JSON.parse(body).map(mapCommit));
    total = headers.get('x-total-count');
    if (firstPageOnly || headers.get('x-hasmore') !== 'true') break;
  }
  if (!firstPageOnly && total != null && Number(total) !== out.length) {
    console.warn(`[warn] ${filePath}: X-Total-Count ${total} but collected ${out.length}`);
  }
  return out;
}

const assertSha = (sha) => { if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full sha: ${sha}`); };

function rawAt(cacheDir, book, sha) {
  assertSha(sha);
  return cached(path.join(cacheDir, book, `${sha}.tsv`), async () =>
    (await http(`${API}/en_tn/raw/tn_${book}.tsv?ref=${sha}`)).body);
}

function diffAt(cacheDir, book, sha) {
  assertSha(sha);
  return cached(path.join(cacheDir, book, `${sha}.diff`), async () =>
    (await http(`${API}/en_tn/git/commits/${sha}.diff`)).body);
}

// ---- en_ult ----

async function ultFileName(cacheDir, book) {
  const text = await cached(path.join(cacheDir, 'ULT', 'contents.json'), async () =>
    (await http(`${API}/en_ult/contents?ref=master`)).body);
  const f = JSON.parse(text).find((x) => new RegExp(`^\\d+-${book}\\.usfm$`).test(x.name));
  if (!f) throw new Error(`no en_ult file for ${book}`);
  return f.name;
}

// Newest en_ult commit (<= until when given) and its parsed verses.
async function ultVerses(cacheDir, book, until) {
  const name = await ultFileName(cacheDir, book);
  const tag = until ? `until-${until}` : 'master';
  const listText = await cached(path.join(cacheDir, 'ULT', book, `commits-${tag}.json`), async () => {
    const extra = until ? `&until=${until}T23:59:59Z` : '';
    const list = await listCommits('en_ult', name, extra, true);
    return JSON.stringify(list);
  });
  const first = JSON.parse(listText)[0];
  if (!first) throw new Error(`no en_ult commits for ${book} until ${until}`);
  const usfm = await cached(path.join(cacheDir, 'ULT', book, `${first.sha}.usfm`), async () =>
    (await http(`${API}/en_ult/raw/${name}?ref=${first.sha}`)).body);
  return { sha: first.sha, date: first.date, verses: lib.usfmToVerses(usfm) };
}

// ---- AI-era ledger ----

const rowKey = (r) => [r.ref, r.id, r.tags, r.slug, r.quote, r.occurrence, r.note].join('\t');
const chapterSig = (rows) => rows.map(rowKey).sort().join('\n');

async function buildBook(book, cacheDir, outDir) {
  const commits = await listCommits('en_tn', `tn_${book}.tsv`);
  mkdirp(path.join(cacheDir, book));
  fs.writeFileSync(path.join(cacheDir, book, 'commits.json'), JSON.stringify(commits, null, 1));
  for (const c of commits) {
    c.kind = lib.classifyCommit(c, book);
    c.chapters = c.kind === 'ai' ? lib.aiSubjectChapters(lib.subjectOf(c.message), book) : [];
  }
  const unparsed = commits.filter((c) => c.kind === 'ai' && !c.chapters.length);
  if (unparsed.length) {
    console.warn(`[warn] ${book}: ${unparsed.length} ai commits (trailer only) with no parsable chapter, ignored: ${unparsed.map((c) => lib.subjectOf(c.message)).slice(0, 5).join(' | ')}`);
  }
  const aiIdxByChapter = new Map();
  commits.forEach((c, i) => {
    for (const ch of c.chapters) {
      if (!aiIdxByChapter.has(ch)) aiIdxByChapter.set(ch, []);
      aiIdxByChapter.get(ch).push(i);
    }
  });

  const rowsCache = new Map();
  const rowsAt = async (sha) => {
    if (!rowsCache.has(sha)) rowsCache.set(sha, lib.parseTsv(await rawAt(cacheDir, book, sha)));
    return rowsCache.get(sha);
  };
  const diffCache = new Map();
  const diffChaptersAt = async (sha) => {
    if (!diffCache.has(sha)) diffCache.set(sha, lib.diffChapters(await diffAt(cacheDir, book, sha), book));
    return diffCache.get(sha);
  };

  const finalSha = commits[0].sha;
  const finalRows = await rowsAt(finalSha);
  const records = [];
  const chapters = [];

  const chapterIds = [...aiIdxByChapter.keys()].sort((a, b) => Number(a) - Number(b));
  for (const ch of chapterIds) {
    const idxs = aiIdxByChapter.get(ch);
    const aiIdx = Math.min(...idxs);
    const aiCommit = commits[aiIdx];
    const parent = commits[aiIdx + 1];
    const aiRowsAll = await rowsAt(aiCommit.sha);
    const parentRows = parent ? await rowsAt(parent.sha) : [];
    const { aiRows, pointerRowsAi, atAi } = lib.isolateAiRows(aiRowsAll, parentRows, ch);
    const finCh = lib.chapterRows(finalRows, ch);
    const { pairs, humanAdded, legacyFinal } = lib.pairRows(aiRows, finCh, atAi);

    const editCommits = [];
    for (let i = 0; i < aiIdx; i++) {
      if (commits[i].kind === 'ai') continue;
      if ((await diffChaptersAt(commits[i].sha)).has(ch)) {
        editCommits.push({ sha: commits[i].sha, date: commits[i].date, kind: commits[i].kind });
      }
    }
    const differs = chapterSig(atAi) !== chapterSig(finCh);
    const reviewed = differs || editCommits.length > 0;
    const lastEdit = editCommits.length ? editCommits[0].date : null;
    const multi = idxs.length > 1;
    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    for (const p of pairs) {
      bump(p.kind);
      records.push({
        book, chapter: Number(ch), ref: p.ai.ref, id: p.ai.id, id_final: p.fin ? p.fin.id : null,
        kind: p.kind,
        slug_ai: p.ai.slug, slug_final: p.fin ? p.fin.slug : null,
        quote_ai: p.ai.quote, quote_final: p.fin ? p.fin.quote : null,
        note_ai: p.ai.note, note_final: p.fin ? p.fin.note : null,
        occurrence_changed: p.fin ? p.ai.occurrence !== p.fin.occurrence : null,
        ai_commit: aiCommit.sha, ai_date: aiCommit.date, multi_ai: multi, reviewed, last_edit_date: lastEdit,
      });
    }
    for (const r of humanAdded) {
      bump('human-added');
      records.push({
        book, chapter: Number(ch), ref: r.ref, id: r.id, id_final: r.id, kind: 'human-added',
        slug_ai: null, slug_final: r.slug, quote_ai: null, quote_final: r.quote,
        note_ai: null, note_final: r.note, occurrence_changed: null,
        ai_commit: aiCommit.sha, ai_date: aiCommit.date, multi_ai: multi, reviewed, last_edit_date: lastEdit,
      });
    }
    const legacyBySlug = {};
    for (const r of legacyFinal) legacyBySlug[r.slug] = (legacyBySlug[r.slug] || 0) + 1;
    chapters.push({
      chapter: Number(ch), ai_commit: aiCommit.sha, ai_date: aiCommit.date, multi_ai: multi,
      no_parent: !parent,
      ai_rows: aiRows.length, pointer_rows_ai: pointerRowsAi.length,
      final_rows: finCh.filter(lib.countable).length, pointer_rows_final: finCh.filter((r) => r.pointer).length,
      legacy_rows_final: legacyFinal.length, legacy_by_slug: legacyBySlug,
      reviewed, last_edit_date: lastEdit, edit_commits: editCommits, counts_by_kind: counts,
    });
  }
  mkdirp(outDir);
  fs.writeFileSync(path.join(outDir, `ledger-${book}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, `chapters-${book}.json`), JSON.stringify(chapters, null, 1));
  const rev = chapters.filter((c) => c.reviewed).length;
  console.log(`[book] ${book}: ${commits.length} commits, ${chapters.length} AI chapters (${rev} reviewed, ${chapters.length - rev} unreviewed), ${records.length} records`);
}

// ---- reference mode ----

async function buildReference(book, refDate, cacheDir, outDir) {
  const extra = `&until=${refDate}T23:59:59Z`;
  const listText = await cached(path.join(cacheDir, book, `commits-until-${refDate}.json`), async () =>
    JSON.stringify(await listCommits('en_tn', `tn_${book}.tsv`, extra, true)));
  const first = JSON.parse(listText)[0];
  if (!first) throw new Error(`no en_tn commit for ${book} until ${refDate}`);
  const rows = lib.parseTsv(await rawAt(cacheDir, book, first.sha));
  const ult = await ultVerses(cacheDir, book, refDate);
  const countable = rows.filter(lib.countable);
  const bySlug = {};
  for (const r of countable) bySlug[r.slug] = (bySlug[r.slug] || 0) + 1;
  const verses = Object.keys(ult.verses).length;
  const slugs = {};
  for (const [s, n] of Object.entries(bySlug)) slugs[s] = { rows: n, notes_per_verse: n / verses };
  const out = {
    book, ref_date: refDate, tn_commit: first.sha, tn_date: first.date,
    ult_commit: ult.sha, ult_date: ult.date, verses,
    verse_count_source: 'en_ult verse keys at ult_commit (src/verse-counts.js needs the Hebrew USFM dir, absent here)',
    rows_total: countable.length, pointer_rows: rows.filter((r) => r.pointer).length,
    by_slug: slugs,
    passive: lib.passiveCoverage(ult.verses, rows),
  };
  fs.writeFileSync(path.join(outDir, `reference-${book}.json`), JSON.stringify(out, null, 1));
  console.log(`[reference] ${book}: tn ${first.sha.slice(0, 8)} ${first.date}, ${countable.length} rows, ${verses} verses`);
}

// ---- stats ----

const pct = (n, d) => (d ? (100 * n / d) : 0);
const f1 = (x) => x.toFixed(1);
const f3 = (x) => x.toFixed(3);
const KINDS = ['kept', 'kept-reid', 'reworded', 'rescoped', 'relabeled', 'deleted'];
const slugLabel = (s) => (s === '' || s == null ? '(none)' : s);

function table(headers, rows) {
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.map((r) => '| ' + r.join(' | ') + ' |'),
  ].join('\n');
}

function refToRow(ref, slug) {
  const m = ref.match(/^(\d+):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { chapter: m[1], verseStart: Number(m[2]), verseEnd: Number(m[3] || m[2]), slug, intro: false, pointer: false };
}

function emptyAgg() {
  const o = { ai_rows: 0, human_added: 0, relabel_targets: {} };
  for (const k of KINDS) o[k] = 0;
  return o;
}

function finishAgg(a) {
  const targets = Object.entries(a.relabel_targets).sort((x, y) => y[1] - x[1]).slice(0, 5);
  return { ...a, deleted_pct: pct(a.deleted, a.ai_rows), top_relabel_targets: targets.map(([slug, n]) => ({ slug, n })) };
}

async function computeStats(cacheDir, outDir) {
  const files = fs.readdirSync(outDir);
  const books = files.filter((f) => /^ledger-.+\.jsonl$/.test(f)).map((f) => f.slice(7, -6)).sort();
  const refBooks = files.filter((f) => /^reference-.+\.json$/.test(f)).map((f) => f.slice(10, -5)).sort();
  const stats = { generated: new Date().toISOString(), books: {}, slugs: {}, months: {}, pairs: {}, unreviewed: {}, reference: {}, comparison: [], passive: { reference: {}, ai_era: {} } };
  const pooled = {};
  const perBookSlug = {};
  const allRecs = {};
  const chaptersByBook = {};
  for (const b of books) {
    const recs = fs.readFileSync(path.join(outDir, `ledger-${b}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const chs = JSON.parse(fs.readFileSync(path.join(outDir, `chapters-${b}.json`), 'utf8'));
    chaptersByBook[b] = chs;
    allRecs[b] = recs.filter((r) => r.reviewed);
    stats.unreviewed[b] = chs.filter((c) => !c.reviewed).map((c) => c.chapter);
    const tot = emptyAgg();
    for (const r of allRecs[b]) {
      const month = r.ai_date.slice(0, 7);
      const m = stats.months[month] || (stats.months[month] = { ai_rows: 0, deleted: 0, human_added: 0 });
      const targets = [tot];
      if (r.kind === 'human-added') {
        const s = slugLabel(r.slug_final);
        for (const store of [pooled, perBookSlug[b] || (perBookSlug[b] = {})]) (store[s] || (store[s] = emptyAgg())).human_added++;
        tot.human_added++;
        m.human_added++;
        continue;
      }
      const s = slugLabel(r.slug_ai);
      for (const store of [pooled, perBookSlug[b] || (perBookSlug[b] = {})]) {
        const a = store[s] || (store[s] = emptyAgg());
        a.ai_rows++;
        a[r.kind]++;
        if (r.kind === 'relabeled') {
          const t = slugLabel(r.slug_final);
          a.relabel_targets[t] = (a.relabel_targets[t] || 0) + 1;
        }
      }
      for (const a of targets) { a.ai_rows++; a[r.kind]++; }
      m.ai_rows++;
      if (r.kind === 'deleted') m.deleted++;
      if (r.kind === 'relabeled') {
        const key = `${s} -> ${slugLabel(r.slug_final)}`;
        stats.pairs[key] = (stats.pairs[key] || 0) + 1;
      }
    }
    stats.books[b] = {
      chapters_total: chs.length, chapters_reviewed: chs.filter((c) => c.reviewed).length,
      ...finishAgg(tot), human_added_per_ai_row: tot.ai_rows ? tot.human_added / tot.ai_rows : 0,
    };
  }
  for (const m of Object.values(stats.months)) {
    m.deletion_rate = m.ai_rows ? m.deleted / m.ai_rows : 0;
    m.human_added_per_ai_row = m.ai_rows ? m.human_added / m.ai_rows : 0;
  }
  for (const [s, a] of Object.entries(pooled)) {
    stats.slugs[s] = { ...finishAgg(a), by_book: {} };
    for (const b of books) if (perBookSlug[b] && perBookSlug[b][s]) stats.slugs[s].by_book[b] = finishAgg(perBookSlug[b][s]);
  }

  // Verses of reviewed chapters (ULT master) and passive coverage, AI era.
  const ultMaster = {};
  const reviewedVerses = {};
  for (const b of books) {
    ultMaster[b] = await ultVerses(cacheDir, b, null);
    const revCh = new Set(chaptersByBook[b].filter((c) => c.reviewed).map((c) => String(c.chapter)));
    const v = {};
    for (const [k, t] of Object.entries(ultMaster[b].verses)) if (revCh.has(k.split(':')[0])) v[k] = t;
    reviewedVerses[b] = v;
    const aiRowsL = allRecs[b].filter((r) => r.kind !== 'human-added').map((r) => refToRow(r.ref, r.slug_ai)).filter(Boolean);
    const finRowsL = allRecs[b].filter((r) => r.kind !== 'deleted').map((r) => refToRow(r.ref, r.slug_final)).filter(Boolean);
    stats.passive.ai_era[b] = {
      ult_commit: ultMaster[b].sha,
      ai: lib.passiveCoverage(v, aiRowsL),
      final: lib.passiveCoverage(v, finRowsL),
    };
  }

  // Reference.
  const refTotals = { verses: 0, slugs: {} };
  for (const b of refBooks) {
    const r = JSON.parse(fs.readFileSync(path.join(outDir, `reference-${b}.json`), 'utf8'));
    stats.reference[b] = { verses: r.verses, rows_total: r.rows_total, pointer_rows: r.pointer_rows, tn_commit: r.tn_commit, tn_date: r.tn_date };
    stats.passive.reference[b] = r.passive;
    refTotals.verses += r.verses;
    for (const [s, v] of Object.entries(r.by_slug)) refTotals.slugs[slugLabel(s)] = (refTotals.slugs[slugLabel(s)] || 0) + v.rows;
  }

  // 3-column comparison over JER+EZK+ISA reviewed chapters.
  const cmpBooks = books.filter((b) => ['JER', 'EZK', 'ISA'].includes(b));
  let cmpVerses = 0;
  const bCnt = {}, cCnt = {}, c2Cnt = {};
  for (const b of cmpBooks) {
    cmpVerses += Object.keys(reviewedVerses[b]).length;
    for (const r of allRecs[b]) {
      if (r.kind !== 'human-added') bCnt[slugLabel(r.slug_ai)] = (bCnt[slugLabel(r.slug_ai)] || 0) + 1;
      if (r.kind !== 'deleted') cCnt[slugLabel(r.slug_final)] = (cCnt[slugLabel(r.slug_final)] || 0) + 1;
    }
    for (const c of chaptersByBook[b].filter((c) => c.reviewed)) {
      for (const [s, n] of Object.entries(c.legacy_by_slug || {})) c2Cnt[slugLabel(s)] = (c2Cnt[slugLabel(s)] || 0) + n;
    }
  }
  for (const s of Object.keys(cCnt)) c2Cnt[s] = (c2Cnt[s] || 0) + cCnt[s];
  const allSlugs = new Set([...Object.keys(refTotals.slugs), ...Object.keys(bCnt), ...Object.keys(cCnt), ...Object.keys(c2Cnt)]);
  stats.comparison = [...allSlugs].map((s) => ({
    slug: s,
    ref_rows: refTotals.slugs[s] || 0, ref_per_verse: refTotals.verses ? (refTotals.slugs[s] || 0) / refTotals.verses : null,
    ai_rows: bCnt[s] || 0, ai_per_verse: cmpVerses ? (bCnt[s] || 0) / cmpVerses : null,
    final_rows: cCnt[s] || 0, final_per_verse: cmpVerses ? (cCnt[s] || 0) / cmpVerses : null,
    final_incl_legacy_rows: c2Cnt[s] || 0, final_incl_legacy_per_verse: cmpVerses ? (c2Cnt[s] || 0) / cmpVerses : null,
  })).sort((x, y) => y.ai_rows - x.ai_rows);
  stats.comparison_basis = { reference_verses: refTotals.verses, ai_era_books: cmpBooks, ai_era_verses: cmpVerses };

  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 1));
  fs.writeFileSync(path.join(outDir, 'stats.md'), renderMd(stats, books, chaptersByBook));
  console.log(`[stats] wrote stats.json and stats.md for ledger books: ${books.join(',')}; reference: ${refBooks.join(',')}`);
}

function renderMd(stats, books, chaptersByBook) {
  const L = [];
  L.push('# Issue bench stats', '', `Generated ${stats.generated}. Only reviewed chapters are counted; unreviewed chapters are listed separately.`, '');
  const slugEntries = Object.entries(stats.slugs);
  const eligible = slugEntries.filter(([, a]) => a.ai_rows >= 10);
  const delRow = ([s, a]) => [s, a.ai_rows, a.deleted, f1(a.deleted_pct) + '%'];
  L.push('## Top 15 deleted slugs by count (min 10 AI rows)', '');
  L.push(table(['slug', 'ai_rows', 'deleted', 'deleted_pct'], [...eligible].sort((x, y) => y[1].deleted - x[1].deleted).slice(0, 15).map(delRow)), '');
  L.push('## Top 15 deleted slugs by rate (min 10 AI rows)', '');
  L.push(table(['slug', 'ai_rows', 'deleted', 'deleted_pct'], [...eligible].sort((x, y) => y[1].deleted_pct - x[1].deleted_pct).slice(0, 15).map(delRow)), '');
  L.push('## Top 15 human-added slugs', '');
  L.push(table(['slug', 'human_added', 'ai_rows (same slug)'], slugEntries.filter(([, a]) => a.human_added).sort((x, y) => y[1].human_added - x[1].human_added).slice(0, 15).map(([s, a]) => [s, a.human_added, a.ai_rows])), '');
  L.push('## Top 15 relabel pairs (from -> to)', '');
  L.push(table(['from -> to', 'count'], Object.entries(stats.pairs).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, n]) => [k, n])), '');

  L.push('## Per-book totals', '');
  L.push(table(['book', 'chapters', 'reviewed', 'ai_rows', ...KINDS, 'deleted_pct', 'human_added', 'human_added/ai_row'],
    Object.entries(stats.books).map(([b, a]) => [b, a.chapters_total, a.chapters_reviewed, a.ai_rows, ...KINDS.map((k) => a[k]), f1(a.deleted_pct) + '%', a.human_added, f3(a.human_added_per_ai_row)])), '');
  L.push('## Per-month totals (by AI commit date)', '');
  L.push(table(['month', 'ai_rows', 'deleted', 'deletion_rate', 'human_added', 'human_added/ai_row'],
    Object.entries(stats.months).sort().map(([m, a]) => [m, a.ai_rows, a.deleted, f1(100 * a.deletion_rate) + '%', a.human_added, f3(a.human_added_per_ai_row)])), '');

  L.push('## Per-slug detail (pooled, then per book)', '');
  const detail = (a) => [a.ai_rows, a.kept, a['kept-reid'], a.reworded, a.rescoped, a.relabeled, a.deleted, f1(a.deleted_pct) + '%', a.top_relabel_targets.map((t) => `${t.slug}:${t.n}`).join(', '), a.human_added];
  const dh = ['slug', 'scope', 'ai_rows', 'kept', 'kept-reid', 'reworded', 'rescoped', 'relabeled', 'deleted', 'deleted_pct', 'top-5 relabel targets', 'human_added'];
  const drows = [];
  for (const [s, a] of [...slugEntries].sort((x, y) => y[1].ai_rows - x[1].ai_rows)) {
    drows.push([s, 'pooled', ...detail(a)]);
    for (const [b, ba] of Object.entries(a.by_book)) drows.push([s, b, ...detail(ba)]);
  }
  L.push(table(dh, drows), '');

  L.push('## Comparison: notes per verse by slug (top 25 by AI rows)', '');
  const cb = stats.comparison_basis;
  L.push(`(a) reference: 2024-2025 prophets pooled (${cb.reference_verses} verses). (b) AI rows, reviewed chapters of ${cb.ai_era_books.join('+')} (${cb.ai_era_verses} verses). (c) editor-final rows of the same chapters, excluding legacy rows kept from before the AI commit. (c+legacy) same including legacy rows.`, '');
  const pv = (x) => (x == null ? '-' : f3(x));
  L.push(table(['slug', '(a) ref rows', '(a) per verse', '(b) AI rows', '(b) per verse', '(c) final rows', '(c) per verse', '(c+legacy) rows', '(c+legacy) per verse'],
    stats.comparison.slice(0, 25).map((c) => [c.slug, c.ref_rows, pv(c.ref_per_verse), c.ai_rows, pv(c.ai_per_verse), c.final_rows, pv(c.final_per_verse), c.final_incl_legacy_rows, pv(c.final_incl_legacy_per_verse)])), '');

  L.push('## Passive coverage (figs-activepassive)', '');
  L.push('Passives detected with an approximate regex (be + optional adverb + past participle); verses with a figs-activepassive note count a row covering any verse in its range.', '');
  const prow = (label, p) => [label, p.verses, p.passive_verses, p.passive_verses_with_note, f1(pct(p.passive_verses_with_note, p.passive_verses)) + '%', p.passive_matches, p.ap_rows];
  const ph = ['set', 'verses', 'verses with passive', 'of those with AP note', '%', 'passive matches', 'figs-activepassive rows'];
  const prs = [];
  for (const [b, p] of Object.entries(stats.passive.reference)) prs.push(prow(`reference ${b}`, p));
  for (const [b, p] of Object.entries(stats.passive.ai_era)) {
    prs.push(prow(`AI-era ${b} AI rows`, p.ai));
    prs.push(prow(`AI-era ${b} editor-final`, p.final));
  }
  L.push(table(ph, prs), '');

  L.push('## Unreviewed chapters (excluded from all stats above)', '');
  L.push(table(['book', 'ai chapters', 'unreviewed count', 'unreviewed chapters'],
    books.map((b) => [b, chaptersByBook[b].length, stats.unreviewed[b].length, stats.unreviewed[b].join(', ') || '-'])), '');
  return L.join('\n') + '\n';
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cache || !args.out) throw new Error('--cache <dir> and --out <dir> are required');
  mkdirp(args.cache);
  mkdirp(args.out);
  const list = (v) => String(v).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (args.books) for (const b of list(args.books)) await buildBook(b, args.cache, args.out);
  if (args.reference) {
    if (!args['ref-date']) throw new Error('--ref-date required with --reference');
    for (const b of list(args.reference)) await buildReference(b, args['ref-date'], args.cache, args.out);
  }
  await computeStats(args.cache, args.out);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
