/**
 * Unit test — score engine dGamma momentum (NO network, NO DB, NO browser).
 *
 * Pins the invariant that dGamma is a magnitude-directed change in gamma,
 * matching the absolute-magnitude GEX level factor. The key cases:
 *
 *   - a gamma wall building (|gamma| growing) is positive momentum;
 *   - a wall bleeding off (|gamma| shrinking) is negative — INCLUDING a
 *     negative-gamma strike shrinking toward zero (the regression this guards);
 *   - identical |Δgamma| gives identical dGamma regardless of gamma's sign;
 *   - a sign FLIP is distinguished from a same-sign move of the same endpoint
 *     magnitudes, because the delta's size is the trip through zero;
 *   - the strike's side of spot points the momentum (above = +, below = −);
 *   - unchanged Greeks (or no previous snapshot) → zero dGamma.
 *
 * §5c additionally pins the DECAYED-BASELINE momentum (momentumHalfLifeMin): a
 * large last-step move enters at full weight, a constant level never ramps, a
 * sustained build accumulates, a one-slot blip reverts, and the memory is
 * wall-clock (cadence-invariant). Those replay a sequence through a MomentumState.
 *
 * Only `computeScore` from score-engine.ts is exercised — it is pure, so no
 * env/DB stub is needed. Assertions read `dGammaRaw` (the pre-z-score sum) so
 * they test the factor arithmetic directly, independent of z normalization.
 *
 * Run:  npm run test:unit  (chained after the scraper schedule test)
 * Exits 0 if every check passes, 1 otherwise. Matches schedule.test.ts.
 */

import pino from 'pino';
import { computeScore, createMomentumState } from '../score-engine.js';
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

// ── 5b. A sign FLIP is distinguished from a same-sign move ──
// Differencing |gamma| alone saw only the endpoint magnitudes, so +100 → −50
// scored identically to +100 → +50 (both −50) even though the first destroyed a
// wall and rebuilt an opposite one. The delta's SIZE is now |Δgamma| (the full
// trip through zero), so the flip reads as a strictly larger move.
check(
  'flip: dGamma(+100→−50) !== dGamma(+100→+50)',
  dGammaRaw(100, -50) !== dGammaRaw(100, 50),
  `got ${dGammaRaw(100, -50)} vs ${dGammaRaw(100, 50)}`,
);
check(
  'flip: |dGamma(+100→−50)| > |dGamma(+100→+50)| (travelled through zero)',
  Math.abs(dGammaRaw(100, -50)) > Math.abs(dGammaRaw(100, 50)),
  `got ${dGammaRaw(100, -50)} vs ${dGammaRaw(100, 50)}`,
);
// Both are still a FADE of that strike's pressure (100 → 50 in magnitude).
check(
  'flip: dGamma(+100→−50) < 0 (pressure still shrank)',
  dGammaRaw(100, -50) < 0,
  `got ${dGammaRaw(100, -50)}`,
);
// A flip into a BIGGER opposite wall is pressure growing → positive momentum.
check(
  'flip: dGamma(+100→−150) > 0 (bigger opposite wall)',
  dGammaRaw(100, -150) > 0,
  `got ${dGammaRaw(100, -150)}`,
);
// The sign-independence invariant survives the flip-aware size.
check(
  'flip sign-independent: dGamma(+100→−50) === dGamma(−100→+50)',
  dGammaRaw(100, -50) === dGammaRaw(-100, 50),
  `got ${dGammaRaw(100, -50)} vs ${dGammaRaw(-100, 50)}`,
);
// The most violent flip of all: +100 → −100 travels 200 through zero. Its
// endpoint magnitudes match, so a sign()-based direction zeroed the whole term
// and swallowed it. Only a strict SHRINK is negative momentum now.
check(
  'flip: dGamma(+100→−100) > 0 (travelled 200 through zero, not 0)',
  dGammaRaw(100, -100) > 0,
  `got ${dGammaRaw(100, -100)}`,
);
// Distance travelled is what counts: 200 through zero === 200 the direct way.
check(
  'flip: dGamma(+100→−100) === dGamma(+100→+300) (both travel 200)',
  dGammaRaw(100, -100) === dGammaRaw(100, 300),
  `got ${dGammaRaw(100, -100)} vs ${dGammaRaw(100, 300)}`,
);
// …and the unchanged case stays 0: its SIZE is 0, so the +1 direction is inert.
check(
  'unchanged gamma still 0 despite the +1 direction default',
  dGammaRaw(-80, -80) === 0,
  `got ${dGammaRaw(-80, -80)}`,
);

