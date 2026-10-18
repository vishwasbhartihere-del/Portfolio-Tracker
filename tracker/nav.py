"""Parse AMFI's daily NAV file and classify schemes for tax (used by scripts/build_navs.py).

AMFI publishes one semicolon-separated file with every scheme's latest NAV.
Category header lines (e.g. "Open Ended Schemes(Equity Scheme - Large Cap Fund)")
precede each block of schemes, which lets us classify funds for tax purposes.
"""
from __future__ import annotations

import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"


@dataclass
class Scheme:
    code: str
    name: str
    isin_growth: str
    isin_reinvest: str
    nav: float
    nav_date: str  # ISO
    amfi_category: str
    tax_class: str  # equity | debt | other
    lock_in_years: int


def _ssl_contexts():
    yield ssl.create_default_context()
    # python.org builds on macOS ship without CA certs; fall back to the system bundle.
    for bundle in ("/etc/ssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"):
        if Path(bundle).exists():
            yield ssl.create_default_context(cafile=bundle)


def _fetch(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "portfolio-tracker/1.0"})
    err: Exception | None = None
    for ctx in _ssl_contexts():
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read()
        except urllib.error.URLError as e:
            if not isinstance(e.reason, ssl.SSLCertVerificationError):
                raise
            err = e
    raise err  # type: ignore[misc]


DEBT_NAME_HINTS = ("gilt", "g-sec", "gsec", "sdl", "bond", "debt", "crisil ibx", "liquid",
                   "money market", "overnight", "treasury", "psu", "target maturity", "nifty ssi")
OTHER_NAME_HINTS = ("gold", "silver", "nasdaq", "s&p 500", "us ", "global", "international",
                    "overseas", "hang seng", "world", "emerging")


def classify(category: str, name: str) -> tuple[str, int]:
    """Map an AMFI category + scheme name to (tax_class, lock_in_years).

    equity: equity-oriented fund (>=65% domestic equity) -> 12m holding, 111A/112A.
    debt:   "specified mutual fund" (>65% debt) -> all gains at slab rate (if bought >= 1-Apr-2023).
    other:  hybrids, FoFs, gold/silver, international -> 24m holding, 12.5% LTCG, slab STCG.
    The user can override this per fund in settings.
    """
    c, n = category.lower(), name.lower()
    lock = 3 if ("elss" in c or "elss" in n or "tax saver" in n) else 0
    if "solution oriented" in c or "children" in c or "retirement" in c:
        lock = 5
    if any(k in c for k in ("debt", "income", "gilt", "liquid", "money market", "overnight",
                            "conservative hybrid")):
        return "debt", lock
    if any(k in c for k in ("overseas", "gold", "silver", "fof", "fund of funds")):
        return "other", lock
    if "index fund" in c or "other  etf" in c or "other etf" in c:
        if any(k in n for k in DEBT_NAME_HINTS):
            return "debt", lock
        if any(k in n for k in OTHER_NAME_HINTS):
            return "other", lock
        return "equity", lock
    if "equity" in c or "elss" in c or "arbitrage" in c or "aggressive hybrid" in c \
            or "equity savings" in c or "balanced advantage" in c or "dynamic asset" in c:
        if any(k in n for k in OTHER_NAME_HINTS):
            return "other", lock
        return "equity", lock
    return "other", lock


def _parse_date(s: str) -> str:
    return datetime.strptime(s.strip(), "%d-%b-%Y").date().isoformat()


def parse_navall(text: str) -> dict[str, Scheme]:
    schemes: dict[str, Scheme] = {}
    category = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("Scheme Code"):
            continue
        if ";" not in line:
            if "Schemes" in line and "(" in line:
                category = line
            continue
        parts = line.split(";")
        if len(parts) < 6:
            continue
        # Format: code;isin1;isin2;name;[plan;option;]nav;date
        code, isin1, isin2 = parts[0], parts[1], parts[2]
        nav_s, date_s = parts[-2], parts[-1]
        name = " - ".join(p.strip(" -") for p in parts[3:-2] if p.strip(" -"))
        try:
            nav = float(nav_s)
            nav_date = _parse_date(date_s)
        except ValueError:
            continue
        tax_class, lock = classify(category, name)
        schemes[code] = Scheme(code, name, isin1 if isin1 != "-" else "",
                               isin2 if isin2 != "-" else "", nav, nav_date,
                               category, tax_class, lock)
    return schemes
