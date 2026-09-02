# Header Mini-Dashboard — Design

**Date:** 2026-09-02
**Status:** Approved for planning

## Purpose

Fill the unused space in the header/controls area with a mini-dashboard showing
wallet balances and trading activity: per-character ISK, total ISK across
logged-in characters, corp ISK, and sales/revenue/profit for today and the last
7 days. A future full-page dashboard (charts, history) is explicitly out of
scope, but the stats engine built here must be reusable by it.

## Decisions made during brainstorming

- **Corp wallet scope:** added for all characters (one re-login each), with a
  dashboard-level toggle controlling whether corp ISK/activity counts toward
  totals, and a per-corp filter for which corps are included.
- **Sales metric:** fills (wallet sell transactions), not orders or units. The
  ledger records fills; distinct orders are not recoverable from it.
- **Time bounds:** EVE time (UTC). Today = since 00:00 UTC. Week = trailing 7
  UTC days including today (since 00:00 UTC six days ago).
- **Profit:** net of sales tax + broker fee, against avg cost at the moment of
  each sell, replayed from the ledger. Broker fee is an estimate (actually paid
  at order placement).
- **Revenue:** gross sell proceeds (qty × unit price), before fees.
- **Scope:** mini-dashboard now; full dashboard page is a separate future spec.

## 1. Placement & layout

Header stays untouched. One new fieldset in the controls row, after Account,
using the existing `ctl-section` / `legend` idiom, with `flex:1` to fill the
remaining width. Two groups side by side:

```
┌ WALLETS ──────────────────┬ ACTIVITY (EVE time) ────────────────────────┐
│ Rytha Main      1.24 B    │           TODAY          LAST 7 DAYS        │
│ Mistress Rose   3.80 B    │  Sales      37 fills       412 fills        │
│ Kahar Dex       410.2 M   │  Revenue    1.92 B         14.6 B           │
│ Samara Dex      88.1 M    │  Profit     311 M          2.41 B  partial  │
│ ─────────────────────     │                                             │
│ Total           5.54 B    │                                             │
│ Corp ☑ (2)      12.9 B ⚙  │                                             │
└───────────────────────────┴─────────────────────────────────────────────┘
```

- **Wallets group:** one row per logged-in character; a Total row; a Corp row.
  The Corp row has a checkbox (include corp ISK in Total and corp fills in
  activity) and a ⚙ popover listing discovered corps with per-corp checkboxes.
  The Corp row shows the count of included corps.
- **Activity group:** 3×2 grid — Sales (fills), Revenue (gross), Profit (net)
  × Today / Last 7 days.
- ISK values use the app's existing abbreviated formatting (`1.51 B` style)
  with the full value in a hover title.
- Characters missing the wallet scope show `—` for balance.
- The Corp row hides entirely when no corp balance is readable.

## 2. Data sources & refresh

| Data | Source | When |
|---|---|---|
| Character balances | `GET /characters/{id}/wallet/` (existing `esi-wallet.read_character_wallet.v1` scope) | In parallel with the existing orders + wallet-tx refresh |
| Activity stats | Existing IndexedDB wallet-transaction ledger | On page load (no network) and after each refresh |
| Corp balances | `GET /corporations/{corp_id}/wallets/` (new scope, below) | In parallel with refresh |

- **New scope:** `esi-wallet.read_corporation_wallets.v1` is appended to
  `SSO_SCOPES`. It is optional like `STRUCTURE_SCOPE` — a character without it
  still works fully; they just contribute no corp balance until re-logged.
- **Corp discovery:** public `GET /characters/{id}/` → `corporation_id`,
  deduped across characters (one fetch per corp, using a token from any member
  character that has the scope). Corp names resolved via the public
  corporation endpoint.
- **Corp balance:** sum of all 7 wallet divisions.
- **403 handling:** a 403 (missing in-game Accountant/Junior Accountant role,
  or scope not yet granted) silently drops that corp for that character;
  another member character may still succeed.
