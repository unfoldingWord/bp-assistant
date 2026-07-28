// overnight-watcher.js — the Overnight Sensor's detection core.
//
// Detects human edits merged overnight into the `-be-` branches of ULT/UST/TN
// on Door43 (self-hosted Gitea), attributes them to editors, and emits an
// attributed, read-only proposal feed that the Dreamer consumes
// (output/overnight-review/<date>/proposals.jsonl). It does NOT write the
// preference store — it only surfaces signal.
//
// Detection is robust to overnight branch deletion:
//   1. PRIMARY — closed+merged PRs whose head ref matches `<BOOK>-be-<editor>`.
//      The PR record persists after the branch is deleted and still carries the
//      book + editor + base/head shas + a files/diff endpoint.
//   2. SECONDARY — live `-be-` branches for in-flight, not-yet-merged work.
//
// Idempotent (keyed by PR id + headSha) and cold-start-safe via
// overnight-review-state.js. HTTP is injectable for tests.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { apiGet, GITEA_API } = require('./repo-verify');
const {
  extractChapter, normalizeWhitespace, stripAlignmentMarkers, fetchText, BOOK_NUMBERS, DOOR43_BASE,
} = require('./check-ult-edits');
const { prepareCompareTn } = require('./workspace-tools/tsv-tools');
const state = require('./overnight-review-state');
const { readSecret } = require('./secrets');

const ORG = 'unfoldingWord';
const WATCHED = [
  { repo: 'en_ult', resource: 'ult' },
  { repo: 'en_ust', resource: 'ust' },
  { repo: 'en_tn', resource: 'tn' },
];

// --- pure helpers ------------------------------------------------------------
// `<BOOK>-be-<editor>` → { book, editor }. Book may carry a numeric prefix
// (1KI, 2SA, …). Returns null for refs that aren't `-be-` branches.
function parseBeRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const m = ref.match(/^(.+?)-be-(.+)$/);
  if (!m) return null;
  const book = m[1].toUpperCase();
  if (!BOOK_NUMBERS[book]) return null;
  return { book, editor: m[2] };
}

function isBotAuthor(login) {
  const l = String(login || '').toLowerCase();
  if (!l) return true; // unknown author → treat as non-editor, skip
  return /\bbot\b|\[bot\]|github-actions|deferredreward-bot|-bot$/.test(l);
}

function resourceForRepo(repo) {
  const w = WATCHED.find((x) => x.repo === repo);
  return w ? w.resource : null;
}

function tnFileForBook(book) { return `tn_${book.toUpperCase()}.tsv`; }
function usfmFileForBook(book) {
  const num = BOOK_NUMBERS[book.toUpperCase()];
  return num ? `${num}-${book.toUpperCase()}.usfm` : null;
}

// List chapters whose stripped, whitespace-normalized text differs between two
// USFM versions (reuses the post-edit-review primitives).
function changedChaptersFromUsfm(oldUsfm, newUsfm) {
  const chapters = new Set();
  const re = /\\c\s+(\d+)/g;
  let m;
  while ((m = re.exec(newUsfm)) !== null) chapters.add(parseInt(m[1], 10));
  const changed = [];
  for (const ch of [...chapters].sort((a, b) => a - b)) {
    const o = extractChapter(oldUsfm, ch);
    const n = extractChapter(newUsfm, ch);
    if (!n) continue;
    if (o == null) { changed.push(ch); continue; }
    if (normalizeWhitespace(stripAlignmentMarkers(o)) !== normalizeWhitespace(stripAlignmentMarkers(n))) {
      changed.push(ch);
    }
  }
  return changed;
}

// Map a prepareCompareTn result to proposal-feed rows (the shape the Dreamer's
// select-dream-candidates gatherProposalsFeed reads).
function tnChangesToProposals(compare, { repo, book, editor, prId, headSha }) {
  return (compare.changes || []).map((c) => {
    const [chapter, verse] = String(c.reference).split(':');
    return {
      source: 'overnight-review',
      kind: 'tn-edit',
      resource: 'tn',
      repo, book, editor,
      prId: prId || null,
      headSha: headSha || null,
      reference: c.reference,
      supportReference: c.supportReference || null,
      key: c.supportReference || c.reference,
      category: c.changeType,
      chapter: chapter || null,
      verse: verse || null,
      before: c.before,
      after: c.after,
      text: `editor ${editor} ${c.changeType} TN note at ${c.reference}`
        + (c.supportReference ? ` (${c.supportReference})` : ''),
    };
  });
}

