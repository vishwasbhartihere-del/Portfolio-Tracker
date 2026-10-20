import {
  ASSET_TYPES, CSV_HEADER, DEFAULT_SETTINGS, LedgerError, TAX_CLASSES, buildReport, keysNeedingFmv, normaliseTxns,
  parseCsv, sortTxns, toCsv, todayISO,
} from "./engine.js";
import { clearPriceCache, feeds, fmvFor, loadFeeds, quotesFor, refreshLive, searchCoins, METALS } from "./prices.js";
import { createDriveSync } from "./drive.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n, d = 0) => n == null ? "–" : (n < 0 ? "−₹" : "₹") + Math.abs(Number(n)).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const price = (n) => inr(n, Math.abs(n) < 100 ? 2 : Math.abs(n) < 10000 ? 2 : 0);
const signed = (n) => `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : "−"}${inr(Math.abs(n))}</span>`;
const pct = (n) => n == null ? "–" : `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : ""}${n.toFixed(2)}%</span>`;
const qty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: n < 1 ? 6 : 3 });
const fmtDate = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";
const BUCKET = { eq_st: "Equity STCG", eq_lt: "Equity LTCG", oth_lt: "Other LTCG", slab: "Slab rate", vda: "Crypto (30%)" };
const TERM = { eq_st: "Short", eq_lt: "Long", oth_lt: "Long", slab: "Slab", vda: "Crypto" };
const CLASS_LABEL = { equity: "Equity", listed: "Listed", other: "Unlisted/other", debt: "Debt", slab: "Slab", vda: "Crypto" };
const TYPE_COLOR = { mf: "--s1", stock: "--s2", bond: "--s3", gold: "--s4", crypto: "--s5", foreign: "--s6", other: "--s7" };
const ui = { filter: "all", open: null };

// ---------- storage (this browser; mirrored to Google Drive when signed in) ----------
const KEYS = { txns: "pt.transactions", settings: "pt.settings" };
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const loadTxns = () => sortTxns(normaliseTxns(store.get(KEYS.txns, [])));
const saveTxns = (txns) => store.set(KEYS.txns, txns.map((t, i) => ({ ...t, row: i + 2 })));
function loadSettings() {
  const saved = store.get(KEYS.settings, {});
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(saved)) s[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...s[k], ...v } : v;
  // Older versions stored overrides by bare scheme code.
  s.tax_class_overrides = Object.fromEntries(Object.entries(s.tax_class_overrides).map(([k, v]) => [k.includes(":") ? k : `mf:${k}`, v]));
  return s;
}

// ---------- compute ----------
let state = null;

async function compute({ refresh = false } = {}) {
  const txns = loadTxns();
  const settings = loadSettings();
  if (txns.length) await refreshLive(txns, refresh);
  const fmv2018 = await fmvFor(keysNeedingFmv(txns));
  try {
    state = buildReport({ txns, quotes: quotesFor(txns, settings), settings, fmv2018, today: todayISO() });
    state.warnings = [...feeds.errors, ...state.warnings];
    render();
  } catch (e) {
    console.error(e);
    $("#warnings").innerHTML = `<div class="warn">${esc(e.message)}</div>`;
  }
}

function render() {
  const r = state;
  const latest = r.holdings.reduce((m, h) => (h.price_date > m ? h.price_date : m), "");
  $("#asof").textContent = r.summary.transactions ? `${r.summary.holdings} holdings · prices as of ${fmtDate(latest)}` : "No transactions yet";
  $("#warnings").innerHTML = r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
  renderOverview(r);
  renderHoldings(r);
  renderTax(r);
  renderSettings(r);
}

