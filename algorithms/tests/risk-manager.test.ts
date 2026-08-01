/**
 * Unit test — time-decaying take-profit / stop-loss (NO network, NO DB, NO browser).
 *
 * Pins the behaviour of the changeable exit distances: both the entry-frozen GEX
 * take-profit and the hard stop walk LINEARLY toward the entry price as the
 * trade ages, so a move that gets most of the way to target and stalls is banked
 * at a reduced distance instead of round-tripping.
 *
 *   distance(t) = max(floor, initial · (1 − perHour · hoursHeld))
 *
 * The invariants guarded here:
 *   - `perHour = 0` is EXACTLY the pre-decay fixed-distance behaviour
 *     (back-compat for every config tuned before decay existed);
 *   - decay is linear in wall-clock hours held, measured from the entry instant;
 *   - the floor bounds the decay, and is itself clamped to the initial distance
 *     so a high floor can never WIDEN an exit (decay only tightens);
 *   - a distance never goes negative, even past 1/hour decay;
 *   - a bad/absent/out-of-order clock degrades to "no decay", never to a
 *     spuriously shrunken target that would fabricate an exit;
 *   - the stalling-trade case end-to-end: a +20pt open trade under a 30pt target
 *     does not exit at t=0 but DOES once decay brings the target under +20;
 *   - §7: the take-profit center weights strikes by gamma² while the entry gate
 *     stays on plain gamma mass — two different numbers from one book, plus the
 *     scale-invariance / single-strike / empty-window edge cases.
 *
 * Only pure functions from risk-manager.ts are exercised — no env/DB stub needed.
 *
 * Run:  npm run test:unit  (chained after the score-engine test)
 * Exits 0 if every check passes, 1 otherwise. Matches score-engine.test.ts.
 */

import pino from 'pino';
import {
  checkStopLoss,
  checkTakeProfit,
  effectiveStopLossPoints,
  effectiveTakeProfitPoints,
  gammaCenterStrike,
  gexEntryGatePoints,
  gexTakeProfitPoints,
} from '../risk-manager.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { AlgoConfig, Snapshot, TradeState } from '../types.js';

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

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// ── Fixtures ─────────────────────────────────────────────────────────
// A long opened at SPX 6800 with a 30pt GEX target frozen at entry.
const ENTRY_ISO = '2026-07-28T14:00:00.000Z';
const ENTRY_PRICE = 6800;
const TP_POINTS = 30;

/** ISO instant `minutes` after the entry (negative → before it). */
function at(minutes: number): string {
  return new Date(Date.parse(ENTRY_ISO) + minutes * 60_000).toISOString();
}

function longState(overrides: Partial<TradeState> = {}): TradeState {
  return {
    position: 'long',
    entryPrice: ENTRY_PRICE,
    entryFill: ENTRY_PRICE,
    entryTime: ENTRY_ISO,
    entryScore: null,
    contracts: 1,
    unrealizedPnl: 0,
    dailyPnl: 0,
    dailyTradeCount: 0,
    highWaterMark: 0,
    gexTpPoints: TP_POINTS,
    ...overrides,
  };
}

function cfg(risk: Partial<AlgoConfig['risk']> = {}): AlgoConfig {
  return { ...DEFAULT_CONFIG, risk: { ...DEFAULT_CONFIG.risk, ...risk } };
}

// ── §1 Back-compat: decay off is the old fixed distance ──────────────
{
  logger.info('§1 decay disabled → fixed distances (pre-decay behaviour)');
  const off = cfg({ takeProfitDecayPerHour: 0, stopLossDecayPerHour: 0 });
  const s = longState();

  check(
    'TP with perHour=0 is unchanged after 4h',
    near(effectiveTakeProfitPoints(off, s, at(240))!, TP_POINTS),
    `got ${effectiveTakeProfitPoints(off, s, at(240))}`,
  );
  check(
    'SL with perHour=0 is unchanged after 4h',
    near(effectiveStopLossPoints(off, s, at(240)), off.risk.stopLossPoints),
    `got ${effectiveStopLossPoints(off, s, at(240))}`,
  );
  // The old all-or-nothing rule: +20 under a 30pt target never exits, ever.
  check(
    'TP with perHour=0: +20pts under a 30pt target does NOT exit even after 4h',
    !checkTakeProfit(s, ENTRY_PRICE + 20, off, at(240)).hit,
  );
}

// ── §2 Linear decay in hours held ────────────────────────────────────
{
  logger.info('§2 take-profit decays linearly toward entry');
  const c = cfg({ takeProfitDecayPerHour: 0.25, takeProfitFloorPoints: 6 });
  const s = longState();

  check('TP at entry (t=0) is the full frozen target', near(effectiveTakeProfitPoints(c, s, at(0))!, 30));
  check('TP after 1h → 22.5 (30 × 0.75)', near(effectiveTakeProfitPoints(c, s, at(60))!, 22.5));
  check('TP after 2h → 15.0 (30 × 0.50)', near(effectiveTakeProfitPoints(c, s, at(120))!, 15));
  check('TP after 30m → 26.25 (sub-hour resolution)', near(effectiveTakeProfitPoints(c, s, at(30))!, 26.25));
}

