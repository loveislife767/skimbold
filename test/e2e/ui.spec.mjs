// End-to-end tests for the popup, the options page and the background service worker
// (spec §7–§9).

import { readFileSync } from 'node:fs';
import {
  test, expect, openExtensionPage, swEval, tabIdFor, collectConsoleErrors,
} from './fixtures.mjs';

const readSettings = (serviceWorker) => swEval(serviceWorker, () => globalThis.Skimbold.settings.load());
const saveSettings = (serviceWorker, patch) => swEval(serviceWorker, (p) => globalThis.Skimbold.settings.save(p), patch);

function pageState(serviceWorker, tabId) {
  return swEval(serviceWorker, async (id) => {
    const api = globalThis.browser ?? globalThis.chrome;
    try {
      return await api.tabs.sendMessage(id, { type: 'skb:getState' }, { frameId: 0 });
    } catch {
      return null;
    }
  }, tabId);
}

function badgeText(serviceWorker, tabId) {
  return swEval(serviceWorker, (id) => (globalThis.browser ?? globalThis.chrome).action.getBadgeText({ tabId: id }), tabId);
}

function registeredAutoScripts(serviceWorker) {
  return swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).scripting.getRegisteredContentScripts({ ids: ['skb-auto'] }));
}

async function openPopup(context, extensionId, tabId) {
  const popup = await openExtensionPage(context, extensionId, `popup/popup.html?tab=${tabId}`);
  // The site row leaves its pending state once the tab's details have arrived.
  await expect(popup.locator('#site-row')).toHaveAttribute('data-pending', 'false');
  return popup;
}

async function fixtureTab(page, serviceWorker, url = '/basic.html') {
  await page.goto(url);
  return tabIdFor(serviceWorker, page);
}

