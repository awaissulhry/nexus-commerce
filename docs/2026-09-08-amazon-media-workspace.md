# Amazon Media workspace — 8 September 2026

The Amazon Images tab now uses the Nexus Media controls with market-specific common images, SKU overrides, dynamic variation grouping, explicit image-language review, and a reviewed publication workflow.

The subsequent [PS and bulk assignment expansion](2026-09-08-amazon-ps-bulk-images.md) adds market-specific PS01–PS06 drafts, a Seller Central ZIP handoff, selective cross-market copying and a reviewed bulk editor with undo. PS images remain outside API publication.

## Editing contract

- Every read and write is bound to the product, connected seller account, marketplace and selected listing alias. The page uses the Studio destination; it never chooses an arbitrary alias.
- Each market has its own common slot map. A missing SKU override inherits that market's common image; `null` explicitly clears the SKU slot. Other markets never inherit these assignments.
- Amazon gallery roles are MAIN, PT01–PT08 and SWCH. Product type requirements fetched with the selected seller and market restrict what can actually be submitted. Safety images and other Seller Central media are not silently treated as writable gallery slots or deleted.
- Existing listing image locators can seed the draft. **Check Amazon** reads the seller contribution, issues, actual product type and variation relationships, plus catalog images separately. **Use Amazon contribution** copies those observed URLs into the selected SKU draft for review.
- Grouping uses the attribute names in Amazon's variation relationships, including compound product-specific sizes. Local listing metadata provides the initial context. Unknown values remain unavailable; neither product titles nor filenames are used to guess a variation.
- Raw variation values retain their source spelling. UI control labels remain English. Changing the grouping never changes SKU assignments.
- Each assigned image is marked as language-neutral, a supported market language, or requiring review. This is an operator confirmation, **not OCR or a certification of image content**.
- Copying from another market names the source listing and gallery explicitly. It replaces only the chosen destination gallery and saves its draft. Language-neutral images retain that label; every localized image returns to language review. Source images are deduplicated by URL without losing assignments.
- Library uploads and gallery saves are separate operations. Concurrent changes discovered during an upload block saving the old gallery against the new revision. Unsaved edits are protected during navigation.

## Publication and evidence

1. Select the exact SKUs in **Review & publish**. Parent listings are available explicitly and are not selected by default.
2. The server records a durable review job. It resolves account credentials, confirms seller SKU/ASIN identity in the selected market, reads current images, loads current product type requirements, and runs Amazon `VALIDATION_PREVIEW` on the exact proposed PATCH operations.
3. The review shows additions, replacements and removals per SKU. Missing mains, unreviewed languages, unavailable sources, unsupported slots, failed validation, duplicate seller SKUs and conflicting galleries for a shared ASIN block approval.
4. **Publish reviewed changes** approves that saved snapshot. Reviews expire after 15 minutes. Serializable saves, revisions and an atomic listing lock prevent double approval and overlapping image submissions.
5. The worker rechecks local context and Amazon's current images before each effect. If Amazon changed since review, the SKU is not submitted and remaining SKUs stop. Only managed image attributes are patched; price, stock, descriptions and relationships are untouched.
6. Each SKU is recorded as `SENDING` before its PATCH. Returned acceptance is `ACCEPTED`, rejection is `REJECTED`; a dropped response is `UNKNOWN`. A stopped worker never replays an ambiguous PATCH. Later SKUs stay `NOT_SENT` after a failure.
7. Periodic read-back runs for the latest submission for 24 hours, including after the browser closes. The same listing is eligible again after two minutes; actual timing depends on queue size and Amazon availability. **Check Amazon** can also be run explicitly. The worker keeps business-profile context as well as seller/market context. Failed reads preserve uncertainty; they never become empty successful galleries.

`COMPLETE` means the worker finished producing receipts. It does **not** mean images are live. Seller-contribution URL matching and Amazon catalog URL matching have separate labels and timestamps. Amazon-hosted rendition URLs can be compared by image identity; an external upload transformed to an Amazon URL remains unverified rather than receiving a guessed success verdict. The actual catalog images and asynchronous listing issues remain inspectable in the page. Amazon may choose other contributions or change presentation; immediate storefront parity is not promised.

Older image-feed entry points refuse a family/market once it has a new Media draft. This prevents those publishers from sending legacy assignments in place of the reviewed gallery. Other listing workflows and external Amazon edits can still change catalog data; the publication preflight and read-back expose those changes.

## Persistence and deployment

- `ChannelListing.platformAttributes._amazonMediaWorkspace`: versioned draft plus the source snapshots it uses.
- `_amazonMediaObservations`: per-SKU, timestamped evidence. An unchanged check timestamp does not invalidate an otherwise identical review.
- `_amazonMediaActiveRun`: most recent approved submission, recovered on page reload.
- New `AmazonMediaRun` table: immutable reviewed plans, actor, exact destination and durable per-SKU receipts. It is deliberately separate from legacy feed jobs that conflate feed completion with publication.
- Base migration: `packages/database/prisma/migrations/20260908_amazon_media_workspace/migration.sql`. The concurrent `20260908b_workspace_data_isolation` migration already includes this table's workspace ownership, index and RLS policy. Deploy these repository migrations in their normal order and regenerate the Prisma client before enabling the new publisher. No database migrations or live Amazon image submissions were executed during this task.

## Verification

- 1,698 Studio/DS editor regression tests passed, with 13 existing opt-in cases skipped. The eight Amazon transport cases also passed separately after the final transport edits.
- 49 API tests passed across the new Amazon client/workspace and the eBay workspace, with two opt-in browser cases skipped. Tests cover permissions, account/market/alias isolation, language review, copying, canonical sources, exact removals, stale revisions, remote drift, shared ASIN conflicts, single approval, accepted/rejected/unknown outcomes, stale-worker recovery and legacy publisher refusal.
- 15 shared Amazon model tests passed.
- Web, API and Factory type checks passed after concurrent unrelated type errors were resolved in the shared workspace.
- Both Web and Factory token guards passed. Generated tokens were in sync. Fourteen DS stylesheets passed the CSS parser check; every token referenced by the feature stylesheet resolves.
- Browser QA used an isolated in-memory API fixture, not a production database or Amazon seller. It verified grouping, explicit clearing and saving, cross-market copying with language reset, preflight blocking, source-picker capacity, desktop light/dark presentation, a real 390-pixel iframe and modal keyboard dismissal/focus restoration.
- At 390 pixels: document width 390; Media width and scroll width both 324. Standard control heights were preserved: toolbar 28 px, text buttons about 30 px, icon/text buttons 32 px. No shared control geometry was overridden.

Visual evidence is under `output/amazon-media/`. The fixture uses synthetic images served locally; their HTTP URLs deliberately fail the real publication URL check. Automated service tests use HTTPS URLs and a mocked Amazon transport to exercise the accepted and interrupted submission paths without a live effect.

## Amazon sources checked

- [Submit media attributes](https://developer-docs.amazon/sp-api/lang-en_US/docs/submit-media): supported image variants, product type/market requirements and media accessibility.
- [Listings management workflows](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/building-listings-management-workflows-guide): validation preview, partial updates, asynchronous processing and issue handling.
- [Official Listings Items API model](https://github.com/amzn/selling-partner-api-models/blob/main/models/listings-items-api-model/listingsItems_2021-08-01.json): variation-theme attribute names, market-scoped relationships, request and response contracts.
