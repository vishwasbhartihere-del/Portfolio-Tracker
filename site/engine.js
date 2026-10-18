// Portfolio + Indian capital-gains engine. Pure functions, no DOM; dates are ISO "YYYY-MM-DD" strings.
//
// Tax buckets (transfers on/after 23-Jul-2024):
//   eq_st   equity-oriented, held <= 12 months             -> 20%
//   eq_lt   equity-oriented, held  > 12 months             -> 12.5% above the yearly exemption
//   oth_lt  non-equity held > 24 months (debt only if bought before 1-Apr-2023) -> 12.5%
//   slab    debt bought from 1-Apr-2023 (any holding), other short-term -> slab rate
// Set-off: ST losses absorb any gain, LT losses only LT gains. Set-off is mandatory, so losses
// also eat into equity LTCG that would have been exempt. Leftover losses carry forward 8 years.
// Surcharge and the basic-exemption shortfall adjustment are ignored.

export const DEBT_CUTOFF = "2023-04-01";
export const GRANDFATHER_CUTOFF = "2018-02-01";
export const GRANDFATHER_DATE = "2018-01-31";

export const DEFAULT_SETTINGS = {
  slab_rate: 30, cess: 4, eq_stcg_rate: 20, ltcg_rate: 12.5, ltcg_exemption: 125000,
  exit_load_pct: 1, // assumed exit load on equity/other units held < 1 year
  external: { eq_st: 0, eq_lt: 0, oth_lt: 0, slab: 0 }, // realised elsewhere this FY (losses negative)
  carry_forward: { st: 0, lt: 0 }, // losses brought forward (positive)
  tax_class_overrides: {}, // { code: "equity" | "debt" | "other" }
};

export const BUCKETS = ["eq_st", "eq_lt", "oth_lt", "slab"];
const EPS = 1e-6;
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

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
  if (taxClass === "debt" && buy >= DEBT_CUTOFF) return null;
  // "More than N months": long-term from the day after the N-month anniversary.
  return addDays(addMonths(buy, taxClass === "equity" ? 12 : 24), 1);
}

export function bucketFor(taxClass, buy, sell) {
  const lt = becomesLongTermOn(taxClass, buy);
  const isLt = lt !== null && sell >= lt;
  if (taxClass === "equity") return isLt ? "eq_lt" : "eq_st";
  return isLt ? "oth_lt" : "slab";
}
export const isLongTerm = (b) => b === "eq_lt" || b === "oth_lt";

/** amounts: { bucket: number | number[] } signed (positive gain, negative loss). */
export function computeTax(amounts, s, broughtForward = s.carry_forward) {
  const gross = { eq_st: 0, eq_lt: 0, oth_lt: 0, slab: 0 };
  let stLoss = 0, ltLoss = 0;
  for (const [b, v] of Object.entries(amounts)) {
    for (const x of [].concat(v)) {
      if (x >= 0) gross[b] += x;
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
  const taxable = { slab: remaining.slab, eq_st: remaining.eq_st, oth_lt: remaining.oth_lt, eq_lt: taxableEqLt };
  const cess = 1 + s.cess / 100;
  const taxBy = {
    slab: r2(taxable.slab * slab * cess), eq_st: r2(taxable.eq_st * eqSt * cess),
    oth_lt: r2(taxable.oth_lt * lt * cess), eq_lt: r2(taxable.eq_lt * lt * cess),
  };
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  return {
    gross: round(gross), losses: round(losses), taxable: round(taxable),
    exempt_used: r2(eqLtNet - taxableEqLt), tax_by_bucket: taxBy, tax: r2(sum(Object.values(taxBy))),
    carry_forward: { st: r2(stLeft), lt: r2(ltLeft) }, setoff, eq_lt_net: r2(eqLtNet),
  };
}

export const exemptionHeadroom = (res, s) => Math.max(0, s.ltcg_exemption - res.eq_lt_net);

// ---------- CSV + FIFO ledger ----------
const BUY_TYPES = new Set(["BUY", "PURCHASE", "SIP", "SWITCH_IN", "SWITCH IN", "SWITCHIN", "REINVEST", "DIV_REINVEST",
  "DIVIDEND_REINVEST", "IDCW_REINVEST", "STP_IN", "STP IN", "BONUS"]);
const SELL_TYPES = new Set(["SELL", "REDEEM", "REDEMPTION", "SWITCH_OUT", "SWITCH OUT", "SWITCHOUT", "STP_OUT", "STP OUT", "SWP"]);
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

export function parseCsv(text, resolveIsin = () => null) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!lines[0]?.trim()) throw new LedgerError("CSV is empty");
  const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/ /g, "_"));
  const errors = [], txns = [];
  lines.slice(1).forEach((line, idx) => {
    const rowNo = idx + 2;
    if (!line.trim()) return;
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
    if (!Object.values(row).some(Boolean)) return;
    try {
      let code = row.scheme_code || row.code || "";
      if (!code && row.isin) {
        code = resolveIsin(row.isin.toUpperCase()) || "";
        if (!code) throw new LedgerError(`unknown ISIN '${row.isin}'`);
      }
      if (!code) throw new LedgerError("missing scheme_code / isin");
      let type = (row.type || row.transaction_type || "BUY").toUpperCase();
      if (BUY_TYPES.has(type)) type = "BUY";
      else if (SELL_TYPES.has(type)) type = "SELL";
      else throw new LedgerError(`unknown type '${type}'`);
      let units = num(row.units), nav = num(row.nav || row.price);
      const amount = num(row.amount);
      if (units == null && amount != null && nav) units = amount / nav;
      if (nav == null && amount != null && units) nav = amount / units;
      if (units == null || nav == null) throw new LedgerError("need units and nav (or amount)");
      units = Math.abs(units);
      if (units <= 0) throw new LedgerError("units must be > 0");
      txns.push({ date: parseDate(row.date), code, type, units, nav, name: row.fund_name || row.name || "", row: rowNo });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      errors.push(`row ${rowNo}: ${e.message}`);
    }
  });
  if (errors.length) throw new LedgerError(errors.slice(0, 20).join("; "));
  return sortTxns(txns);
}

