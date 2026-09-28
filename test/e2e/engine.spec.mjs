// The DOM engine (content/engine.js) on static and dynamic pages: exact restore, skip zones,
// reconciliation of page edits, shadow roots, frames, styles under hostile CSS and strict CSP,
// live settings and re-injection. The engine is injected and driven from the service worker,
// independently of background.js.

import { test, expect, collectConsoleErrors, swEval, tabIdFor } from './fixtures.mjs';
import {
  openFixture, inject, send, setActive, isolated, writeSettings, frames, invariantProblems,
} from '../fixtures/engine/helpers.mjs';

const bodyHtml = (page) => page.evaluate(() => document.body.innerHTML);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const countIn = (page, selector, what = 'skb-b') => page.evaluate(
  ([sel, tag]) => document.querySelector(sel).querySelectorAll(tag).length, [selector, what],
);
const textOf = (page, selector) => page.evaluate((sel) => document.querySelector(sel).innerText, selector);
const boldParts = (page, selector) => page.evaluate(
  (sel) => [...document.querySelector(sel).querySelectorAll('skb-b')].map((bold) => bold.textContent), selector,
);

async function activate(page, serviceWorker, urlPath) {
  const tabId = await openFixture(page, serviceWorker, urlPath);
  await inject(serviceWorker, tabId);
  expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
  await expect.poll(() => countIn(page, 'body')).toBeGreaterThan(0);
  return tabId;
}

test.describe('exact restore', () => {
  test('bolds a rich article, keeps its visible text, and restores its markup byte for byte', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/article.html');
    const html = await bodyHtml(page);
    const text = await bodyText(page);

    await inject(serviceWorker, tabId);
    expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: true });
    await expect.poll(() => countIn(page, 'body')).toBeGreaterThan(100);
    await frames(page);
    expect(await bodyText(page)).toBe(text);
    expect(await invariantProblems(page)).toEqual([]);
    // Scripts the engine must leave alone stay free of wrappers.
    for (const lang of ['ja', 'ar', 'th', 'hi']) {
      expect(await countIn(page, `p[lang="${lang}"]`, 'skb-w'), lang).toBe(0);
    }
    expect(await countIn(page, 'p[lang="he"]')).toBeGreaterThan(5);
    expect(await boldParts(page, '.lede')).toEqual(expect.arrayContaining(['Tw', 'a', 'd', 'th', 'po']));

    expect(await setActive(serviceWorker, tabId, false)).toEqual({ active: false });
    expect(await bodyHtml(page)).toBe(html);
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('five toggles in a row still restore the markup exactly', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/article.html');
    const html = await bodyHtml(page);
    const text = await bodyText(page);
    await inject(serviceWorker, tabId);

    for (let round = 0; round < 5; round++) {
      expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: true });
      await expect.poll(() => countIn(page, 'body')).toBeGreaterThan(100);
      expect(await bodyText(page)).toBe(text);
      expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: false });
      expect(await bodyHtml(page)).toBe(html);
    }
    expect(errors).toEqual([]);
  });

  test('answers skb:getState and reports its state from the top frame only', async ({ page, serviceWorker }) => {
    const tabId = await openFixture(page, serviceWorker, '/engine/frame-parent.html');
    await page.frameLocator('#child').locator('#child-text').waitFor();
    await swEval(serviceWorker, () => {
      const api = globalThis.browser ?? globalThis.chrome;
      globalThis.engineStateReports = [];
      globalThis.engineStateListener = (message, sender) => {
        if (message && message.type === 'skb:state') globalThis.engineStateReports.push({ active: message.active, frameId: sender.frameId });
      };
      api.runtime.onMessage.addListener(globalThis.engineStateListener);
    });
    try {
      await inject(serviceWorker, tabId, { allFrames: true });
      expect(await send(serviceWorker, tabId, { type: 'skb:getState' }, 0)).toEqual({ active: false, pdf: false });
      await setActive(serviceWorker, tabId, true);
      expect(await send(serviceWorker, tabId, { type: 'skb:getState' }, 0)).toEqual({ active: true, pdf: false });
      await setActive(serviceWorker, tabId, false);
      await expect.poll(() => swEval(serviceWorker, () => globalThis.engineStateReports)).toEqual([
        { active: true, frameId: 0 },
        { active: false, frameId: 0 },
      ]);
    } finally {
      await swEval(serviceWorker, () => {
        (globalThis.browser ?? globalThis.chrome).runtime.onMessage.removeListener(globalThis.engineStateListener);
      });
    }
  });
});

