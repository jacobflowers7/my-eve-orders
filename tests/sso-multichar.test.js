// tests/sso-multichar.test.js
// Multi-character SSO: migration, upsert, per-record refresh, scope tracking.
const { run, check, summary } = require("./harness");

// Minimal JWT: header.payload.sig with base64url payload
function jwt(payload) {
  const b64 = s => Buffer.from(JSON.stringify(s)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `x.${b64(payload)}.x`;
}

(async () => {
  // 1) Fresh install: no prior storage, loadSsoChars() starts clean
  // (the parent eve_arbitrage project's version of this test also covered
  // migrating its own pre-multichar "eveArb.sso" key — not applicable here,
  // since this standalone tool never had a prior single-character storage format)
  const r1 = await run(`
    loadSsoChars();
    return { n: ssoChars.length, active: sso };
  `);
  check("fresh install starts with an empty roster", r1.n === 0);
  check("fresh install has no active character", r1.active === null);

  // 2) ssoStore upserts by characterId and records scopes from scp claim
  const tokA = { access_token: jwt({ sub: "CHARACTER:EVE:11", name: "Alpha",
                 scp: ["esi-markets.read_character_orders.v1", "esi-wallet.read_character_wallet.v1"] }),
                 refresh_token: "rA", expires_in: 1200 };
  const tokB = { access_token: jwt({ sub: "CHARACTER:EVE:22", name: "Beta", scp: "esi-markets.structure_markets.v1" }),
                 refresh_token: "rB", expires_in: 1200 };
  const r2 = await run(`
    loadSsoChars();
    ssoStore(${JSON.stringify(tokA)}, "cid");
    ssoStore(${JSON.stringify(tokB)}, "cid");
    ssoStore(${JSON.stringify(tokA)}, "cid");   // repeat login: upsert, not append
    return { n: ssoChars.length, names: ssoChars.map(c => c.characterName).sort(),
             active: sso.characterId,
             aHas: charHasScope(ssoChars.find(c => c.characterId === 11), "esi-wallet.read_character_wallet.v1"),
             bHas: charHasScope(ssoChars.find(c => c.characterId === 22), "esi-wallet.read_character_wallet.v1"),
             persisted: JSON.parse(localStorage.getItem("myOrders.ssoChars")).chars.length };
  `);
  check("two characters after three logins", r2.n === 2);
  check("both names present", JSON.stringify(r2.names) === JSON.stringify(["Alpha", "Beta"]));
  check("last login is active", r2.active === 11);
  check("scp array recorded", r2.aHas === true);
  check("scp string recorded, scope absent", r2.bHas === false);
  check("array persisted", r2.persisted === 2);

  // 3) getAccessTokenFor refreshes only the expired record; failure marks stale
  const fresh = jwt({ sub: "CHARACTER:EVE:11", name: "Alpha", scp: [] });
  let tokenCalls = 0;
  const fetch3 = async (url, opts) => {
    if (String(url).includes("login.eveonline.com")) {
      tokenCalls++;
      const body = String(opts.body);
      if (body.includes("refresh_token=good"))
        return { ok: true, json: async () => ({ access_token: fresh, refresh_token: "good2", expires_in: 1200 }) };
      return { ok: false, status: 400, json: async () => ({}) };
    }
    return { ok: false, json: async () => null, headers: { get: () => "1" } };
  };
  const r3 = await run(`
    ssoChars = [
      { clientId: "cid", accessToken: "live",  refreshToken: "x",    expiresAt: Date.now() + 3600e3,
        characterId: 1, characterName: "Live", scopes: [] },
      { clientId: "cid", accessToken: "dead",  refreshToken: "good", expiresAt: 0,
        characterId: 11, characterName: "Alpha", scopes: [] },
      { clientId: "cid", accessToken: "dead2", refreshToken: "bad",  expiresAt: 0,
        characterId: 2, characterName: "Broken", scopes: [] },
    ];
    const t1 = await getAccessTokenFor(ssoChars[0]);
    const t2 = await getAccessTokenFor(ssoChars[1]);
    const t3 = await getAccessTokenFor(ssoChars[2]);
    return { t1, t2ok: t2 === ssoChars[1].accessToken && t2 !== "dead", t3,
             stillThere: ssoChars.length, stale: ssoChars[2].stale === true };
  `, { fetch: fetch3 });
  check("unexpired token returned as-is", r3.t1 === "live");
  check("expired record refreshed in place", r3.t2ok === true);
  check("failed refresh returns null", r3.t3 === null);
  check("failed record kept, marked stale", r3.stillThere === 3 && r3.stale === true);
  check("no refresh for the live record", tokenCalls === 2);

  // 3b) Concurrent callers for the SAME character share one refresh request.
  // EVE rotates refresh tokens — a second concurrent refresh would present the
  // token the first one just invalidated and kill the session. refreshOrders now
  // runs the orders fetch and the wallet sync in parallel, so this overlap is a
  // normal occurrence, not a corner case.
  const freshB = jwt({ sub: "CHARACTER:EVE:11", name: "Alpha", scp: [] });
  let concurrentCalls = 0;
  const fetch3b = async (url) => {
    if (String(url).includes("login.eveonline.com")) {
      concurrentCalls++;
      await new Promise(res => setTimeout(res, 10));   // hold both callers in-flight
      return { ok: true, json: async () => ({ access_token: freshB, refresh_token: "rotated", expires_in: 1200 }) };
    }
    return { ok: false, json: async () => null, headers: { get: () => "1" } };
  };
  const r3b = await run(`
    ssoChars = [{ clientId: "cid", accessToken: "dead", refreshToken: "orig", expiresAt: 0,
                  characterId: 11, characterName: "Alpha", scopes: [] }];
    const [a, b] = await Promise.all([
      getAccessTokenFor(ssoChars[0]),
      getAccessTokenFor(ssoChars[0]),
    ]);
    // A later call must refresh again rather than reuse a settled promise.
    ssoChars[0].expiresAt = 0;
    const c = await getAccessTokenFor(ssoChars[0]);
    return { same: a === b && a !== null, c: c !== null };
  `, { fetch: fetch3b });
  // 2 total = 1 shared by the concurrent pair + 1 for the later, separate refresh.
  // Without dedup the pair would fire two, making 3.
  check("concurrent refreshes for one character collapse to one token request", concurrentCalls === 2);
  check("both concurrent callers get the same token", r3b.same === true);
  check("in-flight entry is cleared so later refreshes still work", r3b.c === true);

  // 4) ssoLogout: removing an earlier, non-active character must not shift
  //    the active pointer onto a different survivor (regression: old code
  //    reused the pre-filter index against the post-filter array).
  const r4 = await run(`
    ssoChars = [
      { characterId: 1, characterName: "A", clientId: "cid", accessToken: "a", refreshToken: "ra", expiresAt: 0, scopes: [] },
      { characterId: 2, characterName: "B", clientId: "cid", accessToken: "b", refreshToken: "rb", expiresAt: 0, scopes: [] },
      { characterId: 3, characterName: "C", clientId: "cid", accessToken: "c", refreshToken: "rc", expiresAt: 0, scopes: [] },
      { characterId: 4, characterName: "D", clientId: "cid", accessToken: "d", refreshToken: "rd", expiresAt: 0, scopes: [] },
    ];
    activeSsoIdx = 2;
    sso = ssoChars[2];   // C is active
    ssoLogout(1);        // remove A, an earlier non-active character
    return { n: ssoChars.length, activeId: sso?.characterId, activeIdx: activeSsoIdx,
             names: ssoChars.map(c => c.characterName) };
  `);
  check("removing earlier char keeps roster minus one", r4.n === 3);
  check("active character unchanged after unrelated removal", r4.activeId === 3);
  check("activeSsoIdx re-derived to survivor's real position", r4.activeIdx === 1);
  check("survivors in order", JSON.stringify(r4.names) === JSON.stringify(["B", "C", "D"]));

  // 5) ssoLogout: removing the active character itself falls back sensibly
  const r5 = await run(`
    ssoChars = [
      { characterId: 1, characterName: "A", clientId: "cid", accessToken: "a", refreshToken: "ra", expiresAt: 0, scopes: [] },
      { characterId: 2, characterName: "B", clientId: "cid", accessToken: "b", refreshToken: "rb", expiresAt: 0, scopes: [] },
    ];
    activeSsoIdx = 1;
    sso = ssoChars[1];   // B is active
    ssoLogout(2);        // remove the active character
    const afterFirst = { n: ssoChars.length, activeId: sso?.characterId };
    ssoLogout(1);        // remove the last remaining character
    return { afterFirst, n2: ssoChars.length, activeAfterAll: sso };
  `);
  check("logging out the active char falls back to a remaining char", r5.afterFirst.n === 1 && r5.afterFirst.activeId === 1);
  check("logging out the last char empties the roster", r5.n2 === 0);
  check("sso is null when roster is empty", r5.activeAfterAll === null);

  // 6) setActiveSsoChar switches sso and persists the new active index
  const r6 = await run(`
    ssoChars = [
      { characterId: 1, characterName: "A", clientId: "cid", accessToken: "a", refreshToken: "ra", expiresAt: 0, scopes: [] },
      { characterId: 2, characterName: "B", clientId: "cid", accessToken: "b", refreshToken: "rb", expiresAt: 0, scopes: [] },
      { characterId: 3, characterName: "C", clientId: "cid", accessToken: "c", refreshToken: "rc", expiresAt: 0, scopes: [] },
    ];
    activeSsoIdx = 0;
    sso = ssoChars[0];
    setActiveSsoChar(3);
    return { activeId: sso?.characterId, activeIdx: activeSsoIdx,
             persistedActive: JSON.parse(localStorage.getItem("myOrders.ssoChars")).active };
  `);
  check("setActiveSsoChar switches sso to requested character", r6.activeId === 3);
  check("setActiveSsoChar updates activeSsoIdx to match", r6.activeIdx === 2);
  check("setActiveSsoChar persists the new active index", r6.persistedActive === 2);

  summary("sso-multichar");
})();
