// The engine next to what pages do with their own text. Skimbold runs only in the content script's
// isolated world, so page scripts see the real DOM: an emptied text node reads '', and the words
// are in the wrapper's own text nodes. Covered here: a real search highlighter (mark.js 8.11.1)
// marking and unmarking inside our wrappers, text walkers, ranges cut across the bolding, a text component that skips empty text
// nodes (YouTube's), the known limits (normalize() and in-place appends), copy and drag, editors, markup the page re-parses or puts back, the user's
// selection, a busy chat, shadow roots and frames that arrive late. Several tests are
// differential: the same page script runs once without Skimbold and once with it on, and the page
// must end up the same after Skimbold is turned off.

import { test, expect, collectConsoleErrors, tabIdFor } from './fixtures.mjs';
import {
  openFixture, inject, setActive, frames, invariantProblems,
} from '../fixtures/engine/helpers.mjs';

const bodyHtml = (page) => page.evaluate(() => document.body.innerHTML);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const count = (page, selector) => page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

// Opens urlPath (or keeps the page as it is, when urlPath is null) and turns Skimbold on.
async function turnOn(page, serviceWorker, urlPath, { settled = '#c skb-w' } = {}) {
  const tabId = urlPath === null ? await tabIdFor(serviceWorker, page) : await openFixture(page, serviceWorker, urlPath);
  await inject(serviceWorker, tabId);
  expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
  await expect.poll(() => count(page, settled)).toBeGreaterThan(0);
  await frames(page);
  return tabId;
}

// Runs `action` in the page without Skimbold, then again with Skimbold on, and returns what each
// run showed and left behind (the second after turning Skimbold off). `action` may return a value.
// `settled` is the wrapper to wait for after turning on (see turnOn).
async function differential(page, serviceWorker, urlPath, action, arg, settled) {
  await page.goto(urlPath);
  const plainResult = await page.evaluate(action, arg);
  await frames(page);
  const plain = { result: plainResult, text: await bodyText(page), html: await bodyHtml(page) };

  const tabId = await turnOn(page, serviceWorker, urlPath, { settled });
  const result = await page.evaluate(action, arg);
  await frames(page, 50);
  const on = { result, text: await bodyText(page), problems: await invariantProblems(page), bold: await count(page, 'skb-b') };
  await setActive(serviceWorker, tabId, false);
  return { plain, on: { ...on, html: await bodyHtml(page), leftover: await count(page, 'skb-w, skb-b') } };
}

function expectSame({ plain, on }) {
  expect(on.result).toEqual(plain.result);
  expect(on.text).toBe(plain.text);
  expect(on.problems).toEqual([]);
  expect(on.html).toBe(plain.html);
  expect(on.leftover).toBe(0);
}

