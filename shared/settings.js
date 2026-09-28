/*
 * Skimbold settings: defaults, sanitizing, and load/save/subscribe.
 * Runs in content scripts, the Chrome service worker, the Firefox event page,
 * extension pages, plain web pages (localStorage) and Node tests (require()).
 * Wrapped in an IIFE so a second injection into the same content-script world
 * cannot hit a redeclaration error.
 */
(function () {
  'use strict';

  const Skimbold = globalThis.Skimbold || (globalThis.Skimbold = {});

  const STORAGE_KEY = 'settings';
  const WEB_KEY = 'skimbold.settings';
  const MAX_ORIGINS = 500;
  const MAX_ORIGIN_INPUT = 2048;
  // Hostnames as the URL parser normalises them (lower case, IDN in punycode),
  // or a bracketed IPv6 literal. Rejects wildcards and other oddities that
  // would turn into broader match patterns than the user chose.
  const HOST_RE = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

  const MODES = ['auto', 'fixed'];
  const ICON_CLICKS = ['popup', 'toggle'];
  const THEMES = ['auto', 'light', 'sepia', 'dark'];
  const FONTS = ['serif', 'sans'];

  function deepFreeze(obj) {
    for (const value of Object.values(obj)) {
      if (value !== null && typeof value === 'object') deepFreeze(value);
    }
    return Object.freeze(obj);
  }

  const DEFAULTS = deepFreeze({
    mode: 'auto',
    strength: 3,
    letters: 2,
    skipShort: 0,
    everyNth: 1,
    weight: 700,
    fade: 0,
    iconClick: 'popup',
    autoSites: [],
    autoAll: false,
    excludedSites: [],
    reader: { theme: 'auto', fontSize: 20, lineHeight: 1.7, font: 'serif', width: 680, bold: true },
  });

  // Numeric ranges that sanitize() enforces; UI controls can use them for min/max.
  const LIMITS = deepFreeze({
    strength: { min: 1, max: 5 },
    letters: { min: 1, max: 4 },
    skipShort: { min: 0, max: 3 },
    everyNth: { min: 1, max: 3 },
    weight: { min: 600, max: 900, step: 100 },
    fade: { min: 0, max: 60 },
    reader: {
      fontSize: { min: 12, max: 48 },
      lineHeight: { min: 1, max: 3, step: 0.05 },
      width: { min: 320, max: 1600 },
    },
  });

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
  }

  function clampNumber(value, limit, fallback, step) {
    const n = toNumber(value);
    if (Number.isNaN(n)) return fallback;
    const clamped = Math.min(limit.max, Math.max(limit.min, n));
    const rounded = Math.round(clamped / step) * step;
    // Dividing and multiplying by a fractional step can leave float residue (1.7000000000000002).
    return Number(rounded.toFixed(4));
  }

  function clampInt(value, limit, fallback) {
    return clampNumber(value, limit, fallback, 1);
  }

  function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function originOf(url) {
    let parsed;
    try {
      if (typeof url === 'string') parsed = new URL(url.trim());
      else if (url !== null && typeof url === 'object' && typeof url.href === 'string') parsed = new URL(url.href);
      else return null;
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!HOST_RE.test(parsed.hostname)) return null;
    return parsed.origin;
  }

  // The host match pattern for an origin, as the background registers it and the
  // pages request it. The port is left out: Firefox rejects patterns that carry
  // one, and without one both browsers match every port of the host.
  function matchPatternOf(origin) {
    const normalised = originOf(origin);
    if (normalised === null) return null;
    const parsed = new URL(normalised);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  function sanitizeOrigins(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    const seen = new Set();
    for (const item of list) {
      if (typeof item !== 'string' || item.length > MAX_ORIGIN_INPUT) continue;
      const origin = originOf(item);
      if (origin === null || seen.has(origin)) continue;
      seen.add(origin);
      out.push(origin);
      if (out.length === MAX_ORIGINS) break;
    }
    return out;
  }

  function sanitizeReader(value) {
    const src = isObject(value) ? value : {};
    const def = DEFAULTS.reader;
    const lim = LIMITS.reader;
    return {
      theme: pick(src.theme, THEMES, def.theme),
      fontSize: clampInt(src.fontSize, lim.fontSize, def.fontSize),
      lineHeight: clampNumber(src.lineHeight, lim.lineHeight, def.lineHeight, lim.lineHeight.step),
      font: pick(src.font, FONTS, def.font),
      width: clampInt(src.width, lim.width, def.width),
      bold: bool(src.bold, def.bold),
    };
  }

  function sanitize(obj) {
    const src = isObject(obj) ? obj : {};
    return {
      mode: pick(src.mode, MODES, DEFAULTS.mode),
      strength: clampInt(src.strength, LIMITS.strength, DEFAULTS.strength),
      letters: clampInt(src.letters, LIMITS.letters, DEFAULTS.letters),
      skipShort: clampInt(src.skipShort, LIMITS.skipShort, DEFAULTS.skipShort),
      everyNth: clampInt(src.everyNth, LIMITS.everyNth, DEFAULTS.everyNth),
      weight: clampNumber(src.weight, LIMITS.weight, DEFAULTS.weight, LIMITS.weight.step),
      fade: clampInt(src.fade, LIMITS.fade, DEFAULTS.fade),
      iconClick: pick(src.iconClick, ICON_CLICKS, DEFAULTS.iconClick),
      autoSites: sanitizeOrigins(src.autoSites),
      autoAll: bool(src.autoAll, DEFAULTS.autoAll),
      excludedSites: sanitizeOrigins(src.excludedSites),
      reader: sanitizeReader(src.reader),
    };
  }

  // Firefox exposes `browser`; on a page with an element id="browser" that name
  // resolves to the element (named window properties), so require a real API.
  function extensionApi() {
    const b = globalThis.browser;
    const api = b && typeof b === 'object' && b.runtime && b.storage ? b : globalThis.chrome;
    return api && api.storage && (api.storage.sync || api.storage.local) ? api : null;
  }

  async function readArea(area) {
    if (!area) return undefined;
    try {
      const got = await area.get(STORAGE_KEY);
      return got ? got[STORAGE_KEY] : undefined;
    } catch {
      return undefined;
    }
  }

  // A local copy exists only while the latest save could not reach sync
  // (quota, rate limit or sync disabled), so it wins while present.
  async function readExtension(api) {
    const [synced, local] = await Promise.all([
      readArea(api.storage.sync),
      readArea(api.storage.local),
    ]);
    if (local != null) return { value: local, fromLocal: true };
    return { value: synced, fromLocal: false };
  }

  async function writeExtension(api, value, fromLocal) {
    const { sync, local } = api.storage;
    if (sync) {
      try {
        await sync.set({ [STORAGE_KEY]: value });
        if (fromLocal && local) await local.remove(STORAGE_KEY);
        return;
      } catch (err) {
        if (!local) throw err;
      }
    }
    await local.set({ [STORAGE_KEY]: value });
  }

  // Settings this document saved but could not persist (storage blocked or full).
  let webOverride = null;
  const webListeners = new Set();

  function readWeb() {
    if (webOverride) return webOverride;
    try {
      const raw = globalThis.localStorage.getItem(WEB_KEY);
      return raw == null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function writeWeb(value) {
    try {
      globalThis.localStorage.setItem(WEB_KEY, JSON.stringify(value));
      webOverride = null;
    } catch {
      webOverride = sanitize(value);
    }
    // The storage event only reaches other documents, so tell this one directly.
    for (const notify of webListeners) notify();
  }

  async function load() {
    try {
      const api = extensionApi();
      return sanitize(api ? (await readExtension(api)).value : readWeb());
    } catch {
      return sanitize(undefined);
    }
  }

  async function persist(partial) {
    const patch = isObject(partial) ? partial : {};
    const api = extensionApi();
    const stored = api ? await readExtension(api) : { value: readWeb(), fromLocal: false };
    const current = sanitize(stored.value);
    const next = sanitize({
      ...current,
      ...patch,
      reader: { ...current.reader, ...(isObject(patch.reader) ? patch.reader : {}) },
    });
    // Skipping no-op writes spares storage.sync's per-minute write quota.
    if (stored.value != null && JSON.stringify(next) === JSON.stringify(current)) return next;
    if (api) await writeExtension(api, next, stored.fromLocal);
    else writeWeb(next);
    return next;
  }

  // Saves run one at a time so two quick saves in one context cannot both
  // merge into the same stale snapshot and lose one of the changes.
  let saveQueue = Promise.resolve();

  function save(partial) {
    const run = saveQueue.then(() => persist(partial));
    saveQueue = run.catch(() => undefined);
    return run;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => undefined;
    let active = true;
    // One save can touch both areas (sync write + local cleanup); subscribers
    // such as the page engine re-render everything, so skip repeats.
    let lastJson = null;
    const deliver = () => {
      load().then((settings) => {
        const json = JSON.stringify(settings);
        if (!active || json === lastJson) return;
        lastJson = json;
        cb(settings);
      });
    };

    const api = extensionApi();
    if (api) {
      const events = api.storage.onChanged;
      if (!events) return () => undefined;
      const listener = (changes, area) => {
        if ((area === 'sync' || area === 'local') && isObject(changes)
            && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) deliver();
      };
      events.addListener(listener);
      return () => {
        active = false;
        events.removeListener(listener);
      };
    }

    const onStorage = (event) => {
      if (event.key !== WEB_KEY && event.key !== null) return;
      // Another document wrote (or cleared) the shared value; it is now the latest.
      webOverride = null;
      deliver();
    };
    const target = typeof globalThis.addEventListener === 'function' ? globalThis : null;
    if (target) target.addEventListener('storage', onStorage);
    webListeners.add(deliver);
    return () => {
      active = false;
      webListeners.delete(deliver);
      if (target) target.removeEventListener('storage', onStorage);
    };
  }

  const settings = { DEFAULTS, LIMITS, sanitize, load, save, onChange, originOf, matchPatternOf };
  Skimbold.settings = settings;

  if (typeof module === 'object' && module && module.exports) module.exports = settings;
})();
