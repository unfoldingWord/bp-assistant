// lang-names.js — canonical language-code helpers shared by the prompt builders.
//
// The same table was copy-pasted into src/translate-pipeline.js and
// src/api/template-quick.js; this module is the single home for new consumers
// (those two can adopt it in a follow-up without changing behaviour).

const LANG_NAMES = {
  ar: 'Arabic', 'es-419': 'Latin American Spanish', es: 'Spanish', ru: 'Russian',
  fr: 'French', hi: 'Hindi', sw: 'Swahili', pt: 'Portuguese', id: 'Indonesian',
  zh: 'Chinese', vi: 'Vietnamese', bn: 'Bengali', ur: 'Urdu', fa: 'Persian',
  he: 'Hebrew', am: 'Amharic', ne: 'Nepali', my: 'Burmese', th: 'Thai',
  en: 'English', ka: 'Georgian',
};

const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'arc', 'syr', 'prs']);

/** Display name for a BCP-47-ish code, falling back to the base code then the code itself. */
function langName(code) {
  const c = String(code || '');
  return LANG_NAMES[c] || LANG_NAMES[c.split('-')[0]] || c;
}

/** Script direction for a language code (same rule translate-pipeline.js applies). */
function defaultDirection(code) {
  return RTL_LANGS.has(String(code || '').split('-')[0]) ? 'rtl' : 'ltr';
}

module.exports = { LANG_NAMES, RTL_LANGS, langName, defaultDirection };
