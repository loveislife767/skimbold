# Skimbold brand and design system

Skimbold is a calm reading tool, so it should look like good paper and ink rather than software. The palette is ledger paper, green-black ink and a bottle-green accent (think library lamp), with a brass focus ring. Type is split in two: the operating system's own UI face for controls, and a book serif for anything meant to be read.

- Tokens and components: [`extension/shared/theme.css`](../extension/shared/theme.css)
- Living reference: [`docs/brand-demo.html`](brand-demo.html). Open it in a browser and switch between Auto, Light, Sepia and Dark.
- Icons: [`extension/icons/`](../extension/icons/), rendered by [`scripts/icons.mjs`](../scripts/icons.mjs)

## Voice

- Say what it does: "bolds the start of every word".
- Say what it's for: it helps you focus, keep your place and glide through text. Never claim it makes reading faster by any amount. Studies found no measurable speed gain, and store policy treats misleading claims as grounds for rejection.
- Never use the trademarked name of the commercial reading method this resembles, whether in copy, listings, code or file names. Describe the technique in plain words instead.
- Use sentence case, plain verbs and no all-caps labels. A button names its result, and the result keeps that name: "Turn on for this page" becomes "On — turn off".
- When something can't work, explain why and what to do next, without apologising. For example: "Browsers don't let extensions change this page. Open a regular website to use Skimbold."

## The mark

The mark is a lowercase **b** (for bold). Its stem is heavy and topped with a wedge serif, and its bowl is a hairline. Read left to right, the letter does what Skimbold does: a heavy start, then a light rest of the word.

| File | Size | Notes |
| --- | --- | --- |
| `extension/icons/icon.svg` | any | Master artwork on a 96-unit grid, drawn edge to edge. Use this one in UI and on the web. |
| `extension/icons/icon-16.png` | 16×16 | Redrawn by hand for the pixel grid: the stem is exactly 3 px and the bowl is a rounded square so its sides stay sharp. |
| `extension/icons/icon-32.png` | 32×32 | Redrawn by hand. The toolbar uses it on high-DPI screens. |
| `extension/icons/icon-48.png` | 48×48 | Redrawn by hand, with 4 px of padding. Shown on the extensions page. |
| `extension/icons/icon-128.png` | 128×128 | The master at 96×96, centred in 16 px of transparent padding, as the Chrome Web Store requires. |
| `store/promo/logo-300.png` | 300×300 | Edge Add-ons logo, with the same proportions as the 128. |

- **Colours.** The tile is `#1F5E46` and the glyph is `#F2F4EF`, a 6.90:1 contrast. The icon is the same everywhere. On light toolbars the dark tile carries it; on dark toolbars the pale glyph does.
- **Toolbar badge.** The badge reads `ON` in white on `#1F5E46`, a 7.64:1 contrast. Set both colours explicitly: `action.setBadgeBackgroundColor({ color: '#1F5E46' })` and `action.setBadgeTextColor({ color: '#FFFFFF' })`. Both calls exist in Chrome 110+ and in Firefox.
- **Regenerating.** Run `npm run icons`. It renders with headless Chromium and writes all five PNGs. To change the 128 px icon and the 300 px logo, edit `icon.svg`. To change 16, 32 and 48, edit the geometry in `scripts/icons.mjs`. The stem must always be clearly heavier than the bowl. The master uses about 4:1 (a 17-unit stem against a 4.5-unit bowl). At 16 px it drops to 2:1, because a bowl thinner than 1.5 px disappears.
- **Using it in UI.** It is decorative next to the name, so give it an empty `alt`: `<img src="../icons/icon.svg" width="24" height="24" alt="">`. Show it at 20 px or larger and leave a quarter of its width clear around it.
- **Don't** recolour it, crop the tile into a circle, add shadows or outlines, rotate it, or set the letter in a font.

## Wordmark

```html
<span class="skb-wordmark"><b>Skim</b>bold</span>
```

The wordmark is set in the reading serif with "Skim" at weight 800 and "bold" at 400, so the name shows off the product. Don't use it in running text, where the name is just "Skimbold", and never set it all bold or in capitals.

## Colour

Every colour is a custom property on `:root`. Components use only these tokens, so all four surfaces switch theme together.

