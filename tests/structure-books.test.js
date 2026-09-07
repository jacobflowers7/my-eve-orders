// tests/structure-books.test.js
// fetchStructureBooksInto: access-restricted citadel markets are absent from the
// public /markets/{region}/orders/ feed entirely, so orders posted in one have
// no competing book unless we ask the structure directly. Results merge INTO the
// region books so the station lookups stay a single lookup.
const { run, check, summary } = require("./harness");

const CITADEL = 1_035_949_018_593;   // >= 1e12 → player structure
const NPC     = 60003760;

// Two pages, plus a type we do NOT have an order for (the endpoint serves the
// structure's whole market, not just our items).
const page1 = [
  { order_id: 10, type_id: 2929, is_buy_order: false, price: 5_485_000, volume_remain: 183 },
  { order_id: 11, type_id: 2929, is_buy_order: false, price: 4_300_000, volume_remain: 54 },
  { order_id: 12, type_id: 9999, is_buy_order: false, price: 1, volume_remain: 1 },
];
const page2 = [
  { order_id: 13, type_id: 2929, is_buy_order: true,  price: 3_000_000, volume_remain: 5 },
];

(async () => {
  const calls = [];
  const fetchStub = async (url) => {
    const u = String(url);
    calls.push(u);
    const m = u.match(/markets\/structures\/(\d+)\/.*page=(\d+)/);
    if (!m) return { ok: false, status: 404, json: async () => null, headers: { get: () => "1" } };
    const [, id, page] = m;
    if (Number(id) !== CITADEL) return { ok: false, status: 403, json: async () => null, headers: { get: () => "1" } };
    return { ok: true, headers: { get: h => h === "X-Pages" ? "2" : null },
             json: async () => (page === "1" ? page1 : page2) };
  };

  const body = `
    ssoChars = [{ characterId: 11, characterName: "Alpha", clientId: "c",
                  accessToken: "t", expiresAt: Date.now() + 3600_000,
                  scopes: [MARKET_STRUCTURE_SCOPE] }];
    const orders = [
      { order_id: 10, type_id: 2929, location_id: ${CITADEL}, region_id: 10000047, characterId: 11 },
      { order_id: 90, type_id: 34,   location_id: ${NPC},     region_id: 10000002, characterId: 11 },
    ];
    // Pretend the public region feed already ran and found nothing in the citadel.
    const regionBooks = { 10000002: { 34: { sell: [], buy: [] } } };
    const warnings = await fetchStructureBooksInto(regionBooks, orders);
    const book = regionBooks[10000047]?.[2929];
    return {
      warnings,
      sell: book.sell.map(o => ({ price: o.price, locationId: o.locationId, orderId: o.orderId })),
      buy:  book.buy.map(o => o.price),
      otherTypeFetched: regionBooks[10000047]?.[9999] !== undefined,
      bestForOurOrder: stationRivals(regionBooks,
        { order_id: 10, region_id: 10000047, type_id: 2929, location_id: ${CITADEL}, is_buy_order: false },
        myOrderIdSet(orders))[0].price,
    };
  `;
  const r = await run(body, { fetch: fetchStub });

  check("citadel book merged into the region books under its own region",
        r.sell.length === 2 && r.buy.length === 1);
  check("both pages walked", calls.filter(u => u.includes("/markets/structures/")).length === 2);
  check("NPC station needs no structure request", !calls.some(u => u.includes(String(NPC))));
  check("sell side sorted best-first", JSON.stringify(r.sell.map(o => o.price)) === "[4300000,5485000]");
  check("locationId stamped so the station lookups can filter by station",
        r.sell.every(o => o.locationId === CITADEL));
  check("orderId retained", r.sell[0].orderId === 11);
  check("types we hold no order for are discarded", r.otherTypeFetched === false);
  check("no warnings when the book loads", r.warnings.length === 0);
  // The whole point: our 5,485,000 order is undercut at 4,300,000, which the
  // public region feed could never have told us.
  check("the rival's price now resolves inside a restricted citadel", r.bestForOurOrder === 4_300_000);

  // ── A public structure is served by BOTH feeds — the same order must not be
  // counted twice, which would distort the book.
  const r2 = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "t",
                  expiresAt: Date.now() + 3600_000, scopes: [MARKET_STRUCTURE_SCOPE] }];
    const orders = [{ order_id: 10, type_id: 2929, location_id: ${CITADEL}, region_id: 10000047, characterId: 11 }];
    const regionBooks = { 10000047: { 2929: {
      sell: [ { price: 4300000, remain: 54, locationId: ${CITADEL}, orderId: 11 } ],   // already public
      buy: [],
    } } };
    await fetchStructureBooksInto(regionBooks, orders);
    return { sell: regionBooks[10000047][2929].sell.map(o => o.orderId) };
  `, { fetch: fetchStub });
  check("order already present from the public feed is not duplicated",
        JSON.stringify(r2.sell) === "[11,10]");

  // ── Access is per-character: the first candidate may have lost it.
  const tokensTried = [];
  const r3 = await run(`
    ssoChars = [
      { characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "alpha",
        expiresAt: Date.now() + 3600_000, scopes: [MARKET_STRUCTURE_SCOPE] },
      { characterId: 22, characterName: "Beta", clientId: "c", accessToken: "beta",
        expiresAt: Date.now() + 3600_000, scopes: [MARKET_STRUCTURE_SCOPE] },
    ];
    const orders = [
      { order_id: 10, type_id: 2929, location_id: 1_111_111_111_111, region_id: 10000047, characterId: 11 },
      { order_id: 20, type_id: 2929, location_id: 1_111_111_111_111, region_id: 10000047, characterId: 22 },
    ];
    const regionBooks = {};
    const warnings = await fetchStructureBooksInto(regionBooks, orders);
    return { warnings, loaded: regionBooks[10000047]?.[2929]?.sell.length ?? 0 };
  `, {
    fetch: async (url, init) => {
      // Alpha has since lost access here; Beta still has it.
      const who = String(init?.headers?.Authorization ?? "");
      tokensTried.push(who);
      if (who === "Bearer alpha")
        return { ok: false, status: 403, json: async () => null, headers: { get: () => "1" } };
      return { ok: true, headers: { get: () => "1" }, json: async () => page1 };
    },
  });
  check("the refused character was actually tried first", tokensTried[0] === "Bearer alpha");
  check("a second character is tried after the first is refused", tokensTried.includes("Bearer beta"));
  check("the fallback character's book is the one that lands", r3.loaded === 2);
  check("successful fallback raises no warning", r3.warnings.length === 0);

  // ── Nobody can read it: one warning per structure, not per character.
  const r4 = await run(`
    ssoChars = [
      { characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "t",
        expiresAt: Date.now() + 3600_000, scopes: [MARKET_STRUCTURE_SCOPE] },
      { characterId: 22, characterName: "Beta", clientId: "c", accessToken: "t",
        expiresAt: Date.now() + 3600_000, scopes: [MARKET_STRUCTURE_SCOPE] },
    ];
    structureRegistry[1_111_111_111_111] = { name: "CVA Immortalis", systemId: 1 };
    const orders = [
      { order_id: 10, type_id: 2929, location_id: 1_111_111_111_111, region_id: 10000047, characterId: 11 },
      { order_id: 20, type_id: 2929, location_id: 1_111_111_111_111, region_id: 10000047, characterId: 22 },
    ];
    return { warnings: await fetchStructureBooksInto({}, orders) };
  `, { fetch: async () => ({ ok: false, status: 403, json: async () => null, headers: { get: () => "1" } }) });
  check("unreadable structure warns exactly once", r4.warnings.length === 1);
  check("warning names the structure, not its raw id", r4.warnings[0].includes("CVA Immortalis"));

  // ── Characters logged in before the scope existed. The stub below WOULD
  // succeed, so a request slipping through shows up as an empty call list check
  // failing rather than as a silent pass.
  const unscopedCalls = [];
  const r5 = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "t",
                  expiresAt: Date.now() + 3600_000, scopes: [] }];   // pre-upgrade session
    const orders = [{ order_id: 10, type_id: 2929, location_id: 1_111_111_111_111, region_id: 10000047, characterId: 11 }];
    return { warnings: await fetchStructureBooksInto({}, orders) };
  `, {
    fetch: async (url) => { unscopedCalls.push(String(url)); return { ok: true, headers: { get: () => "1" }, json: async () => page1 }; },
  });
  check("no request is made at all for a character lacking the scope", unscopedCalls.length === 0);
  check("missing scope still surfaces a warning", r5.warnings.length === 1);
  check("missing scope warns to log in again", r5.warnings[0].includes("log in again"));

  summary("structure-books");
})();
