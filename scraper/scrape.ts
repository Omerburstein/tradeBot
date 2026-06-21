/**
 * Phase 2a — Periscope Market Maker Exposures scraper (chart view).
 *
 * Loads the UW Periscope dashboard/4 (chart view) in headless Chromium,
 * intercepts the `market_maker_exposures` JSON API response, and parses
 * per-strike Greeks (Gamma, Charm, Vanna) directly from the API payload.
 *
 * Unlike the table-view approach (dashboard/6) which required cycling
 * through Greek dropdowns and scraping HTML tables, the chart view fetches
 * ALL Greeks in a single API call — making scraping faster, more reliable,
 * and immune to HTML class-name changes.
 *
 * Auth: the runtime expects a Playwright `storageState` JSON at
 * UW_AUTH_STATE_PATH (created locally via `periscope-probe.mjs --login`,
 * then uploaded to Railway as a base64-encoded env var).
 *
 * Page-state assumptions (the user pre-configures the saved view):
 *   - Dashboard 4 has a "SPX Market Maker Exposures" chart panel
 *   - Expiry: set via the Expiry dropdown or SETUP_PAUSE_MS for manual config
 *   - Timeframe: defaults to "Latest" — UW resolves to the most recent
 *     10-min slice during RTH automatically.
 *
 * Spec: docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 *       (Phase 2 — scraper)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pino from 'pino';

// Stealth plugin bundle — 17+ evasion modules that patch the most
// common Chromium-automation tells (chrome.runtime, navigator.plugins,
// WebGL vendor/renderer, iframe.contentWindow, permissions API, etc.).
// UW's anti-bot returns "No data available" for historical dates when
// it detects automation; the basic --disable-blink-features +
// navigator.webdriver patch isn't enough on its own. Wrapping
// chromiumExtra once at module-load time so every browser launched
// through this module gets the full stealth bundle.
chromiumExtra.use(StealthPlugin());
import { LOG_LEVEL, UW_AUTH_STATE_PATH, UW_PERISCOPE_URL } from './config.js';
import {
  insertSnapshots,
  insertSpotPrices,
  insertMarketTide,
  insertConeSnapshot,
  coneSnapshotExists,
} from './db.js';
import { parseDateLabel } from './parser.js';
import type {
  Panel,
  SnapshotRow,
  MarketTideRow,
  ConeSnapshotRow,
} from './types.js';

/** Result of a single slot capture: rows + metadata for the caller. */
export interface ScrapeResult {
  rows: SnapshotRow[];
  /** SPX spot price at capture time (from the API index_values or page header). */
  spot: number | null;
}

/**
 * Shape of a single row in the UW `market_maker_exposures` API response.
 * The `data` field is an object keyed by index (0, 1, 2, ...) containing
 * these rows.
 */
interface ApiExposureRow {
  count: number;
  timestamp: string;
  gamma: string;
  strike: number;
  vanna: string;
  charm: string;
}

/**
 * Shape of the `market_maker_exposures` API response body.
 */
interface ApiExposureResponse {
  data: Record<string, ApiExposureRow>;
  timestamp: string; // e.g. "2026-06-18T20:00:00Z"
  date: string;      // e.g. "2026-06-18"
  index_values: {
    close: number;
    high: number;
    low: number;
    open: number;
  };
  prev?: ApiExposureRow[];
  prev2?: ApiExposureRow[];
  prev3?: ApiExposureRow[];
}

/**
 * Shape of a single row in the UW `market_maker_contracts` API response.
 * Each strike appears twice — once for "call" and once for "put".
 */
interface ApiContractsRow {
  count: number;
  timestamp: string;
  type: 'call' | 'put';
  strike: number;
  qty: number;
}

/**
 * Shape of the `market_maker_contracts` API response body.
 */
interface ApiContractsResponse {
  data: ApiContractsRow[];
  timestamp: string;
  date: string;
  index_values: {
    close: number;
    high: number;
    low: number;
    open: number;
  };
}

/**
 * Shape of the `bsoc/SPX/straddle?date=...` response — the ATM straddle
 * price for the day (the Cone / expected-move param). e.g. {"straddle":"40.90"}
 */
interface ApiStraddleResponse {
  straddle: string;
}

/**
 * Shape of a single `net-flow-ticks` data point (one per minute).
 */
interface ApiNetFlowRow {
  timestamp: string; // e.g. "2026-06-18T09:30:00-04:00"
  date: string;      // e.g. "2026-06-18"
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
}

/**
 * Shape of the `net-flow-ticks?date=...` response body (Market Tide).
 * `data` is the full trading day at 1-min granularity (~390 points).
 */
interface ApiNetFlowResponse {
  data: ApiNetFlowRow[];
  prices?: unknown;
}

// US equity-options market holidays. SPX trading is closed on these
// dates. Maintained inline because the periscope-scraper service does
// not pull a holiday calendar from anywhere else; if the user backfills
// a year not covered here, dates that fall on holidays will produce
// "No data available" and the scraper logs + skips them, so the
// holiday list is a perf optimization (skip-without-attempt), not a
// correctness gate.
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  '2025-01-01',
  '2025-01-20',
  '2025-02-17',
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

const logger = pino({ level: LOG_LEVEL });

/**
 * Minimum gamma magnitude (|gamma|) for a strike to be persisted. Strikes
 * whose gamma is within ±this value are dropped entirely, along with their
 * charm/vanna rows — gamma is the anchor that gates the whole strike.
 */
const GAMMA_MIN_ABS = 150;

/** Greeks present in the API response, in capture order. */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; key: keyof Pick<ApiExposureRow, 'gamma' | 'charm' | 'vanna'> }> = [
  { panel: 'gamma', key: 'gamma' },
  { panel: 'charm', key: 'charm' },
  { panel: 'vanna', key: 'vanna' },
];

// ── Time-window helpers (used by both walkers and the backfill loop) ──

const TIMEFRAME_PATTERN = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

/** "8:20" → "08:20"; "08:20" → "08:20". Stable HH:MM string compare. */
function normalizeHhmm(hhmm: string): string {
  const parts = hhmm.split(':');
  const h = parts[0] ?? '0';
  const m = parts[1] ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Extract the slot-start time from a Periscope timeframe label. */
function parseTimeframeStart(label: string): string | null {
  const m = label.match(TIMEFRAME_PATTERN);
  if (m?.[1] == null) return null;
  return normalizeHhmm(m[1]);
}

function prevDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The latest date for which UW market data is available.
 * Returns today if the market has already opened (past 09:20 ET) and
 * today is a trading day. Otherwise walks backwards past weekends and
 * holidays until it finds the most recent trading day.
 */
function latestTradingDay(): string {
  const now = new Date();

  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const hhmm = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  let candidate = hhmm >= '09:20' ? todayYmd : prevDay(todayYmd);

  while (true) {
    const dow = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !US_MARKET_HOLIDAYS.has(candidate)) {
      return candidate;
    }
    candidate = prevDay(candidate);
  }
}

/**
 * The previous trading day before `ymd` (Mon-Fri, US-market non-holiday).
 * Pure calendar arithmetic in UTC — used by the walk-back reader to step
 * backwards through history one session at a time.
 */
function prevTradingDay(ymd: string): string {
  let candidate = prevDay(ymd);
  while (true) {
    const dow = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !US_MARKET_HOLIDAYS.has(candidate)) {
      return candidate;
    }
    candidate = prevDay(candidate);
  }
}

