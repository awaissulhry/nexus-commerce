# Product attribute inventory — 2026-09-05

Current snapshot after the family and category implementation. Source: the running local Studio API for GALE-JACKET, 21 rows, Italy. Product values are omitted. The original audit is historical; see [the implementation report](2026-09-05-product-attribute-foundation.md) for current behavior and remaining acceptance work.

SKU appears in the contract and in the Product identity band, so the All attributes picker has one fewer entry. Column totals include expanded lists and compounds; they do not establish complete marketplace API coverage. Classification, media and variant relationships also have dedicated controls.

The write column names the actual row write target and route. Where the channel specification declares a concrete listing store, it is shown below the route. Generic Amazon attribute overrides use the existing listing override layer. Channel requirements and limits below belong to the selected category; conditional candidates have not been fully evaluated as a marketplace payload.


## Master — 56 contract columns

Jackets family: universal fields, 20 effective family definitions, and the fixture’s additional saved attributes. No marketplace schema is imported into the Master template.

### Identity (5)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Name | `name` · scalar | master · `name` | Required by Master |
| Brand | `brand` · scalar | master · `brand` | Optional |
| Manufacturer | `manufacturer` · scalar | master · `manufacturer` | Optional |
| SKU | `sku` · scalar | Read-only context | Read-only |
| Status | `status` · scalar | master · `status` | Optional |

### Content (3)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Description | `description` · scalar | master · `description` | Optional |
| Bullet points | `bulletPoints` · list | master · `bulletPoints` | Optional |
| Search keywords | `keywords` · list | master · `keywords` | Optional |

### Specifications (10)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Material | `material` · scalar | master · `attr_material` | Optional |
| Color | `color` · scalar | master · `attr_color` | Optional |
| Model number | `model_number` · scalar | master · `attr_model_number` | Optional |
| Size | `size` · scalar | master · `attr_size` | Optional |
| Target gender | `target_gender` · scalar | master · `attr_target_gender` | Optional |
| Age range | `age_range_description` · scalar | master · `attr_age_range_description` | Optional |
| Fabric composition | `fabric_type` · scalar | master · `attr_fabric_type` | Optional |
| Fit | `fit_type` · scalar | master · `attr_fit_type` | Optional |
| Care instructions | `care_instructions` · scalar | master · `attr_care_instructions` | Optional |
| Water resistance | `water_resistance_level` · scalar | master · `attr_water_resistance_level` | Optional |

### Identifiers (3)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| GTIN | `gtin` · scalar | master · `gtin` | Optional |
| EAN | `ean` · scalar | master · `ean` | Optional |
| UPC | `upc` · scalar | master · `upc` | Optional |

### Dimensions and weight (6)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Weight | `weightValue` · scalar | master · `weightValue` | Optional |
| Weight unit | `weightUnit` · scalar | master · `weightUnit` | Optional |
| Length | `dimLength` · scalar | master · `dimLength` | Optional |
| Width | `dimWidth` · scalar | master · `dimWidth` | Optional |
| Height | `dimHeight` · scalar | master · `dimHeight` | Optional |
| Dimension unit | `dimUnit` · scalar | master · `dimUnit` | Optional |

### Compliance and traceability (10)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| PPE category | `ppeCategory` · scalar | master · `ppeCategory` | Optional |
| Protective garment class | `garmentClass` · scalar | master · `garmentClass` | Optional |
| Impact protectors | `impactProtectors` · protector records (specialized editor) | master · `impactProtectors` | Optional |
| Country of origin | `countryOfOrigin` · scalar | master · `countryOfOrigin` | Optional |
| Notified body number | `notifiedBodyNumber` · scalar | master · `notifiedBodyNumber` | Optional |
| HS code | `hsCode` · scalar | master · `hsCode` | Optional |
| Notified body name | `notifiedBodyName` · scalar | master · `notifiedBodyName` | Optional |
| Declaration of conformity URL | `declarationOfConformityUrl` · scalar | master · `declarationOfConformityUrl` | Optional |
| Hazardous material class | `hazmatClass` · scalar | master · `hazmatClass` | Optional |
| UN number | `hazmatUnNumber` · scalar | master · `hazmatUnNumber` | Optional |

### Pricing (5)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Cost | `costPrice` · scalar | master · `costPrice` | Optional |
| Base Price | `basePrice` · scalar | master · `basePrice` | Optional |
| Min Price | `minPrice` · scalar | master · `minPrice` | Optional |
| Max Price | `maxPrice` · scalar | master · `maxPrice` | Optional |
| Min Margin % | `minMargin` · scalar | master · `minMargin` | Optional |

### Inventory (2)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Stock | `totalStock` · scalar | master · `totalStock` | Optional |
| Low Stock Alert | `lowStockThreshold` · scalar | master · `lowStockThreshold` | Optional |

