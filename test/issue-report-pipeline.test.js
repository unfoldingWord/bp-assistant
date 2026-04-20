const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueReportPipeline,
  _extractFeedbackText,
  _buildClassifierInput,
  _parseClassifierOutput,
} = require('../src/issue-report-pipeline');

function buildMessage(overrides = {}) {
  return {
    id: 4242,
    type: 'stream',
    display_recipient: 'BP Proofreading',
    subject: 'Psalm 38',
    sender_id: 99,
    sender_full_name: 'Proof Reader',
    content: 'report: default feedback',
    attachments: [],
    ...overrides,
  };
}

function buildClassifierResponse(payload) {
  return {
    content: [{ text: JSON.stringify(payload) }],
  };
}

function wrapInJsonFence(text) {
  return `\`\`\`json\n${text}\n\`\`\``;
}

function createAnthropicStub(payload) {
  return class AnthropicStub {
    constructor() {
      this.messages = {
        create: async () => buildClassifierResponse(payload),
      };
    }
  };
}

function createRuntime({ classifierPayload, fetchImpl, sentReplies, classifierInputs }) {
  return {
    AnthropicClient: class AnthropicStub {
      constructor() {
        this.messages = {
          create: async (request) => {
            classifierInputs.push(request.messages[0].content);
            return buildClassifierResponse(classifierPayload);
          },
        };
      }
    },
    sendMessage: async (stream, topic, text) => {
      sentReplies.push({ stream, topic, text });
    },
    sendDM: async (_recipient, text) => {
      sentReplies.push({ dm: true, text });
    },
    addReaction: async () => {},
    removeReaction: async () => {},
    readSecret: (name) => {
      if (name === 'anthropic_api_key') return 'anthropic-test-key';
      if (name === 'github_token') return 'github-test-token';
      return null;
    },
    resolveProviderModel: () => 'claude-sonnet-test',
    fetchImpl,
  };
}

function createAnthropicSequenceStub(responses, classifierInputs) {
  let index = 0;
  return class AnthropicStub {
    constructor() {
      this.messages = {
        create: async (request) => {
          classifierInputs.push(request.messages[0].content);
          const next = responses[Math.min(index, responses.length - 1)];
          index += 1;
          return next;
        },
      };
    }
  };
}

function createGithubFetchStub(options = {}) {
  const store = {
    issues: {
      'bp-assistant': [],
      'bp-assistant-skills': [],
    },
    postsByRepo: {
      'bp-assistant': 0,
      'bp-assistant-skills': 0,
    },
    patches: [],
    failNextPostForRepo: options.failNextPostForRepo || null,
  };

  async function jsonResponse(payload, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
    };
  }

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const parsed = new URL(url);

    if (parsed.pathname === '/search/issues') {
      const q = decodeURIComponent(parsed.searchParams.get('q') || '');
      const repoMatch = q.match(/repo:unfoldingWord\/([^\s]+)/);
      const markerMatch = q.match(/"([^"]+)"/);
      const repo = repoMatch?.[1];
      const marker = markerMatch?.[1];
      const item = store.issues[repo].find((issue) => issue.body.includes(marker)) || null;
      return jsonResponse({ items: item ? [item] : [] });
    }

    const createMatch = parsed.pathname.match(/^\/repos\/unfoldingWord\/([^/]+)\/issues$/);
    if (createMatch && method === 'POST') {
      const repo = createMatch[1];
      store.postsByRepo[repo]++;
      if (store.failNextPostForRepo === repo) {
        store.failNextPostForRepo = null;
        return jsonResponse({ message: `${repo} create failed` }, 502);
      }

      const payload = JSON.parse(init.body);
      const issue = {
        number: store.issues[repo].length + 1,
        html_url: `https://github.com/unfoldingWord/${repo}/issues/${store.issues[repo].length + 1}`,
        title: payload.title,
        body: payload.body,
        labels: payload.labels || [],
      };
      store.issues[repo].push(issue);
      return jsonResponse(issue, 201);
    }

    const patchMatch = parsed.pathname.match(/^\/repos\/unfoldingWord\/([^/]+)\/issues\/(\d+)$/);
    if (patchMatch && method === 'PATCH') {
      const repo = patchMatch[1];
      const number = Number(patchMatch[2]);
      const payload = JSON.parse(init.body);
      const issue = store.issues[repo].find((item) => item.number === number);
      issue.body = payload.body;
      store.patches.push({ repo, number, body: payload.body });
      return jsonResponse(issue);
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  };

  return { fetchImpl, store };
}