// ── 5c. Decayed-baseline momentum (momentumHalfLifeMin) ──
// Each rate of change is `signedDelta(current level, baseline)`, where the
// baseline is a per-strike EWMA over recent levels in WALL-CLOCK time. The
// current level enters at full weight; the baseline carries ~2–3 half-lives of
// history and cannot ramp. State lives in a MomentumState threaded across the
// sequence — so these tests replay a sequence of snapshots, not single pairs.

const SEQ_START_MS = Date.parse('2026-05-21T13:30:00Z');

/** Replay a gamma sequence through one MomentumState; return each dGammaRaw. */
function runGammaSeq(gammas: number[], dtMin: number, halfLife: number, k = 6010): number[] {
  const m = createMomentumState();
  const cfg = { ...DEFAULT_CONFIG, momentumHalfLifeMin: halfLife };
  const out: number[] = [];
  let prev: Snapshot | null = null;
  for (let i = 0; i < gammas.length; i++) {
    const at = new Date(SEQ_START_MS + i * dtMin * 60_000).toISOString();
    const cur: Snapshot = { ...snap([strike(k, gammas[i])]), capturedAt: at };
    out.push(computeScore(cur, prev, [], cfg, m).dGammaRaw);
    prev = cur;
  }
  return out;
}

// FULL-WEIGHT PRESENT: after a flat run (baseline pinned exactly at 100), a jump
// in the LAST step reads as the full single-step delta — the last-minute move is
// never damped by the history. This is the property the redesign was asked for.
{
  const seq = runGammaSeq([100, 100, 100, 100, 200], 1, 10);
  check(
    'baseline: a large last-step move registers at full single-step weight',
    Math.abs(seq[4] - dGammaRaw(100, 200)) < 1e-9,
    `got ${seq[4]} vs single-step ${dGammaRaw(100, 200)}`,
  );
}

// STATELESS === single-step: with no MomentumState the baseline collapses to
// `previous`, so behaviour is identical to the old per-pair delta (all of the
// checks in §1–5b run on this path and must keep passing).
check(
  'baseline: stateless call === single-step delta',
  computeScore(snap([strike(6010, 100)]), snap([strike(6010, 50)]), [], DEFAULT_CONFIG).dGammaRaw ===
    dGammaRaw(50, 100),
  'stateless path drifted from signedDelta(curr, prev)',
);

// NO SPURIOUS MOMENTUM / NO RAMP: a constant gamma leaves the baseline equal to
// the level forever, so every delta is exactly 0 — no drift over a session.
{
  const seq = runGammaSeq(Array(50).fill(100), 1, 10);
  check(
    'baseline: constant gamma → every dGamma is 0 (no ramp)',
    seq.every((x) => x === 0),
    `nonzero entries: ${seq.filter((x) => x !== 0).length}`,
  );
}

// SUSTAINED BUILD ACCUMULATES: a steady climb pulls further ahead of the lagging
// baseline each step, so momentum grows rather than saturating at one step's size.
{
  const seq = runGammaSeq([100, 150, 200, 250, 300], 1, 2);
  check(
    'baseline: a sustained build gives increasing momentum',
    seq[2] > seq[1] && seq[3] > seq[2] && seq[1] > 0,
    `got ${seq.slice(1, 4).map((x) => x.toFixed(1)).join(', ')}`,
  );
}