### Additional saved attributes (12)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Armor Type | `armorType` · scalar | master · `attr_armorType` | Optional |
| Batteries required | `batteries_required` · scalar | master · `attr_batteries_required` | Optional |
| Condition type | `condition_type` · scalar | master · `attr_condition_type` | Optional |
| Item name | `item_name` · scalar | master · `attr_item_name` | Optional |
| Merchant shipping group | `merchant_shipping_group` · scalar | master · `attr_merchant_shipping_group` | Optional |
| Merchant suggested asin | `merchant_suggested_asin` · scalar | master · `attr_merchant_suggested_asin` | Optional |
| Parentage level | `parentage_level` · scalar | master · `attr_parentage_level` | Optional |
| Recommended browse nodes | `recommended_browse_nodes` · scalar | master · `attr_recommended_browse_nodes` | Optional |
| Skip offer | `skip_offer` · scalar | master · `attr_skip_offer` | Optional |
| Supplier declared dg hz regulation | `supplier_declared_dg_hz_regulation` · scalar | master · `attr_supplier_declared_dg_hz_regulation` | Optional |
| Supplier declared has product identifier exemption | `supplier_declared_has_product_identifier_exemption` · scalar | master · `attr_supplier_declared_has_product_identifier_exemption` | Optional |
| Weave type | `weave_type` · scalar | master · `attr_weave_type` | Optional |


## Amazon · IT — 162 contract columns

- Category `OUTERWEAR`: 107 adapter source attributes, 160 expanded schema columns; fetched 2026-09-04T22:26:15.790Z. Unrecognized shapes reported by this adapter: 0.
- The separate Amazon product-type selector and read-only SKU account for the other two columns.

### Identity (1)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| SKU | `sku` · scalar | Read-only context | Read-only |

### Classification (1)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Product type | `productType` · scalar | channelListing · `attr_productType`<br>`ChannelListing.platformAttributes.productType` | Amazon · IT: *, required |

### Product identity (10)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Brand | `brand` · scalar | channelListing · `attr_brand` | Amazon · IT: OUTERWEAR, required, max 100 characters |
| Title | `name` · scalar | channelListing · `amazon_title`<br>`ChannelListing.title` | Amazon · IT: OUTERWEAR, required, max 200 characters |
| External Product ID | `externally_assigned_product_identifier` · scalar | channelListing · `attr_externally_assigned_product_identifier` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Has GTIN exemption? | `supplier_declared_has_product_identifier_exemption` · scalar | channelListing · `attr_supplier_declared_has_product_identifier_exemption` | Amazon · IT: OUTERWEAR, optional |
| Merchant Suggested ASIN | `merchant_suggested_asin` · scalar | channelListing · `attr_merchant_suggested_asin` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 10 characters |
| Manufacturer | `manufacturer` · scalar | channelListing · `attr_manufacturer` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 100 characters |
| Model Name | `model_name` · scalar | channelListing · `attr_model_name` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 120 characters |
| Model Number | `model_number` · scalar | channelListing · `attr_model_number` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 40 characters |
| Recommended Browse Nodes | `recommended_browse_nodes` · list | channelListing · `attr_recommended_browse_nodes` | Amazon · IT: OUTERWEAR, optional, max 15 characters, items 1–232 |
| Item Highlight | `title_differentiation` · scalar | channelListing · `attr_title_differentiation` | Amazon · IT: OUTERWEAR, optional, max 125 characters |

