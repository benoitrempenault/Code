# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Studio Brochure** — a dependency-free, static web app that generates elegant, print- and
email-ready real-estate presentation brochures for buyers. The user fills in property
details (or pastes raw notes and lets Claude write the copy), uploads photos, and exports a
PDF (via print) or a self-contained HTML file. Built for Century 21 Kadima but generic.

No build step, no framework, no backend. Plain HTML/CSS/vanilla JS, runnable from any static
host (GitHub Pages) or a local `python3 -m http.server`.

**Both apps now use a step-by-step wizard UI** (8 steps: type de bien and adresse required,
diagnostics/photos/plans/surfaces skippable, fiche prestation, génération). Step 7 accepts
pasted notes or a **photo/scan of handwritten notes** transcribed by `BrochureAI.extractNotes`
(vision); step 8 generates the brochure plus a **texte publicitaire** via
`BrochureAI.generateAdText` (factual, portal-style; stored in `state.adText`). The wizard logic
lives in `assets/js/wizard.js` (Kadima flavour: settings overlay for agency/palette/API key,
all steps unlocked since the app predates the wizard) and `pro/assets/js/wizard.js` (white-label
flavour: first-run agency setup with logo upload, steps unlock as you advance). Voice dictation
was removed (fiches are written at a desk, not on the phone).

**`pro/` — the white-label brochure variant** (UI branded « Studio Brochure », formerly
« Studio Immo » — all four apps now share the « Studio Brochure » brand; directory names and
storage keys keep their historical names), lives alongside without touching
the original app. Same engine (forked copies of `app.js`/`ai.js`/`geo.js`/`library.js` under
`pro/assets/`), but **agency branding configured by the user** (logo/name/contacts in a settings
overlay, persisted under `studio-pro-agency`, re-applied to every fiche; no Century 21 assets
anywhere in `pro/`), and separate storage keys (`studio-pro-v1`, `studio-pro-aikey`, IndexedDB
`studio-pro`). Deployed at `/pro/` by the same Pages workflow, with the marketing site at
`/site/`. When changing the engine or wizard in one app, mirror the change in the other if it
should ship there too.

**`mandat/`** — a third variant (UI branded « Studio Brochure », formerly « Studio Mandat » ;
do not modify `/` or `pro/` when working on it):
a hub with a home page (`mandat/index.html`, two tiles) linking a **fiche prestation app**
(`mandat/fiche.html` + `mandat/assets/js/fiche.js`: voice dictation via Web Speech, photo-of-notes
transcription, AI structuring via `BrochureAI.structureFiche`, live A4 preview, **Word export**
as an HTML `.doc` blob, print) and the **brochure** (`mandat/brochure.html`, a Kadima-flavoured
fork). The fiche's « Injecter dans la brochure » button writes `studio-mandat-handoff` to
localStorage; the brochure wizard consumes it on load (fills type/address/notes, lands on
step 2). Storage: `studio-mandat-v1` (brochure state) and `studio-mandat-fiche`; the API key
(`studio-brochure-aikey`) and the OneDrive library folder are deliberately shared with the
original app. Deployed at `/mandat/`.

**`mandat-pro/`** — the white-label commercial variant of `mandat/` (UI branded « Studio
Brochure » ; the one the
sales site `site-mandat/` links to). Same hub + fiche + brochure trio, but **the agency is
configured once at the accueil** (`mandat-pro/index.html`): a first-run overlay (logo upload
resized to PNG 640px, name required, conseiller/adresse/tél/e-mail, brochure palette, API key)
writes `studio-mandatpro-agency` (`{agency, palette}` — same shape `pro/` uses) and
`studio-mandatpro-aikey`; a « ⚙ Paramètres de l'agence » button (or `?setup=1`) reopens it.
The fiche (`fiche.html`/`fiche.js`) reads that key for the logo shown in the A4 preview and
embedded in the Word export (`logo-agence.png` MHT part; agency name shown when no logo), and
redirects to `index.html?setup=1` when unconfigured. The brochure (`brochure.html`) is the
`pro/` white-label engine (forked `app.js`/`wizard.js` with keys `studio-mandatpro-v1`/`-step`,
IndexedDB `studio-mandatpro`) plus the ⌂ Accueil link and handoff consumption
(`studio-mandatpro-handoff`); its ⚙ « Mon agence » overlay edits the same agency key. `ai.js`
is the `mandat/` fork (it has `structureFiche`). Deployed at `/mandat-pro/`.

## Architecture

- `index.html` — single-page shell: left **editor** panel (form), right **preview** (live A4).
- `assets/css/app.css` — editor/UI chrome (dark theme). Screen-only.
- `assets/css/brochure.css` — the brochure itself: A4 pages, editorial layout, DPE/GES energy
  ladders, and the `@media print` rules. **Shared by preview, print, and HTML export** — this
  is the single source of truth for how a brochure looks.
- `assets/js/app.js` — everything: the `state` object, generic form binding
  (`data-bind` / `data-bind-list` / `data-bind-kv`), photo upload+resize, `buildBrochure()`
  page renderers, zoom, localStorage persistence, and JSON/HTML/print/mailto export.
- `assets/js/ai.js` — `window.BrochureAI.generate()`: a direct browser call to the Anthropic
  Messages API (header `anthropic-dangerous-direct-browser-access`), constrained to JSON via
  `output_config.format`. Default model `claude-opus-4-8`. The user's API key lives only in
  `localStorage` (`studio-brochure-aikey`) and is never put in the exported `.json`.