// ONE-SLOT BLIP REVERTS: a lone spike reads positive, then the very next
// (unchanged) step reads NEGATIVE as the baseline, having absorbed the spike,
// now sits above the level — the blip does not persist as signal.
{
  const seq = runGammaSeq([100, 100, 200, 100, 100], 1, 2);
  check(
    'baseline: a one-slot blip reverts (up then down)',
    seq[2] > 0 && seq[3] < 0,
    `got spike ${seq[2].toFixed(1)}, revert ${seq[3].toFixed(1)}`,
  );
}

// LINEAR RAMP CONVERGES: under a constant slope the delta reaches a bounded
// steady state (level − baseline → const) rather than ramping — the invariant
// that keeps the factor off the day's opening reads.
{
  const seq = runGammaSeq(Array.from({ length: 200 }, (_, i) => 100 + 50 * i), 1, 10);
  // Successive deltas shrink toward a fixed point: the late-step change is a tiny
  // fraction of one input step (50), and far below any runaway — no ramp.
  check(
    'baseline: a linear ramp converges to a bounded steady state',
    Math.abs(seq[199] - seq[150]) < 0.1 && seq[199] < 5000 && Number.isFinite(seq[199]),
    `steps 100/150/199: ${seq[100].toFixed(3)}, ${seq[150].toFixed(3)}, ${seq[199].toFixed(3)}`,
  );
}

// CADENCE-INVARIANT: the half-life is wall-clock, so a coarser cadence lets the
// baseline absorb more per step. Same [100,200,200] scenario: at Δt=10 with
// H=10 the baseline jumps to the midpoint (ρ=0.5) and the third-step delta is
// smaller than at Δt=1 (ρ=0.5^0.1≈0.93, baseline barely moved).
{
  const fine = runGammaSeq([100, 200, 200], 1, 10);
  const coarse = runGammaSeq([100, 200, 200], 10, 10);
  check(
    'baseline: coarser cadence forgets faster per step (wall-clock memory)',
    coarse[2] > 0 && fine[2] > 0 && coarse[2] < fine[2],
    `fine ${fine[2].toFixed(1)} vs coarse ${coarse[2].toFixed(1)}`,
  );
  // ρ=0.5 at Δt=half-life: baseline = midpoint 150 → signedDelta(200,150)=50·dWeight.
  check(
    'baseline: ρ=0.5 at Δt = half-life (exact midpoint baseline)',
    Math.abs(coarse[2] - dGammaRaw(150, 200)) < 1e-9,
    `got ${coarse[2]} vs ${dGammaRaw(150, 200)}`,
  );
}

// ── 6. Normalization is magnitude-ratio, NOT a z-score ──
// History supplies only the SCALE; it never re-centers the reading. These pin
// the properties that distinguish normalizeToScale from (x − mean) / std.

// The normalization SCALE now reads the GROSS field, so history entries set
// `gexGross` to the intended scale magnitude. For the single above-spot strike
// these tests use, a snapshot's gross == |net|, so gexGross = |gexRaw|.
/** gexZ for `gamma` at a strike above spot, against a history of `hist` scale mags. */
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
    gexGross: Math.abs(gexRaw),
    dGammaGross: 0,
    positionsGross: 0,
    dPositionsGross: 0,
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
      gexGross: Math.abs(gexRaw), // scale magnitude (gross), sign-blind
      dGammaGross: 0,
      positionsGross: 0,
      dPositionsGross: 0,
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
  // A 4× spike (kept under zClamp so the LOG SHAPE — not the clamp — is what's
  // tested) relative to a quiet day vs. relative to a busy day.
  const zSmallDay = gexZAgainst(100, Array(4).fill(small / 4));
  const zLargeDay = gexZAgainst(1000, Array(4).fill(large / 4));
  check(
    'scale-invariant: a 4× spike scores the same on a quiet day as on a busy day',
    Math.abs(zSmallDay - zLargeDay) < 1e-9,
    `got ${zSmallDay} vs ${zLargeDay}`,
  );
  // out = sign(r)·log2(1 + |r|^pGamma): the shaping exponent is applied to the
  // whole factor's ratio at normalize (R5). r = 4 → log2(1 + 4^1.2) ≈ 2.65.
  const want = Math.log2(1 + Math.pow(4, DEFAULT_CONFIG.pGamma));
  check(
    '4× typical magnitude → gexZ === log2(1 + 4^pGamma)',
    Math.abs(zSmallDay - want) < 1e-9,
    `got ${zSmallDay}, want ${want}`,
  );
}