### Product details (53)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Product Description | `description` · scalar | channelListing · `amazon_description`<br>`ChannelListing.description` | Amazon · IT: OUTERWEAR, required |
| Bullet 1 | `bulletPoints_1` · scalar 1 of 10 | channelListing · `amazon_bulletPoints[1]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10 |
| Bullet 2 | `bulletPoints_2` · scalar 2 of 10 | channelListing · `amazon_bulletPoints[2]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 3 | `bulletPoints_3` · scalar 3 of 10 | channelListing · `amazon_bulletPoints[3]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 4 | `bulletPoints_4` · scalar 4 of 10 | channelListing · `amazon_bulletPoints[4]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 5 | `bulletPoints_5` · scalar 5 of 10 | channelListing · `amazon_bulletPoints[5]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 6 | `bulletPoints_6` · scalar 6 of 10 | channelListing · `amazon_bulletPoints[6]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 7 | `bulletPoints_7` · scalar 7 of 10 | channelListing · `amazon_bulletPoints[7]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 8 | `bulletPoints_8` · scalar 8 of 10 | channelListing · `amazon_bulletPoints[8]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 9 | `bulletPoints_9` · scalar 9 of 10 | channelListing · `amazon_bulletPoints[9]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Bullet 10 | `bulletPoints_10` · scalar 10 of 10 | channelListing · `amazon_bulletPoints[10]`<br>`ChannelListing.bulletPointsOverride` | Amazon · IT: OUTERWEAR, required, max 700 characters, items 1–10, list requirement; this slot may be optional |
| Fabric Type | `fabric_type` · scalar | channelListing · `attr_fabric_type` | Amazon · IT: OUTERWEAR, required, max 700 characters |
| Search keywords | `keywords` · scalar | channelListing · `keywords` | Amazon · IT: OUTERWEAR, optional, max 500 characters |
| Material 1 | `material_1` · scalar 1 of 3 | channelListing · `attr_material[1]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–3 |
| Material 2 | `material_2` · scalar 2 of 3 | channelListing · `attr_material[2]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–3, list requirement; this slot may be optional |
| Material 3 | `material_3` · scalar 3 of 3 | channelListing · `attr_material[3]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–3, list requirement; this slot may be optional |
| Colour | `color` · scalar | channelListing · `attr_color` | Amazon · IT: OUTERWEAR, optional, max 1000 characters |
| Size | `size` · scalar | channelListing · `attr_size` | Amazon · IT: OUTERWEAR, optional, max 75 characters |
| Target Gender | `target_gender` · scalar | channelListing · `attr_target_gender` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Age Range Description | `age_range_description` · scalar | channelListing · `attr_age_range_description` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 1998 characters |
| Fit Type | `fit_type` · scalar | channelListing · `attr_fit_type` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 2201 characters |
| Care Instructions | `care_instructions` · scalar | channelListing · `attr_care_instructions` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters |
| Water Resistance Level | `water_resistance_level` · scalar | channelListing · `attr_water_resistance_level` | Amazon · IT: OUTERWEAR, optional |
| Closure Type 1 | `closure_1` · scalar 1 of 2 | channelListing · `attr_closure[1]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–2 |
| Closure Type 2 | `closure_2` · scalar 2 of 2 | channelListing · `attr_closure[2]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–2, list requirement; this slot may be optional |
| Colour Map | `color__standardized_values` · scalar | channelListing · `attr_color__standardized_values` | Amazon · IT: OUTERWEAR, optional |
| Department Name | `department` · scalar | channelListing · `attr_department` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 50 characters |
| Fulfillment Center Shelf Life | `fc_shelf_life` · measure | channelListing · `attr_fc_shelf_life` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 5000 characters |
| Handmade Classification | `handmade_classification` · scalar | channelListing · `attr_handmade_classification` | Amazon · IT: OUTERWEAR, optional |
| Is Product Expirable | `is_expiration_dated_product` · scalar | channelListing · `attr_is_expiration_dated_product` | Amazon · IT: OUTERWEAR, optional |
| Item Package Quantity | `item_package_quantity` · scalar | channelListing · `attr_item_package_quantity` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Item Type Name | `item_type_name` · scalar | channelListing · `attr_item_type_name` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters |
| Item Weight | `item_weight` · measure | channelListing · `attr_item_weight` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 5000 characters |
| Language | `language` · list | channelListing · `attr_language` | Amazon · IT: OUTERWEAR, requiredIfRelevant, items 1–103 |
| League Name | `league_name` · scalar | channelListing · `attr_league_name` | Amazon · IT: OUTERWEAR, optional, max 100 characters |
| Lifestyle | `lifestyle` · scalar | channelListing · `attr_lifestyle` | Amazon · IT: OUTERWEAR, optional, max 500 characters |
| Number of Items | `number_of_items` · scalar | channelListing · `attr_number_of_items` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Outer Material 1 | `outer_1` · scalar 1 of 5 | channelListing · `attr_outer[1]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–5 |
| Outer Material 2 | `outer_2` · scalar 2 of 5 | channelListing · `attr_outer[2]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–5, list requirement; this slot may be optional |
| Outer Material 3 | `outer_3` · scalar 3 of 5 | channelListing · `attr_outer[3]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–5, list requirement; this slot may be optional |
| Outer Material 4 | `outer_4` · scalar 4 of 5 | channelListing · `attr_outer[4]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–5, list requirement; this slot may be optional |
| Outer Material 5 | `outer_5` · scalar 5 of 5 | channelListing · `attr_outer[5]` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters, items 1–5, list requirement; this slot may be optional |
| Part Number | `part_number` · scalar | channelListing · `attr_part_number` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 40 characters |
| Pattern | `pattern` · scalar | channelListing · `attr_pattern` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 2200 characters |
| Product Expiration Type | `product_expiration_type` · scalar | channelListing · `attr_product_expiration_type` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 555 characters |
| Product Site Launch Date | `product_site_launch_date` · scalar | channelListing · `attr_product_site_launch_date` | Amazon · IT: OUTERWEAR, optional |
| Special Size | `special_size_type` · scalar | channelListing · `attr_special_size_type` | Amazon · IT: OUTERWEAR, optional, max 2200 characters |
| Style | `style` · scalar | channelListing · `attr_style` | Amazon · IT: OUTERWEAR, optional, max 120 characters |
| Subject Character | `subject_character` · scalar | channelListing · `attr_subject_character` | Amazon · IT: OUTERWEAR, optional, max 200 characters |
| Team Name | `team_name` · scalar | channelListing · `attr_team_name` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 100 characters |
| Temperature Rating | `temperature_rating` · scalar | channelListing · `attr_temperature_rating` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 504 characters |
| Theme | `theme` · scalar | channelListing · `attr_theme` | Amazon · IT: OUTERWEAR, optional, max 500 characters |
| Weave Type | `weave_type` · scalar | channelListing · `attr_weave_type` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 260 characters |

