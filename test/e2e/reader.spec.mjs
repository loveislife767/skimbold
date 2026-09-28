// The Reader page (extension/reader/): paste, files, PDFs, settings, memory, and the web build.
// PDF fixtures come from test/fixtures/reader/make-fixtures.mjs.

import path from 'node:path';
import { test, expect, openExtensionPage, swEval, tabIdFor, collectConsoleErrors } from './fixtures.mjs';
import { FIXTURES_DIR } from '../fixtures/server.mjs';

const fixture = (name) => path.join(FIXTURES_DIR, 'reader', name);

const PROSE = [
  'Reading by lamplight changes the way a page feels.',
  '',
  'The edges of the room fall away, and the lines of text become the only landscape left to explore.',
].join('\n');

const WORDS = ['lamp', 'harbour', 'keeper', 'evening', 'tide', 'window', 'quietly', 'letters', 'ribbon', 'shoreline',
  'lantern', 'weather', 'morning', 'northern', 'stairway', 'the', 'and', 'of', 'a', 'to', 'in', 'with', 'under', 'across'];

// Deterministic filler prose: `count` paragraphs of about 70 words each.
function book(count) {
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed >> 8;
  };
  const paragraphs = [];
  for (let p = 1; p <= count; p++) {
    const sentences = [];
    for (let s = 0; s < 5; s++) {
      const words = Array.from({ length: 8 + (next() % 12) }, () => WORDS[next() % WORDS.length]);
      words[0] = words[0][0].toUpperCase() + words[0].slice(1);
      sentences.push(`${words.join(' ')}.`);
    }
    paragraphs.push(`Paragraph ${p}. ${sentences.join(' ')}`);
  }
  return paragraphs.join('\n\n');
}

// Opens the Reader and waits until it has loaded its settings and bound its handlers.
async function openReader(context, extensionId, query = '') {
  const page = await openExtensionPage(context, extensionId, `reader/reader.html${query}`);
  await waitForReady(page);
  return page;
}

// Settings load first, then the start page title gets its bold word starts.
async function waitForReady(page) {
  await page.locator('#rd-home-title .skb-rb').first().waitFor({ state: 'attached' });
}

// What the browser does on Ctrl+V: a paste event at the focused element.
async function paste(page, text) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const active = document.activeElement;
    const target = active && active !== document.body ? active : document.body;
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

// A document is complete once its end marker shows.
async function waitForDocument(page, timeout = 15_000) {
  await expect(page.locator('#rd-doc-end')).toBeVisible({ timeout });
}

const bodyText = (page) => page.locator('#rd-doc-body').evaluate((node) => node.textContent);
const occurrences = (text, part) => text.split(part).length - 1;
const computed = (locator, property) => locator.evaluate((node, name) => getComputedStyle(node)[name], property);

function storedSettings(serviceWorker) {
  return swEval(serviceWorker, async () => {
    const api = globalThis.browser ?? globalThis.chrome;
    return (await api.storage.sync.get('settings')).settings ?? null;
  });
}