// The exponent-in-log stays distinguishable across spike sizes without both
// flattening to the same value (the reason for log compression). A 6× spike
// scores clearly above a 3× spike, and both stay under the ±zClamp backstop.
{
  const base = computeScore(snap([strike(6010, 100)]), null, [], DEFAULT_CONFIG).gexRaw;
  const z3 = gexZAgainst(100, Array(4).fill(base / 3));
  const z6 = gexZAgainst(100, Array(4).fill(base / 6));
  check('6× spike scores strictly above a 3× spike (log stays distinguishable)', z6 > z3 + 0.5, `3×=${z3}, 6×=${z6}`);
  check('both a 3× and 6× spike stay within ±zClamp', z3 < DEFAULT_CONFIG.zClamp && z6 < DEFAULT_CONFIG.zClamp, `3×=${z3}, 6×=${z6}`);
  // A genuinely huge spike still binds the clamp — the backstop for outliers.
  const z20 = gexZAgainst(100, Array(4).fill(base / 20));
  check('a 20× spike binds the ±zClamp backstop', Math.abs(z20 - DEFAULT_CONFIG.zClamp) < 1e-9, `20×=${z20}`);
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

// ── 7. Gross-magnitude scale: no above/below cancellation in the denominator ──
// The scale reads the GROSS magnitude (sum of |per-strike contribution|), the
// numerator the NET. So a BALANCED snapshot — equal gamma above and below spot —
// has net ≈ 0 but a large gross, and must read ~0 (no direction), NOT a flippy
// ±1 from dividing a near-zero net by a near-zero self-scale. A one-sided
// snapshot (net == gross) still reads directionally.
{
  const grossHist = Array(5).fill(0).map(() => ({
    gexRaw: 0, gexZ: 0, dGammaRaw: 0, dGammaZ: 0,
    positionsRaw: 0, positionsZ: 0, dPositionsRaw: 0, dPositionsZ: 0,
    composite: 0,
    gexGross: 1000, dGammaGross: 0, positionsGross: 0, dPositionsGross: 0,
  }));
  // +100 gamma equidistant above (6010) and below (5990) spot → net cancels.
  const balanced = computeScore(snap([strike(6010, 100), strike(5990, 100)]), null, grossHist, DEFAULT_CONFIG);
  check(
    'gross-scale: balanced above/below → gexZ ≈ 0 (net cancels, no direction)',
    Math.abs(balanced.gexZ) < 1e-9,
    `got ${balanced.gexZ} (gexRaw=${balanced.gexRaw})`,
  );
  check(
    'gross-scale: the SAME balanced snapshot still has a large gross (no cancellation in scale)',
    balanced.gexGross > 0,
    `got ${balanced.gexGross}`,
  );
  // One-sided → net == gross → a clear directional reading.
  const oneSided = computeScore(snap([strike(6010, 100)]), null, grossHist, DEFAULT_CONFIG);
  check('gross-scale: one-sided snapshot → gexZ > 0 (clear direction)', oneSided.gexZ > 0, `got ${oneSided.gexZ}`);
  check(
    'gross-scale: one-sided net === gross',
    Math.abs(oneSided.gexRaw - oneSided.gexGross) < 1e-9,
    `net=${oneSided.gexRaw} gross=${oneSided.gexGross}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
logger.info('────────────────────────────────────────────');
if (failures.length === 0) {
  logger.info('score-engine.test: ✅ ALL CHECKS PASSED');
  process.exit(0);
}
logger.error({ failures }, `score-engine.test: ❌ ${failures.length} CHECK(S) FAILED`);
process.exit(1);
