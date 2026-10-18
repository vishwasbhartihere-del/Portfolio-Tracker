import * as E from "../site/engine.js";

const S = E.DEFAULT_SETTINGS;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const eq = (a, b, msg = "") => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const near = (a, b, d = 0.01, msg = "") => { if (Math.abs(a - b) > d) throw new Error(`${msg} expected ≈${b}, got ${a}`); };
const throws = (fn) => { try { fn(); } catch { return; } throw new Error("expected an error"); };
const lot = (code, buy_date, units, nav) => ({ code, buy_date, units, nav });
const fund = (code, nav, lots, tax_class = "equity", lock = 0) =>
  ({ code, name: code, nav, tax_class, lock_in_years: lock, lots: lots.map(([d, u, p]) => lot(code, d, u, p)) });
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
  eq(E.parseCsv(E.toCsv(t)).length, 2);
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
test("hold alert", () => {
  eq(E.suggest([fund("C", 120, [["2025-11-01", 100, 100]])], {}, S, TODAY).hold_alerts[0].long_term_on, "2026-11-02");
});
test("buildReport end to end", () => {
  const txns = E.parseCsv("date,scheme_code,type,units,nav\n2023-01-01,1,BUY,100,10\n2026-05-01,1,SELL,40,20\n");
  const r = E.buildReport({ txns, schemes: { 1: { name: "F", nav: 25, nav_date: TODAY, tax_class: "equity", lock_in_years: 0 } }, settings: S, today: TODAY });
  eq(r.summary.value, 1500); eq(r.summary.invested, 600); eq(r.tax.gross.eq_lt, 400); eq(r.realized_fy.length, 1);
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
