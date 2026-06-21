/**
 * Headless-Chromium lifecycle + anti-detection setup. Wraps the stealth
 * plugin bundle once at module load and exposes `withBrowser`, which opens
 * an authenticated UW context (storageState, ET timezone, real-Chrome UA)
 * and guarantees the browser is closed afterward. The launch flags and
 * init script are validated anti-bot measures — change with care.
 */
import { type Browser, type Page } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { UW_AUTH_STATE_PATH } from '../core/config.js';

// Stealth plugin bundle — 17+ evasion modules that patch the most
// common Chromium-automation tells (chrome.runtime, navigator.plugins,
// WebGL vendor/renderer, iframe.contentWindow, permissions API, etc.).
// UW's anti-bot returns "No data available" for historical dates when
// it detects automation; the basic --disable-blink-features +
// navigator.webdriver patch isn't enough on its own. Wrapping
// chromiumExtra once at module-load time so every browser launched
// through this module gets the full stealth bundle.
chromiumExtra.use(StealthPlugin());

export async function withBrowser<T>(
  fn: (browser: Browser, page: Page) => Promise<T>,
): Promise<T> {
  // HEADLESS=false launches a visible Chromium for debugging — pair
  // with FORCE_TICK=true to step through a single scrape pass while
  // watching the page. Production deploys leave HEADLESS unset so the
  // default `true` applies.
  const headless =
    (process.env.HEADLESS ?? 'true').trim().toLowerCase() !== 'false';

  // Anti-detection flags. Validated 2026-05-08: UW Periscope serves a
  // stripped-down Single-mode dropdown (only an "All" placeholder, no
  // date list) when navigator.webdriver is true OR the
  // AutomationControlled blink feature is on. Headed runs without
  // these flags get the full 1.2 MB popover with 20 dates; headless
  // got 2 KB. These flags + the init script below close the gap.
  const browser = await chromiumExtra.launch({
    headless,
    slowMo: headless ? 0 : 250,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    // Headless: 1920×1200 to render the full Periscope widescreen layout
    // for clean DOM extraction. Headed: shrink to 1366×768 (laptop-class)
    // so the window fits on a typical screen for visual debugging.
    const viewport = headless
      ? { width: 1920, height: 1200 }
      : { width: 1366, height: 768 };
    const context = await browser.newContext({
      storageState: UW_AUTH_STATE_PATH,
      viewport,
      // Real Chrome UA — `HeadlessChrome` in the default Playwright UA
      // is the most common automation tell.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    // Hide navigator.webdriver before any page script runs.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    return await fn(browser, page);
  } finally {
    await browser.close();
  }
}
