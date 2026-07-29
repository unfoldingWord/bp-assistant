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
  serializeCheckpoint,
  RESUME_MAX_PAUSE_AGE_MS,
  ResumeBodySchema,
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