// ── §3 Floors bound the decay and never widen an exit ────────────────
{
  logger.info('§3 floor clamps');
  const c = cfg({ takeProfitDecayPerHour: 0.25, takeProfitFloorPoints: 6 });

  // 30 × (1 − 1.5) = −15 → floored at 6.
  check(
    'TP decayed past the floor is held at takeProfitFloorPoints',
    near(effectiveTakeProfitPoints(c, longState(), at(360))!, 6),
    `got ${effectiveTakeProfitPoints(c, longState(), at(360))}`,
  );

  // Floor ABOVE the initial distance must not widen the target at any time.
  const tight = longState({ gexTpPoints: 5 });
  check(
    'floor above the initial distance never widens the target (t=0)',
    near(effectiveTakeProfitPoints(c, tight, at(0))!, 5),
    `got ${effectiveTakeProfitPoints(c, tight, at(0))}`,
  );
  check(
    'floor above the initial distance never widens the target (t=4h)',
    near(effectiveTakeProfitPoints(c, tight, at(240))!, 5),
    `got ${effectiveTakeProfitPoints(c, tight, at(240))}`,
  );

  // A decay rate past 1/hour would drive the raw distance negative.
  const runaway = cfg({ takeProfitDecayPerHour: 1, takeProfitFloorPoints: 0 });
  check(
    'distance never goes negative even past 1/hour decay',
    effectiveTakeProfitPoints(runaway, longState(), at(180))! >= 0,
    `got ${effectiveTakeProfitPoints(runaway, longState(), at(180))}`,
  );
}

// ── §4 Clock guards: bad time → no decay, never a shrunken target ────
{
  logger.info('§4 clock guards degrade to "no decay"');
  const c = cfg({ takeProfitDecayPerHour: 0.25, takeProfitFloorPoints: 6 });

  check(
    'now BEFORE entry (out-of-order) → no decay',
    near(effectiveTakeProfitPoints(c, longState(), at(-120))!, 30),
    `got ${effectiveTakeProfitPoints(c, longState(), at(-120))}`,
  );
  check(
    'unparseable now → no decay',
    near(effectiveTakeProfitPoints(c, longState(), 'not-a-timestamp')!, 30),
    `got ${effectiveTakeProfitPoints(c, longState(), 'not-a-timestamp')}`,
  );
  check(
    'missing entryTime → no decay',
    near(effectiveTakeProfitPoints(c, longState({ entryTime: null }), at(240))!, 30),
    `got ${effectiveTakeProfitPoints(c, longState({ entryTime: null }), at(240))}`,
  );
  check(
    'flat / no stored target → null',
    effectiveTakeProfitPoints(c, longState({ gexTpPoints: null }), at(60)) === null,
  );
}

// ── §5 The stalling trade: banks a partial move instead of round-tripping ──
{
  logger.info('§5 stalling trade exits at the decayed target');
  const c = cfg({ takeProfitDecayPerHour: 0.25, takeProfitFloorPoints: 6 });
  const s = longState();
  const spot = ENTRY_PRICE + 20; // ran +20 of a 30pt target, then stalled

  check('t=0: +20 under a 30.0 target → hold', !checkTakeProfit(s, spot, c, at(0)).hit);
  check('t=1h: +20 under a 22.5 target → still hold', !checkTakeProfit(s, spot, c, at(60)).hit);

  const hit = checkTakeProfit(s, spot, c, at(90)); // target now 18.75
  check('t=1.5h: target decayed to 18.75 ≤ +20 → TAKE PROFIT', hit.hit, `reason=${hit.reason}`);
  check(
    'the exit reason reports the decay',
    hit.reason.includes('decayed from 30.0'),
    `reason=${hit.reason}`,
  );

  // A SHORT is symmetric: profit is measured downward from entry.
  const short = longState({ position: 'short' });
  check(
    'short: −20 (in its favour) exits on the same decayed target',
    checkTakeProfit(short, ENTRY_PRICE - 20, c, at(90)).hit,
  );
}

