// Renders the Skimbold mark to every PNG the manifest and the stores need.
//
// extension/icons/icon.svg is the master (full-bleed tile, 96-unit grid). It is used as-is
// for the 128 px store icon (96 px of artwork inside 16 px of transparent padding, per the
// Chrome Web Store rule) and the 300 px Edge Add-ons logo. At 16, 32 and 48 px a straight
// downscale smears the thin bowl across pixel boundaries, so those sizes are redrawn by hand
// on their own pixel grid: stems and bowl edges land on whole pixels and stay crisp.
//
// Usage: npm run icons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const iconsDir = join(root, 'extension', 'icons');
const promoDir = join(root, 'store', 'promo');

const TILE = '#1F5E46';
const GLYPH = '#F2F4EF';

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;

// Each variant keeps the master's anatomy: a heavy stem with a wedge serif (the bold start)
// and a hairline bowl (the light rest of the word).
const HAND_TUNED = {
  16: svg(16,
    `<rect width="16" height="16" rx="3.5" fill="${TILE}"/>` +
    `<path d="M3 3 7 2V14H4V3.4Z" fill="${GLYPH}"/>` +
    // A rounded square keeps the bowl's sides on whole pixels; a true circle goes soft here.
    `<rect x="5.75" y="6.75" width="6.5" height="6.5" rx="2.6" fill="none" stroke="${GLYPH}" stroke-width="1.5"/>`),
  32: svg(32,
    `<rect width="32" height="32" rx="7" fill="${TILE}"/>` +
    `<path d="M6 7.25 15 5V27H9V8.5Z" fill="${GLYPH}"/>` +
    `<circle cx="18.5" cy="19.5" r="6.5" fill="none" stroke="${GLYPH}" stroke-width="2"/>`),
  48: svg(48,
    `<rect x="4" y="4" width="40" height="40" rx="9" fill="${TILE}"/>` +
    `<path d="M11 12.25 21 9.5V38H14V13.25Z" fill="${GLYPH}"/>` +
    `<circle cx="27.5" cy="28.5" r="8.5" fill="none" stroke="${GLYPH}" stroke-width="2"/>`),
};

const master = readFileSync(join(iconsDir, 'icon.svg'), 'utf8');

// [output path, canvas size, svg source, artwork size]
const jobs = [
  [join(iconsDir, 'icon-16.png'), 16, HAND_TUNED[16], 16],
  [join(iconsDir, 'icon-32.png'), 32, HAND_TUNED[32], 32],
  [join(iconsDir, 'icon-48.png'), 48, HAND_TUNED[48], 48],
  [join(iconsDir, 'icon-128.png'), 128, master, 96],
  [join(promoDir, 'logo-300.png'), 300, master, 224],
];

const dataUrl = (source) => `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;

mkdirSync(promoDir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [out, size, source, art] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:transparent">' +
      `<div style="width:${size}px;height:${size}px;display:grid;place-items:center">` +
      `<img src="${dataUrl(source)}" width="${art}" height="${art}" style="display:block" alt="">` +
      '</div></body></html>',
    );
    await page.locator('img').evaluate((img) => img.decode());
    const png = await page.locator('div').screenshot({ omitBackground: true });
    writeFileSync(out, png);
    console.log(`${relative(root, out).replaceAll('\\', '/')}  ${size}x${size}`);
  }
} finally {
  await browser.close();
}
