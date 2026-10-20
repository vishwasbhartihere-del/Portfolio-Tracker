// Price feeds. Everything here runs in the browser against CORS-enabled sources, except the two
// static files the nightly GitHub Action builds (navs.json for mutual funds, stocks.json for NSE/BSE).
//
//   mf       navs.json (AMFI, nightly)  + api.mfapi.in for fresher NAVs of held funds
//   stock    stocks.json (NSE/BSE bhavcopy, nightly; shares, ETFs, REITs, SGBs, listed bonds)
//   bond     stocks.json when the bond is listed, else a manual price
//   gold     api.gold-api.com spot (INR/oz) -> per gram × purity × (1 + Indian premium)
//   crypto   api.coingecko.com (INR)
//   foreign, other  manual prices (Settings)
import { GRANDFATHER_DATE } from "./engine.js";

const MFAPI = "https://api.mfapi.in/mf/";
const GOLD_API = "https://api.gold-api.com/price/";
const COINGECKO = "https://api.coingecko.com/api/v3/";
const OZ_GRAMS = 31.1034768;
const LIVE_KEY = "pt.live", FMV_KEY = "pt.fmv2018", COIN_IDS_KEY = "pt.coinIds";

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const dmyToIso = (s) => { const [d, m, y] = s.split("-"); return `${y}-${m}-${d}`; };
const todayIso = () => new Date().toISOString().slice(0, 10);

export const METALS = {
  GOLD: ["XAU", 0.999, "Gold 24K (per gram)"], GOLD24: ["XAU", 0.999, "Gold 24K (per gram)"], GOLD24K: ["XAU", 0.999, "Gold 24K (per gram)"],
  XAU: ["XAU", 0.999, "Gold 24K (per gram)"], GOLD22: ["XAU", 0.916, "Gold 22K (per gram)"], GOLD22K: ["XAU", 0.916, "Gold 22K (per gram)"],
  GOLD18: ["XAU", 0.75, "Gold 18K (per gram)"], GOLD18K: ["XAU", 0.75, "Gold 18K (per gram)"],
  SILVER: ["XAG", 0.999, "Silver (per gram)"], XAG: ["XAG", 0.999, "Silver (per gram)"], SILVER999: ["XAG", 0.999, "Silver (per gram)"],
};

const COIN_IDS = {
  BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin", SOL: "solana", XRP: "ripple", USDC: "usd-coin",
  DOGE: "dogecoin", ADA: "cardano", TRX: "tron", TON: "the-open-network", AVAX: "avalanche-2", SHIB: "shiba-inu",
  DOT: "polkadot", LINK: "chainlink", MATIC: "matic-network", POL: "polygon-ecosystem-token", LTC: "litecoin",
  BCH: "bitcoin-cash", NEAR: "near", UNI: "uniswap", XLM: "stellar", ATOM: "cosmos", ETC: "ethereum-classic",
  APT: "aptos", ARB: "arbitrum", OP: "optimism", PEPE: "pepe", SUI: "sui", INJ: "injective-protocol",
};

// ---------- static feeds ----------
export const feeds = { schemes: {}, stocks: {}, stockAlias: {}, isin: {}, navsAt: null, stocksAt: null, errors: [] };

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
const rowsToObjects = (data, rowsKey) => {
  const idx = data.fields.map((f, i) => [f, i]);
  return data[rowsKey].map((row) => Object.fromEntries(idx.map(([f, i]) => [f, row[i]])));
};

export async function loadFeeds() {
  const [navs, stocks] = await Promise.allSettled([loadJson("navs.json"), loadJson("stocks.json")]);
  if (navs.status === "fulfilled") {
    feeds.navsAt = navs.value.generated;
    for (const s of rowsToObjects(navs.value, "schemes")) {
      feeds.schemes[s.code] = s;
      for (const i of [s.isin_growth, s.isin_reinvest]) if (i) feeds.isin[i] = { asset_type: "mf", symbol: s.code };
    }
  } else feeds.errors.push("Mutual fund NAV list didn't load; fund prices may be missing.");
  if (stocks.status === "fulfilled") {
    feeds.stocksAt = stocks.value.generated;
    for (const s of rowsToObjects(stocks.value, "rows")) {
      feeds.stocks[s.symbol] = s;
      if (s.bse_code) feeds.stockAlias[s.bse_code] = s.symbol;
      if (s.isin) { feeds.stockAlias[s.isin] = s.symbol; feeds.isin[s.isin] = { asset_type: "stock", symbol: s.symbol }; } // ETFs: exchange price wins
    }
  } else feeds.errors.push("Stock price list didn't load; stock prices may be missing.");
}

const stockRow = (symbol) => feeds.stocks[symbol] || feeds.stocks[feeds.stockAlias[symbol]];

// ---------- live feeds (cached in localStorage) ----------
const MAX_AGE = { mf: 3 * 3600e3, gold: 15 * 60e3, crypto: 5 * 60e3 };

