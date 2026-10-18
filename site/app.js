import {
  DEFAULT_SETTINGS, LedgerError, buildReport, codesNeedingFmv, parseCsv, sortTxns, toCsv, todayISO, GRANDFATHER_DATE,
} from "./engine.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n, d = 0) => n == null ? "–" : (n < 0 ? "−₹" : "₹") + Math.abs(Number(n)).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n) => `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : "−"}${inr(Math.abs(n))}</span>`;
const pct = (n) => n == null ? "–" : `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : ""}${n.toFixed(2)}%</span>`;
const units = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const fmtDate = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";
const BUCKET = { eq_st: "Equity STCG", eq_lt: "Equity LTCG", oth_lt: "Non-equity LTCG", slab: "Slab rate" };
const TERM = { eq_st: "Short", eq_lt: "Long", oth_lt: "Long", slab: "Slab" };
const MFAPI = "https://api.mfapi.in/mf/";

// ---------- storage (this browser only) ----------
const KEYS = { txns: "pt.transactions", settings: "pt.settings", live: "pt.liveNavs", fmv: "pt.fmv2018" };
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};
const loadTxns = () => sortTxns(store.get(KEYS.txns, []));
const saveTxns = (txns) => store.set(KEYS.txns, txns.map(({ date, code, type, units, nav, name }, i) => ({ date, code, type, units, nav, name, row: i + 2 })));
function loadSettings() {
  const saved = store.get(KEYS.settings, {});
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(saved)) s[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...s[k], ...v } : v;
  return s;
}

// ---------- NAV data ----------
let schemes = {}, byIsin = {}, navsGenerated = null;

async function loadSchemes() {
  try {
    const res = await fetch("navs.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    navsGenerated = data.generated;
    const idx = Object.fromEntries(data.fields.map((f, i) => [f, i]));
    for (const row of data.schemes) {
      const s = Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, row[i]]));
      schemes[s.code] = s;
      if (s.isin_growth) byIsin[s.isin_growth] = s.code;
      if (s.isin_reinvest) byIsin[s.isin_reinvest] = s.code;
    }
  } catch (e) {
    warnings.push(`Could not load the AMFI NAV list (${e.message}). Fund names and categories may be missing.`);
  }
}

// mfapi.in serves CORS-enabled per-scheme NAVs; use it for fresher prices on funds you hold.
async function refreshLiveNavs(codes) {
  const live = store.get(KEYS.live, {});
  await Promise.all(codes.map(async (code) => {
    try {
      const res = await fetch(`${MFAPI}${encodeURIComponent(code)}/latest`);
      const j = await res.json();
      const row = j.data?.[0];
      if (!row) return;
      const [d, m, y] = row.date.split("-");
      live[code] = { nav: Number(row.nav), nav_date: `${y}-${m}-${d}` };
    } catch { /* offline or unknown code: keep what we have */ }
  }));
  store.set(KEYS.live, live);
}

async function ensureFmv(codes) {
  const fmv = store.get(KEYS.fmv, {});
  const missing = codes.filter((c) => !(c in fmv));
  await Promise.all(missing.map(async (code) => {
    try {
      const j = await (await fetch(`${MFAPI}${encodeURIComponent(code)}`)).json();
      let best = null;
      for (const r of j.data || []) {
        const [d, m, y] = r.date.split("-");
        const iso = `${y}-${m}-${d}`;
        if (iso <= GRANDFATHER_DATE && (!best || iso > best[0])) best = [iso, Number(r.nav)];
      }
      fmv[code] = best ? best[1] : null;
    } catch { /* retry next load */ }
  }));
  store.set(KEYS.fmv, fmv);
  return Object.fromEntries(Object.entries(fmv).filter(([, v]) => v != null));
}

function mergedSchemes() {
  const live = store.get(KEYS.live, {});
  const out = { ...schemes };
  for (const [code, l] of Object.entries(live)) {
    const base = out[code];
    if (base && l.nav_date > base.nav_date) out[code] = { ...base, nav: l.nav, nav_date: l.nav_date };
  }
  return out;
}

// ---------- app ----------
let state = null;
let warnings = [];

