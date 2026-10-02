---
name: list-product
description: List a product on Amazon, eBay or Shopify from Nexus, start to finish - create the product (or find it), start draft listings, fill the listing fields, text and photos, review the publish in the Nexus product studio, publish, and follow the publication until the channel accepts it. Each stage is one request a person approves in Nexus. Use when the person wants to create a new product, put a product on a new channel or market, or publish or re-publish a listing.
---

# List a product

Nexus is where products are created and published from: the channel gets the listing through the Nexus product studio, never from a flat file. Each stage below is a separate request because the next one needs what the earlier one made (a product id, a draft listing, the text a publish should send). Inside a stage, group what is independent into one change plan.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. The product

- Already in Nexus? `product-search` (name, SKU or brand), then `product-snapshot` (completeness, listings per channel and market: `draft`, `linked`).
- New: `create-product` with `sku`, `name`, `basePrice` (master currency), and what is known: `brand`, `productType`, `description`, `manufacturer`, weight and size, `categoryAttributes`, and `variations` (each `sku` and its `attributes`) for a family. It sets no stock, no barcode and no listing. More variations later: `create-variations` (`axisValues`, `skuPattern`).
- Wait until it ran (`approval-status`), then `product-search` for its id.
- Barcodes: `set-gtin` (refused on a wrong check digit or a code another product carries). Brand: `set-brand`. Stock: `set-stock` at the business's own warehouses (see `stock-count`); never an FBA quantity.

## 2. Draft listings

- `listing-coordinates` (`productId`): every listing of the family (channel, market, account, alias, `draft`, `published`) and the business's accounts per channel.
- `create-draft-listings` (`productId`, `channel`, `market`, `accountId` when the channel has several accounts): the parent and every variation, inert (paused, unpublished) until a publish. Several markets: one plan with one step per market.

## 3. Fields, text and photos

- Required values: `listing-issues` (`productId`, readiness: `missing`) and `content-gaps`.
- Listing fields: `product-content` with a `coordinate` lists each field's key, allowed values and why one cannot be edited; set them with `set-listing-fields` (`values`, or `variants` to include or leave out variations, or `variationTheme` on Amazon).
- Text: follow the `listing-content` skill (`set-content`, `set-listing-content`).
- Photos: `media-plan` shows the family's photos and where they go; `add-photo-from-url` (https, public, JPEG/PNG/WebP/GIF up to 15 MB) and `arrange-photos` (families on the media plan only).
- Put the stage's changes in ONE plan; publish only after it ran.

## 4. Review, then publish

1. `publish-review` (`productId`, `channel`, `market`, `accountId` / `listingId` when needed): create or update, every field it would send and how it compares with the channel (`SEND`, `DIFFERS`, `CANNOT_COMPARE`, `SAME`), blocking issues (severity error) and the channel's live mode. Show the blockers in plain words and fix them first (back to step 3).
2. `publish-listing` (`productId`, `channel`, `marketplace`, `accountId` / `listingId`, `fields`; Shopify also `location`): `fields: "all"` for a draft's first publish; for a live listing only the groups that changed (`title`, `description`, `bullets`, `keywords`, `photos`, `attributes`). Stock, price and fulfilment never ride a publish.
   - Refused: Etsy (no publisher yet), an existing Shopify product, anything the review blocks, an FBA quantity, and an Amazon EU first publish whose quantity differs from the SKU's other live EU markets (Amazon keeps ONE EU quantity).
   - Several markets or channels: one plan, one `publish-listing` step each.
   - If the review changed between the approval and the run, nothing is sent: review again and ask again.

## 5. Price and stock per listing

- `listing-matrix` (`productId`): per row and coordinate key (`EBAY:IT`, `AMAZON:DE`, `AMAZON:EU` for the one EU quantity) the quantity, price, sale and what can be written there.
- `set-listing-price` (set, adjust by %, copy from another market in the same currency, sale) and `set-listing-stock` (pin a quantity, follow stock, buffer, pause or resume sync, push now) with `targets` from `listing-matrix`. FBA quantities are never written; an eBay pin to 0 needs the account's out-of-stock option ON.

## 6. Follow the publication

`approval-status` names the `publication`; `publication-status` (`publicationId`) reads it: SUBMITTED (an Amazon feed is processing), UNVERIFIED (eBay acknowledged it, live status not yet confirmed), PUBLISHING, ACCEPTED, VERIFIED, PARTIAL (some products rejected), FAILED. A pending one settles through the 5-minute settle sweep (when the server has it switched on) or when someone opens its result in the Nexus studio. Then `listing-issues` for anything the channel reported.

To take a listing down for a while: `close-listing` (reversible; `reopen-listing` opens it again). Nothing is ever ended or deleted from here.
