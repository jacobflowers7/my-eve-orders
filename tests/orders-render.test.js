// tests/orders-render.test.js
// End-to-end render from prepared state: columns, n/a states, sort, copy targets.
const { run, check, summary } = require("./harness");

function doc() {
  const els = {};
  const make = () => ({ value: "", style: {}, textContent: "", innerHTML: "", title: "", options: [],
                        classList: { add() {}, remove() {}, toggle() {} } });
  return { getElementById: id => (els[id] ??= make()), querySelectorAll: () => [], title: "", els };
}

(async () => {
  const d = doc();
  const r = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha", scopes: [] }];  // roster non-empty → table renders
    saveOrderRules({ globalPct: 20, perItem: {} });
    ordersState = {
      loadedAt: Date.now(),
      warnings: ["Beta: session expired — log in again"],
      names: { 60003760: "Jita IV - Moon 4", 60008494: "Amarr VIII" },
      orders: [
        { order_id: 1, type_id: 34, price: 130, volume_remain: 10, volume_total: 20,
          is_buy_order: false, location_id: 60003760, region_id: 10000002, characterId: 11, characterName: "Alpha" },
        { order_id: 2, type_id: 35, price: 90, volume_remain: 100, volume_total: 100,
          is_buy_order: true, location_id: 60008494, region_id: 10000002, characterId: 11, characterName: "Alpha" },
        { order_id: 3, type_id: 36, price: 50, volume_remain: 1, volume_total: 1,
          is_buy_order: false, location_id: 60003760, region_id: 10000002, characterId: 22, characterName: "Beta" },
        // Order #4: only offer at its station on its side — solo, not "beat everyone"
        { order_id: 4, type_id: 37, price: 200, volume_remain: 3, volume_total: 3,
          is_buy_order: false, location_id: 60011866, region_id: 10000002, characterId: 11, characterName: "Alpha" },
      ],
      regionBooks: { 10000002: {
        // Order #1 (sell, 130) is undercut at its own station by a rival at 120,
        // so the best offer there is NOT ours: (130-120)/120*100 = 8.3%.
        // The 110 sell is at a DIFFERENT station and must be ignored entirely.
        34: {
          sell: [ { price: 110, remain: 10, locationId: 60008494, orderId: 101 },
                  { price: 120, remain: 10, locationId: 60003760, orderId: 100 },
                  { price: 130, remain: 10, locationId: 60003760, orderId: 1 },
                  { price: 150, remain: 10, locationId: 60003760, orderId: 102 } ],
          buy: [],
        },
        // Order #2 (buy, 90) IS the top bid at its station — nobody has outbid
        // it, so it reads as headroom over the 80 runner-up, not as a tie.
        35: {
          sell: [],
          buy: [ { price: 90, remain: 100, locationId: 60008494, orderId: 2 },
                 { price: 80, remain: 50,  locationId: 60008494, orderId: 103 } ],
        },
        // Order #4 is the only sell listed at its station — solo, distinct from
        // a real 0% tie against a competitor.
        37: { sell: [ { price: 200, remain: 3, locationId: 60011866, orderId: 4 } ], buy: [] },
      } },
      basis: { 34: { unitsOnHand: 100, totalCost: 10000, avgCost: 100, partial: false },
               36: { unitsOnHand: 5, totalCost: 0, avgCost: null, partial: true } },
      ledger: [
        { transactionId: 1, date: "2026-08-01", typeId: 34, quantity: 100, unitPrice: 100,
          isBuy: true, characterId: 11, isPersonal: true, locationId: 60008494 },
      ],
      books: { 34: { sell: [{ price: 100, remain: 1000 }], buy: [{ price: 100, remain: 1000 }] },
               35: { sell: [{ price: 100, remain: 1000 }], buy: [{ price: 100, remain: 1000 }] },
               36: { sell: [], buy: [] },
               37: { sell: [], buy: [] } },
      typeNames: { 34: "Tritanium", 35: "Pyerite", 36: "Mexallon", 37: "Isogen" },
    };
    renderOrdersTable();
    ssoChars = [{ characterId: 11, characterName: "Alpha", scopes: [] }];
    await openCostBasisDetail(34);
    return {
      html: document.getElementById("orders-tbody").innerHTML,
      warn: document.getElementById("orders-warnings").innerHTML,
      shown: document.getElementById("orders-table").style.display,
      modalBody: document.getElementById("cost-basis-modal-body").innerHTML,
      modalShown: document.getElementById("cost-basis-modal").style.display,
    };
  `, {
    document: d,
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.includes("/universe/names/"))
        return { ok: true, json: async () => JSON.parse(opts.body).map(id => ({ id, name: `Amarr VIII` })) };
      return { ok: false, status: 404, json: async () => null, headers: { get: () => "1" } };
    },
  });

  check("table shown", r.shown === "table");
  check("all four orders rendered", (r.html.match(/<tr>/g) || []).length === 4);
  check("item names present", r.html.includes("Tritanium") && r.html.includes("Pyerite"));
  check("station names resolved", r.html.includes("Jita IV - Moon 4"));
  check("sell target rendered (100*1.2=120)", r.html.includes("120"));
  check("buy row tagged", r.html.includes("BUY"));
  check("partial badge on mid-history basis", r.html.includes("partial"));
  check("no-ref order shows n/a not NaN", !r.html.includes("NaN"));
  check("copy affordance present", r.html.includes("copyOrderPrice"));
  check("item-name copy affordance present", r.html.includes("copyItemName(this)"));
  check("markup override input per row", r.html.includes("setOrderMarkup(34"));
  check("stale-char warning surfaced", r.warn.includes("Beta"));
  // sell #1: price=130, ref=100 (Jita sell price) → vsJitaPct = 30.0%; populated even
  // though it needs no cost basis (unlike order #3, whose n/a ref keeps it "—")
  check("vs-Jita % populated without cost basis", r.html.includes("30.0%"));
  check("avg cost cell opens the detail modal", r.html.includes("openCostBasisDetail(34"));
  check("detail modal shows the contributing buy", r.modalBody.includes("Alpha") && r.modalBody.includes("100"));
  check("detail modal shows where it was purchased", r.modalBody.includes("Amarr VIII"));
  check("detail modal is opened (display:flex)", r.modalShown === "flex");
  // order #1: undercut at its own station by 120 → (130-120)/120*100 = 8.3%
  check("vs-Best % measured against the cheapest offer at the same station", r.html.includes("8.3%"));
  check("vs-Best % ignores cheaper offers at OTHER stations in the region", !r.html.includes("18.2%"));
  check("being beaten renders as a loss color", r.html.includes('col-num profit-neg">8.3%'));
  // order #2: holds the top bid over a rival at 80 → (90-80)/80*100 = +12.5%.
  // bestRef is the best RIVAL offer, so winning carries the gap instead of a
  // flat 0.0% — that reading is now reserved for an exact tie with a rival.
  check("holding the top bid shows the headroom over the nearest rival", r.html.includes("12.5%"));
  check("winning is colored as a win", r.html.includes('col-num profit-pos">12.5%'));
  check("winning no longer masquerades as a tie", !r.html.includes('>0.0%<'));
  // order #3 (type 36): no region book at all → nothing to compare against
  check("unreadable station book still renders an em dash, not NaN", r.html.includes(">—<"));
  // order #4: the only offer at its station — a distinct state from a real
  // 0% tie, so it must show the word "solo" instead of a percentage.
  check("solo listing shows the word 'solo', not 0.0%", r.html.includes(">solo<"));
  check("solo listing is not painted with the winning green", !r.html.includes('profit-pos">solo'));
  // order #1: delta=-10 (target 120 < price 130), impact=|−10|×10=100 → cell must
  // carry the loss color even though impact itself is an unsigned magnitude
  check("impact cell colored by delta's direction, not left neutral",
        r.html.includes('<td class="col-num profit-neg">100</td>'));

  // Empty roster → login prompt, table hidden
  const d2 = doc();
  const r2 = await run(`
    ordersState = { orders: [], basis: {}, books: {}, names: {}, typeNames: {}, warnings: [], loadedAt: null };
    ssoChars = [];
    renderOrdersTable();
    return { msg: document.getElementById("msg").innerHTML, shown: document.getElementById("orders-table").style.display };
  `, { document: d2 });
  check("no chars → login prompt", r2.msg.toLowerCase().includes("log in"));
  check("table hidden when empty", r2.shown === "none");

  // Column-header filter dropdowns: populated from the order list, filter
  // independently, reset when the selection no longer exists.
  const setup = `
    ssoChars = [{ characterId: 11, characterName: "Alpha", scopes: [] }];
    saveOrderRules({ globalPct: 20, perItem: {} });
    ordersState = {
      loadedAt: Date.now(), warnings: [],
      names: { 60003760: "Jita IV - Moon 4", 60008494: "Amarr VIII" },
      orders: [
        { order_id: 1, type_id: 34, price: 130, volume_remain: 10, volume_total: 20,
          is_buy_order: false, location_id: 60003760, region_id: 10000002, characterId: 11, characterName: "Alpha" },
        { order_id: 2, type_id: 35, price: 90, volume_remain: 100, volume_total: 100,
          is_buy_order: true, location_id: 60008494, region_id: 10000002, characterId: 11, characterName: "Alpha" },
        { order_id: 3, type_id: 34, price: 50, volume_remain: 1, volume_total: 1,
          is_buy_order: false, location_id: 60003760, region_id: 10000002, characterId: 22, characterName: "Beta" },
      ],
      regionBooks: {}, basis: {},
      books: { 34: { sell: [], buy: [] }, 35: { sell: [], buy: [] } },
      typeNames: { 34: "Tritanium", 35: "Pyerite" },
    };
  `;

  const d3 = doc();
  const r3 = await run(`
    ${setup}
    renderOrdersTable();
    return {
      charSelectHtml: document.getElementById("orders-filter-character").innerHTML,
      stationSelectHtml: document.getElementById("orders-filter-station").innerHTML,
      rowsUnfiltered: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length,
    };
  `, { document: d3 });
  check("character filter lists both characters, alphabetically", r3.charSelectHtml.indexOf("Alpha") < r3.charSelectHtml.indexOf("Beta"));
  check("character filter defaults to 'All Characters', nothing selected", r3.charSelectHtml.includes('value="">All Characters<'));
  check("station filter lists both stations present in the orders", r3.stationSelectHtml.includes("Jita IV - Moon 4") && r3.stationSelectHtml.includes("Amarr VIII"));
  check("no filter applied yet → all three orders shown", r3.rowsUnfiltered === 3);

  const d4 = doc();
  const r4 = await run(`
    ${setup}
    renderOrdersTable();
    setOrdersFilter("character", "11");
    return {
      html: document.getElementById("orders-tbody").innerHTML,
      rows: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length,
      selectHtml: document.getElementById("orders-filter-character").innerHTML,
    };
  `, { document: d4 });
  check("character filter narrows to just that character's orders", r4.rows === 2);
  check("filtered rows are Alpha's, not Beta's", r4.html.includes("Alpha") && !r4.html.includes("Beta"));
  check("selected option carries the selected attribute after filtering", r4.selectHtml.includes('value="11" selected'));
  check("active filter select gets the 'active' class", r4.selectHtml.includes('col-filter-select active'));

  const d5 = doc();
  const r5 = await run(`
    ${setup}
    renderOrdersTable();
    setOrdersFilter("character", "11");
    setOrdersFilter("station", "60008494");
    return { rows: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length };
  `, { document: d5 });
  check("character and station filters combine (AND, not OR)", r5.rows === 1);

  const d6 = doc();
  const r6 = await run(`
    ${setup}
    renderOrdersTable();
    setOrdersFilter("station", "60003760");
    return { rows: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length, html: document.getElementById("orders-tbody").innerHTML };
  `, { document: d6 });
  check("station filter alone narrows across characters", r6.rows === 2);
  check("station filter keeps both characters at that station", r6.html.includes("Alpha") && r6.html.includes("Beta"));

  // Beta (22) only has an order at 60003760 — pairing her with the OTHER
  // station leaves nothing that satisfies both filters at once.
  const d7 = doc();
  const r7 = await run(`
    ${setup}
    renderOrdersTable();
    setOrdersFilter("character", "22");
    setOrdersFilter("station", "60008494");
    return { rows: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length, msg: document.getElementById("orders-tbody").innerHTML };
  `, { document: d7 });
  check("a filter combination matching nothing shows the empty-filter message, not a blank table",
        r7.rows === 1 && r7.msg.includes("No orders match the selected filters"));

  // Filtered to a character, then that character's orders vanish on refresh —
  // the filter must reset to "All", not silently hide everything with no cue.
  const d8 = doc();
  const r8 = await run(`
    ${setup}
    renderOrdersTable();
    setOrdersFilter("character", "22");
    ordersState.orders = ordersState.orders.filter(o => o.characterId !== 22);   // Beta's order is gone
    renderOrdersTable();
    return {
      rows: (document.getElementById("orders-tbody").innerHTML.match(/<tr>/g) || []).length,
      selectHtml: document.getElementById("orders-filter-character").innerHTML,
    };
  `, { document: d8 });
  check("stale filter selection resets to All once its option disappears", r8.rows === 2);
  check("reset filter select shows 'All Characters' selected again", r8.selectHtml.includes('value="">All Characters<'));

  summary("orders-render");
})();