test.describe('search highlighters (mark.js 8.11.1)', () => {
  // mark.js marks asynchronously and calls `done` when it has finished.
  const mark = (page, term, options = {}) => page.evaluate(([word, extra]) => new Promise((resolve) => {
    new window.Mark(document.getElementById('page')).mark(word, { ...extra, done: resolve });
  }), [term, options]);
  const unmark = (page) => page.evaluate(() => new Promise((resolve) => {
    new window.Mark(document.getElementById('page')).unmark({ done: resolve });
  }));
  const marked = (page) => page.evaluate(() => [...document.querySelectorAll('mark')].map((element) => element.textContent).join(''));
  // Answers once the page has run a timer again, so a page that hangs fails the test.
  const responsive = (page) => Promise.race([
    page.evaluate(() => new Promise((resolve) => { setTimeout(() => resolve('responsive'), 0); })),
    new Promise((resolve) => { setTimeout(() => resolve('hung'), 5_000); }),
  ]);

  test('marks and unmarks words across the bold starts, and the marks outlive turning Skimbold off', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/highlight.html');
    const text = await bodyText(page);
    const html = await bodyHtml(page);
    const tabId = await turnOn(page, serviceWorker, null);

    // acrossElements finds a word the bolding split into two nodes, and marks each piece.
    await mark(page, 'harbour', { acrossElements: true });
    expect(await responsive(page)).toBe('responsive');
    await frames(page);
    expect(await marked(page)).toBe('harbour'.repeat(4));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('mark')).backgroundColor)).toBe('rgb(255, 224, 102)');
    expect(await bodyText(page)).toBe(text);
    expect(await count(page, '#page skb-b')).toBeGreaterThan(20);
    expect(await invariantProblems(page)).toEqual([]);

    await unmark(page);
    await frames(page);
    expect(await count(page, 'mark')).toBe(0);
    expect(await bodyText(page)).toBe(text);
    expect(await invariantProblems(page)).toEqual([]);

    // Marked again, then turned off: the highlights stay, the text is whole, and none of our
    // markup is left.
    await mark(page, 'harbour', { acrossElements: true });
    expect(await setActive(serviceWorker, tabId, false)).toEqual({ active: false });
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(await marked(page)).toBe('harbour'.repeat(4));
    expect(await bodyText(page)).toBe(text);
    // Unmarked after that, the page is exactly what it was.
    await unmark(page);
    expect(await bodyHtml(page)).toBe(html);
    expect(errors).toEqual([]);
  });

  // Highlights made before Skimbold was turned on are page text it wraps. Clearing them takes each
  // mark apart and then normalize()s its parent, which removes the text nodes Skimbold emptied
  // there: mark.js puts all of a mark's children in its place, jQuery's highlight plugin only the
  // first (Skimbold's emptied node, so the words went with the mark).
  const clearers = {
    'mark.js unmark': unmark,
    'jQuery removeHighlight': (page) => page.evaluate(() => {
      for (const element of document.querySelectorAll('mark')) {
        const parent = element.parentNode;
        parent.replaceChild(element.firstChild, element);
        parent.normalize();
      }
    }),
  };
  for (const [name, clear] of Object.entries(clearers)) {
    test(`highlights made before turning on are cleared while on without losing a word (${name})`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      await page.goto('/engine/highlight.html');
      const text = await bodyText(page);
      const html = await bodyHtml(page);
      await mark(page, 'harbour', { acrossElements: true });
      const tabId = await turnOn(page, serviceWorker, null);
      expect(await marked(page)).toBe('harbour'.repeat(4));
      await clear(page);
      await frames(page);
      expect(await count(page, 'mark')).toBe(0);
      expect(await bodyText(page)).toBe(text);
      expect(await page.evaluate(() => [...document.querySelectorAll('#page p')].map((p) => p.querySelector('skb-b') !== null)))
        .toEqual([true, true, true]);
      expect(await invariantProblems(page)).toEqual([]);
      await setActive(serviceWorker, tabId, false);
      expect(await bodyHtml(page)).toBe(html);
      expect(errors).toEqual([]);
    });
  }

  // A search page that clears its highlights also updates its other text in the same handler (the
  // results line). Only sources normalize() removed where the highlighter took a mark apart keep
  // their words; everywhere else the page's change shows, as it does without Skimbold.
  for (const change of ['cleared', 'rewritten', 'removed']) {
    test(`clearing highlights and changing other text in one task shows the page's change (${change})`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      const clearSearch = (how) => {
        new window.Mark(document.getElementById('page')).unmark();
        const status = document.getElementById('status');
        if (how === 'cleared') status.textContent = '';
        else if (how === 'rewritten') status.textContent = 'No search';
        else status.firstChild.remove();
      };
      await page.goto('/engine/highlight.html');
      await mark(page, 'harbour', { acrossElements: true });
      await page.evaluate(clearSearch, change);
      const plain = await bodyText(page);

      await page.goto('/engine/highlight.html');
      await mark(page, 'harbour', { acrossElements: true });
      const tabId = await turnOn(page, serviceWorker, null);
      await page.evaluate(clearSearch, change);
      await frames(page);
      expect(await bodyText(page)).toBe(plain);
      expect(await count(page, '#page skb-b')).toBeGreaterThan(20);
      expect(await invariantProblems(page)).toEqual([]);
      await setActive(serviceWorker, tabId, false);
      expect(await bodyText(page)).toBe(plain);
      expect(errors).toEqual([]);
    });
  }

  test('marks made and cleared while on leave whole text nodes after off, and on again bolds whole words', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/highlight.html');
    const tabId = await turnOn(page, serviceWorker, null);
    const starts = () => page.evaluate(() => [...document.querySelectorAll('#a skb-b')].map((bold) => bold.textContent));
    const first = await starts();
    await mark(page, 'harbour', { acrossElements: true });
    await unmark(page);
    await setActive(serviceWorker, tabId, false);
    // The bold parts split the text inside the wrapper; off merges it back into one node.
    expect(await page.evaluate(() => document.getElementById('a').childNodes.length)).toBe(1);
    // So a search that looks at one text node at a time finds the words again.
    expect(await page.evaluate(() => new Promise((resolve) => {
      new window.Mark(document.getElementById('a')).mark('fishermen', { done: resolve });
    }))).toBe(1);
    await unmark(page);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(starts).toEqual(first);
    expect(errors).toEqual([]);
  });

  test('the default search, one text node at a time, stays responsive and leaves the page as it was', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/highlight.html');
    const html = await bodyHtml(page);
    const tabId = await turnOn(page, serviceWorker, null);
    // Words whose start is bold span two nodes, so this search finds only what lies in one:
    // "harbour" nowhere, the last letters of "master" in their node (README: Known limitations).
    await page.evaluate(() => { setTimeout(() => new window.Mark(document.getElementById('page')).mark(['harbour', 'ster']), 0); });
    expect(await responsive(page)).toBe('responsive');
    await frames(page);
    expect(await marked(page)).toBe('ster');
    await unmark(page);
    expect(await invariantProblems(page)).toEqual([]);
    await setActive(serviceWorker, tabId, false);
    expect(await bodyHtml(page)).toBe(html);
    expect(errors).toEqual([]);
  });
});

