/*
 * Skimbold core: the pure text algorithm. No DOM, no extension APIs.
 * Loaded as a classic script in content scripts, extension pages and the web
 * build, and via require() in Node tests. Wrapped in an IIFE so a second
 * injection into the same content-script world cannot hit a redeclaration error.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold || (globalThis.Skimbold = {});

  const RATIOS = [0.25, 0.33, 0.4, 0.5, 0.6];
  const SCRIPTS = '\\p{sc=Latin}\\p{sc=Greek}\\p{sc=Cyrillic}\\p{sc=Armenian}\\p{sc=Georgian}\\p{sc=Hebrew}';

  // Public copy for tests and callers; transform() uses its own instance so a
  // caller that leaves WORD_RE.lastIndex dirty cannot affect it.
  const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
  const WORD_G = new RegExp(WORD_RE.source, 'gu');
  // Cheap rejection: text with no character from an eligible script has no eligible word.
  const ANY_SCRIPT = new RegExp('[' + SCRIPTS + ']', 'u');
  // Sticky probes run at a known index, so they never allocate substrings.
  const ELIGIBLE_Y = new RegExp('(?=\\p{L})[' + SCRIPTS + ']', 'uy');
  const FOREIGN_LETTER_Y = new RegExp('(?=\\p{L})[^' + SCRIPTS + ']', 'uy');
  const MARK_Y = /\p{M}/uy;

  const APOS = 0x27;
  const RIGHT_QUOTE = 0x2019;
  // Every \p{M} code point is at or above U+0300, so anything below is a base.
  const FIRST_MARK = 0x300;

  function toInt(value, lo, hi, fallback) {
    let n = NaN;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    if (Number.isNaN(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  function isHighSurrogate(c) {
    return c >= 0xd800 && c <= 0xdbff;
  }

  function isMarkAt(text, i) {
    MARK_Y.lastIndex = i;
    return MARK_Y.test(text);
  }

  function isEligibleAt(text, i) {
    const c = text.charCodeAt(i);
    if (c < 0x80) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    ELIGIBLE_Y.lastIndex = i;
    return ELIGIBLE_Y.test(text);
  }

  // Letters of text[start, end): code points that are neither marks nor apostrophes.
  function countLetters(text, start, end) {
    let letters = 0;
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c < FIRST_MARK) {
        if (c !== APOS) letters++;
        i++;
      } else if (c === RIGHT_QUOTE) {
        i++;
      } else {
        if (!isMarkAt(text, i)) letters++;
        i += isHighSurrogate(c) ? 2 : 1;
      }
    }
    return letters;
  }

  // End offset of a prefix holding n letters of the word text[start, end).
  // Marks stay with their base, the prefix never ends on an apostrophe, and it
  // stops before any letter of a script we leave untouched (e.g. "Xالعربية").
  function prefixEnd(text, start, end, n) {
    let letters = 0;
    let cut = start; // end of the last letter taken, including its marks
    let attached = false; // whether a mark here still belongs to that letter
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === APOS || c === RIGHT_QUOTE) {
        if (letters >= n) break;
        attached = false;
        i++;
        continue;
      }
      const size = isHighSurrogate(c) ? 2 : 1;
      if (c >= FIRST_MARK && isMarkAt(text, i)) {
        i += size;
        if (attached) cut = i;
        continue;
      }
      if (letters >= n) break;
      if (c >= 0x80 && letters > 0) {
        FOREIGN_LETTER_Y.lastIndex = i;
        if (FOREIGN_LETTER_Y.test(text)) break;
      }
      letters++;
      i += size;
      cut = i;
      attached = true;
    }
    return cut;
  }

  // ratio < 0 means fixed mode with `letters` letters.
  function lengthFor(letterCount, ratio, letters, skipShort) {
    if (!(letterCount >= 1) || letterCount <= skipShort) return 0;
    const n = ratio < 0 ? letters : Math.round(letterCount * ratio);
    const cap = letterCount === 1 ? 1 : letterCount - 1;
    return Math.max(1, Math.min(n, cap));
  }

  function ratioOf(opts) {
    if (opts && opts.mode === 'fixed') return -1;
    return RATIOS[toInt(opts && opts.strength, 1, 5, 3) - 1];
  }

  function boldLength(letterCount, opts) {
    if (!Number.isFinite(letterCount)) return 0;
    return lengthFor(
      Math.floor(letterCount),
      ratioOf(opts),
      toInt(opts && opts.letters, 1, 4, 2),
      toInt(opts && opts.skipShort, 0, 3, 0)
    );
  }

  function isEligibleWord(word) {
    return typeof word === 'string' && word.length > 0 && isEligibleAt(word, 0);
  }

  function transform(text, opts, state) {
    if (typeof text !== 'string' || !ANY_SCRIPT.test(text)) return null;

    const ratio = ratioOf(opts);
    const letters = toInt(opts && opts.letters, 1, 4, 2);
    const skipShort = toInt(opts && opts.skipShort, 0, 3, 0);
    const everyNth = toInt(opts && opts.everyNth, 1, 3, 1);
    const tracked = state !== null && typeof state === 'object';
    let count = tracked && Number.isFinite(state.count) ? state.count : 0;

    let parts = null;
    let last = 0;
    let match;
    WORD_G.lastIndex = 0;
    while ((match = WORD_G.exec(text)) !== null) {
      const start = match.index;
      if (!isEligibleAt(text, start)) continue;
      count++;
      if (everyNth > 1 && (count - 1) % everyNth !== 0) continue;
      const end = start + match[0].length;
      const n = lengthFor(countLetters(text, start, end), ratio, letters, skipShort);
      if (n === 0) continue;
      const cut = prefixEnd(text, start, end, n);
      if (parts === null) parts = [];
      if (start > last) parts.push({ t: text.slice(last, start), b: false });
      parts.push({ t: text.slice(start, cut), b: true });
      last = cut;
    }

    if (tracked) state.count = count;
    if (parts === null) return null;
    if (last < text.length) parts.push({ t: text.slice(last), b: false });
    return parts;
  }

  const core = { boldLength, transform, isEligibleWord, WORD_RE };
  Skimbold.core = core;

  if (typeof module === 'object' && module && module.exports) module.exports = core;
})();