test.describe('skip zones', () => {
  test('leaves form fields, editors, code, math, TeX, video captions, buttons and opted-out regions alone', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/skip.html');
    const zones = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.zone')].map((zone) => [zone.id, zone.innerHTML])));
    const before = await zones();

    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => countIn(page, '#plain')).toBeGreaterThan(0);
    expect(await countIn(page, '#not-editable')).toBeGreaterThan(0);
    await frames(page);
    expect(await zones()).toEqual(before);
    expect(await page.inputValue('#field')).toBe('Input value words stay');
    expect(await page.inputValue('#area')).toBe('Textarea words stay untouched');

    // Typing while the engine is on behaves exactly as without it.
    await page.click('#editor p');
    await page.keyboard.press('End');
    await page.keyboard.type(' and typed words here');
    await page.click('#field');
    await page.keyboard.press('End');
    await page.keyboard.type(' plus more');
    await page.click('#area');
    await page.keyboard.press('End');
    await page.keyboard.type(' with extra words');
    await frames(page, 100);
    expect(await page.evaluate(() => document.getElementById('editor').innerHTML)).toBe('<p>Editable words stay plain and typed words here</p>');
    expect(await page.inputValue('#field')).toBe('Input value words stay plus more');
    expect(await page.inputValue('#area')).toBe('Textarea words stay untouched with extra words');
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('hands a region back when it becomes editable, and bolds it again afterwards', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/skip.html');
    const original = await page.evaluate(() => document.getElementById('plain').innerHTML);
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => countIn(page, '#plain')).toBeGreaterThan(0);

    await page.evaluate(() => document.getElementById('plain').setAttribute('contenteditable', 'true'));
    await frames(page);
    expect(await page.evaluate(() => document.getElementById('plain').innerHTML)).toBe(original);
    await page.click('#plain');
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited');
    await frames(page);
    expect(await page.evaluate(() => document.getElementById('plain').innerHTML)).toBe(`${original} Edited`);

    await page.evaluate(() => document.getElementById('plain').removeAttribute('contenteditable'));
    await expect.poll(() => countIn(page, '#plain')).toBeGreaterThan(0);
    expect(await textOf(page, '#plain')).toBe('Plain paragraph words that the engine should bold. Edited');
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('plain').textContent)).toBe('Plain paragraph words that the engine should bold. Edited');
    expect(await countIn(page, 'body', 'skb-w')).toBe(0);
    expect(errors).toEqual([]);
  });

  // Bolded, the copy would be wider than the field's own text, and the caret and the selection
  // would drift away from the text they belong to.
  test('leaves alone an aria-hidden copy of a field\'s text drawn under a transparent field, while typing too', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/mirror.html');
    const html = await bodyHtml(page);
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    // The hint, last on the page, is an aria-hidden element beside a field whose text shows.
    await expect.poll(() => countIn(page, '#hint')).toBeGreaterThan(0);
    expect(await countIn(page, '#intro')).toBeGreaterThan(0);
    expect(await countIn(page, '#query-copy', 'skb-w')).toBe(0);
    expect(await countIn(page, '#lines', 'skb-w')).toBe(0);
    await setActive(serviceWorker, tabId, false);
    expect(await bodyHtml(page)).toBe(html);

    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => countIn(page, '#hint')).toBeGreaterThan(0);
    await page.click('#query');
    await page.keyboard.press('End');
    await page.keyboard.type(' sort:updated');
    await frames(page, 100);
    expect(await page.evaluate(() => document.getElementById('query-copy').innerHTML))
      .toBe('<span class="key">is:</span>open <span class="key">label:</span>bug <span class="key">sort:</span>updated');
    await setActive(serviceWorker, tabId, false);
    expect(await countIn(page, 'body', 'skb-w, skb-b')).toBe(0);
    expect(await page.inputValue('#query')).toBe('is:open label:bug sort:updated');
    expect(errors).toEqual([]);
  });

  test('does nothing in a document that is in design mode', async ({ page, serviceWorker }) => {
    const tabId = await openFixture(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => { document.designMode = 'on'; });
    await inject(serviceWorker, tabId);
    expect(await setActive(serviceWorker, tabId, true)).toEqual({ active: false });
    expect(await countIn(page, 'body', 'skb-w')).toBe(0);
  });
});

