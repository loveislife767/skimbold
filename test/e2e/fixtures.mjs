// Playwright fixtures for Skimbold's end-to-end tests. Each worker runs one headless Chromium
// with a temp copy of extension/ loaded, plus a fixture server. See test/README.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { start } from '../fixtures/server.mjs';

export { expect };

export const EXTENSION_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const SERVICE_WORKER_TIMEOUT = 10_000;

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${error.message}`);
  }
}

// Tests can't perform activeTab gestures or click permission prompts, so the test copy (never the
// source) requests every host up front. See "The temp copy" in test/README.md.
function addAllUrlsHostPermission(dir) {
  const manifest = readManifest(dir);
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), '<all_urls>'])];
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function findServiceWorker(context, scriptPath) {
  const expectedPath = new URL(scriptPath, 'chrome-extension://id/').pathname;
  const isOurs = (worker) => {
    const url = new URL(worker.url());
    return url.protocol === 'chrome-extension:' && url.pathname === expectedPath;
  };
  const running = context.serviceWorkers().find(isOurs);
  if (running) return running;
  try {
    return await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: SERVICE_WORKER_TIMEOUT });
  } catch {
    // It may have started between the check above and the wait beginning.
    return context.serviceWorkers().find(isOurs) ?? null;
  }
}

// --load-extension fails silently when the manifest is invalid or names a missing file. Loading
// the same folder through CDP makes Chromium return the real error message.
async function explainMissingExtension(playwright, extensionPath) {
  const browser = await playwright.chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--enable-unsafe-extension-debugging'],
  });
  let loadError = null;
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extensionPath }).catch((error) => {
      loadError = error.message.replace(/^[\s\S]*?Extensions\.loadUnpacked\):\s*/, '');
    });
  } finally {
    await browser.close();
  }
  return loadError
    ? `Chromium rejected the extension: ${loadError}`
    : 'Chromium accepts the extension when it is loaded over CDP, so the manifest itself is valid.';
}

// Resolves to 'activated' or 'redundant' (the script threw or failed to parse). With Playwright
// attached, a failed worker stays reachable instead of disappearing, so this is the only signal.
async function settledState(worker) {
  const deadline = Date.now() + SERVICE_WORKER_TIMEOUT;
  for (;;) {
    const state = await worker.evaluate(() => globalThis.serviceWorker?.state ?? 'activated');
    if (state === 'activated' || state === 'redundant' || Date.now() > deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function explainFailedServiceWorker(worker, extensionPath, scriptPath) {
  const file = path.join(extensionPath, scriptPath);
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    const output = check.stderr.replaceAll(extensionPath, 'extension').replace(/^Node\.js v.*$/m, '').trim();
    return `It does not parse:\n${output}`;
  }
  try {
    // Running the script again in the failed worker reproduces the error. The prefix keeps a
    // leading function declaration from being read as an expression, on the same line numbers.
    await worker.evaluate(`void 0;${fs.readFileSync(file, 'utf8')}`);
  } catch (error) {
    const [firstLine, ...stack] = error.message.replace(/^worker\.evaluate:\s*/, '').split('\n');
    const where = stack.join('\n').match(/<anonymous>:(\d+):(\d+)/);
    const location = where ? ` (${scriptPath}:${where[1]}:${where[2]})` : '';
    const hint = firstLine.includes('importScripts')
      ? '\nThe imported script is missing, does not parse, or throws when it runs.'
      : '';
    return `It throws while starting: ${firstLine}${location}${hint}`;
  }
  return 'It threw while starting, but running it again did not reproduce the error.';
}

async function clearWebStorage(context, origins) {
  // Storage.clearDataForOrigin only works on a page session, so borrow a throwaway tab.
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    for (const origin of origins) {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' });
    }
  } finally {
    await page.close();
  }
}

export const test = base.extend({
  server: [async ({}, use) => {
    const server = await start();
    await use(server);
    await server.close();
  }, { scope: 'worker' }],

  extensionPath: [async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skimbold-e2e-'));
    try {
      fs.cpSync(EXTENSION_SOURCE, dir, { recursive: true });
      addAllUrlsHostPermission(dir);
      await use(dir);
    } finally {
      // Retries cover Windows releasing Chromium's file handles a moment after it exits.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, { scope: 'worker' }],

  extensionContext: [async ({ playwright, headless, extensionPath, server }, use) => {
    const context = await playwright.chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      baseURL: server.url,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      // Chromium starts with a blank tab; tests open their own pages.
      await Promise.all(context.pages().map((page) => page.close()));
      await use(context);
    } finally {
      await context.close();
    }
  }, { scope: 'worker', timeout: 60_000 }],

  serviceWorker: [async ({ playwright, extensionContext, extensionPath }, use) => {
    const scriptPath = readManifest(extensionPath).background?.service_worker;
    if (!scriptPath) throw new Error('extension/manifest.json declares no background.service_worker');
    const worker = await findServiceWorker(extensionContext, scriptPath);
    if (!worker) {
      const reason = await explainMissingExtension(playwright, extensionPath);
      throw new Error(`Skimbold did not load: no service worker within ${SERVICE_WORKER_TIMEOUT / 1000} s.\n${reason}`);
    }
    const state = await settledState(worker);
    if (state === 'redundant') {
      const reason = await explainFailedServiceWorker(worker, extensionPath, scriptPath);
      throw new Error(`Skimbold's service worker (${scriptPath}) failed to start.\n${reason}`);
    }
    if (state !== 'activated') {
      throw new Error(`Skimbold's service worker (${scriptPath}) is still "${state}" after ${SERVICE_WORKER_TIMEOUT / 1000} s.`);
    }
    await use(worker);
  }, { scope: 'worker', timeout: 60_000 }],

  extensionId: [async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  }, { scope: 'worker' }],

  context: async ({ extensionContext }, use) => {
    await use(extensionContext);
  },

  page: async ({ extensionContext }, use) => {
    await use(await extensionContext.newPage());
  },

  // Runs around every test: starts it from default settings and empty web storage, and closes
  // the pages it opened. Pages opened in beforeAll hooks are left alone.
  cleanState: [async ({ extensionContext, serviceWorker, extensionId, server }, use, testInfo) => {
    await resetSettings(serviceWorker);
    await clearWebStorage(extensionContext, [`chrome-extension://${extensionId}`, server.url]);
    await extensionContext.clearCookies();
    const openBefore = new Set(extensionContext.pages());
    await use();
    // A failing test keeps its pages for the trace and error context. Playwright starts a new
    // worker, and so a new browser, after every failure.
    if (testInfo.status === testInfo.expectedStatus) {
      const opened = extensionContext.pages().filter((page) => !openBefore.has(page));
      await Promise.all(opened.map((page) => page.close()));
    }
  }, { auto: true, box: true }],
});

