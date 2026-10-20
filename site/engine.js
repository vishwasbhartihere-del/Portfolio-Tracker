// Portfolio + Indian capital-gains engine. Pure functions, no DOM; dates are ISO "YYYY-MM-DD" strings.
//
// Every holding has a tax class, which decides how its gains are taxed (transfers on/after 23-Jul-2024):
//   equity  listed shares, equity MFs/ETFs, REITs/InvITs   LT after 12m: 12.5% above ₹1.25L; ST: 20%
//   listed  other listed securities: gold/silver/intl ETFs, SGBs, listed bonds   LT after 12m: 12.5%; ST: slab
//   other   unlisted assets: physical gold/silver, foreign shares, hybrid/FoF MFs   LT after 24m: 12.5%; ST: slab
//   debt    debt MFs/ETFs: slab if bought from 1-Apr-2023, else LT after 24m at 12.5%
//   slab    always at slab rate (unlisted bonds, market-linked debentures)
//   vda     crypto / virtual digital assets: flat 30%, losses can't offset anything and don't carry forward
//
// Gains land in buckets: eq_st, eq_lt, oth_lt (12.5%), slab, vda (30%).
// Set-off: ST losses absorb any gain, LT losses only LT gains (never VDA). Set-off is mandatory, so
// losses also eat into equity LTCG that would have been exempt. Leftover losses carry forward 8 years.
// Surcharge and the basic-exemption shortfall adjustment are ignored.

export const DEBT_CUTOFF = "2023-04-01";
export const GRANDFATHER_CUTOFF = "2018-02-01";
export const GRANDFATHER_DATE = "2018-01-31";

export const TAX_CLASSES = ["equity", "listed", "other", "debt", "slab", "vda"];
export const BUCKETS = ["eq_st", "eq_lt", "oth_lt", "slab", "vda"];

export const ASSET_TYPES = {
  mf: { label: "Mutual funds", tax_class: "equity" },
  stock: { label: "Stocks & ETFs", tax_class: "equity" },
  bond: { label: "Bonds", tax_class: "listed" },
  gold: { label: "Gold & silver", tax_class: "other" },
  crypto: { label: "Crypto", tax_class: "vda" },
  foreign: { label: "Foreign stocks", tax_class: "other" },
  other: { label: "Other", tax_class: "other" },
};
// Friendly names accepted in the CSV's asset_type column.
const ASSET_ALIASES = {
  mutual_fund: "mf", mutualfund: "mf", fund: "mf", equity: "stock", share: "stock", shares: "stock", stocks: "stock",
  etf: "stock", reit: "stock", invit: "stock", sgb: "stock", silver: "gold", commodity: "gold", bonds: "bond",
  us_stock: "foreign", us: "foreign", international: "foreign", vda: "crypto",
};

export const DEFAULT_SETTINGS = {
  slab_rate: 30, cess: 4, eq_stcg_rate: 20, ltcg_rate: 12.5, ltcg_exemption: 125000, vda_rate: 30,
  exit_load_pct: 1, // assumed exit load on non-debt mutual fund units held < 1 year
  gold_premium_pct: 6, // Indian gold/silver price over international spot (import duty)
  external: { eq_st: 0, eq_lt: 0, oth_lt: 0, slab: 0, vda: 0 }, // realised elsewhere this FY (losses negative)
  carry_forward: { st: 0, lt: 0 }, // losses brought forward (positive)
  tax_class_overrides: {}, // { key: tax class }
  manual_prices: {}, // { key: { price, date } } for assets without a price feed
};

const EPS = 1e-9;
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const assetKey = (type, symbol) => `${type}:${String(symbol).trim().toUpperCase()}`;

// ---------- dates ----------
const toDays = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const fromDays = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => toDays(b) - toDays(a);
export const addDays = (iso, n) => fromDays(toDays(iso) + n);

