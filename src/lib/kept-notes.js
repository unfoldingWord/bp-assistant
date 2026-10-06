'use strict';

/**
 * Verses of `chapter` that a kept note's ref covers, as { lo, hi }, or null.
 * "40:12" and "40:12-14" cover those verses; a cross-chapter "40:48-41:2"
 * covers 40:48 to the end of 40 and 41:1-2. Intro/front refs cover none.
 */
function keptRefVerseSpan(ref, chapter) {
  const m = String(ref || '').match(/^(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/);
  if (!m) return null;
  const c1 = Number(m[1]);
  const v1 = Number(m[2]);
  const c2 = m[3] ? Number(m[3]) : c1;
  const v2 = m[4] ? Number(m[4]) : v1;
  const ch = Number(chapter);
  if (ch < c1 || ch > c2) return null;
  const lo = ch === c1 ? v1 : 1;
  const hi = ch === c2 ? v2 : 999;
  return lo <= hi ? { lo, hi } : null;
}

module.exports = { keptRefVerseSpan };
