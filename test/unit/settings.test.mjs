import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const SETTINGS_PATH = require.resolve('../../extension/shared/settings.js');

const SPEC_DEFAULTS = {
  mode: 'auto', strength: 3, letters: 2, skipShort: 0, everyNth: 1,
  weight: 700,
  fade: 0,
  iconClick: 'popup',
  autoSites: [],
  autoAll: false,
  excludedSites: [],
  reader: { theme: 'auto', fontSize: 20, lineHeight: 1.7, font: 'serif', width: 680, bold: true },
};

// settings.js keeps a little per-realm state (save queue, web listeners), so
// tests that touch storage get a fresh copy of the module.
function freshSettings() {
  delete require.cache[SETTINGS_PATH];
  return require(SETTINGS_PATH);
}

const settings = freshSettings();
const { DEFAULTS, LIMITS, sanitize, originOf, matchPatternOf } = settings;

const GLOBALS = ['chrome', 'browser', 'localStorage', 'addEventListener', 'removeEventListener'];
let savedGlobals;
beforeEach(() => {
  savedGlobals = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
});
afterEach(() => {
  for (const [name, desc] of savedGlobals) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete globalThis[name];
  }
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A fake of the promise-style chrome.storage API, including sync's 8 KB per-item quota.
function fakeStorage() {
  const listeners = new Set();
  const calls = [];
  function area(name, quotaPerItem) {
    const data = new Map();
    const fail = { get: false, set: false, remove: false };
    const emit = (changes) => {
      if (Object.keys(changes).length) setTimeout(() => { for (const fn of [...listeners]) fn(changes, name); }, 0);
    };
    return {
      data, fail,
      async get(key) {
        calls.push(`${name}.get`);
        if (fail.get) throw new Error(`${name} get failed`);
        return data.has(key) ? { [key]: clone(data.get(key)) } : {};
      },
      async set(items) {
        calls.push(`${name}.set`);
        if (fail.set) throw new Error(`${name} set failed`);
        for (const [key, value] of Object.entries(items)) {
          if (quotaPerItem && JSON.stringify(value).length + key.length > quotaPerItem) {
            throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
          }
        }
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          const oldValue = data.get(key);
          if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
          data.set(key, clone(value));
          changes[key] = { oldValue: clone(oldValue), newValue: clone(value) };
        }
        emit(changes);
      },
      async remove(key) {
        calls.push(`${name}.remove`);
        if (fail.remove) throw new Error(`${name} remove failed`);
        if (!data.has(key)) return;
        const oldValue = data.get(key);
        data.delete(key);
        emit({ [key]: { oldValue } });
      },
    };
  }
  const storage = {
    sync: area('sync', 8192),
    local: area('local', 0),
    session: area('session', 0),
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
  };
  return { storage, listeners, calls };
}

function installChrome() {
  const fake = fakeStorage();
  globalThis.chrome = { runtime: { id: 'test' }, storage: fake.storage };
  delete globalThis.browser;
  return fake;
}

function fakeLocalStorage() {
  const data = new Map();
  const store = {
    data,
    failSet: false,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (store.failSet) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key),
  };
  return store;
}

function installWeb({ withLocalStorage = true } = {}) {
  delete globalThis.chrome;
  delete globalThis.browser;
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  const store = withLocalStorage ? fakeLocalStorage() : null;
  if (store) globalThis.localStorage = store;
  else delete globalThis.localStorage;
  const fireStorage = (key, newValue) => {
    const event = new Event('storage');
    event.key = key;
    event.newValue = newValue;
    target.dispatchEvent(event);
  };
  return { store, fireStorage, target };
}

function collector() {
  const seen = [];
  const cb = (value) => seen.push(value);
  return { seen, cb };
}

