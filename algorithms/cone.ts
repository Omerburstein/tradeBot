/**
 * Expected-move cone: the chart-accurate intraday cone, built from the three
 * points the scraper stores in `cone_snapshots` (apex + two end-of-day
 * endpoints), and the state transitions (inside/above/below) it produces.
 *
 * The cone is two straight lines fanning out from the apex `(09:30, spxOpen)`
 * to `(16:00, coneUpper)` and `(16:00, coneLower)` — so the band WIDENS through
 * the session. A "pass" = price crossing one of those lines.
 *
 * The cone acts as a support/resistance trigger gate (NOT a magnet):
 * - Price crossing ABOVE the cone + bullish gamma signal → long (continuation)
 * - Price crossing BELOW the cone + bearish gamma signal → short (continuation)
 * - Price returning INSIDE the cone → exit (breakout failed)
 *
 * 5-MIN CANDLE SAMPLING: cone state transitions and crossings are evaluated only
 * on ET clock-aligned 5-minute candle CLOSES (09:35, 09:40, … ET) using that
 * candle's close price. Between closes the tracker HOLDS its last confirmed
 * state (so intra-candle wiggles never flip the cone or fire a fresh crossing) —
 * i.e. every cone decision is "based on the previous 5-min tick". The very first
 * RTH snapshot of the day seeds the baseline state even if it is not a candle
 * close, so the first real close has something to transition from.
 */

import { etMinutesSinceMidnight } from './et-time.js';
import type { ConeEndpoints, ConeInfo, ConeState } from './types.js';

/** RTH open = 09:30 ET (the cone apex), in minutes since ET midnight. */
const RTH_OPEN_MINUTES = 9 * 60 + 30;
/** RTH close = 16:00 ET, in minutes since ET midnight. */
const RTH_CLOSE_MINUTES = 16 * 60;
/** RTH session length in minutes (09:30–16:00 ET). */
const RTH_MINUTES = 390;
/**
 * Candle size (minutes) the cone is sampled on: state/crossings advance only at
 * ET wall-clock instants divisible by this. 09:30 (the apex) is itself a
 * boundary, so the closes land at 09:35, 09:40, … A 10-min historical backfill
 * (:00/:10/…) is coarser than this, so every backfill Greek slot is a close;
 * per-minute price ticks in between are held.
 */
const CANDLE_MINUTES = 5;

/**
 * Tracks cone state across successive snapshots within a trading day.
 * Create a new instance at the start of each day, seeded with that day's
 * stored cone endpoints (or `null` when no cone was captured).
 */
export class ConeTracker {
  private readonly endpoints: ConeEndpoints | null;
  /** State at the last CONFIRMED 5-min candle close (see CANDLE_MINUTES). */
  private previousState: ConeState | null = null;
  /**
   * The ConeInfo emitted at the last confirmed candle close, replayed verbatim
   * on the intra-candle price ticks that follow it (with `crossed` suppressed
   * and `previousState` pinned to the held state, so no transition or fresh
   * crossing is ever reported off a held tick). `null` until the first close.
   */
  private lastConfirmed: ConeInfo | null = null;

  constructor(endpoints: ConeEndpoints | null) {
    this.endpoints = endpoints;
  }