/** Advance an HH:MM string by 10 minutes. "08:20" → "08:30", "08:50" → "09:00". */
function nextTimeframe(slotStartHhmm: string): string {
  const [hStr, mStr] = slotStartHhmm.split(':');
  const totalMin =
    Number.parseInt(hStr ?? '0', 10) * 60 +
    Number.parseInt(mStr ?? '0', 10) +
    10;
  const newH = Math.floor(totalMin / 60);
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// computeCapturedAt + isInRth live in ./dates.ts so unit tests can
// exercise them without booting config.ts (which validates env vars
// at module load). Imported for internal use AND re-exported so
// existing callers (and tests) keep working unchanged.
import { computeCapturedAt } from './dates.js';
export { computeCapturedAt };

/**
 * Convert a UTC ISO timestamp (from the API response) to an ET HH:MM
 * string. Used to derive the timeframe label for DB rows so it matches
 * exactly what the UW dashboard shows (Eastern Time).
 */
function utcToETHhmm(utcIso: string): string {
  const d = new Date(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/**
 * Derive a UW-style timeframe label from an API timestamp.
 * The API timestamp represents the slot END time.
 * Returns e.g. "09:20 - 09:30" (ET) from the end time "09:30".
 */
function apiTimestampToTimeframe(utcIso: string): string {
  const endHhmm = utcToETHhmm(utcIso);
  // Slot start is 10 minutes before end
  const d = new Date(utcIso);
  d.setMinutes(d.getMinutes() - 10);
  const startHhmm = utcToETHhmm(d.toISOString());
  return `${startHhmm} - ${endHhmm}`;
}

/**
 * Convert an API exposure response into SnapshotRow[] for all three Greeks.
 * Each row in the API data has gamma, charm, vanna as string fields — we
 * parse them into numeric values and emit one SnapshotRow per (strike, greek).
 */
function apiResponseToRows(
  apiData: ApiExposureResponse,
  capturedAt: string,
): { rows: SnapshotRow[]; spot: number; timeframe: string; expiry: string; qualifyingStrikes: Set<number> } {
  const rows: SnapshotRow[] = [];
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  const expiry = apiData.date; // YYYY-MM-DD
  const spot = apiData.index_values.close;

  const dataRows = Object.values(apiData.data);

  // Gamma is the anchor: only persist strikes whose gamma magnitude exceeds
  // the threshold. Charm/Vanna for a strike are kept only when that same
  // strike's gamma qualifies — i.e. a strike is all-or-nothing across Greeks.
  const qualifyingStrikes = new Set<number>();
  for (const row of dataRows) {
    const gamma = Number.parseFloat(row.gamma);
    if (Number.isFinite(gamma) && Math.abs(gamma) > GAMMA_MIN_ABS) {
      qualifyingStrikes.add(row.strike);
    }
  }

  for (const greek of GREEKS_TO_CAPTURE) {
    for (const row of dataRows) {
      if (!qualifyingStrikes.has(row.strike)) continue;
      const valueStr = row[greek.key];
      const value = Number.parseFloat(valueStr);
      if (!Number.isFinite(value)) continue;
      // Skip rows where all Greeks are zero (noise at extreme strikes)
      // Keep zero values though since they can be meaningful at specific strikes
      rows.push({
        capturedAt,
        expiry,
        panel: greek.panel,
        strike: row.strike,
        value,
        timeframe,
      });
    }
  }

  return { rows, spot, timeframe, expiry, qualifyingStrikes };
}

/**
 * Convert an API contracts response into SnapshotRow[] for positions.
 * Each strike has a call row and a put row — we net them (call_qty + put_qty)
 * to produce one SnapshotRow per strike with panel='positions'.
 * Only includes strikes that appear in `qualifyingStrikes` (gamma-gated).
 */
function contractsResponseToRows(
  apiData: ApiContractsResponse,
  capturedAt: string,
  qualifyingStrikes: ReadonlySet<number>,
): SnapshotRow[] {
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  const expiry = apiData.date;

  // Aggregate net qty per strike (call + put).
  const netByStrike = new Map<number, number>();
  for (const row of apiData.data) {
    if (!qualifyingStrikes.has(row.strike)) continue;
    const prev = netByStrike.get(row.strike) ?? 0;
    netByStrike.set(row.strike, prev + row.qty);
  }

  const rows: SnapshotRow[] = [];
  for (const [strike, value] of netByStrike) {
    rows.push({
      capturedAt,
      expiry,
      panel: 'positions',
      strike,
      value,
      timeframe,
    });
  }
  return rows;
}

/**
 * Open the Expiry filter, switch to Single mode, and click the row
 * matching `targetYmd` (YYYY-MM-DD). Returns true on success.
 *
 * UW Periscope renders the Expiry filter as a DropdownFilter component.
 * In the chart view (dashboard/4), dates are shown as "YYYY-MM-DD (Nd)"
 * format, e.g. "2026-06-17 (1d)".
 */
async function setExpirySingle(
  page: Page,
  targetYmd: string,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetYmd)) {
    throw new Error(`setExpirySingle: invalid target "${targetYmd}"`);
  }
  // UW dialog shows dates as "YYYY-MM-DD (Nd)" e.g. "2026-06-17 (1d)"
  const datePattern = new RegExp(`^${escapeRegex(targetYmd)}\\s*\\(`);

  // Find the Expiry dropdown trigger — stable sentry component attribute.
  const trigger = page
    .locator('[data-sentry-component="DropdownFilter"]')
    .filter({ has: page.locator('span', { hasText: /^Expiry$/ }) })
    .first();
  if ((await trigger.count()) === 0) {
    logger.warn('setExpirySingle: Expiry trigger not found');
    return false;
  }

  const dialogId = await trigger.getAttribute('aria-controls');

  // Approach 1: real mouse move + click (triggers hover/focus states that
  // Radix components sometimes require before the dialog fires).
  const box = await trigger.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(300);
    await page.mouse.click(cx, cy);
  } else {
    // Fallback: synthetic click with force
    await trigger.click({ timeout: 5_000, force: true });
  }
  await page.waitForTimeout(1_500);

  // Approach 2: if the dialog still hasn't opened, try a JS-level click
  // (bypasses Playwright event dispatch entirely — hits the DOM handler directly).
  const isExpanded = await trigger.getAttribute('aria-expanded');
  if (isExpanded !== 'true') {
    logger.info('setExpirySingle: mouse click did not open dialog — trying JS click');
    await page.evaluate(() => {
      const filters = document.querySelectorAll('[data-sentry-component="DropdownFilter"]');
      for (const el of filters) {
        if (el.textContent?.includes('Expiry')) {
          (el as HTMLElement).click();
          break;
        }
      }
    });
    await page.waitForTimeout(1_500);
  }

  // Wait for the dialog to appear.
  const dialog =
    dialogId != null
      ? page.locator(`[id="${dialogId}"]`).first()
      : page.locator('[role="dialog"]').first();
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    // Save debug HTML so we can inspect the state when the dialog fails to open.
    const debugHtml = await page.content().catch(() => '');
    const debugPath = resolve('docs/temp', `expiry-debug-${Date.now()}.html`);
    await mkdir(resolve('docs/temp'), { recursive: true });
    await writeFile(debugPath, debugHtml, 'utf8').catch(() => undefined);
    logger.warn(
      { dialogId, debugPath, ariaExpanded: isExpanded },
      'setExpirySingle: dialog did not appear — debug HTML saved',
    );
    await page.keyboard.press('Escape');
    return false;
  }

  // Always try to switch to Single mode first — in Multi mode clicking a
  // date only toggles a checkbox and the dialog stays open.
  const singleBtn = dialog.getByText('Single', { exact: true }).first();
  if ((await singleBtn.count()) > 0) {
    await singleBtn.click({ timeout: 3_000 });
    await page.waitForTimeout(500);
  }

  // Wait for a date row in YYYY-MM-DD (Nd) format to be visible.
  await dialog
    .locator('span, div, td, li', { hasText: /^\d{4}-\d{2}-\d{2}\s*\(/ })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => undefined);

  // Click the row whose text starts with "YYYY-MM-DD (" e.g. "2026-06-17 (1d)"
  const target = dialog
    .locator('span, div, td, li', { hasText: datePattern })
    .first();

  if ((await target.count()) === 0) {
    const dialogHtml = await dialog.innerHTML().catch(() => '');
    logger.warn(
      { targetYmd, dialogHtmlLen: dialogHtml.length },
      'setExpirySingle: target date not found in dialog',
    );
    await page.keyboard.press('Escape');
    return false;
  }

  await target.click({ timeout: 3_000, force: true });

  // In Single mode Radix closes the dialog automatically; give it a moment.
  await page.waitForTimeout(500);

  // If dialog is still visible, try pressing Enter (activates focused item)
  // then fall back to clicking outside the modal.
  if (await dialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  if (await dialog.isVisible().catch(() => false)) {
    // Click in the page margin well outside the dialog to dismiss it.
    await page.mouse.click(10, 10);
    await page.waitForTimeout(500);
  }

  // Verify the trigger pill updated away from "All"
  const newValue = await trigger.locator('span.text-base').first().textContent().catch(() => '');
  logger.info({ targetYmd, newValue }, 'setExpirySingle: date selected');
  return true;
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function setDTEZero(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="dte-filter"]').first();
  if ((await trigger.count()) === 0) {
    logger.warn('setDTEZero: dte-filter trigger not found — skipping');
    return;
  }
  await trigger.click({ timeout: 5_000 });
  // Popover opens via Radix portal — wait for the inputs to be paintable.
  await page.waitForTimeout(800);

  const minInput = page.getByPlaceholder(/min dte/i).first();
  const maxInput = page.getByPlaceholder(/max dte/i).first();

  if ((await minInput.count()) === 0 || (await maxInput.count()) === 0) {
    logger.warn('setDTEZero: Min/Max DTE inputs not found — skipping');
    await page.keyboard.press('Escape');
    return;
  }

  // Use pressSequentially-then-Tab so React sees a real keystroke per
  // character + the blur event UW likely uses to commit. fill() can
  // occasionally bypass the controlled-input handler if React batches
  // updates.
  await minInput.click();
  await minInput.fill('');
  await minInput.pressSequentially('0');
  await page.keyboard.press('Tab');
  await maxInput.click();
  await maxInput.fill('');
  await maxInput.pressSequentially('0');
  await page.keyboard.press('Tab');

  // Verify the inputs hold "0" before closing.
  const minVal = await minInput.inputValue();
  const maxVal = await maxInput.inputValue();
  logger.info({ minVal, maxVal }, 'setDTEZero: input values after fill');

  // Close the popover. UW's filter applies on input change, so Escape
  // shouldn't undo it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_500);

  // Diagnostic: log what the trigger pills show now, so a flaky filter
  // commit shows up obviously in the next run's output.
  const pills: Record<string, string> = {};
  const dropdowns = page.locator('div[data-sentry-component="DropdownFilter"]');
  const dropdownCount = await dropdowns.count();
  for (let i = 0; i < dropdownCount; i += 1) {
    const dd = dropdowns.nth(i);
    const spans = dd.locator('span');
    const spanCount = await spans.count();
    let key = '';
    for (let j = 0; j < spanCount; j += 1) {
      const span = spans.nth(j);
      const cls = (await span.getAttribute('class')) ?? '';
      const txt = ((await span.textContent()) ?? '').trim();
      if (cls.includes('text-xs')) {
        key = txt;
      } else if (cls.includes('text-base') && key !== '') {
        pills[key] = txt;
        break;
      }
    }
  }
  const dateBtn = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  if ((await dateBtn.count()) > 0) {
    pills['__date'] = ((await dateBtn.textContent()) ?? '').trim();
  }
  logger.info({ pills }, 'setDTEZero: trigger pill state after apply');
}