describe('DEFAULTS', () => {
  test('match the spec exactly', () => {
    assert.deepEqual(DEFAULTS, SPEC_DEFAULTS);
    assert.deepEqual(Object.keys(DEFAULTS), Object.keys(SPEC_DEFAULTS));
    assert.deepEqual(Object.keys(DEFAULTS.reader), Object.keys(SPEC_DEFAULTS.reader));
  });

  test('are deeply frozen so no caller can corrupt them', () => {
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.ok(Object.isFrozen(DEFAULTS.reader));
    assert.ok(Object.isFrozen(DEFAULTS.autoSites));
    assert.ok(Object.isFrozen(DEFAULTS.excludedSites));
    assert.ok(Object.isFrozen(LIMITS.reader.fontSize));
  });

  test('defaults sit inside LIMITS', () => {
    for (const key of ['strength', 'letters', 'skipShort', 'everyNth', 'weight', 'fade']) {
      assert.ok(DEFAULTS[key] >= LIMITS[key].min && DEFAULTS[key] <= LIMITS[key].max, key);
    }
    for (const key of ['fontSize', 'lineHeight', 'width']) {
      const value = DEFAULTS.reader[key];
      assert.ok(value >= LIMITS.reader[key].min && value <= LIMITS.reader[key].max, key);
    }
  });

  test('module attaches to globalThis.Skimbold and exports the API', () => {
    assert.equal(globalThis.Skimbold.settings, settings);
    for (const name of ['sanitize', 'load', 'save', 'onChange', 'originOf', 'matchPatternOf']) {
      assert.equal(typeof settings[name], 'function', name);
    }
  });
});