| Token | Light | Dark | Sepia | Role |
| --- | --- | --- | --- | --- |
| `--skb-paper` | `#F2F4EF` | `#141C18` | `#F4ECDC` | Page background |
| `--skb-surface` | `#FBFCFA` | `#1B2520` | `#FBF6EC` | Cards, popup panel, controls |
| `--skb-surface-hover` | `#EEF1EC` | `#233029` | `#F1E8D6` | Hover fill for buttons and segments |
| `--skb-surface-sunk` | `#E6EAE4` | `#0F1612` | `#EADFC9` | Segmented-control track, notices, ghost hover |
| `--skb-ink` | `#17221C` | `#E3E9E4` | `#3A2E22` | Body text |
| `--skb-ink-soft` | `#4A5850` | `#A3B0A8` | `#6B5A47` | Secondary text, hints, unselected segments |
| `--skb-line` | `#D3DAD3` | `#2D3A33` | `#DDD0B8` | Dividers and card edges (decorative) |
| `--skb-line-strong` | `#78877E` | `#6B7C72` | `#8E7B63` | Control borders, switch track when off, slider track |
| `--skb-accent` | `#1F5E46` | `#86C5A4` | `#2F5E46` | Primary button, switch when on, slider fill |
| `--skb-accent-hover` | `#174B37` | `#9DD3B6` | `#254C38` | Primary button hover |
| `--skb-on-accent` | `#F4F7F2` | `#0F1A14` | `#F8F3E8` | Text on the accent |
| `--skb-accent-ink` | `#1F5E46` | `#8FCDAD` | `#2F5E46` | Links and accent-coloured text |
| `--skb-accent-tint` | `#D5E7DC` | `#28443A` | `#DCE0C4` | Text selection |
| `--skb-focus` | `#A86A12` | `#E0A94A` | `#A0600E` | Focus ring |
| `--skb-danger` | `#A3302A` | `#F0907F` | `#9E2F24` | Destructive actions, error edges |
| `--skb-danger-tint` | `#F6E3E0` | `#3A2320` | `#F3DDD3` | Error notice fill, danger button hover |

In dark mode the accent turns into a pale sage fill with dark text. A deep green fill would sink into the dark page.

### Contrast

The ratios below were computed from the values in `theme.css` with the WCAG 2.2 relative-luminance formula and rounded down. Text pairs must reach 4.5:1 (AA). Control boundaries, state indicators and the focus ring must reach 3:1 (non-text contrast, 1.4.11). Every pair passes in all three themes.

| Pair | Where it appears | Needs | Light | Dark | Sepia |
| --- | --- | --- | --- | --- | --- |
| `ink` on `paper` | Body text | 4.5:1 | 14.79 | 14.09 | 11.21 |
| `ink` on `surface` | Text on cards, popup | 4.5:1 | 15.91 | 12.79 | 12.23 |
| `ink` on `surface-sunk` | Selected segment track, notices | 4.5:1 | 13.45 | 14.89 | 9.97 |
| `ink-soft` on `paper` | Muted text | 4.5:1 | 6.76 | 7.71 | 5.62 |
| `ink-soft` on `surface` | Hints, values on cards | 4.5:1 | 7.28 | 7.00 | 6.13 |
| `ink-soft` on `surface-sunk` | Unselected segments | 4.5:1 | 6.15 | 8.15 | 5.00 |
| `accent-ink` on `paper` | Links | 4.5:1 | 6.90 | 9.51 | 6.36 |
| `accent-ink` on `surface` | Links on cards | 4.5:1 | 7.42 | 8.63 | 6.93 |
| `on-accent` on `accent` | Primary button label | 4.5:1 | 7.07 | 8.94 | 6.75 |
| `on-accent` on `accent-hover` | Primary button label, hover | 4.5:1 | 9.26 | 10.54 | 8.74 |
| `danger` on `surface` | Danger button label | 4.5:1 | 6.77 | 6.75 | 6.75 |
| `danger` on `danger-tint` | Danger button, hover | 4.5:1 | 5.63 | 6.24 | 5.57 |
| `ink` on `danger-tint` | Error notice text | 4.5:1 | 13.24 | 11.82 | 10.09 |
| `ink` on `accent-tint` | Selected text | 4.5:1 | 12.70 | 8.61 | 9.72 |
| `line-strong` on `surface` | Control borders, switch track when off | 3:1 | 3.66 | 3.56 | 3.77 |
| `line-strong` on `paper` | Control borders on the page | 3:1 | 3.40 | 3.92 | 3.46 |
| `line-strong` on `surface-sunk` | Edge of the selected segment | 3:1 | 3.10 | 4.15 | 3.07 |
| `accent` on `surface` | Switch when on, slider fill and thumb | 3:1 | 7.42 | 7.90 | 6.93 |
| `accent` on `paper` | Primary button edge on the page | 3:1 | 6.90 | 8.71 | 6.36 |
| `focus` on `paper` | Focus ring | 3:1 | 4.00 | 8.22 | 4.28 |
| `focus` on `surface` | Focus ring on cards | 3:1 | 4.30 | 7.46 | 4.67 |

