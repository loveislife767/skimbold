// Renders the store screenshots and promo tiles in headless Chromium.
//
//   npm run store-assets
//
//   store/screenshots/01-before-after.png … 05-settings.png   1280×800, 24-bit PNG (no alpha)
//   store/promo/small-tile-440x280.png                         Chrome Web Store / Edge small tile
//   store/promo/marquee-1400x560.png                           Chrome marquee / Edge large tile
//
// The screenshots are honest: each one is composed from real captures of the extension (the
// article is bolded by content/engine.js; the popup, Reader and settings are the extension's own
// pages). Only the frame and the caption around them are drawn here. The extension is loaded the
// way the e2e harness loads it: a temp copy with <all_urls> host access, because a script cannot
// click the toolbar button that grants activeTab.
//
// store/promo/logo-300.png is made by scripts/icons.mjs and is left alone.
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = join(ROOT, 'extension');
const SHOTS = join(ROOT, 'store', 'screenshots');
const PROMO = join(ROOT, 'store', 'promo');
const core = createRequire(import.meta.url)('../extension/shared/core.js');

const THEME_CSS = readFileSync(join(EXTENSION, 'shared', 'theme.css'), 'utf8');
const ICON_SVG = `data:image/svg+xml;base64,${readFileSync(join(EXTENSION, 'icons', 'icon.svg')).toString('base64')}`;
const ICON_32 = `data:image/png;base64,${readFileSync(join(EXTENSION, 'icons', 'icon-32.png')).toString('base64')}`;

const STAGE = { width: 1280, height: 800 };
// The browser window drawn on each screenshot: 1120 px wide, flush with the bottom edge.
const WINDOW = { left: 80, top: 212, minTop: 150, width: 1120, bar: 44 };
const contentHeight = (top = WINDOW.top) => STAGE.height - top - WINDOW.bar;
const CONTENT = { width: WINDOW.width, height: contentHeight() };
// The fixture article is served as example.org (a domain reserved for examples), so the page,
// the address bar drawn around it and the popup's "Always on for ..." all name the same site.
const SITE = 'example.org';

// Files the screenshots are rendered from. Checked up front so a missing piece gets a clear message.
const REQUIRED = ['manifest.json', 'background.js', 'content/engine.js', 'popup/popup.html', 'options/options.html', 'reader/reader.html'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dataPng = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

/** Text as HTML with Skimbold's bold starts, using the extension's own algorithm. */
function skimHtml(text, opts = {}) {
  const parts = core.transform(text, opts, { count: 0 });
  return parts ? parts.map((p) => (p.b ? `<b>${esc(p.t)}</b>` : esc(p.t))).join('') : esc(text);
}

// ── Fixture article ─────────────────────────────────────────────────────────
// Public-domain text: Henry David Thoreau, Walden (1854), from the chapter "Reading".

const ARTICLE = {
  title: 'On Reading',
  byline: 'From Walden (1854), by Henry David Thoreau',
  paragraphs: [
    'With a little more deliberation in the choice of their pursuits, all men would perhaps become essentially students and observers, for certainly their nature and destiny are interesting to all alike.',
    'My residence was more favorable, not only to thought, but to serious reading, than a university; and though I was beyond the range of the ordinary circulating library, I had more than ever come within the influence of those books which circulate round the world, whose sentences were first written on bark, and are now merely copied from time to time on to linen paper.',
    'To read well, that is, to read true books in a true spirit, is a noble exercise, and one that will task the reader more than any exercise which the customs of the day esteem. It requires a training such as the athletes underwent, the steady intention almost of the whole life to this object. Books must be read as deliberately and reservedly as they were written.',
    'A written word is the choicest of relics. It is something at once more intimate with us and more universal than any other work of art. It is the work of art nearest to life itself.',
    'Books are the treasured wealth of the world and the fit inheritance of generations and nations. How many a man has dated a new era in his life from the reading of a book.',
  ],
};

const ARTICLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ARTICLE.title)} | Commonplace</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --ink: #1d2125; --soft: #5b636b; --line: #e4e7ea; --accent: #2458a6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171a; --ink: #dfe3e8; --soft: #9aa3ad; --line: #2a2e33; --accent: #8ab4f0; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 19px/1.7 system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 28px; border-bottom: 1px solid var(--line); font-size: 15px; }
  .site { font-weight: 700; letter-spacing: -0.01em; font-size: 17px; }
  nav { display: flex; gap: 18px; color: var(--soft); }
  main { max-width: 700px; margin: 0 auto; padding: 36px 28px 64px; }
  .kicker { color: var(--accent); font-size: 14px; font-weight: 600; }
  h1 { margin: 4px 0 6px; font-size: 40px; line-height: 1.15; letter-spacing: -0.02em; }
  .byline { margin: 0 0 26px; color: var(--soft); font-size: 15px; }
  p { margin: 0 0 20px; }
  @media (max-width: 640px) { nav { display: none; } main { padding: 26px 22px 48px; } h1 { font-size: 32px; } body { font-size: 17px; } }