describe('sanitize', () => {
  test('garbage input gives a fresh, mutable copy of the defaults', () => {
    for (const input of [undefined, null, 0, 42, NaN, '', 'settings', true, [], [1, 2], () => 1, Symbol('x')]) {
      const out = sanitize(input);
      assert.deepEqual(out, SPEC_DEFAULTS, String(typeof input));
      assert.ok(!Object.isFrozen(out) && !Object.isFrozen(out.reader) && !Object.isFrozen(out.autoSites));
      assert.notEqual(out.autoSites, DEFAULTS.autoSites);
      assert.notEqual(out.reader, DEFAULTS.reader);
    }
  });

  test('keeps valid values and returns them in a new object', () => {
    const input = {
      mode: 'fixed', strength: 5, letters: 4, skipShort: 3, everyNth: 3, weight: 900, fade: 60,
      iconClick: 'toggle', autoSites: ['https://a.com'], autoAll: true, excludedSites: ['http://b.org:8080'],
      reader: { theme: 'sepia', fontSize: 24, lineHeight: 2, font: 'sans', width: 900, bold: false },
    };
    const out = sanitize(input);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
    assert.notEqual(out.autoSites, input.autoSites);
    assert.notEqual(out.reader, input.reader);
  });

  test('drops unknown keys, including a JSON __proto__ key', () => {
    const out = sanitize(JSON.parse('{"__proto__":{"mode":"fixed"},"bogus":1,"constructor":2,"strength":4}'));
    assert.deepEqual(Object.keys(out), Object.keys(SPEC_DEFAULTS));
    assert.equal(out.mode, 'auto');
    assert.equal(out.strength, 4);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    const reader = sanitize({ reader: { extra: true, fontSize: 30 } }).reader;
    assert.deepEqual(Object.keys(reader), Object.keys(SPEC_DEFAULTS.reader));
  });

  test('integer fields: coercion, rounding and clamping', () => {
    const cases = [
      ['strength', '4', 4], ['strength', ' 2 ', 2], ['strength', 2.6, 3], ['strength', 0, 1], ['strength', 99, 5],
      ['strength', -Infinity, 1], ['strength', Infinity, 5], ['strength', NaN, 3], ['strength', '', 3],
      ['strength', 'abc', 3], ['strength', null, 3], ['strength', true, 3], ['strength', [4], 3], ['strength', {}, 3],
      ['letters', 0, 1], ['letters', 7, 4], ['letters', '3', 3], ['letters', 1.4, 1],
      ['skipShort', -1, 0], ['skipShort', 9, 3], ['skipShort', '2', 2],
      ['everyNth', 0, 1], ['everyNth', 5, 3], ['everyNth', 2.5, 3],
      ['fade', -5, 0], ['fade', 61, 60], ['fade', 33.4, 33], ['fade', '45', 45], ['fade', false, 0],
    ];
    for (const [key, input, expected] of cases) {
      assert.equal(sanitize({ [key]: input })[key], expected, `${key}: ${String(input)}`);
    }
  });

  test('weight snaps to 600|700|800|900', () => {
    const cases = [[600, 600], [700, 700], [800, 800], [900, 900], ['800', 800], [650, 700], [749, 700],
      [751, 800], [400, 600], [100, 600], [1000, 900], [Infinity, 900], [null, 700], [true, 700], ['bold', 700]];
    for (const [input, expected] of cases) assert.equal(sanitize({ weight: input }).weight, expected, String(input));
  });

  test('enums are whitelisted and case-sensitive', () => {
    assert.equal(sanitize({ mode: 'fixed' }).mode, 'fixed');
    assert.equal(sanitize({ mode: 'FIXED' }).mode, 'auto');
    assert.equal(sanitize({ mode: 1 }).mode, 'auto');
    assert.equal(sanitize({ iconClick: 'toggle' }).iconClick, 'toggle');
    assert.equal(sanitize({ iconClick: 'menu' }).iconClick, 'popup');
    assert.equal(sanitize({ iconClick: ['toggle'] }).iconClick, 'popup');
  });

  test('booleans accept only real booleans', () => {
    assert.equal(sanitize({ autoAll: true }).autoAll, true);
    for (const input of ['true', 1, {}, [], null]) assert.equal(sanitize({ autoAll: input }).autoAll, false);
    assert.equal(sanitize({ reader: { bold: false } }).reader.bold, false);
    for (const input of ['false', 0, null]) assert.equal(sanitize({ reader: { bold: input } }).reader.bold, true);
  });

  test('reader sub-object is clamped and whitelisted', () => {
    assert.deepEqual(sanitize({ reader: 'dark' }).reader, SPEC_DEFAULTS.reader);
    assert.deepEqual(sanitize({ reader: [1] }).reader, SPEC_DEFAULTS.reader);
    const r = (reader) => sanitize({ reader }).reader;
    assert.equal(r({ theme: 'sepia' }).theme, 'sepia');
    assert.equal(r({ theme: 'dark' }).theme, 'dark');
    assert.equal(r({ theme: 'light' }).theme, 'light');
    assert.equal(r({ theme: 'blue' }).theme, 'auto');
    assert.equal(r({ font: 'sans' }).font, 'sans');
    assert.equal(r({ font: 'mono' }).font, 'serif');
    assert.equal(r({ fontSize: '22' }).fontSize, 22);
    assert.equal(r({ fontSize: 5 }).fontSize, LIMITS.reader.fontSize.min);
    assert.equal(r({ fontSize: 100 }).fontSize, LIMITS.reader.fontSize.max);
    assert.equal(r({ fontSize: 17.5 }).fontSize, 18);
    assert.equal(r({ lineHeight: 1.72 }).lineHeight, 1.7);
    assert.equal(r({ lineHeight: '1.85' }).lineHeight, 1.85);
    assert.equal(r({ lineHeight: 1.45 }).lineHeight, 1.45);
    assert.equal(r({ lineHeight: 0.5 }).lineHeight, LIMITS.reader.lineHeight.min);
    assert.equal(r({ lineHeight: 9 }).lineHeight, LIMITS.reader.lineHeight.max);
    assert.equal(r({ lineHeight: 'tall' }).lineHeight, 1.7);
    assert.equal(r({ width: 10 }).width, LIMITS.reader.width.min);
    assert.equal(r({ width: 99999 }).width, LIMITS.reader.width.max);
    assert.equal(r({ width: 720.4 }).width, 720);
  });

  test('line heights never carry float residue', () => {
    for (let x = 0.9; x < 3.2; x += 0.01) {
      const v = sanitize({ reader: { lineHeight: x } }).reader.lineHeight;
      assert.ok(/^\d(\.\d{1,2})?$/.test(String(v)), `${x} -> ${v}`);
    }
  });

  test('origin lists are normalised, filtered, deduped and capped', () => {
    const cases = [
      ['https://Example.COM/path?x=1#y', 'https://example.com'],
      ['http://example.com:80/', 'http://example.com'],
      ['https://example.com:443', 'https://example.com'],
      ['https://example.com:8443/app', 'https://example.com:8443'],
      ['  https://padded.org  ', 'https://padded.org'],
      ['https://user:pw@site.org/', 'https://site.org'],
      ['https://bücher.de', 'https://xn--bcher-kva.de'],
      ['http://127.0.0.1:3000/x', 'http://127.0.0.1:3000'],
      ['http://[::1]:8080/', 'http://[::1]:8080'],
      ['http://localhost:5173', 'http://localhost:5173'],
      ['https://sub.domain_with_underscore.example', 'https://sub.domain_with_underscore.example'],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(sanitize({ autoSites: [input] }).autoSites, [expected], input);
      assert.deepEqual(sanitize({ excludedSites: [input] }).excludedSites, [expected], input);
    }
    const rejected = [
      'example.com', 'ftp://example.com', 'file:///C:/x.html', 'chrome://extensions', 'about:blank',
      'javascript:alert(1)', 'data:text/html,hi', 'chrome-extension://abc/page.html', 'https://',
      'https://*.example.com', 'https://exa mple.com', 'https://a!b.com', 'http://.', '', '   ',
      42, null, undefined, {}, ['https://a.com'], 'https://' + 'a'.repeat(2100) + '.com',
    ];
    for (const input of rejected) {
      assert.deepEqual(sanitize({ autoSites: [input] }).autoSites, [], String(input).slice(0, 40));
    }
    for (const input of ['https://a.com', 5, null, {}]) {
      assert.deepEqual(sanitize({ autoSites: input }).autoSites, [], `non-array ${String(input)}`);
    }
    assert.deepEqual(
      sanitize({ autoSites: ['https://a.com', 'https://A.com/', 'https://a.com:443/x', 'http://a.com', 'https://b.com', 'https://a.com'] }).autoSites,
      ['https://a.com', 'http://a.com', 'https://b.com']
    );
  });

  test('origin lists keep at most 500 entries, first ones first', () => {
    const many = Array.from({ length: 700 }, (_, i) => `https://site${i}.example`);
    const withDupes = many.flatMap((o) => [o, o.toUpperCase(), 'not a url']);
    for (const list of [many, withDupes]) {
      const out = sanitize({ autoSites: list, excludedSites: list });
      assert.equal(out.autoSites.length, 500);
      assert.equal(out.excludedSites.length, 500);
      assert.equal(out.autoSites[0], 'https://site0.example');
      assert.equal(out.autoSites[499], 'https://site499.example');
    }
  });

  test('is idempotent over random garbage', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pool = [undefined, null, true, false, 0, -1, 1.5, 3, 700, 99999, NaN, '', 'fixed', 'auto', 'toggle',
      'sepia', 'sans', '12', 'https://x.org/a', 'nope', [], ['https://y.org', 'bad'], {}, { theme: 'dark' }];
    const keys = [...Object.keys(SPEC_DEFAULTS), 'junk'];
    for (let i = 0; i < 2000; i++) {
      const obj = {};
      for (const key of keys) if (rand() < 0.6) obj[key] = pool[Math.floor(rand() * pool.length)];
      const once = sanitize(obj);
      assert.deepEqual(sanitize(once), once);
      assert.deepEqual(sanitize(JSON.parse(JSON.stringify(once))), once);
    }
  });
});

