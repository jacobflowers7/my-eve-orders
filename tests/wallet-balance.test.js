// fetchWalletBalances: scope gating, auth header, retry integration, degradation.
const { run, check, summary } = require("./harness");

const hdr = { get: h => (String(h).includes("Remain") ? "100" : "0") };
const rec = (id, name, scopes, tok) => `{ clientId: "c", accessToken: "${tok}", refreshToken: "r",
  expiresAt: Date.now() + 3600e3, characterId: ${id}, characterName: "${name}", scopes: ${scopes} }`;

(async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    const u = String(url);
    calls.push({ u, auth: init?.headers?.Authorization ?? null });
    if (u.includes("/characters/11/wallet/")) return { ok: true,  json: async () => 12345.67, headers: hdr };
    if (u.includes("/characters/22/wallet/")) return { ok: false, status: 420, json: async () => null, headers: hdr };
    if (u.includes("/characters/55/wallet/")) return { ok: true, json: async () => { throw new Error("bad json"); }, headers: hdr };
    if (u.includes("/characters/66/wallet/")) return { ok: true, json: async () => "not-a-number", headers: hdr };
    return { ok: false, status: 404, json: async () => null, headers: hdr };
  };

  const r = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    ssoChars = [${rec(11, "Alpha", "ORDERS_SCOPES", "tokA")},
                ${rec(22, "Beta",  "ORDERS_SCOPES", "tokB")},
                ${rec(33, "Gamma", "[]",            "tokC")},
                { clientId: "c", accessToken: "old", refreshToken: "dead",
                  expiresAt: 0, characterId: 44, characterName: "Delta", scopes: ORDERS_SCOPES },
                ${rec(55, "Echo", "ORDERS_SCOPES", "tokE")},
                ${rec(66, "Foxx", "ORDERS_SCOPES", "tokF")}];
    return fetchWalletBalances();
  `, { fetch: fetchStub });

  check("balance parsed for the healthy character", r.balances[11] === 12345.67);
  check("failed character has no balance entry", !(22 in r.balances));
  check("failed character produces a warning",
        r.warnings.some(w => w.includes("Beta") && w.includes("wallet balance")));
  check("character without wallet scope is never fetched",
        !calls.some(c => c.u.includes("/characters/33/")));
  check("requests carry the character's bearer token",
        calls.some(c => c.u.includes("/characters/11/wallet/") && c.auth === "Bearer tokA"));
  const betaCalls = calls.filter(c => c.u.includes("/characters/22/wallet/")).length;
  check("420 is retried through esiFetchRetry (4 attempts)", betaCalls === 4);
  check("stale-session character is skipped silently", !(44 in r.balances) &&
        !r.warnings.some(w => w.includes("Delta")));
  check("stale-session character gets no wallet request",
        !calls.some(c => c.u.includes("/characters/44/wallet/")));
  check("malformed 200 body degrades to a warning, not an exception",
        !(55 in r.balances) && r.warnings.some(w => w.includes("Echo")));
  check("non-number 200 body degrades to a warning", !(66 in r.balances) && r.warnings.some(w => w.includes("Foxx")));

  summary("wallet-balance");
})();