function buildClassifierPayload({ complaints, ownership, issues }) {
  return { complaints, ownership, issues };
}

test('extractFeedbackText strips Zulip mentions and explicit trigger prefixes', () => {
  const feedback = _extractFeedbackText('@**bp-bot** feedback: Split snippets still happen in Psalm 38');
  assert.equal(feedback, 'Split snippets still happen in Psalm 38');
});

test('buildClassifierInput includes reporter, stream context, attachments, and image urls', () => {
  const input = _buildClassifierInput(buildMessage({
    content: 'report: See screenshot https://example.com/problem.png',
    attachments: [{ name: 'problem.png', content_type: 'image/png', url: 'https://example.com/problem.png' }],
  }), 'See screenshot https://example.com/problem.png');

  assert.match(input, /Reporter: Proof Reader/);
  assert.match(input, /Stream: BP Proofreading/);
  assert.match(input, /Topic: Psalm 38/);
  assert.match(input, /Attachments:/);
  assert.match(input, /Image URLs:/);
});

test('parseClassifierOutput keeps atomic complaints and multiple focused issues', () => {
  const parsed = _parseClassifierOutput(JSON.stringify(buildClassifierPayload({
    complaints: [
      {
        id: 'c1',
        summary: 'Split snippets still happen',
        evidence: ['still seeing a lot of split snippets'],
        likely_layers: ['bp-assistant-skills'],
      },
      {
        id: 'c2',
        summary: 'AT uses ellipsis instead of full phrase',
        evidence: ['adding a "…" to the AT instead of putting the whole phrase'],
        likely_layers: ['bp-assistant', 'bp-assistant-skills'],
      },
    ],
    ownership: {
      repositories: ['bp-assistant', 'bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: 'bp-assistant',
      rationale: 'Both layers are involved.',
    },
    issues: [
      {
        id: 'i1',
        repo: 'bp-assistant-skills',
        complaint_ids: ['c1'],
        title: 'Reduce split snippets in tn-writer output',
        body: '## Summary\n\nSkills issue.',
        labels: ['bug'],
      },
      {
        id: 'i2',
        repo: 'bp-assistant',
        complaint_ids: ['c2'],
        title: 'Audit AT post-processing for ellipsis regressions',
        body: '## Summary\n\nApp issue.',
        labels: ['bug'],
      },
    ],
  })));

  assert.equal(parsed.complaints.length, 2);
  assert.deepEqual(parsed.issues[0].complaint_ids, ['c1']);
  assert.deepEqual(parsed.issues[1].complaint_ids, ['c2']);
});

test('parseClassifierOutput accepts valid fenced JSON', () => {
  const payload = buildClassifierPayload({
    complaints: [{
      id: 'c1',
      summary: 'Template choice is wrong',
      evidence: ['uses the wrong template'],
      likely_layers: ['bp-assistant-skills'],
    }],
    ownership: {
      repositories: ['bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: null,
      rationale: 'Skill-side template behavior.',
    },
    issues: [{
      id: 'i1',
      repo: 'bp-assistant-skills',
      complaint_ids: ['c1'],
      title: 'Use the right template for generic nouns',
      body: '## Summary\n\nSkills issue.',
      labels: ['bug'],
    }],
  });

  const parsed = _parseClassifierOutput(wrapInJsonFence(JSON.stringify(payload)));
  assert.equal(parsed.complaints[0].id, 'c1');
  assert.equal(parsed.issues[0].repo, 'bp-assistant-skills');
});

test('issueReportPipeline retries classifier when JSON is truncated at max_tokens', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const payload = buildClassifierPayload({
    complaints: [{
      id: 'c1',
      summary: 'Split snippets still happen',
      evidence: ['still seeing a lot of split snippets'],
      likely_layers: ['bp-assistant-skills'],
    }],
    ownership: {
      repositories: ['bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: null,
      rationale: 'Skill-side formatting bug.',
    },
    issues: [{
      id: 'i1',
      repo: 'bp-assistant-skills',
      complaint_ids: ['c1'],
      title: 'Reduce split snippets in tn-writer output',
      body: '## Summary\n\nSkills issue.\n\n## Steps to Reproduce\n\n1. Run tn-writer.\n\n## Expected Behavior\n\nStable formatting.\n\n## Actual Behavior\n\nSplit snippets.\n\n## Reporter\n\nProof Reader',
      labels: ['bug'],
    }],
  });
  const runtime = {
    ...createRuntime({ classifierPayload: payload, fetchImpl, sentReplies, classifierInputs }),
    AnthropicClient: createAnthropicSequenceStub([
      {
        stop_reason: 'max_tokens',
        content: [{ text: '{\n  "complaints": [\n    { "id": "c1", "summary": "Split snippets still happen"' }],
      },
      {
        stop_reason: 'end_turn',
        content: [{ text: JSON.stringify(payload) }],
      },
    ], classifierInputs),
  };

  await issueReportPipeline({}, buildMessage({
    content: 'feedback: Split snippets still happen in Psalm 38.',
  }), runtime);

  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
  assert.equal(classifierInputs.length, 2);
});

test('issueReportPipeline retries classifier when fenced JSON is truncated at max_tokens', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const payload = buildClassifierPayload({
    complaints: [{
      id: 'c1',
      summary: 'Template choice is wrong',
      evidence: ['uses the wrong template'],
      likely_layers: ['bp-assistant-skills'],
    }],
    ownership: {
      repositories: ['bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: null,
      rationale: 'Skill-side template bug.',
    },
    issues: [{
      id: 'i1',
      repo: 'bp-assistant-skills',
      complaint_ids: ['c1'],
      title: 'Use genericnoun template for a man references',
      body: '## Summary\n\nSkills issue.\n\n## Steps to Reproduce\n\n1. Run tn-writer.\n\n## Expected Behavior\n\nCorrect template.\n\n## Actual Behavior\n\nWrong template.\n\n## Reporter\n\nProof Reader',
      labels: ['bug'],
    }],
  });
  const runtime = {
    ...createRuntime({ classifierPayload: payload, fetchImpl, sentReplies, classifierInputs }),
    AnthropicClient: createAnthropicSequenceStub([
      {
        stop_reason: 'max_tokens',
        content: [{ text: '```json\n{\n  "complaints": [\n    { "id": "c1", "summary": "Template choice is wrong",\n      "evidence"' }],
      },
      {
        stop_reason: 'end_turn',
        content: [{ text: wrapInJsonFence(JSON.stringify(payload)) }],
      },
    ], classifierInputs),
  };

  await issueReportPipeline({}, buildMessage({
    content: 'feedback: Use figs-genericnoun for "a man" instead of figs-gendernotations.',
  }), runtime);

  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
  assert.equal(classifierInputs.length, 2);
});

test('issueReportPipeline retries classifier when fenced JSON is truncated without max_tokens stop reason', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const payload = buildClassifierPayload({
    complaints: [{
      id: 'c1',
      summary: 'Template choice is wrong',
      evidence: ['uses the wrong template'],
      likely_layers: ['bp-assistant-skills'],
    }],
    ownership: {
      repositories: ['bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: null,
      rationale: 'Skill-side template bug.',
    },
    issues: [{
      id: 'i1',
      repo: 'bp-assistant-skills',
      complaint_ids: ['c1'],
      title: 'Use genericnoun template for a man references',
      body: '## Summary\n\nSkills issue.\n\n## Steps to Reproduce\n\n1. Run tn-writer.\n\n## Expected Behavior\n\nCorrect template.\n\n## Actual Behavior\n\nWrong template.\n\n## Reporter\n\nProof Reader',
      labels: ['bug'],
    }],
  });
  const runtime = {
    ...createRuntime({ classifierPayload: payload, fetchImpl, sentReplies, classifierInputs }),
    AnthropicClient: createAnthropicSequenceStub([
      {
        stop_reason: 'end_turn',
        content: [{ text: '```json\n{\n  "complaints": [\n    { "id": "c1", "summary": "Template choice is wrong",\n      "evidence"' }],
      },
      {
        stop_reason: 'end_turn',
        content: [{ text: wrapInJsonFence(JSON.stringify(payload)) }],
      },
    ], classifierInputs),
  };

  await issueReportPipeline({}, buildMessage({
    content: 'feedback: Use figs-genericnoun for "a man" instead of figs-gendernotations.',
  }), runtime);

  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
  assert.equal(classifierInputs.length, 2);
});

test('issueReportPipeline files a single bp-assistant issue', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [{
        id: 'c1',
        summary: 'The app passed the wrong context to Sonnet',
        evidence: ['The app passed the wrong context to Sonnet.'],
        likely_layers: ['bp-assistant'],
      }],
      ownership: {
        repositories: ['bp-assistant'],
        primary_repo: 'bp-assistant',
        secondary_repo: null,
        rationale: 'App-side orchestration bug.',
      },
      issues: [{
        id: 'i1',
        repo: 'bp-assistant',
        complaint_ids: ['c1'],
        title: 'Fix context packaging for report triage',
        body: '## Summary\n\nApp issue.\n\n## Steps to Reproduce\n\n1. Report it.\n\n## Expected Behavior\n\nGood routing.\n\n## Actual Behavior\n\nBad routing.\n\n## Reporter\n\nProof Reader',
        labels: ['bug', 'ai-quality'],
      }],
    }),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, buildMessage({
    content: 'report: The app passed the wrong context to Sonnet.',
  }), runtime);

  assert.equal(store.issues['bp-assistant'].length, 1);
  assert.equal(store.issues['bp-assistant-skills'].length, 0);
  assert.match(store.issues['bp-assistant'][0].body, /issue-report:4242:i1/);
  assert.match(sentReplies[0].text, /bp-assistant#1/);
  assert.match(classifierInputs[0], /The app passed the wrong context to Sonnet/);
});

