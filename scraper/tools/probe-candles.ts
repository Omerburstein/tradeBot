/**
 * Intraday SPX source finder. For CANDLE_DATE, directly fetches several
 * index_candles resolutions/date-param variants (and one_minute_ticks),
 * filters each to the date, and reports:
 *   - whether the endpoint returns data for the requested day (backfill-viable),
 *   - the 09:30–09:50 morning bars (start ET + OHLC), and
 *   - any bar whose o/h/l/c ≈ TARGET_VALUE (a price read off the chart), so we
 *     can see WHICH endpoint + resolution the chart actually draws and at which
 *     timestamp the value lives.
 *
 * No DB writes. Run:
 *   CANDLE_DATE=2026-05-26 TARGET_VALUE=7513.68 npm run probe:candles
 */
import type { APIRequestContext } from 'playwright';
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from '../scrape/browser.js';
import { waitForChartReady, clickZoomOut } from '../scrape/chart.js';
import { etDateOf } from '../scrape/api-transforms.js';

const ORIGIN = 'https://phx.unusualwhales.com';
const targetDate = (process.env.CANDLE_DATE ?? '').trim();
const targetValue = Number.parseFloat((process.env.TARGET_VALUE ?? '').trim());
const hasTarget = Number.isFinite(targetValue);
if (!targetDate) {
  logger.error('set CANDLE_DATE=YYYY-MM-DD (ET) — e.g. CANDLE_DATE=2026-05-26');
  process.exit(1);
}

function etClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(d);
}

/** A candle/tick row with a timestamp + OHLC under varying field names. */
function readRow(r: Record<string, unknown>): { ts: string | null; o?: string; h?: string; l?: string; c?: string } {
  const ts = (r.start ?? r.start_time ?? r.timestamp ?? r.time ?? null) as string | null;
  return { ts, o: r.o as string ?? r.open as string, h: r.h as string ?? r.high as string, l: r.l as string ?? r.low as string, c: r.c as string ?? r.close as string };
}

const near = (s: string | undefined) =>
  hasTarget && s != null && Math.abs(Number.parseFloat(s) - targetValue) <= 0.05;

async function report(req: APIRequestContext, label: string, url: string): Promise<void> {
  let resp;
  try {
    resp = await req.get(url);
  } catch (err) {
    logger.warn({ label, url, err: String(err) }, 'fetch threw');
    return;
  }
  if (!resp.ok()) {
    logger.warn({ label, url, status: resp.status() }, 'fetch non-OK');
    return;
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const data = (Array.isArray(body) ? body : body.data) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(data)) {
    logger.info({ label, url, topKeys: Object.keys(body).slice(0, 6) }, 'no data[] array');
    return;
  }
  const rows = data.map(readRow).filter((r) => r.ts != null);
  const forDate = rows.filter((r) => etDateOf(new Date(r.ts!)) === targetDate);
  const firstSession = rows[0]?.ts ? etDateOf(new Date(rows[0]!.ts!)) : null;

  logger.info(
    { label, url, totalRows: rows.length, rowsForDate: forDate.length, firstSessionDate: firstSession, respectsDate: forDate.length > 0 },
    'ENDPOINT SUMMARY',
  );

  // Morning bars 09:30–09:50.
  for (const r of forDate) {
    const et = etClock(new Date(r.ts!));
    if (et < '09:30:00' || et > '09:50:00') continue;
    logger.info({ label, startET: et, o: r.o, h: r.h, l: r.l, c: r.c }, 'morning bar');
  }
  // Any bar whose OHLC matches the chart value.
  if (hasTarget) {
    for (const r of forDate) {
      if (near(r.o) || near(r.h) || near(r.l) || near(r.c)) {
        const which = [near(r.o) && 'open', near(r.h) && 'high', near(r.l) && 'low', near(r.c) && 'close'].filter(Boolean);
        logger.info({ label, startET: etClock(new Date(r.ts!)), matchedField: which, o: r.o, h: r.h, l: r.l, c: r.c }, `>>> TARGET ${targetValue} MATCH`);
      }
    }
  }
}

await withBrowser(async (_browser, page) => {
  logger.info({ url: UW_PERISCOPE_URL, targetDate, targetValue: hasTarget ? targetValue : null }, 'probe: navigating');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  await clickZoomOut(page);

  const req = page.request;
  // Try every plausible intraday source/resolution/date-param shape.
  await report(req, '5m/interval', `${ORIGIN}/api/index_candles/SPX/5m?interval=40d`);
  await report(req, '1m/interval', `${ORIGIN}/api/index_candles/SPX/1m?interval=40d`);
  await report(req, '5m/date', `${ORIGIN}/api/index_candles/SPX/5m?date=${targetDate}`);
  await report(req, '1m/date', `${ORIGIN}/api/index_candles/SPX/1m?date=${targetDate}`);
  await report(req, 'one_minute_ticks/date', `${ORIGIN}/api/index_ticks/SPX/one_minute_ticks?date=${targetDate}`);
});
