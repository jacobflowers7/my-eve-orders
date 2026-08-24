// tests/region-books.test.js
// fetchRegionBooksForPairs: region-wide books (unlike fetchJitaBooksForTypes,
// NOT filtered to one station — the caller filters by location_id per order,
// since one region can hold many stations the user has orders in).
const { run, check, summary } = require("./harness");

(async () => {
  const fetchStub = async (url) => {
    const u = String(url);
    const regionMatch = u.match(/markets\/(\d+)\/orders/);
    const typeMatch = u.match(/type_id=(\d+)/);
    const region = regionMatch && Number(regionMatch[1]);
    const typeId = typeMatch && Number(typeMatch[1]);
    if (region === 10000002 && typeId === 34) {
      return { ok: true, headers: { get: () => "1" }, json: async () => [
        { order_id: 1, location_id: 60003760, is_buy_order: false, price: 510, volume_remain: 10 },
        { order_id: 2, location_id: 60003760, is_buy_order: false, price: 500, volume_remain: 10 },
        { order_id: 3, location_id: 60008494, is_buy_order: false, price: 495, volume_remain: 5 },  // other station, same region
        { order_id: 4, location_id: 60003760, is_buy_order: true,  price: 470, volume_remain: 5 },
      ] };
    }
    if (region === 10000002 && typeId === 99) return { ok: false, status: 404, headers: { get: () => "1" }, json: async () => null };
    return { ok: false, status: 404, headers: { get: () => "1" }, json: async () => null };
  };

  const r = await run(`
    const books = await fetchRegionBooksForPairs([
      { regionId: 10000002, typeId: 34 },
      { regionId: 10000002, typeId: 99 },
    ]);
    const b34 = books[10000002][34];
    return {
      sellAll: b34.sell.map(o => ({ price: o.price, locationId: o.locationId, orderId: o.orderId })),
      buyAll:  b34.buy.map(o => ({ price: o.price, locationId: o.locationId, orderId: o.orderId })),
      // Caller-side station filter: only 60003760's sell orders
      station60003760: b34.sell.filter(o => o.locationId === 60003760).map(o => o.price),
      failed: books[10000002][99],
      onlyOneRegionKey: Object.keys(books).length,
    };
  `, { fetch: fetchStub });

  check("region-wide book keeps orders from multiple stations", r.sellAll.length === 3);
  check("sorted best-first ascending for sell", JSON.stringify(r.sellAll.map(o => o.price)) === "[495,500,510]");
  check("buy side descending", JSON.stringify(r.buyAll.map(o => o.price)) === "[470]");
  check("orderId and locationId retained for station-filtering/self-exclusion", r.sellAll[0].orderId === 3 && r.sellAll[0].locationId === 60008494);
  check("caller can filter a region book down to one station and stay sorted",
        JSON.stringify(r.station60003760) === "[500,510]");
  check("failed type yields empty books, not a crash", JSON.stringify(r.failed) === '{"sell":[],"buy":[]}');
  check("one region key even with two types requested in it", r.onlyOneRegionKey === 1);

  // stationSideRef: same-side, station-filtered, self-excluded
  const r2 = await run(`
    const regionBooks = {
      10000002: { 34: {
        sell: [ { price: 500, remain: 10, locationId: 60003760, orderId: 1 },
                { price: 510, remain: 10, locationId: 60003760, orderId: 2 },
                { price: 495, remain: 5,  locationId: 60008494, orderId: 3 } ],
        buy:  [ { price: 480, remain: 5,  locationId: 60003760, orderId: 4 } ],
      } },
    };
    const mySell = { order_id: 2, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    // Only order 3 sells at 60008494 — excluding it leaves nothing at that station
    const loneSeller = { order_id: 3, region_id: 10000002, type_id: 34, location_id: 60008494, is_buy_order: false };
    const otherStation = { order_id: 99, region_id: 10000002, type_id: 34, location_id: 60008494, is_buy_order: false };
    const myBuy = { order_id: 4, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: true };
    const unknownType = { order_id: 1, region_id: 10000002, type_id: 999, location_id: 60003760, is_buy_order: false };
    return {
      excludesSelf: stationSideRef(regionBooks, mySell),          // sells at 60003760 minus order 2 → just order 1 (500)
      loneSellerAlone: stationSideRef(regionBooks, loneSeller),   // remove order 1's own sell at that station → nothing left there → null
      otherStationRef: stationSideRef(regionBooks, otherStation), // station 60008494's own sell book, order 99 not present so nothing excluded
      buySide: stationSideRef(regionBooks, myBuy),                // buy side, order 4 IS the only buy → excluded → null
      unknown: stationSideRef(regionBooks, unknownType),
    };
  `);
  check("excludes the order's own posting from the reference", r2.excludesSelf === 500);
  check("lone seller at a station has nothing to compare to → null", r2.loneSellerAlone === null);
  check("filters to the order's own station, not the whole region", r2.otherStationRef === 495);
  check("buy side compares to other buys, not sells", r2.buySide === null);
  check("unknown region/type pair → null, no crash", r2.unknown === null);
  summary("region-books");
})();
