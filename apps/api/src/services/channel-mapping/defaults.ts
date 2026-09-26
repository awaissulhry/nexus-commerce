/**
 * CHMAP (`docs/studies/channel-mappings.md` §8.5) — the shipped RULE DEFAULTS, as data.
 *
 * These tables used to live inside the readers. They are data, not logic: the Amazon and eBay readers, the mapping
 * draft builders and the export read them from here, so one list answers "what does this column mean" everywhere.
 * A business changes a decision for its own forms on the mapping screen (a mapping version), never here.
 * Plain values only — no imports, no functions.
 */

/**
 * Amazon's classic flat-file column ids → the attribute-path grammar of current templates (Amazon's documented
 * legacy → JSON rename, not a family or market rule). Old files carry no machine map of their own (their
 * `AttributePTDMAP` sheet only lists which ids apply to which product type — measured on the Owner's corpus
 * 2026-09-25). A key not listed falls back to "same name, `.value` leaf". `{n}` = the key's numeric suffix
 * (`bullet_point3` → slot 3).
 */
export const AMAZON_FLAT_FILE_KEYS: Readonly<Record<string, string>> = {
  item_sku: 'contribution_sku#1.value',
  feed_product_type: 'product_type#1.value',
  update_delete: '::record_action',
  external_product_id: 'amzn1.volt.ca.product_id_value',
  external_product_id_type: 'amzn1.volt.ca.product_id_type',
  parent_child: 'parentage_level#1.value',
  parent_sku: 'child_parent_sku_relationship#1.parent_sku',
  relationship_type: 'child_parent_sku_relationship#1.child_relationship_type',
  variation_theme: 'variation_theme#1.name',
  brand_name: 'brand#1.value',
  item_name: 'item_name#1.value',
  product_description: 'product_description#1.value',
  bullet_point: 'bullet_point#{n}.value',
  generic_keywords: 'generic_keyword#1.value',
  special_features: 'special_feature#{n}.value',
  target_audience_keywords: 'target_audience_keyword#{n}.value',
  material_type: 'material#{n}.value',
  occasion_type: 'occasion_type#{n}.value',
  sport_type: 'sport_type#{n}.value',
  supplier_declared_dg_hz_regulation: 'supplier_declared_dg_hz_regulation#{n}.value',
  supplier_declared_material_regulation: 'supplier_declared_material_regulation#{n}.value',
  main_image_url: 'main_product_image_locator#1.media_location',
  swatch_image_url: 'swatch_product_image_locator#1.media_location',
  other_image_url: 'other_product_image_locator_{n}#1.media_location',
  color_name: 'color#1.value',
  color_map: 'color#1.standardized_values#1',
  size_name: 'size#1.value',
  department_name: 'department#1.value',
  closure_type: 'closure#1.type#1.value',
  sleeve_type: 'sleeve#1.type#1.value',
  model: 'model_number#1.value',
  style_name: 'style#1.value',
  pattern_name: 'pattern#1.value',
  outer_material_type: 'outer#1.material#1.value',
  inner_material_type: 'inner#1.material#1.value',
  are_batteries_included: 'batteries_included#1.value',
  list_price_with_tax: 'list_price#1.value_with_tax',
  list_price: 'list_price#1.value',
  standard_price: 'purchasable_offer#1.our_price#1.schedule#1.value_with_tax',
  sale_price: 'purchasable_offer#1.discounted_price#1.schedule#1.value_with_tax',
  sale_from_date: 'purchasable_offer#1.discounted_price#1.schedule#1.start_at',
  sale_end_date: 'purchasable_offer#1.discounted_price#1.schedule#1.end_at',
  map_price: 'purchasable_offer#1.map_price#1.schedule#1.value_with_tax',
  offering_start_date: 'purchasable_offer#1.start_at.value',
  offering_end_date: 'purchasable_offer#1.end_at.value',
  currency: 'purchasable_offer#1.currency',
  quantity: 'fulfillment_availability#1.quantity',
  fulfillment_latency: 'fulfillment_availability#1.lead_time_to_ship_max_days',
  restock_date: 'fulfillment_availability#1.restock_date',
  fulfillment_center_id: 'fulfillment_availability#1.fulfillment_channel_code',
  merchant_shipping_group_name: 'merchant_shipping_group#1.value',
  offering_can_be_gift_messaged: 'gift_options#1.can_be_messaged',
  offering_can_be_giftwrapped: 'gift_options#1.can_be_wrapped',
  apparel_size_system: 'apparel_size#1.size_system', apparel_size_class: 'apparel_size#1.size_class', apparel_size: 'apparel_size#1.size',
  apparel_size_to: 'apparel_size#1.size_to', apparel_body_type: 'apparel_size#1.body_type', apparel_height_type: 'apparel_size#1.height_type',
  bottoms_size_system: 'bottoms_size#1.size_system', bottoms_size_class: 'bottoms_size#1.size_class', bottoms_size: 'bottoms_size#1.size',
  bottoms_size_to: 'bottoms_size#1.size_to', bottoms_body_type: 'bottoms_size#1.body_type', bottoms_height_type: 'bottoms_size#1.height_type',
  bottoms_waist_size: 'bottoms_size#1.waist_size', bottoms_inseam_size: 'bottoms_size#1.inseam_size',
  package_height: 'item_package_dimensions#1.height#1.value', package_length: 'item_package_dimensions#1.length#1.value',
  package_width: 'item_package_dimensions#1.width#1.value', package_weight: 'item_package_weight#1.value',
}

