---
name: listing-stock
description: Explain and change how much each listing shows on each channel, market and account in Nexus, and where that number comes from - own warehouses or another business's shared stock, which warehouses feed which markets, follow or a fixed number, buffers, holds, Amazon's one EU quantity and FBA - then propose pins, follow, buffers, holds, push now, a retry of a failed push, an Amazon FBA/FBM switch, warehouse feeds, stock-sync policies or a stock-source switch as requests a person approves. Use when the person asks why a listing shows a quantity, wants a listing to show more, less, a fixed number or zero, to hold or release the stock sync, about overselling, stock drift with a channel, shared stock, or which warehouse feeds a market. Counting and correcting the warehouse numbers themselves is stock-count.
---

# Listing stock

Nexus works out each listing's quantity from stock and sends it to the channel; nobody types it into the channel. This skill is about that number per listing, market and account. The warehouse counts themselves (count, set, move, hold units) belong to `stock-count`.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. How a listing's quantity is worked out

The first rule that applies wins (listing-matrix `sync.kind` names it):

1. **FBA** (`FBA_EXCLUDED`): Amazon's own number. Nexus sends nothing, ever.
2. **Selling paused** (`CLOSED`, Inactive: Pause offer or an Amazon market close): no quantity is sent until `reopen-listing`.
3. **Policy hold** (`PAUSED` via `POLICY`): `set-stock-policy` held the channel, a market (`*` = every market) or one account.
4. **Listing hold** (`PAUSED` via `LISTING`): nothing is sent; the channel keeps selling its last number.
5. **Pinned** (`PINNED`): a fixed number.
6. **Follow** (`FOLLOW`): available units in the warehouses that feed this channel and market (only the listing's own locations, when it is limited to some), minus the listing's buffer, never below 0. No warehouse feeds it → `UNCOUNTED`: nothing is sent.

Where the units come from:
- **Stock source.** Own stock = this business's warehouse locations only; Amazon FBA and Shopify location rows never feed a listing. Shared stock = another business lends its warehouses for the product with the same SKU: those warehouses feed every channel and market, and this business's own warehouses and feeds are ignored. The lender counts it; its sales and counts move these listings within seconds. A product switched back to own stock with no own warehouse feeding a market follows **0** there (not uncounted).
- **Feeds.** A warehouse's `syncRoutes` (stock-locations) say what it feeds: `CHANNEL:MARKET` (`EBAY:IT`), a channel (`SHOPIFY`) or a market (`DE`); an empty list feeds every channel and market. `servesMarketplaces` does not decide what a listing shows.
- **Available** = on hand − reserved: order holds and `reserve-stock` lower it at once.
- **When it moves.** Every stock movement recomputes the following listings and queues them (about 30 s after a manual change, at once for an order). A pinned or held listing is not re-sent.
- **At send** (Amazon, eBay, Shopify) the number is capped at the feeding warehouses' available less the buffer.
- **Amazon EU.** Markets marked `sharesEuQuantity` in business-overview share ONE merchant quantity per SKU and account: the `AMAZON:EU` coordinate in listing-matrix. If those markets disagree (one follows while another is pinned, or two pins differ) Nexus refuses the push.
- **Aliases.** A second eBay item of the same product (key `EBAY:IT#<aliasId>`) has its own quantity and follows the same stock: each offers the full number.
- **Shared eBay variants.** One variant SKU inside several eBay items, with its own follow, fixed number, buffer, or excluded.
- **Shopify** takes the number at one Shopify location: the one chosen for the listing (Review Shopify synchronisation › Inventory location). With none chosen, an imported (linked) listing uses the shop's only active location, and the push is refused when the shop has several.

Example (invented numbers): warehouse A feeds everything, 12 on hand, 2 reserved → 10; warehouse B feeds `EBAY:IT`, 4 available; an FBA location holds 30.

| Listing | Rule | Shows |
|---|---|---|
| eBay IT, buffer 2 | Follow A + B | 10 + 4 − 2 = 12 |
| Amazon IT, DE, FR (FBM), buffer 1 | Follow A | one EU quantity: 10 − 1 = 9 |
| Shopify, pinned 20 | Pinned | sent capped at A: 10 |
| Amazon UK, FBA | FBA | Amazon's number; nothing sent |

A sale of 3 reserved at A → eBay IT 9 and Amazon EU 6, both re-sent; the Shopify pin is not re-sent and shows as oversold.

## 2. Read first

- `listing-matrix` (`productId`, `channel`, `market`): per row (`rowId`) and coordinate key, `sync` (`kind`, `via`, `mode`, `intended` = what Nexus would send, `held` = what the channel has, `buffer`, `poolAvailable`, `oversold`), `queue` (last push and its failure), `writable` and `blocked` (what may change there and why not), and the row's `stock.sharedFrom`. It shows ONE account per channel and market (the family's, else the primary one); `listing-coordinates` lists every account's listings with `listingId` and `accountId`.
- `channel-price-stock` (`channel`, `market`, `sku`, paged): many listings at once, with `listingId`, `quantity.listed`, `intended` and `mode`.
- `stock-levels` (`productId`): per location quantity, reserved and available, `stockSource` (own or pool) and the reservations. Its `channels[].wouldSend` is a location estimate that ignores pins, holds, policies and feeds: what Nexus sends is listing-matrix `intended`.
- `stock-locations`: each location's owner (nexus, amazon-fba, shopify), `syncRoutes`, totals, and the channel policies (`syncPolicies`).
- `shared-stock` (`sku`): what this business lends and borrows, per product `sellsFrom` own or pool with the pool's numbers, and the `oversold` listings.
- `channel-stock-drift` (`productId`): open differences between what a channel reported and Nexus's number (channel, SKU, both numbers; no market).