/** Opens chrome-extension://<id>/<relPath> (query string allowed) in a new tab. */
export async function openExtensionPage(context, extensionId, relPath) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relPath.replace(/^\/+/, '')}`);
  return page;
}

/** Runs fn(arg) inside the service worker; fn can use globalThis.browser ?? globalThis.chrome. */
export function swEval(serviceWorker, fn, arg) {
  return serviceWorker.evaluate(fn, arg);
}

/**
 * Returns the tab id for a Page or a URL string. URLs are matched exactly with tabs.query in the
 * service worker. The extension's own pages are invisible to tabs.query without the "tabs"
 * permission, so pass those as a Page.
 */
export async function tabIdFor(serviceWorker, pageOrUrl, { timeout = 5_000 } = {}) {
  const url = typeof pageOrUrl === 'string' ? pageOrUrl : pageOrUrl.url();
  if (typeof pageOrUrl !== 'string' && url.startsWith('chrome-extension://')) {
    return pageOrUrl.evaluate(async () => (await (globalThis.browser ?? globalThis.chrome).tabs.getCurrent()).id);
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    const ids = await serviceWorker.evaluate(async (wanted) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const tabs = await api.tabs.query({});
      return tabs.filter((tab) => tab.url === wanted || tab.pendingUrl === wanted).map((tab) => tab.id);
    }, url);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) throw new Error(`tabIdFor: ${ids.length} tabs have the URL ${url}`);
    if (Date.now() > deadline) throw new Error(`tabIdFor: no tab has the URL ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Collects console errors and uncaught exceptions from the page and its frames, including
 * extension content scripts. Returns the live array, so assert on it at the end of the test.
 */
export function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber } = message.location();
    errors.push(url ? `${message.text()} (${url}:${lineNumber + 1})` : message.text());
  });
  page.on('pageerror', (error) => errors.push(error.stack ?? String(error)));
  return errors;
}

/** Clears storage.sync, storage.local and storage.session, which restores default settings. */
export async function resetSettings(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    const api = globalThis.browser ?? globalThis.chrome;
    await Promise.all([api.storage.sync.clear(), api.storage.local.clear(), api.storage.session?.clear()]);
  });
}