test('issueReportPipeline summary uses repo names from live GitHub-shaped responses', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [{
        id: 'c1',
        summary: 'Summary said undefined instead of the repo name',
        evidence: ['Summary said undefined instead of the repo name.'],
        likely_layers: ['bp-assistant-skills'],
      }],
      ownership: {
        repositories: ['bp-assistant-skills'],
        primary_repo: 'bp-assistant-skills',
        secondary_repo: null,
        rationale: 'Skill-side formatting bug.',
      },
      issues: [{
        id: 'i1',
        repo: 'bp-assistant-skills',
        complaint_ids: ['c1'],
        title: 'Fix summary formatting for created issues',
        body: '## Summary\n\nSkills issue.\n\n## Steps to Reproduce\n\n1. Report it.\n\n## Expected Behavior\n\nRepo name in summary.\n\n## Actual Behavior\n\nUndefined repo in summary.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      }],
    }),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, buildMessage({
    content: 'feedback: Summary said undefined instead of the repo name.',
  }), runtime);

  assert.equal(sentReplies[0].text, 'Filed [**bp-assistant-skills#1**](https://github.com/unfoldingWord/bp-assistant-skills/issues/1).');
});

test('issueReportPipeline files a single bp-assistant-skills issue', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [{
        id: 'c1',
        summary: 'Split snippets and AT wording still look wrong',
        evidence: ['Split snippets and AT wording still look wrong.'],
        likely_layers: ['bp-assistant-skills'],
      }],
      ownership: {
        repositories: ['bp-assistant-skills'],
        primary_repo: 'bp-assistant-skills',
        secondary_repo: null,
        rationale: 'Skill-side formatting bug.',
      },
      issues: [{
        id: 'i1',
        repo: 'bp-assistant-skills',
        complaint_ids: ['c1'],
        title: 'Fix split snippet guidance in tn-writer',
        body: '## Summary\n\nSkills issue.\n\n## Steps to Reproduce\n\n1. Run tn-writer.\n\n## Expected Behavior\n\nStable formatting.\n\n## Actual Behavior\n\nSplit snippets.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      }],
    }),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, buildMessage({
    content: 'feedback: Split snippets and AT wording still look wrong.',
  }), runtime);

  assert.equal(store.issues['bp-assistant'].length, 0);
  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
});

