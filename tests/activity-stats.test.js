// computeActivityStats: EVE-day (UTC) windows, fee math, partial basis, corp toggles.
const { run, check, summary } = require("./harness");

const NOW = Date.parse("2026-09-02T12:00:00Z");
let nextId = 1;
const row = (date, over = {}) => ({
  key: `11:${nextId}`, characterId: 11, transactionId: nextId++, typeId: 34,
  date, quantity: 1, unitPrice: 100, isBuy: false, locationId: 60003760,
  isPersonal: true, ...over,
});
const near = (a, b) => Math.abs(a - b) < 1e-6;
const stats = (rows, { pre = "", opts = "{}" } = {}) => run(`
  ${pre}
  return computeActivityStats(${JSON.stringify(rows)},
    { brokerFee: 0.03, salesTax: 0.036 }, ${NOW}, ${opts});
`);
const OFF = { opts: "{ includeCorpSells: false }" };

(async () => {
  // ── A. Window bounds + fee math (net factor 1 − 0.03 − 0.036 = 0.934) ─────
  const a = await stats([
    row("2026-08-01T00:00:00Z", { isBuy: true, quantity: 10, unitPrice: 100 }),
    row("2026-08-26T23:59:59Z", { quantity: 1, unitPrice: 100 }),  // before weekStart — excluded
    row("2026-08-27T00:00:00Z", { quantity: 1, unitPrice: 100 }),  // exactly weekStart — included
    row("2026-08-28T10:00:00Z", { quantity: 2, unitPrice: 150 }),
    row("2026-09-02T08:00:00Z", { quantity: 4, unitPrice: 200 }),  // today
  ]);
  check("today: one fill", a.today.fills === 1);
  check("today: gross revenue", a.today.revenue === 800);
  check("today: profit = 4×(200×0.934 − 100)", near(a.today.profit, 347.2));
  check("today: fully covered", a.today.profitPartial === false);
  check("week: boundary fill at 00:00 UTC included, 23:59:59 excluded", a.week.fills === 3);
  check("week: revenue sums included fills only", a.week.revenue === 1200);
  check("week: profit includes a negative fill", near(a.week.profit, -6.6 + 80.2 + 347.2));
  check("week: fully covered", a.week.profitPartial === false);

  // ── B. Partial basis: no-buy-history and oversell ──────────────────────────
  const b = await stats([
    row("2026-09-02T01:00:00Z", { typeId: 35, quantity: 5, unitPrice: 200 }), // no buys at all
    row("2026-08-01T00:00:00Z", { typeId: 36, isBuy: true, quantity: 3, unitPrice: 100 }),
    row("2026-09-02T02:00:00Z", { typeId: 36, quantity: 5, unitPrice: 200 }), // oversell: covered 3 of 5
  ]);
  check("partial: fills and gross revenue still counted", b.today.fills === 2 && b.today.revenue === 2000);
  check("partial: profit covers only covered units", near(b.today.profit, 3 * (200 * 0.934 - 100)));
  check("partial: flag set on both windows", b.today.profitPartial === true && b.week.profitPartial === true);

  // ── C. Corp sells: dashboard toggle × includeCorpBuys ──────────────────────
  const corpRows = [
    row("2026-08-01T00:00:00Z", { typeId: 40, isBuy: true, quantity: 10, unitPrice: 100, isPersonal: false }),
    row("2026-09-02T03:00:00Z", { typeId: 40, quantity: 2, unitPrice: 200, isPersonal: false }),
    row("2026-08-01T01:00:00Z", { typeId: 41, isBuy: true, quantity: 5, unitPrice: 50 }),
    row("2026-09-02T04:00:00Z", { typeId: 41, quantity: 1, unitPrice: 100 }),
  ];
  const cOn = await stats(corpRows);                       // includeCorpSells defaults true
  check("corp sell counted when toggle on", cOn.today.fills === 2 && cOn.today.revenue === 500);
  check("corp sell without corp-buys basis → revenue yes, profit no, partial",
        near(cOn.today.profit, 1 * (100 * 0.934 - 50)) && cOn.today.profitPartial === true);
  const cOff = await stats(corpRows, OFF);
  check("corp sell excluded when toggle off", cOff.today.fills === 1 && cOff.today.revenue === 100);
  check("toggle off → personal profit only, no partial",
        near(cOff.today.profit, 1 * (100 * 0.934 - 50)) && cOff.today.profitPartial === false);
  const cBasis = await stats(corpRows, { pre: "includeCorpBuys = true;" });
  check("corp buys eligible → corp sell gets real profit, no partial",
        near(cBasis.today.profit, 2 * (200 * 0.934 - 100) + 1 * (100 * 0.934 - 50))
        && cBasis.today.profitPartial === false);

  // ── D. Legacy rows + junk quantities ───────────────────────────────────────
  const legacyBuy  = row("2026-08-01T00:00:00Z", { typeId: 50, isBuy: true, quantity: 2, unitPrice: 100 });
  const legacySell = row("2026-09-02T05:00:00Z", { typeId: 50, quantity: 1, unitPrice: 200 });
  delete legacyBuy.isPersonal; delete legacySell.isPersonal;
  const d = await stats([legacyBuy, legacySell,
    row("2026-09-02T06:00:00Z", { quantity: 0 })], OFF);
  check("rows without isPersonal count as personal even with toggle off",
        d.today.fills === 1 && near(d.today.profit, 200 * 0.934 - 100));
  check("zero-quantity rows are skipped", d.today.revenue === 200);

  // ── E. fmtIskSigned ────────────────────────────────────────────────────────
  const f = await run(`return [fmtIskSigned(6.24e9), fmtIskSigned(-347200), fmtIskSigned(0)];`);
  check("fmtIskSigned formats sign + magnitude",
        f[0] === "6.24 B" && f[1] === "−347.2 K" && f[2] === "0");

  summary("activity-stats");
})();
