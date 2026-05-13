/**
 * eBay Flat File — fixed column schema.
 *
 * Unlike the Amazon flat file (which fetches a dynamic manifest from SP-API),
 * the eBay flat file uses a fixed column set. Category-specific item specifics
 * from the Taxonomy API are deferred to v2.
 */

export type EbayColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean' | 'readonly'

export interface EbayColumn {
  id: string
  label: string
  description?: string
  required: boolean
  kind: EbayColumnKind
  options?: string[]
  maxLength?: number
  width: number
  frozen?: boolean
  readOnly?: boolean
}

export interface EbayColumnGroup {
  id: string
  label: string
  color: string
  columns: EbayColumn[]
}

// ── Condition options ──────────────────────────────────────────────────

export const EBAY_CONDITION_OPTIONS = [
  'NEW',
  'LIKE_NEW',
  'VERY_GOOD',
  'GOOD',
  'ACCEPTABLE',
] as const

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

// ── Column groups ──────────────────────────────────────────────────────

export const EBAY_COLUMN_GROUPS: EbayColumnGroup[] = [
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
        id: 'ebay_item_id',
        label: 'eBay Item ID',
        description: 'eBay-assigned ItemID (12-digit number). Auto-filled after first publish.',
        required: false,
        kind: 'text',
        maxLength: 20,
        width: 140,
        readOnly: true,
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
        description: 'Item condition',
        required: true,
        kind: 'enum',
        options: [...EBAY_CONDITION_OPTIONS],
        width: 120,
      },
      {
        id: 'category_id',
        label: 'Category ID',
        description: 'eBay category number (e.g. 11450 for Clothing)',
        required: false,
        kind: 'text',
        maxLength: 20,
        width: 120,
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
        description: 'Fixed price in Euros',
        required: true,
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
        description: 'Available quantity to list',
        required: true,
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
    id: 'item_specifics',
    label: 'Item Specifics',
    color: 'amber',
    columns: [
      { id: 'brand',        label: 'Brand',        description: 'Brand name', required: false, kind: 'text', maxLength: 65, width: 120 },
      { id: 'colour',       label: 'Colour',       description: 'Colour / color name', required: false, kind: 'text', maxLength: 35, width: 120 },
      { id: 'size',         label: 'Size',         description: 'Size value (e.g. "M", "42")', required: false, kind: 'text', maxLength: 35, width: 90 },
      { id: 'material',     label: 'Material',     description: 'Material type', required: false, kind: 'text', maxLength: 65, width: 120 },
      { id: 'model_number', label: 'Model Number', description: 'Manufacturer model number', required: false, kind: 'text', maxLength: 65, width: 140 },
      { id: 'custom_label', label: 'Custom Label', description: 'Custom label / internal SKU note', required: false, kind: 'text', maxLength: 65, width: 140 },
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

// ── Flat column list (for iteration) ──────────────────────────────────

export function getAllEbayColumns(): EbayColumn[] {
  return EBAY_COLUMN_GROUPS.flatMap((g) => g.columns)
}