// Playwright's click first scrolls its target into view, which nudges the page even for a
// control in the sticky bar. A person's click does not, so click where it is.
async function clickInPlace(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openPanel(page) {
  await page.click('#rd-display-toggle');
  await expect(page.locator('#rd-display')).toBeVisible();
}

test.describe('Reader as an extension page', () => {
  test('pasted text is rendered with bold word starts', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const errors = collectConsoleErrors(page);
    await paste(page, PROSE);
    await waitForDocument(page);

    const paragraphs = page.locator('#rd-doc-body p');
    await expect(paragraphs).toHaveCount(2);
    await expect(paragraphs.nth(0)).toHaveText('Reading by lamplight changes the way a page feels.');
    await expect(paragraphs.nth(1)).toHaveText(PROSE.split('\n')[2]);
    // innerText is what is painted; content-visibility settles on the next frame.
    await expect.poll(() => paragraphs.nth(1).evaluate((node) => node.innerText)).toBe(PROSE.split('\n')[2]);
    // Auto at strength 3: "Reading" (7 letters) gets 3 bold letters, "by" 1, "lamplight" 4.
    expect((await paragraphs.nth(0).locator('.skb-rb').allTextContents()).slice(0, 3)).toEqual(['Rea', 'b', 'lamp']);
    expect(await computed(paragraphs.nth(0).locator('.skb-rb').first(), 'fontWeight')).toBe('700');
    await expect(page.locator('#rd-doc-meta')).toHaveText('Pasted text · 28 words');
    await expect(page).toHaveTitle('Reading by lamplight changes the way a page feels. · Skimbold Reader');
    await expect(page.locator('#rd-doc')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('opens a plain text file, joining wrapped lines', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles(fixture('notes.txt'));
    await waitForDocument(page);
    const paragraphs = page.locator('#rd-doc-body p');
    await expect(paragraphs).toHaveCount(6);
    await expect(paragraphs.nth(0)).toHaveText('The Keeper\'s Notes');
    await expect(paragraphs.nth(1)).toHaveText('These notes were typed on an old machine that wrapped every line at about seventy characters, so each paragraph arrives broken into several short lines that belong together. The Reader should join them back into one flowing paragraph without losing a single word.');
    await expect(paragraphs.nth(2)).toHaveText('A word split at the end of a line, like the word lamplighter here, should come back together. A name such as Anne-Marie keeps its hyphen.');
    // A list and a poem keep their lines.
    await expect.poll(() => paragraphs.nth(3).evaluate((node) => node.innerText)).toBe('Things to pack for the night watch:\n- a flask of tea\n- two spare wicks\n- the logbook and a pencil');
    await expect.poll(() => paragraphs.nth(4).evaluate((node) => node.innerText)).toBe('The sea is calm tonight,\nThe tide is full, the moon lies fair\nUpon the straits.');
    await expect(page.locator('#rd-doc-title')).toHaveText('notes.txt');
    await expect(page.locator('#rd-doc-meta')).toHaveText(/^Text file · \d+ words$/);
  });

  test('opens an HTML file as text, never as markup', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const errors = collectConsoleErrors(page);
    await page.locator('#rd-file').setInputFiles(fixture('page.html'));
    await waitForDocument(page);
    const body = page.locator('#rd-doc-body');
    await expect(body.locator('h1')).toHaveText('Harbour Lights Guide');
    await expect(body.locator('h2')).toHaveText('Reading a light');
    await expect(body.locator('p').first()).toHaveText('Every harbour light has its own character: a pattern of flashes that tells sailors exactly which light they are looking at.');
    await expect(body.locator('ul > li')).toHaveText(['Count the flashes in each group.', 'Time the pause between groups.']);
    await expect(body.locator('ol > li')).toHaveText(['Check the colour against the chart.']);
    expect(await body.locator('ol').evaluate((node) => node.start)).toBe(3);
    await expect(body.locator('blockquote p')).toHaveText('A light you cannot name is a light you cannot trust.');
    const code = body.locator('pre.rd-code');
    await expect(code).toHaveText('Fl(2) W 10s   two white flashes every ten seconds');
    await expect(code.locator('.skb-rb')).toHaveCount(0);
    expect(await computed(code, 'fontFamily')).toContain('monospace');

    await expect(body.locator('p', { hasText: 'Markup in the text' })).toHaveText('Markup in the text stays text: <b>not bold</b> & <img src=x onerror=alert(1)>.');
    await expect(body.locator('img, b, script, a')).toHaveCount(0);
    const text = await bodyText(page);
    for (const absent of ['Home', 'About', 'Site footer text', 'This hidden paragraph', 'color: red']) expect(text).not.toContain(absent);
    // Nothing from the file ran: not its script, not its image handler.
    expect(await page.evaluate(() => ({ ...document.documentElement.dataset }))).not.toHaveProperty('scriptRan');
    expect(await page.evaluate(() => ({ ...document.documentElement.dataset }))).not.toHaveProperty('imageRan');
    expect(errors).toEqual([]);
  });

  test('opens a Markdown file without its markers', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles(fixture('guide.md'));
    await waitForDocument(page);
    const body = page.locator('#rd-doc-body');
    await expect(body.locator('h1')).toHaveText('Lamp Care');
    await expect(body.locator('h2')).toHaveText(['Daily tasks', 'Evening Routine']);
    await expect(body.locator('p').first()).toHaveText('A short guide to keeping a brass lamp bright. See the manual for more.');
    await expect(body.locator('ol > li')).toHaveText(['Trim the wick.', 'Polish the glass with a soft cloth. Keep the cloth dry.', 'Top up the oil.']);
    await expect(body.locator('ul > li')).toHaveText(['☑ Checked the reservoir', '☐ Ordered new wicks']);
    await expect(body.locator('blockquote p')).toHaveText('Clean glass gives the steadiest light.');
    await expect(body.locator('pre.rd-code')).toHaveText('lamp --trim --polish');
    await expect(body.locator('pre.rd-code .skb-rb')).toHaveCount(0);
    await expect(body.locator('p').last()).toHaveText('Final paragraph with inline code and snake_case_names intact.');
    await expect(page.locator('#rd-doc-meta')).toHaveText(/^Markdown · \d+ words$/);
  });

  test('refuses files it cannot read', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles({ name: 'photo.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3]) });
    await expect(page.locator('#rd-message')).toContainText('photo.bin isn\'t a file the Reader can open.');
    await expect(page.locator('#rd-message')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#rd-doc')).toBeHidden();
  });

  test('a 3-page PDF article becomes headings and paragraphs', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const errors = collectConsoleErrors(page);
    await page.locator('#rd-file').setInputFiles(fixture('article.pdf'));
    await waitForDocument(page);
    const body = page.locator('#rd-doc-body');
    await expect(body.locator('h1')).toHaveText('Notes on Reading by Lamplight');
    await expect(body.locator('h2')).toHaveText(['The Shape of a Line', 'Keeping Your Place', 'A Quiet Ending']);
    await expect(body.locator('.rd-page')).toHaveText(['Page 2', 'Page 3']);
    await expect(page.locator('#rd-doc-meta')).toHaveText(/^PDF · 3 pages · \d+ words$/);

    const text = await bodyText(page);
    // A word hyphenated across a line break is joined; a hyphenated name keeps its hyphen.
    expect(occurrences(text, 'such as extraordinary has to be split')).toBe(1);
    expect(text).not.toContain('extraor-');
    expect(occurrences(text, 'a quiet man named Jean-Paul Marchand, kept a log')).toBe(1);
    // The running header and footer are gone from every page.
    expect(text).not.toContain('Lamplight Quarterly');
    expect(text).not.toMatch(/page \d of 3/i);
    for (const sentence of [
      'Every line of type asks the eye to make a small journey from left to right, then a longer return sweep back to the start of the next line.',
      'Short paragraphs give the eye a place to rest.',
      'His log listed three things for each vessel:',
      'The final sentence of this article should appear exactly once in the extracted text.',
    ]) expect(occurrences(text, sentence), sentence).toBe(1);
    // Paragraphs are separate elements, whether spaced apart or marked by an indent.
    await expect(body.locator('p', { hasText: 'When the eye loses its place' })).toHaveText('When the eye loses its place, it wanders back over words it has already read. A strong start to each word gives it something to hold on to, the way a handrail steadies a walker on a dark stair.');
    await expect(body.locator('p', { hasText: 'Years later' })).toHaveText('Years later, readers of the log said it was the steadiness of the entries, more than any single story, that kept them turning the pages.');
    await expect(body.locator('h1 .skb-rb').first()).toHaveText('No');
    expect(errors).toEqual([]);
  });

  test('a two-column PDF page is read column by column', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles(fixture('columns.pdf'));
    await waitForDocument(page);
    const paragraphs = await page.locator('#rd-doc-body p').allTextContents();
    expect(paragraphs).toEqual([
      'Column one begins with the morning report. Fog lay over the harbour until nine, and the ferry waited at the pier with its engines idling while the pilots argued about the channel.',
      'By noon the wind had turned to the west and the fog lifted in long grey ribbons that drifted over the hills behind the town.',
      'Fishermen who had stayed ashore mended their nets on the quay and watched the sky for any sign of the storm the radio had promised.',
      'Column two carries the evening forecast. Rain is expected after midnight, heavy at times along the coast, with gusts strong enough to rattle the shutters of the old customs house.',
      'Tomorrow should clear by mid-morning, leaving a cold bright afternoon that is ideal for walking the cliff path to the lighthouse.',
      'Readers planning a crossing are advised to check the ferry timetable before leaving home.',
      'This closing note spans both columns and should come after both of them.',
    ]);
    await expect(page.locator('#rd-doc-body h1')).toHaveText('Two Columns of Weather');
  });

  test('an image-only PDF gets a clear explanation', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const errors = collectConsoleErrors(page);
    await page.locator('#rd-file').setInputFiles(fixture('scanned.pdf'));
    const message = page.locator('#rd-message');
    await expect(message).toContainText('This PDF has no selectable text — it may be a scanned image.', { timeout: 15_000 });
    await expect(message.getByRole('button', { name: 'Choose another file' })).toBeVisible();
    await expect(page.locator('#rd-doc')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a password-protected PDF asks for its password', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles(fixture('locked.pdf'));
    const message = page.locator('#rd-message');
    await expect(message).toContainText('This PDF is protected with a password.');
    await expect(page.locator('#rd-password-input')).toBeFocused();
    await page.fill('#rd-password-input', 'wrong guess');
    await page.keyboard.press('Enter');
    await expect(message).toContainText('That password didn’t work. Try again.');
    await page.fill('#rd-password-input', 'lamplight');
    await page.keyboard.press('Enter');
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body h1')).toHaveText('A Locked Letter');
    await expect(page.locator('#rd-doc-body p')).toHaveText('The key to the lighthouse hangs on a nail beside the door.');
  });

  test('?session= opens text handed over by the background, then deletes it', async ({ context, extensionId, serviceWorker }) => {
    const key = 'selection-e2e';
    await swEval(serviceWorker, async ([k, text]) => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.storage.session.set({ [k]: text });
    }, [key, PROSE]);
    const page = await openReader(context, extensionId, `?session=${key}`);
    const errors = collectConsoleErrors(page);
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body p').first()).toHaveText('Reading by lamplight changes the way a page feels.');
    await expect(page.locator('#rd-doc-meta')).toHaveText('Selected text · 28 words');
    const left = await swEval(serviceWorker, async (k) => {
      const api = globalThis.browser ?? globalThis.chrome;
      return Object.keys(await api.storage.session.get(k));
    }, key);
    expect(left).toEqual([]);
    // Reloading keeps the document on screen, although its key is gone.
    await page.reload();
    await waitForDocument(page);
    expect(new URL(page.url()).search).toBe(`?session=${key}`);
    await expect(page.locator('#rd-doc-body p').first()).toHaveText('Reading by lamplight changes the way a page feels.');
    await expect(page.locator('#rd-message')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('?session= with a key that is gone explains what happened', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId, '?session=selection-missing');
    await expect(page.locator('#rd-message')).toContainText('The selected text is no longer available.');
  });

  test('?pdf=&tab= fetches the PDF inside its tab', async ({ context, extensionId, serviceWorker, server, page }) => {
    await page.goto('/basic.html');
    const tabId = await tabIdFor(serviceWorker, page);
    const url = `${server.url}/reader/article.pdf`;
    const reader = await openReader(context, extensionId, `?pdf=${encodeURIComponent(url)}&tab=${tabId}`);
    const errors = collectConsoleErrors(reader);
    await waitForDocument(reader);
    await expect(reader.locator('#rd-doc-body h1')).toHaveText('Notes on Reading by Lamplight');
    await expect(reader.locator('#rd-doc-title')).toHaveText('article.pdf');
    expect(new URL(reader.url()).searchParams.get('pdf')).toBe(url);
    // The file went through the tab's isolated world, and nothing was left behind there.
    const stash = await swEval(serviceWorker, async (id) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const [result] = await api.scripting.executeScript({
        target: { tabId: id },
        func: () => (globalThis.skimboldPdfStash instanceof Map ? globalThis.skimboldPdfStash.size : -1),
      });
      return result.result;
    }, tabId);
    expect(stash).toBe(0);

    // A reload shows the same document from memory, without fetching the PDF again.
    const fetches = [];
    reader.on('request', (request) => {
      if (request.url().endsWith('.pdf')) fetches.push(request.url());
    });
    await page.close();
    await reader.reload();
    await waitForDocument(reader);
    await expect(reader.locator('#rd-doc-body h1')).toHaveText('Notes on Reading by Lamplight');
    expect(fetches).toEqual([]);
    // Opening something else drops the link from the address.
    await reader.click('#rd-home');
    await paste(reader, PROSE);
    await waitForDocument(reader);
    expect(new URL(reader.url()).search).toBe('');
    expect(errors).toEqual([]);
  });

  test('?pdf= that cannot be fetched offers the file picker', async ({ context, extensionId, serviceWorker, server, page }) => {
    await page.goto('/basic.html');
    const tabId = await tabIdFor(serviceWorker, page);
    const reader = await openReader(context, extensionId, `?pdf=${encodeURIComponent(`${server.url}/reader/missing.pdf`)}&tab=${tabId}`);
    const message = reader.locator('#rd-message');
    await expect(message).toContainText('Choose the PDF to read it here.');
    await expect(message).toContainText('The site didn’t let Skimbold download this PDF.');
    const chooser = reader.waitForEvent('filechooser');
    await message.getByRole('button', { name: 'Choose the PDF' }).click();
    await (await chooser).setFiles(fixture('article.pdf'));
    await waitForDocument(reader);
    await expect(reader.locator('#rd-doc-body h1')).toHaveText('Notes on Reading by Lamplight');

    const local = await openReader(context, extensionId, `?pdf=${encodeURIComponent('file:///C:/papers/notes.pdf')}`);
    await expect(local.locator('#rd-message')).toContainText('Your browser doesn’t let extensions read files on your computer directly.');
  });

  test('theme, font, size, spacing and width change the page and are saved', async ({ context, extensionId, serviceWorker }) => {
    const page = await openReader(context, extensionId);
    await paste(page, PROSE);
    await waitForDocument(page);
    const html = page.locator('html');
    const body = page.locator('body');
    const doc = page.locator('#rd-doc');
    await expect(html).not.toHaveAttribute('data-theme', /./);
    await openPanel(page);

    await page.click('label[for="rd-theme-sepia"]');
    await expect(html).toHaveAttribute('data-theme', 'sepia');
    expect(await computed(body, 'backgroundColor')).toBe('rgb(244, 236, 220)');
    await page.click('label[for="rd-theme-dark"]');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await computed(body, 'backgroundColor')).toBe('rgb(20, 28, 24)');
    await page.click('label[for="rd-theme-light"]');
    expect(await computed(body, 'backgroundColor')).toBe('rgb(242, 244, 239)');
    // Auto follows the system.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.click('label[for="rd-theme-auto"]');
    await expect(html).not.toHaveAttribute('data-theme', /./);
    expect(await computed(body, 'backgroundColor')).toBe('rgb(20, 28, 24)');
    await page.emulateMedia({ colorScheme: 'light' });

    expect(await computed(doc, 'fontFamily')).toMatch(/^Charter/);
    await page.click('label[for="rd-font-sans"]');
    expect(await computed(doc, 'fontFamily')).toMatch(/^system-ui/);

    expect(await computed(doc, 'fontSize')).toBe('20px');
    await page.click('#rd-size-up');
    await expect(page.locator('#rd-size-value')).toHaveText('21 px');
    expect(await computed(doc, 'fontSize')).toBe('21px');

    await page.locator('#rd-leading').fill('2');
    await expect(page.locator('#rd-leading-value')).toHaveText('2.0');
    expect(await computed(doc, 'lineHeight')).toBe('42px');

    await page.locator('#rd-width').fill('900');
    await expect(page.locator('#rd-width-value')).toHaveText('900 px');
    // 900 px of text plus 40 px of padding on each side at this window width.
    expect(await computed(doc, 'maxWidth')).toBe('980px');

    await expect.poll(async () => (await storedSettings(serviceWorker))?.reader).toEqual({
      theme: 'auto', fontSize: 21, lineHeight: 2, font: 'sans', width: 900, bold: true,
    });
    // Escape closes the panel and focus returns to its button.
    await page.keyboard.press('Escape');
    await expect(page.locator('#rd-display')).toBeHidden();
    await expect(page.locator('#rd-display-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('bold letters and strength are shared with the extension settings', async ({ context, extensionId, serviceWorker }) => {
    const page = await openReader(context, extensionId);
    await paste(page, PROSE);
    await waitForDocument(page);
    const first = page.locator('#rd-doc-body p').first();
    await openPanel(page);
    await expect(page.locator('#rd-shared-hint')).toBeVisible();
    await expect(page.locator('#rd-web-note')).toBeHidden();
    await expect(page.locator('#rd-letters-auto')).toBeChecked();

    await page.locator('#rd-strength').fill('5');
    // Strength 5 bolds 60 %: "Reading" → 4 letters.
    await expect(first.locator('.skb-rb').first()).toHaveText('Read');
    await expect.poll(async () => (await storedSettings(serviceWorker))?.strength).toBe(5);

    await page.click('label[for="rd-letters-1"]');
    await expect(first.locator('.skb-rb').first()).toHaveText('R');
    await expect(page.locator('#rd-strength-field')).toBeHidden();
    await expect.poll(async () => {
      const stored = await storedSettings(serviceWorker);
      return stored && { mode: stored.mode, letters: stored.letters };
    }).toEqual({ mode: 'fixed', letters: 1 });

    // A change made elsewhere (the popup, say) applies here at once.
    await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      const { settings } = await api.storage.sync.get('settings');
      await api.storage.sync.set({ settings: { ...settings, letters: 3, weight: 900 } });
    });
    await expect(first.locator('.skb-rb')).toHaveText(['Rea', 'b', 'lam', 'cha', 'th', 'wa', 'a', 'pag', 'fee']);
    await expect(page.locator('#rd-letters-3')).toBeChecked();
    expect(await computed(first.locator('.skb-rb').first(), 'fontWeight')).toBe('900');
  });

  test('keyboard shortcuts: B, + and −, Ctrl+O', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await paste(page, PROSE);
    await waitForDocument(page);
    const span = page.locator('#rd-doc-body .skb-rb').first();
    await page.keyboard.press('b');
    await expect(page.locator('html')).toHaveAttribute('data-bold', 'off');
    await expect(page.locator('#rd-bold')).not.toBeChecked();
    expect(await computed(span, 'fontWeight')).toBe('400');
    await page.keyboard.press('B');
    await expect(page.locator('html')).toHaveAttribute('data-bold', 'on');
    expect(await computed(span, 'fontWeight')).toBe('700');

    await page.keyboard.press('+');
    await expect.poll(() => computed(page.locator('#rd-doc'), 'fontSize')).toBe('21px');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await expect.poll(() => computed(page.locator('#rd-doc'), 'fontSize')).toBe('19px');

    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+O');
    await (await chooser).setFiles(fixture('notes.txt'));
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-title')).toHaveText('notes.txt');
    // With a document open, a stray paste does not replace it.
    await paste(page, 'Something else entirely.');
    await expect(page.locator('#rd-doc-title')).toHaveText('notes.txt');
  });

  test('drag and drop opens a file; files over 100 MB are refused', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const shown = await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['Dropped words are read too.\n\nA second dropped paragraph.'], 'dropped.txt', { type: 'text/plain' }));
      const init = { dataTransfer: data, bubbles: true, cancelable: true };
      document.body.dispatchEvent(new DragEvent('dragenter', init));
      const overlay = !document.getElementById('rd-dropzone').hidden;
      document.body.dispatchEvent(new DragEvent('drop', init));
      return { overlay, after: !document.getElementById('rd-dropzone').hidden };
    });
    expect(shown).toEqual({ overlay: true, after: false });
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body p')).toHaveText(['Dropped words are read too.', 'A second dropped paragraph.']);

    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(101 * 1024 * 1024)], 'huge.pdf', { type: 'application/pdf' }));
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#rd-message')).toContainText('huge.pdf is too large to open.');
    await expect(page.locator('#rd-message')).toContainText('The Reader opens files up to 100 MB.');
  });

  test('remembers the document and where you were', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await paste(page, book(80));
    await waitForDocument(page);
    await page.locator('#rd-doc-body p').nth(40).evaluate((node) => node.scrollIntoView());
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skimbold.reader.position') || '{}').i)).toBe(40);

    // A reload comes back to the same place.
    await page.reload();
    await waitForDocument(page);
    // Checked after the page has settled, so late layout above the spot would show.
    await page.waitForTimeout(1800);
    // The first block under the top bar.
    const topIndex = () => page.evaluate(() => {
      const bar = document.getElementById('rd-bar').getBoundingClientRect().bottom;
      const column = document.getElementById('rd-doc-body').getBoundingClientRect();
      for (let y = bar + 12; y < innerHeight; y += 8) {
        const block = document.elementFromPoint(column.left + 60, y)?.closest('[data-i]');
        if (block) return Number(block.dataset.i);
      }
      return -1;
    });
    expect(await topIndex()).toBe(40);

    // The start page offers to continue.
    await clickInPlace(page, '#rd-home');
    const card = page.locator('#rd-continue');
    await expect(card).toBeVisible();
    // Pasted text is titled by its first line, shortened at a word boundary.
    await expect(page.locator('#rd-continue-title')).toHaveText(/^Paragraph 1\. \S.{10,66}\S…$/);
    await expect(page.locator('#rd-continue-meta')).toHaveText(/^Pasted text · 51% read$/);
    await page.click('#rd-continue-open');
    await waitForDocument(page);
    expect(await topIndex()).toBe(40);

    // Forgetting clears it.
    await page.click('#rd-home');
    await page.click('#rd-forget');
    await expect(card).toBeHidden();
    expect(await page.evaluate(() => [localStorage.getItem('skimbold.reader.doc'), localStorage.getItem('skimbold.reader.position')])).toEqual([null, null]);
  });

  test('a text of 150,000 short lines with no blank line opens (a word list, a log)', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    const errors = collectConsoleErrors(page);
    const lines = Array.from({ length: 150_000 }, (_, i) => `entry ${i} ok`).join('\n');
    await page.locator('#rd-file').setInputFiles({ name: 'words.txt', mimeType: 'text/plain', buffer: Buffer.from(lines) });
    await waitForDocument(page, 30_000);
    await expect(page.locator('#rd-doc-body p').first()).toContainText('entry 0 ok');
    expect(errors).toEqual([]);
  });

  test('the file\'s content decides over its name: a PDF named .txt, and binary data named .txt', async ({ context, extensionId }) => {
    const fs = await import('node:fs');
    const page = await openReader(context, extensionId);
    await page.locator('#rd-file').setInputFiles({ name: 'article-renamed.txt', mimeType: 'text/plain', buffer: fs.readFileSync(fixture('article.pdf')) });
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-meta')).toHaveText(/^PDF · 3 pages/);
    await expect(page.locator('#rd-doc-body h1')).toHaveText('Notes on Reading by Lamplight');

    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    await page.locator('#rd-file').setInputFiles({ name: 'binary.txt', mimeType: 'text/plain', buffer: binary });
    await expect(page.locator('#rd-message')).toContainText('binary.txt isn\'t a file the Reader can open.');
    // A text file that merely mentions the signature is still text.
    await page.locator('#rd-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Every PDF begins with %PDF-1.7 in its header.') });
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-meta')).toHaveText(/^Text file/);
  });

  test('a document reopened with "Continue reading" is still there after a reload', async ({ context, extensionId, serviceWorker }) => {
    await swEval(serviceWorker, () => (globalThis.browser ?? globalThis.chrome).storage.session.set({ 'selection-continue': 'Words handed over from a page, to read later.' }));
    const first = await openReader(context, extensionId, '?session=selection-continue');
    await waitForDocument(first);
    await first.close();

    const page = await openReader(context, extensionId);
    await page.click('#rd-continue-open');
    await waitForDocument(page);
    await page.reload();
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body p')).toHaveText('Words handed over from a page, to read later.');
  });

  test('a PDF on a browser too old for pdf.js gets a message about the browser, not the file', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.addInitScript(() => { delete globalThis.Iterator; });
    await page.goto(`chrome-extension://${extensionId}/reader/reader.html`);
    await waitForReady(page);
    await page.locator('#rd-file').setInputFiles(fixture('article.pdf'));
    await expect(page.locator('#rd-message')).toContainText('This browser is too old to open PDFs here.');
  });

  test('documents over 4 MB are not remembered', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    await paste(page, PROSE);
    await waitForDocument(page);
    expect(await page.evaluate(() => localStorage.getItem('skimbold.reader.doc'))).not.toBeNull();
    const large = book(10_000);
    expect(large.length).toBeGreaterThan(4 * 1024 * 1024);
    await page.click('#rd-home');
    // In one step inside the page, so no trace snapshot copies the growing DOM.
    const result = await page.evaluate(async (text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const doc = document.getElementById('rd-doc');
      while (doc.hidden) await new Promise((resolve) => setTimeout(resolve, 20));
      const first = document.querySelector('#rd-doc-body p').textContent.slice(0, 12);
      const stored = localStorage.getItem('skimbold.reader.doc');
      document.getElementById('rd-home').click();
      return { first, stored };
    }, large);
    expect(result).toEqual({ first: 'Paragraph 1.', stored: null });
    await expect(page.locator('#rd-continue')).toBeHidden();
  });

});

