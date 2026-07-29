'use strict';

// Unit tests for POST /api/pipeline/{jobId}/resume — the machine-callable
// resume verb, and its safety time-box.
//
// Real incident (2026-07-29): a `notes` run for DAN 7 hit a transient Claude
// outage. The bot did exactly what it was designed to do — parked the chapter
// as `paused_for_outage` with a perfectly good `resume: { chapter, skill }` on
// disk — and then waited for a human to type `resume` in Zulip. Nobody did.
// Because bible-editor counts a paused job as occupying the single bot slot,
// that one parked chapter blocked three queued jobs behind it for ~8 hours.
// The resumable state existed; it simply was not reachable over HTTP.
//
// The dangerous half of fixing that is the reason these tests exist. Per
// bp-bot/STALE-SOURCE-DIAGNOSIS.md §3.1, resume is the top documented cause of
// the bot shipping content built from OLD source text: cached per-chapter
// artifacts are keyed on scope only (no source fingerprint) and `checkUltEdits`
// — the one gate that compares generated text against live master ULT — is
// skipped on the resume path. That was contained only by accident, because a
// human resumes within minutes of the run they remember starting. A machine
// will not. RESUME_MAX_PAUSE_AGE_MS is the replacement containment, so the
// staleness assertions below are guarding a publish-wrong-text bug, not a
// preference.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyResumeRequest,
  resumeAnchorPatch,
  serializeCheckpoint,
  RESUME_MAX_PAUSE_AGE_MS,
  ResumeBodySchema,
  StartBodySchema,
} = require('../src/api/pipeline');

const NOW = Date.parse('2026-07-29T18:00:00.000Z');
const agoMinutes = (m) => new Date(NOW - m * 60 * 1000).toISOString();

function pausedCheckpoint(overrides = {}) {
  return {
    pipelineType: 'notes',
    scope: { book: 'DAN', startChapter: 7, endChapter: 7, verseStart: null, verseEnd: null },
    state: 'paused_for_outage',
    updatedAt: agoMinutes(5),
    createdAt: agoMinutes(40),
    resume: { chapter: 7, skill: 'tn-writer' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyResumeRequest — the decision surface
// ---------------------------------------------------------------------------

test('resume — a freshly paused checkpoint with a resume point is resumable', () => {
  const v = classifyResumeRequest(pausedCheckpoint(), { now: NOW });
  assert.equal(v.ok, true);
  assert.deepEqual(v.resume, { chapter: 7, skill: 'tn-writer' });
  assert.equal(v.pausedAgeSeconds, 300);
});

test('resume — paused_for_usage_limit is resumable too', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ state: 'paused_for_usage_limit' }), { now: NOW });
  assert.equal(v.ok, true);
});

test('resume — 404 when there is no checkpoint at all', () => {
  const v = classifyResumeRequest(null, { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 404);
  assert.equal(v.body.error, 'not_found');
});

test('resume — 409 not_resumable for a state that is not a pause', () => {
  // `running` must never be restarted through this verb (that is the conflict
  // path), and `failed` needs a human to look at why it failed.
  for (const state of ['running', 'failed', 'done']) {
    const v = classifyResumeRequest(pausedCheckpoint({ state }), { now: NOW });
    assert.equal(v.ok, false, `state ${state} should not be resumable`);
    assert.equal(v.status, 409);
    assert.equal(v.body.error, 'not_resumable');
    assert.equal(v.body.state, state);
  }
});

test('resume — 409 not_resumable when the checkpoint carries no resume point', () => {
  for (const resume of [null, undefined, {}, { chapter: null, skill: 'tn-writer' }]) {
    const v = classifyResumeRequest(pausedCheckpoint({ resume }), { now: NOW });
    assert.equal(v.ok, false);
    assert.equal(v.status, 409);
    assert.equal(v.body.error, 'not_resumable');
    assert.equal(v.body.message, 'no resume point on checkpoint');
  }
});

// ---------------------------------------------------------------------------
// The safety time-box — see STALE-SOURCE-DIAGNOSIS.md §3.1
// ---------------------------------------------------------------------------

test('resume — the time-box is 90 minutes', () => {
  assert.equal(RESUME_MAX_PAUSE_AGE_MS, 90 * 60 * 1000);
});

test('resume — 409 stale_pause past the time-box (stale artifacts must not be re-shipped)', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ updatedAt: agoMinutes(91) }), { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.equal(v.body.error, 'stale_pause');
  assert.equal(v.body.state, 'paused_for_outage');
  assert.equal(v.body.pausedAgeSeconds, 91 * 60);
});

