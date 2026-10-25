# Listings — old eBay listing shells stay on their own eBay listing (2026-10-25)

The Owner, after the store pages went live (#751): the Amazon Italy Listings page showed the eBay aliases
(`AIREON-ALT1`, `xavia-knee-slider-ALT3`, `IT-MOSS-JACKET-ALT2`, … 16 products) with "No variation theme on Amazon · IT".
Aliases are for eBay only; they must not show there, and this must not happen again. Three read-only studies (root
cause, other places, how to keep it fixed), an exact preview, and he picked **A**.

## Why it happened

- The `-ALT` products are **old eBay listing shells**: products of their own (`productType` `EBAY_LISTING_SHELL`) that
  the old eBay flat-file import made for each extra eBay listing. Each holds one eBay IT listing of another product.
  The identity audit lists them as `unadopted-ebay-shell`. They are not PES.5 aliases (`ProductListingAlias`), which
  already stay on their own channel and market.
- The readiness index checks every live product on every destination of the business's footprint
  (`readinessChannelDestinations`). It never asked whether a product is a shell, so each shell got rows on Amazon,
  Shopify and every eBay market. The rows were there since #748; #751 made them visible on `/listings/amazon/it`.
- A shell row opened in the studio could also make an Amazon (or Shopify, Etsy) draft listing for the shell.

## The fix

| Where | What |
|---|---|
| `packages/shared/listing-readiness.ts` | One rule: `LISTING_SHELL_TYPE`, `isListingShell`, `readinessDestinationAllowed`. Shared: yes. A product that is not a shell: yes. A shell: only where it holds its own listing (same channel, market, and account when both name one; GB = UK). |
| `readiness-index.service.ts` `reconcileFamilyReadiness` | The rebuild skips the destinations the rule refuses (decided on the family root). |
| `readiness-index.service.ts` `reconcileReadinessFootprint` (each minute) | Also deletes the index rows the rule refuses (`removeShellRows`, reported as `shellRows`), like rows outside the footprint. The old rows go about a minute after the deploy; nothing is run by hand. |
| `draft-listing.service.ts` `productsToEnsure` | A shell gets no draft outside its own listing: "… is an old eBay listing shell. It lives only on its own eBay listing." This covers the studio save, Publish, `create-draft-listings`, bulk content changes and the catalog import. |
| `feed/feed-export.service.ts` | The Google Merchant and Meta feeds leave shells out. |

Unchanged: the shells and their eBay listings; they still show on eBay Italy (their own listing). Translate and the MCP
`content-gaps` tool read the same index, so they follow. Real aliases can still be made on any channel (the Amazon alias
option of 2026-10-05 stays). No new pre-push check (the Owner's "no new gates"; a guard would not have found this bug).

## Tests

- `packages/shared/listing-readiness.vitest.test.ts` — the rule, case by case.
- `apps/api/src/services/pim/readiness-own-channel.vitest.test.ts` — on the scope fixtures: a shell gets rows only on
  Shared and its own eBay listing; the Amazon Italy page lists no shell, eBay Italy does; a real alias stays on its own
  coordinate; a planted old row is deleted by the minute check, which then settles. With the fix switched off, 3 of
  its 4 tests fail.
- `draft-listing.service.vitest.test.ts` — a shell is refused on Amazon, alone, in a family save, and with an ordinary
  product (nothing written).

Later, the Owner's choice only: adopt the shells as real aliases (`merge-duplicate-products`, adopt-shell). That is a
data change; this fix does not need it.
