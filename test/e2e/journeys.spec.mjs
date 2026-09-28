// Whole user journeys across the background, the popup, the page engine and the Reader, the
// way a person uses them: turn a page on, adjust it from the panel, turn it off, send a
// selection to the Reader, and read a PDF tab. Unlike the per-part specs, each test here
// crosses every piece it touches with nothing stubbed.

import { createRequire } from 'node:module';
import {
  test, expect, openExtensionPage, swEval, tabIdFor, collectConsoleErrors,
} from './fixtures.mjs';

const core = createRequire(import.meta.url)('../../extension/shared/core.js');

const PDF_TITLE = 'Notes on Reading by Lamplight';

function badgeText(serviceWorker, tabId) {
  return swEval(serviceWorker, (id) => (globalThis.browser ?? globalThis.chrome).action.getBadgeText({ tabId: id }), tabId);
}

function toggleTab(serviceWorker, tabId) {
  return swEval(serviceWorker, async (id) => {
    const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
    return globalThis.Skimbold.background.toggleTab(tab);
  }, tabId);
}

function boldStarts(text, opts) {
  return (core.transform(text, opts) || []).filter((part) => part.b).map((part) => part.t);
}

// True when every wrapper on the page shows exactly the bold starts core.js gives for its text.
async function pageMatches(page, opts) {
  const wrappers = await page.evaluate(() => [...document.querySelectorAll('skb-w')].map((wrapper) => ({
    text: wrapper.textContent,
    bold: [...wrapper.querySelectorAll('skb-b')].map((bold) => bold.textContent),
  })));
  return wrappers.length > 10
    && wrappers.every((wrapper) => JSON.stringify(wrapper.bold) === JSON.stringify(boldStarts(wrapper.text, opts)));
}

test('a page: on from the background, adjusted live from the popup, then off from the popup', async ({ page, context, serviceWorker, extensionId }) => {
  const pageErrors = collectConsoleErrors(page);
  await page.goto('/basic.html');
  const markup = await page.evaluate(() => document.body.innerHTML);
  const visibleText = await page.locator('main').innerText();
  const tabId = await tabIdFor(serviceWorker, page);

  expect(await toggleTab(serviceWorker, tabId)).toEqual({ ok: true, active: true });
  await expect.poll(() => pageMatches(page, { mode: 'auto', strength: 3 })).toBe(true);
  await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('ON');
  expect(await page.locator('main').innerText()).toBe(visibleText);
  // Code and buttons stay plain text; the search box's label is ordinary text.
  await expect(page.locator('pre skb-w, button skb-w')).toHaveCount(0);
  await expect(page.locator('#search label skb-b')).not.toHaveCount(0);

  const popup = await openExtensionPage(context, extensionId, `popup/popup.html?tab=${tabId}`);
  const popupErrors = collectConsoleErrors(popup);
  await expect(popup.locator('#toggle')).toHaveText('On — turn off');
  await expect(popup.locator('#toggle')).toHaveAttribute('data-active', 'true');

  await popup.click('label[for="letters-3"]');
  await expect.poll(() => pageMatches(page, { mode: 'fixed', letters: 3 })).toBe(true);
  await popup.click('label[for="weight-900"]');
  await expect.poll(() => page.locator('skb-b').first().evaluate((el) => getComputedStyle(el).fontWeight)).toBe('900');

  await popup.click('#toggle');
  await expect(popup.locator('#toggle')).toHaveText('Turn on for this page');
  await expect.poll(() => page.evaluate(() => document.body.innerHTML)).toBe(markup);
  await expect.poll(() => badgeText(serviceWorker, tabId)).toBe('');
  expect(pageErrors).toEqual([]);
  expect(popupErrors).toEqual([]);
});

