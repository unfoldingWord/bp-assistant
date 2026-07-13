// article-resolver.js — normalize an article NAME or a Door43 URL into a
// concrete set of (path, sourceMarkdown) files for the translate pipeline.
//
// Mirrors PIPELINE-SPEC §2.1's `articles` envelope; the id round-trip is
// path-keyed (the article's in-repo path is its stable identity).
//
// Input forms (per the product ask):
//   (a) a unique article name/identifier
//         tW: "kt/god"  |  "god" (probed across bible/{kt,names,other})  |  "bible/kt/god"
//         tA: "figs-aside" (probed across manuals)  |  "translate/figs-aside"
//   (b) a Door43 URL to the markdown file(s)
//         tW: .../src/branch/master/bible/kt/god.md            → 1 file
//         tA: .../src/branch/master/translate/figs-aside       → folder → its .md files
//         tA: .../src/branch/master/translate/figs-aside/01.md → that 1 file
//
// Layouts (verified live 2026-07-13):
//   tW  bible/{kt|names|other}/{term}.md            (one file per term)
//   tA  {translate|checking|process|intro}/{article}/*.md  (title.md, sub-title.md, 01.md, ...)
//
// Directory listing uses the Gitea contents API (the raw HTML folder view is
// behind bot-protection); file bodies use the raw endpoint.

'use strict';

const DCS_BASE = 'https://git.door43.org';
const TW_CATEGORIES = ['kt', 'names', 'other'];
const TA_MANUALS = ['translate', 'checking', 'process', 'intro'];

/** Parse "org/repo@ref" (ref = branch name or 40-hex commit SHA). */
function parseRepoRef(ref) {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(ref || '').trim());
  if (!m) throw new Error(`sourceRef must be "org/repo@ref", got: ${ref}`);
  return { org: m[1], repo: m[2], ref: m[3] };
}

function refKind(ref) {
  return /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch';
}

function rawUrl({ org, repo, ref }, filePath) {
  return `${DCS_BASE}/${org}/${repo}/raw/${refKind(ref)}/${encodeURIComponent(ref)}/${filePath}`;
}

/** Fetch a raw file; null on 404, throw on other non-OK. */
async function fetchRaw(loc, filePath, fetchImpl) {
  const res = await (fetchImpl || fetch)(rawUrl(loc, filePath));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${rawUrl(loc, filePath)} → HTTP ${res.status}`);
  return await res.text();
}

/**
 * List a directory's .md files via the Gitea contents API.
 * Returns array of in-repo paths, or null if the directory is absent (404).
 */
async function listMarkdownFiles(loc, dir, fetchImpl) {
  const url = `${DCS_BASE}/api/v1/repos/${loc.org}/${loc.repo}/contents/${dir}`
    + `?ref=${encodeURIComponent(loc.ref)}`;
  const res = await (fetchImpl || fetch)(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`contents API ${url} → HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) return null;
  return body
    .filter((e) => e && e.type === 'file' && typeof e.path === 'string' && e.path.endsWith('.md'))
    .map((e) => e.path)
    .sort(); // deterministic order (01.md, sub-title.md, title.md)
}

/**
 * Parse a Door43 web/raw URL into { org, repo, ref, path }.
 * Handles .../{src|raw|media}/{branch|commit|tag}/{ref}/{path...}.
 */
function parseDoor43Url(url) {
  const m = /^https?:\/\/git\.door43\.org\/([^/]+)\/([^/]+)\/(?:src|raw|media)\/(?:branch|commit|tag)\/([^/]+)\/(.+?)\/?$/.exec(String(url).trim());
  if (!m) throw new Error(`unrecognized Door43 URL: ${url}`);
  return { org: m[1], repo: m[2], ref: decodeURIComponent(m[3]), path: m[4] };
}

/**
 * Reject an in-repo path that could escape the staging dir or the cloned repo
 * when written (path traversal). Article paths are derived from caller-supplied
 * names/URLs and later fed to fs.copyFileSync(repoDir + path), so they must be
 * plain relative POSIX paths — no absolute paths, no `.`/`..` segments.
 */
function assertSafeRepoPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`unsafe article path (absolute): ${p}`);
  }
  if (norm.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`unsafe article path (traversal): ${p}`);
  }
  return norm;
}

/** Fetch several file bodies in parallel, preserving `paths` order; skip 404s. */
async function fetchFiles(loc, paths, fetchImpl) {
  paths.forEach(assertSafeRepoPath);
  const bodies = await Promise.all(paths.map((p) => fetchRaw(loc, p, fetchImpl)));
  const files = [];
  paths.forEach((p, i) => { if (bodies[i] != null) files.push({ path: p, sourceMarkdown: bodies[i] }); });
  return files;
}

