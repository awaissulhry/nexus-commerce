---
name: list-product
description: List a product on Amazon, eBay or Shopify from Nexus, start to finish - create the product (or find it), start draft listings, fill the listing fields, text and photos, review the publish in the Nexus product studio, publish, and follow the publication until the channel accepts it. One reference file per channel (amazon.md, ebay.md, shopify.md - Etsy has no publisher yet) holds its markets, rules and refusals; product-page.md explains every status and action of the product page. Each stage is one request a person approves in Nexus. Use when the person wants to create a new product, put a product on a new channel or market, or publish or re-publish a listing.
---

# List a product

Nexus is where products are created and published from: the channel gets the listing through the Nexus product studio, never from a flat file. Each stage below is a separate request because the next one needs what the earlier one made (a product id, a draft listing, the text a publish should send). Inside a stage, group what is independent into one change plan.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 0. Before you start

- Read the channel's file in this skill's folder first: `amazon.md`, `ebay.md` or `shopify.md` (Etsy: at the end of `shopify.md` — no publisher yet). It names the markets, what must be set before a first publish, and the refusals you will meet.
- `business-overview`: the business's markets (the exact `code` tools take), its accounts per channel (the `id` for `accountId`) and how many listings each account holds per market.
- `product-page.md`: what each status and action of the product page means, and which ones only a person can do there (End, Delete, Relist, Full update).

## 1. The product

- Already in Nexus? `product-search` (name, SKU or brand), then `product-snapshot` (completeness; listings per channel and market).
- New: `create-product` with `sku`, `name`, `basePrice` (master currency) and what is known (`brand`, `productType`, `description`, `manufacturer`, weight and size, `categoryAttributes`, `variations` for a family). It sets no stock, no barcode and no listing. More variations later: `create-variations`.
- Wait until it ran (`approval-status`), then `product-search` for its id. Barcodes: `set-gtin`. Brand: `set-brand`.

## 2. Draft listings

- `listing-coordinates` (`productId`): every listing of the family (channel, market, account, alias, draft or published).
- `create-draft-listings` (`productId`, `channel`, `market`, `accountId` when the channel has several accounts): the parent and every variation, inert until a publish. Several markets: one plan, one step per market.

## 3. Fields, text, photos, price and stock

- Required values: `listing-issues` (`productId`) and `content-gaps`.
- Listing fields: `product-content` with a `coordinate` lists each field's key and allowed values; `set-listing-fields` sets them. Its preview has a `warning` when a value is likely to be refused by the channel at the next publish — fix it before you publish.
- Text: the `listing-content` skill. Photos: `media-plan`, `add-photo-from-url`, `arrange-photos`.
- A FIRST publish creates the listing with its price, quantity and (Amazon) fulfilment from what Nexus holds: set them first — `set-listing-price`, and for stock the `listing-stock` skill. A re-publish never sends stock, price or fulfilment.
- Put the stage's changes in ONE plan; publish only after it ran.

## 4. Review, then publish

1. `publish-review` (`productId`, `channel`, `market`, `accountId` / `listingId` when needed): what would be sent, how it compares with the channel (`SEND`, `DIFFERS`, `CANNOT_COMPARE`, `SAME`), and the blocking issues. Fix the blockers first (back to step 3).
2. `publish-listing` (`productId`, `channel`, `marketplace` — not `market`, `accountId` / `listingId`, `fields`; Shopify also `location`): `fields: "all"` for a first publish; for a live listing only the groups that changed (`title`, `description`, `bullets`, `keywords`, `photos`, `attributes`).
   - Its preview says it in words: `summary`, `creates` (each new listing and whether it starts active or inactive), `held` (rows left out and why), and a `warning` for Amazon's one EU quantity. Show these to the person before you ask.
   - Several markets or channels: one plan, one `publish-listing` step each.
   - If the review changed between the approval and the run, nothing is sent: review again and ask again.

## 5. Follow the publication

`approval-status` names the `publication`; `publication-status` (`publicationId`) reads it. A pending Amazon or eBay publication is checked again by Nexus every 2 minutes, or when someone opens its result in the product studio; a Shopify result is final at once, or UNVERIFIED for a person to check (`shopify.md`). Then `listing-issues` for anything the channel reported.

To take a listing down for a while: `close-listing` (reversible; `reopen-listing` opens it again). End, Delete and Relist are a person's actions on the product page (`product-page.md`).