</style></head>
<body>
  <header><span class="site">Commonplace</span><nav><span>Essays</span><span>Letters</span><span>Archive</span><span>About</span></nav></header>
  <main id="article">
    <div class="kicker">Classic essays</div>
    <h1>${esc(ARTICLE.title)}</h1>
    <p class="byline">${esc(ARTICLE.byline)}</p>
    ${ARTICLE.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n    ')}
  </main>
</body></html>`;

const PDF_SOURCE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 1in; }
  body { font: 12pt/1.55 Georgia, 'Times New Roman', serif; color: #111; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  .byline { margin: 0 0 18pt; color: #444; font-style: italic; }
  p { margin: 0 0 10pt; text-align: justify; }
</style></head><body>
  <h1>${esc(ARTICLE.title)}</h1>
  <p class="byline">${esc(ARTICLE.byline)}</p>
  ${[...ARTICLE.paragraphs, ...ARTICLE.paragraphs.slice(0, 3)].map((p) => `<p>${esc(p)}</p>`).join('\n')}
</body></html>`;

function startServer(pdf) {
  const routes = {
    '/essays/on-reading': ['text/html; charset=utf-8', Buffer.from(ARTICLE_HTML)],
    '/files/on-reading.pdf': ['application/pdf', pdf],
  };
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, 'http://localhost').pathname];
    if (!route) {
      res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': route[0], 'Cache-Control': 'no-store' });
    res.end(route[1]);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

// ── Stage: the frame and caption around each capture ──────────────────────────

function stageHtml({ theme = 'light', title, caption, address, content, badge = false, top = WINDOW.top }) {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><style>
${THEME_CSS}
html, body { width: ${STAGE.width}px; height: ${STAGE.height}px; overflow: hidden; }
body { position: relative; background: var(--skb-paper); }
.caption { position: absolute; left: ${WINDOW.left}px; top: 58px; width: 860px; }
.caption h1 { margin: 0; font: 700 40px/1.15 var(--skb-font-read); letter-spacing: -0.015em; color: var(--skb-ink); }
.caption p { margin: 12px 0 0; font: 400 20px/1.45 var(--skb-font-ui); color: var(--skb-ink-soft); }
.brand { position: absolute; right: ${STAGE.width - WINDOW.left - WINDOW.width}px; top: 62px; display: flex; align-items: center; gap: 10px; font-size: 24px; }
.window { position: absolute; left: ${WINDOW.left}px; top: ${top}px; width: ${WINDOW.width}px; height: ${STAGE.height - top + 20}px;
  border: 1px solid var(--skb-line-strong); border-radius: 12px; overflow: hidden; background: var(--skb-surface); box-shadow: var(--skb-shadow-2); }
.bar { position: relative; display: flex; align-items: center; gap: 14px; height: ${WINDOW.bar}px; padding: 0 16px; background: var(--skb-surface-sunk); border-bottom: 1px solid var(--skb-line); }
.dots { display: flex; gap: 7px; }
.dots i { width: 11px; height: 11px; border-radius: 50%; background: var(--skb-line-strong); opacity: 0.55; }
.address { flex: 1; max-width: 560px; height: 28px; padding: 0 14px; border-radius: 999px; background: var(--skb-surface); color: var(--skb-ink-soft); font: 14px/28px var(--skb-font-ui); white-space: nowrap; overflow: hidden; }
.tool { position: absolute; right: 16px; top: 8px; width: 28px; height: 28px; }
.tool img { width: 20px; height: 20px; margin: 4px; }
.tool .badge { position: absolute; right: -7px; bottom: -3px; padding: 0 3px; border-radius: 3px; background: #1F5E46; color: #fff; font: 700 9px/13px var(--skb-font-ui); }
.content { position: relative; width: ${CONTENT.width}px; height: ${contentHeight(top)}px; overflow: hidden; }
.content > img { display: block; }
.split { display: grid; grid-template-columns: 1fr 1fr; }
.split > div { position: relative; overflow: hidden; }
.split > div + div { border-left: 1px solid var(--skb-line-strong); }
.label { position: absolute; top: 14px; right: 16px; padding: 3px 12px; border-radius: 999px; font: 600 14px/22px var(--skb-font-ui); box-shadow: var(--skb-shadow-1); }
.label--before { background: var(--skb-surface); color: var(--skb-ink); border: 1px solid var(--skb-line-strong); }
.label--after { background: var(--skb-accent); color: var(--skb-on-accent); }
.popup { position: absolute; top: 6px; right: 12px; border: 1px solid var(--skb-line-strong); border-radius: 10px; overflow: hidden; box-shadow: var(--skb-shadow-2); }
.popup img { display: block; width: 100%; height: auto; }
</style></head><body>
<div class="caption"><h1>${esc(title)}</h1><p>${esc(caption)}</p></div>
<div class="brand"><img src="${ICON_SVG}" width="32" height="32" alt=""><span class="skb-wordmark"><b>Skim</b>bold</span></div>
<div class="window">
  <div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="address">${esc(address)}</span>
    <span class="tool"><img src="${ICON_32}" alt="">${badge ? '<span class="badge">ON</span>' : ''}</span></div>
  <div class="content">${content}</div>
</div>
</body></html>`;
}

// ── Promo tiles ─────────────────────────────────────────────────────────────

function promoHtml({ width, height, body, css }) {
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><style>
${THEME_CSS}
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
/* One step deeper than the tile colour, so the icon's own tile still reads as a shape. */
body { background: #174B37; color: #F2F4EF; }
.mark { display: block; filter: drop-shadow(0 6px 14px rgb(0 0 0 / 0.28)); }
.name { font-family: var(--skb-font-read); font-weight: 400; letter-spacing: -0.015em; color: #F2F4EF; }
.name b { font-weight: 800; }
.tag { font-family: var(--skb-font-read); color: #CFE3D7; }
.tag b { color: #FFFFFF; font-weight: 800; }
${css}
</style></head><body>${body}</body></html>`;
}

const SMALL_TILE = promoHtml({
  width: 440,
  height: 280,
  css: `
body { display: grid; place-content: center; justify-items: center; gap: 14px; }
.lockup { display: flex; align-items: center; gap: 16px; }
.name { font-size: 56px; line-height: 1; }
.tag { font-size: 21px; }`,
  body: `<div class="lockup"><img class="mark" src="${ICON_SVG}" width="76" height="76" alt=""><span class="name"><b>Skim</b>bold</span></div>
<div class="tag">${skimHtml('Bold the start of every word')}</div>`,
});

const MARQUEE_TEXT = 'To read well, that is, to read true books in a true spirit, is a noble exercise. Books must be read as deliberately and reservedly as they were written.';

const MARQUEE = promoHtml({
  width: 1400,
  height: 560,
  css: `
body { display: grid; grid-template-columns: 560px 1fr; align-items: center; gap: 72px; padding: 0 96px; }
.lockup { display: flex; align-items: center; gap: 22px; }
.name { font-size: 84px; line-height: 1; }
.tag { margin-top: 26px; font-size: 32px; line-height: 1.35; }
.sub { margin-top: 18px; font: 500 20px/1.4 var(--skb-font-ui); color: #CFE3D7; }
.sheet { position: relative; padding: 34px 40px 38px 58px; border-radius: 14px; background: #F2F4EF; color: #17221C; box-shadow: 0 18px 50px rgb(0 0 0 / 0.28); transform: rotate(-1.5deg); }
.sheet::before { content: ''; position: absolute; left: 34px; top: 0; bottom: 0; border-left: 3px double #B9D3C4; }
.sheet p { margin: 0; font: 400 29px/50px var(--skb-font-read); background-image: linear-gradient(to bottom, transparent 49px, #D3DAD3 49px); background-size: 100% 50px; }
.sheet b { font-weight: 800; }`,
  body: `<div><div class="lockup"><img class="mark" src="${ICON_SVG}" width="104" height="104" alt=""><span class="name"><b>Skim</b>bold</span></div>
<div class="tag">${skimHtml('Bold the start of every word.')}</div>
<div class="sub">Free, private and open source.</div></div>
<div class="sheet"><p>${skimHtml(MARQUEE_TEXT)}</p></div>`,
});

// ── PNG checks ──────────────────────────────────────────────────────────────

// Stores want exact sizes and no alpha channel (colour type 2, 8-bit RGB).
function checkPng(buffer, width, height, label) {
  const w = buffer.readUInt32BE(16);
  const h = buffer.readUInt32BE(20);
  const depth = buffer[24];
  const colourType = buffer[25];
  if (w !== width || h !== height) throw new Error(`${label} is ${w}×${h}, expected ${width}×${height}`);
  if (depth !== 8 || colourType !== 2) throw new Error(`${label} is not a 24-bit RGB PNG (bit depth ${depth}, colour type ${colourType})`);
}

async function renderHtml(browser, html, { width, height, colorScheme = 'light' }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}

function save(file, buffer, width, height) {
  checkPng(buffer, width, height, relative(ROOT, file));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, buffer);
  return relative(ROOT, file).replaceAll('\\', '/');
}

// ── Extension ───────────────────────────────────────────────────────────────

async function explainLoadFailure(extensionPath) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-extension-debugging'] });
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
    return 'Chromium accepts the extension over CDP, so the manifest is valid; the service worker did not start.';
  } catch (error) {
    return `Chromium rejected the extension: ${error.message.replace(/^[\s\S]*?Extensions\.loadUnpacked\):\s*/, '')}`;
  } finally {
    await browser.close();
  }
}

