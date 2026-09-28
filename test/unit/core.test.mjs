import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const CORE_PATH = require.resolve('../../extension/shared/core.js');
const core = require(CORE_PATH);
const { boldLength, transform, isEligibleWord, WORD_RE } = core;

// Independent oracles, written separately from the implementation.
const SPEC_WORD_SOURCE = "[\\p{L}\\p{M}\\p{N}]+(?:['’][\\p{L}\\p{M}\\p{N}]+)*";
const ELIGIBLE_FIRST = /^(?=\p{L})[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}]/u;
// The next letter after a bold prefix (skipping apostrophes and stray marks) is from an untouched script.
const FOREIGN_LETTER_START = /^['’\p{M}]*(?=\p{L})[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}]/u;
const FOREIGN_LETTER = /(?=\p{L})[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}]/u;
const MARK = /^\p{M}/u;

function letterCount(word) {
  let n = 0;
  for (const ch of word) if (!MARK.test(ch) && ch !== "'" && ch !== '’') n++;
  return n;
}

function render(parts) {
  return parts === null ? null : parts.map((p) => (p.b ? `[${p.t}]` : p.t)).join('');
}

const ALL_OPTS = [];
for (const mode of ['auto', 'fixed']) {
  for (let strength = 1; strength <= 5; strength++) {
    for (let letters = 1; letters <= 4; letters++) {
      for (let skipShort = 0; skipShort <= 3; skipShort++) {
        for (let everyNth = 1; everyNth <= 3; everyNth++) {
          ALL_OPTS.push({ mode, strength, letters, skipShort, everyNth });
        }
      }
    }
  }
}

describe('module shape', () => {
  test('exports the documented API and attaches to globalThis.Skimbold', () => {
    assert.equal(typeof boldLength, 'function');
    assert.equal(typeof transform, 'function');
    assert.equal(typeof isEligibleWord, 'function');
    assert.ok(WORD_RE instanceof RegExp);
    assert.equal(globalThis.Skimbold.core, core);
  });

  test('WORD_RE is the spec pattern with the g and u flags', () => {
    assert.equal(WORD_RE.source, SPEC_WORD_SOURCE);
    assert.ok(WORD_RE.global && WORD_RE.unicode);
  });

  test('loads as a classic script twice in one realm without clobbering other members', () => {
    const src = readFileSync(CORE_PATH, 'utf8');
    const ctx = vm.createContext({});
    vm.runInContext('globalThis.Skimbold = { other: 42 };', ctx);
    vm.runInContext(src, ctx);
    vm.runInContext(src, ctx);
    assert.equal(vm.runInContext('Skimbold.other', ctx), 42);
    assert.equal(vm.runInContext('Skimbold.core.transform("Hello").map((p) => p.t).join("|")', ctx), 'He|llo');
  });

  test('creates the namespace when it is missing', () => {
    const ctx = vm.createContext({});
    vm.runInContext(readFileSync(CORE_PATH, 'utf8'), ctx);
    assert.equal(vm.runInContext('typeof Skimbold.core.boldLength', ctx), 'function');
  });
});

