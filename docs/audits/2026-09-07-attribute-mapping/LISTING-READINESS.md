# Listing preparation workflow — 7 September 2026

Implemented locally in `/products/listing-readiness`. The catalog remains the source of shared facts; workbooks and source imports are entry points. This review exposes work for each existing Amazon/eBay listing and leads into its exact product editor destination.

## Behavior

- Start from a family, up to 200 product IDs, up to 200 exact listing IDs, or up to 200 SKUs. SKU lists preserve leading zeroes and commas. Selecting a parent alone does not silently select its variants.
- Successful and partial imports link to the products actually saved by that job. Job ownership is checked before reading identities. Refused/excluded records are not represented as saved. A job with no successes remains an empty selection. A shared-product change is reviewed across that product's existing destinations.
- Filter by seller account and marketplace. Exact listing IDs preserve the selected account, market and alias. Missing/archived selections and products without matching drafts are visible.
- Pages contain at most 25 listings. Resolution groups share work per channel/account/market/alias; at most three groups run concurrently. Global product/listing totals and per-page check counts are explicitly different. Destination options load three small reference queries without category dictionaries. Workbook category-name lookup now uses a keyed map instead of repeatedly scanning every label.
- The existing `resolveBatch` supplies effective values, conditional requirements, field labels, schema version/date, invalid values and pending translations. No browser validator or second attribute-mapping engine was added.
- Missing accounts, inactive markets, missing schemas, empty evaluations, unresolved products and failed checks cannot become a passing result. One failing destination leaves other destination results visible. A direct product/listing version change during resolution invalidates the result.
- The UI distinguishes **Local checks passed**, **Needs attention**, and **Checks incomplete**. Saved listing status and last sync are supporting metadata, never proof of live availability. The checked time and schema date are visible. Changing inputs clears old results and cancels their request; refresh and pagination run new checks.
- Fix links retain the channel, marketplace, account and listing ID in the Studio URL. The new page composes Nexus design-system controls and uses semantic layout tokens; no shared design-system control changed in this pass.

## Corrected false publication path

The product grid's former bulk Publish action and the older Listings screen's publish/pause controls changed `ChannelListing.isPublished` without submitting or withdrawing a listing. They could report success without a corresponding marketplace operation.

Those controls now lead to listing review. `POST /api/listings/bulk-action` refuses legacy `publish` and `unpublish`, and `PATCH /api/listings/:id` refuses direct `isPublished` changes, with HTTP 409 `CHANNEL_WORKFLOW_REQUIRED`, before creating a job or writing a flag. External clients using these shortcuts must move to the channel workflows. Existing channel-specific publishers and their gates remain the submission paths.

No live products were edited, no source workbook was applied, and nothing was published or deployed by this pass.

## Validation

- API: **160 tests passed**, one optional browser-fixture server test skipped, across 13 relevant suites. Includes batching/account/alias isolation, incomplete checks, concurrent direct edits, SKU identity, owned import handoff, HTTP options and input validation, generic publication refusal, canonical resolver, workbook round trips and import review/apply regressions.
- Web: **31 tests passed** across workbook selection, import-preview columns, product-grid layout and scoped editor navigation suites.
- API and Web type checks passed. Web and Factory generated-token checks passed. Scoped whitespace/diff checks passed.
- Read-only browser check of the real Gale parent: five listings across Amazon DE/ES/FR/IT and eBay IT. Italy passed local attribute checks; the other four required attention. Germany explicitly reported missing bullet points and description. The fix link opened the correct Amazon Germany account/listing in Studio.
- Exact-listing selection returned one listing, not other marketplaces. Keyboard Escape returned focus to the account picker. Both light and dark mobile views were inspected at 390 × 844 without horizontal document overflow.
- The real Jackets family returned 219 products and 754 matching listings over 31 pages. Moving to page two cleared the old results while resolving the next 25 listings; global totals remained distinct from page counts.
- Changing the marketplace cleared the previous results before a new check. Country labels remain neutral when reviewing multiple channels, instead of borrowing a channel-prefixed marketplace name.
- Searching and selecting Italy returned the Gale parent's two Italian listings (Amazon and eBay); the family-level Italy endpoint returned 376 listings. The browser request used the lossless JSON SKU list.

## Practical limits

This is a current local attribute review against cached schemas, not a publication authorization token or a live-channel validation receipt. Pricing, stock, media, business policies, account credentials and the final channel payload still require their existing publishing checks. Publication must revalidate; results are not a transaction lock or a guarantee that dependencies cannot change afterward.

The page covers existing Amazon/eBay drafts and listings. A missing destination needs a draft first. Full-catalog background readiness materialization, issue-specific repair workbooks, and unified live submission/acceptance/availability tracking are not implemented by this change. The source workbook review and remaining production gates are documented in `MULTICHANNEL-WORKBOOKS.md`, `LIVE-VALIDATION.md` and `WORKFLOW-QUALITY.md`.
