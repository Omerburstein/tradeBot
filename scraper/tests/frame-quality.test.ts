/**
 * Unit tests for the Greek-frame quality check (scraper/core/frame-quality.ts).
 *
 * Dependency-free (node:test + node:assert) so this runs in the pre-push gate
 * alongside schedule.test.ts — no DB, no network, no browser.
 *
 * The regression fixtures are REAL rows lifted from the 2026-05-26 incident:
 * the same minute (13:40:00Z / 09:40 ET, expiry 2026-05-26, spot 7515.3), as we
 * stored it (Greeks computed against a stale ~7480 underlying) and as UW serves
 * it today (correct). The `net` values are identical across both — that is the
 * whole point of the incident: positions matched byte-for-byte, only the Greeks
 * were wrong, so any check that keys on positions or on frame identity is blind
 * to it and only the gamma/net kernel shape catches it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedAtmStrike,
  checkFrameAgainstSpot,
  MIN_NET_FOR_RATIO,
  MAX_ATM_DEVIATION,
  type FrameStrike,
} from '../core/frame-quality.js';

/** Spot at 2026-05-26 09:40 ET, from spot_prices (and cone apex 7514.96). */
const SPOT_0526 = 7515.3;

/** As STORED — gamma computed against the prior session's close (~7480). */
const CORRUPT_0526: FrameStrike[] = [
  { strike: 7370, gamma: -1293, net: -5250 },
  { strike: 7395, gamma: -694, net: -2164 },
  { strike: 7400, gamma: 694, net: 2055 },
  { strike: 7410, gamma: -668, net: -1801 },
  { strike: 7435, gamma: 606, net: 1320 },
  { strike: 7450, gamma: 796, net: 1573 },
  { strike: 7460, gamma: 639, net: 1208 },
  { strike: 7465, gamma: -1427, net: -2657 },
  { strike: 7470, gamma: -1420, net: -2614 },
  { strike: 7475, gamma: 1900, net: 3478 },
  { strike: 7480, gamma: -865, net: -1582 },
  { strike: 7485, gamma: 1309, net: 2411 },
  { strike: 7500, gamma: 280, net: 545 },
  { strike: 7515, gamma: -441, net: -965 },
  { strike: 7520, gamma: -578, net: -1331 },
  { strike: 7530, gamma: -520, net: -1358 },
  { strike: 7550, gamma: -768, net: -2766 },
  { strike: 7565, gamma: 763, net: 3633 },
  { strike: 7625, gamma: -673, net: -10076 },
  { strike: 7630, gamma: -1068, net: -17414 },
];

/** The SAME minute as UW serves it today — identical `net`, correct gamma. */
const HEALTHY_0526: FrameStrike[] = [
  { strike: 7370, gamma: -269, net: -5250 },
  { strike: 7395, gamma: -178, net: -2164 },
  { strike: 7400, gamma: 188, net: 2055 },
  { strike: 7410, gamma: -205, net: -1801 },
  { strike: 7435, gamma: 282, net: 1320 },
  { strike: 7450, gamma: 501, net: 1573 },
  { strike: 7460, gamma: 503, net: 1208 },
  { strike: 7465, gamma: -1260, net: -2657 },
  { strike: 7470, gamma: -1406, net: -2614 },
  { strike: 7475, gamma: 2110, net: 3478 },
  { strike: 7480, gamma: -1077, net: -1582 },
  { strike: 7485, gamma: 1821, net: 2411 },
  { strike: 7500, gamma: 526, net: 545 },
  { strike: 7515, gamma: -1034, net: -965 },
  { strike: 7520, gamma: -1427, net: -1331 },
  { strike: 7530, gamma: -1361, net: -1358 },
  { strike: 7550, gamma: -1897, net: -2766 },
  { strike: 7565, gamma: 1601, net: 3633 },
  { strike: 7625, gamma: -866, net: -10076 },
  { strike: 7630, gamma: -1329, net: -17414 },
];

test('healthy 2026-05-26 frame: implied ATM sits at spot', () => {
  const atm = impliedAtmStrike(HEALTHY_0526);
  assert.notEqual(atm, null);
  assert.ok(
    Math.abs(atm! - SPOT_0526) <= MAX_ATM_DEVIATION,
    `implied ATM ${atm} should be within ${MAX_ATM_DEVIATION} of spot ${SPOT_0526}`,
  );
  assert.equal(checkFrameAgainstSpot(HEALTHY_0526, SPOT_0526).ok, true);
});

