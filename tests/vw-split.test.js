// tests/vw-split.test.js
// Volume-weighted 5% split: outlier immunity, thin books, one-sided fallback.
const { run, check, summary } = require("./harness");

(async () => {
  const r = await run(`
    // Sell side sorted ascending. Troll order: 1 unit at 10x the real price.
    const sells = [
      { price: 100, remain: 1 },        // outlier CHEAP order, 1 unit — must not define ref
      { price: 500, remain: 5000 },
      { price: 510, remain: 5000 },
    ];
    const buys = [
      { price: 480, remain: 4000 },
      { price: 470, remain: 4000 },
      { price: 1,   remain: 1 },        // 1-ISK troll buy, bottom of book — irrelevant either way
    ];
    return {
      // total sell vol 10001; 5% mark = 500.05 units → falls in the 500-order
      sellP: vwPercentilePrice(sells, 0.05),
      buyP:  vwPercentilePrice(buys, 0.05),
      ref:   jitaRefPrice(sells, buys),
      // Book thinner than the mark: single order carries everything
      thin:  vwPercentilePrice([{ price: 200, remain: 3 }], 0.05),
      empty: vwPercentilePrice([], 0.05),
      oneSided: jitaRefPrice(sells, []),
      bothEmpty: jitaRefPrice([], []),
    };
  `);

  check("outlier sell order absorbed by volume walk", r.sellP === 500);
  check("buy side percentile", r.buyP === 480);
  check("ref is the mean of both sides", r.ref === (500 + 480) / 2);
  check("thin book returns its only real price", r.thin === 200);
  check("empty book → null", r.empty === null);
  check("one-sided book falls back to populated side", r.oneSided === 500);
  check("both sides empty → null", r.bothEmpty === null);
  summary("vw-split");
})();