### Variations (4)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Child Relationship Type | `child_parent_sku_relationship__child_relationship_type` · scalar | channelListing · `attr_child_parent_sku_relationship__child_relationship_type` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Parent SKU | `child_parent_sku_relationship__parent_sku` · scalar | channelListing · `attr_child_parent_sku_relationship__parent_sku` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 40 characters |
| Parentage Level | `parentage_level` · scalar | channelListing · `attr_parentage_level` | Amazon · IT: OUTERWEAR, optional |
| Variation Theme Name | `variation_theme` · scalar | channelListing · `amazon_variationTheme`<br>`ChannelListing.variationTheme` | Amazon · IT: OUTERWEAR, requiredIfRelevant |

### Images (16)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Image locator ps01 | `image_locator_ps01` · scalar | channelListing · `attr_image_locator_ps01` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Image locator ps02 | `image_locator_ps02` · scalar | channelListing · `attr_image_locator_ps02` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Image locator ps03 | `image_locator_ps03` · scalar | channelListing · `attr_image_locator_ps03` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Image locator ps04 | `image_locator_ps04` · scalar | channelListing · `attr_image_locator_ps04` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Image locator ps05 | `image_locator_ps05` · scalar | channelListing · `attr_image_locator_ps05` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Image locator ps06 | `image_locator_ps06` · scalar | channelListing · `attr_image_locator_ps06` | Amazon · IT: OUTERWEAR, optional, max 2500 characters |
| Main Image URL | `main_product_image_locator` · scalar | channelListing · `attr_main_product_image_locator` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 1 | `other_product_image_locator_1` · scalar | channelListing · `attr_other_product_image_locator_1` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 2 | `other_product_image_locator_2` · scalar | channelListing · `attr_other_product_image_locator_2` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 3 | `other_product_image_locator_3` · scalar | channelListing · `attr_other_product_image_locator_3` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 4 | `other_product_image_locator_4` · scalar | channelListing · `attr_other_product_image_locator_4` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 5 | `other_product_image_locator_5` · scalar | channelListing · `attr_other_product_image_locator_5` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 6 | `other_product_image_locator_6` · scalar | channelListing · `attr_other_product_image_locator_6` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 7 | `other_product_image_locator_7` · scalar | channelListing · `attr_other_product_image_locator_7` | Amazon · IT: OUTERWEAR, optional |
| Other Image URL 8 | `other_product_image_locator_8` · scalar | channelListing · `attr_other_product_image_locator_8` | Amazon · IT: OUTERWEAR, optional |
| Swatch Image URL | `swatch_product_image_locator` · scalar | channelListing · `attr_swatch_product_image_locator` | Amazon · IT: OUTERWEAR, optional |

### Safety and compliance (25)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Country of Origin | `country_of_origin` · scalar | channelListing · `attr_country_of_origin` | Amazon · IT: OUTERWEAR, required |
| Dangerous Goods Regulations | `supplier_declared_dg_hz_regulation` · list | channelListing · `attr_supplier_declared_dg_hz_regulation` | Amazon · IT: OUTERWEAR, required, items 1–1000 |
| Are batteries included? | `batteries_included` · scalar | channelListing · `attr_batteries_included` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Are batteries required? | `batteries_required` · scalar | channelListing · `attr_batteries_required` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Battery Cell Composition | `battery__cell_composition` · scalar | channelListing · `attr_battery__cell_composition` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Battery Cell Composition Other Than Listed | `battery__cell_composition_other_than_listed` · scalar | channelListing · `attr_battery__cell_composition_other_than_listed` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 50 characters |
| Battery Weight | `battery__weight` · measure | channelListing · `attr_battery__weight` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 5000 characters |
| Compliance Media Source Location | `compliance_media` · scalar | channelListing · `attr_compliance_media` | Amazon · IT: OUTERWEAR, optional |
| GHS Chemical H Code | `ghs_chemical_h_code` · list | channelListing · `attr_ghs_chemical_h_code` | Amazon · IT: OUTERWEAR, optional, items 1–100 |
| GHS Class | `ghs` · list | channelListing · `attr_ghs` | Amazon · IT: OUTERWEAR, requiredIfRelevant, items 1–1000 |
| Hazmat Information | `hazmat` · scalar | channelListing · `attr_hazmat` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 2197 characters |
| Inner Material | `inner` · scalar | channelListing · `attr_inner` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 500 characters |
| Is This Product Subject To Buyer Age Restrictions | `is_this_product_subject_to_buyer_age_restrictions` · scalar | channelListing · `attr_is_this_product_subject_to_buyer_age_restrictions` | Amazon · IT: OUTERWEAR, optional |
| Lithium Battery Energy Content | `lithium_battery__energy_content` · measure | channelListing · `attr_lithium_battery__energy_content` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 5000 characters |
| Lithium Battery Packaging | `lithium_battery__packaging` · scalar | channelListing · `attr_lithium_battery__packaging` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Lithium Battery Weight | `lithium_battery__weight` · measure | channelListing · `attr_lithium_battery__weight` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 12 characters |
| Manufacturer’s Email or Electronic Address | `gpsr_manufacturer_reference` · scalar | channelListing · `attr_gpsr_manufacturer_reference` | Amazon · IT: OUTERWEAR, optional, max 100 characters |
| Medical Device Sales Channel | `ec_medical_device_sales_channel` · scalar | channelListing · `attr_ec_medical_device_sales_channel` | Amazon · IT: OUTERWEAR, optional |
| Number of Batteries | `num_batteries` · scalar | channelListing · `attr_num_batteries` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Number of Lithium Metal Cells | `number_of_lithium_metal_cells` · scalar | channelListing · `attr_number_of_lithium_metal_cells` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Number of Lithium-ion Cells | `number_of_lithium_ion_cells` · scalar | channelListing · `attr_number_of_lithium_ion_cells` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Responsible Person's Email or Electronic Address | `dsa_responsible_party_address` · scalar | channelListing · `attr_dsa_responsible_party_address` | Amazon · IT: OUTERWEAR, optional, max 1000 characters |
| Safety Attestation | `gpsr_safety_attestation` · scalar | channelListing · `attr_gpsr_safety_attestation` | Amazon · IT: OUTERWEAR, optional |
| Safety Data Sheet (SDS or MSDS) URL | `safety_data_sheet_url` · scalar | channelListing · `attr_safety_data_sheet_url` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 23397 characters |
| Ships Globally | `ships_globally` · scalar | channelListing · `attr_ships_globally` | Amazon · IT: OUTERWEAR, optional |