/** Our eBay listing workbook (the eBay flat-file page's export, current and legacy layouts): what each fixed column is. */
/**
 * CHMAP M7 — where a listing keeps its Amazon seller SKU, in reading order: the import's identity match
 * (`catalog-amazon-workbook.ts`) and the product-sheet push (`studio-publication-amazon.ts`) read the same places;
 * each adds its own offers (all offers on import, active offers on push).
 */
export const AMAZON_LISTING_SKU_KEYS = {
  platformAttributes: ['sellerSku', 'seller_sku', 'sku', 'item_sku'],
  flatFileSnapshot: ['item_sku'],
} as const

export const EBAY_WORKBOOK_COLUMNS = {
  /** Fixed listing columns → the eBay channel spec field they carry. */
  fixedFields: {
    Title: 'title', Subtitle: 'subtitle', Description: 'description', Condition: 'conditionId',
    'Category ID': 'categoryId', 'Variation Theme': 'variationTheme', 'Shared-SKU (Trading API)': 'sharedSkuListing',
    Format: 'listingFormat', Duration: 'listingDuration', 'Description Theme': 'descriptionThemeId',
    'Best Offer': 'bestOffer', 'BO Floor (EUR)': 'bestOfferFloor', 'BO Ceiling (EUR)': 'bestOfferCeiling',
    'VAT %': 'vatRate', 'Handling Days': 'handlingTime', Location: 'itemLocationCountry', 'Package Type': 'packageType',
    Weight: 'packageWeight', Length: 'packageLength', Width: 'packageWidth', Height: 'packageHeight',
    'Dim Unit': 'dimensionUnit', 'Video ID': 'videoId', 'Fulfillment Policy ID': 'fulfillmentPolicyId',
    'Payment Policy ID': 'paymentPolicyId', 'Return Policy ID': 'returnPolicyId',
  } as Readonly<Record<string, string>>,
  /** The headers that make a sheet "our eBay workbook", whatever it is called. */
  identityHeaders: ['SKU', 'Parent/Child', 'Parent SKU', 'Category ID'] as readonly string[],
  /** Listing identity: verified, never overwritten by a file. */
  coordinates: ['SKU', 'Parent/Child', 'Parent SKU', 'Item ID', 'Listing ID'] as readonly string[],
  quantityHeaders: ['Quantity', 'Qty'] as readonly string[],
  /** Listing controls and sync references: reference only. */
  controlHeaders: ['Follow', 'Buffer', 'Max Per Buyer', 'Merchant Location', 'Listing Status', 'Status', 'Last Pushed', 'Sync Status'] as readonly string[],
  /** Product identifiers beside the specifics; a category aspect of the same name still maps first. */
  identifierHeaders: ['EAN', 'MPN', 'UPC', 'ISBN'] as readonly string[],
  /** The weight unit travels with `Weight` as one measurement. */
  weightUnitHeader: 'Wt Unit',
  pricePattern: '^Price \\((?:€|EUR|£|GBP)\\)$',
  imagePattern: '^Image [1-9]\\d*$',
  /** Delete-like lifecycle words in the `Action` column, in the languages our workbooks use. */
  deleteActionPattern: '^(end|delete|withdraw|chiudi|termina|elimina|beenden|löschen|loschen|supprimer|terminer|retirer|finalizar|eliminar|retirar)\\b',
} as const