test('resume — the DAN 7 incident itself (parked ~8h) is refused without force', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ updatedAt: agoMinutes(8 * 60) }), { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.body.error, 'stale_pause');
});

test('resume — exactly at the boundary is still allowed; one ms past is not', () => {
  const at = new Date(NOW - RESUME_MAX_PAUSE_AGE_MS).toISOString();
  assert.equal(classifyResumeRequest(pausedCheckpoint({ updatedAt: at }), { now: NOW }).ok, true);
  const past = new Date(NOW - RESUME_MAX_PAUSE_AGE_MS - 1).toISOString();
  assert.equal(classifyResumeRequest(pausedCheckpoint({ updatedAt: past }), { now: NOW }).ok, false);
});

test('resume — force:true bypasses the age check (and only the age check)', () => {
  const stale = pausedCheckpoint({ updatedAt: agoMinutes(600) });
  assert.equal(classifyResumeRequest(stale, { now: NOW }).ok, false);

  const forced = classifyResumeRequest(stale, { force: true, now: NOW });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.resume, { chapter: 7, skill: 'tn-writer' });

  // force must NOT rescue a non-resumable state or a missing resume point —
  // it is an age override, not an "ignore all gates" flag.
  assert.equal(classifyResumeRequest(pausedCheckpoint({ state: 'running', updatedAt: agoMinutes(600) }), { force: true, now: NOW }).body.error, 'not_resumable');
  assert.equal(classifyResumeRequest(pausedCheckpoint({ resume: null }), { force: true, now: NOW }).body.error, 'not_resumable');
  assert.equal(classifyResumeRequest(null, { force: true, now: NOW }).status, 404);
});