test.describe('page edits while active', () => {
  test('bolds nodes the page adds later', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => {
      const feed = document.getElementById('feed');
      const p = document.createElement('p');
      p.id = 'added';
      p.textContent = 'A paragraph added after the engine started';
      const list = document.createElement('ul');
      list.id = 'added-list';
      for (const item of ['Nested list items arrive too', 'Several of them at once']) list.appendChild(document.createElement('li')).textContent = item;
      feed.append(p, list);
      document.getElementById('anchor').appendChild(document.createTextNode(' and a text node appended'));
    });
    await expect.poll(() => countIn(page, '#added')).toBeGreaterThan(0);
    await expect.poll(() => countIn(page, '#added-list')).toBeGreaterThan(3);
    await expect.poll(() => countIn(page, '#anchor', 'skb-w')).toBe(2);
    expect(await textOf(page, '#added')).toBe('A paragraph added after the engine started');
    expect(await textOf(page, '#anchor')).toBe('Evening falls over quiet water and a text node appended');
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('re-renders when the page rewrites a source text node, with no duplicate text', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    // The source text node stays in place, emptied, with the wrapper right after it.
    await page.evaluate(() => { window.source = document.getElementById('first').firstChild; });
    expect(await page.evaluate(() => window.source.data)).toBe('');

    // The reconciliation runs in the observer's microtask, so one await later the text is right.
    const seen = await page.evaluate(async () => {
      window.source.data = 'Brand new words replace the old ones';
      await null;
      return document.getElementById('first').textContent;
    });
    expect(seen).toBe('Brand new words replace the old ones');
    expect(await textOf(page, '#first')).toBe('Brand new words replace the old ones');
    expect(await countIn(page, '#first', 'skb-w')).toBe(1);
    expect(await boldParts(page, '#first')).toEqual(['Br', 'n', 'wo', 'rep', 't', 'o', 'on']);

    // Cleared by the page: the engine lets go, so the paragraph is really empty (:empty matches).
    await page.evaluate(() => { window.source.nodeValue = ''; });
    await frames(page);
    expect(await textOf(page, '#first')).toBe('');
    expect(await page.evaluate(() => [window.source.nextSibling, document.querySelector('#first:empty') !== null])).toEqual([null, true]);

    await page.evaluate(() => { window.source.textContent = 'Words come back after being cleared'; });
    await frames(page);
    expect(await textOf(page, '#first')).toBe('Words come back after being cleared');
    expect(await countIn(page, '#first', 'skb-w')).toBe(1);
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('follows removals of the text node and of the wrapper', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => {
      window.second = document.getElementById('second').firstChild;
      window.third = document.getElementById('third').firstChild;
    });

    await page.evaluate(() => window.second.remove());
    await frames(page);
    expect(await page.evaluate(() => document.getElementById('second').innerHTML)).toBe('');

    await page.evaluate(() => window.third.nextSibling.remove());
    await frames(page);
    expect(await page.evaluate(() => document.getElementById('third').innerHTML)).toBe('Gulls circle above the market stalls');
    expect(await page.evaluate(() => window.third.data)).toBe('Gulls circle above the market stalls');
    expect(errors).toEqual([]);
  });

  test('keeps visual order when the page inserts right after a text node (Vue-style anchors)', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => {
      const first = document.getElementById('first');
      const source = first.firstChild;
      const strong = document.createElement('strong');
      strong.textContent = ' and more';
      first.insertBefore(strong, source.nextSibling);
      first.insertBefore(document.createTextNode(' at dawn'), strong.nextSibling);
    });
    await frames(page);
    expect(await textOf(page, '#first')).toBe('Morning light spreads across the harbour and more at dawn');
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('moving paragraphs and text nodes keeps the text with them', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => {
      document.getElementById('right').appendChild(document.getElementById('third'));
      document.getElementById('anchor').appendChild(document.getElementById('second').firstChild);
      // Reorder children of a paragraph the way a keyed list would.
      const mixed = document.getElementById('mixed');
      mixed.appendChild(mixed.firstChild);
    });
    await frames(page);
    expect(await textOf(page, '#right')).toBe('Evening falls over quiet waterFishing boats return with their catch\n\nGulls circle above the market stalls');
    expect(await textOf(page, '#second')).toBe('');
    expect(await textOf(page, '#mixed')).toBe('slowly near the pierTides turn');
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('adopts copies of bolded markup, so disabling restores them to plain text too', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await activate(page, serviceWorker, '/engine/dynamic.html');
    const original = await page.evaluate(() => {
      const first = document.getElementById('first');
      const copy = first.cloneNode(true);
      copy.id = 'copy';
      document.getElementById('feed').appendChild(copy);
      const html = document.createElement('p');
      html.id = 'from-html';
      html.innerHTML = first.innerHTML;
      document.getElementById('feed').appendChild(html);
      return 'Morning light spreads across the harbour';
    });
    await frames(page);
    expect(await textOf(page, '#copy')).toBe(original);
    expect(await textOf(page, '#from-html')).toBe(original);
    await setActive(serviceWorker, tabId, false);
    expect(await page.evaluate(() => document.getElementById('copy').innerHTML)).toBe(original);
    expect(await page.evaluate(() => document.getElementById('from-html').innerHTML)).toBe(original);
    expect(await countIn(page, 'body', 'skb-w')).toBe(0);
    expect(errors).toEqual([]);
  });

  test('disabling after many page edits leaves no wrappers and the same visible text', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await activate(page, serviceWorker, '/engine/dynamic.html');
    await page.evaluate(() => {
      const first = document.getElementById('first').firstChild;
      first.data = 'Changed words';
      document.getElementById('second').firstChild.remove();
      document.getElementById('right').prepend(document.getElementById('third'));
      document.getElementById('feed').textContent = 'Feed text set in one go';
    });
    await frames(page);
    const visible = await bodyText(page);
    await setActive(serviceWorker, tabId, false);
    expect(await bodyText(page)).toBe(visible);
    expect(await countIn(page, 'body', 'skb-w')).toBe(0);
    expect(await page.evaluate(() => document.getElementById('first').innerHTML)).toBe('Changed words');
    expect(errors).toEqual([]);
  });
});