test('issueReportPipeline creates dual linked issues for cross-repo reports', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [
        {
          id: 'c1',
          summary: 'Split snippets still happen',
          evidence: ['still seeing a lot of split snippets'],
          likely_layers: ['bp-assistant-skills'],
        },
        {
          id: 'c2',
          summary: 'AT uses ellipsis instead of the full phrase',
          evidence: ['adding a "…" to the AT instead of putting the whole phrase'],
          likely_layers: ['bp-assistant', 'bp-assistant-skills'],
        },
        {
          id: 'c3',
          summary: 'Abstract noun notes are merged across lines',
          evidence: ['combined abstractnoun notes that cover both lines'],
          likely_layers: ['bp-assistant-skills'],
        },
      ],
      ownership: {
        repositories: ['bp-assistant', 'bp-assistant-skills'],
        primary_repo: 'bp-assistant',
        secondary_repo: 'bp-assistant-skills',
        rationale: 'App packaging and skill behavior are both implicated.',
      },
      issues: [
        {
          id: 'i1',
          repo: 'bp-assistant',
          complaint_ids: ['c2'],
          title: 'Harden report triage ownership routing',
          body: '## Summary\n\nApp-side triage concern.\n\n## Steps to Reproduce\n\n1. Report Psalm 38 issue.\n\n## Expected Behavior\n\nCross-repo routing.\n\n## Actual Behavior\n\nOnly one repo gets filed.\n\n## Reporter\n\nProof Reader',
          labels: ['bug'],
        },
        {
          id: 'i2',
          repo: 'bp-assistant-skills',
          complaint_ids: ['c1'],
          title: 'Refine Psalm 38 split snippet guidance',
          body: '## Summary\n\nSkills-side formatting concern.\n\n## Steps to Reproduce\n\n1. Run tn-writer for Psalm 38.\n\n## Expected Behavior\n\nWhole phrase handling.\n\n## Actual Behavior\n\nEllipsis and split snippets.\n\n## Reporter\n\nProof Reader',
          labels: ['bug', 'ai-quality'],
        },
        {
          id: 'i3',
          repo: 'bp-assistant-skills',
          complaint_ids: ['c3'],
          title: 'Split abstract noun notes into separate line-level issues',
          body: '## Summary\n\nSkills-side note segmentation concern.\n\n## Steps to Reproduce\n\n1. Run tn-writer for Psalm 38.\n\n## Expected Behavior\n\nSeparate line-level notes.\n\n## Actual Behavior\n\nCombined abstract noun notes.\n\n## Reporter\n\nProof Reader',
          labels: ['bug'],
        },
      ],
    }),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, buildMessage({
    content: 'bug: Psalm 38 sometimes turns the full phrase into an ellipsis and still splits abstractnoun notes across lines.',
  }), runtime);

  assert.equal(store.issues['bp-assistant'].length, 1);
  assert.equal(store.issues['bp-assistant-skills'].length, 2);
  assert.equal(store.patches.length, 3);
  assert.match(store.issues['bp-assistant'][0].body, /## Related issue/);
  assert.match(store.issues['bp-assistant'][0].body, /bp-assistant-skills#1/);
  assert.match(store.issues['bp-assistant'][0].body, /bp-assistant-skills#2/);
  assert.match(store.issues['bp-assistant-skills'][0].body, /bp-assistant#1/);
  assert.match(sentReplies[0].text, /bp-assistant#1/);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
  assert.match(sentReplies[0].text, /bp-assistant-skills#2/);
});

test('issueReportPipeline reports invalid classifier JSON', async () => {
  const sentReplies = [];
  const runtime = {
    ...createRuntime({
      classifierPayload: null,
      fetchImpl: async () => { throw new Error('fetch should not run'); },
      sentReplies,
      classifierInputs: [],
    }),
    AnthropicClient: class AnthropicStub {
      constructor() {
        this.messages = {
          create: async () => ({ content: [{ text: '{not-json' }] }),
        };
      }
    },
  };

  await issueReportPipeline({}, buildMessage(), runtime);
  assert.match(sentReplies[0].text, /Classifier returned invalid JSON/);
});

test('issueReportPipeline rejects malformed ownership output', async () => {
  const sentReplies = [];
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [{
        id: 'c1',
        summary: 'Bad repo',
        evidence: ['bad repo'],
        likely_layers: ['bp-assistant'],
      }],
      ownership: {
        repositories: ['bp-assistant', 'totally-wrong-repo'],
        primary_repo: 'bp-assistant',
        secondary_repo: 'totally-wrong-repo',
      },
      issues: [{
        id: 'i1',
        repo: 'bp-assistant',
        complaint_ids: ['c1'],
        title: 'Title',
        body: '## Summary\n\nBody',
        labels: ['bug'],
      }],
    }),
    fetchImpl: async () => { throw new Error('fetch should not run'); },
    sentReplies,
    classifierInputs: [],
  });

  await issueReportPipeline({}, buildMessage(), runtime);
  assert.match(sentReplies[0].text, /Classifier returned invalid repositories/);
});

