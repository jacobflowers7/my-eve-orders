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

  // stationRivals: the competing offers on the order's own side at its own
  // station. Our OWN orders are excluded — holding two orders at one station
  // must not make the dearer one look "beaten", nor defeat the solo check.
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
    // Ours: sell 2 (510) and sell 3 (495, alone at its station), buy 5 (470).
    const mine = new Set([2, 3, 5]);
    const at = (order_id, location_id, is_buy_order, type_id) =>
      ({ order_id, region_id: 10000002, type_id: type_id ?? 34, location_id, is_buy_order });
    const beatenSell   = at(2, 60003760, false);
    const loneSeller   = at(3, 60008494, false);
    const outbid       = at(5, 60003760, true);
    const emptyStation = at(99, 60011866, false);
    const unknownType  = at(1, 60003760, false, 999);
    return {
      beatenSell:  stationRivals(regionBooks, beatenSell, mine).map(o => o.price),
      loneSeller:  stationRivals(regionBooks, loneSeller, mine).map(o => o.price),
      outbid:      stationRivals(regionBooks, outbid, mine).map(o => o.price),
      emptyStation: stationRivals(regionBooks, emptyStation, mine),
      unknown:      stationRivals(regionBooks, unknownType, mine),
      // Readability: our own live order must appear in a book we can read.
      readableOurs:    stationBookReadable(regionBooks, beatenSell),
      readableAbsent:  stationBookReadable(regionBooks, emptyStation),
      readableUnknown: stationBookReadable(regionBooks, unknownType),
    };
  `);
  check("our own order is not in our own competition set",
        JSON.stringify(r2.beatenSell) === "[500]");
  check("rivals stay sorted best-first, so the head is the price to beat",
        r2.beatenSell[0] === 500);
  check("a station holding only our own order has no rivals at all",
        JSON.stringify(r2.loneSeller) === "[]");
  check("buy side takes the rival bids, ours excluded",
        JSON.stringify(r2.outbid) === "[480]");
  check("filters to the order's own station, not the whole region",
        !r2.beatenSell.includes(495));
  check("station with a book but nothing at that location → [], not null",
        JSON.stringify(r2.emptyStation) === "[]");
  check("unknown region/type pair → null, no crash", r2.unknown === null);
  check("book containing our own order is readable", r2.readableOurs === true);
  check("book missing our own order is NOT readable — an empty rival list there proves nothing",
        r2.readableAbsent === false);
  check("missing region/type book is not readable", r2.readableUnknown === false);

  summary("region-books");
})();