async function launchExtension(port) {
  const dir = mkdtempSync(join(tmpdir(), 'skimbold-assets-'));
  cpSync(EXTENSION, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, `--host-resolver-rules=MAP ${SITE}:80 127.0.0.1:${port}`],
  });
  const cleanup = async () => {
    await context.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    let worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
    worker ??= await context.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/background.js'), timeout: 15_000 }).catch(() => null);
    if (!worker) throw new Error(`the extension did not load.\n${await explainLoadFailure(dir)}`);
    await Promise.all(context.pages().map((p) => p.close()));
    return { context, worker, id: new URL(worker.url()).host, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function api(worker, fn, arg) {
  return worker.evaluate(fn, arg);
}

async function resetSettings(worker, partial) {
  await api(worker, async (settings) => {
    const ext = globalThis.browser ?? globalThis.chrome;
    await Promise.all([ext.storage.sync.clear(), ext.storage.local.clear()]);
    const shared = globalThis.Skimbold && globalThis.Skimbold.settings;
    if (shared) await shared.save(settings);
    else await ext.storage.sync.set({ settings });
  }, partial);
}

async function tabIdFor(worker, url) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const id = await api(worker, async (wanted) => {
      const tabs = await (globalThis.browser ?? globalThis.chrome).tabs.query({});
      return tabs.find((t) => t.url === wanted)?.id ?? null;
    }, url);
    if (id !== null) return id;
    if (Date.now() > deadline) throw new Error(`no tab has the URL ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Injects the same files the toolbar button does, then turns the engine on through its API.
async function turnOn(worker, page) {
  const tabId = await tabIdFor(worker, page.url());
  const active = await api(worker, async (id) => {
    const ext = globalThis.browser ?? globalThis.chrome;
    await ext.scripting.executeScript({ target: { tabId: id }, files: ['shared/settings.js', 'shared/core.js', 'content/engine.js'] });
    const [result] = await ext.scripting.executeScript({
      target: { tabId: id },
      func: () => {
        const engine = globalThis.Skimbold && globalThis.Skimbold.engine;
        if (!engine) return false;
        engine.enable();
        return engine.isActive();
      },
    });
    return result && result.result;
  }, tabId);
  if (!active) throw new Error('content/engine.js did not turn on (Skimbold.engine.enable() / isActive())');
  // One <skb-b> per bolded word start; the article has a few hundred.
  await page.waitForFunction(() => document.querySelectorAll('skb-b').length > 100, null, { timeout: 10_000 })
    .catch(() => { throw new Error('the engine turned on but bolded fewer than 100 word starts within 10 s'); });
  // Let the engine finish its time slices: wait until the count stops changing.
  const count = () => page.evaluate(() => document.querySelectorAll('skb-b').length);
  for (let previous = -1, current = await count(); current !== previous; previous = current, current = await count()) {
    await page.waitForTimeout(300);
  }
  return tabId;
}

// Records files an extension page failed to load, so a half-finished page (a missing stylesheet,
// say) fails loudly instead of ending up in a store screenshot.
function trackMissingFiles(page) {
  const missing = [];
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('chrome-extension://')) missing.push(new URL(request.url()).pathname.slice(1));
  });
  return missing;
}

async function capture(page, width, height, missing = []) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => document.fonts.ready);
  if (missing.length > 0) throw new Error(`${new URL(page.url()).pathname.slice(1)} could not load ${[...new Set(missing)].join(', ')}`);
  return page.screenshot({ type: 'png' });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const written = [];
  const failed = [];
  const attempt = async (label, fn) => {
    try {
      const out = await fn();
      written.push(out);
      console.log(`  ${out}`);
    } catch (error) {
      failed.push(label);
      console.error(`  ${label}: FAILED — ${error.message}`);
    }
  };

  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  let extension = null;
  let server = null;
  try {
    console.log('Promo tiles');
    await attempt('small tile', async () => save(join(PROMO, 'small-tile-440x280.png'), await renderHtml(browser, SMALL_TILE, { width: 440, height: 280 }), 440, 280));
    await attempt('marquee', async () => save(join(PROMO, 'marquee-1400x560.png'), await renderHtml(browser, MARQUEE, { width: 1400, height: 560 }), 1400, 560));

    const missing = REQUIRED.filter((file) => !existsSync(join(EXTENSION, file)));
    if (missing.length > 0) {
      throw new Error(`the screenshots are made from the real extension, and these files are missing: ${missing.map((f) => `extension/${f}`).join(', ')}`);
    }

    const pdfPage = await browser.newPage();
    await pdfPage.setContent(PDF_SOURCE_HTML);
    const pdf = await pdfPage.pdf({ format: 'Letter', printBackground: true });
    await pdfPage.close();
    server = await startServer(pdf);
    extension = await launchExtension(server.port);
    const { context, worker, id } = extension;
    // A distinct query per shot, so each tab can be found by its exact URL.
    const articleUrl = (shot) => `http://${SITE}/essays/on-reading?shot=${shot}`;
    const stage = (options) => renderHtml(browser, stageHtml(options), { ...STAGE, colorScheme: options.theme === 'dark' ? 'dark' : 'light' });
    const address = `${SITE}/essays/on-reading`;

    console.log('Screenshots');

    await attempt('01 before and after', async () => {
      await resetSettings(worker, {});
      const half = Math.floor((CONTENT.width - 1) / 2);
      const page = await context.newPage();
      await page.setViewportSize({ width: half, height: CONTENT.height });
      await page.goto(articleUrl(1));
      const before = await capture(page, half, CONTENT.height);
      await turnOn(worker, page);
      const after = await capture(page, half, CONTENT.height);
      await page.close();
      const content = `<div class="split">
        <div><img src="${dataPng(before)}" alt=""><span class="label label--before">Original</span></div>
        <div><img src="${dataPng(after)}" alt=""><span class="label label--after">With Skimbold</span></div></div>`;
      return save(join(SHOTS, '01-before-after.png'), await stage({
        title: 'Bold word starts give your eyes an anchor',
        caption: 'Press Alt+R on almost any page. Press it again and the page is back exactly as it was.',
        address,
        content,
      }), STAGE.width, STAGE.height);
    });

    await attempt('02 popup', async () => {
      await resetSettings(worker, {});
      const article = await context.newPage();
      await article.setViewportSize({ width: CONTENT.width, height: CONTENT.height });
      await article.goto(articleUrl(2));
      const tabId = await turnOn(worker, article);

      const popup = await context.newPage();
      const popupMissing = trackMissingFiles(popup);
      await popup.setViewportSize({ width: 800, height: 1000 });
      await popup.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
      await popup.waitForLoadState('load');
      await popup.waitForTimeout(700);
      const size = await popup.evaluate(() => {
        const box = document.body.getBoundingClientRect();
        return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
      });
      if (size.width >= 800) throw new Error('popup/popup.css gives the body no fixed width, so the popup size is unknown');
      const popupPng = await capture(popup, size.width, size.height, popupMissing);
      await popup.close();

      // Raise the window just enough for the whole popup to hang below the toolbar. A very tall
      // popup is shown slightly smaller rather than cut off.
      const top = Math.max(WINDOW.minTop, Math.min(WINDOW.top, STAGE.height - WINDOW.bar - 14 - size.height));
      const scale = Math.min(1, (contentHeight(top) - 14) / size.height);
      const shot = await capture(article, CONTENT.width, contentHeight(top));
      await article.close();
      const content = `<img src="${dataPng(shot)}" alt=""><div class="popup" style="width:${Math.round(size.width * scale)}px"><img src="${dataPng(popupPng)}" alt=""></div>`;
      return save(join(SHOTS, '02-popup.png'), await stage({
        title: 'Everything in one small panel',
        caption: 'Turn it on, choose how much of each word to bold, or keep it on for a site.',
        address,
        content,
        badge: true,
        top,
      }), STAGE.width, STAGE.height);
    });

    await attempt('03 reader', async () => {
      await resetSettings(worker, {});
      const page = await context.newPage();
      const missing = trackMissingFiles(page);
      await page.setViewportSize({ width: CONTENT.width, height: CONTENT.height });
      await page.goto(`chrome-extension://${id}/reader/reader.html`);
      const input = page.locator('input[type="file"]').first();
      if (await input.count()) {
        await input.setInputFiles({ name: 'on-reading.pdf', mimeType: 'application/pdf', buffer: pdf });
      } else {
        await page.goto(`chrome-extension://${id}/reader/reader.html?pdf=${encodeURIComponent(`http://${SITE}/files/on-reading.pdf`)}`);
      }
      await page.waitForFunction(() => document.querySelectorAll('.skb-rb').length > 20, null, { timeout: 20_000 })
        .catch(() => { throw new Error('the Reader showed no bolded text (.skb-rb) within 20 s of opening the PDF'); });
      await page.waitForTimeout(400);
      const shot = await capture(page, CONTENT.width, CONTENT.height, missing);
      await page.close();
      return save(join(SHOTS, '03-reader-pdf.png'), await stage({
        title: 'A Reader for PDFs and pasted text',
        caption: 'Open a PDF or paste anything you copied, then choose the theme, font, size and width.',
        address: 'Skimbold Reader: on-reading.pdf',
        content: `<img src="${dataPng(shot)}" alt="">`,
      }), STAGE.width, STAGE.height);
    });

    await attempt('04 dark mode with fade', async () => {
      await resetSettings(worker, { fade: 35 });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: CONTENT.width, height: CONTENT.height });
      await page.goto(articleUrl(4));
      await turnOn(worker, page);
      const shot = await capture(page, CONTENT.width, CONTENT.height);
      await page.close();
      return save(join(SHOTS, '04-dark-fade.png'), await stage({
        theme: 'dark',
        badge: true,
        title: 'Comfortable on dark pages too',
        caption: 'Fade the rest of each word for a softer page, so the bold starts lead your eye along the line.',
        address,
        content: `<img src="${dataPng(shot)}" alt="">`,
      }), STAGE.width, STAGE.height);
    });

    await attempt('05 settings', async () => {
      await resetSettings(worker, {});
      const page = await context.newPage();
      const missing = trackMissingFiles(page);
      await page.setViewportSize({ width: CONTENT.width, height: CONTENT.height });
      await page.goto(`chrome-extension://${id}/options/options.html`);
      await page.waitForLoadState('load');
      await page.waitForTimeout(700);
      // Start at the Reading card, so the frame holds controls rather than the page header.
      await page.evaluate(() => {
        const heading = document.getElementById('reading-title');
        window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 28);
      });
      const shot = await capture(page, CONTENT.width, CONTENT.height, missing);
      await page.close();
      return save(join(SHOTS, '05-settings.png'), await stage({
        title: 'Set it up the way you read',
        caption: 'Letters, strength, boldness and fade, plus always-on sites and your shortcut.',
        address: 'Skimbold settings',
        content: `<img src="${dataPng(shot)}" alt="">`,
      }), STAGE.width, STAGE.height);
    });
  } catch (error) {
    failed.push('setup');
    console.error(`Store assets: ${error.message}`);
  } finally {
    if (extension) await extension.cleanup();
    if (server) server.close();
    await browser.close();
  }

  console.log(`\n${written.length} written${failed.length ? `, ${failed.length} failed (${failed.join(', ')})` : ''}.`);
  if (failed.length) process.exitCode = 1;
}

await main();