// ── §6 Stop tightening (off by default, on when configured) ──────────
{
  logger.info('§6 stop-loss tightening');
  const s = longState();

  check(
    'default config leaves stop tightening OFF (10pt stop after 3h)',
    near(effectiveStopLossPoints(DEFAULT_CONFIG, s, at(180)), DEFAULT_CONFIG.risk.stopLossPoints),
    `got ${effectiveStopLossPoints(DEFAULT_CONFIG, s, at(180))}`,
  );

  const c = cfg({ stopLossDecayPerHour: 0.25, stopLossFloorPoints: 4 });
  check('stop after 2h → 5.0 (10 × 0.50)', near(effectiveStopLossPoints(c, s, at(120)), 5));
  check(
    'stop decayed past the floor is held at stopLossFloorPoints',
    near(effectiveStopLossPoints(c, s, at(300)), 4),
    `got ${effectiveStopLossPoints(c, s, at(300))}`,
  );

  // −6pts survives the 10pt stop at entry but not the 5pt stop two hours in.
  const under = ENTRY_PRICE - 6;
  check('t=0: −6pts inside the 10pt stop → hold', !checkStopLoss(s, under, c, at(0)).stopped);
  const stopped = checkStopLoss(s, under, c, at(120));
  check('t=2h: −6pts breaches the tightened 5pt stop → STOP', stopped.stopped, `reason=${stopped.reason}`);
  check(
    'the stop reason reports the decay',
    stopped.reason.includes('decayed from 10.0'),
    `reason=${stopped.reason}`,
  );
}

// ── §7 Gamma-center weighting: TP sharpens, the entry gate does not ──
{
  logger.info('§7 gamma-center weighting (TP uses gamma², the gate uses gamma mass)');

  // Two-sided gamma around spot 7000: a heavy cluster 50pts BELOW, a lighter
  // spread ABOVE. The plain mass center is dragged back toward spot by the
  // upper strikes; squaring the weights concentrates on the heavy cluster.
  const snap = (strikes: Array<[number, number]>, spot = 7000): Snapshot => ({
    capturedAt: ENTRY_ISO,
    expiry: '2026-07-28',
    spot,
    strikes: strikes.map(([strike, gamma]) => ({
      strike,
      gamma,
      charm: 0,
      vanna: 0,
      netPosition: 0,
    })),
  } as unknown as Snapshot);

  const twoSided = snap([
    [6950, 10e9],
    [6955, 8e9],
    [7010, 2e9],
    [7040, 1.5e9],
    [7060, 1e9],
  ]);
  const c = cfg();

  const tp = gexTakeProfitPoints(c, twoSided);
  const gate = gexEntryGatePoints(c, twoSided);
  check(
    'gamma² TP reaches further than the plain-mass gate on a two-sided book',
    tp > gate,
    `tp=${tp.toFixed(2)} gate=${gate.toFixed(2)}`,
  );
  check(
    'the gate is the plain |gamma| mass center',
    near(gate, Math.abs(gammaCenterStrike(twoSided.strikes, twoSided.spot, c.strikeWindow)! - twoSided.spot)),
    `gate=${gate}`,
  );
  check(
    'the TP is the gamma²-weighted center',
    near(tp, Math.abs(gammaCenterStrike(twoSided.strikes, twoSided.spot, c.strikeWindow, 2)! - twoSided.spot)),
    `tp=${tp}`,
  );

  // Scale invariance: the weights are normalized before exponentiation, so
  // multiplying every gamma by a constant cannot move either center.
  const scaled = snap([
    [6950, 10e9 * 1e6],
    [6955, 8e9 * 1e6],
    [7010, 2e9 * 1e6],
    [7040, 1.5e9 * 1e6],
    [7060, 1e9 * 1e6],
  ]);
  check(
    'gamma² center is scale-invariant (1e6× gamma → same target)',
    near(gexTakeProfitPoints(c, scaled), tp, 1e-6),
    `scaled=${gexTakeProfitPoints(c, scaled)} vs ${tp}`,
  );

  // A single dominant strike: both exponents must agree — there is nothing for
  // the sharpening to concentrate on.
  const single = snap([[6960, 5e9]]);
  check(
    'one-strike book: TP and gate agree',
    near(gexTakeProfitPoints(c, single), gexEntryGatePoints(c, single)),
    `tp=${gexTakeProfitPoints(c, single)} gate=${gexEntryGatePoints(c, single)}`,
  );

  // No gamma in the window → both fall back to stopLossPoints × riskRewardRatio.
  const empty = snap([[9000, 5e9]]);
  const fallback = c.risk.stopLossPoints * c.risk.riskRewardRatio;
  check(
    'empty window falls back to stopLossPoints × riskRewardRatio for both',
    near(gexTakeProfitPoints(c, empty), fallback) && near(gexEntryGatePoints(c, empty), fallback),
    `tp=${gexTakeProfitPoints(c, empty)} gate=${gexEntryGatePoints(c, empty)} expected=${fallback}`,
  );

  // Zero gamma everywhere is the null case, not a divide-by-zero.
  check(
    'all-zero gamma → null center (no NaN)',
    gammaCenterStrike(snap([[6990, 0], [7010, 0]]).strikes, 7000, c.strikeWindow, 2) === null,
  );
}

// ─────────────────────────────────────────────────────────────────────
logger.info('────────────────────────────────────────────');
if (failures.length === 0) {
  logger.info('risk-manager.test: ✅ ALL CHECKS PASSED');
  process.exit(0);
}
logger.error({ failures }, `risk-manager.test: ❌ ${failures.length} CHECK(S) FAILED`);
process.exit(1);
