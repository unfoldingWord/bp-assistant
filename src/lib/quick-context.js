// quick-context.js — shared context-pack loading/caching/rendering for the
// "quick" HTTPS endpoints (tn-quick, template-quick). Those endpoints are
// single-request, latency-sensitive, and called far more often than the
// batch translate pipeline, so a pack pinned to a sha is cached in-process
// and concurrent callers for the same pack coalesce onto one fetch.
//
// Language-name table also lives here so both quick endpoints (and any
// future one) share a single copy instead of copy-pasting LANG_NAMES.

'use strict';

const { loadContextPack, parseContextRef, resolveContextSha } = require('./context-pack');
const { renderPackPreamble } = require('./translate-core');

const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  fr: 'French', hi: 'Hindi', sw: 'Swahili', pt: 'Portuguese', id: 'Indonesian',
  zh: 'Chinese', vi: 'Vietnamese', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  he: 'Hebrew', am: 'Amharic', ne: 'Nepali', my: 'Burmese', th: 'Thai',
  en: 'English', ka: 'Georgian',
};

function langName(code) {
  const c = String(code || '');
  return LANG_NAMES[c] || LANG_NAMES[c.split('-')[0]] || c;
}

// Pinned-sha pack cache. Values are the in-flight/settled loadContextPack
// promise so concurrent requests for the same "org/repo@sha" coalesce onto
// one fetch instead of racing independent ones.
const MAX_ENTRIES = 20;
const packCache = new Map();

// Branch → sha resolution cache, so a run of requests against a branch ref
// doesn't hit the DCS branches API on every call.
const BRANCH_SHA_TTL_MS = 60_000;
const branchShaCache = new Map();

function shaKey(org, repo, sha) {
  return `${org}/${repo}@${sha}`;
}

function touchCache(key) {
  const value = packCache.get(key);
  packCache.delete(key);
  packCache.set(key, value);
}

function setCache(key, promise) {
  packCache.set(key, promise);
  if (packCache.size > MAX_ENTRIES) {
    const oldestKey = packCache.keys().next().value;
    packCache.delete(oldestKey);
  }
}

function setBranchShaCache(key, value) {
  branchShaCache.set(key, value);
  if (branchShaCache.size > MAX_ENTRIES) {
    const oldestKey = branchShaCache.keys().next().value;
    branchShaCache.delete(oldestKey);
  }
}

function loadPackBySha(parsed, contextRef, fetchImpl) {
  const key = shaKey(parsed.org, parsed.repo, parsed.ref);
  if (packCache.has(key)) {
    touchCache(key);
    return packCache.get(key);
  }
  const promise = loadContextPack(contextRef, { fetchImpl, allowEmpty: true }).catch((err) => {
    packCache.delete(key);
    throw err;
  });
  setCache(key, promise);
  return promise;
}

async function resolveBranchSha(parsed, fetchImpl, now) {
  const key = shaKey(parsed.org, parsed.repo, parsed.ref);
  const cached = branchShaCache.get(key);
  if (cached && now() - cached.resolvedAt < BRANCH_SHA_TTL_MS) {
    return cached.shaPromise;
  }
  const shaPromise = resolveContextSha(parsed, fetchImpl);
  setBranchShaCache(key, { shaPromise, resolvedAt: now() });
  return shaPromise;
}

/**
 * Load a context pack, cached when the ref pins a sha (directly or by
 * resolving a branch to its current commit). A local directory ref, or a
 * branch ref that fails to resolve to a sha, is loaded uncached every call.
 */
async function getContextPackCached(contextRef, { fetchImpl, now = Date.now } = {}) {
  const parsed = parseContextRef(contextRef);
  if (!parsed) {
    // Local directory (dev fixtures / tests) — no caching, always fresh.
    return loadContextPack(contextRef, { fetchImpl, allowEmpty: true });
  }

  if (/^[0-9a-f]{40}$/i.test(parsed.ref)) {
    return loadPackBySha(parsed, contextRef, fetchImpl);
  }

  const sha = await resolveBranchSha(parsed, fetchImpl, now);
  if (!sha) {
    return loadContextPack(contextRef, { fetchImpl, allowEmpty: true });
  }
  const shaRef = `${parsed.org}/${parsed.repo}@${sha}`;
  return loadPackBySha({ org: parsed.org, repo: parsed.repo, ref: sha }, shaRef, fetchImpl);
}

// Total wall-clock budget for loading a pack. These endpoints are interactive
// (a Suggest click, a Draft-with-AI click) and the caller has its own client
// ceiling, so a slow or stuck DCS must not hold the request open — past this
// budget we abandon the pack and draft without preferences.
const PACK_LOAD_TIMEOUT_MS = 8_000;

/**
 * Load a context pack for a quick endpoint. Never throws and never outlasts
 * PACK_LOAD_TIMEOUT_MS: any load error, timeout, or an empty pack degrades to
 * { pack: null, warning: <reason> } so the caller can draft without
 * preferences rather than fail or hang the whole request.
 */
async function loadQuickPack(contextRef, { fetchImpl, timeoutMs = PACK_LOAD_TIMEOUT_MS } = {}) {
  let timer;
  try {
    const pack = await Promise.race([
      getContextPackCached(contextRef, { fetchImpl }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`pack load timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        // Don't hold the event loop open on this timer.
        if (timer.unref) timer.unref();
      }),
    ]);
    if (!pack.hasContent) {
      return { pack: null, warning: `context_pack_unavailable: empty pack at "${contextRef}"` };
    }
    return { pack, warning: null };
  } catch (err) {
    return { pack: null, warning: `context_pack_unavailable: ${err.message}` };
  } finally {
    // A timed-out load keeps running in the background; if it eventually
    // resolves it still populates the sha cache, so the next request benefits.
    clearTimeout(timer);
  }
}

/**
 * Render the org-preferences preamble for a quick endpoint's system prompt.
 * When termStatuses is given, only terms with a matching status are
 * rendered (e.g. tn-quick only needs hard constraints, not "admitted").
 */
function renderQuickPackText({ pack, targetLang, targetLangName, direction, termStatuses }) {
  const effectivePack = termStatuses
    ? { ...pack, terms: (pack.terms || []).filter((t) => termStatuses.includes(t.status)) }
    : pack;
  const parts = renderPackPreamble({ pack: effectivePack, targetLang, targetLangName, direction });
  return parts.join('\n\n');
}

function _resetForTests() {
  packCache.clear();
  branchShaCache.clear();
}

function _cacheSizesForTests() {
  return { packCacheSize: packCache.size, branchShaCacheSize: branchShaCache.size };
}

module.exports = {
  LANG_NAMES,
  langName,
  getContextPackCached,
  loadQuickPack,
  renderQuickPackText,
  BRANCH_SHA_TTL_MS,
  MAX_ENTRIES,
  PACK_LOAD_TIMEOUT_MS,
  _cacheSizesForTests,
  _resetForTests,
};
