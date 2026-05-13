/**
 * eBay Flat File — fixed column schema + market column groups + dynamic category support.
 *
 * Fixed groups: Identifiers, Listing, Content, Pricing, Inventory, Images, Policies, Status
 * Dynamic group: Item Specifics — built from category aspects via buildCategoryColumns()
 * Market groups: one per eBay marketplace (IT, DE, FR, ES, UK)
 */

export type EbayColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean' | 'readonly'

export interface EbayColumn {
  id: string
  label: string
  description?: string
  required: boolean
  kind: EbayColumnKind
  options?: string[]
  optionLabels?: Record<string, string>
  /** Usage level from eBay API (REQUIRED / RECOMMENDED / OPTIONAL) */
  guidance?: string
  maxLength?: number
  width: number
  frozen?: boolean
  readOnly?: boolean
  /** Whether this aspect can be used as a variation dimension in multi-SKU listings */
  variantEligible?: boolean
}

export interface EbayColumnGroup {
  id: string
  label: string
  color: string
  columns: EbayColumn[]
}

// ── Condition options ──────────────────────────────────────────────────
// Values are eBay Inventory API condition enums.
// optionLabels maps each value to a human-readable display name.

export const EBAY_CONDITION_OPTIONS = [
  'NEW',
  'LIKE_NEW',
  'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED',
  'GOOD_REFURBISHED',
  'SELLER_REFURBISHED',
  'USED_EXCELLENT',
  'USED_VERY_GOOD',
  'USED_GOOD',
  'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
] as const

export const EBAY_CONDITION_LABELS: Record<string, string> = {
  NEW:                      'New',
  LIKE_NEW:                 'Like New',
  EXCELLENT_REFURBISHED:    'Excellent – Refurbished',
  VERY_GOOD_REFURBISHED:    'Very Good – Refurbished',
  GOOD_REFURBISHED:         'Good – Refurbished',
  SELLER_REFURBISHED:       'Seller Refurbished',
  USED_EXCELLENT:           'Used – Excellent',
  USED_VERY_GOOD:           'Used – Very Good',
  USED_GOOD:                'Used – Good',
  USED_ACCEPTABLE:          'Used – Acceptable',
  FOR_PARTS_OR_NOT_WORKING: 'For Parts / Not Working',
}

export type EbayCondition = (typeof EBAY_CONDITION_OPTIONS)[number]

// ── Marketplace IDs ────────────────────────────────────────────────────

export const MARKETPLACE_IDS: Record<string, string> = {
  IT: 'EBAY_IT',
  DE: 'EBAY_DE',
  FR: 'EBAY_FR',
  ES: 'EBAY_ES',
  UK: 'EBAY_GB',
  GB: 'EBAY_GB',
}

export const EBAY_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

// ── Fixed column groups (no item specifics, no market groups) ──────────