export function addMonths(iso, months) {
  let [y, m, d] = iso.split("-").map(Number);
  const total = m - 1 + months;
  y += Math.floor(total / 12);
  m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function fyBounds(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return [`${start}-04-01`, `${start + 1}-03-31`];
}
export const fyLabel = (today) => { const [s, e] = fyBounds(today); return `FY ${s.slice(0, 4)}-${e.slice(2, 4)}`; };

// ---------- tax rules ----------
export function becomesLongTermOn(taxClass, buy) {
  if (taxClass === "slab" || taxClass === "vda") return null;
  if (taxClass === "debt" && buy >= DEBT_CUTOFF) return null;
  const months = taxClass === "equity" || taxClass === "listed" ? 12 : 24;
  // "More than N months": long-term from the day after the N-month anniversary.
  return addDays(addMonths(buy, months), 1);
}

export function bucketFor(taxClass, buy, sell) {
  if (taxClass === "vda") return "vda";
  const lt = becomesLongTermOn(taxClass, buy);
  const isLt = lt !== null && sell >= lt;
  if (taxClass === "equity") return isLt ? "eq_lt" : "eq_st";
  return isLt ? "oth_lt" : "slab";
}
export const isLongTerm = (b) => b === "eq_lt" || b === "oth_lt";
/** Short-term rate for a tax class (used for "wait until long-term" estimates). */
export const shortTermRate = (taxClass, s) => (taxClass === "equity" ? s.eq_stcg_rate : s.slab_rate);

/** amounts: { bucket: number | number[] } signed (positive gain, negative loss). */
export function computeTax(amounts, s, broughtForward = s.carry_forward) {
  const gross = { eq_st: 0, eq_lt: 0, oth_lt: 0, slab: 0, vda: 0 };
  let stLoss = 0, ltLoss = 0, vdaLoss = 0;
  for (const [b, v] of Object.entries(amounts)) {
    for (const x of [].concat(v)) {
      if (x >= 0) gross[b] += x;
      else if (b === "vda") vdaLoss -= x; // disregarded by law
      else if (isLongTerm(b)) ltLoss -= x;
      else stLoss -= x;
    }
  }
  stLoss += Number(broughtForward?.st || 0);
  ltLoss += Number(broughtForward?.lt || 0);
  const losses = { st: stLoss, lt: ltLoss };

  const slab = s.slab_rate / 100, eqSt = s.eq_stcg_rate / 100, lt = s.ltcg_rate / 100;
  const ex = s.ltcg_exemption;
  const remaining = {
    slab: gross.slab, eq_st: gross.eq_st, oth_lt: gross.oth_lt,
    eq_lt_excess: Math.max(0, gross.eq_lt - ex), eq_lt_within: Math.min(gross.eq_lt, ex),
  };
  const rate = { slab, eq_st: eqSt, oth_lt: lt, eq_lt_excess: lt, eq_lt_within: 0 };
  const setoff = [];
  const absorb = (pool, targets, kind) => {
    for (const t of [...targets].sort((a, b) => rate[b] - rate[a])) {
      if (pool <= 0) break;
      const used = Math.min(pool, remaining[t]);
      if (used > 0) { remaining[t] -= used; pool -= used; setoff.push({ loss: kind, against: t, amount: r2(used) }); }
    }
    return pool;
  };
  // LT losses can only hit LT gains; use them first so flexible ST losses stay for higher-taxed buckets.
  const ltLeft = absorb(ltLoss, ["oth_lt", "eq_lt_excess", "eq_lt_within"], "lt");
  const stLeft = absorb(stLoss, Object.keys(remaining), "st");

  const eqLtNet = remaining.eq_lt_excess + remaining.eq_lt_within;
  const taxableEqLt = Math.max(0, eqLtNet - ex);
  const taxable = { slab: remaining.slab, eq_st: remaining.eq_st, oth_lt: remaining.oth_lt, eq_lt: taxableEqLt, vda: gross.vda };
  const cess = 1 + s.cess / 100;
  const taxBy = {
    slab: r2(taxable.slab * slab * cess), eq_st: r2(taxable.eq_st * eqSt * cess),
    oth_lt: r2(taxable.oth_lt * lt * cess), eq_lt: r2(taxable.eq_lt * lt * cess),
    vda: r2(taxable.vda * (s.vda_rate ?? 30) / 100 * cess),
  };
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  return {
    gross: round(gross), losses: round(losses), taxable: round(taxable), vda_loss_ignored: r2(vdaLoss),
    exempt_used: r2(eqLtNet - taxableEqLt), tax_by_bucket: taxBy, tax: r2(sum(Object.values(taxBy))),
    carry_forward: { st: r2(stLeft), lt: r2(ltLeft) }, setoff, eq_lt_net: r2(eqLtNet),
  };
}

export const exemptionHeadroom = (res, s) => Math.max(0, s.ltcg_exemption - res.eq_lt_net);

// ---------- CSV ----------
const BUY_TYPES = new Set(["BUY", "PURCHASE", "SIP", "SWITCH_IN", "SWITCH IN", "SWITCHIN", "REINVEST", "DIV_REINVEST",
  "DIVIDEND_REINVEST", "IDCW_REINVEST", "STP_IN", "STP IN", "BONUS", "DEPOSIT", "TRANSFER_IN", "AIRDROP"]);
const SELL_TYPES = new Set(["SELL", "REDEEM", "REDEMPTION", "SWITCH_OUT", "SWITCH OUT", "SWITCHOUT", "STP_OUT", "STP OUT",
  "SWP", "WITHDRAW", "TRANSFER_OUT"]);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export class LedgerError extends Error {}

function parseDate(raw) {
  const s = (raw || "").trim();
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) [, y, m, d] = x;
  else if ((x = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [, d, m, y] = x;
  else if ((x = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/))) { [, d, , y] = x; m = MONTHS[x[2].toLowerCase()]; }
  [y, m, d] = [Number(y), Number(m), Number(d)];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (!y || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new LedgerError(`unrecognised date '${s}'`);
  }
  return dt.toISOString().slice(0, 10);
}

function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(/[,₹]/g, "");
  if (!t) return null;
  const n = Number(t);
  if (Number.isNaN(n)) throw new LedgerError(`not a number '${s}'`);
  return n;
};