async function compute({ refresh = false } = {}) {
  const txns = loadTxns();
  if (refresh || isStale(txns)) await refreshLiveNavs([...new Set(txns.map((t) => t.code))]);
  const fmv2018 = await ensureFmv(codesNeedingFmv(txns));
  try {
    state = buildReport({ txns, schemes: mergedSchemes(), settings: loadSettings(), fmv2018, today: todayISO() });
    state.warnings = [...warnings, ...state.warnings];
    render();
  } catch (e) {
    $("#warnings").innerHTML = `<div class="warn">${esc(e.message)}</div>`;
  }
}

// Fetch live NAVs at most every few hours to keep things snappy.
function isStale(txns) {
  if (!txns.length) return false;
  const last = Number(store.get("pt.liveFetchedAt", 0));
  if (Date.now() - last < 3 * 3600e3) return false;
  store.set("pt.liveFetchedAt", Date.now());
  return true;
}

function render() {
  const r = state;
  $("#asof").textContent = r.summary.transactions
    ? `NAV as of ${fmtDate(r.nav_as_of)} · ${r.summary.funds} funds · ${r.fy}`
    : "No transactions yet. Import a CSV or load the sample to get started.";
  $("#warnings").innerHTML = r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
  renderCards(r);
  renderHoldings(r);
  renderHarvest(r);
  renderRealized(r);
  renderSettings(r);
}

function renderCards(r) {
  const s = r.summary, h = r.harvest;
  const opp = h.loss_harvest.length + h.gain_harvest.length;
  $("#cards").innerHTML = [
    ["Current value", inr(s.value), `Invested ${inr(s.invested)}`],
    ["Unrealised gain", signed(s.gain), `${pct(s.gain_pct)} · XIRR ${s.xirr == null ? "–" : s.xirr.toFixed(2) + "%"}`],
    ["Long-term gain", inr(s.lt_gain), `Short-term / slab: ${inr(s.st_gain)}`],
    [`Est. tax ${r.fy}`, inr(r.tax.tax), "on realised gains so far"],
    ["Harvesting", opp ? `${opp} idea${opp > 1 ? "s" : ""}` : "None now", `LTCG exemption left: ${inr(h.exemption_headroom_before)}`],
  ].map(([l, v, sub]) => `<div class="card"><div class="label">${l}</div><div class="value">${v}</div><div class="sub muted">${sub}</div></div>`).join("");
}

function classChip(h) {
  const label = { equity: "Equity", debt: "Debt", other: "Hybrid/Other" }[h.tax_class];
  return `<span class="chip ${h.tax_class}" title="${esc(h.category)}">${label}${h.tax_class_overridden ? "*" : ""}</span>`;
}

function renderHoldings(r) {
  if (!r.holdings.length) {
    $("#tab-holdings").innerHTML = `<div class="panel empty">No holdings yet. Go to <b>Data</b> to import transactions.</div>`;
    return;
  }
  const rows = r.holdings.map((h, i) => `
    <tr class="fund" data-i="${i}">
      <td><div class="fund-name">${esc(h.name)}</div>
        <div>${classChip(h)}${h.lock_in_years ? `<span class="chip">${h.lock_in_years}y lock-in</span>` : ""}<span class="chip">${esc(h.code)}</span></div></td>
      <td class="num hide-sm">${units(h.units)}</td>
      <td class="num hide-sm">${h.avg_nav.toFixed(2)}<div class="muted">${h.nav.toFixed(2)}</div></td>
      <td class="num hide-sm">${inr(h.invested)}</td>
      <td class="num">${inr(h.value)}<div class="muted show-sm">${inr(h.invested)}</div></td>
      <td class="num">${signed(h.gain)}<div>${pct(h.gain_pct)}</div></td>
      <td class="num hide-sm">${signed(h.lt_gain)}<div class="muted">ST ${inr(h.st_gain)}</div></td>
      <td class="num hide-sm">${h.xirr == null ? "–" : pct(h.xirr)}</td>
    </tr>
    <tr class="lots" id="lots-${i}" hidden><td colspan="8">${lotsTable(h)}</td></tr>`).join("");
  $("#tab-holdings").innerHTML = `<div class="panel table-wrap"><table>
    <thead><tr><th>Fund</th><th class="num hide-sm">Units</th><th class="num hide-sm">Avg cost / NAV</th>
      <th class="num hide-sm">Invested</th><th class="num">Value</th><th class="num">Gain</th>
      <th class="num hide-sm">LT gain</th><th class="num hide-sm">XIRR</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">Tap a fund to see its lots (FIFO order: the top lot is redeemed first).</p></div>
    <div class="panel"><h2>Allocation by tax class</h2>${r.allocation.map((a) =>
      `<div class="kv"><span style="min-width:110px">${classChip(a)}</span><span>${inr(a.value)}</span><span class="muted">${a.pct.toFixed(1)}%</span></div>
       <div class="bar"><div style="width:${a.pct}%"></div></div>`).join("")}</div>`;
  document.querySelectorAll("tr.fund").forEach((tr) =>
    tr.addEventListener("click", () => { const el = $(`#lots-${tr.dataset.i}`); el.hidden = !el.hidden; }));
}

