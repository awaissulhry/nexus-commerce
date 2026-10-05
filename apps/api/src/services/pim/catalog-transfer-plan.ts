import { channelContentField, channelContentState, transferContentAddress, planContentWrite, type TransferContentWrite } from './catalog-transfer-content.js'
import { marketLanguages } from './market-languages.js'
import { contentField, isLocalizableContent, resolveContent, translationMissing } from './content-resolver.js'
import { normalizeLanguage } from './content-language.js'
import { createHash } from 'node:crypto'
import { transferCategoryField, transferIsStore, transferCanonical, transferTargetKey, type TransferCell, type TransferIssue, type TransferMode, type TransferRow } from '@nexus/shared/catalog-transfer'
import { columnApplies, productRoleOf } from '@nexus/shared/master-sheet'
import { getSheetColumns, type SheetColumn } from './sheet-columns.service.js'
import { savedAttributeFields } from './family-sheet-schema.js'
import { getFieldCatalogue, type CatalogueField } from './mapping/field-catalogue.service.js'
import { withCachedSchemas } from './cached-schema-context.js'
import { validateChannelValue } from './mapping/validate-channel-value.js'
import { contentWireValue } from './content-read.js'
import { checkForStorage, coerceForShape } from './sheet-values.js'
import { editVerdict } from './value-verdict.js'
import { channelValuePatch, jsonRecord, storedChannelState, type ValueRecord } from './channel-value-mutation.js'
import type { SourceMapping, SourceExclusion } from './catalog-source-mapping.js'
import { isReferenceField } from '@nexus/shared/reference-values'
import { createReferenceResolver, type ReferenceResolver } from './reference-values.service.js'
import { validateSaleWindow } from './sale-window.js'
import { storedCompareAt } from './compare-at-price.js'
import { SHOPIFY_CSV_IDENTITY, shopifyCsvIdentityError } from './catalog-shopify-csv.js'
import { withFieldName } from '@nexus/shared/off-list-message'
import { restatesPhotoList } from '../images/listing-photos.pure.js'

// Inventory, pricing and publication have their own transactional owners. An attribute import
// must not bypass their ledgers, rules or outbound queues by writing their backing columns.
export const MANAGED_FIELDS = new Set(['sku', 'basePrice', 'costPrice', 'minMargin', 'minPrice', 'maxPrice', 'totalStock', 'lowStockThreshold', 'status', 'fulfillmentChannel', 'productType', 'isParent', 'parentId'])
const MANAGED_CHANNEL_ROOTS = new Set(['purchasable_offer', 'list_price', 'fulfillment_availability', 'standard_price', 'sale_price', 'minimum_seller_allowed_price', 'maximum_seller_allowed_price'])
export function managedChannelField(field: Pick<CatalogueField, 'fieldKey' | 'sheetKey' | 'channelStore'>) {
  return [field.fieldKey, field.sheetKey].some(key => key && MANAGED_CHANNEL_ROOTS.has(key.split('__')[0]))
    || field.channelStore?.kind === 'listingColumn' && ['price', 'quantity', 'priceOverride', 'quantityOverride'].includes(field.channelStore.column)
    || field.channelStore?.kind === 'platformAttributes' && MANAGED_CHANNEL_ROOTS.has(field.channelStore.path[0])
}
export const CLASSIFICATION_FIELDS = new Set(['family', 'parentSku', 'categoryIds', 'primaryCategoryId'])
const CONTENT = new Set(['name', 'title', 'description', 'bulletPoints', 'keywords'])
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const fingerprint = (value: unknown) => createHash('sha256').update(transferCanonical(value)).digest('hex')
/**
 * Everything a target WRITES. Apply re-plans each record and refuses unless this is byte-identical to the reviewed one.
 * Owner 2026-10-05 — plus the eBay photos the review compared (`ebayPhotos`); a target without them keeps its old print.
 */
export const targetWriteFingerprint = (target: Pick<TransferTarget, 'patch' | 'contentWrites' | 'priceWrite' | 'presence' | 'ebayPhotos'>) =>
  fingerprint([target.patch, target.contentWrites, target.priceWrite ?? null, target.presence ?? null, ...(target.ebayPhotos ? [target.ebayPhotos] : [])])
/** Owner 2026-10-05 — the eBay field the sheet calls "Image URLs": its list is the listing's Product media. */
export const isEbayPhotoField = (channel: string, field: Pick<CatalogueField, 'channelStore'>) =>
  channel === 'EBAY' && field.channelStore?.kind === 'platformAttributes' && field.channelStore.path[0] === 'imageUrls'
export interface TransferProduct extends ValueRecord {
  id: string; sku: string; version: number; parentId: string | null; familyId: string | null; isParent: boolean
  categories: { categoryId: string; isPrimary: boolean }[]
}
export interface TransferContext {
  formulas?: { productId: string; scope: string; channel: string; marketplace: string; locale: string; fieldKey: string; dependsOn?: string[]; product?: { parentId: string | null } }[]
  products: Map<string, TransferProduct>
  listings: Map<string, ValueRecord[]>
  families: { id: string; code: string; label: string }[]
  categories: { id: string; isActive: boolean }[]
  accounts: { id: string; channelType: string; marketplace: string | null; isActive?: boolean }[]
  markets: { channel: string; code: string; language?: string; languages?: string[] }[]
  aliases?: { id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; status: string }[]
  categoryDefaults?: Record<string, string | null>
  parentsWithChildren?: Set<string>
  relationshipBlockedProducts?: Set<string>
  /** CFI-6 — listing ids with a PENDING `PRICE_UPDATE`: a channel's own price is never recorded under an operator's unsent push. */
  pendingPriceListings?: Set<string>
  /** CFI-6 — sale windows (raw columns, `sale-window.ts`) of the listings a channel file prices. */
  saleWindows?: Map<string, { start: string | null; end: string | null }>
  /** CFI-4 — the active offer SKUs each listing already carries, for the seller-SKU identity check. */
  offerSkus?: Map<string, string[]>
  /** S9 — a SKU this file would create that another product's listing holds or sends as its channel SKU → its sentence. */
  heldChannelSkus?: Map<string, string>
  /**
   * Owner 2026-10-05 — per eBay listing id, the photos Publish sends (`ebayPhotoReader`, the list the export writes) and
   * whether the listing holds them itself (`own`) or follows the Shared product's. Loaded for the listings a file SETs
   * Image URLs on: the file is compared with this list, not with the old `imageUrls` store a Product media save removes.
   */
  ebayPhotos?: Map<string, { urls: string[]; own: boolean }>
}
/** CFI-6 — a channel file's own selling price and sale, recorded through the one price door without a push. */
export interface TransferPriceWrite {
  price?: number
  sale?: { value: number | null; start: string | null; end: string | null }
  /** NCF D2 A — Shopify's compare-at price from its own product file (`compare-at-price.ts`). */
  compareAt?: number
  /** The listing's own price the review showed (A-17 `expectedPrice`): a number = pinned, `null` = following the master. */
  expectedPrice: number | null
  /**
   * The sale price + window the review showed. Part of the target's write fingerprint, so an apply refuses a record whose
   * sale changed since review — the window lives in raw columns (`sale-window.ts`) no listing snapshot can see.
   */
  expectedSale: { value: number | null; start: string | null; end: string | null }
}
export interface TransferTarget {
  key: string
  identity: TransferRow
  before: ValueRecord | null
  patch: ValueRecord
  contentWrites?: TransferContentWrite[]
  contentFields?: Record<string, string>
  parentSku?: string | null
  categories?: { categoryId: string; isPrimary: boolean }[]
  cells: TransferCell[]
  rows: TransferRow[]
  contractHash: string
  create: boolean
  /** CFI-6 — never part of `patch`: applied through `writeChannelPrices` in record-only mode. */
  priceWrite?: TransferPriceWrite
  /** CFI-3 (Q1 delete) — the channel deleted this listing; applied by `recordChannelDeletion`, nothing sent. */
  presence?: 'ENDED'
  /**
   * Owner 2026-10-05 — the photos Publish sent when the review compared this eBay listing's Image URLs. Part of the write
   * fingerprint: the Shared product's and the parent's Product media and the library live outside the listing snapshot, so
   * a save there between review and apply refuses the record instead of being overwritten unseen.
   */
  ebayPhotos?: string[]
}
export interface TransferPlan {
  targets: TransferTarget[]; issues: TransferIssue[]; warnings: string[]; exclusions?: SourceExclusion[]
  /** CFI-3 — blank cells of full-update rows whose Nexus value was already empty (nothing to clear), and ones that could not be checked. */
  stats?: { alreadyEmpty: number; clearUnchecked: number }
}
export interface TransferContracts {
  reference?: ReferenceResolver
  /** `extraSaved` declares attribute keys the target does not hold yet (a first shared copy: the
   *  product being created has no saved-attribute bag of its own). See `buildTransferPlan`. */
  master: (familyId: string | null, product?: TransferProduct, extraSaved?: Record<string, unknown>) => Promise<SheetColumn[]>
  /** `accountId` (PSIE) reaches the catalogue for SHOPIFY only: a store's own metafields are part of its contract. */
  channel: (channel: string, marketplace: string, category: string, accountId?: string | null) => Promise<{ fields: CatalogueField[]; masterLocalizableKeys?: string[]; warning?: string; schemaVersion?: string | null; fetchedAt?: string | null }>
}

