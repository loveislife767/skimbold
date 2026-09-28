# Changelog

All notable changes to Skimbold are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-27

The first public release.

### Added

- Bold the start of every word on almost any web page, and restore the page exactly when you turn it off.
- Keyboard shortcut <kbd>Alt</kbd>+<kbd>R</kbd> (<kbd>Control</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on a Mac), toolbar button, and right-click menu entries.
- Toolbar panel with a live preview: bold letters (Auto, 1, 2 or 3), strength, fade and boldness, plus "Always on" for the current site.
- Settings page: everything in the panel, plus skip short words, choose which words to bold (every word, every 2nd or every 3rd), what the toolbar button does, always on everywhere with a skip list, the always-on and skip lists (showing sites this browser has not allowed yet), your shortcut, and reset to defaults.
- Reader for PDFs, `.txt`, `.md` and `.html` files, pasted text and selections sent from the right-click menu, with light, sepia and dark themes, serif or sans text, and adjustable size and width. On a PDF tab, the toolbar panel or the shortcut opens the PDF in the Reader. What comes from a private window is not remembered. It is also published as a web page.
- Support for pages built with React and Vue, open shadow roots (including ones attached later), same-origin frames (including ones that load later), and pages with a strict Content Security Policy. Inputs, editors, code, math, video captions and icon fonts are left alone. Copied text pastes without the bolding, highlights a page adds to bolded text (a site search) stay when you turn Skimbold off, and text that a page keeps re-rendering is bolded once it settles; new messages in a busy live chat are bolded within half a second.
- Latin, Greek, Cyrillic, Armenian, Georgian and Hebrew scripts are bolded. Other scripts are left untouched.
- Chromium (Chrome, Edge, Brave, version 122 or later) and Firefox (140 or later) packages, a website with a live demo, and a privacy policy.

[1.0.0]: https://github.com/loveislife767/skimbold/releases/tag/v1.0.0
