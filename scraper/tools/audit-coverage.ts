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

// Dates that have at least one row in periscope_snapshots
const gexRows = await sql(
  `SELECT DISTINCT DATE(captured_at AT TIME ZONE 'America/New_York') AS d
   FROM periscope_snapshots
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   ORDER BY d`,
  [START, END],
) as { d: Date | string }[];

// Dates that have at least one row in positions
const posRows = await sql(
  `SELECT DISTINCT DATE(captured_at AT TIME ZONE 'America/New_York') AS d
   FROM positions
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   ORDER BY d`,
  [START, END],
) as { d: Date | string }[];

const toYmd = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const gexDates  = new Set(gexRows.map((r) => toYmd(r.d)));
const posDates  = new Set(posRows.map((r) => toYmd(r.d)));

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

if (missingBoth.length) {
  console.log(`Missing BOTH GEX + Positions (${missingBoth.length}):`);
  missingBoth.forEach((d) => console.log(`  ${d}`));
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
