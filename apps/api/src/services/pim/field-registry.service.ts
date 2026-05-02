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
  // D.5: description is HTML-string content shown on listings. Made
  // editable in the registry primarily for the ZIP-upload path
  // (description.html files); the spreadsheet grid can edit it too,
  // though it's rarely opened by default since the column is wide.
  { id: 'description', label: 'Description', type: 'text', category: 'universal', editable: true, width: 320, helpText: 'HTML body shown on listings — best edited via ZIP upload (description.html per product folder)' },
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
  // D.3k: master-level GTIN (8–14 digits, normalised on save).
  { id: 'gtin', label: 'GTIN', type: 'text', category: 'identifiers', editable: true, width: 140, helpText: 'Universal product identifier — 8 to 14 digits' },
  { id: 'amazonAsin', label: 'ASIN', type: 'text', category: 'identifiers', editable: false, width: 110 },
  { id: 'parentAsin', label: 'Parent ASIN', type: 'text', category: 'identifiers', editable: false, width: 110 },
  { id: 'ebayItemId', label: 'eBay Item ID', type: 'text', category: 'identifiers', editable: false, width: 130 },
]

// ── Physical attributes ───────────────────────────────────────────────
// D.3j: weight + dimension fields are now editable. Smart parsing on
// the client lets users type "5kg" or "60cm" and the unit suffix is
// extracted and routed to the corresponding *Unit column. The unit
// fields themselves stay editable (select) for explicit changes.
const PHYSICAL_FIELDS: FieldDefinition[] = [
  { id: 'weightValue', label: 'Weight', type: 'number', category: 'physical', editable: true, width: 100, helpText: 'Type "5kg" or "5.5 lb" — the unit is auto-detected' },
  { id: 'weightUnit', label: 'Wt Unit', type: 'select', options: ['kg', 'g', 'lb', 'oz'], category: 'physical', editable: true, width: 80 },
  { id: 'dimLength', label: 'Length', type: 'number', category: 'physical', editable: true, width: 100, helpText: 'Type "60cm" or "23.6in" — the unit is auto-detected' },
  { id: 'dimWidth', label: 'Width', type: 'number', category: 'physical', editable: true, width: 100, helpText: 'Type "60cm" or "23.6in" — the unit is auto-detected' },
  { id: 'dimHeight', label: 'Height', type: 'number', category: 'physical', editable: true, width: 100, helpText: 'Type "60cm" or "23.6in" — the unit is auto-detected' },
  { id: 'dimUnit', label: 'Dim Unit', type: 'select', options: ['cm', 'mm', 'in'], category: 'physical', editable: true, width: 80 },
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
// D.3e: editable: true. Backend stores values in Product.categoryAttributes
// JSON via atomic jsonb || merge. The `productTypes` array gates display:
// rows whose productType doesn't match render "—" so values from
// unrelated categories never leak into the wrong cell.
const CATEGORY_FIELDS_BY_TYPE: Record<string, FieldDefinition[]> = {
  OUTERWEAR: [
    { id: 'attr_armorType', label: 'Armor Type', type: 'select', options: ['Level 1', 'Level 2', 'No Armor'], category: 'category', productTypes: ['OUTERWEAR'], editable: true, width: 120, helpText: 'CE certification level for impact protection' },
    { id: 'attr_ceCertification', label: 'CE Certification', type: 'text', category: 'category', productTypes: ['OUTERWEAR'], editable: true, width: 140, helpText: 'EN-numbered certification reference' },
    { id: 'attr_waterproofRating', label: 'Waterproof', type: 'select', options: ['Yes', 'Water Resistant', 'No'], category: 'category', productTypes: ['OUTERWEAR'], editable: true, width: 130 },
  ],
  HELMET: [
    { id: 'attr_dotCertification', label: 'DOT', type: 'text', category: 'category', productTypes: ['HELMET'], editable: true, width: 100, helpText: 'US DOT FMVSS 218 certification number' },
    { id: 'attr_eceNumber', label: 'ECE', type: 'text', category: 'category', productTypes: ['HELMET'], editable: true, width: 100, helpText: 'European ECE 22.06 (or .05) certification number' },
    { id: 'attr_helmetType', label: 'Helmet Type', type: 'select', options: ['Full Face', 'Modular', 'Open Face', 'Off-Road'], category: 'category', productTypes: ['HELMET'], editable: true, width: 120 },
  ],
}

function getCategorySpecificFields(productType: string): FieldDefinition[] {
  return CATEGORY_FIELDS_BY_TYPE[productType.toUpperCase()] ?? []
}

interface AvailableFieldsParams {
  productTypes?: string[]
  channels?: string[]
  marketplaces?: string[]
  /** Single marketplace code (IT, DE, US…) used to look up cached
   *  CategorySchema rows. When omitted, dynamic schema fields are not
   *  included — only the hardcoded fallback. */
  marketplace?: string | null
}

/**
 * Compose the field set for a given context. The order matters — column
 * selectors and templates render in this order by default.
 *
 * D.3g: when `marketplace` is set and `productTypes` is non-empty, we
 * also pull dynamic category fields from CategorySchema (cached
 * Amazon schemas). Hardcoded fields remain as a fallback for
 * categories that haven't been fetched yet, and are merged with
 * dynamic ones (dynamic wins on duplicate id).
 */
export async function getAvailableFields(
  params: AvailableFieldsParams = {},
): Promise<FieldDefinition[]> {
  const fields: FieldDefinition[] = [
    ...UNIVERSAL_FIELDS,
    ...PRICING_FIELDS,
    ...INVENTORY_FIELDS,
    ...IDENTIFIER_FIELDS,
    ...PHYSICAL_FIELDS,
  ]

  const types = (params.productTypes ?? []).filter(Boolean)
  const channels = (params.channels ?? []).map((c) => c.toUpperCase())

  // ── Dynamic category fields (Amazon, when marketplace + productTypes set)
  // We intentionally only consult cached schemas — no live SP-API calls
  // on the column-list path, which is hit on every page load. The
  // schema-sync service is responsible for keeping the cache fresh.
  const dynamicFields: FieldDefinition[] = []
  if (
    types.length > 0 &&
    params.marketplace &&
    channels.includes('AMAZON')
  ) {
    try {
      const cached = await loadCachedSchemas(params.marketplace, types)
      for (const row of cached) {
        const fromSchema = (
          await import('./schema-to-fields.js')
        ).schemaToFieldDefinitions({
          productType: row.productType,
          schemaDefinition: row.schemaDefinition,
        })
        dynamicFields.push(...fromSchema)
      }
    } catch (err) {
      // Don't break the whole request — log + fall back to hardcoded.
      // eslint-disable-next-line no-console
      console.error('[field-registry] dynamic lookup failed:', err)
    }
  }

  // ── Hardcoded category fallback (used as a backstop and for types
  //    that don't have a cached schema yet).
  for (const pt of types) {
    fields.push(...getCategorySpecificFields(pt))
  }

  if (channels.includes('AMAZON')) fields.push(...AMAZON_FIELDS)
  if (channels.includes('EBAY')) fields.push(...EBAY_FIELDS)

  // De-dupe by id. Dynamic schema fields take precedence over the
  // hardcoded ones — when both exist, the live schema wins.
  const result: FieldDefinition[] = []
  const seen = new Set<string>()
  for (const f of [...dynamicFields, ...fields]) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    result.push(f)
  }
  return result
}