/** Effective per-unit price after fees: fees add to cost on buys and reduce proceeds on sells. */
const effectivePrice = (t) => (t.type === "BUY" ? (t.units * t.price + t.fees) / t.units : (t.units * t.price - t.fees) / t.units);

/**
 * Columns: date, asset_type, symbol, type, quantity, price, [fees], [name], [tax_class]
 * Older mutual-fund CSVs (scheme_code / isin, units, nav, amount) still work.
 * resolveIsin(isin) -> {asset_type, symbol} | null
 */
export function parseCsv(text, resolveIsin = () => null) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!lines[0]?.trim()) throw new LedgerError("CSV is empty");
  const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/[ -]/g, "_"));
  const errors = [], txns = [];
  lines.slice(1).forEach((line, idx) => {
    const rowNo = idx + 2;
    if (!line.trim() || line.trim().startsWith("#")) return;
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
    if (!Object.values(row).some(Boolean)) return;
    try {
      let assetType = (row.asset_type || row.asset || row.category || "").toLowerCase().replace(/[ -]/g, "_");
      let symbol = row.symbol || row.ticker || row.scheme_code || row.code || "";
      if (!assetType && (row.scheme_code || row.code)) assetType = "mf";
      if (!symbol && row.isin) {
        const hit = resolveIsin(row.isin.toUpperCase());
        if (!hit) throw new LedgerError(`unknown ISIN '${row.isin}'`);
        assetType ||= hit.asset_type;
        symbol = hit.symbol;
      }
      assetType = ASSET_ALIASES[assetType] || assetType;
      if (!assetType) throw new LedgerError("missing asset_type");
      if (!ASSET_TYPES[assetType]) throw new LedgerError(`unknown asset_type '${assetType}' (use ${Object.keys(ASSET_TYPES).join(", ")})`);
      if (!symbol) throw new LedgerError("missing symbol");
      let type = (row.type || row.transaction_type || row.action || "BUY").toUpperCase();
      if (BUY_TYPES.has(type)) type = "BUY";
      else if (SELL_TYPES.has(type)) type = "SELL";
      else throw new LedgerError(`unknown type '${type}' (use BUY or SELL)`);
      let units = num(row.quantity ?? row.qty ?? row.units), price = num(row.price ?? row.nav ?? row.rate);
      const amount = num(row.amount);
      if (units == null && amount != null && price) units = amount / price;
      if (price == null && amount != null && units) price = amount / units;
      if (units == null || price == null) throw new LedgerError("need quantity and price (or amount)");
      units = Math.abs(units);
      if (units <= 0) throw new LedgerError("quantity must be > 0");
      if (price < 0) throw new LedgerError("price can't be negative");
      const taxClass = (row.tax_class || "").toLowerCase();
      if (taxClass && !TAX_CLASSES.includes(taxClass)) throw new LedgerError(`unknown tax_class '${taxClass}' (use ${TAX_CLASSES.join(", ")})`);
      symbol = symbol.trim().toUpperCase();
      const t = { date: parseDate(row.date), asset_type: assetType, symbol, key: assetKey(assetType, symbol), type,
        units, price, fees: Math.abs(num(row.fees ?? row.charges ?? row.brokerage) || 0), name: row.name || row.fund_name || "",
        tax_class: taxClass, row: rowNo };
      t.nav = effectivePrice(t);
      txns.push(t);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      errors.push(`row ${rowNo}: ${e.message}`);
    }
  });
  if (errors.length) throw new LedgerError(errors.slice(0, 20).join("; "));
  return sortTxns(txns);
}