/** tW: normalize a name to an in-repo path list (single file). */
async function resolveTwByName(loc, name, fetchImpl) {
  let rel = String(name).trim().replace(/\.md$/i, '');
  rel = rel.replace(/^bible\//i, ''); // accept "bible/kt/god" too
  if (rel.includes('/')) {
    const path = assertSafeRepoPath(`bible/${rel}.md`);
    const md = await fetchRaw(loc, path, fetchImpl);
    if (md == null) throw new Error(`tW article not found: ${path} in ${loc.org}/${loc.repo}@${loc.ref}`);
    return { articleId: rel, files: [{ path, sourceMarkdown: md }] };
  }
  // Bare term → probe the three categories.
  for (const cat of TW_CATEGORIES) {
    const path = assertSafeRepoPath(`bible/${cat}/${rel}.md`);
    const md = await fetchRaw(loc, path, fetchImpl);
    if (md != null) return { articleId: `${cat}/${rel}`, files: [{ path, sourceMarkdown: md }] };
  }
  throw new Error(`tW article "${rel}" not found under bible/{${TW_CATEGORIES.join(',')}} in ${loc.org}/${loc.repo}@${loc.ref}`);
}

/** tA: normalize a name to its folder, list the folder's .md files. */
async function resolveTaByName(loc, name, fetchImpl) {
  const rel = String(name).trim().replace(/\/+$/, '');
  let dir = null;
  if (rel.includes('/')) {
    dir = rel; // "translate/figs-aside"
  } else {
    for (const manual of TA_MANUALS) {
      const files = await listMarkdownFiles(loc, `${manual}/${rel}`, fetchImpl);
      if (files && files.length) { dir = `${manual}/${rel}`; break; }
    }
    if (!dir) throw new Error(`tA article "${rel}" not found under {${TA_MANUALS.join(',')}}/${rel} in ${loc.org}/${loc.repo}@${loc.ref}`);
  }
  const paths = await listMarkdownFiles(loc, dir, fetchImpl);
  if (!paths || !paths.length) throw new Error(`tA article folder empty or absent: ${dir} in ${loc.org}/${loc.repo}@${loc.ref}`);
  const files = await fetchFiles(loc, paths, fetchImpl);
  return { articleId: dir, files };
}

/** Resolve when the caller gave a URL (either resource type). */
async function resolveByUrl(resourceType, url, fetchImpl) {
  const { org, repo, ref, path } = parseDoor43Url(url);
  const loc = { org, repo, ref };
  if (path.endsWith('.md')) {
    assertSafeRepoPath(path);
    const md = await fetchRaw(loc, path, fetchImpl);
    if (md == null) throw new Error(`article file not found at URL: ${url}`);
    const articleId = deriveArticleId(resourceType, path);
    return { articleId, loc, files: [{ path, sourceMarkdown: md }] };
  }
  // Folder URL → list .md files.
  const paths = await listMarkdownFiles(loc, path.replace(/\/+$/, ''), fetchImpl);
  if (!paths || !paths.length) throw new Error(`no .md files under folder URL: ${url}`);
  const files = await fetchFiles(loc, paths, fetchImpl);
  return { articleId: deriveArticleId(resourceType, path), loc, files };
}

/** Path → stable article id: tW drops the `bible/` prefix + `.md`; tA is the folder. */
function deriveArticleId(resourceType, path) {
  const clean = path.replace(/\/+$/, '');
  if (resourceType === 'tw') return clean.replace(/^bible\//, '').replace(/\.md$/i, '');
  // tA: the folder is the article; strip a trailing /NN.md-style file if present.
  return clean.replace(/\/[^/]+\.md$/i, '');
}

/**
 * Resolve an article to its concrete files.
 * @param {object} o
 * @param {'tw'|'ta'} o.resourceType
 * @param {string} [o.articleId]  name/identifier (form a)
 * @param {string} [o.articleUrl] Door43 URL (form b)
 * @param {string} o.sourceRef    "org/repo@ref" (used for name resolution; URL overrides org/repo/ref)
 * @param {function} [o.fetchImpl]
 * @returns {Promise<{ articleId, files: Array<{path, sourceMarkdown}> }>}
 */
async function resolveArticle({ resourceType, articleId, articleUrl, sourceRef, fetchImpl }) {
  if (resourceType !== 'tw' && resourceType !== 'ta') {
    throw new Error(`resolveArticle only handles article resources (tw, ta), got: ${resourceType}`);
  }
  if (articleUrl) {
    const { articleId: id, files } = await resolveByUrl(resourceType, articleUrl, fetchImpl);
    return { articleId: id, files };
  }
  if (!articleId) throw new Error('resolveArticle requires articleId or articleUrl');
  const loc = parseRepoRef(sourceRef);
  return resourceType === 'tw'
    ? resolveTwByName(loc, articleId, fetchImpl)
    : resolveTaByName(loc, articleId, fetchImpl);
}

/**
 * Fetch the existing target versions of an article's files (for future revise
 * mode / diffing). Returns a Map path → markdown (missing files omitted).
 */
async function fetchExistingArticle(targetRef, paths, fetchImpl) {
  const loc = parseRepoRef(targetRef);
  const out = new Map();
  for (const path of paths) {
    const md = await fetchRaw(loc, path, fetchImpl);
    if (md != null) out.set(path, md);
  }
  return out;
}

module.exports = {
  resolveArticle,
  fetchExistingArticle,
  parseDoor43Url,
  parseRepoRef,
  listMarkdownFiles,
  fetchRaw,
  deriveArticleId,
  TW_CATEGORIES,
  TA_MANUALS,
};
