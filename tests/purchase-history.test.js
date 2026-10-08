// tests/purchase-history.test.js
// Covers the cache that outlives EVE's own transaction window: the stats, the
// JSON backup/restore round-trip, the Excel round-trip, and the Avg Cost
// baseline recovered from older spreadsheets. All of it is pure logic — the
// IndexedDB and file-picker halves are browser-only and checked by hand.
const { run, check, summary } = require("./harness");

const mkRow = (over = {}) => ({
  key: "11:5", characterId: 11, transactionId: 5, date: "2026-08-10T12:00:00Z",
  typeId: 34, quantity: 100, unitPrice: 4.5, isBuy: true,
  locationId: 60003760, isPersonal: true, ...over,
});

(async () => {
  // ── 1. Stats ─────────────────────────────────────────────────────────────
  const s = await run(`
    const rows = [
      ${JSON.stringify(mkRow())},
      ${JSON.stringify(mkRow({ key: "11:6", transactionId: 6, date: "2026-07-01T00:00:00Z", isBuy: false }))},
      ${JSON.stringify(mkRow({ key: "22:7", characterId: 22, transactionId: 7, date: "2026-09-01T00:00:00Z" }))},
      ${JSON.stringify(mkRow())},                                   // exact duplicate key
      ${JSON.stringify(mkRow({ key: "33:9", characterId: 33, transactionId: 9, date: "not-a-date" }))},
    ];
    const st = purchaseHistoryStats(rows);
    return { count: st.count, buys: st.buys, sells: st.sells,
             oldest: st.oldest && new Date(st.oldest).toISOString().slice(0, 10),
             newest: st.newest && new Date(st.newest).toISOString().slice(0, 10),
             chars: st.characters.map(c => [c.characterId, c.count]) };
  `);
  check("stats dedupes by key — the duplicate row isn't counted twice", s.count === 4);
  check("stats splits buys from sells", s.buys === 3 && s.sells === 1);
  check("stats finds the oldest and newest dates, ignoring unparseable ones",
        s.oldest === "2026-07-01" && s.newest === "2026-09-01");
  check("stats breaks counts down per character, busiest first",
        JSON.stringify(s.chars) === JSON.stringify([[11, 2], [22, 1], [33, 1]]));

  const empty = await run(`return purchaseHistoryStats([]);`);
  check("stats on an empty cache is all zeroes, no dates",
        empty.count === 0 && empty.oldest === null && empty.newest === null && empty.characters.length === 0);

  // ── 2. JSON backup / restore round-trip ──────────────────────────────────
  const rt = await run(`
    const rows = [
      ${JSON.stringify(mkRow())},
      ${JSON.stringify(mkRow({ key: "22:8", characterId: 22, transactionId: 8, isBuy: false, isPersonal: false }))},
    ];
    const payload = buildPurchaseHistoryExport(rows, { 11: "Alpha", 22: "Beta" }, "2026-10-08T00:00:00.000Z",
      [{ key: "tritanium", typeName: "Tritanium", avgCost: 77, asOf: "2026-09-01" }]);
    const back = parsePurchaseHistoryImport(payload);
    return {
      format: payload.format,
      count: payload.count,
      chars: payload.characters,
      baseline: payload.costBaseline.length,
      errors: back.errors,
      skipped: back.skipped,
      n: back.rows.length,
      first: back.rows[0],
      corpRow: back.rows.find(r => r.key === "22:8"),
      restoredBaseline: back.baseline,
    };
  `);
  check("export is tagged with its format and row count",
        rt.format === "my-orders-purchase-history" && rt.count === 2);
  check("export carries character names so a restore isn't just ids",
        rt.chars["11"] === "Alpha" && rt.chars["22"] === "Beta");
  check("a clean backup parses with no errors and nothing skipped",
        rt.errors.length === 0 && rt.skipped === 0 && rt.n === 2);
  check("round-trip preserves the transaction's identity and economics",
        rt.first.key === "11:5" && rt.first.quantity === 100 && rt.first.unitPrice === 4.5 &&
        rt.first.isBuy === true && rt.first.date === "2026-08-10T12:00:00Z");
  check("round-trip preserves the corp-funded flag (the one that changes cost basis)",
        rt.corpRow.isPersonal === false);
  check("round-trip carries the recovered-average baseline through too",
        rt.restoredBaseline.length === 1 && rt.restoredBaseline[0].avgCost === 77);

  // ── 3. Import rejects what it can't trust ────────────────────────────────
  const bad = await run(`
    return {
      notAnObject: parsePurchaseHistoryImport("nope").errors.length,
      wrongFormat: parsePurchaseHistoryImport({ format: "something-else", transactions: [] }).errors.length,
      noList:      parsePurchaseHistoryImport({ format: "my-orders-purchase-history" }).errors.length,
    };
  `);
  check("a non-object file is rejected", bad.notAnObject === 1);
  check("a file from another tool is rejected by format tag", bad.wrongFormat === 1);
  check("a file with no transactions list is rejected", bad.noList === 1);

  const partial = await run(`
    const mk = (o) => Object.assign({
      format: "my-orders-purchase-history", transactions: [o],
    });
    const one = (o) => parsePurchaseHistoryImport(mk(o));
    return {
      negativeQty:  one({ characterId: 1, transactionId: 2, typeId: 3, quantity: -5, unitPrice: 1, date: "2026-01-01" }),
      zeroQty:      one({ characterId: 1, transactionId: 2, typeId: 3, quantity: 0,  unitPrice: 1, date: "2026-01-01" }),
      badDate:      one({ characterId: 1, transactionId: 2, typeId: 3, quantity: 5,  unitPrice: 1, date: "yesterday" }),
      missingId:    one({ characterId: 1, typeId: 3, quantity: 5, unitPrice: 1, date: "2026-01-01" }),
      nullRow:      one(null),
    };
  `);
  check("a negative quantity is skipped, not imported", partial.negativeQty.rows.length === 0 && partial.negativeQty.skipped === 1);
  check("a zero quantity is skipped — it would poison the weighted average", partial.zeroQty.skipped === 1);
  check("an unparseable date is skipped — the cost engine replays in date order", partial.badDate.skipped === 1);
  check("a row missing its transaction id is skipped", partial.missingId.skipped === 1);
  check("a null entry in the list is skipped rather than throwing", partial.nullRow.skipped === 1);

  // ── 4. Excel sheet round-trip ────────────────────────────────────────────
  const xl = await run(`
    const rows = [
      ${JSON.stringify(mkRow())},
      ${JSON.stringify(mkRow({ key: "22:8", characterId: 22, transactionId: 8, isBuy: false, isPersonal: false,
                               date: "2026-09-02T08:00:00Z", typeId: 35, quantity: 3, unitPrice: 1000 }))},
    ];
    const aoa = buildPurchaseHistorySheet(rows, {
      typeNames: { 34: "Tritanium", 35: "Pyerite" },
      locationNames: { 60003760: "Jita IV - Moon 4" },
      charNames: { 11: "Alpha", 22: "Beta" },
    });
    const back = parsePurchaseHistorySheet(aoa);
    return {
      header: aoa[0],
      // Rows come out newest-first, so find the Tritanium row rather than
      // assuming it's the first one.
      tritRow: aoa.find(r => r[2] === "Tritanium"),
      order: aoa.slice(1).map(r => r[2]),
      n: back.rows.length,
      skipped: back.skipped,
      first: back.rows.find(r => r.key === "11:5"),
      corp: back.rows.find(r => r.key === "22:8"),
    };
  `);
  check("sheet header carries the id columns that make it round-trippable",
        JSON.stringify(xl.header) === JSON.stringify(["Date", "Character", "Item", "Side", "Qty",
          "Unit Price", "Total", "Location", "Location ID", "Character ID", "Type ID",
          "Transaction ID", "Corp-funded"]));
  check("sheet resolves names rather than dumping raw ids",
        xl.tritRow[1] === "Alpha" && xl.tritRow[7] === "Jita IV - Moon 4");
  check("sheet still carries the raw ids alongside the names",
        xl.tritRow[8] === 60003760 && xl.tritRow[9] === 11 && xl.tritRow[10] === 34 && xl.tritRow[11] === 5);
  check("sheet writes newest first", JSON.stringify(xl.order) === JSON.stringify(["Pyerite", "Tritanium"]));
  check("sheet round-trips with nothing lost or skipped", xl.n === 2 && xl.skipped === 0);
  check("round-trip restores quantity, price, side and the item id",
        xl.first.quantity === 100 && xl.first.unitPrice === 4.5 &&
        xl.first.isBuy === true && xl.first.typeId === 34);
  check("round-trip restores the character and transaction ids that form the key",
        xl.corp.key === "22:8" && xl.corp.characterId === 22 && xl.corp.transactionId === 8);
  check("round-trip restores a corp-funded row as corp-funded",
        xl.corp.isPersonal === false && xl.corp.isBuy === false);
  check("dates survive the round-trip to the same instant",
        Date.parse(xl.first.date) === Date.parse("2026-08-10T12:00:00Z"));
  // The station is only written as a name in the readable column, so without the
  // id riding along every restored row would read as "Location 0".
  check("the station survives the round-trip, not just its name",
        xl.first.locationId === 60003760 && xl.corp.locationId === 60003760);

  // ── 5. Excel date handling ───────────────────────────────────────────────
  const dates = await run(`
    return {
      iso: phParseDate("2026-08-10T12:00:00Z"),
      // 25569 is Excel's serial for 1970-01-01 — the anchor that proves the
      // epoch conversion isn't off by the 1900 leap-day bug.
      serial: phParseDate(25569),
      later: phParseDate(26000) > phParseDate(25569),
      blank: phParseDate(""),
      junk: phParseDate("whenever"),
      nul: phParseDate(null),
    };
  `);
  check("an ISO date string round-trips", dates.iso === "2026-08-10T12:00:00.000Z");
  check("Excel serial 25569 converts to 1970-01-01", String(dates.serial).startsWith("1970-01-01"));
  check("later serials convert to later dates", dates.later === true);
  check("a blank or junk date yields null rather than Invalid Date",
        dates.blank === null && dates.junk === null && dates.nul === null);

  const skips = await run(`
    const aoa = [
      ["Date","Character","Item","Side","Qty","Unit Price","Total","Location","Character ID","Type ID","Transaction ID","Corp-funded"],
      ["2026-08-10","Alpha","Tritanium","Buy",10,5,50,"Jita",11,34,1,""],
      ["2026-08-11","Alpha","Tritanium","Buy",0,5,0,"Jita",11,34,2,""],      // zero qty
      ["whenever","Alpha","Tritanium","Buy",10,5,50,"Jita",11,34,3,""],      // bad date
      ["2026-08-12","Alpha","Tritanium","Hmm",10,5,50,"Jita",11,34,4,""],    // unknown side
      ["2026-08-13","Alpha","Tritanium","Sell",10,5,50,"Jita",,34,5,""],     // missing char id → 0
      ["", "", "", "", "", "", "", "", "", "", "", ""],                       // blank row
    ];
    const res = parsePurchaseHistorySheet(aoa);
    return { n: res.rows.length, skipped: res.skipped, keys: res.rows.map(r => r.key) };
  `);
  check("only the two valid rows come back", skips.n === 2);
  check("each rejected row is counted, not silently dropped", skips.skipped === 3);
  check("a row with no Character ID still round-trips under a stable key",
        skips.keys.includes("0:5"));
  check("a sheet written before Location ID existed still imports, station unknown",
        (await run(`
          const res = parsePurchaseHistorySheet([
            ["Date","Character","Item","Side","Qty","Unit Price","Total","Location","Character ID","Type ID","Transaction ID","Corp-funded"],
            ["2026-08-10","Alpha","Tritanium","Buy",10,5,50,"Jita IV",11,34,1,""],
          ]);
          return res.rows[0].locationId;
        `)) === 0);
  check("a sheet with no Transaction ID column isn't mistaken for history",
        (await run(`return parsePurchaseHistorySheet([["Item","Avg Cost"],["Tritanium",100]]).rows.length;`)) === 0);

  // ── 6. Recovering Avg Cost from an older orders export ───────────────────
  const base = await run(`
    const aoa = [
      ["EVE Orders Export"],
      [],
      ["Global Markup %", 20, "Broker Fee %", 3, "Sales Tax %", 3.6],
      [],
      ["Character","Item","Side","Station","Qty Remain","Qty Total","Your Price","Avg Cost"],
      ["Alpha","Tritanium","Sell","Jita",10,20,130,100],
      ["Alpha","Pyerite","Sell","Jita",5,5,90,""],          // blank Avg Cost — nothing to recover
      ["Beta","Mexallon","Sell","Amarr",1,1,50,2500.5],
      ["Beta","Tritanium","Sell","Amarr",2,2,140,120],      // repeat — later row wins
    ];
    return parseCostBaselineFromOrders(aoa, "2026-10-08T00:00:00.000Z");
  `);
  check("baseline is recovered for every item with an Avg Cost", base.length === 2);
  check("the recovered value is the item's Avg Cost, keyed by lower-cased name",
        base.find(b => b.key === "tritanium").avgCost === 120 &&
        base.find(b => b.key === "mexallon").avgCost === 2500.5);
  check("an item with a blank Avg Cost yields nothing rather than a zero",
        !base.some(b => b.key === "pyerite"));
  check("baseline records when it was recovered and where from",
        base.every(b => b.asOf === "2026-10-08T00:00:00.000Z" && b.source === "excel-import"));
  check("a workbook with no Avg Cost column produces no baseline",
        (await run(`return parseCostBaselineFromOrders([["Item","Price"],["Tritanium",100]]).length;`)) === 0);

  // ── 7. Applying the baseline to cost basis ───────────────────────────────
  const applied = await run(`
    const basis = {
      34: { unitsOnHand: 0, totalCost: 0, avgCost: null, partial: false },
      35: { unitsOnHand: 10, totalCost: 1000, avgCost: 100, partial: false },
      36: { unitsOnHand: 0, totalCost: 0, avgCost: null, partial: true },
    };
    const baseline = [{ key: "tritanium", typeName: "Tritanium", avgCost: 77, asOf: "2026-09-01" }];
    const typeNames = { 34: "Tritanium", 35: "Pyerite", 36: "Mexallon" };
    const out = applyCostBaseline(basis, baseline, typeNames);
    return {
      filled: out[34],
      untouched: out[35],
      noMatch: out[36],
      inputIntact: basis[34].avgCost,
      partialCleared: out[36].partial,
    };
  `);
  check("a type with no usable average picks up the recovered figure",
        applied.filled.avgCost === 77 && applied.filled.fromBaseline === true);
  check("the recovery date is kept so the UI can explain where the number came from",
        applied.filled.baselineAsOf === "2026-09-01");
  check("a real ledger average is never overwritten by an imported one",
        applied.untouched.avgCost === 100 && applied.untouched.fromBaseline === undefined);
  check("applyCostBaseline does not mutate the basis it was given", applied.inputIntact === null);
  check("an item with no matching baseline is left alone", applied.noMatch.avgCost === null);
  check("bogus baseline values are ignored",
        (await run(`
          const out = applyCostBaseline({ 34: { avgCost: null } },
            [{ key: "tritanium", avgCost: 0 }, { key: "tritanium", avgCost: -5 }],
            { 34: "Tritanium" });
          return out[34].avgCost;
        `)) === null);
  check("baseline matching ignores case and padding",
        (await run(`
          const out = applyCostBaseline({ 34: { avgCost: null } },
            [{ key: costBaselineKey("  TRITANIUM "), avgCost: 55 }], { 34: "Tritanium" });
          return out[34].avgCost;
        `)) === 55);

  // ── 8. A recovered average must not masquerade as a live one ─────────────
  const badge = await run(`
    const basis = { 34: { avgCost: 77, fromBaseline: true, partial: false } };
    const d = deriveOrderRow(
      { order_id: 1, type_id: 34, price: 100, volume_remain: 5, volume_total: 5, is_buy_order: false },
      basis[34], 90, { globalPct: 20, perItem: {} }, { brokerFee: 0.03, salesTax: 0.036 }, null, 1);
    return { state: d.basisState, margin: d.marginPct != null, profit: d.estProfit != null };
  `);
  check("a recovered average still prices the row — that's the point of recovering it",
        badge.state === "known" && badge.margin === true && badge.profit === true);

  summary("purchase-history");
})();