### Offer (48)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Accessories | `supplemental_condition_information__accessories` · scalar | channelListing · `attr_supplemental_condition_information__accessories` | Amazon · IT: OUTERWEAR, optional |
| Battery Life Percentage | `supplemental_condition_information__battery_life_percentage` · scalar | channelListing · `attr_supplemental_condition_information__battery_life_percentage` | Amazon · IT: OUTERWEAR, optional |
| Cosmetic | `supplemental_condition_information__cosmetic` · scalar | channelListing · `attr_supplemental_condition_information__cosmetic` | Amazon · IT: OUTERWEAR, optional |
| Features 1 | `supplemental_condition_information__features_1` · scalar 1 of 10 | channelListing · `attr_supplemental_condition_information__features[1]` | Amazon · IT: OUTERWEAR, optional, items 1–10 |
| Features 2 | `supplemental_condition_information__features_2` · scalar 2 of 10 | channelListing · `attr_supplemental_condition_information__features[2]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 3 | `supplemental_condition_information__features_3` · scalar 3 of 10 | channelListing · `attr_supplemental_condition_information__features[3]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 4 | `supplemental_condition_information__features_4` · scalar 4 of 10 | channelListing · `attr_supplemental_condition_information__features[4]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 5 | `supplemental_condition_information__features_5` · scalar 5 of 10 | channelListing · `attr_supplemental_condition_information__features[5]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 6 | `supplemental_condition_information__features_6` · scalar 6 of 10 | channelListing · `attr_supplemental_condition_information__features[6]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 7 | `supplemental_condition_information__features_7` · scalar 7 of 10 | channelListing · `attr_supplemental_condition_information__features[7]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 8 | `supplemental_condition_information__features_8` · scalar 8 of 10 | channelListing · `attr_supplemental_condition_information__features[8]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 9 | `supplemental_condition_information__features_9` · scalar 9 of 10 | channelListing · `attr_supplemental_condition_information__features[9]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Features 10 | `supplemental_condition_information__features_10` · scalar 10 of 10 | channelListing · `attr_supplemental_condition_information__features[10]` | Amazon · IT: OUTERWEAR, optional, items 1–10, list requirement; this slot may be optional |
| Functional Condition | `supplemental_condition_information__functional_condition` · scalar | channelListing · `attr_supplemental_condition_information__functional_condition` | Amazon · IT: OUTERWEAR, optional |
| Handling Time | `fulfillment_availability__lead_time_to_ship_max_days` · scalar | channelListing · `attr_fulfillment_availability__lead_time_to_ship_max_days` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Inventory Always Available | `fulfillment_availability__is_inventory_available` · scalar | channelListing · `attr_fulfillment_availability__is_inventory_available` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Is Gift Wrap Available | `gift_options__can_be_wrapped` · scalar | channelListing · `attr_gift_options__can_be_wrapped` | Amazon · IT: OUTERWEAR, optional |
| Item Condition | `condition_type` · scalar | channelListing · `attr_condition_type` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| List Price with Tax | `list_price` · scalar | channelListing · `attr_list_price` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 20 characters |
| Main Image Location | `main_offer_image_locator` · scalar | channelListing · `attr_main_offer_image_locator` | Amazon · IT: OUTERWEAR, optional |
| Maximum Order Quantity | `max_order_quantity` · scalar | channelListing · `attr_max_order_quantity` | Amazon · IT: OUTERWEAR, optional |
| Maximum Seller Allowed Price | `purchasable_offer__maximum_seller_allowed_price` · list | channelListing · `attr_purchasable_offer__maximum_seller_allowed_price` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Merchant Shipping Group | `merchant_shipping_group` · scalar | channelListing · `attr_merchant_shipping_group` | Amazon · IT: OUTERWEAR, requiredIfRelevant, max 100 characters |
| Minimum Advertised Price | `purchasable_offer__map_price` · list | channelListing · `attr_purchasable_offer__map_price` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Minimum Advertised Price Display | `map_policy` · scalar | channelListing · `attr_map_policy` | Amazon · IT: OUTERWEAR, optional |
| Minimum Seller Allowed Price | `purchasable_offer__minimum_seller_allowed_price` · list | channelListing · `attr_purchasable_offer__minimum_seller_allowed_price` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Offer Condition Note | `condition_note` · scalar | channelListing · `attr_condition_note` | Amazon · IT: OUTERWEAR, optional, max 2204 characters |
| Offering Can Be Gift Messaged | `gift_options__can_be_messaged` · scalar | channelListing · `attr_gift_options__can_be_messaged` | Amazon · IT: OUTERWEAR, optional |
| Offering Release Date | `purchasable_offer__start_at` · scalar | channelListing · `attr_purchasable_offer__start_at` | Amazon · IT: OUTERWEAR, optional |
| Other Image Location 1 | `other_offer_image_locator_1` · scalar | channelListing · `attr_other_offer_image_locator_1` | Amazon · IT: OUTERWEAR, optional |
| Other Image Location 2 | `other_offer_image_locator_2` · scalar | channelListing · `attr_other_offer_image_locator_2` | Amazon · IT: OUTERWEAR, optional |
| Other Image Location 3 | `other_offer_image_locator_3` · scalar | channelListing · `attr_other_offer_image_locator_3` | Amazon · IT: OUTERWEAR, optional |
| Other Image Location 4 | `other_offer_image_locator_4` · scalar | channelListing · `attr_other_offer_image_locator_4` | Amazon · IT: OUTERWEAR, optional |
| Other Image Location 5 | `other_offer_image_locator_5` · scalar | channelListing · `attr_other_offer_image_locator_5` | Amazon · IT: OUTERWEAR, optional |
| Packaging | `supplemental_condition_information__packaging` · scalar | channelListing · `attr_supplemental_condition_information__packaging` | Amazon · IT: OUTERWEAR, optional |
| Pricing Rule | `purchasable_offer__automated_pricing_merchandising_rule_plan` · list | channelListing · `attr_purchasable_offer__automated_pricing_merchandising_rule_plan` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Product Tax Code | `product_tax_code` · scalar | channelListing · `attr_product_tax_code` | Amazon · IT: OUTERWEAR, optional, max 949 characters |
| Quantity | `fulfillment_availability__quantity` · scalar | channelListing · `attr_fulfillment_availability__quantity` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Release Date | `merchant_release_date` · scalar | channelListing · `attr_merchant_release_date` | Amazon · IT: OUTERWEAR, optional |
| Renewed Grade | `supplemental_condition_information__renewed_grade` · scalar | channelListing · `attr_supplemental_condition_information__renewed_grade` | Amazon · IT: OUTERWEAR, optional |
| Restock Date | `fulfillment_availability__restock_date` · scalar | channelListing · `attr_fulfillment_availability__restock_date` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Sale End Date | `purchasable_offer__discounted_price__end_at` · list | channelListing · `attr_purchasable_offer__discounted_price__end_at` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Sale Price | `purchasable_offer__discounted_price__value_with_tax` · list | channelListing · `attr_purchasable_offer__discounted_price__value_with_tax` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Sale Start Date | `purchasable_offer__discounted_price__start_at` · list | channelListing · `attr_purchasable_offer__discounted_price__start_at` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |
| Skip Offer | `skip_offer` · scalar | channelListing · `attr_skip_offer` | Amazon · IT: OUTERWEAR, optional |
| Source Type | `supplemental_condition_information__source_type` · scalar | channelListing · `attr_supplemental_condition_information__source_type` | Amazon · IT: OUTERWEAR, optional |
| Stop Selling Date | `purchasable_offer__end_at` · scalar | channelListing · `attr_purchasable_offer__end_at` | Amazon · IT: OUTERWEAR, optional |
| Your Price | `purchasable_offer__our_price` · list | channelListing · `attr_purchasable_offer__our_price` | Amazon · IT: OUTERWEAR, optional, items 1–unbounded |