test.describe('page scripts that work on text nodes', () => {
  // Over the whole page, or over one paragraph that Skimbold holds in a single emptied text node.
  for (const scope of ['page', 'a']) {
    test(`a text walker that writes back every text node leaves the bolding alone, and its own changes show (${scope})`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      const outcome = await differential(page, serviceWorker, '/engine/scripts.html', (id) => {
        // It writes '' back into every text node Skimbold emptied, and ends each sentence with "!".
        const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
        let changed = 0;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const next = node.nodeValue.replace(/\.$/, '!');
          if (next !== node.nodeValue) changed++;
          node.nodeValue = next;
        }
        return changed;
      }, scope);
      expectSame(outcome);
      expect(outcome.on.text).toContain('their nets!');
      expect(outcome.on.bold).toBeGreaterThan(20);
      expect(errors).toEqual([]);
    });
  }

  // A transliteration (here: upper case) changes every text node it visits, the ones inside the
  // wrappers included, and writes '' back into the emptied ones.
  test('a text walker that changes every node of a paragraph keeps its words and shows its change', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const outcome = await differential(page, serviceWorker, '/engine/scripts.html', () => {
      const walker = document.createTreeWalker(document.getElementById('a'), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) node.data = node.data.toUpperCase();
    });
    expectSame(outcome);
    expect(outcome.on.text).toContain('MORNING LIGHT');
    expect(outcome.on.bold).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  // The walker writes '' back into #c's emptied node too; the page's own clear, before or after
  // it in the same task, still empties #c.
  for (const order of ['after', 'before']) {
    test(`a text node the page clears in the same task as a text walker is cleared (${order} the walk)`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      const outcome = await differential(page, serviceWorker, '/engine/scripts.html', (when) => {
        const counter = document.getElementById('c').firstChild;
        if (when === 'before') counter.data = '';
        const walker = document.createTreeWalker(document.getElementById('page'), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) node.data = node.data;
        if (when === 'after') counter.data = '';
      }, order);
      expectSame(outcome);
      expect(outcome.on.text).not.toContain('Gulls');
      expect(outcome.on.bold).toBeGreaterThan(20);
      expect(errors).toEqual([]);
    });
  }

  // Appending to every node writes text into the emptied ones as well. Every word stays; the
  // appended spaces also land between the pieces the bolding split words into.
  test('a text walker that appends to every text node keeps every word, on and after off', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const appendToEvery = () => {
      const walker = document.createTreeWalker(document.getElementById('page'), NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) node.data += ' ';
    };
    const shown = () => page.evaluate(() => document.body.innerText.replaceAll(' ', ''));
    await page.goto('/engine/scripts.html');
    await page.evaluate(appendToEvery);
    const text = await shown();
    await page.goto('/engine/scripts.html');
    const tabId = await turnOn(page, serviceWorker, null);
    await page.evaluate(appendToEvery);
    await frames(page);
    expect(await shown()).toBe(text);
    expect(await invariantProblems(page)).toEqual([]);
    await setActive(serviceWorker, tabId, false);
    expect(await shown()).toBe(text);
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(errors).toEqual([]);
  });

  // A highlighter that works with ranges cuts through the bolding: from the plain part of one word
  // ("fa|lls") into the next element ("quie|t"), which takes the emptied text node inside <em>
  // along. What the range leaves behind (the "t") stays where it is, as it does without Skimbold.
  for (const how of ['extractContents', 'deleteContents']) {
    test(`a range from bolded text into the next element leaves the rest in place (${how})`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      const outcome = await differential(page, serviceWorker, '/engine/scripts.html', (method) => {
        const find = (text) => {
          const walker = document.createTreeWalker(document.getElementById('b'), NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (node.data.includes(text)) return [node, node.data.indexOf(text)];
          }
          return null;
        };
        const [start, startAt] = find('lls');
        const [end, endAt] = find('iet');
        const range = document.createRange();
        range.setStart(start, startAt);
        range.setEnd(end, endAt + 2);
        if (method === 'deleteContents') {
          range.deleteContents();
        } else {
          // A highlighter's way of marking a range that crosses elements.
          const mark = document.createElement('mark');
          mark.append(range.extractContents());
          range.insertNode(mark);
        }
      }, how);
      expectSame(outcome);
      expect(outcome.on.text).toContain(how === 'deleteContents' ? 'Evening fat harbour' : 'Evening falls over the quiet harbour');
      expect(outcome.on.bold).toBeGreaterThan(20);
      expect(errors).toEqual([]);
    });
  }

  // YouTube's text component sees an element that holds only an emptied text node and its wrapper
  // as empty, so it appends its new text instead of replacing the placeholder: its comment count
  // read "Comments2,457,730 Comments", also after turning Skimbold off.
  test('a text component that skips empty text nodes (YouTube) shows its new text, not the old one as well', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const outcome = await differential(page, serviceWorker, '/engine/formatted-string.html', async () => {
      const shown = [];
      const frame = () => new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 20)); });
      const text = () => ['title', 'count'].map((id) => document.getElementById(id).innerText).join(' | ');
      window.updateText('title', [{ text: 'Tides of the northern shore' }]);
      window.updateText('count', [{ text: '2,457,730', span: true }, { text: ' Comments', span: true }]);
      await frame();
      shown.push(text());
      // A client-side navigation to another video updates the same elements again.
      window.updateText('title', [{ text: 'Gulls over the breakwater' }]);
      window.updateText('count', [{ text: '16', span: true }, { text: ' Comments', span: true }]);
      await frame();
      shown.push(text());
      return shown;
    }, undefined, '#title skb-w');
    expect(outcome.plain.result).toEqual([
      'Tides of the northern shore | 2,457,730 Comments', 'Gulls over the breakwater | 16 Comments',
    ]);
    expectSame(outcome);
    expect(outcome.on.bold).toBeGreaterThan(3);
    expect(errors).toEqual([]);
  });

  test('text the page clears, in one node or in a few at once, is let go so the element is empty', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    await page.evaluate(() => { document.getElementById('b').firstChild.data = ''; });
    await frames(page);
    expect(await page.evaluate(() => document.getElementById('b').innerText)).toBe('quiet harbour and the market closes.');
    await page.evaluate(() => {
      for (const id of ['a', 'c', 'row']) document.getElementById(id).firstChild.data = '';
    });
    await frames(page);
    expect(await page.evaluate(() => ['a', 'c', 'row'].map((id) => document.querySelector(`#${id}:empty`) !== null))).toEqual([true, true, true]);
    expect(await invariantProblems(page)).toEqual([]);
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => ['a', 'c', 'row'].map((id) => document.getElementById(id).innerHTML))).toEqual(['', '', '']);
    expect(errors).toEqual([]);
  });

  test('a highlighter can mark a spot in bolded text (insertNode) or wrap a range in one text node (surroundContents)', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const outcome = await differential(page, serviceWorker, '/engine/scripts.html', () => {
      const results = [];
      // A range across a bold start (all of "quiet") cannot be surrounded while Skimbold is on
      // (README: Known limitations); one inside the rest of a word can.
      for (const [phrase, how] of [['fishermen', 'insert'], ['ermen', 'surround'], ['circle above', 'insert']]) {
        getSelection().removeAllRanges();
        window.find(phrase);
        const range = getSelection().getRangeAt(0);
        try {
          if (how === 'surround') range.surroundContents(document.createElement('mark'));
          else range.insertNode(Object.assign(document.createElement('sup'), { textContent: '*' }));
          results.push('ok');
        } catch (error) {
          results.push(error.name);
        }
      }
      getSelection().removeAllRanges();
      return results;
    });
    expect(outcome.plain.result).toEqual(['ok', 'ok', 'ok']);
    expectSame(outcome);
    expect(errors).toEqual([]);
  });

  test('normalize() and in-place appends are known limits: nothing throws or loops, and off leaves clean markup', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    const outcome = await page.evaluate(async () => {
      // normalize() removes the emptied text node of #a, and its words go with it.
      document.getElementById('a').normalize();
      // A typewriter adds to a text node where it stands: the emptied node shows only what it adds.
      const typed = document.getElementById('c').firstChild;
      for (const letter of ' now') typed.appendData(letter);
      // Splitting an emptied text node fails, as it does for any empty one.
      let split = 'ok';
      try {
        document.getElementById('row').firstChild.splitText(3);
      } catch (error) {
        split = error.name;
      }
      await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
      // Then the page is left alone for a moment: the engine must not keep changing it.
      let changes = 0;
      const observer = new MutationObserver((records) => { changes += records.length; });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      observer.disconnect();
      return {
        a: document.getElementById('a').textContent, c: document.getElementById('c').textContent,
        row: document.getElementById('row').textContent, split, changes,
      };
    });
    expect(outcome).toEqual({ a: '', c: ' now', row: 'Recycled row label words', split: 'IndexSizeError', changes: 0 });
    expect(await invariantProblems(page)).toEqual([]);
    await setActive(serviceWorker, tabId, false);
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(await page.evaluate(() => ['c', 'row'].map((id) => document.getElementById(id).innerHTML)))
      .toEqual([' now', 'Recycled row label words']);
    expect(errors).toEqual([]);
  });

  test('text a page clears while it is detached stays cleared when it comes back (recycled rows)', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    expectSame(await differential(page, serviceWorker, '/engine/scripts.html', async () => {
      const row = document.getElementById('row');
      const text = row.firstChild;
      row.remove();
      await new Promise((resolve) => setTimeout(resolve, 50));
      text.data = '';
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.getElementById('rows').append(row);
      return row.textContent;
    }));
    expect(errors).toEqual([]);
  });
});

