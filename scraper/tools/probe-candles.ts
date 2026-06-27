/**
 * Chart-source finder. Drives the Periscope chart to CANDLE_DATE and captures
 * EVERY JSON response, so we can identify exactly which endpoint feeds the
 * price candles for a historical day (one_minute_ticks ignores its date param;
 * index_candles/5m respects it but is mistimed, so the chart must use something
 * else for past dates).
 *
 * Set TARGET_VALUE to a price you read off the chart (e.g. an open/close) and
 * the probe reports which endpoint + JSON path contains that exact value — that
 * endpoint IS the chart's source. Without it, prints a summary of every
 * candle/tick endpoint seen for the date.
 *
 * No DB writes. Run:
 *   CANDLE_DATE=2026-05-26 TARGET_VALUE=7513.68 npm run probe:candles
 */
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from '../scrape/browser.js';
import { waitForChartReady, clickZoomOut } from '../scrape/chart.js';
import { walkDateToTarget } from '../scrape/navigation.js';

const targetDate = (process.env.CANDLE_DATE ?? '').trim();
const targetValue = (process.env.TARGET_VALUE ?? '').trim();
if (!targetDate) {
  logger.error('set CANDLE_DATE=YYYY-MM-DD (ET) — e.g. CANDLE_DATE=2026-05-26');
  process.exit(1);
}

/** Find JSON paths where a value equals `needle` (string-compared, tolerant of
 *  numeric vs string). Returns up to `cap` dotted paths. */
function findValuePaths(node: unknown, needle: string, cap = 8, path = '$'): string[] {
  const hits: string[] = [];
  const visit = (n: unknown, p: string) => {
    if (hits.length >= cap) return;
    if (n === null || n === undefined) return;
    if (typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        visit(v, Array.isArray(n) ? `${p}[${k}]` : `${p}.${k}`);
        if (hits.length >= cap) return;
      }
      return;
    }
    if (String(n) === needle) hits.push(p);
  };
  visit(node, path);
  return hits;
}

await withBrowser(async (_browser, page) => {
  const captured: Array<{ url: string; body: unknown }> = [];
  page.on('response', (resp) => {
    const ct = resp.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    const url = resp.url();
    resp.json().then((body) => captured.push({ url, body })).catch(() => undefined);
  });

  logger.info({ url: UW_PERISCOPE_URL, targetDate, targetValue: targetValue || null }, 'probe: navigating');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  await clickZoomOut(page);

  // Drive the chart to the target date — this fires whatever endpoint the chart
  // uses to load that day's candles.
  captured.length = 0;
  logger.info({ targetDate }, 'probe: walking chart to date');
  await walkDateToTarget(page, targetDate);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(3_000);

  logger.info({ responses: captured.length }, 'probe: captured responses after date change');

  // List every candle/tick/price-ish endpoint seen.
  for (const { url, body } of captured) {
    if (!/candle|tick|price|ohlc|chart|flow|index/i.test(url)) continue;
    const b = body as Record<string, unknown>;
    const data = (b?.data ?? b) as unknown;
    const len = Array.isArray(data) ? data.length : null;
    logger.info({ url, rows: len, topKeys: b && typeof b === 'object' ? Object.keys(b).slice(0, 6) : null }, 'candle/tick endpoint');
  }

  // If a target value was given, report which endpoint(s) contain it.
  if (targetValue) {
    let found = false;
    for (const { url, body } of captured) {
      const paths = findValuePaths(body, targetValue);
      if (paths.length > 0) {
        found = true;
        logger.info({ url, paths }, `>>> TARGET_VALUE ${targetValue} FOUND — likely the chart source`);
      }
    }
    if (!found) {
      logger.warn(
        { targetValue },
        'TARGET_VALUE not found in any captured response — try a different chart value, or the chart may format/round it (paste a few exact on-chart numbers)',
      );
    }
  }
});
