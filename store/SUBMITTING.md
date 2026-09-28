# Submitting Skimbold to the stores

A step-by-step guide for publishing version 1.0.0 on the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. All three are free to list; Chrome charges a one-time $5 to open a developer account.

| Store | Account | Upload | Listing text | Typical review |
| --- | --- | --- | --- | --- |
| Chrome Web Store | Google account, 2-Step Verification, $5 once | `dist/skimbold-1.0.0-chromium.zip` | [listing-chrome.md](listing-chrome.md) | A few days, sometimes a few weeks |
| Microsoft Edge Add-ons | Microsoft account, Partner Center (free) | `dist/skimbold-1.0.0-chromium.zip` | [listing-edge.md](listing-edge.md) | Up to 7 business days |
| Firefox Add-ons (AMO) | Mozilla account with two-factor authentication (free) | `dist/skimbold-1.0.0-firefox.zip` | [listing-firefox.md](listing-firefox.md) | Automatic checks in minutes; a human review may follow |

Privacy answers for all three: [privacy-practices.md](privacy-practices.md).

## 0. Before any store

1. **Check the build.** On `main`, run:
   ```sh
   npm ci
   npm test
   npm run build            # writes both zips to dist/
   npm run lint:firefox     # must end with "errors 0"
   npx playwright test
   ```
2. **Render the images**: `npm run store-assets`. It writes the five screenshots to `store/screenshots/` and the two promo tiles to `store/promo/`. Open each file and check it before you upload it. `store/promo/logo-300.png` comes from `npm run icons`.
3. **Put the website online.** The stores need the privacy policy URL to load.
   1. On GitHub, open **Settings → Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**.
   2. Push to `main`, or run the **Pages** workflow by hand from the **Actions** tab.
   3. Check that <https://loveislife767.github.io/skimbold/privacy.html> loads.
4. **Publish the GitHub release**, so the site's download button works:
   ```sh
   git tag v1.0.0 && git push origin v1.0.0
   gh release create v1.0.0 dist/skimbold-1.0.0-chromium.zip dist/skimbold-1.0.0-firefox.zip \
     --title "Skimbold 1.0.0" --notes "First public release. Install steps: https://loveislife767.github.io/skimbold/#install"
   ```

## 1. Chrome Web Store

### One-time account setup

1. Choose the Google account that will own the listing. Its email address can't be changed later, so a dedicated account is a good idea.
2. Turn on **2-Step Verification** for that account at <https://myaccount.google.com/security>. You can't publish without it.
3. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), accept the developer agreement, and pay the **one-time $5 registration fee**.
4. Go to **Account**:
   - **Publisher name:** `Simon Buhl`. This is shown on the listing.
   - **Contact email:** enter it, then click the link in the verification email. You can't publish until it's verified.
   - **Trader status:** choose **Non-trader**. Skimbold is a free, personal open-source project with no business, sales or ads. This is the EU Digital Services Act declaration. A trader would have to publish a legal name, address and phone number.

### Submit the item

1. Click **New item** and upload `dist/skimbold-1.0.0-chromium.zip`.
2. **Store listing** tab: fill in every field from [listing-chrome.md](listing-chrome.md). Assets go in these slots:

   | Slot | File |
   | --- | --- |
   | Store icon (128×128) | `extension/icons/icon-128.png` |
   | Screenshots (1280×800) | `store/screenshots/01-before-after.png` through `05-settings.png`, in order |
   | Small promo tile (440×280) | `store/promo/small-tile-440x280.png` |
   | Marquee promo tile (1400×560) | `store/promo/marquee-1400x560.png` |

