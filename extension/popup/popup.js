/*
 * Skimbold popup. Paints at once from the last settings this panel saw, then
 * fills in the real settings and the current tab's state as they arrive.
 * Open it with ?tab=<id> to point it at a specific tab (used by the tests).
 */
(function () {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const { settings, core } = globalThis.Skimbold;

  const CACHE_KEY = 'skimbold.popup.settings';
  const SHORTCUT_FLAG = 'shortcutConflict';
  const SAVE_DELAY = 300;
  const PREVIEW_TEXT = 'Bold word starts give your eyes a place to land.';
  const MESSAGES = {
    restricted: 'Browsers don’t let extensions change this page. Open a regular website to use Skimbold.',
    file: 'For files on your computer, turn on “Allow access to file URLs” in Skimbold’s details on the extensions page.',
    blocked: 'Skimbold couldn’t reach this page. Reload it and try again.',
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    toggle: $('toggle'),
    toggleText: $('toggle-text'),
    openPdf: $('open-pdf'),
    notice: $('notice'),
    shortcut: $('shortcut'),
    announce: $('announce'),
    preview: $('preview'),
    previewText: $('preview-text'),
    strengthField: $('strength-field'),
    strength: $('strength'),
    strengthValue: $('strength-value'),
    fade: $('fade'),
    fadeValue: $('fade-value'),
    siteRow: $('site-row'),
    siteText: $('site-text'),
    site: $('site'),
  };

  const tabParam = new URLSearchParams(location.search).get('tab');
  const requestedTab = tabParam && /^\d+$/.test(tabParam) ? Number(tabParam) : null;

  let current = readCache();
  // Edits this panel made that storage has not confirmed yet; they win over incoming changes.
  let overrides = {};
  let unsaved = {};
  let saving = 0;
  let saveTimer = 0;

  let tabId = null;
  let info = null;
  let siteGranted = false;
  // Settings sync between browsers, permissions do not: "everywhere" counts here only
  // once this browser allows every site.
  let allGranted = false;
  // True while the browser's permission prompt is open, so the switch stays on meanwhile.
  let asking = false;
  let busy = false;

  function warn(error) {
    console.warn('Skimbold:', error && error.message ? error.message : error);
  }

  /* ── Settings ────────────────────────────────────────────────────────── */

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return settings.sanitize(raw ? JSON.parse(raw) : undefined);
    } catch {
      return settings.sanitize(undefined);
    }
  }

  function writeCache(value) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
      // Only a head start for the next opening; the real settings arrive a moment later.
    }
  }

  function receive(stored) {
    writeCache(stored);
    current = settings.sanitize({ ...stored, ...overrides });
    render();
  }

  function flush() {
    clearTimeout(saveTimer);
    const patch = unsaved;
    unsaved = {};
    if (Object.keys(patch).length === 0) return Promise.resolve();
    saving++;
    return settings.save(patch)
      .catch(warn)
      .finally(() => {
        saving--;
        if (saving === 0 && Object.keys(unsaved).length === 0) overrides = {};
      });
  }

  // Sliders call this on every input; the save waits for a pause so storage.sync's
  // write quota is not spent on each step of a drag.
  function edit(patch, { now = true } = {}) {
    Object.assign(overrides, patch);
    Object.assign(unsaved, patch);
    current = settings.sanitize({ ...current, ...patch });
    render();
    if (now) return flush();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
    return Promise.resolve();
  }

  /* ── Rendering ───────────────────────────────────────────────────────── */

  function check(name, value) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
      input.checked = input.value === value;
    }
  }

  function syncRange(range, output, text) {
    const min = Number(range.min);
    const max = Number(range.max);
    range.style.setProperty('--skb-fill', `${((Number(range.value) - min) / (max - min)) * 100}%`);
    output.textContent = text;
    range.setAttribute('aria-valuetext', text);
  }

  function fadeText(fade) {
    return fade === 0 ? 'Off' : `${fade}%`;
  }

  function renderPreview() {
    const parts = core.transform(PREVIEW_TEXT, current) || [{ t: PREVIEW_TEXT, b: false }];
    const nodes = parts.map((part) => {
      if (!part.b) return document.createTextNode(part.t);
      const bold = document.createElement('b');
      bold.textContent = part.t;
      return bold;
    });
    ui.previewText.replaceChildren(...nodes);
    ui.preview.style.setProperty('--preview-weight', String(current.weight));
    ui.preview.style.setProperty('--preview-fade', `${current.fade}%`);
  }

  function hostOf(origin) {
    return new URL(origin).host;
  }

  function everywhere() {
    return current.autoAll && allGranted;
  }

  function renderSite() {
    if (!info) return;
    const origin = info.origin;
    ui.siteRow.dataset.pending = 'false';
    ui.siteRow.hidden = info.restricted || !origin;
    if (ui.siteRow.hidden) return;
    if (everywhere()) {
      ui.siteText.textContent = `Skip ${hostOf(origin)}`;
      ui.site.checked = current.excludedSites.includes(origin);
    } else {
      ui.siteText.textContent = `Always on for ${hostOf(origin)}`;
      ui.site.checked = (siteGranted || asking) && current.autoSites.includes(origin);
    }
  }

  function render() {
    check('letters', current.mode === 'auto' ? 'auto' : String(current.letters));
    check('weight', String(current.weight));
    ui.strengthField.hidden = current.mode !== 'auto';
    ui.strength.value = String(current.strength);
    syncRange(ui.strength, ui.strengthValue, String(current.strength));
    ui.fade.value = String(current.fade);
    syncRange(ui.fade, ui.fadeValue, fadeText(current.fade));
    renderPreview();
    renderSite();
  }

  // A notice takes the shortcut line's place: the shortcut can't help on a page Skimbold can't reach.
  function showNotice(text) {
    ui.notice.textContent = text || '';
    ui.notice.hidden = !text;
    ui.shortcut.classList.toggle('shortcut--covered', Boolean(text));
  }

  function renderPage() {
    const restricted = !info || info.restricted;
    const active = Boolean(info && info.active);
    // Browsers draw PDFs in their own viewer, out of an extension's reach, so the Reader
    // takes the toggle's place unless Skimbold is somehow on and needs turning off.
    const pdf = Boolean(info && info.pdf);
    ui.openPdf.hidden = !pdf;
    ui.toggle.hidden = pdf && !active;
    ui.toggle.disabled = restricted;
    ui.toggle.dataset.active = String(active);
    ui.toggle.classList.toggle('skb-btn--primary', !active && !pdf);
    ui.toggleText.textContent = active ? 'On — turn off' : 'Turn on for this page';
    if (restricted) showNotice(MESSAGES.restricted);
    renderSite();
  }

  /* ── Shortcut ────────────────────────────────────────────────────────── */

  function keyChips(shortcut) {
    // macOS reports symbols with no separator (⌃⇧R); those stay one chip.
    const keys = shortcut.length > 1 && shortcut.includes('+') ? shortcut.split('+') : [shortcut];
    const wrap = document.createElement('span');
    wrap.className = 'shortcut__keys';
    keys.forEach((key, i) => {
      if (i > 0) wrap.append(' + ');
      const chip = document.createElement('kbd');
      chip.className = 'skb-kbd';
      chip.textContent = key;
      wrap.append(chip);
    });
    return wrap;
  }

  function openShortcutSettings() {
    const opened = typeof api.commands.openShortcutSettings === 'function'
      ? api.commands.openShortcutSettings()
      : api.tabs.create({ url: 'chrome://extensions/shortcuts' });
    Promise.resolve(opened).then(closePopup, warn);
  }

  async function renderShortcut() {
    if (!api.commands || typeof api.commands.getAll !== 'function') {
      ui.shortcut.hidden = true;
      return;
    }
    const [commands, flags] = await Promise.all([
      api.commands.getAll(),
      api.storage.local.get(SHORTCUT_FLAG).catch(() => ({})),
    ]);
    const command = commands.find((item) => item.name === 'toggle-page');
    const shortcut = command && command.shortcut;
    if (shortcut) {
      const label = document.createElement('span');
      label.textContent = 'Shortcut';
      ui.shortcut.replaceChildren(label, keyChips(shortcut));
      if (flags[SHORTCUT_FLAG]) api.storage.local.remove(SHORTCUT_FLAG).catch(() => undefined);
      return;
    }
    const suggested = api.runtime.getManifest().commands['toggle-page'].suggested_key.default;
    const text = document.createElement('span');
    text.textContent = flags[SHORTCUT_FLAG] ? `${suggested} is already in use.` : 'No shortcut set.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skb-btn skb-btn--small';
    button.id = 'set-shortcut';
    button.textContent = 'Set a shortcut';
    button.addEventListener('click', openShortcutSettings);
    ui.shortcut.replaceChildren(text, button);
  }

  /* ── Tab ─────────────────────────────────────────────────────────────── */

  function isPopupWindow() {
    try {
      return api.extension.getViews({ type: 'popup' }).includes(window);
    } catch {
      return false;
    }
  }

  function closePopup() {
    if (isPopupWindow()) window.close();
  }

  async function findTab() {
    if (requestedTab !== null) return requestedTab;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab && Number.isInteger(tab.id) ? tab.id : null;
  }

  async function loadTab() {
    tabId = await findTab();
    const reply = tabId === null ? null : await api.runtime.sendMessage({ type: 'skb:getTabInfo', tabId });
    info = reply && typeof reply === 'object' && 'restricted' in reply
      ? reply
      : { restricted: true, active: false, pdf: false, origin: null, url: '' };
    if (info.origin && !info.restricted) {
      [siteGranted, allGranted] = await Promise.all([
        api.permissions.contains({ origins: [settings.matchPatternOf(info.origin)] }).catch(() => false),
        api.permissions.contains({ origins: ['*://*/*'] }).catch(() => false),
      ]);
    }
    renderPage();
  }

  const tabReady = loadTab().catch((error) => {
    warn(error);
    info = { restricted: true, active: false, pdf: false, origin: null, url: '' };
    renderPage();
  });

  async function toggleTab() {
    await tabReady;
    if (busy || !info || info.restricted || tabId === null) return;
    busy = true;
    try {
      const result = await api.runtime.sendMessage({ type: 'skb:toggleTab', tabId });
      if (result && result.ok) {
        info.active = result.active;
        showNotice('');
        ui.announce.textContent = result.active ? 'Skimbold is on for this page.' : 'Skimbold is off for this page.';
      } else if (result && result.reason === 'restricted') {
        info.restricted = true;
      } else if (result && result.reason === 'pdf') {
        info.pdf = true;
      } else {
        showNotice(/^file:/i.test(info.url) ? MESSAGES.file : MESSAGES.blocked);
      }
      renderPage();
    } finally {
      busy = false;
    }
  }

  function setPageActive(active) {
    if (info && !info.restricted && info.active !== active) toggleTab();
  }

  /* ── Always on for this site / Skip this site ───────────────────────── */

  function withOrigin(list, origin) {
    return list.includes(origin) ? list : [...list, origin];
  }

  function withoutOrigin(list, origin) {
    return list.filter((item) => item !== origin);
  }

  function reconcile() {
    return api.runtime.sendMessage({ type: 'skb:reconcile' });
  }

  // Least privilege: hand back the site's access once nothing needs it.
  function releaseSite(origin) {
    const pattern = settings.matchPatternOf(origin);
    if (current.autoAll || current.autoSites.some((site) => settings.matchPatternOf(site) === pattern)) return;
    api.permissions.remove({ origins: [pattern] }).catch(() => undefined);
  }

  function onSiteChange() {
    const origin = info && info.origin;
    if (!origin) return;
    const on = ui.site.checked;

    if (everywhere()) {
      const excludedSites = on ? withOrigin(current.excludedSites, origin) : withoutOrigin(current.excludedSites, origin);
      edit({ excludedSites })
        .then(reconcile)
        .then(() => { if (on) setPageActive(false); })
        .catch(warn);
      return;
    }

    if (!on) {
      edit({ autoSites: withoutOrigin(current.autoSites, origin) })
        .then(() => {
          releaseSite(origin);
          return reconcile();
        })
        .catch(warn);
      return;
    }

    // Must be called inside the click: browsers only show a permission prompt for a user gesture.
    const request = api.permissions.request({ origins: [settings.matchPatternOf(origin)] });
    asking = true;
    // Saved before the answer, because Firefox closes the popup while its prompt is open.
    // The background only registers sites whose permission was granted. A site skipped
    // back when Skimbold was on everywhere is not skipped any more.
    const saved = edit({ autoSites: withOrigin(current.autoSites, origin), excludedSites: withoutOrigin(current.excludedSites, origin) });
    request.catch(() => false).then(async (granted) => {
      await saved;
      asking = false;
      if (!granted) {
        await edit({ autoSites: withoutOrigin(current.autoSites, origin) });
        return;
      }
      siteGranted = true;
      renderSite();
      await reconcile();
      setPageActive(true);
    }).catch(warn);
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  document.getElementById('letters').addEventListener('change', (event) => {
    const value = event.target.value;
    edit(value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', letters: Number(value) });
  });

  document.getElementById('weight').addEventListener('change', (event) => {
    edit({ weight: Number(event.target.value) });
  });

  ui.strength.addEventListener('input', () => edit({ strength: Number(ui.strength.value) }, { now: false }));
  ui.strength.addEventListener('change', flush);
  ui.fade.addEventListener('input', () => edit({ fade: Number(ui.fade.value) }, { now: false }));
  ui.fade.addEventListener('change', flush);

  ui.site.addEventListener('change', onSiteChange);
  ui.toggle.addEventListener('click', toggleTab);

  ui.openPdf.addEventListener('click', () => {
    if (!info || !info.url) return;
    // The Reader opens in a regular window; from a private one it keeps nothing.
    const query = `?pdf=${encodeURIComponent(info.url)}&tab=${tabId}${info.incognito ? '&private=1' : ''}`;
    api.tabs.create({ url: api.runtime.getURL(`reader/reader.html${query}`) }).then(closePopup, warn);
  });

  document.getElementById('open-settings').addEventListener('click', () => {
    api.runtime.openOptionsPage().then(closePopup, warn);
  });

  render();
  settings.load().then(receive);
  settings.onChange(receive);
  renderShortcut().catch(warn);
})();