/**
 * Lookup a single field by id. Used by the bulk-patch endpoint to
 * validate incoming change IDs against the registry.
 *
 * D.3g: dynamic resolution — when an attr_* id isn't in the static
 * registry, we scan cached CategorySchema rows for a matching field.
 * The optional `context` narrows the search and is recommended when
 * multiple categories define the same attr name.
 */
export async function getFieldDefinition(
  id: string,
  context: { marketplace?: string | null; productTypes?: string[] } = {},
): Promise<FieldDefinition | undefined> {
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
  const staticHit = all.find((f) => f.id === id)
  if (staticHit) return staticHit

  // Dynamic resolution for attr_* ids — scan cached schemas.
  if (!id.startsWith('attr_')) return undefined
  if (!context.marketplace) return undefined

  try {
    const types = (context.productTypes ?? []).filter(Boolean)
    const cached = await loadCachedSchemas(context.marketplace, types)
    for (const row of cached) {
      const fromSchema = (
        await import('./schema-to-fields.js')
      ).schemaToFieldDefinitions({
        productType: row.productType,
        schemaDefinition: row.schemaDefinition,
      })
      const hit = fromSchema.find((f) => f.id === id)
      if (hit) return hit
    }
  } catch {
    /* fall through */
  }
  return undefined
}

/**
 * Find the most recently fetched CategorySchema row for each requested
 * productType in the given marketplace. We prefer fresh (non-expired)
 * rows; if none exist, the most recent stale row is still useful for
 * UI rendering. Live refresh of expired rows happens via the
 * GET /api/categories/schema endpoint.
 */
async function loadCachedSchemas(
  marketplace: string,
  productTypes: string[],
) {
  // Lazy import to avoid pulling Prisma into modules that don't need
  // it — tests and the static path stay fast.
  const { default: prisma } = await import('../../db.js')
  const where: any = {
    channel: 'AMAZON',
    marketplace,
    isActive: true,
  }
  // Empty productTypes means "all" — used by the PATCH validator,
  // which doesn't know which type a given attr_* field belongs to.
  if (productTypes.length > 0) {
    where.productType = { in: productTypes }
  }
  return prisma.categorySchema.findMany({
    where,
    orderBy: { fetchedAt: 'desc' },
    distinct: ['productType'],
  })
}