test('REGRESSION 2026-05-26: corrupt frame (stale underlying) is rejected', () => {
  const check = checkFrameAgainstSpot(CORRUPT_0526, SPOT_0526);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'atm-mismatch');
  // The stale frame's kernel peaks ~7480 (the prior close), ~35pt below spot.
  assert.ok(
    check.deviation! < -MAX_ATM_DEVIATION,
    `expected implied ATM well below spot, got deviation ${check.deviation}`,
  );
});

test('the two frames differ ONLY in gamma — positions are identical', () => {
  // Guards the fixtures themselves: if these drift apart the regression test
  // above stops proving what it claims to prove.
  assert.deepEqual(
    CORRUPT_0526.map((s) => [s.strike, s.net]),
    HEALTHY_0526.map((s) => [s.strike, s.net]),
  );
});

test('a max-|gamma|-near-spot check would NOT catch this (why we use gamma/net)', () => {
  // On the HEALTHY frame the largest |gamma| strike is 7475 — legitimately 40
  // points from spot, because open interest piles up away from the money. So
  // the naive check both misses the corruption and fires on good data.
  const maxAbsStrike = HEALTHY_0526.reduce((a, b) => (Math.abs(b.gamma) > Math.abs(a.gamma) ? b : a)).strike;
  assert.equal(maxAbsStrike, 7475);
  assert.ok(Math.abs(maxAbsStrike - SPOT_0526) > MAX_ATM_DEVIATION);
});

test('strikes with tiny net are ignored (ratio denominator blows up)', () => {
  // A 2-contract strike far from spot with any gamma at all produces a huge
  // |gamma|/|net| and would otherwise capture the argmax.
  const withNoise: FrameStrike[] = [
    ...HEALTHY_0526,
    { strike: 7900, gamma: 50, net: 2 }, // ratio 25 — dwarfs every real strike
  ];
  assert.equal(impliedAtmStrike(withNoise), impliedAtmStrike(HEALTHY_0526));
});

test('net exactly at the floor counts; below it does not', () => {
  const base: FrameStrike[] = Array.from({ length: 8 }, (_, i) => ({
    strike: 7500 + i * 5,
    gamma: 100,
    net: MIN_NET_FOR_RATIO,
  }));
  assert.notEqual(impliedAtmStrike(base), null);
  const below = base.map((s) => ({ ...s, net: MIN_NET_FOR_RATIO - 1 }));
  assert.equal(impliedAtmStrike(below), null);
});

test('too few usable strikes => insufficient-data, and never a false alarm', () => {
  const thin: FrameStrike[] = [
    { strike: 7500, gamma: 100, net: 1000 },
    { strike: 7505, gamma: 120, net: 1000 },
  ];
  const check = checkFrameAgainstSpot(thin, SPOT_0526);
  assert.equal(check.impliedAtm, null);
  assert.equal(check.reason, 'insufficient-data');
  // Must not block a capture just because the frame is thin.
  assert.equal(check.ok, true);
});

test('non-finite gamma/net values are skipped rather than poisoning the argmax', () => {
  const dirty: FrameStrike[] = [
    ...HEALTHY_0526,
    { strike: 7800, gamma: NaN, net: 5000 },
    { strike: 7810, gamma: 500, net: NaN },
    { strike: 7820, gamma: Infinity, net: 5000 },
  ];
  assert.equal(impliedAtmStrike(dirty), impliedAtmStrike(HEALTHY_0526));
});

test('a synthetic frame tracks whatever spot it was built around', () => {
  // Per-contract gamma kernel centred on `centre`; exposure = kernel x net.
  const build = (centre: number): FrameStrike[] =>
    Array.from({ length: 41 }, (_, i) => {
      const strike = centre - 100 + i * 5;
      const kernel = Math.exp(-(((strike - centre) / 40) ** 2));
      const net = 1000 + ((i * 37) % 900); // arbitrary, well above the floor
      return { strike, gamma: kernel * net, net };
    });
  for (const centre of [7300, 7515, 7800]) {
    const atm = impliedAtmStrike(build(centre));
    assert.ok(Math.abs(atm! - centre) <= 10, `centre ${centre} -> implied ${atm}`);
  }
});
