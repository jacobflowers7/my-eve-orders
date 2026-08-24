// tests/wallet-ledger.test.js
// Pure ledger logic: normalization, keying, dedup, ordering.
const { run, check, summary } = require("./harness");

(async () => {
  const r = await run(`
    const esiRow = { transaction_id: 500, date: "2026-08-20T10:00:00Z", type_id: 34,
                     quantity: 1000, unit_price: 4.5, is_buy: true, location_id: 60003760,
                     client_id: 999, is_personal: true, journal_ref_id: 1 };
    const a = normalizeWalletTx(11, esiRow);

    const existing = [
      { key: "11:1", characterId: 11, transactionId: 1, date: "2026-08-01T00:00:00Z",
        typeId: 34, quantity: 10, unitPrice: 4, isBuy: true, locationId: 60003760 },
      { key: "11:3", characterId: 11, transactionId: 3, date: "2026-08-03T00:00:00Z",
        typeId: 34, quantity: 5, unitPrice: 6, isBuy: false, locationId: 60003760 },
    ];
    const incoming = [
      normalizeWalletTx(11, { transaction_id: 3, date: "2026-08-03T00:00:00Z", type_id: 34,
                              quantity: 5, unit_price: 6, is_buy: false, location_id: 60003760 }), // dup
      normalizeWalletTx(11, { transaction_id: 2, date: "2026-08-02T00:00:00Z", type_id: 34,
                              quantity: 7, unit_price: 5, is_buy: true, location_id: 60003760 }),  // new
      normalizeWalletTx(22, { transaction_id: 3, date: "2026-08-03T00:00:00Z", type_id: 34,
                              quantity: 5, unit_price: 6, is_buy: true, location_id: 60003760 }),  // same txId, other char
    ];
    const { merged, added } = mergeWalletTx(existing, incoming);
    return { a, added, order: merged.map(x => x.key) };
  `);

  check("normalize maps ESI fields", r.a.key === "11:500" && r.a.typeId === 34 &&
        r.a.quantity === 1000 && r.a.unitPrice === 4.5 && r.a.isBuy === true &&
        r.a.locationId === 60003760 && r.a.characterId === 11);
  check("normalize drops untracked ESI fields", !("client_id" in r.a) && !("journal_ref_id" in r.a));
  // is_personal is NOT untracked: corp-wallet rows must be excludable from personal cost basis
  check("normalize retains is_personal as isPersonal", r.a.isPersonal === true);
  check("duplicate key not re-added", r.added === 2);
  check("same txId on another character is distinct", r.order.includes("22:3"));
  check("merged sorted by date then txId", JSON.stringify(r.order) ===
        JSON.stringify(["11:1", "11:2", "11:3", "22:3"]));
  summary("wallet-ledger");
})();
