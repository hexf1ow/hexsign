# HEXSign branding — exactly what changed

Platform: `https://esign.rapidlodge.com.au` (self-hosted OpenSign, containers `opensign-*`, db `opensign`).

## Client (SPA build — `client/client-build.tar.gz`, served from `/usr/src/app/build`)

| Change | Where |
|---|---|
| `HexFlow` → `HexSign` (142 strings, 19 files incl. 8 locales) | `assets/*.js`, `locales/*/translation.json`, `manifest.json` |
| `OpenSign™ Drive` → `HexSign™ Drive` | `assets/main-*.js`, 8 locale files |
| Page title `Rapid Lodgements` → `HexSign` | `index.html` |
| Tenant logo → `/hexsign-logo.png` | `index.html` + Mongo `partners_Tenant.Logo` |
| Footer bar: "Powered by HEXSign · Localised secure signing platform · hexflow.com.au" | `index.html` (`#hex-footer`, hidden on print) |
| Arvo typeface, self-hosted (400/700/400-italic) | `fonts/arvo-*.woff2` + `#hex-arvo-font` style |
| Font rule excludes every Font Awesome element (icons stay on `Font Awesome 6 Pro`) | same style block |
| Location card scoped to signing links only | `index.html` geo hook — `location.pathname` guard, `/load/recipientSignPdf/` |
| Coloured sidebar icons + brand colours on social icons | `#hex-icon-colors` script (rect.left < 340 + label map) |

Font Awesome comes from `https://cdn.opensignlabs.com/fonts.css` (FA Pro 6). Only `light-300`, `solid-900`,
`brands-400` actually exist there — `duotone`, `thin`, `regular` return **404**, so never switch styles blindly.

## Server (`/usr/src/app`)

| File | Change |
|---|---|
| `Utils.js` | `appName` `'HexFlow'` → `'HexSign'` (feeds 10+ mail paths); mail-template logo → `hexsign-logo.png`; header bar `#47a3ad` → `#112366` |
| `cloud/parsefunction/sendMailv3.js` | spam footer `OpenSign™` → `HexSign™`; complaint mail → `info@rapidlodge.com.au` |
| `cloud/parsefunction/sendMailWithAttachment.js` | same footer change |
| `cloud/parsefunction/sendSystemMail.js` | same footer change |
| `cloud/parsefunction/pdf/PDF.js` | `eSignName = 'OpenSign'` → `'HexSign'` → certificate reads "Digitally signed by HexSign." |
| `cloud/parsefunction/generateCertificatebydocId.js` | same `eSignName` change |
| `cloud/parsefunction/pdf/GenerateLocationMap.js` | tile user-agent `RapidLodgements-OpenSign/1.0` → `RapidLodgements-HexSign/1.0` |
| `cloud/parsefunction/pdf/PDF.js` + `generateCertificatebydocId.js` | certificate signature `ContactInfo` `hello@opensignlabs.com` → `info@rapidlodge.com.au` |
| `cloud/customRoute/docxtopdf.js` | user-facing DOCX error text `support@opensignlabs.com` → `info@rapidlodge.com.au` |
| `cloud/parsefunction/Newsletter.js` | upstream call-home `app.opensignlabs.com/api/app` → `esign.rapidlodge.com.au/api/app` |

Backups of pre-change files exist next to each as `*.bak-beforehexsign`, and inside
`/home/superuser/esign-patches/hexsign-rebrand-*/`.

## Left deliberately alone

- `OpenSign-drive` — internal i18n **key**, invisible to users; renaming it breaks lookups.
- Korean help-doc text in `locales/kr/translation.json` (developer help articles).
- Real external URLs (`youtube.com/@hexflow`, `hexflow.com.au`, Facebook page).
- Business identity: tenant name stays **Rapid Lodgements**; the product brand is **HEXSign**.

## Known cosmetic debt

- Source logo is only **350×200 px** — soft on large screens. Replace with SVG or ≥1200 px PNG.
- Icon colours are applied by a runtime script, not compiled into the build.
- Arvo ships 400/700 only; weights 300/500/600 fall back to 400.
