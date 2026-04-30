'use strict';

const GITHUB_ORG = 'unfoldingWord';

function buildGithubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function searchExistingIssue(fetchImpl, token, repo, marker) {
  const query = encodeURIComponent(`repo:${GITHUB_ORG}/${repo} "${marker}" type:issue`);
  const response = await fetchImpl(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
    headers: buildGithubHeaders(token),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GitHub search error ${response.status}: ${err.slice(0, 200)}`);
  }
  const payload = await response.json();
  const issue = payload.items?.[0] || null;
  return issue ? { ...issue, repo } : null;
}

async function searchExistingIssueByMarkers(fetchImpl, token, repo, markers) {
  for (const marker of markers) {
    const existing = await searchExistingIssue(fetchImpl, token, repo, marker);
    if (existing) return existing;
  }
  return null;
}

async function createGithubIssue(fetchImpl, token, repo, payload) {
  const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_ORG}/${repo}/issues`, {
    method: 'POST',
    headers: buildGithubHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const issue = await response.json();
  return { ...issue, repo };
}

async function updateGithubIssue(fetchImpl, token, repo, issueNumber, payload) {
  const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_ORG}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: buildGithubHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${err.slice(0, 200)}`);
  }
  const issue = await response.json();
  return { ...issue, repo };
}

module.exports = {
  GITHUB_ORG,
  buildGithubHeaders,
  searchExistingIssue,
  searchExistingIssueByMarkers,
  createGithubIssue,
  updateGithubIssue,
};