- Activity stats populate immediately on load from IndexedDB, before any
  refresh. Balances populate after the first refresh.

## 3. Stats engine (reusable)

One pure function:

```
computeActivityStats(ledgerRows, fees, now, opts) → {
  today: { fills, revenue, profit, profitPartial },
  week:  { fills, revenue, profit, profitPartial },
}
```

- Replays the **full** ledger in the same order as `computeCostBasis`
  (date, then transactionId), maintaining per-type running
  `unitsOnHand`/`totalCost`, because avg cost at the moment of each sell
  depends on all prior history.
- For each sell fill whose date falls inside a window, accumulates:
  - `fills` += 1
  - `revenue` += qty × unitPrice (gross)
  - `profit` += covered × unitPrice × (1 − brokerFee − salesTax)
    − covered × avgCostAtThatMoment, where
    `covered = min(qty, unitsOnHand)`.
  - If `qty > unitsOnHand` (or no basis exists), the window's
    `profitPartial` flag is set — profit covers only the covered units,
    mirroring the existing `partial` convention on Avg Cost.
- Buy-side basis eligibility follows the existing "Count corp-funded buys"
  setting (`basisEligibleTx`), unchanged.
- Sell-side inclusion: when the dashboard corp toggle is **off**, sell fills
  with `isPersonal === false` are excluded from fills/revenue/profit. When
  **on**, they are included. (Rows persisted before `isPersonal` was tracked
  count as personal, consistent with `basisEligibleTx`.)
- A fill is in a window when its date ≥ the window start: 00:00 UTC today
  (today window), 00:00 UTC six days back (week window). Ledger dates are ISO
  UTC strings from ESI, compared as timestamps.
- Pure, side-effect free, exported to the test harness like the other engines.

## 4. Corp inclusion toggle & persistence

- One dashboard-level checkbox on the Corp row: when off, corp ISK is excluded
  from Total and corp-funded fills are excluded from activity stats.
- The ⚙ popover lists each discovered corp with a checkbox; unchecked corps
  are excluded from the Corp row balance. (Corp *balance* filtering is
  per-corp; corp *activity* filtering is the single toggle — fills don't carry
  a corp id.)
- Deliberately separate from the existing "Count corp-funded buys" cost-basis
  setting, which continues to govern buy-side basis only.
- Toggle state and per-corp selections persist in localStorage
  (`myOrders.dashboard.*` keys). Default: toggle **on**, all discovered corps
  included.

## 5. Error handling

- Any per-character or per-corp ESI failure degrades that row to `—` and
  appends to the existing `#orders-warnings` line; it never blocks or delays
  the orders refresh.
- Wallet balance fetches share the existing retry/backoff helper used by other
  ESI calls.
- A character whose token lacks the new corp scope produces no warning spam —
  the corp row simply reflects what is readable.

## 6. Testing

Following the existing `tests/` harness pattern (pure functions extracted and
exercised in Node):

- **`activity-stats.test.js`** — window bounds at UTC midnight (fill at
  23:59:59 vs 00:00:00), week boundary six days back, fills/revenue/profit
  accumulation, fee math, partial-basis flagging (sell exceeding on-hand,
  sell with no buy history), corp sell inclusion/exclusion via the toggle,
  legacy rows without `isPersonal`.
- **`corp-wallets.test.js`** — corp dedupe across characters, division
  summing, 403 fallback to another member character, missing-scope skip.
- **`wallet-sync.test.js`** (addition) — balance fetch success, failure
  degradation, missing-scope `—`.

## Out of scope

- Full dashboard page with charts/graphs/history (future spec; will reuse
  `computeActivityStats`).
- Per-corp attribution of activity stats (fills don't carry a corp id).
- Order-level sales counts (not recoverable from wallet transactions).
- Corp wallet journal/transaction history.
