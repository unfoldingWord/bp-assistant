// Article resources (tW/tA): the name|URL resolver (with a mocked fetchImpl),
// the markdown structure/link checks, and the Zulip resolveParams wiring.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { runArticleChecks } = require('../src/lib/translate-checks');
const { resolveArticle, parseDoor43Url, deriveArticleId } = require('../src/lib/article-resolver');
const { resolveParams, translateArticles } = require('../src/translate-pipeline');

const FIX = path.join(__dirname, 'fixtures');
const GOD = fs.readFileSync(path.join(FIX, 'tw_kt_god.md'), 'utf8');
const TA01 = fs.readFileSync(path.join(FIX, 'ta_figs-aside', '01.md'), 'utf8');
const TATITLE = fs.readFileSync(path.join(FIX, 'ta_figs-aside', 'title.md'), 'utf8');

const zmsg = (content) => ({ type: 'stream', display_recipient: 'ch', subject: 't', sender_id: 1, content });

// A "perfect translation" of a markdown body: keep every link + heading, change prose.
function fakeArticleTr(md) {
  return md
    .replace(/^(#{1,6}\s).*/gm, '$1عنوان')                          // translate heading text, keep level
    .replace(/\[([^\]]+)\]\(/g, '[نص](')                             // translate link TEXT, keep target
    .replace(/(^|[^\]])\b(created|refers|Definition|Translation)\b/g, '$1كلمة'); // some prose
}

// ---- Article checks ----------------------------------------------------

test('perfect article translation passes error checks (links + headings preserved)', () => {
  const tgt = fakeArticleTr(GOD);
  const res = runArticleChecks(GOD, tgt, { articleId: 'kt/god', path: 'bible/kt/god.md' });
  assert.deepStrictEqual(res.errors, [], JSON.stringify(res.errors.slice(0, 5), null, 2));
});

test('a dropped rc:// link is a blocking error', () => {
  const tgt = GOD.replace(/rc:\/\/en\/ta\/man\/translate\/translate-names/, 'REMOVED');
  const res = runArticleChecks(GOD, tgt);
  assert.ok(res.errors.some((e) => e.check === 'rc-links'));
});

test('a changed markdown link target is a blocking error', () => {
  const src = 'See [create](../other/creation.md) here.';
  const tgt = 'انظر [إنشاء](../other/WRONG.md) هنا.';
  const res = runArticleChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === 'markdown-links'));
});

test('a changed [[wiki]] link is a blocking error', () => {
  const src = 'x [[rc://*/tw/dict/bible/kt/god]] y';
  const tgt = 'x [[rc://*/tw/dict/bible/kt/GONE]] y';
  const res = runArticleChecks(src, tgt);
  // rc:// multiset also catches this; assert at least one link error fires
  assert.ok(res.errors.some((e) => e.check === 'rc-links' || e.check === 'wiki-links'));
});

