import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { DATABASE_URL } from '../scraper/core/config.js';
import { isPersistableSlot } from '../scraper/core/dates.js';

export const MAX_ROWS_PER_INSERT = 500;

export function isRthRow(capturedAt: string): boolean {
  return isPersistableSlot(new Date(capturedAt));
}

let client: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (client === null) {
    client = neon(DATABASE_URL);
  }
  return client;
}