// ---------- overview ----------
function renderOverview(r) {
  const s = r.summary, h = r.harvest;
  if (!s.transactions) {
    $("#tab-overview").innerHTML = `<div class="card"><h2>Welcome</h2><p class="muted">Track mutual funds, stocks, ETFs, SGBs, bonds, gold, crypto
      and anything else in one place, with tax-harvesting ideas under Indian tax rules.</p>
      <div class="row"><button class="btn primary" data-goto="data">Import transactions</button></div></div>`;
    bindGoto();
    return;
  }
  const order = Object.keys(ASSET_TYPES);
  const alloc = [...r.allocation].sort((a, b) => order.indexOf(a.asset_type) - order.indexOf(b.asset_type));
  const ideas = h.loss_harvest.length + h.gain_harvest.length;
  const saved = h.loss_harvest.reduce((a, x) => a + x.net_benefit, 0) + h.gain_harvest.reduce((a, x) => a + x.future_tax_saved, 0);
  $("#tab-overview").innerHTML = `
    <div class="card hero">
      <div class="label">Current value</div>
      <div class="big">${inr(s.value)}</div>
      <div class="line"><span>${signed(s.gain)} (${pct(s.gain_pct)})</span><span>XIRR ${s.xirr == null ? "–" : pct(s.xirr)}</span></div>
      <div class="stats">
        <div class="stat"><div class="k">Invested</div><div class="v">${inr(s.invested)}</div></div>
        <div class="stat"><div class="k">Long-term gain</div><div class="v">${inr(s.lt_gain)}</div></div>
        <div class="stat"><div class="k">Short-term gain</div><div class="v">${inr(s.st_gain)}</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Allocation</h2>
      <div class="alloc-bar" role="img" aria-label="Allocation by asset type">${alloc.map((a) =>
        `<span style="flex:${a.value};background:var(${TYPE_COLOR[a.asset_type]})" title="${esc(a.label)}: ${inr(a.value)} (${a.pct.toFixed(1)}%)"></span>`).join("")}</div>
      <div class="legend">${alloc.map((a) => `<div class="legend-row" data-filter="${a.asset_type}" style="cursor:pointer">
        <span class="swatch" style="background:var(${TYPE_COLOR[a.asset_type]})"></span>
        <span>${esc(a.label)} <span class="muted">· ${a.count}</span></span>
        <span class="num">${inr(a.value)} <span class="muted">${pct(a.invested ? (a.value / a.invested - 1) * 100 : 0)}</span></span>
        <span class="pct">${a.pct.toFixed(1)}%</span></div>`).join("")}</div>
    </div>
    <div class="card">
      <div class="tip">
        <div><h2>Tax ${esc(r.fy)}</h2>
          <p class="muted">Est. tax so far ${inr(r.tax.tax)} · LTCG exemption left ${inr(h.exemption_headroom_before)} · ${h.days_left_in_fy} days to 31 Mar</p>
          ${ideas ? `<p>${ideas} harvesting idea${ideas > 1 ? "s" : ""}, worth about <b class="pos">${inr(saved)}</b> in tax.</p>` : `<p class="muted">No harvesting ideas right now.</p>`}
          ${h.hold_alerts.length ? `<p>${h.hold_alerts.length} holding${h.hold_alerts.length > 1 ? "s turn" : " turns"} long-term within 90 days; avoid selling early.</p>` : ""}</div>
        <button class="btn small" data-goto="tax">View</button>
      </div>
    </div>`;
  bindGoto();
  $$("#tab-overview [data-filter]").forEach((el) => el.addEventListener("click", () => { ui.filter = el.dataset.filter; renderHoldings(state); showTab("holdings"); }));
}

