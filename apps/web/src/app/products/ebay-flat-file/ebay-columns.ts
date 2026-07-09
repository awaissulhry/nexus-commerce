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
  /** Enum strictness: 'open' = suggest + type freely (eBay FREE_TEXT);
   *  'strict' = eBay only accepts listed values (SELECTION_ONLY). */
  enumMode?: 'open' | 'strict'
  /** Enum cell holds a comma-separated list (toggle picker). */
  multiValue?: boolean
  /** Usage level from eBay API (REQUIRED / RECOMMENDED / OPTIONAL) */
  guidance?: string
  maxLength?: number
  /** Minimum value for a number column (bulk writes below it clamp up; buffer = 0). */
  min?: number
  width: number
  frozen?: boolean
  readOnly?: boolean
  /** Whether this aspect can be used as a variation dimension in multi-SKU listings */
  variantEligible?: boolean
  /** EFX P4 — category IDs whose loaded schema includes this aspect column.
   *  Absent on static (non-aspect) columns and on ghost columns. */
  applicableCategories?: string[]
  /** EFX P4 — category IDs whose loaded schema marks this aspect REQUIRED. */
  requiredForCategories?: string[]
  /** EFX P4 — true on a ghost column (data exists on rows, aspect not in any
   *  loaded category schema). */
  ghost?: boolean
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
  NEW_OTHER:                'New – Other',
  NEW_WITH_DEFECTS:         'New – With Defects',
  CERTIFIED_REFURBISHED:    'Certified Refurbished',
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

// ── FF-EN.4 — full-parity enumerable option sets ───────────────────────
// eBay Inventory API measurement + listing enums, plus curated country /
// VAT lists. All surface as pick-or-type comboboxes (strict where eBay
// only accepts listed values; open where a custom entry is reasonable).

/** WeightUnitOfMeasureEnum (Inventory API packageWeightAndSize.weight.unit). */
export const EBAY_WEIGHT_UNITS = ['KILOGRAM', 'GRAM', 'POUND', 'OUNCE'] as const
export const EBAY_WEIGHT_UNIT_LABELS: Record<string, string> = {
  KILOGRAM: 'kg', GRAM: 'g', POUND: 'lb', OUNCE: 'oz',
}
/** LengthUnitOfMeasureEnum (packageWeightAndSize.dimensions.unit). */
export const EBAY_DIMENSION_UNITS = ['CENTIMETER', 'INCH', 'METER', 'FEET'] as const
export const EBAY_DIMENSION_UNIT_LABELS: Record<string, string> = {
  CENTIMETER: 'cm', INCH: 'in', METER: 'm', FEET: 'ft',
}
/** PackageTypeEnum subset relevant to apparel / gear (open — type any other). */
export const EBAY_PACKAGE_TYPES = [
  'PACKAGE_THICK_ENVELOPE', 'MAILING_BOX', 'PARCEL_OR_PADDED_ENVELOPE',
  'PADDED_BAGS', 'LARGE_ENVELOPE', 'LETTER', 'MAILING_LETTER',
] as const
/** Listing format. The Inventory API publishes FIXED_PRICE only; AUCTION is
 *  surfaced for completeness and flagged at validation. */
export const EBAY_LISTING_FORMATS = ['FIXED_PRICE', 'AUCTION'] as const
/** ListingDuration. Fixed-price listings are GTC; auction durations listed
 *  for completeness. */
