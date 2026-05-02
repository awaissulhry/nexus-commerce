/**
 * Field registry — single source of truth for which fields exist on
 * the Product table, plus channel-scoped and category-scoped extras.
 *
 * Phase D scope split:
 *   D.1 (this file): static registry + getAvailableFields()
 *   D.2 client column selector consumes /api/pim/fields
 *   D.3 backend bulk-patch endpoint extends to handle channel-prefixed
 *       and attr_-prefixed field IDs (writes to ChannelListing /
 *       Product.categoryAttributes JSON respectively). Until then,
 *       channel/category fields are returned with editable: false so
 *       the column selector can show them but the bulk-patch won't
 *       silently accept writes against them.
 *
 * Field IDs that match a Product column directly (e.g. `name`,
 * `basePrice`) are editable per the existing ALLOWED_FIELDS in
 * products.routes.ts. Field IDs with `amazon_*` / `ebay_*` / `attr_*`
 * prefixes are namespaced and require additional write logic.
 */

export type FieldType = 'text' | 'number' | 'select' | 'boolean' | 'date'

export type FieldCategory =
  | 'universal'
  | 'pricing'
  | 'inventory'
  | 'identifiers'
  | 'physical'
  | 'content'
  | 'amazon'
  | 'ebay'
  | 'category'

export interface FieldDefinition {
  /** Either a Product column name (writes via bulk-patch) or a
   *  prefixed virtual field (amazon_*, ebay_*, attr_*). */
  id: string
  label: string
  type: FieldType
  category: FieldCategory
  /** Filled in for category-prefixed fields (`attr_*`); a Product
   *  must have a productType matching one of these for the field to
   *  apply. Empty/null = no productType filter. */
  productTypes?: string[]
  /** For channel-scoped fields (`amazon_*`, `ebay_*`). */
  channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  /** Marketplace scope where applicable. */
  marketplaces?: string[]
  /** Allowed values for select fields. */
  options?: string[]
  /** Default column width in px for the bulk-ops table. */
  width?: number
  editable: boolean
  required?: boolean
  helpText?: string
}

// ── Universal: applies to every product, every channel ────────────────
const UNIVERSAL_FIELDS: FieldDefinition[] = [
  { id: 'sku', label: 'SKU', type: 'text', category: 'universal', editable: false, width: 220, helpText: 'Unique product identifier; not editable in bulk' },
  { id: 'name', label: 'Name', type: 'text', category: 'universal', editable: true, width: 380, required: true },
  { id: 'brand', label: 'Brand', type: 'text', category: 'universal', editable: true, width: 160 },
  { id: 'manufacturer', label: 'Manufacturer', type: 'text', category: 'universal', editable: true, width: 160 },
  { id: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'DRAFT', 'INACTIVE'], category: 'universal', editable: true, width: 110 },
  { id: 'productType', label: 'Product Type', type: 'text', category: 'universal', editable: false, width: 130, helpText: 'Set via Amazon import; drives category-specific fields' },
]

// ── Pricing ────────────────────────────────────────────────────────────
const PRICING_FIELDS: FieldDefinition[] = [
  { id: 'basePrice', label: 'Base Price', type: 'number', category: 'pricing', editable: true, width: 100 },
  { id: 'costPrice', label: 'Cost', type: 'number', category: 'pricing', editable: true, width: 100 },
  { id: 'minMargin', label: 'Min Margin %', type: 'number', category: 'pricing', editable: true, width: 110 },
  { id: 'minPrice', label: 'Min Price', type: 'number', category: 'pricing', editable: true, width: 100 },
  { id: 'maxPrice', label: 'Max Price', type: 'number', category: 'pricing', editable: true, width: 100 },
  { id: 'buyBoxPrice', label: 'Buy Box', type: 'number', category: 'pricing', editable: false, width: 100, helpText: 'Read-only; synced from Amazon' },
  { id: 'competitorPrice', label: 'Competitor', type: 'number', category: 'pricing', editable: false, width: 100, helpText: 'Read-only; synced from Amazon' },
]

