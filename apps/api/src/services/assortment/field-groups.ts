/**
 * AE.3 — which offered field group each product field belongs to, or why it is never copied.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §3.4 and §16. Every scalar column of `Product` is
 * listed here, deliberately: `field-groups.vitest.test.ts` reads schema.prisma and fails when a column
 * is missing, so a column added later cannot be copied (or silently dropped) without someone deciding.
 *
 * The transfer rows of a copy name fields by their master-sheet key. Three kinds of key reach this map:
 *   • a Product column (storage "column") — looked up in PRODUCT_COLUMNS;
 *   • an attribute from the category-attribute bag (storage "categoryAttributes") — "attributes";
 *   • the transfer metadata fields family, parentSku, categoryIds, primaryCategoryId.
 * Text in another language is "translations"; the primary-language text is its own group.
 */
import type { FieldGroup } from './share-rules.js'

export type Disposition = { group: FieldGroup } | { never: string }

const g = (group: FieldGroup): Disposition => ({ group })
const never = (reason: string): Disposition => ({ never: reason })

const BOOKKEEPING = never('record bookkeeping belongs to each business')
const STOCK = never('stock and replenishment belong to each business')
const CHANNEL = never('channel identities and listing content belong to each business\'s own accounts')
const OPERATIONS = never('fulfilment and shipping belong to each business')
const MARKET_READING = never('market readings are measured per business')
const SYNC_STATE = never('sync state belongs to each business')
const PROCESS = never('import, review and validation state belong to each business')
const LEGACY = never('an old field that is no longer used')

/** Every scalar column of `Product` (schema.prisma), one decision each. */
export const PRODUCT_COLUMNS: Record<string, Disposition> = {
  // identity
  sku: g('identity'), upc: g('identity'), ean: g('identity'), gtin: g('identity'), brand: g('identity'), manufacturer: g('identity'),
  // content (primary language; other languages are "translations")
  name: g('content'), description: g('content'), bulletPoints: g('content'), keywords: g('content'), aPlusContent: g('content'), localizedContent: g('content'),
  // attributes
  productType: g('attributes'), variationTheme: g('attributes'), variationAxes: g('attributes'),
  // VTR step 1 — codes of THIS business's attribute dictionary; the receiving business links its own axes (the VTR backfill).
  variationAxisCodes: never('dictionary codes belong to each business; the receiving business links its own axes'),
  variationValueOrder: never('value order refers to each business\'s own dictionary options'), categoryAttributes: g('attributes'), variantAttributes: g('attributes'),
  // media
  imageAxisPreference: g('media'),
  // physical
  weightValue: g('physical'), weightUnit: g('physical'), dimLength: g('physical'), dimWidth: g('physical'), dimHeight: g('physical'), dimUnit: g('physical'),
  // compliance
  hsCode: g('compliance'), countryOfOrigin: g('compliance'), ppeCategory: g('compliance'), hazmatClass: g('compliance'), hazmatUnNumber: g('compliance'),
  garmentClass: g('compliance'), notifiedBodyNumber: g('compliance'), notifiedBodyName: g('compliance'), declarationOfConformityUrl: g('compliance'), impactProtectors: g('compliance'),
  // structure
  parentId: g('structure'), isParent: g('structure'), familyId: g('structure'),
  // price (offered only when the owner chooses it)
  basePrice: g('price'), minPrice: g('price'), maxPrice: g('price'), b2bPrice: g('price'), b2bMinQty: g('price'),
  // status (offered only when the owner chooses it)
  status: g('status'),

  // never copied
  costPrice: never('cost belongs to each business'),
  minMargin: never('margin rules belong to each business'),
  workspaceId: BOOKKEEPING, id: BOOKKEEPING, version: BOOKKEEPING, createdAt: BOOKKEEPING, updatedAt: BOOKKEEPING, deletedAt: BOOKKEEPING,
  totalStock: STOCK, lowStockThreshold: STOCK, firstInventoryDate: STOCK, abcClass: STOCK, abcClassUpdatedAt: STOCK,
  serviceLevelPercent: STOCK, orderingCostCents: STOCK, carryingCostPctYear: STOCK, costingMethod: STOCK, weightedAvgCostCents: STOCK,
  amazonAsin: CHANNEL, ebayItemId: CHANNEL, ebayTitle: CHANNEL, shopifyProductId: CHANNEL, woocommerceProductId: CHANNEL, parentAsin: CHANNEL, fnsku: CHANNEL,
  fulfillmentMethod: OPERATIONS, fulfillmentChannel: OPERATIONS, shippingTemplate: OPERATIONS,
  buyBoxPrice: MARKET_READING, competitorPrice: MARKET_READING,
  lastAmazonSync: SYNC_STATE, amazonSyncStatus: SYNC_STATE, amazonSyncError: SYNC_STATE, linkedToChannels: SYNC_STATE, syncChannels: SYNC_STATE,
  hasChannelOverrides: SYNC_STATE, lastChannelOverrideAt: SYNC_STATE,
  workflowStageId: never('workflow stages belong to each business'),
  importSource: PROCESS, importedAt: PROCESS, reviewStatus: PROCESS, validationStatus: PROCESS, validationErrors: PROCESS,
  isBundle: never('bundle composition is not shared yet'),
  isMasterProduct: LEGACY, masterProductId: LEGACY, isMaster: LEGACY, masterSku: LEGACY, cascadedFields: LEGACY,
}

