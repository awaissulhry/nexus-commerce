# Shopify and Etsy product information audit

Date: 2026-09-08. Scope: current product catalog, Product Edit Studio information sheets, mapping/validation, readiness summaries and product/catalog import/export.

The core editing paths now support Shopify and Etsy consistently. This is a local implementation and regression review, **not live-channel or WCAG AAA certification**. No merchant product, account, connection or remote listing was changed during this audit.

## Findings and fixes

| Finding | Result |
| --- | --- |
| Etsy was omitted from the current catalog’s channel filter. | Etsy is selectable alongside the other channels. |
| Scope navigation excluded GLOBAL, the configured store-wide market. | GLOBAL remains a valid store destination, including a workspace with only a store configured. Existing country-market defaults remain intact. |
| Store information sheets had no native product field adapters. | Added a common contract for 10 Shopify and 23 Etsy core fields, with channel-specific labels, types, choices, constraints and storage addresses. |
| A store cell could route to shared product storage. | Store edits explicitly target the selected channel listing, account and alias. SKU and relationship permissions remain enforced. |
| The attribute writer read listing-column values but could save them into an override bag. | It uses the declared listing store for reads, writes and no-op detection, including follow flags, reset behavior and version conflict checks. |
| Shopify’s custom product type could collide with the shared/Amazon product type. | Shopify uses a distinct sheet key and its native `platformAttributes.productType` storage address. |
| Category resolution understood only Amazon/eBay. | Shopify category IDs and numeric Etsy taxonomy IDs use their own fields. Explicit empty store categories remain distinct from inherited categories. |
| Mapping and readiness lacked store definitions. | They consume the same store field contracts and constraints. Stores do not need an Amazon product type to load their fields. Readiness reads each channel’s own marketplace, including GLOBAL when the shared sheet is in a country market. The UI describes the limits of core checks. |
| Store requirements could be labelled Amazon and offer an irrelevant schema refresh. | Shopify/Etsy show their own requirements text and scope, with an explicit distinction between saving information and channel acceptance. |
| Transfer discovery, file parsing, export and source mapping assumed two channels and country markets. | All four channels and GLOBAL are supported throughout those paths. Account/alias/version boundaries remain enforced. |
| Transfer category fields defaulted to eBay’s categoryId. | Each channel uses its own category field; draft store exports and numeric Etsy category values round-trip. Explicit clears and inheritance survive export/import. |
| Store workbook setup required a cached Amazon/eBay-style category. | Core draft workbooks can be prepared without a category. Store-specific category IDs remain authorable and are validated during import review. GLOBAL uses the configured content language. |
| The selected channel disappeared outside the mobile chip viewport. | ScopeBar reveals the active chip on navigation, label updates and resize, scrolling only its own track. The component, readiness vocabulary and base styles are now mirrored into Factory. |

Existing Nexus controls were reused. Shared ScopeBar behavior is documented in both design-system catalogs and changelogs, and the resolved gap is recorded in `.claude/DS-GAPS.md`.

## Field ownership

- Shopify title and description use ChannelListing columns and their follow-master flags. Vendor, custom product type, taxonomy category, URL handle, tags, theme template and SEO fields use their declared platform attribute paths.
- Etsy title, description, price and quantity use their declared listing columns. Classification, tags, materials, dimensions, shipping and policy settings use platform attributes. Numeric IDs, current maker/date choices, title restrictions and tag limits are validated from the same definitions used by the sheet and mapping catalogue.
- Attribute imports continue to defer pricing, inventory and publication to their existing dedicated workflows. Store support does not bypass their transactional ownership.

## Verification

