-- ============================================================================
-- tradeBot — Neon Postgres canonical schema (run in pgAdmin)
--
-- Authoritative reference for ALL tables, kept in sync with the db/ layer
-- (repo-root, sibling of scraper/ and algorithms/). Every statement is
-- idempotent (CREATE TABLE IF NOT EXISTS) and safe to run repeatedly.
--
-- The scraper lazily creates spot_prices, market_tide, positions, and
-- cone_snapshots at runtime (each db/*.ts module CREATEs its own table on
-- first insert). periscope_snapshots is assumed pre-existing (migrations
-- 140/141) and shown here for completeness. Running this file by hand is
-- only needed to provision a fresh database up front.
--
-- Conventions:
--   * captured_at is the slot END time stored as UTC TIMESTAMPTZ. For
--     market_tide it is the data point's OWN 10-min boundary, not scrape time.
--   * Inserts are idempotent via ON CONFLICT DO NOTHING on each PK/UNIQUE key.
--   * Only the persisted RTH window (Mon-Fri 09:40-16:00 ET) is ever written.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- periscope_snapshots — per-strike Greeks (one row per slot × strike × panel)
-- Insert: db/snapshots.ts → insertSnapshots (batched 500/call).
-- (normally created by migrations 140/141; shown here for completeness)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS periscope_snapshots (
  captured_at TIMESTAMPTZ NOT NULL,            -- slot END time (UTC)
  expiry      DATE        NOT NULL,            -- option expiry / trade date
  panel       TEXT        NOT NULL,            -- gamma | charm | vanna
  strike      INTEGER     NOT NULL,            -- SPX strike
  value       NUMERIC     NOT NULL,            -- Greek exposure value
  timeframe   TEXT        NOT NULL,            -- UW slot label, e.g. '09:20 - 09:30'
  CONSTRAINT periscope_snapshots_pk UNIQUE (captured_at, expiry, panel, strike),
  CONSTRAINT periscope_snapshots_panel_chk
    CHECK (panel IN ('gamma', 'charm', 'vanna', 'positions'))
);


-- ----------------------------------------------------------------------------
-- spot_prices — one SPX spot observation per 10-min slot
-- Insert: db/spot-prices.ts → insertSpotPrice / insertSpotPrices.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spot_prices (
  captured_at TIMESTAMPTZ   NOT NULL,          -- slot END time (UTC)
  date        DATE          NOT NULL,          -- trade date (app passes `expiry`)
  spot        NUMERIC(10,2) NOT NULL,          -- SPX index level
  PRIMARY KEY (captured_at, date)
);


-- ----------------------------------------------------------------------------
-- positions — MM call/put contracts per strike (one row per slot × strike)
-- Insert: db/positions.ts → insertPositions (batched 500/call).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  captured_at TIMESTAMPTZ   NOT NULL,          -- slot END time (UTC)
  expiry      DATE          NOT NULL,          -- SPX expiry date
  strike      NUMERIC(10,2) NOT NULL,          -- SPX strike
  call_qty    BIGINT        NOT NULL,          -- MM call contracts at this strike
  put_qty     BIGINT        NOT NULL,          -- MM put contracts at this strike
  timeframe   TEXT          NOT NULL,          -- UW slot label, e.g. '09:20 - 09:30'
  PRIMARY KEY (captured_at, expiry, strike)
);


-- ----------------------------------------------------------------------------
-- market_tide — net-flow (Market Tide) per 10-min slot
--   captured_at = the data point's own 10-min slot boundary (UTC)
-- Insert: db/market-tide.ts → insertMarketTide (batched 500/call).
-- Supersedes the legacy `market_tide_ticks` table (renamed 2026; the old
-- tick_at/date/scrape-time columns were dropped). If a `market_tide_ticks`
-- table still exists in your database it is unused and can be dropped.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_tide (
  captured_at      TIMESTAMPTZ   NOT NULL,     -- data point's 10-min boundary (UTC)
  net_call_premium NUMERIC(18,4) NOT NULL,
  net_put_premium  NUMERIC(18,4) NOT NULL,
  net_volume       BIGINT        NOT NULL,
  PRIMARY KEY (captured_at)
);


-- ----------------------------------------------------------------------------
-- cone_snapshots — once-per-day cone coordinates (expected-move / Cone param)
--   spx_open   = SPX settled open (cone apex; first 1-min tick close)
--   cone_upper = spx_open + ATM straddle  (upper yellow line endpoint)
--   cone_lower = spx_open − ATM straddle  (lower yellow line endpoint)
-- Insert: db/cone.ts → insertConeSnapshot (one row per ET trade date; the
-- code checks captured_at AT TIME ZONE 'America/New_York' before inserting).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cone_snapshots (
  captured_at  TIMESTAMPTZ   NOT NULL PRIMARY KEY,
  spx_open     NUMERIC(10,2) NOT NULL,
  cone_upper   NUMERIC(10,2) NOT NULL,
  cone_lower   NUMERIC(10,2) NOT NULL
);