/** Upgrade transactions saved by older versions (mutual funds only, keyed by scheme code). */
export function normaliseTxns(txns) {
  return txns.map((t) => {
    if (t.key) return t;
    const asset_type = t.asset_type || "mf", symbol = String(t.symbol || t.code).toUpperCase();
    return { ...t, asset_type, symbol, key: assetKey(asset_type, symbol), price: t.price ?? t.nav, fees: t.fees || 0, tax_class: t.tax_class || "" };
  });
}

// Buys before sells on the same day so same-day round trips work.
export const sortTxns = (txns) => txns.sort((a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : (a.type === "BUY" ? 0 : 1) - (b.type === "BUY" ? 0 : 1) || a.row - b.row);

export const CSV_HEADER = "date,asset_type,symbol,type,quantity,price,fees,name,tax_class";
export function toCsv(txns) {
  const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const n = (x) => String(Math.round(x * 1e8) / 1e8);
  return [CSV_HEADER, ...txns.map((t) => [t.date, t.asset_type, q(t.symbol), t.type, n(t.units), n(t.price), t.fees ? n(t.fees) : "",
    q(t.name || ""), t.tax_class || ""].join(","))].join("\n") + "\n";
}

// ---------- FIFO ledger ----------
/** Consume `units` from `lots` (mutated) FIFO; returns realised gain records. */
export function sellFifo(lots, units, sellDate, sellNav, taxClass, fmv2018 = () => null) {
  const out = [];
  let remaining = units;
  while (remaining > 1e-6) {
    if (!lots.length) throw new LedgerError(`selling more than held (${remaining.toFixed(6)} short)`);
    const lot = lots[0];
    const take = Math.min(lot.units, remaining);
    let cost = take * lot.nav;
    const proceeds = take * sellNav;
    let grandfathered = false;
    if (taxClass === "equity" && lot.buy_date < GRANDFATHER_CUTOFF) {
      const fmv = fmv2018(lot.key);
      if (fmv != null) {
        const gf = Math.max(cost, Math.min(take * fmv, proceeds));
        grandfathered = gf !== cost;
        cost = gf;
      }
    }
    out.push({
      key: lot.key, buy_date: lot.buy_date, sell_date: sellDate, units: take, buy_nav: lot.nav, sell_nav: sellNav,
      cost: r2(cost), proceeds: r2(proceeds), gain: r2(proceeds - cost),
      bucket: bucketFor(taxClass, lot.buy_date, sellDate), grandfathered,
    });
    lot.units -= take;
    remaining -= take;
    if (lot.units <= 1e-6) lots.shift();
  }
  return out;
}

export function buildLedger(txns, taxClassOf, fmv2018) {
  const lots = {}, realized = [];
  for (const t of txns) {
    const book = (lots[t.key] ||= []);
    if (t.type === "BUY") book.push({ key: t.key, buy_date: t.date, units: t.units, nav: t.nav });
    else {
      try {
        realized.push(...sellFifo(book, t.units, t.date, t.nav, taxClassOf(t.key), fmv2018));
      } catch (e) {
        throw new LedgerError(`row ${t.row} (${t.date}, ${t.asset_type} ${t.symbol}): ${e.message}`);
      }
    }
  }
  for (const k of Object.keys(lots)) if (!lots[k].length) delete lots[k];
  return { lots, realized };
}

export function xirr(flows) {
  flows = flows.filter(([, a]) => Math.abs(a) > 1e-9);
  if (flows.length < 2 || flows.every(([, a]) => a >= 0) || flows.every(([, a]) => a <= 0)) return null;
  const t0 = flows.reduce((m, [d]) => (d < m ? d : m), flows[0][0]);
  const ys = flows.map(([d, a]) => [daysBetween(t0, d) / 365, a]);
  if (ys.every(([t]) => t < 30 / 365)) return null; // too short to annualise meaningfully
  const npv = (r) => sum(ys.map(([t, a]) => a / (1 + r) ** t));
  let lo = -0.9999, hi = 10, fLo = npv(lo), mid = 0;
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < 1e-7) break;
    if (fLo * f < 0) hi = mid; else { lo = mid; fLo = f; }
  }
  return mid;
}