/**
 * NCF (`docs/studies/native-channel-files.md` §2, §7) — Shopify's own product CSV (admin → Products → Export).
 *
 * `header` is the CLASSIC name Shopify's export writes today — measured on the Owner's file (2026-09-26: 77 columns,
 * `Handle`, `Body (HTML)`, `Variant SKU`, `Variant Barcodes` …); the export writes these. `aliases` are the newer names
 * of Shopify's help-page sample (§2.1, S4 — not measured on a real export); the reader accepts both.
 * `role` is what the column is to Nexus; `field` the Shopify spec field a mapped column carries
 * (`pim/channel-specs/store.ts`, keys as `shopifyMappingFieldKey`); `level` says whether Shopify reads it from the first
 * row of a product (`product`) or from every variant row (`variant`). Headers are case-sensitive (S2).
 * Plain values only.
 */
export type ShopifyCsvRole =
  | 'handle' // the product's identity; groups its rows
  | 'sku' // the variant's identity
  | 'field' // a Shopify field Nexus carries (`field`)
  | 'price' | 'compareAt' // the one price door, record-only on import
  | 'option' // variant structure: never imported, always exported as Shopify holds it
  | 'lifecycle' // Status / Published: never imported
  | 'stock' // inventory: never imported, never exported
  | 'media' // pictures: Shopify keeps its media
  | 'cost' // product cost: Nexus pricing owns it
  | 'ignored' // a column Nexus does not carry
export interface ShopifyCsvColumn { header: string; aliases: readonly string[]; role: ShopifyCsvRole; level: 'product' | 'variant' | 'image'; field?: string; reason?: string }

/**
 * NCF — measured 2026-09-26: Nexus's Shopify `weight` field cannot take a value through a transfer. Its spec checks the
 * unit against `g, kg, oz, lb` (`channel-specs/store.ts`) while Shopify's own rule for the same field demands `GRAMS,
 * KILOGRAMS, OUNCES, POUNDS` (`nativeFieldValueError`), so every value fails one of the two. Until that is settled the
 * weight columns are left to Shopify.
 */
const WEIGHT = 'Weight is not carried by a file yet: Nexus’s Shopify weight field checks two unit vocabularies that disagree (g/kg/oz/lb and GRAMS/KILOGRAMS/…). Shopify keeps its weight; edit it in the Shopify tab.'

