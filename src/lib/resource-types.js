// resource-types.js — the registry that turns a `resourceType` into everything
// the translate pipeline needs to handle it: which family it belongs to, the
// TSV column schema (for tsv resources), which skill translates it, and which
// door43-push type/repo it lands in.
//
// Two families:
//   - 'tsv'     tN, tQ : row-batched TSV; pass-through columns byte-identical,
//               only the translate columns are localized; chapter-range/by-id merge.
//   - 'article' tW, tA : markdown file(s) resolved from a name or Door43 URL;
//               whole-body translation with structure/link preservation; per-file merge.
//
// Column facts verified live 2026-07-13:
//   en_tn tn_OBA.tsv : Reference ID Tags SupportReference Quote Occurrence Note
//   en_tq tq_OBA.tsv : Reference ID Tags Quote Occurrence Question Response
// Note tQ has NO SupportReference and Quote is column 4 (not 5).

'use strict';

const TN_COLUMNS = ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence', 'Note'];
const TQ_COLUMNS = ['Reference', 'ID', 'Tags', 'Quote', 'Occurrence', 'Question', 'Response'];

const RESOURCE_TYPES = {
  tn: {
    family: 'tsv',
    columns: TN_COLUMNS,
    passThroughColumns: ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence'],
    translateColumns: ['Note'],
    supportRefColumn: 'SupportReference',
    file: (book) => `tn_${book.toUpperCase()}.tsv`,
    skill: 'translate-tn',
    pushType: 'tn',
    defaultRepo: (lang) => `${lang}_tn`,
    configRepoKey: 'tnRepo',
    defaultSourceRepo: 'en_tn',
    label: 'translationNotes',
  },
  tq: {
    family: 'tsv',
    columns: TQ_COLUMNS,
    passThroughColumns: ['Reference', 'ID', 'Tags', 'Quote', 'Occurrence'],
    translateColumns: ['Question', 'Response'],
    supportRefColumn: null,
    file: (book) => `tq_${book.toUpperCase()}.tsv`,
    skill: 'translate-tq',
    pushType: 'tq',
    defaultRepo: (lang) => `${lang}_tq`,
    configRepoKey: 'tqRepo',
    defaultSourceRepo: 'en_tq',
    label: 'translationQuestions',
  },
  tw: {
    family: 'article',
    skill: 'translate-article',
    pushType: 'article',
    defaultRepo: (lang) => `${lang}_tw`,
    configRepoKey: 'twRepo',
    defaultSourceRepo: 'en_tw',
    layout: 'tw',                       // bible/{kt,names,other}/{term}.md
    label: 'translationWords',
  },
  ta: {
    family: 'article',
    skill: 'translate-article',
    pushType: 'article',
    defaultRepo: (lang) => `${lang}_ta`,
    configRepoKey: 'taRepo',
    defaultSourceRepo: 'en_ta',
    layout: 'ta',                       // {translate,checking,process,intro}/{article}/*.md
    label: 'translationAcademy',
  },
};

// Zulip route name ↔ resourceType (four routes, all type 'translate').
const ROUTE_RESOURCE_TYPE = {
  'translate-notes': 'tn',
  'translate-questions': 'tq',
  'translate-tw': 'tw',
  'translate-ta': 'ta',
};
const ROUTE_NAME_BY_RESOURCE_TYPE = {
  tn: 'translate-notes',
  tq: 'translate-questions',
  tw: 'translate-tw',
  ta: 'translate-ta',
};

// Placeholder 3-char "book" slot for an article's checkpoint/job scope (articles
// have no book; the sessionKey suffix carries the article id to disambiguate).
// 3 alphanumerics so the API jobId scope round-trips. tw→TWX, ta→TAX.
function articleScopeBook(resourceType) {
  return `${String(resourceType).toUpperCase()}X`;
}

function getResourceType(resourceType) {
  const rt = RESOURCE_TYPES[resourceType];
  if (!rt) {
    throw new Error(`unknown resourceType "${resourceType}" (expected one of: ${Object.keys(RESOURCE_TYPES).join(', ')})`);
  }
  return rt;
}

function isTsvResource(resourceType) {
  return RESOURCE_TYPES[resourceType]?.family === 'tsv';
}

function isArticleResource(resourceType) {
  return RESOURCE_TYPES[resourceType]?.family === 'article';
}

module.exports = {
  RESOURCE_TYPES,
  RESOURCE_TYPE_KEYS: Object.keys(RESOURCE_TYPES),
  TN_COLUMNS,
  TQ_COLUMNS,
  ROUTE_RESOURCE_TYPE,
  ROUTE_NAME_BY_RESOURCE_TYPE,
  articleScopeBook,
  getResourceType,
  isTsvResource,
  isArticleResource,
};