test.describe('popup', () => {
  test('shows the current site and a ready toggle', async ({ page, context, serviceWorker, extensionId, server }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    const errors = collectConsoleErrors(popup);
    const host = new URL(server.url).host;

    await expect(popup.locator('#toggle')).toBeEnabled();
    await expect(popup.locator('#toggle')).toHaveText('Turn on for this page');
    await expect(popup.locator('#site-text')).toHaveText(`Always on for ${host}`);
    await expect(popup.locator('#site')).not.toBeChecked();
    await expect(popup.locator('#notice')).toBeHidden();
    await expect(popup.locator('#open-pdf')).toBeHidden();
    // The real shortcut, read from commands.getAll(), one chip per key.
    await expect(popup.locator('#shortcut .skb-kbd')).toHaveText(['Alt', 'R']);
    // Default settings: Auto, strength 3, fade off, weight 700.
    await expect(popup.locator('#letters-auto')).toBeChecked();
    await expect(popup.locator('#strength')).toHaveValue('3');
    await expect(popup.locator('#fade-value')).toHaveText('Off');
    await expect(popup.locator('#weight-700')).toBeChecked();
    await expect(popup.locator('#preview-text b').first()).toBeVisible();
    await expect(popup.locator('.foot').getByRole('link', { name: 'GitHub' }))
      .toHaveAttribute('href', 'https://github.com/loveislife767/skimbold');
    expect(errors).toEqual([]);
  });

  test('every control writes the settings', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);

    await popup.click('label[for="letters-2"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).mode).toBe('fixed');
    expect((await readSettings(serviceWorker)).letters).toBe(2);
    // Strength only applies to Auto, so it is hidden in fixed mode.
    await expect(popup.locator('#strength-field')).toBeHidden();

    await popup.click('label[for="letters-auto"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).mode).toBe('auto');
    await expect(popup.locator('#strength-field')).toBeVisible();

    await popup.focus('#strength');
    await popup.keyboard.press('ArrowRight');
    await expect(popup.locator('#strength-value')).toHaveText('4');
    await expect.poll(async () => (await readSettings(serviceWorker)).strength).toBe(4);

    await popup.focus('#fade');
    await popup.keyboard.press('ArrowRight');
    await popup.keyboard.press('ArrowRight');
    await expect(popup.locator('#fade-value')).toHaveText('10%');
    await expect.poll(async () => (await readSettings(serviceWorker)).fade).toBe(10);

    await popup.click('label[for="weight-800"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).weight).toBe(800);

    // The range's filled track follows its value (Chromium draws it from --skb-fill).
    expect(await popup.locator('#fade').evaluate((el) => el.style.getPropertyValue('--skb-fill'))).toBe(`${(10 / 60) * 100}%`);
  });

  test('the preview follows the settings, including changes made elsewhere', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    const boldParts = () => popup.locator('#preview-text b').allTextContents();
    const text = () => popup.locator('#preview-text').textContent();
    const original = await text();

    await popup.click('label[for="letters-1"]');
    await expect.poll(async () => (await boldParts()).every((part) => part.length === 1)).toBe(true);
    expect(await text()).toBe(original);

    await popup.click('label[for="letters-3"]');
    // 'Bold' has 4 letters, so 3 of them are bold; 'a' is a single letter.
    await expect.poll(async () => (await boldParts())[0]).toBe('Bol');

    await popup.click('label[for="weight-900"]');
    await expect.poll(() => popup.locator('#preview-text b').first().evaluate((el) => getComputedStyle(el).fontWeight)).toBe('900');

    // A change saved by another page (here the service worker) shows up live.
    await saveSettings(serviceWorker, { mode: 'auto', strength: 5, fade: 30 });
    await expect(popup.locator('#letters-auto')).toBeChecked();
    await expect(popup.locator('#strength-value')).toHaveText('5');
    await expect(popup.locator('#fade-value')).toHaveText('30%');
    expect(await popup.locator('#preview').evaluate((el) => el.style.getPropertyValue('--preview-fade'))).toBe('30%');
    expect(await text()).toBe(original);
  });

  test('the toggle turns the page on and off and badges the tab', async ({ page, context, serviceWorker, extensionId }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);

    await popup.click('#toggle');
    await expect(popup.locator('#toggle')).toHaveText('On — turn off');
    await expect(popup.locator('#toggle')).toHaveAttribute('data-active', 'true');
    await expect(popup.locator('#announce')).toHaveText('Skimbold is on for this page.');
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(true);
    await expect(page.locator('skb-b').first()).toBeAttached();
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('ON');

    await popup.click('#toggle');
    await expect(popup.locator('#toggle')).toHaveText('Turn on for this page');
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(false);
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('');
    expect(errors).toEqual([]);
  });

  test('a restricted page gets a disabled toggle and an explanation', async ({ page, context, serviceWorker, extensionId }) => {
    // Any open page gives the browser a window for the new tab.
    await page.goto('/basic.html');
    const tabId = await swEval(serviceWorker, async () => {
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.create({ url: 'chrome://version', active: false });
      return tab.id;
    });
    const popup = await openPopup(context, extensionId, tabId);

    await expect(popup.locator('#toggle')).toBeDisabled();
    await expect(popup.locator('#notice')).toHaveText(/Browsers don’t let extensions change this page/);
    await expect(popup.locator('#site-row')).toBeHidden();
    // Settings still work on a restricted page; they apply everywhere else.
    await expect(popup.locator('#letters-auto')).toBeEnabled();
  });

  test('a PDF tab offers to open the PDF in the Reader', async ({ page, context, serviceWorker, extensionId, server }) => {
    const tabId = await fixtureTab(page, serviceWorker, '/files/paper.pdf');
    const popup = await openPopup(context, extensionId, tabId);

    await expect(popup.locator('#open-pdf')).toBeVisible();
    await expect(popup.locator('#open-pdf')).toHaveText('Open this PDF in Reader');
    const opened = context.waitForEvent('page');
    await popup.click('#open-pdf');
    const reader = await opened;
    await reader.waitForURL(/reader\/reader\.html/);
    const url = new URL(reader.url());
    expect(url.searchParams.get('pdf')).toBe(`${server.url}/files/paper.pdf`);
    expect(url.searchParams.get('tab')).toBe(String(tabId));
  });

  test('"Always on" asks for the site, saves it and turns the page on', async ({ page, context, serviceWorker, extensionId, server }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);

    // A real click: permissions.request needs a user gesture (granted without a prompt here).
    await popup.click('#site');
    await expect(popup.locator('#site')).toBeChecked();
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([server.url]);

    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(true);
    await expect(popup.locator('#toggle')).toHaveText('On — turn off');
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker))[0]?.matches).toEqual(['http://127.0.0.1/*']);

    await popup.click('#site');
    await expect(popup.locator('#site')).not.toBeChecked();
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([]);
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker)).length).toBe(0);
  });

  test('"Always on" stays on while the browser asks, and backs out if refused', async ({ page, context, serviceWorker, extensionId, server }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await context.newPage();
    // The test copy holds every host already, so the prompt and its answer are simulated.
    await popup.addInitScript(() => {
      let answer;
      globalThis.skbTestAnswer = (granted) => answer(granted);
      chrome.permissions.contains = async () => false;
      chrome.permissions.request = () => new Promise((resolve) => { answer = resolve; });
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tab=${tabId}`);
    await expect(popup.locator('#site-row')).toHaveAttribute('data-pending', 'false');

    await popup.click('#site');
    // Saved before the answer, and shown as on while the prompt is open.
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([server.url]);
    await expect(popup.locator('#site')).toBeChecked();

    await popup.evaluate(() => globalThis.skbTestAnswer(false));
    await expect(popup.locator('#site')).not.toBeChecked();
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([]);
    await expect(popup.locator('#toggle')).toHaveText('Turn on for this page');
  });

  test('with "Always on everywhere", the switch skips the site instead', async ({ page, context, serviceWorker, extensionId, server }) => {
    await saveSettings(serviceWorker, { autoAll: true });
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await openPopup(context, extensionId, tabId);
    const host = new URL(server.url).host;

    await expect(popup.locator('#site-text')).toHaveText(`Skip ${host}`);
    await popup.click('#site');
    await expect.poll(async () => (await readSettings(serviceWorker)).excludedSites).toEqual([server.url]);
    // Only this port of the host is skipped; other ports of 127.0.0.1 stay on.
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker))[0]?.excludeMatches).toEqual([`${server.url}/*`]);
    await popup.click('#site');
    await expect.poll(async () => (await readSettings(serviceWorker)).excludedSites).toEqual([]);
  });

  test('with "Always on everywhere" synced but not allowed in this browser, the switch asks for the site', async ({ page, context, serviceWorker, extensionId, server }) => {
    await saveSettings(serviceWorker, { autoAll: true });
    const tabId = await fixtureTab(page, serviceWorker);
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      const granted = new Set();
      chrome.permissions.contains = async ({ origins }) => origins.every((origin) => granted.has(origin));
      chrome.permissions.request = async ({ origins }) => {
        for (const origin of origins) granted.add(origin);
        return true;
      };
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tab=${tabId}`);
    await expect(popup.locator('#site-row')).toHaveAttribute('data-pending', 'false');
    await expect(popup.locator('#site-text')).toHaveText(`Always on for ${new URL(server.url).host}`);
    await popup.click('#site');
    await expect(popup.locator('#site')).toBeChecked();
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([server.url]);
  });

  test('offers "Set a shortcut" when the browser left the shortcut empty', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    // The install-time flag the background stores when Alt+R was already taken.
    await swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).storage.local.set({ shortcutConflict: true }));
    const popup = await context.newPage();
    // Chromium has no API to clear a shortcut, so the popup is shown an empty one.
    await popup.addInitScript(() => {
      chrome.commands.getAll = async () => [{ name: 'toggle-page', description: '', shortcut: '' }];
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tab=${tabId}`);

    await expect(popup.locator('#shortcut')).toContainText('Alt+R is already in use.');
    const opened = context.waitForEvent('page');
    await popup.click('#set-shortcut');
    const shortcuts = await opened;
    await expect.poll(() => shortcuts.url()).toBe('chrome://extensions/shortcuts');
  });

  test('clears the shortcut flag once a shortcut is set', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    await swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).storage.local.set({ shortcutConflict: true }));
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('#shortcut .skb-kbd')).toHaveText(['Alt', 'R']);
    await expect.poll(() => swEval(serviceWorker, async () => (await (globalThis.browser ?? globalThis.chrome).storage.local.get('shortcutConflict')).shortcutConflict))
      .toBeUndefined();
  });

  test('fits the toolbar panel without scrolling, in light and dark', async ({ page, context, serviceWorker, extensionId }, testInfo) => {
    const tabId = await fixtureTab(page, serviceWorker);
    for (const colorScheme of ['light', 'dark']) {
      const popup = await context.newPage();
      await popup.emulateMedia({ colorScheme });
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tab=${tabId}`);
      await expect(popup.locator('#site-row')).toHaveAttribute('data-pending', 'false');
      const size = await popup.evaluate(() => {
        const box = document.body.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.ceil(box.height), scrollWidth: document.body.scrollWidth };
      });
      // Browsers cap extension popups at 800 × 600.
      expect(size.width).toBe(340);
      expect(size.scrollWidth).toBeLessThanOrEqual(340);
      expect(size.height).toBeLessThanOrEqual(600);
      await popup.setViewportSize({ width: 340, height: size.height });
      await testInfo.attach(`popup-${colorScheme}.png`, { body: await popup.screenshot(), contentType: 'image/png' });
      await popup.close();
    }
  });
});

test.describe('options page', () => {
  test('renders the current settings and saves each change', async ({ context, serviceWorker, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    const errors = collectConsoleErrors(options);

    await expect(options.locator('#version')).toHaveText(/^version \d+\.\d+\.\d+$/);
    await expect(options.locator('#letters-auto')).toBeChecked();
    await expect(options.locator('#skip-0')).toBeChecked();
    await expect(options.locator('#nth-1')).toBeChecked();
    await expect(options.locator('#icon-click')).toHaveValue('popup');
    await expect(options.locator('#shortcut-keys .skb-kbd')).toHaveText(['Alt', 'R']);

    await options.click('label[for="skip-2"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).skipShort).toBe(2);
    await options.click('label[for="nth-3"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).everyNth).toBe(3);
    await options.click('label[for="letters-1"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).letters).toBe(1);
    await options.click('label[for="weight-600"]');
    await expect.poll(async () => (await readSettings(serviceWorker)).weight).toBe(600);
    await options.focus('#fade');
    await options.keyboard.press('End');
    await expect.poll(async () => (await readSettings(serviceWorker)).fade).toBe(60);
    await expect(options.locator('#fade-value')).toHaveText('60%');

    // everyNth 3 with skipShort 2 leaves most words plain in the preview.
    const boldCount = await options.locator('#preview-text b').count();
    expect(boldCount).toBeGreaterThan(0);
    expect(boldCount).toBeLessThan(12);
    expect(errors).toEqual([]);
  });

  test('"Clicking the toolbar icon" switches the popup off and back on', async ({ context, serviceWorker, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    const popupUrl = () => swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).action.getPopup({}));

    await options.selectOption('#icon-click', 'toggle');
    await expect.poll(async () => (await readSettings(serviceWorker)).iconClick).toBe('toggle');
    await expect.poll(popupUrl).toBe('');

    await options.selectOption('#icon-click', 'popup');
    await expect.poll(popupUrl).toBe(`chrome-extension://${extensionId}/popup/popup.html`);
  });

  test('removes sites from both lists', async ({ context, serviceWorker, extensionId }) => {
    await saveSettings(serviceWorker, {
      autoSites: ['https://en.wikipedia.org', 'http://localhost:8080'],
      excludedSites: ['https://mail.example.com'],
    });
    const options = await openExtensionPage(context, extensionId, 'options/options.html');

    await expect(options.locator('#auto-sites .sites__host')).toHaveText(['en.wikipedia.org', 'http://localhost:8080']);
    await expect(options.locator('#excluded-sites .sites__host')).toHaveText(['mail.example.com']);
    await expect(options.locator('#auto-sites-empty')).toBeHidden();

    await options.getByRole('button', { name: 'Remove en.wikipedia.org' }).click();
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual(['http://localhost:8080']);
    await expect(options.locator('#auto-sites .sites__host')).toHaveText(['http://localhost:8080']);
    // Focus stays in the list, on the next remove button.
    await expect(options.getByRole('button', { name: 'Remove http://localhost:8080' })).toBeFocused();

    await options.keyboard.press('Enter');
    await expect.poll(async () => (await readSettings(serviceWorker)).autoSites).toEqual([]);
    await expect(options.locator('#auto-sites-empty')).toBeVisible();
    await expect(options.locator('#auto-sites-title')).toBeFocused();

    await options.getByRole('button', { name: 'Remove mail.example.com' }).click();
    await expect.poll(async () => (await readSettings(serviceWorker)).excludedSites).toEqual([]);
    await expect(options.locator('#excluded-sites-empty')).toBeVisible();
  });

  test('"Always on everywhere" asks for every site and registers auto-on', async ({ context, serviceWorker, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    await options.click('#auto-all');
    await expect.poll(async () => (await readSettings(serviceWorker)).autoAll).toBe(true);
    await expect(options.locator('#auto-all')).toBeChecked();
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker))[0]?.matches).toEqual(['*://*/*']);

    await options.click('#auto-all');
    await expect.poll(async () => (await readSettings(serviceWorker)).autoAll).toBe(false);
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker)).length).toBe(0);
  });

  test('settings synced from another browser show what this browser allows, and can be allowed here', async ({ context, serviceWorker, extensionId }) => {
    await saveSettings(serviceWorker, { autoAll: true, autoSites: ['https://en.wikipedia.org', 'https://example.org'] });
    const options = await context.newPage();
    const errors = collectConsoleErrors(options);
    // This browser has allowed example.org only; the other grants happened on another computer.
    await options.addInitScript(() => {
      const granted = new Set(['https://example.org/*']);
      chrome.permissions.contains = async ({ origins }) => origins.every((origin) => granted.has(origin));
      chrome.permissions.request = async ({ origins }) => {
        for (const origin of origins) granted.add(origin);
        return true;
      };
    });
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect(options.locator('#auto-all')).not.toBeChecked();
    await expect(options.locator('#auto-all-hint')).toContainText('this browser hasn’t allowed Skimbold on every site');
    await expect(options.locator('#auto-sites .sites__status:visible')).toHaveCount(1);
    await expect(options.getByRole('button', { name: 'Allow en.wikipedia.org' })).toBeVisible();
    await expect(options.getByRole('button', { name: 'Allow example.org' })).toHaveCount(0);

    await options.getByRole('button', { name: 'Allow en.wikipedia.org' }).click();
    await expect(options.locator('#auto-sites .sites__status:visible')).toHaveCount(0);
    // Switching everywhere on asks this browser for every site; the setting itself was already on.
    await options.click('#auto-all');
    await expect(options.locator('#auto-all')).toBeChecked();
    await expect(options.locator('#auto-all-hint')).not.toContainText('hasn’t allowed');
    expect((await readSettings(serviceWorker)).autoAll).toBe(true);
    expect(errors).toEqual([]);
  });

  test('reset asks first, then restores every default', async ({ context, serviceWorker, extensionId }) => {
    await saveSettings(serviceWorker, {
      mode: 'fixed', letters: 3, weight: 900, fade: 40, skipShort: 1, everyNth: 2, iconClick: 'toggle',
      autoSites: ['https://en.wikipedia.org'], excludedSites: ['https://mail.example.com'],
      reader: { theme: 'sepia', fontSize: 24 },
    });
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    await expect(options.locator('#letters-3')).toBeChecked();

    await options.click('#reset');
    await expect(options.locator('#reset-confirm')).toBeVisible();
    await expect(options.locator('#reset-no')).toBeFocused();
    await options.click('#reset-no');
    await expect(options.locator('#reset-confirm')).toBeHidden();
    expect((await readSettings(serviceWorker)).weight).toBe(900);

    await options.click('#reset');
    await options.click('#reset-yes');
    await expect(options.locator('#reset-status')).toHaveText('Settings are back to their defaults.');
    const defaults = await swEval(serviceWorker, () => globalThis.Skimbold.settings.DEFAULTS);
    await expect.poll(() => readSettings(serviceWorker)).toEqual(defaults);
    await expect(options.locator('#letters-auto')).toBeChecked();
    await expect(options.locator('#auto-sites-empty')).toBeVisible();
    await expect(options.locator('#reset')).toBeFocused();
  });

  test('has no horizontal scroll on a narrow window, in light and dark', async ({ context, extensionId }, testInfo) => {
    for (const colorScheme of ['light', 'dark']) {
      const options = await context.newPage();
      await options.emulateMedia({ colorScheme });
      await options.setViewportSize({ width: 375, height: 800 });
      await options.goto(`chrome-extension://${extensionId}/options/options.html`);
      await expect(options.locator('#shortcut-keys .skb-kbd').first()).toBeVisible();
      expect(await options.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      await testInfo.attach(`options-${colorScheme}.png`, { body: await options.screenshot({ fullPage: true }), contentType: 'image/png' });
      await options.close();
    }
  });
});