export const SHOPIFY_CSV_COLUMNS = {
  columns: [
    { header: 'Handle', aliases: ['URL handle'], role: 'handle', level: 'product' },
    { header: 'Title', aliases: [], role: 'field', level: 'product', field: 'title' },
    { header: 'Body (HTML)', aliases: ['Description'], role: 'field', level: 'product', field: 'descriptionHtml' },
    { header: 'Vendor', aliases: [], role: 'field', level: 'product', field: 'vendor' },
    { header: 'Product Category', aliases: ['Product category'], role: 'field', level: 'product', field: 'category' },
    { header: 'Type', aliases: [], role: 'field', level: 'product', field: 'productType' },
    { header: 'Tags', aliases: [], role: 'field', level: 'product', field: 'tags' },
    { header: 'Published', aliases: ['Published on online store'], role: 'lifecycle', level: 'product' },
    { header: 'Option1 Name', aliases: ['Option1 name'], role: 'option', level: 'product' },
    { header: 'Option1 Value', aliases: ['Option1 value'], role: 'option', level: 'variant' },
    { header: 'Option1 Linked To', aliases: ['Option1 linked to'], role: 'option', level: 'product' },
    { header: 'Option2 Name', aliases: ['Option2 name'], role: 'option', level: 'product' },
    { header: 'Option2 Value', aliases: ['Option2 value'], role: 'option', level: 'variant' },
    { header: 'Option2 Linked To', aliases: ['Option2 linked to'], role: 'option', level: 'product' },
    { header: 'Option3 Name', aliases: ['Option3 name'], role: 'option', level: 'product' },
    { header: 'Option3 Value', aliases: ['Option3 value'], role: 'option', level: 'variant' },
    { header: 'Option3 Linked To', aliases: ['Option3 linked to'], role: 'option', level: 'product' },
    { header: 'Variant SKU', aliases: ['SKU'], role: 'sku', level: 'variant' },
    { header: 'Variant Grams', aliases: ['Weight value (grams)'], role: 'ignored', level: 'variant', reason: WEIGHT },
    { header: 'Variant Inventory Tracker', aliases: ['Inventory tracker'], role: 'stock', level: 'variant' },
    { header: 'Variant Inventory Qty', aliases: ['Inventory quantity'], role: 'stock', level: 'variant' },
    { header: 'Variant Inventory Policy', aliases: ['Continue selling when out of stock'], role: 'field', level: 'variant', field: 'inventoryPolicy' },
    { header: 'Variant Fulfillment Service', aliases: ['Fulfillment service'], role: 'stock', level: 'variant' },
    { header: 'Variant Price', aliases: ['Price'], role: 'price', level: 'variant' },
    { header: 'Variant Compare At Price', aliases: ['Compare-at price'], role: 'compareAt', level: 'variant' },
    { header: 'Variant Requires Shipping', aliases: ['Requires shipping'], role: 'field', level: 'variant', field: 'requiresShipping' },
    { header: 'Variant Taxable', aliases: ['Charge tax'], role: 'field', level: 'variant', field: 'taxable' },
    { header: 'Unit Price Total Measure', aliases: ['Unit price total measure'], role: 'ignored', level: 'variant', reason: 'Unit prices are not carried by Nexus; Shopify keeps its own.' },
    { header: 'Unit Price Total Measure Unit', aliases: ['Unit price total measure unit'], role: 'ignored', level: 'variant', reason: 'Unit prices are not carried by Nexus; Shopify keeps its own.' },
    { header: 'Unit Price Base Measure', aliases: ['Unit price base measure'], role: 'ignored', level: 'variant', reason: 'Unit prices are not carried by Nexus; Shopify keeps its own.' },
    { header: 'Unit Price Base Measure Unit', aliases: ['Unit price base measure unit'], role: 'ignored', level: 'variant', reason: 'Unit prices are not carried by Nexus; Shopify keeps its own.' },
    { header: 'Variant Barcodes', aliases: ['Variant Barcode', 'Barcodes', 'Barcode'], role: 'field', level: 'variant', field: 'barcode' },
    { header: 'Image Src', aliases: ['Product image URL'], role: 'media', level: 'image' },
    { header: 'Image Position', aliases: ['Image position'], role: 'media', level: 'image' },
    { header: 'Image Alt Text', aliases: ['Image alt text'], role: 'media', level: 'image' },
    { header: 'Gift Card', aliases: ['Gift card'], role: 'ignored', level: 'product', reason: 'Gift cards are not sold through Nexus; Shopify keeps the setting.' },
    { header: 'SEO Title', aliases: ['SEO title'], role: 'field', level: 'product', field: 'seo_title' },
    { header: 'SEO Description', aliases: ['SEO description'], role: 'field', level: 'product', field: 'seo_description' },
    { header: 'Variant Image', aliases: ['Variant image URL'], role: 'media', level: 'variant' },
    { header: 'Variant Weight Unit', aliases: ['Weight unit for display'], role: 'ignored', level: 'variant', reason: WEIGHT },
    { header: 'Variant Tax Code', aliases: ['Tax code'], role: 'ignored', level: 'variant', reason: 'Shopify tax codes are not carried by Nexus; Shopify keeps its own.' },
    { header: 'Cost per item', aliases: [], role: 'cost', level: 'variant' },
    { header: 'Status', aliases: [], role: 'lifecycle', level: 'product' },
    { header: 'Collection', aliases: [], role: 'ignored', level: 'product', reason: 'Collections are managed in Shopify, not by the product file.' },
  ] as readonly ShopifyCsvColumn[],
  /** Shopify's Google Shopping app columns and its per-market columns: not carried by Nexus. */
  ignoredPatterns: [
    { pattern: '^Google Shopping / ', level: 'product', reason: 'Google Shopping app columns are not carried by Nexus; Shopify keeps them.' },
    { pattern: '^(Included|Price|Compare-at price|Compare At Price) / ', level: 'variant', reason: 'Market prices and market inclusion are managed in Shopify Markets, not by Nexus.' },
  ] as readonly { pattern: string; level: ShopifyCsvColumn['level']; reason: string }[],
  /** The headers that make a CSV Shopify's product file (any spelling in the list). */
  identity: { handle: ['Handle', 'URL handle'], title: ['Title'], variant: ['Variant SKU', 'SKU', 'Option1 Name', 'Option1 name'],
    product: ['Body (HTML)', 'Description', 'Variant Price', 'Price', 'Vendor'] },
  /** Shopify's inventory export (quantities by location): refused, stock is never imported from a file. */
  inventoryHeaders: ['Location', 'On hand', 'On hand (current)', 'On hand (new)', 'Available', 'Available (not editable)', 'Incoming', 'Incoming (not editable)', 'Committed', 'Committed (not editable)', 'Unavailable', 'Unavailable (not editable)', 'COO', 'HS Code'],
  /** A list metafield's values are separated by `; ` in Shopify's CSV (S1). */
  listSeparator: '; ',
} as const