## 3. Changes

| To | Tool and arguments | Effect |
|---|---|---|
| A chosen fixed number | `set-listing-stock` `action: "pin-quantity"`, `quantity`, `targets` [{`rowId`, `coordinateKey`}] | queued; stays when stock falls |
| Keep the number it shows now | `bulk-listing-stock` `action: "PIN"` | fixed from now on |
| Follow the stock again | `set-listing-stock` `set-follow` · `bulk-listing-stock` `FOLLOW` | recomputed and queued |
| Hold units back | `set-listing-stock` `set-buffer` + `buffer` · `bulk-listing-stock` `BUFFER` + `buffer` | recomputed and queued |
| Stop selling at 0 now | `bulk-listing-stock` `ZERO_PIN` | fixed 0, sent at once |
| Hold the stock sync | `set-listing-stock` `pause-sync` · `bulk-listing-stock` `PAUSE` | nothing sent; it also keeps price and sale changes in Nexus until release |
| Release it | `resume-sync` · `RESUME` | recomputed and sent at once, held prices too |
| Send again now | `set-listing-stock` `push-now` | queued at once; refused while held or uncounted |
| Retry a failed push | `set-listing-stock` `retry-sync` | the cell's newest failed quantity or price push is sent again; refused where none failed; what reaches the channel cannot be called back |
| Switch Amazon fulfilment (FBA, FBM) | `set-listing-stock` `set-fulfilment` + `method`, on `AMAZON:` cells (EU: `AMAZON:EU`) | Amazon is sent nothing (the offer itself is converted in Seller Central); from then on Nexus sends no quantity (FBA) or the stock (FBM); FBA → FBM refused while FBA units, an active FBA offer or an Amazon FBA code remain |
| A channel, market or account | `set-stock-policy` `channel`, `marketplace` (`*` = every market), `accountId` (left out = every account), `pushesPaused`, `newListingDefaultMode` (FOLLOW or PAUSED) | holds or releases every listing there; how new listings start |
| What a warehouse feeds | `set-stock-policy` `locationCode`, `feeds` (`[]` = every channel and market) | every product stocked there recomputed and queued |
| Own stock ↔ shared stock | `set-stock-source` `productIds` (≤50; a parent brings its variations unless `withVariations: false`), `to` own or pool, `lender` (as shared-stock names it) | preview per listing `showsNow` → `willShow`; joining shared stock turns fixed numbers to follow (a fixed 0 stays); all or none; only an owner can approve |
| Shared eBay variants | `bulk-listing-stock` with `productIds`, `only: "shared"`: EXCLUDE, INCLUDE, PIN (+ `quantity`), FOLLOW, BUFFER | the eBay items' totals change |