export function transferContracts(market: string, options: { allowIncompleteSchema?: boolean; allowUnknownMarket?: boolean } = {}): TransferContracts {
  const masters = new Map<string, Promise<SheetColumn[]>>()
  const channels = new Map<string, ReturnType<TransferContracts['channel']>>()
  return {
    master(familyId, product, extraSaved) {
      const saved = savedAttributeFields([product?.categoryAttributes, extraSaved])
      const key = fingerprint([familyId, saved])
      if (!masters.has(key)) masters.set(key, getSheetColumns({ market, allowUnknownMarket: options.allowUnknownMarket, familyIds: familyId ? [familyId] : [], productTypes: [], savedFields: saved, scopeKind: 'master', includeEmptyChannels: true }).then(s => s.columns))
      return masters.get(key)!
    },
    channel(channel, marketplace, category, accountId) {
      // PSIE — Shopify's contract depends on the store (its metafield definitions); every other channel's does not
      // here, so their contracts stay shared across accounts exactly as before.
      // 🔴 The store's definitions are read from the SAVED copy only (`withCachedSchemas`): an export or an import never
      // waits on a live Shopify read (up to 34 s cold) and never fails on one. Not saved yet = the standard fields, said.
      const store = channel === 'SHOPIFY' ? accountId ?? null : null
      const key = JSON.stringify([channel, marketplace, category, store])
      const standard = () => getFieldCatalogue({ channel, marketplace, productType: category })
      const catalogue = () => store
        ? withCachedSchemas(() => getFieldCatalogue({ channel, marketplace, productType: category, accountId: store })).then(c => ({ ...c, storeFields: true }), () => standard().then(c => ({ ...c, storeFields: false })))
        : standard().then(c => ({ ...c, storeFields: undefined as boolean | undefined }))
      if (!channels.has(key)) channels.set(key, catalogue().then(c => {
        if (!c.schema.present && !options.allowIncompleteSchema) throw new Error(`No cached ${channel} schema for ${marketplace} / ${category}. Refresh the channel category first.`)
        if (c.storeFields === false) return { fields: c.fields, masterLocalizableKeys: c.masterLocalizableKeys, schemaVersion: c.schema.version, fetchedAt: c.schema.fetchedAt,
          warning: `${channel} ${marketplace}: this store's own fields (metafields) are not loaded yet, so only the standard fields are here. Open the product's Shopify tab once to load them.` }
        return { fields: c.fields, masterLocalizableKeys: c.masterLocalizableKeys, schemaVersion: c.schema.version, fetchedAt: c.schema.fetchedAt, warning: !c.schema.present
          ? `${channel} ${marketplace}: ${category ? `category ${category} has no cached requirements` : 'no category is selected'}. Available field definitions and stored values are exported. Select a category and refresh its requirements before importing changes.`
          : transferIsStore(channel) ? `${channel} ${marketplace}: core product field definitions; category-specific requirements and publish readiness must be checked separately.` : `${channel} ${marketplace} / ${category}: requirements from ${c.schema.fetchedAt ?? 'an undated cached schema'}; publish readiness is checked separately.` }
      }))
      return channels.get(key)!
    },
  }
}

const ownMaster = (product: ValueRecord, col: SheetColumn, locale: string) => {
  if (locale) {
    const requested = normalizeLanguage(locale)
    const resolved = resolveContent({ product: product as any, parent: product.parent as any, field: col.key, localizableKeys: [col.key], address: { requested } })
    return translationMissing(resolved, requested) || resolved.ownerId !== product.id ? undefined : resolved.value
  }
  const value = col.storage === 'categoryAttributes' ? jsonRecord(product.categoryAttributes)[col.key] : product[col.key === 'title' ? 'name' : col.key]
  return col.kind === 'number' && value !== null && value !== undefined ? Number(value) : value
}
/**
 * R-LX-8 (on LX.R's P1-8) — three states, not two, for a localized cell:
 *   stored     the product's OWN translation row
 *   inherited  + `value` + `from`: the family's text, owned by the parent. The
 *              value is present and the ownership is stated, so an export of the
 *              child alone can no longer lose its German title silently, and an
 *              import can decide whether to materialise it.
 *   inherited  + `value: null`: genuinely untranslated (a source-language
 *              fallback is displayable but is NOT a translation — LX.5).
 * Never `stored` for a parent's row, never `null` when the text exists.
 */
export function masterTransferState(product: ValueRecord, col: SheetColumn, locale = ''): { state: 'stored' | 'inherited'; value: unknown; from?: string } {
  if (locale) {
    const requested = normalizeLanguage(locale)
    const resolved = resolveContent({ product: product as any, parent: product.parent as any, field: col.key, localizableKeys: [col.key], address: { requested } })
    if (translationMissing(resolved, requested)) return { state: 'inherited', value: null }
    if (resolved.ownerId && resolved.ownerId !== product.id) return { state: 'inherited', value: resolved.value ?? null, from: resolved.ownerId }
    return { state: 'stored', value: resolved.value ?? null }
  }
  const value = ownMaster(product, col, locale)
  // Native nullable columns do not store a separate inheritance marker; the resolver falls back.
  const inherited = value === undefined || col.storage !== 'categoryAttributes' && (value === null || value === '')
  return { state: inherited ? 'inherited' as const : 'stored' as const, value: value ?? null }
}

function nativeConstraint(key: string, value: unknown): string | null {
  if (value == null) return key === 'name' ? 'Name cannot be empty' : null
  if (key === 'name' && !String(value).trim()) return 'Name cannot be empty'
  if (['weightValue', 'dimLength', 'dimWidth', 'dimHeight'].includes(key) && (typeof value !== 'number' || value < 0 || !Number.isFinite(value))) return 'Enter a non-negative number'
  if (key === 'weightUnit' && !['kg', 'g', 'lb', 'oz'].includes(String(value))) return 'Weight unit must be kg, g, lb or oz'
  if (key === 'dimUnit' && !['cm', 'mm', 'm', 'in', 'ft'].includes(String(value))) return 'Dimension unit must be cm, mm, m, in or ft'
  if (key === 'countryOfOrigin' && !/^[A-Z]{2}$/.test(String(value))) return 'Use an uppercase two-letter country code'
  if (key === 'hsCode' && !/^\d{4,12}$/.test(String(value))) return 'HS code must contain 4–12 digits'
  if (['gtin', 'ean', 'upc'].includes(key) && !/^\d{8,14}$/.test(String(value))) return 'Identifiers must contain 8–14 digits; use text to preserve leading zeros'
  return null
}

function cell(row: TransferRow, before: { state: 'stored' | 'inherited'; value: unknown }, after: unknown, state: 'stored' | 'inherited'): TransferCell {
  // R-AE-17 — an inherited value is not stored on this record, so inheriting it again changes nothing
  // here. Since R-LX-8 an inherited LANGUAGE state carries its owner's text while the inherit action
  // carries none; comparing the two called a no-op a change, and the apply then cleared a translation
  // the variation never had ("… has no de translation to review"). Every other inherited state is null.
  const unchanged = before.state === state && (state === 'inherited' || transferCanonical(before.value) === transferCanonical(after))
  return { ...row, before: before.value, after, beforeState: before.state, afterState: state, verdict: unchanged ? 'unchanged' : 'changed' }
}

// ── CFI (R-CFI-1) — values read from the channel's OWN file ─────────────────────────────────────
const fromChannelFile = (row: TransferRow) => row.origin === 'channel-file'
/** `list_price` is the RRP: a saved listing fact the studio publisher serializes (`studio-publication-amazon.ts:134`), not a selling price. */
export const isRrpField = (field: Pick<CatalogueField, 'fieldKey' | 'sheetKey' | 'channelStore'>) =>
  [field.fieldKey, field.sheetKey].some(key => key?.split('__')[0] === 'list_price')
  || field.channelStore?.kind === 'platformAttributes' && field.channelStore.path[0] === 'list_price'
