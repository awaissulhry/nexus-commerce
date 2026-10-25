# Listings live layer — build plan, option A (25 October 2026)

## Summary

- **Owner's pick:** A — one `/listings` page does both jobs: readiness (is the data good?) and live listings (what is
  on the channel now?). The legacy page is removed at the end.
- **Approved:** the Owner said "yes, all 8" (25 Oct). This file is the exact preview he approved; each PR's record is
  added to section 6 when it is built.
- **8 small PRs**, in order. Each one works on its own and goes live on its own. Each merge waits for "Merge #N".
- **No schema change. No new marketplace write.** Bulk actions reuse the endpoints that exist today, with their
  existing checks. Amazon FBA quantity is never written.
- Based on the review `docs/listings/LISTINGS-PAGE-REVIEW-2026-10-25.md` and two read-only planning agents
  (API half, UI half) on `origin/main` 3027438d1.

## 1. The page after all 8 steps

The numbers in the sketches are examples, not real counts.

```
Listings                                  [Translate filtered…] [Publish history] [Export ▾]
412 products · 4,210 listings on 12 markets · checked 2 min ago
[Blocked 41][Warnings 88][Ready 260][Not set up 23]  [Live 3,950][Errors 12][Suppressed 4][Out of sync 31]
Filters: Channel▾ Market▾ Store▾ Language▾ Family▾ Channel state▾ Stock▾
[Products | Problems]  412 products [Search SKU, name, ASIN, Item ID…]   Density Customise Views ● Up to date
☐ ▸ [img] GALE-JACKET   │ Shared ●  Shopify ○             │ 18 Active · 2 Not listed │ Add size chart │ Open Edit ⋯
      GAL-001 · 20 var. │ Amazon ●DE·3 ●IT ◐FR ▲ES        │ 1 Suppressed             │ Amazon DE · 20 │
                        │ eBay   ●IT ○DE                  │                          │                │
```

- When rows are selected, the toolbar becomes:
  `12 products selected · reaches 214 listings on Amazon DE  [Publish…] [Set price…] [Follow master] [⋯]  Clear`
- On a market page (for example `/listings/amazon/de`) each row is one listing, with the columns:
  ☐ Product · Readiness · Status · Price · Qty · ASIN · Last push · Synced · Next step · Actions.

### The chip (one per store + market)

| Part | Meaning |
|---|---|
| Colour | Readiness, unchanged: Blocked (red), Warnings (amber), Ready (green), Not set up / Not computed (grey) |
| `· 3` | Fields with problems, unchanged |
| ● | Every listing here is Active on the channel |
| ◐ | The variations differ ("Mixed: 18 Active, 2 Not listed") |
| ○ | Not selling here: Not listed, Inactive or Ended |
| ▲ | A problem on the channel: Suppressed, Push failed or channel messages. This mark wins over the others. |
| no mark | Shared, or not read from the channel yet |

- The words are the design system's own words for selling state (Active · Inactive · Not listed · Ended · Mixed,
  your choice of 4 Oct). No new words.
- Chips for markets where the product is not listed stay visible, with ○.
- The keyboard works as now: Tab moves between chips, Enter opens the window. A ▲ chip opens the "On the channel" tab.

### The Listing window (replaces the Fix window; centred, not a drawer)

```
GALE-JACKET · Amazon DE                                        ▲ 3 of 50 ▼  ✕
[Blocked] [Mixed]  Checked 2 min ago · Read from Amazon 1 h ago
Market switcher: Amazon DE IT FR ES · eBay IT DE · Shared · Shopify
[Readiness 3] [On Amazon 2] [Price & stock] [History]
On Amazon: Mixed (18 Active · 2 Not listed)
  Parent ASIN B0ABC123 ↗ · Last push Failed 25 Oct 10:42
  ▲ Suppressed GAL-001-M: "Missing main image" (Amazon, 24 Oct)  [Diagnose with AI…] [Mark resolved in Nexus]
  Amazon says, word for word: 90220 "The value for 'size_name' is not allowed." (GAL-001-L)
  Variations: SKU · Status · Price · Qty · ASIN · Last push · Messages
[Open on Amazon ↗] [Sync activity] [Sales]                 [Close] [Publish…] [Open in studio]
```

- Only **Pin price** and **Follow master** can be changed in the window. Buffer, quantity, fulfilment and rules
  open the studio Matrix (one place to write, and it has Undo).
- "Diagnose with AI" runs for one listing only, after a confirm (it costs money).

## 2. The 8 PRs

