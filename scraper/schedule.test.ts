/**
 * Unit test — schedule & calendar gates (NO network, NO DB, NO browser).
 *
 * Exercises the pure scheduling logic the scraper relies on to decide
 * *when* it should do anything at all:
 *
 *   - weekends            → never poll, never enumerate
 *   - US market holidays  → excluded from backfill day lists
 *   - off-market times     → outside the active polling / RTH windows
 *   - 10-min slot timing   → expectedWindowEnd / parseSlotEnd boundaries
 *   - DST correctness      → CT↔UTC offset is computed, not assumed
 *
 * Most assertions hit `dates.ts`, which is intentionally dependency-free.
 * Holiday/weekend enumeration lives in `scrape.ts` (`tradingDaysBetween`),
 * which transitively imports `config.ts` and validates env at load — so we
 * stub DATABASE_URL and dynamic-import it after the pure imports.
 *
 * Run:  npm run test:unit
 * Exits 0 if every check passes, 1 otherwise. Matches integration.test.ts.
 */

import pino from 'pino';
import {
  isInActivePollingWindow,
  isCtInRth,
  expectedWindowEnd,
  parseSlotEnd,
  computeCapturedAt,
} from './dates.js';

// scrape.ts → config.ts throws at import if DATABASE_URL is unset. This
// test never opens a connection; the stub just satisfies the load-time
// guard. Set BEFORE the dynamic import below (static imports are hoisted,
// so tradingDaysBetween must come in via await import()).
process.env.DATABASE_URL ??=
  'postgres://stub:stub@localhost:5432/stub?sslmode=require';