  /**
   * Update cone state for a new snapshot.
   *
   * @param spot          Current SPX price
   * @param capturedAtUtc ISO UTC timestamp of the snapshot
   * @returns ConeInfo with the interpolated boundaries, state, and crossings
   */
  update(spot: number, capturedAtUtc: string): ConeInfo {
    // No stored cone for this day → cone unavailable: treat the price as always
    // inside an unbounded band so no cone-pass trigger fires.
    if (!this.endpoints) {
      const info: ConeInfo = {
        upper: Number.POSITIVE_INFINITY,
        lower: Number.NEGATIVE_INFINITY,
        state: 'inside',
        previousState: this.previousState,
        crossed: null,
        atCandleClose: false,
      };
      this.previousState = 'inside';
      return info;
    }

    // Pre-market (before the 09:30 apex): the cone is not yet defined — it fans
    // out FROM the open, so there is nothing to be inside/above/below yet. These
    // warm-up slots must not establish a cone state, or a pre-open price sitting
    // "above" the zero-width apex would swallow the first genuine RTH breakout
    // crossing. Report a neutral unbounded 'inside' and leave previousState
    // untouched so the first RTH slot sets the crossing baseline.
    const etMinute = etMinutesSinceMidnight(capturedAtUtc);
    if (etMinute < RTH_OPEN_MINUTES) {
      return {
        upper: Number.POSITIVE_INFINITY,
        lower: Number.NEGATIVE_INFINITY,
        state: 'inside',
        previousState: this.previousState,
        crossed: null,
        atCandleClose: false,
      };
    }

    // 5-min candle gate: outside an ET clock-aligned close, replay the last
    // confirmed candle so intra-candle ticks can't flip the state or fire a
    // fresh crossing. `previousState` is pinned to the held state so consumers
    // see no transition. The first RTH snapshot (no confirmed close yet) falls
    // through to seed the baseline even if it is not a close.
    const isCandleClose = etMinute % CANDLE_MINUTES === 0;
    if (!isCandleClose && this.lastConfirmed !== null) {
      const held = this.lastConfirmed;
      return {
        upper: held.upper,
        lower: held.lower,
        state: held.state,
        previousState: held.state,
        crossed: null,
        atCandleClose: false,
      };
    }

    const { spxOpen, coneUpper, coneLower } = this.endpoints;

    // Fraction of the RTH session elapsed since the apex. The two stored
    // endpoints define straight lines from the apex; at fraction f the boundary
    // sits f of the way from the apex price to its end-of-day endpoint.
    const f = this.sessionFraction(capturedAtUtc);
    const upper = spxOpen + (coneUpper - spxOpen) * f;
    const lower = spxOpen + (coneLower - spxOpen) * f;

    // Determine current cone state
    let state: ConeState;
    if (spot >= upper) {
      state = 'above';
    } else if (spot <= lower) {
      state = 'below';
    } else {
      state = 'inside';
    }

    // Detect crossings
    let crossed: ConeInfo['crossed'] = null;
    if (this.previousState !== null && state !== this.previousState) {
      if (state === 'above' && this.previousState === 'inside') {
        crossed = 'up';
      } else if (state === 'below' && this.previousState === 'inside') {
        crossed = 'down';
      } else if (state === 'inside' && (this.previousState === 'above' || this.previousState === 'below')) {
        crossed = 'returned';
      }
    }

    const info: ConeInfo = {
      upper,
      lower,
      state,
      previousState: this.previousState,
      crossed,
      // A true 5-min close (isCandleClose) is a real decision point; the seed
      // fall-through on the first RTH slot (not a close) is not — entries wait
      // for the first genuine close.
      atCandleClose: isCandleClose,
    };

    this.previousState = state;
    this.lastConfirmed = info;
    return info;
  }

  /** Reset for a new trading day. */
  reset(): void {
    this.previousState = null;
    this.lastConfirmed = null;
  }

  /**
   * Fraction (0–1) of the RTH session elapsed at `capturedAtUtc`.
   * 0 at the 09:30 apex, 1 at the 16:00 close.
   */
  private sessionFraction(capturedAtUtc: string): number {
    const elapsed = RTH_MINUTES - this.minutesUntilClose(capturedAtUtc);
    return Math.min(1, Math.max(0, elapsed / RTH_MINUTES));
  }

  /** Minutes until RTH close (16:00 ET) from a UTC timestamp; 0 once past it. */
  private minutesUntilClose(capturedAtUtc: string): number {
    const remaining = RTH_CLOSE_MINUTES - etMinutesSinceMidnight(capturedAtUtc);
    return Math.max(remaining, 0);
  }
}
