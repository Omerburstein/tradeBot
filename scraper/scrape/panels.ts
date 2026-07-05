/**
 * Live single-slot capture — `scrapeAllPanels` opens dashboard/4, reads the
 * list of published snapshot minutes for the session, and fetches the most
 * recent minute's Greeks + positions DIRECTLY from the periscope API
 * (authenticated page.request) for both the session expiry (0DTE) and the
 * next trading day's expiry (1DTE). It also (best effort) stores the day's
 * Market Tide + Cone from the XHRs the page fires on load. This is the path
 * the per-minute cron tick drives.
 *
 * Since the 2026-07 UW redesign there is NO widget driving here at all —
 * no date picker, no Expiry dialog, no Timeframe walker. The page is only
 * loaded to (a) authenticate, (b) fire the on-load XHRs (timestamps, tide,
 * candles, ticks, straddle), and (c) read the header spot price.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UW_PERISCOPE_URL } from '../core/config.js';
import { computeCapturedAt, isInRth } from '../core/dates.js';
import { logger } from '../core/logger.js';
import type { SnapshotRow, PositionRow } from '../core/types.js';
import { withBrowser } from './browser.js';
import { attachApiCaptures } from './captures.js';
import { readSpotPrice, waitForChartReady } from './chart.js';
import { latestTradingDay, nextTradingDay } from './trading-calendar.js';
import { exposuresToRows, positionsToRows } from './api-transforms.js';
import {
  fetchPeriscopeTimestamps,
  fetchPeriscopeSlot,
  latestPublishedMs,
  latestTickClose,
  storeMarketTide,
  storeCone,
} from './api-helpers.js';
import type { ScrapeResult } from './api-types.js';

export async function scrapeAllPanels(): Promise<ScrapeResult> {
  return await withBrowser(async (_browser, page) => {
    // Route all JSON responses into typed ApiCaptures buckets.
    const caps = attachApiCaptures(page);

    // Optional: capture every JSON response to disk for debugging.
    const saveDebug = (process.env.SAVE_SCREENSHOT ?? '').trim().toLowerCase() === 'true';
    const allApiCaptures: Array<{ url: string; body: unknown }> = [];
    if (saveDebug) {
      page.on('response', (response) => {
        const ct = response.headers()['content-type'] ?? '';
        if (!ct.includes('json')) return;
        response.json()
          .then((body) => allApiCaptures.push({ url: response.url(), body }))
          .catch(() => undefined);
      });
    }

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });

    // Wait for the Exposures window to mount, then settle for the trailing
    // on-load XHRs (timestamps, net-flow-ticks, one_minute_ticks, straddle,
    // candles). // anti-bot
    await waitForChartReady(page);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1_500);

    // TARGET_DATE overrides the date to scrape. Useful for running against
    // the previous trading day when today's market hasn't opened yet.
    // Must be YYYY-MM-DD. Defaults to the latest trading day (ET) when not set.
    const rawTargetDate = (process.env.TARGET_DATE ?? '').trim();
    const today =
      /^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate) ? rawTargetDate : latestTradingDay();

    logger.info({ today }, 'scrapeAllPanels: target date');

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
      if (allApiCaptures.length > 0) {
        const apiPath = resolve(tempDir, `api-${ts}.json`);
        await writeFile(apiPath, JSON.stringify(allApiCaptures, null, 2), 'utf8');
        logger.info({ apiPath, count: allApiCaptures.length }, 'api responses saved');
      }
      logger.info({ screenshotPath, htmlPath }, 'screenshot and html saved');
    }

    // Latest published snapshot minute for the session. The list covers the
    // whole extended session (~04:00-24:00 ET), so clamp to the 16:00 ET
    // close: during RTH this is a no-op (latest ≤ now is intraday), and an
    // after-hours tick (FORCE_TICK, post-close stragglers) captures the
    // 16:00 debrief snapshot — matching the dashboard's LIVE pin — instead
    // of a midnight extended-session minute.
    const stamps = await fetchPeriscopeTimestamps(page, caps, today);
    const closeMs = Date.parse(computeCapturedAt(today, '16:00'));
    const latestMs = latestPublishedMs(stamps, Math.min(Date.now(), closeMs));
    if (latestMs === null) {
      logger.warn(
        { today, stampCount: stamps.length },
        'scrapeAllPanels: no published snapshot minutes for date',
      );
      return { rows: [], positionRows: [], spot: null };
    }
    const capturedAt = new Date(latestMs).toISOString();

    // Capture both expiries at the same minute: the session day (0DTE) and
    // the next trading day (1DTE). Rows are stamped with the expiry their
    // request was filtered to.
    const rows: SnapshotRow[] = [];
    const positionRows: PositionRow[] = [];
    const expiries = [today, nextTradingDay(today)];
    for (const [i, expiry] of expiries.entries()) {
      if (i > 0) await page.waitForTimeout(300); // pacing between API pairs // anti-bot
      const slot = await fetchPeriscopeSlot(page, caps, { timestampMs: latestMs, expiry });
      if (slot.exposures == null) {
        logger.warn({ expiry, capturedAt }, 'scrapeAllPanels: no exposures response for expiry');
        continue;
      }
      const parsed = exposuresToRows(slot.exposures, capturedAt, expiry);
      rows.push(...parsed.rows);
      const posRows = slot.positions
        ? positionsToRows(slot.positions, capturedAt, parsed.qualifyingStrikes, expiry)
        : [];
      positionRows.push(...posRows);
      logger.info(
        {
          expiry,
          capturedAt,
          timeframe: parsed.timeframe,
          rowCount: parsed.rows.length,
          positionRows: posRows.length,
          qualifyingStrikes: parsed.qualifyingStrikes.size,
        },
        'scrapeAllPanels: expiry snapshot parsed',
      );
    }

    // Spot: page header first, else the latest 1-min tick close (the new
    // exposures response no longer carries index_values).
    const spot = (await readSpotPrice(page)) ?? latestTickClose(caps, today);

    logger.info(
      {
        capturedAt,
        spot,
        rowCount: rows.length,
        panels: [...new Set(rows.map(r => r.panel))],
        strikes: rows.length > 0
          ? `${rows[0]!.strike} … ${rows[rows.length - 1]!.strike}`
          : 'none',
      },
      'scrapeAllPanels: capture complete',
    );

    // ── Market Tide (latest 5-min slot) + Cone (once/day) ──
    // Both endpoints load on dashboard/4, so their responses were captured
    // above. Persist them here so the live tick stores them too — keyed by
    // the same trading date the Greeks were scraped for. Best-effort: a
    // failure here must not drop the Greek snapshot the caller inserts.
    await storeMarketTide(caps, today, { slotOnly: true });

    if (!isInRth(new Date())) {
      // Premarket/postmarket tick: don't store a cone built outside
      // trading hours (it would carry an out-of-hours captured_at). The
      // cone is stored on the first in-RTH tick of the day instead.
      logger.debug({ today }, 'scrapeAllPanels: outside RTH — skipping cone');
    } else {
      const { inserted, skipped } = await storeCone(caps, today);
      logger.debug({ today, inserted, skipped }, 'scrapeAllPanels: cone result');
    }

    return { rows, positionRows, spot };
  });
}
