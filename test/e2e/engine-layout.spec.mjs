// Text whose own styles decide how it may be wrapped: runs of text nodes in flex and grid
// containers, icon-font ligatures, gradient text, text heavier than the bold setting,
// text-transform: capitalize, pages that turn font synthesis off, and :empty rules.

import { test, expect, collectConsoleErrors } from './fixtures.mjs';
import { openFixture, inject, setActive, frames, writeSettings, invariantProblems } from '../fixtures/engine/helpers.mjs';

const count = (page, selector) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

// Where each word of an element's text is drawn, so a layout change shows up as moved words.
const wordBoxes = (page, selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  const boxes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) boxes.push([Math.round(rect.left), Math.round(rect.top)]);
  }
  return { text: root.innerText, left: Math.min(...boxes.map((box) => box[0])), boxes: boxes.length, height: Math.round(root.getBoundingClientRect().height) };
}, selector);

async function turnOn(page, serviceWorker) {
  const tabId = await openFixture(page, serviceWorker, '/engine/layout.html');
  await inject(serviceWorker, tabId);
  expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
  await expect.poll(() => count(page, '#note skb-w')).toBe(1);
  await frames(page);
  return tabId;
}

test('adjacent text nodes in flex and grid containers stay one item, so nothing moves', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/engine/layout.html');
  const before = {};
  for (const id of ['#row', '#spread', '#grid']) before[id] = await page.evaluate((sel) => document.querySelector(sel).innerText, id);
  const rowSpan = await page.evaluate(() => Math.round(document.querySelector('#row span').getBoundingClientRect().left));
  const gridHeight = await page.evaluate(() => Math.round(document.getElementById('grid').getBoundingClientRect().height));

  const tabId = await turnOn(page, serviceWorker);
  for (const id of ['#row', '#spread', '#grid']) {
    expect(await page.evaluate((sel) => document.querySelector(sel).innerText, id), id).toBe(before[id]);
  }
  expect(await page.evaluate(() => Math.round(document.querySelector('#row span').getBoundingClientRect().left))).toBe(rowSpan);
  expect(await page.evaluate(() => Math.round(document.getElementById('grid').getBoundingClientRect().height))).toBe(gridHeight);
  // A lone text node in a flex row is its own item either way, so it is bolded.
  expect(await count(page, '#single skb-b')).toBeGreaterThan(3);
  // The span holding "Reply" is an item of its own, and its text is bolded as usual.
  expect(await count(page, '#row span skb-b')).toBe(1);
  expect(await invariantProblems(page)).toEqual([]);
  await setActive(serviceWorker, tabId, false);
  expect(errors).toEqual([]);
});

test('icon-font ligatures are left whole, by class, by tag and by font', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  await turnOn(page, serviceWorker);
  for (const id of ['#icon-class', '#icon-font', '#icon-tag']) expect(await count(page, `${id} skb-w`), id).toBe(0);
  expect(await count(page, '#not-icon skb-b')).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('with Fade on, gradient text keeps its own fill while ordinary text fades', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  await turnOn(page, serviceWorker);
  await writeSettings(serviceWorker, { fade: 40 });
  const fills = () => page.evaluate(() => {
    const fill = (el) => getComputedStyle(el).webkitTextFillColor;
    return {
      wrapper: fill(document.querySelector('#gradient skb-w')),
      bold: fill(document.querySelector('#gradient skb-b')),
      plainTail: fill(document.querySelector('#not-icon skb-w')),
    };
  });
  await expect.poll(async () => (await fills()).plainTail).toMatch(/\/ 0\.6\)|, 0\.6\)/);
  expect(await fills()).toEqual(expect.objectContaining({ wrapper: 'rgba(0, 0, 0, 0)', bold: 'rgba(0, 0, 0, 0)' }));
  expect(errors).toEqual([]);
});

test('word starts are never lighter than the text around them', async ({ page, serviceWorker }) => {
  await turnOn(page, serviceWorker);
  const weights = () => page.evaluate(() => ({
    heavy: getComputedStyle(document.querySelector('#heavy skb-b')).fontWeight,
    normal: getComputedStyle(document.querySelector('#not-icon skb-b')).fontWeight,
  }));
  expect(await weights()).toEqual({ heavy: '900', normal: '700' });
  // Choosing Black makes ordinary starts 900 as well; the heading stays at 900.
  await writeSettings(serviceWorker, { weight: 900 });
  await expect.poll(weights).toEqual({ heavy: '900', normal: '900' });
  await writeSettings(serviceWorker, { weight: 600 });
  await expect.poll(weights).toEqual({ heavy: '900', normal: '600' });
});

test('text already as heavy as the bold keeps its own weight, so its lines keep their height', async ({ page, serviceWorker }) => {
  const ids = ['bold-arial', 'strong-para', 'section-title', 'headers'];
  const heights = () => page.evaluate((list) => list.map((id) => document.getElementById(id).getBoundingClientRect().height), ids);
  await page.goto('/engine/layout.html');
  const before = await heights();
  await turnOn(page, serviceWorker);
  await expect.poll(() => count(page, '#headers skb-b')).toBeGreaterThan(1);
  await frames(page);
  expect(await heights()).toEqual(before);
  const weights = await page.evaluate(() => ['#bold-arial', '#strong-para strong', '#strong-para b', '#section-title', '#headers th', '#strong-para']
    .map((selector) => getComputedStyle(document.querySelector(`${selector} skb-b`)).fontWeight));
  // Bold text keeps its 700 in the word starts; ordinary text around it gets the setting's.
  expect(weights).toEqual(['700', '700', '700', '700', '700', '700']);
});

test('text-transform: capitalize still capitalizes the first word', async ({ page, serviceWorker }) => {
  await page.goto('/engine/layout.html');
  const shown = await page.evaluate(() => document.getElementById('cap').innerText);
  expect(shown).toBe('The Quick Brown Fox Jumps');
  await turnOn(page, serviceWorker);
  expect(await count(page, '#cap skb-w')).toBe(1);
  expect(await page.evaluate(() => document.getElementById('cap').innerText)).toBe(shown);
});

test('bold word starts survive a page that turns font synthesis off', async ({ page, serviceWorker }) => {
  await turnOn(page, serviceWorker);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#synthesis')).fontSynthesisWeight)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#synthesis skb-b')).fontSynthesisWeight)).toBe('auto');
});

test('a note the page empties matches :empty again', async ({ page, serviceWorker }) => {
  await turnOn(page, serviceWorker);
  await page.evaluate(() => { document.getElementById('note').firstChild.nodeValue = ''; });
  await frames(page);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('note')).display)).toBe('none');
  await page.evaluate(() => { document.getElementById('note').firstChild.nodeValue = 'Back with words again'; });
  await expect.poll(() => count(page, '#note skb-b')).toBeGreaterThan(1);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('note')).display)).toBe('block');
  expect(await wordBoxes(page, '#note')).toEqual(expect.objectContaining({ text: 'Back with words again' }));
});
