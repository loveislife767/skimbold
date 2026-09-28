# Contributing to Skimbold

Thanks for helping. Bug reports, fixes and small improvements are all welcome.

## Reporting a problem

[Open an issue](https://github.com/loveislife767/skimbold/issues) and include:

- your browser and its version, and Skimbold's version (shown in the About section of the settings page);
- the address of the page, if it's public, and what you expected to see;
- a screenshot, if the problem is visible.

If a site breaks while Skimbold is on, say whether turning it off fixes the page.

## Making a change

1. Fork the repository and create a branch.
2. Run `npm ci`, then `npx playwright install chromium` once.
3. Load the `extension/` folder with **Load unpacked** to try your change. There is no build step.
4. Run `npm test` and `npm run test:e2e`, and add a test for what you changed. The e2e run ends with a stress test that measures how long the page is blocked, so leave the computer otherwise idle until it finishes.
5. Run `npm run build` and `npm run lint:firefox` if you touched the manifest or anything the Firefox build uses.
6. Open a pull request that explains what changed and why.

## Ground rules

These keep Skimbold safe and easy to review in the browser stores:

- **No network requests, remote code or `eval`.** `npm run check:network` enforces this. The only network access allowed is the Reader downloading a PDF the user asked for.
- **Never build markup from page text.** Create elements and set `textContent`; don't use `innerHTML`, `insertAdjacentHTML` or `document.write` with page or file content.
- **Plain scripts, no bundler.** Files in `extension/` are classic scripts that share `globalThis.Skimbold`, so they load unchanged in content scripts, the service worker, extension pages, the website and Node tests. The one exception is `reader/pdf-worker.mjs`, the module that starts the pdf.js worker.
- **Leave `extension/vendor/` alone.** It holds pdf.js exactly as Mozilla published it. Update it with `npm run vendor:pdfjs`.
- **Plain, honest wording.** Describe what Skimbold does ("bolds the start of every word"). Don't claim it makes anyone read faster, and don't use the trademarked name of the commercial method it resembles.
- **Style.** Two-space indent, single quotes and semicolons. Comments explain why, not what.

The design spec is in [docs/specs/2026-09-27-design.md](docs/specs/2026-09-27-design.md), and the design system is in [docs/brand.md](docs/brand.md).

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