/** Every seller-SKU identity a listing already holds: active offers, the platform-attribute sku keys, the flat-file snapshot. */
function heldSellerSkus(listing: ValueRecord | null, context: TransferContext): string[] {
  if (!listing) return []
  const platform = jsonRecord(listing.platformAttributes), snapshot = jsonRecord(listing.flatFileSnapshot)
  return [...new Set([...context.offerSkus?.get(String(listing.id)) ?? [],
    ...[platform.sellerSku, platform.seller_sku, platform.sku, platform.item_sku, snapshot.item_sku].filter((v): v is string => typeof v === 'string' && !!v.trim())])]
}
/** Empty the way a channel sees it: nothing, blank text, an empty list, or a measure/record whose parts are all empty. */
export function isEmptyChannelValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return !value.trim()
  if (Array.isArray(value)) return value.every(isEmptyChannelValue)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('value' in record) return isEmptyChannelValue(record.value)
    return Object.values(record).every(isEmptyChannelValue)
  }
  return false
}
const priceNumber = (value: unknown) => value === null || value === undefined || value === '' ? null : Number(value)
/** The listing's own selling price as the price door reads it: pinned (`followMasterPrice === false`) or following the master. */
function listingOwnPrice(listing: ValueRecord | null): { state: 'stored' | 'inherited'; value: number | null } {
  if (!listing || listing.followMasterPrice !== false) return { state: 'inherited', value: null }
  return { state: 'stored', value: priceNumber(listing.priceOverride) ?? priceNumber(listing.price) }
}
/**
 * B2 — a channel value in the form it is SENT, the way `resolveBatch` builds the effective value: the content wire form,
 * then the channel's own normalisation (`validateChannelValue`). Both sides of a comparison go through it.
 */
function sentValue(field: CatalogueField, value: unknown): unknown {
  const wire = contentWireValue(value ?? null, field.shape, contentField(field.sheetKey ?? field.fieldKey))
  return contentWireValue(validateChannelValue(field, wire).value ?? null, field.shape)
}
const sameSent = (field: CatalogueField, a: unknown, b: unknown) => transferCanonical(sentValue(field, a)) === transferCanonical(sentValue(field, b))
/**
 * B2 — the planner's rule for a channel-file value on a cell that follows Shared: equal (in the form it is SENT) to what
 * Nexus already sends → the cell keeps following Shared; otherwise the file's value is saved on the listing. Exported for
 * the golden round trip (export → re-import), which must keep every inherited cell inherited.
 */
export const channelFileKeepsShared = (field: CatalogueField, fileValue: unknown, sentNow: unknown) => sameSent(field, fileValue, sentNow)
/** A list item named in a warning: quoted, and cut short (a bullet point can be 500 characters). */
const quoted = (item: unknown) => { const text = typeof item === 'string' ? item : JSON.stringify(item); return `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"` }
const round2 = (n: number) => Math.round(n * 100) / 100
const clearKey = (targetKey: string, locale: string, field: string) => JSON.stringify([targetKey, locale, field])

/** A channel file's own price rows: the price door reads them, never the effective channel value. */
const CHANNEL_FILE_PRICE_FIELDS = new Set(['price', 'sale', 'compareAt'])
/**
 * CFI-3 (Q1, D3) — for every `clearIfPresent` row, the value Nexus would publish on that coordinate today (a listing
 * override, else the mapped master value): ONE `resolveBatch` per channel · account · market · alias · category · locale,
 * never one per cell. `null` = could not be read; the row is then left alone and the plan says so.
 * B2 — also every channel-file SET row on Overrides: a value equal to what Nexus already sends keeps following Shared.
 * One read per coordinate, the clears and the sets in the same batch.
 */
async function effectiveForClears(groups: Map<string, TransferRow[]>, context: TransferContext, contracts: TransferContracts, warnings: Set<string>) {
  const out = new Map<string, { value: unknown } | null>()
  const batches = new Map<string, { channel: string; accountId: string; marketplace: string; aliasKey: string; category: string; locale: string; productIds: Set<string>; fieldKeys: Set<string>; keys: { cellKey: string; productId: string; fieldKey: string }[]; clears: boolean; sets: boolean }>()
  for (const [key, group] of groups) {
    const clears = group.filter(r => fromChannelFile(r) && r.entity === 'Overrides' && (r.clearIfPresent && r.action === 'CLEAR' || !r.clearIfPresent && r.action === 'SET' && !CHANNEL_FILE_PRICE_FIELDS.has(r.field)))
    if (!clears.length) continue
    const first = group[0], product = context.products.get(first.sku), listing = context.listings.get(key)?.[0]
    // A product this file creates holds nothing Nexus could publish yet.
    if (!product) { for (const r of clears) out.set(clearKey(key, r.locale, r.field), { value: null }); continue }
    const categoryKey = transferCategoryField(first.channel)
    const categoryRow = group.find(r => r.entity === 'Listings' && r.field === categoryKey && r.action === 'SET')
    const category = String(categoryRow?.value ?? jsonRecord(listing?.platformAttributes)[categoryKey] ?? context.categoryDefaults?.[JSON.stringify([first.sku, first.channel, first.marketplace])] ?? '')
    let fields: CatalogueField[]
    try { fields = (await contracts.channel(first.channel, first.marketplace, category, first.accountId)).fields } catch { for (const r of clears) out.set(clearKey(key, r.locale, r.field), null); continue }
    const languageRows = context.markets.filter(m => m.channel === first.channel && m.code === first.marketplace)
    const languages = marketLanguages(first.channel, first.marketplace, languageRows.map(m => ({ ...m, languages: m.languages ?? [] })))
    for (const r of clears) {
      const field = fields.find(f => f.fieldKey === r.field || f.sheetKey === r.field)
      if (!field) continue // the row loop names it
      // Owner 2026-10-05 — an eBay Image URLs list is compared with the photos Publish sends (`context.ebayPhotos`), not here.
      if (r.action === 'SET' && listing && isEbayPhotoField(first.channel, field) && context.ebayPhotos?.has(String(listing.id))) continue
      const locale = r.locale || languages[0] || ''
      const batchKey = JSON.stringify([first.channel, first.accountId, first.marketplace, first.aliasKey, category, locale])
      if (!batches.has(batchKey)) batches.set(batchKey, { channel: first.channel, accountId: first.accountId, marketplace: first.marketplace, aliasKey: first.aliasKey, category, locale, productIds: new Set(), fieldKeys: new Set(), keys: [], clears: false, sets: false })
      const batch = batches.get(batchKey)!
      batch.productIds.add(String(product.id)); batch.fieldKeys.add(field.fieldKey)
      batch.keys.push({ cellKey: clearKey(key, r.locale, r.field), productId: String(product.id), fieldKey: field.fieldKey })
      if (r.action === 'CLEAR') batch.clears = true; else batch.sets = true
    }
  }
  if (!batches.size) return out
  const { resolveBatch } = await import('./mapping/resolve-batch.service.js')
  for (const batch of batches.values()) {
    try {
      const result = await resolveBatch({ channel: batch.channel, channelConnectionId: batch.accountId, marketplace: batch.marketplace, aliasKey: batch.aliasKey, productIds: [...batch.productIds], fieldKeys: [...batch.fieldKeys], ...(batch.locale ? { locale: batch.locale } : {}), productType: batch.category || null, includeCatalogue: false })
      const byProduct = new Map(result.products.map(p => [p.productId, p]))
      for (const k of batch.keys) {
        const cells = byProduct.get(k.productId)?.cells ?? {}
        const hit = cells[k.fieldKey] ?? Object.values(cells).find(c => c.fieldKey === k.fieldKey)
        out.set(k.cellKey, { value: hit?.value ?? null })
      }
    } catch {
      for (const k of batch.keys) out.set(k.cellKey, null)
      if (batch.clears) warnings.add(`${batch.channel} ${batch.marketplace}: the current values behind the blank cells of full-update rows could not be read, so none of them was cleared. Review those fields after this import.`)
      if (batch.sets) warnings.add(`${batch.channel} ${batch.marketplace}: what Nexus already sends could not be read, so the file's values were not compared with Shared; each one is saved on its listing.`)
    }
  }
  return out
}