describe('boldLength', () => {
  test('default table from the spec (auto, strength 3)', () => {
    const table = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 4, 10: 4, 12: 5 };
    for (const [L, n] of Object.entries(table)) {
      assert.equal(boldLength(Number(L), { mode: 'auto', strength: 3, letters: 2, skipShort: 0, everyNth: 1 }), n, `L=${L}`);
      assert.equal(boldLength(Number(L)), n, `L=${L} with no opts`);
      assert.equal(boldLength(Number(L), {}), n, `L=${L} with empty opts`);
    }
  });

  test('auto mode tables for every strength (L = 1..12)', () => {
    const tables = {
      1: [1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3], // 0.25
      2: [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4], // 0.33
      3: [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5], // 0.4
      4: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6], // 0.5
      5: [1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 7, 7], // 0.6
    };
    for (const [strength, expected] of Object.entries(tables)) {
      const actual = expected.map((_, i) => boldLength(i + 1, { mode: 'auto', strength: Number(strength) }));
      assert.deepEqual(actual, expected, `strength ${strength}`);
    }
  });

  test('fixed mode tables for letters 1..4 (L = 1..8)', () => {
    const tables = {
      1: [1, 1, 1, 1, 1, 1, 1, 1],
      2: [1, 1, 2, 2, 2, 2, 2, 2],
      3: [1, 1, 2, 3, 3, 3, 3, 3],
      4: [1, 1, 2, 3, 4, 4, 4, 4],
    };
    for (const [letters, expected] of Object.entries(tables)) {
      const actual = expected.map((_, i) => boldLength(i + 1, { mode: 'fixed', letters: Number(letters), strength: 5 }));
      assert.deepEqual(actual, expected, `letters ${letters}`);
    }
  });

  test('skipShort leaves words of L <= skipShort plain', () => {
    for (let skipShort = 0; skipShort <= 3; skipShort++) {
      for (let L = 1; L <= 8; L++) {
        const n = boldLength(L, { skipShort });
        if (L <= skipShort) assert.equal(n, 0, `skipShort ${skipShort}, L ${L}`);
        else assert.ok(n >= 1, `skipShort ${skipShort}, L ${L}`);
      }
    }
  });

  test('monotonic non-decreasing in L (1..60) for every opts combination', () => {
    for (const opts of ALL_OPTS) {
      let prev = 0;
      for (let L = 1; L <= 60; L++) {
        const n = boldLength(L, opts);
        assert.ok(Number.isInteger(n) && n >= 0, `integer >= 0 for ${JSON.stringify(opts)} L=${L}`);
        assert.ok(n >= prev, `monotonic for ${JSON.stringify(opts)} at L=${L}: ${prev} -> ${n}`);
        if (L > opts.skipShort) {
          assert.ok(n >= 1, `at least one letter for ${JSON.stringify(opts)} L=${L}`);
          if (L >= 2) assert.ok(n <= L - 1, `keeps a plain tail for ${JSON.stringify(opts)} L=${L}`);
        }
        prev = n;
      }
    }
  });

  test('degenerate letter counts give 0', () => {
    for (const L of [0, -1, -10, NaN, Infinity, -Infinity, undefined, null, '5']) {
      assert.equal(boldLength(L), 0, String(L));
    }
  });

  test('garbage opts fall back to defaults or clamp', () => {
    assert.equal(boldLength(10, { mode: 'bogus', strength: 'x' }), 4);
    assert.equal(boldLength(10, { strength: 99 }), 6); // clamps to 5 (0.6)
    assert.equal(boldLength(10, { strength: -3 }), 3); // clamps to 1 (0.25 -> round(2.5) = 3)
    assert.equal(boldLength(10, { mode: 'fixed', letters: 9 }), 4);
    assert.equal(boldLength(10, { mode: 'fixed', letters: 0 }), 1);
    assert.equal(boldLength(10, { mode: 'fixed', letters: '3' }), 3);
    assert.equal(boldLength(2, { skipShort: 7 }), 0);
    assert.equal(boldLength(4, { skipShort: 7 }), 2); // clamps to 3
    assert.equal(boldLength(10, null), 4);
  });
});

describe('isEligibleWord', () => {
  const cases = [
    ['hello', true], ['Zebra', true], ['été', true], ['e\u0301tude', true], ['ﬁnance', true],
    ['Γειά', true], ['ἀλήθεια', true], ['Привет', true], ['ёлка', true], ['Բարեւ', true],
    ['გამარჯობა', true], ['שלום', true], ['שָׁלוֹם', true],
    ['2nd', false], ['42', false], ['Ⅻ', false], ['\u0301abc', false], ['你好', false],
    ['日本語', false], ['한국어', false], ['สวัสดี', false], ['ສະບາຍດີ', false], ['សួស្តី', false],
    ['မင်္ဂလာပါ', false], ['مرحبا', false], ['नमस्ते', false], ['বাংলা', false], ['தமிழ்', false],
    ['𝐀𝐁𝐂', false], ['𐐷', false], ['👍', false], ['', false], [' hello', false],
    [null, false], [undefined, false], [42, false],
  ];
  for (const [word, expected] of cases) {
    test(`${JSON.stringify(word)} -> ${expected}`, () => assert.equal(isEligibleWord(word), expected));
  }
});