describe('originOf', () => {
  test('returns the origin of http(s) URLs and null for everything else', () => {
    assert.equal(originOf('https://www.example.com/a/b?c#d'), 'https://www.example.com');
    assert.equal(originOf('HTTP://EXAMPLE.com:8080'), 'http://example.com:8080');
    assert.equal(originOf(new URL('https://example.org/x')), 'https://example.org');
    assert.equal(originOf({ href: 'https://loc.example/page' }), 'https://loc.example');
    for (const input of ['chrome://newtab/', 'about:blank', 'file:///tmp/a.pdf', 'edge://settings',
      'view-source:https://a.com', 'moz-extension://id/page.html', 'not a url', '', 'https://*.a.com',
      null, undefined, 42, {}, { href: 5 }]) {
      assert.equal(originOf(input), null, String(input));
    }
  });
});

describe('matchPatternOf', () => {
  test('gives a port-less host pattern for http(s) origins and null for everything else', () => {
    assert.equal(matchPatternOf('https://en.wikipedia.org'), 'https://en.wikipedia.org/*');
    assert.equal(matchPatternOf('http://127.0.0.1:8080'), 'http://127.0.0.1/*');
    assert.equal(matchPatternOf('HTTPS://Example.COM:443/path?q'), 'https://example.com/*');
    assert.equal(matchPatternOf('http://[::1]:3000'), 'http://[::1]/*');
    assert.equal(matchPatternOf('https://bücher.example'), 'https://xn--bcher-kva.example/*');
    for (const input of ['file:///tmp/a.pdf', 'chrome://newtab/', 'https://*.a.com', 'not a url', '', null, undefined]) {
      assert.equal(matchPatternOf(input), null, String(input));
    }
  });
});

