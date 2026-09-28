// Builds everything Skimbold ships (spec §11):
//
//   dist/skimbold-<ver>-chromium.zip   extension/ as-is: Chrome Web Store, Edge Add-ons, releases
//   dist/firefox/                      extension/ with the Firefox manifest (for web-ext lint)
//   dist/skimbold-<ver>-firefox.zip    the same, zipped: addons.mozilla.org, releases
//   dist/site/                         site/ plus the web Reader, deployed to GitHub Pages
//
// Usage: npm run build
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZip, readZip } from './lib/zip.mjs';
import { findViolations, formatViolation } from './check-no-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const GECKO_ID = 'skimbold@loveislife767.github.io';

// Folders of extension/ that the web Reader needs, copied with the same relative layout so
// reader/reader.html finds ../shared/, ../vendor/pdfjs/ and ../icons/ on GitHub Pages too.
export const WEB_READER_DIRS = ['reader', 'shared', 'vendor', 'icons'];

// Clutter that operating systems, editors and merge tools leave in folders. Any file or folder
// whose name starts with a dot is skipped as well (.DS_Store, .git, .vscode, .eslintrc…).
const JUNK = [/^Thumbs\.db$/i, /^ehthumbs\.db$/i, /^desktop\.ini$/i, /^Icon\r$/, /~$/, /^#.*#$/, /\.sw[a-p]$/i, /\.(?:orig|rej|bak|tmp|log)$/i];

/** True when a forward-slash relative path should be part of a package. */
export function isShippable(relPath) {
  return relPath.split('/').every((part) => part !== '' && !part.startsWith('.') && !JUNK.some((re) => re.test(part)));
}

/** Sorted forward-slash paths of every shippable file under dir. */
export function listFiles(dir) {
  const out = [];
  const visit = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      const rel = relative(dir, full).replaceAll('\\', '/');
      if (!isShippable(rel)) continue;
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) out.push(rel);
    }
  };
  visit(dir);
  return out.sort();
}

// Firefox's default extension-page policy for Manifest V3 is "script-src 'self';
// upgrade-insecure-requests;". The upgrade would turn the Reader's download of a PDF from an
// http:// site into an https:// request that fails, so the policy is given without it (the
// same as Chromium's default). MDN documents leaving the upgrade out as allowed.
export const FIREFOX_CSP = { extension_pages: "script-src 'self'" };

/**
 * The Firefox manifest: an event page instead of a service worker (settings.js first, because
 * Firefox has no importScripts there), the add-on id and minimum versions, the Firefox 140+
 * data-collection declaration, and the extension-page policy above. Chrome-only keys are
 * dropped. Key order is kept for readable diffs.
 */
export function firefoxManifest(manifest) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'minimum_chrome_version' || key === 'browser_specific_settings') continue;
    out[key] = key === 'background' ? { scripts: ['shared/settings.js', 'background.js'] } : structuredClone(value);
  }
  if (!('background' in out)) out.background = { scripts: ['shared/settings.js', 'background.js'] };
  out.content_security_policy = structuredClone(FIREFOX_CSP);
  out.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return out;
}

/** Every file path a manifest points at, so a missing one fails the build instead of the browser. */
export function manifestFileReferences(manifest) {
  const refs = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value !== '') refs.add(value.replace(/^\/+/, '').split(/[?#]/)[0]);
  };
  Object.values(manifest.icons ?? {}).forEach(add);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  add(manifest.action?.default_popup);
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  add(manifest.background?.page);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.side_panel?.default_path);
  for (const script of manifest.content_scripts ?? []) [...(script.js ?? []), ...(script.css ?? [])].forEach(add);
  return [...refs].sort();
}

