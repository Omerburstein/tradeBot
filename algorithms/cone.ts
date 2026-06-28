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
 */

import type { ConeEndpoints, ConeInfo, ConeState } from './types.js';

/** RTH session length in minutes (09:30–16:00 ET = 08:30–15:00 CT). */
const RTH_MINUTES = 390;

/**
 * Tracks cone state across successive snapshots within a trading day.
 * Create a new instance at the start of each day, seeded with that day's
 * stored cone endpoints (or `null` when no cone was captured).
 */
export class ConeTracker {
  private readonly endpoints: ConeEndpoints | null;
  private previousState: ConeState | null = null;

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
      };
      this.previousState = 'inside';
      return info;
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
    };

    this.previousState = state;
    return info;
  }

  /** Reset for a new trading day. */
  reset(): void {
    this.previousState = null;
  }

  /**
   * Fraction (0–1) of the RTH session elapsed at `capturedAtUtc`.
   * 0 at the 09:30 apex, 1 at the 16:00 close.
   */
  private sessionFraction(capturedAtUtc: string): number {
    const elapsed = RTH_MINUTES - this.minutesUntilClose(capturedAtUtc);
    return Math.min(1, Math.max(0, elapsed / RTH_MINUTES));
  }

  /**
   * Compute minutes until RTH close (15:00 CT) from a UTC timestamp.
   *
   * Uses Intl.DateTimeFormat for DST-aware CT conversion (same approach
   * as the scraper's dates.ts to avoid the container-TZ regression).
   */
  private minutesUntilClose(capturedAtUtc: string): number {
    const d = new Date(capturedAtUtc);

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);

    const get = (t: string) =>
      Number.parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);

    const ctHour = get('hour');
    const ctMinute = get('minute');
    const ctMinutesSinceMidnight = ctHour * 60 + ctMinute;

    // RTH close = 15:00 CT = 900 minutes since midnight
    const closeMinutes = 15 * 60;
    const remaining = closeMinutes - ctMinutesSinceMidnight;

    return Math.max(remaining, 0);
  }
}
