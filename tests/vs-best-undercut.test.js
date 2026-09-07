// tests/vs-best-undercut.test.js
// Regression: "vs Best %" exists to shout when a rival has taken the best
// price at your own station. The classic EVE undercut is a hair — 0.01 ISK, or
// a few hundredths of a percent — so any tolerance band around zero silently
// converts the exact case this column is for into a "you're winning" green.
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
    ssoChars = [{ characterId: 11, characterName: "Alpha", scopes: [] }];
    saveOrderRules({ globalPct: 20, perItem: {} });
    const mine = (order_id, type_id, price, is_buy_order, location_id) =>
      ({ order_id, type_id, price, volume_remain: 1, volume_total: 1, is_buy_order,
         location_id, region_id: 10000002, characterId: 11, characterName: "Alpha" });
    ordersState = {
      loadedAt: Date.now(), warnings: [], ledger: [], basis: {}, books: {},
      names: { 60003760: "Jita IV - Moon 4" },
      typeNames: { 34: "Hairline", 35: "SmallGap", 36: "Winning", 37: "Outbid", 38: "TiedSell" },
      orders: [
        mine(1, 34, 100000000, false, 60003760),   // undercut by 0.01 ISK
        mine(2, 35, 5000000,   false, 60003760),   // undercut by 1000 ISK (0.02%)
        mine(3, 36, 200,       false, 60003760),   // genuinely the cheapest
        mine(4, 37, 100,       true,  60003760),   // outbid by 0.01 ISK
        mine(5, 38, 300,       false, 60003760),   // exact tie with a rival
      ],
      regionBooks: { 10000002: {
        34: { sell: [ { price: 99999999.99, remain: 1, locationId: 60003760, orderId: 900 },
                      { price: 100000000,   remain: 1, locationId: 60003760, orderId: 1 } ], buy: [] },
        35: { sell: [ { price: 4999000, remain: 1, locationId: 60003760, orderId: 901 },
                      { price: 5000000, remain: 1, locationId: 60003760, orderId: 2 } ], buy: [] },
        36: { sell: [ { price: 200, remain: 1, locationId: 60003760, orderId: 3 },
                      { price: 210, remain: 1, locationId: 60003760, orderId: 902 } ], buy: [] },
        37: { sell: [], buy: [ { price: 100.01, remain: 1, locationId: 60003760, orderId: 903 },
                               { price: 100,    remain: 1, locationId: 60003760, orderId: 4 } ] },
        38: { sell: [ { price: 300, remain: 1, locationId: 60003760, orderId: 5 },
                      { price: 300, remain: 1, locationId: 60003760, orderId: 904 } ], buy: [] },
      } },
    };
    renderOrdersTable();
    const html = document.getElementById("orders-tbody").innerHTML;
    // One <tr> per order, in render order after the default sort — pull each
    // row back out by its item name so assertions can't drift with sorting.
    const rowFor = name => html.split("<tr>").find(s => s.includes(">" + name + "<"));
    return {
      hairline: rowFor("Hairline"), smallGap: rowFor("SmallGap"), winning: rowFor("Winning"),
      outbid: rowFor("Outbid"), tied: rowFor("TiedSell"),
    };
  `, { document: d });

  // The reported bug: both of these are genuinely beaten, and both were painted
  // green at 0.0% because the gap rounded away.
  check("a 0.01 ISK undercut is not painted as winning",
        !r.hairline.includes('profit-pos'));
  check("a 0.01 ISK undercut is painted as beaten",
        r.hairline.includes('col-num profit-neg'));
  check("a 0.01 ISK undercut does not claim a flat 0.0%",
        !r.hairline.includes('profit-neg">0.0%'));
  check("a 0.02% undercut is painted as beaten",
        r.smallGap.includes('col-num profit-neg'));
  check("a 0.02% undercut does not claim a flat 0.0%",
        !r.smallGap.includes('profit-neg">0.0%'));

  // Buy side: being outbid by a hair is the same failure mirrored.
  check("being outbid by 0.01 ISK is painted as beaten",
        r.outbid.includes('col-num profit-neg'));
  check("being outbid by a hair does not claim a flat 0.0%",
        !r.outbid.includes('profit-neg">0.0%'));

  // The states that must NOT read as losses — a fix that reds everything is
  // just as useless as one that greens everything. Since rivals are now
  // measured without our own orders, a win carries its headroom (200 against a
  // rival at 210 → -4.8%) and 0.0% is reserved for an exact tie.
  check("actually holding the cheapest offer reads as a win, with headroom",
        r.winning.includes('class="col-num profit-pos"') && r.winning.includes('>-4.8%</td>'));
  check("an exact tie with a rival is called out rather than painted as a win",
        r.tied.includes('class="col-num profit-tie"') && r.tied.includes('>0.0%</td>'));

  summary("vs-best-undercut");
})();
