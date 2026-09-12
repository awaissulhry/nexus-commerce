# Attribute editing verification — 2026-09-05

The reported Amazon “Has GTIN exemption?” reversal is fixed in the shared sheet value handling. The select editor previously emitted the string `"false"`; Amazon’s formatter used JavaScript truthiness and displayed that nonempty string as Yes. The API already coerced the value to boolean false, so the immediate display could disagree with both the dropdown and persistence.

Both sheet builders now preserve declared scalar types. The actual select component calls the column parser before committing; boolean display, clipboard parsing, and filter choices share the same Yes/No contract. Master no longer stringifies its boolean values. Invalid boolean input remains visible for validation instead of being presented as a valid Yes or No.

Related defects found and fixed during the audit:

- Numeric attribute editors no longer impose an arbitrary two-decimal limit. The API rejects values that would exceed native database precision or truncate fractional inventory, with an explicit refusal. JSON numeric attributes retain their available precision.
- Scalar and list dropdown labels paste back to their declared codes; ambiguous labels are not guessed. Text, dates, and leading-zero identifiers retain their text types.
- Channel list formatting is no longer overwritten by the scalar select formatter. Measures preserve precision and map displayed unit symbols to the column’s unit codes, including unit names containing underscores and scientific notation.
- Invalid measure members and structured records in channel bullet lists are refused instead of becoming zero, a clear, or `[object Object]`.
- A child’s Master write validator now loads legacy saved attributes from the whole parent/variation group, matching the columns the studio exposes. A field stored only on the parent or a sibling can therefore be overridden on a child.

## Measured coverage

Fixture: GALE-JACKET, 21 rows, Italy, Amazon OUTERWEAR and eBay category 177104. Counts describe the schemas loaded during this run, not every possible marketplace category.

| Scope | Columns checked | Declared options checked | Editable routes validated |
| --- | ---: | ---: | ---: |
| master | 56 | 18 | 55 |
| AMAZON | 162 | 3589 | 161 |
| EBAY | 49 | 841 | 48 |

All 267 columns had declared cells on every row. The audit exercised all 4,448 declared option codes and unambiguous display-label conversions, all loaded boolean columns, numeric precision, and all loaded measure unit options. All 264 editable routes accepted their validation probes. Thirteen additional API probes verified valid booleans and weight precision, and refusals for invalid booleans, excess numeric precision, fractional/malformed stock, and malformed channel bullet lists.

The routing probes use `dryRun: true`; they verify the actual route’s schema and routing validation without persisting catalog changes. They are not a claim of database write/reload testing for every field/value combination.

Browser verification used the real Amazon GTIN exemption dropdown: choose No, wait for Saved, reload and observe No, reopen and observe No selected, choose Yes, wait for Saved, choose No again, wait for Saved, reload and observe No. The temporary parent-row probe was restored to its original explicit empty override and the UI confirmed Saved. No listings were published.

## Automated checks

- 668 frontend editor, filter, export, Master/channel save-path tests passed, including six tests rendering the real select component.
- 347 API attribute-service, numeric-storage and bulk-route tests passed.
- Full API TypeScript check passed.
- Full web TypeScript check still reports three errors in existing `grid/workspace/columns.ts` comparator signatures and the unused `ReactNode` import in `grid/workspace/WorkspaceGrid.tsx`. These files were not changed by this fix.
- The broader existing suites also have five column-order/CSS expectation failures and 19 formula tests expecting non-price formulas, while the current implementation intentionally permits formulas only for prices. These are outside this change. The 19 formula cases were explicitly excluded from the final focused API run; they are not counted as passing.

Reproduce the live audit with `node --import tsx apps/api/scripts/verify-attribute-editing.mts`. It fails if a value round trip or editable route probe fails and writes the detailed result to `/tmp/nexus-attribute-edit-audit.json`.

The regression coverage prevents recurrence of the identified defects across the shared paths. It does not certify all future schemas, integrations, or code changes as defect-free.

## Every column checked

The following manifest includes hidden and read-only columns. “Route” means a dry-run write validation; read-only columns were checked as declared cells and for applicable value conversions.

### master

