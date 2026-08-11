// script-guard.js — pure Unicode-script detection used to catch two translate
// misconfigurations before any model call:
//   (a) SOURCE misconfiguration: the sourceRef fed to the pipeline is already
//       written in the target script (e.g. tnSourceRef pointed at a finished
//       Arabic tN book, then asked the model to "translate" Arabic to Arabic —
//       see BSOJ/ar_tn 2TH 3, 44/54 rows returned byte-identical).
//   (b) EXISTING finished work: a target-repo row already holds human
//       translation in the target script and must not be overwritten by a
//       fresh model draft.
//
// Honesty boundary: this guard can only tell source and target apart when the
// two languages use DIFFERENT scripts. For en->id (both Latin) it is a no-op —
// scriptGuardApplicable returns false — and cannot protect against either
// misconfiguration above. Do not treat "applicable === false" as "safe"; it
// only means this particular guard has nothing to say.
//
// isInTargetScript judges by SCRIPT DOMINANCE, not mere presence (see its own
// comment below): link noise (rc://, [[wiki]], markdown link targets) and
// script-neutral characters (digits, punctuation, separators, control/format
// chars) are stripped first, then the remaining target-script character
// count is compared against the remaining Latin character count. A single
// stray character — a BOM, a quoted Hebrew/Greek term inside an otherwise-
// English note — no longer flips the verdict the way bare presence did.

'use strict';

// Unicode block ranges. Not exhaustive of every script in existence — covers
// the scripts unfoldingWord gateway/target languages actually use.
// - arabic's last sub-range ends at U+FEFE, not U+FEFF: U+FEFF is ZERO WIDTH
//   NO-BREAK SPACE (the UTF-8 byte-order-mark character), not an Arabic
//   letter — a single stray BOM in an English note must never mark it
//   "already Arabic".
// - greek includes Greek Extended (U+1F00-U+1FFF, polytonic Greek).
// - han includes CJK Unified Ideographs Extension A (U+3400-U+4DBF).
const SCRIPT_RANGES = {
  arabic: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻾]/,
  hebrew: /[֐-׿יִ-ﭏ]/,
  cyrillic: /[Ѐ-ӿ]/,
  devanagari: /[ऀ-ॿ]/,
  han: /[㐀-䶿一-鿿]/,
  greek: /[Ͱ-Ͽἀ-῿]/,
  ethiopic: /[ሀ-፿]/,
  thai: /[฀-๿]/,
  myanmar: /[က-႟]/,
  bengali: /[ঀ-৿]/,
  georgian: /[Ⴀ-ჿ]/,
  latin: /[A-Za-z]/,
};

// Base language subtag -> script. Covers unfoldingWord's current + likely-next
// gateway/target languages; unlisted langs are "unknown" (scriptOf returns null).
const SCRIPT_BY_LANG = {
  ar: 'arabic', fa: 'arabic', ur: 'arabic', ps: 'arabic', sd: 'arabic', ug: 'arabic', ckb: 'arabic', prs: 'arabic',
  he: 'hebrew', yi: 'hebrew',
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic',
  hi: 'devanagari', ne: 'devanagari', mr: 'devanagari',
  bn: 'bengali',
  zh: 'han',
  el: 'greek',
  am: 'ethiopic', ti: 'ethiopic',
  th: 'thai',
  my: 'myanmar',
  ka: 'georgian',
  en: 'latin', es: 'latin', fr: 'latin', pt: 'latin', id: 'latin', vi: 'latin', sw: 'latin', tr: 'latin',
};

/** Base subtag of a BCP-47-ish lang code ("es-419" -> "es"), lowercased. */
function scriptOf(lang) {
  if (!lang) return null;
  const base = String(lang).split('-')[0].toLowerCase();
  return SCRIPT_BY_LANG[base] || null;
}

/** True if text contains at least one character of the given script. */
function hasScript(text, script) {
  const re = SCRIPT_RANGES[script];
  if (!re) return false;
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return re.test(s);
}

// rc://, [[wiki]], and markdown link targets are never localized — an Arabic
// note full of Latin rc:// links must still read as Arabic — so link noise is
// stripped before counting script characters.
const RC_LINK_RE = /rc:\/\/[^\s\])]+/g;
const WIKI_LINK_RE = /\[\[[^\]]*\]\]/g;
const MD_LINK_TARGET_RE = /\]\([^)]*\)/g;

function stripLinkNoise(text) {
  return String(text ?? '')
    .replace(RC_LINK_RE, ' ')
    .replace(WIKI_LINK_RE, ' ')
    .replace(MD_LINK_TARGET_RE, ' ');
}

// Numbers, punctuation, separators, and control/format characters carry no
// script signal — stripping them also kills the Arabic-Indic-digit false
// positive (a string of only Arabic-Indic digits has nothing left to count).
function stripScriptNeutral(text) {
  return String(text ?? '').replace(/[\p{N}\p{P}\p{Z}\p{C}]/gu, '');
}

function countMatches(text, re) {
  const m = String(text ?? '').match(re);
  return m ? m.length : 0;
}

/**
 * Is `text` DOMINANTLY in `targetLang`'s script? Returns true/false, or null
 * when undecidable (targetLang's script is unknown). Two-arg undecidability
 * is ONLY about the target lang being unrecognized — see
 * scriptGuardApplicable for the source-vs-target-same-script undecidability.
 *
 * Dominance, not presence: link noise and script-neutral characters (digits/
 * punctuation/separators/control chars) are stripped first; what remains is
 * counted per-script and compared against a Latin count. A text with no
 * signal left after stripping (empty, punctuation-only) is `false`. When the
 * target script itself IS latin, the Latin comparison would be circular, so
 * presence of any Latin character after stripping is sufficient.
 */
function isInTargetScript(text, targetLang) {
  const script = scriptOf(targetLang);
  if (!script) return null;
  const stripped = stripScriptNeutral(stripLinkNoise(text));
  if (!stripped) return false;
  const targetCount = countMatches(stripped, new RegExp(SCRIPT_RANGES[script].source, 'g'));
  if (script === 'latin') return targetCount > 0;
  const latinCount = countMatches(stripped, new RegExp(SCRIPT_RANGES.latin.source, 'g'));
  return targetCount > 0 && targetCount > latinCount;
}

/**
 * Can the guard distinguish source from target at all? False when either
 * language's script is unknown, or when source and target share a script
 * (the guard has no signal to tell them apart — e.g. en->id, both Latin).
 */
function scriptGuardApplicable(sourceLang, targetLang) {
  const srcScript = scriptOf(sourceLang);
  const tgtScript = scriptOf(targetLang);
  if (!srcScript || !tgtScript) return false;
  return srcScript !== tgtScript;
}

module.exports = {
  SCRIPT_RANGES,
  SCRIPT_BY_LANG,
  scriptOf,
  hasScript,
  isInTargetScript,
  scriptGuardApplicable,
};