export const EBAY_LISTING_DURATIONS = ['GTC', 'DAYS_1', 'DAYS_3', 'DAYS_5', 'DAYS_7', 'DAYS_10', 'DAYS_30'] as const
/** Common EU VAT rates (%). Open — type any rate. */
export const EBAY_VAT_RATES = ['0', '4', '5', '10', '22'] as const
/** Item-location country (ISO 3166-1 alpha-2) — EU-centric subset. Open. */
export const EBAY_ITEM_LOCATION_COUNTRIES = [
  'IT', 'DE', 'FR', 'ES', 'GB', 'AT', 'BE', 'NL', 'PT', 'IE', 'PL', 'SE', 'DK', 'FI', 'CZ', 'GR', 'CH', 'US',
] as const

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
        // FFP.6 — per-row lifecycle action, applied by Push to the TARGET market(s).
        id: 'row_action',
        label: 'Action',
        description: 'Applied on Push, to this market only: blank = publish/update · deactivate = set the live offer to quantity 0 (keeps the ItemID — the safe hide; set it on variant rows) · end = end on this market (child row = that variation, parent row = the whole listing; the ItemID is lost, a later publish creates a new one) · skip = leave this row out of pushes. Deleting rows stays under the Delete toolbar action.',
        required: false,
        kind: 'enum',
        options: ['', 'deactivate', 'end', 'skip'],
        enumMode: 'strict',
        width: 110,
      },
      {
        id: 'parentage',
        label: 'Parent/Child',
        description: 'Whether this SKU is a variation parent, a child variant, or standalone. Set to "parent" for the listing container, "child" for variant rows, or leave blank for standalone items.',
        required: false,
        kind: 'enum',
        options: ['', 'parent', 'child'],
        enumMode: 'strict',
        width: 120,
      },
      {
        id: 'parent_sku',
        label: 'Parent SKU',
        description: "Type or paste the parent row's SKU to nest this row under that family. Editing this field re-groups the row live.",
        required: false,
        kind: 'text',
        maxLength: 50,
        width: 180,
      },
      {
        id: 'ean',
        label: 'EAN',
        description: "EAN/UPC/GTIN barcode — or 'Does not apply' to list a product without one (eBay GTIN exemption)",
        required: false,
        kind: 'text',
        // 14 fits both a GTIN-14 and the exemption value "Does not apply" (14 chars);
        // 20 leaves headroom. The old cap of 13 made "Does not apply" impossible to type.
        maxLength: 20,
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
        id: 'shared_sku_listing',
        label: 'Shared-SKU (Trading API)',
        description: 'Publish this family as an eBay Trading-API multi-variation listing whose variant SKUs may also appear in OTHER listings (shared stock across genuinely-different products). Leave OFF for normal unique-SKU listings. Only set on the parent row. WARNING: never use to clone the SAME item into multiple listings — eBay prohibits duplicate listings.',
        required: false,
        kind: 'boolean',
        width: 150,
      },
      {
        id: 'subtitle',
        label: 'Subtitle',
        description: 'Optional subtitle shown under listing title (55 chars max). Sent to eBay on publish.',
        required: false,
        kind: 'text',
        maxLength: 55,
        width: 200,
      },
      {
        id: 'listing_format',
        label: 'Format',
        description: 'Listing format. The Inventory API publishes Fixed Price; Auction is flagged at validation.',
        required: false,
        kind: 'enum',
        options: [...EBAY_LISTING_FORMATS],
        optionLabels: { FIXED_PRICE: 'Fixed Price', AUCTION: 'Auction' },
        enumMode: 'strict',
        width: 130,
      },
      {
        id: 'listing_duration',
        label: 'Duration',
        description: 'Listing duration. Stored locally — eBay Inventory API enforces GTC for fixed-price; this field does not affect the live listing.',
        required: false,
        kind: 'enum',
        options: [...EBAY_LISTING_DURATIONS],
        enumMode: 'strict',
        width: 110,
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
        description: 'Enable Best Offer (Trattativa) on this listing so buyers can send offers. Sent to eBay on Push. Set on the parent row — it applies to the whole listing.',
        required: false,
        kind: 'boolean',
        width: 100,
      },
      {
        id: 'best_offer_floor',
        label: 'BO Floor (EUR)',
        description: 'Auto-decline threshold: offers below this are declined automatically (eBay autoDeclinePrice). Sent to eBay when Best Offer is on; leave blank for no auto-decline. Must be below the ceiling.',
        required: false,
        kind: 'number',
        width: 110,
      },
      {
        id: 'best_offer_ceiling',
        label: 'BO Ceiling (EUR)',
        description: 'Auto-accept threshold: offers at or above this are accepted automatically (eBay autoAcceptPrice). Sent to eBay when Best Offer is on; leave blank for no auto-accept. Must be above the floor.',
        required: false,
        kind: 'number',
        width: 120,
      },
      {
        id: 'vat_rate',
        label: 'VAT %',
        description: 'VAT percentage for local tax calculation. Stored locally — eBay manages tax independently; this does not affect your eBay listing.',
        required: false,
        kind: 'enum',
        options: [...EBAY_VAT_RATES],
        enumMode: 'open',
        width: 90,
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
        description: 'Handling time stored locally. On eBay, handling time is set via your Fulfillment Policy — it is not sent directly through the Inventory API.',
        required: false,
        kind: 'number',
        width: 100,
      },
      {
        // EFX P9f — operator override for the offer's quantityLimitPerBuyer.
        id: 'quantity_limit_per_buyer',
        label: 'Max Per Buyer',
        description: 'Maximum quantity a single buyer may purchase of this listing (eBay quantityLimitPerBuyer). Leave blank to use the default of 10. Set on the parent row — applies to the whole listing.',
        required: false,
        kind: 'number',
        min: 1,
        width: 110,
      },
    ],
  },
  {
    id: 'package',
    label: 'Package & Shipping',
    color: 'cyan',
    columns: [
      {
        id: 'item_location_country',
        label: 'Location',
        description: 'Stored locally for reference. The country shown on eBay is determined by your Merchant Location (set in eBay Seller Hub › Inventory › Locations), not this field.',
        required: false,
        kind: 'enum',
        options: [...EBAY_ITEM_LOCATION_COUNTRIES],
        enumMode: 'open',
        width: 110,
      },
      {
        // EFX P9b — the offer's merchantLocationKey. Free text (the seller-defined
        // location key from eBay Seller Hub › Inventory › Locations); blank falls
        // back to the account-configured default at push time.
        id: 'merchant_location_key',
        label: 'Merchant Location',
        description: "eBay merchantLocationKey — the inventory location this listing ships from (create locations in eBay Seller Hub › Inventory › Locations). Sent as the offer's merchantLocationKey; leave blank to use your account's configured default location. Set on the parent row.",
        required: false,
        kind: 'text',
        maxLength: 36,
        width: 160,
      },
      {
        id: 'package_type',
        label: 'Package Type',
        description: 'eBay package type (drives calculated shipping). Pick or type any.',
        required: false,
        kind: 'enum',
        options: [...EBAY_PACKAGE_TYPES],
        enumMode: 'open',
        width: 200,
      },
      {
        id: 'package_weight',
        label: 'Weight',
        description: 'Package weight (value). Used for calculated shipping.',
        required: false,
        kind: 'number',
        width: 90,
      },
      {
        id: 'weight_unit',
        label: 'Wt Unit',
        description: 'Weight unit of measure',
        required: false,
        kind: 'enum',
        options: [...EBAY_WEIGHT_UNITS],
        optionLabels: EBAY_WEIGHT_UNIT_LABELS,
        enumMode: 'strict',
        width: 100,
      },
      {
        id: 'package_length',
        label: 'Length',
        description: 'Package length',
        required: false,
        kind: 'number',
        width: 90,
      },
      {
        id: 'package_width',
        label: 'Width',
        description: 'Package width',
        required: false,
        kind: 'number',
        width: 90,
      },
      {
        id: 'package_height',
        label: 'Height',
        description: 'Package height',
        required: false,
        kind: 'number',
        width: 90,
      },
      {
        id: 'dimension_unit',
        label: 'Dim Unit',
        description: 'Dimension unit of measure',
        required: false,
        kind: 'enum',
        options: [...EBAY_DIMENSION_UNITS],
        optionLabels: EBAY_DIMENSION_UNIT_LABELS,
        enumMode: 'strict',
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

// FM Phase 2 — per-market Follow/Pinned column. Explains itself via the tooltip.
export const FOLLOW_COL_DESC =
  'Follow = this market draws from the shared warehouse pool and updates automatically when stock changes (the Qty shows the live pool number). ' +
  'Pinned = this market holds a fixed quantity you set and ignores the pool. To hold a value: set this to Pinned, then edit the Qty. ' +
  'Default is Follow. Your actual stock is managed on the Stock page and imports — saving here never changes it.'

// FM Phase 4 — per-market Buffer column (units reserved from the shared pool).
export const BUFFER_COL_DESC =
  'Buffer = units held back from the shared warehouse pool so this market never oversells — a Following market then advertises pool − buffer. ' +
  'Useful when several channels draw from one pool. Only applies while Following: a Pinned market holds a fixed quantity and ignores it.'

export const MARKET_COLUMN_GROUPS: EbayColumnGroup[] = [
  {
    id: 'market-IT',
    label: 'Italy (eBay.it)',
    color: 'blue',
    columns: [
      { id: 'it_price',      label: 'Price (€)',  kind: 'number',   required: false, width: 90 },
      { id: 'it_qty',        label: 'Qty',        kind: 'number',   required: false, width: 70 },
      { id: 'it_follow',     label: 'Follow',     kind: 'enum', options: ['Follow', 'Pinned'], enumMode: 'strict', description: FOLLOW_COL_DESC, required: false, width: 92 },
      { id: 'it_buffer',     label: 'Buffer',     kind: 'number', description: BUFFER_COL_DESC, required: false, width: 84 , min: 0 },
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
      { id: 'de_follow',     label: 'Follow',     kind: 'enum', options: ['Follow', 'Pinned'], enumMode: 'strict', description: FOLLOW_COL_DESC, required: false, width: 92 },
      { id: 'de_buffer',     label: 'Buffer',     kind: 'number', description: BUFFER_COL_DESC, required: false, width: 84 , min: 0 },
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
      { id: 'fr_follow',     label: 'Follow',     kind: 'enum', options: ['Follow', 'Pinned'], enumMode: 'strict', description: FOLLOW_COL_DESC, required: false, width: 92 },
      { id: 'fr_buffer',     label: 'Buffer',     kind: 'number', description: BUFFER_COL_DESC, required: false, width: 84 , min: 0 },
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
      { id: 'es_follow',     label: 'Follow',     kind: 'enum', options: ['Follow', 'Pinned'], enumMode: 'strict', description: FOLLOW_COL_DESC, required: false, width: 92 },
      { id: 'es_buffer',     label: 'Buffer',     kind: 'number', description: BUFFER_COL_DESC, required: false, width: 84 , min: 0 },
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
      { id: 'uk_follow',     label: 'Follow',     kind: 'enum', options: ['Follow', 'Pinned'], enumMode: 'strict', description: FOLLOW_COL_DESC, required: false, width: 92 },
      { id: 'uk_buffer',     label: 'Buffer',     kind: 'number', description: BUFFER_COL_DESC, required: false, width: 84 , min: 0 },
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
  /** Enum strictness from eBay's aspectMode (see EbayColumn.enumMode). */
  enumMode?: 'open' | 'strict'
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
      enumMode: a.enumMode,
      required: a.required,
      guidance: a.guidance,
      width: a.width,
      variantEligible: a.variantEligible,
    })),
  }
}

// ── EFX P4 — multi-category union of Item Specifics groups ────────────

/** Strip the trailing requirement/variant markers buildCategoryColumns appends. */
function stripLabelMarkers(label: string): string {
  return label.replace(/[\s*○↕⚠]+$/, '').trim()
}

/** Rebuild the label markers from the merged column's own flags. */
function applyLabelMarkers(base: string, col: Pick<EbayColumn, 'required' | 'guidance' | 'variantEligible'>): string {
  return base
    + (col.required ? ' *' : col.guidance === 'RECOMMENDED' ? ' ○' : '')
    + (col.variantEligible ? ' ↕' : '')
}

/** Prefer the mixed-case id (aspect_Colore) over the all-lowercase alias
 *  (aspect_colore) — buildFlatRow emits both for variation axes. */
function isBetterCasedId(candidate: string, current: string): boolean {
  return candidate !== candidate.toLowerCase() && current === current.toLowerCase()
}

/**
 * Merge the per-category Item Specifics groups of EVERY category present in
 * the sheet into ONE union group. Never all-or-nothing: one category's schema
 * failing to load must not drop another category's columns.
 *
 * Rules:
 *  - columns dedup by id, folding dual-cased ids (aspect_Colore / aspect_colore)
 *    by lowercase — the mixed-case variant wins as the canonical id/label
 *  - required = ANY category requires it (requiredForCategories records which)
 *  - options are unioned (Set, first-seen order preserved)
 *  - enumMode widens to 'open' if any category is open
 *  - kind conflicts widen: any enum → enum (open); otherwise text wins over number
 *  - applicableCategories = every category whose schema contains the aspect
 */
export function mergeCategoryGroups(
  entries: Array<{ categoryId: string; group: EbayColumnGroup }>,
): EbayColumnGroup {
  const byLower = new Map<string, EbayColumn>()
  const order: string[] = []

  for (const { categoryId, group } of entries) {
    for (const col of group.columns) {
      const lower = col.id.toLowerCase()
      const existing = byLower.get(lower)
      if (!existing) {
        byLower.set(lower, {
          ...col,
          options: col.options ? [...col.options] : undefined,
          applicableCategories: [categoryId],
          requiredForCategories: col.required ? [categoryId] : [],
        })
        order.push(lower)
        continue
      }
      // Fold into the existing union column.
      if (isBetterCasedId(col.id, existing.id)) {
        existing.id = col.id
        existing.label = col.label
      }
      if (!existing.applicableCategories!.includes(categoryId)) {
        existing.applicableCategories!.push(categoryId)
      }
      if (col.required) {
        existing.required = true
        if (!existing.requiredForCategories!.includes(categoryId)) {
          existing.requiredForCategories!.push(categoryId)
        }
      }
      // Guidance: strongest level wins (REQUIRED > RECOMMENDED > OPTIONAL).
      const rank = (g?: string) => (g === 'REQUIRED' ? 2 : g === 'RECOMMENDED' ? 1 : 0)
      if (rank(col.guidance) > rank(existing.guidance)) existing.guidance = col.guidance
      // Options union (first-seen order, then new values appended).
      if (col.options?.length) {
        if (!existing.options) existing.options = []
        const seen = new Set(existing.options)
        for (const o of col.options) if (!seen.has(o)) { seen.add(o); existing.options.push(o) }
      }
      // Kind widening: any enum wins; otherwise text beats number (typing stays possible).
      if (col.kind !== existing.kind) {
        if (col.kind === 'enum' || existing.kind === 'enum') {
          existing.kind = 'enum'
          existing.enumMode = 'open' // conflicting kinds → never lock the picker
        } else if (col.kind === 'text' || existing.kind === 'text') {
          existing.kind = 'text'
        }
      }
      // enumMode widens to open if ANY category is open.
      if (existing.kind === 'enum' && (col.enumMode === 'open' || existing.enumMode === 'open')) {
        existing.enumMode = 'open'
      }
      existing.variantEligible = existing.variantEligible || col.variantEligible
      existing.multiValue = existing.multiValue || col.multiValue
      existing.width = Math.max(existing.width, col.width)
    }
  }

  const columns = order.map((lower) => {
    const col = byLower.get(lower)!
    return { ...col, label: applyLabelMarkers(stripLabelMarkers(col.label), col) }
  })

  return { id: 'item-specifics', label: 'Item Specifics', color: 'teal', columns }
}

// ── EFX P4 — ghost columns (row data outside every loaded schema) ─────

export const GHOST_COLUMN_DESC =
  'Not in any loaded category schema — data exists on rows'

/**
 * Stable serialization of the set of aspect_* keys carried by rows (keys with
 * a non-empty value only). Folds dual-cased keys by lowercase, keeping the
 * mixed-case variant as the representative. Sorted → the string only changes
 * when the SET changes, so memos keyed on it don't churn per keystroke.
 */
export function computeAspectKeySignature(rows: Array<Record<string, unknown>>): string {
  const byLower = new Map<string, string>() // lowercase → representative key
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('aspect_') || k === 'aspect_') continue
      if (v === null || v === undefined || v === '') continue
      const lower = k.toLowerCase()
      const cur = byLower.get(lower)
      if (!cur || isBetterCasedId(k, cur)) byLower.set(lower, k)
    }
  }
  return JSON.stringify([...byLower.values()].sort())
}