describe('transform: specific cases', () => {
  const FIXED = (letters) => ({ mode: 'fixed', letters });
  const cases = [
    ['The quick brown fox', undefined, '[T]he [qu]ick [br]own [f]ox'],
    ['Hello, world!', undefined, '[He]llo, [wo]rld!'],
    ['  padded  ', undefined, '  [pa]dded  '],
    ['I am a cat', undefined, '[I] [a]m [a] [c]at'],
    ["don't", FIXED(3), "[don]'t"],
    ['don’t', FIXED(3), '[don]’t'],
    ["don't", FIXED(4), "[don]'t"], // L = 4, capped at 3
    ["o'clock", FIXED(1), "[o]'clock"],
    ["o'clock", FIXED(2), "[o'c]lock"],
    ["rock'n'roll", undefined, "[rock]'n'roll"],
    ["students' notes", undefined, "[stu]dents' [no]tes"],
    ["'quoted'", undefined, "'[qu]oted'"],
    ['’tis', undefined, '’[t]is'],
    ['well-known', undefined, '[we]ll-[kn]own'],
    ['state-of-the-art', undefined, '[st]ate-[o]f-[t]he-[a]rt'],
    ['and/or', undefined, '[a]nd/[o]r'],
    ['snake_case.value', undefined, '[sn]ake_[ca]se.[va]lue'],
    ['e\u0301tude', FIXED(1), '[e\u0301]tude'],
    ['e\u0301tude', undefined, '[e\u0301t]ude'],
    ['cafe\u0301', FIXED(4), '[caf]e\u0301'],
    ['cafe\u0301 au lait', undefined, '[ca]fe\u0301 [a]u [la]it'],
    ['a\u0301\u0302\u0303b', FIXED(1), '[a\u0301\u0302\u0303]b'],
    ['H2O and x86 and 2nd and 3.14', undefined, '[H]2O [a]nd [x]86 [a]nd 2nd [a]nd 3.14'],
    ['https://example.com/path_name.html?q=1', undefined, '[ht]tps://[exa]mple.[c]om/[pa]th_[na]me.[ht]ml?[q]=1'],
    ['👍🏽 hello 👩‍💻 world 🇺🇸', undefined, '👍🏽 [he]llo 👩‍💻 [wo]rld 🇺🇸'],
    ['a👍b', undefined, '[a]👍[b]'],
    ['a𝐀𝐁c', undefined, '[a]𝐀𝐁c'], // mathematical letters are script Common
    ['donʼt', { mode: 'fixed', letters: 4 }, '[don]ʼt'], // U+02BC is a Common-script letter,
    ['שלום עולם', undefined, '[של]ום [עו]לם'],
    ['שָׁלוֹם', FIXED(1), '[שָׁ]לוֹם'],
    ['Привет мир', undefined, '[Пр]ивет [м]ир'],
    ['Γειά σου κόσμε', undefined, '[Γε]ιά [σ]ου [κό]σμε'],
    ['Բարեւ աշխարհ', undefined, '[Բա]րեւ [աշ]խարհ'],
    ['გამარჯობა', undefined, '[გამა]რჯობა'],
    ['Hello 你好 world', undefined, '[He]llo 你好 [wo]rld'],
    ['English ภาษาไทย English', undefined, '[Eng]lish ภาษาไทย [Eng]lish'],
    ['word مرحبا word', undefined, '[wo]rd مرحبا [wo]rd'],
    ['word नमस्ते word', undefined, '[wo]rd नमस्ते [wo]rd'],
    // A Latin-led run glued to an untouched script never bolds into that script.
    ['Hi世界世界世界', undefined, '[Hi]世界世界世界'],
    ['Xالعربية', undefined, '[X]العربية'],
    ['abcनमस्ते', undefined, '[abc]नमस्ते'],
    ['x’你好', { strength: 5 }, '[x]’你好'], // stops at 你 and does not end on the apostrophe
    ["na'́me", { mode: 'fixed', letters: 1 }, "[n]a'́me"],
    ['hy\u00ADphen', undefined, '[h]y\u00AD[ph]en'],
    ['a\u200Db', undefined, '[a]\u200D[b]'],
    ['bad \uD800 surrogate \uDC00x', undefined, '[b]ad \uD800 [surr]ogate \uDC00[x]'],
  ];
  for (const [text, opts, expected] of cases) {
    test(`${JSON.stringify(text)} ${opts ? JSON.stringify(opts) : ''}`, () => {
      assert.equal(render(transform(text, opts)), expected);
    });
  }

  test('returns fresh { t, b } parts', () => {
    assert.deepEqual(transform('Hello there'), [
      { t: 'He', b: true },
      { t: 'llo ', b: false },
      { t: 'th', b: true },
      { t: 'ere', b: false },
    ]);
  });
});