// ── Inventory ─────────────────────────────────────────────────────────
const INVENTORY_FIELDS: FieldDefinition[] = [
  { id: 'totalStock', label: 'Stock', type: 'number', category: 'inventory', editable: true, width: 90 },
  { id: 'lowStockThreshold', label: 'Low Stock Alert', type: 'number', category: 'inventory', editable: true, width: 110 },
  { id: 'fulfillmentChannel', label: 'Fulfillment', type: 'select', options: ['FBA', 'FBM'], category: 'inventory', editable: true, width: 100 },
  { id: 'shippingTemplate', label: 'Shipping Template', type: 'text', category: 'inventory', editable: false, width: 160 },
]

// ── Identifiers ───────────────────────────────────────────────────────
const IDENTIFIER_FIELDS: FieldDefinition[] = [
  { id: 'upc', label: 'UPC', type: 'text', category: 'identifiers', editable: true, width: 130 },
  { id: 'ean', label: 'EAN', type: 'text', category: 'identifiers', editable: true, width: 130 },
  { id: 'amazonAsin', label: 'ASIN', type: 'text', category: 'identifiers', editable: false, width: 110 },
  { id: 'parentAsin', label: 'Parent ASIN', type: 'text', category: 'identifiers', editable: false, width: 110 },
  { id: 'ebayItemId', label: 'eBay Item ID', type: 'text', category: 'identifiers', editable: false, width: 130 },
]

// ── Physical attributes ───────────────────────────────────────────────
const PHYSICAL_FIELDS: FieldDefinition[] = [
  { id: 'weightValue', label: 'Weight', type: 'number', category: 'physical', editable: true, width: 90 },
  { id: 'weightUnit', label: 'Wt Unit', type: 'select', options: ['kg', 'g', 'lb', 'oz'], category: 'physical', editable: false, width: 80, helpText: 'Bulk-patch enforces gram base; per-row edit via product page for now' },
  { id: 'dimLength', label: 'Length', type: 'number', category: 'physical', editable: false, width: 90 },
  { id: 'dimWidth', label: 'Width', type: 'number', category: 'physical', editable: false, width: 90 },
  { id: 'dimHeight', label: 'Height', type: 'number', category: 'physical', editable: false, width: 90 },
  { id: 'dimUnit', label: 'Dim Unit', type: 'select', options: ['cm', 'mm', 'in'], category: 'physical', editable: false, width: 80 },
]

// ── Channel-scoped fields ─────────────────────────────────────────────
// D.3d: amazon_title / amazon_description / ebay_title / ebay_description
// are now editable. They map directly to ChannelListing columns.
// The other amazon_*/ebay_* fields stay editable: false until ChannelListing
// schema gains the corresponding columns (bulletPointsOverride array
// handling, search keywords, browse node, listing format / duration).
const AMAZON_FIELDS: FieldDefinition[] = [
  {
    id: 'amazon_title',
    label: 'Amazon Title',
    type: 'text',
    channel: 'AMAZON',
    category: 'amazon',
    editable: true,
    width: 250,
    helpText: 'ChannelListing.title for the active marketplace. 200 char max per Amazon spec.',
  },
  {
    id: 'amazon_description',
    label: 'Amazon Description',
    type: 'text',
    channel: 'AMAZON',
    category: 'amazon',
    editable: true,
    width: 320,
    helpText: 'ChannelListing.description for the active marketplace.',
  },
  { id: 'amazon_bullets', label: 'Amazon Bullets', type: 'text', channel: 'AMAZON', category: 'amazon', editable: false, width: 300, helpText: 'Bullet array writes ship in a follow-up phase' },
  { id: 'amazon_searchKeywords', label: 'Search Keywords', type: 'text', channel: 'AMAZON', category: 'amazon', editable: false, width: 250, helpText: 'No backing column yet' },
  { id: 'amazon_browseNode', label: 'Browse Node', type: 'text', channel: 'AMAZON', category: 'amazon', editable: false, width: 130, helpText: 'No backing column yet' },
]

const EBAY_FIELDS: FieldDefinition[] = [
  {
    id: 'ebay_title',
    label: 'eBay Title',
    type: 'text',
    channel: 'EBAY',
    category: 'ebay',
    editable: true,
    width: 250,
    helpText: 'ChannelListing.title for the active marketplace. 80 char max per eBay spec.',
  },
  {
    id: 'ebay_description',
    label: 'eBay Description',
    type: 'text',
    channel: 'EBAY',
    category: 'ebay',
    editable: true,
    width: 320,
    helpText: 'ChannelListing.description for the active marketplace.',
  },
  { id: 'ebay_format', label: 'Listing Format', type: 'select', options: ['FixedPrice', 'Auction', 'StoreInventory'], channel: 'EBAY', category: 'ebay', editable: false, width: 130, helpText: 'No backing column yet' },
  { id: 'ebay_duration', label: 'Duration', type: 'select', options: ['GTC', 'Days_7', 'Days_30'], channel: 'EBAY', category: 'ebay', editable: false, width: 100, helpText: 'No backing column yet' },
]

