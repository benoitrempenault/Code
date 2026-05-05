'use strict';
// Shared headless-browser manager for sources that need JavaScript execution
// (Le Bon Coin, SeLoger, PAP, etc.). Disabled by default — set
// SCRAPER_BROWSER=true in the environment to enable.
//
// Stealth: uses playwright-extra + puppeteer-extra-plugin-stealth, which
// patches navigator.webdriver, chrome runtime, languages, plugins, WebGL
// vendor strings and a few other fingerprints. Even so, sites protected by
// DataDome / Cloudflare-bot from a datacenter IP are often blocked. For
// production reliability use residential proxies (set HTTP_PROXY env var).

const path = require('path');

let chromium = null;
let stealth = null;

function ensureLoaded() {
  if (chromium) return;
  // Lazy require — only fails if user actually enables scraping without
  // having installed the optional dependencies.
  const pe = require('playwright-extra');
  chromium = pe.chromium;
  stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);
}

const isEnabled = () => process.env.SCRAPER_BROWSER === 'true';

function parseProxy() {
  const url = process.env.SCRAPER_PROXY;
  if (!url) return null;
  try {
    const u = new URL(url);
    const out = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (_) { return null; }
}

async function withBrowser(callback) {
  ensureLoaded();
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  };
  // Allow forcing a system chromium binary (Docker etc.)
  if (process.env.PW_CHROMIUM_PATH) launchOpts.executablePath = process.env.PW_CHROMIUM_PATH;
  const proxy = parseProxy();
  if (proxy) launchOpts.proxy = proxy;
  const browser = await chromium.launch(launchOpts);
  try {
    return await callback(browser);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

async function newContext(browser, { ignoreHTTPSErrors = !!process.env.SCRAPER_INSECURE_TLS } = {}) {
  return browser.newContext({
    ignoreHTTPSErrors,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 1366, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
  });
}

// Detect blocked / challenge pages by inspecting the rendered HTML body.
// Returns true if the response looks like a bot-mitigation challenge rather
// than the real listing page.
function isBlocked(html, status) {
  if (status >= 500 || status === 401) return true;
  const head = html.slice(0, 5000).toLowerCase();
  if (/un instant…|attention required|cf-mitigated|access denied|forbidden/.test(head)) return true;
  if (status === 403 || status === 410) return true;
  return false;
}

module.exports = { isEnabled, withBrowser, newContext, isBlocked };