// Buys before sells on the same day so same-day round trips work.
export const sortTxns = (txns) => txns.sort((a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : (a.type === "BUY" ? 0 : 1) - (b.type === "BUY" ? 0 : 1) || a.row - b.row);

export function toCsv(txns) {
  const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["date,scheme_code,fund_name,type,units,nav",
    ...txns.map((t) => [t.date, t.code, q(t.name || ""), t.type, t.units.toFixed(4), t.nav.toFixed(4)].join(","))].join("\n") + "\n";
}

/** Consume `units` from `lots` (mutated) FIFO; returns realised gain records. */
export function sellFifo(lots, units, sellDate, sellNav, taxClass, fmv2018 = () => null) {
  const out = [];
  let remaining = units;
  while (remaining > EPS) {
    if (!lots.length) throw new LedgerError(`selling more units than held (${remaining.toFixed(4)} short)`);
    const lot = lots[0];
    const take = Math.min(lot.units, remaining);
    let cost = take * lot.nav;
    const proceeds = take * sellNav;
    let grandfathered = false;
    if (taxClass === "equity" && lot.buy_date < GRANDFATHER_CUTOFF) {
      const fmv = fmv2018(lot.code);
      if (fmv != null) {
        const gf = Math.max(cost, Math.min(take * fmv, proceeds));
        grandfathered = gf !== cost;
        cost = gf;
      }
    }
    out.push({
      code: lot.code, buy_date: lot.buy_date, sell_date: sellDate, units: take, buy_nav: lot.nav, sell_nav: sellNav,
      cost: r2(cost), proceeds: r2(proceeds), gain: r2(proceeds - cost),
      bucket: bucketFor(taxClass, lot.buy_date, sellDate), grandfathered,
    });
    lot.units -= take;
    remaining -= take;
    if (lot.units <= EPS) lots.shift();
  }
  return out;
}

export function buildLedger(txns, taxClassOf, fmv2018) {
  const lots = {}, realized = [];
  for (const t of txns) {
    const book = (lots[t.code] ||= []);
    if (t.type === "BUY") book.push({ code: t.code, buy_date: t.date, units: t.units, nav: t.nav });
    else {
      try {
        realized.push(...sellFifo(book, t.units, t.date, t.nav, taxClassOf(t.code), fmv2018));
      } catch (e) {
        throw new LedgerError(`row ${t.row} (${t.date}, scheme ${t.code}): ${e.message}`);
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
const simulate = (f, units, today, fmv) => sellFifo(cloneLots(f.lots), units, today, f.nav, f.tax_class, fmv);
const exitLoad = (f, sale, today, s) => f.tax_class === "debt" ? 0
  : sum(sale.filter((r) => daysBetween(r.buy_date, today) < 365).map((r) => r.proceeds * s.exit_load_pct / 100));
const withSale = (base, sale) => {
  const out = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
  for (const r of sale) (out[r.bucket] ||= []).push(r.gain);
  return out;
};
const saleSummary = (f, units, sale) => {
  const by = {};
  for (const r of sale) by[r.bucket] = r2((by[r.bucket] || 0) + r.gain);
  return { code: f.code, name: f.name, tax_class: f.tax_class, units: Math.round(units * 1000) / 1000, nav: f.nav,
    amount: r2(sum(sale.map((r) => r.proceeds))), gain: r2(sum(sale.map((r) => r.gain))), by_bucket: by, lots: sale.length };
};

/** funds: [{code, name, nav, tax_class, lock_in_years, lots}] */
export function suggest(funds, baseIn, s, today, fmv = () => null) {
  let base = Object.fromEntries(Object.entries(baseIn).map(([k, v]) => [k, [...v]]));
  const start = computeTax(base, s);
  let current = start;
  const used = new Set(), loss = [], carry = [], gain = [], holds = [], notes = [];
  const cess = 1 + s.cess / 100;
  const addToBase = (sale) => { for (const r of sale) (base[r.bucket] ||= []).push(r.gain); };

  // 1. Loss harvesting: greedy, best saving first, re-evaluated after each pick.
  for (;;) {
    let best = null;
    for (const f of funds) {
      if (used.has(f.code)) continue;
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
    used.add(best.f.code);
  }

  // 2. Losses worth banking for later years (no saving this FY).
  for (const f of funds) {
    if (used.has(f.code)) continue;
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
  for (const f of funds) {
    if (f.tax_class !== "equity" || used.has(f.code)) continue;
    let units = 0, g = 0;
    const steps = [];
    for (let i = 0; i < unlockedCount(f, today); i++) {
      const lot = f.lots[i];
      if (bucketFor("equity", lot.buy_date, today) !== "eq_lt") break; // FIFO stops at first short-term lot
      const r = sellFifo([{ ...lot }], lot.units, today, f.nav, "equity", fmv)[0];
      steps.push([lot.units, r.gain]);
      units += lot.units; g += r.gain;
    }
    if (g > 0 && units > 0) candidates.push({ score: g / (units * f.nav), f, steps });
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
    units = Math.floor(units * 1000) / 1000; // round down so we never overshoot
    if (units <= 0) continue;
    const sale = simulate(f, units, today, fmv);
    const booked = sum(sale.map((r) => r.gain));
    if (booked < MIN_HARVEST_GAIN) continue;
    const res = computeTax(withSale(base, sale), s);
    if (res.tax > current.tax + 1) continue;
    let why = "Books long-term gains inside this year's tax-free limit. Reinvest the same day to reset your cost basis higher (the new units start a fresh 12-month clock).";
    if (f.lock_in_years) why += ` Reinvesting into this fund locks the money for another ${f.lock_in_years} years; consider a similar fund without a lock-in.`;
    gain.push({ ...saleSummary(f, units, sale), tax_now: r2(res.tax - current.tax),
      future_tax_saved: r2(booked * s.ltcg_rate / 100 * cess), why });
    addToBase(sale);
    current = res;
    headroom = exemptionHeadroom(current, s);
  }

  // 4. Hold alerts: profitable short-term lots that turn long-term soon.
  for (const f of funds) {
    for (const lot of f.lots) {
      const ltOn = becomesLongTermOn(f.tax_class, lot.buy_date);
      if (!ltOn || ltOn <= today || daysBetween(today, ltOn) > HOLD_WINDOW_DAYS) continue;
      const g = lot.units * (f.nav - lot.nav);
      if (g <= 0) continue;
      const stRate = f.tax_class === "equity" ? s.eq_stcg_rate : s.slab_rate;
      holds.push({ code: f.code, name: f.name, buy_date: lot.buy_date, units: Math.round(lot.units * 1000) / 1000,
        gain: r2(g), long_term_on: ltOn, days_left: daysBetween(today, ltOn),
        extra_tax_if_sold_now: r2(g * (stRate - s.ltcg_rate) / 100 * cess) });
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
 * schemes: { code: {name, nav, nav_date, tax_class, lock_in_years, category} }
 * fmv2018: { code: nav on 31-Jan-2018 }
 */
export function buildReport({ txns, schemes, settings: s, fmv2018 = {}, today = todayISO() }) {
  const warnings = [];
  const overrides = s.tax_class_overrides || {};
  const taxClassOf = (code) => overrides[code] || schemes[code]?.tax_class || "equity";
  const fmv = (code) => fmv2018[code] ?? null;
  const { lots, realized } = buildLedger(txns, taxClassOf, fmv);
  const last = {};
  for (const t of txns) last[t.code] = t;
  const flowsOf = (code) => txns.filter((t) => t.code === code).map((t) => [t.date, t.type === "BUY" ? -t.units * t.nav : t.units * t.nav]);

  const holdings = [], funds = [];
  let allFlows = [];
  for (const [code, fundLots] of Object.entries(lots)) {
    const sc = schemes[code];
    if (!sc) warnings.push(`Scheme ${code} not found in AMFI data; using last transaction NAV.`);
    const nav = sc ? sc.nav : last[code].nav;
    const name = sc?.name || last[code].name || code;
    const lock = sc?.lock_in_years || 0;
    const tc = taxClassOf(code);
    funds.push({ code, name, nav, tax_class: tc, lock_in_years: lock, lots: fundLots });

    let st = 0, lt = 0;
    const lotRows = fundLots.map((lot) => {
      const r = sellFifo([{ ...lot }], lot.units, today, nav, tc, fmv)[0];
      if (isLongTerm(r.bucket)) lt += r.gain; else st += r.gain;
      const lockedUntil = lock ? addMonths(lot.buy_date, 12 * lock) : null;
      return { buy_date: lot.buy_date, units: lot.units, nav: lot.nav, cost: r2(lot.units * lot.nav), tax_cost: r.cost,
        value: r.proceeds, gain: r.gain, bucket: r.bucket, long_term_on: becomesLongTermOn(tc, lot.buy_date),
        locked_until: lockedUntil && lockedUntil > today ? lockedUntil : null };
    });
    const units = sum(fundLots.map((l) => l.units));
    const invested = sum(fundLots.map((l) => l.units * l.nav));
    const value = units * nav;
    const flows = flowsOf(code);
    allFlows = allFlows.concat(flows);
    holdings.push({
      code, name, category: sc?.category || "Unknown", tax_class: tc, tax_class_overridden: code in overrides,
      units, avg_nav: units ? invested / units : 0, nav, nav_date: sc?.nav_date || last[code].date,
      invested: r2(invested), value: r2(value), gain: r2(value - invested),
      gain_pct: invested ? r2((value / invested - 1) * 100) : 0, st_gain: r2(st), lt_gain: r2(lt),
      xirr: pct(xirr([...flows, [today, value]])), lock_in_years: lock, lots: lotRows,
    });
  }
  holdings.sort((a, b) => b.value - a.value);
  for (const code of new Set(txns.map((t) => t.code))) if (!lots[code]) allFlows = allFlows.concat(flowsOf(code));

  const value = sum(holdings.map((h) => h.value)), invested = sum(holdings.map((h) => h.invested));
  const [fyStart, fyEnd] = fyBounds(today);
  const fyRealized = realized.filter((r) => r.sell_date >= fyStart && r.sell_date <= fyEnd);
  const base = {};
  for (const r of fyRealized) (base[r.bucket] ||= []).push(r.gain);
  for (const [b, v] of Object.entries(s.external || {})) if (v) (base[b] ||= []).push(Number(v));
  const nameOf = (c) => schemes[c]?.name || last[c]?.name || c;

  const byClass = {};
  for (const h of holdings) byClass[h.tax_class] = (byClass[h.tax_class] || 0) + h.value;
  return {
    today, fy: fyLabel(today),
    summary: {
      invested: r2(invested), value: r2(value), gain: r2(value - invested),
      gain_pct: invested ? r2((value / invested - 1) * 100) : 0, xirr: pct(xirr([...allFlows, [today, value]])),
      st_gain: r2(sum(holdings.map((h) => h.st_gain))), lt_gain: r2(sum(holdings.map((h) => h.lt_gain))),
      funds: holdings.length, transactions: txns.length,
    },
    holdings,
    allocation: Object.entries(byClass).sort((a, b) => b[1] - a[1])
      .map(([tax_class, v]) => ({ tax_class, value: r2(v), pct: value ? r2((v / value) * 100) : 0 })),
    realized_fy: fyRealized.map((r) => ({ ...r, name: nameOf(r.code) })),
    realized_all_time: r2(sum(realized.map((r) => r.gain))),
    tax: computeTax(base, s),
    harvest: suggest(funds, base, s, today, fmv),
    settings: s,
    nav_as_of: holdings.reduce((m, h) => (h.nav_date > m ? h.nav_date : m), "") || null,
    warnings,
  };
}

const pct = (x) => (x == null ? null : r2(x * 100));

/** Codes whose equity lots predate 1-Feb-2018 and so need the 31-Jan-2018 NAV. */
export function codesNeedingFmv(txns) {
  return [...new Set(txns.filter((t) => t.type === "BUY" && t.date < GRANDFATHER_CUTOFF).map((t) => t.code))];
}
