// ESI rate-limit handling: retry 420/429/5xx with backoff honoring Retry-After,
// give up after N retries. (Trimmed from the parent eve_arbitrage project's
// version — that one also covered fetchHistoryBatch, which isn't ported here.)
const { run, check, summary } = require("./harness");

(async () => {
  // Retries a 429 then succeeds
  const r1 = await run(`
    ESI_RETRY_MIN_DELAY_MS = 1;
    let calls = 0;
    fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: h => h === "Retry-After" ? "0" : null } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    };
    const r = await esiFetchRetry("http://x/");
    return { calls, ok: r.ok };
  `);
  check("429 retried then succeeds", r1.calls === 2 && r1.ok === true);

  // Gives up after retries, returns last response
  const r2 = await run(`
    ESI_RETRY_MIN_DELAY_MS = 1;
    let calls = 0;
    fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => null } }; };
    const r = await esiFetchRetry("http://x/", { retries: 2 });
    return { calls, ok: r.ok, status: r.status };
  `);
  check("gives up after retries", r2.calls === 3 && r2.ok === false && r2.status === 429);

  // 404 is not retryable
  const r3 = await run(`
    ESI_RETRY_MIN_DELAY_MS = 1;
    let calls = 0;
    fetch = async () => { calls++; return { ok: false, status: 404, headers: { get: () => null } }; };
    const r = await esiFetchRetry("http://x/");
    return { calls, status: r.status };
  `);
  check("404 not retried", r3.calls === 1 && r3.status === 404);

  summary("esi-retry");
})();
