/**
 * Integration test — REAL DATA, no mocks.
 *
 * Runs the live scrape pipeline end-to-end (`scrapeAllPanels`) against the
 * actual UW Periscope page and asserts the captured snapshot is "good":
 * structurally valid AND consistent with the critical invariants in
 * CLAUDE.md (single expiry, Gamma-anchored timeframe, slot-END capturedAt).
 *
 * It does NOT write to Postgres or fire the webhook — `scrapeAllPanels` is
 * the same read-only entry point `probe.ts` uses. Safe to run any time, but
 * it needs valid auth state (UW_AUTH_STATE_PATH) and network access, and
 * outside RTH UW serves the most recent published slot.
 *
 * Run:  npm run test:integration
 * Exits 0 if every check passes, 1 otherwise.
 */

import pino from 'pino';
import { scrapeAllPanels } from './scrape.js';
import { LOG_LEVEL } from './config.js';
import type { Panel, SnapshotRow } from './types.js';

const logger = pino({ level: LOG_LEVEL });

const GREEK_PANELS: Panel[] = ['gamma', 'charm', 'vanna'];
const TIMEFRAME_PATTERN = /^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const failures: string[] = [];
const notes: string[] = [];

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    logger.info(`  PASS  ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    logger.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Format an ISO-8601 UTC instant as "HH:MM" in America/New_York (ET). */
function etHhmm(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

async function main(): Promise<void> {
  logger.info('integration.test: scraping real data via scrapeAllPanels()…');

  const result = await scrapeAllPanels();
  const rows = result.rows;

  logger.info(
    {
      spot: result.spot,
      totalRows: rows.length,
      panels: [...new Set(rows.map((r) => r.panel))],
    },
    'integration.test: scrape returned',
  );

  // ── Gate: we got data at all ─────────────────────────────────────────
  check('scrape returned rows', rows.length > 0, `got ${rows.length} rows`);
  if (rows.length === 0) {
    // Nothing else is meaningful without rows. This is the common
    // failure mode for a logged-out session or a closed-market void.
    notes.push(
      'Zero rows. Outside RTH UW still serves the last slot, so empty ' +
        'usually means a logged-out session or a page that did not render.',
    );
    return;
  }

  // ── Spot price sane ──────────────────────────────────────────────────
  const spot = result.spot;
  check('spot is a finite positive number', spot != null && Number.isFinite(spot) && spot > 0, `spot=${spot}`);
  if (spot != null && (spot < 1000 || spot > 50000)) {
    notes.push(`spot=${spot} is outside the loose 1000–50000 sanity band (not failing, just flagging).`);
  }

  // ── All three Greek panels present ───────────────────────────────────
  const byPanel = new Map<Panel, SnapshotRow[]>();
  for (const r of rows) {
    const list = byPanel.get(r.panel) ?? [];
    list.push(r);
    byPanel.set(r.panel, list);
  }
  for (const p of GREEK_PANELS) {
    check(`panel "${p}" present`, (byPanel.get(p)?.length ?? 0) > 0, `count=${byPanel.get(p)?.length ?? 0}`);
  }

  // ── Per-panel row integrity ──────────────────────────────────────────
  for (const p of GREEK_PANELS) {
    const panelRows = byPanel.get(p) ?? [];
    if (panelRows.length === 0) continue;

    const badStrike = panelRows.find((r) => !Number.isInteger(r.strike) || r.strike <= 0);
    check(`${p}: all strikes are positive integers`, badStrike === undefined, badStrike && `bad strike ${badStrike.strike}`);

    const strikes = panelRows.map((r) => r.strike);
    check(`${p}: strikes are unique`, new Set(strikes).size === strikes.length, `${strikes.length} rows, ${new Set(strikes).size} unique`);

    const badValue = panelRows.find((r) => !Number.isFinite(r.value));
    check(`${p}: all values are finite numbers`, badValue === undefined, badValue && `strike ${badValue.strike} value ${badValue.value}`);

    check(`${p}: has a reasonable strike count (>=5)`, panelRows.length >= 5, `count=${panelRows.length}`);
  }

  // ── Strike alignment across panels (Gamma is the anchor) ─────────────
  const gammaStrikes = new Set((byPanel.get('gamma') ?? []).map((r) => r.strike));
  for (const p of ['charm', 'vanna'] as Panel[]) {
    const pStrikes = new Set((byPanel.get(p) ?? []).map((r) => r.strike));
    const overlap = [...pStrikes].filter((s) => gammaStrikes.has(s)).length;
    const ratio = pStrikes.size > 0 ? overlap / pStrikes.size : 0;
    check(`${p} strikes substantially overlap gamma (>=90%)`, ratio >= 0.9, `overlap ${overlap}/${pStrikes.size}`);
  }

  // ── Single expiry across all rows ────────────────────────────────────
  const expiries = new Set(rows.map((r) => r.expiry));
  check('all rows share one expiry', expiries.size === 1, `expiries=${[...expiries].join(', ')}`);
  const expiry = [...expiries][0] ?? '';
  check('expiry is YYYY-MM-DD', ISO_DATE_PATTERN.test(expiry), `expiry="${expiry}"`);

  // ── Gamma-anchored timeframe: every panel matches gamma's slot ───────
  const timeframes = new Set(rows.map((r) => r.timeframe));
  check('all rows share one timeframe (Gamma anchor holds)', timeframes.size === 1, `timeframes=${[...timeframes].join(' | ')}`);
  const timeframe = [...timeframes][0] ?? '';
  const tfMatch = TIMEFRAME_PATTERN.exec(timeframe);
  check('timeframe matches "HH:MM - HH:MM"', tfMatch !== null, `timeframe="${timeframe}"`);

  // ── capturedAt is one valid instant == slot END (critical invariant) ─
  const capturedAts = new Set(rows.map((r) => r.capturedAt));
  check('all rows share one capturedAt', capturedAts.size === 1, `capturedAts=${[...capturedAts].join(', ')}`);
  const capturedAt = [...capturedAts][0] ?? '';
  const capturedDate = new Date(capturedAt);
  check('capturedAt is a valid ISO instant', !Number.isNaN(capturedDate.getTime()), `capturedAt="${capturedAt}"`);

  if (tfMatch && !Number.isNaN(capturedDate.getTime())) {
    // Slot-END invariant: capturedAt (in ET) must equal the timeframe END.
    const endHhmm = `${tfMatch[3]}:${tfMatch[4]}`;
    const capturedEt = etHhmm(capturedAt);
    check(
      'capturedAt == slot END time in ET (slot-END invariant)',
      capturedEt === endHhmm,
      `capturedAt is ${capturedEt} ET but timeframe end is ${endHhmm}`,
    );
  }
}

main()
  .then(() => {
    logger.info('────────────────────────────────────────────');
    for (const n of notes) logger.warn(`note: ${n}`);
    if (failures.length === 0) {
      logger.info('integration.test: ✅ ALL CHECKS PASSED');
      process.exit(0);
    }
    logger.error({ failures }, `integration.test: ❌ ${failures.length} CHECK(S) FAILED`);
    process.exit(1);
  })
  .catch((err) => {
    logger.error({ err }, 'integration.test: scrape threw before assertions');
    process.exit(1);
  });
