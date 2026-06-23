/**
 * Expected move cone: computes the intraday expected move boundary
 * and tracks state transitions (inside/above/below) for trade triggers.
 *
 * The cone acts as a support/resistance trigger gate (NOT a magnet):
 * - Price breaking ABOVE the cone + bullish gamma signal → long entry (continuation)
 * - Price breaking BELOW the cone + bearish gamma signal → short entry (continuation)
 * - Price returning INSIDE the cone → exit (breakout failed)
 */

import type { AlgoConfig, ConeInfo, ConeState } from './types.js';

/** Minutes in a full trading day (09:30–16:00 ET = 08:30–15:00 CT). */
const RTH_MINUTES = 390;

/** Trading days per year. */
const TRADING_DAYS = 252;

/**
 * Tracks cone state across successive snapshots within a trading day.
 * Create a new instance at the start of each day.
 */
export class ConeTracker {
  private openSpot: number | null = null;
  private previousState: ConeState | null = null;
  private config: AlgoConfig;

  constructor(config: AlgoConfig) {
    this.config = config;
  }

  /**
   * Update cone state for a new snapshot.
   *
   * @param spot          Current SPX price
   * @param capturedAtUtc ISO UTC timestamp of the snapshot
   * @returns ConeInfo with boundaries, state, and crossing events
   */
  update(spot: number, capturedAtUtc: string): ConeInfo {
    // Record open price on first call of the day
    if (this.openSpot === null) {
      this.openSpot = spot;
    }

    const minutesRemaining = this.minutesUntilClose(capturedAtUtc);
    const expectedMove = this.computeExpectedMove(this.openSpot, minutesRemaining);

    const upper = this.openSpot + expectedMove;
    const lower = this.openSpot - expectedMove;

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
    this.openSpot = null;
    this.previousState = null;
  }

  /**
   * Compute the expected move in SPX points.
   *
   * Uses the annualized expected move formula scaled to intraday:
   *   EM = spot * dailyExpectedMovePct * sqrt(minutesRemaining / RTH_MINUTES)
   *
   * The cone narrows as the day progresses (sqrt decay).
   * At market open, the full daily expected move applies.
   * Near close, the cone shrinks to near-zero.
   */
  private computeExpectedMove(openSpot: number, minutesRemaining: number): number {
    // Clamp to avoid negative or zero remaining time
    const minRemaining = Math.max(minutesRemaining, 1);

    // Scale the daily expected move by the fraction of the day remaining
    // sqrt scaling: volatility scales with sqrt(time)
    const timeScale = Math.sqrt(minRemaining / RTH_MINUTES);

    return openSpot * this.config.dailyExpectedMovePct * timeScale;
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
