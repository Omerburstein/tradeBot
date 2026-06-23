/**
 * Trading-calendar helpers — US equity-options market holidays plus pure
 * calendar arithmetic for stepping between trading sessions. No browser or
 * DB dependencies; just date math used by the navigation walkers and the
 * backfill / walk-back orchestration loops.
 */

// US equity-options market holidays. SPX trading is closed on these
// dates. Maintained inline because the periscope-scraper service does
// not pull a holiday calendar from anywhere else; if the user backfills
// a year not covered here, dates that fall on holidays will produce
// "No data available" and the scraper logs + skips them, so the
// holiday list is a perf optimization (skip-without-attempt), not a
// correctness gate.
export const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
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

export function prevDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The latest date for which UW market data is available.
 * Returns today if the market has already opened (past 09:20 ET) and
 * today is a trading day. Otherwise walks backwards past weekends and
 * holidays until it finds the most recent trading day.
 */
export function latestTradingDay(): string {
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
export function prevTradingDay(ymd: string): string {
  let candidate = prevDay(ymd);
  while (true) {
    const dow = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !US_MARKET_HOLIDAYS.has(candidate)) {
      return candidate;
    }
    candidate = prevDay(candidate);
  }
}

/**
 * The next trading day after `ymd` (Mon-Fri, US-market non-holiday).
 * Used to determine the next-expiry date for dual-expiry live tick scrapes.
 */
export function nextTradingDay(ymd: string): string {
  let candidate = nextDay(ymd);
  while (true) {
    const dow = new Date(`${candidate}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !US_MARKET_HOLIDAYS.has(candidate)) {
      return candidate;
    }
    candidate = nextDay(candidate);
  }
}

/** Calendar-day diff between two YYYY-MM-DD strings (target - current).
 *  Negative when current > target. Used to decide whether to use the
 *  day-chevron path or the calendar path. */
export function daysBetweenYmd(currentYmd: string, targetYmd: string): number {
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