test('issueReportPipeline avoids duplicate issue creation after partial dual-repo failure and retry', async () => {
  const classifierPayload = buildClassifierPayload({
    complaints: [
      {
        id: 'c1',
        summary: 'Ellipses still appear',
        evidence: ['flips between ellipses'],
        likely_layers: ['bp-assistant'],
      },
      {
        id: 'c2',
        summary: 'Split snippets still happen',
        evidence: ['split snippets'],
        likely_layers: ['bp-assistant-skills'],
      },
    ],
    ownership: {
      repositories: ['bp-assistant', 'bp-assistant-skills'],
      primary_repo: 'bp-assistant',
      secondary_repo: 'bp-assistant-skills',
      rationale: 'Both repos are involved.',
    },
    issues: [
      {
        id: 'i1',
        repo: 'bp-assistant',
        complaint_ids: ['c1'],
        title: 'Harden report triage ownership routing',
        body: '## Summary\n\nApp-side triage concern.\n\n## Steps to Reproduce\n\n1. Report Psalm 38 issue.\n\n## Expected Behavior\n\nCross-repo routing.\n\n## Actual Behavior\n\nOnly one repo gets filed.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      },
      {
        id: 'i2',
        repo: 'bp-assistant-skills',
        complaint_ids: ['c2'],
        title: 'Refine Psalm 38 split snippet guidance',
        body: '## Summary\n\nSkills-side formatting concern.\n\n## Steps to Reproduce\n\n1. Run tn-writer for Psalm 38.\n\n## Expected Behavior\n\nWhole phrase handling.\n\n## Actual Behavior\n\nEllipsis and split snippets.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      },
    ],
  });
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub({ failNextPostForRepo: 'bp-assistant-skills' });
  const runtime = createRuntime({ classifierPayload, fetchImpl, sentReplies, classifierInputs });

  await issueReportPipeline({}, buildMessage({
    content: 'issue: Psalm 38 still flips between ellipses and split snippets.',
  }), runtime);
  assert.match(sentReplies[0].text, /Failed to file issue: GitHub API error 502/);
  assert.equal(store.postsByRepo['bp-assistant'], 1);
  assert.equal(store.postsByRepo['bp-assistant-skills'], 1);
  assert.equal(store.issues['bp-assistant'].length, 1);
  assert.equal(store.issues['bp-assistant-skills'].length, 0);

  await issueReportPipeline({}, buildMessage({
    content: 'issue: Psalm 38 still flips between ellipses and split snippets.',
  }), runtime);
  assert.equal(store.postsByRepo['bp-assistant'], 1);
  assert.equal(store.postsByRepo['bp-assistant-skills'], 2);
  assert.equal(store.issues['bp-assistant'].length, 1);
  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(store.issues['bp-assistant'][0].body, /bp-assistant-skills#1/);
});
