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
      ],
      // A competing sell at order #1's own station: (130-150)/150*100 = -13.3%
      regionBooks: { 10000002: { 34: {
        sell: [ { price: 130, remain: 10, locationId: 60003760, orderId: 1 },
                { price: 150, remain: 10, locationId: 60003760, orderId: 100 } ],
        buy: [],
      } } },
      basis: { 34: { unitsOnHand: 100, totalCost: 10000, avgCost: 100, partial: false },
               36: { unitsOnHand: 5, totalCost: 0, avgCost: null, partial: true } },
      ledger: [
        { transactionId: 1, date: "2026-08-01", typeId: 34, quantity: 100, unitPrice: 100,
          isBuy: true, characterId: 11, isPersonal: true, locationId: 60008494 },
      ],
      books: { 34: { sell: [{ price: 100, remain: 1000 }], buy: [{ price: 100, remain: 1000 }] },
               35: { sell: [{ price: 100, remain: 1000 }], buy: [{ price: 100, remain: 1000 }] },
               36: { sell: [], buy: [] } },
      typeNames: { 34: "Tritanium", 35: "Pyerite", 36: "Mexallon" },
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
  check("all three orders rendered", (r.html.match(/<tr>/g) || []).length === 3);
  check("item names present", r.html.includes("Tritanium") && r.html.includes("Pyerite"));
  check("station names resolved", r.html.includes("Jita IV - Moon 4"));
  check("sell target rendered (100*1.2=120)", r.html.includes("120"));
  check("buy row tagged", r.html.includes("BUY"));
  check("partial badge on mid-history basis", r.html.includes("partial"));
  check("no-ref order shows n/a not NaN", !r.html.includes("NaN"));
  check("copy affordance present", r.html.includes("copyOrderPrice"));
  check("markup override input per row", r.html.includes("setOrderMarkup(34"));
  check("stale-char warning surfaced", r.warn.includes("Beta"));
  // sell #1: price=130, ref=100 (book mid) → vsJitaPct = 30.0%; populated even
  // though it needs no cost basis (unlike order #3, whose n/a ref keeps it "—")
  check("vs-Jita % populated without cost basis", r.html.includes("30.0%"));
  check("avg cost cell opens the detail modal", r.html.includes("openCostBasisDetail(34"));
  check("detail modal shows the contributing buy", r.modalBody.includes("Alpha") && r.modalBody.includes("100"));
  check("detail modal shows where it was purchased", r.modalBody.includes("Amarr VIII"));
  check("detail modal is opened (display:flex)", r.modalShown === "flex");
  // order #1: competing sell at 150 excludes itself → vsStationPct = (130-150)/150*100 = -13.3%
  check("vs-Station % populated from a competing same-station offer", r.html.includes("-13.3%"));
  check("vs-Station % negative renders as a loss color", r.html.includes('col-num profit-neg">-13.3%'));
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
  summary("orders-render");
})();
