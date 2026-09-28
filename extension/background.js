/*
 * Skimbold background: the Chromium service worker and the Firefox event page.
 * No DOM and no window. Every listener is registered synchronously at the top
 * level, so the browser can wake this script for any of its events.
 */
if (typeof importScripts === 'function') importScripts('shared/settings.js');

(function () {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const Skimbold = globalThis.Skimbold;
  const settings = Skimbold.settings;

  const ENGINE_FILES = ['shared/settings.js', 'shared/core.js', 'content/engine.js'];
  const AUTO_ID = 'skb-auto';
  const AUTO_FILES = [...ENGINE_FILES, 'content/auto.js'];
  // Frames that load after the toggle are synced at most once per FRAME_SYNC_MS per
  // tab (up to MAX_FRAME_SYNC_MS while looking finds nothing to do), and one frame at
  // most once per FRAME_RESYNC_MS, so a page whose frames keep reloading (an ad slot,
  // a live widget) costs little. More frame ids than MAX_FRAME_IDS at once are looked
  // up all together.
  const FRAME_SYNC_MS = 500;
  const MAX_FRAME_SYNC_MS = 8000;
  const FRAME_RESYNC_MS = 2000;
  const MAX_FRAME_IDS = 64;
  const SYNC_MESSAGE = Object.freeze({ type: 'skb:set', active: true, sync: true });
  const ALL_SITES = '*://*/*';
  const READER_PAGE = 'reader/reader.html';
  const SHORTCUT_FLAG = 'shortcutConflict';
  const MENU_TOGGLE = 'skb-toggle-page';
  const MENU_SELECTION = 'skb-read-selection';
  const MENU_READER = 'skb-open-reader';

  // Pages no extension may script. Asking first gives a clear answer instead of a failed injection.
  const RESTRICTED_SCHEMES = new Set([
    'chrome:', 'edge:', 'brave:', 'opera:', 'vivaldi:', 'about:', 'view-source:',
    'chrome-extension:', 'moz-extension:', 'devtools:', 'chrome-search:', 'chrome-untrusted:', 'resource:',
  ]);
  const RESTRICTED_STORES = [
    { host: 'chromewebstore.google.com', path: '/' },
    { host: 'chrome.google.com', path: '/webstore' },
    { host: 'microsoftedge.microsoft.com', path: '/addons' },
    { host: 'addons.mozilla.org', path: '/' },
  ];
  // Firefox's default extensions.webextensions.restrictedDomains: no extension may
  // script these there, although they are ordinary sites elsewhere.
  const FIREFOX_RESTRICTED_HOSTS = new Set([
    'accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org',
    'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org',
    'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com',
  ]);

  function warn(error) {
    console.warn('Skimbold:', error && error.message ? error.message : error);
  }

  // Runs calls one after another, so overlapping triggers can never interleave.
  function serial() {
    let queue = Promise.resolve();
    return (task) => {
      const run = queue.then(task);
      queue = run.catch(() => undefined);
      return run;
    };
  }

  function parseUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  function isFirefox() {
    return typeof api.runtime.getBrowserInfo === 'function';
  }

  function isRestricted(url) {
    const parsed = url ? parseUrl(url) : null;
    if (!parsed) return false;
    if (RESTRICTED_SCHEMES.has(parsed.protocol)) return true;
    if (isFirefox() && FIREFOX_RESTRICTED_HOSTS.has(parsed.hostname)) return true;
    return RESTRICTED_STORES.some((store) => parsed.hostname === store.host && parsed.pathname.startsWith(store.path));
  }

  // A tab is taken for a PDF only when its address says so, or when the engine in it
  // reports the document's type (see topFrameState). A page that merely refuses the
  // engine is not one: Firefox refuses its PDF viewer, but also other pages.
  function isPdfUrl(url) {
    const parsed = url ? parseUrl(url) : null;
    return Boolean(parsed) && /\.pdf$/i.test(parsed.pathname);
  }

  function uniquePatterns(origins) {
    return [...new Set(origins.map(settings.matchPatternOf).filter(Boolean))];
  }

  // Skipped sites keep their port where the browser can match one: skipping
  // localhost:3000 must not skip every other port of localhost. Firefox rejects
  // patterns with a port, so there such origins are left to auto.js, which
  // compares whole origins.
  function excludePatterns(origins) {
    const patterns = origins.map((origin) => {
      const parsed = parseUrl(origin);
      if (!parsed || !parsed.port) return settings.matchPatternOf(origin);
      return isFirefox() ? null : `${parsed.protocol}//${parsed.hostname}:${parsed.port}/*`;
    });
    return [...new Set(patterns.filter(Boolean))];
  }

  function hasHostPermission(pattern) {
    return api.permissions.contains({ origins: [pattern] }).catch(() => false);
  }

  /* ── Badge ─────────────────────────────────────────────────────────────── */

  function setBadge(tabId, active) {
    if (!api.action) return;
    // The tab may have closed since the state was reported.
    api.action.setBadgeText({ tabId, text: active ? 'ON' : '' }).catch(() => undefined);
  }

  function setBadgeColors() {
    if (!api.action) return;
    api.action.setBadgeBackgroundColor({ color: '#1F5E46' }).catch(warn);
    if (typeof api.action.setBadgeTextColor === 'function') {
      api.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(warn);
    }
  }

  /* ── Toggling a tab ────────────────────────────────────────────────────── */

  // Resolves to the engine's {active, pdf} in the top frame, or null when no engine answers.
  async function topFrameState(tabId) {
    try {
      const reply = await api.tabs.sendMessage(tabId, { type: 'skb:getState' }, { frameId: 0 });
      return reply && typeof reply === 'object' ? reply : null;
    } catch {
      return null;
    }
  }

  const PDF_RESULT = Object.freeze({ ok: false, active: false, reason: 'pdf' });

  function inject(target, injectImmediately = true) {
    return api.scripting.executeScript({ target, files: ENGINE_FILES, injectImmediately });
  }

  // Runs in a frame: the engine's state there, or null where it is not loaded.
  function engineState() {
    const engine = globalThis.Skimbold && globalThis.Skimbold.engine;
    return engine && typeof engine.isActive === 'function' ? engine.isActive() : null;
  }

  // The engine's state in each frame, as [frameId, true | false | null]: every frame
  // of the tab (frameIds null), in one quick look, or the frames named.
  async function frameStates(tabId, frameIds) {
    if (frameIds === null) {
      const results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, func: engineState });
      return results.map((result) => [result.frameId, typeof result.result === 'boolean' ? result.result : null]);
    }
    return Promise.all(frameIds.map(async (frameId) => {
      const reply = await api.tabs.sendMessage(tabId, { type: 'skb:getState' }, { frameId }).catch(() => null);
      return [frameId, reply && typeof reply === 'object' ? Boolean(reply.active) : null];
    }));
  }

  // Brings frames of the tab (all of them, or the frameIds named) to the top frame's
  // state when that is on. Frames without the engine get it first; they are injected
  // at once, whatever state they are in, since waiting would hold this up for as
  // long as a lazy frame stays unloaded or a slow one keeps loading. Frames that
  // already run it are left alone. A frame that loads later asks for this again
  // (skb:frames). Resolves to how many frames it brought in line, and whether a
  // frame named by id could not be reached.
  async function syncFrames(tabId, frameIds = null) {
    const result = { synced: 0, missed: false };
    const top = await topFrameState(tabId);
    if (!top || !top.active) return result;
    const states = await frameStates(tabId, frameIds);
    const off = states.filter(([, state]) => state === false).map(([frameId]) => frameId);
    const missing = states.filter(([, state]) => state === null).map(([frameId]) => frameId);
    if (missing.length > 0) {
      try {
        await inject({ tabId, frameIds: missing });
        off.push(...missing);
      } catch {
        // One of them went away or cannot be scripted; the others still get the engine.
        const injected = await Promise.all(missing.map((frameId) => inject({ tabId, frameIds: [frameId] }).then(() => frameId, () => null)));
        off.push(...injected.filter((frameId) => frameId !== null));
        result.missed = frameIds !== null && injected.includes(null);
      }
    }
    const now = await topFrameState(tabId);
    if (!now || !now.active) return result;
    // Each frame learns its id, so the page that holds it can name it when it loads again.
    await Promise.all(off.map((frameId) => api.tabs.sendMessage(tabId, { ...SYNC_MESSAGE, frameId }, { frameId }).catch(() => undefined)));
    result.synced = off.length;
    return result;
  }

  // Frame syncs asked for by the tab's pages (skb:frames), coalesced per tab.
  const frameSyncs = new Map(); // tabId → { ids, all, left, synced, wait, timer, lastAt, running }

  function frameJob(tabId) {
    let job = frameSyncs.get(tabId);
    if (!job) {
      job = { ids: new Set(), all: false, left: new Set(), synced: new Map(), wait: FRAME_SYNC_MS, timer: 0, lastAt: -Infinity, running: false };
      frameSyncs.set(tabId, job);
    }
    return job;
  }

  // A page tells which frames loaded when it can (see requestFrames in engine.js), and
  // whether one it had not seen before is among them. A frame that reloads has
  // announced itself while leaving its last page, so its id is known here too. When
  // no frame is known, every frame of the tab is looked at.
  function onFramesMessage(message, sender) {
    const job = frameJob(sender.tab.id);
    if (message.leaving) {
      if (Number.isInteger(sender.frameId) && sender.frameId > 0) job.left.add(sender.frameId);
      return;
    }
    const ids = Array.isArray(message.frameIds) ? message.frameIds : [];
    for (const frameId of [...ids, ...job.left]) {
      if (Number.isInteger(frameId) && frameId > 0) job.ids.add(frameId);
    }
    job.left.clear();
    if (message.fresh || job.ids.size > 0) job.wait = FRAME_SYNC_MS;
    if (message.fresh || job.ids.size === 0 || job.ids.size > MAX_FRAME_IDS) job.all = true;
    planFrameSync(sender.tab.id, job);
  }

  function planFrameSync(tabId, job) {
    if (job.timer !== 0 || job.running) return;
    job.timer = setTimeout(() => runFrameSync(tabId, job), Math.max(0, job.lastAt + job.wait - Date.now()));
  }

  async function runFrameSync(tabId, job) {
    job.timer = 0;
    job.running = true;
    const now = Date.now();
    job.lastAt = now;
    // A frame synced less than FRAME_RESYNC_MS ago waits for its turn.
    const due = job.all ? null : [...job.ids].filter((frameId) => now - (job.synced.get(frameId) ?? -Infinity) >= FRAME_RESYNC_MS);
    if (due === null) job.ids.clear();
    for (const frameId of due ?? []) {
      job.ids.delete(frameId);
      job.synced.set(frameId, now);
    }
    job.all = false;
    try {
      if (due === null || due.length > 0) {
        const { synced, missed } = await syncFrames(tabId, due);
        // A frame named by id that is gone may have been replaced by a new one (its
        // element was moved), which a look at every frame finds.
        if (missed) job.all = true;
        // A look at every frame that finds nothing to do (a frame out of reach that
        // keeps reloading) makes the next such look wait twice as long.
        job.wait = due === null && synced === 0 ? Math.min(job.wait * 2, MAX_FRAME_SYNC_MS) : FRAME_SYNC_MS;
      }
    } catch {
      // The tab closed or navigated meanwhile.
    } finally {
      job.running = false;
      if (job.all || job.ids.size > 0) planFrameSync(tabId, job);
    }
  }

  async function toggleNow(tab) {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return { ok: false, active: false, reason: 'no-tab' };
    if (isRestricted(tab.url)) return { ok: false, active: false, reason: 'restricted' };
    const tabId = tab.id;
    const state = await topFrameState(tabId);
    if (state && state.pdf && !state.active) return { ...PDF_RESULT };
    if (!state) {
      try {
        // Only the top frame is waited for; the other frames follow it (syncFrames).
        await inject({ tabId, frameIds: [0] }, false);
      } catch {
        // A browser's PDF viewer may refuse scripts (Firefox's does); the Reader can
        // still open the file when the address shows it is one.
        return isPdfUrl(tab.url) ? { ...PDF_RESULT } : { ok: false, active: false, reason: 'blocked' };
      }
    }
    const message = { type: 'skb:set', active: !(state && state.active) };
    let reply = null;
    try {
      // The top frame's answer is the page's state; a subframe (an embedded PDF, an
      // editor in design mode) may well decline.
      reply = await api.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      reply = null;
    }
    if (!reply || typeof reply !== 'object') return { ok: false, active: false, reason: 'blocked' };
    const active = Boolean(reply.active);
    setBadge(tabId, active);
    // Frames that already run the engine follow straight away.
    api.tabs.sendMessage(tabId, message).catch(() => undefined);
    if (active) syncFrames(tabId).catch(() => undefined);
    if (!active && !state) {
      // The engine declines a browser PDF viewer, whose text it cannot reach.
      const now = await topFrameState(tabId);
      if (now && now.pdf) return { ...PDF_RESULT };
    }
    return { ok: true, active };
  }

  const toggleQueues = new Map();

  // Queued per tab, so pressing the shortcut twice quickly turns the page on and then off
  // again, and a page that never answers cannot hold up the other tabs.
  function toggleTab(tab) {
    const key = tab ? tab.id : undefined;
    const run = (toggleQueues.get(key) || Promise.resolve()).then(() => toggleNow(tab));
    const settled = run.catch(() => undefined);
    toggleQueues.set(key, settled);
    settled.then(() => {
      if (toggleQueues.get(key) === settled) toggleQueues.delete(key);
    });
    return run;
  }

  async function getTabInfo(tabId) {
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      return { restricted: true, active: false, pdf: false, origin: null, url: '' };
    }
    const url = tab.url || tab.pendingUrl || '';
    let restricted = isRestricted(url);
    let pdf = false;
    const state = restricted ? null : await topFrameState(tabId);
    if (!restricted && !state && !url) {
      // The browser hides the address of pages we have no access to, so ask directly.
      const type = await api.scripting.executeScript({ target: { tabId }, func: () => document.contentType })
        .then(([result]) => (result ? result.result : null), () => undefined);
      restricted = type === undefined;
      pdf = type === 'application/pdf';
    }
    return {
      restricted,
      active: Boolean(state && state.active),
      pdf: !restricted && (pdf || Boolean(state && state.pdf) || isPdfUrl(url)),
      origin: settings.originOf(url),
      url,
      incognito: Boolean(tab.incognito),
    };
  }

  // The shortcut, the page menu and a popup-less icon click all ask for the page to be
  // readable. On a PDF, whose viewer no extension can change, that means the Reader.
  async function toggleFromBrowser(tab) {
    const result = await toggleTab(tab);
    if (result.reason === 'pdf' && tab.url) {
      await openReader(`?pdf=${encodeURIComponent(tab.url)}&tab=${tab.id}${privateFlag(tab)}`, tab);
    }
    return result;
  }

  async function onCommand(command, tab) {
    if (command !== 'toggle-page') return null;
    let target = tab;
    if (!target || !Number.isInteger(target.id)) {
      [target] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    }
    return toggleFromBrowser(target);
  }

  /* ── Icon click ────────────────────────────────────────────────────────── */

  function applyIconClick(current) {
    if (!api.action) return Promise.resolve();
    const popup = current.iconClick === 'toggle' ? '' : api.runtime.getManifest().action.default_popup;
    return api.action.setPopup({ popup }).catch(warn);
  }

  /* ── Auto-on registration ──────────────────────────────────────────────── */

  async function reconcileNow() {
    const current = await settings.load();
    // Settings sync between browsers, permissions do not: "everywhere" from another
    // computer only counts once this browser allows every site too. Until then the
    // sites allowed here one by one still turn on.
    const everywhere = current.autoAll && await hasHostPermission(ALL_SITES);
    const wanted = everywhere ? [ALL_SITES] : uniquePatterns(current.autoSites);
    const granted = await Promise.all(wanted.map(hasHostPermission));
    const matches = wanted.filter((pattern, i) => granted[i]);
    // Skipped sites only mean something while Skimbold is on everywhere; a site kept
    // on the skip list from then must not block "Always on" for it now.
    const excludeMatches = everywhere ? excludePatterns(current.excludedSites) : [];
    const [existing] = await api.scripting.getRegisteredContentScripts({ ids: [AUTO_ID] });

    if (matches.length === 0) {
      if (existing) await api.scripting.unregisterContentScripts({ ids: [AUTO_ID] });
      return { matches, excludeMatches };
    }
    const script = {
      id: AUTO_ID,
      js: AUTO_FILES,
      matches,
      excludeMatches,
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    };
    if (existing) await api.scripting.updateContentScripts([script]);
    else await api.scripting.registerContentScripts([script]);
    return { matches, excludeMatches };
  }

  const inReconcileOrder = serial();

  // Each run reads the latest settings, so the last queued run always leaves the right state.
  function reconcileAutoOn() {
    return inReconcileOrder(reconcileNow);
  }

  // A permission the user took back (for example from the browser's site-access menu)
  // takes its site out of the settings, so the switches show what will really happen.
  async function dropRevokedSites() {
    const current = await settings.load();
    const kept = await Promise.all(current.autoSites.map((origin) => hasHostPermission(settings.matchPatternOf(origin))));
    const autoSites = current.autoSites.filter((origin, i) => kept[i]);
    const autoAll = current.autoAll && await hasHostPermission(ALL_SITES);
    if (autoSites.length !== current.autoSites.length || autoAll !== current.autoAll) {
      await settings.save({ autoSites, autoAll });
    }
    return reconcileAutoOn();
  }

  /* ── Context menus ─────────────────────────────────────────────────────── */

  function createMenu(properties) {
    return new Promise((resolve) => {
      api.contextMenus.create(properties, () => {
        const error = api.runtime.lastError;
        if (error) warn(error);
        resolve(!error);
      });
    });
  }

  const inMenuOrder = serial();

  // Firefox forgets an event page's menus when the browser restarts, so this runs on
  // startup as well as on install. Removing first makes a second run harmless.
  function createMenus() {
    if (!api.contextMenus) return Promise.resolve([]);
    return inMenuOrder(async () => {
      await api.contextMenus.removeAll();
      const items = [
        {
          id: MENU_TOGGLE,
          title: 'Toggle Skimbold on this page',
          contexts: ['page'],
          documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
        },
        { id: MENU_SELECTION, title: 'Open selection in Skimbold Reader', contexts: ['selection'] },
        { id: MENU_READER, title: 'Open Skimbold Reader', contexts: ['action'] },
      ];
      const created = [];
      for (const item of items) {
        if (await createMenu(item)) created.push(item.id);
      }
      return created;
    });
  }

  function openReader(query, tab) {
    const properties = { url: api.runtime.getURL(READER_PAGE + query) };
    if (tab && Number.isInteger(tab.index) && tab.index >= 0) properties.index = tab.index + 1;
    return api.tabs.create(properties);
  }

  // The Reader is an extension page, which opens in a regular window even for a
  // private one; the flag tells it not to keep what came from there.
  function privateFlag(tab) {
    return tab && tab.incognito ? '&private=1' : '';
  }

  // The menu's own selectionText loses line breaks, so read the selection from the frame
  // when we can; paragraphs then survive into the Reader.
  async function selectedText(info, tab) {
    const fallback = typeof info.selectionText === 'string' ? info.selectionText : '';
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return fallback;
    try {
      const [result] = await api.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [Number.isInteger(info.frameId) ? info.frameId : 0] },
        func: () => String(globalThis.getSelection()),
      });
      const text = result && typeof result.result === 'string' ? result.result : '';
      return text.trim() ? text : fallback;
    } catch {
      return fallback;
    }
  }

  async function openSelectionInReader(info, tab) {
    const text = await selectedText(info, tab);
    const key = `selection-${crypto.randomUUID()}`;
    await api.storage.session.set({ [key]: text });
    return openReader(`?session=${encodeURIComponent(key)}${privateFlag(tab)}`, tab);
  }

  function onMenuClick(info, tab) {
    switch (info.menuItemId) {
      case MENU_TOGGLE: return toggleFromBrowser(tab);
      case MENU_SELECTION: return openSelectionInReader(info, tab);
      case MENU_READER: return openReader('', tab);
      default: return Promise.resolve(null);
    }
  }

  /* ── Shortcut ──────────────────────────────────────────────────────────── */

  // The browser leaves the shortcut empty when another extension already uses the key.
  async function flagShortcutConflict() {
    if (!api.commands) return;
    const commands = await api.commands.getAll();
    const command = commands.find((item) => item.name === 'toggle-page');
    if (command && !command.shortcut) await api.storage.local.set({ [SHORTCUT_FLAG]: true });
  }

  /* ── Messages ──────────────────────────────────────────────────────────── */

  function fromExtensionPage(sender) {
    return sender.id === api.runtime.id && typeof sender.url === 'string'
      && sender.url.startsWith(api.runtime.getURL(''));
  }

  function pageRequest(message) {
    switch (message.type) {
      case 'skb:toggleTab':
        return () => api.tabs.get(message.tabId).then(toggleTab, () => ({ ok: false, active: false, reason: 'no-tab' }));
      case 'skb:getTabInfo':
        return () => getTabInfo(message.tabId);
      case 'skb:reconcile':
        return () => reconcileAutoOn().then(() => ({ ok: true }));
      default:
        return null;
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !sender) return false;

    if (message.type === 'skb:state') {
      if (sender.id !== api.runtime.id || !sender.tab || sender.frameId !== 0) return false;
      setBadge(sender.tab.id, Boolean(message.active));
      sendResponse({ ok: true });
      return false;
    }

    // A frame loaded on a page that is on, or is leaving its page; this only ever
    // re-applies the page's own state.
    if (message.type === 'skb:frames') {
      if (sender.id !== api.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
      onFramesMessage(message, sender);
      return false;
    }

    const handler = fromExtensionPage(sender) ? pageRequest(message) : null;
    if (!handler) return false;
    handler().then(sendResponse, (error) => {
      warn(error);
      sendResponse({ ok: false, active: false, reason: 'error' });
    });
    return true;
  });

  /* ── Lifecycle and browser events ──────────────────────────────────────── */

  api.runtime.onInstalled.addListener((details) => {
    createMenus().catch(warn);
    reconcileAutoOn().catch(warn);
    if (details.reason === 'install') flagShortcutConflict().catch(warn);
  });

  api.runtime.onStartup.addListener(() => {
    createMenus().catch(warn);
    reconcileAutoOn().catch(warn);
  });

  if (api.action) {
    api.action.onClicked.addListener((tab) => {
      toggleFromBrowser(tab).catch(warn);
    });
  }

  if (api.commands && api.commands.onCommand) {
    api.commands.onCommand.addListener((command, tab) => {
      onCommand(command, tab).catch(warn);
    });
  }

  if (api.contextMenus && api.contextMenus.onClicked) {
    api.contextMenus.onClicked.addListener((info, tab) => {
      onMenuClick(info, tab).catch(warn);
    });
  }

  if (api.permissions && api.permissions.onAdded) {
    api.permissions.onAdded.addListener(() => {
      reconcileAutoOn().catch(warn);
    });
  }

  if (api.permissions && api.permissions.onRemoved) {
    api.permissions.onRemoved.addListener(() => {
      dropRevokedSites().catch(warn);
    });
  }

  api.tabs.onRemoved.addListener((tabId) => {
    const job = frameSyncs.get(tabId);
    if (job) clearTimeout(job.timer);
    frameSyncs.delete(tabId);
  });

  settings.onChange((current) => {
    applyIconClick(current);
    reconcileAutoOn().catch(warn);
  });

  // Global action state does not survive a browser restart, so set it whenever this wakes.
  setBadgeColors();
  settings.load().then(applyIconClick);

  Skimbold.background = { toggleTab, reconcileAutoOn, getTabInfo, onCommand, createMenus, onMenuClick, syncFrames };
})();