// ── Category-specific (e.g. OUTERWEAR, HELMET) ────────────────────────
// All editable: false in D.1 — these write to Product.categoryAttributes
// JSON which needs custom write logic in D.3.
const CATEGORY_FIELDS_BY_TYPE: Record<string, FieldDefinition[]> = {
  OUTERWEAR: [
    { id: 'attr_armorType', label: 'Armor Type', type: 'select', options: ['Level 1', 'Level 2', 'No Armor'], category: 'category', productTypes: ['OUTERWEAR'], editable: false, width: 120 },
    { id: 'attr_ceCertification', label: 'CE Certification', type: 'text', category: 'category', productTypes: ['OUTERWEAR'], editable: false, width: 140 },
    { id: 'attr_waterproofRating', label: 'Waterproof', type: 'select', options: ['Yes', 'Water Resistant', 'No'], category: 'category', productTypes: ['OUTERWEAR'], editable: false, width: 130 },
  ],
  HELMET: [
    { id: 'attr_dotCertification', label: 'DOT', type: 'text', category: 'category', productTypes: ['HELMET'], editable: false, width: 100 },
    { id: 'attr_eceNumber', label: 'ECE', type: 'text', category: 'category', productTypes: ['HELMET'], editable: false, width: 100 },
    { id: 'attr_helmetType', label: 'Type', type: 'select', options: ['Full Face', 'Modular', 'Open Face', 'Off-Road'], category: 'category', productTypes: ['HELMET'], editable: false, width: 120 },
  ],
}

function getCategorySpecificFields(productType: string): FieldDefinition[] {
  return CATEGORY_FIELDS_BY_TYPE[productType.toUpperCase()] ?? []
}

interface AvailableFieldsParams {
  productTypes?: string[]
  channels?: string[]
  marketplaces?: string[]
}

/**
 * Compose the field set for a given context. The order matters — column
 * selectors and templates render in this order by default.
 */
export function getAvailableFields(params: AvailableFieldsParams = {}): FieldDefinition[] {
  const fields: FieldDefinition[] = [
    ...UNIVERSAL_FIELDS,
    ...PRICING_FIELDS,
    ...INVENTORY_FIELDS,
    ...IDENTIFIER_FIELDS,
    ...PHYSICAL_FIELDS,
  ]

  // Category-specific fields based on product types
  const types = (params.productTypes ?? []).filter(Boolean)
  for (const pt of types) {
    fields.push(...getCategorySpecificFields(pt))
  }

  // Channel-specific fields
  const channels = (params.channels ?? []).map((c) => c.toUpperCase())
  if (channels.includes('AMAZON')) fields.push(...AMAZON_FIELDS)
  if (channels.includes('EBAY')) fields.push(...EBAY_FIELDS)

  // De-dupe by id (a field could legitimately appear twice if the
  // caller passes overlapping productTypes; first one wins)
  const seen = new Set<string>()
  return fields.filter((f) => {
    if (seen.has(f.id)) return false
    seen.add(f.id)
    return true
  })
}

/**
 * Lookup a single field by id. Used by the bulk-patch endpoint in D.3
 * to validate incoming change IDs against the registry.
 */
export function getFieldDefinition(id: string): FieldDefinition | undefined {
  // The full set of static fields, regardless of context, so the
  // bulk-patch endpoint can recognise any field id.
  const all: FieldDefinition[] = [
    ...UNIVERSAL_FIELDS,
    ...PRICING_FIELDS,
    ...INVENTORY_FIELDS,
    ...IDENTIFIER_FIELDS,
    ...PHYSICAL_FIELDS,
    ...AMAZON_FIELDS,
    ...EBAY_FIELDS,
    ...Object.values(CATEGORY_FIELDS_BY_TYPE).flat(),
  ]
  return all.find((f) => f.id === id)
}
