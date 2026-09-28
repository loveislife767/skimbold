// Proves the e2e harness itself: extension loading, the fixture server, the helpers and the
// clean state every test starts from.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  test, expect, EXTENSION_SOURCE, openExtensionPage, swEval, tabIdFor, collectConsoleErrors, resetSettings,
} from './fixtures.mjs';
import { contentTypeFor, FIXTURES_DIR } from '../fixtures/server.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Node's http client sends the path untouched, unlike browsers and fetch(), which normalise "..".
function rawGet(serverUrl, rawPath) {
  const { hostname, port } = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    http.get({ hostname, port, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test.describe('extension loading', () => {
  test('loads a temp copy of extension/ with background.js as the service worker', async ({ serviceWorker, extensionId, extensionPath }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);

    expect(path.resolve(extensionPath)).not.toBe(path.resolve(EXTENSION_SOURCE));
    const copy = readJson(path.join(extensionPath, 'manifest.json'));
    const source = readJson(path.join(EXTENSION_SOURCE, 'manifest.json'));
    expect(copy.host_permissions).toContain('<all_urls>');
    // The shipped manifest must stay free of static host permissions.
    expect(source.host_permissions ?? []).not.toContain('<all_urls>');
    expect({ ...copy, host_permissions: undefined }).toEqual({ ...source, host_permissions: undefined });
  });

  test('the test copy holds host permission for every site', async ({ serviceWorker, server }) => {
    const granted = await swEval(serviceWorker, async (host) => {
      const api = globalThis.browser ?? globalThis.chrome;
      return {
        allUrls: await api.permissions.contains({ origins: ['<all_urls>'] }),
        fixtureServer: await api.permissions.contains({ origins: [`http://${host}/*`] }),
      };
    }, new URL(server.url).hostname);
    expect(granted).toEqual({ allUrls: true, fixtureServer: true });
  });

  test('the service worker can inject scripts without a user gesture', async ({ page, serviceWorker }) => {
    await page.goto('/basic.html');
    const tabId = await tabIdFor(serviceWorker, page);
    const titles = await swEval(serviceWorker, async (id) => {
      const api = globalThis.browser ?? globalThis.chrome;
      const results = await api.scripting.executeScript({ target: { tabId: id }, func: () => document.title });
      return results.map((result) => result.result);
    }, tabId);
    expect(titles).toEqual(["The Keeper's Log"]);
  });

  test('permissions.request resolves without a prompt when a click triggers it', async ({ context, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    await options.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'harness-request';
      button.textContent = 'Request';
      button.addEventListener('click', () => {
        (globalThis.browser ?? globalThis.chrome).permissions.request({ origins: ['https://example.com/*'] })
          .then((granted) => { button.dataset.result = String(granted); }, (error) => { button.dataset.result = error.message; });
      });
      document.body.append(button);
    });
    await options.click('#harness-request');
    await expect(options.locator('#harness-request')).toHaveAttribute('data-result', 'true');
  });
});

test.describe('fixture server', () => {
  test('serves fixture pages to the browser', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto('/basic.html');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers()['content-security-policy']).toBeUndefined();
    await expect(page.locator('h1')).toHaveText("The Keeper's Log");
    expect(errors).toEqual([]);
  });

  test('applies per-path response headers from headers.json', async ({ context }) => {
    const rules = readJson(path.join(FIXTURES_DIR, 'headers.json'));
    expect(rules['/engine/csp-strict.html']['Content-Security-Policy']).toContain("require-trusted-types-for 'script'");
    for (const [urlPath, headers] of Object.entries(rules)) {
      const response = await context.request.get(urlPath);
      for (const [name, value] of Object.entries(headers)) {
        expect(response.headers()[name.toLowerCase()], `${name} on ${urlPath}`).toBe(value);
      }
    }
  });

  test('serves extension/ and the React UMD builds with the right types', async ({ context }) => {
    const cases = {
      '/extension/manifest.json': 'application/json; charset=utf-8',
      '/extension/vendor/pdfjs/pdf.min.mjs': 'text/javascript; charset=utf-8',
      '/vendor/react/umd/react.development.js': 'text/javascript; charset=utf-8',
      '/vendor/react-dom/umd/react-dom.development.js': 'text/javascript; charset=utf-8',
    };
    for (const [urlPath, type] of Object.entries(cases)) {
      const response = await context.request.get(urlPath);
      expect(response.status(), urlPath).toBe(200);
      expect(response.headers()['content-type'], urlPath).toBe(type);
    }
    expect(contentTypeFor('paper.pdf')).toBe('application/pdf');
    expect((await context.request.get('/favicon.ico')).status()).toBe(204);
    expect((await context.request.post('/basic.html', { data: 'x' })).status()).toBe(405);
  });

  test('never serves files outside its folders', async ({ server }) => {
    const attempts = [
      '/..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%5c..%5cpackage.json',
      '/extension/..%2f..%2fpackage.json',
      '/vendor/react/umd/..%2fpackage.json',
    ];
    for (const rawPath of attempts) {
      const { status, body } = await rawGet(server.url, rawPath);
      expect(status, rawPath).toBe(404);
      expect(body, rawPath).not.toContain('devDependencies');
    }
    expect((await rawGet(server.url, '/%E0%A4%A')).status).toBe(400);
  });
});

