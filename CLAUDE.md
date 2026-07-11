# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Studio Brochure** — a dependency-free, static web app that generates elegant, print- and
email-ready real-estate presentation brochures for buyers. The user fills in property
details (or pastes raw notes and lets Claude write the copy), uploads photos, and exports a
PDF (via print) or a self-contained HTML file. Built for Century 21 Kadima but generic.

No build step, no framework, no backend. Plain HTML/CSS/vanilla JS, runnable from any static
host (GitHub Pages) or a local `python3 -m http.server`.

**`pro/` — Studio Immo**, the white-label commercial variant, lives alongside without touching
the original app. Same engine (forked copies of `app.js`/`ai.js`/`geo.js`/`library.js` under
`pro/assets/`), but: a **step-by-step wizard UI** (`pro/index.html` + `pro/assets/js/wizard.js`,
8 steps — type de bien and adresse are required, diagnostics/photos/plans/surfaces skippable,
fiche prestation with **voice dictation** via Web Speech API, final step generates brochure +
**texte publicitaire** via `BrochureAI.generateAdText`), **agency branding configured by the
user** (logo/name/contacts in a settings overlay, persisted under `studio-pro-agency`,
re-applied to every fiche; no Century 21 assets anywhere in `pro/`), and separate storage keys
(`studio-pro-v1`, `studio-pro-aikey`, IndexedDB `studio-pro`). Deployed at `/pro/` by the same
Pages workflow. When changing brochure rendering in the original app, mirror the change in
`pro/assets/` if it should ship in the commercial version (and vice versa).

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

## Note on repo contents

The root also contains sample client documents (DESPREAUX/SEVERINI `.pdf`/`.docx`). They are
source material, not part of the app, and must never be deployed publicly.
