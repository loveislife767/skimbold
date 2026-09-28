// Zero-dependency static server for the e2e fixtures.
//
//   /extension/…              extension/ (read-only), so web-mode Reader tests load the real files
//   /vendor/react/umd/…       node_modules/react/umd
//   /vendor/react-dom/umd/…   node_modules/react-dom/umd
//   /…                        test/fixtures/
//
// Extra response headers per path come from headers.json. Only GET and HEAD are served, and
// nothing outside the mounted directories is reachable.
//
// Usage from tests: const { url, close } = await start();   // url has no trailing slash
// Manual use:       node test/fixtures/server.mjs [--port=8080]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(FIXTURES_DIR, '..', '..');
const HEADERS_FILE = path.join(FIXTURES_DIR, 'headers.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function buildMounts() {
  const mounts = [{ prefix: '/extension/', dir: path.join(PROJECT_ROOT, 'extension') }];
  const require = createRequire(import.meta.url);
  for (const pkg of ['react', 'react-dom']) {
    try {
      const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
      mounts.push({ prefix: `/vendor/${pkg}/umd/`, dir: path.join(pkgDir, 'umd') });
    } catch {
      // Dev dependency not installed: its /vendor/ paths simply answer 404.
    }
  }
  mounts.push({ prefix: '/', dir: FIXTURES_DIR });
  return mounts;
}

// headers.json: { "/path.html": { "Header-Name": "value", … }, … }
function loadHeaderRules() {
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(HEADERS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`test/fixtures/headers.json could not be read: ${error.message}`);
  }
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isPlainObject(rules)) throw new Error('test/fixtures/headers.json must be an object keyed by URL path');
  for (const [urlPath, headers] of Object.entries(rules)) {
    if (!urlPath.startsWith('/')) throw new Error(`headers.json: key "${urlPath}" must be a URL path starting with "/"`);
    if (!isPlainObject(headers) || !Object.values(headers).every((v) => typeof v === 'string')) {
      throw new Error(`headers.json: "${urlPath}" must map header names to string values`);
    }
  }
  return new Map(Object.entries(rules));
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function directoryListing(urlPath, entries) {
  const items = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
      const href = encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : '');
      return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
    });
  const title = escapeHtml(`Index of ${urlPath}`);
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${items.join('')}</ul>\n`;
}

function createHandler(mounts, headerRules) {
  return async function handle(req, res) {
    let urlPath = null;
    let rawPath = '';
    let search = '';
    try {
      const url = new URL(req.url, 'http://fixtures.invalid');
      rawPath = url.pathname;
      search = url.search;
      urlPath = decodeURIComponent(rawPath);
    } catch {
      // Malformed percent-encoding: answered with 400 below.
    }

    const send = (status, type, body, extraHeaders = {}) => {
      if (status !== 204) {
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', Buffer.byteLength(body));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
      // headers.json rules win over the defaults above; they apply to any response for that path.
      for (const [name, value] of Object.entries(headerRules.get(urlPath) ?? {})) res.setHeader(name, value);
      res.writeHead(status);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const sendText = (status, text, extraHeaders) => send(status, 'text/plain; charset=utf-8', text, extraHeaders);

    if (urlPath === null || urlPath.includes('\0')) return sendText(400, 'Bad request\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(405, 'Method not allowed\n', { Allow: 'GET, HEAD' });

    // "/extension" → "/extension/", so relative URLs inside the mount resolve.
    if (mounts.some((mount) => mount.prefix === `${urlPath}/`)) {
      return sendText(301, 'Moved\n', { Location: `${rawPath}/${search}` });
    }

    const mount = mounts.find((m) => urlPath.startsWith(m.prefix));
    const filePath = path.join(mount.dir, urlPath.slice(mount.prefix.length));
    const relative = path.relative(mount.dir, filePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return sendText(404, 'Not found\n');
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        if (!urlPath.endsWith('/')) return sendText(301, 'Moved\n', { Location: `${rawPath}/${search}` });
        const index = path.join(filePath, 'index.html');
        if (fs.existsSync(index)) return send(200, contentTypeFor(index), await fs.promises.readFile(index));
        const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
        return send(200, 'text/html; charset=utf-8', directoryListing(urlPath, entries));
      }
      return send(200, contentTypeFor(filePath), await fs.promises.readFile(filePath));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) {
        // Chrome requests /favicon.ico for every page; a 404 there would log a console error
        // on every fixture and pollute collectConsoleErrors().
        if (urlPath === '/favicon.ico') return send(204, '', '');
        return sendText(404, 'Not found\n');
      }
      return sendText(500, `Server error: ${error.message}\n`);
    }
  };
}

export async function start({ port = 0, host = '127.0.0.1' } = {}) {
  const handler = createHandler(buildMounts(), loadHeaderRules());
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Server error: ${error.message}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port: boundPort } = server.address();
  return {
    url: `http://${host}:${boundPort}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) {
  const portArg = process.argv.slice(2).find((arg) => arg.startsWith('--port='));
  const rawPort = portArg ? portArg.slice('--port='.length) : (process.env.PORT ?? '8080');
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) {
    console.error(`Invalid port: ${rawPort}`);
    process.exit(1);
  }
  const { url } = await start({ port: Number(rawPort) });
  console.log(`Serving Skimbold test fixtures at ${url}/  (Ctrl+C to stop)`);
}