test('empty target body is a blocking error; heading-count drift is a warning', () => {
  const empty = runArticleChecks(TA01, '   ');
  assert.ok(empty.errors.some((e) => e.check === 'empty-translation'));
  const fewerHeadings = runArticleChecks(TA01, TA01.replace(/^### .*/m, 'no longer a heading'));
  assert.ok(fewerHeadings.warnings.some((w) => w.check === 'heading-parity'));
  assert.ok(fewerHeadings.ok); // warning does not block
});

test('a one-line title file translates without spurious errors', () => {
  const res = runArticleChecks(TATITLE, 'الاستطراد');
  assert.deepStrictEqual(res.errors, []);
});

// ---- URL parsing / id derivation --------------------------------------

test('parseDoor43Url extracts org/repo/ref/path for src and raw URLs', () => {
  assert.deepStrictEqual(
    parseDoor43Url('https://git.door43.org/unfoldingWord/en_tw/src/branch/master/bible/kt/god.md'),
    { org: 'unfoldingWord', repo: 'en_tw', ref: 'master', path: 'bible/kt/god.md' });
  assert.deepStrictEqual(
    parseDoor43Url('https://git.door43.org/unfoldingWord/en_ta/raw/branch/master/translate/figs-aside/01.md'),
    { org: 'unfoldingWord', repo: 'en_ta', ref: 'master', path: 'translate/figs-aside/01.md' });
});

test('deriveArticleId strips bible/ + .md for tw and file for ta', () => {
  assert.strictEqual(deriveArticleId('tw', 'bible/kt/god.md'), 'kt/god');
  assert.strictEqual(deriveArticleId('ta', 'translate/figs-aside/01.md'), 'translate/figs-aside');
  assert.strictEqual(deriveArticleId('ta', 'translate/figs-aside'), 'translate/figs-aside');
});

// ---- Resolver with a mocked fetchImpl ---------------------------------

// Build a fake DCS: raw file map + contents-API directory listings.
function fakeFetch(rawFiles, dirs) {
  return async (url) => {
    // contents API: /api/v1/repos/{org}/{repo}/contents/{dir}?ref=...
    const cm = /\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(url);
    if (cm) {
      const dir = decodeURIComponent(cm[1]);
      const listing = dirs[dir];
      if (!listing) return { status: 404, ok: false };
      return { status: 200, ok: true, json: async () => listing.map((p) => ({ type: 'file', path: p })) };
    }
    // raw: /{org}/{repo}/raw/{branch|commit}/{ref}/{path}
    const rm = /\/raw\/(?:branch|commit)\/[^/]+\/(.+)$/.exec(url);
    if (rm) {
      const p = decodeURIComponent(rm[1]);
      if (rawFiles[p] == null) return { status: 404, ok: false };
      return { status: 200, ok: true, text: async () => rawFiles[p] };
    }
    return { status: 404, ok: false };
  };
}

test('tW resolver: explicit category "kt/god" → single file', async () => {
  const fetchImpl = fakeFetch({ 'bible/kt/god.md': GOD }, {});
  const r = await resolveArticle({ resourceType: 'tw', articleId: 'kt/god', sourceRef: 'unfoldingWord/en_tw@master', fetchImpl });
  assert.strictEqual(r.articleId, 'kt/god');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'bible/kt/god.md');
  assert.strictEqual(r.files[0].sourceMarkdown, GOD);
});

test('tW resolver: bare "god" probes categories and finds bible/kt/god.md', async () => {
  const fetchImpl = fakeFetch({ 'bible/kt/god.md': GOD }, {});
  const r = await resolveArticle({ resourceType: 'tw', articleId: 'god', sourceRef: 'unfoldingWord/en_tw@master', fetchImpl });
  assert.strictEqual(r.articleId, 'kt/god');
  assert.strictEqual(r.files[0].path, 'bible/kt/god.md');
});

test('resolver rejects path-traversal in article names and URLs', async () => {
  const fetchImpl = fakeFetch({}, {});
  await assert.rejects(
    resolveArticle({ resourceType: 'tw', articleId: '../../etc/passwd', sourceRef: 'unfoldingWord/en_tw@master', fetchImpl }),
    /unsafe article path/);
  await assert.rejects(
    resolveArticle({ resourceType: 'ta', articleUrl: 'https://git.door43.org/o/r/src/branch/master/../../../secret.md', fetchImpl }),
    /unsafe article path/);
});

test('tW resolver: unknown term throws', async () => {
  const fetchImpl = fakeFetch({}, {});
  await assert.rejects(resolveArticle({ resourceType: 'tw', articleId: 'nope', sourceRef: 'unfoldingWord/en_tw@master', fetchImpl }), /not found/);
});

test('tA resolver: bare "figs-aside" probes manuals, lists folder .md files', async () => {
  const raw = {
    'translate/figs-aside/01.md': TA01,
    'translate/figs-aside/title.md': TATITLE,
    'translate/figs-aside/sub-title.md': 'q',
  };
  const dirs = { 'translate/figs-aside': ['translate/figs-aside/01.md', 'translate/figs-aside/sub-title.md', 'translate/figs-aside/title.md'] };
  const r = await resolveArticle({ resourceType: 'ta', articleId: 'figs-aside', sourceRef: 'unfoldingWord/en_ta@master', fetchImpl: fakeFetch(raw, dirs) });
  assert.strictEqual(r.articleId, 'translate/figs-aside');
  assert.deepStrictEqual(r.files.map((f) => f.path).sort(), Object.keys(raw).sort());
});

test('tA resolver: folder URL expands to its .md files', async () => {
  const raw = { 'translate/figs-aside/01.md': TA01, 'translate/figs-aside/title.md': TATITLE };
  const dirs = { 'translate/figs-aside': Object.keys(raw) };
  const url = 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside';
  const r = await resolveArticle({ resourceType: 'ta', articleUrl: url, fetchImpl: fakeFetch(raw, dirs) });
  assert.strictEqual(r.articleId, 'translate/figs-aside');
  assert.strictEqual(r.files.length, 2);
});

test('tA resolver: single-.md URL → that one file', async () => {
  const raw = { 'translate/figs-aside/01.md': TA01 };
  const url = 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside/01.md';
  const r = await resolveArticle({ resourceType: 'ta', articleUrl: url, fetchImpl: fakeFetch(raw, {}) });
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'translate/figs-aside/01.md');
});

