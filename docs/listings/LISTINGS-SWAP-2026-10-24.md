# Listings swap — the new Listings page takes the menu (24 October 2026)

Status: BUILT on branch `feat/listings-swap-new-page`, on the Owner's pick "A". Merge waits for "Merge #N".

## 1. What the Owner asked

"Replace the listings page that we have on the navigation. Make the current one legacy … I could be redirected
directly to the relative pages from any potential links … replace the current form with the new listings page."

## 2. What changed

| # | Change | Where |
|---|---|---|
| 1 | `/listings` shows the new page (the readiness page of #748), title **Listings**, in the Products page's frame. | `app/listings/page.tsx`, `app/listings/_readiness/*` (moved from `app/products/listing-readiness/`) |
| 2 | The old page is `/listings/legacy`, title **Listings (legacy)**, crumb "Listings › Legacy", with a note: "This is the old Listings page." + **Open Listings**. Same component and storage key, so saved columns and views stay. | `app/listings/legacy/page.tsx`, `ListingsWorkspace.tsx` (`legacy` prop) |
| 3 | Menu: **Legacy listings** is the last item under Listings. Amazon, eBay and Shopify are unchanged. | `_shared/app-nav.ts` |
| 4 | `/products/listing-readiness` → 308 → `/listings`, query kept, also inside a business (`/w/<id>/…`). | `next.config.js` |
| 5 | `/listings` with an option only the old page reads (`lens`, `listingStatus`, `search`, `syncStatus`, `hasError`, `lowStock`, `published`, `sortBy`, `sortDir`, `drawer`) → 307 → `/listings/legacy`, query kept. Not permanent, so a later new-page option of the same name is never shadowed by a cached 308. | `next.config.js` |
| 6 | New page header: **Back to products** is replaced by **Publish history** and **Legacy listings**. | `_readiness/ListingReadinessClient.tsx` |
| 7 | The old page opens one listing's drawer from `?drawer=<listingId>` and drops the option on close. The API calls log linked there before, but the old page never read it (the link was broken). | `ListingsWorkspace.tsx`, `sync-logs/api-calls/ApiCallsClient.tsx` |
| 8 | `/listings` is rail-less like `/products` (exact path only: its sub-pages keep the app rail). | `components/layout/AppShell.tsx` |
| 9 | A test from #748 used a made-up link `/x`, which `check-link-targets.mjs` refuses. It now uses `/products`. | `design-system/grid/toolbars/familyFooterFrame.vitest.test.ts` |

Found in the browser check: Escape closes the drawer through the page's own key handler, not the drawer's `onClose`,
so the address kept `drawer=…` and a reload opened it again. The option is now dropped by an effect whenever the open
drawer is not the one the address names (closed, or another listing opened).

## 3. Every link, and where it goes now

A link keeps the meaning it had. A link about a listing's live state (status, one listing, a SKU's listing rows)
goes to the page that shows it; a link about readiness goes to the new page.

| Where | Before | After |
|---|---|---|
| Home: failed-listings alert, "Resolve errors" | `/listings?listingStatus=ERROR` | `/listings/legacy?listingStatus=ERROR` |
| Home: draft-listings alert | `/listings?listingStatus=DRAFT` | `/listings/legacy?listingStatus=DRAFT` |
| Publish history: a SKU | `/listings?search=SKU` | `/listings/legacy?search=SKU` |
| ⌘K: a listing result | `/listings?search=SKU` | `/listings/legacy?search=SKU` |
| API calls log: "Listing …" | `/listings?drawer=ID` (raw link, drawer never opened) | `/listings/legacy?drawer=ID` (business-aware link, drawer opens) |
| Sync health grid: a healthy cell | `/listings?channel=…&marketplace=…` | Amazon / eBay: `/listings/<store>/<market>`; other stores: `/listings/legacy?channel=…&marketplace=…` |
| Products: "Listing readiness" button → **Listings**; "Check listing readiness…" | `/products/listing-readiness…` | `/listings…` |
| Studio progress cards, import review, the old page's 3 readiness links, the API's `reviewHref` | `/products/listing-readiness…` | `/listings…` |
| ⌘K "Go to All Listings" → **Go to Listings**, `g l`, Home, channel-page crumbs | `/listings` | `/listings` (now the new page) |

## 4. Checks

See the PR. Tests pin: the two pages and the moved folder, the 308, the ten 307s (derived from the options the old
page reads, so a new old-page option without a rule fails), that no rule takes a new-page option, the menu highlight,
the healthy-cell link, the studio link and the API's review link.
