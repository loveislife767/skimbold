# Skimbold tests

| Kind | Where | Runner |
| --- | --- | --- |
| Unit | `test/unit/*.test.mjs` | `node --test`, no dependencies |
| End-to-end | `test/e2e/*.spec.mjs` | `@playwright/test`, with the extension loaded into Playwright's bundled Chromium |
| Fixtures | `test/fixtures/` | static pages plus `server.mjs`, a small local HTTP server |

## Running the tests

```sh
npm test                                          # unit tests
npx playwright install chromium                   # once, downloads Playwright's Chromium
npm run test:e2e                                  # every e2e spec
npx playwright test test/e2e/harness.spec.mjs     # one file
npx playwright test --grep "resetSettings"        # tests whose title matches
npx playwright test test/e2e/engine-perf.spec.mjs --no-deps   # the perf and stress tests alone
```

- **Headless only.** The browser runs headless, and extensions work there because the harness uses full Chromium (`channel: 'chromium'`) rather than the stripped-down headless shell. On a CI runner, `npx playwright install --with-deps --no-shell chromium` installs just what is needed. `--headed` works for local debugging, but it opens real browser windows.
- **Parallelism.** There are two workers. Each one has its own fixture server and its own Chromium with the extension loaded. Tests in one file run in order in the same worker.
- **Failures.** Traces are kept only for failed tests, in `test-results/<test>/trace.zip`. Open one with `npx playwright show-trace <path>`.
- **On CI** (`CI` is set), failed tests retry once, `test.only` is an error, and an HTML report is written to `playwright-report/` (`npx playwright show-report`). The report never opens by itself.
- **The stress tests.** The 5,000-paragraph test in `engine-perf.spec.mjs` and the Reader's 300-page timing tests in `reader.spec.mjs` are tagged `@stress` and run one at a time. They measure main-thread blocking, so another worker's Chromium competing for the CPU would spoil them. `playwright.config.mjs` therefore puts it in a project of its own, `stress`, which runs after every other test has finished (the `e2e` project), whatever command starts the run; it is skipped when an `e2e` test fails. Because of that dependency, a file filter or `--grep @stress` still runs the whole suite first; add `--no-deps` to run just what the filter picks. It tries up to three rounds and needs one that is clean on every count. On CI a runner that never gives a clean round is reported as a warning annotation, while local runs keep the strict check, which needs an otherwise idle machine: other programs busy on the CPU (another test run, a build) give it long tasks of 50 to 75 ms.
- **Engine tests** drive the content script directly through `test/fixtures/engine/helpers.mjs`, injecting the same files as the background does. The engine runs only in the isolated world, so `page.evaluate` sees the page as its own scripts do: an emptied text node reads `''` and the words are inside `<skb-w>`.
- **Third-party page code.** `test/fixtures/vendor/` holds unmodified builds that fixtures load the way sites do (served at `/vendor/…`): `mark.min.js` is mark.js 8.11.1 from npm (MIT, licence header kept), used by `engine/highlight.html`.

To browse the fixtures by hand, run `node test/fixtures/server.mjs` (port 8080; change it with `--port=9000` or `PORT=9000`) and open <http://127.0.0.1:8080/>.

## Writing an e2e test

Import `test` and `expect` from `./fixtures.mjs`, not from `@playwright/test`:

```js
import { test, expect, tabIdFor, swEval, collectConsoleErrors } from './fixtures.mjs';

test('toggling twice restores the page', async ({ page, serviceWorker }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/basic.html');                       // baseURL is the fixture server
  const before = await page.evaluate(() => document.body.innerHTML);
  const tabId = await tabIdFor(serviceWorker, page);
  // …drive the extension, e.g. through the service worker or a message…
  expect(await page.evaluate(() => document.body.innerHTML)).toBe(before);
  expect(errors).toEqual([]);
});
```

### Fixtures

