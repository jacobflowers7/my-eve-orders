// tests/cost-basis-detail.test.js
// contributingBuys: which buy transactions are still "in" the current
// weighted average — every buy since the position last fully cleared to
// zero. Mirrors computeCostBasis's own reset-at-zero behavior exactly.
const { run, check, summary } = require("./harness");

const row = (txId, date, typeId, qty, price, isBuy, characterId = 11, isPersonal = true) =>
  ({ transactionId: txId, date, typeId, quantity: qty, unitPrice: price, isBuy, characterId, isPersonal });

(async () => {
  const r = await run(`
    const row = ${row.toString()};
    return {
      // Two buys, no sells: both still contribute
      simple: contributingBuys([
        row(1, "2026-08-01", 34, 1000, 4, true),
        row(2, "2026-08-02", 34, 1000, 6, true),
      ], 34).map(x => x.transactionId),

      // Full clear then a fresh buy: only the post-clear buy contributes —
      // the pre-clear buy no longer affects today's average at all
      afterClear: contributingBuys([
        row(1, "2026-08-01", 34, 1000, 4, true),
        row(2, "2026-08-02", 34, 1000, 99, false),   // fully sells out the 1000
        row(3, "2026-08-03", 34, 500, 9, true),
      ], 34).map(x => x.transactionId),

      // Partial sell doesn't clear anything — both buys still contribute
      partialSell: contributingBuys([
        row(1, "2026-08-01", 34, 1000, 4, true),
        row(2, "2026-08-02", 34, 500, 99, false),
        row(3, "2026-08-03", 34, 500, 9, true),
      ], 34).map(x => x.transactionId),

      // Corp-wallet buy excluded, matching computeCostBasis's personal-only rule
      corpExcluded: contributingBuys([
        row(1, "2026-08-01", 34, 1000, 4, true, 11, false),
        row(2, "2026-08-02", 34, 500, 6, true, 11, true),
      ], 34).map(x => x.transactionId),

      // Different type entirely: not included
      otherType: contributingBuys([row(1, "2026-08-01", 99, 1, 1, true)], 34),

      // Sell-before-any-buy (partial basis): no crash, later buy still shows
      sellFirst: contributingBuys([
        row(1, "2026-08-01", 34, 100, 10, false),
        row(2, "2026-08-02", 34, 50, 8, true),
      ], 34).map(x => x.transactionId),
    };
  `);

  check("both buys contribute with no sells", JSON.stringify(r.simple) === "[1,2]");
  check("full clear drops the pre-clear buy", JSON.stringify(r.afterClear) === "[3]");
  check("partial sell keeps both buys", JSON.stringify(r.partialSell) === "[1,3]");
  check("corp-wallet buy excluded", JSON.stringify(r.corpExcluded) === "[2]");
  check("unrelated type returns empty", r.otherType.length === 0);
  check("sell-before-buy doesn't crash, later buy shows", JSON.stringify(r.sellFirst) === "[2]");
  summary("cost-basis-detail");
})();
