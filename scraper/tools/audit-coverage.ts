/**
 * Audit DB coverage gaps between 2025-12-29 and today.
 * Reports trading days with no GEX data (periscope_snapshots) and/or
 * no positions data (positions table).
 *
 * Run via:  npx tsx scraper/tools/audit-coverage.ts
 */

import { getDb } from '../../db/client.js';
import { tradingDaysBetween } from '../scrape/trading-calendar.js';

const START = '2025-12-29';
const END   = '2026-06-30';

const sql = getDb();

// Dates that have at least one row in periscope_snapshots.
// NOTE: format the ET date to a plain string IN POSTGRES (to_char). Do NOT
// return a Postgres DATE here — the Neon driver parses it into a JS Date at
// the host's local-tz midnight, and a later .toISOString() rolls it back to
// the previous UTC day, silently shifting every date by one.
const gexRows = await sql(
  `SELECT DISTINCT to_char(captured_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
   FROM periscope_snapshots
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   ORDER BY d`,
  [START, END],
) as { d: string }[];

// Dates that have at least one row in positions
const posRows = await sql(
  `SELECT DISTINCT to_char(captured_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
   FROM positions
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   ORDER BY d`,
  [START, END],
) as { d: string }[];

const gexDates  = new Set(gexRows.map((r) => r.d));
const posDates  = new Set(posRows.map((r) => r.d));

const tradingDays = tradingDaysBetween(START, END);

const missingGex: string[] = [];
const missingPos: string[] = [];
const missingBoth: string[] = [];

for (const day of tradingDays) {
  const noGex = !gexDates.has(day);
  const noPos = !posDates.has(day);
  if (noGex && noPos) missingBoth.push(day);
  else if (noGex)     missingGex.push(day);
  else if (noPos)     missingPos.push(day);
}

console.log(`\nAudit: ${START} → ${END}  (${tradingDays.length} trading days)\n`);

// Weekday name from a YYYY-MM-DD string, computed in UTC to avoid any
// host-tz drift (the date is a pure calendar label, not an instant).
const dow = (ymd: string): string =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(`${ymd}T12:00:00Z`).getUTCDay()
  ]!;

if (missingBoth.length) {
  console.log(`Missing BOTH GEX + Positions (${missingBoth.length}) — trading days only:`);
  missingBoth.forEach((d) => console.log(`  ${d}  ${dow(d)}`));
  console.log();
}
if (missingGex.length) {
  console.log(`Missing GEX only (${missingGex.length}):`);
  missingGex.forEach((d) => console.log(`  ${d}`));
  console.log();
}
if (missingPos.length) {
  console.log(`Missing Positions only (${missingPos.length}):`);
  missingPos.forEach((d) => console.log(`  ${d}`));
  console.log();
}
if (!missingBoth.length && !missingGex.length && !missingPos.length) {
  console.log('No gaps found — all trading days have both GEX and positions data.');
}