test.describe('Reader performance on a 300-page book @stress', () => {
  test.setTimeout(90_000);

  async function watchLongTasks(page) {
    await page.evaluate(() => {
      globalThis.longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) globalThis.longTasks.push(Math.round(entry.duration));
      }).observe({ type: 'longtask' });
    });
  }

  // Waits for the document inside the page. Every Playwright action or expect takes a trace
  // snapshot of the whole DOM on the page's main thread, which with 100,000+ spans would add
  // long tasks of Playwright's own making; this way none run while the Reader renders.
  function measureRender(page, text = null) {
    return page.evaluate(async (pasted) => {
      const started = performance.now();
      if (pasted !== null) {
        const data = new DataTransfer();
        data.setData('text/plain', pasted);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
      const doc = document.getElementById('rd-doc');
      const end = document.getElementById('rd-doc-end');
      const loading = document.getElementById('rd-doc-loading');
      let firstShown = null;
      let loadingText = '';
      while (end.hidden && performance.now() - started < 80_000) {
        if (firstShown === null && !doc.hidden) {
          firstShown = Math.round(performance.now() - started);
          loadingText = loading.hidden ? '' : loading.textContent;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const elapsed = Math.round(performance.now() - started);
      // Long-task entries arrive a moment after the task ends.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { firstShown, loadingText, elapsed, done: !end.hidden, longTasks: globalThis.longTasks.slice() };
    }, text);
  }

  test('a long Markdown file is parsed in slices too', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    // The file is built and dropped inside the page, so only the Reader's own work is measured.
    const size = await page.evaluate(() => {
      const sections = [];
      for (let i = 0; i < 12_000; i++) {
        sections.push(`## Section ${i}\n\nSome *emphasis*, a [link](https://example.com/${i}) and **strong words** in paragraph ${i}.\n\n- one item\n- two items\n\n> A quoted line ${i}.\n`);
      }
      globalThis.bigMarkdown = new File([sections.join('\n')], 'big.md', { type: 'text/markdown' });
      return globalThis.bigMarkdown.size;
    });
    expect(size).toBeGreaterThan(1_500_000);
    await watchLongTasks(page);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(globalThis.bigMarkdown);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    const result = await measureRender(page);
    expect(result.done).toBe(true);
    // Parsed in one go, this file blocked the page for about half a second.
    expect(Math.max(0, ...result.longTasks), 'longest main-thread task while opening (ms)').toBeLessThan(150);
  });

  test('a long HTML page is parsed in slices, however deeply its text is nested', async ({ context, extensionId }) => {
    const page = await openReader(context, extensionId);
    // A saved page with all of its text in one wrapper: body > div#page > (header, div#content, footer).
    await page.evaluate(() => {
      const entries = [];
      for (let i = 1; i <= 10_000; i++) {
        entries.push(`<h3>Entry ${i}</h3><p>Notes on the <em>harbour</em> for day ${i}.</p>`
          + `<ul><li>Tide at ${i % 12} o'clock</li><li>Gulls, wind and <a href="#w">weather</a></li></ul>`
          + `<table><tr><th>Tide</th><th>Boats</th><th>Wind</th></tr><tr><td>${i % 12}</td><td>${i % 40}</td><td>west</td></tr></table>`);
      }
      const html = `<!doctype html><title>Saved</title><div id="page"><header><h1>A saved page</h1></header><div id="content">${entries.join('')}</div><footer>Footer text</footer></div>`;
      globalThis.bigHtml = new File([html], 'saved.html', { type: 'text/html' });
      // DOMParser builds the document in one task that cannot be sliced, and on a slow machine that
      // task alone can pass 100 ms. So the task that ran it counts only from when it returned.
      const parse = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function (...args) {
        const started = performance.now();
        try {
          return parse.apply(this, args);
        } finally {
          globalThis.parsed = { at: performance.now(), took: Math.round(performance.now() - started) };
        }
      };
      globalThis.afterParse = [];
      new PerformanceObserver((list) => {
        for (const { startTime, duration } of list.getEntries()) {
          const end = startTime + duration;
          const at = globalThis.parsed ? globalThis.parsed.at : -1;
          globalThis.afterParse.push(Math.round(at >= startTime && at <= end ? end - at : duration));
        }
      }).observe({ type: 'longtask' });
    });
    await watchLongTasks(page);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(globalThis.bigHtml);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    const result = await measureRender(page);
    // One call for everything: each Playwright call snapshots the whole page for the trace.
    const { afterParse, parsed, shown } = await page.evaluate(() => {
      const body = document.getElementById('rd-doc-body');
      const paragraphs = [...body.querySelectorAll('p')];
      return {
        afterParse: globalThis.afterParse,
        parsed: globalThis.parsed,
        shown: {
          title: body.querySelector('h1').textContent,
          entries: body.querySelectorAll('h3').length,
          items: body.querySelectorAll('li').length,
          rows: paragraphs.filter((p) => p.textContent === 'Tide · Boats · Wind').length,
          last: paragraphs.at(-1).textContent,
        },
      };
    });
    test.info().annotations.push({ type: 'performance', description: `DOMParser took ${parsed.took} ms; long tasks: ${JSON.stringify(result.longTasks)}, less the parse: ${JSON.stringify(afterParse)}` });
    expect(result.done).toBe(true);
    expect(shown).toEqual({ title: 'A saved page', entries: 10_000, items: 20_000, rows: 10_000, last: 'Footer text' });
    // Sliced only between the wrapper's three parts, the walk through div#content ran as one task
    // of about 200 ms after the parse.
    expect(Math.max(0, ...afterParse), 'longest main-thread task while opening, less the parse (ms)').toBeLessThan(100);
  });

  // Extension pages share one renderer process, so a garbage-collection pass left over from an
  // earlier test can land in one of this test's frames. Like the stress test, it takes up to three
  // rounds, each in a fresh Reader page, and needs one without a long task.
  test('a book-length text renders in slices, never blocking for 50 ms', async ({ context, extensionId }) => {
    // About 2,400 paragraphs and 170,000 words.
    const text = book(2400);
    const rounds = [];
    for (let round = 1; round <= 3; round++) {
      const page = await openReader(context, extensionId);
      await watchLongTasks(page);
      const result = await measureRender(page, text);
      test.info().annotations.push({ type: 'performance', description: `round ${round}: ${text.length} characters rendered in ${result.elapsed} ms; long tasks: ${JSON.stringify(result.longTasks)}` });
      expect(result.done).toBe(true);
      await expect(page.locator('#rd-doc-body p')).toHaveCount(2400);
      rounds.push(result.longTasks);
      if (Math.max(0, ...result.longTasks) < 50) break;
      // The next page would open this document again instead of the start page.
      await page.evaluate(() => localStorage.removeItem('skimbold.reader.doc'));
      await page.close();
    }
    expect(rounds.some((longTasks) => Math.max(0, ...longTasks) < 50), `long tasks in every round: ${JSON.stringify(rounds)}`).toBe(true);
  });

  test('a 300-page PDF shows its first pages while the rest is read', async ({ context, extensionId }) => {
    // Printed here rather than committed: a 300-page fixture would weigh megabytes.
    // 1,150 paragraphs fill about 300 A5 pages.
    const printer = await context.newPage();
    const paragraphs = book(1150).split('\n\n').map((p) => `<p>${p}</p>`).join('');
    await printer.setContent(`<style>body{font:11pt/1.45 Georgia,serif}p{margin:0 0 8pt}</style>${paragraphs}`);
    // A path, as a real file picker gives: a buffer would be decoded inside the page by Playwright.
    const pdf = test.info().outputPath('long-book.pdf');
    await printer.pdf({
      path: pdf,
      format: 'A5',
      margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font:8px serif;text-align:center">A Long Book · <span class="pageNumber"></span></div>',
    });
    await printer.close();

    const page = await openReader(context, extensionId);
    await watchLongTasks(page);
    await page.locator('#rd-file').setInputFiles(pdf);
    const result = await measureRender(page);
    const pages = await page.locator('#rd-doc-body .rd-sec').count();
    test.info().annotations.push({ type: 'performance', description: `${pages} pages: first shown after ${result.firstShown} ms, complete after ${result.elapsed} ms; long tasks: ${JSON.stringify(result.longTasks)}` });
    expect(result.done).toBe(true);
    // The first pages were on screen while later ones were still being read.
    expect(result.loadingText).toMatch(/^Reading page \d+ of \d{3}…$/);
    expect(result.firstShown).toBeLessThan(result.elapsed / 2);
    expect(Math.max(0, ...result.longTasks)).toBeLessThan(50);

    expect(pages).toBeGreaterThanOrEqual(280);
    await expect(page.locator('#rd-doc-meta')).toHaveText(new RegExp(`^PDF · ${pages} pages · [\\d,]+ words$`));
    const text = await bodyText(page);
    expect(text).not.toContain('A Long Book');
    for (const n of [1, 575, 1150]) expect(occurrences(text, `Paragraph ${n}. `)).toBe(1);
  });
});

