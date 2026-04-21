const { execFileSync } = require('child_process');

const ISSUE_REPOS = [
  {
    slug: 'unfoldingWord/bp-assistant',
    localPath: '/srv/bot/app',
    repoKey: 'app',
    worktreePrefix: 'fix-app',
  },
  {
    slug: 'unfoldingWord/bp-assistant-skills',
    localPath: '/srv/bot/workspace',
    repoKey: 'workspace',
    worktreePrefix: 'fix-ws',
  },
];

const SKIP_LABEL_PATTERNS = [
  /\bblocked\b/i,
  /\bneeds[\s-]*design\b/i,
  /\binvalid\b/i,
  /\bqa[\s/:-]*retest\b/i,
  /\bwip\b/i,
  /\bwork[\s-]*in[\s-]*progress\b/i,
];

const SKIP_TEXT_PATTERNS = [
  /\bnot yet\b/i,
  /\bwait\b/i,
  /\bhold off\b/i,
  /\bdefer(?:red|ring)?\b/i,
  /\bneed more feedback\b/i,
  /\bdon['’]?t work\b/i,
  /\bdo not work\b/i,
  /\bdon['’]?t fix\b/i,
  /\bdo not fix\b/i,
  /\bnot sure this is actually true\b/i,
  /\bretest\b/i,
];

const AUTHORITATIVE_DEFER_USERS = new Set(['deferredreward']);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function labelMatchesSkip(name) {
  const text = normalizeWhitespace(name);
  return SKIP_LABEL_PATTERNS.some((pattern) => pattern.test(text));
}

function textMatchesSkip(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return false;
  return SKIP_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectSkipReasons(issue) {
  const reasons = [];
  const labels = Array.isArray(issue.labels) ? issue.labels : [];

  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (labelMatchesSkip(name)) {
      reasons.push(`label:${normalizeWhitespace(name)}`);
    }
  }

  if (textMatchesSkip(issue.title)) reasons.push('title:text-signal');
  if (textMatchesSkip(issue.body)) reasons.push('body:text-signal');

  const comments = Array.isArray(issue.commentsData) ? issue.commentsData : [];
  for (const comment of comments) {
    if (!textMatchesSkip(comment?.body)) continue;
    const login = String(comment?.user?.login || '').trim();
    if (AUTHORITATIVE_DEFER_USERS.has(login)) {
      reasons.push(`comment:${login}:authoritative-defer`);
      continue;
    }
    reasons.push(`comment:${login || 'unknown'}:text-signal`);
  }

  return Array.from(new Set(reasons));
}

function toCandidate(issue, repoConfig) {
  const issueNumber = Number(issue.number);
  const comments = Array.isArray(issue.commentsData) ? issue.commentsData : [];
  return {
    repo: repoConfig.slug,
    repoKey: repoConfig.repoKey,
    issueNumber,
    title: String(issue.title || '').trim(),
    body: String(issue.body || ''),
    htmlUrl: issue.html_url || `https://github.com/${repoConfig.slug}/issues/${issueNumber}`,
    labels: (issue.labels || []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean),
    comments: comments.map((comment) => ({
      user: String(comment?.user?.login || ''),
      body: String(comment?.body || ''),
      createdAt: comment?.created_at || null,
    })),
    localPath: repoConfig.localPath,
    worktreePrefix: repoConfig.worktreePrefix,
    branchName: `fix/issue-${issueNumber}`,
    worktreePath: `/tmp/${repoConfig.worktreePrefix}-${issueNumber}`,
    skipReasons: collectSkipReasons(issue),
  };
}

function selectNightlyFixIssues(issuesByRepo, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 3;
  const candidates = [];
  const skipped = [];

  for (const repoConfig of ISSUE_REPOS) {
    const issues = Array.isArray(issuesByRepo[repoConfig.slug]) ? issuesByRepo[repoConfig.slug] : [];
    for (const issue of issues) {
      const candidate = toCandidate(issue, repoConfig);
      if (candidate.skipReasons.length) {
        skipped.push(candidate);
      } else {
        candidates.push(candidate);
      }
    }
  }

  const compare = (a, b) => {
    const repoCmp = a.repo.localeCompare(b.repo);
    if (repoCmp !== 0) return repoCmp;
    return a.issueNumber - b.issueNumber;
  };

  candidates.sort(compare);
  skipped.sort(compare);

  return {
    selected: candidates.slice(0, limit),
    candidates,
    skipped,
  };
}

function ghApi(pathname) {
  const output = execFileSync('gh', ['api', pathname], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function fetchOpenIssuesForRepo(repoSlug) {
  return ghApi(`repos/${repoSlug}/issues?state=open&per_page=100`);
}

function fetchIssueComments(repoSlug, issueNumber) {
  return ghApi(`repos/${repoSlug}/issues/${issueNumber}/comments`);
}

function fetchNightlyFixIssues() {
  const issuesByRepo = {};

  for (const repoConfig of ISSUE_REPOS) {
    const issues = fetchOpenIssuesForRepo(repoConfig.slug)
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        ...issue,
        commentsData: fetchIssueComments(repoConfig.slug, issue.number),
      }));
    issuesByRepo[repoConfig.slug] = issues;
  }

  return issuesByRepo;
}

module.exports = {
  AUTHORITATIVE_DEFER_USERS,
  ISSUE_REPOS,
  collectSkipReasons,
  fetchNightlyFixIssues,
  selectNightlyFixIssues,
  textMatchesSkip,
};