/** The site plus the web Reader: [{from: absolute source, to: forward-slash path in dist/site}]. */
export function siteFileMap(root = ROOT) {
  const map = new Map();
  const put = (to, from) => {
    if (map.has(to)) throw new Error(`site: ${to} comes from both ${relative(root, map.get(to))} and ${relative(root, from)}`);
    map.set(to, from);
  };
  const siteDir = join(root, 'site');
  for (const rel of listFiles(siteDir)) put(rel, join(siteDir, rel));
  for (const dir of WEB_READER_DIRS) {
    const source = join(root, 'extension', dir);
    for (const rel of listFiles(source)) put(`${dir}/${rel}`, join(source, rel));
  }
  return [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([to, from]) => ({ from, to }));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${error.message}`);
  }
}

function writeFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

// Re-reads a finished archive and compares every entry with its source bytes.
function verifyZip(zip, entries, label) {
  const read = readZip(zip);
  if (read.length !== entries.length) throw new Error(`${label}: ${read.length} entries, expected ${entries.length}`);
  const expected = new Map(entries.map((e) => [e.name, e.data]));
  for (const entry of read) {
    if (!expected.get(entry.name)?.equals(entry.data)) throw new Error(`${label}: ${entry.name} does not round-trip`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Runs the whole build. Returns what it wrote, for tests and the summary.
 * @param {{root?: string, outDir?: string, log?: (line: string) => void}} [options]
 */
export function build({ root = ROOT, outDir = join(root, 'dist'), log = console.log } = {}) {
  const extensionDir = join(root, 'extension');
  const manifest = readJson(join(extensionDir, 'manifest.json'));
  const pkg = readJson(join(root, 'package.json'));
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: extension/manifest.json says ${manifest.version}, package.json says ${pkg.version}. Make them equal.`);
  }
  const version = manifest.version;

  const violations = findViolations(root);
  if (violations.length > 0) {
    throw new Error(`check-no-network found ${violations.length} problem(s):\n${violations.map(formatViolation).join('\n')}`);
  }

  const files = listFiles(extensionDir);
  const fileSet = new Set(files);
  const ffManifest = firefoxManifest(manifest);
  for (const [label, m] of [['manifest.json', manifest], ['Firefox manifest', ffManifest]]) {
    const missing = manifestFileReferences(m).filter((ref) => !fileSet.has(ref));
    if (missing.length > 0) throw new Error(`${label} points at files that do not exist in extension/: ${missing.join(', ')}`);
  }

  rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(outDir, { recursive: true });

  const chromiumEntries = files.map((name) => ({ name, data: readFileSync(join(extensionDir, name)) }));
  const firefoxManifestBytes = Buffer.from(`${JSON.stringify(ffManifest, null, 2)}\n`);
  const firefoxEntries = chromiumEntries.map((e) => (e.name === 'manifest.json' ? { name: e.name, data: firefoxManifestBytes } : e));

  const chromiumZip = createZip(chromiumEntries);
  verifyZip(chromiumZip, chromiumEntries, 'chromium zip');
  const chromiumZipPath = join(outDir, `skimbold-${version}-chromium.zip`);
  writeFile(chromiumZipPath, chromiumZip);

  const firefoxDir = join(outDir, 'firefox');
  for (const { name, data } of firefoxEntries) writeFile(join(firefoxDir, name), data);
  const firefoxZip = createZip(firefoxEntries);
  verifyZip(firefoxZip, firefoxEntries, 'firefox zip');
  const firefoxZipPath = join(outDir, `skimbold-${version}-firefox.zip`);
  writeFile(firefoxZipPath, firefoxZip);

  const siteDir = join(outDir, 'site');
  const siteMap = siteFileMap(root);
  let siteBytes = 0;
  for (const { from, to } of siteMap) {
    const data = readFileSync(from);
    siteBytes += data.length;
    writeFile(join(siteDir, to), data);
  }

  const firefoxBytes = firefoxEntries.reduce((sum, e) => sum + e.data.length, 0);
  const rows = [
    [chromiumZipPath, statSync(chromiumZipPath).size, chromiumEntries.length],
    [firefoxZipPath, statSync(firefoxZipPath).size, firefoxEntries.length],
    [firefoxDir, firefoxBytes, firefoxEntries.length, '/'],
    [siteDir, siteBytes, siteMap.length, '/'],
  ].map(([path, size, count, suffix = '']) => [`${relative(root, path).replaceAll('\\', '/')}${suffix}`, formatSize(size), `${count} files`]);
  const width = Math.max(...rows.map(([p]) => p.length));
  log(`Skimbold ${version}: build complete`);
  for (const [path, size, count] of rows) log(`  ${path.padEnd(width)}  ${size.padStart(9)}  ${count}`);

  return {
    version,
    files,
    chromiumZip: chromiumZipPath,
    firefoxZip: firefoxZipPath,
    firefoxDir,
    siteDir,
    siteFiles: siteMap.map((f) => f.to),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    build();
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