test('resume — an unparseable pause time fails closed as stale', () => {
  // We cannot bound the age, so we must not resume: failing open here would
  // silently re-open the stale-content path.
  const v = classifyResumeRequest(pausedCheckpoint({ updatedAt: 'not-a-date' }), { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.body.error, 'stale_pause');
  assert.equal(v.body.pausedAgeSeconds, null);
});

// ---------------------------------------------------------------------------
// The age ANCHOR — why the time-box cannot be measured from `updatedAt`
//
// setCheckpoint stamps `updatedAt` on EVERY write (src/pipeline-checkpoints.js:72)
// and a resumed run writes state:'running' the instant it starts
// (src/notes-pipeline.js:1851). Measuring the pause age from `updatedAt` therefore
// measures "time since the last resume attempt", not "age of the cached
// artifacts". During a long Claude outage the re-park → retry → re-park cycle
// keeps refreshing `updatedAt`, so the 90-minute gate would never fire and the
// bot would publish content generated hours before a proofreader's edits — the
// exact stale-source publish this gate exists to prevent
// (STALE-SOURCE-DIAGNOSIS.md §3.1). `pauseAnchorAt` is written once and never
// moved, so it is the only sound anchor.
// ---------------------------------------------------------------------------

test('resume — the age gate measures pauseAnchorAt, so a re-parked checkpoint cannot reset its own clock', () => {
  // The regression that matters: a 3h-old pause whose `updatedAt` was refreshed
  // one minute ago by a resume attempt. Reading `updatedAt` would call this
  // fresh (60s) and resume it; the anchor correctly calls it stale.
  const v = classifyResumeRequest(
    pausedCheckpoint({ pauseAnchorAt: agoMinutes(180), updatedAt: agoMinutes(1) }),
    { now: NOW },
  );
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.equal(v.body.error, 'stale_pause');
  // Reported age must be the anchor's, not `updatedAt`'s — a caller deciding
  // whether to force needs the artifact age, not the retry age.
  assert.equal(v.body.pausedAgeSeconds, 180 * 60);
});

test('resume — repeated re-parks never rescue a stale pause (the outage retry loop)', () => {
  // Simulate the loop: the anchor is pinned at the original park and every
  // subsequent attempt only touches `updatedAt`. Every attempt must be refused.
  const anchor = agoMinutes(8 * 60);
  for (const retryMinutesAgo of [0, 1, 5, 30, 89]) {
    const v = classifyResumeRequest(
      pausedCheckpoint({ pauseAnchorAt: anchor, updatedAt: agoMinutes(retryMinutesAgo) }),
      { now: NOW },
    );
    assert.equal(v.ok, false, `retry ${retryMinutesAgo}m ago must still be stale`);
    assert.equal(v.body.error, 'stale_pause');
    assert.equal(v.body.pausedAgeSeconds, 8 * 60 * 60);
  }
});

test('resume — pausedAgeSeconds reflects the anchor even when the pause is fresh enough to resume', () => {
  const v = classifyResumeRequest(
    pausedCheckpoint({ pauseAnchorAt: agoMinutes(20), updatedAt: agoMinutes(1) }),
    { now: NOW },
  );
  assert.equal(v.ok, true);
  assert.equal(v.pausedAgeSeconds, 20 * 60);
});

test('resume — the anchor boundary is the same 90 minutes, measured from the anchor', () => {
  const at = new Date(NOW - RESUME_MAX_PAUSE_AGE_MS).toISOString();
  assert.equal(
    classifyResumeRequest(pausedCheckpoint({ pauseAnchorAt: at, updatedAt: agoMinutes(0) }), { now: NOW }).ok,
    true,
  );
  const past = new Date(NOW - RESUME_MAX_PAUSE_AGE_MS - 1).toISOString();
  assert.equal(
    classifyResumeRequest(pausedCheckpoint({ pauseAnchorAt: past, updatedAt: agoMinutes(0) }), { now: NOW }).ok,
    false,
  );
});

test('resume — with no anchor, behaviour falls back to updatedAt unchanged', () => {
  // Checkpoints parked before this fix shipped carry no anchor; they must keep
  // behaving exactly as before rather than becoming unresumable.
  const fresh = pausedCheckpoint({ updatedAt: agoMinutes(5) });
  assert.equal('pauseAnchorAt' in fresh, false);
  const v = classifyResumeRequest(fresh, { now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.pausedAgeSeconds, 300);
  assert.equal(classifyResumeRequest(pausedCheckpoint({ updatedAt: agoMinutes(91) }), { now: NOW }).body.error, 'stale_pause');
});

test('resume — force:true still overrides an anchored stale pause (age override only)', () => {
  const stale = pausedCheckpoint({ pauseAnchorAt: agoMinutes(600), updatedAt: agoMinutes(1) });
  assert.equal(classifyResumeRequest(stale, { now: NOW }).ok, false);
  assert.equal(classifyResumeRequest(stale, { force: true, now: NOW }).ok, true);
});

test('resume — an unparseable anchor fails closed even when updatedAt is fresh', () => {
  // The anchor is authoritative once present: falling through to a fresh
  // `updatedAt` here would re-open the very reset this fix closes.
  const v = classifyResumeRequest(
    pausedCheckpoint({ pauseAnchorAt: 'not-a-date', updatedAt: agoMinutes(1) }),
    { now: NOW },
  );
  assert.equal(v.ok, false);
  assert.equal(v.body.error, 'stale_pause');
  assert.equal(v.body.pausedAgeSeconds, null);
});

// ---------------------------------------------------------------------------
// Body parsing — an empty body means force=false
// ---------------------------------------------------------------------------

test('resume — empty body is valid and means force=false', () => {
  const parsed = ResumeBodySchema.safeParse({});
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.force, undefined);
  assert.equal(classifyResumeRequest(pausedCheckpoint({ updatedAt: agoMinutes(200) }), { force: parsed.data.force === true, now: NOW }).body.error, 'stale_pause');
});

test('resume — unknown body fields are rejected', () => {
  assert.equal(ResumeBodySchema.safeParse({ pipelineType: 'notes' }).success, false);
  assert.equal(ResumeBodySchema.safeParse({ force: 'yes' }).success, false);
  assert.equal(ResumeBodySchema.safeParse({ force: true, username: 'bible-editor' }).success, true);
});

// ---------------------------------------------------------------------------
// options.fresh must be unrepresentable on the resume path
//
// `fresh` is a legitimate /start option, so a caller replaying a stored
// options_json can carry it in here. On the resume path `fresh` calls
// clearCheckpoint() AND cleanupNotesArtifacts() (src/notes-pipeline.js:1801-1806)
// — destroying the checkpoint and cached artifacts this verb exists to reuse,
// after we have already answered 202 {status:'resumed'}. A resume that wipes the
// work and reports success is the worst possible outcome, so the schema rejects
// it as an unrecognized key instead of silently ignoring it.
// ---------------------------------------------------------------------------

test('resume — options.fresh is rejected, not ignored', () => {
  for (const fresh of [true, false]) {
    const parsed = ResumeBodySchema.safeParse({ force: true, options: { fresh } });
    assert.equal(parsed.success, false, `options.fresh:${fresh} must be rejected`);
    // It must fail as an unrecognized key on options, not somewhere incidental.
    const issue = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
    assert.ok(issue, `expected unrecognized_keys issue, got ${JSON.stringify(parsed.error.issues)}`);
    assert.deepEqual(issue.path, ['options']);
    assert.deepEqual(issue.keys, ['fresh']);
  }
});

test('resume — a valid non-fresh options object still passes through untouched', () => {
  const opts = { noIntro: true, pauseBeforeATs: false, model: 'sonnet' };
  const parsed = ResumeBodySchema.safeParse({ options: opts });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.options, opts);
  // And /start is unaffected — `fresh` is still legal there.
  assert.equal(
    StartBodySchema.safeParse({
      pipelineType: 'notes', book: 'DAN', startChapter: 7, endChapter: 7,
      username: 'bible-editor', sessionKey: 'stream-81-Bot-testing',
      options: { fresh: true },
    }).success,
    true,
  );
});

