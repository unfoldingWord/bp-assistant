const { execFileSync } = require('child_process');
const path = require('path');

const DEFAULT_BP_BOT_HOME = '/home/ubuntu/bp-bot';
const DEFAULT_WORKTREE_ROOT = '/tmp/bp-bot-worktrees';

const ISSUE_REPO_SPECS = [
  {
    slug: 'unfoldingWord/bp-assistant',
    envVar: 'BP_APP_REPO',
    defaultPath: `${DEFAULT_BP_BOT_HOME}/bp-assistant`,
    repoKey: 'app',
    worktreePrefix: 'fix-app',
  },
  {
    slug: 'unfoldingWord/bp-assistant-skills',
    envVar: 'BP_SKILLS_REPO',
    defaultPath: `${DEFAULT_BP_BOT_HOME}/bp-assistant-skills`,
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

const AUTHORITATIVE_ISSUE_OPENERS = new Set(['deferredreward']);
const AUTHORITATIVE_DEFER_USERS = new Set(['deferredreward']);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getWorktreeRoot(env = process.env) {
  return normalizeWhitespace(env.BP_WORKTREE_ROOT || DEFAULT_WORKTREE_ROOT) || DEFAULT_WORKTREE_ROOT;
}

function getIssueRepos(env = process.env) {
  return ISSUE_REPO_SPECS.map((repoConfig) => ({
    slug: repoConfig.slug,
    localPath: normalizeWhitespace(env[repoConfig.envVar] || repoConfig.defaultPath) || repoConfig.defaultPath,
    repoKey: repoConfig.repoKey,
    worktreePrefix: repoConfig.worktreePrefix,
  }));
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
  const openerLogin = String(issue?.user?.login || '').trim();

  if (!AUTHORITATIVE_ISSUE_OPENERS.has(openerLogin)) {
    reasons.push(`author:${openerLogin || 'unknown'}:not-authoritative-opener`);
  }

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

function toCandidate(issue, repoConfig, env = process.env) {
  const issueNumber = Number(issue.number);
  const comments = Array.isArray(issue.commentsData) ? issue.commentsData : [];
  const worktreeRoot = getWorktreeRoot(env);
  return {
    repo: repoConfig.slug,
    repoKey: repoConfig.repoKey,
    issueNumber,
    title: String(issue.title || '').trim(),
    body: String(issue.body || ''),
    opener: String(issue?.user?.login || ''),
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
    worktreePath: path.join(worktreeRoot, `${repoConfig.worktreePrefix}-${issueNumber}`),
    skipReasons: collectSkipReasons(issue),
  };
}

function selectNightlyFixIssues(issuesByRepo, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  const candidates = [];
  const skipped = [];
  const repoConfigs = Array.isArray(options.repoConfigs) ? options.repoConfigs : getIssueRepos(options.env);

  for (const repoConfig of repoConfigs) {
    const issues = Array.isArray(issuesByRepo[repoConfig.slug]) ? issuesByRepo[repoConfig.slug] : [];
    for (const issue of issues) {
      const candidate = toCandidate(issue, repoConfig, options.env);
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
    selected: limit ? candidates.slice(0, limit) : candidates.slice(),
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
  const repoConfigs = getIssueRepos();

  for (const repoConfig of repoConfigs) {
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
  DEFAULT_BP_BOT_HOME,
  DEFAULT_WORKTREE_ROOT,
  ISSUE_REPO_SPECS,
  collectSkipReasons,
  fetchNightlyFixIssues,
  getIssueRepos,
  getWorktreeRoot,
  selectNightlyFixIssues,
  textMatchesSkip,
};