- `until` (bulk-listing-stock PIN, ZERO_PIN, PAUSE, EXCLUDE): ISO date and time, 1 minute to 1 year ahead; then it follows, resumes or is included again by itself.
- **Which tool.** `set-listing-stock`: one family per call, cells read in listing-matrix (so only the account it shows), up to 250 targets; the only way to pin a chosen number on a listing, push now, retry a failed push or switch fulfilment; undo with `revert-listing-change` within 24 hours, once. `bulk-listing-stock`: many families or any account (`listingIds` ≤250 from listing-coordinates or channel-price-stock, or `productIds` ≤50 narrowed by `channel` and `marketplace`), end times, shared eBay variants; at most 250 rows after the Amazon EU expansion; its undo cannot type back a fixed number it replaced (set that again with set-listing-stock). `set-stock-policy`: a whole channel, market or account, or a warehouse's feeds. `set-stock-source`: where a product's units come from.
- **Amazon EU.** A quantity change (pin, follow, buffer, zero) on any EU market covers every open EU market of that SKU and account (one EU line in the preview); a closed market is never reopened. A `set-listing-stock` hold on an EU market holds every EU market. To stop selling in one EU market only, use `close-listing` (Pause offer), never a quantity.

## 4. Traps

| Trap | Do |
|---|---|
| A hold on one Amazon EU market (`bulk-listing-stock` PAUSE, a policy on one EU market) does not freeze the one EU quantity: an EU market that still follows keeps sending it | Hold every EU market: `set-listing-stock` `pause-sync` on `AMAZON:EU`, or PAUSE / policies for each EU market |
| Different feeds for Amazon EU markets (`AMAZON:DE` vs `AMAZON:IT`) give one shared quantity two follow numbers | Feed every EU market alike |
| A pinned listing is not re-sent when stock falls, so it can oversell | Check `sync.oversold` and shared-stock `oversold`; offer `set-follow`, or `push-now` (sent capped at stock) |
| A hold does not stop selling: the channel sells its last number | To stop: `ZERO_PIN` or `close-listing` |
| `set-listing-stock` `pin-quantity` on a SKU that sells from shared stock: the preview passes, the run refuses | Read `blocked.syncQty` first; change the stock in the lending business, or switch to own stock first |
| `set-listing-stock` `set-buffer` on a pinned listing: the preview says "Stored — applies when this listing follows", the run refuses | `set-follow` first (its own request), then the buffer |
| eBay pin to 0 or ZERO_PIN is refused while the account's out-of-stock option is OFF (eBay would end the item); Nexus only reads that option | A person turns it on in eBay, or hold the stock sync instead. A listing that follows stock down to 0, or a switch to own stock with none, is not checked |
| FBA listings are refused or left out | Never ask; Amazon owns that number |
| An Inactive listing takes no quantity (refused or left out) | `reopen-listing` first |
| A policy hold cannot be released per listing | `set-stock-policy` `pushesPaused: false` |
| An account listing-matrix does not show | `bulk-listing-stock` with `listingIds` from listing-coordinates |

No Claude tool; a person does it in Nexus or on the channel:

| Action | Where |
|---|---|
| eBay fulfilment (MCF) | Product studio › Matrix tab › Stock › Set fulfilment… (`set-fulfilment` takes Amazon cells only) |
| Convert an Amazon offer between FBA and FBM | Seller Central |
| Apply or ignore channel drift | Stock › Channel drift |
| Find or switch Shopify locations; a product's Shopify stock location | Stock › Shopify Locations; the product's Review Shopify synchronisation › Inventory location |
| eBay out-of-stock option | eBay's own account settings |
| Offer, accept, pause or end shared stock | Settings › Shared products (an owner) |

## 5. Finish

- Several changes → ONE change plan (`change-plan` skill): one `set-listing-stock` step per family, or one bulk step.
- Before asking, show a table per listing and market: channel · market · account · from → to (mode and number, as `intended` now → after), the EU markets an Amazon line covers, anything left out and why.
- After approval-status says it ran, read `listing-matrix` again and report `intended` and `queue` per listing.
