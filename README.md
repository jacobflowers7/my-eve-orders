# My EVE Orders

A standalone market-order manager for EVE Online. Single-file, no build step, no server-side backend — all your data lives in your own browser (localStorage + IndexedDB). Extracted from the "My Orders" feature of a larger arbitrage tool.

## What it does

- Logs in as multiple EVE characters, across multiple accounts, at once.
- Shows every active market order for every logged-in character: your price, weighted-average cost basis, live Jita reference price, how far you are off the best competing offer at the order's own station, and a markup-driven target price.
- Click any Avg Cost to see exactly which purchases are contributing to it.
- Exports everything to a real Excel workbook — with live formulas, not a static snapshot. Edit the Global Markup %, Broker Fee %, or Sales Tax % cells in Excel and every row recalculates.

## Hard constraint

**ESI (EVE's API) has no endpoint to modify market orders.** This tool computes what your prices *should* be — it never submits anything. You apply price changes manually in the EVE client. The Target and Δ Price columns are click-to-copy to make that fast.

## Running it

This is a static site — no build, no dependencies to install. Serve the folder over `http://` or `https://` (not `file://` — EVE's SSO login can't redirect back to a local file):

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/`.

## One-time setup: register an EVE application

1. Go to [developers.eveonline.com/applications](https://developers.eveonline.com/applications) and create a new application (or edit an existing one).
2. Add these four scopes:
   - `esi-markets.read_character_orders.v1`
   - `esi-wallet.read_character_wallet.v1`
   - `esi-universe.read_structures.v1`
   - `esi-markets.structure_markets.v1`
3. Set the callback URL to wherever you're hosting this page (e.g. `http://localhost:8080/` for local use, or your real deployed URL).
4. Paste the application's Client ID into the "EVE SSO" field in the app and click **Log In**. Repeat for every character you want tracked — logging in again with the app already open adds a character, it doesn't replace the current one.

If you deploy this to a real domain later, add that URL as an additional callback on the same application (or register a second one) — the Client ID field has no default baked in, so you decide.

## The "vs Best %" column

How far your price sits from the **best** live offer on your own side at your order's own station — lowest sell if you're selling, highest buy if you're buying. Your own order is included in that comparison, so:

- **0%** means you're tied with real competitors for the best price — nothing has beaten you, but someone else is also listed there.
- **"solo"** means nobody else is even listed at that station on that side. It's a different state from 0%: you haven't beaten anyone, there's just no competition to beat.
- **Positive** on a sell order: someone is undercutting you, by that much.
- **Negative** on a buy order: someone is outbidding you, by that much.
- **Blank** only when the station's order book can't be read at all.

That last case is why `esi-markets.structure_markets.v1` matters. ESI's public `/markets/{region_id}/orders/` feed covers NPC stations and structures whose market is set to public — but **not** access-restricted citadels. If you trade out of an alliance-only structure, its entire book is invisible to the public feed (Providence's whole public feed is 42 orders; Jita's is 412 pages), so without that scope this column stays empty for every order you have there. With it, the app reads each such structure directly, authenticated as a character who has market access.

If none of your logged-in characters can read a structure's market, the app says so in the warnings line rather than silently showing a blank.

## Filtering the table

The **Char** and **Station** column headers each carry a dropdown, populated from whichever characters and stations actually appear in your current order list. Pick one to narrow the table to just that character or station — the two filters combine (AND), and either can be reset back to "All" from its own dropdown. If a filtered character or station later has no orders (they logged out, the order closed), the filter resets itself back to "All" on the next refresh rather than silently showing an empty table.

## Cost-basis model

Average cost is a **weighted average**, not FIFO, pooled across every character you've logged in. This is deliberate: once stock moves between your own characters (contracts, corp hangars), there's no way to trace which specific purchase a given unit of stock came from, so per-lot tracking would be unreliable in exactly the cases it's meant to help with.

The wallet-transaction ledger only has data since you started using this tool (ESI only serves a rolling window of recent transactions, walked backward on each refresh). Items bought before that, or bought via a corporation wallet, show cost basis as **n/a** rather than a confidently wrong number.

## Tests

```bash
bash tests/run.sh
```

Pure logic (cost-basis engine, pricing formulas, Excel export planning, etc.) is unit tested directly against the app's own inline script. ESI/browser-only code (auth flow, IndexedDB, live rendering) is verified manually in a real browser — see commit history for the verification notes from when this was extracted.

## Origin

Extracted from the `eve_arbitrage` project's My Orders tab. If you're comparing the two: this tool intentionally drops the market-scanning, gap-detection, and shopping-list features — it's just the order-management piece, standalone. Storage keys were renamed (`myOrders.*` instead of `eveArb.*`) so the two tools never collide if ever loaded from the same origin.