test.describe('background', () => {
  test('sets the badge colours', async ({ serviceWorker }) => {
    const colors = await swEval(serviceWorker, async () => {
      const { action } = globalThis.browser ?? globalThis.chrome;
      return { background: await action.getBadgeBackgroundColor({}), text: await action.getBadgeTextColor({}) };
    });
    expect(colors).toEqual({ background: [31, 94, 70, 255], text: [255, 255, 255, 255] });
  });

  test('refuses restricted pages without touching them', async ({ serviceWorker }) => {
    const results = await swEval(serviceWorker, async () => {
      const { toggleTab } = globalThis.Skimbold.background;
      const urls = [
        'chrome://settings/', 'edge://extensions/', 'brave://rewards/', 'about:blank', 'view-source:https://example.com/',
        'chrome-extension://abc/page.html', 'moz-extension://abc/page.html', 'devtools://devtools/bundled/inspector.html',
        'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x',
        'https://microsoftedge.microsoft.com/addons/detail/x', 'https://addons.mozilla.org/en-US/firefox/',
      ];
      return Promise.all(urls.map((url) => toggleTab({ id: 1, url })));
    });
    for (const result of results) expect(result).toEqual({ ok: false, active: false, reason: 'restricted' });
  });

  test('reports a page it cannot reach as blocked', async ({ serviceWorker }) => {
    const result = await swEval(serviceWorker, () => globalThis.Skimbold.background.toggleTab({ id: 2147483000, url: 'https://example.com/' }));
    expect(result).toEqual({ ok: false, active: false, reason: 'blocked' });
  });

  test('describes a tab for the popup', async ({ page, serviceWorker, server }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const info = await swEval(serviceWorker, (id) => globalThis.Skimbold.background.getTabInfo(id), tabId);
    expect(info).toEqual({ restricted: false, active: false, pdf: false, origin: server.url, url: `${server.url}/basic.html`, incognito: false });
  });

  test('the toggle-page command toggles the active tab', async ({ page, serviceWorker }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    await page.bringToFront();

    const on = await swEval(serviceWorker, () => globalThis.Skimbold.background.onCommand('toggle-page'));
    expect(on).toEqual({ ok: true, active: true });
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(true);
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('ON');

    const off = await swEval(serviceWorker, () => globalThis.Skimbold.background.onCommand('toggle-page'));
    expect(off).toEqual({ ok: true, active: false });
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('');
  });

  test('two quick toggles leave the page off again', async ({ page, serviceWorker }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const results = await swEval(serviceWorker, async (id) => {
      const { toggleTab } = globalThis.Skimbold.background;
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
      return Promise.all([toggleTab(tab), toggleTab(tab)]);
    }, tabId);
    expect(results.map((result) => result.active)).toEqual([true, false]);
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(false);
  });

  test('creates its three context menu items', async ({ serviceWorker }) => {
    // contextMenus has no getter; createMenus() reports the items the browser accepted.
    const created = await swEval(serviceWorker, () => globalThis.Skimbold.background.createMenus());
    expect(created).toEqual(['skb-toggle-page', 'skb-read-selection', 'skb-open-reader']);
    // Running it again (install and startup both do) must not trip over duplicate ids.
    expect(await swEval(serviceWorker, () => globalThis.Skimbold.background.createMenus())).toEqual(created);
  });

  test('the selection menu hands the selected text to the Reader', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('main'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    const selected = await page.evaluate(() => String(getSelection()));
    // The Reader deletes the handed-over text once it has read it, so record the write.
    await swEval(serviceWorker, () => {
      globalThis.skbTestSessionWrites = {};
      (globalThis.browser ?? globalThis.chrome).storage.onChanged.addListener((changes, area) => {
        if (area !== 'session') return;
        for (const [key, change] of Object.entries(changes)) {
          if ('newValue' in change) globalThis.skbTestSessionWrites[key] = change.newValue;
        }
      });
    });

    const opened = context.waitForEvent('page');
    await swEval(serviceWorker, async (id) => {
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
      await globalThis.Skimbold.background.onMenuClick({ menuItemId: 'skb-read-selection', selectionText: 'flattened', frameId: 0 }, tab);
    }, tabId);
    const reader = await opened;
    await reader.waitForURL(/reader\/reader\.html\?session=/);
    const key = new URL(reader.url()).searchParams.get('session');
    expect(reader.url().startsWith(`chrome-extension://${extensionId}/reader/reader.html?session=`)).toBe(true);
    const written = await swEval(serviceWorker, (k) => globalThis.skbTestSessionWrites[k], key);
    // Read from the page itself, so the paragraph breaks survive.
    expect(written).toBe(selected);
    expect(written).toContain('\n');
  });

  test('the action menu opens the Reader', async ({ page, context, serviceWorker, extensionId }) => {
    await page.goto('/basic.html');
    const opened = context.waitForEvent('page');
    await swEval(serviceWorker, () => globalThis.Skimbold.background.onMenuClick({ menuItemId: 'skb-open-reader' }));
    const reader = await opened;
    await reader.waitForURL(`chrome-extension://${extensionId}/reader/reader.html`);
  });

  test('answers page requests only from its own pages', async ({ page, context, serviceWorker, extensionId }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    const answer = await options.evaluate((id) => chrome.runtime.sendMessage({ type: 'skb:getTabInfo', tabId: id }), tabId);
    expect(answer.restricted).toBe(false);
    // Nobody answering shows up as undefined or as a rejection, depending on the browser.
    const unknown = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'skb:nope' }).then((r) => r ?? 'no answer', () => 'no answer'));
    expect(unknown).toBe('no answer');

    // The same request from a content script (a web page's world) gets no answer.
    const fromContent = await swEval(serviceWorker, async (id) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const [result] = await api.scripting.executeScript({
        target: { tabId: id },
        func: (target) => chrome.runtime.sendMessage({ type: 'skb:toggleTab', tabId: target }).then((r) => r ?? 'no answer', () => 'no answer'),
        args: [id],
      });
      return result.result;
    }, tabId);
    expect(fromContent).toBe('no answer');
    expect(await pageState(serviceWorker, tabId)).toBeNull();
  });

  test('registers auto-on for granted sites and follows the settings', async ({ page, context, serviceWorker, extensionId, server }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    await saveSettings(serviceWorker, { autoSites: [server.url], excludedSites: ['https://mail.example.com'] });
    expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'skb:reconcile' }))).toEqual({ ok: true });

    // The skip list only applies while Skimbold is on everywhere, so it excludes nothing here.
    await expect.poll(() => registeredAutoScripts(serviceWorker)).toEqual([expect.objectContaining({
      id: 'skb-auto',
      js: ['shared/settings.js', 'shared/core.js', 'content/engine.js', 'content/auto.js'],
      matches: ['http://127.0.0.1/*'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    })]);
    // Chromium leaves out an empty excludeMatches.
    expect((await registeredAutoScripts(serviceWorker))[0].excludeMatches ?? []).toEqual([]);
    // It is the only script registered, and it runs in the isolated world, not the page's.
    expect(await swEval(serviceWorker, async () => (await (globalThis.browser ?? globalThis.chrome).scripting.getRegisteredContentScripts())
      .map((script) => [script.id, script.world ?? 'ISOLATED']))).toEqual([['skb-auto', 'ISOLATED']]);

    // A page opened now turns on by itself.
    const tabId = await fixtureTab(page, serviceWorker);
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('ON');

    await saveSettings(serviceWorker, { autoSites: [] });
    await expect.poll(async () => (await registeredAutoScripts(serviceWorker)).length).toBe(0);

    // Everywhere with a skip list: a site with a port skips that port only.
    await saveSettings(serviceWorker, { autoAll: true, excludedSites: ['https://mail.example.com', 'http://127.0.0.1:1'] });
    await expect.poll(async () => [...((await registeredAutoScripts(serviceWorker))[0]?.excludeMatches ?? [])].sort())
      .toEqual(['http://127.0.0.1:1/*', 'https://mail.example.com/*']);
  });

  test('"everywhere" synced from another browser still turns on the sites allowed here', async ({ serviceWorker, server }) => {
    const registered = await swEval(serviceWorker, async (origin) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const contains = Object.getOwnPropertyDescriptor(api.permissions, 'contains');
      // This browser allows this one site, not every site.
      Object.defineProperty(api.permissions, 'contains', {
        configurable: true, writable: true, value: async ({ origins }) => origins.every((o) => o === 'http://127.0.0.1/*'),
      });
      try {
        await globalThis.Skimbold.settings.save({ autoAll: true, autoSites: [origin], excludedSites: ['https://mail.example.com'] });
        return await globalThis.Skimbold.background.reconcileAutoOn();
      } finally {
        Object.defineProperty(api.permissions, 'contains', contains);
      }
    }, server.url);
    expect(registered).toEqual({ matches: ['http://127.0.0.1/*'], excludeMatches: [] });
  });

  test('a site skipped once still turns on by itself when it is set to always on', async ({ page, serviceWorker, server }) => {
    // Skipped while everywhere was on; then everywhere was turned off and the site set to always on.
    await saveSettings(serviceWorker, { autoAll: false, autoSites: [server.url], excludedSites: [server.url] });
    await swEval(serviceWorker, () => globalThis.Skimbold.background.reconcileAutoOn());
    expect((await registeredAutoScripts(serviceWorker))[0].excludeMatches ?? []).toEqual([]);
    const tabId = await fixtureTab(page, serviceWorker);
    await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active, { timeout: 10_000 }).toBe(true);
  });

  test('turns a page on at once while a frame is still loading or waits below the fold, and the frames follow', async ({ page, serviceWorker }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/engine/frame-child.html?held', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/engine/frames-slow.html', { waitUntil: 'domcontentloaded' });
    const tabId = await tabIdFor(serviceWorker, page);
    const toggle = () => swEval(serviceWorker, async (id) => {
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
      const started = Date.now();
      const late = new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 5000); });
      return { outcome: await Promise.race([globalThis.Skimbold.background.toggleTab(tab), late]), ms: Date.now() - started };
    }, tabId);
    const frameBold = (which) => async () => {
      const frame = page.frames().find((item) => item.url().endsWith(which));
      return frame ? frame.evaluate(() => document.querySelectorAll('skb-b').length).catch(() => -1) : -1;
    };

    const on = await toggle();
    expect(on.outcome).toEqual({ ok: true, active: true });
    expect(on.ms).toBeLessThan(2000);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('#top-text skb-b').length), { timeout: 10_000 }).toBeGreaterThan(3);

    // Frames that arrive later are brought in line with the page.
    release();
    await page.locator('#lazy').scrollIntoViewIfNeeded();
    await expect.poll(frameBold('?held'), { timeout: 10_000 }).toBeGreaterThan(3);
    await expect.poll(frameBold('?lazy'), { timeout: 10_000 }).toBeGreaterThan(3);

    const off = await toggle();
    expect(off.outcome).toEqual({ ok: true, active: false });
    await expect.poll(frameBold('?held')).toBe(0);
    await expect.poll(frameBold('?lazy')).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll('skb-w').length)).toBe(0);
  });

  test('a frame that keeps reloading gets the engine each time, without the other frames being looked into again', async ({ page, serviceWorker }) => {
    await page.goto('/engine/frames-reload.html');
    const tabId = await tabIdFor(serviceWorker, page);
    const slotBold = async () => {
      const frame = page.frames().find((item) => item.url().includes('slot'));
      return frame ? frame.evaluate(() => document.querySelectorAll('skb-b').length).catch(() => -1) : -1;
    };
    // Counts the background's injections: into every frame at once, or into frames it names.
    await swEval(serviceWorker, () => {
      const { scripting } = globalThis.browser ?? globalThis.chrome;
      globalThis.skbInjections = { all: 0, named: 0 };
      globalThis.skbExecuteScript = Object.getOwnPropertyDescriptor(scripting, 'executeScript');
      const original = scripting.executeScript.bind(scripting);
      Object.defineProperty(scripting, 'executeScript', {
        configurable: true, writable: true,
        value: (options) => {
          globalThis.skbInjections[options.target.allFrames ? 'all' : 'named']++;
          return original(options);
        },
      });
    });
    try {
      const toggle = () => swEval(serviceWorker, async (id) => globalThis.Skimbold.background.toggleTab(await (globalThis.browser ?? globalThis.chrome).tabs.get(id)), tabId);
      expect(await toggle()).toEqual({ ok: true, active: true });
      await expect.poll(slotBold, { timeout: 10_000 }).toBeGreaterThan(3);
      await page.waitForTimeout(500);
      await swEval(serviceWorker, () => { globalThis.skbInjections = { all: 0, named: 0 }; });

      await page.evaluate(() => window.slotFixture.start(300));
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.slotFixture.stop());
      // The page the slot loaded last is bolded, like the frames that never reloaded.
      await expect.poll(slotBold, { timeout: 10_000 }).toBeGreaterThan(3);
      const injections = await swEval(serviceWorker, () => globalThis.skbInjections);
      expect(injections.all).toBe(0);
      // The slot is synced at most once every 2 s, however often it reloads (10 times here).
      expect(injections.named).toBeGreaterThan(0);
      expect(injections.named).toBeLessThanOrEqual(4);
      for (const frame of page.frames().filter((item) => /\?\d$/.test(item.url()))) {
        expect(await frame.evaluate(() => document.querySelectorAll('skb-b').length)).toBeGreaterThan(3);
      }
      expect(await toggle()).toEqual({ ok: true, active: false });
    } finally {
      await swEval(serviceWorker, () => {
        Object.defineProperty((globalThis.browser ?? globalThis.chrome).scripting, 'executeScript', globalThis.skbExecuteScript);
      });
    }
  });

  test('the page itself answers the toggle, even when a frame in it (an editor in design mode) stays off', async ({ page, serviceWorker }) => {
    await page.goto('/engine/frame-editor-parent.html');
    await page.frameLocator('#editor').locator('p').waitFor();
    const tabId = await tabIdFor(serviceWorker, page);
    const toggle = () => swEval(serviceWorker, async (id) => {
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
      return globalThis.Skimbold.background.toggleTab(tab);
    }, tabId);
    for (const active of [true, false, true, false]) {
      expect(await toggle()).toEqual({ ok: true, active });
      await expect.poll(async () => (await pageState(serviceWorker, tabId))?.active).toBe(active);
    }
  });

  test('a page that refuses the engine is a PDF only when its address says so, on Firefox too', async ({ page, serviceWorker }) => {
    // Firefox refuses scripts in its PDF viewer, but also on other pages, so a refusal alone
    // says nothing about the page being a PDF.
    const outcome = (tabId, firefox) => swEval(serviceWorker, async ({ id, asFirefox }) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const executeScript = Object.getOwnPropertyDescriptor(api.scripting, 'executeScript');
      Object.defineProperty(api.scripting, 'executeScript', {
        configurable: true, writable: true, value: () => Promise.reject(new Error('Missing host permission for the tab')),
      });
      if (asFirefox) api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
      try {
        const tab = await api.tabs.get(id);
        const { background } = globalThis.Skimbold;
        return { pdf: (await background.getTabInfo(id)).pdf, toggle: await background.toggleTab(tab) };
      } finally {
        delete api.runtime.getBrowserInfo;
        Object.defineProperty(api.scripting, 'executeScript', executeScript);
      }
    }, { id: tabId, asFirefox: firefox });
    for (const [urlPath, pdf] of [['/files/2409.01234', false], ['/files/paper.pdf', true]]) {
      const tabId = await fixtureTab(page, serviceWorker, urlPath);
      for (const firefox of [true, false]) {
        expect(await outcome(tabId, firefox), `${urlPath}, firefox: ${firefox}`)
          .toEqual({ pdf, toggle: { ok: false, active: false, reason: pdf ? 'pdf' : 'blocked' } });
      }
    }
  });

  test('a PDF whose address has no .pdf is recognised by the engine in its tab', async ({ page, context, serviceWorker, server }) => {
    const pdf = readFileSync(new URL('../fixtures/reader/article.pdf', import.meta.url));
    await page.route('**/files/2409.01234', (route) => route.fulfill({ contentType: 'application/pdf', body: pdf }));
    const tabId = await fixtureTab(page, serviceWorker, '/files/2409.01234');
    await page.bringToFront();
    const opened = context.waitForEvent('page');
    expect(await swEval(serviceWorker, () => globalThis.Skimbold.background.onCommand('toggle-page'))).toEqual({ ok: false, active: false, reason: 'pdf' });
    const reader = await opened;
    await reader.waitForURL(/reader\/reader\.html\?pdf=/);
    expect(new URL(reader.url()).searchParams.get('pdf')).toBe(`${server.url}/files/2409.01234`);
    expect(await swEval(serviceWorker, (id) => globalThis.Skimbold.background.getTabInfo(id), tabId)).toMatchObject({ restricted: false, active: false, pdf: true });
  });

  test('the domains Firefox keeps extensions off are refused there, and only there', async ({ serviceWorker }) => {
    const results = await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      const { toggleTab } = globalThis.Skimbold.background;
      const urls = ['https://support.mozilla.org/en-US/', 'https://accounts.firefox.com/', 'https://addons.mozilla.org/en-US/firefox/'];
      const chromium = await Promise.all(urls.map((url) => toggleTab({ id: 2147483000, url })));
      api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
      try {
        return { chromium, firefox: await Promise.all(urls.map((url) => toggleTab({ id: 2147483000, url }))) };
      } finally {
        delete api.runtime.getBrowserInfo;
      }
    });
    const restricted = { ok: false, active: false, reason: 'restricted' };
    const blocked = { ok: false, active: false, reason: 'blocked' };
    expect(results.firefox).toEqual([restricted, restricted, restricted]);
    // Elsewhere they are ordinary sites (the stores stay out of reach everywhere).
    expect(results.chromium).toEqual([blocked, blocked, restricted]);
  });

  test('a selection from a private window reaches the Reader marked private, and is not kept', async ({ page, context, serviceWorker }) => {
    const tabId = await fixtureTab(page, serviceWorker);
    const opened = context.waitForEvent('page');
    await swEval(serviceWorker, async (id) => {
      const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
      const info = { menuItemId: 'skb-read-selection', selectionText: 'Private words to read', frameId: 0 };
      await globalThis.Skimbold.background.onMenuClick(info, { ...tab, incognito: true });
    }, tabId);
    const reader = await opened;
    await reader.waitForURL(/reader\/reader\.html\?session=[^&]+&private=1$/);
    await expect(reader.locator('#rd-doc-body p')).toHaveText('Private words to read');
    await reader.mouse.wheel(0, 200);
    await reader.waitForTimeout(700);
    const kept = await reader.evaluate(() => [localStorage.getItem('skimbold.reader.doc'), localStorage.getItem('skimbold.reader.position')]);
    expect(kept).toEqual([null, null]);
  });
});