test.describe('copy and drag', () => {
  // Chromium serializes the selection the same way for a copy and for a drag. A synthetic event
  // carries the engine's data without touching the system clipboard.
  const transfer = (page, type) => page.evaluate((kind) => {
    getSelection().removeAllRanges();
    const range = document.createRange();
    range.setStart(document.getElementById('a').firstChild, 0);
    range.setEndAfter(document.getElementById('b'));
    getSelection().addRange(range);
    const data = new DataTransfer();
    const event = kind === 'copy'
      ? new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true, composed: true })
      : new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true, composed: true });
    document.getElementById('a').dispatchEvent(event);
    return { html: data.getData('text/html'), text: data.getData('text/plain'), prevented: event.defaultPrevented, selected: String(getSelection()) };
  }, type);

  for (const type of ['copy', 'dragstart']) {
    test(`${type} carries plain text and markup without the bolding`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      await page.goto('/engine/scripts.html');
      const plain = await page.evaluate(() => document.getElementById('b').innerHTML);
      await turnOn(page, serviceWorker, '/engine/scripts.html');
      const data = await transfer(page, type);
      expect(data.text).toBe(data.selected);
      expect(data.text).toContain('Morning light spreads across the harbour');
      expect(data.html).not.toMatch(/skb-|font-weight/);
      // Structure, emphasis and links survive, with the link made absolute for pasting elsewhere.
      expect(data.html).toContain('Morning light spreads across the harbour while fishermen prepare their nets.');
      expect(data.html).toContain(plain.replace('href="/elsewhere.html"', `href="${new URL('/elsewhere.html', page.url())}"`));
      expect(data.prevented).toBe(type === 'copy');
      expect(errors).toEqual([]);
    });
  }

  // A synthetic DragEvent is not enough: what a real drag carries depends on where it is pressed.
  // Chromium can start a selection drag on the element under the pointer (a paragraph) rather than
  // on a text node, and one pressed on a link inside the selection is still a selection drag.
  // `select` is the element whose contents are selected first (none: no selection); `press` gives
  // the point the mouse is pressed on.
  async function realDrag(page, select, press) {
    await page.evaluate((selector) => {
      window.dragged = null;
      // Registered after Skimbold's listener, so it sees what the drag will carry.
      window.addEventListener('dragstart', (event) => {
        const data = event.dataTransfer;
        window.dragged = { html: data.getData('text/html'), text: data.getData('text/plain'), uri: data.getData('text/uri-list'), target: event.target.nodeName };
        event.preventDefault();
      }, { once: true });
      getSelection().removeAllRanges();
      if (selector === null) return;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      getSelection().addRange(range);
    }, select);
    const at = await page.evaluate(press);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y + 100, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.dragged !== null)).toBe(true);
    return page.evaluate(() => window.dragged);
  }
  // Just past the end of the paragraph's last line, wherever the fonts on this system wrap it, so
  // the drag starts on the paragraph and not on its text.
  const pastTheEnd = () => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('a'));
    const last = [...range.getClientRects()].at(-1);
    return { x: last.right + 10, y: last.top + last.height / 2 };
  };
  const onTheLink = () => {
    const box = document.getElementById('link').getBoundingClientRect();
    return { x: box.left + 15, y: box.top + box.height / 2 };
  };

  test('a real selection drag with the mouse carries the words without our markup', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await turnOn(page, serviceWorker, '/engine/drag.html', { settled: '#a skb-w' });
    const dragged = await realDrag(page, '#a', pastTheEnd);
    expect(dragged.target).toBe('P');
    expect(dragged.html).not.toMatch(/skb-|font-weight/);
    expect(dragged.html).toContain('Morning light spreads across the harbour while fishermen prepare their nets and gulls circle.');
    expect(dragged.text).toBe('Morning light spreads across the harbour while fishermen prepare their nets and gulls circle.');
    expect(errors).toEqual([]);
  });

  test('a real selection drag pressed on a link inside the selection carries the words without our markup', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await turnOn(page, serviceWorker, '/engine/drag.html', { settled: '#link skb-w' });
    const dragged = await realDrag(page, '#b', onTheLink);
    expect(dragged.uri).toBe('');
    expect(dragged.html).not.toMatch(/skb-|font-weight/);
    expect(dragged.html).toContain(`Evening falls over the <a id="link" href="${new URL('/elsewhere.html', page.url())}">quiet harbour and the market</a> as the stalls close.`);
    expect(errors).toEqual([]);
  });

  test('a drag of a link, even one that starts on the selection, and a copy with nothing bolded in it, are left to the browser', async ({ page, serviceWorker }) => {
    await turnOn(page, serviceWorker, '/engine/drag.html', { settled: '#link skb-w' });
    // The browser's own link drag carries the address.
    const link = await realDrag(page, null, onTheLink);
    expect(link.uri).toBe(new URL('/elsewhere.html', page.url()).href);
    expect(link.text).toBe(link.uri);
    // A selection that ends inside the link, and the link pressed past it: a link drag that
    // starts on the selection, which Skimbold must not turn into a drag of the selection.
    const partly = await realDrag(page, null, () => {
      const link = document.getElementById('link');
      const texts = [];
      for (const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT); walker.nextNode();) {
        if (walker.currentNode.data !== '') texts.push(walker.currentNode);
      }
      const range = document.createRange();
      range.setStart(document.getElementById('b'), 0);
      range.setEnd(texts[0], 1);
      getSelection().addRange(range);
      const end = document.createRange();
      end.selectNodeContents(texts.at(-1));
      const box = [...end.getClientRects()].at(-1);
      return { x: box.right - 4, y: box.top + box.height / 2 };
    });
    expect(partly.uri).toBe(link.uri);
    expect(partly.html).not.toContain('Evening falls');
    const result = await page.evaluate(() => {
      const code = document.body.appendChild(document.createElement('pre'));
      code.textContent = 'code stays plain';
      getSelection().selectAllChildren(code);
      const data = new DataTransfer();
      const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
      code.dispatchEvent(event);
      return { prevented: event.defaultPrevented, types: [...data.types] };
    });
    expect(result).toEqual({ prevented: false, types: [] });
  });
});

