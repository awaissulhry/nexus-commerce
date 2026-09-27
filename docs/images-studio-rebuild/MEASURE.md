# P0 — measurement (production, read only)

Run 2026-09-27 with `BEGIN READ ONLY` and a positive control (an `UPDATE … WHERE false` failed with 25006 before
any read). Counts only; no ids. Script: session scratchpad `p0-measure.mjs` (same pattern as
`docs/product-cheat/tools/*.mjs`). A local dry run of the same script passed first.

## Summary
- **The catalogue is small.** Xavia Racing: 32 families, 301 variants. Motovento: 1 family (20 variants) + 1 single.
- **The real photo curation today is the previous edit page's eBay builder:** 697 `ListingImage` rows on 31 Xavia
  families (547 of them per axis value). Everything the newer studio stores hold is tiny: 4 eBay
  `_mediaGalleryDraft`, 0 `_productMediaLocales`, 0 master `_productMedia`, 0 `_amazonMediaWorkspace`,
  0 `_nexusContent`. → The migration (P6) is mainly "previous eBay builder → new plan", plus 327 eBay `imageUrls`.
- **Per-language photo sets are not used anywhere** (0 locales). No library file name carries a language code.
  Language versions (§4.8) start from zero — nothing to convert.
- **Aliases:** 4 active, all eBay IT (84 family listing rows). 18 old shell products are still live, 4 are deleted.
- **Markets:** eBay IT only (332 listings, 1 active account). Amazon IT 273 · DE 214 · FR 115 · ES 123 listings
  (1 account). No eBay listing is in two markets, so no shared-SKU conflict today. Shopify (Xavia) and Etsy + eBay
  (Motovento) are connected but have no listings yet.
- **Library size:** Xavia families hold a median of 176 photos (max 320). The library panel must search, filter and
  virtualise from day one.
- **Data gaps to fix in P1:** 214 of Motovento's 238 photos have no `dhash256` (the near-duplicate check fails open
  for them), and 419 photos (377 + 42) have no width/height (size checks cannot judge them). Both need a backfill.
- **Old jobs:** 37 Amazon image feed jobs stuck `IN_PROGRESS` since June; 43 of 156 eBay image publish jobs `FATAL`
  (last July). `AmazonMediaRun`: 0. Scheduled image publish: 0.

## Numbers

| Business | Families | Singles | Variants | Live shells |
|---|---|---|---|---|
| Xavia Racing | 32 | 0 | 301 | 18 |
| Motovento | 1 | 1 | 20 | 0 |

| Business | Library photos | No dhash256 | No size | Language in file name |
|---|---|---|---|---|
| Xavia Racing | 1,975 | 0 | 377 | 0 |
| Motovento | 238 | 214 | 42 | 0 |

`ListingImage` (Xavia only): EBAY/PLATFORM 697 rows, 31 products, 547 by value, 0 by SKU · AMAZON/PLATFORM 45 and
AMAZON/MARKETPLACE 20, both on 1 product, all slotted.

Listing JSON keys (Xavia, eBay): `imageUrls` 327 · `_mediaGalleryDraft` 4 · `sellerSku` 4. Nothing else.

Listings: AMAZON IT 273, DE 214, FR 115, ES 123 (1 account) · EBAY IT 332 (1 account). Aliases: 4 ACTIVE on EBAY IT.

Connections: Xavia — Amazon 1, eBay 1 active (+12 inactive), Shopify 1 · Motovento — eBay 1, Etsy 1.

Jobs: ChannelImagePublishJob EBAY DONE 112, FATAL 43, SUBMITTING 1 (last 2026-07-28) · AmazonImageFeedJob DONE 6,
IN_PROGRESS 37 (last 2026-06-10) · AmazonMediaRun 0 · ScheduledImagePublish 0.

Not measured here: the timing of today's reads (needs the API; measured in P1 against a local API).
