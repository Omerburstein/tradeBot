/**
 * Data-coverage reporter (TODO #6).
 *
 * Queries the DB for a date range and reports, per trading day, how many Greek
 * (gamma) decision slots have full coverage of the four required sources — SPX,
 * ES, GEX, positions (see data-coverage.ts) — and which slots are missing which
 * source. Writes the findings, together with the static per-source spec, to
 * `docs/data-coverage.md`, so the completeness requirements AND the current gaps
 * live in one place.
 *
 * Usage:
 *   COVERAGE_START=2026-01-02 COVERAGE_END=2026-06-30 npm run coverage
 *   # omit dates to cover every 0DTE day with data; add WRITE=false to only print
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb } from '../db/index.js';
import { REQUIRED_SOURCES, SOURCE_SPECS } from './data-coverage.js';
import { CAPTURED_AT_ET_DATE, CAPTURED_AT_UTC_ISO } from './db-sql.js';
import type { DataSource } from './types.js';

/** Coverage of one trading day's Greek decision slots. */
interface DayCoverage {
  day: string;
  /** Number of distinct gamma decision slots the day has (at the feed's cadence
   *  — per-minute live, 10-min historical backfill). */
  gammaSlots: number;
  /** Slots fully covered by all four sources. */
  fullyCovered: number;
  /** Missing-source counts across this day's gamma slots. */
  missing: Record<DataSource, number>;
}

/** Render captured_at exactly as the loader keys its joins (no milliseconds). */
const AS_KEY = CAPTURED_AT_UTC_ISO;

async function slotSet(query: string, params: unknown[]): Promise<Set<string>> {
  const sql = getDb();
  try {
    const rows = await sql(query, params);
    return new Set(rows.map((r: Record<string, unknown>) => String(r.t)));
  } catch {
    return new Set(); // table may not exist yet — treat as no coverage
  }
}

async function loadDayCoverage(day: string): Promise<DayCoverage> {
  // Gamma slots are the Greek decision anchors (spot/es are also required at the
  // intermediate price ticks, but a slot's Greeks/positions come from these).
  const gamma = await slotSet(
    `SELECT ${AS_KEY} AS t FROM periscope_snapshots
      WHERE expiry = $1 AND panel = 'gamma'
        AND ${CAPTURED_AT_ET_DATE} = $1::date
      GROUP BY captured_at`,
    [day],
  );
  const positions = await slotSet(
    `SELECT ${AS_KEY} AS t FROM positions
      WHERE expiry = $1 AND ${CAPTURED_AT_ET_DATE} = $1::date
      GROUP BY captured_at`,
    [day],
  );
  const spx = await slotSet(
    `SELECT ${AS_KEY} AS t FROM spot_prices WHERE date = $1 GROUP BY captured_at`,
    [day],
  );
  const es = await slotSet(
    `SELECT ${AS_KEY} AS t FROM es_prices WHERE date = $1 GROUP BY captured_at`,
    [day],
  );

  const missing: Record<DataSource, number> = { spx: 0, es: 0, gex: 0, positions: 0 };
  let fullyCovered = 0;
  for (const t of gamma) {
    const have: Record<DataSource, boolean> = {
      gex: true, // by construction (t came from the gamma set)
      positions: positions.has(t),
      spx: spx.has(t),
      es: es.has(t),
    };
    let complete = true;
    for (const s of REQUIRED_SOURCES) {
      if (!have[s]) {
        missing[s] += 1;
        complete = false;
      }
    }
    if (complete) fullyCovered += 1;
  }

  return { day, gammaSlots: gamma.size, fullyCovered, missing };
}

async function availableDays(start?: string, end?: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql(
    `SELECT DISTINCT expiry::text AS expiry FROM periscope_snapshots
      WHERE panel = 'gamma'
        AND ${CAPTURED_AT_ET_DATE} = expiry
        AND ($1::date IS NULL OR expiry >= $1)
        AND ($2::date IS NULL OR expiry <= $2)
      ORDER BY expiry`,
    [start ?? null, end ?? null],
  );
  return rows.map((r: Record<string, unknown>) => String(r.expiry));
}

// ── Markdown rendering ──

function renderSpec(): string {
  const header = '| Source | Table | Column(s) | Present when |\n|---|---|---|---|';
  const rows = SOURCE_SPECS.map(
    (s) => `| \`${s.source}\` | \`${s.table}\` | \`${s.columns}\` | ${s.presentWhen} |`,
  );
  return [header, ...rows].join('\n');
}

