const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  issueReportPipeline,
  handlePendingHumanDecisionConflictReply,
  _extractFeedbackText,
  _buildClassifierInput,
  _parseClassifierOutput,
  _clearPendingHumanDecisionConflict,
} = require('../src/issue-report-pipeline');
const {
  findHumanDecisionConflict,
  formatDecisionConflictPrompt,
  loadHumanDecisions,
  summarizePriorDecision,
  summarizeHumanFeedback,
} = require('../src/human-decision-conflicts');

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

function wrapInJsonFence(text) {
  return `\`\`\`json\n${text}\n\`\`\``;
}

function buildClassifierResult(payload) {
  return {
    raw: JSON.stringify(payload),
    stopReason: 'end_turn',
  };
}

function createEmptySkillsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-empty-skills-'));
  fs.mkdirSync(path.join(root, 'data/quick-ref'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data/glossary'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/quick-ref/ult_decisions.csv'), 'Strong,Hebrew,Rendering,Book,Context,Notes,Date,Source\n');
  fs.writeFileSync(path.join(root, 'data/quick-ref/ust_decisions.csv'), 'Strong,Hebrew,Rendering,Book,Context,Notes,Date,Source\n');
  fs.writeFileSync(path.join(root, 'data/glossary/project_glossary.md'), '');
  return root;
}

function createRuntime({ classifierPayload, fetchImpl, sentReplies, classifierInputs }) {
  return {
    skillsRoot: createEmptySkillsRoot(),
    runClassifierQuery: async ({ classifierInput }) => {
      classifierInputs.push(classifierInput);
      return buildClassifierResult(classifierPayload);
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
      if (name === 'anthropic_api_key') throw new Error('anthropic_api_key should not be read');
      if (name === 'github_token') return 'github-test-token';
      return null;
    },
    fetchImpl,
  };
}