test.describe('helpers', () => {
  test('openExtensionPage opens a page that can use extension APIs', async ({ context, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    expect(options.url()).toBe(`chrome-extension://${extensionId}/options/options.html`);
    expect(await options.evaluate(() => (globalThis.browser ?? globalThis.chrome).runtime.id)).toBe(extensionId);
  });

  test('tabIdFor finds web pages by Page or URL, and extension pages by Page', async ({ context, page, serviceWorker, extensionId }) => {
    await page.goto('/basic.html');
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    const webTab = await tabIdFor(serviceWorker, page);
    expect(await tabIdFor(serviceWorker, page.url())).toBe(webTab);
    const extensionTab = await tabIdFor(serviceWorker, options);
    expect(extensionTab).not.toBe(webTab);
    const urls = await swEval(serviceWorker, async (ids) => {
      const api = globalThis.browser ?? globalThis.chrome;
      return Promise.all(ids.map(async (id) => (await api.tabs.get(id)).url ?? 'hidden'));
    }, [webTab, extensionTab]);
    expect(urls).toEqual([page.url(), 'hidden']);
  });

  test('collectConsoleErrors sees page and content-script errors', async ({ page, serviceWorker }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/basic.html');
    await page.evaluate(() => console.error('from the page'));
    const tabId = await tabIdFor(serviceWorker, page);
    await swEval(serviceWorker, async (id) => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          console.error('from a content script');
          setTimeout(() => { throw new Error('uncaught in a content script'); });
        },
      });
    }, tabId);
    await expect.poll(() => errors.length).toBe(3);
    expect(errors[0]).toContain('from the page');
    expect(errors[1]).toContain('from a content script');
    expect(errors[2]).toContain('uncaught in a content script');
  });

  test('resetSettings clears sync, local and session storage', async ({ serviceWorker }) => {
    await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.storage.sync.set({ settings: { mode: 'fixed', letters: 3 } });
      await api.storage.local.set({ note: 'x' });
      await api.storage.session.set({ selection: 'y' });
    });
    await resetSettings(serviceWorker);
    const left = await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      return Promise.all([api.storage.sync.get(null), api.storage.local.get(null), api.storage.session.get(null)]);
    });
    expect(left).toEqual([{}, {}, {}]);
  });
});

test.describe('isolation between tests', () => {
  test.describe.configure({ mode: 'serial' });

  test('a test that leaves state behind', async ({ context, page, serviceWorker, extensionId }) => {
    await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.storage.sync.set({ settings: { mode: 'fixed' } });
      await api.storage.session.set({ selection: 'left over' });
    });
    await page.goto('/basic.html');
    await page.evaluate(() => localStorage.setItem('skimbold.settings', '{"mode":"fixed"}'));
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    await options.evaluate(() => localStorage.setItem('left', 'over'));
    expect(context.pages()).toHaveLength(2);
  });

  test('the next test starts clean', async ({ context, page, serviceWorker, extensionId }) => {
    expect(context.pages()).toHaveLength(1);
    expect(context.pages()[0]).toBe(page);
    const stored = await swEval(serviceWorker, async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      return Promise.all([api.storage.sync.get(null), api.storage.session.get(null)]);
    });
    expect(stored).toEqual([{}, {}]);
    await page.goto('/basic.html');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    const options = await openExtensionPage(context, extensionId, 'options/options.html');
    expect(await options.evaluate(() => localStorage.length)).toBe(0);
  });
});
