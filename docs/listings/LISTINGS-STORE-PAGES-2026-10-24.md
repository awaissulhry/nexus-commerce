# Listings store pages — the new format for each store and market (2026-10-24)

The Owner, after the Listings swap (#750, `LISTINGS-SWAP-2026-10-24.md`): the channel- and market-specific pages under
Listings in the menu must follow the same format as the main Listings page. Three read-only studies (the old store
pages and their links; the new page's scope; the readiness API per store), then an exact preview. He picked **B**: the
plan plus a warning on the new Amazon pages when Amazon has suppressed listings.

## What changed

| Address | Before | After |
|---|---|---|
| `/listings/amazon` | old Amazon page (market tabs, Italy first) | the Listings page, every Amazon market |
| `/listings/amazon/<market>` | old Amazon page, one market | the Listings page, that Amazon market |
| `/listings/ebay`, `/listings/ebay/<market>` | old eBay page | the Listings page for eBay / that eBay market, plus an **eBay tools** menu (Markdowns, Promoted campaigns, Gap analysis) |
| `/listings/shopify` | old Shopify page | the Listings page for Shopify |
| `/listings/legacy/amazon[/<market>]`, `/listings/legacy/ebay[/<market>]`, `/listings/legacy/shopify` | — | the old store pages, unchanged files and storage keys, with the note "This is the old … listings page." and **Open Listings** |

- **One component, a lock.** `_readiness/readinessScope.ts` turns a path into a lock (`{ channel, marketplace }`);
  `readinessQuery.ts` puts it back on every change (`withLock`: an older link, a filter, Clear, a saved view, a view that
  answers late). The address never repeats what the path says; family links (`?parent=`) stay on the store path; the Fix
  window and Translate send the store and market. The Filters panel does not offer Channel (and Market on a market page
  and on Shopify, which has one market).
- **Header.** Crumbs `Listings › Amazon`, title `Amazon Italy`; "N listings · checked …" on a market page, "N listings on
  M markets" elsewhere. M now counts store + market once (an account or an alias is not a market of its own), so the main
  page's number can go down.
- **Amazon suppressions (B).** Readiness cannot see what Amazon suppressed. The new Amazon pages read the old Amazon
  page's own list (`GET /api/listings/amazon/overview` → `activeSuppressions`, Amazon's defect report) and warn: "Amazon
  reports N suppressed listings …", with a link to the old Amazon page for that market (on `/listings/amazon`, one link
  per market). Listings are counted once however many defects they have; the answer is capped at 50 rows ("at least").
- **Frame.** `AppShell` gives every store page the Products frame's own rail (`readinessLockFromPath`); the other
  Listings pages (`legacy…`, `publish-status`, `generate`, `ebay/campaigns|gaps|markdowns`) keep the app rail.
- **Markets.** Two letters, any case; `gb` is the UK (the readiness index says `UK`); anything else is a 404.

## Links

| Where | Before | After |
|---|---|---|
| Home "suppressions" alert | `/listings/amazon?suppressed=true` (an option nothing read) | `/listings/legacy/amazon` (the suppression list) |
| Products grid, Coverage, Health SKU links; Approvals listing link (API `approval-target.ts`) | `/listings/<store>?search=SKU` (Amazon/eBay showed Italy only) | `/listings/legacy?channel=<STORE>&search=SKU` (every market) |
| Product drawer "Open listing" | `/listings/<store>` | `/listings/legacy?drawer=<listingId>` (that listing) |
| Home market table, sync health cell | `/listings/<store>?marketplace=…` / `/listings/<store>/<m>` | `/listings/legacy/<store>/<m>` (`legacyMarketHref`) |
| Menu, "See all markets", channel crumbs, variant gap panel, Home channel grid | `/listings/<store>[/<m>]` | unchanged: the new pages |

`next.config.js`: each store path with an option only the old page reads (`LEGACY_LISTINGS_OPTIONS`) 307 → the same
path under `/listings/legacy/`, query kept, also inside a business. Market sources are `:market([a-zA-Z]{2})`, so the
eBay tool pages are never caught.

## Facts from the study worth keeping

- A readiness "listing" is a product × destination, not a ChannelListing: a market page lists every product checked for
  that market, listed there or not. The menu badge and the "See all markets" numbers count ChannelListings.
- `marketplace` without `channel` mixes stores (Amazon IT + eBay IT); the store pages always send both.
- The readiness routes need `products.view`; the old store pages needed `listings.view`.
- Amazon's suppression list is Amazon's defect report (`AmazonSuppression`, unresolved rows), not a listing status.

## Checks

Typecheck web + api; `src/app/listings`, menu highlight, sync logs, Home, Products lenses/drawer, layout tests; the
API `approval-target` test; the guard scripts; curl of the redirects; a browser round on a private loopback stack (no
outbound network): every store page, family page, tile, filter, Clear, eBay tools by keyboard, the Amazon warning, the
legacy pages, a 404, light + dark, 390 px, console.