describe('extension storage (fake chrome.storage)', () => {
  test('load returns fresh defaults when nothing is stored', async () => {
    installChrome();
    const s = freshSettings();
    const loaded = await s.load();
    assert.deepEqual(loaded, SPEC_DEFAULTS);
    assert.ok(!Object.isFrozen(loaded));
  });

  test('save merges, sanitizes, writes to sync under "settings" and returns the result', async () => {
    const fake = installChrome();
    const s = freshSettings();
    const saved = await s.save({ strength: 99, bogus: 1, autoSites: ['https://A.com/x', 'nope'] });
    assert.deepEqual(saved, { ...SPEC_DEFAULTS, strength: 5, autoSites: ['https://a.com'] });
    assert.deepEqual(fake.storage.sync.data.get('settings'), saved);
    assert.equal(fake.storage.local.data.has('settings'), false);
    assert.deepEqual(await s.load(), saved);

    await s.save({ mode: 'fixed' });
    const after = await s.save({ letters: 3, reader: { fontSize: 24 } });
    assert.equal(after.mode, 'fixed');
    assert.equal(after.letters, 3);
    assert.equal(after.strength, 5);
    assert.deepEqual(after.reader, { ...SPEC_DEFAULTS.reader, fontSize: 24 });
    assert.deepEqual(await s.load(), after);
  });

  test('save treats a non-object partial as no change', async () => {
    installChrome();
    const s = freshSettings();
    for (const partial of [undefined, null, 5, 'x', []]) assert.deepEqual(await s.save(partial), SPEC_DEFAULTS);
    assert.deepEqual(await s.save({ reader: null }), SPEC_DEFAULTS);
  });

  test('concurrent saves in one context do not lose updates', async () => {
    installChrome();
    const s = freshSettings();
    await Promise.all([s.save({ strength: 1 }), s.save({ letters: 4 }), s.save({ fade: 20 }), s.save({ reader: { font: 'sans' } })]);
    const loaded = await s.load();
    assert.equal(loaded.strength, 1);
    assert.equal(loaded.letters, 4);
    assert.equal(loaded.fade, 20);
    assert.equal(loaded.reader.font, 'sans');
  });

  test('a save that changes nothing does not write', async () => {
    const fake = installChrome();
    const s = freshSettings();
    await s.save({ strength: 4 });
    const writes = () => fake.calls.filter((c) => c.endsWith('.set') || c.endsWith('.remove')).length;
    const before = writes();
    await s.save({ strength: 4 });
    await s.save({});
    assert.equal(writes(), before);
  });

  test('stored garbage is sanitized on load', async () => {
    const fake = installChrome();
    fake.storage.sync.data.set('settings', { mode: 'weird', strength: '5', fade: 500, autoSites: 'x', extra: 1 });
    const s = freshSettings();
    assert.deepEqual(await s.load(), { ...SPEC_DEFAULTS, strength: 5, fade: 60 });
    fake.storage.sync.data.set('settings', 'not an object');
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
  });

  test('onChange delivers full sanitized settings and unsubscribes', async () => {
    const fake = installChrome();
    const s = freshSettings();
    const { seen, cb } = collector();
    const off = s.onChange(cb);
    assert.equal(typeof off, 'function');
    assert.equal(fake.listeners.size, 1);

    await s.save({ strength: 2 });
    await tick();
    await tick();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { ...SPEC_DEFAULTS, strength: 2 });

    // A write from another context, with junk in it.
    await fake.storage.sync.set({ settings: { strength: 4, fade: 999, junk: true } });
    await tick();
    await tick();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { ...SPEC_DEFAULTS, strength: 4, fade: 60 });

    // Other keys and other areas are ignored.
    await fake.storage.sync.set({ other: 1 });
    await fake.storage.session.set({ settings: { strength: 1 } });
    await tick();
    await tick();
    assert.equal(seen.length, 2);

    off();
    assert.equal(fake.listeners.size, 0);
    await s.save({ strength: 1 });
    await tick();
    await tick();
    assert.equal(seen.length, 2);
  });

  test('unsubscribing before a pending delivery resolves suppresses it', async () => {
    const fake = installChrome();
    const s = freshSettings();
    const { seen, cb } = collector();
    const off = s.onChange(cb);
    const [listener] = fake.listeners;
    listener({ settings: { newValue: {} } }, 'sync');
    off();
    await tick();
    await tick();
    assert.equal(seen.length, 0);
  });

  test('onChange ignores a non-function callback', () => {
    installChrome();
    const s = freshSettings();
    const off = s.onChange('nope');
    assert.equal(typeof off, 'function');
    off();
  });

  test('falls back to storage.local when sync rejects for quota, and recovers', async () => {
    const fake = installChrome();
    const s = freshSettings();
    await s.save({ strength: 2 });

    const many = Array.from({ length: 500 }, (_, i) => `https://some-long-site-name-${i}.example.com`);
    const big = await s.save({ autoSites: many });
    assert.equal(big.autoSites.length, 500);
    assert.equal(fake.storage.sync.data.get('settings').autoSites.length, 0, 'sync keeps the old value');
    assert.deepEqual(fake.storage.local.data.get('settings'), big);
    assert.deepEqual(await s.load(), big, 'the local copy wins while it exists');

    const { seen, cb } = collector();
    const off = s.onChange(cb);
    const small = await s.save({ autoSites: ['https://a.com'] });
    assert.deepEqual(fake.storage.sync.data.get('settings'), small);
    assert.equal(fake.storage.local.data.has('settings'), false, 'local copy removed once sync works again');
    assert.deepEqual(await s.load(), small);
    await tick();
    await tick();
    assert.equal(seen.length, 1, 'sync write + local cleanup deliver once');
    assert.deepEqual(seen[0], small);
    off();
  });

  test('onChange skips deliveries identical to the previous one', async () => {
    const fake = installChrome();
    const s = freshSettings();
    const { seen, cb } = collector();
    const off = s.onChange(cb);
    await s.save({ fade: 15 });
    await fake.storage.sync.set({ settings: { ...(await s.load()), junk: 1 } }); // sanitizes to the same value
    await tick();
    await tick();
    assert.equal(seen.length, 1);
    await s.save({ fade: 0 });
    await tick();
    await tick();
    await s.save({ fade: 15 });
    await tick();
    await tick();
    assert.deepEqual(seen.map((x) => x.fade), [15, 0, 15]);
    // A change and its undo landing before delivery coalesce: the subscriber already has that state.
    await s.save({ fade: 1 });
    await s.save({ fade: 15 });
    await tick();
    await tick();
    assert.deepEqual(seen.map((x) => x.fade), [15, 0, 15]);
    off();
  });

  test('works with sync unavailable (every call rejects)', async () => {
    const fake = installChrome();
    Object.assign(fake.storage.sync.fail, { get: true, set: true, remove: true });
    const s = freshSettings();
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
    const saved = await s.save({ fade: 30 });
    assert.equal(fake.storage.local.data.get('settings').fade, 30);
    assert.deepEqual(await s.load(), saved);
  });

  test('keeps local and sync consistent when removing the local copy fails', async () => {
    const fake = installChrome();
    const s = freshSettings();
    fake.storage.sync.fail.set = true;
    await s.save({ fade: 10 });
    fake.storage.sync.fail.set = false;
    fake.storage.local.fail.remove = true;
    const saved = await s.save({ fade: 20 });
    assert.deepEqual(await s.load(), saved);
    assert.equal(fake.storage.local.data.get('settings').fade, 20);
  });

  test('works with only storage.local', async () => {
    const fake = installChrome();
    delete fake.storage.sync;
    const s = freshSettings();
    await s.save({ everyNth: 2 });
    assert.equal(fake.storage.local.data.get('settings').everyNth, 2);
    assert.equal((await s.load()).everyNth, 2);
  });

  test('load never throws, even when the API throws synchronously', async () => {
    const fake = installChrome();
    const boom = () => { throw new Error('Extension context invalidated.'); };
    fake.storage.sync.get = boom;
    fake.storage.local.get = boom;
    const s = freshSettings();
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
  });

  test('save rejects when nothing can be written, and later saves still run', async () => {
    const fake = installChrome();
    fake.storage.sync.fail.set = true;
    fake.storage.local.fail.set = true;
    const s = freshSettings();
    await assert.rejects(s.save({ fade: 5 }), /local set failed/);
    fake.storage.sync.fail.set = false;
    assert.equal((await s.save({ fade: 6 })).fade, 6);
  });

  test('prefers a real `browser` namespace (Firefox) over `chrome`', async () => {
    const chromeFake = installChrome();
    const firefox = fakeStorage();
    globalThis.browser = { runtime: { id: 'ff' }, storage: firefox.storage };
    const s = freshSettings();
    await s.save({ strength: 1 });
    assert.equal(firefox.storage.sync.data.get('settings').strength, 1);
    assert.equal(chromeFake.storage.sync.data.has('settings'), false);
  });

  test('ignores a `browser` global that is not the extension API (e.g. <div id="browser">)', async () => {
    const chromeFake = installChrome();
    globalThis.browser = { tagName: 'DIV', id: 'browser' };
    const s = freshSettings();
    await s.save({ strength: 1 });
    assert.equal(chromeFake.storage.sync.data.get('settings').strength, 1);
  });

  test('onChange without storage.onChanged returns a harmless unsubscribe', () => {
    const fake = installChrome();
    delete fake.storage.onChanged;
    const s = freshSettings();
    const off = s.onChange(() => {});
    off();
  });
});