function usfmChangesToProposals(changedChapters, { repo, resource, book, editor, prId, headSha }) {
  return changedChapters.map((ch) => ({
    source: 'overnight-review',
    kind: `${resource}-edit`,
    resource,
    repo, book, editor,
    prId: prId || null,
    headSha: headSha || null,
    category: 'chapter-edited',
    chapter: String(ch),
    verse: null,
    key: `${book}-${ch}`,
    before: null, after: null,
    text: `editor ${editor} edited ${resource.toUpperCase()} ${book} ${ch} — run editor-compare`,
  }));
}

// --- raw fetch (injectable) --------------------------------------------------
function rawUrl(repo, ref, filePath) {
  // ref is e.g. "commit/<sha>" or "branch/master"; DOOR43_BASE already ends in /unfoldingWord
  return `${DOOR43_BASE.replace(/\/unfoldingWord$/, '')}/${ORG}/${repo}/raw/${ref}/${filePath}`;
}

// --- editor attribution ------------------------------------------------------
function loadEditorMap() {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../door43-users.json'), 'utf8');
    const obj = JSON.parse(raw);
    const byUser = {};
    for (const [email, user] of Object.entries(obj)) {
      byUser[String(user).toLowerCase()] = user;
      byUser[String(email).toLowerCase()] = user;
    }
    return byUser;
  } catch { return {}; }
}

// Strict: only resolves KNOWN editors (used to gate the merged+deleted fallback
// so we never review arbitrary merged PRs by unknown authors).
function attributeKnownEditor(editorMap, value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return editorMap[key] || null;
}

// Map a changed filename to a book code for the resource (tn_<BOOK>.tsv / NN-<BOOK>.usfm).
function bookFromFilename(name, resource) {
  const base = String(name || '').split('/').pop();
  if (resource === 'tn') {
    const m = base.match(/^tn_([A-Za-z0-9]{3})\.tsv$/);
    return m ? m[1].toUpperCase() : null;
  }
  const m = base.match(/^\d{2}-([A-Za-z0-9]{3})\.usfm$/);
  return m ? m[1].toUpperCase() : null;
}

// Changed files of a PR — reliable even after the source branch is deleted
// (Gitea strips head.ref but the files endpoint still resolves). Mirrors
// door43-push.checkConflictingBranches.
async function fetchPrFiles(get, repo, prNumber, token) {
  const res = await get(`/repos/${ORG}/${repo}/pulls/${prNumber}/files?limit=100`, token);
  if (!res || res.status !== 200 || !Array.isArray(res.data)) return [];
  return res.data.map((f) => f && f.filename).filter(Boolean);
}

