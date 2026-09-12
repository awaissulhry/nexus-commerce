# Review of the current Jackets family attributes

Observed 11 September 2026. This review covers every one of the **198 effective family definitions** for GALE-JACKET; all currently have `required: false`, and 57 are marked localizable. The 227-column shared chooser also includes universal/structural and saved historical columns, so these counts have different meanings.

These are proposed dispositions based on the inspected definitions, product family and resolver behavior. They are not automatic migrations or a claim that an optional field is invalid for every jacket. A heated jacket, licensed garment or bundle can legitimately need an extension. Preserve populated historical values and review downstream mappings before changing definitions. Requirement rules should follow product/family, channel and locale applicability; not every retained field should become mandatory.

A current `text` field may represent a code or prose; decide which before changing localization. Localized option labels should not change canonical option identity. Native identity/content fields outside these 198 definitions are addressed in the main audit.

| Proposed disposition | Count |
| --- | ---: |
| Core shared facts | 14 |
| Consolidate related concepts | 19 |
| Structured measurements and size systems | 23 |
| Conditional safety and compliance | 28 |
| Conditional battery or expiry extension | 27 |
| Optional apparel and merchandising details | 47 |
| Clarify ambiguous meaning | 12 |
| Other product families | 27 |
| Channel-owned default | 1 |

## Core shared facts

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `material` | text | No | Prefer canonical material codes and a repeatable composition structure; keep marketing wording separately. |
| `model_number` | text | No | Stable manufacturer/model identifier; normally shared by the family unless the business model says otherwise. |
| `color` | text | No | Use a stable variant option code with localized labels, provider value maps and a separate branded color name. |
| `size` | text | No | Use a stable variant option code plus explicit size system/scale; do not localize SKU identity. |
| `target_gender` | text | No | Use a controlled option vocabulary with localized labels and provider mappings. |
| `age_range_description` | text | No | Use controlled age/audience meaning with localized display text; avoid free-text channel enum drift. |
| `fabric_type` | textarea | No | Current textarea is not localizable. Prefer structured composition plus optional localized fabric description. |
| `fit_type` | text | No | Controlled fit codes and localized labels; one authoritative fit concept. |
| `care_instructions` | textarea | No | Current textarea is not localizable. Add locale-aware care content and/or reusable symbols/instructions. |
| `water_resistance_level` | text | No | Separate a controlled performance classification from optional measured rating/evidence and marketing wording. |
| `countryOfOrigin` | text | No | Use the existing canonical origin field with ISO values and localized display names; do not duplicate. |
| `hsCode` | text | No | Retain customs classification with its relevant jurisdiction/version ownership; it is not descriptive prose. |
| `manufacturer_warranty` | text | No | Current field is not localizable. Use structured warranty terms plus localized text/reference as needed. |
| `model_name` | text | Yes | Keep localized model display text; separate the stable model identity from its display label. |

## Consolidate related concepts

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `apparel_fabric_stretch` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `color__standardized_values` | text | Yes | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `customer_package_type` | text | Yes | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `exact_color` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `fabric_stretchability` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `front_pocket_count` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `has_coat_weather_resistance` | boolean | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `item_package_quantity` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `number_of_items` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `number_of_pockets` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `packageType` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `pattern` | text | Yes | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `pattern_type` | text | Yes | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `specific_color` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `temperature_rating` | text | Yes | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `unit_count` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `unit_count__type` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `temperature_minimumUnit` | text | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |
| `temperature_minimumValue` | number | No | Review overlapping meanings; use one canonical model and deliberate channel projections. Do not merge distinct facts blindly. |

## Structured measurements and size systems

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `apparel_size__height_type` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `apparel_size__size_class` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `apparel_size__size_to` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `chestUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `chestValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `garment_size_country` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `item_display_dimensions__depthUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `item_display_dimensions__depthValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `item_display_dimensions__diameterUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `item_display_dimensions__diameterValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageDimensionUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageHeight` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageLength` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageWeightUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageWeightValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `packageWidth` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `shoulder_to_bottom_hem_lengthUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `shoulder_to_bottom_hem_lengthValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `waist__sizeUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `waist__sizeValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `waist__style` | text | Yes | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `waist__widthUnit` | text | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |
| `waist__widthValue` | number | No | Keep if relevant; present value/unit pairs as one typed control. Distinguish item, package and body/size-chart measurements. |

