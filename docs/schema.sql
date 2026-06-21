-- ============================================================================
-- tradeBot — Neon Postgres canonical schema (run in pgAdmin)
--
-- The scraper (scraper/core/db.ts) lazily creates spot_prices, market_tide_ticks,
-- and cone_snapshots with CREATE TABLE IF NOT EXISTS. This file is the
-- authoritative reference for ALL tables and is safe to run repeatedly.
--
-- The only one you MUST run by hand is the market_tide_ticks migration below:
-- the old code wrote the tick time into captured_at and had no tick_at
-- column, so on a DB whose market_tide_ticks already requires tick_at the inserts
-- failed and nothing was stored. The block migrates an existing table in
-- place (preserving rows) or creates the canonical one fresh.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- periscope_snapshots — per-strike Greeks/positions (one row per slot×strike×panel)
-- (normally created by migrations 140/141; shown here for completeness)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS periscope_snapshots (
  captured_at TIMESTAMPTZ NOT NULL,            -- slot END time (UTC)
  expiry      DATE        NOT NULL,            -- option expiry / trade date
  panel       TEXT        NOT NULL,            -- gamma | charm | vanna | positions
  strike      INTEGER     NOT NULL,            -- SPX strike
  value       NUMERIC     NOT NULL,            -- Greek / positions value
  timeframe   TEXT        NOT NULL,            -- UW slot label, e.g. '09:20 - 09:30'
  CONSTRAINT periscope_snapshots_pk UNIQUE (captured_at, expiry, panel, strike),
  CONSTRAINT periscope_snapshots_panel_chk
    CHECK (panel IN ('gamma', 'charm', 'vanna', 'positions'))
);


-- ----------------------------------------------------------------------------
-- spot_prices — one SPX spot observation per 10-min slot
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spot_prices (
  captured_at TIMESTAMPTZ   NOT NULL,          -- slot END time (UTC)
  date        DATE          NOT NULL,          -- trade date
  spot        NUMERIC(10,2) NOT NULL,          -- SPX index level
  PRIMARY KEY (captured_at, date)
);


-- ----------------------------------------------------------------------------
-- cone_snapshots — once-per-day ATM straddle (expected-move / Cone param)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cone_snapshots (
  captured_at TIMESTAMPTZ   NOT NULL,          -- scrape time
  date        DATE          NOT NULL,          -- trade date
  straddle    NUMERIC(10,2) NOT NULL,          -- ATM straddle = expected move (SPX pts)
  PRIMARY KEY (captured_at, date)
);


-- ----------------------------------------------------------------------------
-- market_tide_ticks — net-flow (Market Tide) per 10-min slot
--   tick_at     = the data point's own slot boundary (UTC)   <-- was missing
--   captured_at = scrape wall-clock time (when the row was stored)
-- Idempotent migration: create fresh, or upgrade an old-schema table in place.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.market_tide_ticks') IS NULL THEN
    -- Fresh install: create canonical table.
    CREATE TABLE market_tide_ticks (
      tick_at          TIMESTAMPTZ   NOT NULL,
      date             DATE          NOT NULL,
      net_call_premium NUMERIC(18,4) NOT NULL,
      net_put_premium  NUMERIC(18,4) NOT NULL,
      net_volume       BIGINT        NOT NULL,
      captured_at      TIMESTAMPTZ   NOT NULL,
      PRIMARY KEY (tick_at, date)
    );
  ELSE
    -- Existing table: add the new columns if absent.
    -- Old schema stored the tick time in captured_at, so backfill tick_at
    -- from it, then reset captured_at to "now" as the scrape-time stamp.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'market_tide_ticks' AND column_name = 'tick_at'
    ) THEN
      ALTER TABLE market_tide_ticks ADD COLUMN tick_at TIMESTAMPTZ;
      UPDATE market_tide_ticks SET tick_at = captured_at WHERE tick_at IS NULL;
      UPDATE market_tide_ticks SET captured_at = now()
        WHERE captured_at = tick_at;          -- legacy rows: stamp scrape time
      ALTER TABLE market_tide_ticks ALTER COLUMN tick_at SET NOT NULL;
    END IF;

    -- Ensure a `date` column exists (older tables may lack it).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'market_tide_ticks' AND column_name = 'date'
    ) THEN
      ALTER TABLE market_tide_ticks ADD COLUMN date DATE;
      UPDATE market_tide_ticks SET date = (tick_at AT TIME ZONE 'UTC')::date
        WHERE date IS NULL;
      ALTER TABLE market_tide_ticks ALTER COLUMN date SET NOT NULL;
    END IF;

    -- Repoint the primary key to (tick_at, date) if it isn't already.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k
        ON k.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'market_tide_ticks'
        AND tc.constraint_type = 'PRIMARY KEY'
        AND k.column_name IN ('tick_at', 'date')
      GROUP BY tc.constraint_name
      HAVING COUNT(*) = 2
    ) THEN
      ALTER TABLE market_tide_ticks DROP CONSTRAINT IF EXISTS market_tide_ticks_pkey;
      ALTER TABLE market_tide_ticks ADD PRIMARY KEY (tick_at, date);
    END IF;
  END IF;
END $$;

-- Sanity check after migration:
--   SELECT tick_at, date, net_call_premium, net_put_premium, net_volume, captured_at
--   FROM market_tide_ticks ORDER BY tick_at DESC LIMIT 20;
