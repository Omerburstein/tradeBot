#!/usr/bin/env python3
"""fetch_spx.py — pull the REAL SPX cash index (Polygon ticker I:SPX) 1-min bars
and write a CSV the direct-spot ingest (scripts/ingest-spx.ts) can read.

NOT part of the scraper. Run on demand. Requires the `massive` SDK:

    pip install massive
    MASSIVE_API_KEY=xxxxx python scripts/fetch_spx.py --out docs/temp/spx-1min.csv

WHY I:SPX (not SPY×10 or ES-derived)
------------------------------------
I:SPX is the actual S&P 500 index value (== CBOE:SPX), exact — no ETF tracking
error, no futures cost-of-carry basis, no calibration. Its close IS the spot the
signal wants, so ingest-spx.ts writes close → spot_prices directly (no basis math).

OUTPUT
------
CSV: Datetime,Open,High,Low,Close,Volume. Datetime is Eastern Time wall-clock, so
the ingest works with its default --tz America/New_York. Index aggs carry no real
volume (written as 0).
"""
import argparse
import csv
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from massive import RESTClient

ET = ZoneInfo("America/New_York")
DEFAULT_START = "2025-12-29"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/temp/spx-1min.csv")
    ap.add_argument("--ticker", default="I:SPX")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=datetime.now(ET).strftime("%Y-%m-%d"))
    args = ap.parse_args()

    api_key = os.environ.get("MASSIVE_API_KEY") or os.environ.get("POLYGON_API_KEY")
    if not api_key:
        sys.exit("ERROR: set MASSIVE_API_KEY (or POLYGON_API_KEY) in the environment.")
    client = RESTClient(api_key)

    rows = []
    n = 0
    # list_aggs paginates transparently; ask for the full window ascending.
    for a in client.list_aggs(
        ticker=args.ticker,
        multiplier=1,
        timespan="minute",
        from_=args.start,
        to=args.end,
        limit=50000,
        sort="asc",
    ):
        n += 1
        # Polygon agg timestamps are epoch MILLISECONDS (bar start).
        dt_et = datetime.fromtimestamp(a.timestamp / 1e3, tz=timezone.utc).astimezone(ET)
        vol = getattr(a, "volume", None) or 0
        rows.append((
            dt_et.strftime("%Y-%m-%d %H:%M:%S"),
            a.open, a.high, a.low, a.close, vol,
        ))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Datetime", "Open", "High", "Low", "Close", "Volume"])
        w.writerows(rows)

    print(f"fetched {n} {args.ticker} aggregates, wrote {len(rows)} rows (ET) -> {args.out}",
          file=sys.stderr)
    if rows:
        print(f"  first: {rows[0][0]}   last: {rows[-1][0]}", file=sys.stderr)


if __name__ == "__main__":
    main()
