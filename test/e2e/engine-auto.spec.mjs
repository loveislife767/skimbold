// content/auto.js: injected after settings, core and engine by the auto-on content script. It must
// wait for the page to load and go idle, then turn the engine on only if the settings still say
// so for this origin. background.js may register the real auto-on script for these settings
// too; injecting by hand as well is harmless, because every file bails out on a second run.

import { test, expect, collectConsoleErrors, tabIdFor } from './fixtures.mjs';
import { openFixture, inject, isolated, send, writeSettings, AUTO_FILES } from '../fixtures/engine/helpers.mjs';

const boldCount = (page) => page.evaluate(() => document.querySelectorAll('skb-b').length);
const decision = (serviceWorker, tabId) => isolated(serviceWorker, tabId, () => globalThis.Skimbold.auto);
const active = (serviceWorker, tabId) => isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.isActive());

test('turns the engine on after load when the origin is an always-on site', async ({ page, serviceWorker, server }) => {
  const errors = collectConsoleErrors(page);
  await writeSettings(serviceWorker, { autoSites: [server.url] });
  const tabId = await openFixture(page, serviceWorker, '/engine/article.html');
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  expect(await decision(serviceWorker, tabId)).toEqual([true]);
  expect(await active(serviceWorker, tabId)).toEqual([true]);
  await expect.poll(() => boldCount(page)).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('turns on everywhere with autoAll, but stays off on an excluded origin', async ({ page, serviceWorker, server }) => {
  await writeSettings(serviceWorker, { autoAll: true, excludedSites: ['https://elsewhere.example'] });
  let tabId = await openFixture(page, serviceWorker, '/engine/dynamic.html');
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  expect(await decision(serviceWorker, tabId)).toEqual([true]);
  await expect.poll(() => boldCount(page)).toBeGreaterThan(10);

  await writeSettings(serviceWorker, { autoAll: true, excludedSites: [server.url] });
  tabId = await openFixture(page, serviceWorker, '/engine/article.html');
  const html = await page.evaluate(() => document.body.innerHTML);
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  expect(await decision(serviceWorker, tabId)).toEqual([false]);
  expect(await active(serviceWorker, tabId)).toEqual([false]);
  expect(await page.evaluate(() => document.body.innerHTML)).toBe(html);
});

test('stays off when the origin is not an always-on site', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, { autoSites: ['https://elsewhere.example'] });
  const tabId = await openFixture(page, serviceWorker, '/engine/dynamic.html');
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  expect(await decision(serviceWorker, tabId)).toEqual([false]);
  expect(await boldCount(page)).toBe(0);
});

test('waits for the load event before turning on, and a second injection changes nothing', async ({ page, serviceWorker, server }) => {
  const errors = collectConsoleErrors(page);
  await writeSettings(serviceWorker, { autoSites: [server.url] });
  let releaseImage;
  const imageHeld = new Promise((resolve) => { releaseImage = resolve; });
  await page.route('**/engine/held.gif', async (route) => {
    await imageHeld;
    await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  });
  // The image is in the parsed markup, so the load event waits until the route answers.
  await page.goto('/engine/held-load.html', { waitUntil: 'domcontentloaded' });
  const tabId = await tabIdFor(serviceWorker, page);
  expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  await page.waitForTimeout(500);
  expect(await active(serviceWorker, tabId)).toEqual([false]);
  expect(await boldCount(page)).toBe(0);

  releaseImage();
  // Asking the frame for a promise at the very moment it finishes loading can leave
  // executeScript waiting forever (seen in Chromium 153), so ask once the load is done.
  await page.waitForLoadState('load');
  expect(await decision(serviceWorker, tabId)).toEqual([true]);
  await expect.poll(() => boldCount(page)).toBeGreaterThan(10);
  expect(await page.evaluate(() => document.querySelectorAll('#first skb-w').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('a choice the user makes while it waits for the page stands', async ({ page, serviceWorker, server }) => {
  const errors = collectConsoleErrors(page);
  await writeSettings(serviceWorker, { autoSites: [server.url] });
  let releaseImage;
  const imageHeld = new Promise((resolve) => { releaseImage = resolve; });
  await page.route('**/engine/held.gif', async (route) => {
    await imageHeld;
    await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  });
  await page.goto('/engine/held-load.html', { waitUntil: 'domcontentloaded' });
  const tabId = await tabIdFor(serviceWorker, page);
  await inject(serviceWorker, tabId, { files: AUTO_FILES });
  // Turned on and off again from the toolbar before the page has finished loading.
  expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: true });
  expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: false });

  releaseImage();
  await page.waitForLoadState('load');
  expect(await decision(serviceWorker, tabId)).toEqual([false]);
  expect(await active(serviceWorker, tabId)).toEqual([false]);
  expect(await boldCount(page)).toBe(0);
  expect(errors).toEqual([]);
});
