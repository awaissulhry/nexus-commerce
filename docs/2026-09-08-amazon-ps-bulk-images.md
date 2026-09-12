# Amazon safety images and bulk assignment

The Amazon Images workspace now manages PS01–PS06 alongside the product gallery. Safety images have a separate view because their publication path differs from MAIN, PT01–PT08 and SWCH.

## Safety images

- Market, seller account and listing alias remain explicit. PS assignments use the same saved common-image → SKU-override model, including explicit clears and image-language confirmation.
- **Add images** accepts multiple library selections and assigns them in selection order to the empty slots named by the picker. It retains filled slots and marks each new assignment for language review.
- Cross-market copying lets the operator choose the product gallery, safety images or both. The unselected section is retained. Localized images require renewed language review; language-neutral assignments retain their confirmation.
- The API publisher still manages only Amazon's documented programmatic image variants. PS drafts are excluded from API PATCH generation, contribution matching and gallery verification. The publication review explicitly states this scope. Adopting an Amazon seller contribution retains PS assignments.
- **Export PS images** reads the exact saved revision and selected listing IDs, checks ASIN identity syntax, source availability, language confirmation and conflicting galleries for a shared ASIN, then produces a flat ZIP with `ASIN.PS01.jpg` through `ASIN.PS06.jpg` filenames.
- JPEG conversion preserves the source resolution and framing, applies orientation metadata and flattens transparency onto white. It does not certify text legibility, product suitability or Amazon acceptance. Multi-frame and unsupported image formats are refused.
- Identical sources are downloaded once; identical ASIN/slot assignments are deduplicated. A failed source or concurrent listing change blocks the whole archive. Downloads use the existing DNS-pinned public-source fetcher, which rejects private addresses and redirects and limits source bytes/time. Export adds bounded concurrency, a 100 MB archive input limit and a 10 MB per-JPEG limit.
- Export does not contact Amazon or create a publication receipt. The operator must upload the archive in the intended Seller Central account and market and check its processing result there. Empty slots are omitted: clearing a Nexus PS draft does not delete a previously uploaded Seller Central image. PS publication and storefront display remain explicitly unverified.
- Existing unscoped legacy `ListingImage` assignments are not silently imported into a seller account or alias. New PS drafts use the account-scoped workspace storage. No database schema change is required for these PS assignments.

## Bulk workflow

**Apply to SKUs** now selects individual slots and targets before reviewing an exact plan. The same pure function produces both the preview and the applied draft.

1. Choose a source gallery and operation: fill unassigned slots, replace selected slots, restore common inheritance, or explicitly clear selected slots.
2. Choose the image slots. Source images can be inspected at full size. A bulk language confirmation is optional and explicit.
3. Search by SKU or variation values; group by any available product variation attribute. Select individual SKUs, a complete group, or every matching SKU. Parent listings require an explicit choice. Selected SKUs outside the current filter are counted and disclosed.
4. Review per-SKU before/after assignments, including changes to inheritance. Unselected slots are retained, and missing source slots never clear a target implicitly. Filling preserves inherited photos and explicit clears.
5. Apply to the local draft, with **Undo bulk changes** available until another edit or save. Saving and publication/export remain distinct actions.

The searchable, grouped SKU selector is also used for API publication and PS export. Feature CSS controls layout only; shared Nexus control geometry is unchanged, and no shared design-system files required modification.

## Verification

- 25 shared model tests passed, including bulk preservation, inheritance, explicit clears, language changes, PS-only export and same-ASIN collisions.
- 38 Amazon API tests passed, with one opt-in browser fixture skipped. Export tests decode the generated archive and JPEG, verify exact filenames and dimensions, reject failed or non-image sources, and reject stale/foreign destinations. PS drafts persist and copy without entering API publication; unknown roles still block review.
- 349 image-workspace Web regression tests passed, including binary export transport, exact destination/revision payloads and rejection of login HTML or empty archives.
- Web type checking and the Nexus token guard/check passed. The final API type check is blocked by unrelated concurrent changes in `apps/api/src/services/amazon-market-offer.service.ts:168` and `:265` (`Promise<string>` assigned to `string`). Earlier workspace-authentication type errors were resolved by that concurrent work.
- Browser QA verified multi-image PS assignment and persistence, dynamic Color/Capacity grouping, retained selections outside a search filter, before/after review, applying and undoing bulk changes, preserved SKU mains, export blocking and keyboard dismissal with focus returning to the opener. Light/dark and 390-pixel layouts were inspected; the page remained 390 pixels wide and the modal width/scroll width both measured 350 pixels. Evidence is in `output/amazon-ps-bulk/`.
- Browser evidence uses the isolated fixture and synthetic images. No live Amazon changes or database migrations were performed.

## Sources

Amazon's current [Submit media attributes](https://developer-docs.amazon/sp-api/lang-en_US/docs/submit-media) documentation lists MAIN, PT01–PT08 and SWCH as the programmatic variants and explicitly distinguishes additional Seller Central variants.

Amazon staff's [safety-image guidance](https://sellercentral.amazon.com/seller-forums/discussions/t/60deb733-0c86-41d8-bc84-60cd8b2fb3ca) describes PS01–PS06 and the `ASIN.PS01.jpg` Image Manager convention. Its older reference to APIs is not treated as overriding the current Listings API documentation.
