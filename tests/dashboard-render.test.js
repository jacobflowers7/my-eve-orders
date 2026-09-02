// renderDashboard: balances, totals with corp toggle/filter, escaping, activity wiring.
const { run, check, summary } = require("./harness");

function doc() {
  const els = {};
  const make = () => ({ value: "", style: {}, textContent: "", innerHTML: "", title: "", options: [],
                        checked: false, classList: { add() {}, remove() {}, toggle() {} } });
  return { getElementById: id => (els[id] ??= make()), querySelectorAll: () => [], title: "", els };
}
const today = () => new Date().toISOString();

(async () => {
  const d = doc();
  const r = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha <One>", scopes: ORDERS_SCOPES },
                { characterId: 22, characterName: "Beta", scopes: ORDERS_SCOPES }];
    dashState = { balances: { 11: 1.24e9 },   // Beta has no balance yet → "—"
                  corps: [{ corpId: 98000001, name: "Test <Corp>", balance: 5e9 }] };
    ordersState.ledger = [
      { transactionId: 1, date: "2026-01-01T00:00:00Z", typeId: 34, quantity: 10,
        unitPrice: 100, isBuy: true,  isPersonal: true },
      { transactionId: 2, date: "${today()}", typeId: 34, quantity: 4,
        unitPrice: 200, isBuy: false, isPersonal: true },
      { transactionId: 3, date: "${today()}", typeId: 35, quantity: 1,
        unitPrice: 500, isBuy: false, isPersonal: false },   // corp sell, no basis
    ];
    document.getElementById("broker-fee").value = "3.0";
    document.getElementById("sales-tax").value  = "3.6";

    renderDashboard();
    toggleDashCorpPopover();   // open the ⚙ popover so its markup is in the capture
    const withCorp = { w: document.getElementById("dash-wallets").innerHTML,
                       a: document.getElementById("dash-activity").innerHTML };
    saveDashIncludeCorp(false);
    const noCorp   = { w: document.getElementById("dash-wallets").innerHTML,
                       a: document.getElementById("dash-activity").innerHTML };
    saveDashIncludeCorp(true);
    setDashCorpIncluded(98000001, false);
    const filtered = document.getElementById("dash-wallets").innerHTML;
    dashState.corps = [];
    renderDashboard();
    const noCorps  = document.getElementById("dash-wallets").innerHTML;
    return { withCorp, noCorp, filtered, noCorps };
  `, { document: d });

  check("character names rendered and escaped",
        r.withCorp.w.includes("Alpha &lt;One&gt;") && r.withCorp.w.includes("Beta"));
  check("known balance abbreviated", r.withCorp.w.includes("1.24 B"));
  check("missing balance shows an em dash", r.withCorp.w.includes("—"));
  check("total includes corp ISK when toggle on", r.withCorp.w.includes("6.24 B"));
  check("corp name escaped in popover markup",
        r.withCorp.w.includes("Test &lt;Corp&gt;") && !r.withCorp.w.includes("<Corp>"));
  check("toggle off drops corp ISK from total", !r.noCorp.w.includes("6.24 B"));
  check("corp fill counted in activity when toggle on", r.withCorp.a.includes("2 fills"));
  check("corp fill excluded from activity when toggle off", r.noCorp.a.includes("1 fills"));
  check("corp sell without basis flags profit partial", r.withCorp.a.includes("partial"));
  check("personal-only activity is fully covered", !r.noCorp.a.includes("partial"));
  check("excluding the only corp zeroes the corp row but keeps it visible",
        r.filtered.includes("Corp (0)") && !r.filtered.includes("6.24 B"));
  check("no readable corps → corp row hidden", !r.noCorps.includes("Corp ("));

  summary("dashboard-render");
})();
