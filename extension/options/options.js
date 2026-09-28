/*
 * Skimbold options page: every popup setting plus the less frequent ones, the
 * site lists, the shortcut and a reset. Settings save as they change.
 */
(function () {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const { settings, core } = globalThis.Skimbold;

  const ALL_SITES = '*://*/*';
  const SAVE_DELAY = 300;
  const PREVIEW_TEXT = 'Skimbold bolds the start of every word. Your eyes find the bold letters first and the rest of the word follows, which makes it easier to keep your place on a long page.';

  const $ = (id) => document.getElementById(id);
  const ui = {
    preview: $('preview'),
    previewText: $('preview-text'),
    strengthField: $('strength-field'),
    strength: $('strength'),
    strengthValue: $('strength-value'),
    fade: $('fade'),
    fadeValue: $('fade-value'),
    iconClick: $('icon-click'),
    shortcutField: $('shortcut-field'),
    shortcutKeys: $('shortcut-keys'),
    changeShortcut: $('change-shortcut'),
    autoAll: $('auto-all'),
    autoAllHint: $('auto-all-hint'),
    autoSitesBlock: $('auto-sites-block'),
    autoSitesHint: $('auto-sites-hint'),
    autoSites: $('auto-sites'),
    autoSitesEmpty: $('auto-sites-empty'),
    excludedSites: $('excluded-sites'),
    excludedSitesEmpty: $('excluded-sites-empty'),
    reset: $('reset'),
    resetStart: $('reset-start'),
    resetConfirm: $('reset-confirm'),
    resetYes: $('reset-yes'),
    resetNo: $('reset-no'),
    resetStatus: $('reset-status'),
    version: $('version'),
    siteItem: $('site-item'),
  };

  let current = settings.sanitize(undefined);
  // Edits this page made that storage has not confirmed yet; they win over incoming changes.
  let overrides = {};
  let unsaved = {};
  let saving = 0;
  let saveTimer = 0;
  const shownLists = new Map();
  // What this browser allows. Settings sync between browsers, permissions do not, so
  // "everywhere" or a site switched on elsewhere can arrive without access here.
  // Unknown (undefined) until checked, and then shown as allowed, so nothing flashes.
  const grants = { all: undefined, sites: new Map() };

  const AUTO_ALL_HINT = 'Skimbold turns itself on for every website you open. Your browser asks you to allow access to all sites first.';
  const AUTO_ALL_PENDING = 'On in your settings, but this browser hasn’t allowed Skimbold on every site yet. Switch it on to allow it here.';

  function warn(error) {
    console.warn('Skimbold:', error && error.message ? error.message : error);
  }

  /* ── Settings ────────────────────────────────────────────────────────── */

  function receive(stored) {
    current = settings.sanitize({ ...stored, ...overrides });
    render();
    checkGrants();
  }

  function allowed(pattern) {
    return api.permissions.contains({ origins: [pattern] }).catch(() => false);
  }

  async function checkGrants() {
    const origins = current.autoSites.slice();
    const [all, ...sites] = await Promise.all([allowed(ALL_SITES), ...origins.map((origin) => allowed(settings.matchPatternOf(origin)))]);
    grants.all = all;
    grants.sites = new Map(origins.map((origin, i) => [origin, all || sites[i]]));
    render();
  }

  // On everywhere, as far as this browser is concerned.
  function everywhere() {
    return current.autoAll && grants.all !== false;
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

  function reconcile() {
    return api.runtime.sendMessage({ type: 'skb:reconcile' });
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

  // https is the norm, so only other schemes are spelled out.
  function displayOrigin(origin) {
    return origin.startsWith('https://') ? origin.slice('https://'.length) : origin;
  }

  // `needsAccess(origin)`: the site is on the list but this browser has not allowed it yet;
  // such items get an Allow button, which asks the browser inside the click.
  function renderList(list, empty, origins, remove, { needsAccess = () => false, allow = null } = {}) {
    const key = JSON.stringify(origins.map((origin) => [origin, needsAccess(origin)]));
    // Rebuilding an unchanged list would throw away keyboard focus for nothing.
    if (shownLists.get(list) === key) return;
    shownLists.set(list, key);
    const focusedIndex = [...list.querySelectorAll('.sites__remove')].indexOf(document.activeElement);
    const items = origins.map((origin) => {
      const item = ui.siteItem.content.firstElementChild.cloneNode(true);
      const label = displayOrigin(origin);
      item.querySelector('.sites__host').textContent = label;
      const button = item.querySelector('.sites__remove');
      button.setAttribute('aria-label', `Remove ${label}`);
      button.addEventListener('click', () => remove(origin));
      if (allow && needsAccess(origin)) {
        item.querySelector('.sites__status').hidden = false;
        const allowButton = item.querySelector('.sites__allow');
        allowButton.hidden = false;
        allowButton.setAttribute('aria-label', `Allow ${label}`);
        allowButton.addEventListener('click', () => allow(origin));
      }
      return item;
    });
    list.replaceChildren(...items);
    empty.hidden = origins.length > 0;
    // After a removal, keep the keyboard in the list: the next site, or the list's heading.
    if (focusedIndex >= 0) {
      const buttons = list.querySelectorAll('.sites__remove');
      const next = buttons[Math.min(focusedIndex, buttons.length - 1)];
      if (next) next.focus();
      else focusHeading(list);
    }
  }

  function focusHeading(list) {
    const heading = document.getElementById(list.getAttribute('aria-labelledby'));
    heading.tabIndex = -1;
    heading.focus();
  }

  function render() {
    check('letters', current.mode === 'auto' ? 'auto' : String(current.letters));
    check('weight', String(current.weight));
    check('skipShort', String(current.skipShort));
    check('everyNth', String(current.everyNth));
    ui.strengthField.hidden = current.mode !== 'auto';
    ui.strength.value = String(current.strength);
    syncRange(ui.strength, ui.strengthValue, String(current.strength));
    ui.fade.value = String(current.fade);
    syncRange(ui.fade, ui.fadeValue, current.fade === 0 ? 'Off' : `${current.fade}%`);
    ui.iconClick.value = current.iconClick;
    const onEverywhere = everywhere();
    ui.autoAll.checked = onEverywhere;
    ui.autoAllHint.textContent = current.autoAll && !onEverywhere ? AUTO_ALL_PENDING : AUTO_ALL_HINT;
    ui.autoSitesBlock.classList.toggle('sites--paused', onEverywhere);
    ui.autoSitesHint.textContent = onEverywhere
      ? 'Set aside while Skimbold is on everywhere. They’re used again if you turn that off.'
      : 'To add a site, open it, click the Skimbold icon and switch on “Always on”.';
    renderList(ui.autoSites, ui.autoSitesEmpty, current.autoSites, removeAutoSite, {
      needsAccess: (origin) => !onEverywhere && grants.sites.get(origin) === false,
      allow: allowSite,
    });
    renderList(ui.excludedSites, ui.excludedSitesEmpty, current.excludedSites, removeExcludedSite);
    renderPreview();
  }

  /* ── Sites ───────────────────────────────────────────────────────────── */

  // Least privilege: hand back a site's access once nothing needs it.
  function releaseSite(origin) {
    const pattern = settings.matchPatternOf(origin);
    if (current.autoAll || current.autoSites.some((site) => settings.matchPatternOf(site) === pattern)) return;
    api.permissions.remove({ origins: [pattern] }).catch(() => undefined);
  }

  function removeAutoSite(origin) {
    edit({ autoSites: current.autoSites.filter((site) => site !== origin) })
      .then(() => {
        releaseSite(origin);
        return reconcile();
      })
      .catch(warn);
  }

  function allowSite(origin) {
    // Must be called inside the click: browsers only show a permission prompt for a user gesture.
    api.permissions.request({ origins: [settings.matchPatternOf(origin)] })
      .catch(() => false)
      .then(() => checkGrants())
      .then(reconcile)
      .catch(warn);
  }

  function removeExcludedSite(origin) {
    edit({ excludedSites: current.excludedSites.filter((site) => site !== origin) })
      .then(reconcile)
      .catch(warn);
  }

  function onAutoAllChange() {
    if (!ui.autoAll.checked) {
      edit({ autoAll: false })
        .then(() => {
          // Only the everywhere grant goes; sites allowed one by one keep their access.
          api.permissions.remove({ origins: [ALL_SITES] }).catch(() => undefined);
          return reconcile();
        })
        .catch(warn);
      return;
    }
    // Must be called inside the click: browsers only show a permission prompt for a user gesture.
    api.permissions.request({ origins: [ALL_SITES] })
      .catch(() => false)
      .then((granted) => {
        grants.all = granted;
        if (!granted) {
          render();
          return undefined;
        }
        // Already on in the settings when it came from another browser; reconcile either way.
        return edit({ autoAll: true }).then(reconcile);
      })
      .catch(warn);
  }

  /* ── Shortcut ────────────────────────────────────────────────────────── */

  function keyChips(shortcut) {
    // macOS reports symbols with no separator (⌃⇧R); those stay one chip.
    const keys = shortcut.length > 1 && shortcut.includes('+') ? shortcut.split('+') : [shortcut];
    const nodes = [];
    keys.forEach((key, i) => {
      if (i > 0) nodes.push(document.createTextNode(' + '));
      const chip = document.createElement('kbd');
      chip.className = 'skb-kbd';
      chip.textContent = key;
      nodes.push(chip);
    });
    return nodes;
  }

  async function renderShortcut() {
    if (!api.commands || typeof api.commands.getAll !== 'function') {
      ui.shortcutField.hidden = true;
      return;
    }
    const commands = await api.commands.getAll();
    const command = commands.find((item) => item.name === 'toggle-page');
    const shortcut = command && command.shortcut;
    if (shortcut) {
      ui.shortcutKeys.replaceChildren(...keyChips(shortcut));
      ui.changeShortcut.textContent = 'Change shortcut';
    } else {
      ui.shortcutKeys.textContent = 'Not set';
      ui.changeShortcut.textContent = 'Set a shortcut';
    }
  }

  function openShortcutSettings() {
    const opened = typeof api.commands.openShortcutSettings === 'function'
      ? api.commands.openShortcutSettings()
      : api.tabs.create({ url: 'chrome://extensions/shortcuts' });
    Promise.resolve(opened).catch(warn);
  }

  /* ── Reset ───────────────────────────────────────────────────────────── */

  function showResetConfirm(show) {
    ui.resetStart.hidden = show;
    ui.resetConfirm.hidden = !show;
    (show ? ui.resetNo : ui.reset).focus();
  }

  // Hands back every site permission the user granted; the manifest's own stay.
  async function releaseAllSites() {
    const required = new Set(api.runtime.getManifest().host_permissions || []);
    const { origins = [] } = await api.permissions.getAll();
    const optional = origins.filter((origin) => !required.has(origin));
    if (optional.length) await api.permissions.remove({ origins: optional }).catch(() => undefined);
  }

  async function resetAll() {
    clearTimeout(saveTimer);
    unsaved = {};
    overrides = {};
    current = await settings.save(settings.sanitize(undefined));
    render();
    await releaseAllSites();
    await reconcile();
    showResetConfirm(false);
    ui.resetStatus.textContent = 'Settings are back to their defaults.';
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  $('letters').addEventListener('change', (event) => {
    const value = event.target.value;
    edit(value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', letters: Number(value) });
  });
  $('weight').addEventListener('change', (event) => edit({ weight: Number(event.target.value) }));
  $('skip-short').addEventListener('change', (event) => edit({ skipShort: Number(event.target.value) }));
  $('every-nth').addEventListener('change', (event) => edit({ everyNth: Number(event.target.value) }));

  ui.strength.addEventListener('input', () => edit({ strength: Number(ui.strength.value) }, { now: false }));
  ui.strength.addEventListener('change', flush);
  ui.fade.addEventListener('input', () => edit({ fade: Number(ui.fade.value) }, { now: false }));
  ui.fade.addEventListener('change', flush);

  ui.iconClick.addEventListener('change', () => edit({ iconClick: ui.iconClick.value }));
  ui.autoAll.addEventListener('change', onAutoAllChange);
  ui.changeShortcut.addEventListener('click', openShortcutSettings);

  ui.reset.addEventListener('click', () => {
    ui.resetStatus.textContent = '';
    showResetConfirm(true);
  });
  ui.resetNo.addEventListener('click', () => showResetConfirm(false));
  ui.resetYes.addEventListener('click', () => {
    resetAll().catch(warn);
  });

  // The shortcut and site access are changed on the browser's own pages; show them on return.
  addEventListener('focus', () => {
    renderShortcut().catch(warn);
    checkGrants().catch(warn);
  });
  if (api.permissions.onAdded) api.permissions.onAdded.addListener(() => checkGrants().catch(warn));
  if (api.permissions.onRemoved) api.permissions.onRemoved.addListener(() => checkGrants().catch(warn));
  ui.version.textContent = `version ${api.runtime.getManifest().version}`;
  render();
  settings.load().then(receive);
  settings.onChange(receive);
  renderShortcut().catch(warn);
})();
