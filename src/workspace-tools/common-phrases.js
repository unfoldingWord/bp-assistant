/**
 * Per-book list of very common phrases whose explanation lives in an intro
 * (issue #453; editors' meeting 2026-10-07).
 *
 * A phrase such as נְאֻם יְהוָה "declaration of Yahweh" or בֶּן־אָדָם "son of
 * man" occurs 50-100+ times in a book. The team rule:
 *   - scope "book":    explained in the book intro. One note per chapter, at
 *                      the chapter's first occurrence, pointing to the book
 *                      intro. No other notes for the phrase in that chapter.
 *   - scope "chapter": explained in the chapter intro of the listed chapters.
 *                      One note at the first occurrence in the chapter,
 *                      pointing to the chapter intro.
 * The tA link belongs on that first-occurrence note (its SupportReference),
 * not in the intro.
 *
 * The list is data, kept in the skills workspace next to the other book
 * reference material: `data/book-reference/common_phrases.json`.
 *
 *   {
 *     "JER": [
 *       { "phrase": "נְאֻם יְהוָה", "gloss": "declaration of Yahweh",
 *         "sref": "writing-quotations", "scope": "book" },
 *       { "phrase": "כֹּה אָמַר יְהוָה", "forms": ["כֹּה אָמַר יְהוָה צְבָאוֹת"],
 *         "sref": "writing-quotations", "scope": "book" }
 *     ],
 *     "EZK": [
 *       { "phrase": "וִידַעְתֶּם כִּי אֲנִי יְהוָה", "scope": "book", "enabled": false }
 *     ]
 *   }
 *
 * `phrase` and every entry of `forms` are matched as whole recurrence keys
 * (consonantal tokens, the same normalisation as recurrence-index.js), so a
 * note whose quote is a longer span containing the phrase is not affected.
 * `enabled: false` keeps an entry on file without applying it. Keys starting
 * with "_" are ignored, so the file can carry comments. A missing or
 * unreadable file means no entries, i.e. no behaviour change.
 */

const fs = require('fs');
const path = require('path');
const { hebTokens, bookDisplayName } = require('./recurrence-index');

const COMMON_PHRASES_REL = 'data/book-reference/common_phrases.json';

function normalizeSref(raw) {
  return String(raw || '').trim().replace(/^rc:\/\/\*\/ta\/man\/translate\//, '');
}

/** The recurrence text key of a Hebrew phrase: consonantal tokens joined by "+". */
function phraseTextKey(text) {
  return String(text || '').split('&').flatMap((seg) => hebTokens(seg)).join('+');
}

/**
 * Normalise one book's raw entries. Drops disabled and malformed entries, and
 * chapter-scoped entries that do not list the given chapter (when a chapter
 * is given).
 */
function normalizeCommonPhraseEntries(rawEntries, { chapter = 0 } = {}) {
  const out = [];
  const ch = parseInt(chapter, 10) || 0;
  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.enabled === false) continue;
    const forms = [raw.phrase, ...(Array.isArray(raw.forms) ? raw.forms : [])].filter(Boolean);
    const keys = [...new Set(forms.map(phraseTextKey).filter(Boolean))];
    if (!keys.length) continue;
    const scope = String(raw.scope || 'book').toLowerCase() === 'chapter' ? 'chapter' : 'book';
    const chapters = Array.isArray(raw.chapters)
      ? raw.chapters.map((c) => parseInt(c, 10)).filter(Boolean)
      : [];
    // A chapter-scoped entry with no chapter list has no intro to point at.
    if (scope === 'chapter' && !chapters.length) continue;
    if (scope === 'chapter' && ch && !chapters.includes(ch)) continue;
    out.push({
      id: String(raw.phrase || forms[0]),
      keys,
      scope,
      chapters,
      gloss: String(raw.gloss || ''),
      sref: normalizeSref(raw.sref),
    });
  }
  return out;
}

/**
 * Read the list for `book` from the workspace. Never throws: any problem
 * yields an empty list so the notes pipeline behaves as before.
 */
function loadCommonPhrases(book, { baseDir, chapter = 0 } = {}) {
  const code = String(book || '').toUpperCase();
  if (!code || !baseDir) return [];
  const abs = path.resolve(baseDir, COMMON_PHRASES_REL);
  let parsed;
  try {
    if (!fs.existsSync(abs)) return [];
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    console.warn(`[common-phrases] Could not read ${COMMON_PHRASES_REL}: ${err.message}`);
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return normalizeCommonPhraseEntries(parsed[code], { chapter });
}

/**
 * The first-occurrence note. Wording follows the published corpus ("See the
 * discussion of ... in the Introduction to Leviticus.", "See the Introduction
 * to chapter 7.").
 */
function buildIntroPointerSentence({ book = '', scope = 'book', glQuote = '' } = {}) {
  const gl = String(glQuote || '').trim();
  const subject = gl ? `**${gl}**` : 'this expression';
  const where = scope === 'chapter'
    ? 'the Introduction to this chapter'
    : `the Introduction to ${bookDisplayName(String(book || '').toUpperCase())}`;
  return `See the discussion of ${subject} in ${where}.`;
}

module.exports = {
  COMMON_PHRASES_REL,
  loadCommonPhrases,
  normalizeCommonPhraseEntries,
  buildIntroPointerSentence,
  phraseTextKey,
};
