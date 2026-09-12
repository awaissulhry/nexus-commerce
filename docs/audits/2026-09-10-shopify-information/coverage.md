# Field mapping and coverage

Read-only store discovery: 2026-09-10T05:35:29.857Z. All 60 audit labels are retained. Inventory quantity expands to two physical headers. The connected store also exposes 16 additional definitions.

This is implementation coverage, not proof of 60 Shopify mutation round-trips. 14 native scalar fields, one gallery reorder workflow and 23 definition-backed fields are enabled; 22 audited fields remain read-only. The seven unknown category keys are intentionally unresolved.

| # | Label | Group | Owner / adapter target | Observed UI token or namespace.key | Discovered type | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Product title | General | Product.title | implicit | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 2 | Description | General | Product.descriptionHtml | description | multi_line_text_field | HTML source editor; rich composition and sanitizer integration incomplete |
| 3 | Product media | General | Product.media associations → productReorderMedia | media | media | Reorder, preview, async job checkpoint and verification; attachment and shared-file editing incomplete |
| 4 | Tags | General | Product.tags | tags | list.single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 5 | Status | General | Product.status | status | status | Read-only / capability not connected. Use the publication workspace to change status after reviewing channel visibility. |
| 6 | Product category | General | Product.category | product_taxonomy_node_id | category | Read-only / capability not connected. Category changes require an applicability review. Manage the category in Shopify. |
| 7 | Product type | General | Product.productType | product_type | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 8 | Vendor | General | Product.vendor | vendor | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 9 | Template | General | Product.templateSuffix | template_suffix | single_line_text_field | Read-only / capability not connected. Available templates must be discovered from the active store theme. Manage the template in Shopify. |
| 10 | Sales channels | Publishing | Product resource publications; variant publication needs verification | sales_channels | publication | Read-only / capability not connected. Use Shopify to manage publications. Variant publication writes are not enabled. |
| 11 | Online store schedule | Publishing | Publication schedule | online_store_scheduled | boolean | Read-only / capability not connected. Publication scheduling is not connected to this editor. Manage it in Shopify. |
| 12 | Publish date | Publishing | Publication publishDate + store timezone | online_store_publish_date | date_time | Read-only / capability not connected. Publication scheduling requires the store timezone and publication identity. Manage it in Shopify. |
| 13 | Base price | Pricing | ProductVariant.price | variants.price | money | Implemented scoped scalar draft and patch adapter |
| 14 | Unit price | Pricing | ProductVariant.unitPriceMeasurement | variants.unit_price_measurement | measurement | Read-only / capability not connected. Unit-price measurement editing is not connected. Its existing value is preserved. |
| 15 | Compare-at price | Pricing | ProductVariant.compareAtPrice | variants.compare_at_price | money | Implemented scoped scalar draft and patch adapter |
| 16 | Cost per item | Pricing | InventoryItem.unitCost | variants.cost | money | Read-only / capability not connected. Inventory-item cost uses its own permission and currency context. Manage it in Shopify. |
| 17 | Charge taxes | Pricing | ProductVariant.taxable | variants.taxable | boolean | Implemented scoped scalar draft and patch adapter |
| 18 | SKU | Inventory | ProductVariant.inventoryItem.sku | variants.sku | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 19 | Barcodes | Inventory | ProductVariant.barcode (single in 2026-07) | variants.barcode | single_line_text_field | Read-only / capability not connected. This connector uses Shopify API 2026-07. Multiple typed barcodes require 2026-10. Manage barcodes in Shopify; secondary entries are never replaced here. |
| 20 | Inventory quantity | Inventory | InventoryItem + location + quantity state | variants.inventory_on_hand_adjustment | inventory | Read-only / capability not connected. Choose an inventory location in the stock workspace. Available and on-hand quantities cannot be set independently here. |
| 21 | Continue selling when out of stock | Inventory | ProductVariant.inventoryPolicy | variants.inventory_policy | inventory_policy | Implemented scoped scalar draft and patch adapter |
| 22 | Track quantity | Inventory | InventoryItem.tracked | variants.inventory_management | boolean | Read-only / capability not connected. Tracking changes require inventory authority. Manage tracking in Shopify. |
| 23 | Package | Shipping | Variant package identifier (not discovered) | variants.defaultPackage | package | Read-only / capability not connected. Store package identifiers and the package adapter are not available. Manage the package in Shopify. |
| 24 | Weight | Shipping | InventoryItem.measurement.weight | variants.weight | weight | Read-only / capability not connected. Weight units and inventory-item measurement changes are preserved. Manage them in Shopify. |
| 25 | Physical product | Shipping | InventoryItem.requiresShipping | variants.requires_shipping | boolean | Implemented scoped scalar draft and patch adapter |
| 26 | Harmonized system code | Shipping | InventoryItem.harmonizedSystemCode | variants.metafields_global_harmonized_system_code | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 27 | Country of origin | Shipping | InventoryItem.countryCodeOfOrigin | variants.country_code_of_origin | country | Read-only / capability not connected. The canonical country picker is not connected. Manage origin in Shopify. |
| 28 | Page title (SEO) | SEO | Product.seo.title | metafields_global_title_tag | single_line_text_field | Implemented scoped scalar draft and patch adapter |
| 29 | Meta description (SEO) | SEO | Product.seo.description | metafields_global_description_tag | multi_line_text_field | Implemented scoped scalar draft and patch adapter |
| 30 | URL handle (SEO) | SEO | Product.handle + redirect policy | handle | handle | Read-only / capability not connected. Handle changes need a collision check and redirect decision. Manage the URL in Shopify. |
| 31 | Size Chart | Metafields | PRODUCT metafield custom.size_chart | custom.size_chart | page_reference | Implemented typed editor and existing metafield pipeline |
| 32 | Variation value | Metafields | PRODUCT metafield custom.variation_value | custom.variation_value | single_line_text_field | Implemented typed editor and existing metafield pipeline |
| 33 | Variation products | Metafields | PRODUCT metafield custom.variation_products | custom.variation_products | list.product_reference | Implemented typed editor and existing metafield pipeline |
| 34 | Concise description | Metafields | PRODUCT metafield custom.concise_description | custom.concise_description | metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 35 | Custom Button product page | Metafields | PRODUCT metafield custom.custom_button_product_page | custom.custom_button_product_page | metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 36 | Features | Metafields | PRODUCT metafield custom.features | custom.features | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 37 | Collapsible text | Metafields | PRODUCT metafield custom.collapsible_text | custom.collapsible_text | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 38 | Complementary products heading | Metafields | PRODUCT metafield custom.complementary_products_heading | custom.complementary_products_heading | metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 39 | Text with icon | Metafields | PRODUCT metafield custom.text_with_icon | custom.text_with_icon | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 40 | Media with text product page | Metafields | PRODUCT metafield custom.media_with_text_product_page | custom.media_with_text_product_page | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 41 | Scrolling text product page | Metafields | PRODUCT metafield custom.scrolling_text_product_page | custom.scrolling_text_product_page | metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 42 | Video product page | Metafields | PRODUCT metafield custom.video_product_page | custom.video_product_page | metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 43 | Press product page | Metafields | PRODUCT metafield custom.press_product_page | custom.press_product_page | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 44 | Multiple images with text product page | Metafields | PRODUCT metafield custom.multiple_images_with_text_product_page | custom.multiple_images_with_text_product_page | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 45 | Media grid product page | Metafields | PRODUCT metafield custom.media_grid_product_page | custom.media_grid_product_page | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 46 | Slideshow product page | Metafields | PRODUCT metafield custom.slideshow_product_page | custom.slideshow_product_page | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 47 | Complementary products | Metafields | PRODUCT metafield shopify--discovery--product_recommendation.complementary_products | shopify--discovery--product_recommendation.complementary_products | list.product_reference | Implemented typed editor and existing metafield pipeline |
| 48 | Related products settings | Metafields | PRODUCT metafield shopify--discovery--product_recommendation.related_products_display | shopify--discovery--product_recommendation.related_products_display | single_line_text_field | Implemented typed editor and existing metafield pipeline |
| 49 | Related products | Metafields | PRODUCT metafield shopify--discovery--product_recommendation.related_products | shopify--discovery--product_recommendation.related_products | list.product_reference | Implemented typed editor and existing metafield pipeline |
| 50 | Search product boosts | Metafields | PRODUCT metafield shopify--discovery--product_search_boost.queries | shopify--discovery--product_search_boost.queries | list.single_line_text_field | Implemented typed editor and existing metafield pipeline |
| 51 | Rubik Configuration | Metafields | PRODUCT metafield craftshift.rubik_configuration | craftshift.rubik_configuration | single_line_text_field | Implemented typed editor and existing metafield pipeline |
| 52 | Google: Custom Product | Metafields | PRODUCT metafield mm-google-shopping.custom_product | mm-google-shopping.custom_product | boolean | Implemented typed editor and existing metafield pipeline |
| 53 | Color | Category Metafields | PRODUCT metafield shopify.color-pattern | shopify.color-pattern | list.metaobject_reference | Implemented typed editor and existing metafield pipeline |
| 54 | Age group | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 55 | Target gender | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 56 | Care instructions | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 57 | Fabric | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 58 | Size | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 59 | Clothing features | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |
| 60 | Size type | Category Metafields | Category definition discovery required | Not supplied; not invented | unknown | Read-only / capability not connected. This store definition is unavailable. Refresh definitions or manage the field in Shopify; no key or type is assumed. |

## Persistence and ownership

- Native product fields use narrow `productUpdate` patches. Variant fields use `productVariantsBulkUpdate` with one variant ID; SKU, physical-shipping and HS code are nested in `inventoryItem`.
- Metafields retain owner, namespace, key, declared type, serialization and compare digest. Referenced entries have an independent save boundary in the existing entry service.
- Gallery order retains media association IDs. The operation checkpoints submission before calling Shopify, checkpoints the returned job, waits for completion, and re-reads order. A timeout is reconciled before any retry.
- Saved intent and durable progress remain in the existing ChannelListing JSON workspace. AuditLog captures actor, scope, reviewed before/after commands, operation ID and outcome. These are channel-specific Shopify edits; they do not rewrite the shared PIM catalog.
- Inventory, status/publications, scheduling, category assignment, packages and multi-barcode writes are unavailable here. The interface explains the fallback. This does not mean every one of those operations is unavailable in Shopify itself.