/**
 * Walk the date picker chevrons until the displayed label matches the
 * target YYYY-MM-DD. UW's date picker label looks like "Thu, May 7"
 * — we parse the current label via parseDateLabel + the target's year,
 * then click prev or next based on direction. Caps at 30 attempts to
 * prevent infinite loops on unparseable labels.
 */
async function walkDateToTarget(page: Page, targetYmd: string): Promise<void> {
  const yearStr = targetYmd.slice(0, 4);
  const year = Number.parseInt(yearStr, 10);
  if (!Number.isFinite(year)) {
    throw new Error(`walkDateToTarget: invalid target "${targetYmd}"`);
  }

  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const prevBtn = page.getByLabel('Previous day').first();
  const nextBtn = page.getByLabel('Next day').first();

  // Decide between the day-chevron path (cheap for ±1-3 days) and the
  // calendar widget (cheap for big jumps). Sequential day-chevron
  // clicks past ~10 in a row appear to trip UW's anti-bot — historical
  // backfills returned 0 rows for every slot until the calendar path
  // was added. Threshold is conservative: anything more than 5
  // calendar-days hops over to the calendar.
  const currentLabel = ((await labelLoc.textContent()) ?? '').trim();
  const currentYmd = parseDateLabel(currentLabel, year);
  if (currentYmd === targetYmd) {
    logger.debug(
      { targetYmd, attempts: 0 },
      'walkDateToTarget: already on target',
    );
    return;
  }
  if (currentYmd != null) {
    const daysApart = Math.abs(daysBetweenYmd(currentYmd, targetYmd));
    if (daysApart > 5) {
      await walkDateViaCalendar(page, targetYmd);
      return;
    }
  }

  // Cap at 200 — covers a full half-year walk if the storageState's
  // saved date is far from the target (which happens on the first day
  // of a multi-month backfill range). Within a range loop, day-to-day
  // walks are 1-3 clicks so the cap is never hit in steady state.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const label = ((await labelLoc.textContent()) ?? '').trim();
    const ymd = parseDateLabel(label, year);
    if (ymd === targetYmd) {
      logger.debug(
        { targetYmd, attempts: attempt },
        'walkDateToTarget: matched (day-chevron path)',
      );
      return;
    }
    if (ymd === null) {
      throw new Error(
        `walkDateToTarget: cannot parse current label "${label}"`,
      );
    }
    if (ymd > targetYmd) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkDateToTarget: did not reach ${targetYmd} after 200 chevron clicks`,
  );
}

/**
 * Calendar-based date walker. Used for big jumps (multi-month backfills)
 * where the day-chevron path would (a) take 80+ clicks and (b) get
 * throttled by UW's anti-bot.
 *
 * Flow:
 *   1. Click `[data-testid="date-picker-button"]` to open the calendar.
 *   2. Read the month-header label ("May 2026"). Compute month delta vs.
 *      the target.
 *   3. Click `aria-label="Previous month"` (or Next) the required number
 *      of times.
 *   4. Click the day cell — `<button>` containing `<span
 *      class="font-medium">{day}</span>`. Skip disabled cells (UW marks
 *      non-trading days with `disabled` + `cursor-not-allowed`).
 *   5. The calendar should auto-close on day-click; if not, press Esc.
 */
async function walkDateViaCalendar(
  page: Page,
  targetYmd: string,
): Promise<void> {
  const targetYear = Number.parseInt(targetYmd.slice(0, 4), 10);
  const targetMonth = Number.parseInt(targetYmd.slice(5, 7), 10); // 1-12
  const targetDay = Number.parseInt(targetYmd.slice(8, 10), 10);

  // Step 1: open the calendar
  const datePill = page.locator('[data-testid="date-picker-button"]').first();
  await datePill.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 2-3: walk months until the header matches target. The header
  // is unique inside the popup — match it by regex on text.
  const monthHeader = page.locator('text=/^[A-Z][a-z]+ 20[0-9]{2}$/').first();
  const prevMonth = page.getByLabel('Previous month').first();
  const nextMonth = page.getByLabel('Next month').first();
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const headerText = ((await monthHeader.textContent()) ?? '').trim();
    const m = /^([A-Z][a-z]+) (20[0-9]{2})$/.exec(headerText);
    if (m == null) {
      throw new Error(
        `walkDateViaCalendar: unparseable month header "${headerText}"`,
      );
    }
    const curMonth = MONTH_NAME_TO_NUM[m[1]!] ?? 0;
    const curYear = Number.parseInt(m[2]!, 10);
    if (curYear === targetYear && curMonth === targetMonth) {
      break;
    }
    const curMonths = curYear * 12 + curMonth;
    const targetMonths = targetYear * 12 + targetMonth;
    if (curMonths > targetMonths) {
      await prevMonth.click({ timeout: 3_000 });
    } else {
      await nextMonth.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(300);
  }

  // Step 4: click the day cell. Filter to enabled cells only — disabled
  // cells (non-trading days, dates outside UW's retention window) are
  // marked with the `disabled` attribute.
  const dayCell = page
    .locator(
      `button:not([disabled]):has(span.font-medium:text-is("${targetDay}"))`,
    )
    .first();
  await dayCell.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 5: confirm the date pill now reflects the target (the popup
  // should auto-close on day-click; if it didn't, the assertion still
  // works because the pill text reflects the new selection).
  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const finalLabel = ((await labelLoc.textContent()) ?? '').trim();
  const finalYmd = parseDateLabel(finalLabel, targetYear);
  if (finalYmd !== targetYmd) {
    // Try to dismiss the popup before throwing so subsequent clicks
    // aren't shadowed.
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `walkDateViaCalendar: pill shows "${finalLabel}" (parsed=${finalYmd ?? 'null'}) after click — wanted ${targetYmd}`,
    );
  }
  logger.debug({ targetYmd }, 'walkDateViaCalendar: matched');
}

const MONTH_NAME_TO_NUM: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

/** Calendar-day diff between two YYYY-MM-DD strings (target - current).
 *  Negative when current > target. Used to decide whether to use the
 *  day-chevron path or the calendar path. */
function daysBetweenYmd(currentYmd: string, targetYmd: string): number {
  const a = new Date(`${currentYmd}T12:00:00Z`).getTime();
  const b = new Date(`${targetYmd}T12:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Enumerate trading days (Mon-Fri, US-market non-holidays) from
 * `startDate` through `endDate`, inclusive. Both bounds are YYYY-MM-DD.
 *
 * Uses UTC throughout — date arithmetic is purely calendrical here, no
 * intraday timezone questions. The returned dates are themselves the
 * trading-session calendar dates the scraper will navigate to.
 */
export function tradingDaysBetween(
  startDate: string,
  endDate: string,
): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(
      `tradingDaysBetween: invalid bound — start="${startDate}" end="${endDate}"`,
    );
  }
  while (cursor.getTime() <= end.getTime()) {
    const ymd = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5 && !US_MARKET_HOLIDAYS.has(ymd)) {
      out.push(ymd);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Walk the timeframe-widget chevrons until the displayed slot starts at
 * `targetStartHhmm` (ET — the widget renders in the browser's ET tz).
 * Caps at 80 attempts (covers the full 9:20–16:00 day plus a buffer).
 */
async function walkTimeframeToTarget(
  page: Page,
  targetStartHhmm: string,
): Promise<void> {
  const target = normalizeHhmm(targetStartHhmm);
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  const labelSpan = container.locator('span').last();
  const prevBtn = container.locator('button').first();
  const nextBtn = container.locator('button').last();

  // The first label after a date change is often "Latest" — UW's
  // default setting that resolves to the most-recent slot during RTH
  // but is non-parseable on historical dates. We treat any
  // null-parse result as "click prev to escape into specific-time
  // territory" rather than throwing. Cap raised to 90 so the escape
  // attempts plus a full session walk-back fit within budget.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const label = ((await labelSpan.textContent()) ?? '').trim();
    const currentStart = parseTimeframeStart(label);
    if (currentStart === target) {
      logger.debug(
        { target, attempts: attempt },
        'walkTimeframeToTarget: matched',
      );
      return;
    }
    if (currentStart === null) {
      // Likely "Latest" or another non-HHMM label. Click prev to step
      // into specific-time territory; the next iteration will parse.
      logger.debug(
        { label, target },
        'walkTimeframeToTarget: non-HHMM label, clicking prev to escape',
      );
      await prevBtn.click({ timeout: 3_000 });
    } else if (currentStart > target) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkTimeframeToTarget: did not reach ${target} after 90 chevron clicks`,
  );
}

/**
 * Advance the timeframe by one slot (10 min forward) by clicking the
 * next-chevron button. Caller is responsible for the post-click
 * settle wait — we don't impose one here so the caller can absorb
 * jitter (e.g. data fetch) however suits.
 */
async function advanceTimeframeOneSlot(page: Page): Promise<void> {
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  await container.locator('button').last().click({ timeout: 3_000 });
}

/**
 * Step the timeframe one slot backwards (10 min earlier). Used to
 * escape the "Latest" sentinel when it renders empty — pre-market /
 * post-close, the most recent specific slot has data even when
 * "Latest" appears empty in DTE=[0,0] mode.
 */
async function rewindTimeframeOneSlot(page: Page): Promise<void> {
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  await container.locator('button').first().click({ timeout: 3_000 });
}

async function withBrowser<T>(
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

/**
 * Read the strike-axis tick labels currently rendered on the chart and return
 * the furthest distance (in points) from `spot`, or null if none are readable.
 *
 * The strike axis is drawn as SVG `<text>` ticks (e.g. `7375` … `7600`). Other
 * panels on the page also draw numeric SVG text, so we keep only labels within
 * 1000 points of spot — SPX strikes always sit within a few hundred points of
 * the underlying, while unrelated labels are far outside that band.
 */
async function furthestVisibleStrikeDistance(
  page: Page,
  spot: number,
): Promise<number | null> {
  const strikes = await page.evaluate(() => {
    const out: number[] = [];
    for (const t of Array.from(document.querySelectorAll('svg text'))) {
      const txt = t.textContent?.trim() ?? '';
      if (/^\d{3,6}$/.test(txt)) out.push(Number(txt));
    }
    return out;
  });
  let max: number | null = null;
  for (const s of strikes) {
    const dist = Math.abs(s - spot);
    if (dist > 1000) continue; // exclude numeric labels from other panels
    if (max === null || dist > max) max = dist;
  }
  return max;
}

/**
 * Zoom the chart out until the furthest visible strike is at least
 * `minStrikeDistance` points from the current SPX price (or the zoom-out
 * button runs out / we hit `maxClicks`). Each click widens the strike axis,
 * so the furthest-strike distance grows monotonically toward the threshold.
 *
 * Called after the page loads and the chart is ready, before any date/filter
 * manipulation begins.
 */
async function clickZoomOut(
  page: Page,
  minStrikeDistance = 120,
  maxClicks = 12,
): Promise<void> {
  const zoomOutBtn = page.locator('svg.lucide-zoom-out').locator('..');
  if ((await zoomOutBtn.count()) === 0) {
    logger.debug('zoom-out button not found');
    return;
  }

  for (let clicks = 0; clicks < maxClicks; clicks++) {
    const spot = await readSpotPrice(page);
    const dist =
      spot !== null ? await furthestVisibleStrikeDistance(page, spot) : null;
    if (dist !== null && dist >= minStrikeDistance) {
      logger.info(
        { dist, minStrikeDistance, clicks },
        'zoom-out: furthest strike far enough — stopping',
      );
      return;
    }
    await zoomOutBtn.first().click();
    // Wait for the chart to re-render after zoom change.
    await page.waitForTimeout(500);
  }

  const spot = await readSpotPrice(page);
  const dist =
    spot !== null ? await furthestVisibleStrikeDistance(page, spot) : null;
  logger.warn(
    { dist, minStrikeDistance, maxClicks },
    'zoom-out: hit max clicks before reaching target strike distance',
  );
}

/**
 * Wait for the page to have loaded enough that data is rendered.
 * For the chart view, we look for the "SPX Market Maker Exposures" title
 * or the Timeframe widget — either means the chart panel is mounted.
 *
 * Returns true if the chart appears ready, false on timeout.
 */
async function waitForChartReady(
  page: Page,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check for the Timeframe widget (reliable indicator the MM Exposures
    // panel is rendered and interactive).
    const tfCount = await page.locator('span', { hasText: /^Timeframe:$/ }).count();
    if (tfCount > 0) return true;

    // Also check for explicit "No data available"
    const noDataCount = await page.getByText(/no data available/i).count();
    if (noDataCount > 0) return false;

    await page.waitForTimeout(1_000);
  }
  logger.warn('waitForChartReady timed out');
  return false;
}

/**
 * Read the current Timeframe label from the page.
 * Returns the label text like "15:50 - 16:00" or "Latest".
 */
async function readTimeframeLabel(page: Page): Promise<string> {
  try {
    const container = page
      .locator('div.rounded-full')
      .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
      .first();
    const labelSpan = container.locator('span').last();
    return ((await labelSpan.textContent()) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Read the SPX spot price from the chart view page header.
 * The chart view shows: `<span class="pr-2">SPX</span>7,500.63`
 * Falls back to the `Underlying: ($XXXX.XX)` pattern used by the table view.
 */
async function readSpotPrice(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    // Chart view pattern: SPX followed by price
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      if (span.textContent?.trim() === 'SPX') {
        // The price is in the next text node or sibling
        const parent = span.parentElement;
        if (parent) {
          const text = parent.textContent ?? '';
          const match = text.match(/SPX\s*([\d,]+\.\d+)/);
          if (match?.[1]) {
            const v = parseFloat(match[1].replace(/,/g, ''));
            if (isFinite(v) && v > 0) return v;
          }
        }
      }
    }
    // Table view fallback: Underlying: ($XXXX.XX)
    for (const span of spans) {
      const match = span.textContent?.match(/Underlying:\s*\(\$([\d.]+)\)/);
      if (match?.[1]) {
        const v = parseFloat(match[1]);
        if (isFinite(v) && v > 0) return v;
      }
    }
    return null;
  });
}

export async function scrapeAllPanels(): Promise<ScrapeResult> {
  return await withBrowser(async (_browser, page) => {
    // Intercept market_maker_exposures API responses. We collect ALL
    // JSON responses and filter for the one we need after page settles.
    const saveDebug = (process.env.SAVE_SCREENSHOT ?? '').trim().toLowerCase() === 'true';
    const apiCaptures: Array<{ url: string; body: unknown }> = [];
    const mmeResponses: Array<{ url: string; body: ApiExposureResponse }> = [];
    const mmcResponses: Array<{ url: string; body: ApiContractsResponse }> = [];
    const straddleResponses: Array<{ url: string; body: ApiStraddleResponse }> = [];
    const tideResponses: Array<{ url: string; body: ApiNetFlowResponse }> = [];

    page.on('response', (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] ?? '';
      if (ct.includes('json')) {
        response.json().then((body) => {
          if (saveDebug) {
            apiCaptures.push({ url, body });
          }
          if (url.includes('market_maker_exposures')) {
            mmeResponses.push({ url, body: body as ApiExposureResponse });
          }
          if (url.includes('market_maker_contracts')) {
            mmcResponses.push({ url, body: body as ApiContractsResponse });
          }
          if (url.includes('/straddle')) {
            straddleResponses.push({ url, body: body as ApiStraddleResponse });
          }
          if (url.includes('net-flow-ticks')) {
            tideResponses.push({ url, body: body as ApiNetFlowResponse });
          }
        }).catch(() => undefined);
      }
    });

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });

    // Wait for the chart to render (look for Timeframe widget or data).
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    // TARGET_DATE overrides the date to scrape. Useful for running against
    // the previous trading day when today's market hasn't opened yet.
    // Must be YYYY-MM-DD. Defaults to the latest trading day (ET) when not set.
    const rawTargetDate = (process.env.TARGET_DATE ?? '').trim();
    const today =
      /^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate) ? rawTargetDate : latestTradingDay();

    logger.info({ today }, 'scrapeAllPanels: target date');

    // Step 1: always walk the date picker to the target date first.
    try {
      await walkDateToTarget(page, today);
      await page.waitForTimeout(1_000);
    } catch (err) {
      logger.warn(
        { today, err: err instanceof Error ? err.message : String(err) },
        'walkDateToTarget(today) failed — proceeding with current chart date',
      );
    }

    // SETUP_PAUSE_MS >= 5000: open the browser visibly (set HEADLESS=false),
    // pause here so you can configure the page manually (e.g. set Expiry),
    // then the scraper continues straight to capture — no automated filter.
    // When unset or < 5000: automated setExpirySingle runs instead.
    const setupPauseMs = Number.parseInt(
      process.env.SETUP_PAUSE_MS ?? '0',
      10,
    );
    if (setupPauseMs >= 5_000) {
      logger.info(
        { setupPauseMs },
        'SETUP_PAUSE_MS set — waiting for manual page configuration',
      );
      await page.waitForTimeout(setupPauseMs);
      logger.info('setup pause complete — continuing scrape');
    } else {
      // Step 2: automated expiry filter — set Expiry to Single mode for
      // the target date. Falls back to DTE=[0,0] when the dialog fails.
      let usedSingleExpiry = false;
      try {
        usedSingleExpiry = await setExpirySingle(page, today);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'setExpirySingle threw — falling back to DTE=[0,0]',
        );
      }

      // Dismiss any dialog that may still be open before checking the table.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      if (usedSingleExpiry) {
        // Wait for API response to come back after expiry change.
        await page.waitForTimeout(2_000);
        logger.info(
          { today, mode: 'single-expiry' },
          'live tick prep complete',
        );
      } else {
        logger.info({ today }, 'Single-Expiry unavailable — using DTE=[0,0]');
        await setDTEZero(page);
        await page.waitForTimeout(2_000);
      }
    }

    // Wait for network to settle after filter changes — the chart view
    // fires new API calls when filters change.
    await page.waitForLoadState('networkidle').catch(() => undefined);
    // Extra settle time for any trailing API calls. // anti-bot
    await page.waitForTimeout(2_000);

    if (saveDebug) {
      const ts = Date.now();
      const outDir = resolve('docs/tmp');
      const tempDir = resolve('docs/temp');
      await mkdir(outDir, { recursive: true });
      await mkdir(tempDir, { recursive: true });
      const screenshotPath = resolve(outDir, `scrape-${ts}.png`);
      const htmlPath = resolve(tempDir, `scrape-${ts}.html`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await writeFile(htmlPath, await page.content(), 'utf8');
      if (apiCaptures.length > 0) {
        const apiPath = resolve(tempDir, `api-${ts}.json`);
        await writeFile(apiPath, JSON.stringify(apiCaptures, null, 2), 'utf8');
        logger.info({ apiPath, count: apiCaptures.length }, 'api responses saved');
      }
      logger.info({ screenshotPath, htmlPath }, 'screenshot and html saved');
    }

    // Find the best market_maker_exposures response to use.
    // Prefer the one with `expiry=<target date>` over `expiry=all`.
    // If none match the target date, fall back to any specific-expiry response.
    logger.info(
      { mmeResponseCount: mmeResponses.length, urls: mmeResponses.map(r => r.url) },
      'scrapeAllPanels: collected MME API responses',
    );

    let bestResponse: ApiExposureResponse | null = null;
    for (const r of mmeResponses) {
      if (r.url.includes(`expiry=${today}`)) {
        bestResponse = r.body;
        break;
      }
    }
    // Fall back to any non-"all" expiry response
    if (bestResponse === null) {
      for (const r of mmeResponses) {
        if (!r.url.includes('expiry=all')) {
          bestResponse = r.body;
          break;
        }
      }
    }
    // Last resort: use the "all" expiry response
    if (bestResponse === null && mmeResponses.length > 0) {
      bestResponse = mmeResponses[mmeResponses.length - 1]!.body;
    }

    if (bestResponse === null) {
      logger.warn('scrapeAllPanels: no market_maker_exposures API response captured');
      return { rows: [], spot: null };
    }

    // Read spot price from the page header.
    const spot = await readSpotPrice(page);

    // Read the timeframe label from the page for logging/verification.
    const pageTimeframe = await readTimeframeLabel(page);

    // Derive capturedAt from the API timestamp (slot end time).
    const apiTimeframe = apiTimestampToTimeframe(bestResponse.timestamp);
    const apiEndHhmm = utcToETHhmm(bestResponse.timestamp);
    const capturedAt = computeCapturedAt(bestResponse.date, apiEndHhmm);

    const { rows, timeframe, expiry, qualifyingStrikes } = apiResponseToRows(bestResponse, capturedAt);

    // Find the best market_maker_contracts response (positions).
    let bestContracts: ApiContractsResponse | null = null;
    for (const r of mmcResponses) {
      if (r.url.includes(`expiry=${today}`)) {
        bestContracts = r.body;
        break;
      }
    }
    if (bestContracts === null) {
      for (const r of mmcResponses) {
        if (!r.url.includes('expiry=all')) {
          bestContracts = r.body;
          break;
        }
      }
    }
    if (bestContracts === null && mmcResponses.length > 0) {
      bestContracts = mmcResponses[mmcResponses.length - 1]!.body;
    }

    if (bestContracts) {
      const positionsRows = contractsResponseToRows(bestContracts, capturedAt, qualifyingStrikes);
      rows.push(...positionsRows);
      logger.info(
        { positionsRows: positionsRows.length, mmcResponseCount: mmcResponses.length },
        'scrapeAllPanels: added positions rows from contracts API',
      );
    } else {
      logger.warn('scrapeAllPanels: no market_maker_contracts API response captured');
    }

    logger.info(
      {
        apiTimestamp: bestResponse.timestamp,
        apiDate: bestResponse.date,
        apiTimeframe,
        pageTimeframe,
        expiry,
        spot: spot ?? bestResponse.index_values.close,
        rowCount: rows.length,
        panels: [...new Set(rows.map(r => r.panel))],
        strikes: rows.length > 0
          ? `${rows[0]!.strike} … ${rows[rows.length - 1]!.strike}`
          : 'none',
      },
      'scrapeAllPanels: parsed API response',
    );

    // ── Market Tide (per 10-min slot) + Cone (once/day) ──
    // Both endpoints load on dashboard/4, so their responses were captured
    // above. Persist them here so the live tick stores them too — keyed by
    // the same trading date the Greeks were scraped for. Best-effort: a
    // failure here must not drop the Greek snapshot the caller inserts.
    const tradeDate = bestResponse.date;
    try {
      const tideResp =
        [...tideResponses].reverse().find(r => r.url.includes(`date=${tradeDate}`))
        ?? tideResponses[tideResponses.length - 1];
      if (tideResp) {
        const tideInserted = await insertMarketTide(netFlowToTideRows(tideResp.body, tradeDate));
        logger.info({ tradeDate, tideInserted }, 'scrapeAllPanels: stored Market Tide');
      } else {
        logger.warn({ tradeDate }, 'scrapeAllPanels: no net-flow-ticks (Market Tide) response captured');
      }
    } catch (err) {
      logger.warn(
        { tradeDate, err: err instanceof Error ? err.message : String(err) },
        'scrapeAllPanels: Market Tide store failed — non-blocking',
      );
    }

    try {
      if (await coneSnapshotExists(tradeDate)) {
        logger.debug({ tradeDate }, 'scrapeAllPanels: cone already stored — skipping');
      } else {
        const straddleResp =
          [...straddleResponses].reverse().find(r => r.url.includes(`date=${tradeDate}`))
          ?? straddleResponses[straddleResponses.length - 1];
        const straddle = straddleResp ? parseStraddle(straddleResp.body) : null;
        if (straddle != null) {
          const inserted = await insertConeSnapshot({
            date: tradeDate,
            straddle,
            capturedAt: new Date().toISOString(),
          });
          logger.info({ tradeDate, straddle, inserted }, 'scrapeAllPanels: stored Cone');
        } else {
          logger.warn({ tradeDate }, 'scrapeAllPanels: no straddle (Cone) value captured');
        }
      }
    } catch (err) {
      logger.warn(
        { tradeDate, err: err instanceof Error ? err.message : String(err) },
        'scrapeAllPanels: Cone store failed — non-blocking',
      );
    }

    return {
      rows,
      spot: spot ?? bestResponse.index_values.close,
    };
  });
}

/**
 * All intercepted dashboard/4 JSON responses we care about, grouped by
 * endpoint. One listener fills every bucket so each scrape path attaches
 * interception identically instead of duplicating the response handler.
 */
interface ApiCaptures {
  mme: Array<{ url: string; body: ApiExposureResponse }>;
  mmc: Array<{ url: string; body: ApiContractsResponse }>;
  straddle: Array<{ url: string; body: ApiStraddleResponse }>;
  tide: Array<{ url: string; body: ApiNetFlowResponse }>;
}

/**
 * Attach a single `response` listener that routes every JSON response
 * into the right ApiCaptures bucket (Greeks exposures, contracts,
 * straddle/cone, net-flow/tide). Returns the live arrays; the caller
 * clears them between days.
 */
function attachApiCaptures(page: Page): ApiCaptures {
  const caps: ApiCaptures = { mme: [], mmc: [], straddle: [], tide: [] };
  page.on('response', (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    response
      .json()
      .then((body) => {
        if (url.includes('market_maker_exposures')) {
          caps.mme.push({ url, body: body as ApiExposureResponse });
        } else if (url.includes('market_maker_contracts')) {
          caps.mmc.push({ url, body: body as ApiContractsResponse });
        } else if (url.includes('/straddle')) {
          caps.straddle.push({ url, body: body as ApiStraddleResponse });
        } else if (url.includes('net-flow-ticks')) {
          caps.tide.push({ url, body: body as ApiNetFlowResponse });
        }
      })
      .catch(() => undefined);
  });
  return caps;
}

/** Parse the ATM straddle (cone param) from a straddle response. */
function parseStraddle(body: ApiStraddleResponse): number | null {
  const v = Number.parseFloat(body.straddle);
  return Number.isFinite(v) ? v : null;
}

/**
 * Convert a net-flow-ticks response (1-min Market Tide series) into
 * 10-min-aligned MarketTideRow[]. UW timestamps carry a whole-hour ET
 * offset, so UTC minutes equal ET minutes — `getUTCMinutes() % 10`
 * cleanly selects the slot boundaries (09:30, 09:40, …, 16:00).
 */
function netFlowToTideRows(body: ApiNetFlowResponse, date: string): MarketTideRow[] {
  const out: MarketTideRow[] = [];
  for (const pt of body.data ?? []) {
    const d = new Date(pt.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getUTCMinutes() % 10 !== 0) continue;
    const ncp = Number.parseFloat(pt.net_call_premium);
    const npp = Number.parseFloat(pt.net_put_premium);
    const nv = Number(pt.net_volume);
    if (!Number.isFinite(ncp) || !Number.isFinite(npp) || !Number.isFinite(nv)) {
      continue;
    }
    out.push({
      capturedAt: d.toISOString(),
      date: pt.date ?? date,
      netCallPremium: ncp,
      netPutPremium: npp,
      netVolume: nv,
    });
  }
  return out;
}

/** Outcome of scraping + persisting one trading day. */
interface DayStoreSummary {
  /** Greek/positions snapshot rows parsed (0 ⇒ likely past history floor). */
  rowsParsed: number;
  snapshotsInserted: number;
  spotsInserted: number;
  tidePointsInserted: number;
  /** A new cone row was written. */
  coneInserted: boolean;
  /** Cone skipped because a snapshot already existed for this date. */
  coneSkipped: boolean;
  slotsScanned: number;
}

/**
 * Scrape one trading day AND persist everything for it: navigate the
 * chart to `date`, set Expiry=Single, iterate 10-min slots from
 * `startNorm`..`endNorm` capturing Greeks/positions + per-slot spot,
 * then store Market Tide (per 10-min slot) and the Cone param
 * (straddle, once/day — skipped if already in the DB).
 *
 * This is THE shared per-day scraper: scrapeBackfill (single date),
 * scrapeBackfillRange (fixed list), and scrapeWalkBack (descending walk)
 * all route through it, so scrape + insert behavior lives in one place.
 * Throws if the date can't be selected (callers decide if that's fatal
 * or just "no more history").
 */
async function scrapeAndStoreDay(
  page: Page,
  date: string,
  startNorm: string,
  endNorm: string,
  caps: ApiCaptures,
): Promise<DayStoreSummary> {
  // Drop any responses left over from the previous day so the `?? last`
  // fallbacks below can't read stale data for this date.
  caps.mme.length = 0;
  caps.mmc.length = 0;
  caps.straddle.length = 0;
  caps.tide.length = 0;

  await walkDateToTarget(page, date);
  await page.waitForTimeout(1_500);
  const ok = await setExpirySingle(page, date);
  if (!ok) {
    throw new Error(
      `setExpirySingle(${date}) failed — date may be outside Single-mode dropdown for this chart frame`,
    );
  }
  await waitForChartReady(page);
  await walkTimeframeToTarget(page, startNorm);
  await page.waitForTimeout(1_500);

  const dayRows: SnapshotRow[] = [];
  const daySpots: Array<{ capturedAt: string; expiry: string; spot: number }> = [];
  let currentStart = startNorm;
  let slotsScanned = 0;

  while (currentStart <= endNorm) {
    const slotEnd = nextTimeframe(currentStart);
    const capturedAt = computeCapturedAt(date, slotEnd);

    // Wait for API response
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1_000);

    const latestMme = [...caps.mme]
      .reverse()
      .find(r => r.url.includes(`expiry=${date}`))
      ?? caps.mme[caps.mme.length - 1];

    if (latestMme) {
      const { rows, qualifyingStrikes, spot, expiry } = apiResponseToRows(latestMme.body, capturedAt);
      dayRows.push(...rows);

      // Record this slot's SPX spot (one observation per 10-min window).
      if (Number.isFinite(spot) && spot > 0) {
        daySpots.push({ capturedAt, expiry, spot });
      }

      const latestMmc = [...caps.mmc]
        .reverse()
        .find(r => r.url.includes(`expiry=${date}`))
        ?? caps.mmc[caps.mmc.length - 1];
      if (latestMmc) {
        dayRows.push(...contractsResponseToRows(latestMmc.body, capturedAt, qualifyingStrikes));
      }
    }

    slotsScanned += 1;

    const nextStart = nextTimeframe(currentStart);
    if (nextStart > endNorm) break;

    // Clear only the per-slot Greek responses — straddle/tide are
    // fetched once per day and must survive the whole slot loop.
    caps.mme.length = 0;
    caps.mmc.length = 0;
    await advanceTimeframeOneSlot(page);
    await page.waitForTimeout(1_500);
    currentStart = nextStart;
  }

  // ── Persist Greeks/positions + per-slot spot ──
  const snapshotsInserted = await insertSnapshots(dayRows);
  const spotsInserted = await insertSpotPrices(daySpots);

  // ── Market Tide: one net-flow-ticks call covers the whole day ──
  const tideResp =
    [...caps.tide].reverse().find(r => r.url.includes(`date=${date}`))
    ?? caps.tide[caps.tide.length - 1];
  let tidePointsInserted = 0;
  if (tideResp) {
    tidePointsInserted = await insertMarketTide(netFlowToTideRows(tideResp.body, date));
  } else {
    logger.warn({ date }, 'scrapeAndStoreDay: no net-flow-ticks (Market Tide) response captured');
  }

  // ── Cone (once/day): skip entirely if already stored for this date ──
  let coneInserted = false;
  let coneSkipped = false;
  if (await coneSnapshotExists(date)) {
    coneSkipped = true;
  } else {
    const straddleResp =
      [...caps.straddle].reverse().find(r => r.url.includes(`date=${date}`))
      ?? caps.straddle[caps.straddle.length - 1];
    const straddle = straddleResp ? parseStraddle(straddleResp.body) : null;
    if (straddle != null) {
      const cone: ConeSnapshotRow = {
        date,
        straddle,
        capturedAt: new Date().toISOString(),
      };
      coneInserted = await insertConeSnapshot(cone);
    } else {
      logger.warn({ date }, 'scrapeAndStoreDay: no straddle (Cone) value captured');
    }
  }

  return {
    rowsParsed: dayRows.length,
    snapshotsInserted,
    spotsInserted,
    tidePointsInserted,
    coneInserted,
    coneSkipped,
    slotsScanned,
  };
}

/**
 * Backfill mode: scrape + persist a single historical date. A thin
 * wrapper around the shared `scrapeAndStoreDay` (the same per-day scraper
 * used by the range + walk-back paths) so single-date runs capture and
 * store Greeks, spot, Market Tide, and the Cone identically.
 *
 * The captured_at on each row is computed from the slot's END time
 * (e.g. a "09:20 - 09:30" ET slot stamps captured_at=09:30 ET) so a
 * backfilled day reproduces the live cron's row stamping.
 */
export async function scrapeBackfill(
  targetDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<DayStoreSummary> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    logger.info(
      { targetDate, startHhmm: startNorm, endHhmm: endNorm, url: UW_PERISCOPE_URL },
      'backfill: starting — navigating to periscope',
    );
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    const summary = await scrapeAndStoreDay(page, targetDate, startNorm, endNorm, caps);

    logger.info({ targetDate, ...summary }, 'backfill: complete');
    return summary;
  });
}

/**
 * Scrape every trading day in [startDate, endDate], skipping weekends
 * and US-market holidays. Inserts rows per-day so progress is durable
 * — a process kill mid-loop leaves prior days in the DB intact.
 *
 * Returns a summary; rows are NOT returned (they're already inserted).
 * Errors on any single day log + continue to the next day.
 */
export async function scrapeBackfillRange(
  startDate: string,
  endDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysFailed: string[];
  totalDays: number;
}> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);
  const dates = tradingDaysBetween(startDate, endDate);

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    logger.info(
      {
        startDate,
        endDate,
        totalDays: dates.length,
        startHhmm: startNorm,
        endHhmm: endNorm,
      },
      'backfill range: starting',
    );
    if (dates.length === 0) {
      logger.warn(
        { startDate, endDate },
        'backfill range: no trading days in range',
      );
      return {
        totalRowsInserted: 0,
        daysScanned: 0,
        daysFailed: [],
        totalDays: 0,
      };
    }

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    let totalRowsInserted = 0;
    let daysScanned = 0;
    const daysFailed: string[] = [];

    for (const [idx, date] of dates.entries()) {
      const dayStarted = Date.now();
      const progress = `${idx + 1}/${dates.length}`;
      logger.info({ date, progress }, 'backfill range: starting day');

      try {
        const summary = await scrapeAndStoreDay(page, date, startNorm, endNorm, caps);
        totalRowsInserted += summary.snapshotsInserted;
        daysScanned += 1;

        logger.info(
          {
            date,
            progress,
            ...summary,
            totalRowsInserted,
            daysFailed: daysFailed.length,
            ms: Date.now() - dayStarted,
          },
          'backfill range: day complete',
        );
      } catch (err) {
        daysFailed.push(date);
        logger.error(
          {
            date,
            progress,
            err: err instanceof Error ? err.message : String(err),
            ms: Date.now() - dayStarted,
          },
          'backfill range: day failed — continuing to next',
        );
        // Try to escape any stuck modal/popover state before next day.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }

    logger.info(
      { totalRowsInserted, daysScanned, daysFailed, totalDays: dates.length },
      'backfill range: complete',
    );
    return {
      totalRowsInserted,
      daysScanned,
      daysFailed,
      totalDays: dates.length,
    };
  });
}

/**
 * Read-all mode: start at the latest trading day and walk BACKWARDS one
 * trading session at a time, scraping + inserting each day, until UW
 * runs out of history. Unlike scrapeBackfillRange there is no fixed
 * start date — the script discovers the history floor itself, so it
 * keeps working as UW's available range slides.
 *
 * Stop condition: `maxConsecutiveEmpty` consecutive days that either
 * produced 0 rows or failed to scrape (e.g. the date is no longer in
 * the Single-mode Expiry dropdown). A single transient glitch won't
 * stop the walk — the counter resets on the next non-empty day — but a
 * genuine end-of-history (or repeated failure) terminates cleanly.
 *
 * Rows are inserted per-day (idempotent via ON CONFLICT DO NOTHING), so
 * a kill mid-walk leaves all prior days durably in the DB and a re-run
 * just re-confirms them. An optional `floorDate` is a hard lower bound
 * (inclusive) for safety / partial runs.
 */
export async function scrapeWalkBack(opts: {
  startHhmm: string;
  endHhmm: string;
  maxConsecutiveEmpty?: number;
  floorDate?: string;
}): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysWithData: number;
  daysEmpty: string[];
  daysFailed: string[];
  oldestDateWithData: string | null;
  newestDateScanned: string | null;
}> {
  const startNorm = normalizeHhmm(opts.startHhmm);
  const endNorm = normalizeHhmm(opts.endHhmm);
  const maxEmpty = opts.maxConsecutiveEmpty ?? 3;

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    const firstDate = latestTradingDay();
    logger.info(
      { firstDate, startHhmm: startNorm, endHhmm: endNorm, maxEmpty, floorDate: opts.floorDate ?? null },
      'walk-back: starting from latest trading day',
    );

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    let date: string = firstDate;
    let consecutiveEmpty = 0;
    let totalRowsInserted = 0;
    let daysScanned = 0;
    let daysWithData = 0;
    const daysEmpty: string[] = [];
    const daysFailed: string[] = [];
    let oldestDateWithData: string | null = null;
    let stopReason = 'unknown';

    while (true) {
      if (opts.floorDate != null && date < opts.floorDate) {
        stopReason = `reached floorDate ${opts.floorDate}`;
        break;
      }

      const dayStarted = Date.now();
      logger.info({ date, consecutiveEmpty }, 'walk-back: starting day');

      try {
        const summary = await scrapeAndStoreDay(page, date, startNorm, endNorm, caps);
        totalRowsInserted += summary.snapshotsInserted;
        daysScanned += 1;

        if (summary.rowsParsed === 0) {
          consecutiveEmpty += 1;
          daysEmpty.push(date);
          logger.info(
            { date, ...summary, consecutiveEmpty, ms: Date.now() - dayStarted },
            'walk-back: day returned 0 rows (likely past history floor)',
          );
        } else {
          consecutiveEmpty = 0;
          daysWithData += 1;
          oldestDateWithData = date; // walking backwards → each success is older
          logger.info(
            {
              date,
              ...summary,
              totalRowsInserted,
              ms: Date.now() - dayStarted,
            },
            'walk-back: day complete',
          );
        }
      } catch (err) {
        consecutiveEmpty += 1;
        daysFailed.push(date);
        logger.error(
          {
            date,
            consecutiveEmpty,
            err: err instanceof Error ? err.message : String(err),
            ms: Date.now() - dayStarted,
          },
          'walk-back: day failed — counting toward stop threshold',
        );
        // Escape any stuck modal/popover state before the next day.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      if (consecutiveEmpty >= maxEmpty) {
        stopReason = `${consecutiveEmpty} consecutive empty/failed days — history floor reached`;
        break;
      }

      date = prevTradingDay(date);
    }

    logger.info(
      {
        stopReason,
        totalRowsInserted,
        daysScanned,
        daysWithData,
        daysEmpty: daysEmpty.length,
        daysFailed,
        oldestDateWithData,
        newestDateScanned: firstDate,
      },
      'walk-back: complete',
    );

    return {
      totalRowsInserted,
      daysScanned,
      daysWithData,
      daysEmpty,
      daysFailed,
      oldestDateWithData,
      newestDateScanned: firstDate,
    };
  });
}

/**
 * Discovery helper — open dashboard/4 and dump EVERY JSON XHR/fetch
 * response (URL + full body) to docs/temp/, so we can identify the exact
 * endpoints and JSON shapes for panels we don't parse yet (The Cone,
 * Market Tide) BEFORE writing parsers against them. No DB writes.
 *
 * The Cone + Market Tide panels load on dashboard/4, so simply opening
 * the page fires their API calls. Run headed during RTH so intraday
 * panels actually have data, and use SETUP_PAUSE_MS to hold the window
 * open for manual clicking if a panel is lazy-loaded:
 *
 *   HEADLESS=false SETUP_PAUSE_MS=30000 npm run discover
 *
 * Output: docs/temp/endpoints-<ts>/ with one <NNN>_<sanitized-url>.json
 * per unique endpoint plus an _index.json manifest. docs/temp/ is
 * gitignored, so nothing sensitive is committed.
 */
export async function discoverEndpoints(): Promise<{
  outDir: string;
  endpoints: Array<{ url: string; status: number; bytes: number; file: string }>;
}> {
  return await withBrowser(async (_browser, page) => {
    const captured: Array<{ url: string; status: number; body: string }> = [];

    page.on('response', (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      const status = response.status();
      response
        .text()
        .then((body) => {
          captured.push({ url, status, body });
        })
        .catch(() => undefined);
    });

    logger.info({ url: UW_PERISCOPE_URL }, 'discover: navigating to dashboard/4');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);
    await clickZoomOut(page);

    // Hold the page so lazy panels (Cone / Market Tide) finish loading.
    // In headed mode this is also the window for manual interaction.
    const pauseRaw = Number.parseInt((process.env.SETUP_PAUSE_MS ?? '').trim(), 10);
    const pauseMs = Number.isFinite(pauseRaw) && pauseRaw > 0 ? pauseRaw : 8_000;
    logger.info({ pauseMs }, 'discover: settling — interact now if headed');
    await page.waitForTimeout(pauseMs);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Keep the largest body per unique URL (later/full payloads win over
    // empty pre-flight responses for the same endpoint).
    const byUrl = new Map<string, { url: string; status: number; body: string }>();
    for (const c of captured) {
      const prev = byUrl.get(c.url);
      if (prev == null || c.body.length > prev.body.length) byUrl.set(c.url, c);
    }

    const outDir = resolve('docs/temp', `endpoints-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    const endpoints: Array<{ url: string; status: number; bytes: number; file: string }> = [];
    const sorted = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
    let idx = 0;
    for (const { url, status, body } of sorted) {
      const safe = url
        .replace(/^https?:\/\//, '')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 120);
      const file = resolve(outDir, `${String(idx).padStart(3, '0')}_${safe}.json`);
      await writeFile(file, body, 'utf8').catch(() => undefined);
      endpoints.push({ url, status, bytes: body.length, file });
      idx += 1;
    }

    await writeFile(
      resolve(outDir, '_index.json'),
      JSON.stringify(endpoints, null, 2),
      'utf8',
    ).catch(() => undefined);

    logger.info(
      { outDir, endpointCount: endpoints.length },
      'discover: captured JSON endpoints — inspect docs/temp',
    );
    for (const e of endpoints) {
      logger.info({ bytes: e.bytes, status: e.status }, e.url);
    }

    return { outDir, endpoints };
  });
}