| Attribute key | Kind | Shape | Route |
| --- | --- | --- | --- |
| `name` | longtext | scalar | Validated |
| `brand` | text | scalar | Validated |
| `manufacturer` | text | scalar | Validated |
| `sku` | text | scalar | Read-only |
| `status` | select | scalar | Validated |
| `description` | longtext | scalar | Validated |
| `bulletPoints` | longtext | list | Validated |
| `keywords` | longtext | list | Validated |
| `material` | text | scalar | Validated |
| `color` | text | scalar | Validated |
| `model_number` | text | scalar | Validated |
| `size` | text | scalar | Validated |
| `target_gender` | text | scalar | Validated |
| `age_range_description` | longtext | scalar | Validated |
| `fabric_type` | longtext | scalar | Validated |
| `fit_type` | text | scalar | Validated |
| `care_instructions` | longtext | scalar | Validated |
| `water_resistance_level` | text | scalar | Validated |
| `gtin` | text | scalar | Validated |
| `ean` | text | scalar | Validated |
| `upc` | text | scalar | Validated |
| `weightValue` | number | scalar | Validated |
| `weightUnit` | select | scalar | Validated |
| `dimLength` | number | scalar | Validated |
| `dimWidth` | number | scalar | Validated |
| `dimHeight` | number | scalar | Validated |
| `dimUnit` | select | scalar | Validated |
| `ppeCategory` | select | scalar | Validated |
| `garmentClass` | select | scalar | Validated |
| `impactProtectors` | text | scalar | Validated |
| `countryOfOrigin` | text | scalar | Validated |
| `notifiedBodyNumber` | text | scalar | Validated |
| `hsCode` | text | scalar | Validated |
| `notifiedBodyName` | text | scalar | Validated |
| `declarationOfConformityUrl` | text | scalar | Validated |
| `hazmatClass` | text | scalar | Validated |
| `hazmatUnNumber` | text | scalar | Validated |
| `costPrice` | number | scalar | Validated |
| `basePrice` | number | scalar | Validated |
| `minPrice` | number | scalar | Validated |
| `maxPrice` | number | scalar | Validated |
| `minMargin` | number | scalar | Validated |
| `totalStock` | number | scalar | Validated |
| `lowStockThreshold` | number | scalar | Validated |
| `armorType` | text | scalar | Validated |
| `batteries_required` | text | scalar | Validated |
| `condition_type` | text | scalar | Validated |
| `item_name` | longtext | scalar | Validated |
| `merchant_shipping_group` | text | scalar | Validated |
| `merchant_suggested_asin` | text | scalar | Validated |
| `parentage_level` | text | scalar | Validated |
| `recommended_browse_nodes` | text | scalar | Validated |
| `skip_offer` | text | scalar | Validated |
| `supplier_declared_dg_hz_regulation` | text | scalar | Validated |
| `supplier_declared_has_product_identifier_exemption` | text | scalar | Validated |
| `weave_type` | text | scalar | Validated |

### AMAZON

