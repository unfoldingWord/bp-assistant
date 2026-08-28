// ownership-sweep.js — guard against the EACCES failure class caused by
// foreign-owned (typically root-owned) leftovers under the workspace output/
// and tmp/ trees. A rejected/detached privileged launch, or an earlier run as
// root, can leave files the normal bot user cannot overwrite; the next pipeline
// then dies with EACCES partway through. At pipeline start we sweep those trees,
// warn about anything not owned by the workspace owner, and — when running
// privileged — chown it back so the run can proceed.
//
// When the bot itself runs unprivileged (the normal case) chownSync is not
// permitted, so detection is all we have. Foreign ownership alone is not a
// failure predictor though — a root-owned but group-writable directory is still
// writable by us. What actually causes the mid-run EACCES is a path we cannot
// fix AND cannot write, so the sweep separates those out as `blocked`. Callers
// escalate `blocked` to admin-status (and fail fast for the door43 git trees)
// rather than letting a run discover the problem 55 minutes later at push time
// (see issues #207 and #349).

const fs = require('fs');
const path = require('path');
const { CSKILLBP_DIR } = require('./pipeline-utils');

// Files/dirs under tmp/ older than this are removed by sweepStaleTmp. tmp/ is
// runtime scratch (gitignored), so aging it out is safe.
const TMP_TTL_DAYS = Number(process.env.BP_TMP_TTL_DAYS || 7);

// A foreign-owned path only breaks the run if we also cannot write it. For a
// directory that means W_OK|X_OK (git creates new loose objects *inside* the
// shard dir); for a file it means W_OK (we would have to overwrite it).
function isWriteBlocked(p, isDirectory) {
  const mode = isDirectory ? fs.constants.W_OK | fs.constants.X_OK : fs.constants.W_OK;
  try {
    fs.accessSync(p, mode);
    return false;
  } catch (_) {
    return true;
  }
}

function sweepWorkspaceOwnership({
  baseDir = CSKILLBP_DIR,
  subdirs = ['output', 'tmp'],
  log = console,
  expectedUid,
  expectedGid,
} = {}) {
  // The expected owner is whoever owns the workspace root (the bot user), unless
  // the caller pins it explicitly. Fall back to skipping if the workspace is
  // absent (local dev / unit tests).
  let targetUid;
  let targetGid;
  try {
    const rootStat = fs.statSync(baseDir);
    targetUid = expectedUid != null ? expectedUid : rootStat.uid;
    targetGid = expectedGid != null ? expectedGid : rootStat.gid;
  } catch (_) {
    return null;
  }

  const canChown = typeof process.getuid === 'function' && process.getuid() === 0;
  const foreign = [];
  const blocked = [];
  let chowned = 0;

  const visit = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.uid !== targetUid || st.gid !== targetGid) {
      foreign.push(p);
      let fixed = false;
      if (canChown) {
        try { fs.chownSync(p, targetUid, targetGid); chowned++; fixed = true; } catch (_) { /* best effort */ }
      }
      // Only paths we could neither fix nor write are real EACCES risks.
      if (!fixed && isWriteBlocked(p, st.isDirectory())) blocked.push(p);
    }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(p); } catch (_) { return; }
      for (const e of entries) visit(path.join(p, e));
    }
  };

  for (const sub of subdirs) {
    const dir = path.join(baseDir, sub);
    if (fs.existsSync(dir)) visit(dir);
  }

  if (foreign.length) {
    const preview = foreign.slice(0, 20);
    const more = foreign.length > preview.length ? `\n  ... and ${foreign.length - preview.length} more` : '';
    const action = canChown
      ? ` — chowned ${chowned} back to the workspace owner`
      : ' — running unprivileged, could not chown';
    const risk = blocked.length
      ? ` — ${blocked.length} of them are also unwritable and WILL cause EACCES`
      : ' — all of them are still writable, so no EACCES risk';
    log.warn(
      `[ownership-sweep] ${foreign.length} path(s) under ${baseDir} not owned by uid ${targetUid}:${targetGid}${action}${risk}\n  ` +
      preview.join('\n  ') + more,
    );
  }

  return { foreign, blocked, chowned, canChown, targetUid, targetGid };
}

// Blocked paths inside a door43 repo's git tree are fatal for any pipeline that
// pushes: every push writes loose objects there, so the run would burn its full
// duration and then die at door43-push. Blocked paths elsewhere (a stale
// output/ file for an unrelated chapter) are worth surfacing but not aborting.
function partitionBlocked(blocked = []) {
  const fatal = [];
  const advisory = [];
  for (const p of blocked) {
    const norm = p.split(path.sep).join('/');
    if (/(^|\/)door43-repos\/[^/]+\/\.git(\/|$)/.test(norm)) fatal.push(p);
    else advisory.push(p);
  }
  return { fatal, advisory };
}

function sweepStaleTmp({ baseDir = CSKILLBP_DIR, ttlDays = TMP_TTL_DAYS, log = console, now = Date.now() } = {}) {
  const tmpDir = path.join(baseDir, 'tmp');
  if (!fs.existsSync(tmpDir) || ttlDays <= 0) return null;
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(tmpDir); } catch (_) { return null; }
  for (const e of entries) {
    // tmp/pipeline holds resumable run state (context.json, prepared/generated
    // notes) with its own retention policy in pipeline-context.js — a 7-day
    // scratch TTL here would delete a resumable run out from under a checkpoint.
    if (e === 'pipeline') continue;
    // tmp/translate-* holds editor-delivery outputs (out/*.tsv|md + report)
    // that must remain fetchable via GET /api/pipeline/{jobId}/output after
    // the run is done — the done checkpoint outlives this scratch TTL.
    if (e.startsWith('translate-')) continue;
    const p = path.join(tmpDir, e);
    let st;
    try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (st.mtimeMs >= cutoff) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch (_) { /* best effort */ }
  }
  if (removed) log.warn(`[ownership-sweep] removed ${removed} tmp/ entrie(s) older than ${ttlDays}d`);
  return { removed };
}

module.exports = { sweepWorkspaceOwnership, sweepStaleTmp, partitionBlocked };
