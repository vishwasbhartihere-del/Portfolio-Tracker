import * as E from "../site/engine.js";

const S = E.DEFAULT_SETTINGS;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const eq = (a, b, msg = "") => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const near = (a, b, d = 0.01, msg = "") => { if (Math.abs(a - b) > d) throw new Error(`${msg} expected ≈${b}, got ${a}`); };
const throws = (fn) => { try { fn(); } catch { return; } throw new Error("expected an error"); };
const lot = (key, buy_date, units, nav) => ({ key, buy_date, units, nav });
const fund = (key, price, lots, tax_class = "equity", lock = 0, asset_type = "mf") =>
  ({ key, name: key, price, tax_class, asset_type, lock_in_years: lock, lots: lots.map(([d, u, p]) => lot(key, d, u, p)) });
const TODAY = "2026-10-18";

// buckets & dates
test("equity 12-month boundary", () => {
  eq(E.bucketFor("equity", "2025-01-10", "2026-01-10"), "eq_st");
  eq(E.bucketFor("equity", "2025-01-10", "2026-01-11"), "eq_lt");
});
test("debt from Apr 2023 is always slab", () => {
  eq(E.bucketFor("debt", "2023-04-01", "2030-01-01"), "slab");
  eq(E.bucketFor("debt", "2022-01-01", "2026-01-01"), "oth_lt");
});
test("listed (gold ETF, SGB) is long-term after 12 months, slab before", () => {
  eq(E.bucketFor("listed", "2025-01-10", "2026-01-10"), "slab");
  eq(E.bucketFor("listed", "2025-01-10", "2026-01-11"), "oth_lt");
});
test("crypto is always VDA", () => eq(E.bucketFor("vda", "2020-01-01", "2026-01-01"), "vda"));
test("other needs 24 months", () => {
  eq(E.bucketFor("other", "2024-01-01", "2025-06-01"), "slab");
  eq(E.bucketFor("other", "2024-01-01", "2026-01-02"), "oth_lt");
});
test("addMonths clamps month end", () => { eq(E.addMonths("2024-01-31", 1), "2024-02-29"); eq(E.addMonths("2024-11-15", 3), "2025-02-15"); });
test("financial year", () => {
  eq(E.fyLabel("2026-10-18"), "FY 2026-27"); eq(E.fyLabel("2027-03-31"), "FY 2026-27"); eq(E.fyLabel("2027-04-01"), "FY 2027-28");
});

// tax
test("LTCG exemption", () => near(E.computeTax({ eq_lt: 200000 }, S).tax, 75000 * 0.125 * 1.04));
test("ST loss hits highest rate first", () => {
  const r = E.computeTax({ eq_st: [50000, -30000], slab: 50000 }, S);
  eq(r.taxable.slab, 20000); eq(r.taxable.eq_st, 50000);
});
test("LT loss cannot offset short-term", () => {
  const r = E.computeTax({ eq_st: 50000, eq_lt: -20000 }, S);
  eq(r.taxable.eq_st, 50000); eq(r.carry_forward.lt, 20000);
});
test("LT loss is absorbed by exempt gains (mandatory set-off)", () => {
  const r = E.computeTax({ eq_lt: [100000, -40000] }, S);
  eq(r.tax, 0); eq(r.carry_forward.lt, 0); eq(E.exemptionHeadroom(r, S), 65000);
});
test("crypto: 30% flat, losses ignored and can't offset anything", () => {
  const r = E.computeTax({ vda: [100000, -50000], eq_st: [-20000] }, S);
  near(r.tax_by_bucket.vda, 100000 * 0.3 * 1.04); eq(r.vda_loss_ignored, 50000); eq(r.carry_forward.st, 20000);
});
test("brought-forward losses", () => {
  const r = E.computeTax({ eq_st: 10000 }, S, { st: 25000, lt: 0 });
  eq(r.tax, 0); eq(r.carry_forward.st, 15000);
});