| # | What changes | What you see after it |
|---|---|---|
| 1 | **Small fixes.** Each grey state gets one name on this page ("Not set up", "Not computed"; today one state has three names). The header shows the **latest** check, plus "N listings last checked over a day ago" when there are any (today it shows the oldest). The Market filter lists only markets the business is connected to. One refresh when the tab comes back (today two). An **Etsy** store page and menu item (Etsy chips exist, but there is no Etsy page). Inside one market, "N listings" becomes "N products". No made-up "Not checked" rows when the page is opened from a list of listing ids. | The same page, with honest words and numbers |
| 2 | **Load fix.** One SQL query computes the tiles, the order and the page; only the 50–200 rows on screen are built in detail. A 30-second poll gets "nothing changed" (ETag) when nothing changed. Today every call loads all ~11,300 rows. Tests prove the new query gives exactly the same rows and counts as today. | The same page, faster |
| 3 | **Live layer (read only).** Each chip gets its live mark (●◐○▲). New column "On the channel" ("18 Active · 2 Not listed · 1 Suppressed"). 4 live tiles: Live, Errors, Suppressed, Out of sync. New filters: Channel state, Stock (low stock). Search also finds ASIN, eBay Item ID and many SKUs pasted at once. The Amazon suppressed banner and its 30-second call are replaced by the Suppressed tile. Live data shows only to people with the "view listings" permission. | What is live, where, and what the channel rejected |
| 4 | **Columns, sort, export.** Market pages get Status, Price, Qty, Channel ID (links to the live listing), Last push, Synced, Channel messages. Columns can be sorted (on the server). Column filters on market pages. **Export** of the filtered result to CSV or Excel (max 50,000 rows; cells that start with = + - @ are made safe). | Sort, filter and export like Products |
| 5 | **Listing window** (section 1). Opens from a chip, Open, or a link `?listing=<id>`. | Everything about one listing in one place |
| 6 | **Selection and bulk bar** (like Products), plus the right-click menu. Actions: **Publish…** (the existing publish window, with its review), **Set price…** (store and market pages only; existing 30-second hold; no undo, and the confirm says so), **Follow master**, **Stop following master** (30-second Undo), **Translate selected…** (Nexus only), **Export selected**. The bar says how many listings an action reaches before it runs. | Change many listings at once |
| 7 | **Problems view.** A Products / Problems switch. Each row is one problem, for example "Missing size chart · Amazon DE · 34 products", including the channel's messages word for word and "Ready, not listed". Click → the page filtered to those products. | Fix by problem, not product by product |
| 8 | **Legacy exit.** 19 links in 14 files are pointed at the new page (Home alerts and quick action, Home market table, ⌘K, Publish history, Sync health, API calls log, Approvals, product drawer and lenses, the Legacy button, the menu). Old link options (`search`, `listingStatus`, `hasError`, `drawer`, `lens=health`, …) are read by the new page. `/listings/legacy/…` sends to the new pages (308). Then the legacy files are deleted (`ListingsWorkspace.tsx`, `legacy/**`, the old Amazon / eBay / Shopify clients and the API reads only they use). Routes that other pages still use stay. | One Listings page |

### Not carried over from the legacy page (your yes covers this)

| Legacy part | Why not |
|---|---|
| Performance lens | `/insights/products` already shows sales per channel and market; the window links there |
| Health score 0–100 | It would be a second verdict next to readiness |
| Bulk "Resync" | It does nothing today: it only marks listings "pending" and nothing picks them up |
| AI diagnosis for many listings at once | Costs money per listing; one at a time stays |
| Amazon "Parent ASINs" tile | It leads to no action |
| Manual "Log suppression" | Amazon cannot confirm a hand-made record |
| Saved views of the legacy page | Different columns; not moved |

Until PR 8, the legacy page stays as it is. Its known fault (a product without variations uses the wrong id for
Open, Resync and price) is not fixed there, because PR 8 removes it.

## 3. Checks per PR (LOCAL FIRST — LIGHT)

| Check | Command |
|---|---|
| Types | `npm run typecheck -w @nexus/web`; plus `-w @nexus/api` and `-w @nexus/shared` when they change |
| API tests | `cd apps/api && npx vitest run src/services/pim/listing-readiness` (+ the new SQL-parity, live-state, export, options and permission tests) |
| Web tests | `cd apps/web && npx vitest run src/app/listings` |
| Guards | `check-raw-primitives-ratchet`, `ds-conformance-guard` (already fails on main), `check-ag-grid-import-boundary`, `check-grid-modules`, `check-i18n-catalog`, `check-link-targets` |
| Browser (PRs 3, 5, 6, 7) | local API + local database, `NEXT_PUBLIC_API_URL` set; light + dark; 1440 px + 390 px; keyboard only; Products page unchanged |

## 4. Risks

- The live state is computed twice (SQL for tiles and filters, TypeScript for chips). A parity test pins them together.
- Price and stock are what Nexus last sent or read, not a fresh read. Some values are never read back (eBay price,
  Etsy price and quantity); the window says "as sent by Nexus" there.
- Prices in different currencies and Amazon's one EU stock number are never added up across markets.
- "Refresh from Amazon" in the window ships only if it goes through the channel gateway (hard rule 4). If not, it
  stays out.

## 5. Undo

Each PR is one squash merge and can be reverted on its own. No data is changed by any of the 8 PRs.

## 6. Build record

| PR | Branch | State |
|---|---|---|
| 1 — small fixes | `feat/listings-live-1-fixes` | built 25 Oct; checks in the PR |
