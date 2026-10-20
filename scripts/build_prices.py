"""Build stocks.json: latest closing prices for everything traded on NSE and BSE.

Uses the exchanges' public end-of-day "bhavcopy" files, which cover the whole market (shares, ETFs,
REITs/InvITs, SGBs, listed bonds), so the published file reveals nothing about anyone's holdings.
The last few trading days are merged so thinly-traded securities still get a recent price.

  python3 scripts/build_prices.py site/stocks.json
Output: {"generated", "fields", "rows": [[symbol, name, price, date, series, isin, tax_class, exchange, bse_code], ...]}
"""
from __future__ import annotations

import csv
import io
import json
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tracker.nav import _fetch  # noqa: E402

NSE_URL = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d}_F_0000.csv.zip"
BSE_URL = "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d}_F_0000.CSV"
FIELDS = ["symbol", "name", "price", "date", "series", "isin", "tax_class", "exchange", "bse_code"]
LOOKBACK_DAYS = 10
NSE_EQUITY_SERIES = {"EQ", "BE", "BZ", "SM", "ST", "SZ", "RR", "IV"}
BSE_DEBT_GROUPS = {"F", "G"}


def tax_class(series: str, name: str, symbol: str, isin: str, exchange: str) -> str:
    n, s = f"{name} {symbol}".upper(), symbol.upper()
    if series == "GB" or s.startswith("SGB") or "GOLDBONDS" in n.replace(" ", ""):
        return "listed"  # Sovereign Gold Bonds
    if isin.startswith("INF") or "ETF" in n or "BEES" in n:  # ETF / fund units
        if any(k in n for k in ("GOLD", "SILVER")):
            return "listed"
        if any(k in n for k in ("LIQUID", "GILT", "BOND", "SDL", "G-SEC", "GSEC", "MONEY MARKET", "1D RATE",
                                "OVERNIGHT", "CRISIL", "TREASURY", "TBILL")):
            return "debt"
        if any(k in n for k in ("NASDAQ", "NASDQ", "S&P", "SP500", "HANG SENG", "HANGSENG", "FANG", "MON100",
                                "MON50", "NYSE", "GLOBAL", "JAPAN", "CHINA")):
            return "listed"  # international ETFs are not equity-oriented for Indian tax
        return "equity"
    if exchange == "NSE":
        return "equity" if series in NSE_EQUITY_SERIES else "listed"
    # BSE groups: F = fixed income, G = government securities; everything else is shares.
    if series in BSE_DEBT_GROUPS or isin.startswith("IN0") or " NCD" in n or "BOND" in n:
        return "listed"
    return "equity"


def _rows(text: str):
    yield from csv.DictReader(io.StringIO(text))


def fetch_day(d: date) -> tuple[list[dict], list[dict]]:
    ds = d.strftime("%Y%m%d")
    nse, bse = [], []
    try:
        raw = _fetch(NSE_URL.format(d=ds), timeout=30)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            nse = list(_rows(z.read(z.namelist()[0]).decode("utf-8", errors="replace")))
    except Exception as e:  # holiday, weekend, or blocked
        print(f"NSE {ds}: {e}", file=sys.stderr)
    try:
        bse = list(_rows(_fetch(BSE_URL.format(d=ds), timeout=30).decode("utf-8", errors="replace")))
    except Exception as e:
        print(f"BSE {ds}: {e}", file=sys.stderr)
    return nse, bse


def main(out: str) -> None:
    by_symbol: dict[str, list] = {}
    bse_by_isin: dict[str, str] = {}
    today = datetime.now(timezone.utc).date()
    days_with_data = 0
    # Oldest first so newer prices overwrite older ones.
    for d in sorted(today - timedelta(days=i) for i in range(LOOKBACK_DAYS)):
        if d.weekday() >= 5:
            continue
        nse, bse = fetch_day(d)
        if nse or bse:
            days_with_data += 1
        for r in bse:
            try:
                price = float(r["ClsPric"])
            except (KeyError, ValueError):
                continue
            sym, isin, code = r["TckrSymb"].strip(), r["ISIN"].strip(), r["FinInstrmId"].strip()
            bse_by_isin[isin] = code
            prev = by_symbol.get(sym)
            if prev and prev[7] == "NSE":
                continue  # prefer the NSE listing under the same symbol
            name = r["FinInstrmNm"].strip()
            by_symbol[sym] = [sym, name, price, r["TradDt"], r["SctySrs"].strip(), isin,
                              tax_class(r["SctySrs"].strip(), name, sym, isin, "BSE"), "BSE", code]
        for r in nse:
            try:
                price = float(r["ClsPric"])
            except (KeyError, ValueError):
                continue
            sym, isin, series = r["TckrSymb"].strip(), r["ISIN"].strip(), r["SctySrs"].strip()
            name = r["FinInstrmNm"].strip()
            by_symbol[sym] = [sym, name, price, r["TradDt"], series, isin, tax_class(series, name, sym, isin, "NSE"),
                              "NSE", bse_by_isin.get(isin, "")]
    if len(by_symbol) < 1000:
        raise SystemExit(f"Only {len(by_symbol)} securities from {days_with_data} days; exchange downloads may be blocked.")
    for row in by_symbol.values():  # fill BSE codes learned after the NSE row was written
        row[8] = row[8] or bse_by_isin.get(row[5], "")
    payload = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "fields": FIELDS,
               "rows": sorted(by_symbol.values())}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {len(by_symbol)} securities from {days_with_data} trading days to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "site/stocks.json")