// --- enumeration -------------------------------------------------------------
async function enumerateUnits({ apiGetImpl, token, sinceIso, editorMap = {} }) {
  const get = apiGetImpl || apiGet;
  const units = [];
  for (const { repo, resource } of WATCHED) {
    // PRIMARY: merged PRs. Identify -be- editor edits two ways:
    //   (a) head.ref still present -> parse <BOOK>-be-<editor> directly.
    //   (b) head.ref stripped (Gitea drops it once the branch is deleted — see
    //       repo-verify.js) -> derive BOOK from the PR's changed files and
    //       attribute to the PR author, but ONLY when the author is a known editor.
    let page = 1;
    let keepPaging = true;
    while (keepPaging && page <= 10) {
      const res = await get(`/repos/${ORG}/${repo}/pulls?state=closed&sort=recentupdate&limit=50&page=${page}`, token);
      // Status guard: a 401/403/5xx must NOT be mistaken for "no PRs" — that
      // would let runOvernightReview advance lastRun and permanently skip this
      // interval. Abort the whole run so state is left untouched and retried.
      if (!res || res.status !== 200) {
        throw new Error(`Gitea pulls query failed for ${repo}: status=${res && res.status}`);
      }
      const list = Array.isArray(res.data) ? res.data : [];
      if (list.length === 0) break;
      for (const pr of list) {
        if (!pr || !pr.merged) continue;
        const mergedAt = pr.merged_at || pr.updated_at;
        if (sinceIso && mergedAt && mergedAt < sinceIso) { keepPaging = false; continue; }
        const author = (pr.user && pr.user.login) || null;
        const be = parseBeRef(pr.head && pr.head.ref);
        let book = be && be.book;
        let editor = be && be.editor;
        if (!book) {
          // Fallback path (deleted branch): require a known editor + a touched resource file.
          const known = attributeKnownEditor(editorMap, author);
          if (!known || isBotAuthor(author)) continue;
          const files = await fetchPrFiles(get, repo, pr.number, token);
          book = files.map((f) => bookFromFilename(f, resource)).find(Boolean);
          if (!book) continue; // PR didn't touch this resource's file
          editor = known;
        }
        units.push({
          kind: 'merged-pr', repo, resource, book, editor: editor || author,
          prId: pr.number,
          baseSha: pr.base && pr.base.sha,
          headSha: (pr.head && pr.head.sha) || pr.merge_commit_sha,
          mergedAt,
          author,
        });
      }
      // recentupdate desc — once we pass the cutoff we can stop.
      if (sinceIso && list.some((pr) => (pr.merged_at || pr.updated_at || '') < sinceIso)) keepPaging = false;
      page += 1;
    }
    // SECONDARY: live -be- branches (in-flight work). Best-effort — a non-200
    // here is non-fatal (the branch list is the secondary signal).
    const bres = await get(`/repos/${ORG}/${repo}/branches?limit=100`, token);
    if (bres && bres.status === 200 && Array.isArray(bres.data)) {
      for (const b of bres.data) {
        const be = parseBeRef(b && b.name);
        if (!be) continue;
        units.push({
          kind: 'live-branch', repo, resource, book: be.book, editor: be.editor,
          branch: b.name,
          tipSha: b.commit && b.commit.id,
          author: (b.commit && b.commit.author && b.commit.author.username) || be.editor,
        });
      }
    }
  }
  return units;
}

function unitKeyFor(u) {
  return u.kind === 'merged-pr'
    ? state.prUnitKey(u.repo, u.prId, u.headSha)
    : state.branchUnitKey(u.repo, u.branch, u.tipSha);
}

// Fetch that tolerates a genuinely-absent file (HTTP 404 -> '') but RE-THROWS
// any other failure (network/timeout/5xx). This is what lets the caller tell
// "fetched, no edits" (safe to mark reviewed) apart from "transient failure"
// (must NOT mark reviewed, so the unit is retried next run).
async function fetchAllowMissing(fetch, url) {
  try {
    return await fetch(url);
  } catch (err) {
    if (/HTTP 404\b/.test(String((err && err.message) || ''))) return '';
    throw err;
  }
}

// Review one new unit → array of proposal rows. THROWS on transient fetch
// failure so the orchestrator does not mark the unit reviewed.
async function reviewUnit(u, { fetchTextImpl }) {
  const fetch = fetchTextImpl || fetchText;
  const oldRef = u.kind === 'merged-pr' ? `commit/${u.baseSha}` : 'branch/master';
  const newRef = u.kind === 'merged-pr' ? `commit/${u.headSha}` : `branch/${u.branch}`;
  const headSha = u.kind === 'merged-pr' ? u.headSha : u.tipSha;
  if (u.resource === 'tn') {
    const file = tnFileForBook(u.book);
    const [oldTsv, newTsv] = await Promise.all([
      fetchAllowMissing(fetch, rawUrl(u.repo, oldRef, file)),
      fetchAllowMissing(fetch, rawUrl(u.repo, newRef, file)),
    ]);
    const compare = prepareCompareTn({ oldTsv, newTsv, book: u.book });
    return tnChangesToProposals(compare, { repo: u.repo, book: u.book, editor: u.editor, prId: u.prId, headSha });
  }
  const file = usfmFileForBook(u.book);
  if (!file) return [];
  const [oldUsfm, newUsfm] = await Promise.all([
    fetchAllowMissing(fetch, rawUrl(u.repo, oldRef, file)),
    fetchAllowMissing(fetch, rawUrl(u.repo, newRef, file)),
  ]);
  const changed = changedChaptersFromUsfm(oldUsfm, newUsfm);
  return usfmChangesToProposals(changed, { repo: u.repo, resource: u.resource, book: u.book, editor: u.editor, prId: u.prId, headSha });
}

