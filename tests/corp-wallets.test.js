// fetchCorpBalances: corp dedupe, member fallback on 403, NPC skip, silent vs warned failures.
const { run, check, summary } = require("./harness");

const hdr = { get: h => (String(h).includes("Remain") ? "100" : "0") };
const ok  = body => ({ ok: true, json: async () => body, headers: hdr });
const err = status => ({ ok: false, status, json: async () => null, headers: hdr });
const rec = (id, name, scopes, tok) => `{ clientId: "c", accessToken: "${tok}", refreshToken: "r",
  expiresAt: Date.now() + 3600e3, characterId: ${id}, characterName: "${name}", scopes: ${scopes} }`;
const CORP_SCOPES = `[...ORDERS_SCOPES, CORP_WALLET_SCOPE]`;

(async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    const u = String(url), auth = init?.headers?.Authorization ?? null;
    calls.push({ u, auth });
    const char = u.match(/\/characters\/(\d+)\/\?/);
    if (char) return ok({ corporation_id: { 11: 98000001, 22: 98000001, 33: 98000002,
                                            44: 1000009,  55: 98000003, 66: 98000004 }[char[1]] });
    if (u.includes("/corporations/98000001/wallets/"))
      return auth === "Bearer tok22"
        ? ok([{ division: 1, balance: 100 }, { division: 2, balance: 50 }])
        : err(403);                                   // char 11 lacks the in-game role
    if (u.includes("/corporations/98000002/wallets/")) return err(403);   // nobody has the role
    if (u.includes("/corporations/98000003/wallets/")) return err(500);   // real failure
    if (u.includes("/corporations/98000004/wallets/"))                    // malformed 200 body
      return { ok: true, json: async () => { throw new Error("bad json"); }, headers: hdr };
    if (u.includes("/corporations/98000001/?")) return ok({ name: "Test <Corp>" });
    return err(404);
  };

  const r = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    ssoChars = [${rec(11, "Alpha", CORP_SCOPES, "tok11")},
                ${rec(22, "Beta",  CORP_SCOPES, "tok22")},
                ${rec(33, "Gamma", CORP_SCOPES, "tok33")},
                ${rec(44, "Delta", CORP_SCOPES, "tok44")},
                ${rec(55, "Eps",   CORP_SCOPES, "tok55")},
                ${rec(66, "Zeta",  CORP_SCOPES, "tok66")}];
    return fetchCorpBalances();
  `, { fetch: fetchStub });

  check("one corp resolved", r.corps.length === 1);
  check("first member 403s, second member succeeds; divisions summed",
        r.corps[0]?.corpId === 98000001 && r.corps[0]?.balance === 150);
  check("corp name resolved from the public endpoint", r.corps[0]?.name === "Test <Corp>");
  const w1 = calls.filter(c => c.u.includes("/corporations/98000001/wallets/")).length;
  check("shared corp fetched per member attempt, not per member", w1 === 2);
  check("all-403 corp is dropped silently", !r.warnings.some(w => w.includes("98000002")));
  check("non-403 corp failure produces a warning", r.warnings.some(w => w.includes("98000003")));
  check("malformed 200 body degrades to a warning, not an exception",
        r.warnings.some(w => w.includes("98000004")) && !r.corps.some(c => c.corpId === 98000004));
  check("NPC corp is never attempted", !calls.some(c => c.u.includes("/corporations/1000009/")));

  summary("corp-wallets");
})();