function lotsTable(h) {
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>Bought</th><th class="num">Units</th><th class="num">Buy NAV</th>
    <th class="num">Cost</th><th class="num">Value</th><th class="num">Gain</th><th>Term today</th><th>Long-term from</th></tr></thead><tbody>
    ${h.lots.map((l) => `<tr><td>${fmtDate(l.buy_date)}</td><td class="num">${units(l.units)}</td><td class="num">${l.nav.toFixed(4)}</td>
      <td class="num">${inr(l.cost)}${l.tax_cost !== l.cost ? `<div class="muted" title="Grandfathered cost (31-Jan-2018 NAV)">tax cost ${inr(l.tax_cost)}</div>` : ""}</td>
      <td class="num">${inr(l.value)}</td><td class="num">${signed(l.gain)}</td>
      <td>${TERM[l.bucket]}${l.locked_until ? ` <span class="chip">locked till ${fmtDate(l.locked_until)}</span>` : ""}</td>
      <td>${l.long_term_on ? fmtDate(l.long_term_on) : "never (slab)"}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function actionCard(a, kind) {
  const buckets = Object.entries(a.by_bucket).map(([b, v]) => `${BUCKET[b]} ${signed(v)}`).join(" · ");
  let benefit = "";
  if (kind === "loss") benefit = `Saves ${inr(a.net_benefit)} tax`;
  if (kind === "gain") benefit = `Tax-free · saves ~${inr(a.future_tax_saved)} later`;
  if (kind === "carry") benefit = `Banks ${inr(a.carry_forward_added.st + a.carry_forward_added.lt)} loss`;
  return `<div class="action ${kind === "carry" ? "loss" : kind}">
    <div class="head"><div class="what">Sell ${units(a.units)} units of ${esc(a.name)}</div><div class="benefit ${kind === "gain" ? "pos" : ""}">${benefit}</div></div>
    <div class="kv"><span>Amount <b>${inr(a.amount)}</b></span><span>Realises ${buckets}</span>
      ${a.exit_load ? `<span>Est. exit load <b>${inr(a.exit_load)}</b></span>` : ""}
      ${a.tax_saved != null ? `<span>Tax saved <b>${inr(a.tax_saved)}</b></span>` : ""}
      <span class="muted">FIFO across ${a.lots} lot${a.lots > 1 ? "s" : ""} at NAV ${a.nav}</span></div>
    <p class="why">${esc(a.why)}</p></div>`;
}

function renderHarvest(r) {
  const h = r.harvest, t = r.tax, s = r.settings;
  const used = Math.max(0, s.ltcg_exemption - h.exemption_headroom_before);
  const usedPct = Math.min(100, (used / s.ltcg_exemption) * 100);
  const none = (m) => `<div class="empty">${m}</div>`;
  $("#tab-harvest").innerHTML = `
    <div class="grid2">
      <div class="panel"><h2>${h.fy} so far</h2>
        <div class="kv">${Object.keys(BUCKET).map((b) => `<span>${BUCKET[b]} <b>${inr(t.gross[b])}</b></span>`).join("")}</div>
        <div class="kv"><span>Losses (incl. brought forward) <b>${inr(t.losses.st + t.losses.lt)}</b></span>
          <span>Estimated tax <b>${inr(t.tax)}</b></span>
          <span>Carry forward <b>${inr(t.carry_forward.st + t.carry_forward.lt)}</b></span></div>
        <h3>Equity LTCG exemption</h3>
        <div class="bar"><div style="width:${usedPct}%"></div></div>
        <div class="muted">${inr(used)} of ${inr(s.ltcg_exemption)} used · <b>${inr(h.exemption_headroom_before)}</b> left · ${h.days_left_in_fy} days until ${fmtDate(h.fy_end)}</div>
      </div>
      <div class="panel"><h2>If you follow the plan below</h2>
        <div class="kv"><span>Tax now <b>${inr(h.tax_before)}</b></span><span>Tax after <b>${inr(h.tax_after)}</b></span></div>
        <div class="kv"><span>Gains booked tax-free <b class="pos">${inr(h.gain_harvest.reduce((a, x) => a + x.gain, 0))}</b></span>
          <span>Future tax avoided <b class="pos">~${inr(h.gain_harvest.reduce((a, x) => a + x.future_tax_saved, 0))}</b></span></div>
        <p class="why muted">India has no wash-sale rule, so you can reinvest right away. Sell orders are processed FIFO, so units
          shown always come from your oldest lots. Exit loads are estimated at ${s.exit_load_pct}% for units under 1 year; check each fund's actual load.</p>
        ${h.notes.map((n) => `<div class="warn">${esc(n)}</div>`).join("")}
      </div>
    </div>
    <div class="panel"><h2>1 · Tax-loss harvesting</h2><div class="actions">
      ${h.loss_harvest.map((a) => actionCard(a, "loss")).join("") || none("Nothing worth selling at a loss: either no realised gains to offset, or losses would only eat into your tax-free LTCG limit.")}</div></div>
    <div class="panel"><h2>2 · Tax-gain harvesting (use the ${inr(s.ltcg_exemption)} exemption)</h2><div class="actions">
      ${h.gain_harvest.map((a) => actionCard(a, "gain")).join("") || none(h.exemption_headroom_before < 1000 ? "Exemption already used for this FY." : "No long-term equity gains available to harvest.")}</div></div>
    <div class="panel"><h2>3 · Don't sell yet: turning long-term soon</h2>
      ${h.hold_alerts.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Fund</th><th>Bought</th><th class="num">Units</th><th class="num">Gain</th><th>Long-term on</th><th class="num">Extra tax if sold now</th></tr></thead><tbody>
        ${h.hold_alerts.map((a) => `<tr><td>${esc(a.name)}</td><td>${fmtDate(a.buy_date)}</td><td class="num">${units(a.units)}</td><td class="num">${signed(a.gain)}</td>
          <td>${fmtDate(a.long_term_on)} <span class="muted">(${a.days_left}d)</span></td><td class="num neg">${inr(a.extra_tax_if_sold_now)}+</td></tr>`).join("")}
        </tbody></table></div>` : none("No profitable short-term lots crossing into long-term in the next 90 days.")}</div>
    <div class="panel"><h2>4 · Losses you could bank for future years</h2><div class="actions">
      ${h.carry_forward.map((a) => actionCard(a, "carry")).join("") || none("No meaningful losses to carry forward.")}</div></div>`;
}

function renderRealized(r) {
  const rows = r.realized_fy.map((x) => `<tr><td>${fmtDate(x.sell_date)}</td><td>${esc(x.name)}</td><td>${fmtDate(x.buy_date)}</td>
    <td class="num">${units(x.units)}</td><td class="num">${inr(x.cost)}${x.grandfathered ? ' <span class="chip">GF</span>' : ""}</td>
    <td class="num">${inr(x.proceeds)}</td><td class="num">${signed(x.gain)}</td><td>${BUCKET[x.bucket]}</td></tr>`).join("");
  const t = r.tax;
  $("#tab-realized").innerHTML = `<div class="panel"><h2>Realised in ${r.fy}</h2>
    ${rows ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Sold</th><th>Fund</th><th>Bought</th><th class="num">Units</th><th class="num">Cost</th><th class="num">Proceeds</th><th class="num">Gain</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No redemptions this FY.</div>'}
    </div>
    <div class="panel"><h2>Tax estimate</h2><div class="table-wrap"><table class="compact"><thead><tr><th>Bucket</th><th class="num">Gross gains</th><th class="num">Taxable after set-off</th><th class="num">Tax (incl. cess)</th></tr></thead><tbody>
      ${Object.keys(BUCKET).map((b) => `<tr><td>${BUCKET[b]}</td><td class="num">${inr(t.gross[b])}</td><td class="num">${inr(t.taxable[b])}</td><td class="num">${inr(t.tax_by_bucket[b])}</td></tr>`).join("")}
      <tr><td><b>Total</b></td><td></td><td class="num muted">exempt used ${inr(t.exempt_used)}</td><td class="num"><b>${inr(t.tax)}</b></td></tr></tbody></table></div>
      <p class="muted">Includes gains entered under Settings → realised elsewhere. All-time realised gain in this tracker: ${signed(r.realized_all_time)}.</p></div>`;
}

function renderSettings(r) {
  const s = r.settings;
  const field = (key, label, val) => `<label>${label}<input type="number" step="any" inputmode="decimal" data-key="${key}" value="${val}"></label>`;
  const overrides = r.holdings.map((h) => `<tr><td>${esc(h.name)}</td><td class="muted hide-sm">${esc(h.category)}</td>
    <td><select data-override="${esc(h.code)}">${["", "equity", "debt", "other"].map((c) =>
      `<option value="${c}" ${(s.tax_class_overrides[h.code] || "") === c ? "selected" : ""}>${c || "auto"}</option>`).join("")}</select></td></tr>`).join("");
  $("#tab-settings").innerHTML = `<form id="settings-form">
    <div class="panel"><h2>Tax rates</h2><div class="form-grid">
      ${field("slab_rate", "Your income-tax slab (%)", s.slab_rate)}
      ${field("cess", "Cess (%)", s.cess)}
      ${field("eq_stcg_rate", "Equity STCG rate (%)", s.eq_stcg_rate)}
      ${field("ltcg_rate", "LTCG rate (%)", s.ltcg_rate)}
      ${field("ltcg_exemption", "Equity LTCG exemption (₹/yr)", s.ltcg_exemption)}
      ${field("exit_load_pct", "Assumed exit load < 1 yr (%)", s.exit_load_pct)}
    </div></div>
    <div class="panel"><h2>Realised elsewhere this FY</h2>
      <p class="muted">Gains from stocks, other folios or brokers that aren't in this tracker. Enter losses as negative numbers.</p>
      <div class="form-grid">
      ${field("external.eq_st", "Equity / stock STCG (₹)", s.external.eq_st)}
      ${field("external.eq_lt", "Equity / stock LTCG (₹)", s.external.eq_lt)}
      ${field("external.oth_lt", "Other LTCG @12.5% (₹)", s.external.oth_lt)}
      ${field("external.slab", "Gains taxed at slab (₹)", s.external.slab)}
      </div>
      <h3>Losses brought forward from earlier years</h3><div class="form-grid">
      ${field("carry_forward.st", "Short-term loss (₹)", s.carry_forward.st)}
      ${field("carry_forward.lt", "Long-term loss (₹)", s.carry_forward.lt)}
      </div></div>
    ${overrides ? `<div class="panel"><h2>Fund tax classification</h2>
      <p class="muted">Auto-detected from AMFI categories. <b>Equity</b>: ≥65% Indian equity (12-month rule). <b>Debt</b>: >65% debt (slab rate if bought from Apr 2023).
      <b>Other</b>: hybrids, FoFs, gold, international (24-month rule).</p>
      <div class="table-wrap"><table class="compact"><tbody>${overrides}</tbody></table></div></div>` : ""}
    <button type="submit">Save settings</button> <span id="settings-msg" class="muted"></span></form>`;
  $("#settings-form").addEventListener("submit", saveSettings);
}

async function saveSettings(e) {
  e.preventDefault();
  const s = loadSettings();
  s.tax_class_overrides = {};
  document.querySelectorAll("#settings-form [data-key]").forEach((el) => {
    const [a, b] = el.dataset.key.split(".");
    const v = parseFloat(el.value || "0") || 0;
    if (b) s[a][b] = v; else s[a] = v;
  });
  document.querySelectorAll("#settings-form [data-override]").forEach((el) => {
    if (el.value) s.tax_class_overrides[el.dataset.override] = el.value;
  });
  store.set(KEYS.settings, s);
  await compute();
  showTab("settings");
  $("#settings-msg").textContent = "Saved.";
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importCsv(text, mode) {
  const fresh = parseCsv(text, (isin) => byIsin[isin]);
  const all = sortTxns((mode === "append" ? loadTxns() : []).concat(fresh)).map((t, i) => ({ ...t, row: i + 2 }));
  // Replay before saving so an oversell or bad row never corrupts stored data.
  buildReport({ txns: all, schemes, settings: loadSettings() });
  saveTxns(all);
  return fresh.length;
}

// ---------- wiring ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

$("#refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try { await compute({ refresh: true }); } finally { e.target.disabled = false; }
});

const readInto = (f) => f.text().then((t) => { $("#csv").value = t; });
$("#pick").addEventListener("click", (e) => { e.preventDefault(); $("#file").click(); });
$("#file").addEventListener("change", (e) => e.target.files[0] && readInto(e.target.files[0]));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && readInto(e.dataTransfer.files[0]); });

async function runImport(text, mode) {
  const msg = $("#import-msg");
  try {
    const n = importCsv(text, mode);
    msg.innerHTML = `<span class="pos">Imported ${n} transactions.</span>`;
    $("#csv").value = "";
    await compute({ refresh: true });
    showTab("holdings");
  } catch (err) {
    if (!(err instanceof LedgerError)) console.error(err);
    msg.innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  }
}
$("#import-btn").addEventListener("click", () => runImport($("#csv").value, document.querySelector('input[name="mode"]:checked').value));
$("#sample-btn").addEventListener("click", async () => {
  if (loadTxns().length && !confirm("Replace your current transactions with the sample data?")) return;
  runImport(await (await fetch("sample_transactions.csv")).text(), "replace");
});

$("#backup-btn").addEventListener("click", () => download(`portfolio-backup-${todayISO()}.json`,
  JSON.stringify({ version: 1, exported: new Date().toISOString(), transactions: loadTxns(), settings: loadSettings() }, null, 2), "application/json"));
$("#csv-btn").addEventListener("click", () => download("transactions.csv", toCsv(loadTxns()), "text/csv"));
$("#restore-btn").addEventListener("click", () => $("#restore-file").click());
$("#restore-file").addEventListener("change", async (e) => {
  const msg = $("#data-msg");
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data.transactions)) throw new Error("Not a portfolio backup file.");
    if (loadTxns().length && !confirm("Replace the data in this browser with the backup?")) return;
    saveTxns(sortTxns(data.transactions));
    if (data.settings) store.set(KEYS.settings, data.settings);
    msg.innerHTML = `<span class="pos">Restored ${data.transactions.length} transactions.</span>`;
    await compute({ refresh: true });
  } catch (err) { msg.innerHTML = `<span class="neg">${esc(err.message)}</span>`; }
  e.target.value = "";
});
$("#clear-btn").addEventListener("click", async () => {
  if (!confirm("Delete all transactions and settings from this browser? Download a backup first if you need it.")) return;
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  await compute();
  $("#data-msg").textContent = "All data deleted from this browser.";
});

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    if (words.join("").length >= 2) {
      for (const s of Object.values(schemes)) {
        const hay = `${s.name} ${s.code} ${s.isin_growth}`.toLowerCase();
        if (words.every((w) => hay.includes(w)) && out.push(s) >= 25) break;
      }
    }
    $("#search-results").innerHTML = out.map((s) => `<tr><td><code>${esc(s.code)}</code></td><td>${esc(s.name)}</td>
      <td class="num">${s.nav}</td><td><span class="chip ${s.tax_class}">${s.tax_class}</span></td></tr>`).join("");
  }, 200);
});

(async () => {
  await loadSchemes();
  await compute();
  if (!state?.summary.transactions) showTab("import");
})();
