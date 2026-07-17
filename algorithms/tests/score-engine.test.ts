/**
 * Unit test — score engine dGamma momentum (NO network, NO DB, NO browser).
 *
 * Pins the invariant that dGamma acts on the *magnitude* of gamma (|gamma|),
 * matching the absolute-magnitude GEX level factor. The key cases:
 *
 *   - a gamma wall building (|gamma| growing) is positive momentum;
 *   - a wall bleeding off (|gamma| shrinking) is negative — INCLUDING a
 *     negative-gamma strike shrinking toward zero (the regression this guards);
 *   - identical |Δgamma| gives identical dGamma regardless of gamma's sign;
 *   - the strike's side of spot points the momentum (above = +, below = −);
 *   - unchanged Greeks (or no previous snapshot) → zero dGamma.
 *
 * Only `computeScore` from score-engine.ts is exercised — it is pure, so no
 * env/DB stub is needed. Assertions read `dGammaRaw` (the pre-z-score sum) so
 * they test the factor arithmetic directly, independent of z normalization.
 *
 * Run:  npm run test:unit  (chained after the scraper schedule test)
 * Exits 0 if every check passes, 1 otherwise. Matches schedule.test.ts.
 */

import pino from 'pino';
import { computeScore } from '../score-engine.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { Snapshot, StrikeData } from '../types.js';

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

// ── Snapshot builder ─────────────────────────────────────────────────
// Minimal snapshot: only the fields computeScore reads (spot + strikes).
// charm/vanna are irrelevant to the composite (excluded by design) and
// positions default to 0 so they never perturb the gamma-only assertions.
const SPOT = 6000;

function strike(k: number, gamma: number): StrikeData {
  return { strike: k, gamma, charm: 0, vanna: 0, positions: 0 };
}

function snap(strikes: StrikeData[], spot = SPOT): Snapshot {
  return {
    capturedAt: '2026-05-21T18:50:00Z',
    expiry: '2026-05-21',
    timeframe: '14:40 - 14:50',
    spot,
    strikes,
    cone: null,
  };
}

/** dGammaRaw for one current/previous strike pair (no z-history). */
function dGammaRaw(prevGamma: number, currGamma: number, k = 6010): number {
  const previous = snap([strike(k, prevGamma)]);
  const current = snap([strike(k, currGamma)]);
  return computeScore(current, previous, [], DEFAULT_CONFIG).dGammaRaw;
}

// ── 1. The regression: a NEGATIVE gamma position shrinking toward zero ──
// |gamma| goes 100 → 50 (pressure fading) at a strike ABOVE spot. Under the
// old raw-delta code this was −50 − (−100) = +50 (read as building — wrong).
// Now it differences |gamma|, so the momentum is negative.
check(
  'negative gamma shrinking toward zero (−100→−50) above spot → dGamma < 0',
  dGammaRaw(-100, -50) < 0,
  `got ${dGammaRaw(-100, -50)}`,
);

// ── 2. Acts on |gamma|: same |Δ| ⇒ same dGamma regardless of gamma sign ──
// +100→+50 and −100→−50 both shrink |gamma| by 50, so they must be identical.
check(
  'sign-independent: dGamma(+100→+50) === dGamma(−100→−50)',
  dGammaRaw(100, 50) === dGammaRaw(-100, -50),
  `got ${dGammaRaw(100, 50)} vs ${dGammaRaw(-100, -50)}`,
);
// And a growing wall matches whether it grows positive or negative.
check(
  'sign-independent: dGamma(+50→+100) === dGamma(−50→−100)',
  dGammaRaw(50, 100) === dGammaRaw(-50, -100),
  `got ${dGammaRaw(50, 100)} vs ${dGammaRaw(-50, -100)}`,
);

// ── 3. A wall building (|gamma| growing) above spot → positive momentum ──
check(
  'wall building above spot (+50→+100) → dGamma > 0',
  dGammaRaw(50, 100) > 0,
  `got ${dGammaRaw(50, 100)}`,
);
check(
  'negative wall building above spot (−50→−100) → dGamma > 0',
  dGammaRaw(-50, -100) > 0,
  `got ${dGammaRaw(-50, -100)}`,
);

// ── 4. Direction comes from the strike's side of spot ──
// Same |gamma| growth below spot flips the sign (sign = −1).
check(
  'wall building below spot (5990, +50→+100) → dGamma < 0',
  dGammaRaw(50, 100, 5990) < 0,
  `got ${dGammaRaw(50, 100, 5990)}`,
);
// Mirror strikes with the same |Δ| cancel to ~0 across the whole window.
{
  const previous = snap([strike(6010, 50), strike(5990, 50)]);
  const current = snap([strike(6010, 100), strike(5990, 100)]);
  const raw = computeScore(current, previous, [], DEFAULT_CONFIG).dGammaRaw;
  check('symmetric build above+below spot cancels → dGamma ≈ 0', Math.abs(raw) < 1e-9, `got ${raw}`);
}

// ── 5. No change / no previous → zero dGamma ──
check('unchanged gamma → dGamma === 0', dGammaRaw(80, 80) === 0, `got ${dGammaRaw(80, 80)}`);
check(
  'no previous snapshot → dGamma === 0',
  computeScore(snap([strike(6010, 80)]), null, [], DEFAULT_CONFIG).dGammaRaw === 0,
);

// ── 6. Normalization is magnitude-ratio, NOT a z-score ──
// History supplies only the SCALE; it never re-centers the reading. These pin
// the properties that distinguish normalizeToScale from (x − mean) / std.

