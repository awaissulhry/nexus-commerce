# Shopify attribute mapping verification

Verified 338 Nexus products against `xaviaracing.myshopify.com`. The active catalogue has **70 destinations**: 31 native columns (30 logical attributes, with available/on-hand inventory separated) and 39 live metafields. Ten destinations have saved Master rules; 60 retain explicit store/listing ownership. No destination lacks a declared source.

Mapping coverage describes source connections, not complete or verified product content. The selected GALE family is not linked to remote Shopify product/variant identities, so its store-owned values remain unset. No fuzzy SKU or label match was used.

## Saved Master rules

| Shopify column | Nexus source | Products with a value |
|---|---|---:|
| Description | description | 0/338 |
| Product type | shopify_product_type | 0/338 |
| Title | title in the selected content language; fallback to name | 338/338 |
| Vendor | brand | 315/338 |
| Base price | basePrice | 338/338 |
| Cost | costPrice | 0/338 |
| SKU | sku | 338/338 |
| Country of origin | countryOfOrigin | 21/338 |
| Harmonized system code | hsCode | 0/338 |
| Weight | weightValue + weightUnit, with explicit unit spelling normalization | 0/338 |

Existing store overrides take precedence, including explicit clears, zero prices, and false booleans. Vendor inherits Brand by default. Shopify Product type uses the new `shopify_product_type` Master definition, attached to the product families; Amazon product type and category assignments are separate. Native source rules are shared across Shopify stores; per-listing overrides remain scoped to their account and alias.

## Dynamic metafields

Metafield identities include connected account, owner type, namespace, key, and type. Renames preserve rule identity; deletion or type changes retire the old rule from the active catalogue without erasing its stored history. Review activation rechecks the observed live schema revision. The definition name remains the visible column name.

These sources are store-owned. Reference fields require actual Shopify record IDs and definition-compatible objects; text from similarly named Nexus attributes is not substituted. Typed mappings are checked against live definition constraints; the linked Shopify editor remains responsible for remote reference verification and writes.

| Name | Owner | Shopify address | Type |
|---|---|---|---|
| Rubik Configuration | Product | `craftshift.rubik_configuration` | `single_line_text_field` |
| Rubik swatch image | Variant | `craftshift.swatch_image` | `file_reference` |
| Rubik swatch color | Variant | `craftshift.swatch_color` | `color` |
| Features | Product | `custom.features` | `list.metaobject_reference` |
| Concise description | Product | `custom.concise_description` | `metaobject_reference` |
| Text with icon | Product | `custom.text_with_icon` | `list.metaobject_reference` |
| Media with text product page | Product | `custom.media_with_text_product_page` | `list.metaobject_reference` |
| Search product boosts | Product | `shopify--discovery--product_search_boost.queries` | `list.single_line_text_field` |
| Related products | Product | `shopify--discovery--product_recommendation.related_products` | `list.product_reference` |
| Related products settings | Product | `shopify--discovery--product_recommendation.related_products_display` | `single_line_text_field` |
| Complementary products | Product | `shopify--discovery--product_recommendation.complementary_products` | `list.product_reference` |
| Complementary products heading | Product | `custom.complementary_products_heading` | `metaobject_reference` |
| Scrolling text product page | Product | `custom.scrolling_text_product_page` | `metaobject_reference` |
| Video product page | Product | `custom.video_product_page` | `metaobject_reference` |
| Press product page | Product | `custom.press_product_page` | `list.metaobject_reference` |
| Multiple images with text product page | Product | `custom.multiple_images_with_text_product_page` | `list.metaobject_reference` |
| Media grid product page | Product | `custom.media_grid_product_page` | `list.metaobject_reference` |
| Slideshow product page | Product | `custom.slideshow_product_page` | `list.metaobject_reference` |
| Variant Sort Order | Variant | `custom.variant_sort_order` | `number_integer` |
| Variation value | Product | `custom.variation_value` | `single_line_text_field` |
| Variation products | Product | `custom.variation_products` | `list.product_reference` |
| Collapsible text | Product | `custom.collapsible_text` | `list.metaobject_reference` |
| Size Chart | Product | `custom.size_chart` | `page_reference` |
| Custom Button product page | Product | `custom.custom_button_product_page` | `metaobject_reference` |
| Product rating | Product | `reviews.rating` | `rating` |
| Product rating count | Product | `reviews.rating_count` | `number_integer` |
| Google: Custom Product | Product | `mm-google-shopping.custom_product` | `boolean` |
| Google: Custom Label 4 | Variant | `mm-google-shopping.custom_label_4` | `single_line_text_field` |
| Google: Custom Label 3 | Variant | `mm-google-shopping.custom_label_3` | `single_line_text_field` |
| Google: Custom Label 2 | Variant | `mm-google-shopping.custom_label_2` | `single_line_text_field` |
| Google: Custom Label 1 | Variant | `mm-google-shopping.custom_label_1` | `single_line_text_field` |
| Google: Custom Label 0 | Variant | `mm-google-shopping.custom_label_0` | `single_line_text_field` |
| Google: Size System | Variant | `mm-google-shopping.size_system` | `single_line_text_field` |
| Google: Size Type | Variant | `mm-google-shopping.size_type` | `single_line_text_field` |
| Google: MPN | Variant | `mm-google-shopping.mpn` | `single_line_text_field` |
| Google: Gender | Variant | `mm-google-shopping.gender` | `single_line_text_field` |
| Google: Condition | Variant | `mm-google-shopping.condition` | `single_line_text_field` |
| Google: Age Group | Variant | `mm-google-shopping.age_group` | `single_line_text_field` |
| Color | Product | `shopify.color-pattern` | `list.metaobject_reference` |

