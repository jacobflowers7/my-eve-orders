# vs Best % — Real Competition Only — Design

**Date:** 2026-09-07
**Status:** Approved for planning

## Purpose

The "vs Best %" column exists to answer one question: **has another player taken
the best price away from me at this station, and by how much am I behind?**

It currently answers that question wrongly in three distinct ways, all of which
resolve to a falsely reassuring green cell. This design makes the column compare
against *real competitors only* and report five explicit, non-overlapping states.

## The three defects

1. **A tolerance band swallowed real undercuts.** The render painted anything
   within `Math.abs(vsBestPct) < 0.05` green and printed it as `0.0%`. The
   standard undercut in EVE is a hair — 0.01 ISK, or a few hundredths of a
   percent — so the band greened out precisely the case the column exists to
   catch. An order listed at 100,000,000 against a rival at 99,999,999.99
   computed to `0.00000001%` and rendered as a winning `0.0%`.
   *(Fixed ahead of this spec; see "Already landed" below.)*

2. **Your own orders counted as competition.** `stationBestRef` and
   `stationOfferCount` filter the station book by `locationId` only — never by
   whose order it is. Two consequences:
   - Holding two of your own orders on one item at one station makes
     `stationOfferCount` return 2, so `isSolo` is false and the row reads as a
     win "against real competition" when nobody else is listed at all.
   - A tie can be a tie with yourself.

3. **Ties were indistinguishable from wins.** A rival matching your exact price
   produced `0.0%` green — visually identical to holding the best price alone.
   A rival at parity is already taking sales from you and must be called out.

## Decisions made during brainstorming

- **Competition = other players only**, determined by exact `order_id` match
  against every order held by every logged-in character. No heuristics.
- **A winning order shows its gap**, not a flat `0.0%`. Once your own orders are
  excluded the comparison is always against a real rival, so a winning sell
  reads `-8.3%` — how much headroom you have before anyone touches you. This
  frees `0.0%` to mean exactly one thing: tied.
- **Ties are amber**, a third colour distinct from win-green and beaten-red.
- **The export's "Best Offer" column is renamed "Best Rival Offer"** to match its
  new meaning. The formula is unchanged.

## 1. Competition set

One helper replaces the two current station lookups:

```
stationRivals(regionBooks, order, myOrderIds)
  → the orders at this order's own station, on its own side,
    minus every order_id belonging to any logged-in character
```

`myOrderIds` is a `Set` built once per render from `ordersState.orders`, not per
row — the roster is identical for every row.

The region book is already sorted best-first and filtering preserves that, so
`rivals[0]` is the best competing offer and `rivals.length` is the competitor
count. Both come from one filtered list; there is no second traversal.

## 2. Readability test

Today `stationBestRef` returns `null` on an empty filtered list, which conflates
"this station's book can't be read" with "nothing is listed here". Excluding our
own orders makes an empty list *expected* (solo), so readability needs its own
signal.

**Your own live order must appear in a book you can actually read.** So:

| Condition | State |
|---|---|
| No book for (region, type) | `unreadable` |
| Book exists but your own order is absent from it | `unreadable` |
| Book readable, zero rivals | `solo` |
| Book readable, ≥1 rival | compare against `rivals[0].price` |

This is strictly more precise than the current `here.length === 0` test: it
distinguishes a structure whose market we cannot read (no scope, ESI cache lag)
from a station where we are genuinely alone.

## 3. States, decided in the derivation

`deriveOrderRow` returns `vsBestState`, one of:

| State | Condition |
|---|---|
| `unreadable` | per the table above |
| `solo` | book readable, no rival orders on this side here |
| `beaten` | sell priced **above** rival best, or buy bidding **below** it |
| `tied` | `vsBestPct === 0` against a rival |
| `winning` | otherwise |

`vsBestPct = (price - rivalBest) / rivalBest * 100`, unchanged in form. Sells
read positive when beaten and negative when winning; buys the reverse. The sign
convention for the *beaten* direction is identical to today's, so nothing a user
already understands is inverted.

The state is computed in the derivation, not the render, so it is unit-testable
without HTML and reusable by the export.

## 4. Display

| State | Cell | Colour |
|---|---|---|
| `winning` | `-8.3%` (headroom) | green |
| `tied` | `0.0%` | amber |
| `beaten` | `+2.1%` | red |
| `solo` | `solo` | muted, italic |
| `unreadable` | `—` | none |

New CSS: `--amber: #e0a040` (the value already used inline by the "partial"
badge, promoted to a variable) and `.profit-tie { color: var(--amber); }`.

**Rounding guard, both directions.** `0.0%` is now the specific claim "tied", so
it must never be printed for anything else. A gap that would round to zero at one
decimal renders as a bound instead:

| | rounds toward zero |
|---|---|
| beaten sell | `<0.1%` |
| beaten buy | `>-0.1%` |
| winning sell | `>-0.1%` |
| winning buy | `<0.1%` |

The exact figure goes in the cell's `title` at two significant digits.

## 5. Export

`bestRef` becomes the rival best, so the XLSX header changes from `Best Offer` to
`Best Rival Offer`. The `vs Best %` formula `IF(K="","",(G-K)/K*100)` is
unchanged and remains correct under the new meaning.

## 6. Known limitation — documented in the tooltip

**An order placed by an account not logged into this tool cannot be recognised as
yours.** It will count as a rival, and can present as a "tie" against yourself.
The only remedy is adding that character to the tool. This is stated in the
column tooltip rather than left for the user to discover, because a tie is
exactly the state a trader would otherwise act on.

## 7. Testing

Extend `tests/vs-best-undercut.test.js` and `tests/region-books.test.js`:

- two of your own orders at one station → `solo` (defect 2)
- your order + a rival at equal price → amber `tied` (defect 3)
- your order + a rival at equal price + a second order of your own → still
  `tied` against the rival, not confused by the self-match
- winning renders the negative gap, not `0.0%`
- winning by a hair renders the bound, not `0.0%`
- your own order absent from the book → `—`, not `solo`
- the undercut regressions from the landed fix continue to pass

`tests/orders-render.test.js` has **two assertions that this design
invalidates** — the buy order that "holds the top bid → 0.0% green" becomes a
winning `+12.5%`. They will be updated to the new expectation, not worked around.

## Already landed

The tolerance-band fix (defect 1) is committed ahead of this spec, along with
`tests/vs-best-undercut.test.js`. This design builds on it: the direction test
(`beaten`) introduced there survives intact and becomes one of the five states.

## Out of scope

- Corp orders (`is_corporation`). The tool fetches character orders only; no
  corp-order handling exists anywhere in the codebase today.
- Paginating the region/Jita book fetches. Tracked separately — those fetchers
  read only page 1 of a paginated ESI endpoint. Latent, not currently triggered.