// ledger
test("FIFO + grandfathering", () => {
  const lots = [lot("X", "2017-01-01", 10, 50), lot("X", "2024-01-01", 10, 100)];
  const out = E.sellFifo(lots, 15, "2026-06-01", 120, "equity", () => 80);
  eq(out.length, 2); eq(out[0].grandfathered, true); eq(out[0].cost, 800); eq(out[1].units, 5); eq(lots[0].units, 5);
});
test("oversell rejected", () => throws(() => E.sellFifo([lot("X", "2024-01-01", 1, 10)], 2, "2025-01-01", 10, "equity")));
test("CSV: amount, SIP type, DD/MM/YYYY, quoted names", () => {
  const t = E.parseCsv('Date,Scheme Code,Fund Name,Type,Amount,NAV\n05/01/2024,100,"Fund, Growth",SIP,1000,50\n');
  eq(t[0].units, 20); eq(t[0].type, "BUY"); eq(t[0].date, "2024-01-05"); eq(t[0].name, "Fund, Growth");
});
test("CSV: invalid date rejected", () => throws(() => E.parseCsv("date,scheme_code,type,units,nav\n2026-02-30,1,BUY,1,1")));
test("CSV round trip", () => {
  const t = E.parseCsv("date,scheme_code,type,units,nav\n2024-01-01,1,BUY,10,5\n2024-02-01,1,SELL,4,6\n");
  const back = E.parseCsv(E.toCsv(t));
  eq(back.length, 2); eq(back[0].key, "mf:1"); eq(back[1].price, 6);
});
test("CSV: multi-asset format with fees and aliases", () => {
  const t = E.parseCsv("date,asset_type,symbol,type,quantity,price,fees,name,tax_class\n# comment\n" +
    "2024-01-01,etf,goldbees,BUY,100,50,10,,\n2024-01-02,crypto,btc,BUY,0.01,5000000,0,,\n2024-01-03,bond,XYZ,BUY,1,1000,,NCD,slab\n");
  eq(t[0].key, "stock:GOLDBEES"); near(t[0].nav, 50.1); eq(t[1].key, "crypto:BTC"); eq(t[2].tax_class, "slab");
});
test("CSV: unknown asset type rejected", () => throws(() => E.parseCsv("date,asset_type,symbol,type,quantity,price\n2024-01-01,car,X,BUY,1,1")));
test("sell fees reduce proceeds", () => {
  const t = E.parseCsv("date,asset_type,symbol,type,quantity,price,fees\n2024-01-01,stock,A,BUY,10,100,0\n2024-02-01,stock,A,SELL,10,110,20\n");
  const { realized } = E.buildLedger(t, () => "equity");
  eq(realized[0].gain, 80);
});
test("legacy stored transactions are upgraded", () => {
  const [t] = E.normaliseTxns([{ date: "2024-01-01", code: "122639", type: "BUY", units: 1, nav: 10, row: 2 }]);
  eq(t.key, "mf:122639"); eq(t.price, 10);
});
test("xirr", () => near(E.xirr([["2024-01-01", -100], ["2025-01-01", 110]]), 0.0997, 0.001));

// harvesting
test("gain harvest fills exemption exactly", () => {
  const out = E.suggest([fund("A", 200, [["2022-01-01", 2000, 100]])], {}, S, TODAY);
  eq(out.gain_harvest.length, 1); near(out.gain_harvest[0].gain, 125000, 1); eq(out.tax_after, 0);
});
test("gain harvest stops at short-term lot", () => {
  const out = E.suggest([fund("A", 200, [["2022-01-01", 100, 100], ["2026-05-01", 1000, 150]])], {}, S, TODAY);
  near(out.gain_harvest[0].units, 100, 0.01);
});
test("loss harvest offsets realised gains", () => {
  const out = E.suggest([fund("B", 80, [["2025-01-01", 1000, 100]])], { oth_lt: [30000] }, S, TODAY);
  eq(out.loss_harvest.length, 1); near(out.loss_harvest[0].tax_saved, 20000 * 0.125 * 1.04, 0.1);
});
test("ELSS locked units not sold", () => {
  eq(E.suggest([fund("E", 200, [["2024-01-01", 1000, 100]], "equity", 3)], {}, S, TODAY).gain_harvest.length, 0);
});
test("crypto losses are never suggested for harvesting", () => {
  const out = E.suggest([fund("crypto:BTC", 50, [["2025-01-01", 1, 100]], "vda", 0, "crypto")], { slab: [100000] }, S, TODAY);
  eq(out.loss_harvest.length, 0);
});
test("shares harvest in whole units", () => {
  const out = E.suggest([fund("stock:A", 200, [["2022-01-01", 2000, 100]], "equity", 0, "stock")], {}, S, TODAY);
  eq(out.gain_harvest[0].units, 1250);
});
test("exit load only on mutual funds", () => {
  const stock = E.suggest([fund("stock:B", 80, [["2026-01-01", 1000, 100]], "equity", 0, "stock")], { eq_st: [50000] }, S, TODAY);
  eq(stock.loss_harvest[0].exit_load, 0);
});
test("hold alert", () => {
  eq(E.suggest([fund("C", 120, [["2025-11-01", 100, 100]])], {}, S, TODAY).hold_alerts[0].long_term_on, "2026-11-02");
});
test("buildReport end to end", () => {
  const txns = E.parseCsv("date,scheme_code,type,units,nav\n2023-01-01,1,BUY,100,10\n2026-05-01,1,SELL,40,20\n");
  const r = E.buildReport({ txns, quotes: { "mf:1": { name: "F", price: 25, price_date: TODAY, tax_class: "equity" } }, settings: S, today: TODAY });
  eq(r.summary.value, 1500); eq(r.summary.invested, 600); eq(r.tax.gross.eq_lt, 400); eq(r.realized_fy.length, 1);
});
test("manual price beats missing feed; missing price warns", () => {
  const txns = E.parseCsv("date,asset_type,symbol,type,quantity,price\n2024-01-01,foreign,AAPL,BUY,2,15000\n2024-01-01,other,LAND,BUY,1,500000\n");
  const s = { ...S, manual_prices: { "foreign:AAPL": { price: 20000, date: TODAY } } };
  const r = E.buildReport({ txns, settings: s, today: TODAY });
  eq(r.holdings.find((h) => h.symbol === "AAPL").value, 40000);
  eq(r.warnings.length, 1);
  eq(r.allocation.length, 2);
});

// runner
const out = document.getElementById("out");
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); out.insertAdjacentHTML("beforeend", `<li class="ok">✓ ${name}</li>`); }
  catch (e) { failed++; out.insertAdjacentHTML("beforeend", `<li class="fail">✗ ${name}: ${e.message}</li>`); }
}
document.getElementById("summary").textContent = `${tests.length - failed}/${tests.length} passed`;
document.title = failed ? `FAIL (${failed})` : "PASS";
