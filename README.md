# Portfolio Tracker

A portfolio tracker for Indian investors covering mutual funds, stocks, ETFs, SGBs, bonds, gold, crypto and anything else. It shows current holdings at live prices and suggests tax-harvesting moves. It's a static site hosted free on GitHub Pages, so you can open it on any device, including your phone.

**Privacy:** everything runs in your browser. Your transactions are saved in that browser's local storage and are never uploaded, and the repo contains no personal data. Each device keeps its own copy, so use **Data → Download backup / Restore backup** to move data between laptop and phone. Keep a recent backup, because browsers (especially Safari) can clear site data you haven't opened in a while.

## How it works

- `site/` is the whole app (HTML, CSS and vanilla JS with no build step).
- `.github/workflows/deploy.yml` runs on every push and nightly. It builds `site/navs.json` from AMFI (all mutual funds) and `site/stocks.json` from the NSE/BSE end-of-day files (every listed share, ETF, REIT, SGB and bond), then deploys `site/` to GitHub Pages. Both files cover the whole market, so they reveal nothing about your holdings.
- In the browser, the app fetches live prices for what you hold: fresher MF NAVs from mfapi.in, gold/silver from gold-api.com and crypto from CoinGecko.

## Publish it (one-time)

1. Create an **empty public** repository on GitHub (free GitHub Pages needs a public repo).
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions → "Build NAVs and deploy to GitHub Pages" → Run workflow** (only needed if the first run failed because Pages wasn't enabled yet).
5. Your site is at `https://<you>.github.io/<repo>/`. On your phone, open it and use **Share → Add to Home Screen**.

## Google sign-in + Drive sync (optional)

When you sign in, your data is kept in `portfolio-tracker-data.json` in your own Google Drive, so every device you sign in on shares it. The app uses the `drive.file` scope, so it can only see files it created. One-time setup:

1. Go to https://console.cloud.google.com/ and create a project (e.g. "Portfolio Tracker").
2. **APIs & Services → Library**: search for **Google Drive API** and click **Enable**.
3. **Google Auth Platform → Branding** (the OAuth consent screen): enter an app name and your email, and choose audience **External**.
4. **Audience → Test users**: add your Gmail address.
5. **Data access → Add scopes**: add `.../auth/drive.file`.
6. **Clients → Create client → Web application**. Under **Authorized JavaScript origins**, add `https://<you>.github.io` and `http://localhost:8765`. No redirect URIs are needed.
7. Copy the client ID (`….apps.googleusercontent.com`) into `site/config.js`, then commit and push.

Google tokens last 1 hour. After that, the header shows **Sync with Drive**, and one tap reconnects you.

## Run locally

```bash
python3 scripts/build_navs.py site/navs.json
```
```bash
python3 scripts/build_prices.py site/stocks.json
```
```bash
python3 -m http.server 8765
```
Open http://localhost:8765/site/. The engine tests are at http://localhost:8765/tests/.

## CSV format

One row per buy or sell. The header row is required; column order doesn't matter, and lines starting with `#` are ignored. **Data → Download template** gives you a filled-in example.

```csv
date,asset_type,symbol,type,quantity,price,fees,name,tax_class
2024-01-15,mf,122639,BUY,150.512,66.42,,,
2024-03-04,stock,RELIANCE,BUY,10,1450.50,20,,
2024-05-20,stock,GOLDBEES,BUY,100,55.10,10,,
2023-11-10,gold,GOLD24,BUY,10,6200,,Gold coins,
2025-01-05,crypto,BTC,BUY,0.01,8500000,85,,
2025-02-01,foreign,AAPL,BUY,5,19500,,Apple Inc,
2025-03-01,bond,XYZ-NCD-2028,BUY,10,10000,,XYZ Finance NCD,slab
2026-06-15,stock,RELIANCE,SELL,5,1390,15,,
```

| column | required | notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY` or `DD-Mon-YYYY` |
| `asset_type` | yes | `mf`, `stock`, `bond`, `gold`, `crypto`, `foreign` or `other` (see below) |
| `symbol` | yes | identifies the holding; see the table below. Use **Data → Find a symbol** |
| `type` | yes | `BUY` or `SELL` (also SIP, SWITCH_IN/OUT, REDEEM, BONUS, …) |
| `quantity` | yes | units / shares / grams / coins. Bonus shares: `BUY` at price `0` |
| `price` | yes | price **per unit in ₹** (or give `amount` instead of quantity/price) |
| `fees` | no | total brokerage/charges for the row in ₹; added to cost on buys, taken off proceeds on sells |
| `name` | no | display name for assets without a price feed |
| `tax_class` | no | overrides the tax treatment: `equity`, `listed`, `other`, `debt`, `slab`, `vda` |

| asset_type | symbol | live price from | default tax treatment |
|---|---|---|---|
| `mf` | AMFI scheme code, e.g. `122639` | AMFI + mfapi.in | from the fund's category (equity/debt/hybrid) |
| `stock` | NSE symbol (`RELIANCE`), BSE code (`500325`) or ISIN. Also ETFs (`NIFTYBEES`, `GOLDBEES`), REITs, SGBs (`SGBJUN28`) | NSE/BSE previous close | equity; gold/intl ETFs & SGBs → listed; debt ETFs → debt |
| `bond` | exchange symbol if listed, else any name | NSE/BSE if listed, else manual | listed (use `tax_class` = `slab` for unlisted bonds/MLDs) |
| `gold` | `GOLD24`, `GOLD22`, `GOLD18`, `SILVER` (quantity in grams) | gold-api.com spot + Indian premium | unlisted (24 months) |
| `crypto` | ticker (`BTC`, `ETH`, `SOL`) or CoinGecko id | CoinGecko | crypto: flat 30%, no loss set-off |
| `foreign` | e.g. `AAPL` (enter prices in ₹) | manual (Settings → Manual prices) | unlisted (24 months) |
| `other` | anything, e.g. `UNLISTED-NSE`, `PLOT-PUNE` | manual | unlisted (24 months) |

Older mutual-fund CSVs (`scheme_code`/`isin`, `units`, `nav`) still import.

## Tax rules modelled (transfers after 23-Jul-2024)

| Fund type | Long-term after | STCG | LTCG |
|---|---|---|---|
| Equity-oriented (≥65% Indian equity) | 12 months | 20% | 12.5% above ₹1.25L/yr |
| Debt (>65% debt), bought from 1-Apr-2023 | never | slab | slab |
| Debt bought before 1-Apr-2023 | 24 months | slab | 12.5% |
| Hybrid / FoF / gold / international | 24 months | slab | 12.5% |
| Listed shares, equity ETFs, REITs/InvITs | 12 months | 20% | 12.5% above ₹1.25L/yr (shared with equity MFs) |
| Gold/silver/intl ETFs, SGBs, listed bonds | 12 months | slab | 12.5% |
| Physical gold/silver, foreign shares, unlisted assets | 24 months | slab | 12.5% |
| Unlisted bonds, market-linked debentures | never | slab | slab |
| Crypto (VDA) | n/a | 30% flat | 30% flat; losses can't be set off or carried forward |

Losses are set off the way the tax return does it: short-term losses against any gain, long-term losses only against long-term gains. Set-off is mandatory, and leftover losses carry forward for 8 years. Redemptions are FIFO, ELSS lock-ins are respected, and pre-2018 equity units use the grandfathered cost. Surcharge is not modelled.

> These are estimates and not tax advice. Check actual exit loads and confirm with a CA before you redeem.

## Layout

```
site/engine.js           FIFO ledger, tax set-off, harvesting suggestions, report (pure functions)
site/app.js              UI, localStorage, backup/restore
site/prices.js           price feeds (static files + live APIs)
site/drive.js            Google sign-in + Drive file sync
site/config.js           Google client ID
scripts/build_navs.py    AMFI → navs.json (run by the workflow)
scripts/build_prices.py  NSE/BSE bhavcopies → stocks.json (run by the workflow)
tracker/nav.py           AMFI parser + fund tax classification
tests/                   browser test runner for engine.js
```