- `assets/js/heic.js` — `window.SBHeic`: iPhone **HEIC/HEIF photo support**. `toJpeg(file)` tries
  native decode first (Safari reads HEIC), then falls back to the vendored WASM decoder
  (`assets/js/vendor/libheif-bundle.js`, ~1.4 MB, wasm embedded, loaded lazily on the first HEIC).
  Wired into `resizeImage` (app.js) and `fileToResizedDataUrl` (wizard.js/fiche.js) in all four
  apps — new photo entry points should funnel through those, not read files directly.
- `assets/js/library.js` — `window.BrochureLibrary`: a **brochure library backed by a local
  OneDrive-synced folder** (File System Access API). The user picks a folder once; the app
  lists/opens/saves/deletes `.json` brochures in it, and the OneDrive desktop client syncs them
  to the cloud and other devices. The chosen directory handle is persisted in **IndexedDB**
  (`studio-brochure` DB, `handles` store) so it survives reloads; read/write permission is
  re-requested on the first user gesture. Chrome/Edge desktop only — elsewhere the app falls
  back to the `.json` Import/Save buttons. The library UI (topbar `▤ Bibliothèque` → modal with
  search-by-name) is wired in `app.js` (`wireLibrary`), which tracks `currentFileName` so
  re-saving an opened brochure (e.g. to change the price) overwrites the same file.
  Both the topbar **Sauvegarder** button and the library's **Enregistrer** button funnel
  through `saveCurrentToFolder()`: on Chrome/Edge they prompt for a brochure name (`prompt`,
  sanitized by `safeName` — spaces/accents/hyphens kept, Windows-illegal chars stripped) and
  write `<name>.json` into the chosen folder; `Sauvegarder` triggers the one-time folder pick
  if none is set yet, and falls back to a plain `.json` download (`downloadJson`) on other
  browsers. Note: browsers cannot pre-set an absolute path — the user navigates to the target
  folder (e.g. `KADIMA-TB\…\BROCHURE`) once and it is remembered via IndexedDB + picker `id`.

### Key conventions
- The brochure is re-rendered from `state` on every change; `buildBrochure()` returns an HTML
  string of `.page` sections. To add a section, write a `pageX()` function and add it to the
  array in `buildBrochure()`.
- Photos are resized client-side (`resizeImage`, long edge ≤ 1800px, JPEG) and stored as data
  URLs inside `state` (so they survive JSON export and embed in HTML export).
- Project state persists to `localStorage` key `studio-brochure-v2`; durable saves are the
  `.json` export.

## Commands

- **Run locally:** `python3 -m http.server 8000` then open `http://localhost:8000`.
  (Opening `index.html` via `file://` breaks the CSS-inlining used by HTML export and may
  block the API call — always use a server.)
- **No tests / no lint** configured. Syntax-check JS with `node -c assets/js/app.js`.

## Deployment

`.github/workflows/pages.yml` publishes **only** `index.html` + `assets/` to GitHub Pages
(requires Settings → Pages → Source = GitHub Actions). It deliberately excludes the client
documents (`*.pdf`, `*.docx`) present in the repo root — **do not publish those**.

## Security

- **Untrusted input = imported `.json` / library brochures.** All text is rendered through
  `esc()` / `nl2p()` (which escapes). The only non-text sink is **image `src`**: `normalizeState`
  calls `sanitizeStateImages()`, which runs every image field (`coverPhoto`, `gallery[].url`,
  `plans[]`, `property.webQr`, `agency.logo`) through `sanitizeImageUrl()` — accepts only
  `data:image/*`, `http(s):` and `blob:`, rejects anything containing `<>"'\`` or a booby-trapped
  SVG. This is the single choke point; do **not** interpolate a raw URL into `src` elsewhere.
- `loadData()` runs `stripDangerousKeys()` (removes `__proto__`/`constructor`/`prototype`) before
  merging, and rejects a payload without a `property` object.
- `normalizeState()` backfills missing top-level objects from `DEFAULT` so a partial/old/corrupt
  `localStorage` can't white-screen the app.
- Every app + site page carries a **Content-Security-Policy** meta: `script-src 'self'
  'wasm-unsafe-eval'` on the six app pages (the HEIC decoder is WebAssembly; no inline JS —
  the two accueil pages load `assets/js/home.js`), `connect-src` limited to the Anthropic API
  + OSM Overpass + BAN + qrserver + Google Fonts. When adding a new external call, widen the CSP in
  **all** affected pages or it will be blocked. The exported `.html` deliberately has no CSP (must
  open offline from `file://`).
- The Anthropic API key lives only in `localStorage` and is never written to exported `.json`/`.html`.

## Separation rule: Century 21 vs ABR IMMO

The repo hosts two worlds that must stay visually and legally separate:
- **Century 21 Kadima internal tools** (`/` and `/mandat/`): carry the KADIMA/Century 21 logo,
  are `noindex`, and must **never** mention ABR IMMO nor link to `/legal/`.
- **Commercial product** (`/pro/`, `/mandat-pro/`, `/site/`, `/site-mandat/`, `/legal/`):
  published by ABR IMMO (legal pages), must **never** contain Century 21 marks, logos, forms
  or wording taken from agency documents (franchise confidentiality clause — see
  `docs/marque-studio-brochure.md`).
When adding footers, links or branding, respect this split.

## Note on repo contents

The root also contains sample client documents (DESPREAUX/SEVERINI `.pdf`/`.docx`). They are
source material, not part of the app, and must never be deployed publicly.