export const EBAY_FIXED_GROUPS: EbayColumnGroup[] = [
  {
    id: 'identifiers',
    label: 'Identifiers',
    color: 'slate',
    columns: [
      {
        id: 'sku',
        label: 'SKU',
        description: 'Your seller SKU — must match the product catalog',
        required: true,
        kind: 'text',
        maxLength: 50,
        width: 160,
        frozen: true,
      },
      {
        id: 'ean',
        label: 'EAN',
        description: 'European Article Number (barcode)',
        required: false,
        kind: 'text',
        maxLength: 13,
        width: 120,
      },
      {
        id: 'mpn',
        label: 'MPN',
        description: 'Manufacturer Part Number',
        required: false,
        kind: 'text',
        maxLength: 65,
        width: 120,
      },
    ],
  },
  {
    id: 'listing',
    label: 'Listing',
    color: 'blue',
    columns: [
      {
        id: 'title',
        label: 'Title',
        description: 'eBay listing title — 80 character maximum',
        required: true,
        kind: 'text',
        maxLength: 80,
        width: 320,
      },
      {
        id: 'condition',
        label: 'Condition',
        description: 'Item condition (eBay Inventory API enum)',
        required: true,
        kind: 'enum',
        options: [...EBAY_CONDITION_OPTIONS],
        optionLabels: EBAY_CONDITION_LABELS,
        width: 160,
      },
      {
        id: 'category_id',
        label: 'Category ID',
        description: 'eBay category number (e.g. 11450 for Clothing). Double-click to search.',
        required: false,
        kind: 'text',
        maxLength: 20,
        width: 120,
      },
      {
        id: 'variation_theme',
        label: 'Variation Theme',
        description: 'Comma-separated aspect names that define the variation dimensions (e.g. "Taglia,Colore"). Only needed for product families with multiple variants.',
        required: false,
        kind: 'text' as EbayColumnKind,
        maxLength: 200,
        width: 200,
      },
      {
        id: 'subtitle',
        label: 'Subtitle',
        description: 'Optional subtitle (55 characters max, paid feature)',
        required: false,
        kind: 'text',
        maxLength: 55,
        width: 200,
      },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    color: 'purple',
    columns: [
      {
        id: 'description',
        label: 'Description',
        description: 'HTML listing description (4000 characters max). Click to open editor.',
        required: false,
        kind: 'longtext',
        maxLength: 4000,
        width: 240,
      },
    ],
  },
  {
    id: 'pricing',
    label: 'Pricing',
    color: 'emerald',
    columns: [
      {
        id: 'price',
        label: 'Price (EUR)',
        description: 'Fixed price in Euros (shared / default)',
        required: false,
        kind: 'number',
        width: 100,
      },
      {
        id: 'best_offer_enabled',
        label: 'Best Offer',
        description: 'Enable Best Offer on this listing',
        required: false,
        kind: 'boolean',
        width: 100,
      },
      {
        id: 'best_offer_floor',
        label: 'BO Floor (EUR)',
        description: 'Minimum Best Offer price (auto-decline below this)',
        required: false,
        kind: 'number',
        width: 110,
      },
      {
        id: 'best_offer_ceiling',
        label: 'BO Ceiling (EUR)',
        description: 'Auto-accept Best Offer price (auto-accept above this)',
        required: false,
        kind: 'number',
        width: 120,
      },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    color: 'orange',
    columns: [
      {
        id: 'quantity',
        label: 'Quantity',
        description: 'Available quantity to list (shared / default)',
        required: false,
        kind: 'number',
        width: 90,
      },
      {
        id: 'handling_time',
        label: 'Handling Days',
        description: 'Business days to ship after payment',
        required: false,
        kind: 'number',
        width: 100,
      },
    ],
  },
  {
    id: 'images',
    label: 'Images',
    color: 'teal',
    columns: [
      { id: 'image_1', label: 'Image 1', description: 'Primary image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
      { id: 'image_2', label: 'Image 2', description: 'Additional image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
      { id: 'image_3', label: 'Image 3', description: 'Additional image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
      { id: 'image_4', label: 'Image 4', description: 'Additional image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
      { id: 'image_5', label: 'Image 5', description: 'Additional image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
      { id: 'image_6', label: 'Image 6', description: 'Additional image URL', required: false, kind: 'text', maxLength: 500, width: 180 },
    ],
  },
  {
    id: 'policies',
    label: 'Policies',
    color: 'sky',
    columns: [
      { id: 'fulfillment_policy_id', label: 'Fulfillment Policy ID', description: 'eBay fulfillment/shipping policy ID', required: false, kind: 'text', maxLength: 30, width: 170 },
      { id: 'payment_policy_id',     label: 'Payment Policy ID',     description: 'eBay payment policy ID',     required: false, kind: 'text', maxLength: 30, width: 160 },
      { id: 'return_policy_id',      label: 'Return Policy ID',      description: 'eBay return policy ID',      required: false, kind: 'text', maxLength: 30, width: 150 },
    ],
  },
  {
    id: 'status',
    label: 'Status',
    color: 'slate',
    columns: [
      {
        id: 'listing_status',
        label: 'Listing Status',
        description: 'Current eBay listing status',
        required: false,
        kind: 'readonly',
        options: ['ACTIVE', 'DRAFT', 'INACTIVE', 'ENDED', 'ERROR'],
        width: 120,
        readOnly: true,
      },
      {
        id: 'last_pushed_at',
        label: 'Last Pushed',
        description: 'When this row was last pushed to eBay',
        required: false,
        kind: 'readonly',
        width: 150,
        readOnly: true,
      },
      {
        id: 'sync_status',
        label: 'Sync Status',
        description: 'Push sync status',
        required: false,
        kind: 'readonly',
        options: ['synced', 'pending', 'error'],
        width: 110,
        readOnly: true,
      },
    ],
  },
]

// ── Market column groups ───────────────────────────────────────────────

export const MARKET_COLUMN_GROUPS: EbayColumnGroup[] = [
  {
    id: 'market-IT',
    label: 'Italy (eBay.it)',
    color: 'blue',
    columns: [
      { id: 'it_price',      label: 'Price (€)',  kind: 'number',   required: false, width: 90 },
      { id: 'it_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'it_item_id',    label: 'Item ID',    kind: 'readonly', required: false, width: 130, readOnly: true },
      { id: 'it_status',     label: 'Status',     kind: 'readonly', required: false, width: 90,  readOnly: true },
      { id: 'it_listing_id', label: 'Listing ID', kind: 'readonly', required: false, width: 110, readOnly: true },
    ],
  },
  {
    id: 'market-DE',
    label: 'Germany (eBay.de)',
    color: 'emerald',
    columns: [
      { id: 'de_price',      label: 'Price (€)',  kind: 'number',   required: false, width: 90 },
      { id: 'de_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'de_item_id',    label: 'Item ID',    kind: 'readonly', required: false, width: 130, readOnly: true },
      { id: 'de_status',     label: 'Status',     kind: 'readonly', required: false, width: 90,  readOnly: true },
      { id: 'de_listing_id', label: 'Listing ID', kind: 'readonly', required: false, width: 110, readOnly: true },
    ],
  },
  {
    id: 'market-FR',
    label: 'France (eBay.fr)',
    color: 'amber',
    columns: [
      { id: 'fr_price',      label: 'Price (€)',  kind: 'number',   required: false, width: 90 },
      { id: 'fr_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'fr_item_id',    label: 'Item ID',    kind: 'readonly', required: false, width: 130, readOnly: true },
      { id: 'fr_status',     label: 'Status',     kind: 'readonly', required: false, width: 90,  readOnly: true },
      { id: 'fr_listing_id', label: 'Listing ID', kind: 'readonly', required: false, width: 110, readOnly: true },
    ],
  },
  {
    id: 'market-ES',
    label: 'Spain (eBay.es)',
    color: 'orange',
    columns: [
      { id: 'es_price',      label: 'Price (€)',  kind: 'number',   required: false, width: 90 },
      { id: 'es_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'es_item_id',    label: 'Item ID',    kind: 'readonly', required: false, width: 130, readOnly: true },
      { id: 'es_status',     label: 'Status',     kind: 'readonly', required: false, width: 90,  readOnly: true },
      { id: 'es_listing_id', label: 'Listing ID', kind: 'readonly', required: false, width: 110, readOnly: true },
    ],
  },
  {
    id: 'market-UK',
    label: 'UK (eBay.co.uk)',
    color: 'violet',
    columns: [
      { id: 'uk_price',      label: 'Price (£)',  kind: 'number',   required: false, width: 90 },
      { id: 'uk_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'uk_item_id',    label: 'Item ID',    kind: 'readonly', required: false, width: 130, readOnly: true },
      { id: 'uk_status',     label: 'Status',     kind: 'readonly', required: false, width: 90,  readOnly: true },
      { id: 'uk_listing_id', label: 'Listing ID', kind: 'readonly', required: false, width: 110, readOnly: true },
    ],
  },
]

// ── All groups (fixed + market) — no item specifics (dynamic) ─────────

export const EBAY_COLUMN_GROUPS: EbayColumnGroup[] = [
  ...EBAY_FIXED_GROUPS,
  ...MARKET_COLUMN_GROUPS,
]

// ── Dynamic category aspect columns ───────────────────────────────────

export interface CategoryAspect {
  id: string          // e.g. 'aspect_Brand'
  label: string       // e.g. 'Brand'
  kind: EbayColumnKind
  options?: string[]
  required: boolean
  recommended: boolean
  /** Usage level from eBay API: REQUIRED / RECOMMENDED / OPTIONAL */
  guidance?: string
  width: number
  /** Whether this aspect can be used as a variation dimension in multi-SKU listings */
  variantEligible?: boolean
}

/**
 * Build a dynamic column group from category aspects returned by
 * GET /api/ebay/flat-file/category-schema. Includes required (*),
 * recommended (○), and optional aspects.
 */
export function buildCategoryColumns(aspects: CategoryAspect[]): EbayColumnGroup {
  return {
    id: 'item-specifics',
    label: 'Item Specifics',
    color: 'teal',
    columns: aspects.map((a) => ({
      id: a.id,
      label: a.label + (a.required ? ' *' : a.recommended ? ' ○' : '') + (a.variantEligible ? ' ↕' : ''),
      kind: a.kind,
      options: a.options,
      required: a.required,
      guidance: a.guidance,
      width: a.width,
      variantEligible: a.variantEligible,
    })),
  }
}

// ── Flat column list (for iteration) ──────────────────────────────────

export function getAllEbayColumns(): EbayColumn[] {
  return EBAY_COLUMN_GROUPS.flatMap((g) => g.columns)
}