// ---- resolveParams (Zulip) --------------------------------------------

test('resolveParams: "translate word kt/god to ar" → tw article, ar_tw repo, en_tw source', () => {
  const p = resolveParams({ name: 'translate-tw' }, zmsg('translate word kt/god to ar'));
  assert.strictEqual(p.resourceType, 'tw');
  assert.strictEqual(p.family, 'article');
  assert.strictEqual(p.skill, 'translate-article');
  assert.strictEqual(p.pushType, 'article');
  assert.strictEqual(p.articleId, 'kt/god');
  assert.strictEqual(p.repoName, 'ar_tw');
  assert.strictEqual(p.sourceRef, 'unfoldingWord/en_tw@master');
  assert.strictEqual(p.targetLang, 'ar');
});

test('resolveParams: "translate article figs-aside to ar" → ta article', () => {
  const p = resolveParams({ name: 'translate-ta' }, zmsg('translate article figs-aside to ar'));
  assert.strictEqual(p.resourceType, 'ta');
  assert.strictEqual(p.articleId, 'figs-aside');
  assert.strictEqual(p.repoName, 'ar_ta');
  assert.strictEqual(p.sourceRef, 'unfoldingWord/en_ta@master');
});

test('resolveParams: article via Door43 URL', () => {
  const url = 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside';
  const p = resolveParams({ name: 'translate-ta' }, zmsg(`translate ta ${url} to ar`));
  assert.strictEqual(p.articleUrl, url);
  assert.strictEqual(p.articleId, null);
});

test('translateArticles uses the resolver-canonical articleId for the pack, even on URL runs (params.articleId=null)', async () => {
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artctx-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-'));
  try {
    fs.writeFileSync(path.join(ctxDir, 'instructions.md'), 'translate faithfully');
    const params = {
      resourceType: 'ta', family: 'article', skill: 'translate-article',
      articleId: null, articleUrl: 'https://git.door43.org/unfoldingWord/en_ta/src/branch/master/translate/figs-aside',
      targetLang: 'ar', targetLangName: 'Arabic', sourceLang: 'en', sourceLangName: 'English',
      direction: 'rtl', sourceRef: 'unfoldingWord/en_ta@master', contextRef: ctxDir, contextRefExplicit: true, model: 'sonnet',
    };
    const resolveImpl = async () => ({ articleId: 'translate/figs-aside', files: [{ path: 'translate/figs-aside/01.md', sourceMarkdown: '# Aside\n\nbody' }] });
    const runFileImpl = async () => ({ markdown: '# استطراد\n\nنص', checks: { ok: true, errors: [], warnings: [], violations: [] }, attempts: 1 });
    const res = await translateArticles(params, { workDir, resolveImpl, runFileImpl });
    assert.strictEqual(res.articleId, 'translate/figs-aside');
    // The slug is derived from the CANONICAL article id, not the null params.articleId.
    assert.deepStrictEqual(res.report.batches[0].slugs, ['figs-aside']);
  } finally {
    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('resolveParams: API synthetic article route carries resourceType + articleId', () => {
  const p = resolveParams({
    _synthetic: true,
    _translate: { resourceType: 'tw', targetLang: 'ar', articleId: 'kt/god', sourceLang: 'en' },
  }, {});
  assert.strictEqual(p.resourceType, 'tw');
  assert.strictEqual(p.articleId, 'kt/god');
  assert.strictEqual(p.delivery, 'editor'); // API default: results stay on the bot, never pushed to Door43
});
