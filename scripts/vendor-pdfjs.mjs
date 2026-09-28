// Copies the UNMODIFIED official pdf.js build from node_modules into extension/vendor/pdfjs.
// Store reviewers (AMO) compare vendored files against the official release, so never edit them.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'extension', 'vendor', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const [from, to] of [
  ['build/pdf.min.mjs', 'pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['LICENSE', 'LICENSE'],
]) copyFileSync(join(src, from), join(dest, to));
const { version } = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
console.log(`Vendored pdfjs-dist ${version} → extension/vendor/pdfjs`);
