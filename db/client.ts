import { neon } from '@neondatabase/serverless';
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

/**
 * Driver-agnostic query surface: a parameterized SQL string in, an array of
 * result rows out. This is the ONLY database contract the rest of the codebase
 * (every db/ module + the algo data-loader + the tools/ scripts) depends on —
 * no other file imports a Postgres driver.
 *
 * ┌─ TO SWAP POSTGRES PROVIDERS (Neon → node-postgres / CockroachDB / …) ──────┐
 * │ Rewrite ONLY the body of getDb() below to return a function of this shape. │
 * │ Nothing else in the repo needs to change. With a standard `pg` Pool:       │
 * │   const pool = new Pool({ connectionString: DATABASE_URL });               │
 * │   client = (text, params = []) => pool.query(text, params).then(r => r.rows); │
 * │ (`pg` returns `{ rows }`; the .then(r => r.rows) is what re-pins the        │
 * │ rows-array contract that Neon's query-function form gives us for free.)     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
export type SqlClient = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

let client: SqlClient | null = null;

/** Lazily-initialized singleton query client. See {@link SqlClient}. */
export function getDb(): SqlClient {
  if (client === null) {
    const neonSql = neon(DATABASE_URL);
    client = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
      neonSql(text, params) as unknown as Promise<T[]>;
  }
  return client;
}
