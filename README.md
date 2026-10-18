# Portfolio Tracker

A mutual-fund tracker for Indian investors. It shows your current holdings with live NAVs and suggests tax-harvesting moves. It's a static site hosted free on GitHub Pages, so you can open it on any device, including your phone.

**Privacy:** everything runs in your browser. Your transactions are saved in that browser's local storage and are never uploaded, and the repo contains no personal data. Each device keeps its own copy, so use **Data → Download backup / Restore backup** to move data between laptop and phone. Keep a recent backup, because browsers (especially Safari) can clear site data you haven't opened in a while.

## How it works

- `site/` is the whole app (HTML, CSS and vanilla JS with no build step).
- `.github/workflows/deploy.yml` runs on every push and nightly. It downloads AMFI's NAV file, builds `site/navs.json` (all schemes, NAVs and tax classes) and deploys `site/` to GitHub Pages.
- In the browser, the app also fetches the latest NAVs for funds you hold from [mfapi.in](https://www.mfapi.in/). For units bought before February 2018 it fetches the 31-Jan-2018 NAV, used to raise their cost basis (grandfathering).

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
python3 -m http.server 8765
```
Open http://localhost:8765/site/. The engine tests are at http://localhost:8765/tests/.

## CSV format

| column | notes |
|---|---|
| `date` | `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY` or `DD-Mon-YYYY` |
| `scheme_code` | AMFI scheme code. Use **Data → Find a scheme code**, or give an `isin` column instead |
| `type` | `BUY`, `SIP`, `SWITCH_IN`, `REINVEST` / `SELL`, `REDEEM`, `SWITCH_OUT`, `SWP` |
| `units`, `nav` | or `amount` with one of them |

## Tax rules modelled (transfers after 23-Jul-2024)

| Fund type | Long-term after | STCG | LTCG |
|---|---|---|---|
| Equity-oriented (≥65% Indian equity) | 12 months | 20% | 12.5% above ₹1.25L/yr |
| Debt (>65% debt), bought from 1-Apr-2023 | never | slab | slab |
| Debt bought before 1-Apr-2023 | 24 months | slab | 12.5% |
| Hybrid / FoF / gold / international | 24 months | slab | 12.5% |

Losses are set off the way the tax return does it: short-term losses against any gain, long-term losses only against long-term gains. Set-off is mandatory, and leftover losses carry forward for 8 years. Redemptions are FIFO, ELSS lock-ins are respected, and pre-2018 equity units use the grandfathered cost. Surcharge is not modelled.

> These are estimates and not tax advice. Check actual exit loads and confirm with a CA before you redeem.

## Layout

```
site/engine.js           FIFO ledger, tax set-off, harvesting suggestions, report (pure functions)
site/app.js              UI, localStorage, NAV fetching, backup/restore
site/drive.js            Google sign-in + Drive file sync
site/config.js           Google client ID
scripts/build_navs.py    AMFI → navs.json (run by the workflow)
tracker/nav.py           AMFI parser + fund tax classification
tests/                   browser test runner for engine.js
```