/** gexZ for `gamma` at a strike above spot, against a history of `hist` gexRaws. */
function gexZAgainst(gamma: number, hist: number[]): number {
  const history = hist.map((gexRaw) => ({
    gexRaw,
    gexZ: 0,
    dGammaRaw: 0,
    dGammaZ: 0,
    positionsRaw: 0,
    positionsZ: 0,
    dPositionsRaw: 0,
    dPositionsZ: 0,
    composite: 0,
  }));
  return computeScore(snap([strike(6010, gamma)]), null, history, DEFAULT_CONFIG).gexZ;
}

// The regression this change exists to fix: on a persistently NEGATIVE-gamma
// day, a merely less-negative reading must NOT read positive. Under the old
// (x − mean) / std it scored ≈ +2.1 (bullish while gamma was still bearish).
{
  // Strike BELOW spot with positive gamma → negative gexRaw, like 2026-05-19.
  const persistentlyNegative = [-9000, -10000, -11000, -10500, -9500];
  const z = computeScore(
    snap([strike(5990, 40)]), // small |gamma| → small negative gexRaw
    null,
    persistentlyNegative.map((gexRaw) => ({
      gexRaw,
      gexZ: 0,
      dGammaRaw: 0,
      dGammaZ: 0,
      positionsRaw: 0,
      positionsZ: 0,
      dPositionsRaw: 0,
      dPositionsZ: 0,
      composite: 0,
    })),
    DEFAULT_CONFIG,
  ).gexZ;
  check(
    'negative gexRaw against a negative history → gexZ stays NEGATIVE (no mean-centering)',
    z < 0,
    `got ${z}`,
  );
}

// Sign follows the raw factor, never the history's centre.
check(
  'positive gexRaw against a positive history → gexZ > 0',
  gexZAgainst(100, [5000, 5000, 5000, 5000]) > 0,
  `got ${gexZAgainst(100, [5000, 5000, 5000, 5000])}`,
);

// Scale-invariance: the SAME multiple of the day's typical magnitude gives the
// SAME normalized value, whether the day runs small or large. This is the
// property the change was requested for — the multiplication drives the score,
// not the absolute gamma.
{
  // gexRaw is monotonic in gamma, so build each history from its own baseline.
  const small = computeScore(snap([strike(6010, 100)]), null, [], DEFAULT_CONFIG).gexRaw;
  const large = computeScore(snap([strike(6010, 1000)]), null, [], DEFAULT_CONFIG).gexRaw;
  // A 10× spike relative to a quiet day vs. relative to a busy day.
  const zSmallDay = gexZAgainst(100, [small / 10, small / 10, small / 10, small / 10]);
  const zLargeDay = gexZAgainst(1000, [large / 10, large / 10, large / 10, large / 10]);
  check(
    'scale-invariant: a 10× spike scores the same on a quiet day as on a busy day',
    Math.abs(zSmallDay - zLargeDay) < 1e-9,
    `got ${zSmallDay} vs ${zLargeDay}`,
  );
  // log2(1 + 10) ≈ 3.459 — the 10× case from the design discussion.
  check(
    '10× typical magnitude → gexZ ≈ log2(11) ≈ 3.46',
    Math.abs(zSmallDay - Math.log2(11)) < 0.02,
    `got ${zSmallDay}, want ≈ ${Math.log2(11)}`,
  );
}

// A 10× spike must stay clearly ABOVE a 4× spike (the reason for log
// compression rather than a raw ratio + clamp, which flattened both to 3.5).
{
  const base = computeScore(snap([strike(6010, 100)]), null, [], DEFAULT_CONFIG).gexRaw;
  const z4 = gexZAgainst(100, Array(4).fill(base / 4));
  const z10 = gexZAgainst(100, Array(4).fill(base / 10));
  check('10× spike scores strictly above a 4× spike (not both clamped)', z10 > z4 + 0.5, `4×=${z4}, 10×=${z10}`);
  check('both a 4× and 10× spike stay within ±zClamp', z4 < DEFAULT_CONFIG.zClamp && z10 < DEFAULT_CONFIG.zClamp, `4×=${z4}, 10×=${z10}`);
}

// A reading at exactly the day's typical magnitude reads 1.0 — keeps
// entryThreshold (1.5) meaning "1.5× typical" and in a familiar range.
{
  const base = computeScore(snap([strike(6010, 100)]), null, [], DEFAULT_CONFIG).gexRaw;
  const z = gexZAgainst(100, Array(4).fill(base));
  check('a reading at exactly typical magnitude → gexZ === 1.0', Math.abs(z - 1.0) < 1e-9, `got ${z}`);
}

// Degenerate history (all ~zero) must report "nothing to see", not a ±1 sign.
check(
  'all-zero history → gexZ === 0 (noise never becomes a ±1 signal)',
  gexZAgainst(100, [0, 0, 0, 0]) === 0,
  `got ${gexZAgainst(100, [0, 0, 0, 0])}`,
);

// Cold start (<3 samples) still falls back to a clamped sign estimate.
check(
  'cold start (2 samples) → gexZ === +1 sign estimate',
  gexZAgainst(100, [5000, 5000]) === 1,
  `got ${gexZAgainst(100, [5000, 5000])}`,
);

// ─────────────────────────────────────────────────────────────────────
logger.info('────────────────────────────────────────────');
if (failures.length === 0) {
  logger.info('score-engine.test: ✅ ALL CHECKS PASSED');
  process.exit(0);
}
logger.error({ failures }, `score-engine.test: ❌ ${failures.length} CHECK(S) FAILED`);
process.exit(1);
