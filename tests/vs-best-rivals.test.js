// tests/vs-best-rivals.test.js
// "vs Best %" must compare against OTHER PLAYERS only. Our own orders are not
// competition: two of our own orders at one station is still "solo", and a tie
// with ourselves is not a tie. A rival at our exact price IS worth calling out,
// so it gets its own state rather than reading as a win.
const { run, check, summary } = require("./harness");

function doc() {
  const els = {};
  const make = () => ({ value: "", style: {}, textContent: "", innerHTML: "", title: "", options: [],
                        classList: { add() {}, remove() {}, toggle() {} } });
  return { getElementById: id => (els[id] ??= make()), querySelectorAll: () => [], title: "", els };
}

// Assert on the cell's colour and its content without pinning the attribute
// order between them — several states carry a title, and that is incidental.
function cellIs(row, cls, text) {
  return row.includes(`class="col-num ${cls}"`) && row.includes(`>${text}</td>`);
}

(async () => {
  // ── stationRivals: the competition set, our own orders removed ────────────
  const r1 = await run(`
    const regionBooks = { 10000002: { 34: {
      sell: [ { price: 450, remain: 1, locationId: 60003760, orderId: 502 },   // ours
              { price: 500, remain: 1, locationId: 60003760, orderId: 501 },   // ours
              { price: 550, remain: 1, locationId: 60003760, orderId: 900 },   // rival
              { price: 400, remain: 1, locationId: 60008494, orderId: 901 } ], // rival, OTHER station
      buy:  [ { price: 90, remain: 1, locationId: 60003760, orderId: 503 },    // ours
              { price: 80, remain: 1, locationId: 60003760, orderId: 902 } ],  // rival
    } } };
    const mine = new Set([501, 502, 503]);
    const sellHere = { order_id: 501, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    const buyHere  = { order_id: 503, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: true };
    const onlyOurs = { order_id: 502, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    return {
      sellRivals: stationRivals(regionBooks, sellHere, mine).map(o => o.orderId),
      buyRivals:  stationRivals(regionBooks, buyHere,  mine).map(o => o.orderId),
      // Same station queried from our OTHER order — the answer must not depend
      // on which of our orders is asking.
      sameFromOther: stationRivals(regionBooks, onlyOurs, mine).map(o => o.orderId),
      unknownType: stationRivals(regionBooks,
        { order_id: 1, region_id: 10000002, type_id: 999, location_id: 60003760, is_buy_order: false }, mine),
    };
  `);
  check("our own orders are excluded from the competition set",
        JSON.stringify(r1.sellRivals) === "[900]");
  check("rivals at other stations in the region are excluded",
        !r1.sellRivals.includes(901));
  check("buy side excludes our own bid too", JSON.stringify(r1.buyRivals) === "[902]");
  check("the rival set is a property of the station, not of which order asks",
        JSON.stringify(r1.sameFromOther) === JSON.stringify(r1.sellRivals));
  check("unknown region/type pair → null, no crash", r1.unknownType === null);

  // ── The reported bug, end to end ──────────────────────────────────────────
  const r2 = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha", scopes: [] },
                { characterId: 22, characterName: "Bravo", scopes: [] }];
    saveOrderRules({ globalPct: 20, perItem: {} });
    const mine = (order_id, type_id, price, is_buy_order, characterId) =>
      ({ order_id, type_id, price, volume_remain: 1, volume_total: 1, is_buy_order,
         location_id: 60003760, region_id: 10000002, characterId,
         characterName: characterId === 11 ? "Alpha" : "Bravo" });
    ordersState = {
      loadedAt: Date.now(), warnings: [], ledger: [], basis: {}, books: {},
      names: { 60003760: "Jita IV - Moon 4" },
      typeNames: { 34: "TwoOfMine", 35: "TiedWithRival", 36: "Winning", 37: "BeatenSell",
                   38: "SelfPlusRivalTie", 39: "HairWin", 40: "OutbidBuy", 41: "WinningBuy",
                   42: "MissingFromBook" },
      orders: [
        // Malkuth case: two of OUR orders, nobody else. Both are solo.
        mine(501, 34, 500000, false, 11), mine(502, 34, 450000, false, 22),
        mine(503, 35, 300, false, 11),      // rival sits at exactly 300
        mine(504, 36, 100, false, 11),      // rival at 110 — we win with headroom
        mine(505, 37, 130, false, 11),      // rival at 120 — we are beaten
        mine(506, 38, 300, false, 11),      // rival at 300 AND another of ours at 250
        mine(507, 38, 250, false, 22),
        mine(508, 39, 100, false, 11),      // rival a hair above — winning, rounds to zero
        mine(509, 40, 100, true,  11),      // rival outbids by a hair
        mine(510, 41, 90,  true,  11),      // we hold the top bid over a rival at 80
        mine(511, 42, 200, false, 11),      // our own order missing from the book
      ],
      regionBooks: { 10000002: {
        34: { sell: [ { price: 450000, remain: 1, locationId: 60003760, orderId: 502 },
                      { price: 500000, remain: 1, locationId: 60003760, orderId: 501 } ], buy: [] },
        35: { sell: [ { price: 300, remain: 1, locationId: 60003760, orderId: 503 },
                      { price: 300, remain: 1, locationId: 60003760, orderId: 910 } ], buy: [] },
        36: { sell: [ { price: 100, remain: 1, locationId: 60003760, orderId: 504 },
                      { price: 110, remain: 1, locationId: 60003760, orderId: 911 } ], buy: [] },
        37: { sell: [ { price: 120, remain: 1, locationId: 60003760, orderId: 912 },
                      { price: 130, remain: 1, locationId: 60003760, orderId: 505 } ], buy: [] },
        38: { sell: [ { price: 250, remain: 1, locationId: 60003760, orderId: 507 },
                      { price: 300, remain: 1, locationId: 60003760, orderId: 506 },
                      { price: 300, remain: 1, locationId: 60003760, orderId: 913 } ], buy: [] },
        39: { sell: [ { price: 100,      remain: 1, locationId: 60003760, orderId: 508 },
                      { price: 100.00001, remain: 1, locationId: 60003760, orderId: 914 } ], buy: [] },
        40: { sell: [], buy: [ { price: 100.01, remain: 1, locationId: 60003760, orderId: 915 },
                               { price: 100,    remain: 1, locationId: 60003760, orderId: 509 } ] },
        41: { sell: [], buy: [ { price: 90, remain: 1, locationId: 60003760, orderId: 510 },
                               { price: 80, remain: 1, locationId: 60003760, orderId: 916 } ] },
        // Our order 511 is NOT here — we cannot actually read this station's book.
        42: { sell: [ { price: 210, remain: 1, locationId: 60003760, orderId: 917 } ], buy: [] },
      } },
    };
    renderOrdersTable();
    const html = document.getElementById("orders-tbody").innerHTML;
    const rowFor = name => html.split("<tr>").find(s => s.includes(">" + name + "<"));
    return {
      twoOfMine: html.split("<tr>").filter(s => s.includes(">TwoOfMine<")),
      tied: rowFor("TiedWithRival"), winning: rowFor("Winning"), beaten: rowFor("BeatenSell"),
      selfPlusRival: html.split("<tr>").filter(s => s.includes(">SelfPlusRivalTie<")),
      hairWin: rowFor("HairWin"), outbid: rowFor("OutbidBuy"),
      winningBuy: rowFor("WinningBuy"), missing: rowFor("MissingFromBook"),
    };
  `, { document: doc() });

  // The bug the user hit: our own second order was being read as a competitor.
  check("two of our own orders at one station are BOTH solo",
        r2.twoOfMine.length === 2 && r2.twoOfMine.every(row => row.includes(">solo<")));
  check("neither self-owned order is painted as beaten",
        r2.twoOfMine.every(row => !row.includes("profit-neg")));

  // Ties are their own state now — a rival at our exact price is not a win.
  check("a rival at our exact price reads 0.0% in the tie colour",
        cellIs(r2.tied, "profit-tie", "0.0%"));
  check("a tie is not painted as a win", !cellIs(r2.tied, "profit-pos", "0.0%"));
  check("a tie with a rival is not reported as solo", !r2.tied.includes(">solo<"));

  // A self-order must not mask a real tie, and must not create a fake one.
  check("our own cheaper order does not hide a genuine tie with a rival",
        r2.selfPlusRival.some(row => cellIs(row, "profit-tie", "0.0%")));
  check("our own cheaper order is itself solo-free but not beaten by us",
        r2.selfPlusRival.every(row => !row.includes('profit-neg">20.0%')));

  // Winning now carries the headroom instead of a flat zero.
  check("winning shows the gap to the nearest rival, not 0.0%",
        cellIs(r2.winning, "profit-pos", "-9.1%"));
  check("winning is never printed as 0.0% now that 0.0% means tied",
        !r2.winning.includes('>0.0%'));
  check("winning by a hair prints the bound, not a rounded zero",
        cellIs(r2.hairWin, "profit-pos", "&gt;-0.1%"));

  // Beaten is unchanged in sign and colour.
  check("beaten sell still reads a positive red gap",
        cellIs(r2.beaten, "profit-neg", "8.3%"));
  check("being outbid by a hair on the buy side is red, not a rounded zero",
        cellIs(r2.outbid, "profit-neg", "&gt;-0.1%"));
  check("holding the top bid over a rival shows the buy-side headroom",
        cellIs(r2.winningBuy, "profit-pos", "12.5%"));

  // Readability: our own live order must be visible in a book we can read.
  check("our own order missing from the book reads as unreadable, not solo",
        r2.missing.includes(">—<") && !r2.missing.includes(">solo<"));

  summary("vs-best-rivals");
})();
