// from_id walk: pagination, overlap stop, stale-char null, and gap tracking
// across an interrupted sync (mid-walk failure must be resumable, never lost).
const { run, check, summary } = require("./harness");

const mkRow = (id, d) => ({ transaction_id: id, date: d, type_id: 34, quantity: 1,
                            unit_price: 5, is_buy: true, location_id: 60003760 });

const REC = `{ clientId: "c", accessToken: "tok", refreshToken: "r",
               expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha",
               scopes: ORDERS_SCOPES }`;

const okPage = page => ({ ok: true, json: async () => page, headers: { get: () => "1" } });
const notOk  = ()     => ({ ok: false, status: 420, json: async () => null, headers: { get: () => "1" } });
const fromIdOf = u => { const m = String(u).match(/from_id=(\d+)/); return m ? Number(m[1]) : null; };

(async () => {
  // ── 1. Happy path: two full pages then an empty one ───────────────────────
  const calls = [];
  const fetchStub = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/wallet/transactions")) {
      const from = fromIdOf(u);
      // History: ids 300..201 then 200..101, then nothing older
      const page = from === null ? Array.from({ length: 100 }, (_, i) => mkRow(300 - i, "2026-08-10T00:00:00Z"))
                 : from === 201  ? Array.from({ length: 100 }, (_, i) => mkRow(200 - i, "2026-08-05T00:00:00Z"))
                 : [];
      return okPage(page);
    }
    return { ok: false, status: 404, json: async () => null, headers: { get: () => "1" } };
  };

  const r = await run(`
    const rec = ${REC};
    const res = await fetchWalletTxPages(rec, new Set());
    // Second sync: everything already known → single request, no rows
    const again = await fetchWalletTxPages(rec, new Set(res.rows.map(x => x.key)));
    const staleRec = { ...rec, expiresAt: 0, refreshToken: "dead" };
    const stale = await fetchWalletTxPages(staleRec, new Set());
    return { n: res.rows.length, first: res.rows[0].transactionId,
             complete: res.complete, stoppedAtId: res.stoppedAtId,
             stale, againN: again.rows.length, againComplete: again.complete };
  `, { fetch: fetchStub });

  check("walk collected both pages", r.n === 200);
  check("rows are normalized", typeof r.first === "number");
  check("clean end-of-history reports complete with no stop point",
        r.complete === true && r.stoppedAtId === null);
  check("overlap stops the walk with no new rows", r.againN === 0 && r.againComplete === true);
  check("stale char (failed refresh) returns null", r.stale === null);
  // 4 wallet calls total: first sync = page1 + page2 + empty page; second sync = 1 overlapping page
  const walletCalls = calls.filter(u => u.includes("/wallet/transactions")).length;
  check("no wasted requests", walletCalls === 4);

  // ── 2. Partial-page overlap still means "contiguous" ──────────────────────
  const partialOverlapStub = async () =>
    okPage([mkRow(300, "2026-08-10T00:00:00Z"), mkRow(299, "2026-08-10T00:00:00Z")]);

  const po = await run(`
    const rec = ${REC};
    // Only ONE of the two rows on the page is already known
    const res = await fetchWalletTxPages(rec, new Set(["11:299"]));
    return { complete: res.complete, stoppedAtId: res.stoppedAtId,
             ids: res.rows.map(x => x.transactionId) };
  `, { fetch: partialOverlapStub });

  check("partial-page overlap counts as contiguous (complete, no gap)",
        po.complete === true && po.stoppedAtId === null);
  check("partial-page overlap keeps only the fresh rows",
        JSON.stringify(po.ids) === JSON.stringify([300]));

  // ── 3. Mid-walk failure: incomplete + stoppedAtId at the failed boundary ──
  // Page 1 (from_id absent) succeeds with ids 300..201; page 2 (from_id=201) 420s.
  const failStub = async (url) => {
    const u = String(url);
    if (!u.includes("/wallet/transactions")) return notOk();
    const from = fromIdOf(u);
    if (from === null) return okPage(Array.from({ length: 100 }, (_, i) => mkRow(300 - i, "2026-08-10T00:00:00Z")));
    return notOk();                       // everything older fails
  };

  const f = await run(`
    const rec = ${REC};
    const res = await fetchWalletTxPages(rec, new Set());
    return { n: res.rows.length, complete: res.complete, stoppedAtId: res.stoppedAtId };
  `, { fetch: failStub });

  check("mid-walk failure keeps the rows already collected", f.n === 100);
  check("mid-walk failure reports incomplete", f.complete === false);
  check("stoppedAtId is the from_id of the failed request", f.stoppedAtId === 201);

  // ── 4. syncAllWalletTx records the gap in localStorage + warns ────────────
  const store = {};   // shared across both syncs, so the marker persists
  const s1 = await run(`
    ssoChars = [${REC}];
    const out = await syncAllWalletTx();
    return { warnings: out.warnings, ledgerN: out.ledger.length };
  `, { fetch: failStub, store });

  check("interrupted sync warns about resumable history",
        s1.warnings.length === 1 && /incomplete/.test(s1.warnings[0]));
  check("interrupted sync still keeps what it fetched", s1.ledgerN === 100);
  const gaps1 = JSON.parse(store["myOrders.walletSyncGaps"]);
  check("gap marker persisted for the character", gaps1["11"] === 201);

  // ── 5. Next sync resumes the backfill and clears the marker ───────────────
  // The "recent" walk finds only brand-new rows (400..391) and ends cleanly, so
  // ids 200..101 can ONLY reach the ledger via the resumed backfill from 201.
  const healCalls = [];
  const healStub = async (url) => {
    const u = String(url);
    if (!u.includes("/wallet/transactions")) return notOk();
    healCalls.push(u);
    const from = fromIdOf(u);
    if (from === null) return okPage(Array.from({ length: 10 }, (_, i) => mkRow(400 - i, "2026-08-20T00:00:00Z")));
    if (from === 201)  return okPage(Array.from({ length: 100 }, (_, i) => mkRow(200 - i, "2026-08-05T00:00:00Z")));
    return okPage([]);                    // nothing older on either walk
  };

  const s2 = await run(`
    ssoChars = [${REC}];
    const out = await syncAllWalletTx();
    return { warnings: out.warnings, ids: out.ledger.map(x => x.transactionId) };
  `, { fetch: healStub, store });

  check("healed sync raises no incomplete warning", s2.warnings.length === 0);
  check("recent walk still collected the newest rows", s2.ids.includes(400));
  check("previously-missing older rows arrive via the backfill walk",
        s2.ids.includes(200) && s2.ids.includes(101));
  check("backfill walk resumed from the persisted gap id",
        healCalls.some(u => fromIdOf(u) === 201));
  const gaps2 = JSON.parse(store["myOrders.walletSyncGaps"]);
  check("gap marker cleared once the backfill completed", gaps2["11"] === undefined);

  summary("wallet-sync");
})();