// --- orchestration -----------------------------------------------------------
function dateStamp(now) { return now.toISOString().slice(0, 10); }

async function runOvernightReview({
  skillsRepo,
  token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN') || '',
  now = new Date(),
  dryRun = false,
  deps = {},
} = {}) {
  const log = deps.log || ((m) => process.stderr.write(`${m}\n`));
  const writeImpl = deps.writeFileSync || fs.writeFileSync;
  const mkdir = deps.mkdirSync || ((p) => fs.mkdirSync(p, { recursive: true }));
  const stateFile = path.join(skillsRepo, state.DEFAULT_STATE_REL);

  // #OVERNIGHT-STATE: probe for a pre-existing state file BEFORE loadState
  // swallows the distinction — this lets a cold start be logged as either a
  // genuine first-ever run (no file at all) or an anomalous one (a file was
  // there but came back uninitialized/corrupt), so a persistence regression
  // can't hide behind an innocuous "cold start" line the way this one did for
  // 34 consecutive nightly runs.
  let stateFileExisted = true;
  try { (deps.readFileSync || fs.readFileSync)(stateFile, 'utf8'); } catch { stateFileExisted = false; }

  const st = state.loadState(stateFile, deps.readFileSync);
  const editorMap = deps.editorMap || loadEditorMap();
  // If enumeration throws (e.g. a Gitea auth/5xx error), it propagates here and
  // aborts the run BEFORE any state write — lastRun is not advanced, so the
  // interval is retried rather than silently skipped.
  const units = await enumerateUnits({ apiGetImpl: deps.apiGetImpl, token, sinceIso: st.lastRun, editorMap });
  const allKeys = units.map(unitKeyFor);

  if (state.isColdStart(st)) {
    state.primeColdStart(st, allKeys, now);
    // #OVERNIGHT-STATE: persist regardless of dryRun. Priming records "these
    // HEADs are already seen" — that's memory, not an action (dry-run's job is
    // to skip taking actions like opening PRs, not to skip remembering). The
    // previous `if (!dryRun)` guard here meant a dry-run cold start was never
    // saved, so every dry run looked like the very first run, forever.
    state.saveState(stateFile, st, { writeImpl, mkdirImpl: mkdir });
    const anomaly = stateFileExisted ? ' [WARNING: a state file existed but was not initialized — check for a persistence bug]' : '';
    log(`[overnight] cold start (${stateFileExisted ? 'not a genuine first run' : 'genuine first run'})${anomaly} — recorded ${allKeys.length} current HEAD(s); reviewing nothing tonight.${dryRun ? ' (dry-run: state persisted, proposal feed still suppressed)' : ''}`);
    return {
      coldStart: true, dryRun, genuineFirstRun: !stateFileExisted,
      units: units.length, reviewed: 0, proposals: 0, proposalsPath: null,
    };
  }

  const fresh = units.filter((u) => !state.isReviewed(st, unitKeyFor(u)) && !isBotAuthor(u.author));
  const proposals = [];
  const reviewTasks = [];
  let failed = 0;
  for (const u of fresh) {
    let rows;
    try {
      rows = await reviewUnit(u, { fetchTextImpl: deps.fetchTextImpl });
    } catch (err) {
      // Transient fetch/compare failure — do NOT mark reviewed; retry next run.
      failed += 1;
      log(`[overnight] review failed for ${unitKeyFor(u)} (${(err && err.message) || err}) — not marking reviewed; will retry.`);
      continue;
    }
    proposals.push(...rows);
    reviewTasks.push({
      repo: u.repo, resource: u.resource, book: u.book, editor: u.editor,
      kind: u.kind, prId: u.prId || null, branch: u.branch || null,
      changes: rows.length,
      chapters: [...new Set(rows.map((r) => r.chapter).filter(Boolean))],
    });
    state.markReviewed(st, unitKeyFor(u), now);
  }

  // Write under data/ (tracked) — NOT output/ (runtime, ephemeral on the wake
  // machine). The feed must persist (committed alongside state.json) so the
  // next Dreamer wake can read it after a fresh clone.
  const outDir = path.join(skillsRepo, 'data/overnight-review', dateStamp(now));
  let proposalsPath = null;
  let tasksPath = null;
  if (!dryRun) {
    // The proposal/review-task feed is the "action" side of a run — it's what
    // downstream automation (the Dreamer, and anything OVERNIGHT_PR_ENABLED
    // eventually gates) reads to act on. dry-run suppresses it.
    mkdir(outDir);
    proposalsPath = path.join(outDir, 'proposals.jsonl');
    writeImpl(proposalsPath, proposals.map((p) => JSON.stringify(p)).join('\n') + (proposals.length ? '\n' : ''));
    tasksPath = path.join(outDir, 'review-tasks.jsonl');
    writeImpl(tasksPath, reviewTasks.map((t) => JSON.stringify(t)).join('\n') + (reviewTasks.length ? '\n' : ''));
  }
  // #OVERNIGHT-STATE: persist the reviewed-set and lastRun watermark
  // UNCONDITIONALLY — including on a dry run. Marking a unit reviewed and
  // advancing lastRun is bookkeeping ("what have I already looked at"), not an
  // action ("open a PR"); dry-run must only suppress the latter. Gating this
  // behind `!dryRun` (as it was) meant every dry run started back at the same
  // watermark, so a dry-run-only Sensor could never make forward progress —
  // this is the root cause of 34 consecutive no-op nightly runs.
  // Only advance the lastRun watermark on a clean run — otherwise a deferred
  // unit would fall outside the next window and never be retried.
  if (failed === 0) st.lastRun = now.toISOString();
  state.saveState(stateFile, st, { writeImpl, mkdirImpl: mkdir });

  const reviewed = fresh.length - failed;
  log(`[overnight] ${dryRun ? 'would review' : 'reviewed'} ${reviewed} unit(s)${failed ? ` (${failed} deferred on transient failure)` : ''} → ${proposals.length} proposal row(s), ${reviewTasks.length} review task(s).`);
  return {
    coldStart: false, dryRun, units: units.length, reviewed, failed,
    proposals: proposals.length, proposalsPath, tasksPath, reviewTasks,
    sampleProposals: proposals.slice(0, 12),
  };
}

