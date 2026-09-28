# Microsoft Edge Add-ons listing

Paste each field into [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview). [SUBMITTING.md](SUBMITTING.md) walks through the submission, and [privacy-practices.md](privacy-practices.md) holds the answers for the **Privacy** page.

Edge Add-ons policy: the listing must not mention any other browser or store. Nothing below does, and the screenshots and promo tiles don't either.

**Package:** `dist/skimbold-1.0.0-chromium.zip`, from `npm run build`. It is the same package that is attached to the GitHub release.

## Read from the manifest

| Field | Value |
| --- | --- |
| Extension name | `Skimbold: Bold Word Starts for Easier Reading` |
| Short description | `Bolds the first letters of every word so your eyes can glide through text. On any page, plus a reader for pasted text & PDFs.` |

## Availability

| Field | Value |
| --- | --- |
| Visibility | Public |
| Markets | All markets |

## Properties

| Field | Value |
| --- | --- |
| Category | **Accessibility** |
| Website | `https://loveislife767.github.io/skimbold/` |
| Support contact detail | `https://github.com/loveislife767/skimbold/issues` |
| Mature content | Not checked |

## Store listing: English

### Description

Paste everything between the lines. It is about 1,400 characters; Partner Center accepts 250 to 10,000.

---

Skimbold bolds the first letters of each word on the page you're reading. The heavy starts give your eyes an anchor on every line, which helps you focus, keep your place and glide through long articles, documentation and study material.

How to use it
• Press Alt+R (Control+Shift+R on a Mac) or click the Skimbold button in the toolbar.
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
• Your reading stays on your device and is never sent anywhere
• Access to a site is requested only if you switch on "Always on" for it

Free and open source under the MIT License:
https://github.com/loveislife767/skimbold

---

### Images

| Slot | File |
| --- | --- |
| Extension logo (300×300) | `store/promo/logo-300.png` |
| Small promotional tile (440×280) | `store/promo/small-tile-440x280.png` |
| Large promotional tile (1400×560) | `store/promo/marquee-1400x560.png` |
| Screenshots (1280×800, up to 6) | `store/screenshots/01-before-after.png`, `02-popup.png`, `03-reader-pdf.png`, `04-dark-fade.png`, `05-settings.png`, in that order |
| YouTube video URL | Leave empty |

### Search terms

Seven terms, 15 words in total. The limits are 7 terms, 30 characters each and 21 words.

```
bold first letters
bold word starts
reading aid
focus reading
readability
PDF reader
skim reading
```

## Privacy

Copy the answers from [privacy-practices.md](privacy-practices.md): the single-purpose description, the permission justifications, **No, I am not using remote code**, and in the data usage section, **Website content** ticked plus all three certifications. The privacy policy URL is `https://loveislife767.github.io/skimbold/privacy.html`.

## Notes for certification

```
No sign-in or test account is needed. To test: open any article, then press Alt+R or click the Skimbold toolbar button and choose "Turn on for this page". The first letters of each word turn bold; press Alt+R again to restore the page exactly. The Reader opens from the "Reader" button in the toolbar panel; paste text or open a PDF there. "Always on for this site" in the panel requests access to that one site only. The extension makes no network requests of its own; the only download is the Reader fetching a PDF that the user asked to open from the current tab. The folder vendor/pdfjs contains pdf.js 6.3.289, unmodified, from the official pdfjs-dist package (Apache-2.0). Source code: https://github.com/loveislife767/skimbold
```
