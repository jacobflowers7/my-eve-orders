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

  // stationBestRef: best offer on the order's own side at its own station.
  // Our own posting is INCLUDED on purpose — the question is "has anyone beaten
  // me here?", so holding the best price must resolve to our own price.
  const r2 = await run(`
    const regionBooks = {
      10000002: { 34: {
        sell: [ { price: 495, remain: 5,  locationId: 60008494, orderId: 3 },
                { price: 500, remain: 10, locationId: 60003760, orderId: 1 },
                { price: 510, remain: 10, locationId: 60003760, orderId: 2 } ],
        buy:  [ { price: 480, remain: 5,  locationId: 60003760, orderId: 4 },
                { price: 470, remain: 5,  locationId: 60003760, orderId: 5 } ],
      } },
    };
    const beatenSell = { order_id: 2, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    const bestSell   = { order_id: 1, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    // Order 3 is the only sell at 60008494 — with self included it is its own best offer
    const loneSeller = { order_id: 3, region_id: 10000002, type_id: 34, location_id: 60008494, is_buy_order: false };
    const topBid     = { order_id: 4, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: true };
    const outbid     = { order_id: 5, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: true };
    const emptyStation = { order_id: 99, region_id: 10000002, type_id: 34, location_id: 60011866, is_buy_order: false };
    const unknownType  = { order_id: 1, region_id: 10000002, type_id: 999, location_id: 60003760, is_buy_order: false };
    return {
      beatenSell: stationBestRef(regionBooks, beatenSell),   // 500 undercuts our 510
      bestSell:   stationBestRef(regionBooks, bestSell),     // we ARE the 500 → our own price
      loneSeller: stationBestRef(regionBooks, loneSeller),   // only offer there → itself
      topBid:     stationBestRef(regionBooks, topBid),       // highest buy is ours
      outbid:     stationBestRef(regionBooks, outbid),       // 480 outbids our 470
      emptyStation: stationBestRef(regionBooks, emptyStation),
      unknown:      stationBestRef(regionBooks, unknownType),
    };
  `);
  check("beaten sell references the cheapest offer at its station", r2.beatenSell === 500);
  check("best sell references its own price, so the comparison lands on 0%", r2.bestSell === 500);
  check("lone seller is its own best offer (0%), not a blank", r2.loneSeller === 495);
  check("buy side takes the HIGHEST bid, not the lowest", r2.topBid === 480 && r2.outbid === 480);
  check("filters to the order's own station, not the whole region", r2.beatenSell !== 495);
  check("station with no book at all → null", r2.emptyStation === null);
  check("unknown region/type pair → null, no crash", r2.unknown === null);

  // stationOfferCount: how many live orders (ours included) sit at that
  // station on that side — the input isSolo is derived from.
  const r3 = await run(`
    const regionBooks = {
      10000002: { 34: {
        sell: [ { price: 495, remain: 5,  locationId: 60008494, orderId: 3 },
                { price: 500, remain: 10, locationId: 60003760, orderId: 1 },
                { price: 510, remain: 10, locationId: 60003760, orderId: 2 } ],
        buy:  [ { price: 480, remain: 5,  locationId: 60003760, orderId: 4 } ],
      } },
    };
    const crowdedSell = { order_id: 1, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: false };
    const loneSeller   = { order_id: 3, region_id: 10000002, type_id: 34, location_id: 60008494, is_buy_order: false };
    const loneBuyer     = { order_id: 4, region_id: 10000002, type_id: 34, location_id: 60003760, is_buy_order: true };
    const emptyStation = { order_id: 99, region_id: 10000002, type_id: 34, location_id: 60011866, is_buy_order: false };
    const unknownType  = { order_id: 1, region_id: 10000002, type_id: 999, location_id: 60003760, is_buy_order: false };
    return {
      crowdedSell: stationOfferCount(regionBooks, crowdedSell),
      loneSeller:  stationOfferCount(regionBooks, loneSeller),
      loneBuyer:   stationOfferCount(regionBooks, loneBuyer),
      emptyStation: stationOfferCount(regionBooks, emptyStation),
      unknown:      stationOfferCount(regionBooks, unknownType),
    };
  `);
  check("two sells at the same station count as 2", r3.crowdedSell === 2);
  check("a station with only our own sell counts as 1 (solo)", r3.loneSeller === 1);
  check("a station with only our own buy counts as 1 (solo)", r3.loneBuyer === 1);
  check("station with a book but nothing at that location → 0, not null", r3.emptyStation === 0);
  check("unknown region/type pair → null, no crash", r3.unknown === null);
  summary("region-books");
})();