| Check | Result |
| --- | --- |
| API regression run: save route, field contracts, mapping, readiness, provenance and transfers | 243 passed; 3 opt-in browser/benchmark tests skipped |
| Final category/mapping/transfer refinements | 68 passed; overlaps the main run |
| Final sheet/export spot checks | 13 passed |
| Final store readiness coordinate checks | 4 passed; overlaps the main run |
| Web scope, navigation, write-contract and workbook selection tests | 76 passed |
| API, Web and Factory TypeScript checks | Passed |
| Web and Factory generated token checks | Passed |
| DS stylesheet parsing | 14 stylesheets passed |
| Shared ScopeBar and readiness source mirror | Identical in Web and Factory |
| Browser: channel isolation, Enter save, Escape cancel, maker selection | Passed in isolated fixture; captured payloads include channel, GLOBAL, account, alias and expected version |
| Browser: requirements dialog and Escape focus return | Passed for Shopify and Etsy |
| Browser: desktop, 768px tablet and 390px mobile, light/dark | Inspected; no document horizontal overflow; selected mobile scope remains visible; grid scroll stays local |
| Broad legacy/AG grid parity guard | Failed: 592 differences across 6,727 judged properties in existing grid specimens |

The broad parity differences include wrapper scrolling/geometry and row hover/selection rendering. Those grid implementations were not changed by this work. They remain a separate quality issue and prevent a claim that every platform grid is visually consistent. The exact specimen counts are in [the guard summary](checks/grid-parity-summary.txt).

Checks and captured payloads are stored under [checks](checks/) and [browser-writes.json](browser-writes.json). The browser fixture mounts the real UI with synthetic data and an in-memory endpoint; it does not prove database persistence or channel acceptance. API route tests separately cover storage, account targeting, no-ops, resets and stale-version conflicts.

## Evidence

- [Shopify desktop, light](shopify-desktop-light.png)
- [Etsy desktop, light](etsy-desktop-light.png)
- [Shopify tablet, dark](shopify-tablet-dark.png)
- [Etsy mobile, light](etsy-mobile-light.png)
- [Etsy mobile, dark](etsy-mobile-dark.png)
- [Reproduce the browser rehearsal](browser-fixture/README.md)

## Limits requiring further verification

No active Shopify or Etsy connection was present in the local workspace. Remote readback, real account-specific definitions and publishing were therefore not exercised. The adapters describe **core product fields**; Shopify metafields, Etsy category-specific properties and all conditional publication requirements are not a complete live schema here. The requirements dialog, mapping catalogue and transfer review state this explicitly.

A final channel acceptance review needs connected test stores and representative listings, including variants, category-specific attributes, shipping profiles/policies and store-defined metafields. The legacy product lenses are outside this current Studio audit. Existing outgoing sync/publishing adapters were not changed or certified by these editor fixes.

## Official definitions consulted

Field definitions were checked against primary documentation available on the audit date:

- [Shopify ProductUpdateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductUpdateInput)
- [Shopify product tags](https://help.shopify.com/en/manual/products/details/tags)
- [Etsy Open API reference](https://developers.etsy.com/documentation/reference/) and [published OpenAPI schema](https://www.etsy.com/openapi/generated/oas/3.0.0.json)
- [Etsy listing creation guidance](https://help.etsy.com/hc/en-gb/articles/115015628707-How-to-Create-a-Listing)
- [Etsy tag guidance](https://help.etsy.com/hc/en-gb/articles/360000336307-How-to-Use-Tags-to-Get-Found-in-Search)

The core adapter version records the review date. Etsy’s current date-era enum is taken from its published schema rather than retaining a stale year value. Platform limits and category definitions still need periodic review.

## Follow-up: edit sub-sidebar — 8 September 2026

The product navigation sub-sidebar still filtered its channel groups to Amazon and eBay, even after Shopify and Etsy were available in the scope selector. `StudioSubheader` now includes Shopify and Etsy, each with a Listing information link, when present in the workspace's available channel options. Existing destination-aware URLs select GLOBAL and clear the previous channel's account/listing context. Verified both entries and navigation in the isolated editor; 37 navigation/scope tests and Web typecheck passed.
