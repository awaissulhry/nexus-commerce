# Etsy channel sheet — new listings

The user creates new listings. Existing/deactivated Etsy listings are excluded from this work: no imports, product matches, SKU assignments, links, activations or listing updates were made. The exploratory old-listing files were removed after the scope correction.

## Implemented

Etsy continues to render the same `ChannelSheet`, grid, column preferences, source controls, list editors and mapping catalogue used by eBay and Amazon. Its category field now uses their shared `ChannelCategoryEditor` and Nexus `AsyncListboxPanel`. Category names are resolved separately from the sheet read; editing and storage retain the actual Etsy taxonomy ID. No shared design-system component or stylesheet was changed, so no Factory mirror was needed.

The previous 23-field Etsy contract is now a dedicated adapter covering all 50 `ShopListing` response fields and the union of all 29 create and 24 update parameters from the official OpenAPI snapshot. Aliases (`style`/`styles`, `listing_type`/`type`, `creation_timestamp`/`created_timestamp`, `last_modified_timestamp`/`updated_timestamp`) share a storage address. The resulting contract has **54 API attribute names, 53 field definitions and 55 new-listing grid columns**, including the structural SKU and numbered style slots. Product Media replaces the image-ID column in that count. Compound converted-money fields retain amount, divisor and currency instead of assuming cents.

Every selected seller-taxonomy category contributes its own complete property definition: stable property IDs, choices, required status, single/multiple values, maximum values, measurement scales and variation eligibility. Automatically selected and inventory-only properties remain visible with an explanation. Native/read-only Etsy fields cannot be manually edited or given automatic Master defaults; listing status is a separate lifecycle action. A missing or malformed category definition prevents a complete readiness result. Refreshing through the existing Requirements dialog populates the shared category cache and invalidates sheet caches only after a successful response.

Live verification retrieved **3,065 seller category nodes** without reading existing listings. Searches use the selected connection, return named category paths and allow retry. Large results are capped at 100 with a refinement hint. See [new-listing-coverage.json](new-listing-coverage.json).

## Mapping

The sheet, mapping catalogue, typed validation and local channel writes use the same contracts and storage addresses. These default mappings were verified:

| Etsy field | Nexus source | Channel value |
| --- | --- | --- |
| title | localized title, fallback name | listing title override/follow flag |
| description | description | listing description override/follow flag |
| price | basePrice | listing price override/follow flag |
| quantity | totalStock | listing quantity override/follow flag |
| tags | localized keywords | platformAttributes.tags; 13 × 20-character tags |
| materials | material | platformAttributes.materials; complete list preserved |
| styles | style | platformAttributes.styles; two numbered slots |
| item_weight / item_weight_unit | weightValue / weightUnit | platformAttributes item weight and unit |
| item_length / item_width / item_height | dimLength / dimWidth / dimHeight | platformAttributes item dimensions |
| item_dimensions_unit | dimUnit | platformAttributes.item_dimensions_unit |
| image_ids | Product Media workspace | shared gallery inheritance / listing._productMediaLocales; remote IDs remain separate |
| taxonomy_id | explicit Etsy category selection | platformAttributes.taxonomy_id |
| category color, material, style, unscaled size | matching Master fact, when the category declares that exact editable concept | platformAttributes.etsyProperties[property ID].value / .values |
| other category property | reviewed source or explicit value | platformAttributes.etsyProperties[property ID].value / .values |
| property scale | explicit Etsy scale | platformAttributes.etsyProperties[property ID].scale_id |

The connected catalogue confirms **13 shared-data defaults and 40 fields owned by listing settings, Product Media or channel-reported data**. See the complete [field crosswalk](mapping-crosswalk.md). Coverage of mapping ownership is not listing readiness: a mapped source can still be empty or invalid for Etsy. Category selection remains missing for the new-listing coordinate.

The Nexus-only audit inspected 338 products, including 301 children, and the existing custom attribute definitions. Material, Style, Color and Size definitions already exist. Physical measurements and keywords are currently empty. Variant colors include Italian values and combined legacy strings; those are not guessed into an Etsy choice. Exact category mappings preserve the original value and report mismatches against that category's options. Lists are never silently shortened, secondary color never inherits primary color, and a size with a measurement scale requires an explicit mapping. See [master-data-audit.json](master-data-audit.json).

Etsy physical/digital `type` must **not** inherit Nexus's internal product `type`. Maker, manufacturing era, category choices, shipping/policy identities and other property mappings need explicit authoring or reviewed mapping rules. Currency, Etsy IDs, remote status and timestamps are not replaced by similarly named Nexus values describing different events or identities. Digital download files remain separate from the gallery. No values are inferred from the excluded listings.

Product Media uses the existing account/listing/language-scoped editor, inheritance, ordering, alt text and copy/fill workflow. `image_ids` stays in the API catalogue with a Product Media owner and read-only status; the sheet has one gallery instead of an editable numeric-ID list. Nexus asset IDs are never submitted as Etsy image IDs. Saving a gallery remains local authoring; Etsy upload/publishing integration is separate.

## Verification and remaining work

- Mapping follow-up, verified 2026-09-11: **165 API tests passed**, including channel adapters, mapping resolution, inherited data, own listing storage and Product Media.
- Web shared-sheet, media, category-choice, reference-label and layout regressions: **232 passed**.
- Full API and Web type checks passed.
- Web and Factory token checks, DS conformance, raw-control ratchet and targeted whitespace checks passed.
- Live new-listing check: all 3,065 taxonomy nodes parsed; 55 grid columns; 13 shared-data defaults; no category preselected; readiness correctly reports category selection missing.
- **Browser visual/keyboard QA remains unverified.** Browser operations failed repeatedly with `Unable to load browser request-header policy`. No screenshot or WCAG AAA certification is claimed.

This is the listing/category sheet foundation, not completion of every Etsy resource. The separate inventory offering graph (including three variation axes), multi-question personalization, media/files, translations and full shop-profile resource editing/publishing still require their corresponding workflows. Their published resource fields are inventoried in [resource-inventory.json](resource-inventory.json). The legacy Etsy sync service still uses an older data model; it was not used for this work. No Etsy publishing end-to-end test was performed.

## Sources

- [Official OpenAPI schema](https://www.etsy.com/openapi/generated/oas/3.0.0.json), retrieved 2026-09-10. `generate-native-schema.mjs` regenerates the compact checked-in listing schema from a downloaded copy.
- [Etsy listing and taxonomy API reference](https://developers.etsy.com/documentation/reference/).
- [Inventory/shipping migration](https://developers.etsy.com/documentation/tutorials/inventory-shipping-migration/): dedicated reads and their permission scopes.
- [Third variation support](https://developers.etsy.com/documentation/tutorials/third-variation/): inventory supports three axes, with explicit write capability negotiation.
- [Personalization migration](https://developers.etsy.com/documentation/tutorials/personalization-migration/): up to five typed questions and a dedicated replacement endpoint; retired flat fields must not be restored.

Run the isolated live check from `apps/api`: `../../node_modules/.bin/tsx ../../docs/audits/2026-09-10-etsy-attributes/verify-new-listing.mts`. It reads category metadata and local sheet contracts only.