test('a selection: sent from the page menu to the Reader, which bolds it and clears the hand-off', async ({ page, context, serviceWorker }) => {
  await page.goto('/basic.html');
  const tabId = await tabIdFor(serviceWorker, page);
  const paragraphs = await page.evaluate(() => {
    const [first, second] = document.querySelectorAll('h2 + p, h2 + p + p');
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(second);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return [first.textContent, second.textContent];
  });

  const opened = context.waitForEvent('page');
  await swEval(serviceWorker, async (id) => {
    const tab = await (globalThis.browser ?? globalThis.chrome).tabs.get(id);
    // Chromium flattens selectionText; the background reads the real selection from the frame.
    await globalThis.Skimbold.background.onMenuClick({ menuItemId: 'skb-read-selection', selectionText: 'flattened', frameId: 0 }, tab);
  }, tabId);
  const reader = await opened;
  const readerErrors = collectConsoleErrors(reader);
  await reader.waitForURL(/reader\/reader\.html\?session=selection-/);

  await expect(reader.locator('#rd-doc-end')).toBeVisible();
  await expect(reader.locator('#rd-doc-body p')).toHaveText(paragraphs);
  const firstBold = await reader.locator('#rd-doc-body p').first().locator('.skb-rb').allTextContents();
  expect(firstBold).toEqual(boldStarts(paragraphs[0], {}));
  await expect(reader.locator('#rd-doc-meta')).toHaveText(/^Selected text · \d+ words$/);
  // The Reader read the text once and removed it from session storage.
  expect(await swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).storage.session.get(null))).toEqual({});
  expect(readerErrors).toEqual([]);
});

test('a PDF tab: the popup offers the Reader, which reads the file through that tab', async ({ page, context, serviceWorker, extensionId, server }) => {
  const response = await page.goto('/reader/article.pdf');
  expect(response.headers()['content-type']).toBe('application/pdf');
  const tabId = await tabIdFor(serviceWorker, page);

  const popup = await openExtensionPage(context, extensionId, `popup/popup.html?tab=${tabId}`);
  await expect(popup.locator('#site-row')).toHaveAttribute('data-pending', 'false');
  await expect(popup.locator('#open-pdf')).toBeVisible();
  // The browser's viewer is out of reach, so the Reader takes the toggle's place.
  await expect(popup.locator('#toggle')).toBeHidden();

  const opened = context.waitForEvent('page');
  await popup.click('#open-pdf');
  const reader = await opened;
  const readerErrors = collectConsoleErrors(reader);
  const directFetches = [];
  reader.on('request', (request) => {
    if (request.url().endsWith('/reader/article.pdf')) directFetches.push(request.url());
  });
  await reader.waitForURL(/reader\/reader\.html\?pdf=/);
  expect(new URL(reader.url()).searchParams.get('pdf')).toBe(`${server.url}/reader/article.pdf`);

  await expect(reader.locator('#rd-doc-end')).toBeVisible({ timeout: 15_000 });
  await expect(reader.locator('#rd-doc-body h1')).toHaveText(PDF_TITLE);
  await expect(reader.locator('#rd-doc-body p', { hasText: 'extraordinary' })).toHaveCount(1);
  await expect(reader.locator('#rd-doc-body .skb-rb').first()).toBeVisible();
  await expect(reader.locator('#rd-doc-meta')).toHaveText(/^PDF · 3 pages · \d+ words$/);
  // The file came through the PDF's own tab, so the Reader never downloaded it itself.
  expect(directFetches).toEqual([]);
  expect(readerErrors).toEqual([]);
});

test('a PDF tab: the shortcut opens the Reader instead of claiming the page is on', async ({ page, context, serviceWorker, server }) => {
  await page.goto('/reader/article.pdf');
  const tabId = await tabIdFor(serviceWorker, page);
  await page.bringToFront();

  const opened = context.waitForEvent('page');
  const result = await swEval(serviceWorker, () => globalThis.Skimbold.background.onCommand('toggle-page'));
  expect(result).toEqual({ ok: false, active: false, reason: 'pdf' });
  const reader = await opened;
  await reader.waitForURL(/reader\/reader\.html\?pdf=/);
  const params = new URL(reader.url()).searchParams;
  expect(params.get('pdf')).toBe(`${server.url}/reader/article.pdf`);
  expect(params.get('tab')).toBe(String(tabId));
  await expect(reader.locator('#rd-doc-body h1')).toHaveText(PDF_TITLE, { timeout: 15_000 });

  expect(await badgeText(serviceWorker, tabId)).toBe('');
  const info = await swEval(serviceWorker, (id) => globalThis.Skimbold.background.getTabInfo(id), tabId);
  expect(info).toMatchObject({ restricted: false, active: false, pdf: true });
  // Once the engine is in the tab, a second press is answered from its state alone.
  expect(await toggleTab(serviceWorker, tabId)).toEqual({ ok: false, active: false, reason: 'pdf' });
});
