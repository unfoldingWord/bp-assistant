// door43-push: the PR description body.
//
// Issue #385 — the interpretive review's per-row findings need to reach the
// editor reviewing the chapter on Door43, which means they have to land in the
// TN pull request description instead of the hardcoded `body: ''`.
//
// door43Push itself needs a real git checkout and a Gitea token, so these
// exercise createAndMergePR (the function that actually issues the PR create
// call) with an injected API implementation, plus the pure body cap.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createAndMergePR, capPrBody, PR_BODY_MAX } = require('../src/door43-push');

// A stub Gitea API: records every call, answers the happy path.
function stubApi(overrides = {}) {
  const calls = [];
  const impl = async (method, apiPath, token, data) => {
    calls.push({ method, apiPath, data });
    const key = `${method} ${apiPath.replace(/\?.*$/, '')}`;
    if (overrides[key]) return overrides[key];
    if (method === 'POST' && /\/pulls$/.test(apiPath)) {
      return { status: 201, data: { number: 7, html_url: 'https://git.door43.org/x/pulls/7' } };
    }
    if (method === 'POST' && /\/merge$/.test(apiPath)) return { status: 200, data: {} };
    if (method === 'DELETE') return { status: 204, data: {} };
    return { status: 200, data: {} };
  };
  return { impl, calls };
}

const createBody = (calls) => calls.find((c) => c.method === 'POST' && /\/pulls$/.test(c.apiPath)).data.body;

// ---- body pass-through ---------------------------------------------------

test('createAndMergePR sends the provided body in the PR create call', async () => {
  const { impl, calls } = stubApi();
  const summary = 'Interpretive review changed 3 rows\n- 1:2 tightened gloss\n- 1:5 removed aside';

  const res = await createAndMergePR('tok', 'en_tn', 'AI-PSA-030', 'title', 'master', 'unfoldingWord', { body: summary, apiImpl: impl });

  assert.equal(res.success, true);
  assert.equal(createBody(calls), summary);
});

test("createAndMergePR sends '' when no body is given", async () => {
  const { impl, calls } = stubApi();

  await createAndMergePR('tok', 'en_tn', 'AI-PSA-030', 'title', 'master', 'unfoldingWord', { apiImpl: impl });

  assert.equal(createBody(calls), '');
});

test('a body of undefined or null degrades to the empty string, not "undefined"', async () => {
  for (const val of [undefined, null]) {
    const { impl, calls } = stubApi();
    await createAndMergePR('tok', 'en_tn', 'b', 't', 'master', 'unfoldingWord', { body: val, apiImpl: impl });
    assert.equal(createBody(calls), '', `body: ${val}`);
  }
});

// ---- cap -----------------------------------------------------------------

test('an oversized body is capped at PR_BODY_MAX before it is sent', async () => {
  const { impl, calls } = stubApi();
  const huge = 'row findings. '.repeat(2000); // well over the cap

  await createAndMergePR('tok', 'en_tn', 'b', 't', 'master', 'unfoldingWord', { body: huge, apiImpl: impl });

  const sent = createBody(calls);
  assert.ok(sent.length <= PR_BODY_MAX, `sent ${sent.length} > cap ${PR_BODY_MAX}`);
  assert.ok(sent.endsWith('…(truncated)'), 'truncation is marked');
  assert.ok(sent.startsWith('row findings.'), 'keeps the head of the summary');
});

test('capPrBody leaves a body at or under the cap byte-identical', () => {
  assert.equal(capPrBody(''), '');
  assert.equal(capPrBody('short summary'), 'short summary');
  const exact = 'y'.repeat(PR_BODY_MAX);
  assert.equal(capPrBody(exact), exact);
  assert.equal(capPrBody('y'.repeat(PR_BODY_MAX + 1)).length, PR_BODY_MAX);
});

test('capPrBody coerces non-strings to the empty string', () => {
  for (const val of [undefined, null, 0, {}, []]) assert.equal(capPrBody(val), '');
});

// ---- the 409 path stays unchanged ---------------------------------------

test('the 409 already-exists path does not attempt to edit the existing PR body', async () => {
  const { impl, calls } = stubApi({
    'POST /repos/unfoldingWord/en_tn/pulls': { status: 409, data: { message: 'issue_id: 42' } },
  });

  const res = await createAndMergePR('tok', 'en_tn', 'b', 't', 'master', 'unfoldingWord', { body: 'a summary', apiImpl: impl });

  assert.equal(res.success, true);
  // No PATCH/edit of the existing PR.
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});
