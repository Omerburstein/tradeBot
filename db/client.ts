import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { DATABASE_URL } from '../scraper/core/config.js';
import { isPersistableSlot, MARKET_OPEN_MIN } from '../scraper/core/dates.js';

export const MAX_ROWS_PER_INSERT = 500;

/** Retention gate for the 10-min Greek/position snapshots (captured_at = slot
 *  END): Mon-Fri 09:40-16:00 ET. */
export function isRthRow(capturedAt: string): boolean {
  return isPersistableSlot(new Date(capturedAt));
}

/** Retention gate for the 5-min instant datasets (spot, Market Tide): Mon-Fri
 *  09:30-16:00 ET — keeps the 09:30 and 09:35 points the Greek gate drops. */
export function isRthInstant(capturedAt: string): boolean {
  return isPersistableSlot(new Date(capturedAt), MARKET_OPEN_MIN);
}

let client: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (client === null) {
    client = neon(DATABASE_URL);
  }
  return client;
}
