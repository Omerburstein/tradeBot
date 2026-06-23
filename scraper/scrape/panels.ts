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
import { computeCapturedAt, isInRth } from '../core/dates.js';
import { logger } from '../core/logger.js';
import type { SnapshotRow, PositionRow } from '../core/types.js';
import { withBrowser } from './browser.js';
import { clickZoomOut, readSpotPrice, waitForChartReady } from './chart.js';
import { readTimeframeLabel } from './timeframe.js';
import { setDTEZero, setExpirySingle, walkDateToTarget } from './navigation.js';
import { latestTradingDay, nextTradingDay } from './trading-calendar.js';
import {
  apiResponseToRows,
  apiTimestampToTimeframe,
  contractsResponseToRows,
  netFlowToTideRows,
  parseStraddle,
  utcToETHhmm,
} from './api-transforms.js';
import type {
  ApiCandleEntry,
  ApiContractsResponse,
  ApiExposureResponse,
  ApiNetFlowResponse,
  ApiSpxTickEntry,
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
    const candleResponses: Array<{ url: string; body: ApiCandleEntry[] }> = [];
    const tickResponses: Array<{ url: string; body: ApiSpxTickEntry[] }> = [];

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
          if (url.includes('index_candles')) {
            candleResponses.push({ url, body: body as ApiCandleEntry[] });
          }
          if (url.includes('one_minute_ticks')) {
            tickResponses.push({ url, body: body as ApiSpxTickEntry[] });
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
      return { rows: [], positionRows: [], spot: null };
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

    // ── Next-expiry (next trading day / 1DTE+) ──────────────────────────────
    // After capturing today's expiry, switch the Expiry filter to the next
    // trading day. The response listener is still running — new API responses
    // append to the same arrays, distinguished by `expiry=<date>` in the URL.
    const nextExpiry = nextTradingDay(today);
    const mmeBefore = mmeResponses.length;
    const mmcBefore = mmcResponses.length;

    let nextExpiryRows: SnapshotRow[] = [];
    let nextExpiryPositionRows: PositionRow[] = [];
    let nextExpiryQualifyingStrikes = new Set<number>();

    try {
      // skipModeSwitch: the dialog is already in Single mode from the
      // first (today) call — re-clicking "Single" would toggle it to Multi.
      const nextUsed = await setExpirySingle(page, nextExpiry, { skipModeSwitch: true });
      if (nextUsed) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300); // anti-bot
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(2_500); // anti-bot settle + refetch

        // Only consider responses that arrived AFTER the expiry switch, and
        // pick the one that is actually for nextExpiry. Match on the URL
        // param OR the response body's own `date` field (the API echoes the
        // expiry there). Fall back to any non-"all" newly-arrived response,
        // then the last one — mirroring today's 3-tier selection.
        const newMME = mmeResponses.slice(mmeBefore);
        logger.info(
          { nextExpiry, newMMECount: newMME.length, urls: newMME.map(r => r.url) },
          'scrapeAllPanels: next-expiry MME responses after switch',
        );
        // Match on the URL expiry param — the response BODY's `date` is the
        // trading-session date, not the expiry, so it can't be used here.
        let nextMMEResp: ApiExposureResponse | null =
          newMME.find(r => r.url.includes(`expiry=${nextExpiry}`))?.body ?? null;
        if (nextMMEResp === null) {
          nextMMEResp = newMME.find(r => !r.url.includes('expiry=all'))?.body ?? null;
        }
        if (nextMMEResp === null && newMME.length > 0) {
          nextMMEResp = newMME[newMME.length - 1]!.body;
        }

        if (nextMMEResp) {
          // Pass nextExpiry explicitly so rows are stamped with the real
          // expiry, not the session date (apiData.date).
          const parsed = apiResponseToRows(nextMMEResp, capturedAt, nextExpiry);
          nextExpiryRows = parsed.rows;
          nextExpiryQualifyingStrikes = parsed.qualifyingStrikes;
          logger.info(
            { nextExpiry, apiDate: nextMMEResp.date, rowCount: nextExpiryRows.length },
            'scrapeAllPanels: next-expiry rows parsed',
          );
        } else {
          logger.warn({ nextExpiry }, 'scrapeAllPanels: no MME response for next expiry');
        }

        const newMMC = mmcResponses.slice(mmcBefore);
        let nextMMCResp: ApiContractsResponse | null =
          newMMC.find(r => r.url.includes(`expiry=${nextExpiry}`))?.body ?? null;
        if (nextMMCResp === null) {
          nextMMCResp = newMMC.find(r => !r.url.includes('expiry=all'))?.body ?? null;
        }
        if (nextMMCResp === null && newMMC.length > 0) {
          nextMMCResp = newMMC[newMMC.length - 1]!.body;
        }
        if (nextMMCResp) {
          nextExpiryPositionRows = contractsResponseToRows(
            nextMMCResp,
            capturedAt,
            nextExpiryQualifyingStrikes,
            nextExpiry,
          );
          logger.info(
            { nextExpiry, positionRows: nextExpiryPositionRows.length },
            'scrapeAllPanels: next-expiry positions parsed',
          );
        } else {
          logger.warn({ nextExpiry }, 'scrapeAllPanels: no contracts response for next expiry');
        }
      } else {
        logger.warn({ nextExpiry }, 'scrapeAllPanels: setExpirySingle failed for next expiry — skipping');
      }
    } catch (err) {
      logger.warn(
        { nextExpiry, err: err instanceof Error ? err.message : String(err) },
        'scrapeAllPanels: next-expiry capture failed — non-blocking',
      );
    }

    // Find the best market_maker_contracts response (positions) for today.
    // Only search responses captured before the next-expiry filter switch
    // to avoid accidentally using next-expiry contracts for today's rows.
    const todayMMCResponses = mmcResponses.slice(0, mmcBefore);
    let bestContracts: ApiContractsResponse | null = null;
    for (const r of todayMMCResponses) {
      if (r.url.includes(`expiry=${today}`)) {
        bestContracts = r.body;
        break;
      }
    }
    if (bestContracts === null) {
      for (const r of todayMMCResponses) {
        if (!r.url.includes('expiry=all')) {
          bestContracts = r.body;
          break;
        }
      }
    }
    if (bestContracts === null && todayMMCResponses.length > 0) {
      bestContracts = todayMMCResponses[todayMMCResponses.length - 1]!.body;
    }

    const positionRows = bestContracts
      ? contractsResponseToRows(bestContracts, capturedAt, qualifyingStrikes)
      : [];
    if (bestContracts) {
      logger.info(
        { positionRows: positionRows.length, mmcResponseCount: mmcResponses.length },
        'scrapeAllPanels: parsed positions rows from contracts API',
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
        const tideInserted = await insertMarketTide(netFlowToTideRows(tideResp.body).slice(-1));
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
      if (!isInRth(new Date())) {
        // Premarket/postmarket tick: don't store a cone built outside
        // trading hours (it would carry an out-of-hours captured_at). The
        // cone is stored on the first in-RTH tick of the day instead.
        logger.debug({ tradeDate }, 'scrapeAllPanels: outside RTH — skipping cone');
      } else if (await coneSnapshotExists(tradeDate)) {
        logger.debug({ tradeDate }, 'scrapeAllPanels: cone already stored — skipping');
      } else {
        const straddleResp =
          [...straddleResponses].reverse().find(r => r.url.includes(`date=${tradeDate}`))
          ?? straddleResponses[straddleResponses.length - 1];
        const straddle = straddleResp ? parseStraddle(straddleResp.body) : null;
        const candleEntry = candleResponses
          .flatMap(r => r.body)
          .find(e => e.date === tradeDate);
        const tickEntry = tickResponses
          .find(r => r.url.includes(`date=${tradeDate}`))
          ?.body[0];
        const spxOpen = candleEntry
          ? Number.parseFloat(candleEntry.o)
          : tickEntry ? Number.parseFloat(tickEntry.open) : null;
        if (straddle != null && spxOpen != null) {
          const inserted = await insertConeSnapshot({
            capturedAt: new Date().toISOString(),
            spxOpen,
            coneUpper: spxOpen + straddle,
            coneLower: spxOpen - straddle,
          });
          logger.info({ tradeDate, spxOpen, straddle, inserted }, 'scrapeAllPanels: stored Cone');
        } else {
          logger.warn({ tradeDate, straddle, spxOpen }, 'scrapeAllPanels: missing cone data');
        }
      }
    } catch (err) {
      logger.warn(
        { tradeDate, err: err instanceof Error ? err.message : String(err) },
        'scrapeAllPanels: Cone store failed — non-blocking',
      );
    }

    return {
      rows: [...rows, ...nextExpiryRows],
      positionRows: [...positionRows, ...nextExpiryPositionRows],
      spot: spot ?? bestResponse.index_values.close,
    };
  });
}
