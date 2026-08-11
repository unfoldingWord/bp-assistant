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

'use strict';

// Unicode block ranges. Not exhaustive of every script in existence — covers
// the scripts unfoldingWord gateway/target languages actually use.
const SCRIPT_RANGES = {
  arabic: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/,
  hebrew: /[֐-׿יִ-ﭏ]/,
  cyrillic: /[Ѐ-ӿ]/,
  devanagari: /[ऀ-ॿ]/,
  han: /[一-鿿]/,
  greek: /[Ͱ-Ͽ]/,
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

/**
 * Is `text` in `targetLang`'s script? Returns true/false, or null when
 * undecidable (targetLang's script is unknown). Two-arg undecidability is
 * ONLY about the target lang being unrecognized — see scriptGuardApplicable
 * for the source-vs-target-same-script undecidability.
 */
function isInTargetScript(text, targetLang) {
  const script = scriptOf(targetLang);
  if (!script) return null;
  return hasScript(text, script);
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
