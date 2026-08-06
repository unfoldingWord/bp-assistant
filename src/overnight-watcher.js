// overnight-watcher.js — the Overnight Sensor's detection core.
//
// Detects human edits merged overnight into the `-be-` branches of ULT/UST/TN
// on Door43 (self-hosted Gitea), attributes them to editors, and emits an
// attributed, read-only proposal feed that the Dreamer consumes
// (data/overnight-review/<date>/proposals.jsonl — matches the `outDir` below and
// the Dreamer's own read path; this comment said `output/` until 2026-07-28 and
// the mismatch briefly read as a real broken-feed bug). It does NOT write the
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
//
// Cold start (see #OVERNIGHT-COLDSTART-VISIBILITY at the cold-start branch in
// runOvernightReview) defaults to priming every enumerated unit as
// already-seen and reviewing none of them — this is correct on a genuine
// first-ever run, but it is a silent no-op for any backlog that accumulated
// before the Sensor could persist state. `--review-cold-start` /
// `OVERNIGHT_REVIEW_COLD_START=true` opt into reviewing the enumerated units
// on a cold start instead of priming past them; default is OFF.
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

// #OVERNIGHT-FEED: what `dryRun` means in THIS module, decided here so the next
// reader doesn't reintroduce a `!dryRun` guard around persistence. This module
// takes no actions of its own (no PR creation, no door43-push call — see the
// #OVERNIGHT-FEED comment below the feed write). Both the state file and the
// proposal/review-task feed are files for other systems to read, not actions,
// so `dryRun` no longer gates either write. Its only remaining job is LOG /
// DIGEST WORDING (the `[overnight] reviewed vs would-review` line and the CLI
// digest text) plus being echoed through in the returned result object, so a
// caller (e.g. the cron wrapper in bp-assistant-auto-issue-handler, gated on
// OVERNIGHT_PR_ENABLED) can tell which invocation mode produced a given feed.
// If a real action is ever added to this module, `dryRun` should gate THAT —
// not the persistence of state.json or the proposal feed.
async function runOvernightReview({
  skillsRepo,
  token = readSecret('door43_token', 'DOOR43_TOKEN') || readSecret('gitea_token', 'GITEA_TOKEN') || '',
  now = new Date(),
  dryRun = false,
  // #OVERNIGHT-COLDSTART-VISIBILITY: opt-in escape hatch for the situation this
  // module cannot tell apart from a genuine first-ever run — see the long
  // comment below, at the cold-start branch, for why this defaults to false.
  reviewColdStart = false,
  deps = {},
} = {}) {
  const log = deps.log || ((m) => process.stderr.write(`${m}\n`));
  const writeImpl = deps.writeFileSync || fs.writeFileSync;
  const mkdir = deps.mkdirSync || ((p) => fs.mkdirSync(p, { recursive: true }));

  // #OVERNIGHT-STATE-LOCATION (issue #305): state.json lives on the volume,
  // outside the skills checkout, and at the SAME path in both run modes — see
  // the long comment at the top of overnight-review-state.js for why letting
  // dry-run write an untracked file at a path PR mode later commits would jam
  // every hourly sync. The proposal feed below still goes into `skillsRepo`
  // (that IS the reviewable artifact PR mode commits); only the watermark moves.
  const { stateFile, legacyStateFile } = state.resolveStateFile({ skillsRepo, env: deps.env || process.env });
  state.migrateLegacyStateFile(stateFile, legacyStateFile, {
    readImpl: deps.readFileSync || fs.readFileSync,
    writeImpl,
    mkdirImpl: mkdir,
    unlinkImpl: deps.unlinkSync || fs.unlinkSync,
    log,
  });

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

  if (state.isColdStart(st) && !reviewColdStart) {
    state.primeColdStart(st, allKeys, now);
    // #OVERNIGHT-STATE: persist regardless of dryRun. Priming records "these
    // HEADs are already seen" — that's memory, not an action (dry-run's job is
    // to skip taking actions like opening PRs, not to skip remembering). The
    // previous `if (!dryRun)` guard here meant a dry-run cold start was never
    // saved, so every dry run looked like the very first run, forever.
    state.saveState(stateFile, st, { writeImpl, mkdirImpl: mkdir });
    const anomaly = stateFileExisted ? ' [WARNING: a state file existed but was not initialized — check for a persistence bug]' : '';
    // #OVERNIGHT-COLDSTART-VISIBILITY: priming is correct, pre-existing,
    // intentional design — it stops the Sensor from trying to review all of
    // history the very first time it ever runs. What was NOT correct is that
    // it did this SILENTLY: every unit primed here is discarded work — no
    // proposal is ever produced for it, and the reviewed watermark advances
    // past it, so it can never be picked up on a later run either. That is
    // invisible unless someone reads this log line closely, and it is exactly
    // what will happen to this Sensor's own accumulated backlog: after ~34
    // nights of dry-run-only operation, state.json was never saved (see
    // a9b8bea two commits back), so THE FIRST RUN AFTER THIS BRANCH DEPLOYS
    // WILL COLD-START — and every merged edit from those 34 nights will be
    // silently primed away unless OVERNIGHT_REVIEW_COLD_START (or
    // --review-cold-start) is set for that run. Log the count AND enough
    // identifying detail to act on, and surface both in the digest (see
    // cliMain below) — not buried in a log stream nobody tails.
    const sample = allKeys.slice(0, 20);
    const skippedDetail = sample.length < allKeys.length
      ? `${sample.join(', ')}, … (+${allKeys.length - sample.length} more)`
      : sample.join(', ');
    log(`[overnight] COLD START (${stateFileExisted ? 'not a genuine first run' : 'genuine first run'})${anomaly} — SKIPPING ${allKeys.length} unit(s) as already-seen; NO proposals will be produced for them: ${skippedDetail || '(none)'}. To review these instead of skipping them, set OVERNIGHT_REVIEW_COLD_START=true (or pass --review-cold-start) and re-run.${dryRun ? ' (dry-run)' : ''}`);
    return {
      coldStart: true, dryRun, genuineFirstRun: !stateFileExisted,
      units: units.length, reviewed: 0, proposals: 0, proposalsPath: null,
      skipped: allKeys.length, skippedSample: sample,
    };
  }

  // #OVERNIGHT-COLDSTART-VISIBILITY: reviewColdStart was set on a genuine cold
  // start — the operator has explicitly opted OUT of priming for this run and
  // wants the enumerated units reviewed instead. Do NOT call primeColdStart.
  // Just flip `initialized` so this doesn't cold-start again next run, and
  // fall through into the exact same review/feed/state-save path used for a
  // normal (non-cold) run below. That path already treats every unit in
  // `units` as "fresh" (nothing is in st.reviewed yet), already writes the
  // proposal feed unconditionally, and already only advances the watermark
  // when nothing failed — so the invariant in the #OVERNIGHT-FEED comment
  // below (reviewed-set/watermark never advances past unpersisted proposals)
  // holds here for free, with no separate code path to keep in sync.
  const coldStartReviewed = state.isColdStart(st) && reviewColdStart;
  if (coldStartReviewed) {
    st.initialized = true;
    log(`[overnight] COLD START — OVERNIGHT_REVIEW_COLD_START is set: reviewing ${allKeys.length} enumerated unit(s) instead of priming them past. This will attempt to review the entire accumulated backlog.`);
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
  // machine). The feed must persist so the next Dreamer wake can read it after
  // a fresh clone; in PR mode it is the content of the draft PR. (It no longer
  // travels "alongside state.json" — the watermark moved out of the checkout
  // in #305; the feed stays here because it is the reviewable artifact.)
  const outDir = path.join(skillsRepo, 'data/overnight-review', dateStamp(now));
  // #OVERNIGHT-FEED (closes the follow-up on #OVERNIGHT-STATE): the proposal
  // and review-task feed is a FILE for downstream automation/humans to read —
  // same category as state.json — not an "action" like opening a PR. This
  // module never opens PRs (grep it: no createPull/door43-push call here), so
  // there was never an action for dry-run to suppress by gating this write.
  // Gating it behind `!dryRun` (as it was) combined with the previous fix
  // (state now persists unconditionally) to make things WORSE than the
  // original bug: units got marked reviewed and the watermark advanced, but
  // the proposals describing them were discarded — so the Sensor still
  // produced nothing, and now permanently forgot the backlog too. Write the
  // feed unconditionally, and do it BEFORE advancing/saving state (below) —
  // see the invariant comment there.
  mkdir(outDir);
  const proposalsPath = path.join(outDir, 'proposals.jsonl');
  writeImpl(proposalsPath, proposals.map((p) => JSON.stringify(p)).join('\n') + (proposals.length ? '\n' : ''));
  const tasksPath = path.join(outDir, 'review-tasks.jsonl');
  writeImpl(tasksPath, reviewTasks.map((t) => JSON.stringify(t)).join('\n') + (reviewTasks.length ? '\n' : ''));
  // #OVERNIGHT-STATE: persist the reviewed-set and lastRun watermark
  // UNCONDITIONALLY — including on a dry run. Marking a unit reviewed and
  // advancing lastRun is bookkeeping ("what have I already looked at"), not an
  // action ("open a PR"); dry-run must only suppress the latter. Gating this
  // behind `!dryRun` (as it was) meant every dry run started back at the same
  // watermark, so a dry-run-only Sensor could never make forward progress —
  // this is the root cause of 34 consecutive no-op nightly runs.
  //
  // INVARIANT (#OVERNIGHT-FEED): the reviewed-set / lastRun watermark must
  // NEVER advance past units whose proposals were not successfully persisted.
  // That's why the feed write above runs first, with nothing catching its
  // exception here: if writeImpl/mkdir throws, it propagates out of
  // runOvernightReview before `st.lastRun` is touched or state.saveState is
  // called, so nothing is persisted this run — the same units are still
  // "fresh" (not in `reviewed`, lastRun unmoved) and get retried next run
  // instead of being silently marked seen with their proposals lost.
  //
  // Only advance the lastRun watermark on a clean run — otherwise a deferred
  // unit would fall outside the next window and never be retried.
  if (failed === 0) st.lastRun = now.toISOString();
  state.saveState(stateFile, st, { writeImpl, mkdirImpl: mkdir });

  const reviewed = fresh.length - failed;
  // "reviewed" regardless of dryRun — the feed is always written now (see
  // #OVERNIGHT-FEED above), so there is no "would review" distinction left to
  // draw. dryRun only tags the line for the reader's benefit.
  log(`[overnight] reviewed ${reviewed} unit(s)${failed ? ` (${failed} deferred on transient failure)` : ''} → ${proposals.length} proposal row(s), ${reviewTasks.length} review task(s).${coldStartReviewed ? ' (this was a cold start, reviewed via OVERNIGHT_REVIEW_COLD_START instead of primed)' : ''}${dryRun ? ' (dry-run)' : ''}`);
  return {
    coldStart: false, dryRun, units: units.length, reviewed, failed,
    proposals: proposals.length, proposalsPath, tasksPath, reviewTasks,
    sampleProposals: proposals.slice(0, 12),
    coldStartReviewed, skipped: 0,
  };
}

// --- CLI ---------------------------------------------------------------------
// node src/overnight-watcher.js --skills-repo <dir> [--dry-run] [--review-cold-start]
// Prints a digest between OVERNIGHT_DIGEST markers for the cron wrapper.
//
// #OVERNIGHT-COLDSTART-VISIBILITY: --review-cold-start (or env
// OVERNIGHT_REVIEW_COLD_START=true) makes a cold start REVIEW the enumerated
// units instead of priming past them — i.e. it treats the accumulated backlog
// as work to do, not as noise to skip. Default is OFF: priming remains the
// default cold-start behaviour (see the long comment at the cold-start branch
// in runOvernightReview for why silently reviewing everything on every
// genuine first run would be wrong). This is an opt-in escape hatch for the
// one situation where a human knows better than the default — e.g. the first
// run after this fix deploys, where the Sensor's own dry-run history means
// it is about to cold-start over a real, non-empty backlog.
function parseArgs(argv) {
  const out = { dryRun: false, reviewColdStart: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--review-cold-start') out.reviewColdStart = true;
    else if (a === '--skills-repo') out.skillsRepo = argv[++i];
  }
  return out;
}

function envFlag(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || '').trim());
}