| Fixture | Scope | Value |
| --- | --- | --- |
| `server` | worker | `{ url, close }`. `url` is `http://127.0.0.1:<port>`, with no trailing slash. It is also the browser context's `baseURL`, so `page.goto('/basic.html')` and `context.request.get('/basic.html')` work. |
| `extensionPath` | worker | The temp copy of `extension/` that Chromium loads (see below). |
| `extensionContext` | worker | The persistent `BrowserContext` with the extension loaded. Use it in `beforeAll` hooks, which cannot use test fixtures. |
| `serviceWorker` | worker | The `Worker` for `background.js`, already checked to be running. |
| `extensionId` | worker | The 32-letter id of the loaded copy. It changes from run to run. |
| `context` | test | The same object as `extensionContext`. |
| `page` | test | A new tab in that context. |

### Helpers

| Helper | Does |
| --- | --- |
| `openExtensionPage(context, extensionId, relPath)` | Opens `chrome-extension://<id>/<relPath>` in a new tab and returns the `Page`. A query string is allowed, e.g. `'reader/reader.html?session=abc'`. |
| `swEval(serviceWorker, fn, arg)` | Runs `fn(arg)` in the service worker and returns the result. Inside `fn`, use `globalThis.browser ?? globalThis.chrome`. |
| `tabIdFor(serviceWorker, pageOrUrl)` | Returns the tab id for a `Page` or an exact URL, found with `tabs.query` in the service worker. It waits up to 5 s for the tab to show up, and throws if no tab or several tabs match. Without the `tabs` permission, `tabs.query` hides the URL of the extension's own pages, so pass those as a `Page` (the page then asks `tabs.getCurrent()`). |
| `collectConsoleErrors(page)` | Returns an array that fills with the page's `console.error` messages and uncaught exceptions. That includes those from its frames and from extension content scripts, because Chromium reports those on the page too. Service-worker errors are not included. |
| `resetSettings(serviceWorker)` | Clears `storage.sync`, `storage.local` and `storage.session`, which brings back the default settings. |

`EXTENSION_SOURCE` (the path of `extension/`) is exported too. `server.mjs` exports `start`, `contentTypeFor` and `FIXTURES_DIR`.

### Every test starts clean

An automatic fixture wraps each test in the extension-backed `test`:

- **Before the test:**
  - `resetSettings()`;
  - clears `localStorage` for the extension's origin and for the fixture server's origin. That covers the Reader's remembered document and the web build's `skimbold.settings`;
  - clears cookies.
- **After a passing test:** it closes every page the test opened. Pages opened in a `beforeAll` hook stay open.
- **After a failing test:** its pages are left open so the trace and error context can capture them. Playwright replaces the worker, and so the browser, after every failure anyway.

`background.js` keeps running for the whole worker; it is not restarted between tests. It sees the cleared storage through `storage.onChanged`, like any other settings change, and reacts on its own time. So a test that depends on that reaction (for example, the auto-on script being unregistered) should wait for the result rather than assume it.

## The fixture server

`test/fixtures/server.mjs` has no dependencies. It only listens on 127.0.0.1 and only answers `GET` and `HEAD`.

| URL path | Served from |
| --- | --- |
| `/…` | `test/fixtures/` |
| `/extension/…` | `extension/`, read-only, e.g. `/extension/reader/reader.html` for web-mode Reader tests |
| `/vendor/react/umd/…` | `node_modules/react/umd/`, e.g. `/vendor/react/umd/react.development.js` |
| `/vendor/react-dom/umd/…` | `node_modules/react-dom/umd/`, e.g. `/vendor/react-dom/umd/react-dom.development.js` |

