// tests/cost-basis.test.js
// Weighted-average engine: buys, sells at avg, partial clamp, multi-char pooling.
const { run, check, summary } = require("./harness");

const row = (txId, date, typeId, qty, price, isBuy) =>
  ({ transactionId: txId, date, typeId, quantity: qty, unitPrice: price, isBuy });

(async () => {
  const r = await run(`
    const row = ${row.toString()};
    return {
      // Buys only: avg of 1000@4 + 1000@6 = 5
      buysOnly: computeCostBasis([
        row(1, "2026-08-01", 34, 1000, 4, true),
        row(2, "2026-08-02", 34, 1000, 6, true),
      ])[34],
      // Sell removes at current avg: 2000@5 avg, sell 1000 → 1000 left, avg still 5;
      // then buy 1000@9 → avg (5000+9000)/2000 = 7
      sellAtAvg: computeCostBasis([
        row(1, "2026-08-01", 34, 1000, 4, true),
        row(2, "2026-08-02", 34, 1000, 6, true),
        row(3, "2026-08-03", 34, 1000, 99, false),   // sale price is irrelevant to basis
        row(4, "2026-08-04", 34, 1000, 9, true),
      ])[34],
      // Sell before any buy: partial, clamped at zero, later buys still work
      partial: computeCostBasis([
        row(1, "2026-08-01", 35, 500, 10, false),
        row(2, "2026-08-02", 35, 200, 8, true),
      ])[35],
      // Oversell: 100 bought, 150 sold → clamp to 0, partial, avg null
      oversell: computeCostBasis([
        row(1, "2026-08-01", 36, 100, 10, true),
        row(2, "2026-08-02", 36, 150, 12, false),
      ])[36],
      // Sell-only type, no buy ever recorded: must be absent from result (not present with degenerate zero/null values)
      sellOnlyNoBuy: computeCostBasis([
        row(1, "2026-08-01", 40, 100, 10, false),
      ])[40] === undefined,
      // Unknown type: absent from result entirely
      unknown: computeCostBasis([row(1, "2026-08-01", 34, 1, 1, true)])[999] === undefined,
      // Rows arrive unsorted — engine must sort before folding
      unsorted: computeCostBasis([
        row(2, "2026-08-02", 37, 100, 99, false),
        row(1, "2026-08-01", 37, 100, 10, true),
      ])[37],
      // Zero-quantity rows are ignored
      zeroQty: computeCostBasis([
        row(1, "2026-08-01", 38, 0, 10, true),
        row(2, "2026-08-02", 38, 10, 5, true),
      ])[38],
      // Corp-wallet buy (isPersonal false) must not pool into the personal average
      corpMixed: computeCostBasis([
        { ...row(1, "2026-08-01", 41, 100, 10, true), isPersonal: true },
        { ...row(2, "2026-08-02", 41, 100, 90, true), isPersonal: false },
      ])[41],
      // A type whose ONLY buy history is corp-wallet has no personal basis at all
      corpOnly: computeCostBasis([
        { ...row(1, "2026-08-01", 42, 100, 10, true), isPersonal: false },
        { ...row(2, "2026-08-02", 42, 50, 12, false), isPersonal: true },
      ])[42] === undefined,
      // Legacy rows persisted before is_personal was tracked: missing = personal
      legacyMissingFlag: computeCostBasis([
        row(1, "2026-08-01", 43, 100, 10, true),
      ])[43],
      // With the toggle ON, corp-funded buys pool into the average like any
      // other buy — the one-person "buying corp as ISK source" setup.
      corpToggled: (() => {
        includeCorpBuys = true;
        const out = {
          mixed: computeCostBasis([
            { ...row(1, "2026-08-01", 41, 100, 10, true), isPersonal: true },
            { ...row(2, "2026-08-02", 41, 100, 90, true), isPersonal: false },
          ])[41],
          corpOnly: computeCostBasis([
            { ...row(1, "2026-08-01", 42, 100, 10, true), isPersonal: false },
          ])[42],
        };
        includeCorpBuys = false;   // don't leak into the assertions above on re-run
        return out;
      })(),
      // A clean sellout to zero AFTER a partial (mid-history) position clears
      // the flag: from here the average is exact again.
      resetAfterPartial: computeCostBasis([
        row(1, "2026-08-01", 44, 500, 10, false),   // sell-before-any-buy: partial, clamp to 0
        row(2, "2026-08-02", 44, 200, 8, true),
        row(3, "2026-08-03", 44, 200, 99, false),   // clean sellout: not oversold, clears to 0
        row(4, "2026-08-04", 44, 100, 12, true),
      ])[44],
      // An oversell that ALSO happens to land on zero in the same step must
      // stay partial — that step is itself the ambiguous one.
      oversellThenReset: computeCostBasis([
        row(1, "2026-08-01", 45, 100, 10, true),
        row(2, "2026-08-02", 45, 150, 12, false),   // oversells, clamps to 0 in the same step
      ])[45],
      // Self-trade: two of the user's own characters trading with each other
      // share transaction_id — must be a no-op on the pooled average, not a
      // real external buy+sell re-marking it to the transfer price.
      selfTrade: computeCostBasis([
        { key: "11:1", characterId: 11, transactionId: 1, date: "2026-08-01", typeId: 46,
          quantity: 100, unitPrice: 5, isBuy: true, isPersonal: true },
        { key: "11:2", characterId: 11, transactionId: 2, date: "2026-08-02", typeId: 46,
          quantity: 100, unitPrice: 10, isBuy: false, isPersonal: true },   // A sells 100@10 to B
        { key: "22:2", characterId: 22, transactionId: 2, date: "2026-08-02", typeId: 46,
          quantity: 100, unitPrice: 10, isBuy: true, isPersonal: true },
      ])[46],
    };
  `);

  check("buys average correctly", r.buysOnly.unitsOnHand === 2000 && r.buysOnly.avgCost === 5 && r.buysOnly.partial === false);
  check("sell removes at avg, later buy re-averages", r.sellAtAvg.unitsOnHand === 2000 && r.sellAtAvg.avgCost === 7);
  check("sell-before-buy flags partial", r.partial.partial === true && r.partial.unitsOnHand === 200 && r.partial.avgCost === 8);
  check("oversell clamps to zero, avg null", r.oversell.unitsOnHand === 0 && r.oversell.avgCost === null && r.oversell.partial === true);
  check("a clean sellout after a partial position clears the flag",
        r.resetAfterPartial.partial === false && r.resetAfterPartial.unitsOnHand === 100 && r.resetAfterPartial.avgCost === 12);
  check("an oversell landing on zero in the same step stays partial",
        r.oversellThenReset.partial === true && r.oversellThenReset.unitsOnHand === 0);
  check("a self-trade between two of the user's own characters is a no-op on the pooled average",
        r.selfTrade.unitsOnHand === 100 && r.selfTrade.avgCost === 5);
  check("sell-only type with no buy history: absent from result", r.sellOnlyNoBuy === true);
  check("no buy history → absent (Unknown)", r.unknown === true);
  check("unsorted input handled: sell after buy empties cleanly", r.unsorted.unitsOnHand === 0 && r.unsorted.partial === false);
  check("zero-qty rows ignored", r.zeroQty.unitsOnHand === 10 && r.zeroQty.avgCost === 5);
  check("corp-wallet buy excluded from personal average",
        r.corpMixed.unitsOnHand === 100 && r.corpMixed.avgCost === 10);
  check("corp-only buy history leaves no personal basis", r.corpOnly === true);
  check("legacy rows without isPersonal still count as personal",
        r.legacyMissingFlag.unitsOnHand === 100 && r.legacyMissingFlag.avgCost === 10);
  check("toggle on: corp buy pools into the average",
        r.corpToggled.mixed.unitsOnHand === 200 && r.corpToggled.mixed.avgCost === 50);
  check("toggle on: corp-only history now yields a basis",
        r.corpToggled.corpOnly.unitsOnHand === 100 && r.corpToggled.corpOnly.avgCost === 10);
  summary("cost-basis");
})();
