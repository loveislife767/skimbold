// Generates the Reader's PDF fixtures. The PDFs are committed, so this only needs to run again
// when their content changes:  node test/fixtures/reader/make-fixtures.mjs
//
//   article.pdf   3 pages: headings, paragraphs (spaced and indented), a bullet list, a word
//                 hyphenated across a line break, a running header and a running footer
//   columns.pdf   1 page: a full-width title, two text columns, a full-width closing note
//   scanned.pdf   1 page: text drawn on a canvas only, so there is no selectable text
//   locked.pdf    1 page, encrypted with the user password "lamplight" (hand-written, RC4 40-bit)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = path.dirname(fileURLToPath(import.meta.url));

const ARTICLE = `<!doctype html>
<meta charset="utf-8">
<style>
  body { font: 11pt/1.45 Georgia, 'Times New Roman', serif; color: #111; margin: 0; }
  h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 14pt; }
  h2 { font-size: 15pt; margin: 18pt 0 8pt; }
  p { margin: 0 0 9pt; }
  .book p { margin: 0; text-indent: 1.6em; }
  .book p:first-of-type { text-indent: 0; }
  ul { margin: 8pt 0; }
  .page { break-before: page; }
</style>
<h1>Notes on Reading by Lamplight</h1>
<p>Reading by the light of a single lamp changes the way a page feels. The edges of the room fall
away, and the lines of text become the only landscape left to explore.</p>
<h2>The Shape of a Line</h2>
<p>Every line of type asks the eye to make a small journey from left to right, then a longer return
sweep back to the start of the next line. Readers rarely notice these movements, yet they account
for much of the effort that a long evening of reading requires.</p>
<p>A careful typesetter avoids breaking words across lines, but sometimes a long word such as extraor-<br>dinary
has to be split to keep the right edge even. The mind of the reader simply mends the gap without
being asked.</p>
<p>Short paragraphs give the eye a place to rest.</p>
<section class="page book">
  <h2>Keeping Your Place</h2>
  <p>When the eye loses its place, it wanders back over words it has already read. A strong start to
  each word gives it something to hold on to, the way a handrail steadies a walker on a dark stair.</p>
  <p>The lighthouse keeper, a quiet man named Jean-<br>Paul Marchand, kept a log of every ship that
  passed his tower. He wrote in a small, even hand and never skipped a night.</p>
  <p>His log listed three things for each vessel:</p>
  <ul>
    <li>the hour it was first sighted,</li>
    <li>the direction of its wake,</li>
    <li>and the colour of its lamps.</li>
  </ul>
  <p>Years later, readers of the log said it was the steadiness of the entries, more than any single
  story, that kept them turning the pages.</p>
</section>
<section class="page">
  <h2>A Quiet Ending</h2>
  <p>Good reading light is warm, steady and placed slightly behind the shoulder, so that no glare
  rises from the paper and the words stay sharp until the last line.</p>
  <p>The final sentence of this article should appear exactly once in the extracted text.</p>
</section>`;

const COLUMNS = `<!doctype html>
<meta charset="utf-8">
<style>
  body { font: 10.5pt/1.4 Georgia, 'Times New Roman', serif; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 12pt; }
  .cols { column-count: 2; column-gap: 28pt; }
  p { margin: 0 0 8pt; }
  .second { break-before: column; }
  .note { margin-top: 14pt; font-style: italic; }
</style>
<h1>Two Columns of Weather</h1>
<div class="cols">
  <p>Column one begins with the morning report. Fog lay over the harbour until nine, and the ferry
  waited at the pier with its engines idling while the pilots argued about the channel.</p>
  <p>By noon the wind had turned to the west and the fog lifted in long grey ribbons that drifted
  over the hills behind the town.</p>
  <p>Fishermen who had stayed ashore mended their nets on the quay and watched the sky for any sign
  of the storm the radio had promised.</p>
  <p class="second">Column two carries the evening forecast. Rain is expected after midnight, heavy
  at times along the coast, with gusts strong enough to rattle the shutters of the old customs
  house.</p>
  <p>Tomorrow should clear by mid-morning, leaving a cold bright afternoon that is ideal for walking
  the cliff path to the lighthouse.</p>
  <p>Readers planning a crossing are advised to check the ferry timetable before leaving home.</p>
</div>
<p class="note">This closing note spans both columns and should come after both of them.</p>`;

const SCANNED = `<!doctype html>
<meta charset="utf-8">
<style>body { margin: 0; } canvas { display: block; width: 100%; }</style>
<canvas width="1100" height="1400"></canvas>
<script>
  const ctx = document.querySelector('canvas').getContext('2d');
  ctx.fillStyle = '#f7f3ea';
  ctx.fillRect(0, 0, 1100, 1400);
  ctx.fillStyle = '#222';
  ctx.font = '34px Georgia, serif';
  const lines = [
    'This page was scanned from paper.',
    'Its words are pixels in an image,',
    'so there is no text to select.',
  ];
  lines.forEach((line, i) => ctx.fillText(line, 90, 160 + i * 56));
</script>`;

async function makePdf(browser, name, html, options) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: path.join(OUT, name), printBackground: true, ...options });
  await page.close();
  console.log(`wrote ${name}`);
}

// ── A hand-written PDF protected with the standard security handler, revision 2 ───────────────
// (PDF 32000-1:2008, 7.6.3, algorithms 1 to 4: RC4 with a 40-bit key). Chromium cannot print an
// encrypted PDF, and Node's OpenSSL build leaves RC4 out, hence the small RC4 below.

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

function makeLockedPdf(userPassword, ownerPassword) {
  const id = md5(Buffer.from('skimbold locked fixture'));
  const permissions = -44; // print and copy allowed; the value only matters for the key
  const ownerValue = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const fileKey = md5(padded(userPassword), ownerValue, p, id).subarray(0, 5);
  const userValue = rc4(fileKey, PAD);
  const objectKey = (num) => md5(fileKey, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);

  const content = Buffer.from([
    'BT /F1 20 Tf 72 700 Td (A Locked Letter) Tj ET',
    'BT /F1 12 Tf 72 660 Td (The key to the lighthouse hangs on a nail beside the door.) Tj ET',
  ].join('\n'), 'latin1');
  const stream = rc4(objectKey(4), content);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${ownerValue.toString('hex')}> /U <${userValue.toString('hex')}> /P ${permissions} >>`,
  ];

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    offset += chunk.length;
    chunks.push(chunk);
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  await makePdf(browser, 'article.pdf', ARTICLE, {
    format: 'A5',
    margin: { top: '22mm', bottom: '22mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div style="width:100%;margin:0 16mm;font:8px Georgia,serif;color:#555;text-align:right">Lamplight Quarterly</div>',
    footerTemplate: '<div style="width:100%;margin:0 16mm;font:8px Georgia,serif;color:#555;text-align:center">Notes on Reading by Lamplight · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
  await makePdf(browser, 'columns.pdf', COLUMNS, {
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
  });
  await makePdf(browser, 'scanned.pdf', SCANNED, {
    format: 'A5',
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  });
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, 'locked.pdf'), makeLockedPdf('lamplight', 'keeper-of-the-light'));
console.log('wrote locked.pdf');