// ---------- harvesting ----------
const MIN_BENEFIT = 100, MIN_HARVEST_GAIN = 1000, HOLD_WINDOW_DAYS = 90;
const cloneLots = (lots) => lots.map((l) => ({ ...l }));

function unlockedCount(f, today) {
  if (!f.lock_in_years) return f.lots.length;
  let n = 0;
  for (const lot of f.lots) { if (addMonths(lot.buy_date, 12 * f.lock_in_years) > today) break; n++; }
  return n;
}
const simulate = (f, units, today, fmv) => sellFifo(cloneLots(f.lots), units, today, f.price, f.tax_class, fmv);
// Exit loads only apply to (non-debt) mutual funds.
const exitLoad = (f, sale, today, s) => f.asset_type !== "mf" || f.tax_class === "debt" ? 0
  : sum(sale.filter((r) => daysBetween(r.buy_date, today) < 365).map((r) => r.proceeds * s.exit_load_pct / 100));
const withSale = (base, sale) => {
  const out = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
  for (const r of sale) (out[r.bucket] ||= []).push(r.gain);
  return out;
};
const saleSummary = (f, units, sale) => {
  const by = {};
  for (const r of sale) by[r.bucket] = r2((by[r.bucket] || 0) + r.gain);
  return { key: f.key, name: f.name, asset_type: f.asset_type, tax_class: f.tax_class, units: Math.round(units * 1e6) / 1e6,
    price: f.price, amount: r2(sum(sale.map((r) => r.proceeds))), gain: r2(sum(sale.map((r) => r.gain))), by_bucket: by, lots: sale.length };
};
// Fractional units are fine for mutual funds and crypto; shares and bonds trade in whole units.
const roundDownUnits = (f, u) => (["stock", "bond"].includes(f.asset_type) ? Math.floor(u + 1e-9) : Math.floor(u * 1000) / 1000);

