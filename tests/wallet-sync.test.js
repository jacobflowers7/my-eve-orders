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
  check("gap marker persisted for the character, as an array of resume points",
        JSON.stringify(gaps1["11"]) === "[201]");

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

  // ── 6. A NEW gap opening while an OLD one is still unresolved must not
  // discard the old one — the recent walk fails above the old marker, and the
  // backfill resuming the old marker fails too, in the same sync.
  const doubleGapStore = { "myOrders.walletSyncGaps": JSON.stringify({ 11: 201 }) };
  const doubleGapStub = async (url) => {
    const u = String(url);
    if (!u.includes("/wallet/transactions")) return notOk();
    const from = fromIdOf(u);
    if (from === null) return okPage(Array.from({ length: 100 }, (_, i) => mkRow(500 - i, "2026-08-15T00:00:00Z")));
    return notOk();   // both the recent walk's second page AND the backfill from 201 fail
  };
  const dg = await run(`
    ssoChars = [${REC}];
    const out = await syncAllWalletTx();
    return { warnings: out.warnings };
  `, { fetch: doubleGapStub, store: doubleGapStore });
  check("both incomplete walks in one sync raise the incomplete warning",
        dg.warnings.some(w => /incomplete/.test(w)));
  const gapsDouble = JSON.parse(doubleGapStore["myOrders.walletSyncGaps"]);
  check("BOTH the new gap (from the recent walk) and the old gap (from the backfill) survive",
        JSON.stringify(gapsDouble["11"].sort((a, b) => a - b)) === "[201,401]");

  // ── 7. Legacy single-number marker (pre-array persisted format) is still
  // honored and normalized going forward.
  const legacyStore = { "myOrders.walletSyncGaps": JSON.stringify({ 11: 201 }) };
  const legacyStub = async (url) => {
    const u = String(url);
    if (!u.includes("/wallet/transactions")) return notOk();
    const from = fromIdOf(u);
    if (from === null) return okPage(Array.from({ length: 5 }, (_, i) => mkRow(1000 - i, "2026-08-20T00:00:00Z")));
    if (from === 201) return okPage(Array.from({ length: 100 }, (_, i) => mkRow(200 - i, "2026-08-05T00:00:00Z")));
    return okPage([]);
  };
  const lg = await run(`
    ssoChars = [${REC}];
    const out = await syncAllWalletTx();
    return { ids: out.ledger.map(x => x.transactionId) };
  `, { fetch: legacyStub, store: legacyStore });
  check("a legacy scalar gap marker is still resumed", lg.ids.includes(200) && lg.ids.includes(101));
  const legacyGapsAfter = JSON.parse(legacyStore["myOrders.walletSyncGaps"]);
  check("legacy marker is cleared (not left behind in scalar form) once resolved",
        legacyGapsAfter["11"] === undefined);

  // ── 8. Token refresh failing between the recent walk and the backfill must
  // not crash the sync (backfill === null) — the recent walk's rows must
  // still be kept and persisted, and the old gap must stay tracked to retry.
  const nullBackfillStore = { "myOrders.walletSyncGaps": JSON.stringify({ 11: [201] }) };
  let callCount = 0;
  const nullBackfillStub = async (url) => {
    const u = String(url);
    if (!u.includes("/wallet/transactions")) return notOk();
    callCount++;
    const from = fromIdOf(u);
    if (from === null) return okPage([mkRow(300, "2026-08-25T00:00:00Z")]);
    return okPage([]);   // would succeed IF reached — the token dies first
  };
  const nb = await run(`
    ssoChars = [${REC}];
    // Simulate the refresh token dying right after the "recent" walk grabs a
    // token but before the backfill call re-checks expiry.
    const origGetTokenFor = getAccessTokenFor;
    let calls = 0;
    getAccessTokenFor = async (rec) => { calls++; return calls === 1 ? "tok" : null; };
    let threw = false;
    let out;
    try { out = await syncAllWalletTx(); } catch { threw = true; }
    getAccessTokenFor = origGetTokenFor;
    return { threw, warnings: out?.warnings ?? [], ledgerN: out?.ledger.length ?? -1 };
  `, { fetch: nullBackfillStub, store: nullBackfillStore });
  check("a token failure mid-sync (backfill === null) does not throw", nb.threw === false);
  check("the recent walk's rows are still kept when the backfill fails to even start",
        nb.ledgerN === 1);
  check("a session-expired-mid-sync warning is raised instead of a crash",
        nb.warnings.some(w => /session expired mid-sync/.test(w)));
  const gapsAfterNullBackfill = JSON.parse(nullBackfillStore["myOrders.walletSyncGaps"]);
  check("the unresolved gap marker is kept (not lost) so it can retry next time",
        JSON.stringify(gapsAfterNullBackfill["11"]) === "[201]");

  // ── 9. fetchWalletTxPages exposes whether it reached ESI's true end of
  // history (empty page) vs a known-row overlap — syncAllWalletTx's
  // gap-vs-clean-end distinction depends on this.
  const endOfHistory = await run(`
    const rec = ${REC};
    const clean = await fetchWalletTxPages(rec, new Set());          // first-ever sync, no overlap possible
    return { complete: clean.complete, reachedEndOfEsiHistory: clean.reachedEndOfEsiHistory };
  `, { fetch: async () => okPage([]) });
  check("an empty first page reports reachedEndOfEsiHistory: true",
        endOfHistory.complete === true && endOfHistory.reachedEndOfEsiHistory === true);
  const overlapEnd = await run(`
    const rec = ${REC};
    const res = await fetchWalletTxPages(rec, new Set(["11:300"]));  // page's only row already known
    return { complete: res.complete, reachedEndOfEsiHistory: res.reachedEndOfEsiHistory };
  `, { fetch: async () => okPage([mkRow(300, "2026-08-10T00:00:00Z")]) });
  check("an overlap stop reports reachedEndOfEsiHistory: false",
        overlapEnd.complete === true && overlapEnd.reachedEndOfEsiHistory === false);

  summary("wallet-sync");
})();
