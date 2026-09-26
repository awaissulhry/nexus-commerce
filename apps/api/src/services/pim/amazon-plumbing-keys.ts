import { CONTENT_ROOTS } from '../channel-drift/amazon-content-compare.js'

/**
 * Amazon schema keys that are NOT a product attribute a business's Shared set should hold: content (handled by the
 * locale section), identity (the identity card), and offer / fulfillment / variation / envelope plumbing. Code-defined,
 * so it answers the same for a business with no Amazon connection (no cached schema of its own to read).
 *
 * Read by the master attribute schema (`master-schema.service.ts`, which surfaces only genuine product attributes:
 * material, color, size, care, armor, …; content keys still import as content via MA.7's FLATFILE_CONTENT map) and by
 * the Shared view's saved-key filter (`sharedSavedFields`, `family-sheet-schema.ts`).
 */
export const AMAZON_NON_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  // content → locale/content section
  ...CONTENT_ROOTS,
  // identity → identity card
  'brand', 'manufacturer',
  'externally_assigned_product_identifier', 'supplier_declared_has_product_identifier_exemption', 'merchant_suggested_asin',
  // offer / price / fulfillment plumbing
  'purchasable_offer', 'list_price', 'condition_type', 'condition_note',
  'fulfillment_availability', 'merchant_shipping_group', 'max_order_quantity', 'main_offer_image_locator',
  // variation / browse / envelope plumbing
  'parentage_level', 'child_parent_sku_relationship', 'variation_theme', 'skip_offer',
  'recommended_browse_nodes', 'browse_node', 'item_type_keyword', 'product_tax_code',
])