/** assets: [{key, name, asset_type, price, tax_class, lock_in_years, lots}] */
export function suggest(assets, baseIn, s, today, fmv = () => null) {
  const base = Object.fromEntries(Object.entries(baseIn).map(([k, v]) => [k, [...v]]));
  const start = computeTax(base, s);
  let current = start;
  const used = new Set(), loss = [], carry = [], gain = [], holds = [], notes = [];
  const cess = 1 + s.cess / 100;
  const addToBase = (sale) => { for (const r of sale) (base[r.bucket] ||= []).push(r.gain); };
  const harvestable = assets.filter((f) => f.tax_class !== "vda" && f.price > 0);

  // 1. Loss harvesting: greedy, best saving first, re-evaluated after each pick.
  for (;;) {
    let best = null;
    for (const f of harvestable) {
      if (used.has(f.key)) continue;
      let cum = 0;
      for (let i = 0; i < unlockedCount(f, today); i++) {
        cum += f.lots[i].units;
        const sale = simulate(f, cum, today, fmv);
        if (!sale.some((r) => r.gain < 0)) continue;
        const res = computeTax(withSale(base, sale), s);
        const load = exitLoad(f, sale, today, s);
        const net = current.tax - res.tax - load;
        if (!best || net > best.net) best = { net, f, units: cum, sale, res, load };
      }
    }
    if (!best || best.net < MIN_BENEFIT) break;
    loss.push({ ...saleSummary(best.f, best.units, best.sale), tax_saved: r2(current.tax - best.res.tax),
      exit_load: r2(best.load), net_benefit: r2(best.net),
      why: "Books losses that offset gains you've already realised this FY." });
    addToBase(best.sale);
    current = best.res;
    used.add(best.f.key);
  }

  // 2. Losses worth banking for later years (no saving this FY).
  for (const f of harvestable) {
    if (used.has(f.key)) continue;
    let best = null, cum = 0;
    for (let i = 0; i < unlockedCount(f, today); i++) {
      cum += f.lots[i].units;
      const sale = simulate(f, cum, today, fmv);
      const res = computeTax(withSale(base, sale), s);
      if (res.tax > current.tax + 1) continue;
      const added = { st: res.carry_forward.st - current.carry_forward.st, lt: res.carry_forward.lt - current.carry_forward.lt };
      const future = (added.st * s.eq_stcg_rate + added.lt * s.ltcg_rate) / 100 * cess;
      const load = exitLoad(f, sale, today, s);
      if (!best || future - load > best.value) best = { value: future - load, units: cum, sale, added, load };
    }
    if (best && best.value >= 1000) {
      carry.push({ ...saleSummary(f, best.units, best.sale), carry_forward_added: { st: r2(best.added.st), lt: r2(best.added.lt) },
        future_value: r2(best.value + best.load), exit_load: r2(best.load), net_benefit: r2(best.value),
        why: "No gains to offset this year, but the loss carries forward 8 years (file your ITR on time). Mostly useful if you expect big gains later." });
    }
  }

  // 3. Gain harvesting into the equity LTCG exemption.
  let headroom = exemptionHeadroom(current, s);
  const leftover = current.carry_forward.st + current.carry_forward.lt;
  if (leftover > 0 && headroom > 0) {
    notes.push(`You have ₹${Math.round(leftover).toLocaleString("en-IN")} of unabsorbed losses. Set-off is mandatory, so harvesting gains will use those losses up before the exemption; consider carrying them forward instead.`);
    headroom = 0;
  }
  const candidates = [];
  for (const f of harvestable) {
    if (f.tax_class !== "equity" || used.has(f.key)) continue;
    let units = 0, g = 0;
    const steps = [];
    for (let i = 0; i < unlockedCount(f, today); i++) {
      const lot = f.lots[i];
      if (bucketFor("equity", lot.buy_date, today) !== "eq_lt") break; // FIFO stops at the first short-term lot
      const r = sellFifo([{ ...lot }], lot.units, today, f.price, "equity", fmv)[0];
      steps.push([lot.units, r.gain]);
      units += lot.units; g += r.gain;
    }
    if (g > 0 && units > 0) candidates.push({ score: g / (units * f.price), f, steps });
  }
  // Most gain per rupee sold first (least churn); lock-in funds last since reinvesting restarts the lock.
  candidates.sort((a, b) => (a.f.lock_in_years > 0) - (b.f.lock_in_years > 0) || b.score - a.score);
  for (const { f, steps } of candidates) {
    if (headroom < MIN_HARVEST_GAIN) break;
    let units = 0, g = 0;
    for (const [lu, lg] of steps) {
      if (g + lg <= headroom) { units += lu; g += lg; continue; }
      if (lg > 0) units += lu * (headroom - g) / lg; // partial lot lands exactly on the headroom
      break;
    }
    units = roundDownUnits(f, units); // round down so we never overshoot
    if (units <= 0) continue;
    const sale = simulate(f, units, today, fmv);
    const booked = sum(sale.map((r) => r.gain));
    if (booked < MIN_HARVEST_GAIN) continue;
    const res = computeTax(withSale(base, sale), s);
    if (res.tax > current.tax + 1) continue;
    let why = "Books long-term gains inside this year's tax-free limit. Buy back the same day to reset your cost higher (the new units start a fresh 12-month clock).";
    if (f.lock_in_years) why += ` Reinvesting into this fund locks the money for another ${f.lock_in_years} years; consider a similar fund without a lock-in.`;
    gain.push({ ...saleSummary(f, units, sale), tax_now: r2(res.tax - current.tax),
      future_tax_saved: r2(booked * s.ltcg_rate / 100 * cess), why });
    addToBase(sale);
    current = res;
    headroom = exemptionHeadroom(current, s);
  }

  // 4. Hold alerts: profitable short-term lots that turn long-term soon.
  for (const f of assets) {
    for (const lot of f.lots) {
      const ltOn = becomesLongTermOn(f.tax_class, lot.buy_date);
      if (!ltOn || ltOn <= today || daysBetween(today, ltOn) > HOLD_WINDOW_DAYS) continue;
      const g = lot.units * (f.price - lot.nav);
      if (g <= 0) continue;
      holds.push({ key: f.key, name: f.name, buy_date: lot.buy_date, units: Math.round(lot.units * 1e6) / 1e6,
        gain: r2(g), long_term_on: ltOn, days_left: daysBetween(today, ltOn),
        extra_tax_if_sold_now: r2(g * (shortTermRate(f.tax_class, s) - s.ltcg_rate) / 100 * cess) });
    }
  }
  holds.sort((a, b) => a.days_left - b.days_left);

  const [, fyEnd] = fyBounds(today);
  return {
    fy: fyLabel(today), fy_end: fyEnd, days_left_in_fy: daysBetween(today, fyEnd),
    tax_before: start.tax, tax_after: current.tax,
    exemption_headroom_before: r2(exemptionHeadroom(start, s)), exemption_headroom_after: r2(headroom),
    loss_harvest: loss, gain_harvest: gain, carry_forward: carry, hold_alerts: holds, notes,
  };
}

