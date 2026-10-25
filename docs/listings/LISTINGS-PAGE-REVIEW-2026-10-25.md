# Listings page review — purpose, competitors, gaps (25 October 2026)

## Summary

- **What it is:** the new `/listings` page (PRs #748, #750, #751, #752) is a **readiness checklist**. It answers
  "is my saved product data good enough to publish, and where do I fix it?". It reads only `ReadinessIndex`.
  It never reads the live channel listings.
- **Is that the job of a "Listings" page?** Only half of it. In every channel tool we studied, the Listings screen
  first shows **what is live on each channel now**: status, price, stock, channel ID, channel errors, and bulk
  actions. Readiness is the other half. Most tools keep it on a separate screen. The best ones (ChannelEngine,
  M2E, Listing Mirror) show both in one grid.
- **Where the live half is today:** only on `/listings/legacy` (last item in the menu), plus parts in the studio
  Matrix, `/catalog/matrix`, `/sync-logs`, `/dashboard/health`, `/pricing`. The legacy grid probably has two
  faults (section 5).
- **Biggest gaps:** live status / price / stock / ASIN or Item ID on the row; the channel's own errors; row
  selection + bulk actions; export; sorting; an "issue-first" view (one problem → all products that have it).
- **Decision for the Owner:** section 6. Recommended: **A — one Listings page that does both jobs**.
- Method: 4 read-only agents (2 on the code at `origin/main` 3027438d1, 2 on public competitor docs). Nothing was
  changed, run or published.

## 1. What the new page does (from the code)

Paths: `apps/web/src/app/listings/_readiness/` (page), `apps/api/src/services/pim/listing-readiness-families.service.ts`
(API), `packages/shared/listing-readiness.ts` (types).

| Part | What it is |
|---|---|
| One row | A product family (root) or a single product. Opening a family shows up to 10 variations + a footer. |
| One "listing" | One product on one destination (channel + market + account + alias). Languages fold into one verdict; the worst wins. |
| Which destinations | **Every** destination the business is connected to, plus "Shared" per language — for every product, listed there or not. |
| One chip | The worst state on one destination; the number = fields with problems. Chips are grouped one line per store. |
| Tiles | All / Blocked / Warnings / Ready / Not checked (product × destination units). Click = filter. |
| Columns | Product (photo, name, SKU, variations), Markets, Next step, Checked, Fix + Edit. |
| Fix window | Read-only. Problems per market and language, each with "Open field" (exact studio field), SKUs touched. |
| Filters | Channel, Market, Store, Language, Family; search on SKU, name, GTIN/EAN/UPC. |
| Live | Event stream (`readiness.updated`) + re-read every 30 s and on tab focus. |
| Actions on the page | Only **Translate filtered products…** changes anything. Everything else links out. |

What the page does **not** show (the row type has none of these fields): live status on the channel (active,
inactive, suppressed, ended), price, stock, ASIN / eBay Item ID, last sync or sync error, sales, Buy Box, listing
URL, or **whether the product is listed on that channel at all**. The one exception is the Amazon suppressed
**count** banner on Amazon pages. The page's own footer says "Readiness reflects saved information…".

### Grid features: Listings vs Products (same `NexusGrid`, AG Grid Enterprise)

| Feature | Listings | Products |
|---|---|---|
| Families, paging, density, Customise, saved views | yes | yes |
| Sorting | **no** (all `sortable:false`, fixed worst-first order) | yes |
| Per-column filters | **no** | yes |
| Row selection + bulk actions | **no** | yes (Bulk edit, Publish…, Tag, Duplicate, Delete) |
| CSV export | **no** (the DS export refuses server-side grids) | yes |
| Right-click menu | no | yes |
| Inline edit | no | stock only |

## 2. Is it the right job?

| Job | Old page (now `/listings/legacy`) | New `/listings` | Elsewhere |
|---|---|---|---|
| Live status, sync, price, stock, external ID per listing | yes | **no** | one family: studio Matrix; in part `/catalog/matrix`, `/pricing` |
| Search by ASIN / Item ID | yes | **no** | ⌘K (opens legacy) |
| Status presets: Errors, Low stock, Drafts, Out of sync, Suppressed | yes | **no** | — |
| Sort, CSV export | yes | **no** | — |
| Inline price pin, bulk resync / set price / follow master + Undo | yes | **no** | studio Matrix (one family), `/pricing` |
| Health lens, Matrix lens (drift), Performance lens | yes | **no** | in part `/sync-logs`, `/dashboard/health` |
| AI suppression diagnosis | yes | **no** | legacy only |
| Listing drawer (sync history, publish attempts, follow master, buffer, Amazon ASIN/FBA fees/Buy Box) | yes | **no** | in part studio |
| eBay watchers / views / questions; Shopify online-store / on sale | yes | **no** | legacy only |
| Readiness verdict, next step, Fix, Translate | links out only | **yes** | — |
| eBay tools (markdowns, promoted, gaps), Publish history | yes | yes | — |

Many app links still send live-state work to legacy: Home alerts and "Resolve errors", Home market matrix, ⌘K
listing results, Publish history SKU links, Sync health cells, API calls log, Approvals, the new page's own
suppression banner.

**Conclusion:** the new page does its own job (readiness) well and is built on the right parts. But under the name
"Listings" it replaced a live-listings page, and the live job did not move with it. A seller who clicks
"Listings" today cannot see what is live, at what price and stock, or what the channel rejected.

## 3. How others do it (public docs, checked 25 Oct 2026)

### Channel tools (the "Listings" screen)

| Tool | Row | Shows | Readiness on the same screen? |
|---|---|---|---|
| Amazon Manage All Inventory | SKU offer per market; parent opens | status, stock (available/inbound/reserved), price + Buy Box flag, pricing status, fees | partly; Listing Quality Dashboard is separate |
| eBay Seller Hub | listing (Item ID) | price, qty, watchers, views; Active/Unsold/Drafts/Scheduled/Ended; bulk 2,000 | quality report separate |
| Shopify Products | product + variants | channel/market filters, Publishing error filter, bulk channel availability | as Draft only |
| ChannelEngine | product per channel, family selector | **next export action / last export result / channel status side by side**; exported vs channel-reported price and stock; "BEWARE" when feedback is stale | **yes** |
| Zentail | SKU (Single/Master/Variant/Alias/Kit/FBA) | Live / Needs attention + reason; "Fix in Quick Edit" opens only the bad SKUs and fields; Published rate, Buyable rate | separate "Listing Prep" |
| M2E Pro | product in one account + market | ASIN, qty (incl. FBA), price, status; list/revise/relist/stop | yes |
| Listing Mirror | listing per channel | Incomplete / Error / Warning / Paused / Pending sync / In sync | yes |
| Linnworks | stock item | one column per channel (count + error colour) | no (listing tool) |
| Tradebyte, Feedonomics | error code / category | tiles per error type, count of articles, click-through | separate error hub |

Industry baseline (most tools): one row per SKU/product with per-channel state; a lifecycle status (Live /
Inactive / Draft / Pending); **three kinds of problem kept apart** — Incomplete (our data), Error (channel
rejected), Warning (live, but fix advised); the channel's error text word for word; filters by channel / account /
market / status; multi-ID search; saved views; bulk price, quantity, publish, relist/end, retry, export/import;
linking existing channel listings to products.

### PIM tools (the "readiness" screen)

| Tool | Readiness model | Problems grouped / fixed | Shows the channel's answer? |
|---|---|---|---|
| Akeneo (+ Activation) | % complete per channel × locale; Ready / Not ready; Errors / Warnings / Info + Health score | **by issue type** with product count → open products / mapping; AI mapping suggestions | yes: Accepted / Rejected, Sent vs Displayed |
| Productsup | Products ready %, Channel ready %, **Channel optimised %** | **by test** → filter to failing items → one rule fixes all | yes: feedback connectors |
| Salsify | required fields per channel | FeedbackIQ (AI reads retailer feedback, points at the field) | partly |
| Syndigo | readiness % per recipient; red errors block | per-recipient rule sets | yes: "Is it Live" (live + content match) |
| Stibo STEP | several completeness metrics per channel | sufficiency panel | yes; says "Accepted ≠ live" |
| Sales Layer | pass/fail per sync | **own errors kept apart from Amazon's answer** | yes |

### Enterprise grid baseline

Checkbox selection with a bulk bar; "select all N filtered" (not only the page); bulk edit; inline edit with undo;
column chooser/pin/reorder; sorting (multi-sort); per-column filters + filter chips; saved views (personal /
shared / default); state in the URL; **export CSV/XLSX**; group-by and detail panel; density; skeleton loading,
empty and error states; full keyboard; accessible roles; server-side rows.

## 4. What is missing — in order

**A. The live half (the biggest gap)**
1. Per destination: **listed or not**, live status (Live / Draft / Inactive / Suppressed / Ended / Error), channel
   ID (ASIN, eBay Item ID) with a link to the live listing.
2. Price and stock per listing; flag when the channel's number differs from ours (drift).
3. The **channel's own errors** (rejections, suppression reasons) word for word, kept apart from our own checks —
   the ChannelEngine "our check · last push · channel says" pattern.
4. Tiles / presets for Live, Errors, Suppressed, Out of sync, Low stock, Not listed.
5. Search by ASIN / Item ID and by many SKUs at once.

**B. Grid**
6. Row selection + bulk bar: Publish selected, Resync, Translate selected, price / stock change, export.
7. Export CSV/XLSX of the filtered result (needs a server export; the DS export refuses server-side grids).
8. Sorting (state, name, problem count, checked time).
9. **Issue-first view:** "Missing size chart — 34 products · Amazon DE" → click → those products → fix
   (Akeneo, Productsup, Tradebyte, Zentail all have it).
10. Per-column filters and the right-click menu (Products has both).

**C. Later / standout**
11. Required vs optional split ("Ready" vs "Optimised", Productsup).
12. Readiness and error history (trend over time).
13. Dry-run check against the channel before a push (Amazon SP-API listings support a validation-preview mode).
14. Alert when a product turns Blocked; Published rate / Buyable rate per channel.

## 5. Faults and rough edges found in the code

New page:
- "Listings" means two things: the menu badge counts real channel listings; the tiles count product × destination
  (including "Shared" and markets the product is not on). The toolbar's "N products" counts family rows.
- One state has three names: "Not checked" (tile), "Not computed" (chip, Fix window), "Not checked yet" (Next step).
- The header "checked …" time is the **oldest** check in the whole result, so one stale family makes the page look stale.
- Load: every call loads all filtered index rows (~11,300) and pages in memory; this runs every 30 s, on every
  event, and twice when the tab comes back (`focus` + `visibilitychange`). Amazon pages also poll the heavy
  `/api/listings/amazon/overview` every 30 s only for the suppression list.
- No Etsy store page, although Etsy chips show on `/listings`.
- The Market filter lists every active marketplace, also markets the business is not connected to.
- Not confirmed, needs a check: siblings may get invented "Not checked" entries per alias; `/gb` → `uk` may miss
  listings stored as GB; late answers may still reach the grid.

Legacy page (`ListingsWorkspace.tsx`) — not confirmed in a browser:
- A product without variations gets the **product id** as its row id (line ~667). The drawer, Resync and inline
  price use that id, but the API expects a channel-listing id → probably fails.
- The unfiltered grid shows only the **first** listing per product, so other markets of that product do not show.

## 6. Decision for the Owner

| | A — one Listings page, both jobs (recommended) | B — two pages |
|---|---|---|
| What | Add the live layer to `/listings`: chip shows live status too, price/stock/ID, channel errors, live tiles, selection + bulk + export. Retire legacy at the end. | Rename the new page "Listing readiness". Build a new live-listings page in the new format (fix the legacy faults). |
| Like | ChannelEngine, M2E, Listing Mirror | Amazon, eBay, Zentail, Tradebyte |
| Pro | One place; fits "extend, don't add pages"; the grid already exists | Each page stays simple |
| Con | Bigger change to one page; needs a careful chip design | Two pages to keep; the seller must switch |

Nothing will be built until the Owner picks and approves an exact preview.