/**
 * LX.F2 R-LX-21 (F-LX-4) — `options.revalidateDeclaredVersion` is FALSE on the two APPLY
 * paths. The workbook's `version` column is an EXPORT-FRESHNESS check and it belongs to the
 * preview, which still makes it. Re-making it while applying refuses a job because of the
 * job's OWN earlier target: a shared-content write cascades onto every listing that follows
 * the shared text and bumps its `version` (`master-content.service.ts:137`), so one workbook
 * carrying a shared `name` AND a channel `item_name` could never apply — target 1 succeeded
 * and targets 2 and 3 answered "The exported version no longer matches this record", measured
 * on `catalog-transfer-http.vitest.test.ts` ("applies one wide workbook to independent
 * languages, accounts and marketplaces"). The apply keeps its own guards: the rebuilt plan
 * must still produce a byte-identical patch and contract hash, the target snapshot must still
 * match (`listingConflictSnapshot`), and the write is a compare-and-set on the freshly read
 * `version` + `updatedAt`. The preview keeps the check (a re-uploaded stale workbook still
 * reads INVALID).
 */
export async function buildTransferPlan(rows: TransferRow[], mode: TransferMode, context: TransferContext, contracts: TransferContracts, policy?: SourceMapping['policy'], options?: {
  revalidateDeclaredVersion?: boolean
  /**
   * R-AE-17 — the shared products the WHOLE job declares. An apply plans each record alone, but
   * whether an inherited language value's owner is "in this transfer" (R-LX-8) was answered at
   * preview for the whole file. Without this the lone record materialises the text, its plan no
   * longer matches the reviewed one, and the variation is refused ("Catalog inputs or ownership
   * changed since preview"). The preview needs none: its rows already hold every declared owner.
   */
  declaredProductSkus?: ReadonlySet<string>
  /**
   * A first copy of ANOTHER business's shared products (or the live sync that follows it). Two rules
   * are relaxed, and ONLY for values that were already stored by the business that shares them:
   *
   *  1. An attribute the receiving family does not declare is DECLARED for this plan from the
   *     incoming value, instead of refusing the record. The platform already keeps such attributes on
   *     a product — `savedAttributeFields` gives them a column under "Additional saved attributes",
   *     "Saved outside the selected family template" — but it derives them from the product's OWN bag,
   *     and on a first copy that product does not exist yet. So the copy was refusing exactly what the
   *     platform promises to preserve, and one refused attribute makes the whole record INVALID.
   *     (Production 2026-09-21: GALE-JACKET, 10 attributes, "0 attributes" saved.)
   *  2. A single value bound for a LIST column is wrapped into a one-item list. `coerceForShape`
   *     refuses a scalar there on purpose, so a person typing into a sheet is told; a copy is not
   *     typing, it is moving a value the other business has already stored.
   *
   * An operator-authored workbook leaves this OFF, so a typo'd column is still refused by name.
   */
  sharedCopy?: boolean
}): Promise<TransferPlan> {
  const resolveReference = contracts.reference ?? createReferenceResolver()
  const issues: TransferIssue[] = [], warnings = new Set<string>(), targets: TransferTarget[] = []
  const exclusions: SourceExclusion[] = []
  const preserve = (row: TransferRow, stored: boolean) => {
    const owner = row.entity === 'Products' ? policy?.shared : policy?.overrides
    if (owner === 'exclude' || stored && (owner === 'fill-empty' || owner === 'preserve')) {
      exclusions.push({ row: row.row, sku: row.sku, field: row.field, source: row.source, identity: row, message: 'Existing value preserved by the declared source ownership policy' })
      return true
    }
    return false
  }
  const error = (row: TransferRow, message: string) => issues.push({ ...row, message })
  const groups = new Map<string, TransferRow[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    const key = transferTargetKey(row), cellKey = JSON.stringify([key, row.locale, row.field === 'title' && row.entity === 'Products' ? 'name' : row.field])
    if (seen.has(cellKey)) { error(row, 'Duplicate attribute at the same product or listing coordinate'); continue }
    seen.add(cellKey)
    // Classification participates in schema resolution, so apply its ownership policy first.
    if (row.entity === 'Products' && CLASSIFICATION_FIELDS.has(row.field)) {
      const p = context.products.get(row.sku)
      const stored = row.field === 'family' ? !!p?.familyId : row.field === 'parentSku' ? !!p?.parentId : row.field === 'categoryIds' ? !!p?.categories.length : !!p?.categories.some(c => c.isPrimary)
      if (preserve(row, stored)) continue
    }
    if (row.entity === 'Listings' && row.field === transferCategoryField(row.channel)) {
      const stored = Object.prototype.hasOwnProperty.call(jsonRecord(context.listings.get(key)?.[0]?.platformAttributes), row.field)
      if (preserve(row, stored)) continue
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  const productRows = new Map([...groups.values()].filter(r => r[0].entity === 'Products').map(r => [r[0].sku, r]))
  const effective = await effectiveForClears(groups, context, contracts, warnings)
  const stats = { alreadyEmpty: 0, clearUnchecked: 0 }
  /** B2 — per channel · market, the file values that equal what Nexus already sends (they keep following Shared). */
  const followsShared = new Map<string, number>()
  /** Owner 2026-10-05 — per channel · market, the eBay Image URLs lists this file sets (the review says what becomes of them). */
  const photoLists = new Map<string, number>()
  const familyFor = (sku: string, visiting = new Set<string>()): string | null => {
    if (visiting.has(sku)) throw new Error('Parent relationships contain a cycle')
    visiting.add(sku)
    const group = productRows.get(sku) ?? [], existing = context.products.get(sku)
    const family = group.find(r => r.field === 'family')
    if (family?.action === 'SET') {
      const found = context.families.find(f => f.code === family.value)
      if (!found) throw new Error(`Unknown family code "${String(family.value)}"`)
      return found.id
    }
    if (!family && existing?.familyId) return existing.familyId
    const parent = group.find(r => r.field === 'parentSku')
    const parentSku = parent ? parent.action === 'SET' ? String(parent.value) : null : [...context.products.values()].find(p => p.id === existing?.parentId)?.sku
    return parentSku ? familyFor(parentSku, visiting) : null
  }
  // Products are planned before listings. Parents precede children at apply time.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => Number(a[0].entity !== 'Products') - Number(b[0].entity !== 'Products'))
  for (const [key, group] of ordered) {
    const first = group[0]
    const existingProduct = context.products.get(first.sku)
    const existingListings = context.listings.get(key) ?? []
    const isProduct = first.entity === 'Products'
    const before = isProduct ? existingProduct ?? null : existingListings[0] ?? null
    const groupIssueStart = issues.length
    if (existingProduct?.deletedAt) { error(first, 'This SKU is archived. Restore it before importing.'); continue }
    if (existingListings.length > 1) { error(first, 'Multiple listings have this exact coordinate. Resolve the duplicate before importing.'); continue }
    // CFI-3 (Q1 delete) — the channel deleted a listing Nexus never held: there is nothing to end, and nothing is created.
    if (!isProduct && !before && group.some(r => r.entity === 'Listings' && r.field === 'presence' && fromChannelFile(r))) {
      for (const r of group) exclusions.push({ row: r.row, sku: r.sku, field: r.field, source: r.source, identity: r, message: 'The channel file deletes this listing, but Nexus holds no listing here — nothing to end' })
      continue
    }
    if (mode === 'create' && before) { error(first, 'This record already exists; choose Update or Create or update'); continue }
    if (mode === 'update' && !before) { error(first, 'This record does not exist; Update never creates an unknown SKU or listing'); continue }
    // S9 — a new product may not take a SKU another product's listing holds or sends as its channel SKU.
    if (isProduct && !before && context.heldChannelSkus?.has(first.sku)) { error(first, context.heldChannelSkus.get(first.sku)!); continue }
    if (!isProduct && !existingProduct && !productRows.has(first.sku)) { error(first, 'Create the shared product in Products before adding its listings'); continue }
    if (!isProduct && !before && !group.some(r => r.entity === 'Listings')) { error(first, 'Declare a new listing in Listings before supplying overrides'); continue }
    const versions = [...new Set(group.filter(r => r.version !== undefined).map(r => r.version))]
    // Two declared versions for ONE record is a malformed workbook, not staleness, so that arm
    // fires on every path — apply included. The staleness arm obeys
    // `revalidateDeclaredVersion` (LX.F2 R-LX-21, reasoned at the signature).
    if (versions.length > 1 || (options?.revalidateDeclaredVersion !== false && versions.length && versions[0] !== before?.version)) { error(first, 'The exported version no longer matches this record. Export again before applying edits.'); continue }
    const target: TransferTarget = { key, identity: first, before: before ? clone(before) : null, patch: {}, rows: group, cells: [], contractHash: '', create: !before }
    const formulaKeys = new Map<string, string[]>()
    try {
      if (isProduct) {
        const familyId = familyFor(first.sku)
        if (!before && !familyId) throw new Error('New products need a family, or a parent SKU with a family')
        let columns = await contracts.master(familyId, existingProduct)
        if (options?.sharedCopy) {
          // Declare, from the values being copied, the attributes this business does not hold yet.
          // ONLY keys that have no column already: a native or family-declared field keeps its own
          // column and its own storage, and must never gain a "saved attribute" beside it. Rows with
          // a locale are left alone — a saved attribute is not localized, so declaring one would only
          // trade this refusal for another.
          const declared = new Set(columns.map(c => c.key))
          const undeclared: Record<string, unknown> = {}
          for (const row of group) {
            if (CLASSIFICATION_FIELDS.has(row.field) || row.field === 'productRole' || row.field === '__productRole') continue
            if (row.locale || row.action !== 'SET') continue
            const key = row.field === 'title' ? 'name' : row.field
            if (declared.has(key) || row.value === null || row.value === undefined || row.value === '') continue
            undeclared[key] = row.value
          }
          if (Object.keys(undeclared).length) columns = await contracts.master(familyId, existingProduct, undeclared)
        }
        for (const c of columns) formulaKeys.set(c.key, [c.key, c.writeField].filter((k): k is string => !!k))
        target.contractHash = fingerprint(columns)
        const byKey = new Map(columns.map(c => [c.key, c]))
        const working: ValueRecord = clone(before ?? { categoryAttributes: {}, localizedContent: {} })
        for (const row of group) {
          if (CLASSIFICATION_FIELDS.has(row.field)) {
            if (row.locale) { error(row, 'Classification does not vary by locale'); continue }
            const old = row.field === 'family' ? context.families.find(f => f.id === before?.familyId)?.code ?? null
              : row.field === 'parentSku' ? [...context.products.values()].find(p => p.id === before?.parentId)?.sku ?? null
              : row.field === 'categoryIds' ? (existingProduct?.categories ?? []).map(c => c.categoryId).sort()
              : existingProduct?.categories.find(c => c.isPrimary)?.categoryId ?? null
            const after = row.action === 'SET' ? row.value : row.field === 'categoryIds' ? [] : null
            if (preserve(row, old !== null && (!Array.isArray(old) || old.length > 0))) continue
            const c = cell(row, { value: old, state: old === null ? 'inherited' : 'stored' }, after, after === null ? 'inherited' : 'stored')
            target.cells.push(c)
            if (row.field === 'family') target.patch.familyId = row.action === 'SET' ? context.families.find(f => f.code === row.value)?.id : null
            if (row.field === 'parentSku') {
              if (row.action === 'SET' && (typeof after !== 'string' || !after.trim() || after !== after.trim())) throw new Error('Parent SKU must be a non-empty text SKU without surrounding spaces')
              target.parentSku = after === null ? null : String(after)
              if (old !== target.parentSku && existingProduct && context.relationshipBlockedProducts?.has(existingProduct.id)) throw new Error('This SKU has listing aliases. Resolve its listing relationships before changing Parent SKU.')
              if (target.parentSku) {
                if (target.parentSku === row.sku) throw new Error('A product cannot be its own parent')
                const parent = context.products.get(target.parentSku)
                if (!parent && !productRows.has(target.parentSku)) throw new Error(`Parent SKU "${target.parentSku}" does not exist`)
                if (parent?.parentId || productRows.get(target.parentSku)?.some(r => r.field === 'parentSku' && r.action === 'SET')) throw new Error('A child cannot be another child’s parent')
                if (parent?.deletedAt) throw new Error('The selected parent SKU is archived')
                if (parent && productRoleOf({ ...parent, childCount: context.parentsWithChildren?.has(parent.id) ? 1 : 0 }) !== 'parent') throw new Error('Select a parent product; this SKU is currently a standalone product. Use Promote to parent first.')
                if (context.parentsWithChildren?.has(existingProduct?.id) || [...context.products.values()].some(p => p.parentId === existingProduct?.id)) throw new Error('A product with children cannot become a child')
              }
            }
            continue
          }
          if (row.field === 'productRole' || row.field === '__productRole') { error(row, 'Product role is calculated from Parent SKU and parent status; it cannot be imported as an attribute'); continue }
          const col = byKey.get(row.field === 'title' ? 'name' : row.field)
          if (!col) {
            // A shared copy sends INHERIT for a variation that stores no value of its own. When this business
            // has no column for the key either (a family can link an attribute and keep it off the master
            // sheet; the parent then has a saved-attribute column from its own value, the variation none),
            // and this record stores nothing under it, inheriting changes nothing: the variation keeps reading
            // its parent's value. (Production 2026-09-29: GALE-JACKET's 20 variations, all refused.) A record
            // that does store something there, and an operator's workbook, are still refused by name.
            const key = row.field === 'title' ? 'name' : row.field
            const storesNothing = !Object.prototype.hasOwnProperty.call(jsonRecord(working.categoryAttributes), key) && (working[key] === undefined || working[key] === null)
            if (options?.sharedCopy && row.action === 'INHERIT' && !row.locale && storesNothing) { target.cells.push(cell(row, { state: 'inherited', value: null }, null, 'inherited')); continue }
            error(row, 'This attribute is not declared by the selected family'); continue
          }
          const old = masterTransferState(working, col, row.locale)
          if (preserve(row, old.state === 'stored')) continue
          // R-LX-8 — an INHERITED language value now travels WITH its text (see
          // `masterTransferState`). If its owner is not in this transfer the target
          // has nothing to inherit from, so the text is materialised onto the child;
          // when the parent IS in the transfer set the child keeps inheriting,
          // exactly as exported. Every branch below reads this effective action, so
          // nothing changes for a row that carries no inherited text.
          const inheritedOwnerSku = row.locale && row.action === 'INHERIT' && row.value !== undefined && row.value !== null
            ? [...context.products.values()].find(p => p.id === existingProduct?.parentId)?.sku ?? target.parentSku ?? null
            : null
          const ownerInTransfer = !!inheritedOwnerSku && (productRows.has(inheritedOwnerSku) || !!options?.declaredProductSkus?.has(inheritedOwnerSku))
          const action = inheritedOwnerSku && !ownerInTransfer ? 'SET' as const : row.action
          let value = action === 'SET' ? row.value : null
          if (action === 'INHERIT' && old.state !== 'inherited' && !row.locale && col.storage !== 'categoryAttributes' && !existingProduct?.parentId && !target.parentSku) { error(row, 'A root product has no parent value to inherit; use CLEAR for an optional field'); continue }
          // Native fields that have no distinct clear marker must not claim to suppress a parent.
          if (action === 'CLEAR' && !row.locale && col.storage !== 'categoryAttributes' && (existingProduct?.parentId || target.parentSku)) { error(row, 'This native field falls back to its parent when empty. Use INHERIT to make that choice explicit.'); continue }
          const state = action === 'INHERIT' ? 'inherited' : 'stored'
          const unchanged = cell(row, old, value, state).verdict === 'unchanged'
          if (MANAGED_FIELDS.has(col.key)) { if (!unchanged) error(row, 'Manage this field in its dedicated pricing, inventory or product workflow'); else target.cells.push(cell(row, old, value, state)); continue }
          if ((!col.editable || !columnApplies(col, { isParent: existingProduct?.isParent ?? false, productType: null, familyId })) && !unchanged) { error(row, 'This attribute is read-only or does not apply to this product'); continue }
          if (row.locale && !CONTENT.has(col.key) && col.storage !== 'localizedContent') { error(row, 'This attribute is not localized; leave locale empty'); continue }
          if (!row.locale && col.storage === 'localizedContent' && !CONTENT.has(col.key)) { error(row, 'This attribute needs a locale, such as it or en'); continue }
          if (!unchanged && action === 'SET') {
            // A copy MOVES a value the other business already stores; it is not typing one. So a lone
            // value bound for a list column is the list of one, not an operator mistake to report.
            // Only the shape is adjusted here, never the value.
            const wrap = options?.sharedCopy && col.shape === 'list' && value !== null && value !== undefined
              && !Array.isArray(value) && !(typeof value === 'string' && value.trim().startsWith('['))
            // P1 (`value-verdict.ts`) — the verdict every edit path uses: only what the field's type cannot hold is
            // refused; an off-list or over-limit value is imported and named in the review.
            const checked = checkForStorage(col, wrap ? [value] : value)
            if (checked.ok === false) { error(row, checked.error); continue }
            value = checked.value
            for (const found of checked.findings) warnings.add(`${row.sku} ${col.label}: ${found.message} (row ${row.row}; imported as written).`)
          }
          if (!row.locale && col.storage !== 'categoryAttributes') {
            // PSIE — a variant's INHERIT carries no value of its own: its parent's is used (for `name`, the content
            // writer resets the column), so "Name cannot be empty" does not apply to it. A root still has to hold one.
            const inheritsFromParent = action === 'INHERIT' && !!(existingProduct?.parentId || target.parentSku)
            const problem = inheritsFromParent ? null : nativeConstraint(col.key, value)
            if (problem) { error(row, problem); continue }
            if (['bulletPoints', 'keywords'].includes(col.key) && value === null) value = []
          }
          const changed = cell(row, old, value, state)
          target.cells.push(changed)
          if (changed.verdict === 'unchanged') continue
          if (isLocalizableContent(col.key, col.storage) && (before || row.locale)) {
            planContentWrite(target.contentWrites ??= [], transferContentAddress(row), contentField(col.key), action, value)
          } else if (col.storage === 'categoryAttributes') {
            const bag = clone(jsonRecord(working.categoryAttributes))
            if (action === 'INHERIT') delete bag[col.key]; else bag[col.key] = value
            target.patch.categoryAttributes = working.categoryAttributes = bag
          } else target.patch[col.key === 'title' ? 'name' : col.key] = value
        }
        if (!before) {
          if (!target.patch.name) throw new Error('New products require a shared name')
          target.patch.familyId ??= familyId
          target.patch.isParent = rows.some(r => r.entity === 'Products' && r.field === 'parentSku' && r.action === 'SET' && r.value === first.sku)
        }
        const categoriesRow = group.find(r => r.field === 'categoryIds'), primaryRow = group.find(r => r.field === 'primaryCategoryId')
        if (categoriesRow || primaryRow) {
          const ids = categoriesRow ? categoriesRow.action === 'SET' ? categoriesRow.value : [] : existingProduct?.categories.map(c => c.categoryId) ?? []
          if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('categoryIds must be a JSON array of distinct category IDs')
          if (ids.some(id => !context.categories.some(c => c.id === id && c.isActive))) throw new Error('A selected internal category is unavailable')
          const primary = primaryRow ? primaryRow.action === 'SET' ? primaryRow.value : null : existingProduct?.categories.find(c => c.isPrimary)?.categoryId ?? (ids.length === 1 ? ids[0] : null)
          if (ids.length ? !ids.includes(primary) : primary !== null) throw new Error('Select one primaryCategoryId from categoryIds')
          target.categories = ids.map(id => ({ categoryId: id, isPrimary: id === primary }))
        }
      } else {
        const account = context.accounts.find(a => a.id === first.accountId)
        if (!account || account.isActive === false || account.channelType !== first.channel || account.marketplace && !['GLOBAL', first.marketplace].includes(account.marketplace)) throw new Error('The active account does not match this channel and marketplace')
        if (!context.markets.some(m => m.channel === first.channel && m.code === first.marketplace)) throw new Error('This channel marketplace is not configured')
        if (first.aliasKey) {
          const alias = context.aliases?.find(a => a.id === first.aliasKey && a.status === 'ACTIVE' && a.channel === first.channel && a.marketplace === first.marketplace && a.channelConnectionId === first.accountId)
          if (!alias || alias.productId !== (existingProduct?.parentId ?? existingProduct?.id)) throw new Error('This alias is not an active listing of this product family and account. Create the alias in Product Edit Studio first.')
        }
        // CFI-3 (Q1 delete) — a channel file's delete row: the listing is marked ended at apply; nothing is sent.
        const presenceRow = group.find(r => r.entity === 'Listings' && r.field === 'presence' && fromChannelFile(r))
        if (presenceRow) {
          if (presenceRow.action !== 'SET' || presenceRow.value !== 'ENDED') throw new Error('A channel file can only record that the channel ENDED this listing')
          if (group.length > 1) throw new Error('This file both deletes this listing and updates it. Keep one of the two rows.')
          // A delete ends only the listing that holds the file's seller SKU: the product's own SKU, or an identity this listing carries.
          // The listing sells under its held identity when it has one (the studio publishes `identities[0] ?? product.sku`), so
          // the file's SKU must be that identity — even when it equals the Nexus SKU — and only a listing with none sells as the Nexus SKU.
          const fileSku = presenceRow.fileSku ?? first.sku, held = heldSellerSkus(before, context)
          if (held.length ? !held.includes(fileSku) : fileSku !== first.sku) {
            throw new Error(`The file deletes seller SKU ${fileSku}, which this listing does not hold${held.length ? ` (it sells as ${held.join(', ')})` : ''}`)
          }
          const status = before?.listingStatus ?? null
          target.contractHash = fingerprint(['presence', 'ENDED'])
          target.cells.push(cell(presenceRow, { state: 'stored', value: status }, 'ENDED', 'stored'))
          if (status !== 'ENDED') target.presence = 'ENDED'
        } else {
        const categoryKey = transferCategoryField(first.channel)
        const categoryRow = group.find(r => r.entity === 'Listings' && r.field === categoryKey)
        const sharedTarget = targets.find(t => t.identity.entity === 'Products' && t.identity.sku === first.sku)
        const sharedCategoriesChange = sharedTarget?.categories && fingerprint(sharedTarget.categories) !== fingerprint(existingProduct?.categories ?? [])
        if (sharedCategoriesChange && categoryRow?.action !== 'SET' && (!jsonRecord(before?.platformAttributes)[categoryKey] || categoryRow?.action === 'INHERIT')) throw new Error('This source changes shared categories used by an inherited listing category. Declare the listing category explicitly in this review, or review its overrides after the shared category import.')
        const defaultCategory = context.categoryDefaults?.[JSON.stringify([first.sku, first.channel, first.marketplace])] ?? null
        const storedCategory = jsonRecord(before?.platformAttributes)[categoryKey]
        const cleared = transferIsStore(first.channel) && (categoryRow?.action === 'CLEAR' || !categoryRow && storedCategory === null)
        const category = categoryRow?.action === 'SET' ? String(categoryRow.value) : cleared ? '' : String((categoryRow ? null : storedCategory) ?? defaultCategory ?? '')
        if (!category && !transferIsStore(first.channel)) throw new Error(`A listing needs ${categoryKey} in the Listings worksheet`)
        const contract = await contracts.channel(first.channel, first.marketplace, category, first.accountId)
        for (const f of contract.fields) {
          const keys = [f.fieldKey, f.sheetKey, f.channelStore?.kind === 'listingColumn' ? f.channelStore.column : undefined].filter((k): k is string => !!k)
          for (const key of keys) formulaKeys.set(key, keys)
        }
        if (contract.warning) warnings.add(contract.warning)
        target.contractHash = fingerprint([category, contract.fields])
        // CFI-4 — a NEW market listing still belongs to its product, business and coordinate. Without them the content
        // resolver refused every text field ("Content listing does not belong to this product/workspace", measured on
        // REGAL IT, AIREON DE, MOSS DE and WATERPROOF FR, 2026-09-24).
        const working = clone(before ?? { productId: existingProduct?.id ?? null, workspaceId: existingProduct?.workspaceId ?? null, channel: first.channel, marketplace: first.marketplace,
          channelConnectionId: first.accountId, aliasKey: first.aliasKey, overrideData: {}, platformAttributes: {}, translations: [] })
        const resolvedFields = new Set<string>()
        const languageRows = context.markets.filter(m => m.channel === first.channel && m.code === first.marketplace)
        const languages = group.some(row => contract.fields.some(f => (f.fieldKey === row.field || f.sheetKey === row.field) && channelContentField(f, contract.masterLocalizableKeys))) ? marketLanguages(first.channel, first.marketplace, languageRows.map(m => ({ ...m, languages: m.languages ?? [] }))) : []
        for (const row of group) {
          if (row.entity === 'Listings' && row.field === categoryKey) {
            if (row.action === 'CLEAR' && !transferIsStore(first.channel)) { error(row, 'A listing category cannot be cleared; use INHERIT when a category mapping is configured'); continue }
            const previous = jsonRecord(before?.platformAttributes)[categoryKey] ?? null
            if (preserve(row, Object.prototype.hasOwnProperty.call(jsonRecord(before?.platformAttributes), categoryKey))) continue
            let categoryValue: unknown = row.action === 'SET' ? category : null
            if (row.action === 'SET' && transferIsStore(first.channel)) {
              const field = contract.fields.find(f => f.fieldKey === categoryKey)!
              const checked = coerceForShape({ ...field, key: field.fieldKey }, row.value)
              if (checked.ok === false) { error(row, checked.error); continue }
              categoryValue = checked.value
            }
            target.cells.push(cell(row, { state: Object.prototype.hasOwnProperty.call(jsonRecord(before?.platformAttributes), categoryKey) ? 'stored' : 'inherited', value: previous }, categoryValue, row.action === 'INHERIT' ? 'inherited' : 'stored'))
            const platform = { ...jsonRecord(working.platformAttributes) }
            if (row.action === 'INHERIT') delete platform[categoryKey]; else platform[categoryKey] = categoryValue
            target.patch.platformAttributes = working.platformAttributes = platform
            continue
          }
          // CFI-4 — the seller SKU the channel uses when it differs from the Nexus SKU: the identity the studio publisher reads.
          if (row.entity === 'Listings' && row.field === 'sellerSku' && fromChannelFile(row)) {
            if (row.action !== 'SET' || typeof row.value !== 'string' || !row.value.trim() || row.value !== row.value.trim()) { error(row, 'A seller SKU is a non-empty text without surrounding spaces'); continue }
            const platform = { ...jsonRecord(working.platformAttributes) }
            const other = heldSellerSkus(before, context).filter(sku => sku !== row.value)
            if (other.length) { error(row, `This listing already carries the seller SKU ${other.join(', ')} on ${first.channel} ${first.marketplace}; the file says ${String(row.value)}. Reconcile the listing identity before importing.`); continue }
            const previous = typeof platform.sellerSku === 'string' ? platform.sellerSku : null
            target.cells.push(cell(row, { state: previous === null ? 'inherited' : 'stored', value: previous }, row.value, 'stored'))
            if (previous !== row.value) { platform.sellerSku = row.value; target.patch.platformAttributes = working.platformAttributes = platform }
            continue
          }
          // NCF — Shopify's own identity of this product as last read from its product file (handle, status, option names,
          // variants): what the product-CSV export writes back unchanged, and how the next import finds the product.
          if (row.entity === 'Listings' && row.field === SHOPIFY_CSV_IDENTITY && fromChannelFile(row)) {
            const problem = first.channel !== 'SHOPIFY' ? 'Only a Shopify listing carries a Shopify product identity' : row.action !== 'SET' ? 'A channel file records the Shopify product identity; it cannot clear it' : shopifyCsvIdentityError(row.value)
            if (problem) { error(row, problem); continue }
            const platform = { ...jsonRecord(working.platformAttributes) }
            const previous = platform[SHOPIFY_CSV_IDENTITY] ?? null
            const changed = cell(row, { state: previous === null ? 'inherited' : 'stored', value: previous }, row.value, 'stored')
            target.cells.push(changed)
            if (changed.verdict === 'changed') { platform[SHOPIFY_CSV_IDENTITY] = clone(row.value); target.patch.platformAttributes = working.platformAttributes = platform }
            continue
          }
          // CFI-6 (Q2) — the channel's own selling price and sale, recorded through the one price door without a push.
          if (row.entity === 'Overrides' && (row.field === 'price' || row.field === 'sale' || row.field === 'compareAt') && fromChannelFile(row)) {
            if (row.action !== 'SET') { error(row, 'A channel file records a price or a sale; it cannot clear or inherit one'); continue }
            const listingId = before ? String(before.id) : null
            const own = listingOwnPrice(before)
            const reviewedSale = { value: priceNumber(before?.salePrice), ...(listingId ? context.saleWindows?.get(listingId) ?? { start: null, end: null } : { start: null, end: null }) }
            const pending = () => !!listingId && !!context.pendingPriceListings?.has(listingId)
            const waiting = `A price change is waiting to be sent to ${first.channel}. Send or cancel it before importing the channel's price.`
            if (row.field === 'price') {
              const amount = typeof row.value === 'number' ? row.value : typeof row.value === 'string' && row.value.trim() ? Number(row.value) : Number.NaN
              if (!Number.isFinite(amount) || amount < 0) { error(row, 'A price is a number of zero or more'); continue }
              const changed = cell(row, own, round2(amount), 'stored')
              if (changed.verdict === 'changed' && pending()) { error(row, waiting); continue }
              target.cells.push(changed)
              if (changed.verdict === 'changed') target.priceWrite = { ...target.priceWrite, price: round2(amount), expectedPrice: own.value, expectedSale: reviewedSale }
            } else if (row.field === 'compareAt') {
              // NCF D2 A — Shopify's struck-through price, through the same door (record-only).
              if (first.channel !== 'SHOPIFY') { error(row, 'Only a Shopify listing has a compare-at price'); continue }
              const amount = typeof row.value === 'number' ? row.value : typeof row.value === 'string' && row.value.trim() ? Number(row.value) : Number.NaN
              if (!Number.isFinite(amount) || amount < 0) { error(row, 'A compare-at price is a number of zero or more'); continue }
              const changed = cell(row, storedCompareAt(before?.platformAttributes), round2(amount), 'stored')
              if (changed.verdict === 'changed' && pending()) { error(row, waiting); continue }
              target.cells.push(changed)
              if (changed.verdict === 'changed') target.priceWrite = { ...target.priceWrite, compareAt: round2(amount), expectedPrice: own.value, expectedSale: reviewedSale }
            } else {
              const sale = jsonRecord(row.value)
              const amount = sale.value === null || sale.value === undefined || sale.value === '' ? null : Number(sale.value)
              if (amount !== null && (!Number.isFinite(amount) || amount < 0)) { error(row, 'A sale price is a number of zero or more'); continue }
              const next = { value: amount === null ? null : round2(amount), start: amount === null ? null : typeof sale.start === 'string' ? sale.start : null, end: amount === null ? null : typeof sale.end === 'string' ? sale.end : null }
              const problem = validateSaleWindow(next.value, next)
              if (problem) { error(row, problem); continue }
              const changed = cell(row, { state: 'stored', value: reviewedSale }, next, 'stored')
              if (changed.verdict === 'changed' && pending()) { error(row, waiting); continue }
              target.cells.push(changed)
              if (changed.verdict === 'changed') target.priceWrite = { ...target.priceWrite, sale: next, expectedPrice: own.value, expectedSale: reviewedSale }
            }
            continue
          }
          if (row.entity !== 'Overrides') { error(row, `Listings accepts ${categoryKey}; put channel attribute values in Overrides`); continue }
          let field = contract.fields.find(f => f.fieldKey === row.field || f.sheetKey === row.field)
          // CFI-5 (lane request L3-1) — an eBay custom item specific from the channel's own workbook: eBay accepts seller-defined
          // aspects, and the listing already stores them at `platformAttributes.itemSpecifics[<Name>]`. A schema aspect with the
          // same store path keeps its own field; otherwise the specific is planned as a scalar text at that exact path.
          const specific = !field && fromChannelFile(row) && first.channel === 'EBAY' && row.field.startsWith('itemSpecifics.') ? row.field.slice('itemSpecifics.'.length) : ''
          if (specific && specific.trim() && !['__proto__', 'prototype', 'constructor'].includes(specific)) {
            field = contract.fields.find(f => f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics' && f.channelStore.path[1] === specific)
              ?? { fieldKey: row.field, sheetKey: row.field, label: specific, kind: 'text', shape: 'scalar', editable: true, channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', specific] } } as CatalogueField
          }
          if (!field) { error(row, 'This attribute is not declared by the listing category'); continue }
          const textField = channelContentField(field, contract.masterLocalizableKeys)
          if (textField) (target.contentFields ??= {})[row.field] = textField
          if (row.locale && !textField) { error(row, 'This channel attribute does not vary by language; use the facts sheet'); continue }
          const destination = textField ? transferContentAddress(row, languages) : null
          const address = destination?.tier === 'pin' ? destination : null
          const fieldIdentity = JSON.stringify([field.fieldKey, address?.language ?? ''])
          if (resolvedFields.has(fieldIdentity)) { error(row, 'Duplicate attribute: these two keys resolve to the same channel field'); continue }
          resolvedFields.add(fieldIdentity)
          if (field.fieldKey === categoryKey || field.sheetKey === categoryKey) { error(row, 'Set the listing category in Listings'); continue }
          const keys = [...new Set([field.fieldKey, field.sheetKey].filter((s): s is string => !!s))]
          // Owner 2026-10-05 — Product media is the one photo source: an eBay Image URLs SET is compared with the photos Publish
          // sends (the list the export writes), held by the listing (stored) or followed from Shared (inherited) — not with the
          // old `imageUrls` store, which a save in Product media removes. Blank, CLEAR and INHERIT keep their own rules.
          const photos = row.action === 'SET' && before && !textField && isEbayPhotoField(first.channel, field) ? context.ebayPhotos?.get(String(before.id)) : undefined
          const old: { state: 'stored' | 'inherited'; value: unknown } = photos ? { state: photos.own ? 'stored' : 'inherited', value: photos.urls }
            : textField && address && existingProduct ? channelContentState(existingProduct, working, textField, address.language, languages) : storedChannelState(working, field.channelStore, keys)
          if (textField) old.value = contentWireValue(old.value, field.shape, textField)
          // CFI-3 (Q1, D3) — a full-update blank clears the market value ONLY when Nexus would publish one; an already-empty
          // value plans nothing. `before` shows the value Nexus would have published, so the review says what goes.
          if (row.clearIfPresent) {
            if (!fromChannelFile(row) || row.action !== 'CLEAR') { error(row, 'Only a channel file’s full-update blank can clear a value when present'); continue }
            const current = effective.get(clearKey(key, row.locale, row.field))
            if (!current) { stats.clearUnchecked++; continue }
            if (isEmptyChannelValue(current.value) && (old.state !== 'stored' || isEmptyChannelValue(old.value))) { stats.alreadyEmpty++; continue }
            if (old.state === 'inherited') old.value = current.value
          }
          if (preserve(row, old.state === 'stored')) continue
          if (photos) {
            target.ebayPhotos = photos.urls
            // A file that restates that list (the same addresses in the same order) plans nothing: a listing that follows the
            // Shared product's photos keeps following them, and one with its own list keeps it.
            if (restatesPhotoList(row.value, photos.urls)) { target.cells.push(cell(row, old, old.value, old.state)); continue }
          }
          // B2 (the Owner's decision 4, every channel file) — a cell that follows Shared, which the file sets to exactly what
          // Nexus already sends, keeps following Shared: a channel file restates every value, it does not choose them.
          const current = fromChannelFile(row) && row.action === 'SET' ? effective.get(clearKey(key, row.locale, row.field)) : undefined
          if (current && old.state === 'inherited' && channelFileKeepsShared(field, row.value, current.value)) {
            target.cells.push(cell(row, { state: 'inherited', value: current.value }, current.value, 'inherited'))
            const market = `${first.channel} ${first.marketplace}`
            followsShared.set(market, (followsShared.get(market) ?? 0) + 1)
            continue
          }
          // B4 — a list longer than the template's columns (10 bullets, 5 columns): a file that fills every column with the
          // START of the Nexus list keeps the whole list; any other list replaces it, and the review names what goes.
          const slots = row.listSlots
          if (fromChannelFile(row) && row.action === 'SET' && field.shape === 'list' && typeof slots === 'number' && Array.isArray(row.value)) {
            const held = old.state === 'stored' || photos ? old.value : current?.value
            if (Array.isArray(held) && held.length > slots) {
              const where = `${first.channel} ${first.marketplace}: ${row.sku} ${field.label}`
              if (row.value.length === slots && sameSent(field, row.value, held.slice(0, slots))) {
                target.cells.push(cell(row, { state: old.state, value: held }, held, old.state))
                warnings.add(`${where}: the file has ${slots} columns; Nexus keeps all ${held.length}.`)
                continue
              }
              const kept = new Set((sentValue(field, row.value) as unknown[]).map(transferCanonical))
              const removed = (sentValue(field, held) as unknown[]).filter(item => !kept.has(transferCanonical(item)))
              if (removed.length) warnings.add(`${where}: the file has ${slots} columns and replaces the ${held.length} Nexus holds; removed: ${removed.map(quoted).join(', ')}.`)
            }
          }
          const state = row.action === 'INHERIT' ? 'inherited' : 'stored'
          let value = row.action === 'SET' ? row.value : null
          if (cell(row, old, value, state).verdict !== 'unchanged') {
            // CFI (origin 'channel-file') — the value is what the channel already holds, so a field that is read-only on a
            // live listing, and the RRP (`list_price`), are stored as the channel's facts. Operator files keep both refusals.
            if (!field.editable && before && !fromChannelFile(row)) { error(row, 'The channel marks this field read-only on an existing listing'); continue }
            if (managedChannelField(field) && !(fromChannelFile(row) && isRrpField(field))) { error(row, 'Use the pricing or inventory workspace for this listing'); continue }
            if (row.action === 'SET' && isReferenceField(field.fieldKey)) {
              try { value = await resolveReference({ field: field.fieldKey, value, channel: first.channel, marketplace: first.marketplace, accountId: first.accountId, productType: category }) }
              catch (e) { error(row, e instanceof Error ? e.message : 'This reference could not be verified. Try again.'); continue }
            }
            // P1 (`value-verdict.ts`) — the verdict every edit path uses: a value the field's type cannot hold is refused;
            // every other problem (off the channel's list, over a limit) is imported as written and named in the review.
            // Publish blocks what the channel itself would reject. (CFI-5's eBay-choices exception is now the rule.)
            const checked = validateChannelValue(field, value, first.channel)
            const refused = checked.findings.filter(found => editVerdict(found) === 'refuse')
            if (refused.length) { error(row, refused.map(found => found.message).join(' ')); continue }
            for (const found of checked.findings) warnings.add(`${first.channel} ${first.marketplace}: ${row.sku} ${withFieldName(field.label, found.message)} Imported as written.`)
            value = checked.value
          }
          const changed = cell(row, old, value, state)
          target.cells.push(changed)
          if (changed.verdict === 'changed') {
            if (textField && address) planContentWrite(target.contentWrites ??= [], address, textField, row.action, value)
            else {
              if (row.action === 'SET' && isEbayPhotoField(first.channel, field)) {
                const market = `${first.channel} ${first.marketplace}`
                photoLists.set(market, (photoLists.get(market) ?? 0) + 1)
              }
              const patch = channelValuePatch(working, field.channelStore, keys, row.action, value)
              Object.assign(target.patch, patch); Object.assign(working, patch)
            }
          }
        }
        }
      }
    } catch (e) { error(first, e instanceof Error ? e.message : String(e)) }
    for (const changed of target.cells.filter(c => c.verdict === 'changed')) {
      const keys = [...new Set([changed.field, ...formulaKeys.get(changed.field) ?? [], ...(['name', 'title', 'item_name'].includes(changed.field) ? ['name', 'title', 'item_name'] : [])].map(k => k.replace(/^attr_/, '')))]
      const controlled = context.formulas?.some(f => f.productId === existingProduct?.id && keys.includes(f.fieldKey.replace(/^attr_/, '')) && (isProduct
        ? f.scope === 'master' && (!changed.locale || f.locale === changed.locale)
        : !first.aliasKey && f.scope === 'channel' && f.channel === first.channel && f.marketplace === first.marketplace))
      if (controlled) error(changed, 'This field is controlled by a Nexus formula. Replace or remove the formula in the grid before importing a fixed value.')
      const dependent = context.formulas?.some(f => (f.productId === existingProduct?.id || isProduct && f.product?.parentId === existingProduct?.id)
        && (isProduct || !first.aliasKey && f.scope === 'channel' && f.channel === first.channel && f.marketplace === first.marketplace)
        && (f.dependsOn?.some(d => keys.includes(d.replace(/^attr_/, ''))) || isProduct && ['family', 'categoryIds', 'primaryCategoryId', 'parentSku'].includes(changed.field)))
      if (!controlled && dependent) error(changed, 'A Nexus formula depends on this value. Change this source in the grid so its formulas recalculate together, then export a new workbook.')
    }
    if (issues.length === groupIssueStart) targets.push(target)
  }
  for (const [market, n] of photoLists) warnings.add(`${market}: ${n === 1 ? 'an Image URLs list is' : `${n} Image URLs lists are`} set. A list whose every address is a photo of the media library becomes the listing's Product media, in that order; a list with any other address stays the listing's Image URLs list until it is saved in Product media.`)
  for (const [market, n] of followsShared) warnings.add(`${market}: ${n} ${n === 1 ? 'value equals' : 'values equal'} what Nexus already sends; ${n === 1 ? 'it keeps' : 'they keep'} following Shared.`)
  return { targets, issues, warnings: [...warnings], ...(policy || exclusions.length ? { exclusions } : {}), stats }
}