| Attribute key | Kind | Shape | Route |
| --- | --- | --- | --- |
| `sku` | text | scalar | Read-only |
| `productType` | text | scalar | Validated |
| `brand` | text | scalar | Validated |
| `name` | longtext | scalar | Validated |
| `externally_assigned_product_identifier` | text | scalar | Validated |
| `supplier_declared_has_product_identifier_exemption` | boolean | scalar | Validated |
| `merchant_suggested_asin` | text | scalar | Validated |
| `manufacturer` | text | scalar | Validated |
| `model_name` | text | scalar | Validated |
| `model_number` | text | scalar | Validated |
| `recommended_browse_nodes` | select | list | Validated |
| `title_differentiation` | text | scalar | Validated |
| `description` | longtext | scalar | Validated |
| `bulletPoints_1` | longtext | scalar | Validated |
| `bulletPoints_2` | longtext | scalar | Validated |
| `bulletPoints_3` | longtext | scalar | Validated |
| `bulletPoints_4` | longtext | scalar | Validated |
| `bulletPoints_5` | longtext | scalar | Validated |
| `bulletPoints_6` | longtext | scalar | Validated |
| `bulletPoints_7` | longtext | scalar | Validated |
| `bulletPoints_8` | longtext | scalar | Validated |
| `bulletPoints_9` | longtext | scalar | Validated |
| `bulletPoints_10` | longtext | scalar | Validated |
| `fabric_type` | longtext | scalar | Validated |
| `keywords` | longtext | scalar | Validated |
| `material_1` | select | scalar | Validated |
| `material_2` | select | scalar | Validated |
| `material_3` | select | scalar | Validated |
| `color` | text | scalar | Validated |
| `size` | text | scalar | Validated |
| `target_gender` | select | scalar | Validated |
| `age_range_description` | select | scalar | Validated |
| `fit_type` | select | scalar | Validated |
| `care_instructions` | select | scalar | Validated |
| `water_resistance_level` | select | scalar | Validated |
| `closure_1` | select | scalar | Validated |
| `closure_2` | select | scalar | Validated |
| `color__standardized_values` | select | scalar | Validated |
| `department` | select | scalar | Validated |
| `fc_shelf_life` | number | measure | Validated |
| `handmade_classification` | select | scalar | Validated |
| `is_expiration_dated_product` | boolean | scalar | Validated |
| `item_package_quantity` | number | scalar | Validated |
| `item_type_name` | select | scalar | Validated |
| `item_weight` | number | measure | Validated |
| `language` | select | list | Validated |
| `league_name` | select | scalar | Validated |
| `lifestyle` | select | scalar | Validated |
| `number_of_items` | number | scalar | Validated |
| `outer_1` | select | scalar | Validated |
| `outer_2` | select | scalar | Validated |
| `outer_3` | select | scalar | Validated |
| `outer_4` | select | scalar | Validated |
| `outer_5` | select | scalar | Validated |
| `part_number` | text | scalar | Validated |
| `pattern` | select | scalar | Validated |
| `product_expiration_type` | select | scalar | Validated |
| `product_site_launch_date` | date | scalar | Validated |
| `special_size_type` | select | scalar | Validated |
| `style` | select | scalar | Validated |
| `subject_character` | text | scalar | Validated |
| `team_name` | select | scalar | Validated |
| `temperature_rating` | select | scalar | Validated |
| `theme` | select | scalar | Validated |
| `weave_type` | select | scalar | Validated |
| `child_parent_sku_relationship__child_relationship_type` | select | scalar | Validated |
| `child_parent_sku_relationship__parent_sku` | text | scalar | Validated |
| `parentage_level` | select | scalar | Validated |
| `variation_theme` | select | scalar | Validated |
| `image_locator_ps01` | text | scalar | Validated |
| `image_locator_ps02` | text | scalar | Validated |
| `image_locator_ps03` | text | scalar | Validated |
| `image_locator_ps04` | text | scalar | Validated |
| `image_locator_ps05` | text | scalar | Validated |
| `image_locator_ps06` | text | scalar | Validated |
| `main_product_image_locator` | text | scalar | Validated |
| `other_product_image_locator_1` | text | scalar | Validated |
| `other_product_image_locator_2` | text | scalar | Validated |
| `other_product_image_locator_3` | text | scalar | Validated |
| `other_product_image_locator_4` | text | scalar | Validated |
| `other_product_image_locator_5` | text | scalar | Validated |
| `other_product_image_locator_6` | text | scalar | Validated |
| `other_product_image_locator_7` | text | scalar | Validated |
| `other_product_image_locator_8` | text | scalar | Validated |
| `swatch_product_image_locator` | text | scalar | Validated |
| `country_of_origin` | select | scalar | Validated |
| `supplier_declared_dg_hz_regulation` | select | list | Validated |
| `batteries_included` | boolean | scalar | Validated |
| `batteries_required` | boolean | scalar | Validated |
| `battery__cell_composition` | select | scalar | Validated |
| `battery__cell_composition_other_than_listed` | text | scalar | Validated |
| `battery__weight` | number | measure | Validated |
| `compliance_media` | text | scalar | Validated |
| `ghs_chemical_h_code` | select | list | Validated |
| `ghs` | select | list | Validated |
| `hazmat` | text | scalar | Validated |
| `inner` | text | scalar | Validated |
| `is_this_product_subject_to_buyer_age_restrictions` | boolean | scalar | Validated |
| `lithium_battery__energy_content` | number | measure | Validated |
| `lithium_battery__packaging` | select | scalar | Validated |
| `lithium_battery__weight` | number | measure | Validated |
| `gpsr_manufacturer_reference` | text | scalar | Validated |
| `ec_medical_device_sales_channel` | select | scalar | Validated |
| `num_batteries` | number | scalar | Validated |
| `number_of_lithium_metal_cells` | number | scalar | Validated |
| `number_of_lithium_ion_cells` | number | scalar | Validated |
| `dsa_responsible_party_address` | text | scalar | Validated |
| `gpsr_safety_attestation` | boolean | scalar | Validated |
| `safety_data_sheet_url` | text | scalar | Validated |
| `ships_globally` | boolean | scalar | Validated |
| `supplemental_condition_information__accessories` | select | scalar | Validated |
| `supplemental_condition_information__battery_life_percentage` | select | scalar | Validated |
| `supplemental_condition_information__cosmetic` | select | scalar | Validated |
| `supplemental_condition_information__features_1` | select | scalar | Validated |
| `supplemental_condition_information__features_2` | select | scalar | Validated |
| `supplemental_condition_information__features_3` | select | scalar | Validated |
| `supplemental_condition_information__features_4` | select | scalar | Validated |
| `supplemental_condition_information__features_5` | select | scalar | Validated |
| `supplemental_condition_information__features_6` | select | scalar | Validated |
| `supplemental_condition_information__features_7` | select | scalar | Validated |
| `supplemental_condition_information__features_8` | select | scalar | Validated |
| `supplemental_condition_information__features_9` | select | scalar | Validated |
| `supplemental_condition_information__features_10` | select | scalar | Validated |
| `supplemental_condition_information__functional_condition` | select | scalar | Validated |
| `fulfillment_availability__lead_time_to_ship_max_days` | number | scalar | Validated |
| `fulfillment_availability__is_inventory_available` | boolean | scalar | Validated |
| `gift_options__can_be_wrapped` | boolean | scalar | Validated |
| `condition_type` | select | scalar | Validated |
| `list_price` | number | scalar | Validated |
| `main_offer_image_locator` | text | scalar | Validated |
| `max_order_quantity` | number | scalar | Validated |
| `purchasable_offer__maximum_seller_allowed_price` | number | list | Validated |
| `merchant_shipping_group` | text | scalar | Validated |
| `purchasable_offer__map_price` | number | list | Validated |
| `map_policy` | select | scalar | Validated |
| `purchasable_offer__minimum_seller_allowed_price` | number | list | Validated |
| `condition_note` | text | scalar | Validated |
| `gift_options__can_be_messaged` | boolean | scalar | Validated |
| `purchasable_offer__start_at` | date | scalar | Validated |
| `other_offer_image_locator_1` | text | scalar | Validated |
| `other_offer_image_locator_2` | text | scalar | Validated |
| `other_offer_image_locator_3` | text | scalar | Validated |
| `other_offer_image_locator_4` | text | scalar | Validated |
| `other_offer_image_locator_5` | text | scalar | Validated |
| `supplemental_condition_information__packaging` | select | scalar | Validated |
| `purchasable_offer__automated_pricing_merchandising_rule_plan` | text | list | Validated |
| `product_tax_code` | text | scalar | Validated |
| `fulfillment_availability__quantity` | number | scalar | Validated |
| `merchant_release_date` | date | scalar | Validated |
| `supplemental_condition_information__renewed_grade` | select | scalar | Validated |
| `fulfillment_availability__restock_date` | date | scalar | Validated |
| `purchasable_offer__discounted_price__end_at` | date | list | Validated |
| `purchasable_offer__discounted_price__value_with_tax` | number | list | Validated |
| `purchasable_offer__discounted_price__start_at` | date | list | Validated |
| `skip_offer` | boolean | scalar | Validated |
| `supplemental_condition_information__source_type` | select | scalar | Validated |
| `purchasable_offer__end_at` | date | scalar | Validated |
| `purchasable_offer__our_price` | number | list | Validated |
| `item_package_dimensions__height` | number | measure | Validated |
| `item_package_dimensions__length` | number | measure | Validated |
| `item_package_weight` | number | measure | Validated |
| `item_package_dimensions__width` | number | measure | Validated |

