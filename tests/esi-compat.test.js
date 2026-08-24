// Every ESI request must carry the pinned X-Compatibility-Date header
// (ESI's new versioning scheme); non-ESI requests must be left alone.
const { run, check, summary } = require("./harness");

(async () => {
  const calls = [];
  const recorder = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
  };

  await run(`
    await fetch("https://esi.evetech.net/universe/regions/?datasource=tranquility");
    await fetch("https://example.com/other");
    return true;
  `, { fetch: recorder });

  const esiCalls   = calls.filter(c => c.url.startsWith("https://esi.evetech.net/"));
  const otherCalls = calls.filter(c => c.url.startsWith("https://example.com/"));

  check("ESI calls recorded", esiCalls.length >= 1);
  check("all ESI calls pinned to a compatibility date",
        esiCalls.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.headers["X-Compatibility-Date"] ?? "")));
  check("non-ESI calls untouched",
        otherCalls.length === 1 && !("X-Compatibility-Date" in otherCalls[0].headers));

  // The base URL itself must no longer use the deprecated /latest prefix
  const usesLatest = await run(`return ESI.includes("/latest");`, { fetch: recorder });
  check("ESI base no longer uses /latest", usesLatest === false);

  summary("esi-compat");
})();
