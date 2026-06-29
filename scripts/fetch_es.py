#!/usr/bin/env python3
"""fetch_es.py — pull ES (S&P 500 futures) 5-min bars from massive/Polygon and
write a CSV the ES→SPX converter / ingest can read.

NOT part of the scraper. Run on demand. Requires the `massive` SDK:

    pip install massive
    MASSIVE_API_KEY=xxxxx python scripts/fetch_es.py --out docs/temp/es-front-month-5min.csv

WHY "ROLLED" BY DEFAULT
-----------------------
A single far-dated contract (e.g. ESU6 = Sep 2026) is essentially untradeable
before it becomes the front month: e.g. 2026-01-20 had a *single 1-lot print*
all session, which makes per-day basis calibration meaningless. So by default we
fetch the three quarterlies that cover 2025-12-29 → today and, for each trading
day, keep whichever contract had the most RTH volume (the liquid front month):

    ESH6 (Mar 2026) → ESM6 (Jun 2026) → ESU6 (Sep 2026)

Pass --ticker ESU6 to fetch a single contract instead (matches the raw query in
the original request, but not recommended for the historical window).

OUTPUT
------
CSV with header Datetime,Open,High,Low,Close,Volume[,Contract]. Datetime is
Eastern Time wall-clock ("YYYY-MM-DD HH:MM:SS"), so the converter/ingest work
with their default --tz America/New_York (no --tz flag needed).
"""
import argparse
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from massive import RESTClient

ET = ZoneInfo("America/New_York")
DEFAULT_CONTRACTS = ["ESH6", "ESM6", "ESU6"]  # Mar, Jun, Sep 2026
DEFAULT_START = "2025-12-29"


def fetch_contract(client: RESTClient, ticker: str, start: str):
    """Return {(et_date, et_datetime_str, min_of_day): (o,h,l,c,v)} for one
    contract, stopping once we page past `start` (sorted desc)."""
    out = {}
    n = 0
    for a in client.list_futures_aggregates(
        ticker=ticker, resolution="5min", sort="window_start.desc", limit=50000,
    ):
        n += 1
        dt_utc = datetime.fromtimestamp(a.window_start / 1e9, tz=timezone.utc)
        dt_et = dt_utc.astimezone(ET)
        date_et = dt_et.strftime("%Y-%m-%d")
        if date_et < start:
            break
        key = (date_et, dt_et.strftime("%Y-%m-%d %H:%M:%S"), dt_et.hour * 60 + dt_et.minute)
        out[key] = (a.open, a.high, a.low, a.close, a.volume)
    print(f"  {ticker}: fetched {n} aggregates", file=sys.stderr)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/temp/es-front-month-5min.csv")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument(
        "--ticker",
        default=None,
        help="Single contract (e.g. ESU6). Omit to roll the front month.",
    )
    args = ap.parse_args()

    api_key = os.environ.get("MASSIVE_API_KEY")
    if not api_key:
        sys.exit("ERROR: set MASSIVE_API_KEY in the environment.")
    client = RESTClient(api_key)

    contracts = [args.ticker] if args.ticker else DEFAULT_CONTRACTS
    rolled = args.ticker is None

    # Fetch each contract; track RTH volume per ET date for the roll decision.
    bars = {}
    rth_vol = {c: defaultdict(float) for c in contracts}
    for c in contracts:
        bars[c] = fetch_contract(client, c, args.start)
        for (date_et, _, mind), (_o, _h, _l, _cl, v) in bars[c].items():
            if 9 * 60 + 30 <= mind <= 16 * 60:
                rth_vol[c][date_et] += v or 0

    all_dates = {d for c in contracts for (d, _, _) in bars[c]}

    # Pick the most-liquid contract per day (the front month).
    chosen = {}
    for d in sorted(all_dates):
        best = max(contracts, key=lambda c: rth_vol[c].get(d, 0.0))
        if rth_vol[best].get(d, 0.0) > 0 or not rolled:
            chosen[d] = best

    rows = []
    for d in sorted(chosen):
        c = chosen[d]
        day_bars = sorted(
            ((dts, mind, vals) for (dd, dts, mind), vals in bars[c].items() if dd == d),
            key=lambda x: x[1],
        )
        for dts, _mind, (o, h, l, cl, v) in day_bars:
            row = [dts, o, h, l, cl, v]
            if rolled:
                row.append(c)
            rows.append(row)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        header = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
        if rolled:
            header.append("Contract")
        w.writerow(header)
        w.writerows(rows)

    print(f"\nwrote {len(rows)} rows (ET) -> {args.out}", file=sys.stderr)
    if rolled:
        prev = None
        for d in sorted(chosen):
            if chosen[d] != prev:
                print(f"  {d}: front month = {chosen[d]}", file=sys.stderr)
                prev = chosen[d]


if __name__ == "__main__":
    main()
