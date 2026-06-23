/**
 * Date utilities for the scraper. Kept dependency-free so unit tests
 * can import them without booting `config.ts` (which validates env
 * vars at module load).
 *
 * TIMEZONE: all wall-clock interpretation is anchored to Eastern Time
 * (America/New_York), matching exactly what the UW Periscope dashboard
 * displays. ET is always one hour ahead of the SPX pit's CT, so the
 * RTH/active-window bounds below are the ET equivalents of the old CT
 * bounds (same real-world instants). `captured_at` remains an absolute
 * UTC instant and is unaffected by this choice — only the wall-clock
 * representation moved CT→ET.
 */

const MARKET_TZ = 'America/New_York';

/**
 * Compute the captured_at ISO timestamp for a backfilled slot.
 *
 * `date` is YYYY-MM-DD, `slotEndHhmm` is the slot's end time as
 * displayed by UW (Eastern Time — what the dashboard shows). Returns
 * the UTC ISO that corresponds to that ET wall-clock instant.
 *
 * REGRESSION (2026-05-10): An earlier version of this function used
 * `new Date('YYYY-MM-DDTHH:MM:00').toISOString()` and relied on the
 * Railway container being configured with a fixed TZ. When the
 * container ran in UTC (default), every backfilled `captured_at` was
 * shifted hours earlier. That corrupted 5/4-5/7 snapshots and caused
 * ~$50 of stale Claude reads in the auto-playbook backfill.
 *
 * This implementation computes the ET-to-UTC offset explicitly via
 * Intl.DateTimeFormat, which is correct regardless of container TZ
 * and handles DST transitions automatically.
 */
export function computeCapturedAt(date: string, slotEndHhmm: string): string {
  const hhmm = normalizeHhmm(slotEndHhmm);
  const [y, m, d] = date.split('-').map((s) => Number.parseInt(s, 10));
  const [hh, mm] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm)
  ) {
    throw new Error(
      `computeCapturedAt: malformed inputs date="${date}" slotEnd="${slotEndHhmm}"`,
    );
  }
  // Convergence loop: probe a UTC instant pretending ET values are
  // UTC values, read back what ET actually was at that instant, and
  // shift by the gap. Two passes suffice (one pass corrects the
  // wrong-offset guess; second pass corrects any DST cusp).
  let probeUtcMs = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    const etPartsList = new Intl.DateTimeFormat('en-US', {
      timeZone: MARKET_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(probeUtcMs));
    const get = (t: string) =>
      Number.parseInt(etPartsList.find((p) => p.type === t)?.value ?? '0', 10);
    const etMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    const targetMs = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
    probeUtcMs += targetMs - etMs;
  }
  return new Date(probeUtcMs).toISOString();
}

/**
 * Returns true when the given UTC instant maps to an ET wall-clock
 * time inside RTH (09:30-16:00 ET inclusive). DST-aware via
 * Intl.DateTimeFormat. Mon-Fri only.
 *
 * Used by the auto-playbook webhook guard to reject stale captures
 * that landed outside trading hours.
 */
export function isInRth(d: Date): boolean {
  const { weekday, minutesSinceMidnight } = etParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 16 * 60;
}

/**
 * Returns true when a captured slot's END time (its captured_at instant)
 * belongs to the data we persist: Mon-Fri, 09:40-16:00 ET inclusive.
 * DST-aware.
 *
 * This is STRICTER than `isInRth`: it also excludes the opening
 * 09:20-09:30 slot (which ends at 09:30 and straddles the bell). The
 * first persisted slot is therefore 09:30-09:40 (ends 09:40) and the
 * last is 15:50-16:00 (ends 16:00). Premarket and postmarket slots are
 * excluded as well.
 *
 * Used as the single retention gate across every persistence path —
 * live tick, single-date backfill, range backfill, walk-back — so
 * out-of-window slots are dropped no matter which path produced them.
 */
export function isPersistableSlot(d: Date): boolean {
  const { weekday, minutesSinceMidnight } = etParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesSinceMidnight >= 9 * 60 + 40 && minutesSinceMidnight <= 16 * 60;
}

/**
 * Returns true when the given UTC instant is inside the scraper's
 * active polling window: Mon-Fri, 09:21-16:14 ET. DST-aware.
 *
 * Window bounds:
 *   - 09:21 ET — earliest a 10-min slot ending at 09:20 could appear
 *     in UW's "Latest" panel (publication lag is typically 1-3 min).
 *   - 16:14 ET — latest tick that can still capture the debrief slot
 *     ("15:50 - 16:00") within the auto-playbook's 16:15 ET wallclock
 *     ceiling. Beyond this the scraper has nothing useful to do.
 *
 * Outside this window the scraper resets its dedup state and sleeps
 * until the next active window.
 */
export function isInActivePollingWindow(d: Date): boolean {
  const { weekday, minutesSinceMidnight } = etParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return (
    minutesSinceMidnight >= 9 * 60 + 21 && minutesSinceMidnight <= 16 * 60 + 14
  );
}

/**
 * Return the end time (HH:MM) of the most recently CLOSED 10-min UW
 * slot at the given instant, in ET. DST-aware. Returns null when the
 * instant is before the first 10-min boundary of the day (00:10 ET).
 *
 * Examples (all ET):
 *   09:30:00 → "09:30"  (the 09:20-09:30 slot just closed)
 *   09:32:15 → "09:30"
 *   09:39:59 → "09:30"
 *   09:40:00 → "09:40"  (the 09:30-09:40 slot just closed)
 *
 * Used by the scraper to know which slot end-time to expect from UW's
 * "Latest" panel. When lastCapturedWindowEnd === expectedWindowEnd, we
 * already have the slot for this window and can skip the scrape until
 * the next 10-min boundary closes.
 */
export function expectedWindowEnd(d: Date): string | null {
  const { hour, minute } = etParts(d);
  const totalMin = hour * 60 + minute;
  if (totalMin < 10) return null;
  const endMin = Math.floor(totalMin / 10) * 10;
  const eh = Math.floor(endMin / 60);
  const em = endMin % 60;
  return `${pad2(eh)}:${pad2(em)}`;
}

/**
 * Parse the END time (HH:MM) from a UW slot label like "08:20 - 08:30".
 * Returns null on unparseable input. The scraper uses this to compare
 * a freshly-captured slot's end against `expectedWindowEnd(now)`.
 */
export function parseSlotEnd(slotKey: string): string | null {
  const m = slotKey.match(/^\s*\d{1,2}:\d{2}\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (m == null) return null;
  return `${pad2(Number.parseInt(m[1]!, 10))}:${m[2]}`;
}

function etParts(d: Date): {
  hour: number;
  minute: number;
  weekday: string;
  minutesSinceMidnight: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  return {
    hour,
    minute,
    weekday: get('weekday'),
    minutesSinceMidnight: hour * 60 + minute,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function normalizeHhmm(s: string): string {
  // Accepts "8:30" or "08:30" — pad the hour to 2 digits.
  const parts = s.split(':');
  if (parts.length !== 2) return s;
  return `${parts[0]!.padStart(2, '0')}:${parts[1]}`;
}
