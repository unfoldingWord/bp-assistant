// door43-push: createPR opens a PR and stops.
//
// tn-modernize delivers one en_tn PR for a human to review; createAndMergePR
// would merge it seconds after opening. These pin that createPR never calls
// the merge or branch-delete endpoints, and that createAndMergePR still does.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createPR, createAndMergePR } = require('../src/door43-push');

function stubApi(overrides = {}) {
  const calls = [];
  const impl = async (method, apiPath, token, data) => {
    calls.push({ method, apiPath, data });
    const key = `${method} ${apiPath.replace(/\?.*$/, '')}`;
    if (overrides[key]) return overrides[key];
    if (method === 'POST' && /\/pulls$/.test(apiPath)) {
      return { status: 201, data: { number: 12, html_url: 'https://git.door43.org/unfoldingWord/en_tn/pulls/12' } };
    }
    if (method === 'POST' && /\/merge$/.test(apiPath)) return { status: 200, data: {} };
    if (method === 'DELETE') return { status: 204, data: {} };
    return { status: 200, data: {} };
  };
  return { impl, calls };
}

const touchesMergeOrDelete = (calls) => calls.filter((c) => /\/merge$/.test(c.apiPath) || c.method === 'DELETE');

test('createPR opens the PR and returns its number and url without merging or deleting', async () => {
  const { impl, calls } = stubApi();
  const res = await createPR('tok', 'en_tn', 'tn-modernize-2026-10-16', 'title', 'master', 'unfoldingWord', { body: 'b', apiImpl: impl });

  assert.equal(res.success, true);
  assert.equal(res.prNumber, 12);
  assert.equal(res.url, 'https://git.door43.org/unfoldingWord/en_tn/pulls/12');
  assert.deepEqual(touchesMergeOrDelete(calls), []);
  assert.equal(calls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.apiPath)).length, 1);
});

test('createPR reuses an existing PR on 409 and still does not merge', async () => {
  const { impl, calls } = stubApi({
    'POST /repos/unfoldingWord/en_tn/pulls': { status: 409, data: { message: 'pull request already exists for these targets [id: 99, issue_id: 7900, head_repo_id: 1]' } },
  });
  const res = await createPR('tok', 'en_tn', 'b', 't', 'master', 'unfoldingWord', { apiImpl: impl });

  assert.equal(res.success, true);
  assert.equal(res.prNumber, 7900);
  assert.deepEqual(touchesMergeOrDelete(calls), []);
});

test('createPR reports a missing branch instead of opening a PR', async () => {
  const { impl, calls } = stubApi({ 'GET /repos/unfoldingWord/en_tn/branches/gone': { status: 404, data: {} } });
  const res = await createPR('tok', 'en_tn', 'gone', 't', 'master', 'unfoldingWord', { apiImpl: impl });

  assert.equal(res.success, false);
  assert.match(res.details, /does not exist/);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('createAndMergePR still merges and deletes the branch after createPR', async () => {
  const { impl, calls } = stubApi();
  const res = await createAndMergePR('tok', 'en_tn', 'AI-PSA-030', 't', 'master', 'unfoldingWord', { apiImpl: impl });

  assert.equal(res.success, true);
  assert.equal(res.prNumber, 12);
  assert.ok(calls.some((c) => /\/pulls\/12\/merge$/.test(c.apiPath)), 'merge called');
  assert.ok(calls.some((c) => c.method === 'DELETE' && /\/branches\/AI-PSA-030$/.test(c.apiPath)), 'branch deleted');
});