test.describe('Reader as a web page', () => {
  test('paste and PDF work with no extension APIs', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/extension/reader/reader.html');
    await waitForReady(page);
    expect(await page.evaluate(() => Boolean(globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id))).toBe(false);
    await expect(page.locator('#rd-shared-hint')).toBeHidden();
    // The website's Reader points visitors to the extension; the extension's own does not.
    await expect(page.locator('#rd-web-note a')).toHaveAttribute('href', '../');
    await expect(page.locator('#rd-web-note')).toBeVisible();

    await paste(page, PROSE);
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body p').first().locator('.skb-rb').first()).toHaveText('Rea');

    // Settings live in localStorage on the web.
    await openPanel(page);
    await page.click('label[for="rd-letters-2"]');
    await expect(page.locator('#rd-doc-body p').first().locator('.skb-rb').first()).toHaveText('Re');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skimbold.settings') || '{}').letters)).toBe(2);
    await page.keyboard.press('Escape');

    await page.locator('#rd-file').setInputFiles(fixture('article.pdf'));
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body h2')).toHaveText(['The Shape of a Line', 'Keeping Your Place', 'A Quiet Ending']);

    await page.goto('/extension/reader/reader.html?pdf=/reader/columns.pdf');
    await waitForDocument(page);
    await expect(page.locator('#rd-doc-body h1')).toHaveText('Two Columns of Weather');
    await expect(page.locator('#rd-doc-body p').first().locator('.skb-rb').first()).toHaveText('Co');
    expect(errors).toEqual([]);
  });

  test('a ?pdf= link to another site is not fetched: the website opens only files you choose', async ({ page, server }) => {
    const requests = [];
    const other = server.url.replace('127.0.0.1', 'localhost');
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`/extension/reader/reader.html?pdf=${encodeURIComponent(`${other}/reader/article.pdf`)}`);
    await waitForReady(page);
    await expect(page.locator('#rd-message')).toContainText('This Reader opens the files you choose.');
    expect(requests.filter((url) => url.startsWith(other))).toEqual([]);
    await expect(page.locator('#rd-doc')).toBeHidden();
  });

  test('Ctrl+V and the Paste button read the clipboard', async ({ page, context, server }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
    try {
      await page.goto('/extension/reader/reader.html');
      await waitForReady(page);
      await page.evaluate(() => navigator.clipboard.writeText('Copied from somewhere else.'));
      await page.keyboard.press('Control+V');
      await waitForDocument(page);
      await expect(page.locator('#rd-doc-body p')).toHaveText('Copied from somewhere else.');

      await page.evaluate(() => navigator.clipboard.writeText('The Paste button reads this.'));
      await page.click('#rd-paste');
      await expect(page.locator('#rd-doc-body p')).toHaveText('The Paste button reads this.');
    } finally {
      await context.clearPermissions();
    }
  });

  test('fits a 360 px phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.goto('/extension/reader/reader.html');
    await waitForReady(page);
    expect(await overflow()).toBe(0);
    await page.locator('#rd-file').setInputFiles(fixture('page.html'));
    await waitForDocument(page);
    expect(await overflow()).toBe(0);
    await openPanel(page);
    // A sheet along the bottom edge, once it has slid into place.
    await expect.poll(async () => {
      const box = await page.locator('#rd-display').boundingBox();
      return [box.x, box.width, Math.round(box.y + box.height)];
    }).toEqual([0, 360, 740]);
    await expect(page.locator('#rd-width')).toBeHidden();
    expect(await overflow()).toBe(0);
    // Every toolbar control stays reachable.
    for (const id of ['#rd-open', '#rd-paste', '#rd-bold', '#rd-display-toggle']) {
      const box = await page.locator(id).boundingBox();
      expect(box.x + box.width, id).toBeLessThanOrEqual(360);
    }
  });
});
