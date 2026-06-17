# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Studio Brochure** — a dependency-free, static web app that generates elegant, print- and
email-ready real-estate presentation brochures for buyers. The user fills in property
details (or pastes raw notes and lets Claude write the copy), uploads photos, and exports a
PDF (via print) or a self-contained HTML file. Built for Century 21 Kadima but generic.

No build step, no framework, no backend. Plain HTML/CSS/vanilla JS, runnable from any static
host (GitHub Pages) or a local `python3 -m http.server`.

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
