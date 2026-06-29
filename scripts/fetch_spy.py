#!/usr/bin/env python3
"""fetch_spy.py — pull SPY ETF 5-min bars from massive/Polygon and write a CSV
the SPX converter can read (with --scale 10).

NOT part of the scraper. Run on demand. Requires the `massive` SDK:

    pip install massive
    MASSIVE_API_KEY=xxxxx python scripts/fetch_spy.py --out docs/temp/spy-5min.csv

WHY SPY
-------
SPY is arbitraged to the S&P 500 NAV continuously, so SPY×10 tracks the SPX cash
index far tighter intraday than ES futures do — there is no cost-of-carry "basis"
that breathes during the day. After a per-day close anchor (the converter's
default), SPY×10 reproduces SPX to well under a point for essentially every bar.

Convert with:
    npx tsx scripts/es-to-spx.ts --es docs/temp/spy-5min.csv --scale 10 \
        --out docs/temp/spx-from-spy-5min.csv

OUTPUT
------
CSV: Datetime,Open,High,Low,Close,Volume. Datetime is Eastern Time wall-clock,
so the converter works with its default --tz America/New_York.
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
    ap.add_argument("--out", default="docs/temp/spy-5min.csv")
    ap.add_argument("--ticker", default="SPY")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=datetime.now(ET).strftime("%Y-%m-%d"))
    args = ap.parse_args()

    api_key = os.environ.get("MASSIVE_API_KEY")
    if not api_key:
        sys.exit("ERROR: set MASSIVE_API_KEY in the environment.")
    client = RESTClient(api_key)

    rows = []
    n = 0
    # list_aggs paginates; ask for the full window in ascending order.
    for a in client.list_aggs(
        ticker=args.ticker,
        multiplier=5,
        timespan="minute",
        from_=args.start,
        to=args.end,
        limit=50000,
        sort="asc",
    ):
        n += 1
        # Polygon stock/ETF agg timestamps are epoch MILLISECONDS (bar start).
        dt_et = datetime.fromtimestamp(a.timestamp / 1e3, tz=timezone.utc).astimezone(ET)
        rows.append((
            dt_et.strftime("%Y-%m-%d %H:%M:%S"),
            a.open, a.high, a.low, a.close, a.volume,
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
