/**
 * Live single-slot capture — `scrapeAllPanels` opens dashboard/4, navigates
 * to the target date, applies the Expiry/DTE filter, then reads the most
 * recent slot's Greeks + positions from the intercepted API and (best
 * effort) stores the day's Market Tide + Cone. This is the path the per-
 * minute cron tick drives.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UW_PERISCOPE_URL } from '../core/config.js';
import {
  insertMarketTide,
  insertConeSnapshot,
  coneSnapshotExists,
} from '../core/db.js';
import { computeCapturedAt } from '../core/dates.js';
import { logger } from '../core/logger.js';
import { withBrowser } from './browser.js';
import { clickZoomOut, readSpotPrice, waitForChartReady } from './chart.js';
import { readTimeframeLabel } from './timeframe.js';
import { setDTEZero, setExpirySingle, walkDateToTarget } from './navigation.js';
import { latestTradingDay } from './trading-calendar.js';
import {
  apiResponseToRows,
  apiTimestampToTimeframe,
  contractsResponseToRows,
  netFlowToTideRows,
  parseStraddle,
  utcToETHhmm,
} from './api-transforms.js';
import type {
  ApiContractsResponse,
  ApiExposureResponse,
  ApiNetFlowResponse,
  ApiStraddleResponse,
  ScrapeResult,
} from './api-types.js';

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