`--skb-line` is only for decoration, such as card edges and dividers. Never make it the only thing that shows where a control is. Use `--skb-line-strong` for that.

## Themes

| `<html data-theme>` | Result |
| --- | --- |
| absent or `"auto"` | Light, or dark when the OS asks for dark |
| `"light"` | Always light |
| `"dark"` | Always dark |
| `"sepia"` | Warm paper with brown ink (offered by the Reader) |

The popup and the options page should leave `data-theme` unset so they follow the OS. The Reader sets it from its own theme setting. Each theme also sets `color-scheme`, so scrollbars and native controls match.

## Type

| Token | Stack | Use |
| --- | --- | --- |
| `--skb-font-ui` | `system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Liberation Sans', Arial, sans-serif` | Every control, label and message |
| `--skb-font-read` | `Charter, 'Bitstream Charter', 'Sitka Text', Cambria, 'Charis SIL', 'Noto Serif', 'DejaVu Serif', Georgia, serif` | Reader text, previews, the wordmark, headings on the site |

The reading stack needs no web fonts. macOS picks up Charter, Windows 10 and 11 pick up Sitka Text (Cambria on older Windows), Linux picks up Bitstream Charter, Charis SIL, Noto Serif or DejaVu Serif, and Georgia is the fallback everywhere else.

| Token | Size | Typical use |
| --- | --- | --- |
| `--skb-text-xs` | 12px | Keyboard chips, captions |
| `--skb-text-sm` | 13px | Hints, segment labels, small buttons |
| `--skb-text-md` | 14px | UI body (the default `body` size) |
| `--skb-text-lg` | 16px | Popup preview text, site body |
| `--skb-text-xl` | 18px | Wordmark in the popup header, lead paragraphs |
| `--skb-text-2xl` | 21px | Section headings |
| `--skb-text-3xl` | 24px | Page titles in the options page and Reader |
| `--skb-text-4xl` | 36px | Site headings |
| `--skb-text-5xl` | 48px | Site hero only |

- **Line height.** `--skb-leading-ui` (1.4) for the interface and `--skb-leading-read` (1.7) for reading text. The serif gets the extra room.
- **Weights.** Body text 400; unselected segments 500; labels and buttons 600; selected segments 700; wordmark 800/400. Bolded word starts use the user's chosen weight, 600 to 900.
- **Measure.** Keep reading columns to about 60–75 characters. The Reader's default of 680 px at 20 px meets that.

## Space, radii, shadows, motion

| Token | Value |
| --- | --- |
| `--skb-space-1` … `--skb-space-12` | 4, 8, 12, 16, 20, 24, 32, 40, 48 px (`-1 -2 -3 -4 -5 -6 -8 -10 -12`) |
| `--skb-radius-xs` | 4px: keyboard chips, notices |
| `--skb-radius-sm` | 6px: small buttons, segments |
| `--skb-radius-md` | 9px: buttons, inputs, segmented-control track |
| `--skb-radius-lg` | 14px: cards |
| `--skb-radius-pill` | 999px: switch, slider track |
| `--skb-shadow-1` | Resting lift (cards, selected segment, slider thumb) |
| `--skb-shadow-2` | Floating surfaces (menus, the demo popup) |
| `--skb-dur`, `--skb-ease` | 140ms, `cubic-bezier(0.2, 0.7, 0.2, 1)`. Use them for every transition you add. |