// ---------------------------------------------------------------------------
// Session-key identity — the checkpoint we validate must be the one we resume
//
// triggerPipelineFromApi DERIVES its session key from the API control thread
// (src/router.js:1670), ignoring the key embedded in the jobId. For a
// Zulip-originated run the two differ, so resuming would validate a real
// checkpoint and then launch a run that finds none — silently restarting from
// chapter 1 and re-pushing completed chapters to Door43 while reporting
// `resumed from ch=N`. handleResumeRequest compares the two and refuses (409).
// The comparison itself is exercised over real HTTP; what is pinned here is the
// export it depends on, whose absence would throw a TypeError on every resume.
// ---------------------------------------------------------------------------

test('resume — buildApiSessionKey is exported and a Zulip-style key does not match the derived API key', () => {
  const { buildApiSessionKey } = require('../src/router');
  assert.equal(typeof buildApiSessionKey, 'function');
  const derived = buildApiSessionKey('notes', {});
  assert.ok(derived.startsWith('stream-'), `unexpected derived key: ${derived}`);
  assert.notEqual(derived, 'stream-81 English Book Packages-Some Topic');
});

// ---------------------------------------------------------------------------
// Status payload — the paused detail bible-editor needs to decide to resume
// ---------------------------------------------------------------------------

test('status — serializeCheckpoint exposes resume + pausedAt for a paused job', () => {
  const cp = pausedCheckpoint();
  const out = serializeCheckpoint('job__notes__DAN_7_7_na_na', cp);
  assert.deepEqual(out.resume, { chapter: 7, skill: 'tn-writer' });
  assert.equal(out.pausedAt, cp.updatedAt);
  // Existing fields must be untouched.
  assert.equal(out.state, 'paused_for_outage');
  assert.equal(out.pipelineType, 'notes');
  assert.deepEqual(out.scope, cp.scope);
  assert.equal(out.interrupted, false);
});

