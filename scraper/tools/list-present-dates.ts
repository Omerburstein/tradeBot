/**
 * List every ET date present in periscope_snapshots (GEX) and positions,
 * with row counts, for the full audit window. Used to reconcile the
 * coverage audit against eyeballed DB contents.
 *
 * Run via:  npx tsx scraper/tools/list-present-dates.ts
 */

import { getDb } from '../../db/client.js';

const START = '2025-12-01';
const END   = '2026-06-30';

const sql = getDb();

const gex = await sql(
  `SELECT to_char(captured_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d,
          to_char(captured_at AT TIME ZONE 'America/New_York', 'Dy') AS dow,
          COUNT(*)::int AS n,
          to_char(MIN(captured_at AT TIME ZONE 'America/New_York'), 'HH24:MI') AS first_et,
          to_char(MAX(captured_at AT TIME ZONE 'America/New_York'), 'HH24:MI') AS last_et
   FROM periscope_snapshots
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   GROUP BY d, dow ORDER BY d`,
  [START, END],
) as { d: string; dow: string; n: number; first_et: string; last_et: string }[];

const pos = await sql(
  `SELECT to_char(captured_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d,
          COUNT(*)::int AS n
   FROM positions
   WHERE captured_at >= $1::date AND captured_at < ($2::date + INTERVAL '1 day')
   GROUP BY d ORDER BY d`,
  [START, END],
) as { d: string; n: number }[];

const posMap = new Map(pos.map((r) => [r.d, r.n]));

console.log(`\nPresent ET dates ${START} → ${END}\n`);
console.log('date        dow  gex_rows  pos_rows  et_span');
let weekendCount = 0;
for (const r of gex) {
  const p = posMap.get(r.d) ?? 0;
  const weekend = r.dow === 'Sat' || r.dow === 'Sun';
  if (weekend) weekendCount++;
  console.log(
    `${r.d}  ${r.dow}  ${String(r.n).padStart(8)}  ${String(p).padStart(8)}  ${r.first_et}-${r.last_et}${weekend ? '   <-- WEEKEND' : ''}`,
  );
}
console.log(`\nGEX dates present: ${gex.length}  (weekend-attributed: ${weekendCount})`);
