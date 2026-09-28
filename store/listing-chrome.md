# Chrome Web Store listing

Paste each field into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). [SUBMITTING.md](SUBMITTING.md) walks through the whole submission, and [privacy-practices.md](privacy-practices.md) holds the answers for the **Privacy** tab.

**Package:** `dist/skimbold-1.0.0-chromium.zip`, from `npm run build`.

## Package details (read from the manifest)

The dashboard fills these in from `manifest.json`. To change them, edit the manifest and upload a new package.

| Field | Value | Limit |
| --- | --- | --- |
| Name | `Skimbold: Bold Word Starts for Easier Reading` | 45 characters, within Chrome's 75 and Firefox's 45 |
| Summary | `Bolds the first letters of every word so your eyes can glide through text. On any page, plus a reader for pasted text & PDFs.` | 125 of 132 characters |

## Store listing tab

### Description

Paste everything between the lines as plain text. It has no speed claims, no testimonials and no keyword lists, and no word repeats more than five times apart from short common words.

---

Skimbold bolds the first letters of each word on the page you're reading. The heavy starts give your eyes an anchor on every line, which helps you focus, keep your place and glide through long articles, documentation and study material.

How to use it
• Press Alt+R (Control+Shift+R on a Mac) or click the toolbar button.
• Press the shortcut again and everything goes back exactly as it was.
• Select a passage, right-click, and open it in the Skimbold Reader.

Make it yours
• Bold letters: Auto, which scales with length, or a fixed 1, 2 or 3
• Strength, boldness, and a fade for the rest of each word
• Skip short words, or bold only every second or third one
• Keep it on for sites you choose, or everywhere with a skip list

The Reader
Open PDFs, plain text, Markdown and HTML files, or paste anything you copied. Choose a light, sepia or dark theme, a serif or sans font, and your own size and width.

Leaves websites working
Search boxes, editors, code and math are left alone. It works in modern web apps, respects strict security policies, and follows each site's own colours, including dark themes.

Private by design
• No account, no ads, no analytics
• Your reading stays inside your browser and is never sent anywhere
• Access to a site is requested only if you switch on "Always on" for it

Free and open source under the MIT License:
https://github.com/loveislife767/skimbold

---

### Other fields

| Field | Value |
| --- | --- |
| Category | **Accessibility** (under "Make Chrome Yours"). It is a reading aid that changes how text looks. |
| Language | **English** |
| Store icon | `extension/icons/icon-128.png` (128×128; 96×96 artwork inside 16 px of transparent padding) |
| Screenshots (1280×800, up to 5) | Upload in this order: `store/screenshots/01-before-after.png`, `02-popup.png`, `03-reader-pdf.png`, `04-dark-fade.png`, `05-settings.png` |
| Small promo tile (440×280) | `store/promo/small-tile-440x280.png` |
| Marquee promo tile (1400×560) | `store/promo/marquee-1400x560.png` |
| Global promo video | Leave empty |
| Official URL | Leave empty (it needs a site verified in Google Search Console) |
| Homepage URL | `https://loveislife767.github.io/skimbold/` |
| Support URL | `https://github.com/loveislife767/skimbold/issues` |
| Mature content | No |

## Privacy tab

Copy the answers from [privacy-practices.md](privacy-practices.md). In short:

| Field | Answer |
| --- | --- |
| Single purpose | Skimbold makes text easier to follow by bolding the first letters of each word, on the web pages the user turns it on for and in its built-in Reader for PDFs and pasted text. |
| Permission justifications | See [privacy-practices.md](privacy-practices.md#permission-justifications): `activeTab`, `scripting`, `storage`, `contextMenus`, and the optional host permission `*://*/*` |
| Remote code | **No, I am not using remote code.** |
| Data usage | Tick **Website content** only, then tick all three certifications |
| Privacy policy URL | `https://loveislife767.github.io/skimbold/privacy.html` |

## Distribution tab

| Field | Value |
| --- | --- |
| Payments | Free |
| Visibility | Public |
| Distribution | All regions |

## Test instructions tab

No account or login is needed. For reviewers:

```
No sign-in is required. To test: open any article (for example a Wikipedia page), then press Alt+R or click the Skimbold toolbar button and choose "Turn on for this page". The first letters of each word turn bold; press Alt+R again to restore the page. The Reader opens from the toolbar panel's "Reader" button; paste text or open a PDF there. The "Always on for this site" switch requests access to that one site only. The extension makes no network requests of its own; the only fetch is the Reader downloading a PDF the user asked to open from the current tab.
```
