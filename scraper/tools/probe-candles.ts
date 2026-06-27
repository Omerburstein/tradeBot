/**
 * Candle probe — dumps the RAW index_candles/SPX/5m payload for one ET date so
 * we can see exactly how UW timestamps each 5-min bar (start/end) and which
 * OHLC field equals the price the chart shows at a given boundary. Use it to
 * verify the spot mapping in candles5mToSpotRowsByDate against the UW chart.
 *
 * No DB writes. Run headed or headless:
 *   CANDLE_DATE=2026-05-26 npx tsx scraper/tools/probe-candles.ts
 *   CANDLE_DATE=2026-05-26 HEADLESS=false npx tsx scraper/tools/probe-candles.ts
 */
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from '../scrape/browser.js';
import { waitForChartReady, clickZoomOut } from '../scrape/chart.js';
import { etDateOf } from '../scrape/api-transforms.js';
import type { ApiIntradayCandle } from '../scrape/api-types.js';

const CANDLE_ORIGIN = 'https://phx.unusualwhales.com';
const FIVE_MIN_MS = 5 * 60 * 1000;

/** ET HH:MM:SS of a UTC instant (so we can read the bar's wall-clock time). */
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
  logger.info({ url: UW_PERISCOPE_URL }, 'probe-candles: navigating');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  await clickZoomOut(page);

  const url = `${CANDLE_ORIGIN}/api/index_candles/SPX/5m?interval=40d`;
  const resp = await page.request.get(url);
  if (!resp.ok()) {
    logger.error({ status: resp.status() }, 'probe-candles: candle fetch non-OK');
    return;
  }
  const body = (await resp.json()) as { data?: ApiIntradayCandle[] };
  const all = body.data ?? [];
  const forDate = all.filter((c) => etDateOf(new Date(c.start)) === targetDate);

  logger.info(
    { targetDate, totalCandles: all.length, candlesForDate: forDate.length },
    'probe-candles: fetched',
  );

  // Print the morning bars with start/end (ET clock) + OHLC, plus what the
  // current mapping (snap start to nearest 5-min, use open) would store.
  for (const c of forDate.slice(0, 12)) {
    const startMs = new Date(c.start).getTime();
    const snapped = new Date(Math.round(startMs / FIVE_MIN_MS) * FIVE_MIN_MS);
    logger.info(
      {
        startISO: c.start,
        endISO: c.end,
        startET: etClock(new Date(c.start)),
        endET: c.end ? etClock(new Date(c.end)) : null,
        o: c.o,
        h: c.h,
        l: c.l,
        c: c.c,
        snappedET: etClock(snapped),
        currentlyStoresAtSnapped: c.o, // open, snapped-start label
      },
      'candle',
    );
  }
});
