// The engine under a React 18 app that re-renders every 10-50 ms. The fixture renders one store
// into #app (processed) and #reference (data-skimbold-skip, never touched), so any stale,
// duplicated or missing text shows up as a difference between the two. And a server-rendered
// app that hydrates on load, turned on while the page is still loading, and a page that is still
// loading long after it opened.

import { test, expect, collectConsoleErrors, tabIdFor } from './fixtures.mjs';
import { openFixture, inject, setActive, frames, invariantProblems } from '../fixtures/engine/helpers.mjs';

const RUN_MS = 3_000;

const ticks = (page) => page.evaluate(() => window.reactFixture.ticks());
const boldCount = (page, selector) => page.evaluate((sel) => document.querySelectorAll(`${sel} skb-b`).length, selector);
// Text in #app with a word in it that is not in a wrapper.
const plainWords = (page) => page.evaluate(() => {
  const walker = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT);
  const plain = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement.closest('skb-w') === null && /\p{L}{2,}/u.test(node.data)) plain.push(node.data.trim());
  }
  return plain;
});

// Stops the updates, lets React and the engine settle, then compares what both roots show.
async function expectSameText(page) {
  await page.evaluate(() => window.reactFixture.pause());
  await frames(page, 50);
  const { app, reference } = await page.evaluate(() => window.reactFixture.texts());
  expect(app.length).toBeGreaterThan(200);
  expect(app).toBe(reference);
}

for (const when of ['before', 'after']) {
  test(`a React 18 app keeps rendering correctly with the engine enabled ${when} it mounts`, async ({ page, serviceWorker }) => {
    test.setTimeout(60_000);
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, when === 'before' ? '/engine/react.html?manual' : '/engine/react.html');
    await inject(serviceWorker, tabId);
    if (when === 'before') {
      expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
      await page.evaluate(() => window.reactFixture.start());
    } else {
      await page.waitForFunction(() => window.reactFixture.ticks() > 5);
      expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
    }
    await expect.poll(() => boldCount(page, '#app')).toBeGreaterThan(20);

    const startTick = await ticks(page);
    await page.waitForTimeout(RUN_MS);
    expect(await ticks(page) - startTick).toBeGreaterThan(30);
    expect(await page.evaluate(() => window.reactFixture.mismatches)).toEqual([]);
    await expectSameText(page);
    // Text the engine held back while React kept replacing it is bolded once the app is quiet.
    await expect.poll(() => plainWords(page), { timeout: 5_000 }).toEqual([]);
    expect(await boldCount(page, '#reference')).toBe(0);
    expect(await invariantProblems(page, '#app')).toEqual([]);

    // Turned off while React keeps rendering: no wrappers remain and the app still updates.
    await page.evaluate(() => window.reactFixture.resume());
    expect(await setActive(serviceWorker, tabId, false)).toEqual({ active: false });
    expect(await page.evaluate(() => document.querySelectorAll('skb-w, skb-b').length)).toBe(0);
    const offTick = await ticks(page);
    await page.waitForTimeout(1_000);
    expect(await ticks(page) - offTick).toBeGreaterThan(10);
    await expectSameText(page);
    expect(await page.evaluate(() => window.reactFixture.mismatches)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('turned on while a server-rendered app is still loading, it waits until the app has hydrated', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  const count = (selector) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  let releaseImage;
  const imageHeld = new Promise((resolve) => { releaseImage = resolve; });
  await page.route('**/engine/held.gif', async (route) => {
    await imageHeld;
    await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  });
  // The image holds the load event, and with it the app's hydration.
  await page.goto('/engine/hydrate.html', { waitUntil: 'domcontentloaded' });
  const tabId = await tabIdFor(serviceWorker, page);
  expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  await inject(serviceWorker, tabId);
  expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
  await page.waitForTimeout(300);
  expect(await count('skb-w')).toBe(0);

  releaseImage();
  await page.waitForLoadState('load');
  await expect.poll(() => count('#app skb-b')).toBeGreaterThan(5);
  await page.click('#click');
  await expect(page.locator('#count')).toHaveText('You clicked 1 times');
  // An Astro island is left alone until it has hydrated too.
  expect(await count('#island skb-w')).toBe(0);
  await page.evaluate(() => document.querySelector('astro-island').removeAttribute('ssr'));
  await expect.poll(() => count('#island skb-b')).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

// Pages full of ads can hold their load event back for half a minute, long after they are
// readable. The wait for it ends 3 s after the page opened, not 3 s after turning on, so a page
// that has been open longer than that is bolded straight away.
test('turned on while a page that opened more than 3 s ago is still loading, it starts at once', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  let releaseImage;
  const imageHeld = new Promise((resolve) => { releaseImage = resolve; });
  await page.route('**/engine/held.gif', async (route) => {
    await imageHeld;
    await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  });
  await page.goto('/engine/held-load.html', { waitUntil: 'domcontentloaded' });
  const tabId = await tabIdFor(serviceWorker, page);
  await inject(serviceWorker, tabId);
  await page.waitForFunction(() => performance.now() > 3_200, null, { polling: 100 });
  expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
  // Only a moment of idle (at most 1 s) comes first.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#first skb-w').length), { timeout: 1_500 }).toBe(1);
  expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  releaseImage();
  expect(errors).toEqual([]);
});