test.describe('styles', () => {
  test('bold stays visible, inline and heavy under hostile page CSS', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/hostile.html');
    const text = await bodyText(page);
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => countIn(page, 'body')).toBeGreaterThan(10);

    const styles = await page.evaluate(() => ['#in-block', '#plain', '#spanned', '#faded'].map((selector) => {
      const pick = (el) => {
        const style = getComputedStyle(el);
        return { weight: style.fontWeight, visibility: style.visibility, display: style.display, opacity: style.opacity, float: style.float };
      };
      const root = document.querySelector(selector);
      return { selector, wrapper: pick(root.querySelector('skb-w')), bold: pick(root.querySelector('skb-b')) };
    }));
    for (const { selector, wrapper, bold } of styles) {
      expect(bold, selector).toEqual({ weight: '700', visibility: 'visible', display: 'inline', opacity: '1', float: 'none' });
      expect({ ...wrapper, weight: undefined }, selector).toEqual({ weight: undefined, visibility: 'visible', display: 'inline', opacity: '1', float: 'none' });
    }
    // innerText leaves out hidden text, so nothing went invisible.
    expect(await bodyText(page)).toBe(text);
    expect(errors).toEqual([]);
  });

  test('styles apply under strict CSP and Trusted Types, with no violations', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto('/engine/csp-strict.html');
    expect(response.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
    const tabId = await tabIdFor(serviceWorker, page);
    const html = await bodyHtml(page);
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => countIn(page, '#words')).toBeGreaterThan(5);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#words skb-b')).fontWeight)).toBe('700');
    expect(await page.evaluate(() => document.getElementById('skb-style'))).toBeNull();
    await frames(page, 100);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);

    await setActive(serviceWorker, tabId, false);
    expect(await bodyHtml(page)).toBe(html);
    await frames(page, 100);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
    expect(errors).toEqual([]);
    // The policy really is enforced: a string sent to innerHTML is refused.
    expect(await page.evaluate(() => {
      try {
        document.body.insertAdjacentHTML('beforeend', '<i>x</i>');
        return 'allowed';
      } catch {
        return 'refused';
      }
    })).toBe('refused');
  });

  test('settings changes re-render the page live, without toggling', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await activate(page, serviceWorker, '/engine/dynamic.html');
    expect(await boldParts(page, '#first')).toEqual(['Mor', 'li', 'spr', 'ac', 't', 'har']);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#first skb-b')).fontWeight)).toBe('700');

    await writeSettings(serviceWorker, { mode: 'fixed', letters: 3, weight: 900, fade: 40 });
    await expect.poll(() => boldParts(page, '#first')).toEqual(['Mor', 'lig', 'spr', 'acr', 'th', 'har']);
    const styles = await page.evaluate(() => {
      const wrapper = document.querySelector('#first skb-w');
      const bold = wrapper.querySelector('skb-b');
      return {
        weight: getComputedStyle(bold).fontWeight,
        tail: getComputedStyle(wrapper).webkitTextFillColor,
        head: getComputedStyle(bold).webkitTextFillColor,
      };
    });
    expect(styles.weight).toBe('900');
    expect(styles.tail).toMatch(/\/ 0\.6\)|, 0\.6\)/);
    expect(styles.head).toBe('rgb(0, 0, 0)');
    expect(await textOf(page, '#first')).toBe('Morning light spreads across the harbour');

    await writeSettings(serviceWorker, { mode: 'fixed', letters: 3, weight: 600, fade: 0, everyNth: 2 });
    await expect.poll(() => boldParts(page, '#first')).toEqual(['Mor', 'spr', 'th']);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#first skb-b')).fontWeight)).toBe('600');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#first skb-w')).webkitTextFillColor)).toBe('rgb(0, 0, 0)');
    expect(await invariantProblems(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('roots and frames', () => {
  test('processes open shadow roots, including content added later, and restores them', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/shadow.html');
    const snapshot = () => page.evaluate(() => {
      const card = document.getElementById('card').shadowRoot;
      return {
        card: card.innerHTML,
        nested: card.getElementById('nested-host').shadowRoot.innerHTML,
        declarative: document.getElementById('declarative').shadowRoot.innerHTML,
        closed: window.closedRootHtml(),
        light: document.body.innerHTML,
        sheets: [document.adoptedStyleSheets.length, card.adoptedStyleSheets.length],
      };
    });
    const before = await snapshot();
    await inject(serviceWorker, tabId);
    await setActive(serviceWorker, tabId, true);

    const inShadow = (selector) => page.evaluate((sel) => {
      const card = document.getElementById('card').shadowRoot;
      const roots = { card, nested: card.getElementById('nested-host').shadowRoot, declarative: document.getElementById('declarative').shadowRoot };
      const [rootName, query] = sel.split(' ');
      const bold = roots[rootName].querySelector(`${query} skb-b`);
      if (!bold) return null;
      const style = getComputedStyle(bold);
      return { weight: style.fontWeight, visibility: style.visibility };
    }, selector);
    await expect.poll(() => inShadow('card #shadow-body')).toEqual({ weight: '700', visibility: 'visible' });
    await expect.poll(() => inShadow('nested #nested-body')).toEqual({ weight: '700', visibility: 'visible' });
    await expect.poll(() => inShadow('declarative .inner')).toEqual({ weight: '700', visibility: 'visible' });
    expect(await countIn(page, '[slot="title"]')).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.closedRootHtml())).toBe(before.closed);

    await page.evaluate(() => {
      const late = document.createElement('p');
      late.id = 'late';
      late.textContent = 'Late shadow words added afterwards.';
      document.getElementById('card').shadowRoot.appendChild(late);
    });
    await expect.poll(() => inShadow('card #late')).toEqual({ weight: '700', visibility: 'visible' });
    expect(await page.evaluate(() => document.getElementById('card').shadowRoot.getElementById('late').innerText)).toBe('Late shadow words added afterwards.');

    await setActive(serviceWorker, tabId, false);
    const after = await snapshot();
    expect(after).toEqual({ ...before, card: `${before.card}<p id="late">Late shadow words added afterwards.</p>` });
    expect(errors).toEqual([]);
  });

  test('processes a same-origin iframe when injected into all frames', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/frame-parent.html');
    const child = page.frameLocator('#child');
    await child.locator('#child-text').waitFor();
    const frame = page.frames().find((item) => item.url().endsWith('/engine/frame-child.html'));
    const childHtml = await frame.evaluate(() => document.body.innerHTML);

    await inject(serviceWorker, tabId, { allFrames: true });
    await setActive(serviceWorker, tabId, true);
    await expect.poll(() => frame.evaluate(() => document.querySelectorAll('#child-text skb-b').length)).toBeGreaterThan(3);
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('skb-b')).fontWeight)).toBe('700');
    expect(await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.isActive(), [], { allFrames: true })).toEqual([true, true]);

    await setActive(serviceWorker, tabId, false);
    expect(await frame.evaluate(() => document.body.innerHTML)).toBe(childHtml);
    expect(errors).toEqual([]);
  });
});

test.describe('re-injection', () => {
  test('injecting twice neither double-processes nor double-listens', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    const tabId = await openFixture(page, serviceWorker, '/engine/dynamic.html');
    const html = await bodyHtml(page);
    await inject(serviceWorker, tabId);
    await isolated(serviceWorker, tabId, () => { globalThis.Skimbold.engine.marker = 'first'; });
    await inject(serviceWorker, tabId);
    expect(await isolated(serviceWorker, tabId, () => globalThis.Skimbold.engine.marker)).toEqual(['first']);

    // With two listeners, one toggle would flip twice and leave the page off.
    expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: true });
    await expect.poll(() => countIn(page, '#first', 'skb-w')).toBe(1);
    await inject(serviceWorker, tabId);
    await frames(page);
    for (const id of ['first', 'second', 'third', 'anchor']) expect(await countIn(page, `#${id}`, 'skb-w'), id).toBe(1);
    expect(await invariantProblems(page)).toEqual([]);

    expect(await send(serviceWorker, tabId, { type: 'skb:toggle' })).toEqual({ active: false });
    await frames(page);
    expect(await bodyHtml(page)).toBe(html);
    expect(errors).toEqual([]);
  });
});