function createClassifierSequenceStub(responses, classifierInputs) {
  let index = 0;
  return async ({ classifierInput }) => {
    classifierInputs.push(classifierInput);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
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

function createSkillsRoot({ withAttribution = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-skills-decisions-'));
  fs.mkdirSync(path.join(root, 'data/quick-ref'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data/glossary'), { recursive: true });
  const notes = withAttribution
    ? '"Never \'Yahweh of hosts\'. Always \'Yahweh of Armies\'. Submitted by: Chris Smith."'
    : '"Never \'Yahweh of hosts\' (archaic). Always \'Yahweh of Armies\'. See H6635b entry."';
  fs.writeFileSync(path.join(root, 'data/quick-ref/ult_decisions.csv'), [
    'Strong,Hebrew,Rendering,Book,Context,Notes,Date,Source',
    `H3068+H6635,יְהוָה צְבָאוֹת,Yahweh of Armies,ALL,divine title throughout Isaiah,${notes},2026-04-21,human`,
    'H9999,דמה,unrelated,ALL,unrelated,AI-only row,2026-04-21,AI',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'data/quick-ref/ust_decisions.csv'), 'Strong,Hebrew,Rendering,Book,Context,Notes,Date,Source\n');
  fs.writeFileSync(path.join(root, 'data/glossary/project_glossary.md'), [
    '| Hebrew | Strong | ULT | UST | Notes |',
    '|---|---|---|---|---|',
    '| צְבָאוֹת | H6635 | armies | hosts | ULT: "Yahweh of Armies" (not "hosts"). |',
  ].join('\n'));
  return root;
}

function buildJeremiahHostsPayload() {
  return buildClassifierPayload({
    complaints: [{
      id: 'c1',
      summary: 'Jeremiah notes should use Yahweh of hosts',
      evidence: ['Please use Yahweh of hosts in Jeremiah notes.'],
      likely_layers: ['bp-assistant-skills'],
    }],
    ownership: {
      repositories: ['bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: null,
      rationale: 'Skill-side translation preference.',
    },
    issues: [{
      id: 'i1',
      repo: 'bp-assistant-skills',
      complaint_ids: ['c1'],
      title: 'Use Yahweh of hosts in Jeremiah notes',
      body: '## Summary\n\nJeremiah notes should use Yahweh of hosts instead of Yahweh of Armies.\n\n## Steps to Reproduce\n\n1. Run tn-writer for Jeremiah.\n\n## Expected Behavior\n\nUse Yahweh of hosts.\n\n## Actual Behavior\n\nUses Yahweh of Armies.\n\n## Reporter\n\nProof Reader',
      labels: ['bug'],
    }],
  });
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

test('parseClassifierOutput keeps atomic complaints and repo-scoped issues', () => {
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

test('human decision conflict parser detects rejected Yahweh of hosts preference', async () => {
  const skillsRoot = createSkillsRoot();
  const decisions = loadHumanDecisions(skillsRoot);
  assert.ok(decisions.some((decision) => decision.strong === 'H3068+H6635' && decision.source === 'human'));
  assert.ok(decisions.every((decision) => decision.rendering !== 'unrelated'));

  const conflict = await findHumanDecisionConflict({
    message: buildMessage({ subject: 'Jeremiah BP' }),
    feedbackText: 'Please use Yahweh of hosts in Jeremiah notes.',
    classified: buildJeremiahHostsPayload(),
    skillsRoot,
  });

  assert.equal(conflict.decision.strong, 'H3068+H6635');
  assert.equal(conflict.decision.date, '2026-04-21');
  assert.equal(conflict.feedbackSummary, 'Jeremiah notes should use Yahweh of hosts');
  assert.match(formatDecisionConflictPrompt(conflict), /^This conflicts with a human decision recorded on April 21\./);
  assert.match(formatDecisionConflictPrompt(conflict), /Feedback summary: Jeremiah notes should use Yahweh of hosts/);
  assert.match(formatDecisionConflictPrompt(conflict), /Prior decision: H3068\+H6635 \/ יְהוָה צְבָאוֹת: use "Yahweh of Armies"\. Never 'Yahweh of hosts'/);
});

test('human decision conflict prompt uses submitter when decision notes contain one', async () => {
  const skillsRoot = createSkillsRoot({ withAttribution: true });
  const conflict = await findHumanDecisionConflict({
    message: buildMessage({ subject: 'Jeremiah BP' }),
    feedbackText: 'Please use Yahweh of hosts in Jeremiah notes.',
    classified: buildJeremiahHostsPayload(),
    skillsRoot,
  });

  assert.match(formatDecisionConflictPrompt(conflict), /submitted by Chris Smith on April 21/);
});

test('summarizeHumanFeedback prefers classifier complaint summary and normalizes capitalization', () => {
  const summary = summarizeHumanFeedback({
    feedbackText: 'please use rescue for hiphils of H5337',
    classified: {
      complaints: [{ summary: 'use rescue for Hiphil forms of H5337' }],
      issues: [{ title: 'Fallback title' }],
    },
  });

  assert.equal(summary, 'Use rescue for Hiphil forms of H5337');
});

test('summarizePriorDecision includes rendering scope and notes', () => {
  const summary = summarizePriorDecision({
    strong: 'H5337',
    hebrew: 'נָצַל',
    rendering: 'deliver',
    book: 'ALL',
    notes: "Project preference: 'deliver' not 'rescue' for נצל Hiphil. Editor ISA 47:14.",
  });

  assert.equal(
    summary,
    "H5337 / נָצַל: use \"deliver\". Project preference: 'deliver' not 'rescue' for נצל Hiphil. Editor ISA 47:14."
  );
});

test('issueReportPipeline pauses skills issue when feedback conflicts with human decision', async () => {
  const message = buildMessage({
    subject: 'Jeremiah BP',
    content: 'feedback: Please use Yahweh of hosts in Jeremiah notes.',
  });
  _clearPendingHumanDecisionConflict(message);
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildJeremiahHostsPayload(),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, message, { ...runtime, skillsRoot: createSkillsRoot() });

  assert.equal(store.issues['bp-assistant-skills'].length, 0);
  assert.equal(store.postsByRepo['bp-assistant-skills'], 0);
  assert.match(sentReplies[0].text, /^This conflicts with a human decision recorded on April 21\./);
  assert.match(sentReplies[0].text, /Feedback summary: Jeremiah notes should use Yahweh of hosts/);
  assert.match(sentReplies[0].text, /Do you still wish to file this feedback \(yes\/no\)\?/);
  _clearPendingHumanDecisionConflict(message);
});

test('confirmed human-decision conflict files issue with conflict section and markers', async () => {
  const message = buildMessage({
    subject: 'Jeremiah BP',
    content: 'feedback: Please use Yahweh of hosts in Jeremiah notes.',
  });
  _clearPendingHumanDecisionConflict(message);
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildJeremiahHostsPayload(),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, message, { ...runtime, skillsRoot: createSkillsRoot() });
  const handled = await handlePendingHumanDecisionConflictReply(
    buildMessage({ ...message, content: 'yes', id: 5000 }),
    {
      isYes: (content) => /^yes$/i.test(String(content).trim()),
      isNo: (content) => /^no$/i.test(String(content).trim()),
    },
    runtime
  );

  assert.equal(handled, true);
  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.match(store.issues['bp-assistant-skills'][0].body, /## Conflicts with prior human decision/);
  assert.match(store.issues['bp-assistant-skills'][0].body, /issue-report:4242:i1/);
  assert.match(store.issues['bp-assistant-skills'][0].body, /issue-report:4242:bp-assistant-skills:c1/);
  assert.match(sentReplies[1].text, /Filed \[\*\*bp-assistant-skills#1\*\*\]/);
});

test('declined human-decision conflict clears pending report without filing', async () => {
  const message = buildMessage({
    subject: 'Jeremiah BP',
    content: 'feedback: Please use Yahweh of hosts in Jeremiah notes.',
  });
  _clearPendingHumanDecisionConflict(message);
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const runtime = createRuntime({
    classifierPayload: buildJeremiahHostsPayload(),
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  await issueReportPipeline({}, message, { ...runtime, skillsRoot: createSkillsRoot() });
  const handled = await handlePendingHumanDecisionConflictReply(
    buildMessage({ ...message, content: 'no', id: 5001 }),
    {
      isYes: (content) => /^yes$/i.test(String(content).trim()),
      isNo: (content) => /^no$/i.test(String(content).trim()),
    },
    runtime
  );

  assert.equal(handled, true);
  assert.equal(store.issues['bp-assistant-skills'].length, 0);
  assert.equal(store.postsByRepo['bp-assistant-skills'], 0);
  assert.equal(sentReplies[1].text, 'No issue filed.');
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
    runClassifierQuery: createClassifierSequenceStub([
      {
        stopReason: 'max_tokens',
        raw: '{\n  "complaints": [\n    { "id": "c1", "summary": "Split snippets still happen"',
      },
      {
        stopReason: 'end_turn',
        raw: JSON.stringify(payload),
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
    runClassifierQuery: createClassifierSequenceStub([
      {
        stopReason: 'max_tokens',
        raw: '```json\n{\n  "complaints": [\n    { "id": "c1", "summary": "Template choice is wrong",\n      "evidence"',
      },
      {
        stopReason: 'end_turn',
        raw: wrapInJsonFence(JSON.stringify(payload)),
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
    runClassifierQuery: createClassifierSequenceStub([
      {
        stopReason: 'end_turn',
        raw: '```json\n{\n  "complaints": [\n    { "id": "c1", "summary": "Template choice is wrong",\n      "evidence"',
      },
      {
        stopReason: 'end_turn',
        raw: wrapInJsonFence(JSON.stringify(payload)),
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
          complaint_ids: ['c1', 'c3'],
          title: 'Refine Psalm 38 tn-writing and note splitting behavior',
          body: '## Summary\n\nSkills-side formatting and note segmentation concern.\n\n## Steps to Reproduce\n\n1. Run tn-writer for Psalm 38.\n\n## Expected Behavior\n\nWhole phrase handling and separate line-level notes.\n\n## Actual Behavior\n\nEllipsis, split snippets, and combined abstract noun notes.\n\n## Reporter\n\nProof Reader',
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
  assert.equal(store.issues['bp-assistant-skills'].length, 1);
  assert.equal(store.patches.length, 2);
  assert.match(store.issues['bp-assistant'][0].body, /## Related issue/);
  assert.match(store.issues['bp-assistant'][0].body, /bp-assistant-skills#1/);
  assert.match(store.issues['bp-assistant-skills'][0].body, /bp-assistant#1/);
  assert.match(sentReplies[0].text, /bp-assistant#1/);
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/);
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
    runClassifierQuery: async () => ({ raw: '{not-json', stopReason: 'end_turn' }),
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

test('issueReportPipeline rejects multiple issues for the same repo in one report', async () => {
  const sentReplies = [];
  const runtime = createRuntime({
    classifierPayload: buildClassifierPayload({
      complaints: [
        {
          id: 'c1',
          summary: 'Split snippets still happen',
          evidence: ['split snippets'],
          likely_layers: ['bp-assistant-skills'],
        },
        {
          id: 'c2',
          summary: 'Abstract noun notes stay merged',
          evidence: ['combined abstractnoun notes'],
          likely_layers: ['bp-assistant-skills'],
        },
      ],
      ownership: {
        repositories: ['bp-assistant-skills'],
        primary_repo: 'bp-assistant-skills',
        secondary_repo: null,
        rationale: 'Skills repo only.',
      },
      issues: [
        {
          id: 'i1',
          repo: 'bp-assistant-skills',
          complaint_ids: ['c1'],
          title: 'Refine split snippet guidance',
          body: '## Summary\n\nSkills issue.',
          labels: ['bug'],
        },
        {
          id: 'i2',
          repo: 'bp-assistant-skills',
          complaint_ids: ['c2'],
          title: 'Split abstract noun notes per line',
          body: '## Summary\n\nSkills issue.',
          labels: ['bug'],
        },
      ],
    }),
    fetchImpl: async () => { throw new Error('fetch should not run'); },
    sentReplies,
    classifierInputs: [],
  });

  await issueReportPipeline({}, buildMessage(), runtime);
  assert.match(sentReplies[0].text, /Classifier returned multiple issues for repo bp-assistant-skills/);
});

test('issueReportPipeline avoids duplicate issue creation after partial dual-repo failure and retry', async () => {
  const firstClassifierPayload = buildClassifierPayload({
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
  const secondClassifierPayload = buildClassifierPayload({
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
        id: 'i9',
        repo: 'bp-assistant',
        complaint_ids: ['c1'],
        title: 'Harden report triage ownership routing',
        body: '## Summary\n\nApp-side triage concern.\n\n## Steps to Reproduce\n\n1. Report Psalm 38 issue.\n\n## Expected Behavior\n\nCross-repo routing.\n\n## Actual Behavior\n\nOnly one repo gets filed.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      },
      {
        id: 'i8',
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
  const runtime = createRuntime({
    classifierPayload: firstClassifierPayload,
    fetchImpl,
    sentReplies,
    classifierInputs,
  });
  runtime.runClassifierQuery = createClassifierSequenceStub([
    {
      stopReason: 'end_turn',
      raw: JSON.stringify(firstClassifierPayload),
    },
    {
      stopReason: 'end_turn',
      raw: JSON.stringify(secondClassifierPayload),
    },
  ], classifierInputs);

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
  assert.equal(classifierInputs.length, 2);
});

// Psalm 38 regression: real proofreader feedback that spans both repos.
// The classifier is mocked to return dual ownership — this test asserts the
// pipeline correctly opens two linked issues, NOT just one skills-only issue.
test('Psalm 38 regression: dual-ownership report opens two cross-linked issues', async () => {
  const classifierInputs = [];
  const sentReplies = [];
  const { fetchImpl, store } = createGithubFetchStub();
  const dualOwnershipPayload = buildClassifierPayload({
    complaints: [
      {
        id: 'c1',
        summary: 'AT output falls back to an ellipsis instead of the full phrase',
        evidence: ['adding a "…" to the AT instead of putting the whole phrase'],
        likely_layers: ['bp-assistant', 'bp-assistant-skills'],
      },
      {
        id: 'c2',
        summary: 'Split snippets still appear',
        evidence: ['still seeing a lot of split snippets'],
        likely_layers: ['bp-assistant-skills'],
      },
      {
        id: 'c3',
        summary: 'Abstract noun notes are merged across both lines',
        evidence: ['combined abstractnoun notes that cover both lines instead of a note for each line'],
        likely_layers: ['bp-assistant-skills'],
      },
    ],
    ownership: {
      repositories: ['bp-assistant', 'bp-assistant-skills'],
      primary_repo: 'bp-assistant-skills',
      secondary_repo: 'bp-assistant',
      rationale: 'The note-writing symptoms are skill-facing, but app-side context shaping or post-processing could also explain the ellipsis behavior.',
    },
    issues: [
      {
        id: 'i1',
        repo: 'bp-assistant-skills',
        complaint_ids: ['c1', 'c2', 'c3'],
        title: 'Refine Psalm 38 note splitting and AT phrase handling',
        body: '## Summary\n\nPsalm 38 output still splits snippets, uses an ellipsis in the AT, and merges abstract noun notes across both lines.\n\n## Steps to Reproduce\n\n1. Run tn-writer on Psalm 38 content matching the reported case.\n\n## Expected Behavior\n\nWhole-phrase AT output, stable snippets, and one abstract noun note per line.\n\n## Actual Behavior\n\nThe AI sometimes inserts an ellipsis in the AT, still splits snippets, and combines abstract noun notes across lines.\n\n## Reporter\n\nProof Reader',
        labels: ['bug', 'ai-quality'],
      },
      {
        id: 'i2',
        repo: 'bp-assistant',
        complaint_ids: ['c1'],
        title: 'Audit Psalm 38 AT post-processing and report context shaping',
        body: '## Summary\n\nThe Psalm 38 report may reflect app-side context packaging, preprocessing, or post-processing that turns a full phrase into an ellipsis before the final note is posted.\n\n## Steps to Reproduce\n\n1. Submit the reported Psalm 38 feedback through the explicit report flow.\n\n## Expected Behavior\n\nThe bot should preserve enough context for triage and avoid introducing AT ellipsis regressions.\n\n## Actual Behavior\n\nThe report plausibly points to app-side context shaping or post-processing around the generated note.\n\n## Reporter\n\nProof Reader',
        labels: ['bug'],
      },
    ],
  });
  const runtime = createRuntime({
    classifierPayload: dualOwnershipPayload,
    fetchImpl,
    sentReplies,
    classifierInputs,
  });

  const psalm38Report = `bug: Noticing an interesting change in Ps38 - while the snippet now sometimes (not always - still seeing a lot of split snippets!) includes everything in between so as not to use an "&" in the quote field, now it's adding a "…" to the AT instead of putting the whole phrase! ... there are still a LOT of combined abstractnoun notes that cover both lines instead of a note for each line - I'll split them apart but would save me a ton of time if the AI would do that.`;

  await issueReportPipeline({}, buildMessage({
    content: psalm38Report,
  }), runtime);

  // Core regression: dual ownership must produce two issues, not skills-only.
  assert.equal(dualOwnershipPayload.ownership.repositories.length, 2, 'ownership.repositories must have 2 entries');
  assert.equal(store.issues['bp-assistant'].length, 1, 'app issue created');
  assert.equal(store.issues['bp-assistant-skills'].length, 1, 'skills issue created');

  // Reciprocal cross-links must be present.
  assert.match(store.issues['bp-assistant-skills'][0].body, /## Related issue/, 'skills issue has Related issue section');
  assert.match(store.issues['bp-assistant-skills'][0].body, /bp-assistant#1/, 'skills issue links to app issue');
  assert.match(store.issues['bp-assistant'][0].body, /bp-assistant-skills#1/, 'app issue links to skills issue');

  // Classifier received the sample text with reporter and stream context.
  assert.match(classifierInputs[0], /Ps38/, 'classifier received Ps38 reference');
  assert.match(classifierInputs[0], /split snippets/, 'classifier received split snippets text');
  assert.match(classifierInputs[0], /abstractnoun notes/, 'classifier received abstractnoun notes text');
  assert.match(classifierInputs[0], /Reporter: Proof Reader/, 'classifier received reporter name');
  assert.match(classifierInputs[0], /Stream: BP Proofreading/, 'classifier received stream context');

  // Reply mentions both issue URLs.
  assert.match(sentReplies[0].text, /bp-assistant#1/, 'reply mentions app issue');
  assert.match(sentReplies[0].text, /bp-assistant-skills#1/, 'reply mentions skills issue');
});