### Shipping (4)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Item Package Height | `item_package_dimensions__height` · measure | channelListing · `attr_item_package_dimensions__height` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Item Package Length | `item_package_dimensions__length` · measure | channelListing · `attr_item_package_dimensions__length` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Item Package Weight | `item_package_weight` · measure | channelListing · `attr_item_package_weight` | Amazon · IT: OUTERWEAR, requiredIfRelevant |
| Item Package Width | `item_package_dimensions__width` · measure | channelListing · `attr_item_package_dimensions__width` | Amazon · IT: OUTERWEAR, requiredIfRelevant |


## eBay · IT — 49 contract columns

- Category `177104`: 48 adapter source attributes, 48 expanded schema columns; fetched 2026-08-20T06:00:46.688Z. Unrecognized shapes reported by this adapter: 0.
- The 48 modeled fields comprise 20 cached item specifics and 28 listing fields. Read-only SKU is the remaining column. Fresh metadata and policy lookup are currently blocked by the local eBay credential configuration.

### Identity (1)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| SKU | `sku` · scalar | Read-only context | Read-only |

### Classification (1)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Category | `categoryId` · scalar | channelListing · `attr_categoryId`<br>`ChannelListing.platformAttributes.categoryId` | eBay · IT: 177104, optional |

### Content (4)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Title | `name` · scalar | channelListing · `ebay_title`<br>`ChannelListing.title` | eBay · IT: 177104, required, max 80 characters |
| Description | `description` · scalar | channelListing · `ebay_description`<br>`ChannelListing.description` | eBay · IT: 177104, required |
| Subtitle | `subtitle` · scalar | channelListing · `attr_subtitle`<br>`ChannelListing.platformAttributes.subtitle` | eBay · IT: 177104, optional, max 55 characters |
| Description theme | `descriptionThemeId` · scalar | channelListing · `attr_descriptionThemeId`<br>`ChannelListing.platformAttributes.descriptionThemeId` | eBay · IT: 177104, optional |

