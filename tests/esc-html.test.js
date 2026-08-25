// Adapted from the parent eve_arbitrage project's version: the raw-function
// checks are unchanged; the render-path check uses renderOrdersTable (this
// tool's only render path) instead of renderGapsTable, which isn't ported here.
const { run, check, summary } = require("./harness");

(async () => {
  const r = await run(`
    return {
      quotes:  escHtml('a "quoted" name'),
      single:  escHtml("O'Structure"),
      angle:   escHtml('<b>&'),
      breakout: escHtml('" onmouseover="alert(1)'),
    };
  `);
  check("double quotes escaped", r.quotes === "a &quot;quoted&quot; name");
  check("single quotes escaped", r.single === "O&#39;Structure");
  check("angle brackets + amp still escaped", r.angle === "&lt;b&gt;&amp;");
  check("attribute breakout neutralised", !r.breakout.includes('"'));

  // Character/item/station names are player-visible ESI text — must be
  // escaped when rendered into the orders table.
  const r2 = await run(`
    const cells = {};
    const doc = {
      title: "",
      getElementById: id => {
        if (!cells[id]) cells[id] = { value: "", style: {}, innerHTML: "", textContent: "",
          classList: { add() {}, remove() {}, toggle() {} }, title: "", options: [], placeholder: "" };
        return cells[id];
      },
      querySelectorAll: () => [],
    };
    document = doc;
    ssoChars = [{ characterId: 11, characterName: '<img src=x onerror=alert(1)>', scopes: [] }];
    saveOrderRules({ globalPct: 20, perItem: {} });
    ordersState = {
      loadedAt: Date.now(), warnings: [],
      names: { 60003760: '<script>alert(1)<\\/script>' },
      typeNames: { 34: '"><svg onload=alert(1)>' },
      orders: [{ order_id: 1, type_id: 34, price: 100, volume_remain: 1, volume_total: 1,
                 is_buy_order: false, location_id: 60003760, region_id: 10000002,
                 characterId: 11, characterName: '<img src=x onerror=alert(1)>' }],
      basis: {}, ledger: [], books: {}, regionBooks: {},
    };
    renderOrdersTable();
    return doc.getElementById("orders-tbody").innerHTML;
  `);
  check("character name escaped in orders render", !r2.includes("<img"));
  check("station name escaped in orders render", !r2.includes("<script>"));
  check("item name escaped in orders render", !r2.includes("<svg"));
  check("copyItemName reads el.textContent, so item names with apostrophes need no argument escaping",
        !r2.includes("copyItemName('") && !r2.includes('copyItemName("'));

  summary("esc-html");
})();