test('status — pausedAt is absent for non-paused states; resume is null when there is none', () => {
  const running = serializeCheckpoint('j', pausedCheckpoint({ state: 'running', resume: null }));
  assert.equal('pausedAt' in running, false);
  assert.equal(running.resume, null);
});

// ---------------------------------------------------------------------------
// Session-key guard — the checkpoint we validate must be the one we resume
// ---------------------------------------------------------------------------
//
// triggerPipelineFromApi DERIVES its session key from the API control thread
// (src/router.js:1609-1621, :1670), ignoring the key embedded in the jobId. So a
// Zulip-originated checkpoint passes every other check and then the launched run
// finds no checkpoint under ITS key, restarts from chapter 1, and re-pushes
// already-completed chapters to Door43 — while the API answers `resumed from
// ch=N`. Silent, and it writes to a real repo, so it is refused instead.

const API_KEY = 'stream-81 English Book Packages-Bot testing';
const ZULIP_KEY = 'stream-81 English Book Packages-Some Topic';

test('resume — a Zulip-originated checkpoint is refused, not silently restarted', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ sessionKey: ZULIP_KEY }), {
    now: NOW,
    derivedSessionKey: API_KEY,
  });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.equal(v.body.error, 'not_resumable');
  assert.match(v.body.message, /resume it from Zulip/);
});

test('resume — a checkpoint whose sessionKey matches the derived key is accepted', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ sessionKey: API_KEY }), {
    now: NOW,
    derivedSessionKey: API_KEY,
  });
  assert.equal(v.ok, true);
});

test('resume — the guard fails CLOSED on a checkpoint with no sessionKey', () => {
  // setCheckpoint always writes one, so an absent key means a hand-edited file —
  // a documented practice, and the worst case in which to guess.
  const v = classifyResumeRequest(pausedCheckpoint(), { now: NOW, derivedSessionKey: API_KEY });
  assert.equal(v.ok, false);
  assert.equal(v.body.error, 'not_resumable');
});

test('resume — force does NOT override a session mismatch (it overrides age only)', () => {
  const v = classifyResumeRequest(pausedCheckpoint({ sessionKey: ZULIP_KEY }), {
    now: NOW,
    force: true,
    derivedSessionKey: API_KEY,
  });
  assert.equal(v.ok, false);
  assert.match(v.body.message, /different session/);
});

// ---------------------------------------------------------------------------
// Age anchor — write-once, or it is not an anchor
// ---------------------------------------------------------------------------

test('anchor — pinned from updatedAt on a checkpoint that has none', () => {
  const cp = pausedCheckpoint({ updatedAt: agoMinutes(20) });
  assert.deepEqual(resumeAnchorPatch(cp), { pauseAnchorAt: cp.updatedAt });
});

test('anchor — never re-pinned, so a resume cannot move its own clock forward', () => {
  // This is the whole point. setCheckpoint stamps updatedAt on every write and a
  // resumed run writes state:'running' immediately, so re-pinning would drag the
  // anchor onto the fresh timestamp and the 90-minute gate would never fire.
  const cp = pausedCheckpoint({ pauseAnchorAt: agoMinutes(200), updatedAt: agoMinutes(1) });
  assert.equal(resumeAnchorPatch(cp), null);
});

test('anchor — nothing to pin without a checkpoint or an updatedAt', () => {
  assert.equal(resumeAnchorPatch(null), null);
  assert.equal(resumeAnchorPatch(pausedCheckpoint({ updatedAt: undefined })), null);
});
