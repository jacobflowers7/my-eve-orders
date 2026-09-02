# Header Mini-Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the empty header/controls space with a mini-dashboard: per-character wallet ISK, total ISK, corp ISK (toggleable, per-corp filterable), and sales/revenue/profit for today and the last 7 EVE (UTC) days.

**Architecture:** Everything lives in the single-file app `index.html` (one inline `<script>`); tests are Node files in `tests/` that eval the extracted script with stubs (see `tests/harness.js`). A new pure engine `computeActivityStats` mirrors `computeCostBasis`'s ledger replay to produce realized per-window stats. Two new fetchers (`fetchWalletBalances`, `fetchCorpBalances`) run inside `refreshOrders`'s existing `Promise.all`. One new fieldset renders via `renderDashboard()`.

**Tech Stack:** Vanilla JS, no dependencies, ESI (EVE Swagger Interface) REST API, EVE SSO OAuth, IndexedDB ledger (already present), Node test harness (`tests/run.sh`).

**Spec:** `docs/superpowers/specs/2026-09-02-header-mini-dashboard-design.md`

## Global Constraints

- Single-file app: all production code goes in the inline `<script>` of `index.html`. No new files except tests.
- Tests run with `bash tests/run.sh` (runs `node --check` on the extracted script, then every `*.test.js`). All existing tests must stay green.
- Time bounds are EVE time = UTC: today starts 00:00 UTC; week = trailing 7 UTC days (start = today's 00:00 UTC − 6 days). A fill is in a window when `Date.parse(date) >= start`.
- Sales metric = fills (wallet sell transactions). Revenue = gross (`qty × unitPrice`). Profit = `covered × (unitPrice × (1 − brokerFee − salesTax) − avgCostAtThatMoment)` with `covered = min(qty, unitsOnHand)`; any uncovered units set a `profitPartial` flag.
- Buy-side basis eligibility uses the existing `basisEligibleTx` (global `includeCorpBuys`), unchanged. Sell-side corp inclusion is the new dashboard toggle.
- New scope `esi-wallet.read_corporation_wallets.v1` is optional like `STRUCTURE_SCOPE`: characters without it keep working.
- Corp-wallet 403s are silent (missing in-game Accountant role / not re-logged); non-403 corp failures produce one warning per corp on the existing `#orders-warnings` line. Dashboard fetch failures never block the orders refresh.
- All player-controlled strings rendered into HTML (character names, corp names) go through `escHtml`.
- localStorage keys: `myOrders.dashboard.includeCorp`, `myOrders.dashboard.corps`. Defaults: corp toggle ON, all discovered corps included.
- Commit messages: plain imperative sentence (repo style, no `feat:` prefixes), footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do not commit the pre-existing uncommitted changes to `index.html` / `tests/*` that may be in the working tree — stage only files this plan touches, and `git diff` before committing to confirm.

## File Structure

- Modify: `index.html` — scope consts (~line 455), `esiFetchRetry` (~line 856), new fetchers after `idbTxAll`/wallet-sync section (~line 1075), `computeActivityStats` + `fmtIskSigned` after `computeCostBasis` (~line 1130), dashboard settings/render near `saveCorpBuysSetting` (~line 560), markup after the Account fieldset (~line 325), wiring edits in `refreshOrders`, `renderOrdersTable`, `updateSsoUI`, `init`.
- Create: `tests/activity-stats.test.js`, `tests/wallet-balance.test.js`, `tests/corp-wallets.test.js`, `tests/dashboard-render.test.js`.

(Line numbers are anchors from the time of writing; locate by the named function/markup, not the number.)

---

### Task 1: Activity stats engine (`computeActivityStats` + `fmtIskSigned`)

**Files:**
- Modify: `index.html` (after `computeCostBasis`, before the `// Every buy row still "in" ...` comment block; `fmtIskSigned` goes next to `formatISK` in the Formatting helpers section)
- Test: `tests/activity-stats.test.js`

**Interfaces:**
- Consumes: `basisEligibleTx(r)` and global `let includeCorpBuys` (already in `index.html`).
- Produces: `computeActivityStats(rows, fees, nowMs, { includeCorpSells = true } = {})` → `{ today: { fills, revenue, profit, profitPartial }, week: { fills, revenue, profit, profitPartial } }` where `rows` are normalized ledger rows (`{ date, transactionId, typeId, quantity, unitPrice, isBuy, isPersonal }`), `fees = { brokerFee, salesTax }` as fractions, `nowMs` a Unix ms timestamp. Also `fmtIskSigned(n)` → string like `−1.24 B`. Task 4 relies on both names exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/activity-stats.test.js`:

```js
// computeActivityStats: EVE-day (UTC) windows, fee math, partial basis, corp toggles.
const { run, check, summary } = require("./harness");

const NOW = Date.parse("2026-09-02T12:00:00Z");
let nextId = 1;
const row = (date, over = {}) => ({
  key: `11:${nextId}`, characterId: 11, transactionId: nextId++, typeId: 34,
  date, quantity: 1, unitPrice: 100, isBuy: false, locationId: 60003760,
  isPersonal: true, ...over,
});
const near = (a, b) => Math.abs(a - b) < 1e-6;
const stats = (rows, { pre = "", opts = "{}" } = {}) => run(`
  ${pre}
  return computeActivityStats(${JSON.stringify(rows)},
    { brokerFee: 0.03, salesTax: 0.036 }, ${NOW}, ${opts});
`);
const OFF = { opts: "{ includeCorpSells: false }" };

(async () => {
  // ── A. Window bounds + fee math (net factor 1 − 0.03 − 0.036 = 0.934) ─────
  const a = await stats([
    row("2026-08-01T00:00:00Z", { isBuy: true, quantity: 10, unitPrice: 100 }),
    row("2026-08-26T23:59:59Z", { quantity: 1, unitPrice: 100 }),  // before weekStart — excluded
    row("2026-08-27T00:00:00Z", { quantity: 1, unitPrice: 100 }),  // exactly weekStart — included
    row("2026-08-28T10:00:00Z", { quantity: 2, unitPrice: 150 }),
    row("2026-09-02T08:00:00Z", { quantity: 4, unitPrice: 200 }),  // today
  ]);
  check("today: one fill", a.today.fills === 1);
  check("today: gross revenue", a.today.revenue === 800);
  check("today: profit = 4×(200×0.934 − 100)", near(a.today.profit, 347.2));
  check("today: fully covered", a.today.profitPartial === false);
  check("week: boundary fill at 00:00 UTC included, 23:59:59 excluded", a.week.fills === 3);
  check("week: revenue sums included fills only", a.week.revenue === 1200);
  check("week: profit includes a negative fill", near(a.week.profit, -6.6 + 80.2 + 347.2));
  check("week: fully covered", a.week.profitPartial === false);

  // ── B. Partial basis: no-buy-history and oversell ──────────────────────────
  const b = await stats([
    row("2026-09-02T01:00:00Z", { typeId: 35, quantity: 5, unitPrice: 200 }), // no buys at all
    row("2026-08-01T00:00:00Z", { typeId: 36, isBuy: true, quantity: 3, unitPrice: 100 }),
    row("2026-09-02T02:00:00Z", { typeId: 36, quantity: 5, unitPrice: 200 }), // oversell: covered 3 of 5
  ]);
  check("partial: fills and gross revenue still counted", b.today.fills === 2 && b.today.revenue === 2000);
  check("partial: profit covers only covered units", near(b.today.profit, 3 * (200 * 0.934 - 100)));
  check("partial: flag set on both windows", b.today.profitPartial === true && b.week.profitPartial === true);

  // ── C. Corp sells: dashboard toggle × includeCorpBuys ──────────────────────
  const corpRows = [
    row("2026-08-01T00:00:00Z", { typeId: 40, isBuy: true, quantity: 10, unitPrice: 100, isPersonal: false }),
    row("2026-09-02T03:00:00Z", { typeId: 40, quantity: 2, unitPrice: 200, isPersonal: false }),
    row("2026-08-01T01:00:00Z", { typeId: 41, isBuy: true, quantity: 5, unitPrice: 50 }),
    row("2026-09-02T04:00:00Z", { typeId: 41, quantity: 1, unitPrice: 100 }),
  ];
  const cOn = await stats(corpRows);                       // includeCorpSells defaults true
  check("corp sell counted when toggle on", cOn.today.fills === 2 && cOn.today.revenue === 500);
  check("corp sell without corp-buys basis → revenue yes, profit no, partial",
        near(cOn.today.profit, 1 * (100 * 0.934 - 50)) && cOn.today.profitPartial === true);
  const cOff = await stats(corpRows, OFF);
  check("corp sell excluded when toggle off", cOff.today.fills === 1 && cOff.today.revenue === 100);
  check("toggle off → personal profit only, no partial",
        near(cOff.today.profit, 1 * (100 * 0.934 - 50)) && cOff.today.profitPartial === false);
  const cBasis = await stats(corpRows, { pre: "includeCorpBuys = true;" });
  check("corp buys eligible → corp sell gets real profit, no partial",
        near(cBasis.today.profit, 2 * (200 * 0.934 - 100) + 1 * (100 * 0.934 - 50))
        && cBasis.today.profitPartial === false);

  // ── D. Legacy rows + junk quantities ───────────────────────────────────────
  const legacyBuy  = row("2026-08-01T00:00:00Z", { typeId: 50, isBuy: true, quantity: 2, unitPrice: 100 });
  const legacySell = row("2026-09-02T05:00:00Z", { typeId: 50, quantity: 1, unitPrice: 200 });
  delete legacyBuy.isPersonal; delete legacySell.isPersonal;
  const d = await stats([legacyBuy, legacySell,
    row("2026-09-02T06:00:00Z", { quantity: 0 })], OFF);
  check("rows without isPersonal count as personal even with toggle off",
        d.today.fills === 1 && near(d.today.profit, 200 * 0.934 - 100));
  check("zero-quantity rows are skipped", d.today.revenue === 200);

  // ── E. fmtIskSigned ────────────────────────────────────────────────────────
  const f = await run(`return [fmtIskSigned(6.24e9), fmtIskSigned(-347200), fmtIskSigned(0)];`);
  check("fmtIskSigned formats sign + magnitude",
        f[0] === "6.24 B" && f[1] === "−347.2 K" && f[2] === "0");

  summary("activity-stats");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/activity-stats.test.js`
Expected: crashes with `ReferenceError: computeActivityStats is not defined` (an unhandled rejection from the first `stats()` call — exit code non-zero).

- [ ] **Step 3: Implement `computeActivityStats` and `fmtIskSigned`**

In `index.html`, directly after the closing brace of `computeCostBasis` (before the `// Every buy row still "in" the current weighted average...` comment), insert:

```js

// ── Activity stats engine ────────────────────────────────────────────────────
// Realized per-window trading stats for the dashboard, from the same ledger
// replay computeCostBasis performs: the avg cost backing each sell's profit is
// the running weighted average at that moment, so the whole ledger replays
// even though only fills inside a window are counted. Windows are EVE days
// (UTC): today = since 00:00 UTC, week = trailing 7 UTC days. Buy-side basis
// eligibility follows basisEligibleTx (the corp-buys setting); the separate
// includeCorpSells option is the dashboard's corp toggle for what gets
// *counted*. A counted corp sell with no basis in the replay contributes
// revenue but unknown profit, so it flags the window partial.
function computeActivityStats(rows, fees, nowMs, { includeCorpSells = true } = {}) {
  const d = new Date(nowMs);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekStart  = todayStart - 6 * 86400e3;
  const today = { fills: 0, revenue: 0, profit: 0, profitPartial: false };
  const week  = { fills: 0, revenue: 0, profit: 0, profitPartial: false };

  const state = {};   // typeId → running { unitsOnHand, totalCost }, mirroring computeCostBasis
  const sorted = [...rows].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.transactionId - b.transactionId);

  for (const r of sorted) {
    if (!(r.quantity > 0)) continue;
    const inBasis = basisEligibleTx(r);

    if (r.isBuy) {
      if (!inBasis) continue;
      const b = (state[r.typeId] ??= { unitsOnHand: 0, totalCost: 0 });
      b.unitsOnHand += r.quantity;
      b.totalCost   += r.quantity * r.unitPrice;
      continue;
    }

    const b = inBasis ? (state[r.typeId] ??= { unitsOnHand: 0, totalCost: 0 }) : null;
    const covered = b ? Math.min(r.quantity, b.unitsOnHand) : 0;
    const avg = covered > 0 ? b.totalCost / b.unitsOnHand : null;

    if (includeCorpSells || r.isPersonal !== false) {
      const t = Date.parse(r.date);
      for (const w of [today, week]) {
        if (t < (w === today ? todayStart : weekStart)) continue;
        w.fills   += 1;
        w.revenue += r.quantity * r.unitPrice;
        if (covered > 0) w.profit += covered * (r.unitPrice * (1 - fees.brokerFee - fees.salesTax) - avg);
        if (covered < r.quantity) w.profitPartial = true;
      }
    }

    if (covered > 0) { b.totalCost -= avg * covered; b.unitsOnHand -= covered; }
    if (b && b.unitsOnHand === 0) b.totalCost = 0;   // avoid float dust, same as computeCostBasis
  }
  return { today, week };
}
```

In the Formatting helpers section, directly after the closing brace of `formatISK`, insert:

```js

// Profit can be negative; formatISK assumes magnitudes.
const fmtIskSigned = n => (n < 0 ? "−" : "") + formatISK(Math.abs(n));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/activity-stats.test.js`
Expected: every line `ok …`, final line `activity-stats: ALL PASSED`.

- [ ] **Step 5: Run the full suite**

Run: `bash tests/run.sh`
Expected: `syntax: OK`, every test file `ALL PASSED`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/activity-stats.test.js
git commit -m "Add activity-stats engine: per-EVE-day fills/revenue/realized profit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Character wallet balances (`fetchWalletBalances` + `esiFetchRetry` auth support)

**Files:**
- Modify: `index.html` (the `esiFetchRetry` function; new fetcher after `idbTxAll`, i.e. just before the `// ── Wallet-transaction sync ──` comment)
- Test: `tests/wallet-balance.test.js` (covers the spec's "wallet-sync additions" as its own focused file)

**Interfaces:**
- Consumes: `ssoChars`, `charHasScope`, `WALLET_SCOPE`, `getAccessTokenFor`, `ESI`, `esiFetchRetry`.
- Produces: `esiFetchRetry(url, { retries = 3, init } = {})` — new optional `init` forwarded to `fetch(url, init)` (existing call sites unchanged). `fetchWalletBalances()` → `Promise<{ balances: { [characterId]: number }, warnings: string[] }>`. Task 4 relies on both.

- [ ] **Step 1: Write the failing test**

Create `tests/wallet-balance.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/wallet-balance.test.js`
Expected: crashes with `ReferenceError: fetchWalletBalances is not defined`.

- [ ] **Step 3: Implement**

In `index.html`, change the `esiFetchRetry` signature and its one `fetch` call (two edits in the same function):

```js
async function esiFetchRetry(url, { retries = 3, init } = {}) {
```

```js
    try { r = await fetch(url, init); } catch { r = null; } // network error → retry
```

Then, just before the `// ── Wallet-transaction sync ──` comment block, insert:

```js

// ── Dashboard: character wallet balances ─────────────────────────────────────
// The wallet scope already granted for the transaction ledger also covers the
// balance endpoint, so this costs no re-login. Runs concurrently with the
// orders/ledger refresh; token-refresh races are already deduped in
// getAccessTokenFor. A character without the scope simply shows "—".
async function fetchWalletBalances() {
  const warnings = [];
  const balances = {};
  await Promise.all(ssoChars.map(async rec => {
    if (!charHasScope(rec, WALLET_SCOPE)) return;
    const token = await getAccessTokenFor(rec);
    if (!token) return;   // stale session already warned about by the orders fetch
    const r = await esiFetchRetry(`${ESI}/characters/${rec.characterId}/wallet/?datasource=tranquility`,
      { init: { headers: { Authorization: `Bearer ${token}` } } });
    if (r?.ok) balances[rec.characterId] = await r.json();   // endpoint returns a bare number
    else warnings.push(`${rec.characterName}: wallet balance unavailable`);
  }));
  return { balances, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/wallet-balance.test.js`
Expected: `wallet-balance: ALL PASSED`.

- [ ] **Step 5: Run the full suite**

Run: `bash tests/run.sh`
Expected: all files `ALL PASSED` (esi-retry tests must still pass with the widened signature).

- [ ] **Step 6: Commit**

```bash
git add index.html tests/wallet-balance.test.js
git commit -m "Fetch per-character wallet balances for the dashboard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Corp discovery + corp wallet balances (`fetchCorpBalances` + new scope)

**Files:**
- Modify: `index.html` (scope consts near `MARKET_STRUCTURE_SCOPE`; the `SSO_SCOPES` line; new fetcher directly after `fetchWalletBalances` from Task 2)
- Test: `tests/corp-wallets.test.js`

**Interfaces:**
- Consumes: `ssoChars`, `charHasScope`, `getAccessTokenFor`, `ESI`, `esiFetchRetry` (with `init`).
- Produces: `const CORP_WALLET_SCOPE = "esi-wallet.read_corporation_wallets.v1"` (in `SSO_SCOPES`); `fetchCorpBalances()` → `Promise<{ corps: Array<{ corpId, name, balance }>, warnings: string[] }>` sorted by `corpId`. Task 4 relies on these.

- [ ] **Step 1: Write the failing test**

Create `tests/corp-wallets.test.js`:

```js
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
                                            44: 1000009,  55: 98000003 }[char[1]] });
    if (u.includes("/corporations/98000001/wallets/"))
      return auth === "Bearer tok22"
        ? ok([{ division: 1, balance: 100 }, { division: 2, balance: 50 }])
        : err(403);                                   // char 11 lacks the in-game role
    if (u.includes("/corporations/98000002/wallets/")) return err(403);   // nobody has the role
    if (u.includes("/corporations/98000003/wallets/")) return err(500);   // real failure
    if (u.includes("/corporations/98000001/?")) return ok({ name: "Test <Corp>" });
    return err(404);
  };

  const r = await run(`
    ESI_RETRY_MIN_DELAY_MS = 0;
    ssoChars = [${rec(11, "Alpha", CORP_SCOPES, "tok11")},
                ${rec(22, "Beta",  CORP_SCOPES, "tok22")},
                ${rec(33, "Gamma", CORP_SCOPES, "tok33")},
                ${rec(44, "Delta", CORP_SCOPES, "tok44")},
                ${rec(55, "Eps",   CORP_SCOPES, "tok55")}];
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
  check("NPC corp is never attempted", !calls.some(c => c.u.includes("/corporations/1000009/")));

  summary("corp-wallets");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corp-wallets.test.js`
Expected: crashes with `ReferenceError: CORP_WALLET_SCOPE is not defined` (or `fetchCorpBalances is not defined`).

- [ ] **Step 3: Implement**

In `index.html`, directly after the `MARKET_STRUCTURE_SCOPE` const, insert:

```js

// Corp wallet balances for the dashboard. Optional like STRUCTURE_SCOPE — and
// even when granted, ESI serves corp wallets only to characters holding the
// in-game Accountant/Junior Accountant role (403 otherwise). Characters logged
// in before this scope existed keep working; they just contribute no corp
// balance until they log in again.
const CORP_WALLET_SCOPE = "esi-wallet.read_corporation_wallets.v1";
```

Change the `SSO_SCOPES` line to:

```js
const SSO_SCOPES = [...ORDERS_SCOPES, STRUCTURE_SCOPE, MARKET_STRUCTURE_SCOPE, CORP_WALLET_SCOPE].join(" ");
```

Directly after `fetchWalletBalances` (Task 2), insert:

```js

// Corp balances: discover each character's corp (public endpoint), dedupe, then
// read wallets via the first member whose token works. A 403 is the expected
// "no Accountant role / scope not yet granted" case and stays silent; a corp
// that failed for any other reason gets one warning. Corp names are public.
async function fetchCorpBalances() {
  const corpMembers = new Map();   // corpId → member recs, roster order
  await Promise.all(ssoChars.map(async rec => {
    const r = await esiFetchRetry(`${ESI}/characters/${rec.characterId}/?datasource=tranquility`);
    const corpId = r?.ok ? (await r.json())?.corporation_id : null;
    // Player corps start at 98M; NPC corp wallets always 403 and burn error budget.
    if (corpId >= 98000000) corpMembers.set(corpId, [...(corpMembers.get(corpId) ?? []), rec]);
  }));

  const corps = [], warnings = [];
  await Promise.all([...corpMembers].map(async ([corpId, recs]) => {
    let balance = null, non403 = false;
    for (const rec of recs.filter(rc => charHasScope(rc, CORP_WALLET_SCOPE))) {
      const token = await getAccessTokenFor(rec);
      if (!token) continue;
      const r = await esiFetchRetry(`${ESI}/corporations/${corpId}/wallets/?datasource=tranquility`,
        { init: { headers: { Authorization: `Bearer ${token}` } } });
      if (r?.ok) { balance = (await r.json()).reduce((s, d) => s + (d.balance ?? 0), 0); break; }
      if (r?.status !== 403) non403 = true;
    }
    if (balance === null) {
      if (non403) warnings.push(`Corp ${corpId}: wallets unavailable`);
      return;   // silent when it's only missing roles / an un-granted scope
    }
    const nr = await esiFetchRetry(`${ESI}/corporations/${corpId}/?datasource=tranquility`);
    const name = (nr?.ok ? (await nr.json())?.name : null) ?? `Corp ${corpId}`;
    corps.push({ corpId, name, balance });
  }));
  return { corps: corps.sort((a, b) => a.corpId - b.corpId), warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/corp-wallets.test.js`
Expected: `corp-wallets: ALL PASSED`.

- [ ] **Step 5: Run the full suite**

Run: `bash tests/run.sh`
Expected: all `ALL PASSED` — in particular `sso-multichar.test.js` must still pass with the extended `SSO_SCOPES` (if it asserts the exact scope string, update its expectation to include `esi-wallet.read_corporation_wallets.v1` and note that in the commit).

- [ ] **Step 6: Commit**

```bash
git add index.html tests/corp-wallets.test.js
git commit -m "Add corp wallet scope and corp balance fetch with role-aware fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard UI — markup, settings, `renderDashboard`, wiring

**Files:**
- Modify: `index.html` (markup after the Account `</fieldset>`; settings + render functions after `saveCorpBuysSetting`; edits in `refreshOrders`, `renderOrdersTable`, `updateSsoUI`, `init`, and `saveCorpBuysSetting` itself)
- Test: `tests/dashboard-render.test.js`

**Interfaces:**
- Consumes: `computeActivityStats`, `fmtIskSigned` (Task 1), `fetchWalletBalances` (Task 2), `fetchCorpBalances` (Task 3), plus existing `formatISK`, `fmt`, `escHtml`, `currentFees`, `mergeWalletTx`, `idbTxAll`, `ssoChars`, `ordersState`.
- Produces: globals `dashState`, `dashIncludeCorp`, `dashCorpSel`; functions `renderDashboard()`, `loadDashSettings()`, `saveDashIncludeCorp(on)`, `setDashCorpIncluded(corpId, on)`, `toggleDashCorpPopover()`, `dashCorpIncluded(corpId)`; element ids `dash-section`, `dash-wallets`, `dash-activity`.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-render.test.js`:

```js
// renderDashboard: balances, totals with corp toggle/filter, escaping, activity wiring.
const { run, check, summary } = require("./harness");

function doc() {
  const els = {};
  const make = () => ({ value: "", style: {}, textContent: "", innerHTML: "", title: "", options: [],
                        checked: false, classList: { add() {}, remove() {}, toggle() {} } });
  return { getElementById: id => (els[id] ??= make()), querySelectorAll: () => [], title: "", els };
}
const today = () => new Date().toISOString();

(async () => {
  const d = doc();
  const r = await run(`
    ssoChars = [{ characterId: 11, characterName: "Alpha <One>", scopes: ORDERS_SCOPES },
                { characterId: 22, characterName: "Beta", scopes: ORDERS_SCOPES }];
    dashState = { balances: { 11: 1.24e9 },   // Beta has no balance yet → "—"
                  corps: [{ corpId: 98000001, name: "Test <Corp>", balance: 5e9 }] };
    ordersState.ledger = [
      { transactionId: 1, date: "2026-01-01T00:00:00Z", typeId: 34, quantity: 10,
        unitPrice: 100, isBuy: true,  isPersonal: true },
      { transactionId: 2, date: "${today()}", typeId: 34, quantity: 4,
        unitPrice: 200, isBuy: false, isPersonal: true },
      { transactionId: 3, date: "${today()}", typeId: 35, quantity: 1,
        unitPrice: 500, isBuy: false, isPersonal: false },   // corp sell, no basis
    ];
    document.getElementById("broker-fee").value = "3.0";
    document.getElementById("sales-tax").value  = "3.6";

    renderDashboard();
    toggleDashCorpPopover();   // open the ⚙ popover so its markup is in the capture
    const withCorp = { w: document.getElementById("dash-wallets").innerHTML,
                       a: document.getElementById("dash-activity").innerHTML };
    saveDashIncludeCorp(false);
    const noCorp   = { w: document.getElementById("dash-wallets").innerHTML,
                       a: document.getElementById("dash-activity").innerHTML };
    saveDashIncludeCorp(true);
    setDashCorpIncluded(98000001, false);
    const filtered = document.getElementById("dash-wallets").innerHTML;
    dashState.corps = [];
    renderDashboard();
    const noCorps  = document.getElementById("dash-wallets").innerHTML;
    return { withCorp, noCorp, filtered, noCorps };
  `, { document: d });

  check("character names rendered and escaped",
        r.withCorp.w.includes("Alpha &lt;One&gt;") && r.withCorp.w.includes("Beta"));
  check("known balance abbreviated", r.withCorp.w.includes("1.24 B"));
  check("missing balance shows an em dash", r.withCorp.w.includes("—"));
  check("total includes corp ISK when toggle on", r.withCorp.w.includes("6.24 B"));
  check("corp name escaped in popover markup",
        r.withCorp.w.includes("Test &lt;Corp&gt;") && !r.withCorp.w.includes("<Corp>"));
  check("toggle off drops corp ISK from total", !r.noCorp.w.includes("6.24 B"));
  check("corp fill counted in activity when toggle on", r.withCorp.a.includes("2 fills"));
  check("corp fill excluded from activity when toggle off", r.noCorp.a.includes("1 fills"));
  check("corp sell without basis flags profit partial", r.withCorp.a.includes("partial"));
  check("personal-only activity is fully covered", !r.noCorp.a.includes("partial"));
  check("excluding the only corp zeroes the corp row but keeps it visible",
        r.filtered.includes("Corp (0)") && !r.filtered.includes("6.24 B"));
  check("no readable corps → corp row hidden", !r.noCorps.includes("Corp ("));

  summary("dashboard-render");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/dashboard-render.test.js`
Expected: crashes with `ReferenceError: renderDashboard is not defined` (dashState/renderDashboard don't exist yet).

- [ ] **Step 3: Add the markup**

In `index.html`, inside `<div class="controls">`, directly after the Account fieldset's closing `</fieldset>` (the third one), insert:

```html
  <fieldset class="ctl-section" id="dash-section" style="flex:1;align-self:stretch">
  <legend>Wallets &amp; Activity</legend>
  <div id="dash-wallets" style="min-width:210px"></div>
  <div id="dash-activity" style="min-width:260px"></div>
  </fieldset>
```

- [ ] **Step 4: Add settings, state, and `renderDashboard`**

In `index.html`, directly after the closing brace of `saveCorpBuysSetting`, insert:

```js

// ── Dashboard: wallets & activity ────────────────────────────────────────────
// Balances and corp list arrive with each refresh; activity stats come from
// the durable ledger, so they render on page load before any network I/O.
const DASH_CORP_INC_KEY = "myOrders.dashboard.includeCorp";
const DASH_CORP_SEL_KEY = "myOrders.dashboard.corps";
let dashIncludeCorp = true;      // corp ISK in Total + corp-funded fills in Activity
let dashCorpSel = {};            // corpId → false when excluded; missing = included
let dashCorpPopoverOpen = false;
let dashState = { balances: {}, corps: [] };

function dashCorpIncluded(corpId) { return dashCorpSel[corpId] !== false; }

function loadDashSettings() {
  dashIncludeCorp = localStorage.getItem(DASH_CORP_INC_KEY) !== "0";   // default ON
  try { dashCorpSel = JSON.parse(localStorage.getItem(DASH_CORP_SEL_KEY)) ?? {}; } catch { dashCorpSel = {}; }
}

function saveDashIncludeCorp(on) {
  dashIncludeCorp = !!on;
  try { localStorage.setItem(DASH_CORP_INC_KEY, dashIncludeCorp ? "1" : "0"); } catch {}
  renderDashboard();
}

function setDashCorpIncluded(corpId, on) {
  dashCorpSel[corpId] = !!on;
  try { localStorage.setItem(DASH_CORP_SEL_KEY, JSON.stringify(dashCorpSel)); } catch {}
  renderDashboard();
}

function toggleDashCorpPopover() { dashCorpPopoverOpen = !dashCorpPopoverOpen; renderDashboard(); }

function renderDashboard() {
  const wEl = document.getElementById("dash-wallets");
  const aEl = document.getElementById("dash-activity");
  if (!wEl || !aEl) return;

  const iskCell = n =>
    `<td style="text-align:right;font-family:monospace;padding:1px 0 1px 14px"` +
    ` title="${n == null ? "" : escHtml(fmt(n) + " ISK")}">${n == null ? "—" : formatISK(n)}</td>`;

  // Wallets: one row per character, Total, then the corp row when any corp is readable.
  const rows = [];
  let total = 0;
  for (const rec of ssoChars) {
    const bal = dashState.balances[rec.characterId];
    if (bal != null) total += bal;
    rows.push(`<tr><td style="color:var(--text-dim);padding:1px 0">${escHtml(rec.characterName)}</td>${iskCell(bal)}</tr>`);
  }
  const inclCorps = dashState.corps.filter(c => dashCorpIncluded(c.corpId));
  const corpSum = inclCorps.reduce((s, c) => s + c.balance, 0);
  if (dashIncludeCorp) total += corpSum;
  rows.push(`<tr><td style="border-top:1px solid var(--border);padding:3px 0 1px;color:var(--gold);font-weight:600">Total</td>` +
    `<td style="border-top:1px solid var(--border);text-align:right;font-family:monospace;padding:3px 0 1px 14px;` +
    `color:var(--gold);font-weight:600" title="${escHtml(fmt(total) + " ISK")}">${formatISK(total)}</td></tr>`);
  if (dashState.corps.length) {
    const pop = !dashCorpPopoverOpen ? "" :
      `<div style="position:absolute;left:0;bottom:100%;z-index:100;background:var(--bg3);` +
      `border:1px solid var(--border);border-radius:3px;padding:8px 10px;white-space:nowrap">` +
      dashState.corps.map(c =>
        `<label style="display:flex;gap:6px;align-items:center;font-size:11px">` +
        `<input type="checkbox" ${dashCorpIncluded(c.corpId) ? "checked" : ""}` +
        ` onchange="setDashCorpIncluded(${c.corpId}, this.checked)" style="width:auto"/>` +
        `${escHtml(c.name)} <span style="color:var(--text-dim)">${formatISK(c.balance)}</span></label>`).join("") +
      `</div>`;
    rows.push(`<tr><td style="position:relative;color:var(--text-dim);padding:1px 0">` +
      `<input type="checkbox" ${dashIncludeCorp ? "checked" : ""} onchange="saveDashIncludeCorp(this.checked)"` +
      ` style="width:auto;vertical-align:middle"` +
      ` title="Include corp ISK in Total and corp-funded sales in Activity"/>` +
      ` Corp (${inclCorps.length}) <button onclick="toggleDashCorpPopover()" style="background:none;border:none;` +
      `color:var(--text-dim);cursor:pointer;font-size:11px;padding:0" title="Choose which corps count">⚙</button>` +
      `${pop}</td>${iskCell(corpSum)}</tr>`);
  }
  wEl.innerHTML = `<table style="border-collapse:collapse;font-size:12px">${rows.join("")}</table>`;

  // Activity (EVE time = UTC), straight from the ledger already in memory.
  const stats = computeActivityStats(ordersState.ledger ?? [], currentFees(), Date.now(),
                                     { includeCorpSells: dashIncludeCorp });
  const head = `style="color:var(--text-dim);font-size:9px;text-transform:uppercase;letter-spacing:1px;text-align:right;padding-left:18px"`;
  const num  = `style="text-align:right;font-family:monospace;padding:1px 0 1px 18px"`;
  const badge = ` <span title="Some sales lack full cost-basis history — profit covers only the units it could price"` +
                ` style="color:#e0a040;font-size:10px">partial</span>`;
  const profitCell = w =>
    `<td ${num}><span style="color:${w.profit >= 0 ? "var(--green)" : "var(--red)"}"` +
    ` title="${escHtml(fmt(w.profit) + " ISK")}">${fmtIskSigned(w.profit)}</span>${w.profitPartial ? badge : ""}</td>`;
  aEl.innerHTML =
    `<table style="border-collapse:collapse;font-size:12px">` +
    `<tr><td></td><td ${head}>Today</td><td ${head}>Last 7 Days</td></tr>` +
    `<tr><td style="color:var(--text-dim)">Sales</td><td ${num}>${stats.today.fills} fills</td>` +
    `<td ${num}>${stats.week.fills} fills</td></tr>` +
    `<tr><td style="color:var(--text-dim)">Revenue</td>${iskCell(stats.today.revenue)}${iskCell(stats.week.revenue)}</tr>` +
    `<tr><td style="color:var(--text-dim)">Profit</td>${profitCell(stats.today)}${profitCell(stats.week)}</tr></table>`;
}
```

- [ ] **Step 5: Wire it up (four small edits)**

**(a) `refreshOrders`** — replace the two-way `Promise.all` destructure:

```js
    const [{ orders, warnings: ow }, { ledger, warnings: ww }] =
      await Promise.all([fetchAllCharacterOrders(), syncAllWalletTx()]);