### Item specifics (20)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Brand | `brand` · scalar | channelListing · `attr_brand`<br>`ChannelListing.platformAttributes.itemSpecifics.Marca` | eBay · IT: 177104, required |
| Material | `material` · scalar | channelListing · `attr_material`<br>`ChannelListing.platformAttributes.itemSpecifics.Materiale` | eBay · IT: 177104, bestPractice |
| Color | `color` · scalar | channelListing · `attr_color`<br>`ChannelListing.platformAttributes.itemSpecifics.Colore` | eBay · IT: 177104, optional |
| Size | `size` · scalar | channelListing · `attr_size`<br>`ChannelListing.platformAttributes.itemSpecifics.Taglia` | eBay · IT: 177104, bestPractice |
| Adatto a | `adatto_a` · list | channelListing · `attr_adatto_a`<br>`ChannelListing.platformAttributes.itemSpecifics.Adatto a` | eBay · IT: 177104, bestPractice, items 1–unbounded |
| Closure / Fastening | `closure_fastening` · list | channelListing · `attr_closure_fastening`<br>`ChannelListing.platformAttributes.itemSpecifics.Chiusura` | eBay · IT: 177104, optional, items 1–unbounded |
| Colore esatto | `colore_esatto` · scalar | channelListing · `attr_colore_esatto`<br>`ChannelListing.platformAttributes.itemSpecifics.Colore esatto` | eBay · IT: 177104, optional |
| Colore specifico | `colore_specifico` · scalar | channelListing · `attr_colore_specifico`<br>`ChannelListing.platformAttributes.itemSpecifics.Colore specifico` | eBay · IT: 177104, optional |
| Cura dell'indumento | `cura_dell_indumento` · scalar | channelListing · `attr_cura_dell_indumento`<br>`ChannelListing.platformAttributes.itemSpecifics.Cura dell'indumento` | eBay · IT: 177104, optional |
| Features | `features` · list | channelListing · `attr_features`<br>`ChannelListing.platformAttributes.itemSpecifics.Caratteristiche` | eBay · IT: 177104, optional, items 1–unbounded |
| Garanzia produttore | `garanzia_produttore` · scalar | channelListing · `attr_garanzia_produttore`<br>`ChannelListing.platformAttributes.itemSpecifics.Garanzia produttore` | eBay · IT: 177104, optional |
| Length | `length` · scalar | channelListing · `attr_length`<br>`ChannelListing.platformAttributes.itemSpecifics.Lunghezza` | eBay · IT: 177104, optional |
| Paese di origine | `paese_di_origine` · scalar | channelListing · `attr_paese_di_origine`<br>`ChannelListing.platformAttributes.itemSpecifics.Paese di origine` | eBay · IT: 177104, optional |
| Protection | `protection` · list | channelListing · `attr_protection`<br>`ChannelListing.platformAttributes.itemSpecifics.Protezione` | eBay · IT: 177104, optional, items 1–unbounded |
| Quantità | `quantita` · scalar | channelListing · `attr_quantita`<br>`ChannelListing.platformAttributes.itemSpecifics.Quantità` | eBay · IT: 177104, optional |
| Scollatura | `scollatura` · scalar | channelListing · `attr_scollatura`<br>`ChannelListing.platformAttributes.itemSpecifics.Scollatura` | eBay · IT: 177104, optional |
| Season | `season` · scalar | channelListing · `attr_season`<br>`ChannelListing.platformAttributes.itemSpecifics.Stagione` | eBay · IT: 177104, optional |
| Style | `style` · scalar | channelListing · `attr_style`<br>`ChannelListing.platformAttributes.itemSpecifics.Stile` | eBay · IT: 177104, optional |
| Unità di misura | `unita_di_misura` · scalar | channelListing · `attr_unita_di_misura`<br>`ChannelListing.platformAttributes.itemSpecifics.Unità di misura` | eBay · IT: 177104, optional |
| Width | `width` · scalar | channelListing · `attr_width`<br>`ChannelListing.platformAttributes.itemSpecifics.Larghezza` | eBay · IT: 177104, optional |

### Variations (2)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Shared-SKU listing | `sharedSkuListing` · scalar | channelListing · `attr_sharedSkuListing`<br>`ChannelListing.platformAttributes.sharedSkuListing` | eBay · IT: 177104, optional |
| Variation theme | `variationTheme` · scalar | channelListing · `ebay_variationTheme`<br>`ChannelListing.variationTheme` | eBay · IT: 177104, optional |

### Images and media (2)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Image URLs | `imageUrls` · list | channelListing · `attr_imageUrls`<br>`ChannelListing.platformAttributes.imageUrls` | eBay · IT: 177104, optional, items 1–24 |
| Video id | `videoId` · scalar | channelListing · `attr_videoId`<br>`ChannelListing.platformAttributes.videoId` | eBay · IT: 177104, optional |

### Offer (9)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Condition | `conditionId` · scalar | channelListing · `attr_conditionId`<br>`ChannelListing.platformAttributes.conditionId` | eBay · IT: 177104, required |
| Listing price | `price` · scalar | channelListing · `ebay_price`<br>`ChannelListing.price` | eBay · IT: 177104, required |
| Available quantity | `quantity` · scalar | channelListing · `ebay_quantity`<br>`ChannelListing.quantity` | eBay · IT: 177104, required |
| Listing format | `listingFormat` · scalar | channelListing · `attr_listingFormat`<br>`ChannelListing.platformAttributes.listingFormat` | eBay · IT: 177104, optional |
| Listing duration | `listingDuration` · scalar | channelListing · `attr_listingDuration`<br>`ChannelListing.platformAttributes.listingDuration` | eBay · IT: 177104, optional |
| VAT rate (%) | `vatRate` · scalar | channelListing · `attr_vatRate`<br>`ChannelListing.platformAttributes.vatRate` | eBay · IT: 177104, optional |
| Best offer | `bestOffer` · scalar | channelListing · `attr_bestOffer`<br>`ChannelListing.platformAttributes.bestOffer` | eBay · IT: 177104, optional |
| Best offer auto-accept | `bestOfferFloor` · scalar | channelListing · `attr_bestOfferFloor`<br>`ChannelListing.platformAttributes.bestOfferFloor` | eBay · IT: 177104, optional |
| Best offer auto-decline | `bestOfferCeiling` · scalar | channelListing · `attr_bestOfferCeiling`<br>`ChannelListing.platformAttributes.bestOfferCeiling` | eBay · IT: 177104, optional |

### Shipping (7)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Handling time (days) | `handlingTime` · scalar | channelListing · `attr_handlingTime`<br>`ChannelListing.platformAttributes.handlingTime` | eBay · IT: 177104, optional |
| Package type | `packageType` · scalar | channelListing · `attr_packageType`<br>`ChannelListing.platformAttributes.packageType` | eBay · IT: 177104, optional |
| Package weight | `packageWeight` · measure | channelListing · `attr_packageWeight`<br>`ChannelListing.platformAttributes.packageWeight + weightUnit` | eBay · IT: 177104, optional |
| Package length | `packageLength` · scalar | channelListing · `attr_packageLength`<br>`ChannelListing.platformAttributes.packageLength` | eBay · IT: 177104, optional |
| Package width | `packageWidth` · scalar | channelListing · `attr_packageWidth`<br>`ChannelListing.platformAttributes.packageWidth` | eBay · IT: 177104, optional |
| Package height | `packageHeight` · scalar | channelListing · `attr_packageHeight`<br>`ChannelListing.platformAttributes.packageHeight` | eBay · IT: 177104, optional |
| Package dimension unit | `dimensionUnit` · scalar | channelListing · `attr_dimensionUnit`<br>`ChannelListing.platformAttributes.dimensionUnit` | eBay · IT: 177104, optional |

### Policies (3)

| Label | Key · shape | Write target · route / declared store | Requirement and limits |
| --- | --- | --- | --- |
| Shipping policy id | `fulfillmentPolicyId` · scalar | channelListing · `attr_fulfillmentPolicyId`<br>`ChannelListing.platformAttributes.fulfillmentPolicyId` | eBay · IT: 177104, optional |
| Return policy id | `returnPolicyId` · scalar | channelListing · `attr_returnPolicyId`<br>`ChannelListing.platformAttributes.returnPolicyId` | eBay · IT: 177104, optional |
| Payment policy id | `paymentPolicyId` · scalar | channelListing · `attr_paymentPolicyId`<br>`ChannelListing.platformAttributes.paymentPolicyId` | eBay · IT: 177104, optional |