/** Refresh live prices for the holdings that need them. force=true ignores the cache age. */
export async function refreshLive(txns, force = false) {
  const live = read(LIVE_KEY, {});
  const fresh = (key, type) => !force && live[key] && Date.now() - live[key].fetched < MAX_AGE[type];
  const keys = [...new Map(txns.map((t) => [t.key, t])).values()];
  const jobs = [];

  for (const t of keys.filter((t) => t.asset_type === "mf" && !fresh(t.key, "mf"))) {
    jobs.push(fetch(`${MFAPI}${encodeURIComponent(t.symbol)}/latest`).then((r) => r.json()).then((j) => {
      const row = j.data?.[0];
      if (row) live[t.key] = { price: Number(row.nav), price_date: dmyToIso(row.date), source: "mfapi.in", fetched: Date.now() };
    }).catch(() => {}));
  }

  const metals = keys.filter((t) => t.asset_type === "gold" && METALS[t.symbol] && !fresh(t.key, "gold"));
  if (metals.length) {
    for (const metal of new Set(metals.map((t) => METALS[t.symbol][0]))) {
      jobs.push(fetch(`${GOLD_API}${metal}/INR`).then((r) => r.json()).then((j) => {
        if (!j.price) return;
        live[`metal:${metal}`] = { price: j.price, price_date: (j.updatedAt || todayIso()).slice(0, 10), fetched: Date.now() };
        for (const t of metals.filter((m) => METALS[m.symbol][0] === metal)) live[t.key] = { metal, fetched: Date.now() };
      }).catch(() => {}));
    }
  }

  const coins = keys.filter((t) => t.asset_type === "crypto" && !fresh(t.key, "crypto"));
  if (coins.length) {
    jobs.push((async () => {
      const ids = read(COIN_IDS_KEY, {});
      for (const t of coins) ids[t.symbol] ||= COIN_IDS[t.symbol] || (await searchCoinId(t.symbol)) || t.symbol.toLowerCase();
      write(COIN_IDS_KEY, ids);
      const list = [...new Set(coins.map((t) => ids[t.symbol]))].join(",");
      const j = await (await fetch(`${COINGECKO}simple/price?ids=${encodeURIComponent(list)}&vs_currencies=inr&include_last_updated_at=true`)).json();
      for (const t of coins) {
        const q = j[ids[t.symbol]];
        if (q?.inr != null) live[t.key] = { price: q.inr, price_date: new Date((q.last_updated_at || Date.now() / 1000) * 1000).toISOString().slice(0, 10), coin: ids[t.symbol], source: "CoinGecko", fetched: Date.now() };
      }
    })().catch(() => {}));
  }

  await Promise.all(jobs);
  write(LIVE_KEY, live);
}

async function searchCoinId(symbol) {
  try {
    const j = await (await fetch(`${COINGECKO}search?query=${encodeURIComponent(symbol)}`)).json();
    return (j.coins || []).find((c) => c.symbol.toUpperCase() === symbol)?.id || null;
  } catch { return null; }
}

export async function searchCoins(q) {
  const j = await (await fetch(`${COINGECKO}search?query=${encodeURIComponent(q)}`)).json();
  return (j.coins || []).slice(0, 10).map((c) => ({ symbol: c.symbol.toUpperCase(), name: c.name, id: c.id }));
}

/** Build the engine's quote map for every asset in the transactions. */
export function quotesFor(txns, settings) {
  const live = read(LIVE_KEY, {});
  const quotes = {};
  for (const t of new Map(txns.map((x) => [x.key, x])).values()) {
    const l = live[t.key];
    if (t.asset_type === "mf") {
      const s = feeds.schemes[t.symbol];
      if (!s && !l) continue;
      const newer = l && (!s || l.price_date > s.nav_date);
      quotes[t.key] = { name: s?.name, tax_class: s?.tax_class, lock_in_years: s?.lock_in_years || 0, category: s?.category,
        price: newer ? l.price : s.nav, price_date: newer ? l.price_date : s.nav_date, source: newer ? "mfapi.in" : "AMFI" };
    } else if (t.asset_type === "stock" || t.asset_type === "bond") {
      const s = stockRow(t.symbol);
      if (s) quotes[t.key] = { name: s.name, tax_class: s.tax_class, category: s.exchange, price: s.price, price_date: s.date, source: `${s.exchange} close` };
    } else if (t.asset_type === "gold" && METALS[t.symbol] && l?.metal) {
      const m = live[`metal:${l.metal}`];
      const [, purity, name] = METALS[t.symbol];
      if (m) quotes[t.key] = { name, price: (m.price / OZ_GRAMS) * purity * (1 + (settings.gold_premium_pct || 0) / 100),
        price_date: m.price_date, source: "gold-api.com" };
    } else if (t.asset_type === "crypto" && l) {
      quotes[t.key] = { price: l.price, price_date: l.price_date, source: "CoinGecko" };
    }
  }
  return quotes;
}

/** 31-Jan-2018 NAVs for pre-2018 mutual-fund lots (grandfathering). */
export async function fmvFor(keys) {
  const fmv = read(FMV_KEY, {});
  await Promise.all(keys.filter((k) => !(k in fmv)).map(async (key) => {
    try {
      const j = await (await fetch(`${MFAPI}${encodeURIComponent(key.split(":")[1])}`)).json();
      let best = null;
      for (const r of j.data || []) {
        const iso = dmyToIso(r.date);
        if (iso <= GRANDFATHER_DATE && (!best || iso > best[0])) best = [iso, Number(r.nav)];
      }
      fmv[key] = best ? best[1] : null;
    } catch { /* retry next time */ }
  }));
  write(FMV_KEY, fmv);
  return Object.fromEntries(Object.entries(fmv).filter(([, v]) => v != null));
}

export function clearPriceCache() {
  for (const k of [LIVE_KEY, FMV_KEY, COIN_IDS_KEY]) localStorage.removeItem(k);
}
