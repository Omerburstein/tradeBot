/**
 * Audit stored Greek frames for the 2026-05-26 defect class: gamma computed
 * against the wrong underlying (see scraper/core/frame-quality.ts).
 *
 * Scans periscope_snapshots joined to positions + spot_prices and reports every
 * slot whose per-contract gamma kernel peaks too far from spot. Read-only.
 *
 *   npm run audit:frames                      # since 2026-05-01
 *   npm run audit:frames -- --since 2026-01-01
 *   npm run audit:frames -- --slots           # list every bad slot, not a summary
 *
 * Exits 1 when any corrupt slot is found, so it can gate a backfill or run in CI.
 */
import { getDb } from '../../db/index.js';
import { checkFrameAgainstSpot, MAX_ATM_DEVIATION, type FrameStrike } from '../core/frame-quality.js';

const args = process.argv.slice(2);
const since = args[args.indexOf('--since') + 1]?.match(/^\d{4}-\d{2}-\d{2}$/)
  ? args[args.indexOf('--since') + 1]!
  : '2026-05-01';
const listSlots = args.includes('--slots');

const sql = getDb();

const days = await sql(
  `SELECT DISTINCT expiry::text AS d
   FROM periscope_snapshots
   WHERE panel = 'gamma'
     AND (captured_at AT TIME ZONE 'America/New_York')::date = expiry
     AND expiry >= $1
   ORDER BY d`,
  [since],
);

console.log(`Auditing Greek frames since ${since} (threshold ±${MAX_ATM_DEVIATION} pts)\n`);

const badByDay = new Map<string, { slot: string; dev: number; atm: number; spot: number }[]>();
let totalSlots = 0;

for (const dr of days) {
  const date = String(dr.d);
  const rows = await sql(
    `SELECT to_char(g.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS k,
            g.strike, g.value AS gamma, (p.call_qty + p.put_qty) AS net
     FROM periscope_snapshots g
     JOIN positions p
       ON p.captured_at = g.captured_at AND p.strike = g.strike AND p.expiry = g.expiry
     WHERE g.expiry = $1 AND g.panel = 'gamma'
     ORDER BY g.captured_at`,
    [date],
  );
  const spotRows = await sql(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS k, spot
     FROM spot_prices WHERE date = $1`,
    [date],
  );
  const spotBy = new Map(spotRows.map((r: any) => [String(r.k), Number(r.spot)]));

  const bySlot = new Map<string, FrameStrike[]>();
  for (const r of rows) {
    const k = String(r.k);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k)!.push({ strike: Number(r.strike), gamma: Number(r.gamma), net: Number(r.net) });
  }

  for (const [slot, strikes] of [...bySlot.entries()].sort()) {
    const spot = spotBy.get(slot);
    if (spot === undefined) continue;
    totalSlots++;
    const check = checkFrameAgainstSpot(strikes, spot);
    if (check.ok || check.deviation === null) continue;
    if (!badByDay.has(date)) badByDay.set(date, []);
    badByDay.get(date)!.push({ slot, dev: check.deviation, atm: check.impliedAtm!, spot });
  }
}

const totalBad = [...badByDay.values()].reduce((a, b) => a + b.length, 0);

if (totalBad === 0) {
  console.log(`  clean — 0 corrupt slots out of ${totalSlots}`);
  process.exit(0);
}

console.log('  date         badSlots   worstDev   ET times');
for (const [date, bad] of [...badByDay.entries()].sort()) {
  const worst = bad.reduce((a, b) => (Math.abs(b.dev) > Math.abs(a.dev) ? b : a));
  const ets = bad.map((b) =>
    new Date(b.slot).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }),
  );
  console.log(
    `  ${date}   ${String(bad.length).padStart(6)}   ${worst.dev.toFixed(1).padStart(8)}   ` +
    (ets.length > 8 ? `${ets.slice(0, 8).join(' ')} …(+${ets.length - 8})` : ets.join(' ')),
  );
  if (listSlots) {
    for (const b of bad) {
      console.log(`      ${b.slot}  impliedAtm=${b.atm}  spot=${b.spot.toFixed(1)}  dev=${b.dev.toFixed(1)}`);
    }
  }
}
console.log(`\n  ${totalBad} corrupt slot(s) across ${badByDay.size} day(s), out of ${totalSlots} scanned.`);
console.log('  These days need a re-backfill (delete the bad slots first — inserts are ON CONFLICT DO NOTHING).');
process.exit(1);