describe('web fallback (localStorage)', () => {
  test('used when chrome.storage is absent (a normal web page in Chrome)', async () => {
    const { store } = installWeb();
    globalThis.chrome = { loadTimes() {} };
    const s = freshSettings();
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
    const saved = await s.save({ reader: { theme: 'dark' }, mode: 'fixed' });
    assert.deepEqual(JSON.parse(store.data.get('skimbold.settings')), saved);
    assert.deepEqual(await s.load(), saved);
  });

  test('corrupt or foreign values load as sanitized settings', async () => {
    const { store } = installWeb();
    const s = freshSettings();
    store.data.set('skimbold.settings', '{not json');
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
    store.data.set('skimbold.settings', JSON.stringify({ strength: 9, weight: '800' }));
    assert.deepEqual(await s.load(), { ...SPEC_DEFAULTS, strength: 5, weight: 800 });
  });

  test('save notifies subscribers in the same document; the storage event covers other documents', async () => {
    const { fireStorage } = installWeb();
    const s = freshSettings();
    const { seen, cb } = collector();
    const off = s.onChange(cb);

    await s.save({ fade: 40 });
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].fade, 40);

    // Another tab writes a new value.
    globalThis.localStorage.data.set('skimbold.settings', JSON.stringify({ fade: 10, strength: 1 }));
    fireStorage('skimbold.settings', JSON.stringify({ fade: 10, strength: 1 }));
    await tick();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { ...SPEC_DEFAULTS, fade: 10, strength: 1 });

    fireStorage('unrelated', 'x');
    await tick();
    assert.equal(seen.length, 2);

    // localStorage.clear() in another tab fires with key === null.
    globalThis.localStorage.data.clear();
    fireStorage(null, null);
    await tick();
    assert.deepEqual(seen[2], SPEC_DEFAULTS);

    off();
    await s.save({ fade: 50 });
    fireStorage('skimbold.settings', '{}');
    await tick();
    assert.equal(seen.length, 3);
  });

  test('a failing localStorage write keeps the settings for this document', async () => {
    const { store } = installWeb();
    const s = freshSettings();
    await s.save({ strength: 2 });
    store.failSet = true;
    const { seen, cb } = collector();
    const off = s.onChange(cb);
    const saved = await s.save({ strength: 4 });
    assert.equal(saved.strength, 4);
    assert.equal(JSON.parse(store.data.get('skimbold.settings')).strength, 2);
    assert.equal((await s.load()).strength, 4);
    await tick();
    assert.equal(seen.at(-1).strength, 4);
    store.failSet = false;
    await s.save({ strength: 5 });
    assert.equal(JSON.parse(store.data.get('skimbold.settings')).strength, 5);
    assert.equal((await s.load()).strength, 5);
    off();
  });

  test('a throwing localStorage getter (blocked storage) still works in memory', async () => {
    installWeb({ withLocalStorage: false });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    const s = freshSettings();
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
    await s.save({ letters: 1 });
    assert.equal((await s.load()).letters, 1);
  });

  test('plain Node (no chrome, no localStorage, no window events) keeps settings in memory', async () => {
    delete globalThis.chrome;
    delete globalThis.browser;
    delete globalThis.localStorage;
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    const s = freshSettings();
    const { seen, cb } = collector();
    const off = s.onChange(cb);
    assert.deepEqual(await s.load(), SPEC_DEFAULTS);
    await s.save({ skipShort: 2 });
    assert.equal((await s.load()).skipShort, 2);
    await tick();
    assert.equal(seen[0].skipShort, 2);
    off();
  });
});