/**
 * Build editable ghost columns for aspect_* keys that carry row data but are
 * absent from the union schema (category schema drifted, category failed to
 * load, or legacy data). Never lets existing data become invisible.
 */
export function buildGhostAspectColumns(aspectKeys: string[], unionColumnIds: string[]): EbayColumn[] {
  const unionLower = new Set(unionColumnIds.map((id) => id.toLowerCase()))
  const byLower = new Map<string, string>()
  for (const k of aspectKeys) {
    if (!k.startsWith('aspect_') || k === 'aspect_') continue
    const lower = k.toLowerCase()
    if (unionLower.has(lower)) continue
    const cur = byLower.get(lower)
    if (!cur || isBetterCasedId(k, cur)) byLower.set(lower, k)
  }
  return [...byLower.values()].sort().map((key) => ({
    id: key,
    label: key.slice('aspect_'.length).replace(/_/g, ' ') + ' ⚠',
    description: GHOST_COLUMN_DESC,
    required: false,
    kind: 'text' as EbayColumnKind,
    width: 140,
    ghost: true,
  }))
}

// ── Flat column list (for iteration) ──────────────────────────────────

export function getAllEbayColumns(): EbayColumn[] {
  return EBAY_COLUMN_GROUPS.flatMap((g) => g.columns)
}
