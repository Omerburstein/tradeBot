/**
 * Candle/tick probe — for one ET date, dumps BOTH intraday SPX price sources
 * so we can see which one matches the UW price chart and whether it respects
 * the `date` param (i.e. is usable for backfill):
 *
 *   1. index_ticks/SPX/one_minute_ticks?date=…  — per-minute OHLC (what the
 *      chart's 5-min candles are aggregated from). Prints the returned session
 *      date (to expose date-param-ignoring) and the 09:30–09:45 ticks, plus the
 *      open at each 5-min boundary (the candidate spot value).
 *   2. index_candles/SPX/5m?interval=40d         — the source we currently use;
 *      sorted + filtered to the date, morning bars printed for comparison.
 *
 * No DB writes. Run:
 *   CANDLE_DATE=2026-05-26 npm run probe:candles
 */
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from '../scrape/browser.js';
import { waitForChartReady, clickZoomOut } from '../scrape/chart.js';
import { etDateOf } from '../scrape/api-transforms.js';
import type { ApiIntradayCandle, ApiSpxTickResponse } from '../scrape/api-types.js';

const ORIGIN = 'https://phx.unusualwhales.com';
const FIVE_MIN_MS = 5 * 60 * 1000;

/** ET HH:MM:SS of a UTC instant. */
function etClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

const targetDate = (process.env.CANDLE_DATE ?? '').trim();
if (!targetDate) {
  logger.error('set CANDLE_DATE=YYYY-MM-DD (ET) — e.g. CANDLE_DATE=2026-05-26');
  process.exit(1);
}

await withBrowser(async (_browser, page) => {
  logger.info({ url: UW_PERISCOPE_URL, targetDate }, 'probe-candles: navigating');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  await clickZoomOut(page);

  // ── Source 1: one_minute_ticks (chart source) ──
  const tickUrl = `${ORIGIN}/api/index_ticks/SPX/one_minute_ticks?date=${targetDate}`;
  const tickResp = await page.request.get(tickUrl);
  if (tickResp.ok()) {
    const body = (await tickResp.json()) as ApiSpxTickResponse;
    const data = body.data ?? [];
    const firstET = data[0] ? etDateOf(new Date(data[0].start_time)) : null;
    logger.info(
      {
        requestedDate: targetDate,
        returnedSessionDate: firstET,
        respectsDate: firstET === targetDate,
        ticks: data.length,
        firstStart: data[0]?.start_time ?? null,
        lastStart: data[data.length - 1]?.start_time ?? null,
      },
      'one_minute_ticks: SUMMARY (respectsDate=false ⇒ latest-session only, no backfill)',
    );
    // Morning ticks 09:30–09:45 + the open at each 5-min boundary.
    for (const t of data) {
      const d = new Date(t.start_time);
      const et = etClock(d);
      if (et < '09:30:00' || et > '09:45:00') continue;
      const isBoundary = d.getUTCMinutes() % 5 === 0;
      logger.info(
        { startET: et, open: t.open, close: t.close, high: t.high, low: t.low, fiveMinBoundary: isBoundary, spotIfBoundary: isBoundary ? t.open : null },
        'one_minute_ticks bar',
      );
    }
  } else {
    logger.warn({ status: tickResp.status() }, 'one_minute_ticks fetch non-OK');
  }

  // ── Source 2: index_candles/5m (current source) ──
  const candUrl = `${ORIGIN}/api/index_candles/SPX/5m?interval=40d`;
  const candResp = await page.request.get(candUrl);
  if (candResp.ok()) {
    const body = (await candResp.json()) as { data?: ApiIntradayCandle[] };
    const forDate = (body.data ?? [])
      .filter((c) => etDateOf(new Date(c.start)) === targetDate)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    logger.info({ targetDate, candlesForDate: forDate.length }, 'index_candles/5m: SUMMARY');
    for (const c of forDate) {
      const et = etClock(new Date(c.start));
      if (et < '09:30:00' || et > '09:50:00') continue;
      const snapped = new Date(Math.round(new Date(c.start).getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
      logger.info(
        { startET: et, snappedET: etClock(snapped), o: c.o, h: c.h, l: c.l, c: c.c },
        'index_candles/5m bar',
      );
    }
  } else {
    logger.warn({ status: candResp.status() }, 'index_candles/5m fetch non-OK');
  }
});
