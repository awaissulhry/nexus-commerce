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
import { validateChannelValue } from './mapping/validate-channel-value.js'
import { coerceForShape } from './sheet-values.js'
import { channelValuePatch, jsonRecord, storedChannelState, type ValueRecord } from './channel-value-mutation.js'
import type { SourceMapping, SourceExclusion } from './catalog-source-mapping.js'
import { isReferenceField } from '@nexus/shared/reference-values'
import { createReferenceResolver, type ReferenceResolver } from './reference-values.service.js'

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
}
export interface TransferPlan { targets: TransferTarget[]; issues: TransferIssue[]; warnings: string[]; exclusions?: SourceExclusion[] }
export interface TransferContracts {
  reference?: ReferenceResolver
  master: (familyId: string | null, product?: TransferProduct) => Promise<SheetColumn[]>
  channel: (channel: string, marketplace: string, category: string) => Promise<{ fields: CatalogueField[]; warning?: string; schemaVersion?: string | null; fetchedAt?: string | null }>
}

export function transferContracts(market: string, options: { allowIncompleteSchema?: boolean } = {}): TransferContracts {
  const masters = new Map<string, Promise<SheetColumn[]>>()
  const channels = new Map<string, ReturnType<TransferContracts['channel']>>()
  return {
    master(familyId, product) {
      const saved = savedAttributeFields([product?.categoryAttributes])
      const key = fingerprint([familyId, saved])
      if (!masters.has(key)) masters.set(key, getSheetColumns({ market, familyIds: familyId ? [familyId] : [], productTypes: [], savedFields: saved, scopeKind: 'master', includeEmptyChannels: true }).then(s => s.columns))
      return masters.get(key)!
    },
    channel(channel, marketplace, category) {
      const key = JSON.stringify([channel, marketplace, category])
      if (!channels.has(key)) channels.set(key, getFieldCatalogue({ channel, marketplace, productType: category }).then(c => {
        if (!c.schema.present && !options.allowIncompleteSchema) throw new Error(`No cached ${channel} schema for ${marketplace} / ${category}. Refresh the channel category first.`)
        return { fields: c.fields, schemaVersion: c.schema.version, fetchedAt: c.schema.fetchedAt, warning: !c.schema.present
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
  return { ...row, before: before.value, after, beforeState: before.state, afterState: state,
    verdict: before.state === state && transferCanonical(before.value) === transferCanonical(after) ? 'unchanged' : 'changed' }
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
export async function buildTransferPlan(rows: TransferRow[], mode: TransferMode, context: TransferContext, contracts: TransferContracts, policy?: SourceMapping['policy'], options?: { revalidateDeclaredVersion?: boolean }): Promise<TransferPlan> {
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
    if (mode === 'create' && before) { error(first, 'This record already exists; choose Update or Create or update'); continue }
    if (mode === 'update' && !before) { error(first, 'This record does not exist; Update never creates an unknown SKU or listing'); continue }
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
        const columns = await contracts.master(familyId, existingProduct)
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
          if (!col) { error(row, 'This attribute is not declared by the selected family'); continue }
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
          const action = inheritedOwnerSku && !productRows.has(inheritedOwnerSku) ? 'SET' as const : row.action
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
            const checked = coerceForShape(col, value)
            if (checked.ok === false) { error(row, checked.error); continue }
            value = checked.value
          }
          if (!row.locale && col.storage !== 'categoryAttributes') {
            const problem = nativeConstraint(col.key, value)
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
        const contract = await contracts.channel(first.channel, first.marketplace, category)
        for (const f of contract.fields) {
          const keys = [f.fieldKey, f.sheetKey, f.channelStore?.kind === 'listingColumn' ? f.channelStore.column : undefined].filter((k): k is string => !!k)
          for (const key of keys) formulaKeys.set(key, keys)
        }
        if (contract.warning) warnings.add(contract.warning)
        target.contractHash = fingerprint([category, contract.fields])
        const working = clone(before ?? { overrideData: {}, platformAttributes: {} })
        const resolvedFields = new Set<string>()
        const languageRows = context.markets.filter(m => m.channel === first.channel && m.code === first.marketplace)
        const languages = group.some(row => contract.fields.some(f => (f.fieldKey === row.field || f.sheetKey === row.field) && channelContentField(f))) ? marketLanguages(first.channel, first.marketplace, languageRows.map(m => ({ ...m, languages: m.languages ?? [] }))) : []
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
          if (row.entity !== 'Overrides') { error(row, `Listings accepts ${categoryKey}; put channel attribute values in Overrides`); continue }
          const field = contract.fields.find(f => f.fieldKey === row.field || f.sheetKey === row.field)
          if (!field) { error(row, 'This attribute is not declared by the listing category'); continue }
          const textField = channelContentField(field)
          if (textField) (target.contentFields ??= {})[row.field] = textField
          if (row.locale && !textField) { error(row, 'This channel attribute does not vary by language; use the facts sheet'); continue }
          const destination = textField ? transferContentAddress(row, languages) : null
          const address = destination?.tier === 'pin' ? destination : null
          const fieldIdentity = JSON.stringify([field.fieldKey, address?.language ?? ''])
          if (resolvedFields.has(fieldIdentity)) { error(row, 'Duplicate attribute: these two keys resolve to the same channel field'); continue }
          resolvedFields.add(fieldIdentity)
          if (field.fieldKey === categoryKey || field.sheetKey === categoryKey) { error(row, 'Set the listing category in Listings'); continue }
          const keys = [...new Set([field.fieldKey, field.sheetKey].filter((s): s is string => !!s))]
          const old = textField && address && existingProduct ? channelContentState(existingProduct, working, textField, address.language, languages) : storedChannelState(working, field.channelStore, keys)
          if (preserve(row, old.state === 'stored')) continue
          const state = row.action === 'INHERIT' ? 'inherited' : 'stored'
          let value = row.action === 'SET' ? row.value : null
          if (cell(row, old, value, state).verdict !== 'unchanged') {
            if (!field.editable && before) { error(row, 'The channel marks this field read-only on an existing listing'); continue }
            if (managedChannelField(field)) { error(row, 'Use the pricing or inventory workspace for this listing'); continue }
            if (row.action === 'SET' && isReferenceField(field.fieldKey)) {
              try { value = await resolveReference({ field: field.fieldKey, value, channel: first.channel, marketplace: first.marketplace, accountId: first.accountId, productType: category }) }
              catch (e) { error(row, e instanceof Error ? e.message : 'This reference could not be verified. Try again.'); continue }
            }
            const checked = validateChannelValue(field, value)
            if (checked.errors.length) { error(row, checked.errors.join(' ')); continue }
            value = checked.value
          }
          const changed = cell(row, old, value, state)
          target.cells.push(changed)
          if (changed.verdict === 'changed') {
            if (textField && address) planContentWrite(target.contentWrites ??= [], address, textField, row.action, value)
            else {
              const patch = channelValuePatch(working, field.channelStore, keys, row.action, value)
              Object.assign(target.patch, patch); Object.assign(working, patch)
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
  return { targets, issues, warnings: [...warnings], ...(policy ? { exclusions } : {}) }
}