Radii grow with the size of the element, so a card is rounder than the button inside it. Light-theme shadows are tinted with the ink colour. Under `prefers-reduced-motion: reduce`, `--skb-dur` becomes `0ms` and theme.css also shortens every transition and animation on the page to effectively zero.

## What theme.css sets globally

- `box-sizing: border-box` on everything.
- `body`: no margin, `--skb-paper` background, `--skb-ink` text, the UI font at 14px/1.4. A page can override any of these.
- `a`: the `--skb-accent-ink` colour, a 1px underline offset by 0.2em, thickening to 2px on hover.
- `::selection`: `--skb-accent-tint`.
- `:focus-visible`: a 2px `--skb-focus` outline with a 2px offset. Don't remove it. Components that hide their native input move the ring to the part you can see.

## Components

Every class starts with `skb-`. Copy the markup exactly: the CSS relies on the element order shown, for example a radio input directly before its label.

### Button: `.skb-btn`

```html
<button class="skb-btn skb-btn--primary" type="button">Turn on for this page</button>
<button class="skb-btn" type="button">Paste text</button>
<button class="skb-btn skb-btn--ghost" type="button">Cancel</button>
<button class="skb-btn skb-btn--danger" type="button">Reset to defaults</button>
<button class="skb-btn skb-btn--small" type="button">Set a shortcut</button>
<a class="skb-btn skb-btn--ghost skb-btn--small" href="../options/options.html">Settings</a>
```

| Modifier | Effect |
| --- | --- |
| *(none)* | Surface fill with a `line-strong` border. Use it for secondary actions. |
| `--primary` | Accent fill. Use it for one main action per view. |
| `--ghost` | No fill and no border until hovered. Use it for toolbars, footers and list actions. |
| `--danger` | Danger-coloured text and border. Use it for reset and remove. |
| `--small` | 28 px tall, 13 px text. |
| `--icon` | Square and icon-only. Needs an `aria-label`. Combine it with `--small` for 28 px. |

Disabled buttons (`disabled` or `aria-disabled="true"`) drop to half opacity and lose hover feedback. Icons go inside the button as inline SVG. They are sized 18 px, or 16 px in small buttons, and drawn on a 20-unit grid with `stroke="currentColor"`, `stroke-width="1.6"` and round caps. Mark them `aria-hidden="true"`.

```html
<button class="skb-btn skb-btn--ghost skb-btn--small" type="button">
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 5.5C8.2 4.3 5.9 3.8 3 4v11c2.9-.2 5.2.3 7 1.5 1.8-1.2 4.1-1.7 7-1.5V4c-2.9-.2-5.2.3-7 1.5Z"/><path d="M10 5.5v11"/></svg>
  Reader
</button>
<button class="skb-btn skb-btn--icon" type="button" aria-label="Larger text">
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 10h10M10 5v10"/></svg>
</button>
```

### Segmented control: `.skb-seg`

These are real radio buttons. Tab moves into the group, the arrow keys change the choice, and screen readers announce a labelled radio group. The chosen segment is set in bold, which is the same signal Skimbold uses everywhere else.

```html
<div class="skb-field">
  <span class="skb-field__label" id="letters-label">Bold letters</span>
  <div class="skb-seg" role="radiogroup" aria-labelledby="letters-label">
    <input type="radio" name="letters" id="letters-auto" value="auto" checked>
    <label for="letters-auto">Auto</label>
    <input type="radio" name="letters" id="letters-1" value="1">
    <label for="letters-1">1</label>
    <input type="radio" name="letters" id="letters-2" value="2">
    <label for="letters-2">2</label>
    <input type="radio" name="letters" id="letters-3" value="3">
    <label for="letters-3">3</label>
  </div>
</div>
```

- Each `<input>` must come immediately before its `<label>`. All inputs in a group share one `name`, and every `id` must be unique on the page.
- Segments share the width equally, so the bold selected label never nudges its neighbours.
- Listen for `change` on the container: `seg.addEventListener('change', (e) => save(e.target.value))`.
- To make a Boldness control preview its own weights, give each label an inline weight, such as `<label for="w-900" style="font-weight:900">Black</label>`. The inline style overrides the selected-bold rule.
- A single disabled option is written as `<input … disabled>`.

### Switch: `.skb-switch`

