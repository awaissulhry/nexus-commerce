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