describe('transform: null when nothing is bolded', () => {
  const inputs = [
    '', ' ', '   \n\t  ', '\u00A0\u200B', '12345', '3.14 2,000 1st 2nd 3rd 4th', '— … ! ? , .',
    '你好世界', '日本語のテキスト', '한국어 텍스트', 'สวัสดีครับ', 'ສະບາຍດີ', 'សួស្តី', 'မင်္ဂလာပါ',
    'مرحبا بالعالم', 'سلام دنیا', 'नमस्ते दुनिया', 'বাংলা', 'தமிழ்', '👍🏽👩‍💻🇺🇸❤️1️⃣', '𝐀𝐁𝐂 𝒳', 'Ⅻ Ⅳ',
    '\u0301\u0302', '\uD800\uDC00\uDBFF',
  ];
  for (const text of inputs) {
    test(JSON.stringify(text), () => assert.equal(transform(text), null));
  }

  test('non-string input', () => {
    for (const value of [undefined, null, 42, {}, ['a'], true]) assert.equal(transform(value), null);
  });

  test('skipShort can leave a whole text plain', () => {
    assert.equal(transform('a an the and', { skipShort: 3 }), null);
  });

  test('a dirty exported WORD_RE.lastIndex does not affect transform', () => {
    WORD_RE.lastIndex = 5;
    assert.equal(render(transform('Hello world')), '[He]llo [wo]rld');
    WORD_RE.lastIndex = 0;
  });
});

describe('transform: skipShort and everyNth', () => {
  test('skipShort 1..3', () => {
    const text = 'I am the house';
    assert.equal(render(transform(text, { skipShort: 0 })), '[I] [a]m [t]he [ho]use');
    assert.equal(render(transform(text, { skipShort: 1 })), 'I [a]m [t]he [ho]use');
    assert.equal(render(transform(text, { skipShort: 2 })), 'I am [t]he [ho]use');
    assert.equal(render(transform(text, { skipShort: 3 })), 'I am the [ho]use');
  });

  test('everyNth bolds the 1st, N+1th, ... eligible word', () => {
    const text = 'one two three four five six seven';
    assert.equal(render(transform(text, { everyNth: 2 })), '[o]ne two [th]ree four [fi]ve six [se]ven');
    assert.equal(render(transform(text, { everyNth: 3 })), '[o]ne two three [fo]ur five six [se]ven');
  });

  test('everyNth counts only eligible words', () => {
    assert.equal(render(transform('one 2nd 你好 two three', { everyNth: 2 })), '[o]ne 2nd 你好 two [th]ree');
  });

  test('everyNth stays regular across calls that share a state object', () => {
    const state = { count: 0 };
    const opts = { everyNth: 2 };
    assert.equal(render(transform('one two three', opts, state)), '[o]ne two [th]ree');
    assert.equal(state.count, 3);
    assert.equal(transform('four', opts, state), null); // #4 is skipped, but still counted
    assert.equal(state.count, 4);
    assert.equal(render(transform('five six', opts, state)), '[fi]ve six');
    assert.equal(transform('   ', opts, state), null); // no eligible words: count unchanged
    assert.equal(transform('2nd 你好', opts, state), null);
    assert.equal(state.count, 6);
    assert.equal(render(transform('seven eight nine', opts, state)), '[se]ven eight [ni]ne');
    assert.equal(state.count, 9);
  });

  test('state is updated even when everyNth is 1, and a bad count restarts at 0', () => {
    const state = { count: 'x' };
    transform('a b c', {}, state);
    assert.equal(state.count, 3);
    const fresh = {};
    assert.equal(render(transform('one two three', { everyNth: 3 }, fresh)), '[o]ne two three');
    assert.equal(fresh.count, 3);
  });

  test('without state each call starts counting at 1', () => {
    const opts = { everyNth: 2 };
    assert.equal(render(transform('one two', opts)), '[o]ne two');
    assert.equal(render(transform('three four', opts)), '[th]ree four');
  });
});

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  // Latin, including precomposed and decomposed accents, ligatures and apostrophes
  'the', 'quick', 'Brown', 'fox', 'jumps', 'I', 'a', 'naïve', 'café', 'cafe\u0301', 'e\u0301tude',
  'Ångström', 'A\u030Angstro\u0308m', 'straße', 'ÆSIR', 'œuvre', 'ﬁnance', 'Ǆemal', 'ṩ\u0323',
  "don't", 'don’t', "rock'n'roll", "o'clock", '’tis', "students'", "'quoted'", "l'homme",
  'well-known', 'state-of-the-art', 'and/or', 'e.g.', 'snake_case', 'hy\u00ADphen',
  // numbers and number-led tokens
  '2nd', '3rd', '42', '3.14', '1,000', 'x2', 'H2O', 'Ⅻ', '٣٤', '१२',
  // URLs and addresses
  'https://example.com/a-b_c.d?q=1#frag', 'user@example.org', 'C:\\Users\\name\\file.txt',
  // emoji, ZWJ sequences, flags, keycaps, variation selectors, skin tones
  '👍', '👍🏽', '👩‍💻', '👨‍👩‍👧‍👦', '🇺🇸', '1️⃣', '❤️', '🏳️‍🌈', '☺︎',
  // astral letters (surrogate pairs)
  '𝐀𝐁𝐂', '𐐷𐐸', 'a𝐀b', '𝒳', '𠀋',
  // untouched scripts
  '你好世界', '日本語のテキスト', 'カタカナ', '한국어', 'สวัสดีครับ', 'ສະບາຍດີ', 'សួស្តី', 'မင်္ဂလာပါ',
  'مرحبا', 'بالعالم', 'سلام', 'नमस्ते', 'दुनिया', 'বাংলা', 'தமிழ்', 'ಕನ್ನಡ', 'ትግርኛ',
  // bolded scripts
  'שלום', 'עולם', 'שָׁלוֹם', 'Γειά', 'σου', 'κόσμε', 'ἀλήθεια', 'Привет', 'мир', 'ёлка', 'й\u0306',
  'Բարեւ', 'աշխարհ', 'გამარჯობა', 'ᲒᲐᲛᲐᲠᲯᲝᲑᲐ',
  // mixed runs with no separator
  'Hi世界', 'Xالعربية', 'abcनमस्ते', 'Zสวัสดี', 'a\u05D0b', 'Moscowмосква',
  // oddities
  '\uD800', '\uDC00x', '\u0301abc', 'a\u200Db', 'a\u200Cb', 'x\uFE0F', '\u200E', '\u202Eabc\u202C',
];
const SEPARATORS = [
  ' ', ' ', ' ', '  ', '\n', '\t', ', ', '. ', '—', '-', '/', '_', '.', '"', '(', ')', '\u00A0',
  '\u200B', '\u3000', "'", '’', '', '', '',
];