A checkbox with `role="switch"`, so it is announced as "on" or "off". Text and switch can go in either order: the text takes whatever space is left.

```html
<!-- Settings row: text left, switch right -->
<label class="skb-switch">
  <span>Always on for en.wikipedia.org</span>
  <input type="checkbox" role="switch">
</label>

<!-- Inline: switch first -->
<label class="skb-switch">
  <input type="checkbox" role="switch" checked>
  <span>Bold</span>
</label>
```

Listen for `change` on the input. For a hint, add `aria-describedby` pointing at a `.skb-field__hint`.

### Slider: `.skb-range`

```html
<div class="skb-field">
  <label class="skb-field__label" for="fade">Fade rest of word</label>
  <output class="skb-field__value" for="fade">20%</output>
  <input class="skb-range" type="range" id="fade" min="0" max="60" step="5" value="20">
</div>
```

Firefox paints the filled part of the track by itself. Chromium can't, so the page sets the fill as a percentage in `--skb-fill`. Do it once on load and again on every `input` event, and update the readout at the same time:

```js
function syncRange(range, output, unit) {
  const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
  range.style.setProperty('--skb-fill', `${pct}%`);
  output.textContent = `${range.value}${unit}`;
}
```

Keyboard focus puts the brass ring around the thumb.

### Field: `.skb-field`

A field is a grid: the label on the left, an optional value readout on the right, then the control, then a hint, each at full width.

```html
<div class="skb-field">
  <label class="skb-field__label" for="strength">Strength</label>
  <output class="skb-field__value" for="strength">3</output>
  <input class="skb-range" type="range" id="strength" min="1" max="5" step="1" value="3" aria-describedby="strength-hint">
  <p class="skb-field__hint" id="strength-hint">How much of each word is bold in Auto mode.</p>
</div>
```

Use `<label for>` for a single control. For a `.skb-seg`, use `<span class="skb-field__label" id>` together with `aria-labelledby` on the group, as shown above.

### Text input and select: `.skb-input`, `.skb-select`

```html
<div class="skb-field">
  <label class="skb-field__label" for="icon-click">Clicking the toolbar icon</label>
  <select class="skb-select" id="icon-click">
    <option value="popup">Opens this panel</option>
    <option value="toggle">Turns Skimbold on or off</option>
  </select>
</div>
<textarea class="skb-input" rows="8" aria-label="Text to read"></textarea>
```

`.skb-input` works on `<input>` and `<textarea>`. A textarea can be resized vertically. The select's arrow is drawn in `currentColor`, so it follows the theme.

### Card: `.skb-card`

```html
<section class="skb-card">…</section>
```

A card is a raised surface with a hairline edge, 14 px radius and 16 px padding. Use cards to group related settings. Don't nest them, and don't wrap every paragraph in one.

### Notice: `.skb-notice`

```html
<p class="skb-notice">Browsers don't let extensions change this page. Open a regular website to use Skimbold.</p>
<p class="skb-notice skb-notice--danger" role="alert">This PDF has no selectable text. It may be a scan.</p>
```

A notice is a short explanation in the flow of the page. Add `role="alert"` or `role="status"` only when the message appears after the page has loaded.

### Keyboard chip: `.skb-kbd`

```html
<kbd class="skb-kbd">Alt</kbd> + <kbd class="skb-kbd">R</kbd>
```

Use one chip per key, joined by " + ". Build the chips from the `shortcut` string that `commands.getAll()` returns, splitting it on `+` (for example `Alt+R`). macOS reports shortcuts as symbols with no separator (for example `⌃⇧R`); show those as one chip.

### Utilities

| Class | Use |
| --- | --- |
| `.skb-muted` | Secondary text in `--skb-ink-soft` |
| `.skb-sr-only` | Text for screen readers only |
| `.skb-wordmark` | The name, as above |

## Accessibility checklist

- Every control has a visible label, and every icon-only button has an `aria-label`.
- Everything can be reached and operated with the keyboard, and the brass focus ring is always visible.
- Targets are at least 28 px tall (small buttons) and usually 36 px, above the WCAG 2.2 minimum of 24 px.
- Text contrast meets AA in all themes (see the table above), and state is never shown by colour alone: selected segments also turn bold and gain an edge.
- Motion respects `prefers-reduced-motion`.