```

with:

```js
    const [{ orders, warnings: ow }, { ledger, warnings: ww }, wallets, corpRes] =
      await Promise.all([fetchAllCharacterOrders(), syncAllWalletTx(),
                         fetchWalletBalances(), fetchCorpBalances()]);
    dashState = { balances: wallets.balances, corps: corpRes.corps };
```

and extend the warnings line in the `ordersState = {...}` assignment from
`warnings: [...ow, ...ww, ...region.warnings],` to:

```js
      warnings: [...ow, ...ww, ...wallets.warnings, ...corpRes.warnings, ...region.warnings],
```

**(b) `renderOrdersTable`** — add as the FIRST statement of the function body (it must run on the early-return paths too):

```js
  renderDashboard();
```

**(c) `updateSsoUI`** — add the same call as the FIRST statement of its body, so roster changes (add/remove character) redraw the wallet rows:

```js
  renderDashboard();
```

**(d) `init`** — add `loadDashSettings();` right after `loadCorpBuysSetting();`, and directly before the final `renderOrdersTable();` add:

```js
  // Activity stats need no network: the ledger is durable in IndexedDB, so the
  // dashboard renders on load. Balances stay "—" until the first refresh.
  const { merged } = mergeWalletTx(await idbTxAll(), []);
  if (!ordersState.ledger.length) ordersState.ledger = merged;
```

**(e) `saveCorpBuysSetting`** — no edit needed: it already ends by calling `renderOrdersTable()`, which now re-renders the dashboard (the corp-buys setting changes basis eligibility, which changes profit).

- [ ] **Step 6: Run test to verify it passes**

Run: `node tests/dashboard-render.test.js`
Expected: `dashboard-render: ALL PASSED`.

- [ ] **Step 7: Run the full suite**

Run: `bash tests/run.sh`
Expected: `syntax: OK` and every file `ALL PASSED` — especially `orders-render.test.js` and `sso-multichar.test.js`, whose code paths now call `renderDashboard()`.

- [ ] **Step 8: Visual sanity check in the browser**

Serve the app (`python3 -m http.server 8080` from the repo root, or however the user normally runs it), open `http://localhost:8080/`, and confirm: the Wallets & Activity fieldset fills the previously empty space; activity tiles show data immediately (ledger already in IndexedDB); balances fill in after Refresh Orders; the corp row appears only after a character re-logs with the new scope and holds the Accountant role. This step verifies layout only — logic is covered by the tests.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/dashboard-render.test.js
git commit -m "Add header mini-dashboard: wallet balances, corp ISK, and activity stats

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