## Conditional safety and compliance

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `ppeCategory` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `garmentClass` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `notifiedBodyNumber` | text | No | Reference a reusable body/certificate record where applicable; validate relationship to the document. |
| `notifiedBodyName` | text | No | Resolve from the same reusable record as its number to avoid inconsistent pairs. |
| `declarationOfConformityUrl` | text | No | Use a typed reusable document reference with version, language, applicability and expiry metadata. |
| `hazmatClass` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `hazmatUnNumber` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `impactProtectors` | text | No | Use structured protector location/type/performance information and supporting evidence where relevant. |
| `compliance_age_range` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_down_plumage_weight` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_embellishment_feature` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_fastening_method` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_is_furskin_present` | boolean | No | Conditional material/compliance fact; false is a meaningful value distinct from unknown. |
| `compliance_is_handmade` | boolean | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_other_material_additions` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_outer_surface_material` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_printing_method` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `compliance_weave_type` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `ghs` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `ghs_chemical_h_code` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `gpsr_safety_attestation` | boolean | No | A policy-specific attestation, not an automatically inferred truth; retain evidence and reviewed applicability. |
| `hazmat` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `is_green_purchasing_law_compliant` | boolean | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `is_oem_sourced_product` | boolean | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `is_this_product_subject_to_buyer_age_restrictions` | boolean | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |
| `regulatory_compliance_certification` | text | No | Use repeatable typed certificate references and applicability, not one free-text string. |
| `safety_data_sheet_url` | text | Yes | Use a typed locale-aware document reference where applicable; do not require for every jacket. |
| `supplier_declared_dg_hz_regulation` | text | No | Show and require under the relevant product/destination policy; reuse canonical compliance records and reviewed evidence. |

## Conditional battery or expiry extension

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `batteries_included` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `batteries_required` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery__cell_composition` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery__cell_composition_other_than_listed` | text | Yes | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery__iec_code` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery__weightUnit` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery__weightValue` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery_contains_free_unabsorbed_liquid` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `battery_installation_device_type` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `contains_battery_or_cell` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `fc_shelf_lifeUnit` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `fc_shelf_lifeValue` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `has_less_than_30_percent_state_of_charge` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `has_multiple_battery_powered_components` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `has_replaceable_battery` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `is_battery_non_spillable` | boolean | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `is_expiration_dated_product` | boolean | No | Only relevant when the product actually has expiry policy; do not require a fabricated date. |
| `lithium_battery__energy_contentUnit` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `lithium_battery__energy_contentValue` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `lithium_battery__packaging` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `lithium_battery__weightUnit` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `lithium_battery__weightValue` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `non_lithium_battery_energy_content` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `non_lithium_battery_energy_content__unit` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `non_lithium_battery_packaging` | text | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `num_batteries` | number | No | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |
| `product_expiration_type` | text | Yes | Enable for applicable heated/electrical or expiry-managed products; preserve supplier facts and explicit unknown/false states. |

## Optional apparel and merchandising details

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `apparel_closure_orientation` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `apparel_fabric_weight_class` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `athlete` | text | Yes | Enable for licensed/team/character merchandise when relevant; use a reusable entity rather than asking every jacket for a value. |
| `band` | text | Yes | Enable for licensed/team/character merchandise when relevant; use a reusable entity rather than asking every jacket for a value. |
| `climate_suitability` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `closure` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `coat_silhouette_type` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `coat_weather_protection` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `collar_style` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `collection_item` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `department` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `edition` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `embellishment_feature` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `fabric_distressing` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `fabric_wash` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `fashion_decade` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `fit_to_size_sentiment` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `formality_level` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `front_style` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `fur` | text | Yes | Conditional real material fact; do not discard a populated value solely because most jackets do not use fur. |
| `handmade_classification` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `item_type_name` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `has_pockets` | boolean | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `item_length_description` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `item_shape` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `language` | text | No | Clarify whether this means supplied instructions/packaging languages; editor content locale is a separate dimension. |
| `league_name` | text | Yes | Enable for licensed/team/character merchandise when relevant; use a reusable entity rather than asking every jacket for a value. |
| `lifestyle` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `lining_description` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `neckline` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `number_of_lithium_ion_cells` | number | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `number_of_lithium_metal_cells` | number | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `part_number` | text | No | Keep when manufacturer part number differs from model number and SKU; document that distinction. |
| `pocket_description` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `seasons` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `sleeve__length_description` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `sleeve__type` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `special_feature` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `special_size_type` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `specific_uses_for_product` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `sport_type` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `style` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `subject_character` | text | Yes | Enable for licensed/team/character merchandise when relevant; use a reusable entity rather than asking every jacket for a value. |
| `team_name` | text | Yes | Enable for licensed/team/character merchandise when relevant; use a reusable entity rather than asking every jacket for a value. |
| `theme` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `ultraviolet_protection_factor` | text | No | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |
| `weave_type` | text | Yes | Keep available where relevant; use an optional group and controlled codes/localized labels for enumerated meanings. |

## Clarify ambiguous meaning

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `body_type` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `configuration` | text | Yes | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `inner` | text | Yes | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `item_specific_quantity` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `item_specific_unit` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `length` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `outer` | text | Yes | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `protection` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `suitable_for` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `title_differentiation` | text | Yes | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `version_for_country` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |
| `width` | text | No | Document the business meaning, units and owner; merge with a clear existing fact when equivalent. |

## Other product families

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `bottoms_size__height_type` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `bottoms_size__inseam_size` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `bottoms_size__size_class` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `bottoms_size__size_to` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `bottoms_size__waist_size` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `cup` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `flavor` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `grip` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `hand_orientation` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `inseamUnit` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `inseamValue` | number | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `leg` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `leg__decimal_value` | number | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `leg__unit` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `leg_hem_opening_widthUnit` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `leg_hem_opening_widthValue` | number | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `lens__color` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `lens__widthUnit` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `lens__widthValue` | number | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `metal_type` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `pants_form_type` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `platform_for_display` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `ring` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `rise__heightUnit` | text | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `rise__heightValue` | number | No | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `rise__style` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |
| `scent` | text | Yes | Remove from the ordinary Jackets template unless a documented product or bundle use requires it; preserve saved values. |

## Channel-owned default

| Current code | Current type | Localizable now | Recommendation |
| --- | --- | --- | --- |
| `shopify_product_type` | text | No | Move default ownership to Shopify mapping or channel policy. Keep shared only if deliberately redefined as a provider-neutral merchandising type. |
