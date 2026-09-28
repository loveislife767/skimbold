// Guards Skimbold's promises in code: no network requests of our own, no string-to-code
// evaluation, and no use of a competitor's trademark.
//
//   node scripts/check-no-network.mjs      (also run by npm run build)
//
// Exits 1 and prints file:line:column for every violation.
//
// 1. Network. extension/ and site/ (our code; extension/vendor/ is the unmodified pdf.js build
//    and is skipped) may not use fetch(), XMLHttpRequest, WebSocket, EventSource, sendBeacon,
//    WebTransport or RTCPeerConnection, and may not load scripts, styles, workers, frames or
//    media from a remote URL.
//
//    Allowlist: extension/reader/ may call fetch(). The Reader downloads a PDF only when the
//    user asks it to open one from a tab (spec §10): first same-origin inside that tab through
//    scripting.executeScript, then with a direct fetch(url). Every other network rule still
//    applies to reader/.
//
// 2. Evaluation. No eval(), Function()/new Function() or setTimeout/setInterval with a string,
//    anywhere in our extension or site code, reader/ included.
//
// 3. Trademark. The name of the commercial reading method this resembles must not appear in
//    the extension, the site, the store kit, the scripts, docs/ or the top-level docs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.htm', '.css']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.txt', '.svg', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report', 'blob-report']);

// Reader allowlist: see the header comment.
const ALLOWED = [{ prefix: 'extension/reader/', rules: new Set(['fetch']) }];

