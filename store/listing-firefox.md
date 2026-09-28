# Firefox Add-ons (AMO) listing

Paste each field into the [Add-on Developer Hub](https://addons.mozilla.org/developers/). [SUBMITTING.md](SUBMITTING.md) walks through the submission.

**Package:** `dist/skimbold-1.0.0-firefox.zip`, from `npm run build`. This is the Firefox build: an event page instead of a service worker, the add-on id `skimbold@loveislife767.github.io`, a minimum of Firefox 140 (Android 142), and `data_collection_permissions: { required: ["none"] }`. `npm run lint:firefox` must report 0 errors before you upload it.

## Upload

| Question | Answer |
| --- | --- |
| Where to distribute | **On this site** (listed on addons.mozilla.org) |
| Compatible applications | **Firefox** and **Firefox for Android** (the manifest declares both) |
| Do you need to submit source code? | **No.** None of our code is minified, bundled or transpiled; the zip contains the source files as they are in the repository. The only third-party code is pdf.js, included unmodified (see the reviewer notes below). |

## Describe add-on

| Field | Value |
| --- | --- |
| Name | `Skimbold: Bold Word Starts for Easier Reading` (from the manifest) |
| Add-on URL | `https://addons.mozilla.org/firefox/addon/skimbold/` |
| Categories (Firefox) | **Appearance** |
| Categories (Firefox for Android) | **Appearance** |
| Support email | Leave empty |
| Support website | `https://github.com/loveislife767/skimbold/issues` |
| Homepage | `https://loveislife767.github.io/skimbold/` |
| License | **MIT License** |
| This add-on has a privacy policy | Tick it and paste the text of [PRIVACY.md](../PRIVACY.md). Nothing is collected, but the policy explains the local storage and the Reader's PDF download. |

### Summary

188 of 250 characters:

```
Bolds the first letters of every word, giving your eyes an anchor on each line. Works on almost any page, with a Reader for PDFs and pasted text. Private: no tracking, no network requests.
```

### Description

AMO accepts a limited set of Markdown in descriptions. Paste everything between the lines.

---

Skimbold bolds the first letters of each word on the page you're reading. The heavy starts give your eyes an anchor on every line, which helps you focus, keep your place and glide through long articles, documentation and study material.

**How to use it**

- Press Alt+R (Control+Shift+R on a Mac) or click the toolbar button.
- Press the shortcut again and everything goes back exactly as it was.
- Select a passage, right-click, and open it in the Skimbold Reader.

**Make it yours**

- Bold letters: Auto, which scales with length, or a fixed 1, 2 or 3
- Strength, boldness, and a fade for the rest of each word
- Skip short words, or bold only every second or third one
- Keep it on for sites you choose, or everywhere with a skip list

**The Reader**

Open PDFs, plain text, Markdown and HTML files, or paste anything you copied. Choose a light, sepia or dark theme, a serif or sans font, and your own size and width.

**Leaves websites working**

Search boxes, editors, code and math are left alone. It works in modern web apps, respects strict security policies, and follows each site's own colours, including dark themes.

**Private by design**

- No account, no ads, no analytics, and no data collection
- Your reading stays on your device and is never sent anywhere
- Access to a site is requested only if you switch on "Always on" for it

Free and open source under the MIT License: https://github.com/loveislife767/skimbold

---

## Images

AMO takes the icon from the manifest (`icons/icon-128.png`, with 48 as a fallback). After submitting, add the screenshots in **Edit Product Page → Images**, in this order, with these captions:

| File | Caption |
| --- | --- |
| `store/screenshots/01-before-after.png` | The same article without and with Skimbold |
| `store/screenshots/02-popup.png` | The toolbar panel: turn it on, choose letters, strength, fade and boldness |
| `store/screenshots/03-reader-pdf.png` | The Reader showing a PDF |
| `store/screenshots/04-dark-fade.png` | A dark page with the rest of each word faded |
| `store/screenshots/05-settings.png` | The settings page |

## Notes to reviewer

Paste this into **Notes to Reviewer**:

```
Skimbold bolds the first letters of each word on pages the user turns it on for, and has a Reader page for PDFs and pasted text. No account is needed. Test: open any article, press Alt+R (or click the toolbar button, then "Turn on for this page"); press Alt+R again to restore the page.

Build: the zip is the repository's extension/ folder as-is, with manifest.json rewritten for Firefox by scripts/build.mjs (background.scripts, browser_specific_settings, and content_security_policy.extension_pages "script-src 'self'" so the Reader can download a PDF from an http:// site the user is on, instead of Firefox's default upgrade to https://). Our own code is not minified, bundled or transpiled, so there is no separate source package. Repository: https://github.com/loveislife767/skimbold

Third-party library: pdf.js 6.3.289 by Mozilla (Apache-2.0), used only by the Reader to extract text from PDFs, loaded with dynamic import() from the package and run with isEvalSupported: false. Its worker starts from our reader/pdf-worker.mjs, which imports our reader/pdf-support.js (small fallbacks for JavaScript functions older browsers lack) and then the unmodified worker file. The pdf.js files are byte-identical to the official pdfjs-dist 6.3.289 package on npm:

- vendor/pdfjs/pdf.min.mjs = package/build/pdf.min.mjs
  SHA-256 f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2
- vendor/pdfjs/pdf.worker.min.mjs = package/build/pdf.worker.min.mjs
  SHA-256 8ab0e5e30031b4a06ecfddd5ae9562f0227f830ee7ec9ed1a968b134243d2386
- vendor/pdfjs/LICENSE = package/LICENSE
  SHA-256 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594

Official package: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz (npm page: https://www.npmjs.com/package/pdfjs-dist/v/6.3.289)
Readable source at that release: https://github.com/mozilla/pdf.js/tree/v6.3.289 (release: https://github.com/mozilla/pdf.js/releases/tag/v6.3.289)

The two web-ext lint warnings (UNSAFE_VAR_ASSIGNMENT on import()) are inside these unmodified pdf.js files.

Data: the manifest declares data_collection_permissions required: ["none"]. Page text is processed locally and never transmitted. The only network request is the Reader downloading a PDF the user explicitly asked to open from the current tab (same URL the tab shows). Settings are in storage.sync; the Reader's last document is in the extension page's localStorage.
```