### EBAY

| Attribute key | Kind | Shape | Route |
| --- | --- | --- | --- |
| `sku` | text | scalar | Read-only |
| `categoryId` | text | scalar | Validated |
| `name` | longtext | scalar | Validated |
| `description` | longtext | scalar | Validated |
| `subtitle` | text | scalar | Validated |
| `descriptionThemeId` | text | scalar | Validated |
| `brand` | select | scalar | Validated |
| `material` | select | scalar | Validated |
| `color` | select | scalar | Validated |
| `size` | select | scalar | Validated |
| `adatto_a` | select | list | Validated |
| `closure_fastening` | select | list | Validated |
| `colore_esatto` | text | scalar | Validated |
| `colore_specifico` | text | scalar | Validated |
| `cura_dell_indumento` | select | scalar | Validated |
| `features` | select | list | Validated |
| `garanzia_produttore` | select | scalar | Validated |
| `length` | select | scalar | Validated |
| `paese_di_origine` | select | scalar | Validated |
| `protection` | select | list | Validated |
| `quantita` | text | scalar | Validated |
| `scollatura` | select | scalar | Validated |
| `season` | select | scalar | Validated |
| `style` | select | scalar | Validated |
| `unita_di_misura` | select | scalar | Validated |
| `width` | select | scalar | Validated |
| `sharedSkuListing` | boolean | scalar | Validated |
| `variationTheme` | text | scalar | Validated |
| `imageUrls` | text | list | Validated |
| `videoId` | text | scalar | Validated |
| `conditionId` | select | scalar | Validated |
| `price` | number | scalar | Validated |
| `quantity` | number | scalar | Validated |
| `listingFormat` | select | scalar | Validated |
| `listingDuration` | select | scalar | Validated |
| `vatRate` | number | scalar | Validated |
| `bestOffer` | boolean | scalar | Validated |
| `bestOfferFloor` | number | scalar | Validated |
| `bestOfferCeiling` | number | scalar | Validated |
| `handlingTime` | number | scalar | Validated |
| `packageType` | select | scalar | Validated |
| `packageWeight` | number | measure | Validated |
| `packageLength` | number | scalar | Validated |
| `packageWidth` | number | scalar | Validated |
| `packageHeight` | number | scalar | Validated |
| `dimensionUnit` | select | scalar | Validated |
| `fulfillmentPolicyId` | text | scalar | Validated |
| `returnPolicyId` | text | scalar | Validated |
| `paymentPolicyId` | text | scalar | Validated |

