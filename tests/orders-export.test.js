// tests/orders-export.test.js
// buildOrdersExportPlan is pure — no SheetJS calls — so the export's layout
// and formula strings are fully testable without loading the vendored library.
const { run, check, summary } = require("./harness");

(async () => {
  const r = await run(`
    return {
      colLetters: [0, 1, 25, 26].map(xlsxColLetter),      // A, B, Z, AA
      addr: xlsxAddr(0, 0),                                 // A1
      addrRow5col6: xlsxAddr(5, 6),                          // G6
      addrAbs: xlsxAddrAbs(2, 1),                            // $B$3
    };
  `);
  check("col letters: 0→A, 1→B, 25→Z, 26→AA", JSON.stringify(r.colLetters) === '["A","B","Z","AA"]');
  check("addr(0,0) is A1", r.addr === "A1");
  check("addr(5,6) is G6", r.addrRow5col6 === "G6");
  check("absolute addr uses $ on both parts", r.addrAbs === "$B$3");

  const r2 = await run(`
    const rules = { globalPct: 20, perItem: { 35: 50 } };
    const fees  = { brokerFee: 0.03, salesTax: 0.03 };
    const typeNames = { 34: "Tritanium", 35: "Pyerite" };
    const locNames  = { 60003760: "Jita IV - Moon 4" };

    const sell = { order_id: 1, type_id: 34, price: 130, volume_remain: 10, volume_total: 20,
                   is_buy_order: false, location_id: 60003760, characterName: "Alpha" };
    const buy  = { order_id: 2, type_id: 35, price: 90, volume_remain: 5, volume_total: 5,
                   is_buy_order: true, location_id: 60003760, characterName: "Alpha" };
    const noBasisSell = { order_id: 3, type_id: 34, price: 50, volume_remain: 1, volume_total: 1,
                          is_buy_order: false, location_id: 60003760, characterName: "Beta" };

    const rows = [
      { o: sell, ref: 100, bestRef: 105, avgCost: 100, basisState: "known" },
      { o: buy,  ref: 100, bestRef: null, avgCost: null, basisState: "unknown" },
      { o: noBasisSell, ref: 100, bestRef: null, avgCost: null, basisState: "unknown" },
    ];

    const plan = buildOrdersExportPlan(rows, rules, fees, typeNames, locNames);
    const byCell = (r, c) => plan.formulas.find(x => x.r === r && x.c === c);
    return {
      header: plan.aoa[4],
      settingsRow: plan.aoa[2],
      sellDataRow: plan.aoa[5],
      buyDataRow: plan.aoa[6],
      noBasisRow: plan.aoa[7],
      // row 5 = sell (has global markup, no override) → markup formula present
      sellMarkupFormula: byCell(5, 12),
      // row 6 = buy with an override (type 35) → no markup formula, literal in AOA instead
      buyMarkupFormula: byCell(6, 12),
      sellTargetFormula: byCell(5, 13),
      buyTargetFormula: byCell(6, 13),
      sellMarginFormula: byCell(5, 16),
      buyMarginFormula: byCell(6, 16),
      noBasisMarginFormula: byCell(7, 16),
      sellEstProfitFormula: byCell(5, 17),
      buyEstProfitFormula: byCell(6, 17),
      noBasisEstProfitFormula: byCell(7, 17),
      vsJitaFormula: byCell(5, 9),
      vsBestFormula: byCell(5, 11),
      deltaFormula: byCell(5, 14),
      impactFormula: byCell(5, 15),
    };
  `);

  check("header row matches the 18-column layout", JSON.stringify(r2.header) ===
    JSON.stringify(["Character","Item","Side","Station","Qty Remain","Qty Total","Your Price",
      "Avg Cost","Jita Ref","vs Jita %","Best Offer","vs Best %","Markup %",
      "Target","Delta","Impact","Margin %","Est. Profit"]));
  check("settings row holds global markup and fees as percent values",
        JSON.stringify(r2.settingsRow) === '["Global Markup %",20,"Broker Fee %",3,"Sales Tax %",3]');

  check("sell row: static snapshot values", JSON.stringify(r2.sellDataRow.slice(0, 9)) ===
    JSON.stringify(["Alpha", "Tritanium", "Sell", "Jita IV - Moon 4", 10, 20, 130, 100, 100]));
  check("sell row: best-offer snapshot lands in the Best Offer column", r2.sellDataRow[10] === 105);
  check("no best offer → Best Offer cell blank, so the vs Best % formula blanks too", r2.buyDataRow[10] === "");
  check("sell row: no per-item override → markup cell blank in AOA (formula fills it)", r2.sellDataRow[12] === "");
  check("buy row: per-item override → literal 50 in AOA, no formula for that cell",
        r2.buyDataRow[12] === 50 && r2.buyMarkupFormula === undefined);

  check("sell markup formula references the global settings cell", r2.sellMarkupFormula.f === "$B$3");
  check("sell target formula marks UP: ref*(1+markup/100)", r2.sellTargetFormula.f.includes("*(1+M6/100))"));
  check("buy target formula marks DOWN: ref*(1-markup/100)", r2.buyTargetFormula.f.includes("*(1-M7/100))"));
  check("sell margin (known basis) references fee cells", r2.sellMarginFormula.f.includes("$D$3") && r2.sellMarginFormula.f.includes("$F$3"));
  // The sheet must blank the same cells the app blanks. deriveOrderRow suppresses
  // sell margin when there's no Jita ref or a non-positive avg cost, so the
  // formula has to guard the ref cell (I) and H<=0 — otherwise the export shows a
  // margin the app itself reports as n/a, or #DIV/0! on a zero basis.
  check("sell margin blanks when the Jita ref cell is empty", r2.sellMarginFormula.f.includes('I6=""'));
  check("sell margin blanks on a non-positive avg cost", r2.sellMarginFormula.f.includes("H6<=0"));
  check("buy margin needs no cost basis, just the reference", r2.buyMarginFormula.f === 'IF(I7="","",(I7-G7)/I7*100)');
  check("no-basis sell gets a literal n/a, not a formula", r2.noBasisRow[16] === "n/a" && r2.noBasisMarginFormula === undefined);
  check("sell est. profit (known basis) is net proceeds minus avg cost, times qty remain",
        r2.sellEstProfitFormula.f === 'IF(OR(G6="",H6="",H6<=0,I6=""),"",((G6*(1-$D$3/100-$F$3/100))-H6)*E6)');
  check("buy orders get no est. profit — nothing has been sold", r2.buyEstProfitFormula === undefined && r2.buyDataRow[17] === "");
  check("no-basis sell gets a literal n/a for est. profit too", r2.noBasisRow[17] === "n/a" && r2.noBasisEstProfitFormula === undefined);
  check("vs Jita % formula is direction-agnostic (price vs ref)", r2.vsJitaFormula.f === 'IF(I6="","",(G6-I6)/I6*100)');
  check("vs Best % formula references the best-offer column", r2.vsBestFormula.f === 'IF(K6="","",(G6-K6)/K6*100)');
  check("delta formula is target minus price", r2.deltaFormula.f === 'IF(N6="","",N6-G6)');
  check("impact formula is abs(delta) times qty remain", r2.impactFormula.f === 'IF(O6="","",ABS(O6)*E6)');
  summary("orders-export");
})();