const REMOTE = String.raw`["']?\s*(?:https?:)?//`;
// A <link> only fetches when its rel asks for a resource; canonical and similar are just metadata.
const FETCHING_REL = /\brel\s*=\s*["']?[^"'>]*\b(?:stylesheet|preload|prefetch|modulepreload|icon|manifest|preconnect|dns-prefetch|prerender)\b/i;

const NETWORK_RULES = [
  { id: 'fetch', re: /\bfetch\s*\(/g, why: 'fetch() makes a network request' },
  { id: 'xhr', re: /\bXMLHttpRequest\b/g, why: 'XMLHttpRequest makes a network request' },
  { id: 'websocket', re: /\bWebSocket\b/g, why: 'WebSocket opens a network connection' },
  { id: 'eventsource', re: /\bEventSource\b/g, why: 'EventSource opens a network connection' },
  { id: 'beacon', re: /\bsendBeacon\b/g, why: 'sendBeacon sends data over the network' },
  { id: 'webtransport', re: /\b(?:WebTransport|RTCPeerConnection)\b/g, why: 'opens a network connection' },
  { id: 'remote-importScripts', re: new RegExp(String.raw`\bimportScripts\s*\([^)]*?["'\x60](?:https?:)?//`, 'g'), why: 'importScripts from a remote URL' },
  { id: 'remote-import', re: new RegExp(String.raw`\bimport\s*\(\s*["'\x60](?:https?:)?//|\b(?:from|import)\s+["'](?:https?:)?//`, 'g'), why: 'module import from a remote URL' },
  { id: 'remote-worker', re: new RegExp(String.raw`\bnew\s+(?:Shared)?Worker\s*\(\s*["'\x60](?:https?:)?//`, 'g'), why: 'worker loaded from a remote URL' },
  { id: 'remote-src', re: new RegExp(String.raw`\.src\s*=\s*["'\x60](?:https?:)?//`, 'g'), why: 'element source set to a remote URL' },
  { id: 'remote-script', re: new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*${REMOTE}`, 'gi'), why: '<script> loaded from a remote URL' },
  { id: 'remote-media', re: new RegExp(String.raw`<(?:img|iframe|frame|audio|video|source|track|embed|input)\b[^>]*\bsrc(?:set)?\s*=\s*${REMOTE}|<object\b[^>]*\bdata\s*=\s*${REMOTE}`, 'gi'), why: 'element loads a remote URL' },
  { id: 'remote-link', re: new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*${REMOTE}[^>]*>`, 'gi'), why: '<link> loads a remote URL', filter: (m) => FETCHING_REL.test(m) },
  { id: 'remote-css-import', re: new RegExp(String.raw`@import\s+(?:url\(\s*)?${REMOTE}`, 'gi'), why: 'CSS @import from a remote URL' },
  // Case-sensitive on purpose: JavaScript's new URL('https://…') only builds an object.
  { id: 'remote-css-url', re: new RegExp(String.raw`(?<![\w.$])(?<!@import\s+)url\(\s*${REMOTE}`, 'g'), why: 'CSS url() loads a remote URL' },
];

const EVAL_RULES = [
  { id: 'eval', re: /\beval\s*\(/g, why: 'eval() runs a string as code' },
  { id: 'function-constructor', re: /(?<![.\w$])(?:new\s+)?Function\s*\(/g, why: 'the Function constructor runs a string as code' },
  { id: 'string-timer', re: /\bset(?:Timeout|Interval)\s*\(\s*["'\x60]/g, why: 'a string passed to a timer runs as code' },
];

// Spelled in two halves so that this file does not contain the word itself.
const TRADEMARK_RULES = [
  { id: 'trademark', re: new RegExp(['bi', 'onic'].join(''), 'gi'), why: 'trademarked name; describe the technique instead ("bolds the start of every word")' },
];

function walk(dir, { skip = () => false } = {}) {
  const out = [];
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name) && !skip(full)) out.push(...walk(full, { skip }));
    } else if (item.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function lineAndColumn(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  const end = text.indexOf('\n', index);
  return { line, column: index - lineStart + 1, source: text.slice(lineStart, end === -1 ? undefined : end).trim() };
}

function scan(root, file, rules, allowed) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  const violations = [];
  for (const rule of rules) {
    if (allowed(rel, rule.id)) continue;
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      if (rule.filter && !rule.filter(match[0])) continue;
      const where = lineAndColumn(text, match.index);
      violations.push({ file: rel, line: where.line, column: where.column, rule: rule.id, why: rule.why, source: where.source });
    }
  }
  return violations;
}

/**
 * Scans the repository at `root` and returns every violation, sorted by file and position.
 * @param {string} [root]
 * @returns {Array<{file: string, line: number, column: number, rule: string, why: string, source: string}>}
 */
export function findViolations(root = ROOT) {
  const vendor = resolve(root, 'extension', 'vendor');
  const notVendor = { skip: (dir) => resolve(dir) === vendor };
  const byExtension = (set) => (file) => set.has(extname(file).toLowerCase());
  const isAllowed = (rel, ruleId) => ALLOWED.some((a) => rel.startsWith(a.prefix) && a.rules.has(ruleId));
  const never = () => false;

  const extensionAndSite = [...walk(join(root, 'extension'), notVendor), ...walk(join(root, 'site'))];
  const ownCode = extensionAndSite.filter(byExtension(CODE_EXTENSIONS));
  const prose = [
    ...extensionAndSite,
    ...walk(join(root, 'store')),
    ...walk(join(root, 'scripts')),
    ...walk(join(root, 'docs')),
    ...['README.md', 'PRIVACY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'package.json'].map((name) => join(root, name)).filter(existsSync),
  ].filter(byExtension(TEXT_EXTENSIONS));

  const violations = [];
  for (const file of ownCode) {
    violations.push(...scan(root, file, NETWORK_RULES, isAllowed));
    violations.push(...scan(root, file, EVAL_RULES, never));
  }
  for (const file of prose) violations.push(...scan(root, file, TRADEMARK_RULES, never));
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export function formatViolation(v) {
  return `${v.file}:${v.line}:${v.column}  [${v.rule}] ${v.why}\n    ${v.source.length > 160 ? `${v.source.slice(0, 157)}...` : v.source}`;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('check-no-network: no network APIs, remote loads, eval or trademark use found.');
    return;
  }
  console.error(`check-no-network: ${violations.length} violation${violations.length === 1 ? '' : 's'}\n`);
  for (const v of violations) console.error(formatViolation(v));
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