const { tradingDaysBetween } = await import('./scrape.js');

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    logger.info(`  PASS  ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    logger.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? undefined : `got ${a}, expected ${e}`);
}

function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw, threw ? undefined : 'expected a throw, got none');
}

// ── CT instant builders ──────────────────────────────────────────────
// Encode the CT wall-clock directly via an explicit UTC offset so the
// gate functions (which read the instant back in America/Chicago) see
// exactly the intended local time. CST = -06:00, CDT = -05:00.
//   2026-01-05 Mon (winter/CST)   2026-06-15 Mon (summer/CDT)
//   2026-01-10 Sat                2026-01-11 Sun   (both CST)
//   2026-03-09 Mon (first weekday after spring-forward, CDT)
const monWinter = (hms: string) => new Date(`2026-01-05T${hms}-06:00`);
const monSummer = (hms: string) => new Date(`2026-06-15T${hms}-05:00`);
const saturday = (hms: string) => new Date(`2026-01-10T${hms}-06:00`);
const sunday = (hms: string) => new Date(`2026-01-11T${hms}-06:00`);

logger.info('schedule.test: pure scheduling/calendar gates…');

// ─────────────────────────────────────────────────────────────────────
// 1. Active polling window — Mon-Fri 08:21-15:14 CT (inclusive bounds)
// ─────────────────────────────────────────────────────────────────────
check('active: weekday inside window (12:00)', isInActivePollingWindow(monWinter('12:00:00')));
check('active: lower bound 08:21 inclusive', isInActivePollingWindow(monWinter('08:21:00')));
check('active: just before lower 08:20 excluded', !isInActivePollingWindow(monWinter('08:20:59')));
check('active: upper bound 15:14 inclusive', isInActivePollingWindow(monWinter('15:14:00')));
check('active: just after upper 15:15 excluded', !isInActivePollingWindow(monWinter('15:15:00')));

// off-market times — same weekday, outside hours
check('off-market: 03:00 pre-dawn excluded', !isInActivePollingWindow(monWinter('03:00:00')));
check('off-market: 07:00 pre-market excluded', !isInActivePollingWindow(monWinter('07:00:00')));
check('off-market: 20:00 after-hours excluded', !isInActivePollingWindow(monWinter('20:00:00')));
check('off-market: 23:59 late-night excluded', !isInActivePollingWindow(monWinter('23:59:00')));

// weekends — never active even mid-day
check('weekend: Saturday 12:00 excluded', !isInActivePollingWindow(saturday('12:00:00')));
check('weekend: Sunday 12:00 excluded', !isInActivePollingWindow(sunday('12:00:00')));

// DST: summer weekday at the same wall-clock must still be inside.
// Catches any regression to a hardcoded UTC offset.
check('DST: summer weekday 09:00 CDT inside window', isInActivePollingWindow(monSummer('09:00:00')));
check('DST: post-spring-forward Mon 09:00 CDT inside', isInActivePollingWindow(new Date('2026-03-09T09:00:00-05:00')));

// ─────────────────────────────────────────────────────────────────────
// 2. RTH gate — Mon-Fri 08:30-15:00 CT (used by webhook staleness guard)
// ─────────────────────────────────────────────────────────────────────
check('rth: lower bound 08:30 inclusive', isCtInRth(monWinter('08:30:00')));
check('rth: just before 08:29 excluded', !isCtInRth(monWinter('08:29:00')));
check('rth: upper bound 15:00 inclusive', isCtInRth(monWinter('15:00:00')));
check('rth: just after 15:01 excluded', !isCtInRth(monWinter('15:01:00')));
check('rth: midday weekday included', isCtInRth(monWinter('11:30:00')));
check('rth: Saturday excluded', !isCtInRth(saturday('11:30:00')));
check('rth: Sunday excluded', !isCtInRth(sunday('11:30:00')));
check('rth: DST summer 09:00 CDT included', isCtInRth(monSummer('09:00:00')));

// ─────────────────────────────────────────────────────────────────────
// 3. 10-min slot end — expectedWindowEnd (which closed slot to expect)
// ─────────────────────────────────────────────────────────────────────
eq('slot: 08:30:00 → "08:30" (slot just closed)', expectedWindowEnd(monWinter('08:30:00')), '08:30');
eq('slot: 08:32:15 → "08:30"', expectedWindowEnd(monWinter('08:32:15')), '08:30');
eq('slot: 08:39:59 → "08:30"', expectedWindowEnd(monWinter('08:39:59')), '08:30');
eq('slot: 08:40:00 → "08:40" (next slot closed)', expectedWindowEnd(monWinter('08:40:00')), '08:40');
eq('slot: 15:00:00 → "15:00"', expectedWindowEnd(monWinter('15:00:00')), '15:00');
eq('slot: 00:05 before first boundary → null', expectedWindowEnd(monWinter('00:05:00')), null);
eq('slot: 00:10 first boundary → "00:10"', expectedWindowEnd(monWinter('00:10:00')), '00:10');

// ─────────────────────────────────────────────────────────────────────
// 4. Slot-label parsing — parseSlotEnd
// ─────────────────────────────────────────────────────────────────────
eq('parse: "08:20 - 08:30" → "08:30"', parseSlotEnd('08:20 - 08:30'), '08:30');
eq('parse: "14:50 - 15:00" → "15:00"', parseSlotEnd('14:50 - 15:00'), '15:00');
eq('parse: unpadded "9:10 - 9:20" → "09:20"', parseSlotEnd('9:10 - 9:20'), '09:20');
eq('parse: garbage → null', parseSlotEnd('not a slot'), null);
eq('parse: empty → null', parseSlotEnd(''), null);

// ─────────────────────────────────────────────────────────────────────
// 5. computeCapturedAt — slot-END instant, DST-aware CT→UTC
//    (the function whose regression corrupted 5/4-5/7 data; see dates.ts)
// ─────────────────────────────────────────────────────────────────────
eq('capturedAt: winter 08:30 CST → 14:30 UTC', computeCapturedAt('2026-01-05', '08:30'), '2026-01-05T14:30:00.000Z');
eq('capturedAt: summer 08:30 CDT → 13:30 UTC', computeCapturedAt('2026-06-15', '08:30'), '2026-06-15T13:30:00.000Z');
eq('capturedAt: post-DST Mon 08:30 CDT → 13:30 UTC', computeCapturedAt('2026-03-09', '08:30'), '2026-03-09T13:30:00.000Z');
eq('capturedAt: accepts unpadded hour "8:30"', computeCapturedAt('2026-06-15', '8:30'), '2026-06-15T13:30:00.000Z');
eq('capturedAt: debrief slot 15:00 CST → 21:00 UTC', computeCapturedAt('2026-01-05', '15:00'), '2026-01-05T21:00:00.000Z');
throws('capturedAt: malformed date throws', () => computeCapturedAt('not-a-date', '08:30'));
throws('capturedAt: malformed slot throws', () => computeCapturedAt('2026-01-05', 'xx:yy'));

// round-trip: the CT HH:MM read back from the result equals the input
{
  const iso = computeCapturedAt('2026-07-04', '12:40');
  const back = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  eq('capturedAt: round-trips back to "12:40" CT', back, '12:40');
}

// ─────────────────────────────────────────────────────────────────────
// 6. tradingDaysBetween — holidays + weekends excluded (backfill gate)
// ─────────────────────────────────────────────────────────────────────
// Clean Mon-Fri week, no holiday → all five days.
eq(
  'days: clean week Mon-Fri → 5 trading days',
  tradingDaysBetween('2026-03-02', '2026-03-06'),
  ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'],
);

// Week containing Juneteenth (Fri 2026-06-19) + weekend tail.
eq(
  'days: week with Juneteenth holiday Fri skipped',
  tradingDaysBetween('2026-06-15', '2026-06-21'),
  ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18'],
);

// Week starting on MLK Day (Mon 2026-01-19) → Mon dropped.
eq(
  'days: week starting MLK holiday Mon skipped',
  tradingDaysBetween('2026-01-19', '2026-01-23'),
  ['2026-01-20', '2026-01-21', '2026-01-22', '2026-01-23'],
);

// Weekend-only range → empty.
eq('days: Sat-Sun range → []', tradingDaysBetween('2026-06-20', '2026-06-21'), []);

// Single holiday (Christmas, Fri 2026-12-25) → empty.
eq('days: Christmas-only range → []', tradingDaysBetween('2026-12-25', '2026-12-25'), []);

// Single New Year's holiday (Thu 2026-01-01) → empty.
eq("days: New Year's-only range → []", tradingDaysBetween('2026-01-01', '2026-01-01'), []);

// Single ordinary weekday → that one day.
eq('days: single trading day → [self]', tradingDaysBetween('2026-03-04', '2026-03-04'), ['2026-03-04']);

// Inclusive bounds + chronological order preserved across a weekend gap.
eq(
  'days: Fri→Mon spans weekend, inclusive bounds',
  tradingDaysBetween('2026-03-06', '2026-03-09'),
  ['2026-03-06', '2026-03-09'],
);

// Malformed bound throws (guards backfill env parsing).
throws('days: malformed bound throws', () => tradingDaysBetween('garbage', '2026-03-06'));

// ─────────────────────────────────────────────────────────────────────
logger.info('────────────────────────────────────────────');
if (failures.length === 0) {
  logger.info('schedule.test: ✅ ALL CHECKS PASSED');
  process.exit(0);
}
logger.error({ failures }, `schedule.test: ❌ ${failures.length} CHECK(S) FAILED`);
process.exit(1);
