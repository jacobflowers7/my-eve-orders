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
    return { ok: false, status: 404, json: async () => null, headers: hdr };
  };

  const r = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    ssoChars = [${rec(11, "Alpha", "ORDERS_SCOPES", "tokA")},
                ${rec(22, "Beta",  "ORDERS_SCOPES", "tokB")},
                ${rec(33, "Gamma", "[]",            "tokC")}];
    return fetchWalletBalances();
  `, { fetch: fetchStub });

  check("balance parsed for the healthy character", r.balances[11] === 12345.67);
  check("failed character has no balance entry", !(22 in r.balances));
  check("failed character produces one warning",
        r.warnings.length === 1 && r.warnings[0].includes("Beta") && r.warnings[0].includes("wallet balance"));
  check("character without wallet scope is never fetched",
        !calls.some(c => c.u.includes("/characters/33/")));
  check("requests carry the character's bearer token",
        calls.some(c => c.u.includes("/characters/11/wallet/") && c.auth === "Bearer tokA"));
  const betaCalls = calls.filter(c => c.u.includes("/characters/22/wallet/")).length;
  check("420 is retried through esiFetchRetry (4 attempts)", betaCalls === 4);

  summary("wallet-balance");
})();
