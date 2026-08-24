// tests/structure-name.test.js
// fetchStructureInfoFor: resolves a player structure's name using a SPECIFIC
// character's auth (docking rights are per-character), caches, degrades to
// null on no-access rather than crashing.
const { run, check, summary } = require("./harness");

(async () => {
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.includes("/universe/structures/1000000000123/"))
      return { ok: true, json: async () => ({ name: "Fancy Citadel", solar_system_id: 30000142 }) };
    if (u.includes("/universe/structures/1000000000999/"))
      return { ok: false, status: 403, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => null };
  };

  const r = await run(`
    structureRegistry = {};
    const rec = { clientId: "c", accessToken: "tok", refreshToken: "r",
                  expiresAt: Date.now() + 3600e3, characterId: 11, characterName: "Alpha", scopes: [] };
    const resolved = await fetchStructureInfoFor(rec, 1000000000123);
    const cached   = await fetchStructureInfoFor(rec, 1000000000123); // second call: cache, no refetch
    const noAccess = await fetchStructureInfoFor(rec, 1000000000999);
    return { resolved, cached, noAccess, registrySize: Object.keys(structureRegistry).length };
  `, { fetch: fetchStub });

  check("resolves name + system", r.resolved.name === "Fancy Citadel" && r.resolved.systemId === 30000142);
  check("second call returns the cached value", r.cached.name === "Fancy Citadel");
  check("no docking rights → null, not a crash", r.noAccess === null);
  check("only the successful structure gets cached", r.registrySize === 1);
  summary("structure-name");
})();