// ---------- report ----------
/**
 * quotes: { key: {price, price_date, name, tax_class, lock_in_years, category, source} } — any feed that knows the asset.
 * Holdings without a quote fall back to a manual price, then to the last transaction price (flagged as stale).
 * fmv2018: { key: price on 31-Jan-2018 } for grandfathering pre-2018 equity.
 */
export function buildReport({ txns, quotes = {}, settings: s, fmv2018 = {}, today = todayISO() }) {
  const warnings = [];
  const overrides = s.tax_class_overrides || {};
  const last = {}, csvClass = {};
  for (const t of txns) { last[t.key] = t; if (t.tax_class) csvClass[t.key] = t.tax_class; }
  const taxClassOf = (key) => overrides[key] || csvClass[key] || quotes[key]?.tax_class
    || ASSET_TYPES[last[key]?.asset_type]?.tax_class || "other";
  const fmv = (key) => fmv2018[key] ?? null;
  const { lots, realized } = buildLedger(txns, taxClassOf, fmv);
  const flowsOf = (key) => txns.filter((t) => t.key === key).map((t) => [t.date, t.type === "BUY" ? -t.units * t.nav : t.units * t.nav]);

  const holdings = [], assets = [];
  let allFlows = [];
  for (const [key, assetLots] of Object.entries(lots)) {
    const t = last[key];
    const q = quotes[key];
    const manual = s.manual_prices?.[key];
    let price, priceDate, source;
    if (manual && (!q || manual.date >= q.price_date)) [price, priceDate, source] = [Number(manual.price), manual.date, "manual"];
    else if (q) [price, priceDate, source] = [q.price, q.price_date, q.source || "feed"];
    else {
      const lastTrade = [...txns].reverse().find((x) => x.key === key);
      [price, priceDate, source] = [lastTrade.price, lastTrade.date, "last trade"];
    }
    const name = q?.name || t.name || t.symbol;
    const lock = q?.lock_in_years || 0;
    const tc = taxClassOf(key);
    assets.push({ key, name, asset_type: t.asset_type, price, tax_class: tc, lock_in_years: lock, lots: assetLots });

    let st = 0, lt = 0;
    const lotRows = assetLots.map((lot) => {
      const r = sellFifo([{ ...lot }], lot.units, today, price, tc, fmv)[0];
      if (isLongTerm(r.bucket)) lt += r.gain; else st += r.gain;
      const lockedUntil = lock ? addMonths(lot.buy_date, 12 * lock) : null;
      return { buy_date: lot.buy_date, units: lot.units, nav: lot.nav, cost: r2(lot.units * lot.nav), tax_cost: r.cost,
        value: r.proceeds, gain: r.gain, bucket: r.bucket, long_term_on: becomesLongTermOn(tc, lot.buy_date),
        locked_until: lockedUntil && lockedUntil > today ? lockedUntil : null };
    });
    const units = sum(assetLots.map((l) => l.units));
    const invested = sum(assetLots.map((l) => l.units * l.nav));
    const value = units * price;
    const flows = flowsOf(key);
    allFlows = allFlows.concat(flows);
    holdings.push({
      key, symbol: t.symbol, asset_type: t.asset_type, name, category: q?.category || ASSET_TYPES[t.asset_type].label,
      tax_class: tc, tax_class_overridden: key in overrides, units, avg_price: units ? invested / units : 0,
      price, price_date: priceDate, price_source: source, stale: source === "last trade" || daysBetween(priceDate, today) > 7,
      invested: r2(invested), value: r2(value), gain: r2(value - invested),
      gain_pct: invested ? r2((value / invested - 1) * 100) : 0, st_gain: r2(st), lt_gain: r2(lt),
      xirr: pct(xirr([...flows, [today, value]])), lock_in_years: lock, lots: lotRows,
    });
  }
  holdings.sort((a, b) => b.value - a.value);
  const noPrice = holdings.filter((h) => h.price_source === "last trade");
  if (noPrice.length) warnings.push(`No live price for ${noPrice.map((h) => h.symbol).join(", ")}; using the last transaction price. Set one under Settings → Manual prices.`);
  for (const key of new Set(txns.map((t) => t.key))) if (!lots[key]) allFlows = allFlows.concat(flowsOf(key));

  const value = sum(holdings.map((h) => h.value)), invested = sum(holdings.map((h) => h.invested));
  const [fyStart, fyEnd] = fyBounds(today);
  const fyRealized = realized.filter((r) => r.sell_date >= fyStart && r.sell_date <= fyEnd);
  const base = {};
  for (const r of fyRealized) (base[r.bucket] ||= []).push(r.gain);
  for (const [b, v] of Object.entries(s.external || {})) if (v) (base[b] ||= []).push(Number(v));
  const nameOf = (k) => quotes[k]?.name || last[k]?.name || last[k]?.symbol || k;

  const byType = {};
  for (const h of holdings) {
    const g = (byType[h.asset_type] ||= { asset_type: h.asset_type, label: ASSET_TYPES[h.asset_type].label, value: 0, invested: 0, count: 0 });
    g.value += h.value; g.invested += h.invested; g.count++;
  }
  return {
    today, fy: fyLabel(today),
    summary: {
      invested: r2(invested), value: r2(value), gain: r2(value - invested),
      gain_pct: invested ? r2((value / invested - 1) * 100) : 0, xirr: pct(xirr([...allFlows, [today, value]])),
      st_gain: r2(sum(holdings.map((h) => h.st_gain))), lt_gain: r2(sum(holdings.map((h) => h.lt_gain))),
      holdings: holdings.length, transactions: txns.length,
    },
    holdings,
    allocation: Object.values(byType).sort((a, b) => b.value - a.value).map((g) => ({
      ...g, value: r2(g.value), invested: r2(g.invested), gain: r2(g.value - g.invested), pct: value ? r2((g.value / value) * 100) : 0,
    })),
    realized_fy: fyRealized.map((r) => ({ ...r, name: nameOf(r.key) })),
    realized_all_time: r2(sum(realized.map((r) => r.gain))),
    tax: computeTax(base, s),
    harvest: suggest(assets, base, s, today, fmv),
    settings: s,
    warnings,
  };
}

const pct = (x) => (x == null ? null : r2(x * 100));

/** Mutual-fund holdings bought before 1-Feb-2018 need the 31-Jan-2018 NAV for grandfathering. */
export function keysNeedingFmv(txns) {
  return [...new Set(txns.filter((t) => t.type === "BUY" && t.asset_type === "mf" && t.date < GRANDFATHER_CUTOFF).map((t) => t.key))];
}