async function cliMain(argv) {
  const args = parseArgs(argv);
  const skillsRepo = args.skillsRepo || process.env.BP_SKILLS_REPO;
  if (!skillsRepo) { process.stderr.write('[overnight] BP_SKILLS_REPO not set\n'); process.exit(2); }
  const reviewColdStart = args.reviewColdStart || envFlag('OVERNIGHT_REVIEW_COLD_START');
  const res = await runOvernightReview({ skillsRepo, dryRun: args.dryRun, reviewColdStart });
  const lines = [];
  if (res.coldStart) {
    const label = res.genuineFirstRun ? 'genuine first run' : 'NOT a genuine first run — state existed but was uninitialized, check for a persistence bug';
    lines.push(`COLD START (${label}) — SKIPPED ${res.skipped} unit(s) as already-seen; NO proposals were produced for them${res.dryRun ? ' (dry-run)' : ''}.`);
    if (res.skippedSample && res.skippedSample.length) {
      const more = res.skipped > res.skippedSample.length ? ` (+${res.skipped - res.skippedSample.length} more)` : '';
      lines.push(`Skipped units: ${res.skippedSample.join(', ')}${more}`);
    }
    lines.push('To review these instead of skipping them, set OVERNIGHT_REVIEW_COLD_START=true (or pass --review-cold-start) and re-run.');
  } else {
    if (res.coldStartReviewed) lines.push('NOTE: this was a cold start; reviewed the enumerated backlog instead of priming past it (OVERNIGHT_REVIEW_COLD_START was set).');
    lines.push(`Reviewed ${res.reviewed} new \`-be-\` unit(s) across ${res.units} watched → ${res.proposals} attributed proposal row(s)${res.dryRun ? ' (dry-run)' : ''}.`);
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
