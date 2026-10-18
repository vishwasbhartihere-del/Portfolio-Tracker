"""Download AMFI's NAV file and write a compact navs.json for the static site.

Run by the GitHub Action before each deploy:  python3 scripts/build_navs.py site/navs.json
Output: {"generated": ISO, "fields": [...], "schemes": [[code, name, nav, nav_date, tax_class,
         lock_in_years, category, isin_growth, isin_reinvest], ...]}
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tracker.nav import AMFI_URL, _fetch, parse_navall  # noqa: E402

FIELDS = ["code", "name", "nav", "nav_date", "tax_class", "lock_in_years", "category", "isin_growth", "isin_reinvest"]


def short_category(c: str) -> str:
    # "Open Ended Schemes(Equity Scheme - Large Cap Fund)" -> "Equity Scheme - Large Cap Fund"
    return c[c.find("(") + 1:-1] if "(" in c and c.endswith(")") else c


def main(out: str) -> None:
    schemes = parse_navall(_fetch(AMFI_URL, timeout=60).decode("utf-8", errors="replace"))
    if len(schemes) < 1000:
        raise SystemExit(f"Only {len(schemes)} schemes parsed; AMFI format may have changed.")
    rows = [[s.code, s.name, s.nav, s.nav_date, s.tax_class, s.lock_in_years, short_category(s.amfi_category),
             s.isin_growth, s.isin_reinvest] for s in schemes.values()]
    payload = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "fields": FIELDS, "schemes": rows}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {len(rows)} schemes to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "site/navs.json")