**What every response gets:**
- the right `Content-Type`. `.js` and `.mjs` are `text/javascript`, `.pdf` is `application/pdf`, text types are UTF-8, and unknown extensions are `application/octet-stream`;
- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`.

**Other behaviour:**
- Directories serve their `index.html`, or a file listing if there is none.
- Requests that would leave the served folders get `404`, whatever the encoding (`..%2f`, `%2e%2e`, backslashes).
- `/favicon.ico` answers `204` when no fixture provides one. Otherwise Chromium's automatic favicon request would log a 404 console error on every page.

### Per-path headers: `headers.json`

`test/fixtures/headers.json` maps an exact URL path to extra response headers:

```json
{
  "/engine/csp-strict.html": {
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; require-trusted-types-for 'script'"
  }
}
```

- Rules match the decoded path exactly, with no query string and no wildcards.
- A rule applies to every response for that path, even a 404, and it overrides the default headers above.
- The file is read when a server starts, and a malformed file makes `start()` throw.
- `harness.spec.mjs` checks that every rule in the file is actually sent.

## The temp copy and its host permission

The shipped `extension/manifest.json` has no host permissions. It relies on `activeTab`, plus optional host permissions that are requested when the user turns on "Always on" for a site. Neither can be exercised in an automated test:
- `activeTab` access comes from clicking the toolbar icon or pressing the keyboard shortcut in the browser's own UI, which Playwright cannot reach because it drives page content, not browser chrome;
- permission prompts cannot be clicked.

So the `extensionPath` fixture copies `extension/` into a temp folder (`%TEMP%` or `/tmp`, named `skimbold-e2e-*`) once per worker. It adds `"host_permissions": ["<all_urls>"]` to the copy's manifest. Chromium grants that at install, without a prompt, for an unpacked extension. As a result:

- `scripting.executeScript` from the service worker works on any http(s) tab without a user gesture. It is the same call the popup and the shortcut make once `activeTab` has granted access.
- `permissions.request({ origins: [...] })` resolves `true` straight away, with no prompt. It still needs a user gesture, so trigger it with a Playwright click on a real button, never from `swEval`.
- `tabs.query` reports `url` and `title` for http(s) tabs.

What this means for tests:

- **`permissions.onAdded` and `permissions.onRemoved` never fire for a site.** Every origin is already granted, so `request()` adds nothing, and `permissions.remove()` rejects with "You cannot remove required permissions". Test the auto-on reconciliation by changing settings, or by sending `{type: 'skb:reconcile'}` from an extension page, rather than by waiting for permission events.
- **Host access is broader than in real use.** Code that quietly depends on host access it would not have outside an `activeTab` grant can pass here. Keep that in mind when reviewing anything that reads `tab.url` or injects without a user action.
- **The source manifest is never modified.** `harness.spec.mjs` checks that the copy differs from it only in `host_permissions`, and that the source still has no `<all_urls>`.
- **Edits need a new run.** The copy is taken when a worker starts, so changes to `extension/` apply on the next run. The copy is deleted when the worker exits. A killed run can leave `skimbold-e2e-*` folders behind, and they are safe to delete.

## The silent-load gotcha

`--load-extension` does not report an extension it cannot load: there is no error, no service worker and nothing in the console. Every test then fails later with a confusing timeout. This happens when the manifest is invalid or names a file that does not exist.

The `serviceWorker` fixture guards against this:

1. **It waits up to 10 s for `background.js` to appear.** If it never does, the fixture launches a second headless Chromium with `--enable-unsafe-extension-debugging` and loads the same folder through CDP (`Extensions.loadUnpacked`), which returns Chromium's real error. The fixture then fails with it, for example:
   ```
   Skimbold did not load: no service worker within 10 s.
   Chromium rejected the extension: Could not load javascript 'content/engine.js' for script.
   ```
2. **It checks that the worker actually started.** If `background.js` fails to parse or throws at startup, the worker still shows up while Playwright is attached, but its state is `redundant` and none of its listeners exist. The fixture detects that state and fails with the cause:
   - a syntax error comes from `node --check`;
   - a runtime exception comes from running the script again inside the failed worker, with its line number. For example: `It throws while starting: ReferenceError: window is not defined (background.js:3:1)`.

To see the load error by hand:

```js
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-extension-debugging'] });
const cdp = await browser.newBrowserCDPSession();
await cdp.send('Extensions.loadUnpacked', { path: '/absolute/path/to/extension' });   // throws with the real error
```
