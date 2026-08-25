// tests/resolve-location-names.test.js
// resolveLocationNames: structures resolve using the owning character's own
// auth (docking rights are per-character); regular stations resolve publicly.
const { run, check, summary } = require("./harness");

(async () => {
  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/universe/structures/1000000000123/"))
      return { ok: true, json: async () => ({ name: "Fancy Citadel", solar_system_id: 30000142 }) };
    if (u.includes("/universe/structures/1000000000999/"))
      return { ok: false, status: 403, json: async () => ({}) };
    if (u.includes("/universe/names/"))
      return { ok: true, json: async () => JSON.parse(opts.body).map(id => ({ id, name: `Station ${id}` })) };
    return { ok: false, status: 404, json: async () => null };
  };

  const r = await run(`
    structureRegistry = {};
    ssoChars = [{ characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "tok",
                  refreshToken: "r", expiresAt: Date.now() + 3600e3, scopes: [] }];
    const names = await resolveLocationNames([
      { locationId: 60003760, characterId: 11 },                 // regular station
      { locationId: 1000000000123, characterId: 11 },            // structure, resolvable
      { locationId: 1000000000999, characterId: 11 },             // structure, no docking rights
    ]);
    return names;
  `, { fetch: fetchStub });

  check("regular station resolved via /universe/names/", r[60003760] === "Station 60003760");
  check("structure resolved via owning character's auth", r[1000000000123] === "Fancy Citadel");
  check("structure with no docking rights falls back gracefully", r[1000000000999] === "Player Structure (1000000000999)");

  // Access is per-character and can lapse (corp change, war, structure sold)
  // while an older order or wallet row from that character survives. The pair
  // listed first is therefore not necessarily the one that can still resolve —
  // every character with a pair at that structure has to be tried.
  const perCharStub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/universe/structures/1000000000123/")) {
      // Only Beta (token "tok-22") still has docking rights here.
      const auth = opts?.headers?.Authorization ?? "";
      return auth.includes("tok-22")
        ? { ok: true, json: async () => ({ name: "Shared Citadel", solar_system_id: 30000142 }) }
        : { ok: false, status: 403, json: async () => ({}) };
    }
    if (u.includes("/universe/names/"))
      return { ok: true, json: async () => JSON.parse(opts.body).map(id => ({ id, name: `Station ${id}` })) };
    return { ok: false, status: 404, json: async () => null };
  };

  const r2 = await run(`
    structureRegistry = {};
    ssoChars = [
      { characterId: 11, characterName: "Alpha", clientId: "c", accessToken: "tok-11",
        refreshToken: "r", expiresAt: Date.now() + 3600e3, scopes: [] },
      { characterId: 22, characterName: "Beta",  clientId: "c", accessToken: "tok-22",
        refreshToken: "r", expiresAt: Date.now() + 3600e3, scopes: [] },
    ];
    const names = await resolveLocationNames([
      { locationId: 1000000000123, characterId: 11 },   // listed first, has LOST access
      { locationId: 1000000000123, characterId: 22 },   // listed second, still has access
    ]);
    return names;
  `, { fetch: perCharStub });

  check("falls through to a later character that still has docking rights",
        r2[1000000000123] === "Shared Citadel");
  summary("resolve-location-names");
})();