function bindGoto() { $$("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto))); }

// ---------- holdings ----------
function renderHoldings(r) {
  if (!r.holdings.length) {
    $("#tab-holdings").innerHTML = `<div class="card empty">No holdings yet. Import transactions under <b>Data</b>.</div>`;
    return;
  }
  const types = Object.keys(ASSET_TYPES).filter((t) => r.holdings.some((h) => h.asset_type === t));
  if (ui.filter !== "all" && !types.includes(ui.filter)) ui.filter = "all";
  const shown = types.filter((t) => ui.filter === "all" || t === ui.filter);
  $("#tab-holdings").innerHTML = `
    <div class="chips">${["all", ...types].map((t) => `<button class="chip ${ui.filter === t ? "active" : ""}" data-chip="${t}">${t === "all" ? "All" : esc(ASSET_TYPES[t].label)}</button>`).join("")}</div>
    <div class="card list" style="padding:0">${shown.map((t) => {
      const rows = r.holdings.filter((h) => h.asset_type === t);
      const total = rows.reduce((a, h) => a + h.value, 0);
      return `<div class="group-head"><span>${esc(ASSET_TYPES[t].label)}</span><span>${inr(total)}</span></div>${rows.map(holdingRow).join("")}`;
    }).join("")}</div>`;
  $$("[data-chip]").forEach((b) => b.addEventListener("click", () => { ui.filter = b.dataset.chip; renderHoldings(state); }));
  $$(".h-row").forEach((row) => row.addEventListener("click", () => { ui.open = ui.open === row.dataset.key ? null : row.dataset.key; renderHoldings(state); }));
}

function holdingRow(h) {
  const meta = [h.asset_type === "mf" ? `<span>${esc(h.symbol)}</span>` : `<span>${esc(h.symbol)}</span>`, `<span>${qty(h.units)} @ ${price(h.price)}</span>`];
  if (h.lock_in_years) meta.push(`<span class="tag">${h.lock_in_years}y lock-in</span>`);
  if (h.stale) meta.push(`<span class="tag" title="Price from ${esc(h.price_source)} on ${fmtDate(h.price_date)}">price ${h.price_source === "last trade" ? "missing" : "old"}</span>`);
  return `<div class="h-row" data-key="${esc(h.key)}">
      <div style="min-width:0"><div class="h-name">${esc(h.name)}</div><div class="h-meta">${meta.join("·")}</div></div>
      <div><div class="h-val">${inr(h.value)}</div><div class="h-gain">${signed(h.gain)} · ${pct(h.gain_pct)}</div></div>
    </div>${ui.open === h.key ? holdingDetail(h) : ""}`;
}

function holdingDetail(h) {
  const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  return `<div class="detail"><div class="kv-grid">
      ${kv("Invested", inr(h.invested))}${kv("Avg cost", price(h.avg_price))}
      ${kv("Price", `${price(h.price)} <span class="muted">${fmtDate(h.price_date)}</span>`)}${kv("Source", esc(h.price_source))}
      ${kv("Long-term gain", signed(h.lt_gain))}${kv("Short-term gain", signed(h.st_gain))}
      ${kv("XIRR", h.xirr == null ? "–" : pct(h.xirr))}${kv("Tax class", `${CLASS_LABEL[h.tax_class]}${h.tax_class_overridden ? " *" : ""}`)}
    </div>
    <div class="table-wrap"><table><thead><tr><th>Bought</th><th class="num">Qty</th><th class="num">Cost/unit</th><th class="num">Value</th><th class="num">Gain</th><th>Term</th><th>Long-term on</th></tr></thead><tbody>
    ${h.lots.map((l) => `<tr><td>${fmtDate(l.buy_date)}</td><td class="num">${qty(l.units)}</td><td class="num">${price(l.nav)}</td>
      <td class="num">${inr(l.value)}</td><td class="num">${signed(l.gain)}${l.tax_cost !== l.cost ? `<div class="muted" title="Grandfathered cost (31-Jan-2018)">GF cost ${inr(l.tax_cost)}</div>` : ""}</td>
      <td>${TERM[l.bucket]}${l.locked_until ? ` <span class="tag">locked to ${fmtDate(l.locked_until)}</span>` : ""}</td>
      <td>${l.long_term_on ? fmtDate(l.long_term_on) : "–"}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted">Sales use FIFO: the top lot is sold first.</p></div>`;
}

// ---------- tax ----------
function idea(a, kind) {
  const buckets = Object.entries(a.by_bucket).map(([b, v]) => `${BUCKET[b]} ${signed(v)}`).join(", ");
  const benefit = kind === "loss" ? `<span class="pos">Saves ${inr(a.net_benefit)}</span>`
    : kind === "gain" ? `<span class="pos">Tax-free · ~${inr(a.future_tax_saved)} saved later</span>`
      : `Banks ${inr(a.carry_forward_added.st + a.carry_forward_added.lt)} of losses`;
  return `<div class="idea"><div class="head"><div class="what">Sell ${qty(a.units)} ${esc(a.name)}</div><div class="benefit">${benefit}</div></div>
    <div class="meta"><span>≈ ${inr(a.amount)}</span><span>${buckets}</span>${a.exit_load ? `<span>exit load ~${inr(a.exit_load)}</span>` : ""}</div>
    <div class="why">${esc(a.why)}</div></div>`;
}

function renderTax(r) {
  const h = r.harvest, t = r.tax, s = r.settings;
  const used = Math.max(0, s.ltcg_exemption - h.exemption_headroom_before);
  const section = (title, items, kind, emptyMsg) => `<div class="card"><div class="section-head"><h2>${title}</h2><span class="count">${items.length || ""}</span></div>
    ${items.length ? items.map((a) => idea(a, kind)).join("") : `<p class="empty">${emptyMsg}</p>`}</div>`;
  const realized = r.realized_fy.map((x) => `<tr><td>${fmtDate(x.sell_date)}</td><td>${esc(x.name)}</td><td class="num">${qty(x.units)}</td>
    <td class="num">${inr(x.proceeds)}</td><td class="num">${signed(x.gain)}</td><td>${BUCKET[x.bucket]}</td></tr>`).join("");
  $("#tab-tax").innerHTML = `
    <div class="card">
      <h2>${esc(h.fy)} so far</h2>
      <div class="stats" style="border-top:0;margin-top:8px;padding-top:0">
        <div class="stat"><div class="k">Estimated tax</div><div class="v">${inr(t.tax)}</div></div>
        <div class="stat"><div class="k">After suggestions</div><div class="v">${inr(h.tax_after)}</div></div>
        <div class="stat"><div class="k">Losses to carry forward</div><div class="v">${inr(t.carry_forward.st + t.carry_forward.lt)}</div></div>
      </div>
      <h3>Equity LTCG exemption</h3>
      <div class="progress"><div style="width:${Math.min(100, (used / s.ltcg_exemption) * 100)}%"></div></div>
      <p class="muted">${inr(used)} of ${inr(s.ltcg_exemption)} used · <b>${inr(h.exemption_headroom_before)}</b> left · ${h.days_left_in_fy} days to ${fmtDate(h.fy_end)}</p>
      ${h.notes.map((n) => `<div class="warn" style="margin-top:10px">${esc(n)}</div>`).join("")}
    </div>
    ${section("Book tax-free gains", h.gain_harvest, "gain", h.exemption_headroom_before < 1000 ? "This year's exemption is already used." : "No long-term equity gains to harvest.")}
    ${section("Sell losers to cut tax", h.loss_harvest, "loss", "Nothing worth selling at a loss right now.")}
    <div class="card"><div class="section-head"><h2>Don't sell yet</h2><span class="count">${h.hold_alerts.length || ""}</span></div>
      ${h.hold_alerts.length ? `<div class="table-wrap"><table><thead><tr><th>Holding</th><th class="num">Gain</th><th>Long-term on</th><th class="num">Extra tax if sold now</th></tr></thead><tbody>
        ${h.hold_alerts.map((a) => `<tr><td>${esc(a.name)}<div class="muted">bought ${fmtDate(a.buy_date)}</div></td><td class="num">${signed(a.gain)}</td>
          <td>${fmtDate(a.long_term_on)} <span class="muted">(${a.days_left}d)</span></td><td class="num neg">${inr(a.extra_tax_if_sold_now)}+</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="empty">Nothing turns long-term in the next 90 days.</p>`}</div>
    ${h.carry_forward.length ? section("Losses you could bank", h.carry_forward, "carry", "") : ""}
    <div class="card"><h2>Realised this year</h2>
      ${realized ? `<div class="table-wrap"><table><thead><tr><th>Sold</th><th>Holding</th><th class="num">Qty</th><th class="num">Proceeds</th><th class="num">Gain</th><th>Type</th></tr></thead><tbody>${realized}</tbody></table></div>` : `<p class="empty">No sales this financial year.</p>`}
      <h3>Tax by type</h3>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th class="num">Gains</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead><tbody>
        ${Object.keys(BUCKET).map((b) => `<tr><td>${BUCKET[b]}</td><td class="num">${inr(t.gross[b])}</td><td class="num">${inr(t.taxable[b])}</td><td class="num">${inr(t.tax_by_bucket[b])}</td></tr>`).join("")}
      </tbody></table></div>
      ${t.vda_loss_ignored ? `<p class="muted">Crypto losses of ${inr(t.vda_loss_ignored)} can't be set off or carried forward.</p>` : ""}
      <p class="muted">Includes gains entered under Settings. Equity exemption used: ${inr(t.exempt_used)}.</p>
    </div>`;
}

// ---------- settings ----------
function renderSettings(r) {
  const s = r.settings;
  const field = (key, label, val) => `<label>${label}<input type="number" step="any" inputmode="decimal" data-key="${key}" value="${val}"></label>`;
  const manual = r.holdings.filter((h) => !["mf", "stock"].includes(h.asset_type) || h.price_source === "last trade" || s.manual_prices[h.key]);
  $("#tab-settings").innerHTML = `<form id="settings-form">
    <div class="card"><h2>Manual prices</h2>
      <p class="muted">For holdings without a price feed (foreign stocks, unlisted assets) or to override one. Leave blank to use the feed.</p>
      ${manual.length ? manual.map((h) => `<div class="price-row"><div><div>${esc(h.name)}</div><div class="muted">${esc(ASSET_TYPES[h.asset_type].label)} · now ${price(h.price)} (${esc(h.price_source)})</div></div>
        <input type="number" step="any" inputmode="decimal" data-price="${esc(h.key)}" value="${s.manual_prices[h.key]?.price ?? ""}" placeholder="₹ per unit"></div>`).join("")
        : `<p class="empty">All holdings have a live price.</p>`}
    </div>
    <div class="card"><h2>Tax rates</h2><div class="form-grid">
      ${field("slab_rate", "Your income-tax slab (%)", s.slab_rate)}${field("cess", "Cess (%)", s.cess)}
      ${field("eq_stcg_rate", "Equity STCG (%)", s.eq_stcg_rate)}${field("ltcg_rate", "LTCG (%)", s.ltcg_rate)}
      ${field("ltcg_exemption", "Equity LTCG exemption (₹)", s.ltcg_exemption)}${field("vda_rate", "Crypto tax (%)", s.vda_rate)}
      ${field("exit_load_pct", "MF exit load < 1 yr (%)", s.exit_load_pct)}${field("gold_premium_pct", "Indian gold premium over spot (%)", s.gold_premium_pct)}
    </div></div>
    <div class="card"><h2>Realised elsewhere this FY</h2>
      <p class="muted">Gains from accounts not in this tracker. Enter losses as negative numbers.</p>
      <div class="form-grid">
      ${field("external.eq_st", "Equity STCG (₹)", s.external.eq_st)}${field("external.eq_lt", "Equity LTCG (₹)", s.external.eq_lt)}
      ${field("external.oth_lt", "Other LTCG @12.5% (₹)", s.external.oth_lt)}${field("external.slab", "Taxed at slab (₹)", s.external.slab)}
      ${field("external.vda", "Crypto gains (₹)", s.external.vda)}
      </div>
      <h3>Losses brought forward</h3><div class="form-grid">
      ${field("carry_forward.st", "Short-term loss (₹)", s.carry_forward.st)}${field("carry_forward.lt", "Long-term loss (₹)", s.carry_forward.lt)}
      </div></div>
    ${r.holdings.length ? `<div class="card"><h2>Tax class per holding</h2>
      <p class="muted"><b>Equity</b>: shares, equity MFs/ETFs, REITs (12 months). <b>Listed</b>: gold/intl ETFs, SGBs, listed bonds (12 months, slab if short).
      <b>Unlisted/other</b>: physical gold, foreign shares, hybrid/FoF funds (24 months). <b>Debt</b>: debt funds. <b>Slab</b>: always slab. <b>Crypto</b>: flat 30%.</p>
      ${r.holdings.map((h) => `<div class="class-row"><div>${esc(h.name)}</div><select data-override="${esc(h.key)}">
        <option value="">auto${h.tax_class_overridden ? "" : ` (${CLASS_LABEL[h.tax_class]})`}</option>${TAX_CLASSES.map((c) =>
          `<option value="${c}" ${s.tax_class_overrides[h.key] === c ? "selected" : ""}>${CLASS_LABEL[c]}</option>`).join("")}</select></div>`).join("")}
    </div>` : ""}
    <div class="row"><button type="submit" class="btn primary">Save settings</button><span id="settings-msg" class="msg muted"></span></div>
  </form>`;
  $("#settings-form").addEventListener("submit", saveSettings);
}

async function saveSettings(e) {
  e.preventDefault();
  const s = loadSettings();
  s.tax_class_overrides = {};
  $$("#settings-form [data-key]").forEach((el) => {
    const [a, b] = el.dataset.key.split(".");
    const v = parseFloat(el.value || "0") || 0;
    if (b) s[a][b] = v; else s[a] = v;
  });
  $$("#settings-form [data-override]").forEach((el) => { if (el.value) s.tax_class_overrides[el.dataset.override] = el.value; });
  $$("#settings-form [data-price]").forEach((el) => {
    const v = parseFloat(el.value);
    if (v > 0) s.manual_prices[el.dataset.price] = { price: v, date: todayISO() };
    else delete s.manual_prices[el.dataset.price];
  });
  store.set(KEYS.settings, s);
  drive.changed();
  await compute();
  showTab("settings");
  $("#settings-msg").textContent = "Saved.";
}

function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
}

// ---------- data tab ----------
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importCsv(text, mode) {
  const fresh = parseCsv(text, (isin) => feeds.isin[isin] || null);
  const all = sortTxns((mode === "append" ? loadTxns() : []).concat(fresh)).map((t, i) => ({ ...t, row: i + 2 }));
  buildReport({ txns: all, settings: loadSettings() }); // replay first so a bad file never replaces good data
  saveTxns(all);
  drive.changed();
  return fresh.length;
}

async function runImport(text, mode) {
  const msg = $("#import-msg");
  try {
    const n = importCsv(text, mode);
    msg.innerHTML = `<span class="pos">Imported ${n} transactions.</span>`;
    $("#csv").value = "";
    await compute({ refresh: true });
    showTab("overview");
  } catch (err) {
    if (!(err instanceof LedgerError)) console.error(err);
    msg.innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  }
}

const TEMPLATE = `${CSV_HEADER}
# Lines starting with # are ignored. Prices are per unit in INR; fees are total charges for the row.
2024-01-15,mf,122639,BUY,150.512,66.42,,,
2024-03-04,stock,RELIANCE,BUY,10,1450.50,20,,
2024-05-20,stock,GOLDBEES,BUY,100,55.10,10,,
2024-06-10,stock,SGBJUN28,BUY,2,7200,,,
2023-11-10,gold,GOLD24,BUY,10,6200,,Gold coins,
2025-01-05,crypto,BTC,BUY,0.01,8500000,85,,
2025-02-01,foreign,AAPL,BUY,5,19500,,Apple Inc,
2025-03-01,bond,XYZ-NCD-2028,BUY,10,10000,,XYZ Finance NCD,slab
2026-06-15,stock,RELIANCE,SELL,5,1390,15,,
`;

$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.classList.add("spin");
  try { await compute({ refresh: true }); } finally { btn.disabled = false; btn.classList.remove("spin"); }
});
const readInto = (f) => f.text().then((t) => { $("#csv").value = t; });
$("#pick").addEventListener("click", (e) => { e.preventDefault(); $("#file").click(); });
$("#file").addEventListener("change", (e) => e.target.files[0] && readInto(e.target.files[0]));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && readInto(e.dataTransfer.files[0]); });
$("#import-btn").addEventListener("click", () => runImport($("#csv").value, $('input[name="mode"]:checked').value));
$("#template-btn").addEventListener("click", () => download("portfolio-template.csv", TEMPLATE, "text/csv"));
$("#sample-btn").addEventListener("click", async () => {
  if (loadTxns().length && !confirm("Replace your current transactions with the sample data?")) return;
  runImport(await (await fetch("sample_transactions.csv")).text(), "replace");
});
$("#backup-btn").addEventListener("click", () => download(`portfolio-backup-${todayISO()}.json`,
  JSON.stringify(snapshot(), null, 2), "application/json"));
$("#csv-btn").addEventListener("click", () => download("transactions.csv", toCsv(loadTxns()), "text/csv"));
$("#restore-btn").addEventListener("click", () => $("#restore-file").click());
$("#restore-file").addEventListener("change", async (e) => {
  const msg = $("#data-msg");
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data.transactions)) throw new Error("Not a portfolio backup file.");
    if (loadTxns().length && !confirm("Replace the data in this browser with the backup?")) return;
    saveTxns(sortTxns(normaliseTxns(data.transactions)));
    if (data.settings) store.set(KEYS.settings, data.settings);
    drive.changed();
    msg.innerHTML = `<span class="pos">Restored ${data.transactions.length} transactions.</span>`;
    await compute({ refresh: true });
  } catch (err) { msg.innerHTML = `<span class="neg">${esc(err.message)}</span>`; }
  e.target.value = "";
});
$("#clear-btn").addEventListener("click", async () => {
  const where = drive.signedIn ? "this browser AND your Google Drive copy" : "this browser";
  if (!confirm(`Delete all transactions and settings from ${where}? Download a backup first if you need it.`)) return;
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  clearPriceCache();
  drive.changed();
  await compute();
  $("#data-msg").textContent = "All data deleted.";
});

let searchTimer;
const runSearch = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("#search").value.trim().toLowerCase(), type = $("#search-type").value;
    const words = q.split(/\s+/).filter(Boolean);
    const out = [];
    const match = (hay) => words.every((w) => hay.toLowerCase().includes(w));
    if (q.length >= 2) {
      if (type === "all" || type === "stock") {
        for (const s of Object.values(feeds.stocks)) {
          if (match(`${s.symbol} ${s.name} ${s.isin} ${s.bse_code}`)) out.push(["stock", s.symbol, s.name, s.price]);
          if (out.length >= 12) break;
        }
      }
      if (type === "all" || type === "mf") {
        let n = 0;
        for (const s of Object.values(feeds.schemes)) {
          if (match(`${s.name} ${s.code} ${s.isin_growth}`)) { out.push(["mf", s.code, s.name, s.nav]); if (++n >= 12) break; }
        }
      }
      if (type === "all" || type === "crypto") {
        try { for (const c of await searchCoins(q)) out.push(["crypto", c.symbol, c.name, null]); } catch { /* offline */ }
      }
      if ("gold silver".includes(q) || q.startsWith("gold") || q.startsWith("silver")) {
        for (const [sym, [, , name]] of Object.entries(METALS).filter(([k]) => ["GOLD24", "GOLD22", "GOLD18", "SILVER"].includes(k))) out.unshift(["gold", sym, name, null]);
      }
    }
    $("#search-results").innerHTML = out.map(([t, sym, name, p]) => `<div class="result"><div><div>${esc(name)}</div>
      <div class="muted">asset_type <code>${t}</code> · symbol <code>${esc(sym)}</code></div></div><div class="num muted">${p != null ? price(p) : ""}</div></div>`).join("")
      || (q.length >= 2 ? `<p class="empty">No matches.</p>` : "");
  }, 250);
};
$("#search").addEventListener("input", runSearch);
$("#search-type").addEventListener("change", runSearch);

// ---------- Google Drive sync ----------
function snapshot() { return { version: 2, updated: new Date().toISOString(), transactions: loadTxns(), settings: loadSettings() }; }
const drive = createDriveSync({
  getSnapshot: snapshot,
  async applySnapshot(snap) {
    saveTxns(sortTxns(normaliseTxns(snap.transactions || [])));
    if (snap.settings) store.set(KEYS.settings, snap.settings);
    await compute({ refresh: true });
  },
  onStatus: renderSync,
});

function renderSync({ kind, detail, email }) {
  const who = email ? `<span class="email">${esc(email)}</span>` : "";
  $("#sync").innerHTML = {
    off: "",
    "signed-out": `<button id="g-in" class="btn small">Sign in<span class="wide-only"> with Google</span></button>`,
    "needs-tap": `<button id="g-in" class="btn small">Sync with Drive</button>`,
    syncing: `<span class="pill">Syncing…</span>`,
    synced: `<button id="g-out" class="pill" title="Signed in as ${esc(email)}. Click to sign out."><span class="dot"></span>Synced</button>${who}`,
    error: `<button id="g-in" class="btn small" title="${esc(detail)}">Retry sync</button>`,
  }[kind];
  if (kind === "error") $("#warnings").insertAdjacentHTML("afterbegin", `<div class="warn">Google Drive sync failed: ${esc(detail)}</div>`);
  $("#g-in")?.addEventListener("click", () => drive.connect());
  $("#g-out")?.addEventListener("click", () => {
    if (confirm(`Signed in as ${email}.\n\nSign out of Google? Your data stays in Google Drive and on this device.`)) drive.signOut();
  });
}

(async () => {
  drive.resume();
  await loadFeeds();
  await compute();
  if (!state?.summary.transactions) showTab("data");
})();