/** The transfer engine's metadata fields (catalog-transfer-export.ts). */
export const METADATA_FIELDS: Record<string, Disposition> = {
  family: g('structure'),
  parentSku: g('structure'),
  categoryIds: g('attributes'),
  primaryCategoryId: g('attributes'),
}

export type ColumnStorage = 'column' | 'categoryAttributes' | 'localizedContent' | 'listing'

/**
 * The disposition of one transfer row. `storage` is the master-sheet column's storage for this key,
 * or undefined when the key is not a master column (metadata, or unknown).
 */
export function classifyRow(row: { field: string; locale?: string }, storage: ColumnStorage | undefined, primaryLocale: string): Disposition {
  const metadata = METADATA_FIELDS[row.field]
  if (metadata) return metadata
  if (row.locale && row.locale !== primaryLocale) return g('translations')
  if (storage === 'categoryAttributes') return g('attributes')
  if (storage === 'localizedContent') return g('content')
  if (storage === 'listing') return never('channel listing fields are never shared')
  const column = PRODUCT_COLUMNS[row.field]
  if (column) return column
  // A key the map does not know is reported, never copied on a guess.
  return never('this field is not shared yet')
}

// ── Sharing studio step 4 — a channel listing's own fields ───────────────────────────────────────

/**
 * The channel-spec groups whose fields are a listing's own CONTENT: copied once, with the "listings" group, into the
 * drafts the receiving business makes. An allow-list: a group not named here — offer terms, shipping, policies,
 * photos, variations, listing format, business prices, anything new or ungrouped (Shopify's store fields) — is never
 * copied on a guess. `category_attributes` is Etsy's item specifics.
 */
export const LISTING_CONTENT_GROUPS: ReadonlySet<string> = new Set(['content', 'aspects', 'category_attributes', 'product_details', 'product_identity', 'classification', 'safety_and_compliance'])

/**
 * Fields inside those groups that name something one business owns, so a copy would point at the other business's
 * record: eBay's description theme (a template of the business), Etsy's shop section and production partners.
 */
export const BUSINESS_OWNED_LISTING_FIELDS: ReadonlySet<string> = new Set(['descriptionThemeId', 'shop_section_id', 'production_partner_ids'])

/** The disposition of one listing field (a channel field-catalogue entry), or of the listing's channel category. */
export function classifyListingField(field: { key?: string; group?: string | null; managed?: boolean; category?: boolean }): Disposition {
  if (field.category) return g('listings')
  if (field.managed) return never('price and stock belong to each business')
  if (field.key && BUSINESS_OWNED_LISTING_FIELDS.has(field.key)) return never('it names a record of the business that shares')
  const group = String(field.group ?? '').split(':').pop()!.toLowerCase()
  if (LISTING_CONTENT_GROUPS.has(group)) return g('listings')
  if (group === 'offer' || group === 'listing') return never('offer terms belong to each seller account')
  if (group === 'shipping' || group === 'policies') return never('shipping and business policies belong to each seller account')
  if (group === 'images') return never('photos per listing are not copied yet')
  if (group === 'variations') return never('each business lays out its own variations')
  return never('this listing field is not shared yet')
}