test.describe('editing', () => {
  test('a bolded paragraph moved into an editor is handed back, so typing there is kept', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    await page.evaluate(() => {
      const editor = document.body.appendChild(document.createElement('div'));
      editor.id = 'editor';
      editor.contentEditable = 'true';
    });
    await frames(page);
    // An editor that is already there takes the bolded paragraph in (a notes app, a CMS).
    await page.evaluate(() => document.getElementById('editor').append(document.getElementById('c')));
    await frames(page);
    expect(await count(page, '#editor skb-w')).toBe(0);
    await page.click('#c');
    // Typed in the middle of the line, where a wrapper would have held the text.
    await page.evaluate(() => {
      getSelection().removeAllRanges();
      window.find('circle');
      getSelection().collapseToEnd();
    });
    await page.keyboard.type(' TYPED');
    await frames(page);
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('c').textContent)).toBe('Gulls circle TYPED above the stalls');
    expect(errors).toEqual([]);
  });

  test('switching the page to design mode hands the text back before the first keystroke', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    await page.evaluate(() => { document.designMode = 'on'; });
    await page.click('#c');
    await page.keyboard.press('End');
    await page.keyboard.type('XYZ');
    await frames(page);
    expect(await count(page, 'skb-w')).toBe(0);
    expect(await page.evaluate(() => document.getElementById('c').textContent)).toBe('Gulls circle above the stallsXYZ');
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('c').textContent)).toBe('Gulls circle above the stallsXYZ');
    expect(errors).toEqual([]);
  });
});