function renderReport(days: DayCoverage[], start?: string, end?: string): string {
  const totalSlots = days.reduce((a, d) => a + d.gammaSlots, 0);
  const totalFull = days.reduce((a, d) => a + d.fullyCovered, 0);
  const totalMissing: Record<DataSource, number> = { spx: 0, es: 0, gex: 0, positions: 0 };
  for (const d of days) for (const s of REQUIRED_SOURCES) totalMissing[s] += d.missing[s];

  const range = `${start ?? days[0]?.day ?? '—'} → ${end ?? days[days.length - 1]?.day ?? '—'}`;
  const pct = totalSlots > 0 ? ((totalFull / totalSlots) * 100).toFixed(1) : '0.0';

  const out: string[] = [];
  out.push('# Data Coverage — Decision Completeness (TODO #6)');
  out.push('');
  out.push(
    'The algo only makes an entry/exit decision for a slot when **all four** of its',
    'required data sources are present. If any is missing it emits a structured',
    '`DATA_GAP` error and holds — a half-covered slot never moves the book. This',
    'file documents what each source is, where it comes from, and what "present"',
    'means, then reports which slots currently lack full coverage.',
    '',
    '> Generated by `npm run coverage`. Do not edit by hand — rerun to refresh.',
    '',
    '## Required sources',
    '',
    renderSpec(),
    '',
    'A slot is **actionable** only when every row above is satisfied. The gate lives',
    'in `algorithms/data-coverage.ts` (`assessCoverage`) and is enforced in',
    '`algorithms/signal-generator.ts` (`processSnapshot`, step 0). Intermediate',
    'price ticks (inserted between Greek frames when the feed is coarser than',
    'per-minute) additionally require a spot **and** ES bar at the tick instant;',
    'their GEX/positions carry from the parent Greek slot.',
    '',
    '## Current coverage',
    '',
    `Range: **${range}** · ${days.length} trading day(s) · ${totalSlots} gamma decision slots.`,
    '',
    `Fully covered: **${totalFull}/${totalSlots} (${pct}%)**.`,
    '',
    'Slots missing each source (a slot may miss several):',
    '',
    '| Source | Slots missing |',
    '|---|---|',
    ...REQUIRED_SOURCES.map((s) => `| \`${s}\` | ${totalMissing[s]} |`),
    '',
    '### Per-day breakdown',
    '',
    '| Day | Slots | Full | Missing spx | Missing es | Missing gex | Missing positions |',
    '|---|---|---|---|---|---|---|',
  );
  for (const d of days) {
    out.push(
      `| ${d.day} | ${d.gammaSlots} | ${d.fullyCovered} | ${d.missing.spx} | ${d.missing.es} | ${d.missing.gex} | ${d.missing.positions} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

function outPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'docs', 'data-coverage.md');
}

// ── CLI ──

const isMain =
  process.argv[1]?.endsWith('coverage-report.ts') ||
  process.argv[1]?.endsWith('coverage-report.js');

if (isMain) {
  const start = process.env.COVERAGE_START;
  const end = process.env.COVERAGE_END;
  const write = process.env.WRITE !== 'false';

  (async () => {
    const days = await availableDays(start, end);
    if (days.length === 0) {
      console.error('No 0DTE days with data in range.');
      process.exit(1);
    }
    const coverage: DayCoverage[] = [];
    for (const day of days) coverage.push(await loadDayCoverage(day));

    const totalSlots = coverage.reduce((a, d) => a + d.gammaSlots, 0);
    const totalFull = coverage.reduce((a, d) => a + d.fullyCovered, 0);
    console.log(`Coverage ${days[0]} → ${days[days.length - 1]}: ` +
      `${totalFull}/${totalSlots} gamma slots fully covered across ${days.length} days.`);
    for (const d of coverage) {
      const gaps = REQUIRED_SOURCES.filter((s) => d.missing[s] > 0)
        .map((s) => `${s}=${d.missing[s]}`)
        .join(' ');
      console.log(
        `  ${d.day}: ${d.fullyCovered}/${d.gammaSlots} full` + (gaps ? `  (missing ${gaps})` : ''),
      );
    }

    if (write) {
      const md = renderReport(coverage, start, end);
      const path = outPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, md, 'utf8');
      console.log(`\nWrote ${path}`);
    }
  })().then(() => process.exit(0)).catch((e) => {
    console.error('coverage-report failed:', e);
    process.exit(1);
  });
}
