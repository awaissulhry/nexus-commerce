---
name: identity-check
description: Check that the ids of a Nexus business agree - SKUs, barcodes (GTIN/EAN/UPC), brands, product families, and channel ids such as eBay Item IDs, ASINs and Shopify products - explain each kind of problem in plain words, and propose the fixes as one change plan a person approves. Reads only until the person asks for a fix. Use when the person asks about duplicate or wrong ids, a listing linked to the wrong item, broken product families, barcode errors, SKU mismatches, or "is my catalog consistent?".
---

# Identity check

Audit, explain, then propose. The audit reads what Nexus has saved; a live check asks the channel for one family at a time. A channel id belongs to one listing of one business: it is never moved to another business, and an ASIN is never typed by hand.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Audit

- `identity-audit` (optional `checks`, `severity`, `examples` up to 5): one line per check that found something — how many, examples, what it means, and the fix tool with `fix.available`. `clean` lists the checks that found nothing; `skipped` says why a check did not run.
- `identity-issues` (`checks`, `severity`, paged with `cursor`): every finding of a check.
- One product: `product-identity` (`productId`, `channel`, `market`) — every id of the family. One id: `find-by-id` (`query`, `kind`) — every place it is used, and whether another business holds the same eBay Item ID, Shopify product or Etsy listing.
- Live, for one family: `channel-identity-check` (`productId`, `channel`, `market`; up to 5 listings a call, limited per hour): held, ended, foreign (another seller lists it), unverifiable, or not readable, and SKUs missing on either side.

## 2. Explain

Group by check, worst first (`severity` error). For each: what it means for selling (a wrong link pushes stock to someone else's item; a broken family stops a publish; a bad barcode makes Amazon match the wrong catalogue item), how many, and two or three examples (SKU, channel, market).

## 3. Propose fixes (only when asked)

| Problem | Tool |
|---|---|
| Listing not linked, or linked to the wrong channel item | `link-channel-id` (eBay: the Item ID, checked live — Active, this account's seller, the family's SKUs; Amazon: leave `externalId` out, the ASIN is read from Amazon) / `unlink-channel-id` (the item stays live on the channel and can oversell: the preview names the quantity last advertised) |
| Product SKU wrong | `set-product-sku` (refused while the product is live on a channel: a channel's seller SKU is recorded, never renamed) |
| Extra listing's seller SKU | `set-listing-sku` |
| Barcode invalid, missing or on two products | `set-gtin` (`field`: gtin, ean or upc; empty `code` clears it) |
| Brand spelled several ways | `set-brand` (each product with its brand, up to 250) |
| Broken family: no parent, wrong parent, a variation alone | `fix-parent` (`action`: attach, move, detach, promote, lift-extra-listings) |
| Duplicate product or an old eBay listing shell | `merge-duplicate-products` (safe cases only; the duplicate goes to the trash and can be restored) |

- Show each fix as from → to, and say what it touches on the channel (most of these change Nexus only; a link makes Nexus drive that item again, paused until a person resumes its pushes).
- Put the fixes in ONE `submit-change-plan`; brand fixes as one `set-brand` step.
- A finding with no fix tool (`fix.available` false): say what a person does in Nexus.
- After the fixes ran, run `identity-audit` again with the same `checks` and report what is left.
