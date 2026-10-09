'use strict';

// Quote comparison key shared by the hint/kept matching in tn-tools and the
// push-time dedup in insert-tn-rows: drop Hebrew cantillation and invisible
// marks, NFC, collapse whitespace, lowercase.
const HEBREW_QUOTE_STRIP_RE = /[\u0591-\u05AF\u2060\u05BD\u05C3]/g;
const QUOTE_INVISIBLE_RE = /[\u2060\u00AD]/g;

function stripHebrewQuoteMarks(value) {
  return String(value || '').replace(HEBREW_QUOTE_STRIP_RE, '');
}

function normalizeQuote(s) {
  return stripHebrewQuoteMarks(String(s || ''))
    .normalize('NFC')
    .replace(QUOTE_INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

module.exports = { HEBREW_QUOTE_STRIP_RE, QUOTE_INVISIBLE_RE, stripHebrewQuoteMarks, normalizeQuote };