3. **Privacy** tab: enter the single purpose, the five permission justifications, **No** for remote code, tick **Website content** and all three certifications, and add the privacy policy URL. All of it is in [privacy-practices.md](privacy-practices.md).
4. **Distribution** tab: free, **Public**, all regions.
5. **Test instructions** tab: paste the note from [listing-chrome.md](listing-chrome.md#test-instructions-tab).
6. Click **Submit for review**. You get an email when it's approved or if the reviewers have questions. You can choose whether it publishes automatically after approval.

## 2. Microsoft Edge Add-ons

### One-time account setup

1. Go to [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd) and sign in with a Microsoft account. Turn on two-step verification for it at <https://account.microsoft.com/security>.
2. Register for the **Microsoft Edge program** as an **Individual**. It's free.
3. Enter the publisher display name `Simon Buhl` and your contact details, then accept the agreement.

### Submit the extension

1. **Create new extension**, then upload `dist/skimbold-1.0.0-chromium.zip`, the same file as Chrome.
2. **Availability:** Public, all markets.
3. **Properties:** category **Accessibility**, website and support URL from [listing-edge.md](listing-edge.md). Leave mature content unticked.
4. **Privacy:** same answers as Chrome, from [privacy-practices.md](privacy-practices.md).
5. **Store listings → English → Edit details:** description, images and search terms from [listing-edge.md](listing-edge.md). Assets go in these slots:

   | Slot | File |
   | --- | --- |
   | Extension logo (300×300) | `store/promo/logo-300.png` |
   | Small promotional tile (440×280) | `store/promo/small-tile-440x280.png` |
   | Large promotional tile (1400×560) | `store/promo/marquee-1400x560.png` |
   | Screenshots (1280×800) | `store/screenshots/01-before-after.png` through `05-settings.png`, in order |

   Edge rejects listings that mention other browsers. The text in listing-edge.md doesn't, so paste it unchanged.
6. Click **Publish**, paste the **Notes for certification** from [listing-edge.md](listing-edge.md), and submit.

## 3. Firefox Add-ons (AMO)

### One-time account setup

1. Go to the [Add-on Developer Hub](https://addons.mozilla.org/developers/) and create a Mozilla account, or sign in.
2. Turn on **two-factor authentication** when AMO asks. It's required for developers. Save the recovery codes somewhere safe.
3. Accept the Firefox Add-on Distribution Agreement the first time you submit.

### Submit the add-on

1. Run `npm run lint:firefox` one last time. It must report 0 errors. Two warnings inside `vendor/pdfjs/` are expected, and the reviewer notes explain them.
2. **Submit a New Add-on** → **On this site** → upload `dist/skimbold-1.0.0-firefox.zip`.
3. Tick **Firefox** and **Firefox for Android**.
4. For **Do you need to submit source code?**, answer **No**. [listing-firefox.md](listing-firefox.md) explains why.
5. **Describe add-on:** name, summary, description, categories, support site, homepage, license (**MIT**) and privacy policy, all from [listing-firefox.md](listing-firefox.md).
6. Paste the **Notes to Reviewer** from [listing-firefox.md](listing-firefox.md#notes-to-reviewer). It links the exact official pdf.js files and their SHA-256 hashes.
7. Submit. When it's live, open **Edit Product Page → Images** and add the five screenshots with the captions from listing-firefox.md. AMO takes the icon from the package.

## 4. When a listing goes live

1. Add a store button to the website. In `site/index.html`, the `.install__stores` row holds the download buttons; add one line per store, for example:
   ```html
   <a class="skb-btn" href="https://chromewebstore.google.com/detail/<item-id>">Chrome Web Store</a>
   ```
   Use the listing URL each store gives you. Push to `main` and the Pages workflow republishes the site.
2. Add the same links to the **Install** section of `README.md`, and change the sentence saying the listings are on their way.

## Updating later

1. Set the new version in both `package.json` and `extension/manifest.json`; the build refuses to run if they differ. Add an entry to `CHANGELOG.md`.
2. Run the checks in step 0, then `npm run store-assets` if the interface changed.
3. Upload the new zips:
   - Chrome: **Package → Upload new package**, then **Submit for review**.
   - Edge: **Update**, then upload the package and publish.
   - AMO: **Upload New Version**.
4. Tag the version and attach both zips to a new GitHub release.

Adding a permission makes Chrome and Edge ask existing users to approve it, and it adds a new justification field. Keep [privacy-practices.md](privacy-practices.md), `PRIVACY.md` and `site/privacy.html` in step with any change to what the extension handles.