describe('classic-script loading', () => {
  test('runs twice in one realm (content-script re-injection) without clobbering Skimbold.core', async () => {
    const src = readFileSync(SETTINGS_PATH, 'utf8');
    const ctx = vm.createContext({ URL, setTimeout });
    vm.runInContext('globalThis.Skimbold = { core: "kept" };', ctx);
    vm.runInContext(src, ctx);
    vm.runInContext(src, ctx);
    assert.equal(vm.runInContext('Skimbold.core', ctx), 'kept');
    assert.equal(vm.runInContext('typeof Skimbold.settings.load', ctx), 'function');
    const loaded = await vm.runInContext('Skimbold.settings.load()', ctx);
    assert.equal(loaded.strength, 3);
  });

  test('works in a service-worker-like realm (no window, no localStorage) with chrome.storage', async () => {
    const fake = fakeStorage();
    const ctx = vm.createContext({ URL, setTimeout, chrome: { runtime: { id: 'sw' }, storage: fake.storage } });
    vm.runInContext(readFileSync(SETTINGS_PATH, 'utf8'), ctx);
    const saved = await vm.runInContext('Skimbold.settings.save({ iconClick: "toggle" })', ctx);
    assert.equal(saved.iconClick, 'toggle');
    assert.equal(fake.storage.sync.data.get('settings').iconClick, 'toggle');
  });
});
