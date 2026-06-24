import type { ConeSnapshotRow } from '../scraper/core/types.js';
import { getDb } from './client.js';

const CREATE_CONE_SNAPSHOTS_TABLE =
  `CREATE TABLE IF NOT EXISTS cone_snapshots (` +
  `captured_at  TIMESTAMPTZ   NOT NULL PRIMARY KEY, ` +
  `spx_open     NUMERIC(10,2) NOT NULL, ` +
  `cone_upper   NUMERIC(10,2) NOT NULL, ` +
  `cone_lower   NUMERIC(10,2) NOT NULL` +
  `)`;

const SELECT_BY_ET_DATE =
  `SELECT 1 FROM cone_snapshots ` +
  `WHERE (captured_at AT TIME ZONE 'America/New_York')::date = $1::date ` +
  `LIMIT 1`;

export async function coneSnapshotExists(date: string): Promise<boolean> {
  const sql = getDb();
  try {
    const rows = (await sql(SELECT_BY_ET_DATE, [date])) as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function insertConeSnapshot(row: ConeSnapshotRow): Promise<boolean> {
  const sql = getDb();
  await sql(CREATE_CONE_SNAPSHOTS_TABLE, []);

  const existing = (await sql(SELECT_BY_ET_DATE, [row.capturedAt])) as unknown[];
  if (existing.length > 0) return false;

  await sql(
    `INSERT INTO cone_snapshots (captured_at, spx_open, cone_upper, cone_lower) ` +
    `VALUES ($1, $2, $3, $4)`,
    [row.capturedAt, row.spxOpen, row.coneUpper, row.coneLower],
  );
  return true;
}