// --- CLI ---------------------------------------------------------------------
// node src/overnight-watcher.js --skills-repo <dir> [--dry-run]
// Prints a digest between OVERNIGHT_DIGEST markers for the cron wrapper.
function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skills-repo') out.skillsRepo = argv[++i];
  }
  return out;
}

async function cliMain(argv) {
  const args = parseArgs(argv);
  const skillsRepo = args.skillsRepo || process.env.BP_SKILLS_REPO;
  if (!skillsRepo) { process.stderr.write('[overnight] BP_SKILLS_REPO not set\n'); process.exit(2); }
  const res = await runOvernightReview({ skillsRepo, dryRun: args.dryRun });
  const lines = [];
  if (res.coldStart) {
    const label = res.genuineFirstRun ? 'genuine first run' : 'NOT a genuine first run — state existed but was uninitialized, check for a persistence bug';
    lines.push(`Cold start (${label}) — recorded current HEADs; reviewed nothing this run${res.dryRun ? ' (dry-run)' : ''}.`);
  } else {
    lines.push(`Reviewed ${res.reviewed} new \`-be-\` unit(s) across ${res.units} watched → ${res.proposals} attributed proposal row(s)${res.dryRun ? ' (dry-run: watermark advanced, proposal feed not written)' : ''}.`);
    for (const t of res.reviewTasks || []) {
      lines.push(`- ${t.repo} ${t.book} (${t.resource}) by ${t.editor}: ${t.changes} change(s)${t.chapters.length ? ` [ch ${t.chapters.join(',')}]` : ''}`);
    }
  }
  process.stdout.write('OVERNIGHT_DIGEST_BEGIN\n' + lines.join('\n') + '\nOVERNIGHT_DIGEST_END\n');
  if (res.proposalsPath) process.stdout.write(`OVERNIGHT_PROPOSALS_PATH: ${res.proposalsPath}\n`);
}

if (require.main === module) {
  cliMain(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[overnight] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  ORG,
  WATCHED,
  parseBeRef,
  isBotAuthor,
  resourceForRepo,
  tnFileForBook,
  usfmFileForBook,
  changedChaptersFromUsfm,
  tnChangesToProposals,
  usfmChangesToProposals,
  rawUrl,
  enumerateUnits,
  unitKeyFor,
  reviewUnit,
  runOvernightReview,
};
