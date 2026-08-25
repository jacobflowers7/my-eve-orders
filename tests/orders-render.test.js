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
        // it, so it must read exactly 0.0%, not the gap to the 80 runner-up.
        35: {
          sell: [],
          buy: [ { price: 90, remain: 100, locationId: 60008494, orderId: 2 },
                 { price: 80, remain: 50,  locationId: 60008494, orderId: 103 } ],
        },
      } },
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
  // order #1: undercut at its own station by 120 → (130-120)/120*100 = 8.3%
  check("vs-Best % measured against the cheapest offer at the same station", r.html.includes("8.3%"));
  check("vs-Best % ignores cheaper offers at OTHER stations in the region", !r.html.includes("18.2%"));
  check("being beaten renders as a loss color", r.html.includes('col-num profit-neg">8.3%'));
  // order #2: holds the top bid → 0.0%, and that is the WINNING state, so green
  check("holding the best price reads exactly 0.0%", r.html.includes("0.0%"));
  check("0.0% is colored as winning, not as a loss", r.html.includes('col-num profit-pos">0.0%'));
  // order #3 (type 36): no region book at all → nothing to compare against
  check("unreadable station book still renders an em dash, not NaN", r.html.includes(">—<"));
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
