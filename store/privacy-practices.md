# Privacy practices: answers for every store

These answers are the same for the Chrome Web Store (**Privacy** tab), Microsoft Edge Add-ons (**Privacy** page) and addons.mozilla.org. They match [PRIVACY.md](../PRIVACY.md) and the published policy at <https://loveislife767.github.io/skimbold/privacy.html>. If the extension's behaviour changes, update all three together.

## What Skimbold handles

| Data | What happens to it | Leaves the device? |
| --- | --- | --- |
| Text of a page the user turns Skimbold on for | Read by the content script and shown again with bold word starts. It is not stored or logged. | No |
| Display settings (letters, strength, fade, weight, icon click, Reader theme, font, size, width) | `storage.sync`, with a `storage.local` copy if sync storage is full | Only through the browser's own sync, if the user has turned sync on |
| Sites the user chose for "Always on" or to skip | `storage.sync`, as part of the settings | Only through the browser's own sync, if the user has turned sync on |
| Text sent to the Reader from the right-click menu | `storage.session` under a random key; deleted once the Reader reads it | No |
| The Reader's last document and scroll position | The Reader page's `localStorage`; documents over 4 MB are skipped | No |
| A PDF the user asks the Reader to open from the current tab | Downloaded from the URL the tab already shows, then parsed locally | Only the download request to that URL, which the user asked for |

Nothing is sent to the developer or to any third party. There are no servers, analytics, crash reports, ads or remote code.

## Single purpose

```
Skimbold makes text easier to follow by bolding the first letters of each word, on the web pages the user turns it on for and in its built-in Reader for PDFs and pasted text.
```

## Permission justifications

**activeTab**
```
When the user presses the Skimbold shortcut, clicks the toolbar button or chooses "Toggle Skimbold on this page" from the right-click menu, activeTab grants temporary access to that one tab so Skimbold can bold the words on it. No other tab is accessed.
```

**scripting**
```
Injects Skimbold's own packaged content scripts (shared/settings.js, shared/core.js, content/engine.js) into the tab the user turned it on for, including frames of that page that load later, and registers the same packaged scripts to run on sites the user chose for "Always on". Only files inside the extension package are injected. The Reader also uses it, when the user asks to open the PDF shown in the current tab, to download that PDF from the tab's own page so sites the user is signed in to still work. When the user sends a selection to the Reader from the right-click menu, it reads that selection from the tab so its paragraph breaks are kept.
```

**storage**
```
Saves the user's settings (how many letters to bold, strength, fade, boldness, Reader preferences, and the sites chosen for "Always on" or to skip) with storage.sync, with a storage.local copy if sync storage is full. storage.session briefly holds text the user sends to the Reader from the right-click menu and is cleared once the Reader opens it.
```

**contextMenus**
```
Adds the right-click menu entries "Toggle Skimbold on this page", "Open selection in Skimbold Reader" and, on the toolbar button, "Open Skimbold Reader".
```

**Host permission `*://*/*` (optional, in optional_host_permissions)**
```
Optional and never requested at install. It is requested for one site when the user switches on "Always on for this site", or for all sites only when the user switches on "Always on everywhere" in the settings, so Skimbold can turn on by itself when those pages load. The browser asks the user to confirm each time, and the user can remove it at any time; Skimbold then stops turning on by itself there.
```

## Remote code

**No, I am not using remote code.**

```
All JavaScript is packaged in the extension. The Reader loads the packaged, unmodified pdf.js 6.3.289 from vendor/pdfjs/ with a dynamic import() of the extension's own file, with isEvalSupported set to false; its worker starts from the packaged reader/pdf-worker.mjs, which adds a few newer JavaScript functions for older browsers (reader/pdf-support.js) and then imports the packaged pdf.js worker. Nothing is loaded from a network location, and there is no eval or new Function.
```

## Data usage

**What user data do you plan to collect from users now or in the future?**

Tick **Website content** only, and leave every other box empty.

Why: the Chrome Web Store's User Data FAQ asks extensions to disclose data they handle "even when data is processed or stored locally on a user's device and is not transmitted". Skimbold reads the text of pages the user turns it on for, so that is the one category it handles. It handles none of the others:

| Category | Ticked | Reason |
| --- | --- | --- |
| Personally identifiable information | No | No names, emails, addresses or identifiers are read or stored |
| Health information | No | Not handled |
| Financial and payment information | No | Not handled |
| Authentication information | No | Not handled; password and input fields are skipped |
| Personal communications | No | Not collected; pages are only restyled locally |
| Location | No | Not handled |
| Web history | No | No list of visited pages is kept. The "Always on" list holds only sites the user chose. |
| User activity | No | No clicks, keystrokes or scrolling are recorded; only the extension's own shortcut is used |
| Website content | **Yes** | Page text is read locally to display it with bold word starts. It is never stored or transmitted. |

**I certify that the following disclosures are true.** Tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

```
https://loveislife767.github.io/skimbold/privacy.html
```

The URL goes live when the Pages workflow first deploys (see [SUBMITTING.md](SUBMITTING.md)). Check that it loads before you submit.

## Firefox

Firefox 140 and later reads the data declaration from the manifest. The build sets `browser_specific_settings.gecko.data_collection_permissions` to `{ "required": ["none"] }`: Skimbold collects and transmits nothing. Processing on the device does not count as collection under Mozilla's policy. Firefox then shows users "no data collection" at install, and AMO needs no separate consent screen.
