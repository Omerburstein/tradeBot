/**
 * Market Tide window prober. Loads dashboard/4 (for an authed page context),
 * then directly hits net-flow-ticks with a range of `market_day_timeframe`
 * values and reports, for each, which trading dates actually come back and
 * whether TIDE_DATE is among them. This verifies the core assumption behind
 * the widened backfill window: that market_day_timeframe controls HOW MANY
 * past sessions the endpoint returns (default 1 = today only).
 *
 * No DB writes. Run:
 *   TIDE_DATE=2026-05-28 npm run probe:tide
 */
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from '../scrape/browser.js';
import { waitForChartReady, clickZoomOut } from '../scrape/chart.js';
import type { ApiNetFlowResponse } from '../scrape/api-types.js';

const ORIGIN = 'https://phx.unusualwhales.com';
const targetDate = (process.env.TIDE_DATE ?? '').trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  logger.error('set TIDE_DATE=YYYY-MM-DD (ET) — e.g. TIDE_DATE=2026-05-28');
  process.exit(1);
}

const TIMEFRAMES = [1, 30, 60];

await withBrowser(async (_browser, page) => {
  logger.info({ url: UW_PERISCOPE_URL, targetDate }, 'probe:tide navigating');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  await clickZoomOut(page);

  for (const tf of TIMEFRAMES) {
    const url = `${ORIGIN}/api/net-flow-ticks?date=${targetDate}&grouping_minutes=1&market_day_timeframe=${tf}`;
    let resp;
    try {
      resp = await page.request.get(url);
    } catch (err) {
      logger.warn({ tf, url, err: String(err) }, 'fetch threw');
      continue;
    }
    if (!resp.ok()) {
      logger.warn({ tf, url, status: resp.status() }, 'fetch non-OK');
      continue;
    }
    const body = (await resp.json()) as ApiNetFlowResponse;
    const points = body.data ?? [];
    const dates = [...new Set(points.map((p) => p.date))].sort();
    logger.info(
      {
        market_day_timeframe: tf,
        totalPoints: points.length,
        distinctDates: dates.length,
        earliest: dates[0] ?? null,
        latest: dates[dates.length - 1] ?? null,
        targetPresent: dates.includes(targetDate),
        pointsForTarget: points.filter((p) => p.date === targetDate).length,
      },
      'net-flow-ticks window result',
    );
  }
});