function generateCorpus(count, seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = rand() < 0.3 ? pick(SEPARATORS) : '';
    const n = 1 + Math.floor(rand() * 12);
    for (let j = 0; j < n; j++) s += pick(FRAGMENTS) + pick(SEPARATORS);
    out.push(s);
  }
  return out;
}

// Checks every invariant of transform's output against independent oracles.
function checkTransform(text, opts, state) {
  const startCount = state ? state.count : 0;
  const parts = transform(text, opts, state);

  // Which words should be bolded, and how many letters each.
  const expected = [];
  let count = startCount;
  const everyNth = opts.everyNth || 1;
  for (const m of text.matchAll(new RegExp(SPEC_WORD_SOURCE, 'gu'))) {
    if (!ELIGIBLE_FIRST.test(m[0])) continue;
    count++;
    if (everyNth > 1 && (count - 1) % everyNth !== 0) continue;
    const n = boldLength(letterCount(m[0]), opts);
    if (n > 0) expected.push({ start: m.index, word: m[0], n });
  }
  if (state) assert.equal(state.count, count, 'state.count');

  if (expected.length === 0) {
    assert.equal(parts, null, `expected null for ${JSON.stringify(text)}`);
    return;
  }
  assert.ok(Array.isArray(parts) && parts.length > 0, `expected parts for ${JSON.stringify(text)}`);
  assert.equal(parts.map((p) => p.t).join(''), text, 'round trip');

  let offset = 0;
  let bi = 0;
  for (let i = 0; i < parts.length; i++) {
    const { t, b } = parts[i];
    assert.equal(typeof t, 'string');
    assert.equal(typeof b, 'boolean');
    assert.ok(t.length > 0, 'no empty parts');
    if (i > 0) assert.notEqual(b, parts[i - 1].b, 'adjacent parts differ in b');
    if (b) {
      const want = expected[bi++];
      assert.ok(want, `unexpected bold part ${JSON.stringify(t)} in ${JSON.stringify(text)}`);
      assert.equal(offset, want.start, `bold part starts at the word start in ${JSON.stringify(text)}`);
      assert.ok(want.word.startsWith(t), 'bold part is a prefix of its word');
      assert.ok(!/['’]$/u.test(t), `bold part ${JSON.stringify(t)} ends on an apostrophe`);
      assert.ok(!/[\uD800-\uDBFF]$/.test(t), 'bold part never splits a surrogate pair');
      assert.ok(!FOREIGN_LETTER.test(t), `bold part ${JSON.stringify(t)} contains an untouched script`);
      const rest = text.slice(offset + t.length);
      assert.ok(!MARK.test(rest), `combining mark separated from its base in ${JSON.stringify(text)}`);
      const got = letterCount(t);
      if (got !== want.n) {
        // Only allowed when the prefix stopped at a letter of an untouched script.
        assert.ok(got < want.n && FOREIGN_LETTER_START.test(rest),
          `bold ${JSON.stringify(t)} has ${got} letters, expected ${want.n}`);
      }
      if (letterCount(want.word) >= 2) assert.ok(t.length < want.word.length, 'keeps a plain tail');
    }
    offset += t.length;
  }
  assert.equal(bi, expected.length, `every expected word bolded in ${JSON.stringify(text)}`);
}

describe('transform: round-trip property over a generated mixed-script corpus', () => {
  const corpus = generateCorpus(4000, 0x5eed);
  const OPTS = [
    {},
    { mode: 'auto', strength: 1 }, { mode: 'auto', strength: 2 }, { mode: 'auto', strength: 4 },
    { mode: 'auto', strength: 5 },
    { mode: 'fixed', letters: 1 }, { mode: 'fixed', letters: 2 }, { mode: 'fixed', letters: 3 },
    { mode: 'fixed', letters: 4 },
    { skipShort: 3 }, { mode: 'fixed', letters: 4, skipShort: 2 },
  ];

  test('fragments on their own', () => {
    for (const text of [...FRAGMENTS, ...SEPARATORS]) for (const opts of OPTS) checkTransform(text, opts);
  });

  test(`${corpus.length} generated strings x ${OPTS.length} option sets`, () => {
    for (const text of corpus) for (const opts of OPTS) checkTransform(text, opts);
  });

  test('everyNth 2 and 3 with shared state across the whole corpus', () => {
    for (const everyNth of [2, 3]) {
      const state = { count: 0 };
      const opts = { everyNth, strength: 4 };
      for (const text of corpus) checkTransform(text, opts, state);
      assert.ok(state.count > 10000);
    }
  });

  test('one large concatenated document', () => {
    checkTransform(corpus.join('\n'), {});
  });
});

describe('transform: performance', () => {
  const PARAGRAPH =
    'It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin ' +
    'nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass ' +
    "doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from entering " +
    "along with him. The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured " +
    "poster, too large for indoor display, had been tacked to the wall. It depicted simply an enormous " +
    "face, more than a metre wide: the face of a man of about forty-five, with a heavy black moustache " +
    "and ruggedly handsome features. Winston made for the stairs; it wasn't any use trying the lift.\n\n";
  const paragraphs = [];
  let size = 0;
  while (size < 1024 * 1024) {
    paragraphs.push(PARAGRAPH);
    size += PARAGRAPH.length;
  }
  const big = paragraphs.join('');

  test('~1 MB of English prose transforms well under a second', (t) => {
    const opts = { mode: 'auto', strength: 3, letters: 2, skipShort: 0, everyNth: 1 };
    for (let i = 0; i < 20; i++) transform(paragraphs[i], opts); // warm up the JIT

    let t0 = performance.now();
    const whole = transform(big, opts);
    const wholeMs = performance.now() - t0;

    t0 = performance.now();
    let parts = 0;
    const state = { count: 0 };
    for (const p of paragraphs) parts += transform(p, opts, state).length;
    const chunkMs = performance.now() - t0;

    const blank = ' \n\t '.repeat(256 * 1024);
    t0 = performance.now();
    for (let i = 0; i < 4; i++) assert.equal(transform(blank.slice(i), opts), null);
    const blankMs = performance.now() - t0;

    const words = whole.filter((p) => p.b).length;
    t.diagnostic(`1 string of ${big.length} chars (${words} bolded words): ${wholeMs.toFixed(1)} ms`);
    t.diagnostic(`${paragraphs.length} paragraph calls with shared state (${parts} parts): ${chunkMs.toFixed(1)} ms`);
    t.diagnostic(`4 x 1 MB of whitespace rejected: ${blankMs.toFixed(1)} ms`);
    assert.equal(whole.map((p) => p.t).join(''), big);
    assert.ok(wholeMs < 1000, `whole-string transform took ${wholeMs} ms`);
    assert.ok(chunkMs < 1000, `per-paragraph transform took ${chunkMs} ms`);
    assert.ok(blankMs < 1000, `whitespace rejection took ${blankMs} ms`);
  });
});