test.describe('markup and selection', () => {
  test('markup the page saved while on and puts back after off shows as plain text', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/scripts.html');
    const original = await page.evaluate(() => document.getElementById('b').innerHTML);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    // A tab panel cached as markup while on; the page also hides undefined elements.
    await page.evaluate(() => {
      window.cached = document.getElementById('b').innerHTML;
      document.head.appendChild(document.createElement('style')).textContent = ':not(:defined){visibility:hidden}';
    });
    await setActive(serviceWorker, tabId, false);
    await page.evaluate(() => { document.getElementById('b').innerHTML = window.cached; });
    await frames(page);
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(await page.evaluate(() => document.getElementById('b').innerHTML)).toBe(original);
    expect(await page.evaluate(() => document.getElementById('b').innerText)).toBe('Evening falls over the quiet harbour and the market closes.');
    expect(errors).toEqual([]);
  });

  // The second re-parse lands while the first one's copies are still settling, which marks the
  // container as re-rendering; whatever the timing, turning off must leave none of our markup.
  for (const waitMs of [0, 100, 150]) {
    test(`markup re-parsed twice while on leaves none of ours behind when turned off ${waitMs} ms later`, async ({ page, serviceWorker }) => {
      const errors = collectConsoleErrors(page);
      await page.goto('/engine/scripts.html');
      const html = await bodyHtml(page);
      const text = await bodyText(page);
      const tabId = await turnOn(page, serviceWorker, null);
      await page.evaluate(async () => {
        document.head.appendChild(document.createElement('style')).textContent = ':not(:defined){visibility:hidden}';
        const main = document.getElementById('page');
        main.innerHTML = main.innerHTML;
        await new Promise((resolve) => { requestAnimationFrame(resolve); });
        main.innerHTML = main.innerHTML;
      });
      await page.waitForTimeout(waitMs);
      expect(await invariantProblems(page)).toEqual([]);
      await setActive(serviceWorker, tabId, false);
      expect(await count(page, 'skb-w, skb-b')).toBe(0);
      expect(await bodyText(page)).toBe(text);
      expect(await bodyHtml(page)).toBe(html);
      expect(errors).toEqual([]);
    });
  }

  test('a selection made before turning on stays on the same words, on and after off', async ({ page, serviceWorker }) => {
    await page.goto('/engine/scripts.html');
    await page.evaluate(() => window.find('fishermen prepare'));
    const tabId = await tabIdFor(serviceWorker, page);
    expect(await page.evaluate(() => String(getSelection()))).toBe('fishermen prepare');
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => count(page, '#a skb-w')).toBe(1);
    expect(await page.evaluate(() => String(getSelection()))).toBe('fishermen prepare');
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => String(getSelection()))).toBe('fishermen prepare');
  });
});

