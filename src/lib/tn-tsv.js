// tn-tsv.js — parse/serialize the 7-column translationNotes TSV.
//
// Thin wrapper over the generic codec in tsv-resource.js (which is shared by
// the tN and tQ resource types). Kept as its own module so the existing
// translate-tn imports and tests are unchanged.
//
// Format facts (verified against unfoldingWord/en_tn tn_OBA.tsv):
// - Header: Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote
// - One physical line per row; newlines inside Note are the literal two-char
//   sequence "\n" (backslash + n), never a real newline. Fields never contain
//   real tabs. So a naive line/tab split is exact, not approximate.

'use strict';

const { makeTsvCodec, refChapter, refVerseRange, sliceChapterRows } = require('./tsv-resource');

const TN_COLUMNS = ['Reference', 'ID', 'Tags', 'SupportReference', 'Quote', 'Occurrence', 'Note'];
const codec = makeTsvCodec(TN_COLUMNS);
const TN_HEADER = codec.HEADER;

/**
 * Parse a tN TSV string. Throws on structural corruption (wrong header,
 * wrong column count) — corrupt input must never be silently repaired.
 * @returns {Array<{Reference,ID,Tags,SupportReference,Quote,Occurrence,Note}>}
 */
const parseTnTsv = codec.parse;

/** Serialize rows back to canonical tN TSV (header + LF line endings + trailing newline). */
const serializeTnTsv = codec.serialize;

module.exports = { TN_COLUMNS, TN_HEADER, parseTnTsv, serializeTnTsv, refChapter, refVerseRange, sliceChapterRows };
