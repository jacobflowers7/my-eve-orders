// tests/orders-fetch.test.js
// Jita per-type books (station filter, sort) + paged character orders.
const { run, check, summary } = require("./harness");

(async () => {
  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/markets/10000002/orders/")) {
      const typeId = Number(u.match(/type_id=(\d+)/)[1]);
      if (typeId === 99) return { ok: false, status: 404, headers: { get: () => "1" }, json: async () => null };
      return { ok: true, headers: { get: h => h === "X-Pages" ? "1" : "1" }, json: async () => [
        { type_id: typeId, is_buy_order: false, price: 510, volume_remain: 10, location_id: 60003760 },
        { type_id: typeId, is_buy_order: false, price: 500, volume_remain: 10, location_id: 60003760 },
        { type_id: typeId, is_buy_order: false, price: 400, volume_remain: 99, location_id: 12345 },   // Perimeter — excluded
        { type_id: typeId, is_buy_order: true,  price: 470, volume_remain: 5,  location_id: 60003760 },
        { type_id: typeId, is_buy_order: true,  price: 480, volume_remain: 5,  location_id: 60003760 },
      ] };
    }
    if (u.includes("/characters/11/orders")) {
      const page = Number(u.match(/page=(\d+)/)?.[1] ?? 1);
      return { ok: true, headers: { get: h => h === "X-Pages" ? "2" : "1" }, json: async () =>
        [{ order_id: page * 100, type_id: 34, price: 5, volume_remain: 10, volume_total: 10,
           is_buy_order: false, location_id: 60003760, region_id: 10000002, duration: 90 }] };
    }
    return { ok: false, status: 404, headers: { get: () => "1" }, json: async () => null };
  };

  const r = await run(`
    const books = await fetchJitaBooksForTypes([34, 99]);
    const rec = { clientId: "c", accessToken: "tok", refreshToken: "r",
                  expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha",
                  scopes: ORDERS_SCOPES };
    const orders = await fetchCharacterOrders(rec);
    return {
      sellPrices: books[34].sell.map(o => o.price),
      buyPrices:  books[34].buy.map(o => o.price),
      failed: books[99],
      nOrders: orders.length,
      orderIds: orders.map(o => o.order_id).sort((a, b) => a - b),
      annotated: orders[0].characterName === "Alpha" && orders[0].characterId === 11,
    };
  `, { fetch: fetchStub });

  check("sell book: Jita 4-4 only, ascending", JSON.stringify(r.sellPrices) === "[500,510]");
  check("buy book: Jita 4-4 only, descending", JSON.stringify(r.buyPrices) === "[480,470]");
  check("failed type yields empty books, not crash", JSON.stringify(r.failed) === '{"sell":[],"buy":[]}');
  check("character orders walk X-Pages", r.nOrders === 2 && JSON.stringify(r.orderIds) === "[100,200]");
  check("orders annotated with character", r.annotated === true);

  const hdr = { get: h => (String(h).includes("X-Pages") ? "1" : String(h).includes("Remain") ? "100" : "0") };

  // A network exception on ANY page must resolve to null, not throw — a
  // thrown rejection here would escape fetchAllCharacterOrders' Promise.all
  // and abort the whole refresh, discarding every other character's orders.
  const throwRec = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    const rec = { clientId: "c", accessToken: "tok", refreshToken: "r",
                  expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha",
                  scopes: ORDERS_SCOPES };
    let threw = false;
    let result;
    try { result = await fetchCharacterOrders(rec); } catch { threw = true; }
    return { threw, result };
  `, { fetch: async () => { throw new TypeError("Failed to fetch"); } });
  check("a network exception resolves to null instead of throwing",
        throwRec.threw === false && throwRec.result === null);

  // A malformed body (JSON parse failure) is not something esiFetchRetry's own
  // fetch()-level catch absorbs — it must still resolve to null, not throw and
  // take the rest of Promise.all down with it.
  const badJsonRec = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    const rec = { clientId: "c", accessToken: "tok", refreshToken: "r",
                  expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha",
                  scopes: ORDERS_SCOPES };
    let threw = false;
    let result;
    try { result = await fetchCharacterOrders(rec); } catch { threw = true; }
    return { threw, result };
  `, { fetch: async () => ({ ok: true, headers: { get: h => h === "X-Pages" ? "1" : "100" },
                             json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }) });
  check("a malformed JSON body resolves to null instead of throwing",
        badJsonRec.threw === false && badJsonRec.result === null);

  // A failed later page must not silently truncate the order list — that
  // would read exactly like orders had filled or expired.
  const page2FailRec = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    const rec = { clientId: "c", accessToken: "tok", refreshToken: "r",
                  expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha",
                  scopes: ORDERS_SCOPES };
    return await fetchCharacterOrders(rec);
  `, {
    fetch: async (url) => {
      const page = Number(String(url).match(/page=(\d+)/)?.[1] ?? 1);
      if (page === 1) return { ok: true, headers: { get: h => h === "X-Pages" ? "2" : "100" }, json: async () =>
        [{ order_id: 100, type_id: 34, price: 5, volume_remain: 10, volume_total: 10,
           is_buy_order: false, location_id: 60003760, region_id: 10000002 }] };
      return { ok: false, status: 502, headers: hdr, json: async () => null };
    },
  });
  check("a failed later page returns null instead of a truncated order list",
        page2FailRec === null);
  summary("orders-fetch");
})();
