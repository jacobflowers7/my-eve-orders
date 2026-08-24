// tests/order-derive.test.js
// Markup resolution + the one place margin math lives.
const { run, check, summary } = require("./harness");

(async () => {
  const r = await run(`
    // Rules: persistence + override resolution
    saveOrderRules({ globalPct: 20, perItem: { 35: 50 } });
    const rules = loadOrderRules();

    const fees = { brokerFee: 0.03, salesTax: 0.03 };   // fractions, currentFees() shape
    const sell = { is_buy_order: false, price: 130, volume_remain: 10, type_id: 34 };
    const buy  = { is_buy_order: true,  price: 90,  volume_remain: 10, type_id: 34 };
    const basis = { unitsOnHand: 100, totalCost: 10000, avgCost: 100, partial: false };

    return {
      globalPct:   resolveMarkupPct(rules, 34),
      overridePct: resolveMarkupPct(rules, 35),
      sellRow:  deriveOrderRow(sell, basis, 100, rules, fees),
      buyRow:   deriveOrderRow(buy,  basis, 100, rules, fees),
      partial:  deriveOrderRow(sell, { ...basis, partial: true }, 100, rules, fees),
      unknown:  deriveOrderRow(sell, undefined, 100, rules, fees),
      noRef:    deriveOrderRow(sell, basis, null, rules, fees),
      zeroFees: deriveOrderRow(sell, basis, 100, rules, { brokerFee: 0, salesTax: 0 }),
      belowRef: deriveOrderRow({ ...sell, price: 90 }, basis, 100, rules, fees),
      // stationRef is the 5th positional param that ref/basis math doesn't touch —
      // must be independent of, and not confused with, the Jita ref (100 here)
      station:      deriveOrderRow(sell, basis, 100, rules, fees, 110),
      noStationRef: deriveOrderRow(sell, basis, 100, rules, fees, null),
    };
  `);

  check("global markup resolves", r.globalPct === 20);
  check("per-item override wins", r.overridePct === 50);

  // sell: target = 100*1.2 = 120; delta = 120-130 = -10; impact = 100
  // net = 130*(1-0.06) = 122.2; margin = (122.2-100)/100*100 = 22.2
  check("sell target from ref*(1+markup)", r.sellRow.target === 120);
  check("sell delta", r.sellRow.delta === -10);
  check("impact = |delta|*qty", r.sellRow.impact === 100);
  check("sell margin net of fees", Math.abs(r.sellRow.marginPct - 22.2) < 1e-9);
  check("zero fees give gross margin", Math.abs(r.zeroFees.marginPct - 30) < 1e-9);

  // buy: target = 100*0.8 = 80; delta = 80-90 = -10; margin = (100-90)/100*100 = 10 (under ref = good)
  check("buy target from ref*(1-markup)", r.buyRow.target === 80);
  check("buy margin = % under reference", r.buyRow.marginPct === 10);

  check("partial basis suppresses margin", r.partial.marginPct === null && r.partial.basisState === "partial");
  check("unknown basis: n/a margin, avgCost null", r.unknown.marginPct === null &&
        r.unknown.avgCost === null && r.unknown.basisState === "unknown");
  check("no ref: target/delta/margin all null, still listed", r.noRef.target === null &&
        r.noRef.delta === null && r.noRef.marginPct === null && r.noRef.impact === 0);

  // vsJitaPct: current price vs Jita ref, direction-agnostic, no cost-basis dependency —
  // price=130, ref=100 → (130-100)/100*100 = 30 (priced 30% above Jita)
  check("vsJitaPct: price above ref is positive", r.sellRow.vsJitaPct === 30);
  check("vsJitaPct: price below ref is negative", r.belowRef.vsJitaPct === -10);
  check("vsJitaPct: needs no cost basis (unknown basis still populates)", r.unknown.vsJitaPct === 30);
  check("vsJitaPct: null when ref is missing", r.noRef.vsJitaPct === null);

  // vsStationPct: price=130, stationRef=110 → (130-110)/110*100 = 18.18...
  check("vsStationPct computed from stationRef, not the Jita ref", Math.abs(r.station.vsStationPct - 18.1818) < 1e-3);
  check("vsStationPct: null when stationRef missing (e.g. lone seller)", r.noStationRef.vsStationPct === null);
  check("vsStationPct: omitted stationRef arg is also null, doesn't crash", r.sellRow.vsStationPct === null);
  summary("order-derive");
})();