test.describe('pages that keep changing', () => {
  // Skimbold tries again once the widget has been quiet for a second, then after 2, 4, 8 and 16
  // seconds, so the fight dies down instead of looping.
  test('a widget that re-renders on every child change is tried less and less often instead of looping', async ({ page, serviceWorker }) => {
    test.setTimeout(40_000);
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/scripts.html');
    await page.evaluate(() => {
      const widget = document.getElementById('c');
      const model = widget.textContent;
      window.resets = [];
      new MutationObserver(() => {
        if (widget.childNodes.length !== 1 || widget.firstChild.nodeType !== Node.TEXT_NODE) {
          window.resets.push(performance.now());
          widget.textContent = model;
        }
      }).observe(widget, { childList: true, subtree: true });
    });
    const tabId = await turnOn(page, serviceWorker, null, { settled: '#a skb-w' });
    await page.waitForTimeout(12_000);
    const resets = await page.evaluate(() => window.resets);
    expect(resets.length).toBeLessThan(20);
    // Each try after the first fight waits longer than the one before (1, 2, 4 and 8 s).
    const gaps = resets.slice(1).map((at, i) => at - resets[i]).filter((gap) => gap > 500);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1] * 1.5);
    expect(await page.evaluate(() => document.getElementById('c').innerText)).toBe('Gulls circle above the stalls');
    await setActive(serviceWorker, tabId, false);
    expect(errors).toEqual([]);
  });

  // React sets the text of an element whose only child is text in place, and replaces its children
  // whole once a wrapper sits beside that text, so every update of a stream throws away the last
  // wrapper. Skimbold stops wrapping there until the stream has been quiet for a moment.
  test('text a React-style stream keeps replacing is bolded once the stream ends', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    const { text, wrapped } = await page.evaluate(() => new Promise((resolve) => {
      const answer = document.body.appendChild(document.createElement('div'));
      answer.id = 'answer';
      // How often Skimbold wraps the text while it streams, only for the page to throw it away.
      let wraps = 0;
      const watcher = new MutationObserver((records) => {
        for (const record of records) wraps += [...record.addedNodes].filter((node) => node.localName === 'skb-w').length;
      });
      watcher.observe(answer, { childList: true });
      const words = 'Tides are the rise and fall of sea levels caused by the pull of the moon and the sun'.split(' ');
      const started = performance.now();
      let streamed = '';
      let n = 0;
      const timer = setInterval(() => {
        streamed += (n === 0 ? '' : ' ') + words[n++ % words.length];
        const only = answer.firstChild;
        if (only !== null && only === answer.lastChild && only.nodeType === Node.TEXT_NODE) only.nodeValue = streamed;
        else answer.textContent = streamed;
        if (performance.now() - started > 2500) {
          clearInterval(timer);
          watcher.disconnect();
          resolve({ text: streamed, wrapped: wraps });
        }
      }, 30);
    }));
    // A few tries at first, then none until the stream is over.
    expect(wrapped).toBeLessThan(12);
    await expect.poll(() => count(page, '#answer skb-b'), { timeout: 5_000 }).toBe(text.split(' ').length);
    expect(await page.evaluate(() => document.getElementById('answer').innerText)).toBe(text);
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('answer').textContent)).toBe(text);
    expect(errors).toEqual([]);
  });

  test('new content in a container that never stops re-rendering is bolded at the latest half a second after it arrives', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    await page.evaluate(() => {
      const feed = document.body.appendChild(document.createElement('section'));
      feed.id = 'feed';
      feed.appendChild(document.createElement('p')).textContent = 'Live score 0';
      let tick = 0;
      window.posted = [];
      window.feedTimer = setInterval(() => {
        tick++;
        // A live blog renders its score line afresh every 150 ms, so it never goes quiet...
        const score = document.createElement('p');
        score.textContent = `Live score ${tick}`;
        feed.replaceChild(score, feed.firstChild);
        // ...and adds a post that stays, in the same update, every 600 ms.
        if (tick % 4 === 0) {
          const post = document.createElement('p');
          post.className = 'post';
          post.textContent = `Post number ${tick / 4} about the regatta in the harbour`;
          feed.appendChild(post);
          window.posted.push(performance.now());
        }
      }, 150);
    });
    await page.waitForTimeout(4000);
    const posts = await page.evaluate(() => [...document.querySelectorAll('#feed .post')]
      .map((post, i) => ({ bold: post.querySelector('skb-b') !== null, age: Math.round(performance.now() - window.posted[i]) })));
    await page.evaluate(() => clearInterval(window.feedTimer));
    expect(posts.filter((post) => post.age > 600 && !post.bold)).toEqual([]);
    expect(posts.filter((post) => post.bold).length).toBeGreaterThan(4);
    await setActive(serviceWorker, tabId, false);
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a busy chat that keeps its last 40 messages gets each new one bolded within half a second', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/chat.html');
    await page.evaluate(() => window.chatFixture.start(100));
    // Full, so every new message comes with the removal of the oldest.
    await page.waitForFunction(() => document.querySelectorAll('#chat .message').length === 40);
    const tabId = await turnOn(page, serviceWorker, null, { settled: '#topic skb-w' });
    for (let sample = 0; sample < 4; sample++) {
      await page.waitForTimeout(700);
      // The newest messages arrived up to 500 ms ago; the ones before them are all bolded.
      const plain = await page.evaluate(() => [...document.querySelectorAll('#chat .message')].slice(0, -5)
        .filter((message) => message.querySelector('skb-b') === null).length);
      expect(plain, `sample ${sample}`).toBe(0);
    }
    await page.evaluate(() => window.chatFixture.stop());
    await expect.poll(() => count(page, '#chat .message:not(:has(skb-b))')).toBe(0);
    expect(await invariantProblems(page, '#chat')).toEqual([]);
    await setActive(serviceWorker, tabId, false);
    expect(await count(page, 'skb-w, skb-b')).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe('late roots and frames', () => {
  test('shadow roots attached after turning on are bolded (a custom element defined later, a root the page fills and slots into)', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/scripts.html');
    await page.evaluate(() => {
      document.body.appendChild(document.createElement('late-card')).id = 'late';
      document.body.appendChild(document.createElement('div')).id = 'host';
    });
    const tabId = await turnOn(page, serviceWorker, null);
    // Added while on, the way a lazily loaded component library's elements arrive: the element
    // itself is the added node.
    await page.evaluate(() => { document.body.appendChild(document.createElement('later-card')).id = 'later'; });
    await frames(page);
    await page.evaluate(() => {
      // Defined once their code has loaded: each attaches its root as it upgrades, which changes
      // nothing in the light DOM; Skimbold looks at such elements again while the page is on.
      for (const name of ['late-card', 'later-card']) {
        customElements.define(name, class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = '<p>Words inside a late custom element</p>';
          }
        });
      }
      // A root attached to an ordinary element, found when the page next changes the element.
      const host = document.getElementById('host');
      host.attachShadow({ mode: 'open' }).innerHTML = '<p>Words in a root attached later <slot></slot></p>';
      host.append('and slotted words');
    });
    const bold = (id) => page.evaluate((host) => document.getElementById(host).shadowRoot.querySelectorAll('skb-b').length, id);
    await expect.poll(() => bold('late'), { timeout: 10_000 }).toBeGreaterThan(2);
    await expect.poll(() => bold('later'), { timeout: 10_000 }).toBeGreaterThan(2);
    await expect.poll(() => bold('host')).toBeGreaterThan(2);
    await expect.poll(() => count(page, '#host skb-b')).toBeGreaterThan(1);
    await setActive(serviceWorker, tabId, false);
    expect(await bold('late')).toBe(0);
    expect(await bold('later')).toBe(0);
    expect(await page.evaluate(() => document.getElementById('host').shadowRoot.innerHTML)).toBe('<p>Words in a root attached later <slot></slot></p>');
    expect(errors).toEqual([]);
  });

  test('light-DOM text shown through a slot inside a code block stays plain', async ({ page, serviceWorker }) => {
    await page.goto('/engine/scripts.html');
    await page.evaluate(() => {
      customElements.define('code-view', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<pre><code><slot></slot></code></pre>';
        }
      });
      const view = document.body.appendChild(document.createElement('code-view'));
      view.id = 'code';
      view.append('const total = items.reduce((sum, item) => sum + item.price, 0);');
      view.appendChild(document.createElement('span')).textContent = 'inside a slotted span too';
    });
    await turnOn(page, serviceWorker, null);
    await frames(page, 100);
    expect(await count(page, '#code skb-w')).toBe(0);
  });

  test('bolded text that a shadow root attached later shows inside a code block is handed back', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/scripts.html');
    const html = await page.evaluate(() => {
      const view = document.body.appendChild(document.createElement('code-view'));
      view.id = 'code';
      view.append('const total = items.reduce((sum, item) => sum + item.price, 0);');
      view.appendChild(document.createElement('span')).textContent = 'inside a slotted span too';
      const box = document.body.appendChild(document.createElement('div'));
      box.id = 'box';
      box.textContent = 'Words in an ordinary element';
      return [view.innerHTML, box.innerHTML];
    });
    const tabId = await turnOn(page, serviceWorker, null);
    // Until the page defines the component, its text is ordinary text.
    expect(await count(page, '#code skb-w, #box skb-w')).toBe(3);
    await page.evaluate(() => {
      // Defined once its code has loaded, it attaches its root as it upgrades (found by Skimbold's
      // look at custom elements every 2 s)...
      customElements.define('code-view', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<pre><code><slot></slot></code></pre>';
        }
      });
      // ...and a root attached to an ordinary element is found when the page next changes it.
      const box = document.getElementById('box');
      box.attachShadow({ mode: 'open' }).innerHTML = '<pre><slot></slot></pre>';
      box.append(' and more');
    });
    await expect.poll(() => count(page, '#code skb-w, #box skb-w'), { timeout: 10_000 }).toBe(0);
    const shown = () => page.evaluate(() => ['code', 'box'].map((id) => document.getElementById(id).innerHTML));
    expect(await shown()).toEqual([html[0], `${html[1]} and more`]);
    await setActive(serviceWorker, tabId, false);
    expect(await shown()).toEqual([html[0], `${html[1]} and more`]);
    expect(errors).toEqual([]);
  });

  test('a same-origin frame added after turning on is bolded too', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await turnOn(page, serviceWorker, '/engine/scripts.html');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = '/engine/frame-child.html';
      document.body.append(frame);
    });
    const child = () => page.frames().find((frame) => frame.url().endsWith('/engine/frame-child.html'));
    await expect.poll(async () => {
      const frame = child();
      return frame ? frame.evaluate(() => document.querySelectorAll('skb-b').length).catch(() => 0) : 0;
    }, { timeout: 10_000 }).toBeGreaterThan(3);
    await setActive(serviceWorker, tabId, false);
    await expect.poll(() => child().evaluate(() => document.querySelectorAll('skb-w').length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('an empty frame the page fills after turning on is bolded too', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/engine/scripts.html');
    // A widget's frame with no src (comments, a preview): the page writes into it by script.
    await page.evaluate(() => { document.body.appendChild(document.createElement('iframe')).id = 'blank'; });
    const tabId = await tabIdFor(serviceWorker, page);
    await inject(serviceWorker, tabId, { allFrames: true });
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => count(page, '#c skb-w')).toBe(1);
    await page.evaluate(() => { document.getElementById('blank').contentDocument.body.innerHTML = '<p>Message body rendered later into the frame</p>'; });
    const bold = () => page.evaluate(() => document.getElementById('blank').contentDocument.querySelectorAll('skb-b').length);
    await expect.poll(bold).toBeGreaterThan(3);
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('blank').contentDocument.body.innerHTML))
      .toBe('<p>Message body rendered later into the frame</p>');
    expect(errors).toEqual([]);
  });
});

test('Skimbold changes nothing in the page\'s own JavaScript world', async ({ page, serviceWorker }) => {
  await page.goto('/engine/scripts.html');
  const globals = await page.evaluate(() => Object.keys(window).length);
  await turnOn(page, serviceWorker, null);
  expect(await page.evaluate(() => [
    Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data').get, Node.prototype.normalize, Text.prototype.splitText,
    Range.prototype.surroundContents, Element.prototype.attachShadow,
  ].map((fn) => Function.prototype.toString.call(fn).includes('[native code]')))).toEqual([true, true, true, true, true]);
  expect(await page.evaluate(() => Object.keys(window).length)).toBe(globals);
  // A page script reads an emptied text node as it really is.
  expect(await page.evaluate(() => document.getElementById('a').firstChild.data)).toBe('');
});