## Data gaps and boundaries

- All 338 products currently lack descriptions, cost, weight, HS code, and the new Shopify Product type source in this resolver. The mappings are present; no product values were fabricated.
- Brand is missing on 23 products. Observed spellings include `Xavia Racing`, `Xavia`, and `XAVIA RACING WWW.XAVIARACING.IT`. These were preserved for business review.
- Country of origin is populated on 21 products and missing on 317. Zero base prices remain zero; they are not treated as missing.
- Shopify Status is not derived from the Nexus product lifecycle. Inventory quantity is not derived from aggregate stock without a selected inventory location. Barcodes, publications, package IDs and references keep their own ownership.
- The local API does not have the public HTTPS callback needed to activate Shopify schema webhooks. Definition reads and the 30-second refresh fallback remain available; live webhook delivery still requires deployment verification.
- Application changes are local. The ten mapping rules and one Master definition were saved in Nexus; no Shopify products were published or altered by this work.

## Evidence

- `mapping-plan.json`: exact ten rules and the added Master definition.
- `mapping-activation.json`: durable review `cmtv69mnb0007njxn2gg63g7x`, MAPPING_APPLIED; 338 products scanned, zero invalid or newly invalid outputs, zero product-value changes.
- `mapping-verification.json`: final catalogue, populated/empty counts, and product-sheet values. No mapping resolver timeout or skipped products in the GALE sheet.
- 185 API tests and 25 web tests passed. API/web TypeScript checks, shared package build, web/factory token checks, AG Grid boundary, and raw primitive ratchet passed.
- Browser verification used the actual local editor and mapping page. Product type opens its attribute rule; Enter opens and Escape closes the dialog without saving. The dynamic Features field shows `custom.features` and scopes its rule to the connected store. In dark mode at 390 px, the settled dialog spans x=0..390 with no page overflow. Normal viewport and light mode were restored.

Repeat the read-only audit from `apps/api`:

```sh
../../node_modules/.bin/tsx ../../docs/audits/2026-09-10-shopify-attributes/read-mapping.mts --verify
```

## Nexus display names (follow-up)

The Shopify information registry now displays the confirmed Nexus equivalents: Vendor → Brand,
Title → Name, and Harmonized system code → HS code. These are display changes; the destination
keys, source mappings, storage paths, and edit/publish contracts are unchanged. Earlier tables
and JSON evidence retain the names observed during mapping activation.

The linked information grid, unlinked product sheet, column chooser, and mapping catalogue use
the same labels. Header help and mapping details retain the original Shopify terminology, and
the mapping search and linked column search accept both names. Metafield names still come from
the selected store's live definitions; they are never renamed by the native display dictionary.

Verification: 52 focused tests passed (18 shared, 20 API, 14 web), including schema rename/delete,
store isolation, column projection, and existing edit contracts. Shared build, API/web type checks,
web/Factory token checks, AG Grid import boundary and raw primitive ratchet passed. The actual
local GALE product sheet and column chooser show Name, Brand and HS code; all 39 live metafield
names remain present. Searching Vendor opens Brand in the mapping catalogue, whose keyboard-opened
drawer shows “Shopify: Vendor” and returns focus to Brand on Escape. Checked desktop light and
900px dark presentation without page overflow. No product values, mapping rules or column layouts
were saved during this follow-up.
